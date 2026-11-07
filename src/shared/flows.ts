// Flows (docs/loops-and-graphs.md): a named graph of steps with one start, edges that branch on a step's facts,
// and loops with bounds. This module is the model, the TOML reader and the checks, pure so the renderer (live
// validation in the editor), main (repository files, personal flows) and tests share one set of rules. Nothing
// here runs a step.
import { parse } from 'smol-toml'
import { createT, type TFunction } from './i18n'
import { applyPersona, isWriteGlob, type Persona, type PersonaSource } from './personas'
import { templatePlaceholders } from './promptTemplates'
import type { ScheduleFingerprint } from './types'

const enT = createT('en')

export const FLOW_DIR = '.foreman/flows'
export { MAX_FLOW_BYTES } from './flowLimits'
// How many personal flows one person keeps, as personas are capped (MAX_PERSONAL_PERSONAS).
export const MAX_PERSONAL_FLOWS = 100
export const MAX_REPO_FLOWS = 50

export const FLOW_STEP_KINDS = ['turn', 'checks', 'script', 'review', 'decide', 'workspace', 'wait', 'gate', 'pick', 'pr'] as const
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number]

export const FLOW_ITERATIONS = ['same-tab', 'compact-when-full', 'fresh-with-summary'] as const
export type FlowIteration = (typeof FLOW_ITERATIONS)[number]

export const FLOW_AFTER = ['keep', 'archive', 'delete-unchanged'] as const
export type FlowAfter = (typeof FLOW_AFTER)[number]

export const FLOW_WAITS = ['ci', 'review'] as const

/** How long a `wait` step waits by default before it ends as `timed-out`. */
export const FLOW_WAIT_MINUTES = 120

/** Above this share of the context window (a percentage), `compact-when-full` compacts before the next pass's turn. */
export const FLOW_COMPACT_ABOVE = 70

/** Where a flow came from: shipped with Foreman, a file in the repository, or kept in state.json. */
export type FlowSource = 'built-in' | 'repo' | 'personal'

/** A `pr` step's title or body may carry the run ledger here, beside the flow's inputs. */
export const FLOW_LEDGER_PLACEHOLDER = 'ledger'

/** A file a gate shows is cut to this. */
export const MAX_GATE_FILE_BYTES = 8 * 1024

/** The end of a run: an edge may point here instead of at a step. */
export const FLOW_DONE = 'done'

/** Context a step can be shown that belongs to no single step. Anything else is `step.section`. */
export const FLOW_CONTEXT_SOURCES = ['task', 'diff', 'tree', 'note', 'ledger', 'attachments', 'comments'] as const

/** The effort levels a step may name (agents.ts EffortLevel); which of them a model takes is the model's. */
export const FLOW_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** Who runs an agent step and what it is shown: the parts `turn`, `review` and `decide` share. */
interface AgentStepFields {
  persona?: string
  // A loadout slot (1-based), or an agent and model; either overrides the persona's default.
  loadout?: number
  agent?: string
  model?: string
  // The thinking effort its turns run at (an EffortLevel); otherwise the loadout's, else the model's default.
  effort?: string
  context?: string[]
  // Narrowing only (see applyPersona): read-only on, or fewer of the persona's MCP servers.
  read_only?: boolean
  mcp?: string[]
  // Narrowing only: the paths a turn step may write, inside its persona's `writes` (see applyPersona).
  writes?: string[]
}

export type FlowStep = { name: string } & (
  | ({ kind: 'turn'; template?: string; prompt?: string; same_tab?: string } & AgentStepFields)
  | { kind: 'checks' }
  | { kind: 'script'; command: string }
  // A review's prompt leads its instructions (what to look for), before the code review preferences and the diff.
  | ({ kind: 'review'; prompt?: string } & AgentStepFields)
  | ({ kind: 'decide'; options: string[]; prompt?: string } & AgentStepFields)
  | { kind: 'workspace'; from?: string }
  | { kind: 'wait'; on: (typeof FLOW_WAITS)[number]; at_most?: { minutes: number } }
  | { kind: 'gate'; show?: string[]; ask?: string }
  | { kind: 'pick'; over: string[] }
  // Opens the pull request for the run's workspace branch, as the Git panel's Push and a host's create do; no agent.
  | { kind: 'pr'; draft?: boolean; title?: string; body?: string }
)

/** A plain next step, or a table keyed by a fact of the step it leaves. Either names a step or `done`. */
export type FlowEdge = string | Record<string, string>

export interface FlowLoop {
  name: string
  over: string[]
  at_most: { iterations?: number; minutes?: number; cost?: number }
  iteration?: FlowIteration
  // compact-when-full: the share of the context window (a percentage) above which the tab is compacted first.
  compact_above?: number
  // A counted loop: its steps run exactly `times` passes (each entry of its first step is one), then the run goes on to
  // `then` instead of starting another or taking an edge out. `at_most` still bounds it.
  times?: number
  then?: string
}

export interface Flow {
  name: string
  description?: string
  // Where a drafted flow came from (a workspace and date, or an assistant thread), kept as written.
  made_from?: string
  source: FlowSource
  start: string
  steps: FlowStep[]
  edges: Record<string, FlowEdge>
  loops: FlowLoop[]
  after: FlowAfter
  // Input name → description: the [inputs] table, then {{placeholders}} found in prompts (with no description).
  inputs: Record<string, string>
}

export interface FlowProblem {
  level: 'error' | 'warning'
  text: string
}

