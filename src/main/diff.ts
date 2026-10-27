// Everything a workspace changed relative to where it branched off, including
// uncommitted and untracked files. A cloud workspace's git runs in its sandbox
// (workspaceTarget); reads never wake a sleeping one.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { DiffFile, DiffHunk, DiffScope, DiffStat, Workspace, WorkspaceDiff } from '../shared/types'
import { sharedWorkingTree, snapshotWorkingTree, VIEW_REUSE_MS } from './checkpoints'
import { baseStartPoint, git, noteWorktreeChanged, revParse, type GitTarget } from './git'
import { workspaceTarget } from './runtime'

export const MAX_DIFF_BYTES = 4 * 1024 * 1024

/** Where the branch started: the base ref it came from and its merge base with HEAD. */
export async function branchPoint(ws: Workspace, at: GitTarget = workspaceTarget(ws)): Promise<{ baseRef: string; mergeBase: string }> {
  const baseRef = await baseStartPoint(at, ws.baseBranch)
  const mergeBase = (await git(at, ['merge-base', 'HEAD', baseRef], { allowFail: true })).stdout.trim() || baseRef
  return { baseRef, mergeBase }
}

// The two sides of a workspace diff: where the branch started, and a tree of
// the working directory as it is right now.
async function diffEnds(ws: Workspace, at: GitTarget): Promise<{ baseRef: string; mergeBase: string; tree: string }> {
  return { ...(await branchPoint(ws, at)), tree: await snapshotWorkingTree(at) }
}

/**
 * Line totals for the sidebar; much cheaper than the full diff. With no `tree`, a snapshot taken a moment ago
 * (for the diff on screen, or a check's staleness) serves (sharedWorkingTree).
 */
export async function workspaceDiffStat(ws: Workspace, tree?: string): Promise<DiffStat> {
  const at = workspaceTarget(ws)
  const [{ mergeBase }, workingTree] = await Promise.all([branchPoint(ws, at), tree ?? sharedWorkingTree(at)])
  const { stdout } = await git(at, ['diff', '--numstat', '--no-ext-diff', '--find-renames', mergeBase, workingTree])
  const stat: DiffStat = { files: 0, additions: 0, deletions: 0 }
  for (const line of stdout.split('\n')) {
    const [added, deleted] = line.split('\t')
    if (deleted === undefined) continue
    stat.files++
    // Binary files report "-".
    stat.additions += Number(added) || 0
    stat.deletions += Number(deleted) || 0
  }
  return stat
}

export async function workspaceDiff(ws: Workspace, scope: DiffScope = 'all', tree?: string): Promise<WorkspaceDiff> {
  // A caller that already holds a snapshot of the working tree (like archive's checkpoint) can pass it
  // in and skip re-scanning every file for the diff; otherwise one only just taken serves.
  const at = workspaceTarget(ws)
  const [ends, workingTree] = await Promise.all([branchPoint(ws, at), tree ?? sharedWorkingTree(at, Date.now() - VIEW_REUSE_MS)])
  let { baseRef, mergeBase } = ends
  // Uncommitted: compare the working tree with HEAD instead of the branch point.
  if (scope === 'uncommitted') {
    const head = await revParse(at, 'HEAD')
    if (head) {
      mergeBase = head
      baseRef = 'HEAD'
    }
  }
  const [{ stdout }, raw] = await Promise.all([
    git(at, [
      '-c', 'core.quotePath=false',
      'diff', '--no-color', '--no-ext-diff', '--find-renames',
      '--src-prefix=a/', '--dst-prefix=b/',
      mergeBase, workingTree
    ]),
    git(at, ['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--find-renames', mergeBase, workingTree], { allowFail: true })
  ])
  const truncated = stdout.length > MAX_DIFF_BYTES
  const files = parseUnifiedDiff(truncated ? stdout.slice(0, MAX_DIFF_BYTES) : stdout)
  const blobs = parseRawDiff(raw.stdout)
  for (const file of files) file.blobId = blobs.get(file.path)
  return { baseRef, scope, files, truncated, mergeBase }
}

/** New-side blob id by path from `git diff --raw -z --no-abbrev`. */
export function parseRawDiff(text: string): Map<string, string> {
  const blobs = new Map<string, string>()
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const meta = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) (\w)/.exec(parts[i])
    if (!meta) continue
    // Renames and copies carry the old path first, then the new one.
    const renamed = meta[2] === 'R' || meta[2] === 'C'
    const path = renamed ? parts[i + 2] : parts[i + 1]
    if (path !== undefined) blobs.set(path, meta[1])
    i += renamed ? 2 : 1
  }
  return blobs
}

/** The given files between two commits (an alert's start and end checkpoints). */
export async function refsDiff(dir: GitTarget, startRef: string, endRef: string, files: string[]): Promise<WorkspaceDiff> {
  const { stdout } = await git(dir, [
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/',
    startRef, endRef, '--', ...files.map((f) => `:(literal)${f}`)
  ])
  const truncated = stdout.length > MAX_DIFF_BYTES
  return { baseRef: startRef, scope: 'all', files: parseUnifiedDiff(truncated ? stdout.slice(0, MAX_DIFF_BYTES) : stdout), truncated }
}

