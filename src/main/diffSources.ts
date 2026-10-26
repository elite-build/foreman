// O5: the Changes panel's other diff sources (staged, the last commits, picked
// commits, the PR as pushed, one commit) and the branch's commits for the
// Commits tab. Read-only: nothing here touches the index or the working tree.
// A cloud workspace's git runs in its sandbox, its private index under /tmp there.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { lastCount, lastNRange, orderPicked } from '../shared/diffSource'
import type { BranchCommit, BranchCommits, DiffScope, DiffSourceBlock, DiffSourceInfo, Workspace, WorkspaceDiff } from '../shared/types'
import { snapshotWorkingTree } from './checkpoints'
import { branchPoint, MAX_DIFF_BYTES, parseUnifiedDiff } from './diff'
import { git, gitOut, revParse, type GitTarget } from './git'
import { workspaceTarget } from './runtime'
import type { WorkspaceRuntime } from './runtime/types'

const MAX_COMMITS = 200

/** The pull request as reviewers see it: its base and the branch head on the remote. */
export interface PrTarget {
  number: number
  provider?: 'gitlab'
  // e.g. origin/main, the PR's base branch.
  baseRef: string
  // e.g. origin/feature, the branch as pushed.
  headRef: string
}

// The new side is a commit, a tree, or the index (staged).
type Range = { from: string; to: string | 'index'; commits?: string[]; label: string } | { blocked: DiffSourceBlock }

async function emptyTree(dir: GitTarget): Promise<string> {
  const format = (await git(dir, ['rev-parse', '--show-object-format'], { allowFail: true })).stdout.trim()
  return format === 'sha256' ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
}

async function parentOf(dir: GitTarget, sha: string): Promise<string> {
  return (await revParse(dir, `${sha}^`)) ?? (await emptyTree(dir))
}

/** Commits on the branch since the merge base, following first parents, newest first. */
async function firstParents(dir: GitTarget, mergeBase: string, limit?: number): Promise<string[]> {
  if (!(await revParse(dir, 'HEAD'))) return []
  const range = (await revParse(dir, mergeBase)) ? `${mergeBase}..HEAD` : 'HEAD'
  const out = await git(dir, ['rev-list', '--first-parent', ...(limit ? [`-n${limit}`] : []), range], { allowFail: true })
  return out.stdout.split('\n').filter(Boolean)
}

/**
 * Picked commits that aren't one unbroken run: each one's own change applied in
 * order onto the oldest one's parent, in a private index. Null when one doesn't
 * apply without the commits in between.
 */
