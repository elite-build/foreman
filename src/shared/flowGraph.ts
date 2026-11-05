// Four graphs over one flow (docs/loops-and-graphs.md, "Four graphs over one flow" and "Showing a graph"): the run
// graph (steps and the facts between them), the context graph (what each step was shown), the memory graph (what
// outlives a step, who reads and writes it) and the data graph (which tree each step started from and ended on). Each is
// drawn from the flow file and, for a run, from the records its steps kept; flowMermaid turns one into Mermaid source
// for the renderer's existing diagram renderer and `foreman flow show --mermaid`. Pure: nothing here reads a file.
import { MODELS } from './agents'
import { FLOW_DONE, stepPersona, type Flow, type FlowEdge, type FlowLoop, type FlowRun, type FlowRunStep, type FlowStep, type FlowStepKind } from './flows'
import { createT, type Locale, type PlainKey, type TFunction } from './i18n'
import { formatCompact } from './i18n/time'
import { memoryLabel } from './memoryPaths'

const enT = createT('en')

export const FLOW_LENSES = ['run', 'context', 'memory', 'data'] as const
export type FlowLens = (typeof FLOW_LENSES)[number]

export type FlowNodeState = FlowRunStep['state'] | 'not-yet'

export interface FlowGraphNode {
  id: string
  kind: 'step' | 'source' | 'memory' | 'tree' | 'end'
  label: string
  // Lines under the label, separated by "\n" (who runs it, its state, what the lens adds).
  sublabel?: string
  stepKind?: FlowStepKind
  state?: FlowNodeState
  persona?: string
  model?: string
  // The loops spanning it.
  loops: string[]
  // How many times it ran in the run.
  runs?: number
  // Context lens: the window at the end of its latest turn, and the window at the end of each turn it ran, in order.
  usage?: { used: number; limit: number }
  series?: number[]
  // Data lens: its latest start tree isn't where the step before it ended.
  moved?: boolean
}

export interface FlowGraphEdge {
  from: string
  to: string
  label?: string
  kind: 'fact' | 'shown' | 'read' | 'write' | 'tree'
  // With a run: true when it happened, false when it didn't (yet). Without a run: undefined.
  taken?: boolean
  // A data edge into a step whose tree moved.
  moved?: boolean
  // Lineage (shared/lineage.ts): inferred from message text or timing rather than read from a record; drawn dashed.
  reconstructed?: boolean
}

export interface FlowGraphLoop {
  name: string
  over: string[]
  // The loop with its bounds and how far the run got, in words, for the ring's title.
  title: string
  pass?: number
  iterations?: number
  maxIterations?: number
  minutes?: number
  maxMinutes?: number
  cost?: number
  maxCost?: number
}

export interface FlowGraph {
  lens: FlowLens
  // "<flow> · <lens>", for the picture's title.
  title: string
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
  loops: FlowGraphLoop[]
}

export interface FlowGraphOptions {
  t?: TFunction
  locale?: Locale
  // Workspace id → its name, for the data lens's workspace nodes.
  workspaceNames?: Record<string, string>
}

/** A state as a glyph, so the diagram never shows state by colour (it has none) or shape alone. */
export const FLOW_STATE_GLYPH: Record<FlowNodeState, string> = {
  completed: '●',
  failed: '◆',
  'not-yet': '◌',
  running: '◐',
  waiting: '▲',
  stopped: '■',
  skipped: '○'
}

const STATE_WORD: Record<FlowNodeState, PlainKey> = {
  completed: 'flowGraph.state.completed',
  failed: 'flowGraph.state.failed',
  'not-yet': 'flowGraph.state.notYet',
  running: 'flowGraph.state.running',
  waiting: 'flowGraph.state.waiting',
  stopped: 'flowGraph.state.stopped',
  skipped: 'flowGraph.state.skipped'
}

export const LENS_WORD: Record<FlowLens, PlainKey> = {
  run: 'flowGraph.lens.run',
  context: 'flowGraph.lens.context',
  memory: 'flowGraph.lens.memory',
  data: 'flowGraph.lens.data'
}

