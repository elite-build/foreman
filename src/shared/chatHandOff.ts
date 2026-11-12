// Switching agents and accounts in a chat, with a record of exactly what the next agent received (docs/agents.md 5).
// `buildHandOff` is pure and deterministic, with no model call: the newest turns go in full until 60% of the budget, older
// ones condensed (the request and the final answer) until the budget, the rest are left out and named. A parked agent that
// saw the chat up to a turn gets only what came after (a delta). Each turn is headed with the agent and model that answered
// it, so the next agent can tell whose words they are. Tokens are an estimate (characters / 4), labelled as one wherever
// they are shown. The code calls the record a hand-off; in the app it is "What <Agent> received", because Hand off already
// means moving a workspace to another computer and handing a plan or review to a new chat.
import { AGENTS, type AgentKind } from './agents'
import { isChildItem } from './subagents'
import { authorLabel, turnAuthors, type TurnAuthor } from './switchAgent'
import type { ChatItem } from './types'

/** How the next agent was given the chat (docs/agents.md 5.3). */
export type HandOffStrategy = 'native-fork' | 'resume-delta' | 'inject' | 'prompt-delta' | 'prompt-full'

/** Settings → Default models: how much of a chat the next agent is given, in estimated tokens. */
export const HAND_OFF_BUDGET = { default: 16_000, min: 1_024, max: 64_000 } as const
/** The newest turns go in full until this share of the budget; older ones are condensed until the whole budget. */
export const HAND_OFF_FULL_SHARE = 0.6
/** A condensed turn keeps its request and its final answer, each cut to this many characters. */
export const CONDENSED_CHARS = 400
/** What one `read_chat_history` call returns, at most (estimated tokens). */
export const READ_HISTORY_MAX_TOKENS = 64_000
/** The word the next agent is told to read the left-out turns with. */
export const READ_CHAT_HISTORY_TOOL_NAME = 'read_chat_history'
const READ_HISTORY_TOOL = READ_CHAT_HISTORY_TOOL_NAME

/** One side of a switch: an agent, the account it ran on (none: the default) and its model. */
export interface HandOffParty {
  agent: AgentKind
  instance?: string
  model: string
}

/** What the record knows of each turn it considered, for showing it (the number counts the chat's turns from 1). */
export interface HandOffTurn {
  id: string
  n: number
  agent: AgentKind
  model?: string
  // The user's request, cut to one line.
  request: string
  // What the turn cost in the text the agent received, in estimated tokens (0 for a left-out turn).
  tokens: number
}

export interface ChatHandOff {
  // The target's first turn that carried it. Absent on the preview a switch answers with, before any turn has started.
  turnId?: string
  from: HandOffParty
  to: HandOffParty
  strategy: HandOffStrategy
  budgetTokens: number
  usedTokens: number
  full: string[]
  condensed: string[]
  omitted: string[]
  sinceTurn?: string
  // Every turn considered, oldest first: which list each is in comes from `full`, `condensed` and `omitted`.
  turns: HandOffTurn[]
}

/** The budget as the setting holds it, kept within its limits. */
export function clampBudget(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : HAND_OFF_BUDGET.default
  return Math.min(HAND_OFF_BUDGET.max, Math.max(HAND_OFF_BUDGET.min, n))
}

/** An estimate of how many tokens this text takes: four characters to a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** One turn of a chat: what the user asked (and added while it worked), what the agent answered, and who answered. */
export interface ChatTurn {
  id: string
  // Counted from 1 across the whole chat.
  n: number
  author: TurnAuthor
  user: string[]
  attachments: string[]
  // The assistant's messages in order (tool calls and thinking are left out).
  answers: string[]
  tools: number
}

