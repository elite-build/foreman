// `foreman flow …`: flows (docs/loops-and-graphs.md) from the command line, behind Settings → Experimental → Flows like the
// window's Flows section. Starting a run approves what it will do, so `flow-run` without `shown` answers with the same
// approval summary the Run dialog shows, and with the fingerprint sent back it starts exactly that: the service refuses
// when it changed meanwhile. A gate is answered with `foreman approve <id> --continue | --send-back | --stop`, a pick with
// `foreman approve <id> --pick <step>` (approvals.ts).
import { flowSummary, isActiveRun, parseFlow, type FlowFingerprint, type FlowListing, type FlowPersonaRef, type FlowRun, type FlowRunPreview, type FlowRunSummary } from '../../shared/flows'
import { flowGraph, flowMermaid } from '../../shared/flowGraph'
import { formatCompact } from '../../shared/i18n/time'
import { memoryLabel } from '../../shared/memoryPaths'
import { FLOW_STATUS_LENSES, flowEndText, flowStepText, gateWaitText, pickWaitText, type FlowAddResult, type FlowListResult, type FlowLoopRow, type FlowRemoveResult, type FlowRow, type FlowRunPreviewResult, type FlowRunResult, type FlowRunRow, type FlowRunsResult, type FlowShowResult, type FlowStatusResult, type FlowStopResult, type FlowWaitResult } from '../../shared/cli/flows'
import type { Api, ApprovalRequest, Repo, Workspace } from '../../shared/types'
import { notClaudeProblem } from '../flows'
import { SHOWN_CHANGED } from '../schedules'
import type { CliHost } from './host'
import { CliCodedError } from './host'
import { columns, flagParam, invalid, numberParam, paramsObject, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { durationText, findByRef, firstLine, notFound, refused, utcText } from './refs'
import { resolveRepo } from './resolve'

type GateRequest = Extract<ApprovalRequest, { kind: 'gate' }>
type PickRequest = Extract<ApprovalRequest, { kind: 'pick' }>
// What a run waits on from a person: its gate, or its pick.
type Asks = { gate?: GateRequest; pick?: PickRequest }

const short = (id: string) => id.slice(0, 8)
// How often a wait looks again when no event woke it.
const POLL_MS = 500
// How long `flow-run` waits for the run's workspace before it answers with the run as it is.
const PLACE_MS = 120_000

export const FLOWS_OFF = 'Flows are off; turn them on in Settings → Experimental → Flows.'

/** Every flow method refuses while the switch is off, naming it. */
export function flowsOn(host: CliHost): void {
  if (!host.state().settings.flows) throw refused(FLOWS_OFF, '`foreman settings set experimental.flows on` does the same.')
}

// ---- flows ----

const fileStem = (file: string | undefined) => (file ?? '').replace(/^.*\//, '').replace(/\.toml$/i, '')
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** What a flow answers to: its name, the name's slug, a starter's id and a file's name. */
function flowNames(f: FlowListing): string[] {
  return [f.name, slug(f.name), ...(f.starter ? [f.starter] : []), ...(f.file ? [fileStem(f.file), f.file] : [])]
}

const flowSpec = {
  id: (f: FlowListing) => f.id,
  names: flowNames,
  describe: (f: FlowListing) => `${f.name} (${f.source === 'repo' ? f.file : f.source}, id ${f.id})`
}

export function findFlow(flows: FlowListing[], query: string): FlowListing {
  return findByRef(flows, query, 'flow', flowSpec)
}

/**
 * Why a flow can't start in this repository, in the words a start refuses it with: the run preview's problems
 * (flowRunProblems: where it starts, its loadouts and agents, personas, templates and saved commands). Undefined when it
 * can start, when the file has problems of its own, and when no repository is known (none to read its personas and
 * commands from: a run needs one anyway).
 */
export async function cantRunIn(api: Pick<Api, 'flowRunPreview'>, repos: Repo[], listing: FlowListing, repoId: string | undefined): Promise<string | undefined> {
  const repo = repos.find((r) => r.id === (listing.repoId ?? repoId))
  if (!repo || listing.problems.length) return undefined
  try {
    const { summary } = await api.flowRunPreview({ flowId: listing.id, repoId: repo.id, baseBranch: repo.defaultBranch || 'main' })
    // The preview lists turns on other agents apart from the rest; a start refuses them in these words.
    const problems = [...summary.problems, ...(summary.notClaude.length ? [notClaudeProblem(summary.notClaude)] : [])]
    return problems.length ? problems.join(' ') : undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function flowRow(f: FlowListing, repos: Repo[], cantRun?: string): FlowRow {
  const parsed = f.problems.length ? undefined : parseFlow(f.toml, f.source)
  const flow = parsed && 'flow' in parsed ? parsed.flow : undefined
  const summary = f.summary ?? (flow ? flowSummary(flow) : undefined)
  return {
    id: f.id,
    name: f.name,
    source: f.source,
    ...(f.starter ? { starter: f.starter } : {}),
    ...(f.repoId ? { repo: repos.find((r) => r.id === f.repoId)?.name ?? f.repoId, repoId: f.repoId } : {}),
    ...(f.file ? { file: f.file } : {}),
    ...(f.rev ? { rev: f.rev } : {}),
    ...(summary ? { steps: summary.steps, loops: summary.loops, gates: summary.gates } : {}),
    personas: summary?.personas ?? [],
    problems: f.problems,
    warnings: f.warnings,
    ...(cantRun ? { cantRun } : {})
  }
}

const sourceText = (r: FlowRow) => (r.source === 'repo' ? `repo ${r.repo ?? ''}`.trim() : r.source)
const revText = (r: FlowRow) => (r.source === 'repo' ? (r.rev ?? '').slice(0, 7) : r.source === 'personal' && r.rev ? r.rev.slice(0, 10) : '')

/** The repository a command means, or none: `--repo`, else the one it ran in, else every repository. */
export async function optionalRepo(host: CliHost, p: Record<string, unknown>): Promise<Repo | undefined> {
  const query = textParam(p, 'repo', { optional: true })
  const cwd = textParam(p, 'cwd', { optional: true }) ?? process.cwd()
  if (query?.trim()) return resolveRepo(host.state(), cwd, query)
  return resolveRepo(host.state(), cwd).catch(() => undefined)
}

const list: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<FlowListResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const repo = await optionalRepo(host, p)
    const state = host.state()
    const listings = await host.api.listFlows(repo?.id)
    const rows = await Promise.all(listings.map(async (f) => flowRow(f, state.repos, await cantRunIn(host.api, state.repos, f, repo?.id))))
    if (!rows.length) return { flows: rows, ...(repo ? { repo: repo.name } : {}), text: 'No flows.' }
    const table = columns([
      ['NAME', 'SOURCE', 'FILE', 'REV', 'STEPS', 'LOOPS', 'GATES', 'PERSONAS'],
      ...rows.map((r) => [r.name, sourceText(r), r.file ?? '', revText(r), r.steps === undefined ? '' : String(r.steps), r.loops === undefined ? '' : String(r.loops), r.gates === undefined ? '' : String(r.gates), r.personas.join(', ')])
    ])
    const lines = [table[0]]
    rows.forEach((r, i) => {
      lines.push(table[i + 1])
      for (const problem of r.problems) lines.push(`  problem: ${problem}`)
      if (r.cantRun) lines.push(`  can’t run: ${r.cantRun}`)
    })
    return { flows: rows, ...(repo ? { repo: repo.name } : {}), text: lines.join('\n') }
  }
}

const show: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<FlowShowResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const repo = await optionalRepo(host, p)
    const listing = findFlow(await host.api.listFlows(repo?.id), textParam(p, 'flow'))
    const state = host.state()
    const row = flowRow(listing, state.repos, await cantRunIn(host.api, state.repos, listing, repo?.id))
    if (flagParam(p, 'mermaid')) {
      // The run graph the Flows dialog draws, as Mermaid source; a file that isn't a flow has nothing to draw.
      const parsed = row.problems.length ? undefined : parseFlow(listing.toml, listing.source)
      if (!parsed || !('flow' in parsed)) throw invalid(`“${row.name}” isn’t a flow it can draw: ${(parsed && 'problems' in parsed ? parsed.problems : row.problems).join(' ')}`)
      const mermaid = flowMermaid(flowGraph(parsed.flow, undefined, 'run'))
      return { flow: row, toml: listing.toml, mermaid, text: mermaid }
    }
    const lines = [`${row.name} (${row.source === 'repo' ? `${row.repo}: ${row.file}${row.rev ? ` at ${row.rev.slice(0, 7)}` : ''}` : row.source === 'built-in' ? 'built-in' : 'personal'})`, `id ${row.id}`]
    if (row.steps !== undefined) lines.push(`Steps ${row.steps} · loops ${row.loops} · gates ${row.gates}`)
    // Each persona as found where the flow runs (one that isn't found is among the problems below).
    for (const ref of listing.personas ?? []) lines.push(`Persona ${personaRefText(ref)}`)
    for (const problem of row.problems) lines.push(`Problem: ${problem}`)
    for (const warning of row.warnings) lines.push(`Warning: ${warning}`)
    if (row.cantRun) lines.push(`Can’t run: ${row.cantRun}`)
    return { flow: row, toml: listing.toml, text: `${lines.join('\n')}\n\n${listing.toml.trimEnd()}` }
  }
}

