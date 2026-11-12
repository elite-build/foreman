// O1: switching agent mid-conversation. A tab can continue with another agent:
// the agent it leaves keeps its own conversation (parked), the new one gets the
// visible history as text (the same block a fork carries), and switching back
// resumes the parked conversation with a short note of what was said meanwhile.
// The pure parts: who wrote each turn, what a resumed agent is told, and what the
// picker and composer offer.
import { offers, type AgentCapabilities } from './agentCapabilities'
import { accountMoveGuess, DEFAULT_MOVE_RULE, type AgentInstance, type MoveRule } from './agentInstances'
import { AGENTS, modelInfo, type AgentKind, type Loadout } from './agents'
import type { ChatHandOff, HandOffParty } from './chatHandOff'
import { readOnlyEnforcement } from './permissions'
import type { ChatItem, Session } from './types'

/** The divider a switch leaves in the chat. `history`: the new agent gets the earlier messages as text; `native`: it resumed its own conversation. */
export interface AgentSwitch {
  from: AgentKind
  to: AgentKind
  model: string
  carried: 'history' | 'native'
  // What the target was given, written when its first turn starts (docs/agents.md 5.1).
  handOff?: ChatHandOff
}

/** A switch or an account move whose record is still to be written: the notice it goes on, and who is involved. Cleared once the agent started. */
export interface PendingHandOff {
  noticeId: string
  from: HandOffParty
  to: HandOffParty
  // The target's own conversation was resumed (it saw the chat up to its last turn); false: it starts a new one.
  resumed: boolean
}

/**
 * O1 (G1): the other lines that mark where a conversation changed without switching agents: it was compacted (the agent
 * works from a summary of what's above), or the tab moved to another model of the same agent (same conversation).
 */
export type ChatDivider = { kind: 'compact'; idle?: true; before?: number; after?: number; at?: string } | { kind: 'model'; agent: AgentKind; from: string; to: string }

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
  // #130: the account the conversation ran on, and where it lives; switching back restores both.
  instanceId?: string
  conversationKey?: string
}

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

/** After a rewind, the parked conversations that still match the chat: those whose last turn was kept. */
export function parkedAfterRewind(parked: Session['parked'], keptTurnIds: Set<string>): Session['parked'] {
  if (!parked) return undefined
  const out: NonNullable<Session['parked']> = {}
  for (const [agent, p] of Object.entries(parked) as [AgentKind, ParkedSession][]) if (p.lastTurnId && keptTurnIds.has(p.lastTurnId)) out[agent] = p
  return Object.keys(out).length ? out : undefined
}

// ---- the picker and the composer ----

/**
 * What choosing a model does: `apply` at once (same agent, or nothing to carry), or `ask` whether to continue here or
 * open a new chat. #130: another account of the same agent asks too, once the chat has a conversation of its own.
 */
/**
 * What continuing a tab with a flow step's own loadout changes (docs/agents.md 5.6): another agent is a switch with everything the
 * loadout names; the same agent on another account (the step names one) is a move to that account only, which the agent's own rule
 * for moving a chat allows or refuses; the same agent and account, or an account the step doesn't name, changes nothing.
 */
export function stepTabPatch(tab: Pick<Session, 'agent' | 'instanceId'>, loadout: Loadout): { agent?: AgentKind; model?: string; effort?: Loadout['effort']; fastMode?: boolean; instanceId?: string } | undefined {
  if (tab.agent !== loadout.agent) return { agent: loadout.agent, model: loadout.model, effort: loadout.effort, fastMode: loadout.fast, ...(loadout.instance ? { instanceId: loadout.instance } : {}) }
  if (loadout.instance && loadout.instance !== tab.instanceId) return { instanceId: loadout.instance }
  return undefined
}

export function modelChoiceAction(session: Pick<Session, 'agent' | 'instanceId' | 'agentSessionId'>, hasHistory: boolean, choice: Pick<Loadout, 'agent' | 'instance'>): 'apply' | 'ask' {
  if (choice.agent !== session.agent) return hasHistory ? 'ask' : 'apply'
  return hasHistory && session.agentSessionId && (choice.instance ?? undefined) !== (session.instanceId ?? undefined) ? 'ask' : 'apply'
}

export type ContinueBlock = 'running' | 'read-only' | 'history' | 'account' | 'cloud'

/**
 * Why this chat can't continue with that agent (only a new chat is offered then), or null when it can.
 * #130 `account`: the agent's rule keeps a chat on its account (`moveChats: never`). `cloud`: a remote workspace signs its
 * agent in its own way, so it takes only the default account (docs/agents.md 5.4). Both are known before anything changes.
 */
export function continueBlock(session: Pick<Session, 'readOnly' | 'importedMode' | 'status' | 'turnId'>, target: AgentCapabilities | undefined, accountBlocked = false, cloudAccount = false): ContinueBlock | null {
  if (session.importedMode === 'history') return 'history'
  if (session.status === 'running' || session.turnId) return 'running'
  if (session.readOnly && !readOnlyEnforcement(target)) return 'read-only'
  if (cloudAccount) return 'cloud'
  if (accountBlocked) return 'account'
  return null
}

/**
 * Whether the account a choice names is refused by its agent's move rule: another account of the chat's own agent, or the
 * account a parked conversation of another agent would be resumed on. Another agent with nothing parked starts a new
 * conversation, which any account takes. The window's guess, from the accounts' folders (main decides with the environment too).
 */
export function accountBlocked(
  session: Pick<Session, 'agent' | 'instanceId' | 'agentSessionId' | 'parked'>,
  choice: Pick<Loadout, 'agent' | 'instance'>,
  instances: AgentInstance[] | undefined,
  moveRule: (agent: AgentKind) => MoveRule | undefined = () => undefined
): boolean {
  const rule = moveRule(choice.agent) ?? DEFAULT_MOVE_RULE
  if (choice.agent === session.agent) return accountMoveGuess(instances, session.agent, session.instanceId, choice.instance, rule, Boolean(session.agentSessionId)) === 'blocked'
  const back = session.parked?.[choice.agent]
  if (!back || choice.instance === undefined) return false
  return accountMoveGuess(instances, choice.agent, back.instanceId, choice.instance, rule, Boolean(back.agentSessionId)) === 'blocked'
}

/** Whether the choice names an account in a remote workspace, which signs in its own way and takes only the default one. */
export function cloudAccountBlocked(cloud: boolean, choice: Pick<Loadout, 'instance'>): boolean {
  return cloud && Boolean(choice.instance)
}

/**
 * The composer's Plan control for the tab's agent (its record, with what it declared folded in: an ACP agent's plan session
 * mode counts). An agent without plan mode keeps the chip, disabled, with the record's `why` as its tooltip (a hidden
 * control can't say why); only an agent with no record at all has none.
 */
export function planControl(record: AgentCapabilities | undefined, opts: { planMode: boolean; readOnly?: boolean }): 'hidden' | 'unavailable' | 'locked' | 'on' | 'off' {
  if (!record) return 'hidden'
  if (!offers(record.planning.planMode)) return 'unavailable'
  if (opts.readOnly) return 'locked'
  return opts.planMode ? 'on' : 'off'
}
