// The capability record drawn as a list (docs/agents.md, 2.6): Settings → Agents → an agent → Capabilities. The groups follow the
// record's own order, and each line says one of three things, as a word and a sentence: it works, it works with a fallback
// (what Foreman does instead), or it isn't offered (why). Pure: the renderer turns the keys into text with its `t`.
import type { Ability, AgentCapabilities, FallbackId, Level } from './agentCapabilities'
import type { PlainKey } from './i18n'
import type { ApprovalPolicy } from './permissions'

export type CapabilityGroupId = 'sessions' | 'threads' | 'turns' | 'planning' | 'approvals' | 'tools' | 'subagents' | 'context' | 'checkpointing' | 'enforcement' | 'usage'

export interface CapabilityLine {
  // `group.name`, a stable id for tests and keys.
  id: string
  label: PlainKey
  level: Level
  // `fallback`: the sentence for what Foreman does instead; `none`: why it isn't offered; `native`: absent.
  detail?: PlainKey
  // `native`: a short clause that says how, where that helps ("from Foreman's own checkpoint").
  note?: PlainKey
  // The permission modes an agent runs at, for the line that lists them.
  modes?: readonly ApprovalPolicy[]
}

export interface CapabilityGroup {
  id: CapabilityGroupId
  label: PlainKey
  lines: CapabilityLine[]
}

/** One sentence per fallback, written next to what the fallback does (docs/agents.md, 2.5). */
export const FALLBACK_SENTENCE: Record<FallbackId, PlainKey> = {
  'interrupt-restart': 'agentCaps.fallback.interruptRestart',
  'checkpoint-fresh-session': 'agentCaps.fallback.checkpointFreshSession',
  'prompt-history': 'agentCaps.fallback.promptHistory',
  'session-always': 'agentCaps.fallback.sessionAlways',
  'once-always': 'agentCaps.fallback.onceAlways',
  'server-per-turn': 'agentCaps.fallback.serverPerTurn'
}

/** The words for an approval mode, as they read everywhere else (Settings → Data & devices, the composer). */
export const MODE_LABEL: Record<ApprovalPolicy, PlainKey> = {
  ask: 'agentAccess.level.ask',
  'ask-except-edits': 'agentAccess.level.askExceptEdits',
  auto: 'agentAccess.level.auto',
  'never-ask': 'agentAccess.level.neverAsk'
}

const GROUP_LABEL: Record<CapabilityGroupId, PlainKey> = {
  sessions: 'agentCaps.group.sessions',
  threads: 'agentCaps.group.threads',
  turns: 'agentCaps.group.turns',
  planning: 'agentCaps.group.planning',
  approvals: 'agentCaps.group.approvals',
  tools: 'agentCaps.group.tools',
  subagents: 'agentCaps.group.subagents',
  context: 'agentCaps.group.context',
  checkpointing: 'agentCaps.group.checkpointing',
  enforcement: 'agentCaps.group.enforcement',
  usage: 'agentCaps.group.usage'
}

const LINE_LABEL = {
  concurrentChats: 'agentCaps.line.concurrentChats',
  modelSwitch: 'agentCaps.line.modelSwitch',
  resume: 'agentCaps.line.resume',
  fork: 'agentCaps.line.fork',
  steer: 'agentCaps.line.steer',
  planMode: 'agentCaps.line.planMode',
  questions: 'agentCaps.line.questions',
  goals: 'agentCaps.line.goals',
  approvalTools: 'agentCaps.line.approvalTools',
  alwaysAllow: 'agentCaps.line.alwaysAllow',
  mcp: 'agentCaps.line.mcp',
  terminals: 'agentCaps.line.terminals',
  children: 'agentCaps.line.children',
  stopChild: 'agentCaps.line.stopChild',
  handoff: 'agentCaps.line.handoff',
  compact: 'agentCaps.line.compact',
  restoreFiles: 'agentCaps.line.restoreFiles',
  conversationRollback: 'agentCaps.line.conversationRollback',
  readOnly: 'agentCaps.line.readOnly',
  modes: 'agentCaps.line.modes',
  scopedWrites: 'agentCaps.line.scopedWrites',
  cost: 'agentCaps.line.cost',
  limitWindows: 'agentCaps.line.limitWindows',
  resetTime: 'agentCaps.line.resetTime'
} as const satisfies Record<string, PlainKey>

type LineName = keyof typeof LINE_LABEL