/** The chat as turns: each starts at a message the user sent (not one steered into a running turn) and holds what follows. */
export function chatTurns(items: ChatItem[], current: Pick<TurnAuthor, 'agent'>): ChatTurn[] {
  const authors = turnAuthors(items, current)
  const byId = new Map<string, ChatTurn>()
  const order: ChatTurn[] = []
  for (const item of items) {
    if (item.kind === 'user' && !item.steered && !byId.has(item.turnId)) {
      const turn: ChatTurn = { id: item.turnId, n: order.length + 1, author: authors.get(item.turnId) ?? { agent: current.agent }, user: [], attachments: [], answers: [], tools: 0 }
      byId.set(item.turnId, turn)
      order.push(turn)
    }
    if (!('turnId' in item) || !item.turnId || isChildItem(item)) continue
    const turn = byId.get(item.turnId)
    if (!turn) continue
    if (item.kind === 'user') {
      if (item.text.trim()) turn.user.push(item.steered ? `(while it worked) ${item.text.trim()}` : item.text.trim())
      for (const a of item.attachments ?? []) turn.attachments.push(a.name)
    } else if (item.kind === 'assistant') {
      if (item.text.trim()) turn.answers.push(item.text.trim())
    } else if (item.kind === 'tool') turn.tools++
  }
  return order
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One line, cut to `max` characters with an ellipsis. */
export function cut(text: string, max: number): string {
  const line = oneLine(text)
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const who = (turn: ChatTurn) => authorLabel(turn.author)
const heading = (turn: ChatTurn) => `### Turn ${turn.n} · ${who(turn)}`

/** A turn in full: what the user said and what the agent answered, as written. */
function fullBlock(turn: ChatTurn): string {
  const lines = [heading(turn)]
  for (const text of turn.user) lines.push(`**You:** ${text}`)
  if (turn.attachments.length) lines.push(`_Attachments: ${turn.attachments.join(', ')}_`)
  if (turn.answers.length) lines.push(`**${who(turn)}:** ${turn.answers.join('\n\n')}`)
  else lines.push('_No answer._')
  return lines.join('\n')
}

/** A turn condensed: its request and its final answer, each cut. */
function condensedBlock(turn: ChatTurn): string {
  const lines = [`${heading(turn)} · condensed`, `**You:** ${cut(turn.user[0] ?? '', CONDENSED_CHARS)}`]
  const final = turn.answers.at(-1)
  lines.push(final ? `**${who(turn)}:** ${cut(final, CONDENSED_CHARS)}` : '_No answer._')
  return lines.join('\n')
}

export interface HandOffBlock {
  turn: ChatTurn
  level: 'full' | 'condensed'
  text: string
}

/** What `buildHandOff` decided: the record's figures, and the blocks of text that go to the agent. */
export interface HandOffBuild {
  // True when the target already saw the chat up to `sinceTurn` and is given only what came after.
  delta: boolean
  sinceTurn?: string
  budgetTokens: number
  usedTokens: number
  full: string[]
  condensed: string[]
  omitted: string[]
  turns: HandOffTurn[]
  // Included turns, oldest first.
  blocks: HandOffBlock[]
  // The numbers of the turns left out, for the text that names them.
  omittedNumbers: number[]
}

/**
 * Decides what the next agent is given of `items` (the chat before its new message). `lastSeen`: the last turn the target
 * saw (a parked conversation); the turns after it are the delta. Not found (the chat was rewound), or none: the whole chat.
 * Newest turns in full until 60% of `budget`, then older ones condensed until `budget`; the oldest are left out. Both
 * lists stay contiguous, so a gap is never in the middle. Pure: the same chat gives the same answer.
 */
export function buildHandOff(items: ChatItem[], target: Pick<TurnAuthor, 'agent'>, lastSeen: string | undefined, budget: number): HandOffBuild {
  const budgetTokens = clampBudget(budget)
  const all = chatTurns(items, target)
  const at = lastSeen ? all.findIndex((t) => t.id === lastSeen) : -1
  const delta = at >= 0
  const considered = delta ? all.slice(at + 1) : all
  const fullLimit = budgetTokens * HAND_OFF_FULL_SHARE
  let used = 0
  const blocks: HandOffBlock[] = []
  let phase: 'full' | 'condensed' | 'omit' = 'full'
  // Newest first, so what is kept is always the most recent.
  for (const turn of [...considered].reverse()) {
    if (phase === 'full') {
      const text = fullBlock(turn)
      const cost = estimateTokens(text)
      if (used + cost <= fullLimit) {
        used += cost
        blocks.unshift({ turn, level: 'full', text })
        continue
      }
      phase = 'condensed'
    }
    if (phase === 'condensed') {
      const text = condensedBlock(turn)
      const cost = estimateTokens(text)
      if (used + cost <= budgetTokens) {
        used += cost
        blocks.unshift({ turn, level: 'condensed', text })
        continue
      }
      phase = 'omit'
    }
  }
  const level = new Map(blocks.map((b) => [b.turn.id, b] as const))
  const turns: HandOffTurn[] = considered.map((t) => ({ id: t.id, n: t.n, agent: t.author.agent, ...(t.author.model ? { model: t.author.model } : {}), request: cut(t.user[0] ?? '', 120), tokens: level.has(t.id) ? estimateTokens(level.get(t.id)!.text) : 0 }))
  const omittedTurns = considered.filter((t) => !level.has(t.id))
  return {
    delta,
    ...(delta ? { sinceTurn: lastSeen } : {}),
    budgetTokens,
    usedTokens: used,
    full: blocks.filter((b) => b.level === 'full').map((b) => b.turn.id),
    condensed: blocks.filter((b) => b.level === 'condensed').map((b) => b.turn.id),
    omitted: omittedTurns.map((t) => t.id),
    turns,
    blocks,
    omittedNumbers: omittedTurns.map((t) => t.n)
  }
}

/**
 * How the next agent is given the chat (docs/agents.md 5.3). `native-fork`: the same agent on the same home forks its own
 * conversation, nothing sent as text. `resume-delta`: an agent that saw the chat up to some turn (a parked conversation)
 * resumes it and gets only what came after; `prompt-delta` when its thread can't be resumed. Any other agent gets the chat as
 * text (`prompt-full`). `inject` (Codex takes conversation items) is chosen only once a recorded fixture shows injected
 * items reaching the model, which is slice 4; until then Codex gets `prompt-full` like the others.
 */
export function chooseStrategy(o: { sameAgent: boolean; sameHome: boolean; forkNative: boolean; parked: boolean; resumeNative: boolean }): HandOffStrategy {
  if (o.sameAgent && o.sameHome && o.forkNative) return 'native-fork'
  if (o.parked) return o.resumeNative ? 'resume-delta' : 'prompt-delta'
  return 'prompt-full'
}

/** The record of a build: the figures and the lists, with who and how. */
export function handOffRecord(build: HandOffBuild, info: { from: HandOffParty; to: HandOffParty; strategy: HandOffStrategy; turnId?: string }): ChatHandOff {
  return {
    ...(info.turnId ? { turnId: info.turnId } : {}),
    from: info.from,
    to: info.to,
    strategy: info.strategy,
    budgetTokens: build.budgetTokens,
    usedTokens: build.usedTokens,
    full: build.full,
    condensed: build.condensed,
    omitted: build.omitted,
    ...(build.sinceTurn ? { sinceTurn: build.sinceTurn } : {}),
    turns: build.turns
  }
}

/** Turn numbers as a short list: "1–3", "1–3, 7", "2". */
export function numberRanges(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return out.join(', ')
}

/**
 * Why the text is being given: the tab was `switch`ed to this agent, moved to another `account` (its conversation can't be
 * resumed there), or this agent is `return`ing to its own conversation and gets what was said while it was away.
 */
export type HandOffReason = 'switch' | 'account' | 'restore' | 'return'

/**
 * The attributed block that goes before the user's new message. It says where the conversation came from, heads every turn
 * with who answered it, and, when turns were left out, says which and (when the agent can use it) names the tool that reads
 * them. '' when there is nothing to give.
 */
export function renderHandOff(build: HandOffBuild, opts: { reason: HandOffReason; canRead: boolean }): string {
  if (!build.blocks.length && !build.omitted.length) return ''
  const left = build.omitted.length ? ` ${leftOutSentence(build, opts.canRead)}` : ''
  const intro =
    opts.reason === 'return'
      ? `While you were away, the user carried on in this chat with another agent. The turns since your last turn here, with the agent that answered each, are below.${left} They are context only; they are not a new request:`
      : opts.reason === 'restore'
        ? `The user restored this chat to an earlier point, so it continues here as a new conversation; you can't rewind your own. The conversation up to that point, which you don't otherwise remember, is below, each turn headed with the agent that answered it.${left} Anything after it was undone. It is given here for context only; it is not a new request:`
      : opts.reason === 'account'
        ? `This chat's earlier conversation is kept where this session can't resume it (another account, or a config folder that has since changed), so it continues here as a new conversation. Its conversation so far, which you don't otherwise remember, is below, each turn headed with the agent that answered it.${left} It is given here for context only; it is not a new request:`
        : `This chat began with another agent, and the user has switched it to you. Its conversation so far, which you don't otherwise remember, is below, each turn headed with the agent that answered it.${left} It is given here for context only; it is not a new request:`
  const tag = opts.reason === 'return' ? 'messages_in_between' : 'earlier_conversation'
  const gap = build.omitted.length ? [`[Turns ${numberRanges(build.omittedNumbers)} are left out.${opts.canRead ? ` Read them with ${READ_HISTORY_TOOL}.` : ''}]`, ''] : []
  return [intro, `<${tag}>`, ...gap, build.blocks.map((b) => b.text).join('\n\n'), `</${tag}>`, '', "The user's new message:", '', ''].join('\n')
}

function leftOutSentence(build: HandOffBuild, canRead: boolean): string {
  const count = build.omitted.length
  const where = `turn${count === 1 ? '' : 's'} ${numberRanges(build.omittedNumbers)}`
  return `${count} ${count === 1 ? 'turn' : 'turns'} (${where}) ${count === 1 ? 'was' : 'were'} left out to keep this short${canRead ? `; the ${READ_HISTORY_TOOL} tool reads any of them in full` : ''}.`
}

// ---- read_chat_history ----

export interface ReadHistoryArgs {
  turns?: number[]
  from?: number
  to?: number
}

export interface ReadHistoryResult {
  // The turns that follow, as the agent should read them.
  text: string
  // The turn numbers returned, in order.
  returned: number[]
  // How many turns the chat has.
  total: number
  // Asked for but the chat doesn't have them.
  missing: number[]
  // Asked for and found, but they didn't fit in one call: ask again for these.
  notReturned: number[]
}

/**
 * The turns a `read_chat_history` call asked for, in full and attributed: by number (`turns`), by range (`from`, `to`,
 * either one alone reaching to that end of the chat), or both. Never more than READ_HISTORY_MAX_TOKENS (estimated); what
 * doesn't fit is listed so the agent can ask again. With no selection it lists the chat's turns, one line each. Only ever
 * reads the items it is given, which the caller takes from the calling turn's own chat.
 */
export function readChatHistory(items: ChatItem[], args: ReadHistoryArgs, current: Pick<TurnAuthor, 'agent'>, maxTokens = READ_HISTORY_MAX_TOKENS): ReadHistoryResult {
  const all = chatTurns(items, current)
  const total = all.length
  const wanted = new Set<number>()
  for (const n of args.turns ?? []) wanted.add(n)
  if (args.from !== undefined || args.to !== undefined) {
    const from = args.from ?? 1
    const to = args.to ?? total
    if (from > to) throw new Error(`from (${from}) is after to (${to}).`)
    for (let n = from; n <= Math.min(to, total); n++) wanted.add(n)
  }
  if (!wanted.size) {
    const index = all.map((t) => `Turn ${t.n} · ${who(t)}: ${cut(t.user[0] ?? '', 120)}`)
    return { text: [`This chat has ${total} turn${total === 1 ? '' : 's'}. Say which to read with turns, or from and to.`, ...index].join('\n'), returned: [], total, missing: [], notReturned: [] }
  }
  const ordered = [...wanted].sort((a, b) => a - b)
  const missing = ordered.filter((n) => n < 1 || n > total)
  const found = ordered.filter((n) => n >= 1 && n <= total)
  const blocks: string[] = []
  const returned: number[] = []
  const notReturned: number[] = []
  let used = 0
  for (const n of found) {
    const turn = all[n - 1]
    let text = fullBlock(turn) + (turn.tools ? `\n_${turn.tools} tool call${turn.tools === 1 ? '' : 's'} not shown._` : '')
    let cost = estimateTokens(text)
    if (used + cost > maxTokens) {
      // A turn that alone is over the limit is cut to fit, so it can still be read; a later one waits for the next call.
      if (blocks.length || cost <= maxTokens) {
        notReturned.push(n)
        continue
      }
      text = `${text.slice(0, maxTokens * 4 - 40)}\n[This turn was cut to fit one call.]`
      cost = estimateTokens(text)
    }
    used += cost
    blocks.push(text)
    returned.push(n)
  }
  const notes = [
    ...(missing.length ? [`The chat has no turn ${numberRanges(missing)} (it has ${total}).`] : []),
    ...(notReturned.length ? [`Turns ${numberRanges(notReturned)} didn't fit in one call (at most ${maxTokens.toLocaleString('en-US')} estimated tokens). Ask for them again.`] : [])
  ]
  return { text: [...blocks, ...notes].join('\n\n'), returned, total, missing, notReturned }
}

/** "Codex (GPT-6.1 Sol)" for a party, for the places that name who was involved. */
export function partyLabel(party: HandOffParty): string {
  return authorLabel({ agent: party.agent, model: party.model })
}

/** The agent's name alone: "Codex". */
export const agentName = (agent: AgentKind): string => AGENTS[agent]?.label ?? agent

/** The record in words for a terminal (`foreman chat switch`): English, as the CLI's other output is. */
export function describeHandOff(handOff: ChatHandOff): string {
  const number = new Map(handOff.turns.map((t) => [t.id, t.n]))
  const list = (ids: string[]) => numberRanges(ids.map((id) => number.get(id)).filter((n): n is number => n !== undefined))
  const to = agentName(handOff.to.agent)
  const lines = [
    `What ${to} received (${handOff.strategy}): ${handOff.full.length} turns in full, ${handOff.condensed.length} condensed, ${handOff.omitted.length} left out · ${handOff.usedTokens.toLocaleString('en-US')} of ${handOff.budgetTokens.toLocaleString('en-US')} tokens (an estimate: characters / 4)`
  ]
  if (handOff.sinceTurn) lines.push(`  Only the turns after #${number.get(handOff.sinceTurn) ?? '?'}, which ${to} had already seen`)
  if (handOff.full.length) lines.push(`  In full: #${list(handOff.full)}`)
  if (handOff.condensed.length) lines.push(`  Condensed (the request and the final answer): #${list(handOff.condensed)}`)
  if (handOff.omitted.length) lines.push(`  Left out: #${list(handOff.omitted)} (${to} can read them with ${READ_HISTORY_TOOL} where it has tools)`)
  return lines.join('\n')
}
