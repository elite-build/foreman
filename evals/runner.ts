// Runs cases against a model and sums what came back. The model call is passed in, so everything here is testable without one.
import type { AnyCase, RunOutput, RunSpec, Scenario } from './types'
import { DEFAULT_RUNS } from './types'

export type RunModel = (spec: RunSpec, options: { model: string }) => Promise<RunOutput>

export interface Rate {
  passed: number
  runs: number
  /** Runs that failed to run at all (sign-in, network): counted as not passed, and the result is marked `error`. */
  errors: number
  /** One reason per run that did not pass. */
  failures: string[]
  costUsd: number
}

export type BeforeResult = { kind: 'none'; why: string } | { kind: 'rate'; rate: Rate; ref: string }

/**
 * `ok`: the old text failed the probe, the new passes, and both pass the control. `no-before`: no earlier text, so only
 * the new text was measured. `not-discriminating`: the old text passed every probe, so the case doesn't show what the fix
 * did and should be sharpened or dropped. `control-failed`: a control failed on some text, so the check or the setup is
 * wrong and the probe numbers mean nothing. `error`: a run could not be made.
 */
export type Status = 'ok' | 'no-before' | 'not-discriminating' | 'control-failed' | 'error'

export interface CaseResult {
  id: string
  title: string
  before: BeforeResult
  after: Rate
  /** The control on the old text; null where there is none. */
  controlBefore: Rate | null
  controlAfter: Rate
  status: Status
}

export interface RunOptions {
  model: string
  /** Runs per scenario and variant; a case's own `runs` when not given. */
  runs?: number
  /** Model calls in flight at once. */
  concurrency?: number
  onRun?: (done: number, total: number) => void
}

interface Job {
  caseIndex: number
  slot: 'before' | 'after' | 'controlBefore' | 'controlAfter'
}

const emptyRate = (): Rate => ({ passed: 0, runs: 0, errors: 0, failures: [], costUsd: 0 })

/** One run of one variant: the verdict, never a throw. */
export async function runOnce(c: AnyCase, variant: unknown, scenario: Scenario, run: RunModel, model: string): Promise<{ pass: boolean; reason: string; costUsd: number; error: boolean }> {
  let output: RunOutput
  try {
    output = await run(c.build(variant, scenario), { model })
  } catch (err) {
    return { pass: false, reason: `run failed: ${err instanceof Error ? err.message : String(err)}`, costUsd: 0, error: true }
  }
  if (output.error) return { pass: false, reason: `run failed: ${output.error}`, costUsd: output.costUsd, error: true }
  try {
    const verdict = c.check(output, scenario)
    return { pass: verdict.pass, reason: verdict.reason, costUsd: output.costUsd, error: false }
  } catch (err) {
    return { pass: false, reason: `check threw: ${err instanceof Error ? err.message : String(err)}`, costUsd: output.costUsd, error: true }
  }
}

export function statusOf(c: Pick<CaseResult, 'before' | 'after' | 'controlBefore' | 'controlAfter'>): Status {
  const rates = [c.after, c.controlAfter, ...(c.controlBefore ? [c.controlBefore] : []), ...(c.before.kind === 'rate' ? [c.before.rate] : [])]
  if (rates.some((r) => r.errors > 0)) return 'error'
  if (c.controlAfter.passed < c.controlAfter.runs || (c.controlBefore && c.controlBefore.passed < c.controlBefore.runs)) return 'control-failed'
  if (c.before.kind === 'none') return 'no-before'
  if (c.before.rate.passed === c.before.rate.runs) return 'not-discriminating'
  return 'ok'
}

/** Every run of every case (the old text where there is one, the new, and the control on each), a few at a time. */
export async function runCases(cases: readonly AnyCase[], run: RunModel, options: RunOptions): Promise<CaseResult[]> {
  const rates = cases.map(() => ({ before: emptyRate(), after: emptyRate(), controlBefore: emptyRate(), controlAfter: emptyRate() }))
  const jobs: Job[] = []
  for (const [caseIndex, c] of cases.entries()) {
    const n = options.runs ?? c.runs ?? DEFAULT_RUNS
    const slots: Job['slot'][] = ['after', 'controlAfter', ...('none' in c.before ? [] : (['before', 'controlBefore'] as const))]
    for (const slot of slots) for (let i = 0; i < n; i++) jobs.push({ caseIndex, slot })
  }
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const c = cases[job.caseIndex]
      const variant = job.slot === 'before' || job.slot === 'controlBefore' ? ('value' in c.before ? c.before.value : undefined) : c.after
      const scenario: Scenario = job.slot.startsWith('control') ? 'control' : 'probe'
      const r = await runOnce(c, variant, scenario, run, options.model)
      const rate = rates[job.caseIndex][job.slot]
      rate.runs++
      rate.costUsd += r.costUsd
      if (r.pass) rate.passed++
      else rate.failures.push(r.reason)
      if (r.error) rate.errors++
      options.onRun?.(++done, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, jobs.length)) }, worker))
  return cases.map((c, i): CaseResult => {
    const hasBefore = !('none' in c.before)
    const result = {
      id: c.id,
      title: c.title,
      before: hasBefore ? ({ kind: 'rate', rate: rates[i].before, ref: (c.before as { ref: string }).ref } as const) : ({ kind: 'none', why: (c.before as { none: string }).none } as const),
      after: rates[i].after,
      controlBefore: hasBefore ? rates[i].controlBefore : null,
      controlAfter: rates[i].controlAfter
    }
    return { ...result, status: statusOf(result) }
  })
}

export function totalCost(results: CaseResult[]): number {
  let cost = 0
  for (const r of results) for (const rate of [r.after, r.controlAfter, r.controlBefore, r.before.kind === 'rate' ? r.before.rate : null]) cost += rate?.costUsd ?? 0
  return cost
}