/** A line from an `Ability`: a fallback names its sentence, a `none` its `why`. */
function fromAbility(group: CapabilityGroupId, name: LineName, a: Ability, note?: PlainKey): CapabilityLine {
  const line: CapabilityLine = { id: `${group}.${name}`, label: LINE_LABEL[name], level: a.level }
  if (a.level === 'fallback' && a.fallback) line.detail = FALLBACK_SENTENCE[a.fallback]
  else if (a.level === 'none') line.detail = a.why ?? 'agentCaps.why.generic'
  else if (note) line.note = note
  return line
}

/** A line from a yes-or-no fact, with the sentence for the no. */
function fromFlag(group: CapabilityGroupId, name: LineName, on: boolean, why: PlainKey, note?: PlainKey): CapabilityLine {
  const line: CapabilityLine = { id: `${group}.${name}`, label: LINE_LABEL[name], level: on ? 'native' : 'none' }
  if (on) {
    if (note) line.note = note
  } else line.detail = why
  return line
}

/**
 * The record as groups of lines, in the record's order. An ability the agent has is Works, one it has by a fallback names that
 * fallback, and one it lacks gives the record's own sentence. Facts the record holds as plain values (how a hand-off arrives,
 * whether files are restored, who enforces read-only) are put in the same three words.
 */
export function capabilityGroups(record: AgentCapabilities): CapabilityGroup[] {
  const { sessions, threads, turns, planning, approvals, tools, subagents, context, checkpointing, enforcement, usage } = record
  const readOnly = enforcement.readOnly
  const groups: Record<CapabilityGroupId, CapabilityLine[]> = {
    sessions: [fromAbility('sessions', 'concurrentChats', sessions.concurrentChats), fromAbility('sessions', 'modelSwitch', sessions.modelSwitch)],
    threads: [fromAbility('threads', 'resume', threads.resume), fromAbility('threads', 'fork', threads.fork)],
    turns: [fromAbility('turns', 'steer', turns.steer)],
    planning: [fromAbility('planning', 'planMode', planning.planMode), fromAbility('planning', 'questions', planning.questions), fromAbility('planning', 'goals', planning.goals)],
    approvals: [fromAbility('approvals', 'approvalTools', approvals.tools), fromAbility('approvals', 'alwaysAllow', approvals.alwaysAllow)],
    tools: [fromAbility('tools', 'mcp', tools.mcp), fromAbility('tools', 'terminals', tools.terminals)],
    subagents: [fromAbility('subagents', 'children', subagents.children), fromAbility('subagents', 'stopChild', subagents.stop)],
    context: [
      // A hand-off by text is the one way every agent can take a chat over, so it is the fallback; `native` and `inject` are the agent's own.
      context.handoff === 'prompt'
        ? { id: 'context.handoff', label: LINE_LABEL.handoff, level: 'fallback', detail: FALLBACK_SENTENCE['prompt-history'] }
        : { id: 'context.handoff', label: LINE_LABEL.handoff, level: 'native' },
      fromAbility('context', 'compact', context.compact)
    ],
    checkpointing: [
      fromFlag('checkpointing', 'restoreFiles', checkpointing.restoreFiles, 'agentCaps.why.restoreFiles', 'agentCaps.note.restoreFiles'),
      fromAbility('checkpointing', 'conversationRollback', checkpointing.conversationRollback)
    ],
    enforcement: [
      fromFlag('enforcement', 'readOnly', readOnly !== null, 'agentCaps.why.readOnly', readOnly === 'plan' ? 'agentCaps.note.readOnlyPlan' : 'agentCaps.note.readOnlySandbox'),
      { ...fromFlag('enforcement', 'modes', enforcement.permissionModes.length > 1, 'agentCaps.why.oneMode'), modes: enforcement.permissionModes },
      fromAbility('enforcement', 'scopedWrites', enforcement.scopedWrites)
    ],
    usage: [
      fromFlag('usage', 'cost', usage.cost, 'agentCaps.why.cost'),
      fromFlag('usage', 'limitWindows', usage.limitWindows, 'agentCaps.why.limitWindows'),
      fromFlag('usage', 'resetTime', usage.resetTime, 'agentCaps.why.resetTime')
    ]
  }
  return (Object.keys(groups) as CapabilityGroupId[]).map((id) => ({ id, label: GROUP_LABEL[id], lines: groups[id] }))
}

/** How many of a group's lines work, work by a fallback, or aren't offered. */
export function countLevels(lines: readonly CapabilityLine[]): Record<Level, number> {
  const out: Record<Level, number> = { native: 0, fallback: 0, none: 0 }
  for (const line of lines) out[line.level]++
  return out
}

/** A group where everything works starts closed; one with a fallback or a gap starts open. */
export function startsOpen(group: Pick<CapabilityGroup, 'lines'>): boolean {
  return group.lines.some((l) => l.level !== 'native')
}