/** A file read: the flow and any warnings, or the errors that stop it being one. */
export type FlowParse = { flow: Flow; warnings: string[] } | { problems: string[]; warnings: string[] }

export interface FlowSummary {
  steps: number
  loops: number
  gates: number
  personas: string[]
}

/** A persona a flow names, as found where the flow is listed or runs. */
export interface FlowPersonaRef {
  name: string
  source: PersonaSource
  file?: string
  rev?: string
  readOnly?: boolean
  // The only paths its turns may write (scoped writes).
  writes?: string[]
}

/** A flow as the Automations page lists it, from any source. */
export interface FlowListing {
  // 'built-in:<starter>', 'repo:<repoId>:<file>', or the personal flow's id.
  id: string
  source: FlowSource
  // The built-in starter's id (its name is translated from it).
  starter?: string
  repoId?: string
  file?: string
  // A repository file's git blob SHA; a personal flow's last save.
  rev?: string
  name: string
  toml: string
  summary?: FlowSummary
  // The personas its steps name, as found (one that isn't found is among the problems).
  personas?: FlowPersonaRef[]
  problems: string[]
  warnings: string[]
}

/** A personal flow as state.json keeps it: the document, which is the source of truth, and when it changed. */
export interface PersonalFlow {
  id: string
  toml: string
  createdAt: string
  updatedAt: string
}

// ---- reading ----

type Table = Record<string, unknown>

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
const STEP_NAME = /^[A-Za-z0-9][\w-]*$/

const STEP_FIELDS: Record<FlowStepKind, readonly string[]> = {
  turn: ['template', 'prompt', 'persona', 'loadout', 'agent', 'model', 'effort', 'context', 'same_tab', 'read_only', 'mcp', 'writes'],
  checks: [],
  script: ['command'],
  review: ['persona', 'loadout', 'agent', 'model', 'effort', 'prompt', 'context', 'read_only', 'mcp'],
  decide: ['options', 'persona', 'loadout', 'agent', 'model', 'effort', 'prompt', 'context', 'read_only', 'mcp'],
  workspace: ['from'],
  wait: ['on', 'at_most'],
  gate: ['show', 'ask'],
  pick: ['over'],
  pr: ['draft', 'title', 'body']
}

const TOP_FIELDS = ['name', 'description', 'made_from', 'start', 'steps', 'edges', 'loops', 'after', 'inputs']

/** The persona a name means where the flow runs, or undefined when there is none. */
export type PersonaLookup = (name: string) => Persona | undefined

/**
 * Read a flow document. Errors (bad TOML, a wrong shape, a broken graph) mean no flow; warnings ride along. With
 * `personas`, a step naming one that doesn't exist, or loosening one, is an error too.
 */
export function parseFlow(toml: string, source: FlowSource, t: TFunction = enT, personas?: PersonaLookup): FlowParse {
  let raw: unknown
  try {
    raw = parse(toml)
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
    return { problems: [t('flows.problem.toml', { error: message })], warnings: [] }
  }
  const read = flowFromObject(raw, source, t)
  if (!read.flow) return { problems: read.problems, warnings: read.warnings }
  const checked = validateFlow(read.flow, t, personas)
  const problems = [...read.problems, ...checked.filter((p) => p.level === 'error').map((p) => p.text)]
  const warnings = [...read.warnings, ...checked.filter((p) => p.level === 'warning').map((p) => p.text)]
  return problems.length ? { problems, warnings } : { flow: read.flow, warnings }
}

