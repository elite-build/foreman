// Workspace files: listing for @-mentions, and chat attachments stored in
// the workspace's .context folder (excluded from git so they never show up
// in diffs or commits). A cloud workspace's attachments are written into its
// sandbox's worktree, through its runtime, and its agent reads them there.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Attachment } from '../shared/types'
import { git, gitOut, type GitTarget } from './git'
import type { WorkspaceRuntime } from './runtime/types'

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_LISTED_FILES = 20_000

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const TEXT = /\.(txt|md|markdown|json|ya?ml|toml|csv|log|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|sql|env)$/i

function kindFor(name: string): Attachment['kind'] {
  if (IMAGE.test(name)) return 'image'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (TEXT.test(name)) return 'text'
  return 'file'
}

/** Keep .context/ out of git without touching the repo's .gitignore. */
export async function excludeContextDir(workspacePath: GitTarget): Promise<void> {
  if (typeof workspacePath !== 'string') return excludeInRuntime(workspacePath)
  const common = await gitOut(workspacePath, ['rev-parse', '--git-common-dir'])
  const exclude = path.resolve(workspacePath, common, 'info', 'exclude')
  const current = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
  if (current.split(/\r?\n/).some((line) => line.trim() === '.context/')) return
  await mkdir(path.dirname(exclude), { recursive: true })
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.context/\n`)
}

async function excludeInRuntime(rt: WorkspaceRuntime): Promise<void> {
  const common = await gitOut(rt, ['rev-parse', '--git-common-dir'])
  const exclude = path.posix.resolve(rt.cwd, common, 'info', 'exclude')
  const current = (await rt.readFile(exclude))?.toString('utf8') ?? ''
  if (current.split(/\r?\n/).some((line) => line.trim() === '.context/')) return
  await rt.writeFile(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.context/\n`)
}

async function attachmentsDir(workspacePath: string): Promise<string> {
  const dir = path.join(workspacePath, '.context', 'attachments')
  await mkdir(dir, { recursive: true })
  await excludeContextDir(workspacePath).catch(() => undefined)
  return dir
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'attachment'
}

/** A unique destination so two attachments with the same name don't collide. */
async function destination(workspacePath: string, name: string): Promise<string> {
  const dir = path.join(await attachmentsDir(workspacePath), randomUUID().slice(0, 8))
  await mkdir(dir, { recursive: true })
  return path.join(dir, safeName(name))
}

/** A unique destination in a runtime's worktree (a cloud sandbox), with .context/ kept out of git there. */
async function runtimeDestination(rt: WorkspaceRuntime, name: string): Promise<string> {
  const dir = path.posix.join(rt.cwd, '.context', 'attachments', randomUUID().slice(0, 8))
  await rt.mkdir(dir)
  await excludeInRuntime(rt).catch(() => undefined)
  return path.posix.join(dir, safeName(name))
}

/** A file on this computer attached to a message; a cloud workspace gets a copy in its sandbox. */
export async function attachFromPath(workspacePath: GitTarget, source: string): Promise<Attachment> {
  const info = await stat(source)
  if (!info.isFile()) throw new Error(`${path.basename(source)} is not a file`)
  if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(source)} is larger than 100 MB`)
  if (typeof workspacePath !== 'string') {
    const target = await runtimeDestination(workspacePath, path.basename(source))
    await workspacePath.writeFile(target, await readFile(source))
    return { name: path.basename(source), path: target, kind: kindFor(source) }
  }
  const target = await destination(workspacePath, path.basename(source))
  await copyFile(source, target)
  return { name: path.basename(source), path: target, kind: kindFor(source) }
}

export async function attachFromData(workspacePath: GitTarget, name: string, base64: string): Promise<Attachment> {
  const data = Buffer.from(base64, 'base64')
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 100 MB`)
  if (typeof workspacePath !== 'string') {
    const target = await runtimeDestination(workspacePath, name)
    await workspacePath.writeFile(target, data)
    return { name, path: target, kind: kindFor(name) }
  }
  const target = await destination(workspacePath, name)
  await writeFile(target, data)
  return { name, path: target, kind: kindFor(name) }
}

