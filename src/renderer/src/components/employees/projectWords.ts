// The words for projects (docs/ai-employees.md §15) in the person's language: a project's state and the line under its
// name, a part's state, a plan's status, what a project waits on. Text only; the views lay it out.
import type { PlainKey } from '../../../../shared/i18n'
import { channelSlug, projectSlug, type PartState, type Project, type ProjectPlan, type ProjectWait } from '../../../../shared/projects'
import type { useT } from '../../i18n'
import type { StatusTone } from '../../ui'

type T = ReturnType<typeof useT>

/** A part's state as a Status: a glyph's tone and a word. */
export const PART_STATUS: Record<PartState, { tone: StatusTone; label: PlainKey }> = {
  pending: { tone: 'off', label: 'projects.part.pending' },
  running: { tone: 'info', label: 'projects.part.running' },
  gate: { tone: 'warn', label: 'projects.part.gate' },
  done: { tone: 'ok', label: 'projects.part.done' },
  stuck: { tone: 'error', label: 'projects.part.stuck' }
}

export const PLAN_STATUS_KEY: Record<ProjectPlan['status'], PlainKey> = {
  waiting: 'projects.plan.status.waiting',
  approved: 'projects.plan.status.approved',
  'went-ahead': 'projects.plan.status.wentAhead',
  replaced: 'projects.plan.status.replaced',
  'sent-back': 'projects.plan.status.sentBack'
}

export const WAIT_KIND_KEY: Record<ProjectWait['kind'], PlainKey> = {
  questions: 'projects.wait.questions',
  plan: 'projects.wait.plan',
  gate: 'projects.wait.gate',
  stuck: 'projects.wait.stuck',
  final: 'projects.wait.final'
}

/** A channel's name: `#csv-export`, `#frlk`. */
export const channelName = (slug: string) => `#${slug}`
export const orgChannelSlug = (name: string) => projectSlug(name, [])
/** What moved in an organization's listed projects (a stable string, where the snapshot's arrays are new each time). */
export const projectsPulse = (projects: readonly Pick<Project, 'id' | 'updatedAt'>[] | undefined): string => (projects ?? []).map((p) => `${p.id}:${p.updatedAt}`).join(',')
/** A project's channel name, as the person named it or from its title: `#csv-export`. */
export const projectChannel = (p: Pick<Project, 'slug' | 'name'>) => channelName(channelSlug(p))

/** A part's title, by id, in the plan in effect (or the newest). */
export function partTitle(project: Pick<Project, 'plan' | 'plans'>, partId: string | undefined): string {
  if (!partId) return ''
  return (project.plan ?? project.plans.at(-1))?.parts.find((p) => p.id === partId)?.title ?? partId
}

/** A project's state in a glyph and a word, and the line under its name (what it is doing, or what it waits on). */
export function projectStatus(project: Project, t: T, pmName: string): { tone: StatusTone; label: string; line: string } {
  if (project.phase === 'closed') return { tone: project.outcome === 'done' ? 'ok' : 'off', label: t(project.outcome === 'done' ? 'projects.state.done' : 'projects.state.stopped'), line: project.title }
  const wait = project.waits[0]
  if (wait?.kind === 'stuck') return { tone: 'error', label: t('projects.state.stuck'), line: wait.reason ?? project.title }
  if (wait) return { tone: 'warn', label: t('projects.state.waitingYou'), line: wait.kind === 'gate' ? t('projects.line.gate', { part: partTitle(project, wait.partId) }) : wait.kind === 'questions' ? t('projects.line.questions', { name: pmName }) : t(WAIT_KIND_KEY[wait.kind]) }
  if (project.paused) return { tone: 'off', label: t('projects.state.paused'), line: project.title }
  if (project.phase === 'planning' || project.replanning) return { tone: 'info', label: t('projects.state.planning'), line: t('projects.line.planning', { name: pmName }) }
  if (project.phase === 'accepting') return { tone: 'info', label: t('projects.state.accepting'), line: t('projects.line.accepting', { name: pmName }) }
  const parts = project.plan?.parts ?? []
  const done = parts.filter((p) => project.parts[p.id]?.state === 'done').length
  return { tone: 'info', label: t('projects.state.working'), line: t('projects.line.parts', { done, count: parts.length }) }
}
