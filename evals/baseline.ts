// evals/baseline.json: what each case scored the last time someone recorded a baseline, and with which model. Pure.
import type { CaseResult, Rate } from './runner'

export interface BaselineRate {
  passed: number
  runs: number
}

export interface BaselineEntry {
  /** Null when the case has no earlier text. */
  before: BaselineRate | null
  after: BaselineRate
  /** Both controls together. */
  control: BaselineRate
}

export interface Baseline {
  version: 1
  /** The model the numbers were measured with; null while nothing has been recorded. */
  model: string | null
  updated: string | null
  cases: Record<string, BaselineEntry>
}

export const EMPTY_BASELINE: Baseline = { version: 1, model: null, updated: null, cases: {} }

export function parseBaseline(text: string): Baseline {
  const value = JSON.parse(text) as Partial<Baseline>
  if (value.version !== 1 || typeof value.cases !== 'object' || value.cases === null) throw new Error('evals/baseline.json is not a version 1 baseline.')
  return { version: 1, model: value.model ?? null, updated: value.updated ?? null, cases: value.cases as Record<string, BaselineEntry> }
}

export function serializeBaseline(baseline: Baseline): string {
  const cases = Object.fromEntries(Object.entries(baseline.cases).sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify({ ...baseline, cases }, null, 2)}\n`
}

const rateOf = (r: Rate): BaselineRate => ({ passed: r.passed, runs: r.runs })
const sum = (a: Rate, b: Rate | null): BaselineRate => ({ passed: a.passed + (b?.passed ?? 0), runs: a.runs + (b?.runs ?? 0) })

/** What a case's result becomes in the baseline. */
export function entryOf(result: CaseResult): BaselineEntry {
  return { before: result.before.kind === 'rate' ? rateOf(result.before.rate) : null, after: rateOf(result.after), control: sum(result.controlAfter, result.controlBefore) }
}

export type Movement = 'new' | 'same' | 'better' | 'worse'

export interface Comparison {
  id: string
  /** How the after rate moved against the baseline's. */
  after: Movement
  /** The control moved against the baseline's: a control that got worse means the check or the model changed, not the text. */
  control: Movement
  baselineAfter?: BaselineRate
}

const fraction = (r: BaselineRate) => (r.runs ? r.passed / r.runs : 0)

function move(now: BaselineRate, then: BaselineRate | undefined): Movement {
  if (!then) return 'new'
  const a = fraction(now)
  const b = fraction(then)
  return a > b + 1e-9 ? 'better' : a < b - 1e-9 ? 'worse' : 'same'
}

export interface Compared {
  /** Why nothing was compared (another model, no baseline yet), or null. */
  skipped: string | null
  comparisons: Comparison[]
  /** Any case whose after rate got worse. */
  regressed: boolean
}

/** Each result against the baseline. Not compared across models: another model's numbers say nothing about this one's. */
export function compare(baseline: Baseline, model: string, results: CaseResult[]): Compared {
  if (baseline.model === null || !Object.keys(baseline.cases).length) {
    return { skipped: 'no baseline recorded yet (run every case with the model to use, then --update-baseline)', comparisons: [], regressed: false }
  }
  if (baseline.model !== model) {
    return { skipped: `the baseline is for ${baseline.model} and this run used ${model}: not compared`, comparisons: [], regressed: false }
  }
  const comparisons = results.map((r): Comparison => {
    const entry = baseline.cases[r.id]
    const now = entryOf(r)
    return { id: r.id, after: move(now.after, entry?.after), control: move(now.control, entry?.control), ...(entry ? { baselineAfter: entry.after } : {}) }
  })
  return { skipped: null, comparisons, regressed: comparisons.some((c) => c.after === 'worse') }
}

/**
 * The baseline after `--update-baseline`. A run that is not clean (a failed run, a failed control) or that used another model
 * on only some cases never writes: a baseline mixing models, or holding numbers that measured nothing, is worse than none.
 */
export function updateBaseline(
  existing: Baseline,
  results: CaseResult[],
  options: { model: string; date: string; allCases: boolean }
): { baseline: Baseline } | { refused: string } {
  const unclean = results.filter((r) => r.status === 'error' || r.status === 'control-failed')
  if (unclean.length) return { refused: `not recording: ${unclean.map((r) => `${r.id} (${r.status})`).join(', ')}` }
  const sameModel = existing.model === options.model
  if (!sameModel && existing.model !== null && Object.keys(existing.cases).length && !options.allCases) {
    return { refused: `the baseline is for ${existing.model}; to record ${options.model} run every case, so the file never mixes models` }
  }
  const cases = sameModel || existing.model === null ? { ...existing.cases } : {}
  for (const r of results) cases[r.id] = entryOf(r)
  return { baseline: { version: 1, model: options.model, updated: options.date, cases } }
}
