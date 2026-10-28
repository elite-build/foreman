// `foreman schedules …`: Automations → Schedules from the command line. Saving a schedule approves the template and the
// repository's setup, checks and MCP servers as they are now, so `preview` prints exactly what the Schedule dialog implies and
// `add`/`edit`/`approve` send the fingerprint back as `shown`: the service refuses when it no longer matches, as the window does.
import { modelsFor } from '../../shared/agents'
import { pickerModels } from '../../shared/modelVisibility'
import { templatePlaceholders } from '../../shared/promptTemplates'
import { findLayeredTemplate } from '../../shared/repoTemplates'
import { dateInZone, DEFAULT_MAX_MINUTES, formatRun, parseDate, parseTime, previewRuns, validTimezone, weekdaysText, WEEKDAY_NAMES } from '../../shared/schedule'
import { pullRequestUrl } from '../../shared/status'
import type { OccurrenceRow, ScheduleRow, SchedulePreviewResult, SchedulesApproveResult, SchedulesChangeResult, SchedulesListResult, SchedulesRemoveResult, SchedulesRunsResult, SchedulesSaveResult, SchedulesStopRunResult } from '../../shared/cli/schedules'
import type { AppSnapshot, Occurrence, PromptTemplate, Repo, Schedule, ScheduleFingerprint, ScheduleFingerprintView, ScheduleRequest } from '../../shared/types'
import { changedParts, scheduleProblem } from '../schedules'
import { resolveLoadout } from './agents'
import type { CliHost } from './host'
import { columns, invalid, numberParam, paramsObject, textList, textParam, type MethodDef } from './kit'
import { ambiguous, durationText, findByRef, firstLine, notFound, refused, type RefSpec } from './refs'
import { resolveRepo } from './resolve'

const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

// ---- words ----

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** "every day at 09:00", "every Mon, Wed at 09:00", "on the 15th of every month at 09:00", "once on 2026-10-26 at 09:00". */
export function cadenceOf(s: Pick<Schedule, 'recurrence' | 'startDate' | 'weekdays' | 'dayOfMonth' | 'time'>): string {
  switch (s.recurrence) {
    case 'once': return `once on ${s.startDate} at ${s.time}`
    case 'hourly': return `every hour at :${s.time.slice(3)}`
    case 'daily': return `every day at ${s.time}`
    case 'weekly': return s.weekdays.length === 7 ? `every day at ${s.time}` : `every ${weekdaysText(s.weekdays)} at ${s.time}`
    case 'monthly': return `on the ${ordinal(s.dayOfMonth ?? 1)} of every month at ${s.time}${(s.dayOfMonth ?? 1) > 28 ? ' (the last day in shorter months)' : ''}`
  }
}

const scheduleSpec: RefSpec<Schedule> = {
  id: (s) => s.id,
  names: (s) => [s.templateName],
  describe: (s) => `${s.templateName} (${s.recurrence}, id ${s.id})`
}

// ---- rows ----

const ACTIVE: Occurrence['state'][] = ['starting', 'running']

function scheduleRow(snapshot: AppSnapshot, s: Schedule): ScheduleRow {
  const runs = snapshot.occurrences.filter((o) => o.scheduleId === s.id)
  const last = [...runs].reverse().find((o) => !ACTIVE.includes(o.state))
  const next = s.nextRunAt ? formatRun(Date.parse(s.nextRunAt), s.timezone) : undefined
  return {
    id: s.id,
    template: s.templateName,
    templateId: s.templateId,
    repo: snapshot.repos.find((r) => r.id === s.repoId)?.name ?? s.repoId,
    repoId: s.repoId,
    base: s.baseBranch,
    recurrence: s.recurrence,
    cadence: cadenceOf(s),
    timezone: s.timezone,
    time: s.time,
    startDate: s.startDate,
    weekdays: s.weekdays,
    ...(s.dayOfMonth !== undefined ? { dayOfMonth: s.dayOfMonth } : {}),
    model: s.model,
    maxMinutes: s.maxMinutes,
    state: s.state,
    ...(s.pausedReason ? { pausedReason: s.pausedReason } : {}),
    ...(s.pausedKind ? { pausedKind: s.pausedKind } : {}),
    ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}),
    ...(next ? { next } : {}),
    consecutiveFailures: s.consecutiveFailures,
    running: runs.filter((o) => ACTIVE.includes(o.state)).map((o) => o.id),
    ...(last ? { last: { id: last.id, state: last.state, at: last.endedAt ?? last.startedAt ?? last.plannedAt, ...(last.reason ? { reason: last.reason } : {}) } } : {})
  }
}