/** The document with its top-level `name` set to `name` (added first when it has none); the rest as written. */
export function withFlowName(toml: string, name: string): string {
  const lines = toml.split(/\r?\n/)
  const header = lines.findIndex((l) => /^\s*\[/.test(l))
  const top = header < 0 ? lines.length : header
  const at = lines.slice(0, top).findIndex((l) => /^\s*name\s*=/.test(l))
  const line = `name = ${JSON.stringify(name)}`
  if (at >= 0) lines[at] = line
  else lines.unshift(line)
  return lines.join('\n')
}

// Saving or deleting a personal flow changes what Foreman will run, so it is admin: never from inside an agent turn. The
// assistant's Run card runs it in process with the app's token, after the user's click.
const add: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<FlowAddResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const name = textParam(p, 'name', { optional: true })?.trim()
    if (name !== undefined && !name) throw invalid('--name needs a name.')
    const toml = name ? withFlowName(textParam(p, 'toml'), name) : textParam(p, 'toml')
    // A clash is only knowable once the document parses; one that doesn't comes back with its problems from the app.
    const parsed = parseFlow(toml, 'personal')
    if ('flow' in parsed) {
      const all = await host.api.listFlows()
      const clash = all.find((f) => f.source === 'personal' && f.name.trim().toLowerCase() === parsed.flow.name.trim().toLowerCase())
      if (clash) throw invalid(`You already have a personal flow named “${clash.name}”.`, 'Save it under another name with --name, or remove the old one first (`foreman flow remove`).')
    }
    const saved = await host.api.savePersonalFlow({ toml })
    if ('problems' in saved) return { saved: false, problems: saved.problems, text: [`Not saved: the flow has ${saved.problems.length === 1 ? 'a problem' : 'problems'}.`, ...saved.problems.map((x) => `  ${x}`)].join('\n') }
    const state = host.state()
    // Whether it can start in the repository this ran in, as `flow run` there would say.
    const here = await optionalRepo(host, p)
    const row = flowRow(saved.flow, state.repos, await cantRunIn(host.api, state.repos, saved.flow, here?.id))
    const notes = [...row.warnings.map((w) => `  warning: ${w}`), ...(row.cantRun ? [`  can’t run yet: ${row.cantRun}`] : [])]
    return { saved: true, flow: row, text: [`Saved the personal flow “${row.name}” (id ${row.id}).`, ...notes].join('\n') }
  }
}

