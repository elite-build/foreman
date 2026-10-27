// Thin wrapper over the git CLI. Always argv arrays, never a shell, so the
// same calls work unchanged on Windows. A call runs in a folder here (a path)
// or wherever a WorkspaceRuntime says.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMergeTree } from '../shared/baseWatch'
import type { WorkspaceRuntime } from './runtime/types'

/** Where git runs: a folder on this computer, or a workspace runtime. */
export type GitTarget = string | WorkspaceRuntime

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message)
  }
}

export interface GitOptions {
  env?: Record<string, string | undefined>
  allowFail?: boolean
  timeoutMs?: number
}

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * How many local git processes run at once; the rest wait their turn. Each one costs tens of milliseconds of CPU
 * to start (more on Windows, and under antivirus), and a dozen turns ending together used to start fifty at once.
 */
export const GIT_CONCURRENCY = Math.max(2, Math.min(6, Math.floor(os.availableParallelism() / 2)))

// Local, CPU-bound commands that run no hooks and never wait on the network: only these take a slot, so a slow
// fetch or push, or a commit's hook, never holds up the rest.
const LIMITED = new Set([
  '--version', 'add', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'commit-tree', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'for-each-ref', 'grep', 'hash-object', 'log', 'ls-files', 'ls-tree', 'merge-base', 'merge-tree', 'mktree',
  'name-rev', 'read-tree', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-ref', 'status', 'symbolic-ref', 'update-index', 'update-ref', 'var', 'write-tree'
])
// Queries that only read: one already running with the same arguments in the same folder is shared, not run again.
const SHARED = new Set(['cat-file', 'describe', 'diff', 'diff-tree', 'for-each-ref', 'log', 'ls-files', 'ls-tree', 'merge-base', 'name-rev', 'rev-list', 'rev-parse', 'show', 'show-ref', 'status'])
// Commands that can rewrite files in the working tree: they mark it changed (see worktreeGeneration).
const MUTATING = new Set(['am', 'apply', 'checkout', 'checkout-index', 'cherry-pick', 'clean', 'merge', 'mv', 'pull', 'read-tree', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch'])

/** The git command in an argument list, past global options like `-c name=value`. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++
    else if (!args[i].startsWith('-') || args[i] === '--version') return args[i]
  }
  return ''
}

let running = 0
const waiting: (() => void)[] = []

/**
 * Start a process once a slot is free. A slot is held only while its process runs (`start` calls `done` when it
 * exits, before anyone awaiting it resumes), so a git call made from another's result can never wait on itself.
 */
function withSlot(start: (done: () => void) => void): void {
  const run = () => {
    let held = true
    start(() => {
      if (!held) return
      held = false
      const next = waiting.shift()
      if (next) next()
      else running--
    })
  }
  if (running < GIT_CONCURRENCY) {
    running++
    run()
  } else waiting.push(run)
}

/** How a folder is known to the caches here: one spelling per folder (macOS and Windows ignore case by default). */
export function worktreeKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'linux' ? resolved : resolved.toLowerCase()
}

const generations = new Map<string, number>()

/** Goes up whenever Foreman changes files in the working tree at `dir`; a cached reading from before is stale. */
export function worktreeGeneration(dir: string): number {
  return generations.get(worktreeKey(dir)) ?? 0
}

/** Foreman changed (or is about to change) files in `dir`: nothing read from it before counts any more. */
export function noteWorktreeChanged(dir: string): void {
  const key = worktreeKey(dir)
  generations.set(key, (generations.get(key) ?? 0) + 1)
}

// Goes up as any git command that may write (a commit, a ref, a checkout) starts and ends, in any folder: a query
// already running from before can't answer for after (refs are shared between a repository's worktrees).
let writes = 0
const inFlight = new Map<string, { generation: number; writes: number; result: Promise<GitResult> }>()

export function git(cwd: GitTarget, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  if (typeof cwd !== 'string') return runtimeGit(cwd, args, opts)
  const command = subcommand(args)
  if (!SHARED.has(command) || opts.env) {
    // A temporary index (a snapshot) leaves the working tree, the real index and every ref alone.
    if (opts.env?.GIT_INDEX_FILE) return localGit(cwd, args, opts, command)
    const files = MUTATING.has(command)
    const note = () => {
      writes++
      if (files) noteWorktreeChanged(cwd)
    }
    note()
    const result = localGit(cwd, args, opts, command)
    result.then(note, note)
    return result
  }
  const key = [worktreeKey(cwd), opts.allowFail ? 1 : 0, opts.timeoutMs ?? 0, ...args].join('\0')
  const generation = worktreeGeneration(cwd)
  const same = inFlight.get(key)
  if (same?.generation === generation && same.writes === writes) return same.result
  const entry = { generation, writes, result: localGit(cwd, args, opts, command) }
  inFlight.set(key, entry)
  const clear = () => {
    if (inFlight.get(key) === entry) inFlight.delete(key)
  }
  entry.result.then(clear, clear)
  return entry.result
}

function localGit(cwd: string, args: string[], opts: GitOptions, command: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // Never throws: the next queued call starts from inside a finished one's callback.
    const start = (done: () => void) => {
      try {
        execFile(
          'git',
          args,
          {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
            maxBuffer: 512 * 1024 * 1024,
            timeout: opts.timeoutMs ?? 0,
            windowsHide: true,
            encoding: 'utf8'
          },
          (err, stdout, stderr) => {
            done()
            if (!err) return resolve({ stdout, stderr, code: 0 })
            // execFile reports the exit status as a numeric `code`; spawn failures use a string code.
            const status = (err as { code?: unknown }).code
            const code = typeof status === 'number' ? status : null
            if (opts.allowFail) return resolve({ stdout, stderr, code: code ?? 1 })
            const detail = stderr.trim() || err.message
            reject(new GitError(`git ${args[0]} failed: ${detail}`, args, code, stderr))
          }
        )
      } catch (err) {
        done()
        reject(err)
      }
    }
    if (LIMITED.has(command)) withSlot(start)
    else start(() => undefined)
  })
}