/** The flow a parsed TOML table describes, with problems in its shape. The graph itself is validateFlow's. */
export function flowFromObject(raw: unknown, source: FlowSource, t: TFunction = enT): { flow?: Flow; problems: string[]; warnings: string[] } {
  const problems: string[] = []
  const warnings: string[] = []
  if (!isTable(raw)) return { problems: [t('flows.problem.noSteps')], warnings }
  for (const key of Object.keys(raw)) if (!TOP_FIELDS.includes(key)) warnings.push(t('flows.problem.unknownSection', { field: key }))

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) problems.push(t('flows.problem.name'))
  const text = (v: unknown, field: string): string | undefined => {
    if (v === undefined) return undefined
    if (typeof v === 'string') return v
    problems.push(t('flows.problem.topText', { field }))
    return undefined
  }
  const description = text(raw.description, 'description')
  const madeFrom = text(raw.made_from, 'made_from')

  let start = ''
  if (raw.start === undefined) problems.push(t('flows.problem.noStart'))
  else if (isTable(raw.start) && typeof raw.start.step === 'string' && raw.start.step.trim()) start = raw.start.step.trim()
  else if (typeof raw.start === 'string' && raw.start.trim()) start = raw.start.trim()
  else problems.push(t('flows.problem.noStart'))

  const steps: FlowStep[] = []
  if (!isTable(raw.steps) || !Object.keys(raw.steps).length) problems.push(t('flows.problem.noSteps'))
  else
    for (const [stepName, body] of Object.entries(raw.steps)) {
      const step = stepFrom(stepName, body, problems, warnings, t)
      if (step) steps.push(step)
    }

  const edges: Record<string, FlowEdge> = {}
  if (raw.edges !== undefined && !isTable(raw.edges)) problems.push(t('flows.problem.topTable', { field: 'edges' }))
  else
    for (const [from, to] of Object.entries((raw.edges as Table | undefined) ?? {})) {
      if (typeof to === 'string') edges[from] = to
      else if (isTable(to) && Object.values(to).every((v) => typeof v === 'string')) edges[from] = to as Record<string, string>
      else problems.push(t('flows.problem.edgeShape', { step: from }))
    }

  const loops: FlowLoop[] = []
  if (raw.loops !== undefined && !isTable(raw.loops)) problems.push(t('flows.problem.topTable', { field: 'loops' }))
  else
    for (const [loopName, body] of Object.entries((raw.loops as Table | undefined) ?? {})) {
      const loop = loopFrom(loopName, body, problems, warnings, t)
      if (loop) loops.push(loop)
    }

  let after: FlowAfter = 'keep'
  if (raw.after !== undefined) {
    const workspace = isTable(raw.after) ? raw.after.workspace : undefined
    if (workspace === undefined && isTable(raw.after)) after = 'keep'
    else if (typeof workspace === 'string' && (FLOW_AFTER as readonly string[]).includes(workspace)) after = workspace as FlowAfter
    else problems.push(t('flows.problem.after', { choices: FLOW_AFTER.join(', ') }))
  }

  const inputs: Record<string, string> = {}
  if (raw.inputs !== undefined) {
    if (isTable(raw.inputs) && Object.values(raw.inputs).every((v) => typeof v === 'string')) Object.assign(inputs, raw.inputs)
    else problems.push(t('flows.problem.inputs'))
  }
  for (const step of steps) {
    const texts =
      step.kind === 'turn' || step.kind === 'decide' || step.kind === 'review'
        ? [step.prompt]
        : step.kind === 'gate'
          ? [step.ask, ...(step.show ?? []).filter(isShowPath)]
          : step.kind === 'pr'
            ? [step.title, step.body]
            : []
    for (const body of texts)
      for (const placeholder of body ? templatePlaceholders(body) : []) if (!(placeholder in inputs) && !(step.kind === 'pr' && placeholder === FLOW_LEDGER_PLACEHOLDER)) inputs[placeholder] = ''
  }

  if (problems.length) return { problems, warnings }
  const flow: Flow = { name, source, start, steps, edges, loops, after, inputs }
  if (description !== undefined) flow.description = description
  if (madeFrom !== undefined) flow.made_from = madeFrom
  return { flow, problems, warnings }
}

function stepFrom(name: string, body: unknown, problems: string[], warnings: string[], t: TFunction): FlowStep | undefined {
  if (!isTable(body)) {
    problems.push(t('flows.problem.stepShape', { step: name }))
    return undefined
  }
  const kind = body.kind
  if (typeof kind !== 'string' || !(FLOW_STEP_KINDS as readonly string[]).includes(kind)) {
    problems.push(typeof kind === 'string' ? t('flows.problem.kind', { step: name, kind, kinds: FLOW_STEP_KINDS.join(', ') }) : t('flows.problem.noKind', { step: name, kinds: FLOW_STEP_KINDS.join(', ') }))
    return undefined
  }
  const k = kind as FlowStepKind
  for (const field of Object.keys(body)) if (field !== 'kind' && !STEP_FIELDS[k].includes(field)) warnings.push(t('flows.problem.unknownField', { step: name, field }))
  const before = problems.length
  const text = (field: string, required = false): string | undefined => {
    const v = body[field]
    if (v === undefined) {
      if (required) problems.push(t('flows.problem.required', { step: name, field }))
      return undefined
    }
    if (typeof v === 'string' && v.trim()) return v
    problems.push(t('flows.problem.fieldText', { step: name, field }))
    return undefined
  }
  const list = (field: string, required = false): string[] | undefined => {
    const v = body[field]
    if (v === undefined) {
      if (required) problems.push(t('flows.problem.required', { step: name, field }))
      return undefined
    }
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) && (!required || v.length)) return v as string[]
    problems.push(t('flows.problem.fieldList', { step: name, field }))
    return undefined
  }
  const agent = (): AgentStepFields => {
    const out: AgentStepFields = {}
    const persona = text('persona')
    if (persona) out.persona = persona
    if (body.loadout !== undefined) {
      if (typeof body.loadout === 'number' && Number.isInteger(body.loadout) && body.loadout >= 1) out.loadout = body.loadout
      else problems.push(t('flows.problem.fieldWhole', { step: name, field: 'loadout' }))
    }
    const agentName = text('agent')
    if (agentName) out.agent = agentName
    const model = text('model')
    if (model) out.model = model
    const effort = text('effort')
    if (effort) {
      if ((FLOW_EFFORTS as readonly string[]).includes(effort)) out.effort = effort
      else problems.push(t('flows.problem.effort', { step: name, value: effort, efforts: FLOW_EFFORTS.join(', ') }))
    }
    const context = list('context')
    if (context) out.context = context
    if (body.read_only !== undefined) {
      if (typeof body.read_only === 'boolean') out.read_only = body.read_only
      else problems.push(t('flows.problem.fieldBool', { step: name, field: 'read_only' }))
    }
    const mcp = list('mcp')
    if (mcp) out.mcp = mcp
    const writes = STEP_FIELDS[k].includes('writes') ? list('writes') : undefined
    if (writes) {
      for (const glob of writes) if (!isWriteGlob(glob)) problems.push(t('flows.problem.writes', { step: name, value: glob }))
      out.writes = writes
    }
    return out
  }
  let step: FlowStep
  switch (k) {
    case 'turn': {
      step = { name, kind: k, ...agent() }
      const template = text('template')
      const prompt = text('prompt')
      const sameTab = text('same_tab')
      if (template) step.template = template
      if (prompt) step.prompt = prompt
      if (sameTab) step.same_tab = sameTab
      break
    }
    case 'checks':
      step = { name, kind: k }
      break
    case 'script':
      step = { name, kind: k, command: text('command', true) ?? '' }
      break
    case 'review': {
      step = { name, kind: k, ...agent() }
      const prompt = text('prompt')
      if (prompt) step.prompt = prompt
      break
    }
    case 'decide': {
      step = { name, kind: k, options: list('options', true) ?? [], ...agent() }
      const prompt = text('prompt')
      if (prompt) step.prompt = prompt
      break
    }
    case 'workspace': {
      step = { name, kind: k }
      const from = text('from')
      if (from) step.from = from
      break
    }
    case 'wait': {
      const on = body.on
      if (on === undefined) problems.push(t('flows.problem.required', { step: name, field: 'on' }))
      else if (typeof on !== 'string' || !(FLOW_WAITS as readonly string[]).includes(on)) problems.push(t('flows.problem.fieldChoice', { step: name, field: 'on', choices: FLOW_WAITS.join(', ') }))
      step = { name, kind: k, on: (on as (typeof FLOW_WAITS)[number]) ?? 'ci' }
      if (body.at_most !== undefined) {
        const bound = body.at_most
        const minutes = isTable(bound) ? bound.minutes : undefined
        if (isTable(bound) && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 && Object.keys(bound).every((key) => key === 'minutes')) step.at_most = { minutes }
        else problems.push(t('flows.problem.waitBound', { step: name }))
      }
      break
    }
    case 'gate': {
      step = { name, kind: k }
      const show = list('show')
      const ask = text('ask')
      if (show) step.show = show
      if (ask) step.ask = ask
      break
    }
    case 'pick':
      step = { name, kind: k, over: list('over', true) ?? [] }
      break
    case 'pr': {
      step = { name, kind: k }
      if (body.draft !== undefined) {
        if (typeof body.draft === 'boolean') step.draft = body.draft
        else problems.push(t('flows.problem.fieldBool', { step: name, field: 'draft' }))
      }
      const title = text('title')
      const prBody = text('body')
      if (title) step.title = title
      if (prBody) step.body = prBody
      break
    }
  }
  return problems.length === before ? step : undefined
}

