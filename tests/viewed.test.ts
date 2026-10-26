import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRawDiff, workspaceDiff } from '../src/main/diff'
import { git } from '../src/main/git'
import type { ViewedMark, Workspace } from '../src/shared/types'
import { isViewed, pruneViewed, viewedCount, withMark } from '../src/shared/viewed'
import { commit, makeRepo } from './helpers'

const asWorkspace = (dir: string) => ({ path: dir, baseBranch: 'main' }) as Workspace

describe('viewed marks', () => {
  it('parses new-side blob ids, including renames and deletions', () => {
    const z = (s: string[]) => s.join('\0') + '\0'
    const raw = z([
      ':100644 100644 aaa111 bbb222 M', 'a.txt',
      ':100644 100644 ccc333 ddd444 R090', 'old.txt', 'new.txt',
      ':100644 000000 eee555 0000000 D', 'gone.txt'
    ])
    expect([...parseRawDiff(raw)]).toEqual([['a.txt', 'bbb222'], ['new.txt', 'ddd444'], ['gone.txt', '0000000']])
  })

  it('gives each diff file a blob id and the workspace diff a merge base', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n', 'r.txt': 'rename me please\nmore\nlines\nhere\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await writeFile(path.join(dir, 'new file.txt'), 'x\n')
    await rename(path.join(dir, 'r.txt'), path.join(dir, 'renamed.txt'))
    const diff = await workspaceDiff(asWorkspace(dir))
    const head = (await git(dir, ['rev-parse', 'main'])).stdout.trim()
    expect(diff.mergeBase).toBe(head)
    const blob = async (file: string) => (await git(dir, ['hash-object', file])).stdout.trim()
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f.blobId]))
    expect(byPath['a.txt']).toBe(await blob(path.join(dir, 'a.txt')))
    expect(byPath['new file.txt']).toBe(await blob(path.join(dir, 'new file.txt')))
    expect(byPath['renamed.txt']).toBe(await blob(path.join(dir, 'renamed.txt')))
  })

  it('a mark clears when the file changes or the branch point moves', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    const first = await workspaceDiff(asWorkspace(dir))
    const file = first.files[0]
    const marks = withMark(undefined, { path: file.path, blobId: file.blobId!, mergeBase: first.mergeBase! }, true)
    expect(isViewed(marks, file, first.mergeBase)).toBe(true)
    expect(viewedCount(marks, first.files, first.mergeBase)).toEqual({ viewed: 1, total: 1 })

    // Same content again keeps the mark.
    expect(pruneViewed(marks, (await workspaceDiff(asWorkspace(dir))).files, first.mergeBase!)).toEqual(marks)

    // The file changes.
    await writeFile(path.join(dir, 'a.txt'), 'three\n')
    const edited = await workspaceDiff(asWorkspace(dir))
    expect(isViewed(marks, edited.files[0], edited.mergeBase)).toBe(false)
    expect(pruneViewed(marks, edited.files, edited.mergeBase!)).toEqual([])

    // The branch point moves, with the file as it was when marked.
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    await git(dir, ['add', '-A'])
    await commit(dir, 'feature work')
    await git(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'other.txt'), 'o\n')
    await git(dir, ['add', '-A'])
    await commit(dir, 'main moves')
    await git(dir, ['checkout', '-q', 'feature'])
    await git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'rebase', '-q', 'main'])
    const moved = await workspaceDiff(asWorkspace(dir))
    expect(moved.mergeBase).not.toBe(first.mergeBase)
    expect(moved.files[0].blobId).toBe(file.blobId)
    expect(isViewed(marks, moved.files[0], moved.mergeBase)).toBe(false)
    expect(pruneViewed(marks, moved.files, moved.mergeBase!)).toEqual([])
  })

  it('keeps one mark per file and unmarks', () => {
    const a: ViewedMark = { path: 'a', blobId: '1', mergeBase: 'm' }
    const marks = withMark(withMark(undefined, a, true), { ...a, blobId: '2' }, true)
    expect(marks).toEqual([{ ...a, blobId: '2' }])
    expect(withMark(marks, a, false)).toEqual([])
    expect(isViewed(marks, { path: 'a' }, 'm')).toBe(false)
  })
})
