// Parameters and results of the chat-tab methods, and the text a chat
// is printed as. Each result has a `text` the command prints unless --json is given.
import { durationText } from '../checks'
import type { ChatItem, McpServerInfo, SlashCommandInfo, TurnOutcome } from '../types'

/** Where a command ran, which workspace it names and (for most) which open tab, counting from 1. */
export interface TabRef {
  workspace: string
  cwd?: string
  tab?: number
}

export interface TabRow {
  // The position among the open tabs, from 1; absent for a closed tab.
  tab?: number
  id: string
  title: string
  agent: string
  model: string
  // "Claude · Opus 5.5"
  modelText: string
  effort?: string
  fast: boolean
  plan: boolean
  autoAcceptEdits?: boolean
  status: 'idle' | 'running'
  queued: number
  lastTurn?: { outcome: TurnOutcome; turn?: string; endedAt: string }
  closed?: boolean
}

export interface TabsParams {
  workspace: string
  cwd?: string
  closed?: boolean
}

export interface TabsResult {
  workspace: { id: string; name: string }
  tabs: TabRow[]
  text: string
}

export interface TabNewParams {
  workspace: string
  cwd?: string
  agent?: string
  model?: string
  effort?: string
  fast?: boolean
  plan?: boolean
  title?: string
}

export interface TabChangeResult {
  workspace: { id: string; name: string }
  tab?: TabRow
  text: string
}

/** The fields `tab set` may change. `fast`, `plan`, `autoAcceptEdits` and `includeNote` are true or false when given. */
export interface TabSetPatch {
  title?: string
  agent?: string
  model?: string
  effort?: string
  fast?: boolean
  plan?: boolean
  autoAcceptEdits?: boolean
  includeNote?: boolean
}

export interface TabSetParams extends TabRef {
  patch: TabSetPatch
}

export interface TabCloseParams extends TabRef {}

export interface TabReopenParams {
  workspace: string
  cwd?: string
  // A closed tab's id (`foreman tabs <ws> --closed` lists them), or the start of it; the latest closed one when left out.
  id?: string
}

export interface TabForkParams extends TabRef {
  // Fork from this turn (id or the start of it) instead of after the latest answer.
  turn?: string
  // With a turn: from just before it (edit and resend).
  before?: boolean
}

export interface ChatParams extends TabRef {
  // The last n turns.
  tail?: number
  // Only what came after this turn.
  since?: string
  toolOutput?: boolean
}

export interface ChatResult {
  workspace: { id: string; name: string }
  tab: number
  session: string
  items: ChatItem[]
  text: string
}

export type QueueVerb = 'list' | 'remove' | 'steer' | 'move' | 'edit'

export interface QueueParams extends TabRef {
  verb: QueueVerb
  // A queued message: its position from 1, its id or the start of it, or its turn id.
  message?: string
  direction?: 'up' | 'down'
  text?: string
}

export interface QueueRow {
  position: number
  id: string
  turn?: string
  text: string
  attachments: number
}

export interface QueueResult {
  workspace: { id: string; name: string }
  tab: number
  verb: QueueVerb
  queue: QueueRow[]
  text: string
}

export interface RewindParams extends TabRef {
  turn: string
}

export interface RewindResult {
  workspace: { id: string; name: string }
  tab: number
  turn: string
  text: string
}

export interface ResumeNowResult {
  workspace: { id: string; name: string }
  tab: number
  session: string
  text: string
}

export type McpVerb = 'status' | 'restart' | 'reconnect'

export interface McpParams extends TabRef {
  verb: McpVerb
  // reconnect: the server's name.
  name?: string
}

export interface McpResult {
  workspace: { id: string; name: string }
  tab: number
  verb: McpVerb
  supported: boolean
  servers: McpServerInfo[]
  text: string
}

export interface SlashResult {
  workspace: { id: string; name: string }
  tab: number
  commands: SlashCommandInfo[]
  text: string
}

export interface SearchParams {
  query: string
  toolOutput?: boolean
  notes?: boolean
  limit?: number
}

export interface SearchHitRow {
  kind: 'chat' | 'note'
  workspace: string
  workspaceId: string
  repo: string
  // Chat hits: the tab and the message.
  tab?: string
  session?: string
  item?: string
  itemKind?: string
  at?: string
  // Note hits: the note's revision.
  revision?: number
  archived: boolean
  // The matching words are in [brackets].
  snippet: string
}

export interface SearchResult {
  query: string
  hits: SearchHitRow[]
  text: string
}

// ----- chat as text -----

const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description']

