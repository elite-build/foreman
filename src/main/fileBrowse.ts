// The Files tab and image previews (#19): one folder of a worktree at a time,
// leaving out what git ignores and .git itself, and images read for the file
// viewer as data URLs (shown through <img>, so an SVG's scripts never run).
import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { sortEntries, type DirEntry, type DirListing } from '../shared/fileTree'
import { IMAGE_MIME, imageInfo, MAX_IMAGE_PREVIEW_BYTES, previewFormat, type ImagePreview } from '../shared/imageInfo'
import { insideWorkspace } from './files'
import { git } from './git'

// A folder with more entries than this lists the first ones (folders first) and says so.
export const MAX_DIR_ENTRIES = 2000
// Keeps each git check-ignore command line well under Windows' 32K limit.
const CHECK_IGNORE_CHARS = 8000

const isGitDir = (relative: string) => relative.split(/[\\/]/).includes('.git')

/** The folder's full path, refusing anything outside the worktree, inside .git, or reached through a link that leaves it. */
async function folderInside(workspacePath: string, relative: string): Promise<string> {
  if (isGitDir(relative)) throw new Error('The .git folder isn’t listed')
  const full = insideWorkspace(workspacePath, relative)
  const [root, real] = await Promise.all([realpath(workspacePath), realpath(full)])
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('That folder is outside the workspace')
  return full
}

/** Undo git's C-style quoting of an unusual name (a tab, a quote, a backslash). -z would avoid it but needs --stdin, which git() doesn't offer. */
export function unquoteGitPath(line: string): string {
  if (!line.startsWith('"') || !line.endsWith('"')) return line
  const bytes: number[] = []
  const body = Buffer.from(line.slice(1, -1), 'utf8')
  const named: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) {
      bytes.push(body[i])
      continue
    }
    const next = String.fromCharCode(body[i + 1])
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.subarray(i + 1, i + 4).toString(), 8))
      i += 3
    } else {
      bytes.push(named[next] ?? body[i + 1])
      i++
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Which of these worktree-relative paths git ignores. Not a repository, or git failing: none. */
async function ignoredPaths(workspacePath: string, paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  let batch: string[] = []
  let chars = 0
  const run = async () => {
    if (!batch.length) return
    // Exit 1 means none ignored; 128 is an error (not a repository).
    const r = await git(workspacePath, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...batch], { allowFail: true, timeoutMs: 20_000 })
    if (r.code === 0) for (const line of r.stdout.split('\n')) if (line) ignored.add(unquoteGitPath(line.replace(/\r$/, '')))
    batch = []
    chars = 0
  }
  for (const p of paths) {
    if (chars + p.length > CHECK_IGNORE_CHARS) await run()
    batch.push(p)
    chars += p.length + 3
  }
  await run()
  return ignored
}

/**
 * One folder of the worktree ('' is the top): folders first, then files by
 * name. .git is never listed, and neither is anything git ignores (tracked
 * files always are). Links are listed as files and never followed.
 */
export async function listWorkspaceDir(workspacePath: string, relative: string): Promise<DirListing> {
  if (path.isAbsolute(relative)) throw new Error('That folder is outside the workspace; use a workspace-relative path')
  const dir = relative.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const full = await folderInside(workspacePath, dir)
  let dirents: Dirent[]
  try {
    dirents = await readdir(full, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') throw new Error(`${dir} is not a folder`)
    throw err
  }
  const entries: DirEntry[] = dirents
    .filter((d) => d.name !== '.git')
    .map((d) => ({ name: d.name, path: dir ? `${dir}/${d.name}` : d.name, dir: d.isDirectory() }))
  const ignored = await ignoredPaths(workspacePath, entries.map((e) => e.path))
  const kept = sortEntries(entries.filter((e) => !ignored.has(e.path)))
  return { entries: kept.slice(0, MAX_DIR_ENTRIES), truncated: kept.length > MAX_DIR_ENTRIES }
}

/** A preview from bytes already read: format and size from the header, a data URL unless over the cap. */
function imagePreview(data: Buffer, format: NonNullable<ReturnType<typeof previewFormat>>): ImagePreview {
  if (data.length > MAX_IMAGE_PREVIEW_BYTES) return { format, bytes: data.length, tooLarge: true }
  const meta = imageInfo(data, format)
  return { ...meta, bytes: data.length, tooLarge: false, dataUrl: `data:${IMAGE_MIME[meta.format]};base64,${data.toString('base64')}` }
}

/** A commit id as the diff gives it (the branch point, or HEAD's id); never a name or an option. */
export const COMMIT_ID = /^[0-9a-f]{7,64}$/

/**
 * An image as it was at a commit, for the diff's before side (#19): `git show <commit>:<path>` read as bytes.
 * The commit must be an id and the path a plain worktree-relative one, so nothing reaches git as an option.
 */
export async function readImageAtCommit(workspacePath: string, relative: string, commit: string): Promise<ImagePreview> {
  const format = previewFormat(relative)
  if (!format) throw new Error('Foreman can’t preview this kind of file')
  if (!COMMIT_ID.test(commit)) throw new Error('Not a commit id')
  const rel = relative.replace(/\\/g, '/')
  insideWorkspace(workspacePath, rel)
  if (rel.startsWith('-') || isGitDir(rel)) throw new Error('Not a file in the workspace')
  const data = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', 'show', `${commit}:${rel}`],
      { cwd: workspacePath, encoding: 'buffer', maxBuffer: MAX_IMAGE_PREVIEW_BYTES + 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(new Error(`${relative} isn’t in that commit`)) : resolve(stdout))
    )
  })
  return imagePreview(data, format)
}

/** An image for the viewer: its format, pixel size and bytes, as a data URL unless it's over the cap. */
export async function readWorkspaceImage(workspacePath: string, relative: string): Promise<ImagePreview> {
  const format = previewFormat(relative)
  if (!format) throw new Error('Foreman can’t preview this kind of file')
  const full = insideWorkspace(workspacePath, relative)
  const info = await stat(full)
  if (!info.isFile()) throw new Error(`${relative} is not a file`)
  if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { format, bytes: info.size, tooLarge: true }
  const data = await readFile(full)
  const meta = imageInfo(data, format)
  return { ...meta, bytes: data.length, tooLarge: false, dataUrl: `data:${IMAGE_MIME[meta.format]};base64,${data.toString('base64')}` }
}