/** Pasted data saved before its workspace exists (the new-workspace dialog); copied in with attachFromPath when the message goes. */
export async function stageAttachment(stagingDir: string, name: string, base64: string): Promise<string> {
  const data = Buffer.from(base64, 'base64')
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 100 MB`)
  const dir = path.join(stagingDir, randomUUID().slice(0, 8))
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, safeName(name))
  await writeFile(target, data)
  return target
}

/** Text appended to a prompt so the agent knows where its attachments are. A runtime's are sandbox paths. */
export function attachmentNote(workspacePath: GitTarget, attachments: Attachment[]): string {
  if (!attachments.length) return ''
  const rel = (p: string) => (typeof workspacePath === 'string' ? path.relative(workspacePath, p).split(path.sep).join('/') : path.posix.relative(workspacePath.cwd, p))
  const lines = attachments.map((a) => `- ${rel(a.path)} (${a.kind})`)
  return `\n\nThe user attached these files (read them as needed):\n${lines.join('\n')}`
}

/** Tracked and untracked (not ignored) files, for @-mention search. */
export async function listWorkspaceFiles(workspacePath: GitTarget): Promise<string[]> {
  const { stdout } = await git(workspacePath, ['ls-files', '-co', '--exclude-standard', '-z'])
  return stdout.split('\0').filter(Boolean).slice(0, MAX_LISTED_FILES)
}

const MAX_VIEW_BYTES = 2 * 1024 * 1024

export function insideWorkspace(workspacePath: string, relative: string): string {
  const full = path.resolve(workspacePath, relative)
  const root = path.resolve(workspacePath)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('That file is outside the workspace')
  return full
}

/** File contents for the viewer; binary or huge files are not returned. A runtime's (a cloud sandbox's) are read there. */
export async function readWorkspaceFile(workspacePath: GitTarget, relative: string): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  if (typeof workspacePath !== 'string') {
    const root = workspacePath.cwd
    const full = path.posix.resolve(root, relative.replace(/\\/g, '/'))
    if (full !== root && !full.startsWith(`${root}/`)) throw new Error('That file is outside the workspace')
    const data = await workspacePath.readFile(full)
    if (!data) throw new Error(`${relative} isn’t in the workspace`)
    if (data.length > MAX_VIEW_BYTES) return { content: '', binary: false, tooLarge: true }
    const binary = data.subarray(0, 8000).includes(0)
    return { content: binary ? '' : data.toString('utf8'), binary, tooLarge: false }
  }
  const full = insideWorkspace(workspacePath, relative)
  const info = await stat(full)
  if (info.size > MAX_VIEW_BYTES) return { content: '', binary: false, tooLarge: true }
  const data = await readFile(full)
  const binary = data.subarray(0, 8000).includes(0)
  return { content: binary ? '' : data.toString('utf8'), binary, tooLarge: false }
}

export async function writeWorkspaceFile(workspacePath: string, relative: string, content: string): Promise<void> {
  await writeFile(insideWorkspace(workspacePath, relative), content)
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

/** Search tracked and untracked files (honoring .gitignore) with git grep. */
export async function searchWorkspace(
  workspacePath: GitTarget,
  query: string,
  options: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean } = {}
): Promise<SearchMatch[]> {
  if (!query) return []
  const args = ['grep', '-n', '-I', '--untracked', '--no-color', '--full-name', '-m', '50']
  if (!options.caseSensitive) args.push('-i')
  if (options.wholeWord) args.push('-w')
  args.push(options.regex ? '-E' : '-F', '-e', query)
  const r = await git(workspacePath, args, { allowFail: true, timeoutMs: 20_000 })
  // git grep exits 1 for "no matches".
  if (r.code > 1) throw new Error(r.stderr.trim() || 'Search failed')
  const matches: SearchMatch[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line)
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].slice(0, 300) })
    if (matches.length >= 500) break
  }
  return matches
}