function loopFrom(name: string, body: unknown, problems: string[], warnings: string[], t: TFunction): FlowLoop | undefined {
  if (!isTable(body)) {
    problems.push(t('flows.problem.loopShape', { loop: name }))
    return undefined
  }
  for (const field of Object.keys(body)) if (!['over', 'at_most', 'iteration', 'compact_above', 'times', 'then'].includes(field)) warnings.push(t('flows.problem.loopUnknownField', { loop: name, field }))
  const before = problems.length
  const over = Array.isArray(body.over) && body.over.every((x) => typeof x === 'string') ? (body.over as string[]) : null
  if (!over) problems.push(t('flows.problem.loopOver', { loop: name }))
  const at_most: FlowLoop['at_most'] = {}
  if (body.at_most !== undefined) {
    if (!isTable(body.at_most)) problems.push(t('flows.problem.loopBound', { loop: name }))
    else
      for (const [bound, value] of Object.entries(body.at_most)) {
        if (bound !== 'iterations' && bound !== 'minutes' && bound !== 'cost') {
          warnings.push(t('flows.problem.loopUnknownField', { loop: name, field: `at_most.${bound}` }))
          continue
        }
        const ok = typeof value === 'number' && Number.isFinite(value) && value > 0 && (bound !== 'iterations' || Number.isInteger(value))
        if (ok) at_most[bound] = value
        else problems.push(t('flows.problem.loopBoundValue', { loop: name, bound }))
      }
  }
  let iteration: FlowIteration | undefined
  if (body.iteration !== undefined) {
    if (typeof body.iteration === 'string' && (FLOW_ITERATIONS as readonly string[]).includes(body.iteration)) iteration = body.iteration as FlowIteration
    else problems.push(t('flows.problem.loopIteration', { loop: name, choices: FLOW_ITERATIONS.join(', ') }))
  }
  let compactAbove: number | undefined
  if (body.compact_above !== undefined) {
    const v = body.compact_above
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100) compactAbove = v
    else problems.push(t('flows.problem.loopCompactAbove', { loop: name }))
  }
  let times: number | undefined
  if (body.times !== undefined) {
    if (typeof body.times === 'number' && Number.isInteger(body.times) && body.times >= 1) times = body.times
    else problems.push(t('flows.problem.loopTimes', { loop: name }))
  }
  let then: string | undefined
  if (body.then !== undefined) {
    if (typeof body.then === 'string' && body.then.trim()) then = body.then.trim()
    else problems.push(t('flows.problem.loopThen', { loop: name }))
  }
  if ((body.times === undefined) !== (body.then === undefined)) problems.push(t('flows.problem.loopThen', { loop: name }))
  if (problems.length !== before) return undefined
  return {
    name,
    over: over ?? [],
    at_most,
    ...(iteration ? { iteration } : {}),
    ...(compactAbove !== undefined ? { compact_above: compactAbove } : {}),
    ...(times !== undefined && then ? { times, then } : {})
  }
}

// ---- the graph ----