const short = (id: string) => id.slice(0, 8)

function occurrenceRow(snapshot: AppSnapshot, o: Occurrence): OccurrenceRow {
  const schedule = snapshot.schedules.find((s) => s.id === o.scheduleId)
  const ws = o.workspaceId ? snapshot.workspaces.find((w) => w.id === o.workspaceId) : undefined
  const prUrl = ws ? pullRequestUrl(ws) : undefined
  const pr = ws && (ws.prInfo?.number ?? ws.pullRequest?.number)
  return {
    id: o.id,
    scheduleId: o.scheduleId,
    template: schedule?.templateName ?? '(removed)',
    plannedAt: o.plannedAt,
    ...(o.startedAt ? { startedAt: o.startedAt } : {}),
    ...(o.endedAt ? { endedAt: o.endedAt } : {}),
    ...(o.startedAt && o.endedAt ? { durationMs: Date.parse(o.endedAt) - Date.parse(o.startedAt) } : {}),
    state: o.state,
    ...(o.reason ? { reason: o.reason } : {}),
    ...(ws ? { workspace: { id: ws.id, name: ws.name } } : {}),
    ...(pr ? { pr: { number: pr, ...(prUrl ? { url: prUrl } : {}) } } : {})
  }
}

// ---- a request from what was typed ----

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** `mon`, `Wednesday`, `3`, `weekdays`, `weekends`, `every` → weekday numbers (0 is Sunday). */
export function parseWeekdays(words: string[]): number[] {
  const out = new Set<number>()
  for (const raw of words.flatMap((w) => w.split(/[,\s]+/)).filter(Boolean)) {
    const w = raw.toLowerCase()
    if (w === 'weekdays') [1, 2, 3, 4, 5].forEach((d) => out.add(d))
    else if (w === 'weekends') [0, 6].forEach((d) => out.add(d))
    else if (w === 'every' || w === 'all' || w === 'daily') [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d))
    else if (/^[0-6]$/.test(w)) out.add(Number(w))
    else if (w.length >= 3 && w.slice(0, 3) in DAYS && WEEKDAY_NAMES[DAYS[w.slice(0, 3)]].toLowerCase().startsWith(w)) out.add(DAYS[w.slice(0, 3)])
    else throw invalid(`“${raw}” isn’t a weekday. Use names (mon, tue, … or monday), numbers 0 (Sunday) to 6, weekdays or weekends.`)
  }
  return [...out].sort((a, b) => a - b)
}

const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay()

/** What the dialog selects first: a Sonnet from the picker's Claude models, else the first one shown. */
function defaultModel(host: CliHost): string {
  const claude = pickerModels(modelsFor('claude'), host.state().settings.hiddenModels ?? {}).shown
  return claude.find((m) => m.id.includes('sonnet'))?.id ?? claude[0]?.id ?? ''
}

const RECURRENCES: Schedule['recurrence'][] = ['once', 'hourly', 'daily', 'weekly', 'monthly']

function fingerprintParam(raw: unknown): ScheduleFingerprint | undefined {
  if (raw === undefined || raw === null) return undefined
  const f = raw as Record<string, unknown>
  if (typeof raw !== 'object' || (['template', 'setup', 'checks', 'mcp'] as const).some((k) => typeof f[k] !== 'string')) throw invalid('shown must be the fingerprint a preview returned.')
  return { template: f.template as string, setup: f.setup as string, checks: f.checks as string, mcp: f.mcp as string }
}

