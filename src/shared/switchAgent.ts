// O1: switching agent mid-conversation. A tab can continue with another agent:
// the agent it leaves keeps its own conversation (parked), the new one gets the
// visible history as text (the same block a fork carries), and switching back
// resumes the parked conversation with a short note of what was said meanwhile.
// The pure parts: who wrote each turn, what a resumed agent is told, and what the
// picker and composer offer.
import { AGENTS, modelInfo, supportsPlan, type AgentKind, type Loadout } from './agents'
import type { AcpMode } from './agentCatalog'
import { readOnlyEnforcement } from './permissions'
import type { ChatItem, Session } from './types'

/** The divider a switch leaves in the chat. `history`: the new agent gets the earlier messages as text; `native`: it resumed its own conversation. */
export interface AgentSwitch {
  from: AgentKind
  to: AgentKind
  model: string
  carried: 'history' | 'native'
}

/**
 * O1 (G1): the other lines that mark where a conversation changed without switching agents: it was compacted (the agent
 * works from a summary of what's above), or the tab moved to another model of the same agent (same conversation).
 */
export type ChatDivider = { kind: 'compact' } | { kind: 'model'; agent: AgentKind; from: string; to: string }

/**
 * The divider a model change leaves, or null when it needs none: no messages yet, same model, or a change that
 * undoes the one just made (the previous divider, with no turn since, is updated in place instead: `replace`).
 */
export function modelDivider(items: ChatItem[], agent: AgentKind, from: string, to: string): { divider: ChatDivider; replace?: string } | null {
  if (from === to || !items.some((i) => i.kind === 'user')) return null
  const last = items.at(-1)
  const previous = last?.kind === 'notice' && last.divider?.kind === 'model' && last.divider.agent === agent ? last : undefined
  if (previous && previous.divider?.kind === 'model') {
    if (previous.divider.from === to) return { divider: { kind: 'model', agent, from: to, to }, replace: previous.id }
    return { divider: { kind: 'model', agent, from: previous.divider.from, to }, replace: previous.id }
  }
  return { divider: { kind: 'model', agent, from, to } }
}

/** An agent's own conversation in a tab it was switched away from, kept so switching back resumes it. */
export interface ParkedSession {
  agentSessionId: string
  lastAssistantUuid?: string
  resumeAt?: string
  nativeFork?: boolean
  forkOnResume?: boolean
  // The last turn this agent ran here: what was said after it goes into the note it gets on its return.
  lastTurnId?: string
}

// The note a resumed agent gets: each message cut to this, and the newest part of the whole kept.
export const CATCH_UP_MESSAGE_CHARS = 600
export const CATCH_UP_MAX_CHARS = 8_000

type User = Extract<ChatItem, { kind: 'user' }>
export interface TurnAuthor {
  agent: AgentKind
  // Unknown for turns from before O1 (their message didn't record it).
  model?: string
}

const switchOf = (item: ChatItem): AgentSwitch | undefined => (item.kind === 'notice' ? item.switched : undefined)

/** Whether this chat has been switched between agents (it has a switch divider). */
export function isMixed(items: ChatItem[]): boolean {
  return items.some((i) => Boolean(switchOf(i)))
}

/**
 * Which agent (and model) ran each turn, by turn id. A message records both since O1; an older one ran on the agent the
 * first switch left, or the tab's own agent when it never switched.
 */
export function turnAuthors(items: ChatItem[], current: Pick<TurnAuthor, 'agent'>): Map<string, TurnAuthor> {
  const first = items.map(switchOf).find(Boolean)
  let agent: AgentKind = first ? first.from : current.agent
  const out = new Map<string, TurnAuthor>()
  for (const item of items) {
    const sw = switchOf(item)
    if (sw) agent = sw.to
    // An older message's model is unknown, not guessed.
    else if (item.kind === 'user' && !item.steered && !out.has(item.turnId)) out.set(item.turnId, { agent: item.agent ?? agent, model: item.model })
  }
  return out
}

/** How many turns of this chat another agent answered (the given agent's own conversation never saw them). */
export function otherAgentTurns(items: ChatItem[], agent: AgentKind): number {
  return [...turnAuthors(items, { agent }).values()].filter((a) => a.agent !== agent).length
}

/** The last turn the agent ran in this chat. */
export function lastTurnOf(items: ChatItem[], agent: AgentKind): string | undefined {
  let last: string | undefined
  for (const [turnId, author] of turnAuthors(items, { agent })) if (author.agent === agent) last = turnId
  return last
}

/** "Codex (GPT-6.1 Sol)", or the agent alone when the model is unknown. */
export function authorLabel(author: TurnAuthor): string {
  const name = AGENTS[author.agent]?.label ?? author.agent
  return author.model ? `${name} (${modelInfo(author.agent, author.model).label})` : name
}

