// Parameters and results of the flow methods (`foreman flow …`, docs/loops-and-graphs.md). Each result has a `text`
// the command prints unless --json is given. Type-only imports, so the command line loads nothing of the flow model.
import type { FlowFingerprint, FlowGateShow, FlowRunState, FlowRunStepState, FlowRunSummary, FlowSource, FlowStepKind } from '../flows'

export interface FlowRow {
  // 'built-in:<starter>', 'repo:<repoId>:<file>', or a personal flow's id.
  id: string
  name: string
  source: FlowSource
  starter?: string
  repo?: string
  repoId?: string
  file?: string
  // A repository file's git blob SHA; a personal flow's last save.
  rev?: string
  steps?: number
  loops?: number
  gates?: number
  personas: string[]
  // Why the file isn't a flow (nothing else is known about it then), and what is worth knowing about one that is.
  problems: string[]
  warnings: string[]
  // Why this version can't run it (steps it can't carry out yet, a turn that isn't on Claude); absent when it can.
  cantRun?: string
}

export interface FlowListParams {
  // Repository name, id or folder; otherwise the one the command ran in, else every repository's flows.
  repo?: string
  cwd: string
}

export interface FlowListResult {
  flows: FlowRow[]
  // The repository whose files are listed; absent when every repository's are.
  repo?: string
  text: string
}

export interface FlowShowParams {
  // A flow's name, id, starter id or file name.
  flow: string
  repo?: string
  cwd: string
}

export interface FlowShowResult {
  flow: FlowRow
  toml: string
  text: string
}

export interface FlowAddParams {
  // The document, as the file says it.
  toml: string
  // Saved under this name instead of the file's `name`.
  name?: string
}

export interface FlowAddResult {
  saved: boolean
  flow?: FlowRow
  // Why it wasn't saved: the flow's problems, as the editor lists them.
  problems?: string[]
  text: string
}

export interface FlowRemoveParams {
  flow: string
}

export interface FlowRemoveResult {
  removed: FlowRow
  text: string
}

export interface FlowRunParams {
  flow: string
  repo?: string
  cwd: string
  // The branch the run's workspace starts from. Default: the repository's base branch.
  base?: string
  // Values for the flow's inputs and its templates' {{placeholders}}.
  inputs?: Record<string, string>
  // Bring Foreman forward on the run's workspace once it exists.
  open?: boolean
  // The fingerprint the user was shown (the preview's `fingerprint`). Without it nothing starts and the preview comes back.
  shown?: FlowFingerprint
}

export interface FlowStepRow {
  name: string
  kind: FlowStepKind
  iteration: number
  state: FlowRunStepState
  startedAt: string
  endedAt?: string
  // The loops spanning it, with the iteration each was on.
  loops?: Record<string, number>
  // The fact that chose the next step ("failed", "continued").
  fact?: string
  detail?: string
  delta?: { files: number; additions: number; deletions: number }
  session?: string
  turn?: string
}

export interface FlowLoopRow {
  loop: string
  // Iterations and minutes used: the pass going now, else the most the run reached.
  iterations: number
  maxIterations?: number
  minutes: number
  maxMinutes?: number
}

export interface FlowRunRow {
  id: string
  flow: string
  flowId: string
  source: FlowSource
  repo: string
  repoId: string
  base: string
  state: FlowRunState
  reason?: string
  startedAt: string
  endedAt?: string
  workspace?: { id: string; name: string }
  current?: { step: string; iteration: number }
  loops: FlowLoopRow[]
  steps: FlowStepRow[]
  // The gate the run waits at, with the request id `foreman approve` takes.
  gate?: { id: string; step: string; ask: string; show: FlowGateShow[] }
}

export interface FlowRunPreviewResult {
  started: false
  needsConfirmation: true
  // Send this back as `shown` to start exactly what the preview described.
  fingerprint: FlowFingerprint
  summary: FlowRunSummary
  inputs: Record<string, string>
  text: string
}

