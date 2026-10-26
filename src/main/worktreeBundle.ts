// Capture and restore of a workspace's branch and uncommitted work as a git bundle.
// Capture: quiesce (the caller checks), checkpoint (untracked files included), prove
// nothing moved while it ran, bundle. Restore: verify against the destination repo,
// fetch into new refs (never over an existing branch), then a new worktree gets the
// checkpoint restored. Hooks are off for every git call that could run one.
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OMITTED_LIMIT, dirtySubmodules, freeBranchName, incompatibleNames, lfsMissing, type WorktreeInfo, type WorktreeNote, type WorktreeSkip } from '../shared/worktreeBundle'
import { deleteCheckpoints, saveCheckpoint, CHECKPOINT_REF_PREFIX } from './checkpoints'
import { filesToCopy } from './filesToCopy'
import { busyOperation, git, gitOut, hasUnmergedPaths, revParse } from './git'

/** Config that keeps repository hooks from running during import-side git calls. */
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

export type Capture =
  | { ok: true; info: WorktreeInfo; bundle: Buffer; files: { entry: string; data: Buffer }[] }
  | { ok: false; reason: WorktreeSkip | 'changed' | 'failed'; message: string }

interface Fingerprint {
  head: string | null
  tree: string
  index: string
}

async function fingerprint(dir: string): Promise<Fingerprint> {
  // write-tree can refresh the index file's cached tree, so it runs first; then the bytes are stable.
  const tree = await gitOut(dir, ['write-tree'])
  const indexPath = path.resolve(dir, await gitOut(dir, ['rev-parse', '--git-path', 'index']))
  const bytes = await readFile(indexPath).catch(() => Buffer.alloc(0))
  return { head: await revParse(dir, 'HEAD'), tree, index: createHash('sha256').update(bytes).digest('hex') }
}

export interface CaptureOptions {
  dir: string
  branch: string
  baseBranch: string
  id: string
  // Patterns of the repo's "files to copy" list when the user chose to bring those ignored files; null otherwise.
  copyPatterns: string[] | null
  maxFileBytes: number
  maxTotalBytes: number
  // Runs between the checkpoint and the revalidation (a seam for tests).
  afterCheckpoint?: () => Promise<void>
}

