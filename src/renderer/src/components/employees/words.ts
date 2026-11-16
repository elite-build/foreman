// The words the employees views share (docs/ai-employees.md §5, §10): an employee's state as a Status, its model as
// text, its hat colour's name, and what its access means in sentences. Text only; the views lay it out.
import { catalogAgent } from '../../../../shared/agentCatalog'
import { effortLabel, modelInfo, type AgentKind } from '../../../../shared/agents'
import { fileName, needsYouItems, type DefinitionChange, type DefinitionField, type PlanGroups, type PlanLine } from '../../../../shared/employeeDecisions'
import {
  employeeStatus,
  type EmployeeSummary,
  type EmployeeActionPolicy,
  type EmployeeDefinition,
  type EmployeeRepoAccess,
  type EmployeeStatus,
  type PersonalityTrait
} from '../../../../shared/employees'
import { ACTION_NEEDS_PERSON, type EmployeeActionPayload, type EmployeeActionState } from '../../../../shared/employeeActions'
import { needsPerson, type EmployeeActivity, type EmployeeClosureReason, type EmployeeRunState, type EmployeeTask, type EmployeeWorkView } from '../../../../shared/employeeWork'
import { parseCron } from '../../../../shared/cron'
import {
  intervalMinutes,
  triggerKey,
  triggerZone,
  type AuthoredBy,
  type EmployeeTrigger,
  type EmployeeTriggerState,
  type EventSource,
  type EventTrigger,
  type PullRequestEvent,
  type TriggerFiring,
  type TriggerSkip
} from '../../../../shared/employeeTriggers'
import { formatDateTime } from '../../../../shared/i18n/time'
import type { PlainKey, TFunction } from '../../../../shared/i18n'
import { formatRun } from '../../../../shared/schedule'
import { clockTime, dayOf } from '../../../../shared/usageLimit'
import type { RendererT } from '../../i18n'
import type { StatusTone } from '../../ui'
import { cadenceText } from '../ScheduleDialogs'

// A draft doesn't run (it isn't approved here), so it has the hollow ○ of a state that isn't active, never Working's ■;
// its word says which.
export const STATUS_TONE: Record<EmployeeStatus, StatusTone> = { invalid: 'error', retired: 'off', changed: 'warn', paused: 'warn', draft: 'off', idle: 'off' }

export const STATUS_LABEL: Record<EmployeeStatus, PlainKey> = {
  invalid: 'employees.status.invalid',
  retired: 'employees.status.retired',
  changed: 'employees.status.changed',
  paused: 'employees.status.paused',
  draft: 'employees.status.draft',
  idle: 'employees.status.idle'
}

export const COLOUR_LABEL: Record<string, PlainKey> = {
  orange: 'employees.colour.orange',
  pink: 'employees.colour.pink',
  teal: 'employees.colour.teal',
  blue: 'employees.colour.blue',
  green: 'employees.colour.green',
  purple: 'employees.colour.purple',
  yellow: 'employees.colour.yellow',
  red: 'employees.colour.red',
  cyan: 'employees.colour.cyan',
  lime: 'employees.colour.lime',
  brown: 'employees.colour.brown',
  slate: 'employees.colour.slate'
}

/** A colour's name; a colour this build doesn't know reads as itself. */
export const colourName = (colour: string, t: TFunction): string => (COLOUR_LABEL[colour] ? t(COLOUR_LABEL[colour]) : colour)

export const TRAIT_LABEL: Record<PersonalityTrait, PlainKey> = {
  concise: 'employees.trait.concise',
  casual: 'employees.trait.casual',
  formal: 'employees.trait.formal',
  friendly: 'employees.trait.friendly',
  direct: 'employees.trait.direct',
  'data-driven': 'employees.trait.dataDriven',
  playful: 'employees.trait.playful',
  thorough: 'employees.trait.thorough'
}

export const ACCESS_LABEL: Record<EmployeeRepoAccess, PlainKey> = { none: 'employees.access.none', read: 'employees.access.read', write: 'employees.access.write' }

export const POLICY_LABEL: Record<EmployeeActionPolicy, PlainKey> = { held: 'employees.policy.held', allowed: 'employees.policy.allowed', never: 'employees.policy.never' }

const ACTION_LABEL: Record<string, PlainKey> = {
  'slack-post': 'employees.actionName.slackPost',
  linear: 'employees.actionName.linear',
  push: 'employees.actionName.push',
  'pull-request': 'employees.actionName.pullRequest'
}

/** An outward action's name; one Foreman doesn't list reads as its key. */
export const actionName = (action: string, t: TFunction): string => (ACTION_LABEL[action] ? t(ACTION_LABEL[action]) : action)

export const ACTION_STATE_LABEL: Record<EmployeeActionState, PlainKey> = {
  held: 'employees.heldAction.state.held',
  approved: 'employees.heldAction.state.approved',
  sent: 'employees.heldAction.state.sent',
  skipped: 'employees.heldAction.state.skipped',
  failed: 'employees.heldAction.state.failed',
  refused: 'employees.heldAction.state.refused',
  uncertain: 'employees.heldAction.state.uncertain'
}

