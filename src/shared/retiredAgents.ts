// Agents Foreman no longer runs, and the agent that takes over what was saved for them. A retired id is no AgentKind:
// these helpers move a session, a default model or a template's model saved for one onto its successor, once, as the
// store loads (main/store.ts), restores a backup (main/gitBackup.ts) or imports a chat (main/portability.ts). Chat items
// keep the agent that actually answered; `retiredAgentName` names it there.
import { AGENTS, DEFAULT_MODEL, type AgentKind, type Loadout } from './agents'
import type { PromptTemplate, Session, Settings, TemplateStartModel } from './types'

export interface RetiredAgent {
  // The agent its chats and choices move to.
  successor: AgentKind
  // Its name, for the chat history it left.
  name: string
}

export const RETIRED_AGENTS: Readonly<Record<string, RetiredAgent>> = {
  // Google stopped serving Gemini CLI for personal Google accounts on 18 June 2026; Antigravity's CLI (agy) replaced it.
  gemini: { successor: 'antigravity', name: 'Gemini CLI' }
}

function retired(agent: unknown): RetiredAgent | undefined {
  return typeof agent === 'string' && Object.hasOwn(RETIRED_AGENTS, agent) ? RETIRED_AGENTS[agent] : undefined
}

/** The agent a retired agent's chats moved to; undefined for any agent Foreman still runs (or no agent). */
export function retiredSuccessor(agent: unknown): AgentKind | undefined {
  return retired(agent)?.successor
}

/** "Gemini CLI" for a retired agent's turns in a chat; undefined for any other id. */
export function retiredAgentName(agent: unknown): string | undefined {
  return retired(agent)?.name
}

/** An agent's name in a chat's history: its label, a retired agent's old name ("Gemini CLI"), else the id itself. */
export function historyAgentLabel(agent: string): string {
  return (Object.hasOwn(AGENTS, agent) ? AGENTS[agent as AgentKind].label : undefined) ?? retiredAgentName(agent) ?? agent
}

/** A model choice saved for a retired agent, moved to its successor's default model; any other choice unchanged. */
export function movedLoadout<T extends Loadout | TemplateStartModel>(choice: T): T
export function movedLoadout<T extends Loadout | TemplateStartModel>(choice: T | undefined): T | undefined
export function movedLoadout<T extends Loadout | TemplateStartModel>(choice: T | undefined): T | undefined {
  const successor = retiredSuccessor(choice?.agent)
  if (!choice || !successor) return choice
  // Its model, effort, fast mode and account were the retired agent's; the successor starts on its own default.
  const moved = { ...choice, agent: successor, model: DEFAULT_MODEL[successor] } as T & { effort?: unknown; instance?: unknown; fast?: boolean }
  delete moved.effort
  delete moved.instance
  if ('fast' in moved) moved.fast = false
  return moved
}

function movedTemplate(template: PromptTemplate): PromptTemplate {
  const startModel = movedLoadout(template.startModel)
  const followModel = movedLoadout(template.followUp?.model)
  if (startModel === template.startModel && followModel === template.followUp?.model) return template
  return { ...template, ...(startModel ? { startModel } : {}), ...(template.followUp ? { followUp: { ...template.followUp, ...(followModel ? { model: followModel } : {}) } } : {}) }
}

/**
 * Default models, the review model and templates' models saved for a retired agent move to its successor. A retired agent's
 * Settings choices (on, sign-in mode) carry over to its successor when the successor has none of its own; its program path
 * doesn't (a different program). Returns whether anything changed.
 */
export function moveRetiredSettings(settings: Settings): boolean {
  let changed = false
  if (Array.isArray(settings.loadouts) && settings.loadouts.some((l) => retiredSuccessor(l?.agent))) {
    settings.loadouts = settings.loadouts.map((l) => movedLoadout(l))
    changed = true
  }
  if (settings.reviewModel && retiredSuccessor(settings.reviewModel.agent)) {
    settings.reviewModel = movedLoadout(settings.reviewModel)
    changed = true
  }
  if (Array.isArray(settings.promptTemplates)) {
    const templates = settings.promptTemplates.map(movedTemplate)
    if (templates.some((t, i) => t !== settings.promptTemplates[i])) {
      settings.promptTemplates = templates
      changed = true
    }
  }
  const prefs = settings.agentPrefs as Record<string, { enabled?: boolean; auth?: 'cli' | 'apiKey'; path?: string } | undefined> | undefined
  if (prefs && typeof prefs === 'object') {
    for (const [id, info] of Object.entries(RETIRED_AGENTS)) {
      const own = prefs[id]
      if (!own) continue
      if (!prefs[info.successor] && (own.enabled !== undefined || own.auth !== undefined)) {
        prefs[info.successor] = { ...(own.enabled !== undefined ? { enabled: own.enabled } : {}), ...(own.auth !== undefined ? { auth: own.auth } : {}) }
      }
      delete prefs[id]
      changed = true
    }
  }
  return changed
}

/**
 * A session left on a retired agent continues on its successor: a new conversation (the retired agent's can't be resumed),
 * on the successor's default model, that gets the chat so far as text with its next message when there is one (`hasHistory`).
 * Any session drops what it parked for a retired agent and a pending hand-off naming one. Returns whether it was on a
 * retired agent (the caller tells the chat).
 */
export function moveRetiredSession(session: Session, hasHistory: boolean): boolean {
  if (session.parked) {
    for (const id of Object.keys(session.parked)) if (retired(id)) delete (session.parked as Record<string, unknown>)[id]
    if (!Object.keys(session.parked).length) session.parked = undefined
  }
  const pending = session.handOffPending
  if (pending && (retired(pending.from.agent) || retired(pending.to.agent))) session.handOffPending = undefined
  for (const queued of session.queue ?? []) if (queued.followUp?.model) queued.followUp.model = movedLoadout(queued.followUp.model)
  const successor = retiredSuccessor(session.agent)
  if (!successor) return false
  session.agent = successor
  session.model = DEFAULT_MODEL[successor]
  session.effort = undefined
  session.fastMode = false
  session.planMode = false
  // Everything that pointed into the retired agent's own conversation or account.
  session.instanceId = undefined
  session.conversationKey = undefined
  session.agentSessionId = undefined
  session.lastAssistantUuid = undefined
  session.resumeAt = undefined
  session.nativeFork = undefined
  session.forkOnResume = undefined
  session.nativeLineage = undefined
  session.contextUsage = undefined
  session.catchUpSince = undefined
  session.modeNoticed = undefined
  session.limitResume = undefined
  session.limitHeld = undefined
  session.seedHistory = hasHistory ? 'switch' : undefined
  return true
}
