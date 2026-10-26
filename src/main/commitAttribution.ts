// G2 (O5): which tab made each commit, cached. A tab is named only when exactly one tab's finished
// `git` tool call printed the commit's `[branch abc1234]` line (shared/diffSource.ts decides); this
// keeps the work from being redone every time the Commits tab loads:
//  - each chat's sightings are kept until the chat changes (a running tab is always read again, since
//    its tool events don't move `lastActivityAt`);
//  - a commit, once named, stays named: a sha is made once, and its line can't be printed by another
//    tab's commit. A commit not named yet is looked for again next time.
import type { ChatItem, Session } from '../shared/types'
import { sightingsInChat, tabForCommit, type CommitSighting } from '../shared/diffSource'

type Tab = Pick<Session, 'id' | 'status' | 'lastActivityAt' | 'lastTurn'>

/** What says a chat may have changed since it was read. Null: always read again. */
function chatVersion(tab: Tab): string | null {
  if (tab.status === 'running') return null
  return `${tab.lastActivityAt ?? ''}|${tab.lastTurn?.endedAt ?? ''}|${tab.lastTurn?.turnId ?? ''}`
}

export class CommitAttribution {
  private chats = new Map<string, { version: string; sightings: CommitSighting[] }>()
  private named = new Map<string, string>()
  // How many chats were read, for tests.
  reads = 0

  constructor(private readChat: (sessionId: string) => Promise<ChatItem[]>) {}

  private async sightings(tab: Tab): Promise<CommitSighting[]> {
    const version = chatVersion(tab)
    const hit = this.chats.get(tab.id)
    if (hit && version !== null && hit.version === version) return hit.sightings
    this.reads++
    const sightings = sightingsInChat(tab.id, await this.readChat(tab.id).catch(() => []))
    if (version !== null) this.chats.set(tab.id, { version, sightings })
    else this.chats.delete(tab.id)
    return sightings
  }

  /** The tab that made each commit, for the commits Foreman can name. Tabs are the workspace's, open or closed. */
  async attribute(workspaceId: string, tabs: Tab[], shas: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const ids = new Set(tabs.map((t) => t.id))
    const unknown: string[] = []
    for (const sha of shas) {
      const known = this.named.get(`${workspaceId}:${sha}`)
      if (known && ids.has(known)) out.set(sha, known)
      else unknown.push(sha)
    }
    if (!unknown.length) return out
    const sightings = (await Promise.all(tabs.map((t) => this.sightings(t)))).flat()
    for (const sha of unknown) {
      const tab = tabForCommit(sha, sightings)
      if (!tab) continue
      out.set(sha, tab)
      this.named.set(`${workspaceId}:${sha}`, tab)
    }
    return out
  }

  /** A workspace went away (archived, removed): drop what was kept for it. */
  forget(workspaceId: string, sessionIds: string[]): void {
    for (const key of [...this.named.keys()]) if (key.startsWith(`${workspaceId}:`)) this.named.delete(key)
    for (const id of sessionIds) this.chats.delete(id)
  }
}
