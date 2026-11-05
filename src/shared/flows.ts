// Flows (docs/loops-and-graphs.md): a named graph of steps with one start, edges that branch on a step's facts,
// and loops with bounds. This module is the model, the TOML reader and the checks, pure so the renderer (live
// validation in the editor), main (repository files, personal flows) and tests share one set of rules. Nothing
// here runs a step: a flow is only read, checked and listed in this slice.
import { parse } from 'smol-toml'
import { createT, type TFunction } from './i18n'
import { templatePlaceholders } from './promptTemplates'

const enT = createT('en')

export const FLOW_DIR = '.foreman/flows'
export const MAX_FLOW_BYTES = 64 * 1024
export const MAX_REPO_FLOWS = 50

export const FLOW_STEP_KINDS = ['turn', 'checks', 'script', 'review', 'decide', 'workspace', 'wait', 'gate', 'pick'] as const
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number]

export const FLOW_ITERATIONS = ['same-tab', 'compact-when-full', 'fresh-with-summary'] as const
export type FlowIteration = (typeof FLOW_ITERATIONS)[number]

export const FLOW_AFTER = ['keep', 'archive', 'delete-unchanged'] as const
export type FlowAfter = (typeof FLOW_AFTER)[number]

export const FLOW_WAITS = ['ci', 'review'] as const

/** Where a flow came from: shipped with Foreman, a file in the repository, or kept in state.json. */
export type FlowSource = 'built-in' | 'repo' | 'personal'

/** The end of a run: an edge may point here instead of at a step. */
export const FLOW_DONE = 'done'

/** Context a step can be shown that belongs to no single step. Anything else is `step.section`. */
export const FLOW_CONTEXT_SOURCES = ['task', 'diff', 'tree', 'note', 'ledger', 'attachments', 'comments'] as const

/** Who runs an agent step and what it is shown: the parts `turn`, `review` and `decide` share. */
interface AgentStepFields {
  persona?: string
  // A loadout slot (1-based), or an agent and model; either overrides the persona's default.
  loadout?: number
  agent?: string
  model?: string
  context?: string[]
}

export type FlowStep = { name: string } & (
  | ({ kind: 'turn'; template?: string; prompt?: string; same_tab?: string } & AgentStepFields)
  | { kind: 'checks' }
  | { kind: 'script'; command: string }
  | ({ kind: 'review' } & AgentStepFields)
  | ({ kind: 'decide'; options: string[]; prompt?: string } & AgentStepFields)
  | { kind: 'workspace'; from?: string }
  | { kind: 'wait'; on: (typeof FLOW_WAITS)[number] }
  | { kind: 'gate'; show?: string[]; ask?: string }
  | { kind: 'pick'; over: string[] }
)

/** A plain next step, or a table keyed by a fact of the step it leaves. Either names a step or `done`. */
export type FlowEdge = string | Record<string, string>

export interface FlowLoop {
  name: string
  over: string[]
  at_most: { iterations?: number; minutes?: number; cost?: number }
  iteration?: FlowIteration
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
  turn: ['template', 'prompt', 'persona', 'loadout', 'agent', 'model', 'context', 'same_tab'],
  checks: [],
  script: ['command'],
  review: ['persona', 'loadout', 'agent', 'model', 'context'],
  decide: ['options', 'persona', 'loadout', 'agent', 'model', 'prompt', 'context'],
  workspace: ['from'],
  wait: ['on'],
  gate: ['show', 'ask'],
  pick: ['over']
}

const TOP_FIELDS = ['name', 'description', 'made_from', 'start', 'steps', 'edges', 'loops', 'after', 'inputs']

/** Read a flow document. Errors (bad TOML, a wrong shape, a broken graph) mean no flow; warnings ride along. */
export function parseFlow(toml: string, source: FlowSource, t: TFunction = enT): FlowParse {
  let raw: unknown
  try {
    raw = parse(toml)
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim()
    return { problems: [t('flows.problem.toml', { error: message })], warnings: [] }
  }
  const read = flowFromObject(raw, source, t)
  if (!read.flow) return { problems: read.problems, warnings: read.warnings }
  const checked = validateFlow(read.flow, t)
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
    const texts = step.kind === 'turn' || step.kind === 'decide' ? [step.prompt] : step.kind === 'gate' ? [step.ask] : []
    for (const body of texts) for (const placeholder of body ? templatePlaceholders(body) : []) if (!(placeholder in inputs)) inputs[placeholder] = ''
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
    const context = list('context')
    if (context) out.context = context
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
    case 'review':
      step = { name, kind: k, ...agent() }
      break
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
  }
  return problems.length === before ? step : undefined
}

function loopFrom(name: string, body: unknown, problems: string[], warnings: string[], t: TFunction): FlowLoop | undefined {
  if (!isTable(body)) {
    problems.push(t('flows.problem.loopShape', { loop: name }))
    return undefined
  }
  for (const field of Object.keys(body)) if (!['over', 'at_most', 'iteration'].includes(field)) warnings.push(t('flows.problem.loopUnknownField', { loop: name, field }))
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
  if (problems.length !== before) return undefined
  return { name, over: over ?? [], at_most, ...(iteration ? { iteration } : {}) }
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
      return ['clean', 'findings']
    case 'decide':
      return [...step.options, 'undecided']
    case 'wait':
      return ['green', 'failed']
    case 'gate':
      return ['continued', 'sent-back', 'stopped']
    case 'pick':
      return [...step.over]
    case 'workspace':
      return []
  }
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