const END_WORD: Partial<Record<FlowRun['state'], PlainKey>> = {
  failed: 'flowGraph.end.failed',
  stopped: 'flowGraph.end.stopped',
  cancelled: 'flowGraph.end.stopped',
  'needs-you': 'flowGraph.end.needsYou',
  uncertain: 'flowGraph.end.uncertain'
}

/** A state in words with its glyph: "● completed". */
export function stateText(state: FlowNodeState, t: TFunction = enT): string {
  return `${FLOW_STATE_GLYPH[state]} ${t(STATE_WORD[state])}`
}

/** A step's start and end trees, whichever record shape it has (a run from before kept a review's tree as a string). */
export function stepTrees(step: Pick<FlowRunStep, 'tree'>): { start?: string; end?: string } {
  const tree = step.tree as FlowRunStep['tree'] | string | undefined
  if (typeof tree === 'string') return tree ? { start: tree } : {}
  return tree ?? {}
}

/** "4m 02s", "42s", "1h 05m". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A model id as its people name ("claude-opus-5-5" → "Opus 5.5"), else the id. */
export function modelWords(model: string): string {
  const bare = (id: string) => id.replace(/\[1m\]$/i, '')
  return MODELS.find((m) => m.id === model || bare(m.id) === bare(model))?.label ?? model
}

const isAgentKind = (kind: FlowStepKind) => kind === 'turn' || kind === 'review' || kind === 'decide'
const READS_TREE: readonly FlowStepKind[] = ['checks', 'review', 'script']
// What the step record says it was shown when a gate's note led its message.
const GATE_NOTE = 'note from you'

/** The graph's model: the flow file's, or (without one) what the run's records say. Edges are null when unknown. */
interface Model {
  flow?: Flow
  name: string
  start?: string
  steps: FlowStep[]
  edges: Record<string, FlowEdge> | null
  loops: FlowLoop[]
}

function modelOf(flow: Flow | undefined, run: FlowRun | undefined): Model {
  if (flow) return { flow, name: flow.name, start: flow.start, steps: flow.steps, edges: flow.edges, loops: flow.loops }
  const steps: FlowStep[] = []
  for (const r of run?.steps ?? []) if (!steps.some((s) => s.name === r.name)) steps.push({ name: r.name, kind: r.kind } as FlowStep)
  const loops: FlowLoop[] = Object.entries(run?.bounds ?? {}).map(([name, b]) => ({ name, over: b.over, at_most: { iterations: b.iterations, minutes: b.minutes, cost: b.cost } }))
  return { name: run?.flow.name ?? '', start: run?.steps[0]?.name, steps, edges: null, loops }
}

const stepId = (name: string) => `step:${name}`
const DONE_ID = 'end:done'
const ENDED_ID = 'end:ended'

/**
 * The graph a lens draws over a flow and, when given, one of its runs. Without the flow (its file changed or is gone)
 * the run's records stand in for it: the steps that ran and the facts they went on by.
 */
