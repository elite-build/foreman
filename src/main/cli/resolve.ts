// "Name, id or ." lookups: which repository, workspace or tab a command means, with one set of error texts.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { tabListText } from '../../shared/tabs'
import type { Repo, Session, Workspace } from '../../shared/types'
import { git } from '../git'
import { CliCodedError } from './host'

function realpath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** How deep `child` sits inside `parent` (0 = the same folder), or -1 when outside it. */
function depthInside(child: string, parent: string): number {
  const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase())
  const rel = path.relative(fold(realpath(parent)), fold(realpath(child)))
  if (rel === '') return 0
  if (rel.startsWith('..') || path.isAbsolute(rel)) return -1
  return rel.split(path.sep).length
}

/**
 * The repository a command means: the one named by `query` (name, id or folder),
 * else the one containing `cwd` (its folder, one of its workspaces, or another
 * worktree of it), else the only one there is.
 */
export async function resolveRepo(state: { repos: Repo[]; workspaces: Workspace[] }, cwd: string, query?: string): Promise<Repo> {
  const { repos } = state
  if (!repos.length) throw new Error('Add a repository to Foreman first')
  const names = () => repos.map((r) => r.name).join(', ')
  if (query?.trim()) {
    const q = query.trim().toLowerCase()
    const found =
      repos.find((r) => r.id === query.trim()) ??
      repos.find((r) => r.name.toLowerCase() === q) ??
      repos.find((r) => depthInside(path.resolve(cwd, query.trim()), r.rootPath) === 0)
    if (!found) throw new Error(`No repository named “${query.trim()}”. Repositories: ${names()}`)
    return found
  }
  // The closest enclosing folder wins, so a workspace nested in its repository's folder counts as the workspace.
  let best: { repo: Repo; depth: number } | undefined
  const consider = (repoId: string, folder: string) => {
    const depth = depthInside(cwd, folder)
    const repo = repos.find((r) => r.id === repoId)
    if (repo && depth >= 0 && (!best || depth < best.depth)) best = { repo, depth }
  }
  for (const ws of state.workspaces) if (ws.state !== 'archived' && ws.path) consider(ws.repoId, ws.path)
  for (const repo of repos) consider(repo.id, repo.rootPath)
  if (best) return best.repo
  // A worktree Foreman doesn't know about: its common git dir sits in the main checkout.
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true }).catch(() => null)
  if (common?.code === 0) {
    const main = path.dirname(common.stdout.trim())
    const repo = repos.find((r) => depthInside(main, r.rootPath) === 0)
    if (repo) return repo
  }
  if (repos.length === 1) return repos[0]
  throw new Error(`Run this inside a repository Foreman knows, or pass --repo. Repositories: ${names()}`)
}

/** The workspace a command means: the closest one whose folder contains `cwd`. */
export function resolveWorkspace(state: { workspaces: Workspace[] }, cwd: string): Workspace {
  let best: { ws: Workspace; depth: number } | undefined
  for (const ws of state.workspaces) {
    if (ws.state === 'archived' || !ws.path) continue
    const depth = depthInside(cwd, ws.path)
    if (depth >= 0 && (!best || depth < best.depth)) best = { ws, depth }
  }
  if (!best) throw new Error('Run this inside one of Foreman’s workspaces')
  return best.ws
}

/** The workspace named by `query` (id, name or branch; "." for the one containing `cwd`). */
export function findWorkspace(state: { repos: Repo[]; workspaces: Workspace[] }, query: string, cwd: string): Workspace {
  if (query === '.') return resolveWorkspace(state, cwd)
  const live = state.workspaces.filter((w) => w.state !== 'archived')
  const q = query.trim().toLowerCase()
  const byId = live.find((w) => w.id === query.trim())
  if (byId) return byId
  const matches = (pick: (w: Workspace) => string) => live.filter((w) => pick(w).toLowerCase() === q)
  const found = [matches((w) => w.name), matches((w) => w.branch)].find((m) => m.length > 0)
  if (!found) throw new Error(`No workspace named “${query}”. \`foreman status\` lists them.`)
  if (found.length > 1) {
    const repoName = (w: Workspace) => state.repos.find((r) => r.id === w.repoId)?.name ?? w.repoId
    throw new Error(`“${query}” matches several workspaces: ${found.map((w) => `${w.name} (${repoName(w)}, id ${w.id})`).join('; ')}. Pass the id.`)
  }
  return found[0]
}

/**
 * One explicit open tab of `ws`, counting from 1. Without `n` it is the only tab; with several it
 * refuses and lists them, so nothing is ever sent to a tab the caller didn't pick.
 */
export function findTab(sessions: Session[], ws: Workspace, n?: number): { tab: number; session: Session } {
  const tabs = sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  let tab: number
  if (n !== undefined) {
    if (!Number.isInteger(n) || n < 1 || n > tabs.length) {
      throw new CliCodedError('not-found', `${ws.name} has no tab ${n}. Its open tabs:\n${tabListText(tabs)}`)
    }
    tab = n
  } else if (tabs.length === 1) tab = 1
  else throw new CliCodedError('ambiguous', `${ws.name} has ${tabs.length} open tabs. Pick one with --tab <n>:\n${tabListText(tabs)}`)
  return { tab, session: tabs[tab - 1] }
}
