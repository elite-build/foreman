// The command line of `npm run evals`: its arguments and its report. Pure.
import { compare, type Baseline, type Compared } from './baseline'
import { totalCost, type CaseResult, type Rate, type Status } from './runner'

/** The model the baseline is meant for. Cheaper models are for proving the harness works, not for baselines. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

export interface Args {
  cases: string[]
  model: string
  runs?: number
  updateBaseline: boolean
  list: boolean
  help: boolean
}

export const USAGE = `npm run evals -- [case...] [--model <id>] [--runs <n>] [--update-baseline] [--list]

  case               case ids to run (default: all); see --list
  --model <id>       the model to run (default ${DEFAULT_MODEL})
  --runs <n>         runs per scenario and variant (default: each case's own, 3)
  --update-baseline  record this run in evals/baseline.json, for the model named in the file
  --list             list the cases and exit

Runs real models and costs real money. Never run by npm test or in CI.`

/** Parses `argv` (what follows `npm run evals --`). Throws a sentence a person can act on. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { cases: [], model: DEFAULT_MODEL, updateBaseline: false, list: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (name: string): string => {
      const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined
      const given = inline ?? argv[++i]
      if (!given || given.startsWith('--')) throw new Error(`${name} needs a value.`)
      return given
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--list') args.list = true
    else if (arg === '--update-baseline') args.updateBaseline = true
    else if (arg === '--model' || arg.startsWith('--model=')) args.model = value('--model')
    else if (arg === '--runs' || arg.startsWith('--runs=')) {
      const text = value('--runs')
      const n = Number(text)
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`--runs must be a whole number from 1 to 20, not “${text}”.`)
      args.runs = n
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.\n\n${USAGE}`)
    else args.cases.push(arg)
  }
  return args
}

/** The cases named, in the list's order. Throws for an id that isn't one. */
export function selectCases<T extends { id: string }>(all: readonly T[], names: string[]): T[] {
  const unknown = names.filter((n) => !all.some((c) => c.id === n))
  if (unknown.length) throw new Error(`No such case: ${unknown.join(', ')}. The cases are ${all.map((c) => c.id).join(', ')}.`)
  return names.length ? all.filter((c) => names.includes(c.id)) : [...all]
}

const rate = (r: Rate | null) => (r ? `${r.passed}/${r.runs}` : '-')
const STATUS_WORD: Record<Status, string> = {
  ok: 'ok',
  'no-before': 'no before',
  'not-discriminating': 'before passes (does not discriminate)',
  'control-failed': 'CONTROL FAILED',
  error: 'RUN ERROR'
}

const MOVEMENT_WORD = { new: 'new', same: 'same', better: 'better', worse: 'WORSE' } as const

/** The table and what to read from it. */
export function formatReport(results: CaseResult[], options: { model: string; baseline: Baseline; costUsd?: number }): string {
  const compared: Compared = compare(options.baseline, options.model, results)
  const rows = results.map((r) => {
    const c = compared.comparisons.find((x) => x.id === r.id)
    const control = r.controlBefore ? `${rate(r.controlBefore)} / ${rate(r.controlAfter)}` : rate(r.controlAfter)
    return [r.id, r.before.kind === 'rate' ? rate(r.before.rate) : 'no before', rate(r.after), control, STATUS_WORD[r.status], c ? `${MOVEMENT_WORD[c.after]}${c.baselineAfter ? ` (was ${c.baselineAfter.passed}/${c.baselineAfter.runs})` : ''}` : '-']
  })
  const header = ['case', 'before', 'after', 'control (before / after)', 'status', 'vs baseline']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
  const out = [`Model ${options.model}`, '', line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '']
  for (const r of results) {
    const lines: string[] = []
    if (r.before.kind === 'none') lines.push(`  no before: ${r.before.why}`)
    else for (const why of r.before.rate.failures.slice(0, 2)) lines.push(`  before failed: ${why}`)
    for (const why of r.after.failures.slice(0, 3)) lines.push(`  AFTER FAILED: ${why}`)
    for (const [name, c] of [['control (before)', r.controlBefore], ['control (after)', r.controlAfter]] as const) for (const why of c?.failures.slice(0, 2) ?? []) lines.push(`  ${name} failed: ${why}`)
    if (r.status === 'not-discriminating') lines.push('  the old text passed every probe: this case does not show what the fix did; sharpen the probe or drop the case.')
    if (lines.length) out.push(`${r.id}`, ...lines, '')
  }
  out.push(compared.skipped ? `Baseline: ${compared.skipped}.` : compared.regressed ? 'Baseline: REGRESSED, a case passes less often than in evals/baseline.json.' : 'Baseline: nothing got worse.')
  out.push(`Cost: about $${(options.costUsd ?? totalCost(results)).toFixed(4)}`)
  return out.join('\n')
}

/** Whether the run should make the process fail: a regression, a failed control or a run that could not be made. */
export function failed(results: CaseResult[], baseline: Baseline, model: string): boolean {
  return compare(baseline, model, results).regressed || results.some((r) => r.status === 'error' || r.status === 'control-failed')
}
