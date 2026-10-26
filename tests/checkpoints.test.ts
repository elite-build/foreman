import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteCheckpoints, restoreCheckpoint, saveCheckpoint, snapshotWorkingTree } from '../src/main/checkpoints'
import { git, gitOut } from '../src/main/git'
import { commit, makeRepo } from './helpers'

const read = (dir: string, file: string) => readFile(path.join(dir, file), 'utf8')

describe('checkpoints', () => {
  it('restores tracked edits, untracked files, deletions and the index', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'b.txt': 'keep\n', '.gitignore': 'ignored.log\n' })
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(path.join(dir, 'new.txt'), 'untracked\n')
    await git(dir, ['add', 'a.txt'])
    const saved = await saveCheckpoint(dir, 's1-t1-start')
    expect(saved.ok).toBe(true)

    // Saving must not touch the workspace.
    expect(await read(dir, 'a.txt')).toBe('two\n')
    expect(await gitOut(dir, ['diff', '--cached', '--name-only'])).toBe('a.txt')

    // Simulate an agent turn: edit, delete, add, stage, and create an ignored file.
    await writeFile(path.join(dir, 'a.txt'), 'three\n')
    await git(dir, ['rm', '-q', 'b.txt'])
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'later.txt'), 'later\n')
    await writeFile(path.join(dir, 'ignored.log'), 'log\n')

    await restoreCheckpoint(dir, 's1-t1-start')

    expect(await read(dir, 'a.txt')).toBe('two\n')
    expect(await read(dir, 'b.txt')).toBe('keep\n')
    expect(await read(dir, 'new.txt')).toBe('untracked\n')
    expect(existsSync(path.join(dir, 'src'))).toBe(false)
    expect(existsSync(path.join(dir, 'ignored.log'))).toBe(true)
    expect(await gitOut(dir, ['diff', '--cached', '--name-only'])).toBe('a.txt')
    expect(await gitOut(dir, ['ls-files', '--others', '--exclude-standard'])).toBe('new.txt')
  })

  it('returns the working-tree snapshot it took', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(path.join(dir, 'new.txt'), 'untracked\n')
    const saved = await saveCheckpoint(dir, 's-tree')
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    // The tree is the snapshot of the working tree at checkpoint time.
    expect(await gitOut(dir, ['cat-file', 'blob', `${saved.tree}:a.txt`])).toBe('two')
    expect(await gitOut(dir, ['cat-file', 'blob', `${saved.tree}:new.txt`])).toBe('untracked')
  })

  it('moves HEAD back when the agent committed', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    const before = await gitOut(dir, ['rev-parse', 'HEAD'])
    expect((await saveCheckpoint(dir, 'cp')).ok).toBe(true)
    await writeFile(path.join(dir, 'a.txt'), 'committed\n')
    await git(dir, ['add', '-A'])
    await commit(dir, 'agent commit')

    await restoreCheckpoint(dir, 'cp')
    expect(await gitOut(dir, ['rev-parse', 'HEAD'])).toBe(before)
    expect(await read(dir, 'a.txt')).toBe('one\n')
    expect(await gitOut(dir, ['status', '--porcelain'])).toBe('')
  })

  it('skips while a merge is in progress', async () => {
    const dir = await makeRepo({ 'a.txt': 'base\n' })
    const id = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
    await git(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'a.txt'), 'other\n')
    await git(dir, [...id, 'commit', '-qam', 'other'])
    await git(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), 'main\n')
    await git(dir, [...id, 'commit', '-qam', 'main'])
    // Conflicting merge leaves MERGE_HEAD behind.
    await git(dir, [...id, 'merge', 'other'], { allowFail: true })

    const result = await saveCheckpoint(dir, 'during-merge')
    expect(result).toEqual({ ok: false, reason: 'merge in progress' })
  })

  it('deletes checkpoints by prefix', async () => {
    const dir = await makeRepo()
    await saveCheckpoint(dir, 'sess-a-1')
    await saveCheckpoint(dir, 'sess-a-2')
    await saveCheckpoint(dir, 'sess-b-1')
    await deleteCheckpoints(dir, 'sess-a-')
    const refs = await gitOut(dir, ['for-each-ref', '--format=%(refname)', 'refs/switchyard-checkpoints/'])
    expect(refs).toBe('refs/switchyard-checkpoints/sess-b-1')
  })

  it('refuses to run from a subdirectory of the repo', async () => {
    const dir = await makeRepo()
    await mkdir(path.join(dir, 'sub'))
    await expect(saveCheckpoint(path.join(dir, 'sub'), 'x')).rejects.toThrow(/not the workspace root/)
  })

  it('captures an edit made in the same instant as the index, even at the same size', async () => {
    const dir = await makeRepo({ 'a.txt': 'aaaa\n' })
    // Refresh the index, then change the file right away without changing its size.
    await git(dir, ['update-index', '--refresh'], { allowFail: true })
    await writeFile(path.join(dir, 'a.txt'), 'bbbb\n')
    const tree = await snapshotWorkingTree(dir)
    expect(await gitOut(dir, ['cat-file', 'blob', `${tree}:a.txt`])).toBe('bbbb')
  })
})