/** The facts a step can produce, which are the only keys an edge leaving it may branch on. */
export function flowFacts(step: FlowStep): string[] {
  switch (step.kind) {
    case 'turn':
      return ['answer', 'delta', 'outcome', 'reports']
    case 'checks':
      return ['passed', 'failed']
    case 'script':
      return ['ok', 'failed']
    case 'review':
      // undecided: a persona expected to end with findings or `done` did neither; with no edge for it, the findings edge.
      return ['clean', 'findings', 'undecided']
    case 'decide':
      return [...step.options, 'undecided']
    case 'wait':
      return step.on === 'review' ? ['approved', 'changes-requested', 'timed-out'] : ['green', 'failed', 'none', 'timed-out']
    case 'gate':
      return ['continued', 'sent-back', 'stopped']
    case 'pick':
      return [...step.over]
    case 'workspace':
      return ['ready', 'failed']
    case 'pr':
      return ['opened', 'failed']
  }
}

/** A gate's `show` entry that names a file (it has a slash): a path relative to the workspace, `{{inputs}}` and `*` allowed. */
export function isShowPath(ref: string): boolean {
  return ref.includes('/')
}

/** A file a gate shows stays inside the workspace: relative, forward slashes, no `..`. */
export function showPathProblem(ref: string): boolean {
  const p = ref.trim()
  return !p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes(String.fromCharCode(92)) || p.split('/').some((part) => part === '..' || part === '')
}

/**
 * Where a run goes after `from` produced `fact`. `done` when the edge says so or the step has no edge (the run ends
 * there); null when the edge branches and has no entry for the fact (nothing planned for it: the run stops).
 */
export function nextStep(flow: Flow, from: string, fact?: string): string | null {
  const edge = flow.edges[from]
  if (edge === undefined) return FLOW_DONE
  if (typeof edge === 'string') return edge
  return fact !== undefined && Object.hasOwn(edge, fact) ? edge[fact] : null
}

/** The loops that span a step, in the file's order. */
export function loopsContaining(flow: Flow, step: string): FlowLoop[] {
  return flow.loops.filter((l) => l.over.includes(step))
}

/** The persona a step runs as: its own, else (continuing another step's tab) that step's. */
export function stepPersona(flow: Flow, step: FlowStep): string | undefined {
  if (step.kind !== 'turn' && step.kind !== 'review' && step.kind !== 'decide') return undefined
  if (step.persona) return step.persona
  if (step.kind !== 'turn' || !step.same_tab) return undefined
  const other = flow.steps.find((s) => s.name === step.same_tab)
  return other && other !== step && other.kind === 'turn' && other.persona ? other.persona : undefined
}

export function flowSummary(flow: Flow): FlowSummary {
  const personas: string[] = []
  for (const step of flow.steps) {
    const persona = 'persona' in step ? step.persona : undefined
    if (persona && !personas.includes(persona)) personas.push(persona)
  }
  return { steps: flow.steps.length, loops: flow.loops.length, gates: flow.steps.filter((s) => s.kind === 'gate').length, personas }
}

/** The text an approval would hash: the flow as parsed, keys sorted, without where it was read from. */
export function flowFingerprintInputs(flow: Flow): string {
  const { source: _source, ...rest } = flow
  return stable(rest)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isTable(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** The steps an edge leaving `name` can lead to (never `done`, never a name that isn't a step), and a counted loop's `then`. */
function successors(flow: Flow, names: Set<string>, name: string): string[] {
  const edge = flow.edges[name]
  const targets = edge === undefined ? [] : typeof edge === 'string' ? [edge] : Object.values(edge)
  for (const loop of flow.loops) if (loop.then && loop.over.includes(name)) targets.push(loop.then)
  return targets.filter((x) => names.has(x))
}

/**
 * Where a counted loop sends the run instead of `next` as it leaves `from`: its `then`, once its passes are done (an edge
 * that would start pass N+1, or leave its steps, after the Nth). `entries` counts the loop's first step in this pass.
 */
export function countedLoopRedirect(flow: Flow, from: string, next: string, entries: (loop: FlowLoop) => number): string | undefined {
  for (const loop of flow.loops) {
    if (!loop.times || !loop.then || !loop.over.includes(from)) continue
    const leaving = !loop.over.includes(next)
    const restarting = next === loop.over[0]
    if ((leaving || restarting) && entries(loop) >= loop.times) return loop.then
  }
  return undefined
}

/** Every step reachable from `name` by one edge or more (so `name` itself only when it is on a cycle). */
function reachableFrom(flow: Flow, names: Set<string>, name: string, within?: Set<string>): Set<string> {
  const seen = new Set<string>()
  const queue = successors(flow, names, name).filter((x) => !within || within.has(x))
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next)) continue
    seen.add(next)
    for (const s of successors(flow, names, next)) if (!seen.has(s) && (!within || within.has(s))) queue.push(s)
  }
  return seen
}

/** Each persona a step names exists where the flow runs, and no step loosens it: the problems, in words. */
export function flowPersonaProblems(flow: Flow, personas: PersonaLookup, t: TFunction = enT): string[] {
  const out: string[] = []
  for (const step of flow.steps) {
    if (!('persona' in step) || !step.persona) continue
    const persona = personas(step.persona)
    if (!persona) out.push(t('flows.problem.personaUnknown', { step: step.name, persona: step.persona }))
    else out.push(...applyPersona(step, persona, t).problems)
  }
  return out
}