/**
 * O6: a file's text at a ref (a sensitive-alert diff's end checkpoint), so its diff can show the unchanged
 * lines between hunks. Only for a path the diff names; binary or over 2 MB comes back without text.
 */
export async function fileAtRef(dir: GitTarget, ref: string, file: string): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  if (ref.startsWith('-') || file.startsWith('-')) throw new Error('Not a file at that point')
  const size = await git(dir, ['cat-file', '-s', `${ref}:${file}`], { allowFail: true })
  if (size.code !== 0) throw new Error(`${file} isn’t in that checkpoint`)
  if (Number(size.stdout.trim()) > 2 * 1024 * 1024) return { content: '', binary: false, tooLarge: true }
  const { stdout } = await git(dir, ['show', `${ref}:${file}`])
  const binary = stdout.slice(0, 8000).includes('\u0000')
  return { content: binary ? '' : stdout, binary, tooLarge: false }
}

// Header paths: git quotes unusual names and appends a tab after names with spaces.
function unquote(header: string): string {
  const raw = header.replace(/\t$/, '')
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = { path: m?.[2] ?? '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = Number(m?.[1] ?? 0)
      newNo = Number(m?.[2] ?? 0)
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (!hunk) {
      // File header lines.
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
      else if (line.startsWith('Binary files ')) file.binary = true
      else if (line.startsWith('--- ')) {
        const p = unquote(line.slice(4))
        if (p !== '/dev/null' && file.status === 'deleted') file.path = stripPrefix(p, 'a/')
      } else if (line.startsWith('+++ ')) {
        const p = unquote(line.slice(4))
        if (p !== '/dev/null') file.path = stripPrefix(p, 'b/')
      }
      continue
    }

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
      file.additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
      file.deletions++
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
    // "\ No newline at end of file" and the trailing empty line are skipped.
  }
  return files
}

/** The whole patch against the base (up to the diff size limit) with its totals, for handing to another chat. */
export async function workspaceDiffPatch(ws: Workspace): Promise<{ text: string; baseRef: string; files: number; additions: number; deletions: number; cut: boolean; tree: string }> {
  const at = workspaceTarget(ws)
  const { baseRef, mergeBase, tree } = await diffEnds(ws, at)
  const base = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames']
  const [patch, numstat] = await Promise.all([git(at, [...base, mergeBase, tree]), git(at, [...base, '--numstat', mergeBase, tree])])
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of numstat.stdout.split('\n')) {
    const [added, deleted] = line.split('\t')
    if (deleted === undefined) continue
    files++
    additions += Number(added) || 0
    deletions += Number(deleted) || 0
  }
  const cut = patch.stdout.length > MAX_DIFF_BYTES
  // #17: the tree the patch was taken from, so an auto review is tied to exactly what it read.
  return { text: cut ? patch.stdout.slice(0, MAX_DIFF_BYTES) : patch.stdout, baseRef, files, additions, deletions, cut, tree }
}

/** #17: the files that differ between a tree (or the branch's start, for null) and another tree. */
export async function changedFilesBetween(ws: Workspace, from: string | null, to: string): Promise<string[]> {
  const at = workspaceTarget(ws)
  const start = from ?? (await branchPoint(ws, at)).mergeBase
  const { stdout } = await git(at, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-ext-diff', '--no-renames', start, to])
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Raw diff text for the agent's GetWorkspaceDiff tool. */
export async function workspaceDiffText(ws: Workspace, file?: string, stat = false): Promise<string> {
  const at = workspaceTarget(ws)
  const { mergeBase, tree } = await diffEnds(ws, at)
  const args = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', ...(stat ? ['--stat'] : []), mergeBase, tree]
  if (file) args.push('--', file)
  const { stdout } = await git(at, args)
  if (!stdout.trim()) return 'No changes found.'
  return stdout.length > 200_000 ? `${stdout.slice(0, 200_000)}\n… (diff truncated; ask for one file at a time)` : stdout
}

/** Put a file back the way it was where the branch started (deleting it if it is new). */
export async function revertFile(ws: Workspace, file: string): Promise<void> {
  if (file.startsWith('/') || file.split(/[\\/]/).includes('..')) throw new Error('Invalid path')
  // The user asked for it: a sleeping sandbox wakes.
  const at = workspaceTarget(ws, { wake: true })
  const { mergeBase } = await branchPoint(ws, at)
  const existed = (await git(at, ['cat-file', '-e', `${mergeBase}:${file}`], { allowFail: true })).code === 0
  if (existed) {
    await git(at, ['checkout', mergeBase, '--', file])
  } else {
    await git(at, ['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', file])
    if (typeof at === 'string') await rm(path.join(at, file), { force: true })
    else await at.exec('bash', ['-c', 'rm -f -- "$1"', 'rm', file])
  }
  // A snapshot taken while the file went must not stand for the tree now.
  if (typeof at === 'string') noteWorktreeChanged(at)
}