const remove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<FlowRemoveResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const listing = findFlow(await host.api.listFlows(), textParam(p, 'flow'))
    if (listing.source !== 'personal') throw refused(`Only personal flows can be removed here; “${listing.name}” is ${listing.source === 'built-in' ? 'built into Foreman' : `the repository file ${listing.file}`}.`)
    await host.api.deletePersonalFlow(listing.id)
    const state = host.state()
    return { removed: flowRow(listing, state.repos), text: `Removed the personal flow “${listing.name}”. Its past runs stay listed.` }
  }
}

// ---- runs ----

function loopRows(run: FlowRun): FlowLoopRow[] {
  return Object.entries(run.bounds ?? {}).map(([loop, b]) => {
    const pass = run.loops[loop]
    const inLoop = run.steps.filter((s) => s.loops?.[loop] !== undefined)
    return {
      loop,
      ...(pass && pass.pass > 1 ? { pass: pass.pass } : {}),
      iterations: pass?.iterations ?? Math.max(0, ...inLoop.map((s) => s.loops![loop])),
      ...(b.iterations !== undefined ? { maxIterations: b.iterations } : {}),
      minutes: Math.floor(pass ? pass.minutesUsed : inLoop.reduce((n, s) => n + (s.minutes ?? 0), 0)),
      ...(b.minutes !== undefined ? { maxMinutes: b.minutes } : {}),
      ...(pass?.costUsed ? { cost: pass.costUsed } : {}),
      ...(b.cost !== undefined ? { maxCost: b.cost } : {})
    }
  })
}