export function flowGraph(flow: Flow | undefined, run: FlowRun | undefined, lens: FlowLens, options: FlowGraphOptions = {}): FlowGraph {
  const t = options.t ?? enT
  const locale = options.locale ?? 'en'
  const m = modelOf(flow, run)
  const records = (name: string) => run?.steps.filter((s) => s.name === name) ?? []
  const compact = (n: number) => formatCompact(n, locale)
  const nodes: FlowGraphNode[] = []
  const edges: FlowGraphEdge[] = []
  const node = (n: FlowGraphNode) => {
    if (!nodes.some((x) => x.id === n.id)) nodes.push(n)
  }
  const edge = (e: FlowGraphEdge) => {
    const same = edges.find((x) => x.from === e.from && x.to === e.to && x.kind === e.kind && x.label === e.label)
    if (!same) edges.push(e)
    else if (e.taken) same.taken = true
  }
  const ran = (name: string) => records(name).length > 0
  const takenIf = (happened: boolean) => (run ? happened : undefined)

  // ---- the steps, in every lens ----
  for (const step of m.steps) {
    const mine = records(step.name)
    const latest = mine.at(-1)
    const state: FlowNodeState | undefined = latest?.state ?? (run ? 'not-yet' : undefined)
    const persona = latest?.persona ?? (m.flow ? stepPersona(m.flow, step) : undefined)
    const model = latest?.model ?? ('model' in step && step.model ? step.model : undefined)
    const loops = m.loops.filter((l) => l.over.includes(step.name)).map((l) => l.name)
    const lines: string[] = []
    const who = [step.kind !== 'turn' ? step.kind : undefined, persona, model ? modelWords(model) : undefined].filter(Boolean)
    if (who.length) lines.push(`· ${who.join(' · ')}`)
    if (state) {
      const took = latest?.endedAt ? Date.parse(latest.endedAt) - Date.parse(latest.startedAt) : undefined
      lines.push([stateText(state, t), took !== undefined && Number.isFinite(took) ? durationWords(took) : undefined, mine.length > 1 ? t('flowGraph.runs', { count: mine.length }) : undefined].filter(Boolean).join(' · '))
    }
    const usages = mine.filter((r) => r.usage).map((r) => r.usage!)
    const usage = usages.at(-1)
    const trees = latest ? stepTrees(latest) : {}
    if (lens === 'context' && usage) {
      const series = usages.length > 1 ? usages.map((u) => compact(u.used)).join(' → ') : compact(usage.used)
      lines.push(t('flowGraph.usage', { used: series, limit: compact(usage.limit) }))
    }
    if (lens === 'data' && (trees.start || trees.end)) {
      lines.push(`${trees.start ? trees.start.slice(0, 7) : '?'} → ${trees.end ? trees.end.slice(0, 7) : trees.start ? trees.start.slice(0, 7) : '?'}${latest?.moved ? ` · ${t('flowGraph.edge.moved')}` : ''}`)
    }
    node({
      id: stepId(step.name),
      kind: 'step',
      label: step.name,
      ...(lines.length ? { sublabel: lines.join('\n') } : {}),
      stepKind: step.kind,
      ...(state ? { state } : {}),
      ...(persona ? { persona } : {}),
      ...(model ? { model } : {}),
      loops,
      ...(mine.length ? { runs: mine.length } : {}),
      ...(usage ? { usage } : {}),
      ...(usages.length ? { series: usages.map((u) => u.used) } : {}),
      ...(latest?.moved ? { moved: true } : {})
    })
  }

  if (lens === 'run') runEdges(m, run, t, node, edge)
  else if (lens === 'context') contextEdges(m, run, node, edge, takenIf, t)
  else if (lens === 'memory') memoryEdges(m, run, node, edge, takenIf, ran, t)
  else dataEdges(m, run, node, edge, t, options.workspaceNames ?? {})

  const loops: FlowGraphLoop[] = m.loops.map((loop) => {
    const pass = run?.loops[loop.name]
    const bound = run?.bounds?.[loop.name]
    const maxIterations = bound?.iterations ?? loop.at_most.iterations
    const maxMinutes = bound?.minutes ?? loop.at_most.minutes
    const maxCost = bound?.cost ?? loop.at_most.cost
    const inLoop = (run?.steps ?? []).filter((s) => s.loops?.[loop.name] !== undefined)
    const iterations = run ? (pass?.iterations ?? (inLoop.length ? Math.max(...inLoop.map((s) => s.loops![loop.name])) : 0)) : undefined
    const minutes = run ? Math.floor(pass ? pass.minutesUsed : inLoop.reduce((n, s) => n + (s.minutes ?? 0), 0)) : undefined
    const parts = [loop.name]
    if (pass && pass.pass > 1) parts.push(t('flowGraph.loop.pass', { pass: pass.pass }))
    if (iterations) parts.push(maxIterations !== undefined ? t('flowGraph.loop.iterationOf', { iteration: iterations, max: maxIterations }) : t('flowGraph.loop.iteration', { iteration: iterations }))
    else if (maxIterations !== undefined) parts.push(t('flowGraph.loop.atMostIterations', { max: maxIterations }))
    if (maxMinutes !== undefined) parts.push(minutes !== undefined ? t('flowGraph.loop.minutesOf', { minutes, max: maxMinutes }) : t('flowGraph.loop.atMostMinutes', { max: maxMinutes }))
    if (maxCost !== undefined) parts.push(run ? t('flowGraph.loop.costOf', { cost: (pass?.costUsed ?? 0).toFixed(2), max: maxCost.toFixed(2) }) : t('flowGraph.loop.atMostCost', { max: maxCost.toFixed(2) }))
    return {
      name: loop.name,
      over: [...loop.over],
      title: parts.join(' · '),
      ...(pass ? { pass: pass.pass } : {}),
      ...(iterations !== undefined ? { iterations } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
      ...(maxMinutes !== undefined ? { maxMinutes } : {}),
      ...(pass?.costUsed ? { cost: pass.costUsed } : {}),
      ...(maxCost !== undefined ? { maxCost } : {})
    }
  })

  return { lens, title: t('flowGraph.title', { flow: m.name, lens: t(LENS_WORD[lens]) }), nodes, edges, loops }
}

type AddNode = (n: FlowGraphNode) => void
type AddEdge = (e: FlowGraphEdge) => void

/** Run lens: the facts between steps; taken where the run went that way, the end it reached. */
function runEdges(m: Model, run: FlowRun | undefined, t: TFunction, node: AddNode, edge: AddEdge): void {
  const declared: { from: string; to: string; facts: string[] }[] = []
  const add = (from: string, to: string, fact?: string) => {
    const at = declared.find((d) => d.from === from && d.to === to)
    if (at) {
      if (fact) at.facts.push(fact)
    } else declared.push({ from, to, facts: fact ? [fact] : [] })
  }
  if (m.edges)
    for (const step of m.steps) {
      const out = m.edges[step.name]
      if (out === undefined) add(step.name, FLOW_DONE)
      else if (typeof out === 'string') add(step.name, out)
      else for (const [fact, to] of Object.entries(out)) add(step.name, to, fact)
    }
  // What the run did: each step to the next, by the fact the first ended with, and the end it reached.
  const went: { from: string; to: string; fact?: string }[] = []
  const steps = run?.steps ?? []
  for (let i = 0; i + 1 < steps.length; i++) went.push({ from: steps[i].name, to: steps[i + 1].name, fact: steps[i].fact })
  const last = steps.at(-1)
  if (run && last && run.state === 'completed') went.push({ from: last.name, to: FLOW_DONE, fact: last.fact })
  const endWord = run ? END_WORD[run.state] : undefined
  if (run && last && endWord) went.push({ from: last.name, to: ENDED_ID, fact: last.fact })

  const target = (to: string) => (to === FLOW_DONE ? DONE_ID : to === ENDED_ID ? ENDED_ID : stepId(to))
  if (declared.some((d) => d.to === FLOW_DONE) || went.some((w) => w.to === FLOW_DONE)) node({ id: DONE_ID, kind: 'end', label: t('flowGraph.end.done'), loops: [] })
  if (endWord) node({ id: ENDED_ID, kind: 'end', label: t(endWord), loops: [] })
  for (const d of declared) {
    edge({ from: stepId(d.from), to: target(d.to), kind: 'fact', ...(d.facts.length ? { label: d.facts.join(' / ') } : {}), ...(run ? { taken: went.some((w) => w.from === d.from && w.to === d.to) } : {}) })
  }
  // A move the file doesn't have (it changed since, or there is no file): drawn from the record, as taken.
  for (const w of went) {
    if (declared.some((d) => d.from === w.from && d.to === w.to)) continue
    edge({ from: stepId(w.from), to: target(w.to), kind: 'fact', ...(w.fact ? { label: w.fact } : {}), taken: true })
  }
}

/** The refs a step declares (its context, a gate's show) and the ones its records say it was shown. */
function refsOf(step: FlowStep, mine: FlowRunStep[]): { declared: string[]; shown: string[] } {
  const declared = [...('context' in step ? (step.context ?? []) : []), ...(step.kind === 'gate' ? (step.show ?? []) : [])]
  const shown = [...new Set(mine.flatMap((r) => r.shown ?? []))]
  return { declared, shown }
}

/** Context lens: each source a step is shown, declared (the file) or as sent (the receipts), and who produced it. */
function contextEdges(m: Model, run: FlowRun | undefined, node: AddNode, edge: AddEdge, takenIf: (b: boolean) => boolean | undefined, t: TFunction): void {
  const sourceId = (ref: string) => `src:${ref}`
  const addSource = (ref: string) => {
    const revisions = ref === 'note' ? [...new Set((run?.steps ?? []).filter((r) => r.noteRevision !== undefined).map((r) => `r${r.noteRevision}`))] : []
    node({ id: sourceId(ref), kind: 'source', label: ref === GATE_NOTE ? t('flowGraph.source.gateNote') : ref, ...(revisions.length ? { sublabel: t('flowGraph.memory.revisions', { revisions: revisions.join(', ') }) } : {}), loops: [] })
  }
  for (const step of m.steps) {
    const mine = run?.steps.filter((s) => s.name === step.name) ?? []
    const { declared, shown } = refsOf(step, mine)
    for (const ref of [...new Set([...declared, ...shown])]) {
      addSource(ref)
      edge({ from: sourceId(ref), to: stepId(step.name), kind: 'shown', ...(run ? { taken: shown.includes(ref) } : {}) })
    }
  }
  // Who produced each step's output source: `<step>.answer`, `.findings`, `.output`, and the check results.
  for (const ref of [...new Set(m.steps.flatMap((s) => [...refsOf(s, []).declared, ...(run?.steps.filter((r) => r.name === s.name).flatMap((r) => r.shown ?? []) ?? [])]))]) {
    const producers = ref === 'checks.results' ? m.steps.filter((s) => s.kind === 'checks').map((s) => s.name) : /\.(answer|findings|output)$/.test(ref) ? [ref.slice(0, ref.lastIndexOf('.'))] : []
    for (const from of producers) {
      if (!m.steps.some((s) => s.name === from)) continue
      edge({ from: stepId(from), to: sourceId(ref), kind: 'write', ...(run ? { taken: takenIf(run.steps.some((r) => r.name === from && r.state === 'completed')) } : {}) })
    }
  }
}

/** Memory lens: the run ledger, the note, standing instructions, personas, memory files and reports; reads and writes. */
function memoryEdges(m: Model, run: FlowRun | undefined, node: AddNode, edge: AddEdge, takenIf: (b: boolean) => boolean | undefined, ran: (name: string) => boolean, t: TFunction): void {
  const recs = (name: string) => run?.steps.filter((s) => s.name === name) ?? []
  const fresh = new Set(m.loops.filter((l) => l.iteration === 'fresh-with-summary').flatMap((l) => l.over))
  const agentSteps = m.steps.filter((s) => isAgentKind(s.kind))
  // The run ledger: read by a step shown it, or by every pass of a loop that starts fresh; only Foreman writes it.
  const ledgerReaders = m.steps.filter((s) => refsOf(s, recs(s.name)).declared.includes('ledger') || fresh.has(s.name) || recs(s.name).some((r) => r.shown?.includes('ledger')))
  if (ledgerReaders.length) {
    node({ id: 'mem:ledger', kind: 'memory', label: t('flowGraph.memory.ledger'), sublabel: t('flowGraph.memory.ledgerNote'), loops: [] })
    for (const s of ledgerReaders) edge({ from: 'mem:ledger', to: stepId(s.name), kind: 'read', ...(run ? { taken: recs(s.name).some((r) => r.shown?.includes('ledger')) } : {}) })
  }
  // The workspace note: human-owned; the revision each step saw.
  const noteReaders = m.steps.filter((s) => refsOf(s, recs(s.name)).declared.includes('note') || recs(s.name).some((r) => r.shown?.includes('note')))
  if (noteReaders.length) {
    const revisions = [...new Set((run?.steps ?? []).filter((r) => r.noteRevision !== undefined).map((r) => `r${r.noteRevision}`))]
    node({ id: 'mem:note', kind: 'memory', label: t('flowGraph.memory.note'), ...(revisions.length ? { sublabel: t('flowGraph.memory.revisions', { revisions: revisions.join(', ') }) } : {}), loops: [] })
    for (const s of noteReaders) {
      const seen = [...new Set(recs(s.name).filter((r) => r.noteRevision !== undefined).map((r) => `r${r.noteRevision}`))]
      edge({ from: 'mem:note', to: stepId(s.name), kind: 'read', ...(seen.length ? { label: seen.join(', ') } : {}), ...(run ? { taken: recs(s.name).some((r) => r.shown?.includes('note')) } : {}) })
    }
  }
  // The repository's standing instructions: every agent turn starts from them.
  if (agentSteps.length) {
    node({ id: 'mem:instructions', kind: 'memory', label: t('flowGraph.memory.instructions'), loops: [] })
    for (const s of agentSteps) edge({ from: 'mem:instructions', to: stepId(s.name), kind: 'read', ...(run ? { taken: takenIf(ran(s.name)) } : {}) })
  }
  // Personas: who a step is, read at each of its turns.
  for (const s of m.steps) {
    const persona = recs(s.name).at(-1)?.persona ?? (m.flow ? stepPersona(m.flow, s) : undefined)
    if (!persona) continue
    node({ id: `mem:persona:${persona}`, kind: 'memory', label: t('flowGraph.memory.persona', { name: persona }), loops: [] })
    edge({ from: `mem:persona:${persona}`, to: stepId(s.name), kind: 'read', ...(run ? { taken: takenIf(ran(s.name)) } : {}) })
  }
  // Memory files: read where the agent's breakdown named them, written where a turn's changes touched them.
  const files: { id: string; path: string }[] = []
  const fileId = (path: string): string => {
    const p = path.replace(/\\/g, '/')
    const known = files.find((f) => f.path === p || f.path.endsWith(`/${p}`) || p.endsWith(`/${f.path}`))
    if (known) return known.id
    const id = `mem:file:${files.length}`
    files.push({ id, path: p })
    node({ id, kind: 'memory', label: memoryLabel(p), sublabel: t('flowGraph.memory.file'), loops: [] })
    return id
  }
  for (const r of run?.steps ?? []) {
    for (const path of r.memoryFiles ?? []) edge({ from: fileId(path), to: stepId(r.name), kind: 'read', taken: true })
    for (const path of r.memoryWrites ?? []) edge({ from: stepId(r.name), to: fileId(path), kind: 'write', label: t('flowGraph.edge.wrote', { who: r.persona ?? r.name, file: memoryLabel(path) }), taken: true })
  }
  // Reports: the agent's writes to Foreman (`done` chose the edge, a decide's choice).
  const reporting = m.steps.filter((s) => s.kind === 'decide' || (m.edges && typeof m.edges[s.name] === 'object' && Object.hasOwn(m.edges[s.name] as object, 'reports')))
  const reported = (run?.steps ?? []).filter((r) => r.fact === 'reports' || (r.kind === 'decide' && r.fact && r.fact !== 'undecided'))
  if (reporting.length || reported.length) {
    node({ id: 'mem:reports', kind: 'memory', label: t('flowGraph.memory.reports'), loops: [] })
    for (const s of reporting) edge({ from: stepId(s.name), to: 'mem:reports', kind: 'write', label: t('flowGraph.edge.reported'), ...(run ? { taken: reported.some((r) => r.name === s.name) } : {}) })
    for (const r of reported) edge({ from: stepId(r.name), to: 'mem:reports', kind: 'write', label: t('flowGraph.edge.reported'), taken: true })
  }
}

/** Data lens: the base branch, the workspaces the run made, each step's start and end trees, the pull request a wait read. */
function dataEdges(m: Model, run: FlowRun | undefined, node: AddNode, edge: AddEdge, t: TFunction, names: Record<string, string>): void {
  node({ id: 'tree:base', kind: 'tree', label: run ? t('flowGraph.data.base', { branch: run.baseBranch }) : t('flowGraph.data.baseBranch'), loops: [] })
  const wsId = (id: string) => `ws:${id}`
  const prSteps = m.steps.filter((s) => s.kind === 'wait')
  if (prSteps.length) node({ id: 'pr', kind: 'tree', label: t('flowGraph.data.pr'), loops: [] })
  for (const s of prSteps) edge({ from: 'pr', to: stepId(s.name), kind: 'read', label: t('flowGraph.edge.read'), ...(run ? { taken: run.steps.some((r) => r.name === s.name) } : {}) })
  const from = (s: FlowStep) => (s.kind === 'workspace' && s.from && s.from !== 'base' ? stepId(s.from) : 'tree:base')
  if (!run) {
    if (m.start) edge({ from: 'tree:base', to: stepId(m.start), kind: 'tree' })
    for (const s of m.steps) if (s.kind === 'workspace') edge({ from: from(s), to: stepId(s.name), kind: 'tree', label: t('flowGraph.edge.made') })
    return
  }
  const workspaces = [...new Set([...(run.workspaces ?? []), ...(run.workspaceId ? [run.workspaceId] : [])])]
  workspaces.forEach((id, i) => {
    node({ id: wsId(id), kind: 'tree', label: t('flowGraph.data.workspace', { name: names[id] ?? id.slice(0, 8) }), loops: [] })
    const maker = run.steps.find((r) => r.kind === 'workspace' && r.workspaceId === id)
    if (maker) {
      const step = m.steps.find((s) => s.name === maker.name)
      edge({ from: step ? from(step) : 'tree:base', to: stepId(maker.name), kind: 'tree', taken: true })
      edge({ from: stepId(maker.name), to: wsId(id), kind: 'tree', label: t('flowGraph.edge.made'), taken: true })
    } else if (i === 0) edge({ from: 'tree:base', to: wsId(id), kind: 'tree', label: t('flowGraph.edge.made'), taken: true })
  })
  const seenIn = new Set<string>()
  for (const r of run.steps) {
    const ws = r.workspaceId ?? run.workspaceId
    const first = ws !== undefined && !seenIn.has(ws)
    if (ws) seenIn.add(ws)
    const { start, end } = stepTrees(r)
    if (start) {
      const id = `tree:${start}`
      node({ id, kind: 'tree', label: t('flowGraph.data.tree', { hash: start.slice(0, 7) }), loops: [] })
      const label = r.moved ? t('flowGraph.edge.moved') : READS_TREE.includes(r.kind) ? t('flowGraph.edge.read') : undefined
      edge({ from: id, to: stepId(r.name), kind: 'tree', ...(label ? { label } : {}), taken: true, ...(r.moved ? { moved: true } : {}) })
    } else if (first && ws && r.kind !== 'workspace') edge({ from: wsId(ws), to: stepId(r.name), kind: 'tree', taken: true })
    if (end && r.kind !== 'workspace') {
      const id = `tree:${end}`
      node({ id, kind: 'tree', label: t('flowGraph.data.tree', { hash: end.slice(0, 7) }), loops: [] })
      edge({ from: stepId(r.name), to: id, kind: 'tree', taken: true })
    }
  }
}

// ---- Mermaid ----

/** Kept under the renderer's limit (mermaidSource.ts MERMAID_MAX_CHARS), so a flow's diagram is never refused for size. */
export const FLOW_MERMAID_MAX_CHARS = 20_000

/**
 * Text for a Mermaid label, safe inside quotes: every character Mermaid reads as syntax (quotes, brackets, braces, pipes,
 * angle brackets, backticks, `#` and `;`) becomes its entity code, and line breaks become spaces.
 */
export function mermaidLabel(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[#;"'`<>[\]{}()|&\\]/g, (c) => `#${c.charCodeAt(0)};`)
}

const edgeLabel = (text: string) => (/^[\p{L}\p{N} ._·/-]+$/u.test(text) && !/^\s|\s$/.test(text) ? text : `"${mermaidLabel(text)}"`)

function shape(n: FlowGraphNode, text: string): string {
  if (n.kind === 'end') return `(["${text}"])`
  if (n.kind === 'source') return `[["${text}"]]`
  if (n.kind === 'memory') return `[("${text}")]`
  if (n.kind === 'tree') return `>"${text}"]`
  if (n.stepKind === 'gate' || n.stepKind === 'pick') return `{{"${text}"}}`
  if (n.stepKind === 'decide') return `{"${text}"}`
  return `["${text}"]`
}

function mermaidOf(graph: FlowGraph, compact: boolean): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]))
  const lines = ['flowchart LR', `  accTitle: ${graph.title.replace(/[\r\n]+/g, ' ')}`]
  const declare = (n: FlowGraphNode, indent: string) => {
    const parts = [n.label, ...(!compact && n.sublabel ? n.sublabel.split('\n') : [])]
    lines.push(`${indent}${ids.get(n.id)}${shape(n, parts.map(mermaidLabel).join('<br/>'))}`)
  }
  // Loops as rings: a loop inside another (its steps a subset) nests; a step in two loops that don't nest is in the first.
  const placed = new Set<string>()
  const loops = graph.loops.filter((l) => l.over.length)
  const inside = (a: FlowGraphLoop, b: FlowGraphLoop) => a !== b && a.over.every((s) => b.over.includes(s)) && (a.over.length < b.over.length || loops.indexOf(a) > loops.indexOf(b))
  const parentOf = (l: FlowGraphLoop) => loops.filter((o) => inside(l, o)).sort((a, b) => a.over.length - b.over.length)[0]
  const emitLoop = (loop: FlowGraphLoop, indent: string) => {
    lines.push(`${indent}subgraph L${loops.indexOf(loop)} ["${mermaidLabel(compact ? loop.name : loop.title)}"]`)
    for (const child of loops.filter((o) => parentOf(o) === loop)) emitLoop(child, `${indent}  `)
    for (const name of loop.over) {
      const n = graph.nodes.find((x) => x.id === stepId(name))
      if (!n || placed.has(n.id)) continue
      placed.add(n.id)
      declare(n, `${indent}  `)
    }
    lines.push(`${indent}end`)
  }
  for (const loop of loops) if (!parentOf(loop)) emitLoop(loop, '  ')
  for (const n of graph.nodes) if (!placed.has(n.id)) declare(n, '  ')
  for (const e of graph.edges) {
    const from = ids.get(e.from)
    const to = ids.get(e.to)
    if (!from || !to) continue
    const arrow = e.taken === false || e.reconstructed ? '-.->' : '-->'
    lines.push(`  ${from} ${arrow}${!compact && e.label ? `|${edgeLabel(e.label)}|` : ''} ${to}`)
  }
  return lines.join('\n')
}

/**
 * The graph as Mermaid flowchart source: left to right, loops as subgraphs titled with their bounds, a gate or pick as a
 * hexagon, a decide as a rhombus, the ends as stadiums, sources as files, memory as cylinders and trees as flags; edges
 * not taken (yet) dotted. No colours: the renderer themes it, and state is a glyph and a word. Kept under
 * FLOW_MERMAID_MAX_CHARS: a graph too big with its lines drops them, then everything but its steps.
 */
export function flowMermaid(graph: FlowGraph): string {
  const full = mermaidOf(graph, false)
  if (full.length <= FLOW_MERMAID_MAX_CHARS) return full
  const short = mermaidOf(graph, true)
  if (short.length <= FLOW_MERMAID_MAX_CHARS) return short
  const keep = new Set(graph.nodes.filter((n) => n.kind === 'step' || n.kind === 'end').map((n) => n.id))
  const steps = mermaidOf({ ...graph, nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) }, true)
  return steps.length <= FLOW_MERMAID_MAX_CHARS ? steps : steps.slice(0, steps.lastIndexOf('\n', FLOW_MERMAID_MAX_CHARS))
}