/** The one line a tool call is known by: its command, file or pattern. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) if (typeof record[key] === 'string' && record[key]) return (record[key] as string).split('\n')[0]
  return ''
}

const indent = (text: string, by = '  '): string => text.replace(/\n$/, '').split('\n').map((line) => (line ? by + line : line)).join('\n')

/** The turn ids of the chat in order, one per message that started or queued a turn. */
export function chatTurns(items: ChatItem[]): string[] {
  const ids: string[] = []
  for (const item of items) if (item.kind === 'user' && !item.steered && !ids.includes(item.turnId)) ids.push(item.turnId)
  return ids
}

/** The turn `query` names: an exact id, or the start of one id (four characters or more). */
export function findTurn(items: ChatItem[], query: string): string | undefined {
  const q = query.trim().toLowerCase()
  const ids = new Set<string>()
  for (const item of items) if ('turnId' in item && item.turnId) ids.add(item.turnId)
  const all = [...ids]
  const exact = all.find((id) => id.toLowerCase() === q)
  if (exact) return exact
  const starts = q.length >= 4 ? all.filter((id) => id.toLowerCase().startsWith(q)) : []
  return starts.length === 1 ? starts[0] : undefined
}

/** The last `n` turns of the chat, with the notices and items around them. */
export function lastTurns(items: ChatItem[], n: number): ChatItem[] {
  const turns = chatTurns(items)
  if (n >= turns.length) return items
  const first = turns[turns.length - n]
  const at = items.findIndex((i) => i.kind === 'user' && !i.steered && i.turnId === first)
  return at < 0 ? items : items.slice(at)
}

/** What came after `turnId`'s last item. */
export function afterTurn(items: ChatItem[], turnId: string): ChatItem[] {
  let last = -1
  items.forEach((item, i) => {
    if ('turnId' in item && item.turnId === turnId) last = i
  })
  return items.slice(last + 1)
}

/** Items as the JSON a script reads: no thinking, and a tool's output only when asked for. */
export function chatItemsOut(items: ChatItem[], toolOutput: boolean): ChatItem[] {
  return items.filter((i) => i.kind !== 'thinking').map((i) => (i.kind === 'tool' && !toolOutput ? { ...i, output: undefined } : i))
}

/**
 * A chat as plain text for a terminal: who said what, tool calls as one line each (with their output when asked for),
 * notices and how each turn ended. Thinking and Foreman's internal items are left out.
 */
export function renderChat(items: ChatItem[], options: { toolOutput?: boolean; agent?: string } = {}): string {
  const agent = options.agent ?? 'Agent'
  const blocks: string[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      const names = (item.attachments ?? []).map((a) => a.name)
      const head = `You${item.steered ? ' (while the agent worked)' : ''} · turn ${item.turnId}`
      blocks.push([`${head}`, indent(item.text.trim()), names.length ? indent(`Attachments: ${names.join(', ')}`) : ''].filter(Boolean).join('\n'))
    } else if (item.kind === 'assistant') {
      if (item.text.trim()) blocks.push([`${agent}`, indent(item.text.trim())].join('\n'))
    } else if (item.kind === 'tool') {
      const summary = toolSummary(item.input)
      const line = `  · ${item.name}${summary ? ` ${summary}` : ''}${item.status === 'error' ? ' (error)' : item.status === 'running' ? ' (running)' : ''}`
      blocks.push(options.toolOutput && item.output?.trim() ? `${line}\n${indent(item.output.trim(), '      ')}` : line)
    } else if (item.kind === 'notice') {
      blocks.push(`  ${item.level === 'error' ? '! ' : '- '}${item.text}`)
    } else if (item.kind === 'turn-end') {
      const parts: string[] = [item.outcome === 'completed' ? 'completed' : item.outcome === 'error' ? 'failed' : item.outcome === 'cancelled' ? 'stopped' : 'interrupted']
      if (item.durationMs !== undefined) parts.push(durationText(item.durationMs))
      if (item.delta) parts.push(`+${item.delta.additions} -${item.delta.deletions}`)
      blocks.push(`  = turn ${item.turnId} ${parts[0]}${parts.length > 1 ? ` (${parts.slice(1).join(', ')})` : ''}${item.error ? `: ${item.error}` : ''}`)
    }
  }
  // Consecutive one-line items stay together; messages get a blank line around them.
  const out: string[] = []
  blocks.forEach((block, i) => {
    const small = block.startsWith('  ')
    const prevSmall = i > 0 && blocks[i - 1].startsWith('  ')
    if (i > 0 && !(small && prevSmall)) out.push('')
    out.push(block)
  })
  return out.join('\n')
}