/** git through a runtime, with the same results and errors as the local form. */
async function runtimeGit(rt: WorkspaceRuntime, args: string[], opts: GitOptions): Promise<GitResult> {
  const r = await rt.exec('git', args, { env: { GIT_TERMINAL_PROMPT: '0', ...opts.env }, timeoutMs: opts.timeoutMs })
  if (r.code === 0 || opts.allowFail) return r
  throw new GitError(`git ${args[0]} failed: ${r.stderr.trim() || `exit code ${r.code}`}`, args, r.code, r.stderr)
}

/** Run git and return trimmed stdout. */
export async function gitOut(cwd: GitTarget, args: string[], opts: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, opts)).stdout.trim()
}

export async function isInsideWorkTree(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })
  return r.code === 0 && r.stdout.trim() === 'true'
}

export async function toplevel(dir: GitTarget): Promise<string> {
  return gitOut(dir, ['rev-parse', '--show-toplevel'])
}

export async function revParse(cwd: GitTarget, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true })
  return r.code === 0 ? r.stdout.trim() : null
}

export async function hasRemote(cwd: GitTarget, name: string): Promise<boolean> {
  const remotes = (await gitOut(cwd, ['remote'])).split('\n')
  return remotes.includes(name)
}

/** Remote URL (credentials stripped) and the first root commit: evidence for matching a repository on another machine. */
export async function repoEvidence(root: string, remote: string): Promise<{ remoteUrl?: string; rootCommit?: string }> {
  const url = await git(root, ['remote', 'get-url', remote], { allowFail: true })
  const roots = await git(root, ['rev-list', '--max-parents=0', 'HEAD'], { allowFail: true })
  const rootCommit = roots.code === 0 ? roots.stdout.trim().split('\n').filter(Boolean).sort()[0] : undefined
  const remoteUrl = url.code === 0 && url.stdout.trim() ? url.stdout.trim().replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1') : undefined
  return { remoteUrl, rootCommit }
}

export async function detectDefaultBranch(root: string): Promise<string> {
  const originHead = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (originHead.code === 0) return originHead.stdout.trim().replace(/^origin\//, '')
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    if (await revParse(root, `refs/heads/${candidate}`)) return candidate
  }
  const current = await gitOut(root, ['branch', '--show-current'])
  return current || 'main'
}

/** Ref to branch new workspaces from: the remote branch when it exists. */
export async function baseStartPoint(root: GitTarget, baseBranch: string, remote = 'origin'): Promise<string> {
  if (await revParse(root, `refs/remotes/${remote}/${baseBranch}`)) return `${remote}/${baseBranch}`
  return baseBranch
}

/** In-progress operation that would block committing, or null. */
export async function busyOperation(cwd: GitTarget): Promise<'rebase' | 'merge' | 'cherry-pick' | 'revert' | null> {
  const paths = await gitOut(cwd, [
    'rev-parse',
    '--git-path', 'rebase-merge',
    '--git-path', 'rebase-apply',
    '--git-path', 'MERGE_HEAD',
    '--git-path', 'CHERRY_PICK_HEAD',
    '--git-path', 'REVERT_HEAD'
  ])
  const [rebaseMerge, rebaseApply, mergeHead, cherryPick, revert] = paths.split('\n')
  if (typeof cwd !== 'string') {
    // Paths come back relative to the runtime's cwd, which is where its file calls start too.
    const found = await Promise.all([rebaseMerge, rebaseApply, mergeHead, cherryPick, revert].map((p) => cwd.exists(p)))
    return found[0] || found[1] ? 'rebase' : found[2] ? 'merge' : found[3] ? 'cherry-pick' : found[4] ? 'revert' : null
  }
  const exists = (p: string) => existsSync(path.resolve(cwd, p))
  if (exists(rebaseMerge) || exists(rebaseApply)) return 'rebase'
  if (exists(mergeHead)) return 'merge'
  if (exists(cherryPick)) return 'cherry-pick'
  if (exists(revert)) return 'revert'
  return null
}

export async function hasUnmergedPaths(cwd: GitTarget): Promise<boolean> {
  return (await gitOut(cwd, ['ls-files', '-u'])).length > 0
}

let versionText: Promise<string | undefined> | null = null

/** The installed git's version line, once. */
export function gitVersion(): Promise<string | undefined> {
  versionText ??= git(process.cwd(), ['--version'], { allowFail: true }).then((r) => (r.code === 0 ? r.stdout.trim() : undefined))
  return versionText
}

/**
 * Committed conflicts between a branch head and a base tip, without touching
 * either worktree or index (git 2.38+). null when git could not tell.
 */
export async function mergeTreeConflicts(cwd: GitTarget, base: string, head: string): Promise<string[] | null> {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], { allowFail: true })
  if (r.code === 0) return []
  // Exit 1 is "conflicts"; anything else (unrelated histories, old git) is a failure to look.
  return r.code === 1 ? parseMergeTree(r.stdout) : null
}
