// Folders dropped on the window, or named on the command line (Windows and Linux pass a
// folder dropped on the app's icon or shortcut this way), sorted out for the Add repository
// confirmation (O21). Everything here only reads: nothing is added until the user says Add.
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DroppedFolder, Repo } from '../shared/types'
import { git, isInsideWorkTree, repoEvidence, toplevel } from './git'
import { safeDirName } from './platform'
import { samePath } from './workspaces'

/** A remote URL as host/path: no scheme, credentials or .git (git@github.com:a/b.git → github.com/a/b). */
export function displayRemote(url: string): string {
  // A remote on disk (C:\repos\x, /srv/x.git, ../x) stays a path.
  if (/^([a-z]:[\\/]|[\\/.])/i.test(url.trim())) return url.trim()
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
}

async function classifyOne(full: string, repos: Pick<Repo, 'id' | 'rootPath'>[], workspacesRoot: string): Promise<DroppedFolder> {
  const name = path.basename(full) || full
  const info = await stat(full).catch(() => null)
  if (!info) return { path: full, name, kind: 'missing' }
  if (!info.isDirectory()) return { path: full, name, kind: 'file' }
  if (!(await isInsideWorkTree(full))) return { path: full, name, kind: 'not-git' }
  // git prints forward slashes on Windows; addRepo adds the top folder, so that's what is shown.
  const root = path.normalize(await toplevel(full))
  const existing = repos.find((r) => samePath(r.rootPath, root))
  if (existing) return { path: full, name, kind: 'added', root, repoId: existing.id }
  const branch = await git(root, ['branch', '--show-current'], { allowFail: true })
  const { remoteUrl } = await repoEvidence(root, 'origin')
  return {
    path: full,
    name,
    kind: 'repo',
    root,
    branch: (branch.code === 0 && branch.stdout.trim()) || null,
    origin: remoteUrl ? displayRemote(remoteUrl) : null,
    workspacesDir: path.join(workspacesRoot, safeDirName(path.basename(root)))
  }
}

/** What each path is, in the order given; repeats (the same folder twice) are left out. */
export async function classifyFolders(paths: string[], repos: Pick<Repo, 'id' | 'rootPath'>[], workspacesRoot: string): Promise<DroppedFolder[]> {
  const seen: string[] = []
  const result: DroppedFolder[] = []
  for (const given of paths) {
    if (!given) continue
    const full = path.resolve(given)
    if (seen.some((p) => samePath(p, full))) continue
    seen.push(full)
    result.push(await classifyOne(full, repos, workspacesRoot))
  }
  return result
}

/**
 * Paths named on a launch's command line. argv[0] is the executable; switches (Chromium's
 * `--…`, macOS's `-psn_…`) and the app itself (run from source, argv[1] is its folder) are
 * skipped. Linux launchers pass file:// URIs (%U); other URLs are ignored. Relative paths
 * resolve against the launch's working folder. Whether each is a folder is decided later.
 */
export function launchPaths(argv: readonly string[], options: { cwd: string; skip?: string[]; platform?: NodeJS.Platform }): string[] {
  const platform = options.platform ?? process.platform
  const key = (p: string) => (platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase())
  const skip = new Set((options.skip ?? []).filter(Boolean).map(key))
  const result: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    let candidate = arg
    if (/^file:\/\//i.test(arg)) {
      try {
        candidate = fileURLToPath(arg)
      } catch {
        continue
      }
    } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(arg)) continue
    const full = path.resolve(options.cwd, candidate)
    if (skip.has(key(full)) || result.some((p) => key(p) === key(full))) continue
    result.push(full)
  }
  return result
}