/** The steps an edge leaving `name` can lead to (never `done`, never a name that isn't a step). */
function successors(flow: Flow, names: Set<string>, name: string): string[] {
  const edge = flow.edges[name]
  const targets = edge === undefined ? [] : typeof edge === 'string' ? [edge] : Object.values(edge)
  return targets.filter((x) => names.has(x))
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

/** The graph's problems in words: errors refuse the flow, warnings are shown beside it. */
export function validateFlow(flow: Flow, t: TFunction = enT): FlowProblem[] {
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
    if (step.kind === 'pick') for (const other of step.over) reference(step, other, other)
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
    if (iterations === undefined && minutes === undefined && cost === undefined) error(t('flows.problem.loopBound', { loop: loop.name }))
  }

  for (const step of flow.steps) if (names.has(flow.start) && !fromStart.has(step.name)) warn(t('flows.problem.unreachable', { step: step.name }))
  return out
}

// ---- runs ----

/** The step kinds a run can carry out in this version; a flow with any other kind is refused before it starts. */
export const FLOW_RUNNABLE_KINDS: readonly FlowStepKind[] = ['turn', 'checks', 'gate']

/** The steps a run can't carry out yet, in the file's order. */
export function unsupportedSteps(flow: Flow): { step: string; kind: FlowStepKind }[] {
  return flow.steps.filter((s) => !FLOW_RUNNABLE_KINDS.includes(s.kind)).map((s) => ({ step: s.name, kind: s.kind }))
}

/** Something a gate shows the person deciding, in words ("Tests failed, Types passed"); `step` names whose answer. */
export interface FlowGateShow {
  kind: 'diff' | 'checks.results' | 'review.findings' | 'step.answer'
  step?: string
  summary: string
}

/** waiting: at a gate. needs-you: an unattended turn asked for something and was stopped. uncertain: Foreman closed mid-run; never retried. */
export type FlowRunState = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'needs-you' | 'stopped' | 'cancelled' | 'uncertain'
export const FLOW_RUN_ACTIVE: readonly FlowRunState[] = ['starting', 'running', 'waiting']
export const isActiveRun = (run: Pick<FlowRun, 'state'>): boolean => FLOW_RUN_ACTIVE.includes(run.state)

export type FlowRunStepState = 'running' | 'completed' | 'failed' | 'waiting' | 'skipped' | 'stopped'

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
  // Minutes this step counted against its loops (a gate counts none).
  minutes?: number
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
  // The loop's steps entered in this iteration; entering one again starts the next iteration.
  visited: string[]
}

/** What a run's approval covers, part by part, so a refusal can say which part changed. */
export interface FlowFingerprint {
  flow: string
  templates: string
  setup: string
  checks: string
  mcp: string
}

export interface FlowRun {
  id: string
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
  // The first message as sent: the run's task, which a step's `task` context carries.
  task?: string
  current?: { step: string; iteration: number }
  steps: FlowRunStep[]
  loops: Record<string, FlowRunLoop>
  // Each loop's steps and bounds as the flow said when the run started, so a run can be shown without its file.
  bounds?: Record<string, { over: string[]; iterations?: number; minutes?: number; cost?: number }>
  // A gate's "Send back" note, carried to the next step's message and then cleared.
  note?: string
  // The gate the note came from, named in the message that carries it.
  noteFrom?: string
}

/** What starting a flow would approve, as the Run dialog shows it. */
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
  personas: string[]
  templates: { name: string; rev?: string; source: 'personal' | 'repo' }[]
  setupScript: string
  checks: { name: string; command: string }[]
  mcpServers: string[]
  integrations: string[]
  // Steps of kinds a run can't carry out yet, and turn steps whose agent isn't Claude: either refuses the run.
  unsupported: { step: string; kind: FlowStepKind }[]
  notClaude: { step: string; agent: string }[]
  // Other reasons it can't start (a template that doesn't exist, a loadout slot that isn't set).
  problems: string[]
}

export interface FlowRunPreview {
  fingerprint: FlowFingerprint
  summary: FlowRunSummary
  // The values a run asks for: the flow's [inputs] and its templates' {{placeholders}}.
  inputs: { name: string; description: string }[]
}

export interface FlowRunStart {
  flowId: string
  source?: FlowSource
  repoId: string
  baseBranch: string
  inputs: Record<string, string>
  // The fingerprint the caller showed; the run is refused when it is no longer what would run.
  shown: FlowFingerprint
}

/** The active run a workspace belongs to, else its latest run. */
export function runForWorkspace(runs: readonly FlowRun[] | undefined, workspaceId: string): FlowRun | undefined {
  const mine = (runs ?? []).filter((r) => r.workspaceId === workspaceId)
  return mine.find(isActiveRun) ?? mine.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)
}

/** The loops spanning the run's current step with their bounds: "iteration 2 of at most 4 · 18 of 45 min" as numbers. */
export function currentLoopBounds(run: FlowRun): { loop: string; pass: number; iteration: number; maxIterations?: number; minutes: number; maxMinutes?: number }[] {
  const at = run.current?.step
  if (!at) return []
  return Object.entries(run.bounds ?? {})
    .filter(([name, b]) => b.over.includes(at) && run.loops[name]?.open)
    .map(([name, b]) => ({ loop: name, pass: run.loops[name].pass, iteration: run.loops[name].iterations, maxIterations: b.iterations, minutes: Math.floor(run.loops[name].minutesUsed), maxMinutes: b.minutes }))
}
