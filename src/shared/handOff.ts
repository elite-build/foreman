// What a new chat is given when it starts from another one (second opinion,
// continue): picking the source's task and answer, sizing and placing the
// context, and the plain-language lines the dialog shows. Pure, so the dialog
// and the main process agree on the numbers.
import { AGENTS, modelInfo, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
import type { ChatItem, MessageFollowUp, Session } from './types'

const enT = createT('en')

export const MAX_OPEN_TABS = 10
/** Context up to this size goes into the message itself; the rest is attached. */
export const MAX_INLINE_BYTES = 40 * 1024
/** An attachment longer than this is cut and labelled truncated. */
export const MAX_ATTACHMENT_BYTES = 400 * 1024

export type SectionKind = 'task' | 'answer' | 'diff'

export interface ContextSection {
  kind: SectionKind
  label: string
  text: string
}

export interface Placement {
  kind: SectionKind
  where: 'inline' | 'attached'
  bytes: number
  // Attached sections longer than the cap are cut.
  truncated: boolean
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const byteLength = (text: string): number => encoder.encode(text).length

/** Whole sections go inline while they fit in the budget; any that don't are attached (cut if enormous). */
export function placeSections(sections: { kind: SectionKind; bytes: number }[]): Placement[] {
  let room = MAX_INLINE_BYTES
  return sections.map(({ kind, bytes }) => {
    if (bytes <= room) {
      room -= bytes
      return { kind, where: 'inline', bytes, truncated: false }
    }
    return { kind, where: 'attached', bytes: Math.min(bytes, MAX_ATTACHMENT_BYTES), truncated: bytes > MAX_ATTACHMENT_BYTES }
  })
}

/** The first `max` bytes of the text, never ending in half a character. */
export function truncateBytes(text: string, max: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  return decoder.decode(bytes.slice(0, max)).replace(/�+$/, '')
}

export interface AssembledHandOff {
  text: string
  attachments: { name: string; content: string; truncated: boolean }[]
  placements: Placement[]
  // What is sent in all: inline context plus attachments, as cut.
  totalBytes: number
}

/** The message with its inline sections, and the sections that go as attachments. */
export function assembleHandOff(message: string, sections: ContextSection[]): AssembledHandOff {
  const placements = placeSections(sections.map((s) => ({ kind: s.kind, bytes: byteLength(s.text) })))
  let text = message.trim()
  const attachments: AssembledHandOff['attachments'] = []
  const notes: string[] = []
  sections.forEach((section, n) => {
    const placement = placements[n]
    if (placement.where === 'inline') {
      text += `\n\n## ${section.label}\n\n${section.text}`
      return
    }
    const name = `${section.label}${placement.truncated ? ' (truncated)' : ''}.md`
    const content = placement.truncated
      ? `${truncateBytes(section.text, MAX_ATTACHMENT_BYTES)}\n\n[Truncated: ${formatBytes(byteLength(section.text) - MAX_ATTACHMENT_BYTES)} omitted]`
      : section.text
    attachments.push({ name, content, truncated: placement.truncated })
    notes.push(`- ${section.label}: attached as “${name}”${placement.truncated ? `, truncated to the first ${formatBytes(MAX_ATTACHMENT_BYTES)}` : ''}`)
  })
  if (notes.length) text += `\n\nToo long to include here:\n${notes.join('\n')}`
  return { text, attachments, placements, totalBytes: placements.reduce((sum, p) => sum + p.bytes, 0) }
}

/** "0.4 KB", "14 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 10) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// #22: a Chat agent goes to whichever provider that agent uses (its name stands in).
const PROVIDER: Partial<Record<AgentKind, string>> = {
  claude: 'Anthropic (Claude Code)',
  codex: 'OpenAI (Codex)',
  cursor: 'Cursor'
}

/** "~14 KB → OpenAI (Codex)", plus a note when something goes as an attachment. */
export function sizeLine(placements: Placement[], agent: AgentKind, t: TFunction = enT): string {
  const total = placements.reduce((sum, p) => sum + p.bytes, 0)
  const attached = placements.filter((p) => p.where === 'attached')
  const truncated = attached.some((p) => p.truncated)
  const note = attached.length ? ` · ${truncated ? t('handOff.size.attachedTruncated', { count: attached.length }) : t('handOff.size.attached', { count: attached.length })}` : ''
  const provider = agent === 'opencode' ? t('handOff.size.opencodeProvider') : PROVIDER[agent] ?? AGENTS[agent]?.label ?? agent
  return `${t('handOff.size.line', { size: formatBytes(total), provider })}${note}`
}

// ---- reading the source chat ----

export interface TaskChoice {
  turnId: string
  text: string
}

/** The chat's own messages, oldest first. Steered ones were sent into a running turn and aren't tasks. */
export function userTasks(items: ChatItem[]): TaskChoice[] {
  const tasks: TaskChoice[] = []
  for (const item of items) if (item.kind === 'user' && !item.steered && item.text.trim()) tasks.push({ turnId: item.turnId, text: item.text })
  return tasks
}

/** The agent's latest finished reply: the last assistant message with text. */
export function lastAnswer(items: ChatItem[]): { id: string; turnId: string; text: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'assistant' && !item.streaming && item.text.trim()) return { id: item.id, turnId: item.turnId, text: item.text }
  }
  return null
}

