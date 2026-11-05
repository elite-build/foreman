// What a workspace's Lineage tab and `foreman workspace lineage` read (docs/loops-and-graphs.md, "Recovering graphs from
// what happened"): the workspace, its chats and the chats they link to one hop away (the tab a fork or hand-off came
// from, the chat that started it or sent it a message, a compare sibling's), each chat's user, turn-end and result items
// only, and the flow run it belongs to. Bounded: at most MAX_OWN_CHATS of its own chats (the newest), MAX_LINKED of the
// others, and the last MAX_ITEMS of those items per chat. Reads only; the graph itself is shared/lineage.ts.
import { runForWorkspace, type FlowRun } from '../shared/flows'
import type { LineageInput } from '../shared/lineage'
import type { ChatItem, Session, Workspace } from '../shared/types'

export const MAX_OWN_CHATS = 24
export const MAX_LINKED = 12
export const MAX_ITEMS = 600

export interface LineageSources {
  workspaces: Workspace[]
  sessions: Session[]
  readChat(sessionId: string): Promise<ChatItem[]>
  flowRuns?: FlowRun[]
  templateNames?: Record<string, string>
}

const KEPT = new Set<ChatItem['kind']>(['user', 'turn-end', 'result'])

/** The records one workspace's lineage is drawn from. Throws when there is no such workspace. */
export async function lineageInput(src: LineageSources, workspaceId: string): Promise<LineageInput> {
  const workspace = src.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) throw new Error('That workspace isn’t there any more.')
  const recent = (s: Session) => s.lastActivityAt ?? s.createdAt ?? ''
  const own = src.sessions
    .filter((s) => s.workspaceId === workspaceId)
    .sort((a, b) => recent(b).localeCompare(recent(a)))
    .slice(0, MAX_OWN_CHATS)
  const chats = new Map<string, ChatItem[]>()
  const read = async (id: string) => {
    if (chats.has(id)) return
    const items = await src.readChat(id).catch(() => [] as ChatItem[])
    chats.set(id, items.filter((i) => KEPT.has(i.kind)).slice(-MAX_ITEMS))
  }
  await Promise.all(own.map((s) => read(s.id)))

  // One hop: the chats these name, and the compare siblings' chats.
  const siblings = workspace.compareId ? src.workspaces.filter((w) => w.id !== workspaceId && w.compareId === workspace.compareId) : []
  const linkedIds = new Set<string>()
  for (const s of own) {
    if (s.forkedFrom) linkedIds.add(s.forkedFrom.sessionId)
    if (s.handedOffFrom) linkedIds.add(s.handedOffFrom.sessionId)
    for (const item of chats.get(s.id) ?? []) if (item.kind === 'user' && item.origin?.kind === 'delegation') linkedIds.add(item.origin.sessionId)
  }
  if (workspace.startedBy && workspace.startedBy.via !== 'assistant') linkedIds.add(workspace.startedBy.sessionId)
  for (const w of siblings) if (w.compare?.sessionId) linkedIds.add(w.compare.sessionId)
  for (const s of own) linkedIds.delete(s.id)
  const linked = [...linkedIds]
    .map((id) => src.sessions.find((s) => s.id === id))
    .filter((s): s is Session => Boolean(s))
    .slice(0, MAX_LINKED)
  await Promise.all(linked.map((s) => read(s.id)))

  const named = new Set([...siblings.map((w) => w.id), ...linked.map((s) => s.workspaceId)])
  const flowRun = workspace.flowRun ? (src.flowRuns ?? []).find((r) => r.id === workspace.flowRun!.runId) : runForWorkspace(src.flowRuns, workspaceId)
  return {
    workspace,
    sessions: [...own, ...linked],
    chats,
    workspaces: src.workspaces.filter((w) => w.id === workspaceId || named.has(w.id)),
    ...(flowRun ? { flowRun } : {}),
    ...(src.templateNames ? { templateNames: src.templateNames } : {})
  }
}