export interface FlowRunStartedResult {
  started: true
  run: FlowRunRow
  // The first step's chat and turn, once it started (absent when it hadn't yet, or the run ended first).
  session?: string
  turn?: string
  // Where the run is, for the first `flow-wait`.
  seen: string
  text: string
}

export type FlowRunResult = FlowRunPreviewResult | FlowRunStartedResult

export interface FlowRunsParams {
  repo?: string
  cwd: string
  // Every repository's runs, all that are kept; otherwise this repository's newest 20.
  all?: boolean
}

export interface FlowRunsResult {
  runs: FlowRunRow[]
  text: string
}

export interface FlowRunRefParams {
  // A run's id (the start of it, four characters or more).
  run: string
}

export interface FlowStatusResult {
  run: FlowRunRow
  text: string
}

export interface FlowWaitParams extends FlowRunRefParams {
  // The `seen` of the last answer: this returns once the run is anywhere else.
  seen?: string
  // Give up after this long and return the run as it is.
  timeoutSec?: number
}

export interface FlowWaitResult {
  run: FlowRunRow
  seen: string
  ended: boolean
}

export interface FlowStopResult {
  run: FlowRunRow
  text: string
}

// ---- words both sides print ----

const GATE_SHOW_LABEL: Record<FlowGateShow['kind'], string> = { diff: 'Changes', 'checks.results': 'Checks', 'review.findings': 'Review findings', 'step.answer': 'Answer' }

/** "Changes: 3 files changed, +40 −2", "Answer from implement: …". */
export function gateShowText(show: FlowGateShow): string {
  return `${show.kind === 'step.answer' && show.step ? `Answer from ${show.step}` : GATE_SHOW_LABEL[show.kind]}: ${show.summary}`
}

/** A step as it starts (`started`) or as it stands: "checks, iteration 2: completed (failed) · test failed, types passed". */
export function flowStepText(step: FlowStepRow, started = false): string {
  const extra: string[] = []
  if (!started && step.delta) extra.push(`${step.delta.files} ${step.delta.files === 1 ? 'file' : 'files'} +${step.delta.additions} −${step.delta.deletions}`)
  if (!started && step.detail) extra.push(step.detail)
  const state = started ? 'started' : step.state === 'waiting' ? 'waiting for you' : step.state
  return `${step.name}, iteration ${step.iteration}: ${state}${!started && step.fact ? ` (${step.fact})` : ''}${extra.length ? ` · ${extra.join(' · ')}` : ''}`
}

/** What a gate asks and how to answer it from here. */
export function gateWaitText(gate: NonNullable<FlowRunRow['gate']>): string {
  const lines = [`Waiting for you at ${gate.step}: ${gate.ask} — answer with \`foreman approve ${gate.id} --continue | --send-back --note "…" | --stop\``]
  for (const show of gate.show) lines.push(`  ${gateShowText(show)}`)
  return lines.join('\n')
}

const END_WORDS: Partial<Record<FlowRunState, string>> = { failed: 'failed', stopped: 'stopped', 'needs-you': 'needs you', cancelled: 'was cancelled', uncertain: 'is uncertain' }

/** The line a finished run ends on: which way it ended and why. */
export function flowEndText(run: Pick<FlowRunRow, 'flow' | 'state' | 'reason'>): string {
  if (run.state === 'completed') return `The flow “${run.flow}” completed.`
  return `The flow “${run.flow}” ${END_WORDS[run.state] ?? run.state}${run.reason ? `: ${run.reason}` : '.'}`
}

/** A run that hasn't ended. */
export const flowRunGoing = (state: FlowRunState): boolean => state === 'starting' || state === 'running' || state === 'waiting'

/** `foreman flow run --wait` exit codes: 0 completed, 1 anything else it ended as. */
export const flowRunExit = (state: FlowRunState): number => (state === 'completed' ? 0 : 1)