interface Built {
  request: ScheduleRequest
  repo: Repo
  template: PromptTemplate
}

/**
 * The request the Schedule dialog would send for these choices, with its defaults: a Claude model from the picker, 30 minutes,
 * the repository's base branch, today in this computer's zone. Editing starts from the schedule as it is.
 */
async function buildRequest(host: CliHost, snapshot: AppSnapshot, p: Record<string, unknown>, existing?: Schedule): Promise<Built> {
  const repoQuery = textParam(p, 'repo', { optional: true })
  const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
  const repo = existing && !repoQuery?.trim() ? snapshot.repos.find((r) => r.id === existing.repoId) : await resolveRepo(snapshot, cwd, repoQuery)
  if (!repo) throw notFound('The schedule’s repository was removed; pass --repo to move it to another.')
  const personal = snapshot.settings.promptTemplates
  const fromRepo = snapshot.repoTemplates[repo.id] ?? []
  const templateQuery = textParam(p, 'template', { optional: true })
  let template: PromptTemplate | undefined
  if (templateQuery?.trim()) {
    const found = findLayeredTemplate(personal, fromRepo, templateQuery)
    if ('error' in found) throw found.error.includes('matches several') ? ambiguous(found.error) : notFound(found.error, '`foreman templates` lists them.')
    template = found.template
  } else if (existing) {
    template = [...personal, ...Object.values(snapshot.repoTemplates).flat()].find((t) => t.id === existing.templateId)
    if (!template) throw notFound(`The template “${existing.templateName}” no longer exists; pass --template to choose another.`)
  } else throw invalid('Name the template to schedule.', '`foreman templates` lists them.')
  const placeholders = templatePlaceholders(template.body)
  if (placeholders.length) throw invalid(`“${template.name}” has placeholders to fill in each time (${placeholders.map((x) => `{{${x}}}`).join(', ')}). A scheduled run can’t ask, so write them out first.`, `\`foreman templates edit ${template.name}\` changes the text, or save a copy without placeholders.`)
  if (!template.body.trim()) throw invalid(`“${template.name}” is empty.`)

  const recurrenceText = textParam(p, 'recurrence', { optional: true }) ?? existing?.recurrence
  if (!recurrenceText) throw invalid(`Say how often: ${RECURRENCES.join(', ')}.`)
  if (!(RECURRENCES as string[]).includes(recurrenceText)) throw invalid(`“${recurrenceText}” isn’t a cadence. Use ${RECURRENCES.join(', ')}.`)
  const recurrence = recurrenceText as Schedule['recurrence']
  const timezone = textParam(p, 'tz', { optional: true }) ?? existing?.timezone ?? localZone()
  const startGiven = textParam(p, 'start', { optional: true })
  const startDate = startGiven ?? (existing && existing.state !== 'finished' ? existing.startDate : dateInZone(Date.now(), validTimezone(timezone) ? timezone : 'UTC'))
  const atText = textParam(p, 'at', { optional: true }) ?? existing?.time
  if (!atText) throw invalid('Say the time of day: --at HH:MM.')
  const at = parseTime(atText)
  if (!at) throw invalid(`“${atText}” isn’t a time. Use HH:MM, 24 hour.`)
  const time = `${String(at.h).padStart(2, '0')}:${String(at.min).padStart(2, '0')}`
  const on = textList(p, 'on', { optional: true })
  const startDay = parseDate(startDate)
  const weekdays = on ? parseWeekdays(on) : recurrence === 'weekly' && existing?.weekdays.length ? existing.weekdays : startDay ? [weekdayOf(startDate)] : existing?.weekdays ?? []
  const dayGiven = numberParam(p, 'dayOfMonth')
  if (dayGiven !== undefined && (!Number.isInteger(dayGiven) || dayGiven < 1 || dayGiven > 31)) throw invalid('The day of the month is 1 to 31.')
  const dayOfMonth = dayGiven ?? existing?.dayOfMonth ?? startDay?.d
  const maxMinutes = numberParam(p, 'maxMinutes') ?? existing?.maxMinutes ?? DEFAULT_MAX_MINUTES
  const modelGiven = textParam(p, 'model', { optional: true })
  const modelWanted = modelGiven ?? existing?.model ?? defaultModel(host)
  if (!modelWanted) throw invalid('Foreman has no Claude model to offer yet; pass --model.', '`foreman models refresh claude`')
  // A Claude model Foreman can name; an unchanged saved one stays as it is, even if the list moved on.
  const model = modelGiven === undefined && existing ? existing.model : resolveLoadout(host, { agent: 'claude', model: modelWanted }).loadout.model

  const request: ScheduleRequest = {
    templateId: template.id,
    templateName: template.name,
    repoId: repo.id,
    baseBranch: (textParam(p, 'base', { optional: true }) ?? existing?.baseBranch ?? repo.defaultBranch ?? 'main').trim(),
    recurrence,
    startDate,
    weekdays,
    ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
    time,
    timezone,
    agent: 'claude',
    model,
    maxMinutes,
    // Not set from the command line yet: an edit keeps what the Schedule dialog chose.
    ...(existing?.afterRun ? { afterRun: existing.afterRun, afterRunDeleteBranch: existing.afterRunDeleteBranch } : {})
  }
  const problem = scheduleProblem(request)
  if (problem) throw invalid(problem)
  return { request, repo, template }
}