export function runRow(run: FlowRun, state: { repos: Repo[]; workspaces: Workspace[] }, asks: Asks = {}): FlowRunRow {
  const { gate, pick } = asks
  const ws = run.workspaceId ? state.workspaces.find((w) => w.id === run.workspaceId) : undefined
  const name = (id: string) => state.workspaces.find((w) => w.id === id)?.name ?? '(removed)'
  const many = (run.workspaces?.length ?? 0) > 1
  return {
    id: run.id,
    flow: run.flow.name,
    flowId: run.flow.id,
    source: run.flow.source,
    repo: state.repos.find((r) => r.id === run.repoId)?.name ?? run.repoId,
    repoId: run.repoId,
    base: run.baseBranch,
    state: run.state,
    ...(run.reason ? { reason: run.reason } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.workspaceId ? { workspace: { id: run.workspaceId, name: ws?.name ?? '(removed)' } } : {}),
    ...(many ? { workspaces: run.workspaces!.map((id) => ({ id, name: name(id) })) } : {}),
    ...(run.current ? { current: run.current } : {}),
    loops: loopRows(run),
    steps: run.steps.map((s) => ({
      name: s.name,
      kind: s.kind,
      iteration: s.iteration,
      state: s.state,
      startedAt: s.startedAt,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      ...(s.loops ? { loops: s.loops } : {}),
      ...(s.fact ? { fact: s.fact } : {}),
      ...(s.detail ? { detail: s.detail } : {}),
      ...(s.delta ? { delta: s.delta } : {}),
      ...(s.sessionId ? { session: s.sessionId } : {}),
      ...(s.turnId ? { turn: s.turnId } : {}),
      ...(many && s.workspaceId ? { workspace: name(s.workspaceId) } : {}),
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
      ...(s.shown?.length ? { shown: s.shown } : {}),
      ...(s.usage ? { usage: s.usage } : {}),
      ...(s.memoryFiles?.length ? { memoryFiles: s.memoryFiles } : {}),
      ...(s.memoryWrites?.length ? { memoryWrites: s.memoryWrites } : {}),
      ...(s.noteRevision !== undefined ? { noteRevision: s.noteRevision } : {}),
      ...(s.tree?.start || s.tree?.end ? { tree: s.tree } : {}),
      ...(s.moved ? { moved: true } : {})
    })),
    ...(gate ? { gate: { id: gate.id, step: gate.step, ask: gate.ask, show: gate.show } } : {}),
    ...(pick ? { pick: { id: pick.id, step: pick.step, ask: pick.ask, choices: pick.choices } } : {})
  }
}

type ReadRun = { run: FlowRun } & Asks

/** What waits on a person for these runs: each waiting run's gate or pick, from the pending requests. */
function asksOf(run: FlowRun, pending: ApprovalRequest[]): Asks {
  if (run.state !== 'waiting') return {}
  const gate = pending.find((r): r is GateRequest => r.kind === 'gate' && r.flowRunId === run.id)
  const pick = pending.find((r): r is PickRequest => r.kind === 'pick' && r.flowRunId === run.id)
  return { ...(gate ? { gate } : {}), ...(pick ? { pick } : {}) }
}

/** A run and, while it waits at a gate or a pick, the request that asks. Undefined when it is gone (or Flows went off). */
async function readRun(host: CliHost, id: string): Promise<ReadRun | undefined> {
  const run = (await host.api.listFlowRuns()).find((r) => r.id === id)
  if (!run) return undefined
  return { run, ...asksOf(run, run.state === 'waiting' ? await host.api.pendingApprovals() : []) }
}

/** Where a run is, as a token a wait compares: its state, how many steps, the last one's state, its gate or pick, its workspace. */
export function seenOf(run: FlowRun, asks: Asks = {}): string {
  return [run.state, run.steps.length, run.steps.at(-1)?.state ?? '', asks.gate?.id ?? asks.pick?.id ?? '', run.workspaceId ?? ''].join('|')
}

