// The capability record: what each coding agent can do, as data every feature reads (docs/agents.md, section 2).
// This file is the type and the pure helpers. The records themselves are in agentCatalog/; the lookup by agent id
// is in agentCatalog.ts (staticCapabilities), which knows which ids exist. Nothing here names an agent.
// Pure: main, the renderer, the phone and the CLI share it.
import type { PlainKey } from './i18n'
import type { ApprovalPolicy } from './permissions'
import type { ReadOnlyEnforcement } from './types'

/** How an agent does a thing: itself (`native`), by something Foreman does instead (`fallback`), or not at all (`none`). */
export type Level = 'native' | 'fallback' | 'none'

/** What Foreman does instead, where the agent has no way of its own. One implementation each (docs/agents.md, 2.5). */
export type FallbackId =
  // steer: interrupt, restart with the message, mark the turn
  | 'interrupt-restart'
  // rollback: restore files, fresh session seeded with history up to there
  | 'checkpoint-fresh-session'
  // fork / hand-off: history as attributed text in the first turn
  | 'prompt-history'
  // "always allow" remembered by Foreman for this session
  | 'session-always'
  // "always allow" answered as "once", reason shown
  | 'once-always'
  // one server process for each turn: the agent's environment names its turn, and ACP can't set one per session
  | 'server-per-turn'

export interface Ability {
  level: Level
  // Required when level is 'fallback'.
  fallback?: FallbackId
  // Required when level is 'none': one sentence the UI shows (a message key, translated by the feature).
  why?: PlainKey
}

/** `ability('native')`, `ability('fallback', 'prompt-history')`, `ability('none', 'agentCaps.why.plan')`. */
export function ability(level: 'native'): Ability
export function ability(level: 'fallback', fallback: FallbackId): Ability
export function ability(level: 'none', why: PlainKey): Ability
export function ability(level: Level, detail?: FallbackId | PlainKey): Ability {
  if (level === 'native') return { level }
  if (level === 'fallback') return { level, fallback: detail as FallbackId }
  return { level, why: detail as PlainKey }
}

/** Whether the ability is offered at all, natively or by a fallback. */
export function offers(a: Ability): boolean {
  return a.level !== 'none'
}

/** Whether the ability is a fallback, and that one. */
export function isFallback(a: Ability, fallback: FallbackId): boolean {
  return a.level === 'fallback' && a.fallback === fallback
}

/**
 * Whether a running turn of this agent can be cut and restarted with a new message first, because it can't take one in
 * (`turns.steer` is the `interrupt-restart` fallback): the composer offers "Interrupt and send" as an explicit choice.
 */
export function interruptsToSteer(record: Pick<AgentCapabilities, 'turns'> | undefined): boolean {
  return record ? isFallback(record.turns.steer, 'interrupt-restart') : false
}

/**
 * What an agent's driver provides beyond a turn. Main derives the `DRIVER_FEATURES` from the registered driver, so they
 * can't drift from the adapter (main/agents/capabilities.ts); the rest is static data in the record.
 */
export interface AgentFeatures {
  // The Foreman assistant can run on it (Claude's locked-down turn).
  assistant: boolean
  // Scheduled runs and flow steps can use it: it can run with nobody there to answer an approval.
  unattended: boolean
  // It can run inside a cloud workspace's sandbox.
  cloud: boolean
  // Its turns can be kept running while Foreman is closed (the agent host).
  keptRunning: boolean
  // `report` and `request_review` tools for a chat started with "Teach agents Foreman".
  reportTools: boolean
  // The GetWorkspaceDiff and diff-comment tools.
  diffTool: boolean
  // Suggested follow-ups under an answer.
  followups: boolean
  // The repository's shared slash commands in the composer.
  repoCommands: boolean
  // Its transcript is mirrored into Foreman (and resumed from it).
  transcriptMirror: boolean
  // It writes chat titles (a one-shot answer with no tools).
  titles: boolean
}

/** The features main derives from the driver; the others are static. */
export const DRIVER_FEATURES = ['titles', 'diffTool', 'followups', 'reportTools', 'transcriptMirror'] as const
export type DriverFeature = (typeof DRIVER_FEATURES)[number]

/** Facts an agent states when it starts, which resolveCapabilities may accept. */
export type DeclarableFact = 'planMode' | 'version' | 'windowsSandbox'