async function previewOf(host: CliHost, request: ScheduleRequest): Promise<SchedulePreviewResult> {
  return previewFrom(request, await host.api.scheduleFingerprint(request))
}

function previewFrom(request: ScheduleRequest, view: ScheduleFingerprintView): SchedulePreviewResult {
  const spec = { recurrence: request.recurrence, startDate: request.startDate, weekdays: request.weekdays, dayOfMonth: request.dayOfMonth, time: request.time, timezone: request.timezone }
  const nextRuns = previewRuns(spec, Date.now(), 3).map((r) => r.label)
  const cadence = `${cadenceOf(request as Pick<Schedule, 'recurrence' | 'startDate' | 'weekdays' | 'dayOfMonth' | 'time'>)} (${request.timezone})`
  const s = view.summary
  const setup = s.setupScript.trim() ? firstLine(s.setupScript, 100) + (s.setupScript.trim().includes('\n') ? ' …' : '') : '(none)'
  const lines = [
    `Schedule “${s.templateName}”${s.templateRev ? ` (template revision ${s.templateRev.slice(0, 7)})` : ''}${s.templateSource === 'repo' ? ', a repository template' : ''}`,
    `Repository: ${s.repoName}, each run starts from ${s.baseBranch} in a fresh workspace`,
    `Runs ${cadence}${request.recurrence === 'once' ? '' : `, from ${request.startDate}`}`,
    `Next: ${nextRuns.join('; ') || '(none)'}`,
    `Runs on: Claude · ${request.model}, permission mode auto; a question or an approval stops the run and leaves it for you`,
    `Limit: ${request.maxMinutes} minutes per run`,
    `Setup script: ${setup}`,
    `Checks: ${s.checks.length ? s.checks.map((c) => `${c.name} (${firstLine(c.command, 60)})`).join(', ') : '(none)'}`,
    `Repository MCP servers: ${s.mcpServers.length ? s.mcpServers.join(', ') : '(none)'}`,
    ...(s.integrations.length ? [`Integrations: ${s.integrations.join('; ')}`] : []),
    'Runs only while Foreman is open. A run that is late is skipped, never replayed; two failed runs in a row pause the schedule; a change to the template, setup, checks or MCP servers pauses it until you approve again.'
  ]
  return { request, fingerprint: view.fingerprint, summary: s, cadence, nextRuns, text: lines.join('\n') }
}

// ---- the methods ----