/** Read the run until `done` says so, the time is up or the caller goes away; woken by the app's events and a poll. */
function untilRun(host: CliHost, id: string, done: (r: ReadRun | undefined) => boolean, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<ReadRun | undefined> {
  return new Promise((resolve) => {
    let finished = false
    let checking = false
    let last: ReadRun | undefined
    const cleanups: (() => void)[] = []
    const finish = () => {
      if (finished) return
      finished = true
      for (const c of cleanups) c()
      resolve(last)
    }
    const check = async () => {
      if (checking || finished) return
      checking = true
      try {
        last = await readRun(host, id)
        if (done(last)) finish()
      } catch {
        // Flows were turned off (the API refuses): the caller says so.
        last = undefined
        finish()
      } finally {
        checking = false
      }
    }
    cleanups.push(host.onEvent(() => void check()))
    const timer = setInterval(() => void check(), POLL_MS)
    cleanups.push(() => clearInterval(timer))
    if (options.timeoutMs !== undefined) {
      const timeout = setTimeout(finish, options.timeoutMs)
      cleanups.push(() => clearTimeout(timeout))
    }
    if (options.signal) {
      if (options.signal.aborted) return finish()
      const onAbort = () => finish()
      options.signal.addEventListener('abort', onAbort)
      cleanups.push(() => options.signal!.removeEventListener('abort', onAbort))
    }
    void check()
  })
}

const runSpec = { id: (r: FlowRun) => r.id, names: () => [] as string[], describe: (r: FlowRun) => `${r.flow.name}, ${r.state}, id ${r.id}` }

async function findRun(host: CliHost, query: string): Promise<FlowRun> {
  const runs = await host.api.listFlowRuns()
  if (!runs.length) throw notFound('No flow runs yet. `foreman flow run <flow>` starts one.')
  return findByRef(runs, query, 'flow run', runSpec)
}

function loopText(l: FlowLoopRow): string {
  const cost = l.maxCost !== undefined ? ` · $${(l.cost ?? 0).toFixed(2)} of $${l.maxCost.toFixed(2)} (Claude turns)` : l.cost ? ` · $${l.cost.toFixed(2)}` : ''
  return `${l.loop}: ${l.pass ? `pass ${l.pass} · ` : ''}iteration ${l.iterations}${l.maxIterations !== undefined ? ` of at most ${l.maxIterations}` : ''}${l.maxMinutes !== undefined ? ` · ${l.minutes} of ${l.maxMinutes} min` : l.minutes ? ` · ${l.minutes} min` : ''}${cost}`
}

/** The run in lines: what it is, where it is, its loops, its steps so far, and the gate it waits at. */
export function runText(row: FlowRunRow): string {
  const lines = [`Run ${short(row.id)} of “${row.flow}” in ${row.repo} (from ${row.base}): ${row.state}`]
  if (row.reason) lines.push(`Reason: ${row.reason}`)
  if (row.current && (row.state === 'running' || row.state === 'waiting' || row.state === 'starting')) lines.push(`At: ${row.current.step}, iteration ${row.current.iteration}`)
  for (const loop of row.loops) lines.push(`Loop ${loopText(loop)}`)
  if (row.workspace) lines.push(`Workspace: ${row.workspace.name} (${row.workspace.id})`)
  if (row.workspaces) lines.push(`Workspaces it made: ${row.workspaces.map((w) => w.name).join(', ')}`)
  lines.push(`Started: ${utcText(row.startedAt)}${row.endedAt ? ` · ended ${utcText(row.endedAt)} (took ${durationText(Date.parse(row.endedAt) - Date.parse(row.startedAt))})` : ''}`)
  lines.push(row.steps.length ? 'Steps:' : 'No step has started yet.')
  for (const step of row.steps) lines.push(`  ${flowStepText(step)}`)
  if (row.gate) lines.push(gateWaitText(row.gate))
  if (row.pick) lines.push(pickWaitText(row.pick))
  return lines.join('\n')
}

const AGENT_KINDS = new Set(['turn', 'review', 'decide'])
const READS_TREE = new Set(['checks', 'review', 'script'])
const amount = (n: number) => formatCompact(n, 'en')
const windowText = (u: { used: number; limit: number }) => `${amount(u.used)} of ${amount(u.limit)} (${u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0}%)`

/** The run through a lens, as `foreman flow status --lens` prints it: the facts the Flow tab's lens draws, in lines. */
export function lensText(row: FlowRunRow, lens: 'context' | 'memory' | 'data'): string {
  const lines = [`Run ${short(row.id)} of “${row.flow}” in ${row.repo} (from ${row.base}): ${row.state}`]
  if (!row.steps.length) return [...lines, 'No step has started yet.'].join('\n')
  if (lens === 'context') {
    lines.push('Context: what each step was shown, and its context window when its turn ended:')
    for (const s of row.steps) {
      const parts = [s.shown?.length ? `shown ${s.shown.join(', ')}` : 'shown nothing from earlier steps']
      if (s.usage) parts.push(`window ${windowText(s.usage)}`)
      else if (AGENT_KINDS.has(s.kind) && s.endedAt) parts.push('window not reported by the agent')
      lines.push(`  ${s.name}, iteration ${s.iteration}: ${parts.join(' · ')}`)
    }
    // A step that ran more than once (a loop): its window pass by pass.
    for (const name of [...new Set(row.steps.map((s) => s.name))]) {
      const usages = row.steps.filter((s) => s.name === name && s.usage).map((s) => s.usage!)
      if (usages.length > 1) lines.push(`  ${name} per pass: ${usages.map((u) => amount(u.used)).join(' → ')} of ${amount(usages.at(-1)!.limit)}`)
    }
  } else if (lens === 'memory') {
    lines.push('Memory: what each step read and wrote that outlives it:')
    for (const s of row.steps) {
      const parts: string[] = []
      if (s.memoryFiles?.length) parts.push(`read ${s.memoryFiles.map(memoryLabel).join(', ')}`)
      if (s.memoryWrites?.length) parts.push(`wrote ${s.memoryWrites.join(', ')}`)
      if (s.noteRevision !== undefined) parts.push(`workspace note r${s.noteRevision}`)
      if (s.shown?.includes('ledger')) parts.push('the run ledger')
      if (s.kind === 'decide' && s.fact && s.fact !== 'undecided') parts.push(`reported: decided ${s.fact}`)
      else if (s.fact === 'reports') parts.push('reported: done')
      lines.push(`  ${s.name}, iteration ${s.iteration}: ${parts.length ? parts.join(' · ') : 'nothing recorded'}`)
    }
  } else {
    lines.push(`Data: the working tree each step started from and ended on (base ${row.base}):`)
    for (const s of row.steps) {
      const start = s.tree?.start?.slice(0, 7)
      const end = s.tree?.end?.slice(0, 7)
      const tree = READS_TREE.has(s.kind) && start ? `read ${start}` : start || end ? `${start ?? 'unknown'} → ${end ?? start ?? 'unknown'}` : 'no tree recorded'
      lines.push(`  ${s.name}, iteration ${s.iteration}: ${tree}${s.workspace ? ` · in ${s.workspace}` : ''}${s.moved ? ' · moved since the last step' : ''}`)
    }
    if (row.workspaces) lines.push(`Workspaces it made: ${row.workspaces.map((w) => w.name).join(', ')}`)
  }
  return lines.join('\n')
}

/** "qa-engineer (built-in, read-only)", "reviewer (.claude/agents/reviewer.md at 1a2b3c4)". */
export function personaRefText(ref: FlowPersonaRef): string {
  const where = ref.source === 'built-in' ? 'built-in' : ref.source === 'personal' ? `personal${ref.rev ? `, saved ${ref.rev.slice(0, 10)}` : ''}` : `${ref.file ?? ref.source}${ref.rev ? ` at ${ref.rev.slice(0, 7)}` : ''}`
  return `${ref.name} (${where}${ref.readOnly ? ', read-only' : ''})`
}

/** The approval the Run dialog shows, in lines (a flow schedule's preview prints them too). */
export function flowPreviewLines(s: FlowRunSummary, inputs: Record<string, string>): string[] {
  const where = s.flowSource === 'repo' ? `the repository file ${s.flowFile}${s.flowRev ? ` at ${s.flowRev.slice(0, 7)}` : ''}` : s.flowSource === 'built-in' ? 'built into Foreman' : `a personal flow${s.flowRev ? `, saved ${s.flowRev.slice(0, 10)}` : ''}`
  const setup = s.setupScript.trim() ? firstLine(s.setupScript, 100) + (s.setupScript.trim().includes('\n') ? ' …' : '') : '(none)'
  const lines = [
    `Run “${s.flowName}” (${where})`,
    `Repository: ${s.repoName}; the run starts from ${s.baseBranch} in a fresh workspace`,
    `Steps: ${s.steps} · loops: ${s.loops} · gates: ${s.gates}`,
    ...(s.personas.length ? [`Personas: ${s.personas.map(personaRefText).join('; ')}`] : []),
    `Templates: ${s.templates.length ? s.templates.map((t) => `${t.name}${t.rev ? ` (revision ${t.rev.slice(0, 7)})` : ''}${t.source === 'repo' ? ', a repository template' : ''}`).join('; ') : '(none)'}`,
    `Setup script: ${setup}`,
    `Checks: ${s.checks.length ? s.checks.map((c) => `${c.name} (${firstLine(c.command, 60)})`).join(', ') : '(none)'}`,
    ...(s.commands?.length ? [`Commands its script steps run: ${s.commands.map((c) => `${c.name} (${firstLine(c.command, 60)})`).join(', ')}`] : []),
    `Repository MCP servers: ${s.mcpServers.length ? s.mcpServers.join(', ') : '(none)'}`,
    ...(s.integrations.length ? [`Integrations: ${s.integrations.join('; ')}`] : []),
    ...(Object.keys(inputs).length ? [`Inputs: ${Object.entries(inputs).map(([k, v]) => `${k} = ${JSON.stringify(firstLine(v, 60))}`).join(', ')}`] : []),
    'Unattended turns are Claude only. Each turn step runs in auto mode, and any approval or question stops the run and leaves it for you. Gates and picks wait for your answer. The run works in a new workspace, and is refused if anything above changes before it starts.',
    ...(s.costBound ? ['A cost bound applies to Claude turns only: other agents don’t say what a turn cost.'] : [])
  ]
  return lines
}

function previewText(preview: FlowRunPreview, inputs: Record<string, string>): string {
  return flowPreviewLines(preview.summary, inputs).join('\n')
}

function fingerprintParam(raw: unknown): FlowFingerprint | undefined {
  if (raw === undefined || raw === null) return undefined
  const f = raw as Record<string, unknown>
  const keys = ['flow', 'templates', 'setup', 'checks', 'mcp', 'personas'] as const
  if (typeof raw !== 'object' || keys.some((k) => typeof f[k] !== 'string')) throw invalid('shown must be the fingerprint a preview returned.')
  return { flow: f.flow as string, templates: f.templates as string, setup: f.setup as string, checks: f.checks as string, mcp: f.mcp as string, personas: f.personas as string }
}

function inputsParam(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== 'string')) throw invalid('inputs must be names and text values.')
  return raw as Record<string, string>
}