/** The graph's problems in words: errors refuse the flow, warnings are shown beside it. `personas` checks the personas steps name. */
export function validateFlow(flow: Flow, t: TFunction = enT, personas?: PersonaLookup): FlowProblem[] {
  const out: FlowProblem[] = []
  const error = (text: string) => out.push({ level: 'error', text })
  const warn = (text: string) => out.push({ level: 'warning', text })
  const byName = new Map<string, FlowStep>()
  for (const step of flow.steps) {
    if (byName.has(step.name)) error(t('flows.problem.duplicateStep', { step: step.name }))
    else if (step.name === FLOW_DONE) error(t('flows.problem.reservedName', { step: step.name }))
    else if (!STEP_NAME.test(step.name)) error(t('flows.problem.stepName', { step: step.name }))
    byName.set(step.name, step)
  }
  const names = new Set(byName.keys())
  if (!flow.steps.length) error(t('flows.problem.noSteps'))
  if (!flow.start) error(t('flows.problem.noStart'))
  else if (!names.has(flow.start)) error(t('flows.problem.unknownStart', { step: flow.start }))

  // Edges: from a step, to a step or done, keyed only by facts the step produces.
  const target = (from: string, to: string) => {
    if (to !== FLOW_DONE && !names.has(to)) error(t('flows.problem.edgeTo', { from, step: to }))
  }
  for (const [from, edge] of Object.entries(flow.edges)) {
    const step = byName.get(from)
    if (!step) {
      error(t('flows.problem.edgeFrom', { step: from }))
      continue
    }
    if (typeof edge === 'string') {
      target(from, edge)
      continue
    }
    const facts = flowFacts(step)
    for (const [fact, to] of Object.entries(edge)) {
      if (!facts.includes(fact))
        error(facts.length ? t('flows.problem.fact', { step: from, kind: step.kind, fact, facts: facts.join(', ') }) : t('flows.problem.noFacts', { step: from, kind: step.kind }))
      target(from, to)
    }
  }

  // Order: what a step reads must come from a step that can have run before it.
  const fromStart = names.has(flow.start) ? new Set([flow.start, ...reachableFrom(flow, names, flow.start)]) : new Set<string>()
  const reach = new Map<string, Set<string>>()
  const reachOf = (name: string) => {
    let r = reach.get(name)
    if (!r) reach.set(name, (r = reachableFrom(flow, names, name)))
    return r
  }
  const canRunBefore = (other: string, step: string) => fromStart.has(other) && reachOf(other).has(step)
  const reference = (step: FlowStep, other: string, ref: string) => {
    if (!names.has(other)) return error(t('flows.problem.refUnknown', { step: step.name, ref, other }))
    if (fromStart.has(step.name) && !canRunBefore(other, step.name)) error(t('flows.problem.order', { step: step.name, ref, other }))
  }
  const sources = (step: FlowStep, refs: string[] | undefined) => {
    for (const ref of refs ?? []) {
      // A gate may show a file by its path; nothing else takes one.
      if (step.kind === 'gate' && isShowPath(ref)) {
        if (showPathProblem(ref)) error(t('flows.problem.showPath', { step: step.name, ref }))
        continue
      }
      const dot = ref.indexOf('.')
      if (dot > 0) reference(step, ref.slice(0, dot), ref)
      else if (!(FLOW_CONTEXT_SOURCES as readonly string[]).includes(ref)) error(t('flows.problem.contextSource', { step: step.name, ref, sources: FLOW_CONTEXT_SOURCES.join(', ') }))
    }
  }
  for (const step of flow.steps) {
    if ('context' in step) sources(step, step.context)
    if (step.kind === 'gate') sources(step, step.show)
    if (step.kind === 'turn' && step.same_tab) {
      const other = byName.get(step.same_tab)
      if (!other) error(t('flows.problem.sameTabUnknown', { step: step.name, other: step.same_tab }))
      else if (other.kind !== 'turn') error(t('flows.problem.sameTabKind', { step: step.name, other: other.name, kind: other.kind }))
    }
    if (step.kind === 'workspace' && step.from && step.from !== 'base') reference(step, step.from, step.from)
    if (step.kind === 'pick')
      for (const other of step.over) {
        reference(step, other, other)
        const kind = byName.get(other)?.kind
        if (kind && kind !== 'workspace' && kind !== 'turn') error(t('flows.problem.pickKind', { step: step.name, other, kind }))
      }
  }

  // Loops: unique names, real steps that lead back to each other, and at least one bound.
  const loopNames = new Set<string>()
  for (const loop of flow.loops) {
    if (loopNames.has(loop.name)) error(t('flows.problem.duplicateLoop', { loop: loop.name }))
    loopNames.add(loop.name)
    const unknown = loop.over.filter((s) => !names.has(s))
    for (const s of unknown) error(t('flows.problem.loopUnknown', { loop: loop.name, step: s }))
    if (!loop.over.length) error(t('flows.problem.loopOver', { loop: loop.name }))
    else if (!unknown.length) {
      const within = new Set(loop.over)
      if (loop.over.some((s) => loop.over.some((other) => !reachableFrom(flow, names, s, within).has(other)))) error(t('flows.problem.loopDisconnected', { loop: loop.name }))
    }
    const { iterations, minutes, cost } = loop.at_most
    if (iterations === undefined && minutes === undefined && cost === undefined && loop.times === undefined) error(t('flows.problem.loopBound', { loop: loop.name }))
    if (loop.then && loop.then !== FLOW_DONE && !names.has(loop.then)) error(t('flows.problem.loopThenUnknown', { loop: loop.name, step: loop.then }))
    else if (loop.then && loop.over.includes(loop.then)) error(t('flows.problem.loopThenInside', { loop: loop.name, step: loop.then }))
  }

  if (personas) for (const problem of flowPersonaProblems(flow, personas, t)) error(problem)

  for (const step of flow.steps) if (names.has(flow.start) && !fromStart.has(step.name)) warn(t('flows.problem.unreachable', { step: step.name }))
  return out
}

