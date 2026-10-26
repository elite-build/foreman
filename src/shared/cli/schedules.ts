// Parameters and results of the schedule methods.
// Each result has a `text` the command prints unless --json is given.
import type { Schedule, ScheduleFingerprint, ScheduleRequest, ScheduleSummary } from '../types'

/** The cadence and limits of a schedule, as the command line says them. Anything left out takes the Schedule dialog's default. */
export interface ScheduleSpecParams {
  recurrence: Schedule['recurrence']
  // Weekly: the days, as names (`mon`, `wed`, `weekdays`) or numbers (0 is Sunday). Default: the start date's weekday.
  on?: string[]
  // Monthly: the day of the month, 1 to 31. Default: the start date's day.
  dayOfMonth?: number
  // HH:MM, 24 hour, in the time zone.
  at: string
  // An IANA zone (Europe/London). Default: this computer's.
  tz?: string
  // The first eligible date, YYYY-MM-DD in the zone. Default: today there.
  start?: string
  // The branch each run starts from. Default: the repository's.
  base?: string
  // A Claude model id. Default: the dialog's (Sonnet when listed).
  model?: string
  // 5 to 480. Default: 30.
  maxMinutes?: number
}

export interface SchedulesPreviewParams extends ScheduleSpecParams {
  // Slug, name, id or `repo:<slug>`.
  template: string
  // Repository name, id or folder; otherwise the one the command ran in.
  repo?: string
  cwd: string
}

export interface SchedulesAddParams extends SchedulesPreviewParams {
  // The fingerprint the user was shown (the preview's `fingerprint`). Without it nothing is saved and the preview comes back.
  shown?: ScheduleFingerprint
}

export interface SchedulesEditParams extends Partial<ScheduleSpecParams> {
  // A schedule's id (the start of it, four characters or more) or its template's name.
  id: string
  cwd: string
  template?: string
  repo?: string
  shown?: ScheduleFingerprint
}

export interface SchedulePreviewResult {
  // What would be saved.
  request: ScheduleRequest
  // Send this back as `shown` to approve exactly what the preview described.
  fingerprint: ScheduleFingerprint
  summary: ScheduleSummary
  // "every day at 09:00 (Europe/London)".
  cadence: string
  // The next runs, as the zone's wall clock says them.
  nextRuns: string[]
  text: string
}

export interface SchedulesSaveResult {
  saved: boolean
  // The preview is all there is: nothing was saved because nothing was shown yet.
  needsConfirmation?: boolean
  schedule?: ScheduleRow
  preview?: SchedulePreviewResult
  text: string
}

export interface ScheduleRow {
  id: string
  template: string
  templateId: string
  repo: string
  repoId: string
  base: string
  recurrence: Schedule['recurrence']
  cadence: string
  timezone: string
  time: string
  startDate: string
  weekdays: number[]
  dayOfMonth?: number
  model: string
  maxMinutes: number
  state: Schedule['state']
  pausedReason?: string
  pausedKind?: Schedule['pausedKind']
  // ISO (UTC) and as the schedule's zone says it.
  nextRunAt?: string
  next?: string
  consecutiveFailures: number
  // Runs in flight (occurrence ids).
  running: string[]
  last?: { id: string; state: string; at: string; reason?: string }
}

export interface SchedulesListResult {
  schedules: ScheduleRow[]
  text: string
}

export interface ScheduleIdParams {
  id: string
}

export interface SchedulesApproveParams {
  id: string
  // The fingerprint the user was shown. Without it the answer is what changed, and nothing is approved.
  shown?: ScheduleFingerprint
}

export interface SchedulesApproveResult {
  approved: boolean
  needsConfirmation?: boolean
  // What differs from what was approved before, in words ("the template").
  changed: string[]
  schedule?: ScheduleRow
  preview?: SchedulePreviewResult
  text: string
}

export interface SchedulesChangeResult {
  schedule: ScheduleRow
  text: string
}

export interface SchedulesRemoveResult {
  removed: ScheduleRow
  text: string
}

export interface SchedulesRunsParams {
  // One schedule (id or template name); default: all.
  id?: string
  // The newest first; default 20.
  limit?: number
}

export interface OccurrenceRow {
  id: string
  scheduleId: string
  template: string
  plannedAt: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  state: string
  reason?: string
  workspace?: { id: string; name: string }
  pr?: { number: number; url?: string }
}

export interface SchedulesRunsResult {
  runs: OccurrenceRow[]
  text: string
}

export interface SchedulesStopRunParams {
  // An occurrence id (the start of it, four characters or more).
  occurrence: string
}

export interface SchedulesStopRunResult {
  occurrence: string
  text: string
}
