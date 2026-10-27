// Git load: local git processes are capped (and never wait on themselves), identical read-only queries running
// at once are shared, and the end of a turn scans the working tree once for its checkpoint, diff stat, checks and
// review staleness, while a snapshot never outlives a change Foreman made.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Count real git processes: when each starts, how many run at once, and what each was.
const spawns = vi.hoisted(() => ({ list: [] as string[][], running: 0, peak: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (file: string, ...rest: unknown[]) => {
      if (file !== 'git') return Reflect.apply(actual.execFile, actual, [file, ...rest])
      const [args, options, callback] = rest as [string[], object, (...a: unknown[]) => void]
      spawns.list.push(args)
      spawns.peak = Math.max(spawns.peak, ++spawns.running)
      return actual.execFile(file, args, options, (...a: unknown[]) => {
        spawns.running--
        callback(...a)
      })
    }
  }
})

import { saveCheckpoint, sharedWorkingTree, snapshotWorkingTree, SNAPSHOT_REUSE_MS, VIEW_REUSE_MS } from '../src/main/checkpoints'
import { ChecksService } from '../src/main/checks'
import { revertFile, workspaceDiffStat } from '../src/main/diff'
import { git, GIT_CONCURRENCY, noteWorktreeChanged } from '../src/main/git'
import type { Store } from '../src/main/store'
import { turnDelta } from '../src/main/turnDelta'
import type { Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const scans = () => spawns.list.filter((a) => a[0] === 'add').length
const ran = (command: string) => spawns.list.filter((a) => a.join(' ') === command).length

beforeEach(() => {
  spawns.list.length = 0
  spawns.peak = 0
})

describe('the git limiter', () => {
  it('runs at most GIT_CONCURRENCY local git processes at once, and finishes them all', async () => {
    const dir = await makeRepo()
    spawns.list.length = 0
    // Different arguments each, so none is shared with another.
    const results = await Promise.all(Array.from({ length: GIT_CONCURRENCY * 5 }, (_, i) => git(dir, ['log', '-1', `--format=tformat:${i}`])))
    expect(results.map((r) => r.stdout.trim())).toEqual(Array.from({ length: GIT_CONCURRENCY * 5 }, (_, i) => String(i)))
    expect(spawns.list).toHaveLength(GIT_CONCURRENCY * 5)
    expect(spawns.peak).toBeLessThanOrEqual(GIT_CONCURRENCY)
    expect(spawns.peak).toBeGreaterThan(1)
  })

  it('never deadlocks: git started from another call’s result, and processes that fail to start, give their slot back', async () => {
    const dir = await makeRepo()
    const chain = async (i: number, depth: number): Promise<number> => {
      const r = await git(dir, ['log', '-1', `--format=tformat:${i}-${depth}`])
      return depth ? chain(i, depth - 1) : Number(r.stdout.split('-')[0])
    }
    const missing = path.join(await tempDir(), 'gone')
    const [chained, failed] = await Promise.all([
      Promise.all(Array.from({ length: GIT_CONCURRENCY * 3 }, (_, i) => chain(i, 3))),
      Promise.all(Array.from({ length: GIT_CONCURRENCY * 2 }, (_, i) => git(missing, ['log', `--format=tformat:${i}`], { allowFail: true })))
    ])
    expect(chained).toHaveLength(GIT_CONCURRENCY * 3)
    expect(failed.every((r) => r.code !== 0)).toBe(true)
    expect((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(spawns.peak).toBeLessThanOrEqual(GIT_CONCURRENCY)
  })

  it('shares an identical read-only query already running in the same folder, but not across a change Foreman made', async () => {
    const dir = await makeRepo()
    const [a, b] = await Promise.all([git(dir, ['status', '--porcelain']), git(dir, ['status', '--porcelain'])])
    expect(a).toBe(b)
    expect(ran('status --porcelain')).toBe(1)
    spawns.list.length = 0
    const first = git(dir, ['status', '--porcelain'])
    noteWorktreeChanged(dir)
    await Promise.all([first, git(dir, ['status', '--porcelain'])])
    expect(ran('status --porcelain')).toBe(2)
    // Nor across a git command that may write (here a ref), wherever it ran.
    const head = git(dir, ['rev-parse', 'refs/heads/main'])
    const moved = git(dir, ['update-ref', 'refs/heads/other', 'HEAD'])
    await Promise.all([head, moved, git(dir, ['rev-parse', 'refs/heads/main'])])
    expect(ran('rev-parse refs/heads/main')).toBe(2)
  })
})

describe('one working-tree snapshot per turn end', () => {
  async function setup() {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    const ws = { id: 'ws1', repoId: 'r1', name: 'tokyo', path: dir, state: 'ready', baseBranch: 'main' } as Workspace
    const store = { state: { sessions: [] }, save: () => undefined } as unknown as Store
    const checks = new ChecksService({ store, workspace: () => ws, checks: () => [{ name: 'test', command: 'echo ok', source: 'shared' }], env: () => ({}), changed: () => undefined })
    return { dir, ws, checks }
  }

  it('the end checkpoint’s scan serves the diff stat, the checks’ and the review’s staleness', async () => {
    const { dir, ws, checks } = await setup()
    await saveCheckpoint(dir, 's-t-start')
    const before = await snapshotWorkingTree(dir)
    ws.checks = { running: false, results: [{ name: 'test', command: 'echo ok', status: 'passed', startedAt: '', logPath: '', fingerprint: { tree: before, command: 'x', source: 'shared' } }] }
    await writeFile(path.join(dir, 'a.txt'), 'two\nthree\n')
    spawns.list.length = 0
    // What a turn's end runs (sessions.ts track → endTurn, then Core.refreshDiffStat with when the agent stopped),
    // however long it takes on a loaded machine.
    const stoppedAt = Date.now()
    const end = await saveCheckpoint(dir, 's-t-end')
    await turnDelta(dir, 's', 't')
    await new Promise((r) => setTimeout(r, SNAPSHOT_REUSE_MS + 50))
    const tree = await sharedWorkingTree(dir, stoppedAt)
    const stat = await workspaceDiffStat(ws, tree)
    await checks.refreshStale(ws.id, tree)
    // The review's staleness gets the same tree; its own reads, a moment later, share it too.
    const reviewTree = await sharedWorkingTree(dir, stoppedAt)
    // Before: 26 git processes and 4 scans of every file (checkpoint, diff stat, checks, review).
    expect(scans()).toBe(1)
    expect(spawns.list.length).toBeLessThanOrEqual(17)
    expect(end.ok && end.tree).toBe(tree)
    expect(reviewTree).toBe(tree)
    expect(stat).toEqual({ files: 1, additions: 2, deletions: 1 })
    expect(ws.checks.stale).toBe(true)
  })

  it('concurrent readers of the same moment share one scan; a snapshot doesn’t outlive its time', async () => {
    const { dir, ws, checks } = await setup()
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    ws.checks = { running: false, results: [] }
    spawns.list.length = 0
    // The Git panel's checks ask as the diff's totals change (Core's checksStatus).
    const [stat, , tree] = await Promise.all([workspaceDiffStat(ws), checks.status(ws.id, { since: Date.now() - VIEW_REUSE_MS }), sharedWorkingTree(dir)])
    expect(scans()).toBe(1)
    expect(stat.files).toBe(1)
    // A snapshot started before `since` is read again.
    expect(await sharedWorkingTree(dir, Date.now())).toBe(tree)
    expect(scans()).toBe(2)
  })

  it('never serves a tree from before a change Foreman made: a file written, a revert, a git command', async () => {
    const { dir, ws } = await setup()
    const clean = await sharedWorkingTree(dir)
    // Written by Foreman's editor (core's writeFile notes it).
    await writeFile(path.join(dir, 'a.txt'), 'edited\n')
    noteWorktreeChanged(dir)
    const edited = await sharedWorkingTree(dir)
    expect(edited).not.toBe(clean)
    // A git command that rewrites files marks the tree changed by itself.
    await git(dir, ['checkout', '--', 'a.txt'])
    expect(await sharedWorkingTree(dir)).toBe(clean)
    // Reverting a file Foreman's way.
    await writeFile(path.join(dir, 'new.txt'), 'x\n')
    noteWorktreeChanged(dir)
    expect(await sharedWorkingTree(dir)).not.toBe(clean)
    await revertFile(ws, 'new.txt')
    expect(await sharedWorkingTree(dir)).toBe(clean)
  })
})