export async function captureWorktree(options: CaptureOptions): Promise<Capture> {
  const { dir } = options
  if ((await revParse(dir, 'HEAD')) === null) return { ok: false, reason: 'unborn', message: 'This repository has no commits yet, so there is no branch to bundle. Commit once, then export again.' }
  const busy = await busyOperation(dir)
  if (busy || (await hasUnmergedPaths(dir))) return { ok: false, reason: 'merge', message: `${busy ? `A ${busy} is in progress` : 'There are unresolved merge conflicts'}. Finish or abort it, then export again.` }

  const notes: WorktreeNote[] = []
  const cpId = `export-${options.id}`
  const cpRef = CHECKPOINT_REF_PREFIX + cpId
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'foreman-bundle-'))
  try {
    const before = await fingerprint(dir)
    const saved = await saveCheckpoint(dir, cpId)
    if (!saved.ok) return { ok: false, reason: 'merge', message: `Couldn’t snapshot the worktree: ${saved.reason}.` }
    await options.afterCheckpoint?.()
    const after = await fingerprint(dir)
    if (after.head !== before.head || after.index !== before.index || after.tree !== before.tree) {
      return { ok: false, reason: 'changed', message: 'The worktree changed while it was being captured (HEAD or the index moved). Nothing was exported; try again when nothing is writing to it.' }
    }
    const head = before.head!

    // What did not come along, said plainly.
    const status = await git(dir, ['status', '--porcelain=v2'], { allowFail: true })
    const subs = dirtySubmodules(status.stdout)
    if (subs.length) notes.push({ kind: 'submodule', text: `Submodule changes aren’t included (the bundle holds the main repository only): ${subs.join(', ')}.` })
    const attrs = await git(dir, ['grep', '-l', 'filter=lfs', '--', '.gitattributes', '**/.gitattributes'], { allowFail: true })
    if (attrs.code === 0) {
      const lfs = await git(dir, ['lfs', 'ls-files'], { allowFail: true })
      if (lfs.code !== 0) notes.push({ kind: 'lfs', text: 'This repository uses Git LFS, but git-lfs isn’t available here, so missing large files can’t be checked. The bundle holds LFS pointers only.' })
      else {
        const missing = lfsMissing(lfs.stdout)
        if (missing.length) notes.push({ kind: 'lfs', text: `${missing.length} Git LFS file${missing.length === 1 ? ' isn’t' : 's aren’t'} downloaded here, so only pointers travel: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}.` })
        else notes.push({ kind: 'lfs', text: 'Git LFS file contents aren’t in the bundle (only pointers); run git lfs pull after activating.' })
      }
    }
    const tracked = (await gitOut(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    const odd = incompatibleNames(tracked)
    if (odd.length) notes.push({ kind: 'filenames', text: `${odd.length} file name${odd.length === 1 ? '' : 's'} may not work on every system: ${odd.slice(0, 5).join(', ')}${odd.length > 5 ? ', …' : ''}.` })

    // Ignored files stay behind unless the user chose the "files to copy" ones.
    const ignored = (await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { allowFail: true })).stdout
      .split('\0')
      .filter((f) => f && !f.startsWith('.git/') && !f.startsWith('.context/'))
      .sort()
    const brought: { path: string; entry: string }[] = []
    const files: { entry: string; data: Buffer }[] = []
    const left = new Set(ignored)
    if (options.copyPatterns?.length) {
      let total = 0
      for (const rel of await filesToCopy(dir, options.copyPatterns)) {
        for (const file of await expand(dir, rel)) {
          const info = await stat(path.join(dir, file)).catch(() => null)
          if (!info?.isFile()) continue
          if (info.size > options.maxFileBytes || total + info.size > options.maxTotalBytes) {
            notes.push({ kind: 'files', text: `${file} is too large to include.` })
            continue
          }
          total += info.size
          const entry = `worktree/files/${files.length}`
          files.push({ entry, data: await readFile(path.join(dir, file)) })
          brought.push({ path: file, entry })
        }
        left.delete(rel)
      }
    }
    const omitted = [...left]
    if (omitted.length) notes.push({ kind: 'ignored', text: `${omitted.length} ignored item${omitted.length === 1 ? '' : 's'} (for example build output or dependencies) stay on this machine.` })

    // The bundle: the branch (when it isn't just the base) and the checkpoint commit.
    const refs: string[] = [cpRef]
    const branchRef = `refs/heads/${options.branch}`
    const tip = await revParse(dir, branchRef)
    if (!tip) notes.push({ kind: 'detached', text: `${options.branch} isn’t a branch in this worktree (HEAD is detached); it will be recreated from the commit.` })
    const baseTip = await revParse(dir, options.baseBranch)
    const mergeBase = baseTip ? await gitOut(dir, ['merge-base', head, baseTip], { allowFail: true }).catch(() => '') : ''
    const args = ['bundle', 'create', path.join(tmp, 'b.bundle')]
    if (tip && tip !== mergeBase) refs.unshift(branchRef)
    args.push(...refs)
    // History the destination already has (the shared base) stays out of the file; `verify` says if it doesn't.
    if (mergeBase) args.push(`^${mergeBase}`)
    await git(dir, args)
    const bundle = await readFile(path.join(tmp, 'b.bundle'))

    const info: WorktreeInfo = {
      branch: options.branch,
      head,
      checkpointId: cpId,
      checkpointRef: cpRef,
      omitted: omitted.slice(0, OMITTED_LIMIT),
      omittedMore: Math.max(0, omitted.length - OMITTED_LIMIT),
      files: brought,
      notes
    }
    return { ok: true, info, bundle, files }
  } catch (err) {
    return { ok: false, reason: 'failed', message: `Couldn’t bundle the worktree: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await deleteCheckpoints(dir, cpId).catch(() => undefined)
    await rm(tmp, { recursive: true, force: true })
  }
}

/** A folder from the copy list as its files; a file as itself. */
async function expand(root: string, rel: string): Promise<string[]> {
  const clean = rel.replace(/\/$/, '')
  const info = await stat(path.join(root, clean)).catch(() => null)
  if (!info) return []
  if (!info.isDirectory()) return [clean]
  const out: string[] = []
  for (const entry of await readdir(path.join(root, clean), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    out.push(...(await expand(root, `${clean}/${entry.name}`)))
  }
  return out
}

/** Whether the bundle verifies in this repository (its prerequisites are here and it is well formed). */
export async function verifyBundle(repoRoot: string, bundleFile: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await git(repoRoot, [...NO_HOOKS, 'bundle', 'verify', bundleFile], { allowFail: true })
  if (res.code === 0) return { ok: true }
  const detail = (res.stderr || res.stdout).trim().split('\n').filter(Boolean).slice(0, 3).join(' ')
  return { ok: false, error: /prerequisite|missing|lacks/i.test(detail) ? `This repository doesn’t have the history the bundle builds on (${detail}). Fetch the base branch, then try again.` : `The bundle doesn’t verify: ${detail || 'unknown error'}` }
}

export interface Fetched {
  branch: string
  checkpointId: string
}

/**
 * Bring the bundle's commits in under new names: the branch gets a free name (a suffix on a clash),
 * and the checkpoint gets its own ref. Existing branches and refs are never moved.
 */
export async function fetchBundle(repoRoot: string, bundleFile: string, info: WorktreeInfo, workspaceId: string): Promise<Fetched> {
  const verified = await verifyBundle(repoRoot, bundleFile)
  if (!verified.ok) throw new Error(verified.error)
  const heads = (await gitOut(repoRoot, ['bundle', 'list-heads', bundleFile])).split('\n').map((l) => l.trim().split(/\s+/)[1])
  const exists = new Map<string, boolean>()
  const taken = async (name: string) => {
    if (!exists.has(name)) exists.set(name, Boolean(await revParse(repoRoot, `refs/heads/${name}`)))
    return exists.get(name)!
  }
  // freeBranchName is synchronous; resolve every candidate it could ask for first.
  for (const candidate of [info.branch, ...Array.from({ length: 20 }, (_, n) => (n === 0 ? `${info.branch}-imported` : `${info.branch}-imported-${n + 1}`))]) await taken(candidate)
  const branch = freeBranchName(info.branch, (c) => exists.get(c) ?? false)
  const checkpointId = `import-${workspaceId}`
  const cpRef = CHECKPOINT_REF_PREFIX + checkpointId
  if (await revParse(repoRoot, cpRef)) throw new Error('This workspace’s checkpoint is already in the repository.')
  const want = [`${info.checkpointRef}:${cpRef}`]
  const hasBranch = heads.includes(`refs/heads/${info.branch}`)
  if (hasBranch) want.push(`refs/heads/${info.branch}:refs/heads/${branch}`)
  await git(repoRoot, [...NO_HOOKS, 'fetch', '--no-tags', bundleFile, ...want])
  if (!hasBranch) await git(repoRoot, ['branch', '--no-track', branch, info.head])
  return { branch, checkpointId }
}
