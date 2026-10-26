// Search every chat: the FTS index in foreman.db, joined back to the workspace,
// tab and model each hit belongs to.
import { ftsQuery, HIT_END, HIT_START } from '../shared/chatIndex'
import type { ChatHit, ChatSearchOptions, NoteHit } from '../shared/types'
import type { Store } from './store'

const DEFAULT_LIMIT = 100

export function searchChats(store: Store, query: string, options: ChatSearchOptions = {}): ChatHit[] {
  const match = ftsQuery(query)
  if (!match) return []
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 500)
  const raw = store.db.searchItems(match, {
    toolOutput: Boolean(options.includeToolOutput),
    // Cleared and rewound items are searchable only when the user chose to keep them.
    cleared: store.state.settings.keepClearedHistory,
    // Fetch extra: hits of chats that no longer exist are dropped below.
    limit: limit * 2
  })
  const hits: ChatHit[] = []
  for (const hit of raw) {
    const session = store.state.sessions.find((s) => s.id === hit.sessionId)
    const workspace = session && store.state.workspaces.find((w) => w.id === session.workspaceId)
    if (!session || !workspace) continue
    const repo = store.state.repos.find((r) => r.id === workspace.repoId)
    hits.push({
      sessionId: session.id,
      itemId: hit.itemId,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      repoName: repo?.name ?? '',
      tabTitle: session.title ?? '',
      // O1: the agent and model that answered the hit's turn, in a tab that switched agents.
      agent: (hit.agent as ChatHit['agent'] | undefined) ?? session.agent,
      model: hit.model ?? session.model,
      kind: hit.kind as ChatHit['kind'],
      snippet: hit.snippet,
      at: hit.at,
      archived: workspace.state === 'archived',
      closed: Boolean(session.closedAt),
      cleared: hit.cleared
    })
    if (hits.length >= limit) break
  }
  return hits
}

const SNIPPET_SIDE = 60

/** Workspace notes that contain every word typed (case-insensitive), as their own kind of result. */
export function searchNotes(store: Store, query: string): NoteHit[] {
  const words = query.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase())
  if (!words.length) return []
  const hits: NoteHit[] = []
  for (const ws of store.state.workspaces) {
    const text = ws.note?.text
    if (!ws.note || !text?.trim()) continue
    const lower = text.toLowerCase()
    if (!words.every((w) => lower.includes(w))) continue
    const first = lower.indexOf(words[0])
    const start = Math.max(0, first - SNIPPET_SIDE)
    const end = Math.min(text.length, first + words[0].length + SNIPPET_SIDE)
    let snippet = text.slice(start, end).replace(/\s+/g, ' ')
    for (const w of new Set(words)) snippet = snippet.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `${HIT_START}${m}${HIT_END}`)
    hits.push({
      workspaceId: ws.id,
      workspaceName: ws.name,
      repoName: store.state.repos.find((r) => r.id === ws.repoId)?.name ?? '',
      revision: ws.note.revision,
      snippet: `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`,
      archived: ws.state === 'archived'
    })
  }
  return hits
}