export interface AgentCapabilities {
  sessions: {
    // The composer's model chip.
    modelSwitch: Ability
    // Several chats at once: native where the agent's own process serves each, `server-per-turn` where Foreman starts a process for
    // every turn so that each carries its own turn's environment.
    concurrentChats: Ability
  }
  threads: {
    // Continue the agent's own conversation on the next turn.
    resume: Ability
    // forkSession.
    fork: Ability
  }
  turns: {
    // Deliver a message into the running turn (planDelivery, composer, phone).
    steer: Ability
  }
  planning: {
    // The Plan chip. For an ACP agent this is static `none` until the agent declares a plan mode (`declares`).
    planMode: Ability
    // The ask card: the agent asking the person a question mid-turn.
    questions: Ability
    // A goal the agent works toward by itself across turns (`/goal`, and the card above the composer that shows it).
    goals: Ability
  }
  approvals: {
    // The approval card.
    tools: Ability
    // "Always allow" on it.
    alwaysAllow: Ability
  }
  tools: {
    // Repo MCP servers, foreman-app and integrations reach it (repoMcpSupport says how).
    mcp: Ability
    // The commands it asks Foreman to run for it (ACP `terminal/create`): piped processes under Foreman's approval, shown in the chat
    // (docs/agents.md 3). `none` for an agent that starts its own commands.
    terminals: Ability
  }
  subagents: {
    children: Ability
    stop: Ability
  }
  context: {
    // How a chat's history reaches it after a switch.
    handoff: 'native' | 'inject' | 'prompt'
    compact: Ability
  }
  checkpointing: {
    // Restore puts the workspace files back from the checkpoint (the chat shows the Restore control).
    restoreFiles: boolean
    // Restore also rewinds the agent's own conversation.
    conversationRollback: Ability
  }
  enforcement: {
    // Who holds the permission mode: the agent (its modes, its sandbox) or Foreman (its own prompts and review).
    by: 'agent' | 'foreman'
    // How Foreman holds a chat to read-only; null where it can't.
    readOnly: ReadOnlyEnforcement | null
    // The modes a turn of this agent honours.
    permissionModes: readonly ApprovalPolicy[]
    // The #170 ceilings a turn can be held to.
    ceilings: readonly ApprovalPolicy[]
    // A flow persona's `writes` globs.
    scopedWrites: Ability
  }
  usage: {
    // A turn's cost is reported.
    cost: boolean
    // Per-window limits (session, weekly) are reported.
    limitWindows: boolean
    // A usage limit's reset time can be read.
    resetTime: boolean
  }
  features: AgentFeatures
  // What the record was proven against: real recorded traffic or a protocol simulation (docs/agents.md, section 9).
  evidence: 'recorded' | 'simulated'
  // The facts this agent states when it starts and the record accepts.
  declares: readonly DeclarableFact[]
  // The agent's version, when it declared one. Never static.
  version?: string
}

/** What one account of an agent stated when it started. Absent fields: not stated. */
export interface DeclaredFacts {
  // An ACP agent listed a plan session mode.
  planMode?: boolean
  // OpenCode's server version, Codex's `initialize` result.
  version?: string
  // Codex on Windows: whether its sandbox is ready (`windowsSandbox/readiness`), read at the start of a turn. Every protection Codex
  // has (read-only, scoped writes, the #170 ceilings) is a sandbox policy, so a sandbox that isn't ready takes all three away.
  windowsSandbox?: 'ready' | 'not-ready'
}

/** The key under an agent in `declared` for facts that hold for every account of it (ACP session modes: known per agent). */
export const EVERY_ACCOUNT = ''

/**
 * The key for the agent's default account (a chat with no `instanceId`). A fact an account states about its own home (its version, its
 * Windows sandbox's readiness) is kept under that account's key, never under EVERY_ACCOUNT, so no other account inherits it.
 */
export const DEFAULT_ACCOUNT = 'default'

/** What the snapshot carries: the static record per agent, and what each account declared. */
export interface AgentCapabilitiesView {
  agents: Record<string, AgentCapabilities>
  // agent id → account id (EVERY_ACCOUNT for facts of the agent, DEFAULT_ACCOUNT for the default account) → facts
  declared: Record<string, Record<string, DeclaredFacts>>
}

/**
 * The record with what the agent declared folded in. Declared facts only fill what the record says the agent declares,
 * and only ever turn a `none` plan mode on or take enforcement away; they never invent another ability.
 */
export function resolveCapabilities(base: AgentCapabilities, declared?: DeclaredFacts): AgentCapabilities {
  if (!declared) return base
  let out = base
  if (declared.planMode && base.declares.includes('planMode') && base.planning.planMode.level === 'none') {
    out = { ...out, planning: { ...out.planning, planMode: ability('native') } }
  }
  if (declared.version && base.declares.includes('version')) {
    out = { ...out, version: declared.version }
  }
  if (declared.windowsSandbox === 'not-ready' && base.declares.includes('windowsSandbox')) {
    // The ceilings (#170) are sandbox policies too: a sandbox that isn't ready holds none below Never ask.
    out = { ...out, enforcement: { ...out.enforcement, readOnly: null, scopedWrites: ability('none', 'agentCaps.why.sandboxNotReady'), ceilings: out.enforcement.ceilings.filter((c) => c === 'never-ask') } }
  }
  return out
}

/**
 * The record for an agent's account (`instance` absent: the default account), or undefined for an agent with no chats. The account's own
 * declaration is laid over the facts stated for the agent (ACP modes are known per agent today).
 */
export function capabilitiesFor(view: AgentCapabilitiesView, agent: string, instance?: string): AgentCapabilities | undefined {
  const base = view.agents[agent]
  if (!base) return undefined
  const byAccount = view.declared[agent]
  const declared = byAccount ? { ...byAccount[EVERY_ACCOUNT], ...byAccount[instance ?? DEFAULT_ACCOUNT] } : undefined
  return resolveCapabilities(base, declared)
}
