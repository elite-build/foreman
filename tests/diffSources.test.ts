// O5: diff sources (staged, last N, picked commits, the PR as pushed, one commit) and the Commits tab, in real temp repos.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { branchCommits, sourceDiff, sourceInfo, type PrTarget } from '../src/main/diffSources'
import { git } from '../src/main/git'
import { commitsInOutput, lastNRange, orderPicked, sightingsInChat, tabForCommit, toggleUncommitted } from '../src/shared/diffSource'
import type { ChatItem, Workspace } from '../src/shared/types'
import { commit, makeRepo, tempDir } from './helpers'

const asWorkspace = (dir: string) => ({ path: dir, baseBranch: 'main', branch: 'feature' }) as Workspace
const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i}`).join('\n') + '\n'
const sha = async (dir: string, ref: string) => (await git(dir, ['rev-parse', ref])).stdout.trim()
const paths = (diff: { files: { path: string }[] }) => diff.files.map((f) => f.path).sort()

async function commitAll(dir: string, message: string) {
  await git(dir, ['add', '-A'])
  await commit(dir, message)
}

describe('diff sources in a real repo', () => {
  // main (pushed) → feature: c1 edits a.txt line 1, c2 adds b.txt (pushed), c3 adds c.txt and edits a.txt line 30 (not pushed);
  // then d.txt staged and u.txt untracked.
  let dir: string
  let c1: string, c2: string, c3: string
  const pr: PrTarget = { number: 47, baseRef: 'origin/main', headRef: 'origin/feature' }
  beforeAll(async () => {
    dir = await makeRepo({ 'a.txt': lines(40) })
    await git(dir, ['config', 'user.email', 'test@example.com'])
    const remote = await tempDir()
    await git(remote, ['init', '-q', '--bare'])
    await git(dir, ['remote', 'add', 'origin', remote])
    await git(dir, ['push', '-q', 'origin', 'main'])
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), lines(40, { 1: 'ONE' }))
    await commitAll(dir, 'c1 edit a')
    await writeFile(path.join(dir, 'b.txt'), 'b\n')
    await commitAll(dir, 'c2 add b')
    await git(dir, ['push', '-q', 'origin', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), lines(40, { 1: 'ONE', 30: 'THIRTY' }))
    await writeFile(path.join(dir, 'c.txt'), 'c\n')
    await commitAll(dir, 'c3 add c, edit a')
    ;[c1, c2, c3] = await Promise.all(['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => sha(dir, r)))
    await writeFile(path.join(dir, 'd.txt'), 'd\n')
    await git(dir, ['add', 'd.txt'])
    await writeFile(path.join(dir, 'u.txt'), 'u\n')
  })

  it('staged is HEAD against the index', async () => {
    const diff = await sourceDiff(asWorkspace(dir), 'staged')
    expect(paths(diff)).toEqual(['d.txt'])
  })

  it('last commit and last 3 commits cover the newest commits only', async () => {
    const last = await sourceDiff(asWorkspace(dir), 'last-commit')
    expect(paths(last)).toEqual(['a.txt', 'c.txt'])
    expect(last.commits).toEqual([c3])
    const three = await sourceDiff(asWorkspace(dir), 'last-3')
    expect(paths(three)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(three.commits).toEqual([c3, c2, c1])
    // Neither includes uncommitted work.
    expect(paths(three)).not.toContain('d.txt')
  })

  it('picked commits: an unbroken run is a range; a gap is each commit’s own change', async () => {
    const run = await sourceDiff(asWorkspace(dir), 'picked', [c3, c2])
    expect(paths(run)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(run.commits).toEqual([c3, c2])
    const gap = await sourceDiff(asWorkspace(dir), 'picked', [c3, c1])
    expect(paths(gap)).toEqual(['a.txt', 'c.txt'])
    const a = gap.files.find((f) => f.path === 'a.txt')!
    expect(a.additions).toBe(2)
    expect(gap.commits).toEqual([c3, c1])
    expect((await sourceDiff(asWorkspace(dir), 'picked', [])).unavailable).toBe('no-picks')
  })

  it('PR changes are the pushed commits only, base...remote head', async () => {
    const diff = await sourceDiff(asWorkspace(dir), 'pr', [], pr)
    expect(paths(diff)).toEqual(['a.txt', 'b.txt'])
    expect(diff.baseRef).toBe('origin/main')
    expect((await sourceDiff(asWorkspace(dir), 'pr', [], null)).unavailable).toBe('no-pr')
    expect((await sourceDiff(asWorkspace(dir), 'pr', [], { ...pr, headRef: 'origin/nope' })).unavailable).toBe('not-pushed')
  })

  it('one commit shows only that commit’s change', async () => {
    const diff = await sourceDiff(asWorkspace(dir), 'commit', [c2])
    expect(paths(diff)).toEqual(['b.txt'])
    expect(diff.commits).toEqual([c2])
    const first = await sourceDiff(asWorkspace(dir), 'commit', [c1])
    expect(first.files[0].additions).toBe(1)
    expect(first.files[0].deletions).toBe(1)
  })

  it('counts files for every source', async () => {
    const info = await sourceInfo(asWorkspace(dir), [], pr)
    expect(info.counts).toEqual({ all: 5, uncommitted: 2, staged: 1, 'last-commit': 2, 'last-3': 3, pr: 2 })
    expect(info.blocked).toEqual({ picked: 'no-picks' })
    expect(info).toMatchObject({ baseRef: 'origin/main', branchCommits: 3, lastN: 3, lastCommit: { sha: c3, subject: 'c3 add c, edit a' }, pr: { number: 47 } })
    const picked = await sourceInfo(asWorkspace(dir), [c1], null)
    expect(picked.counts.picked).toBe(1)
    expect(picked.blocked.pr).toBe('no-pr')
  })

  it('lists the commits since the merge base, newest first, with totals and pushed state', async () => {
    const list = await branchCommits(asWorkspace(dir), 'origin/feature')
    expect(list.commits.map((c) => c.subject)).toEqual(['c3 add c, edit a', 'c2 add b', 'c1 edit a'])
    expect(list.commits.map((c) => c.pushed)).toEqual([false, true, true])
    expect(list.commits[0]).toMatchObject({ sha: c3, author: 'Test', you: true, files: 2, additions: 2, deletions: 1 })
    expect(list.uncommitted).toEqual({ files: 2, staged: 1, additions: 2, deletions: 0 })
    expect(list.pushedTo).toBe(c2)
    expect(list.mergeBase).toBe(await sha(dir, 'main'))
    // No remote copy: pushed isn't known.
    expect((await branchCommits(asWorkspace(dir), null)).commits[0].pushed).toBeNull()
  })
})

describe('diff sources at the edges', () => {
  it('a branch with no commits has nothing for the commit sources', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    const info = await sourceInfo(asWorkspace(dir))
    expect(info.blocked).toMatchObject({ 'last-commit': 'no-commits', 'last-3': 'no-commits', pr: 'no-pr' })
    expect(info.branchCommits).toBe(0)
    expect((await branchCommits(asWorkspace(dir))).commits).toEqual([])
  })

  it('last 3 on a one-commit branch is every commit on it', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'b.txt'), 'b\n')
    await commitAll(dir, 'only')
    const diff = await sourceDiff(asWorkspace(dir), 'last-3')
    expect(paths(diff)).toEqual(['b.txt'])
    expect((await sourceInfo(asWorkspace(dir))).lastN).toBe(1)
  })

  it('picked commits that need the ones in between say so', async () => {
    const dir = await makeRepo({ 'a.txt': 'one\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    for (const text of ['two\n', 'three\n', 'four\n']) {
      await writeFile(path.join(dir, 'a.txt'), text)
      await commitAll(dir, text.trim())
    }
    const [first, last] = await Promise.all([sha(dir, 'HEAD~2'), sha(dir, 'HEAD')])
    expect((await sourceDiff(asWorkspace(dir), 'picked', [first, last])).unavailable).toBe('not-applicable')
    // Nothing was touched.
    expect((await git(dir, ['status', '--porcelain'])).stdout).toBe('')
  })
})

describe('diff source helpers', () => {
  it('reads the commit line git prints', () => {
    expect(commitsInOutput('[feature 1a2b3c4] Fix it\n 1 file changed')).toEqual(['1a2b3c4'])
    expect(commitsInOutput('[main (root-commit) abcdef0] init')).toEqual(['abcdef0'])
    expect(commitsInOutput('commit 1a2b3c4d\nAuthor: x')).toEqual([])
  })

  it('attributes a commit only to the one tab whose git call printed it', () => {
    const tool = (output: string, command = 'git commit -m x'): ChatItem => ({ kind: 'tool', id: 't', turnId: 'u', name: 'Bash', input: { command }, status: 'done', output })
    const a = sightingsInChat('A', [tool('[feature 1a2b3c4] x'), tool('[feature 9999999] y', 'echo')])
    expect(a).toEqual([{ short: '1a2b3c4', sessionId: 'A' }])
    expect(tabForCommit('1a2b3c4deadbeef', a)).toBe('A')
    expect(tabForCommit('ffffffff', a)).toBeUndefined()
    // Two tabs claim it: unknown, not a guess.
    expect(tabForCommit('1a2b3c4deadbeef', [...a, { short: '1a2b3c4', sessionId: 'B' }])).toBeUndefined()
  })

  it('orders picks and spots gaps', () => {
    const list = ['c3', 'c2', 'c1']
    expect(orderPicked(list, ['c1', 'c3'])).toEqual({ oldestFirst: ['c1', 'c3'], contiguous: false })
    expect(orderPicked(list, ['c2', 'c3', 'zz'])).toEqual({ oldestFirst: ['c2', 'c3'], contiguous: true })
    expect(lastNRange(list, 1)).toEqual({ from: 'c2', commits: ['c3'] })
    expect(lastNRange(list, 3)).toEqual({ from: undefined, commits: list })
    expect(lastNRange([], 1)).toBeNull()
    expect(toggleUncommitted('last-3')).toBe('uncommitted')
    expect(toggleUncommitted('uncommitted')).toBe('all')
  })
})
