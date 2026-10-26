// Onboarding state kept in state.json, and what the Get started checklist on Home is made of. Pure, so main (the
// migration, recording a milestone), the renderer (the card) and the tests all use the same rules.
import type { AgentReadiness } from './agentReadiness'
import type { AssistantGate } from './assistant'

/**
 * The things a person does once that the checklist remembers. Recorded the first time, never undone.
 * The other checklist items are worked out from the app's state: a project, a workspace, the default agent's sign-in.
 */
export const ONBOARDING_MILESTONES = ['comfortable', 'needsYou', 'tiles', 'template', 'automation', 'assistant', 'mcp'] as const
export type OnboardingMilestone = (typeof ONBOARDING_MILESTONES)[number]

export interface OnboardingState {
  // When each milestone was first reached (an ISO time).
  milestones: Partial<Record<OnboardingMilestone, string>>
  // "Hide checklist": Home's Get started card stays away until it is opened again from ⌘K.
  checklistHidden: boolean
}

export function defaultOnboarding(): OnboardingState {
  return { milestones: {}, checklistHidden: false }
}

export function isOnboardingMilestone(value: unknown): value is OnboardingMilestone {
  return typeof value === 'string' && (ONBOARDING_MILESTONES as readonly string[]).includes(value)
}

/** What is saved, with anything unknown or malformed dropped (an edited state.json, or one from a newer Foreman). */
function cleanMilestones(value: unknown): OnboardingState['milestones'] {
  const out: OnboardingState['milestones'] = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [id, at] of Object.entries(value)) if (isOnboardingMilestone(id) && typeof at === 'string' && at) out[id] = at
  return out
}

export interface OnboardingMigrationInput {
  // What state.json had (undefined when it had nothing, as on a new install or before this version).
  onboardingSeen?: unknown
  onboarding?: unknown
  // Whether the user already had repositories, or had finished the old welcome tour: someone who has found their way around.
  established: boolean
}

/**
 * The first-run gate and the checklist, brought up to date. A person who already had repositories or had seen the
 * tour is never sent through the first run, and the checklist never opens by itself for them (it is still in ⌘K).
 */
export function migrateOnboarding(input: OnboardingMigrationInput): { onboardingSeen: boolean; onboarding: OnboardingState } {
  const onboardingSeen = typeof input.onboardingSeen === 'boolean' ? input.onboardingSeen : input.established
  const saved = input.onboarding && typeof input.onboarding === 'object' && !Array.isArray(input.onboarding) ? (input.onboarding as Partial<OnboardingState>) : undefined
  return {
    onboardingSeen,
    onboarding: {
      milestones: cleanMilestones(saved?.milestones),
      checklistHidden: typeof saved?.checklistHidden === 'boolean' ? saved.checklistHidden : input.established
    }
  }
}

/** Records a milestone. The first time stands: a second call returns the same state, so a repeat never moves the time. */
export function withMilestone(state: OnboardingState, id: OnboardingMilestone, at: string): OnboardingState {
  if (state.milestones[id]) return state
  return { ...state, milestones: { ...state.milestones, [id]: at } }
}

// ---- the checklist ----

export type ChecklistItemId = 'comfortable' | 'agent' | 'project' | 'workspace' | 'needsYou' | 'tiles' | 'template' | 'automation' | 'assistant' | 'mcp'

/**
 * - `done`: reached (a milestone, or the app's state says so now).
 * - `todo`: not yet.
 * - `attention`: a live item that is not working now: the default agent is not signed in or not installed.
 * - `needs-claude`: the assistant cannot run until Claude is signed in (it runs on Claude only).
 */
export type ChecklistStatus = 'done' | 'todo' | 'attention' | 'needs-claude'

export interface ChecklistItem {
  id: ChecklistItemId
  // A milestone is recorded once; a live item is read from the app each time; a derived one is true while it exists.
  kind: 'milestone' | 'live' | 'derived'
  status: ChecklistStatus
}

/** Optional pages and places, listed under "More": links, not tracked. */
export const CHECKLIST_MORE = ['cloud', 'phone', 'backup', 'shortcuts'] as const
export type ChecklistMoreId = (typeof CHECKLIST_MORE)[number]

export interface ChecklistInput {
  onboarding: OnboardingState
  repoCount: number
  workspaceCount: number
  // The default agent's sign-in as the evidence shows it now; undefined while it is not known.
  agent?: Pick<AgentReadiness, 'ready' | 'evidenceKey'> | null
  // Whether the assistant can run; undefined until asked.
  assistantGate?: AssistantGate | null
}

export interface Checklist {
  items: ChecklistItem[]
  done: number
  total: number
  // Every tracked item is done.
  complete: boolean
}

/** True when the assistant cannot run until Claude is signed in. Off and Privacy mode are the user's own choices, not this. */
export function assistantNeedsClaude(gate: AssistantGate | null | undefined): boolean {
  if (!gate) return false
  if (gate.state === 'none' || gate.state === 'signed-out') return true
  return gate.state === 'unsupported' && !gate.alternative
}

/** Whether the assistant is on the checklist at all: it is not when the user turned it off or Privacy mode stops it. */
export function assistantOffered(gate: AssistantGate | null | undefined): boolean {
  return !gate || (gate.state !== 'off' && gate.state !== 'privacy')
}

function agentStatus(agent: ChecklistInput['agent']): ChecklistStatus {
  if (!agent || agent.evidenceKey === 'agentReadiness.checking') return 'todo'
  return agent.ready ? 'done' : 'attention'
}

/** The checklist's items in order, each with where it stands. */
export function deriveChecklist(input: ChecklistInput): Checklist {
  const { onboarding } = input
  const milestone = (id: OnboardingMilestone): ChecklistStatus => (onboarding.milestones[id] ? 'done' : 'todo')
  const item = (id: ChecklistItemId, kind: ChecklistItem['kind'], status: ChecklistStatus): ChecklistItem => ({ id, kind, status })
  const items: ChecklistItem[] = [
    item('comfortable', 'milestone', milestone('comfortable')),
    item('agent', 'live', agentStatus(input.agent)),
    item('project', 'derived', input.repoCount > 0 ? 'done' : 'todo'),
    item('workspace', 'derived', input.workspaceCount > 0 ? 'done' : 'todo'),
    item('needsYou', 'milestone', milestone('needsYou')),
    item('tiles', 'milestone', milestone('tiles')),
    item('template', 'milestone', milestone('template')),
    item('automation', 'milestone', milestone('automation'))
  ]
  // Trying the assistant is remembered even if Claude is signed out later; it is only left off when the user turned it off.
  const asked = Boolean(onboarding.milestones.assistant)
  if (asked || assistantOffered(input.assistantGate)) items.push(item('assistant', 'milestone', asked ? 'done' : assistantNeedsClaude(input.assistantGate) ? 'needs-claude' : 'todo'))
  items.push(item('mcp', 'milestone', milestone('mcp')))
  const done = items.filter((i) => i.status === 'done').length
  return { items, done, total: items.length, complete: done === items.length }
}

/** Whether Home shows the Get started card: not hidden, and something is still to do. */
export function checklistShown(onboarding: OnboardingState, checklist: Checklist): boolean {
  return !onboarding.checklistHidden && !checklist.complete
}
