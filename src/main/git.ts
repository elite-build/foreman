// Thin wrapper over the git CLI. Always argv arrays, never a shell, so the
// same calls work unchanged on Windows. A call runs in a folder here (a path)
// or wherever a WorkspaceRuntime says.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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

export function git(cwd: GitTarget, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  if (typeof cwd !== 'string') return runtimeGit(cwd, args, opts)
  return new Promise((resolve, reject) => {
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
        if (!err) return resolve({ stdout, stderr, code: 0 })
        // execFile reports the exit status as a numeric `code`; spawn failures use a string code.
        const status = (err as { code?: unknown }).code
        const code = typeof status === 'number' ? status : null
        if (opts.allowFail) return resolve({ stdout, stderr, code: code ?? 1 })
        const detail = stderr.trim() || err.message
        reject(new GitError(`git ${args[0]} failed: ${detail}`, args, code, stderr))
      }
    )
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
