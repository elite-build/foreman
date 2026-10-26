// Setup as ordered steps (O19): the pure parts shared by main and the renderer.
// A layer that stores one setup script (older state, `setup = "…"` in a
// settings.toml) has one step called Setup, so existing setups run as before.
import { createT, type TFunction } from './i18n'
import type { RepoSettingsPatch, SetupRun, SetupStep, SetupStepResult } from './types'

const enT = createT('en')

/** The name a single setup script gets as a step. */
export const SINGLE_STEP_NAME = 'Setup'
/** G3: the archive script as steps (same schema as setup); a single archive script is one step called Archive. */
export const SINGLE_ARCHIVE_STEP_NAME = 'Archive'

export type StepsKind = 'setup' | 'archive'
const SINGLE: Record<StepsKind, string> = { setup: SINGLE_STEP_NAME, archive: SINGLE_ARCHIVE_STEP_NAME }

/** One setup (or archive) script as steps: none when it's empty. */
export function scriptAsSteps(script: string, kind: StepsKind = 'setup'): SetupStep[] {
  return script.trim() ? [{ name: SINGLE[kind], command: script }] : []
}

/**
 * G3: the steps as groups of indexes, in order. Consecutive steps marked `parallel` form one group that
 * runs at the same time; every other step is a group of its own. The next group waits for the whole group.
 */
export function stepGroups(steps: Pick<SetupStep, 'parallel'>[]): number[][] {
  const groups: number[][] = []
  steps.forEach((step, i) => {
    const last = groups.at(-1)
    if (step.parallel && last && steps[last[0]].parallel) last.push(i)
    else groups.push([i])
  })
  return groups
}

/** The steps' commands, one per line: what "is there a setup" checks and schedule fingerprints look at. */
export function stepsScript(steps: SetupStep[]): string {
  return steps.map((s) => s.command).join('\n')
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600 }

/**
 * A step timeout as written in settings.toml, in seconds: a number of seconds, or
 * "90s", "10m", "10 min", "1h". 0, "none", "no limit" or anything unreadable is no limit.
 */
export function parseTimeout(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  if (typeof value !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value)
  if (!m) return undefined
  const unit = m[2].toLowerCase()
  const factor = unit ? UNITS[unit] : 1
  const seconds = factor ? Math.round(Number(m[1]) * factor) : 0
  return seconds > 0 ? seconds : undefined
}

/** Steps with a command, each named (Step 2 when the name is blank) and with a positive whole timeout or none. */
export function cleanSteps(steps: SetupStep[]): SetupStep[] {
  return steps
    .filter((s) => s.command.trim())
    .map((s, i) => {
      const step: SetupStep = { name: s.name.trim() || `Step ${i + 1}`, command: s.command.replace(/\s+$/, '') }
      const timeout = parseTimeout(s.timeoutSec)
      if (timeout) step.timeoutSec = timeout
      if (s.parallel) step.parallel = true
      return step
    })
}

export function sameSteps(a: SetupStep[], b: SetupStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.name === b[i].name && s.command === b[i].command && (s.timeoutSec ?? 0) === (b[i].timeoutSec ?? 0) && Boolean(s.parallel) === Boolean(b[i].parallel))
}

/**
 * The patch that stores `steps` on this computer. One step called Setup with no
 * limit is stored as a plain setup script, as before, so older versions still run it.
 */
export function stepsPatch(steps: SetupStep[], kind: StepsKind = 'setup'): RepoSettingsPatch {
  const clean = cleanSteps(steps)
  const [script, list] = kind === 'archive' ? (['archiveScript', 'archiveSteps'] as const) : (['setupScript', 'setupSteps'] as const)
  if (clean.length === 1 && clean[0].name === SINGLE[kind] && !clean[0].timeoutSec) return { [script]: clean[0].command, [list]: null }
  if (!clean.length) return { [script]: '', [list]: null }
  return { [list]: clean, [script]: null }
}

/** A fresh result for each step, nothing run yet. */
export function pendingResults(steps: SetupStep[]): SetupStepResult[] {
  return steps.map((s) => ({ name: s.name, command: s.command, ...(s.timeoutSec ? { timeoutSec: s.timeoutSec } : {}), ...(s.parallel ? { parallel: true } : {}), status: 'pending' }))
}

const PASSED = (r: SetupStepResult) => r.status === 'done'

/**
 * Where Retry failed step carries on: the first step of the last run that didn't pass,
 * as long as it and the steps before it are still the ones configured (same name and
 * command). -1 when there is nothing to carry on from, so setup runs from the top.
 */
export function resumeIndex(run: SetupRun | undefined, steps: SetupStep[]): number {
  if (!run) return -1
  const at = run.steps.findIndex((r) => !PASSED(r))
  if (at < 0 || at >= steps.length) return -1
  for (let i = 0; i <= at; i++) {
    if (run.steps[i].name !== steps[i].name || run.steps[i].command !== steps[i].command) return -1
  }
  return at
}

/** A step that ended the run without passing: failed, timed out or stopped. */
export function failedStep(run: SetupRun | undefined): number {
  return run ? run.steps.findIndex((r) => r.status === 'failed' || r.status === 'timed-out' || r.status === 'stopped') : -1
}

/** The step running now, for the sidebar ("Seed DB, step 2 of 3") and the header pill. */
export function runningStep(run: SetupRun | undefined): { name: string; index: number; total: number } | undefined {
  const index = run ? run.steps.findIndex((r) => r.status === 'running') : -1
  return index >= 0 ? { name: run!.steps[index].name, index, total: run!.steps.length } : undefined
}

/** A stopwatch: 0:31, 2:00, 1:02:03. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** How long a finished step took: 48s, 2m 05s, 1h 02m. */
export function duration(ms: number, t: TFunction = enT): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return t('duration.seconds', { s: total })
  const m = Math.floor(total / 60)
  if (m < 60) return t('duration.minutes', { m, s: String(total % 60).padStart(2, '0') })
  return t('duration.hours', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
}