/** "Slack post to #launches", "Push of feature/x": what an action is, in a few words. */
export function actionNoun(p: EmployeeActionPayload, t: TFunction): string {
  switch (p.kind) {
    case 'slack-post':
      return t('employees.actionNoun.slack', { channel: p.channelName ? `#${p.channelName}` : p.channel })
    case 'linear':
      return p.issue ? t('employees.actionNoun.linearIssue', { tool: p.tool, issue: p.issue }) : t('employees.actionNoun.linear', { tool: p.tool })
    case 'push':
      return t('employees.actionNoun.push', { branch: p.branch })
    case 'pull-request':
      return t('employees.actionNoun.pullRequest', { title: p.title })
  }
}

export const MEMORY_SCOPE_LABEL: Record<string, PlainKey> = { 'org/docs': 'employees.access.memoryDocs', 'org/data': 'employees.access.memoryData' }

/** "Claude Code" */
export const agentLabel = (agent: string): string => catalogAgent(agent)?.name ?? agent

/** "Claude Code · Claude Sonnet 5.5": the model as text, never a second icon beside the hat (§5.4). */
export function modelText(agent: string | undefined, model: string | undefined, t: TFunction): string {
  if (!agent) return ''
  const name = model ? modelInfo(agent as AgentKind, model, t).label : ''
  return name ? t('employees.model.text', { agent: agentLabel(agent), model: name }) : agentLabel(agent)
}

const join = (items: string[], t: TFunction) => items.join(t('employees.list.separator'))

export type CanDoSection = 'repos' | 'memory' | 'profile' | 'actions' | 'when' | 'limits' | 'model'

/**
 * What a definition lets the employee do, in sentences, each with the section of the precise form that changes it
 * (§5.3, "What it can do"). Every line is said, the safe ones too, so nothing is left to guess.
 */