const run: MethodDef = {
  tier: 'act',
  async handle(host, params, ctx: CliContext): Promise<FlowRunResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const state = host.state()
    const repo = await resolveRepo(state, textParam(p, 'cwd', { optional: true }) ?? process.cwd(), textParam(p, 'repo', { optional: true }))
    const listing = findFlow(await host.api.listFlows(repo.id), textParam(p, 'flow'))
    if (listing.problems.length) throw invalid(`“${listing.name}” has problems, so it can’t run: ${listing.problems.join(' ')}`, '`foreman flow show` prints it.')
    const baseBranch = textParam(p, 'base', { optional: true })?.trim() || repo.defaultBranch || 'main'
    const preview = await host.api.flowRunPreview({ flowId: listing.id, repoId: repo.id, baseBranch })
    const s = preview.summary
    const reasons = [...(s.notClaude.length ? [`Unattended turns are Claude only; these agent steps aren’t on Claude: ${s.notClaude.map((n) => `${n.step} (${n.agent})`).join(', ')}.`] : []), ...s.problems]
    if (reasons.length) throw new CliCodedError('not-supported', `Can’t run “${s.flowName}”: ${reasons.join(' ')}`)
    const given = inputsParam(p.inputs)
    const asked = preview.inputs
    const unknown = Object.keys(given).filter((k) => !asked.some((i) => i.name === k))
    const askedText = asked.map((i) => `${i.name}${i.description ? ` (${i.description})` : ''}`).join(', ')
    if (unknown.length) throw invalid(`“${s.flowName}” has no input ${unknown.map((u) => `“${u}”`).join(', ')}. ${asked.length ? `It asks for: ${askedText}.` : 'It asks for none.'}`)
    const missing = asked.filter((i) => !given[i.name]?.trim())
    if (missing.length) throw invalid(`“${s.flowName}” asks for ${missing.map((i) => `${i.name}${i.description ? ` (${i.description})` : ''}`).join(', ')}.`, `Give each with --input ${missing[0].name}=<value>.`)
    const inputs = Object.fromEntries(asked.map((i) => [i.name, given[i.name].trim()]))
    const shown = fingerprintParam(p.shown)
    if (!shown) return { started: false, needsConfirmation: true, fingerprint: preview.fingerprint, summary: s, inputs, text: previewText(preview, inputs) }

    let started: FlowRun
    try {
      started = await host.api.startFlowRun({ flowId: listing.id, source: listing.source, repoId: repo.id, baseBranch, inputs, shown })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith(SHOWN_CHANGED)) throw refused(message, 'Run the command again to see what it would approve now.')
      throw err
    }
    // The run makes its workspace as its first step does; the answer waits for it, or for the run to end first.
    const placed = await untilRun(host, started.id, (r) => !r || Boolean(r.run.workspaceId) || !isActiveRun(r.run), { signal: ctx.signal, timeoutMs: PLACE_MS })
    const now = placed?.run ?? started
    let first: { session: string; turn: string } | undefined
    if (now.workspaceId) {
      if (flagParam(p, 'open')) host.reveal(now.workspaceId)
      if (isActiveRun(now)) first = await host.firstTurn(now.workspaceId)
    }
    const latest = (await readRun(host, started.id).catch(() => undefined)) ?? placed ?? { run: now }
    const row = runRow(latest.run, host.state(), latest)
    const lines = [`Started “${row.flow}” in ${row.repo} from ${row.base}`, `  run        ${row.id}`]
    if (row.workspace) lines.push(`  workspace  ${row.workspace.name} (${row.workspace.id})`)
    if (first) lines.push(`  session    ${first.session}`, `  turn       ${first.turn}`)
    if (!isActiveRun(latest.run)) lines.push(flowEndText(row))
    else if (!row.workspace) lines.push('  The workspace isn’t made yet; `foreman flow status` shows where the run is.')
    else if (!first) lines.push('  The first turn hasn’t started yet (setup may still be running); `foreman flow status` shows where the run is.')
    return { started: true, run: row, ...(first ? { session: first.session, turn: first.turn } : {}), seen: seenOf(latest.run, latest), text: lines.join('\n') }
  }
}