const list: MethodDef = {
  tier: 'read',
  async handle(host): Promise<SchedulesListResult> {
    const snapshot = host.snapshot()
    const rows = snapshot.schedules.map((s) => scheduleRow(snapshot, s))
    if (!rows.length) return { schedules: rows, text: 'No schedules. `foreman schedules add <template> --every …` makes one.' }
    const when = (r: ScheduleRow) => (r.running.length ? 'running now' : r.state === 'paused' ? `paused: ${firstLine(r.pausedReason ?? '', 70)}` : r.state === 'finished' ? 'finished' : `next ${r.next ?? ''}`)
    const lines = columns([['ID', 'TEMPLATE', 'REPO', 'CADENCE', 'STATE'], ...rows.map((r) => [short(r.id), r.template, r.repo, `${r.cadence} (${r.timezone})`, when(r)])])
    return { schedules: rows, text: lines.join('\n') }
  }
}

const preview: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<SchedulePreviewResult> {
    const p = paramsObject(params)
    return previewOf(host, (await buildRequest(host, host.snapshot(), p)).request)
  }
}

async function save(host: CliHost, p: Record<string, unknown>, existing: Schedule | undefined, snapshot: AppSnapshot): Promise<SchedulesSaveResult> {
  const built = await buildRequest(host, snapshot, p, existing)
  const shown = fingerprintParam(p.shown)
  if (!shown) {
    const pre = await previewOf(host, built.request)
    return { saved: false, needsConfirmation: true, preview: pre, text: `${pre.text}\n\nNothing is saved yet. Approve it with the fingerprint above (\`--yes\`).` }
  }
  const saved = await host.api.saveSchedule(built.request, existing?.id, shown)
  const after = host.snapshot()
  const row = scheduleRow({ ...after, schedules: after.schedules.some((s) => s.id === saved.id) ? after.schedules : [...after.schedules, saved] }, saved)
  return { saved: true, schedule: row, text: `${existing ? 'Saved' : 'Scheduled'} “${row.template}” in ${row.repo}: ${row.cadence} (${row.timezone}).${row.next ? ` Next run: ${row.next}.` : ''} Runs only while Foreman is open.` }
}

const add: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SchedulesSaveResult> {
    return save(host, paramsObject(params), undefined, host.snapshot())
  }
}

const edit: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SchedulesSaveResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const existing = findByRef(snapshot.schedules, textParam(p, 'id'), 'schedule', scheduleSpec)
    return save(host, p, existing, snapshot)
  }
}

/** The request a saved schedule stands for, to ask what it would approve now. */
function requestOf(s: Schedule): ScheduleRequest {
  return { templateId: s.templateId, templateName: s.templateName, repoId: s.repoId, baseBranch: s.baseBranch, recurrence: s.recurrence, startDate: s.startDate, weekdays: s.weekdays, ...(s.dayOfMonth !== undefined ? { dayOfMonth: s.dayOfMonth } : {}), time: s.time, timezone: s.timezone, agent: 'claude', model: s.model, maxMinutes: s.maxMinutes, ...(s.afterRun ? { afterRun: s.afterRun, afterRunDeleteBranch: s.afterRunDeleteBranch } : {}) }
}

const approve: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SchedulesApproveResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const s = findByRef(snapshot.schedules, textParam(p, 'id'), 'schedule', scheduleSpec)
    const shown = fingerprintParam(p.shown)
    if (!shown) {
      // What the schedule would run now, against what it was approved on.
      const now = await host.api.scheduleFingerprint(requestOf(s))
      const changed = changedParts(s.approved, now.fingerprint)
      const preview = previewFrom(requestOf(s), now)
      return {
        approved: false,
        needsConfirmation: true,
        changed,
        preview,
        text: `${changed.length ? `Since you approved “${s.templateName}”, ${changed.join(' and ')} changed.` : `Nothing has changed since you approved “${s.templateName}”.`}${s.pausedReason ? ` ${s.pausedReason}` : ''}\n\n${preview.text}\n\nNothing is approved yet. Approve it with the fingerprint above (\`--yes\`).`
      }
    }
    await host.api.approveSchedule(s.id, shown)
    const after = host.snapshot()
    const row = scheduleRow(after, after.schedules.find((x) => x.id === s.id) ?? s)
    return { approved: true, changed: [], schedule: row, text: `Approved “${row.template}”. ${row.next ? `Next run: ${row.next}.` : ''}`.trim() }
  }
}