/** Everything the agent said in one turn, as text (tool calls and thinking left out); empty if it said nothing. */
export function turnAnswer(items: ChatItem[], turnId: string): string {
  return items
    .filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && i.turnId === turnId && !i.streaming && Boolean(i.text.trim()))
    .map((i) => i.text.trim())
    .join('\n\n')
}

/** The message the last answer replied to; failing that, the latest one. */
export function defaultTask(tasks: TaskChoice[], answer: { turnId: string } | null): string | undefined {
  return (answer && tasks.find((t) => t.turnId === answer.turnId)?.turnId) ?? tasks.at(-1)?.turnId
}

/** Short model name for tabs: "Opus" for Opus 5.5. The full name and effort go in the tooltip. */
export function compactModelLabel(agent: AgentKind, model: string): string {
  const label = modelInfo(agent, model).label
  const name = agent === 'opencode' && label.includes('/') ? label.slice(label.lastIndexOf('/') + 1).trim() : label
  return name.split(/\s+/)[0] || AGENTS[agent].label
}

export function modelTooltip(agent: AgentKind, model: string, effort?: string, fast?: boolean, t: TFunction = enT): string {
  return [modelInfo(agent, model).label, effort, fast ? t('handOff.model.fast') : ''].filter(Boolean).join(' · ')
}

export const SECOND_OPINION_MESSAGE =
  "Review this change for bugs and regressions. List concrete problems with file and line. Don't edit code."
export const REVIEW_MESSAGE = 'Please review the changes in this workspace.'
export const CONTINUE_MESSAGE = 'Continue from this context:'

// ---- continuing ----

export type ContinueEligibility = { ok: true; turnId: string } | { ok: false; reason: string }

/**
 * Whether "Continue in another chat" is on offer: the chat is idle with nothing
 * queued, and its latest turn completed with an answer (a stopped, failed or
 * interrupted turn gets Retry instead). The plan card's Hand off is exempt: it
 * is the answer to a question the source is waiting on.
 */
export function continueEligibility(session: Pick<Session, 'status' | 'queue' | 'lastTurn'>, items: ChatItem[], t: TFunction = enT): ContinueEligibility {
  if (session.status !== 'idle') return { ok: false, reason: t('handOff.continue.working') }
  if (session.queue.length > 0) return { ok: false, reason: t('handOff.continue.queued') }
  let end: Extract<ChatItem, { kind: 'turn-end' }> | undefined
  let endAt = -1
  for (let n = items.length - 1; n >= 0 && !end; n--) {
    const item = items[n]
    if (item.kind === 'turn-end') {
      end = item
      endAt = n
    }
  }
  if (!end) return { ok: false, reason: t('handOff.continue.noTurn') }
  if (items.slice(endAt + 1).some((i) => i.kind === 'user')) return { ok: false, reason: t('handOff.continue.newer') }
  const outcome = session.lastTurn?.outcome ?? end.outcome
  if (end.outcome !== 'completed' || outcome !== 'completed') return { ok: false, reason: t('handOff.continue.notCompleted') }
  const answer = lastAnswer(items)
  if (!answer || answer.turnId !== end.turnId) return { ok: false, reason: t('handOff.continue.noAnswer') }
  return { ok: true, turnId: end.turnId }
}

/**
 * The follow-up suggested for the answer to this turn: the one its message
 * carried. A turn that was also steered, or whose message is gone (rewound
 * past), has none and gets the generic action.
 */
export function continueFollowUp(items: ChatItem[], turnId: string): MessageFollowUp | null {
  const sent = items.filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId)
  const message = sent.filter((m) => !m.steered)
  if (message.length !== 1 || sent.some((m) => m.steered)) return null
  return message[0].followUp ?? null
}