export function canDoLines(d: EmployeeDefinition, t: RendererT, names: (id: string) => string = (id) => id): { section: CanDoSection; text: string }[] {
  const lines: { section: CanDoSection; text: string }[] = []
  const repos = Object.entries(d.access.repos)
  const reads = repos.filter(([, a]) => a === 'read').map(([r]) => r)
  const writes = repos.filter(([, a]) => a === 'write').map(([r]) => r)
  lines.push({ section: 'repos', text: reads.length ? t('employees.can.reads', { repos: join(reads, t) }) : writes.length ? t('employees.can.readsOnlyWritten') : t('employees.can.readsNone') })
  if (writes.length) lines.push({ section: 'repos', text: t('employees.can.writes', { repos: join(writes, t) }) })
  // Its own folder by its name ("Max's notes"), never the id in its path.
  lines.push({ section: 'memory', text: t('employees.can.memory', { folder: t('employees.employee.notesLink', { name: d.name.trim() || d.id }) }) })
  if (d.access.memory_write.length) lines.push({ section: 'memory', text: t('employees.can.memoryWrite', { folders: join(d.access.memory_write.map((s) => `memory/${s}/`), t) }) })
  lines.push({ section: 'profile', text: d.access.profile === 'shell' ? t('employees.can.shell') : t('employees.can.noShell') })
  if (d.access.mcp.length) lines.push({ section: 'profile', text: t('employees.can.mcp', { servers: join(d.access.mcp, t) }) })
  const by = (policy: EmployeeActionPolicy) => Object.entries(d.access.actions).filter(([, p]) => p === policy).map(([a]) => actionName(a, t))
  const allowed = by('allowed')
  const never = by('never')
  lines.push({ section: 'actions', text: allowed.length ? t('employees.can.allowed', { actions: join(allowed, t) }) : t('employees.can.held') })
  if (never.length) lines.push({ section: 'actions', text: t('employees.can.never', { actions: join(never, t) }) })
  if (d.access.delegate_to.length) lines.push({ section: 'actions', text: t('employees.can.delegates', { names: join(d.access.delegate_to.map(names), t) }) })
  const on = (d.triggers ?? []).filter((x) => x.enabled)
  lines.push({ section: 'when', text: on.length ? t('employees.can.whenTriggers', { triggers: join(on.map((x) => triggerWhen(x, t)), t) }) : t('employees.can.whenAsked') })
  const { runs_per_day: runs, minutes_per_run: minutes } = d.limits
  lines.push({
    section: 'limits',
    text:
      runs !== undefined && minutes !== undefined
        ? t('employees.can.limits', { runs, minutes })
        : runs !== undefined
          ? t('employees.can.limitRuns', { runs })
          : minutes !== undefined
            ? t('employees.can.limitMinutes', { minutes })
            : t('employees.can.noLimits')
  })
  if (d.limits.cost_per_day_usd !== undefined) lines.push({ section: 'limits', text: t('employees.can.cost', { cost: new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD' }).format(d.limits.cost_per_day_usd) }) })
  const model = modelText(d.model.agent, d.model.model, t)
  lines.push({ section: 'model', text: d.attendance === 'unattended' ? t('employees.can.model', { model }) : t('employees.can.modelAttended', { model }) })
  return lines
}

// ---- tasks and runs (docs/ai-employees.md §6) ----

/** A task's state as one word with a tone: held work says why it isn't running, a closed task says its reason. */
export function taskWord(task: Pick<EmployeeTask, 'state' | 'hold' | 'closureReason' | 'result' | 'question' | 'waitingOn'>): { label: PlainKey; tone: StatusTone } {
  if (task.state === 'running') return { label: 'employees.task.state.running', tone: 'info' }
  if (task.state === 'waiting') {
    // Parked on other employees' work, a dependency or a follow-up (§7): their own business, not the person's.
    if (task.waitingOn === 'reply') return { label: 'employees.task.state.waitingOnReply', tone: 'info' }
    if (task.waitingOn === 'dependency') return { label: 'employees.task.state.waitingOnDependency', tone: 'info' }
    if (task.waitingOn === 'date') return { label: 'employees.task.state.waitingOnDate', tone: 'info' }
    return { label: task.question ? 'employees.task.state.asks' : 'employees.task.state.waiting', tone: 'warn' }
  }
  if (task.state === 'open') {
    if (task.hold === 'paused') return { label: 'employees.task.state.paused', tone: 'warn' }
    if (task.hold === 'budget') return { label: 'employees.task.state.budget', tone: 'warn' }
    if (task.hold === 'root-limit') return { label: 'employees.task.state.rootLimit', tone: 'warn' }
    if (task.hold === 'usage-limit') return { label: 'employees.task.state.usageLimit', tone: 'warn' }
    if (task.hold === 'stopped') return { label: 'employees.task.state.stopped', tone: 'off' }
    return { label: 'employees.task.state.queued', tone: 'info' }
  }
  // What the run said (§6.2): partly done, or Foreman's synthetic partial when it said nothing, never shown as done.
  if (task.result?.synthetic) return { label: 'employees.task.closure.noResult', tone: 'warn' }
  if (task.result?.status === 'partial') return { label: 'employees.task.closure.partial', tone: 'warn' }
  const reason = task.closureReason ?? 'done'
  return { label: CLOSURE_LABEL[reason], tone: reason === 'done' ? 'ok' : reason === 'blocked' ? 'error' : reason === 'expired' ? 'warn' : 'off' }
}

export const CLOSURE_LABEL: Record<EmployeeClosureReason, PlainKey> = {
  done: 'employees.task.closure.done',
  'handed-off': 'employees.task.closure.handedOff',
  blocked: 'employees.task.closure.blocked',
  declined: 'employees.task.closure.declined',
  canceled: 'employees.task.closure.canceled',
  escalated: 'employees.task.closure.escalated',
  superseded: 'employees.task.closure.superseded',
  'no-follow-on': 'employees.task.closure.noFollowOn',
  expired: 'employees.task.closure.expired'
}

export const RUN_LABEL: Record<EmployeeRunState, PlainKey> = {
  queued: 'employees.run.state.queued',
  admitted: 'employees.run.state.admitted',
  provisioning: 'employees.run.state.provisioning',
  running: 'employees.run.state.running',
  completed: 'employees.run.state.completed',
  failed: 'employees.run.state.failed',
  'needs-you': 'employees.run.state.needsYou',
  uncertain: 'employees.run.state.uncertain',
  cancelled: 'employees.run.state.cancelled',
  'timed-out': 'employees.run.state.timedOut',
  'usage-limit': 'employees.run.state.usageLimit'
}

export const RUN_TONE: Record<EmployeeRunState, StatusTone> = {
  queued: 'info',
  admitted: 'info',
  provisioning: 'info',
  running: 'info',
  completed: 'ok',
  failed: 'error',
  'needs-you': 'warn',
  uncertain: 'warn',
  cancelled: 'off',
  'timed-out': 'error',
  // Not a failure (§9): its task waits for the limit to reset and runs again by itself.
  'usage-limit': 'warn'
}

/**
 * An employee's state word on the Team page and the sidebar (§6.5): its lifecycle, except that an approved one running
 * a task says Working. How many tasks need a person is shown beside it, separately, never instead of it.
 */
export function workStatus(status: EmployeeStatus, activity: Pick<EmployeeActivity, 'running'>): { label: PlainKey; tone: StatusTone } {
  if (activity.running && (status === 'idle' || status === 'paused')) return { label: 'employees.activity.working', tone: 'info' }
  return { label: STATUS_LABEL[status], tone: STATUS_TONE[status] }
}

/**
 * The one state a sidebar row shows (§10): a problem reading it, retired, changed since approval or a draft first; then
 * Needs you (with how many) when anything of it waits for a person, a pause for failures included; then Working, Paused or
 * Idle. One glyph and one word, never two that disagree.
 */
export function rowStatus(
  e: { problems: string[]; state: EmployeeSummary['state']; changed: boolean; pausedKind?: EmployeeSummary['pausedKind'] },
  activity: Pick<EmployeeActivity, 'running' | 'needsYou'>,
  t: TFunction
): { label: string; tone: StatusTone } {
  const status = employeeStatus(e)
  if (status === 'invalid' || status === 'retired' || status === 'changed' || status === 'draft') return { label: t(STATUS_LABEL[status]), tone: STATUS_TONE[status] }
  const needs = activity.needsYou + (e.pausedKind === 'failures' ? 1 : 0)
  if (needs > 0) return { label: t('employees.needsYou.count', { count: needs }), tone: 'warn' }
  const word = workStatus(status, activity)
  return { label: t(word.label), tone: word.tone }
}

/**
 * Why an open or waiting task isn't running, in words: a usage limit's hold says when it resets, in this computer's time
 * ("Waiting for the usage limit to reset at 23:30"), or when Foreman tries again when that isn't known (§9); anything
 * else is the reason main recorded.
 */
export function holdText(task: Pick<EmployeeTask, 'state' | 'hold' | 'reason' | 'limitHold'>, t: RendererT, now = Date.now()): string | undefined {
  const h = task.limitHold
  if (task.state !== 'open' || task.hold !== 'usage-limit' || !h) return task.reason
  if (!h.resetAt) return t('employees.hold.usageLimitUnknown', { time: clockTime(Date.parse(h.retryAt), t.locale) })
  const at = Date.parse(h.resetAt)
  const time = clockTime(at, t.locale)
  const day = dayOf(at, now, t.locale)
  if (day === 'today') return t('employees.hold.usageLimit', { time })
  return day === 'tomorrow' ? t('employees.hold.usageLimitTomorrow', { time }) : t('employees.hold.usageLimitDay', { day, time })
}

/**
 * One task in a line: what it is on, or why it waits or is held. A question (ask_person) is said once, in the person's
 * language around the employee's words ("Asks you: Which day does 2.4 launch?"), never beside the reason main recorded.
 */
function taskLine(task: EmployeeTask, t: RendererT, now: number): string {
  if (task.state === 'running') return t('employees.activity.on', { title: task.title })
  if (task.state === 'waiting') {
    const question = task.question?.question.split(/\r?\n/).find((l) => l.trim())?.trim()
    if (question) return t('employees.activity.asks', { question })
    return task.reason ? t('employees.activity.waiting', { title: task.title, reason: task.reason }) : t('employees.activity.waitingOnly', { title: task.title })
  }
  const reason = holdText(task, t, now)
  return reason ? t('employees.activity.held', { title: task.title, reason }) : t('employees.activity.heldOnly', { title: task.title })
}

/** What the employee is on or waiting for, in one line (§10, "what it's doing or waiting for"); undefined when nothing. */
export function activityText(activity: EmployeeActivity, t: RendererT, now = Date.now()): string | undefined {
  return activity.current ? taskLine(activity.current, t, now) : undefined
}

/**
 * What of the employee waits for the person, in one line (§10, Needs you, "what your answer unblocks"): a task that waits
 * on them (its question, or why), else an outward action held for them ("Held for you: Push of max/launch-2.4"), else a
 * memory change it proposes ("Proposes a memory change: memory/org/PROJECT.md"); undefined when nothing does.
 */
export function needsYouText(view: EmployeeWorkView | undefined, employeeId: string, t: RendererT, now = Date.now()): string | undefined {
  const task = view?.tasks.find((x) => x.employeeId === employeeId && needsPerson(x))
  if (task) return taskLine(task, t, now)
  const action = view?.actions?.find((a) => a.employeeId === employeeId && ACTION_NEEDS_PERSON.includes(a.state))
  if (action) return t('employees.activity.action', { state: t(ACTION_STATE_LABEL[action.state]), action: actionNoun(action.payload, t) })
  const proposal = view?.proposals.find((p) => p.employeeId === employeeId)
  return proposal ? t('employees.activity.proposal', { path: proposal.path }) : undefined
}

/** Its last result: the closed task's title, how it closed, and what it reported or why. */
export function lastResultText(activity: EmployeeActivity, t: TFunction): string | undefined {
  const last = activity.last
  if (!last) return undefined
  const how = t(taskWord(last).label)
  const said = last.resultSummary?.split('\n')[0] ?? last.closureDetail
  return said ? t('employees.activity.lastSaid', { title: last.title, how, said }) : t('employees.activity.last', { title: last.title, how })
}

// ---- triggers (docs/ai-employees.md §5.1, §8) ----

const pad = (n: number) => String(n).padStart(2, '0')

/** A cron expression in words where it has a usual shape ("Every Mon at 09:00"), else the expression itself. */
export function cronWords(cron: string, t: RendererT): string {
  const parsed = parseCron(cron)
  if (!parsed.ok) return t('employees.trigger.cronRaw', { cron })
  const { minutes, hours, days, months, weekdays, anyDay, anyWeekday } = parsed.spec
  const allMonths = months.length === 12
  const allDays = anyDay && days.length === 31
  const allWeek = anyWeekday && weekdays.length === 7
  if (allMonths && minutes.length === 1 && hours.length === 1) {
    const time = `${pad(hours[0])}:${pad(minutes[0])}`
    const base = { startDate: '', time, weekdays: [] as number[] }
    if (allDays && allWeek) return cadenceText({ ...base, recurrence: 'daily' }, t, t.locale)
    if (allDays && !anyWeekday) return cadenceText({ ...base, recurrence: 'weekly', weekdays }, t, t.locale)
    if (!anyDay && days.length === 1 && allWeek) return cadenceText({ ...base, recurrence: 'monthly', dayOfMonth: days[0] }, t, t.locale)
  }
  if (allMonths && allDays && allWeek && hours.length === 24) {
    if (minutes.length === 1) return cadenceText({ recurrence: 'hourly', startDate: '', time: `00:${pad(minutes[0])}`, weekdays: [] }, t, t.locale)
    const step = minutes[1] - minutes[0]
    if (minutes[0] === 0 && 60 % step === 0 && minutes.length === 60 / step && minutes.every((m, i) => m === i * step)) return t('employees.trigger.everyMinutes', { count: step })
  }
  return t('employees.trigger.cronRaw', { cron })
}

/** "Every 90 minutes", "Every 2 hours", "Every 3 days". */
export function intervalWords(every: string, t: TFunction): string {
  const minutes = intervalMinutes(every)
  if (minutes === undefined) return every
  if (minutes % 1440 === 0) return t('employees.trigger.everyDays', { count: minutes / 1440 })
  if (minutes % 60 === 0) return t('employees.trigger.everyHours', { count: minutes / 60 })
  return t('employees.trigger.everyMinutes', { count: minutes })
}

/** An event source's name, for the Edit view's Source select. */
export const EVENT_SOURCE_LABEL: Record<EventSource, PlainKey> = {
  'pull-request': 'employees.event.source.pullRequest',
  'base-moved': 'employees.event.source.baseMoved',
  memory: 'employees.event.source.memory',
  linear: 'employees.event.source.linear'
}

/** A pull request event's name, for the Edit view's checkboxes. */
export const PR_EVENT_NAME: Record<PullRequestEvent, PlainKey> = {
  merged: 'employees.event.on.merged',
  'ci-failed': 'employees.event.on.ciFailed',
  'review-requested': 'employees.event.on.reviewRequested',
  'changes-requested': 'employees.event.on.changesRequested',
  approved: 'employees.event.on.approved'
}

/** A pull request event in a sentence: "a pull request merges". */
const PR_EVENT_WORDS: Record<PullRequestEvent, PlainKey> = {
  merged: 'employees.event.pr.merged',
  'ci-failed': 'employees.event.pr.ciFailed',
  'review-requested': 'employees.event.pr.reviewRequested',
  'changes-requested': 'employees.event.pr.changesRequested',
  approved: 'employees.event.pr.approved'
}

export const AUTHORED_LABEL: Record<AuthoredBy, PlainKey> = { anyone: 'employees.event.authored.anyone', employees: 'employees.event.authored.employees', people: 'employees.event.authored.people' }

/**
 * When an event trigger fires, in words: "When a pull request merges in site", "When the base branch of site moves",
 * "When memory changes under memory/org/docs/**", with its filters after it.
 */
export function eventWhen(trigger: EventTrigger, t: TFunction): string {
  const repo = trigger.repo || t('employees.event.itsRepo')
  const filters: string[] = []
  let when: string
  switch (trigger.source) {
    case 'pull-request': {
      const events = (trigger.on ?? []).filter((e): e is PullRequestEvent => e in PR_EVENT_WORDS).map((e) => t(PR_EVENT_WORDS[e]))
      when = t('employees.event.when.pullRequest', { events: events.join(t('employees.event.or')) || t('employees.event.pr.nothing'), repo })
      if (trigger.branch) filters.push(t('employees.event.filter.branch', { branch: trigger.branch }))
      if (trigger.authored_by === 'employees') filters.push(t('employees.event.filter.byEmployees'))
      if (trigger.authored_by === 'people') filters.push(t('employees.event.filter.byPeople'))
      break
    }
    case 'base-moved':
      when = t('employees.event.when.baseMoved', { repo })
      break
    case 'memory':
      when = t('employees.event.when.memory', { paths: (trigger.paths ?? []).join(t('employees.list.separator')) })
      break
    case 'linear':
      when = t('employees.event.when.linear', { repo })
      if (trigger.team) filters.push(t('employees.event.filter.team', { team: trigger.team }))
      if (trigger.label) filters.push(t('employees.event.filter.label', { label: trigger.label }))
      break
  }
  return filters.length ? t('employees.event.withFilters', { when, filters: filters.join(t('employees.list.separator')) }) : when
}

/** When a trigger fires, in words, with its time zone: "Every Mon at 09:00 (Europe/London)"; an event trigger's event. */
export function triggerWhen(trigger: EmployeeTrigger, t: RendererT): string {
  if (trigger.kind === 'event') return eventWhen(trigger, t)
  const cadence =
    trigger.kind === 'cron'
      ? cronWords(trigger.cron, t)
      : trigger.kind === 'interval'
        ? intervalWords(trigger.every, t)
        : cadenceText(
            { recurrence: trigger.recurrence, startDate: trigger.start_date, time: trigger.time, weekdays: trigger.weekdays ?? [], ...(trigger.day_of_month !== undefined ? { dayOfMonth: trigger.day_of_month } : {}) },
            t,
            t.locale
          )
  return t('employees.trigger.when', { cadence, zone: triggerZone(trigger) })
}

/** What a trigger asks, in words: its prompt's first line, or its responsibilities. */
export function triggerAsks(trigger: EmployeeTrigger, t: TFunction): string {
  const first = trigger.prompt
    ?.split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim()
  return first ?? t('employees.trigger.asksDefault')
}

/** Why a firing was skipped, in words. */
export function skipText(skip: TriggerSkip, name: string, detail: string, t: TFunction): string {
  switch (skip) {
    case 'missed':
      return t('employees.trigger.skip.missed')
    case 'draft':
      return t('employees.trigger.skip.draft', { name })
    case 'changed':
      return t('employees.trigger.skip.changed', { name })
    case 'retired':
      return t('employees.trigger.skip.retired', { name })
    case 'invalid':
      return t('employees.trigger.skip.invalid', { name })
    case 'paused':
      return t('employees.trigger.skip.paused', { name })
    case 'overlap':
      return t('employees.trigger.skip.overlap')
    case 'no-repo':
      return t('employees.trigger.skip.noRepo', { name })
    case 'error':
      return t('employees.trigger.skip.error', { detail })
    case 'self':
      return t('employees.trigger.skip.self')
    case 'chain':
      return t('employees.trigger.skip.chain')
    case 'no-connection':
      return t('employees.trigger.skip.noConnection', { detail })
  }
}

/**
 * What became of a firing: "started a task", "started one task for 3 missed times", "merged into the task waiting",
 * "skipped, Foreman wasn’t running"; an event's: "fired for #42, 10:31", "skipped: chain guard".
 */
export function firingText(firing: TriggerFiring, name: string, t: RendererT): string {
  if (firing.subject && firing.outcome === 'fired') return t('employees.trigger.firing.firedFor', { subject: firing.subject, time: formatDateTime(firing.at, t.locale, { hour: '2-digit', minute: '2-digit' }) })
  if (firing.subject && firing.outcome === 'coalesced') return t('employees.trigger.firing.coalescedFor', { subject: firing.subject })
  if (firing.outcome === 'fired') return firing.collapsed && firing.collapsed > 1 ? t('employees.trigger.firing.collapsed', { count: firing.collapsed }) : t('employees.trigger.firing.fired')
  if (firing.outcome === 'coalesced') return t('employees.trigger.firing.coalesced')
  return skipText(firing.skip ?? 'error', name, firing.detail ?? '', t)
}

/** A trigger's next planned time and last firing on this computer, in words, for the Triggers tab and Automations. */
export function triggerStatus(trigger: EmployeeTrigger, state: EmployeeTriggerState | undefined, name: string, t: RendererT): { next?: string; last?: string } {
  const next = trigger.enabled && !state?.off && state?.nextAt ? t('employees.trigger.next', { time: formatRun(Date.parse(state.nextAt), triggerZone(trigger), t.locale) }) : undefined
  const fired = state?.firings.at(-1)
  return { ...(next ? { next } : {}), ...(fired ? { last: t('employees.trigger.last', { what: firingText(fired, name, t) }) } : {}) }
}

/**
 * "Next run Mon 16 Nov · 09:00 GMT": the soonest planned time of an employee's triggers here, while they can fire (it is
 * approved, unchanged, not paused or retired); undefined otherwise or when none is planned.
 */
export function nextRunText(
  orgId: string,
  e: Pick<EmployeeSummary, 'id' | 'state' | 'changed' | 'problems' | 'triggers'>,
  states: readonly EmployeeTriggerState[] | undefined,
  t: RendererT
): string | undefined {
  if (e.state !== 'active' || e.changed || e.problems.length || !e.triggers?.length) return undefined
  let soonest: { at: number; zone: string } | undefined
  for (const trigger of e.triggers) {
    if (!trigger.enabled || trigger.kind === 'event') continue
    const state = states?.find((s) => s.orgId === orgId && s.employeeId === e.id && s.triggerId === triggerKey(trigger))
    if (!state?.nextAt || state.off) continue
    const at = Date.parse(state.nextAt)
    if (!soonest || at < soonest.at) soonest = { at, zone: triggerZone(trigger) }
  }
  return soonest ? t('employees.card.next', { time: formatRun(soonest.at, soonest.zone, t.locale) }) : undefined
}

// ---- a draft's page is its plan (docs/ai-employees.md §5.3) ----

const PLAN_ACTION: Record<'allowed' | 'never' | 'held', Record<string, PlainKey>> = {
  allowed: { push: 'employees.plan.allowed.push', 'pull-request': 'employees.plan.allowed.pullRequest', 'slack-post': 'employees.plan.allowed.slack', linear: 'employees.plan.allowed.linear' },
  never: { push: 'employees.plan.never.push', 'pull-request': 'employees.plan.never.pullRequest', 'slack-post': 'employees.plan.never.slack', linear: 'employees.plan.never.linear' },
  held: { push: 'employees.plan.held.push', 'pull-request': 'employees.plan.held.pullRequest', 'slack-post': 'employees.plan.held.slack', linear: 'employees.plan.held.linear' }
}

export interface PlanContext {
  memory: string
  organization: string
  names: (id: string) => string
}

/**
 * A definition's plan in words, grouped Can / Can't / Asks you first, each line with why where that helps ("It has Read
 * access to site only."). Slack and Linear that it keeps no tools for are one line.
 */
export function planText(groups: PlanGroups, ctx: PlanContext, t: RendererT): Record<keyof PlanGroups, { text: string; detail?: string }[]> {
  const scopes = (list: string[]) => join(list.map((s) => (MEMORY_SCOPE_LABEL[s] ? t(MEMORY_SCOPE_LABEL[s]) : s)), t)
  const one = (line: PlanLine, group: keyof PlanGroups): { text: string; detail?: string } => {
    switch (line.kind) {
      case 'read':
        return { text: t('employees.plan.read', { repos: join(line.repos, t) }) }
      case 'write':
        return { text: t('employees.plan.write', { repos: join(line.repos, t) }) }
      case 'notes':
        return { text: t('employees.plan.notes', { memory: ctx.memory }) }
      case 'memory-write':
        return { text: t('employees.plan.memoryWrite', { folders: scopes(line.scopes), memory: ctx.memory }) }
      case 'shell':
        return { text: t('employees.plan.shell'), detail: t('employees.plan.shellWhy') }
      case 'mcp':
        return { text: t('employees.plan.mcp', { servers: join(line.servers, t) }), detail: t('employees.plan.mcpWhy') }
      case 'delegate':
        return { text: t('employees.plan.delegate', { names: join(line.ids.map(ctx.names), t) }) }
      case 'action':
        return { text: t(PLAN_ACTION[group === 'can' ? 'allowed' : group === 'cant' ? 'never' : 'held'][line.action] ?? 'employees.plan.held.push') }
      case 'no-repo-change':
        return { text: t('employees.plan.noRepoChange'), detail: line.reads.length ? t('employees.plan.noRepoChangeWhy', { repos: join(line.reads, t) }) : t('employees.plan.noRepoAccess') }
      case 'no-publish':
        return { text: t('employees.plan.noPublish') }
      case 'no-slack':
        return { text: t('employees.plan.noSlack'), detail: t('employees.plan.noSlackWhy') }
      case 'no-linear':
        return { text: t('employees.plan.noLinear'), detail: t('employees.plan.noLinearWhy') }
      case 'no-shell':
        return { text: t('employees.plan.noShell') }
      case 'no-delegate':
        return { text: t('employees.plan.noDelegate') }
      case 'shared-memory':
        return { text: t('employees.plan.sharedMemory', { organization: ctx.organization }), detail: t('employees.plan.sharedMemoryWhy') }
    }
  }
  const words = (group: keyof PlanGroups) => {
    const lines = groups[group]
    const both = lines.some((l) => l.kind === 'no-slack') && lines.some((l) => l.kind === 'no-linear')
    return lines.flatMap((line) => {
      if (both && line.kind === 'no-linear') return []
      if (both && line.kind === 'no-slack') return [{ text: t('employees.plan.noSlackLinear'), detail: t('employees.plan.noSlackLinearWhy') }]
      return [one(line, group)]
    })
  }
  return { can: words('can'), cant: words('cant'), asks: words('asks') }
}

/** When it runs, in one line, and the limits it keeps (§5.1, §9). */
export function planWhen(d: Pick<EmployeeDefinition, 'triggers' | 'limits' | 'attendance'>, t: RendererT): { when: string; limits: string; attended: string } {
  const on = (d.triggers ?? []).filter((x) => x.enabled)
  const when = on.length ? t('employees.plan.whenTriggers', { triggers: join(on.map((x) => triggerWhen(x, t)), t) }) : t('employees.plan.whenAsked')
  const cost = d.limits.cost_per_day_usd !== undefined ? new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD' }).format(d.limits.cost_per_day_usd) : undefined
  const { runs_per_day: runs, minutes_per_run: minutes } = d.limits
  const set =
    runs !== undefined && minutes !== undefined
      ? t('employees.plan.limits', { runs, minutes })
      : runs !== undefined
        ? t('employees.plan.limitRuns', { runs })
        : minutes !== undefined
          ? t('employees.plan.limitMinutes', { minutes })
          : t('employees.plan.noLimits')
  const limits = cost ? t('employees.plan.limitsCost', { limits: set, cost }) : set
  const attended = d.attendance === 'unattended' ? t('employees.plan.unattended') : t('employees.plan.attended')
  return { when, limits, attended }
}

/** "Claude Code · Opus 5.5 · High effort". */
export function planModel(d: Pick<EmployeeDefinition, 'model'>, t: RendererT): string {
  const model = modelText(d.model.agent, d.model.model, t) || agentLabel(d.model.agent)
  return d.model.effort ? t('employees.plan.modelLine', { model, effort: effortLabel(d.model.effort, t) }) : model
}

const CHANGE_LABEL: Record<Exclude<DefinitionField, 'repo' | 'action' | 'instructions'>, PlainKey> = {
  model: 'employees.changed.field.model',
  effort: 'employees.changed.field.effort',
  attendance: 'employees.changed.field.attendance',
  memory: 'employees.changed.field.memory',
  profile: 'employees.changed.field.profile',
  mcp: 'employees.changed.field.mcp',
  delegate: 'employees.changed.field.delegate',
  triggers: 'employees.changed.field.triggers',
  runs: 'employees.changed.field.runs',
  minutes: 'employees.changed.field.minutes',
  cost: 'employees.changed.field.cost',
  persona: 'employees.changed.field.persona',
  words: 'employees.changed.field.words'
}

/**
 * A difference since approval in words: what it is about, the old value and the new one, and whether it widens what the
 * employee may do ("Wider") or only rewords it ("Reworded"), so neither rests on colour.
 */
export function changeText(c: DefinitionChange, before: EmployeeDefinition, after: EmployeeDefinition, ctx: Pick<PlanContext, 'names'>, t: RendererT): { label: string; before: string; after: string; tag?: 'wider' | 'reworded' } {
  const none = t('employees.changed.none')
  const listOf = (v: string, map: (x: string) => string = (x) => x) => (v ? join(v.split(', ').map(map), t) : none)
  const value = (v: string): string => {
    switch (c.field) {
      case 'model': {
        const [agent, ...model] = v.split('/')
        return modelText(agent, model.join('/'), t) || agentLabel(agent)
      }
      case 'effort':
        return v ? effortLabel(v as NonNullable<EmployeeDefinition['model']['effort']>, t) : none
      case 'attendance':
        return v === 'unattended' ? t('employees.plan.unattendedShort') : t('employees.plan.attendedShort')
      case 'repo':
        return t(ACCESS_LABEL[v as EmployeeRepoAccess] ?? 'employees.access.none')
      case 'memory':
        return listOf(v, (s) => (MEMORY_SCOPE_LABEL[s] ? t(MEMORY_SCOPE_LABEL[s]) : s))
      case 'profile':
        return v === 'shell' ? t('employees.changed.shell') : t('employees.changed.noShell')
      case 'mcp':
        return listOf(v)
      case 'delegate':
        return listOf(v, ctx.names)
      case 'action':
        return t(POLICY_LABEL[v as EmployeeActionPolicy] ?? 'employees.policy.held')
      case 'runs':
        return v ? t('employees.changed.runs', { count: Number(v) }) : t('employees.access.noLimit')
      case 'minutes':
        return v ? t('employees.changed.minutes', { count: Number(v) }) : t('employees.access.noLimit')
      case 'cost':
        return v ? new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD' }).format(Number(v)) : none
      case 'persona':
        return v || none
      default:
        return v
    }
  }
  if (c.field === 'triggers') return { label: t(CHANGE_LABEL.triggers), before: planWhen(before, t).when, after: planWhen(after, t).when, ...(c.wider ? { tag: 'wider' as const } : {}) }
  if (c.field === 'instructions') return { label: t('employees.changed.field.instructions', { name: after.name || after.id }), before: '', after: '', tag: 'reworded' }
  if (c.field === 'words') return { label: t(CHANGE_LABEL.words), before: '', after: '', tag: 'reworded' }
  const label = c.field === 'repo' ? t('employees.changed.field.repo', { repo: c.subject ?? '' }) : c.field === 'action' ? actionName(c.subject ?? '', t) : t(CHANGE_LABEL[c.field])
  return { label, before: value(c.before), after: value(c.after), ...(c.wider ? { tag: 'wider' as const } : {}) }
}

/**
 * What waits for you from an employee, in a few words for its page's status line ("push max/launch-2.4", "answer
 * “Which day does 2.4 launch?”"); undefined when nothing does.
 */
export function decisionWhat(view: EmployeeWorkView | undefined, employeeId: string, t: RendererT): string | undefined {
  const item = needsYouItems(view, employeeId)[0]
  if (!item) return undefined
  switch (item.kind) {
    case 'question':
      return t('employees.what.question', { question: item.task.question!.question.split(/\r?\n/)[0] })
    case 'task':
      return t('employees.what.task', { title: item.task.title })
    case 'action':
      return actionNoun(item.action.payload, t)
    case 'proposal':
      return t('employees.what.proposal', { file: fileName(item.proposal.path) })
  }
}