// ---- runs ----

/**
 * Something a gate shows the person deciding, in words ("Tests failed, Types passed"); `step` names whose answer. A
 * `file` is a file in the workspace by its path (a glob means the newest match), its content cut to MAX_GATE_FILE_BYTES.
 */
export interface FlowGateShow {
  kind: 'diff' | 'checks.results' | 'review.findings' | 'step.answer' | 'file'
  step?: string
  path?: string
  summary: string
}

/** One result a pick step offers: the step that made it, the workspace it is in, and how it ended, in words. */
export interface FlowPickChoice {
  step: string
  workspaceId: string
  summary: string
}

/** waiting: at a gate or a pick. needs-you: an unattended turn asked for something and was stopped. uncertain: Foreman closed mid-run; never retried. */
export type FlowRunState = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'needs-you' | 'stopped' | 'uncertain'
export const FLOW_RUN_ACTIVE: readonly FlowRunState[] = ['starting', 'running', 'waiting']
export const isActiveRun = (run: Pick<FlowRun, 'state'>): boolean => FLOW_RUN_ACTIVE.includes(run.state)

export type FlowRunStepState = 'running' | 'completed' | 'failed' | 'waiting' | 'stopped'

/** One execution of a step: a step that runs again (a loop) gets another entry. */
export interface FlowRunStep {
  name: string
  kind: FlowStepKind
  // How many times this step has run in this run, this one included.
  iteration: number
  // The loops spanning it, with the iteration each was on.
  loops?: Record<string, number>
  state: FlowRunStepState
  startedAt: string
  endedAt?: string
  sessionId?: string
  turnId?: string
  // The fact that chose the next step ("failed", "continued").
  fact?: string
  // What happened, in words ("Tests failed, Types passed").
  detail?: string
  delta?: { files: number; additions: number; deletions: number }
  // The context sections its message carried, in order ("task", "implement.answer", "checks.results").
  shown?: string[]
  // The persona it ran as, and whether that held its tab read-only.
  persona?: string
  readOnly?: boolean
  // Minutes this step counted against its loops (a gate, a pick and a wait count none).
  minutes?: number
  // The workspace it ran in (a run that makes more than one workspace moves between them).
  workspaceId?: string
  // The working tree's hash (short) before the step ran and after it ended; checks, a review and a script record the
  // tree they read as `start`, a workspace step its new workspace's as `end`.
  tree?: { start?: string; end?: string }
  // Its start tree differs from the end of the step before it in the same workspace: something changed files between.
  moved?: true
  // What its turn cost, when the agent says (Claude's result items), in USD.
  costUsd?: number
  // The model its turn ran on (an agent step), and the effort, when one was chosen for it.
  model?: string
  effort?: string
  // How full the tab's context window was when its turn ended, as the agent said (Claude per turn; others a total).
  usage?: { used: number; limit: number }
  // The memory files the agent's context breakdown named (Claude), as it named them.
  memoryFiles?: string[]
  // Paths its turn's changes touched that are agent memory (isMemoryPath): CLAUDE.md, .claude/, AGENTS.md and the above.
  memoryWrites?: string[]
  // The workspace note's revision its message carried, when it was shown the note.
  noteRevision?: number
}

/**
 * A loop's current pass: it starts when the run enters the loop's steps from outside, and its bounds count within it.
 * Leaving the loop's steps (a gate outside it, say) closes the pass; entering again opens the next one with fresh bounds.
 * A flow that wants a gate to count against the loop lists the gate in the loop's `over`.
 */
export interface FlowRunLoop {
  // 1 for the first pass of this run, up by one each time the loop is entered again from outside.
  pass: number
  // False once the run has left the loop's steps.
  open: boolean
  iterations: number
  startedAt: string
  minutesUsed: number
  // USD spent by this pass's turns, where the agent says (Claude).
  costUsed?: number
  // The loop's steps entered in this iteration; entering one again starts the next iteration.
  visited: string[]
  // A counted loop: how many times its first step was entered in this pass.
  entries?: number
}

/** What a run's approval covers, part by part, so a refusal can say which part changed. */
export interface FlowFingerprint {
  flow: string
  templates: string
  setup: string
  checks: string
  mcp: string
  // Every persona the flow's steps run as: name, source and the document as written.
  personas: string
}

/** A flow run's approval as a flow schedule's fingerprint has it: what the Schedule dialog sends back as `shown`. */
export function scheduleFingerprintOfFlow(f: FlowFingerprint): ScheduleFingerprint {
  return { template: f.templates, setup: f.setup, checks: f.checks, mcp: f.mcp, flow: f.flow, personas: f.personas }
}

/**
 * Who started a run when it wasn't someone at the window or a terminal: a schedule's occurrence, a workspace agent's
 * start_flow (the coordinating chat and its turn), or the assistant's thread (its Run card).
 */
export type FlowRunOrigin =
  | { kind: 'schedule'; scheduleId: string; occurrenceId: string }
  | { kind: 'delegation'; sessionId: string; turnId?: string }
  | { kind: 'assistant'; threadId: string }

