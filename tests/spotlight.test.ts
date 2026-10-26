import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Repo, Workspace } from '../src/shared/types'
import { git, gitOut } from '../src/main/git'
import { Spotlight } from '../src/main/spotlight'
import { commit, makeRepo, tempDir } from './helpers'

const read = (dir: string, file: string) => readFile(path.join(dir, file), 'utf8')

// Each spotlight step runs dozens of git processes one after another (checkpoint, snapshot, restore). On a
// loaded Windows runner a git process costs several times what it does on a desktop, so the whole test took
// over 20 s there while doing the right thing. Waits are bounded by the test's own budget, not a guess at
// one step's speed; a sync that never lands still fails here.
const BUDGET = 60_000

async function waitFor(check: () => Promise<boolean>, ms = BUDGET / 2): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

// Real git work plus a file watcher; give it room on a busy machine.
describe('spotlight', { timeout: BUDGET }, () => {
  it('mirrors a workspace into the repo root and restores the root exactly on stop', async () => {
    const root = await makeRepo({ 'app.txt': 'v1\n', 'keep.txt': 'root\n' })
    const mainBefore = await gitOut(root, ['rev-parse', 'main'])
    const wsPath = path.join(await tempDir(), 'ws')
    await git(root, ['worktree', 'add', '-q', '-b', 'feature', wsPath, 'main'])
    // The workspace has a commit of its own plus uncommitted work.
    await writeFile(path.join(wsPath, 'app.txt'), 'v2\n')
    await git(wsPath, ['add', '-A'])
    await commit(wsPath, 'feature work')
    await writeFile(path.join(wsPath, 'new.txt'), 'from workspace\n')

    // The user has their own uncommitted and untracked work in the root.
    await writeFile(path.join(root, 'keep.txt'), 'root edited\n')
    await writeFile(path.join(root, 'notes.txt'), 'untracked in root\n')

    const repo = { id: 'r1', rootPath: root } as Repo
    const ws = { id: 'w1', name: 'ws', path: wsPath } as Workspace
    const logs: string[] = []
    const spotlight = new Spotlight({ log: (_id, line) => logs.push(line), changed: () => {} })

    await spotlight.start(repo, ws)
    expect(await read(root, 'app.txt')).toBe('v2\n')
    expect(await read(root, 'new.txt')).toBe('from workspace\n')
    // The checked-out branch never moves.
    expect(await gitOut(root, ['rev-parse', 'main'])).toBe(mainBefore)

    // Later edits in the workspace keep flowing into the root.
    await writeFile(path.join(wsPath, 'app.txt'), 'v3\n')
    await waitFor(async () => (await read(root, 'app.txt')) === 'v3\n')

    await spotlight.stop(repo)
    expect(await read(root, 'app.txt')).toBe('v1\n')
    expect(await read(root, 'keep.txt')).toBe('root edited\n')
    expect(await read(root, 'notes.txt')).toBe('untracked in root\n')
    expect(existsSync(path.join(root, 'new.txt'))).toBe(false)
    expect(await gitOut(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
    expect(await gitOut(root, ['rev-parse', 'HEAD'])).toBe(mainBefore)
    expect(await gitOut(root, ['for-each-ref', 'refs/switchyard-checkpoints/spotlight*'])).toBe('')
    expect(logs.some((l) => l.startsWith('Spotlight off'))).toBe(true)
  })

  it('refuses to start on a detached root', async () => {
    const root = await makeRepo()
    await git(root, ['checkout', '-q', '--detach'])
    const spotlight = new Spotlight({ log: () => {}, changed: () => {} })
    await expect(spotlight.start({ id: 'r', rootPath: root } as Repo, { id: 'w', name: 'w', path: root } as Workspace)).rejects.toThrow(/detached/)
  })
})