const runs: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<FlowRunsResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const all = flagParam(p, 'all')
    if (all && textParam(p, 'repo', { optional: true })?.trim()) throw invalid('Give --repo or --all, not both.')
    const repo = all ? undefined : await optionalRepo(host, p)
    const found = await host.api.listFlowRuns(repo?.id)
    const state = host.state()
    const pending = await host.api.pendingApprovals()
    const rows = [...found]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, all ? undefined : 20)
      .map((r) => runRow(r, state, asksOf(r, pending)))
    if (!rows.length) return { runs: rows, text: repo ? `No flow runs in ${repo.name} yet.` : 'No flow runs yet.' }
    const at = (r: FlowRunRow) => (r.current && (r.state === 'running' || r.state === 'waiting' || r.state === 'starting') ? `${r.current.step} #${r.current.iteration}` : '')
    const table = columns([['RUN', 'FLOW', 'REPO', 'STATE', 'AT', 'STARTED', 'WORKSPACE'], ...rows.map((r) => [short(r.id), r.flow, r.repo, `${r.state}${r.reason && r.state !== 'completed' ? `: ${firstLine(r.reason, 60)}` : ''}`, at(r), utcText(r.startedAt), r.workspace?.name ?? ''])])
    return { runs: rows, text: table.join('\n') }
  }
}