async function pickedTree(dir: GitTarget, oldestFirst: string[]): Promise<string | null> {
  if (typeof dir !== 'string') return runtimePickedTree(dir, oldestFirst)
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'foreman-picked-'))
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  try {
    await git(dir, ['read-tree', await parentOf(dir, oldestFirst[0])], { env })
    for (const sha of oldestFirst) {
      const patch = path.join(tmp, 'change.patch')
      const { stdout } = await git(dir, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', await parentOf(dir, sha), sha])
      if (!stdout.trim()) continue
      await writeFile(patch, stdout)
      if ((await git(dir, ['apply', '--cached', '--binary', patch], { env, allowFail: true })).code !== 0) return null
    }
    return await gitOut(dir, ['write-tree'], { env })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** pickedTree in a sandbox: the same steps, the index and patches in a folder under its /tmp. */
async function runtimePickedTree(rt: WorkspaceRuntime, oldestFirst: string[]): Promise<string | null> {
  const tmp = `/tmp/foreman-picked-${randomUUID().slice(0, 8)}`
  const env = { GIT_INDEX_FILE: `${tmp}/index` }
  await rt.mkdir(tmp)
  try {
    await git(rt, ['read-tree', await parentOf(rt, oldestFirst[0])], { env })
    for (const sha of oldestFirst) {
      const patch = `${tmp}/change.patch`
      const { stdout } = await git(rt, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', await parentOf(rt, sha), sha])
      if (!stdout.trim()) continue
      await rt.writeFile(patch, stdout)
      if ((await git(rt, ['apply', '--cached', '--binary', patch], { env, allowFail: true })).code !== 0) return null
    }
    return await gitOut(rt, ['write-tree'], { env })
  } finally {
    await rt.exec('bash', ['-c', 'rm -rf -- "$1"', 'rm', tmp]).catch(() => undefined)
  }
}

async function rangeFor(ws: Workspace, scope: DiffScope, commits: string[] = [], pr?: PrTarget | null, dir: GitTarget = workspaceTarget(ws)): Promise<Range> {
  if (scope === 'staged') {
    return { from: (await revParse(dir, 'HEAD')) ?? (await emptyTree(dir)), to: 'index', label: 'HEAD' }
  }
  if (scope === 'commit') {
    const sha = commits[0] ? await revParse(dir, commits[0]) : null
    if (!sha) return { blocked: 'no-commits' }
    return { from: await parentOf(dir, sha), to: sha, commits: [sha], label: sha }
  }
  if (scope === 'pr') {
    if (!pr) return { blocked: 'no-pr' }
    const head = await revParse(dir, pr.headRef)
    if (!head) return { blocked: 'not-pushed' }
    const base = (await git(dir, ['merge-base', pr.baseRef, head], { allowFail: true })).stdout.trim()
    if (!base || base === head) return { blocked: 'not-pushed' }
    return { from: base, to: head, label: pr.baseRef }
  }
  const { mergeBase } = await branchPoint(ws, dir)
  if (scope === 'last-commit' || scope === 'last-3') {
    const n = lastCount(scope)
    const list = await firstParents(dir, mergeBase, n + 1)
    const range = lastNRange(list, n)
    if (!range) return { blocked: 'no-commits' }
    // Fewer than n commits: from the oldest one's parent (the merge base, unless the branch has no base).
    const from = range.from ?? (await parentOf(dir, list[list.length - 1]))
    return { from, to: 'HEAD', commits: range.commits, label: from }
  }
  if (scope === 'picked') {
    if (!commits.length) return { blocked: 'no-picks' }
    const { oldestFirst, contiguous } = orderPicked(await firstParents(dir, mergeBase, MAX_COMMITS), commits)
    if (!oldestFirst.length) return { blocked: 'no-picks' }
    const from = await parentOf(dir, oldestFirst[0])
    const newestFirst = [...oldestFirst].reverse()
    if (contiguous) return { from, to: newestFirst[0], commits: newestFirst, label: from }
    const tree = await pickedTree(dir, oldestFirst)
    return tree ? { from, to: tree, commits: newestFirst, label: from } : { blocked: 'not-applicable' }
  }
  throw new Error(`Not a commit source: ${scope}`)
}

const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames']
const ends = (r: { from: string; to: string }) => (r.to === 'index' ? ['--cached', r.from] : [r.from, r.to])

/** The diff for a source other than All changes and Uncommitted (those stay in diff.ts, with viewed marks). */
export async function sourceDiff(ws: Workspace, scope: DiffScope, commits?: string[], pr?: PrTarget | null): Promise<WorkspaceDiff> {
  const at = workspaceTarget(ws)
  const range = await rangeFor(ws, scope, commits, pr, at)
  if ('blocked' in range) return { baseRef: '', scope, files: [], truncated: false, unavailable: range.blocked }
  const { stdout } = await git(at, [...DIFF, '--src-prefix=a/', '--dst-prefix=b/', ...ends(range)])
  const truncated = stdout.length > MAX_DIFF_BYTES
  return { baseRef: range.label, scope, files: parseUnifiedDiff(truncated ? stdout.slice(0, MAX_DIFF_BYTES) : stdout), truncated, ...(range.commits ? { commits: range.commits } : {}) }
}

async function countFiles(dir: GitTarget, args: string[]): Promise<number> {
  const { stdout } = await git(dir, [...DIFF, '--name-only', '-z', ...args])
  return stdout.split('\0').filter(Boolean).length
}

/** File counts for every source, read from git now; a source that can't be shown says why. */
export async function sourceInfo(ws: Workspace, picked: string[] = [], pr?: PrTarget | null): Promise<DiffSourceInfo> {
  const dir = workspaceTarget(ws)
  const { baseRef, mergeBase } = await branchPoint(ws, dir)
  const head = await revParse(dir, 'HEAD')
  const tree = await snapshotWorkingTree(dir)
  const info: DiffSourceInfo = { counts: {}, blocked: {}, baseRef, branchCommits: 0, lastN: 0 }
  info.counts.all = await countFiles(dir, [mergeBase, tree])
  info.counts.uncommitted = await countFiles(dir, [head ?? (await emptyTree(dir)), tree])
  const list = await firstParents(dir, mergeBase, MAX_COMMITS + 1)
  info.branchCommits = list.length
  info.lastN = Math.min(3, list.length)
  if (list[0]) info.lastCommit = { sha: list[0], subject: await gitOut(dir, ['log', '-1', '--format=%s', list[0]]) }
  if (pr) info.pr = { number: pr.number, ...(pr.provider ? { provider: pr.provider } : {}) }
  for (const scope of ['staged', 'last-commit', 'last-3', 'picked', 'pr'] as const) {
    try {
      const range = await rangeFor(ws, scope, scope === 'picked' ? picked : [], pr, dir)
      if ('blocked' in range) info.blocked[scope] = range.blocked
      else info.counts[scope] = await countFiles(dir, ends(range))
    } catch {
      info.blocked[scope] = 'failed'
    }
  }
  return info
}

/** The branch's commits since the merge base, newest first, with line totals and whether each is pushed. */
export async function branchCommits(ws: Workspace, remoteHead?: string | null): Promise<BranchCommits> {
  const dir = workspaceTarget(ws)
  const { baseRef, mergeBase } = await branchPoint(ws, dir)
  const head = await revParse(dir, 'HEAD')
  const empty = await emptyTree(dir)
  const tree = await snapshotWorkingTree(dir)
  const uncommitted = { files: 0, staged: 0, additions: 0, deletions: 0 }
  for (const line of (await git(dir, [...DIFF, '--numstat', head ?? empty, tree])).stdout.split('\n')) {
    const [added, deleted] = line.split('\t')
    if (deleted === undefined) continue
    uncommitted.files++
    uncommitted.additions += Number(added) || 0
    uncommitted.deletions += Number(deleted) || 0
  }
  uncommitted.staged = await countFiles(dir, ['--cached', head ?? empty])
  if (!head) return { baseRef, mergeBase, commits: [], more: false, uncommitted }

  const pushedTo = remoteHead ? ((await revParse(dir, remoteHead)) ?? undefined) : undefined
  const pushed = pushedTo ? new Set((await git(dir, ['rev-list', pushedTo, `^${mergeBase}`], { allowFail: true })).stdout.split('\n').filter(Boolean)) : null
  const me = (await git(dir, ['config', 'user.email'], { allowFail: true })).stdout.trim().toLowerCase()
  const range = (await revParse(dir, mergeBase)) ? `${mergeBase}..HEAD` : 'HEAD'
  // First parents only, and a merge's change against its first parent: the branch's own history.
  const { stdout } = await git(dir, ['-c', 'core.quotePath=false', 'log', '--first-parent', '-m', '--numstat', `-n${MAX_COMMITS + 1}`, '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s', range])
  const commits: BranchCommit[] = []
  for (const record of stdout.split('\x1e').slice(1)) {
    const [header, ...lines] = record.split('\n')
    const [sha, author, email, at, subject] = header.split('\x1f')
    const commit: BranchCommit = { sha, subject, author, you: Boolean(me) && email.toLowerCase() === me, at, files: 0, additions: 0, deletions: 0, pushed: pushed ? pushed.has(sha) : null }
    for (const line of lines) {
      const [added, deleted] = line.split('\t')
      if (deleted === undefined) continue
      commit.files++
      commit.additions += Number(added) || 0
      commit.deletions += Number(deleted) || 0
    }
    commits.push(commit)
  }
  return { baseRef, mergeBase, commits: commits.slice(0, MAX_COMMITS), more: commits.length > MAX_COMMITS, uncommitted, ...(pushedTo ? { pushedTo } : {}) }
}

/** G2 (O5): the Commits tab's count badge: the branch's commits since the merge base, without reading them. */
export async function branchCommitCount(ws: Workspace): Promise<{ count: number; more: boolean }> {
  const dir = workspaceTarget(ws)
  const { mergeBase } = await branchPoint(ws, dir)
  const list = await firstParents(dir, mergeBase, MAX_COMMITS + 1)
  return { count: Math.min(list.length, MAX_COMMITS), more: list.length > MAX_COMMITS }
}
