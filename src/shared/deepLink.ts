// #3 foreman:// links. Navigation only: a link names a place (Home, a workspace, one of its tabs) and
// opening it shows that place. Nothing in a link can send, approve, run or restore anything, and any
// other part of the URL is ignored. Pure, so parsing and routing are tested without a window.
import type { AppSnapshot, Session, Workspace } from './types'

export const LINK_SCHEME = 'foreman'

/** foreman://workspace/<repo>/<workspace>?tab=N (names, as the sidebar shows them; tab counts from 1). */
export function workspaceLink(repoName: string, workspaceName: string, tab?: number): string {
  const query = tab && tab > 0 ? `?tab=${tab}` : ''
  return `${LINK_SCHEME}://workspace/${encodeURIComponent(repoName)}/${encodeURIComponent(workspaceName)}${query}`
}

export type ParsedLink = { kind: 'home' } | { kind: 'workspace'; repo: string; workspace: string; tab?: number }

/** What a link names, or null when it isn't a foreman:// link this version understands. */
export function parseLink(url: string): ParsedLink | null {
  const match = /^foreman:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(url.trim())
  if (!match) return null
  const parts = match[1].split('/').filter(Boolean)
  let decoded: string[]
  try {
    decoded = parts.map((p) => decodeURIComponent(p))
  } catch {
    return null
  }
  const [kind, ...rest] = decoded
  if (kind?.toLowerCase() === 'home' && rest.length === 0) return { kind: 'home' }
  if (kind?.toLowerCase() !== 'workspace' || rest.length !== 2 || !rest[0].trim() || !rest[1].trim()) return null
  const tabText = new URLSearchParams(match[2] ?? '').get('tab')
  const tab = tabText && /^\d{1,3}$/.test(tabText) && Number(tabText) > 0 ? Number(tabText) : undefined
  return { kind: 'workspace', repo: rest[0], workspace: rest[1], ...(tab ? { tab } : {}) }
}

/** Why a link opened somewhere other than it named, said once on arrival. */
export type LinkNotice = 'invalid' | 'missing-repo' | 'missing-workspace' | 'tab-missing'

export type LinkRoute =
  | { kind: 'home'; notice?: LinkNotice }
  | { kind: 'workspace'; workspaceId: string; sessionId?: string; notice?: LinkNotice }
  // #13: an archived workspace opens read-only; nothing is restored.
  | { kind: 'archived'; workspaceId: string; sessionId?: string; notice?: LinkNotice }

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

function pickWorkspace(candidates: Workspace[]): Workspace | undefined {
  // A live workspace wins over an archived one of the same name; among archived, the latest.
  return candidates.find((w) => w.state !== 'archived') ?? candidates.filter((w) => w.state === 'archived').sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))[0]
}

/** The tab a link's number names: open tabs in order, as the tab strip shows them. */
function tabAt(sessions: Session[], workspaceId: string, tab: number | undefined): { sessionId?: string; missing: boolean } {
  if (!tab) return { missing: false }
  const open = sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
  const session = open[tab - 1]
  return session ? { sessionId: session.id, missing: false } : { missing: true }
}

/** Where a link goes, decided the same way every time: a missing repo or workspace goes Home and says so. */
export function routeLink(url: string, snapshot: Pick<AppSnapshot, 'repos' | 'workspaces' | 'sessions'>): LinkRoute {
  const link = parseLink(url)
  if (!link) return { kind: 'home', notice: 'invalid' }
  if (link.kind === 'home') return { kind: 'home' }
  const repos = snapshot.repos.filter((r) => same(r.name, link.repo))
  if (!repos.length) return { kind: 'home', notice: 'missing-repo' }
  const ids = new Set(repos.map((r) => r.id))
  const ws = pickWorkspace(snapshot.workspaces.filter((w) => ids.has(w.repoId) && same(w.name, link.workspace)))
  if (!ws) return { kind: 'home', notice: 'missing-workspace' }
  const tab = tabAt(snapshot.sessions, ws.id, link.tab)
  const notice = tab.missing ? ({ notice: 'tab-missing' } as const) : {}
  const sessionId = tab.sessionId ? { sessionId: tab.sessionId } : {}
  return { kind: ws.state === 'archived' ? 'archived' : 'workspace', workspaceId: ws.id, ...sessionId, ...notice }
}

/** foreman:// links on a command line (Windows and Linux hand them over this way, at launch or to the running app). */
export function linksIn(argv: readonly string[]): string[] {
  return argv.filter((a) => /^foreman:\/\//i.test(a))
}