function lifecycle(verb: 'pause' | 'resume' | 'remove'): MethodDef {
  return {
    tier: 'admin',
    async handle(host, params): Promise<SchedulesChangeResult | SchedulesRemoveResult> {
      const p = paramsObject(params)
      const snapshot = host.snapshot()
      const s = findByRef(snapshot.schedules, textParam(p, 'id'), 'schedule', scheduleSpec)
      if (verb === 'pause') await host.api.pauseSchedule(s.id)
      else if (verb === 'resume') await host.api.resumeSchedule(s.id)
      else {
        const running = snapshot.occurrences.filter((o) => o.scheduleId === s.id && ACTIVE.includes(o.state))
        if (running.length) throw refused(`“${s.templateName}” has a run going. Stop it first: \`foreman schedules stop-run ${short(running[0].id)}\`.`)
        await host.api.deleteSchedule(s.id)
        return { removed: scheduleRow(snapshot, s), text: `Removed the schedule “${s.templateName}” and its run history.` }
      }
      const after = host.snapshot()
      const row = scheduleRow(after, after.schedules.find((x) => x.id === s.id) ?? s)
      return { schedule: row, text: verb === 'pause' ? `Paused “${row.template}”.` : `Resumed “${row.template}”.${row.next ? ` Next run: ${row.next}.` : ''}` }
    }
  }
}

const runs: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<SchedulesRunsResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const id = textParam(p, 'id', { optional: true })
    const only = id?.trim() ? findByRef(snapshot.schedules, id, 'schedule', scheduleSpec) : undefined
    const limit = numberParam(p, 'limit') ?? 20
    if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a whole number, 1 or more.')
    const rows = snapshot.occurrences
      .filter((o) => !only || o.scheduleId === only.id)
      .slice(-limit)
      .reverse()
      .map((o) => occurrenceRow(snapshot, o))
    if (!rows.length) return { runs: rows, text: only ? `“${only.templateName}” hasn’t run yet.` : 'No scheduled runs yet.' }
    const zone = (r: OccurrenceRow) => snapshot.schedules.find((s) => s.id === r.scheduleId)?.timezone ?? 'UTC'
    const lines = columns([['RUN', 'TEMPLATE', 'STARTED', 'OUTCOME', 'TOOK', 'WORKSPACE', 'PR'], ...rows.map((r) => [short(r.id), r.template, formatRun(Date.parse(r.startedAt ?? r.plannedAt), zone(r)), `${r.state}${r.reason && r.state !== 'completed' ? `: ${firstLine(r.reason, 50)}` : ''}`, r.durationMs !== undefined ? durationText(r.durationMs) : '', r.workspace?.name ?? '', r.pr ? `#${r.pr.number}` : ''])])
    return { runs: rows, text: lines.join('\n') }
  }
}

const stopRun: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<SchedulesStopRunResult> {
    const p = paramsObject(params)
    const snapshot = host.snapshot()
    const o = findByRef(snapshot.occurrences, textParam(p, 'occurrence'), 'scheduled run', { id: (x) => x.id, names: (x) => [x.id], describe: (x) => `${x.state}, id ${x.id}` })
    if (!ACTIVE.includes(o.state)) throw refused(`That run isn’t going (it ${o.state === 'completed' ? 'completed' : `is ${o.state}`}).`)
    await host.api.stopScheduledRun(o.id)
    return { occurrence: o.id, text: `Stopping the run of “${snapshot.schedules.find((s) => s.id === o.scheduleId)?.templateName ?? 'the schedule'}”; it ends as stopped.` }
  }
}

export const SCHEDULES_METHODS: Record<string, MethodDef> = {
  'schedules-list': list,
  'schedules-preview': preview,
  'schedules-add': add,
  'schedules-edit': edit,
  'schedules-approve': approve,
  'schedules-pause': lifecycle('pause'),
  'schedules-resume': lifecycle('resume'),
  'schedules-remove': lifecycle('remove'),
  'schedules-runs': runs,
  'schedules-stop-run': stopRun
}