/** The agents that answered these turns, by name: "Claude Code", "Claude Code and Codex". */
export function answeredBy(items: ChatItem[], current: Pick<TurnAuthor, 'agent'>): string {
  const names = [...new Set([...turnAuthors(items, current).values()].map((a) => AGENTS[a.agent]?.label ?? a.agent))]
  if (names.length <= 1) return names[0] ?? AGENTS[current.agent].label
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

const shorten = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * The note an agent resuming its own conversation gets with its next message: what was said in this chat since its
 * last turn (messages only, each shortened, the newest part kept). '' when nothing was said in between.
 */
export function catchUpBlock(items: ChatItem[], sinceTurnId: string, current: Pick<TurnAuthor, 'agent'>): { text: string; cut: boolean } {
  let start = -1
  items.forEach((item, n) => {
    if ('turnId' in item && item.turnId === sinceTurnId) start = n
  })
  const after = items.slice(start + 1)
  const authors = turnAuthors(items, current)
  // One line per message: the user's, and each answer's text joined (tool calls and thinking are left out).
  const entries: { turnId?: string; text: string }[] = []
  for (const item of after) {
    if (item.kind === 'user' && item.text.trim()) entries.push({ text: `**You${item.steered ? ' (while it worked)' : ''}:** ${item.text}` })
    else if (item.kind === 'assistant' && item.text.trim()) {
      const last = entries.at(-1)
      if (last?.turnId === item.turnId) last.text += ` ${item.text}`
      else {
        const author = authors.get(item.turnId)
        entries.push({ turnId: item.turnId, text: `**${author ? authorLabel(author) : 'Assistant'}:** ${item.text}` })
      }
    }
  }
  const lines = entries.map((e) => shorten(e.text, CATCH_UP_MESSAGE_CHARS))
  if (!lines.length) return { text: '', cut: false }
  // The newest messages win when the note is too long.
  const kept: string[] = []
  let size = 0
  for (const line of [...lines].reverse()) {
    if (size + line.length > CATCH_UP_MAX_CHARS && kept.length) break
    kept.unshift(line)
    size += line.length + 1
  }
  const cut = kept.length < lines.length
  return {
    cut,
    text: [
      `While you were away, the user carried on in this chat with another agent. A short note of what was said since your last turn here (each message shortened, tool output left out${cut ? ', older messages left out to fit' : ''}). It is context only; it is not a new request:`,
      '<messages_in_between>',
      kept.join('\n'),
      '</messages_in_between>',
      '',
      "The user's new message:",
      '',
      ''
    ].join('\n')
  }
}

/** After a rewind, the parked conversations that still match the chat: those whose last turn was kept. */
export function parkedAfterRewind(parked: Session['parked'], keptTurnIds: Set<string>): Session['parked'] {
  if (!parked) return undefined
  const out: NonNullable<Session['parked']> = {}
  for (const [agent, p] of Object.entries(parked) as [AgentKind, ParkedSession][]) if (p.lastTurnId && keptTurnIds.has(p.lastTurnId)) out[agent] = p
  return Object.keys(out).length ? out : undefined
}

// ---- the picker and the composer ----

/** What choosing a model does: `apply` at once (same agent, or nothing to carry), or `ask` whether to continue here or open a new chat. */
export function modelChoiceAction(session: Pick<Session, 'agent'>, hasHistory: boolean, choice: Pick<Loadout, 'agent'>): 'apply' | 'ask' {
  return choice.agent !== session.agent && hasHistory ? 'ask' : 'apply'
}

/** Why this chat can't continue with that agent (only a new chat is offered then), or null when it can. */
export function continueBlock(session: Pick<Session, 'readOnly' | 'importedMode' | 'status' | 'turnId'>, target: AgentKind): 'running' | 'read-only' | 'history' | null {
  if (session.importedMode === 'history') return 'history'
  if (session.status === 'running' || session.turnId) return 'running'
  if (session.readOnly && !readOnlyEnforcement(target)) return 'read-only'
  return null
}

/**
 * The composer's Plan control for the tab's agent. An agent without plan mode has no Plan chip, except in a chat that
 * switched agents, where it stays in place greyed ("Codex has no plan mode") so the change is visible.
 */
export function planControl(agent: AgentKind, opts: { planMode: boolean; readOnly?: boolean; mixed: boolean; modes?: AcpMode[] }): 'hidden' | 'unavailable' | 'locked' | 'on' | 'off' {
  // G1: an ACP agent's declared plan session mode counts (`modes`, from the model catalog).
  if (!supportsPlan(agent, opts.modes)) return opts.mixed ? 'unavailable' : 'hidden'
  if (opts.readOnly) return 'locked'
  return opts.planMode ? 'on' : 'off'
}