export interface FlowRun {
  id: string
  // Absent: started from the window or a terminal.
  origin?: FlowRunOrigin
  flow: { id: string; name: string; source: FlowSource; starter?: string; file?: string; rev?: string }
  repoId: string
  baseBranch: string
  inputs: Record<string, string>
  fingerprint: FlowFingerprint
  state: FlowRunState
  reason?: string
  startedAt: string
  endedAt?: string
  workspaceId?: string
  // Every workspace the run made, in order (a workspace step makes another; a pick moves `workspaceId` among them).
  workspaces?: string[]
  // The pull request a `pr` step opened, which a later `wait` reads.
  pullRequest?: { number: number; url: string }
  // The first message as sent: the run's task, which a step's `task` context carries.
  task?: string
  current?: { step: string; iteration: number }
  steps: FlowRunStep[]
  loops: Record<string, FlowRunLoop>
  // Each loop's steps and bounds as the flow said when the run started, so a run can be shown without its file.
  bounds?: Record<string, { over: string[]; iterations?: number; minutes?: number; cost?: number; times?: number; then?: string }>
  // The models chosen for this run's agent steps when it started (FlowRunStart.models); the rest ran as the flow says.
  models?: FlowModelChoices
  // A gate's "Send back" note, carried to the next step's message and then cleared.
  note?: string
  // The gate the note came from, named in the message that carries it.
  noteFrom?: string
}

/** What starting a flow would approve, as the Run a flow page shows it. */
export interface FlowRunSummary {
  flowName: string
  flowSource: FlowSource
  starter?: string
  flowFile?: string
  flowRev?: string
  repoName: string
  baseBranch: string
  steps: number
  loops: number
  gates: number
  personas: FlowPersonaRef[]
  templates: { name: string; rev?: string; source: 'personal' | 'repo' }[]
  setupScript: string
  checks: { name: string; command: string }[]
  // The saved commands its script steps run, approved with the checks.
  commands?: { name: string; command: string }[]
  mcpServers: string[]
  integrations: string[]
  // Turn steps whose agent isn't Claude: they refuse the run.
  notClaude: { step: string; agent: string }[]
  // Review and decide steps on Codex: read-only and attended (an approval they ask for waits for you).
  attended?: { step: string; agent: string }[]
  // A loop bounds cost, which only counts turns whose agent says what they cost (Claude).
  costBound?: boolean
  // Other reasons it can't start (a template that doesn't exist, a loadout slot that isn't set).
  problems: string[]
  // What a completed run does with the workspaces it made (the flow's [after]); a run can't change it.
  after?: FlowAfter
}

export interface FlowRunPreview {
  fingerprint: FlowFingerprint
  summary: FlowRunSummary
  // The values a run asks for: the flow's [inputs] and its templates' {{placeholders}}.
  inputs: { name: string; description: string }[]
  // Each agent step a run can choose a model for, with the one the flow gives it.
  models?: FlowStepModel[]
}

/** The agent, model and effort one agent step runs on. */
export interface FlowStepChoice {
  agent: string
  model: string
  effort?: string
}

/** A run's own choices, by agent step name; a step not named runs as the flow says. */
export type FlowModelChoices = Record<string, FlowStepChoice>

/**
 * An agent step whose model a run can choose (one that doesn't continue another step's tab), with what the flow gives
 * it and where that comes from: the step itself, its persona, a loadout slot, or loadout 1 by default.
 */
export interface FlowStepModel {
  step: string
  kind: 'turn' | 'review' | 'decide'
  persona?: string
  // The turn steps that continue its tab, and so run on its model.
  follows?: string[]
  // Whether it is held read-only (a review or decide always is), which is what lets it run on Codex.
  readOnly: boolean
  choice: FlowStepChoice
  from: 'step' | 'persona' | 'slot' | 'default'
  slot?: number
}

export interface FlowRunStart {
  flowId: string
  source?: FlowSource
  repoId: string
  baseBranch: string
  inputs: Record<string, string>
  // The fingerprint the caller showed; the run is refused when it is no longer what would run.
  shown: FlowFingerprint
  // Models chosen for this run, by agent step; checked as a step's own agent and model would be.
  models?: FlowModelChoices
}

/** The active run a workspace belongs to (its current workspace, or another the run made), else its latest run. */
export function runForWorkspace(runs: readonly FlowRun[] | undefined, workspaceId: string): FlowRun | undefined {
  const mine = (runs ?? []).filter((r) => r.workspaceId === workspaceId || r.workspaces?.includes(workspaceId))
  return mine.find(isActiveRun) ?? mine.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)
}

/** The loops spanning the run's current step with their bounds: "iteration 2 of at most 4 · 18 of 45 min · $0.40 of $2.00" as numbers. */
export function currentLoopBounds(run: FlowRun): { loop: string; pass: number; iteration: number; maxIterations?: number; minutes: number; maxMinutes?: number; cost?: number; maxCost?: number }[] {
  const at = run.current?.step
  if (!at) return []
  return Object.entries(run.bounds ?? {})
    .filter(([name, b]) => b.over.includes(at) && run.loops[name]?.open)
    .map(([name, b]) => ({
      loop: name,
      pass: run.loops[name].pass,
      iteration: run.loops[name].iterations,
      maxIterations: b.iterations,
      minutes: Math.floor(run.loops[name].minutesUsed),
      maxMinutes: b.minutes,
      ...(run.loops[name].costUsed ? { cost: run.loops[name].costUsed } : {}),
      ...(b.cost !== undefined ? { maxCost: b.cost } : {})
    }))
}