const status: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<FlowStatusResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const lens = textParam(p, 'lens', { optional: true })
    if (lens !== undefined && !(FLOW_STATUS_LENSES as readonly string[]).includes(lens)) throw invalid(`--lens is one of ${FLOW_STATUS_LENSES.join(', ')}, not “${lens}”.`)
    const found = await findRun(host, textParam(p, 'run'))
    const read = (await readRun(host, found.id)) ?? { run: found }
    const row = runRow(read.run, host.state(), read)
    return { run: row, text: lens && lens !== 'run' ? lensText(row, lens as 'context' | 'memory' | 'data') : runText(row) }
  }
}

/** Waits until the run is anywhere other than `seen` (a step started or ended, a gate asks, it ended). */
const wait: MethodDef = {
  tier: 'read',
  async handle(host, params, ctx: CliContext): Promise<FlowWaitResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const found = await findRun(host, textParam(p, 'run'))
    const seen = textParam(p, 'seen', { optional: true })
    const timeoutSec = numberParam(p, 'timeoutSec')
    if (timeoutSec !== undefined && !(timeoutSec > 0)) throw invalid('timeoutSec must be above zero.')
    const moved = await untilRun(host, found.id, (r) => !r || !isActiveRun(r.run) || seenOf(r.run, r) !== seen, { signal: ctx.signal, ...(timeoutSec !== undefined ? { timeoutMs: timeoutSec * 1000 } : {}) })
    flowsOn(host)
    const now = moved ?? { run: found }
    return { run: runRow(now.run, host.state(), now), seen: seenOf(now.run, now), ended: !isActiveRun(now.run) }
  }
}

const stop: MethodDef = {
  tier: 'act',
  async handle(host, params): Promise<FlowStopResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const found = await findRun(host, textParam(p, 'run'))
    if (!isActiveRun(found)) throw refused(`That run isn’t going: it ${found.state === 'completed' ? 'completed' : `is ${found.state}`}.`)
    await host.api.stopFlowRun(found.id)
    const after = (await readRun(host, found.id)) ?? { run: found }
    const row = runRow(after.run, host.state(), after)
    return { run: row, text: `Stopped the run of “${row.flow}”${row.current ? ` at ${row.current.step}` : ''}. Its workspace stays.` }
  }
}

export const FLOW_METHODS: Record<string, MethodDef> = {
  'flow-list': list,
  'flow-show': show,
  'flow-add': add,
  'flow-remove': remove,
  'flow-run': run,
  'flow-runs': runs,
  'flow-status': status,
  'flow-wait': wait,
  'flow-stop': stop
}
