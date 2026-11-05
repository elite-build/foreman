import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/cli/command'
import { approvalRunners } from '../src/cli/commands/approvals'
import { flowRunners, inputsOf, stepPrinter } from '../src/cli/commands/flows'
import { io } from '../src/cli/commands/input'
import { renderCommandHelp } from '../src/cli/help'
import { confirm } from '../src/cli/output'
import { ERROR_EXIT } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { APPROVAL_METHODS } from '../src/main/cli/approvals'
import { FLOW_METHODS, FLOWS_OFF, runRow, withFlowName } from '../src/main/cli/flows'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, tierCheck, type CliHost } from '../src/main/cliServer'
import { listFlows, personalFlowListing } from '../src/main/flowFiles'
import { SHOWN_CHANGED } from '../src/main/schedules'
import { defaultSettings } from '../src/main/store'
import type { ApprovalAnswerResult, ApprovalsResult } from '../src/shared/cli/approvals'
import type { FlowAddResult, FlowListResult, FlowRunPreviewResult, FlowRunRow, FlowRunsResult, FlowRunStartedResult, FlowShowResult, FlowStatusResult, FlowWaitResult } from '../src/shared/cli/flows'
import { COMMANDS, commandName, findCommand } from '../src/shared/cliCommands'
import { FLOW_COMMANDS } from '../src/shared/cliCommandsAutomations'
import type { FlowFingerprint, FlowRun, FlowRunPreview, FlowRunStart, PersonalFlow } from '../src/shared/flows'
import type { Api, ApprovalRequest, Repo, Session, Settings, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const TIDY = `name = "Tidy"

[inputs]
task = "What to tidy"

[start]
step = "work"

[steps.work]
kind = "turn"
prompt = "{{task}}"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "work"
prompt = "Fix the checks."
context = ["checks.results"]

[steps.ship]
kind = "gate"
show = ["diff"]
ask = "Ship it?"

[edges]
work = "checks"
checks = { passed = "ship", failed = "fix" }
fix = "checks"
ship = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.green]
over = ["checks", "fix"]
at_most = { iterations = 3, minutes = 30 }
`

const ON_CODEX = `name = "Codex try"

[start]
step = "work"

[steps.work]
kind = "turn"
prompt = "Do it"
agent = "codex"
`

const personal = (id: string, toml: string): PersonalFlow => ({ id, toml, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' })

const root = path.resolve('/tmp/foreman-cli-flows/repo')
const repo = { id: 'r1', name: 'api', rootPath: root, defaultBranch: 'develop' } as Repo
const ws = { id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'flow-tidy', baseBranch: 'develop', state: 'ready', path: '/x', createdAt: 'x' } as Workspace
const tab = { id: 's1', workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false } as unknown as Session

const FP: FlowFingerprint = { flow: 'f', templates: 't', setup: 's', checks: 'c', mcp: 'm', personas: 'p' }

function preview(over: Partial<FlowRunPreview['summary']> = {}, inputs = [{ name: 'task', description: 'What to tidy' }]): FlowRunPreview {
  return {
    fingerprint: FP,
    summary: { flowName: 'Tidy', flowSource: 'personal', flowRev: '2026-11-02T00:00:00.000Z', repoName: 'api', baseBranch: 'develop', steps: 4, loops: 1, gates: 1, personas: [], templates: [], setupScript: 'npm ci', checks: [{ name: 'test', command: 'npm test' }], mcpServers: [], integrations: ['linear: Work (read)'], unsupported: [], notClaude: [], problems: [], ...over },
    inputs
  }
}

const gateRequest = (runId: string): Extract<ApprovalRequest, { kind: 'gate' }> => ({ id: 'gate1234-abcd', sessionId: 's1', kind: 'gate', flowRunId: runId, flowName: 'Tidy', step: 'ship', ask: 'Ship it?', show: [{ kind: 'diff', summary: '2 files changed, +10 −1' }] })

function aRun(over: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run11111-2222',
    flow: { id: 'flow-tidy', name: 'Tidy', source: 'personal' },
    repoId: 'r1',
    baseBranch: 'develop',
    inputs: { task: 'the parser' },
    fingerprint: FP,
    state: 'running',
    startedAt: '2026-11-05T10:00:00.000Z',
    workspaceId: 'ws1',
    current: { step: 'fix', iteration: 2 },
    steps: [
      { name: 'work', kind: 'turn', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:00:00.000Z', endedAt: '2026-11-05T10:05:00.000Z', sessionId: 's1', turnId: 'turn-1', fact: 'delta', delta: { files: 2, additions: 10, deletions: 1 } },
      { name: 'checks', kind: 'checks', iteration: 1, loops: { green: 1 }, state: 'completed', startedAt: '2026-11-05T10:05:00.000Z', endedAt: '2026-11-05T10:06:00.000Z', fact: 'failed', detail: 'test failed', minutes: 1 },
      { name: 'fix', kind: 'turn', iteration: 1, loops: { green: 2 }, state: 'running', startedAt: '2026-11-05T10:06:00.000Z', sessionId: 's1' }
    ],
    loops: { green: { pass: 1, open: true, iterations: 2, startedAt: '2026-11-05T10:05:00.000Z', minutesUsed: 7.4, visited: ['fix'] } },
    bounds: { green: { over: ['checks', 'fix'], iterations: 3, minutes: 30 } },
    ...over
  }
}

const ctxOf = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: () => undefined })

function rig(over: { settings?: Partial<Settings>; personal?: PersonalFlow[]; runs?: FlowRun[]; pending?: ApprovalRequest[]; api?: Partial<Api>; host?: Partial<CliHost> } = {}) {
  const settings = { ...defaultSettings(), flows: true, ...over.settings }
  const flows = over.personal ?? [personal('flow-tidy', TIDY)]
  const runs = over.runs ?? []
  const calls: [string, ...unknown[]][] = []
  const api = fakeApi({
    listFlows: async () => {
      if (!settings.flows) throw new Error('Flows are off; turn them on in Settings → Experimental.')
      return listFlows([], flows)
    },
    listFlowRuns: async () => runs,
    pendingApprovals: async () => over.pending ?? [],
    flowRunPreview: async (input) => {
      calls.push(['flowRunPreview', input])
      return preview()
    },
    startFlowRun: async (input: FlowRunStart) => {
      calls.push(['startFlowRun', input])
      const run = aRun({ id: 'new-run-0001', state: 'running', steps: [{ name: 'work', kind: 'turn', iteration: 1, state: 'running', startedAt: '2026-11-05T10:00:00.000Z', sessionId: 's1' }], current: { step: 'work', iteration: 1 }, loops: {} })
      runs.push(run)
      return run
    },
    stopFlowRun: async (id) => {
      calls.push(['stopFlowRun', id])
      const run = runs.find((r) => r.id === id)
      if (run) Object.assign(run, { state: 'stopped', reason: 'Stopped by you.' })
    },
    savePersonalFlow: async (input) => {
      calls.push(['savePersonalFlow', input])
      const listing = personalFlowListing(personal('flow-new', input.toml))
      return listing.problems.length ? { problems: listing.problems } : { flow: listing }
    },
    deletePersonalFlow: async (id) => void calls.push(['deletePersonalFlow', id]),
    respondApproval: async (id, response) => void calls.push(['respondApproval', id, response]),
    ...over.api
  })
  const reveal = vi.fn()
  const host = stubHost({ api, state: () => ({ repos: [repo], workspaces: [ws], sessions: [tab], settings }), reveal, firstTurn: async () => ({ session: 's1', turn: 'turn-1' }), ...over.host })
  const call = async <T>(method: string, params?: unknown, token?: string): Promise<T> => (await (FLOW_METHODS[method] ?? APPROVAL_METHODS[method]).handle(host, params, ctxOf(token))) as T
  return { host, api, calls, call, runs, reveal, settings }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

// ---- the command table ----

describe('the flow command table', () => {
  it('declares list, show, add, remove, run, runs, status and stop beside the schedules, each with help and an example', () => {
    expect(FLOW_COMMANDS.map(commandName)).toEqual(['flow list', 'flow show', 'flow add', 'flow remove', 'flow run', 'flow runs', 'flow status', 'flow stop'])
    for (const spec of FLOW_COMMANDS) {
      const name = commandName(spec)
      expect(COMMANDS, name).toContain(spec)
      expect(spec.group, name).toBe('settings')
      expect(spec.usage.startsWith(`foreman ${name}`), name).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      const help = renderCommandHelp(spec)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) expect(findCommand(example.split(' ').slice(1)), example).toMatchObject({ spec })
    }
    expect(Object.keys(flowRunners).sort()).toEqual(FLOW_COMMANDS.map(commandName).sort())
  })

  it('puts the reads in the read tier and run, stop, add and remove in act, like run and send', () => {
    expect(Object.fromEntries(FLOW_COMMANDS.map((c) => [commandName(c), c.tier]))).toEqual({ 'flow list': 'read', 'flow show': 'read', 'flow add': 'act', 'flow remove': 'act', 'flow run': 'act', 'flow runs': 'read', 'flow status': 'read', 'flow stop': 'act' })
    expect(Object.fromEntries(Object.entries(FLOW_METHODS).map(([m, d]) => [m, d.tier]))).toEqual({ 'flow-list': 'read', 'flow-show': 'read', 'flow-add': 'act', 'flow-remove': 'act', 'flow-run': 'act', 'flow-runs': 'read', 'flow-status': 'read', 'flow-wait': 'read', 'flow-stop': 'act' })
    expect(FLOW_COMMANDS.find((c) => commandName(c) === 'flow run')?.noAssistant).toBeTruthy()
  })

  it('parses repeated --input, and --wait and --open', () => {
    const spec = FLOW_COMMANDS.find((c) => commandName(c) === 'flow run')!
    const { opts, positionals } = parseCommandArgs(spec, ['tidy', '--input', 'task=a=b', '--input', 'note=', '--wait', '-o'])
    expect(positionals).toEqual(['tidy'])
    expect(inputsOf(opts.input)).toEqual({ task: 'a=b', note: '' })
    expect(opts).toMatchObject({ wait: true, open: true })
    expect(() => inputsOf(['oops'])).toThrow(/key=value/)
    expect(() => inputsOf(['a=1', 'a=2'])).toThrow(/twice/)
    expect(() => parseCommandArgs(spec, ['tidy', '--timeout', '5'])).toThrow(/doesn’t take --timeout/)
  })

  it('gives approve the three gate answers and says deny doesn’t answer a gate', () => {
    const approve = COMMANDS.find((c) => commandName(c) === 'approve')!
    for (const flag of ['continue', 'send-back', 'note', 'stop']) expect(Object.keys(approve.options)).toContain(flag)
    expect(renderCommandHelp(approve)).toContain('deny doesn\'t answer a gate')
  })
})

// ---- the app's side ----

describe('flow methods', () => {
  it('refuse while Flows are off, naming the setting', async () => {
    const { call } = rig({ settings: { flows: false } })
    for (const method of Object.keys(FLOW_METHODS)) {
      const err = await failure(call(method, { flow: 'tidy', run: 'run1', cwd: root, toml: TIDY }))
      expect(err.code, method).toBe('refused')
      expect(err.message, method).toBe(FLOWS_OFF)
      expect(err.message).toContain('Settings → Experimental → Flows')
    }
    expect(ERROR_EXIT.refused).toBe(7)
  })

  it('list: built-in, personal and broken flows with their source, summary, problems and why one can’t run', async () => {
    const { call } = rig({ personal: [personal('flow-tidy', TIDY), personal('flow-codex', ON_CODEX), personal('flow-bad', 'name = "Broken"')] })
    const result = await call<FlowListResult>('flow-list', { cwd: root })
    const byName = Object.fromEntries(result.flows.map((f) => [f.name, f]))
    expect(byName['Fix until green']).toMatchObject({ source: 'built-in', starter: 'fix-until-green', steps: 6, loops: 2, gates: 1, personas: ['developer', 'qa-engineer'] })
    expect(byName['Fix until green'].cantRun).toContain('review steps aren’t supported yet (review)')
    expect(byName.Tidy).toMatchObject({ source: 'personal', steps: 4, loops: 1, gates: 1, problems: [] })
    expect(byName.Tidy.cantRun).toBeUndefined()
    expect(byName['Codex try'].cantRun).toContain('Claude only')
    expect(byName['flow-bad'].problems.length).toBeGreaterThan(0)
    expect(result.text.split('\n')[0]).toMatch(/^NAME\s+SOURCE\s+FILE\s+REV\s+STEPS\s+LOOPS\s+GATES\s+PERSONAS$/)
    expect(result.text).toContain('  can’t run: review steps aren’t supported yet')
    expect(result.text).toContain('  problem: ')
  })

  it('show: the summary and the TOML', async () => {
    const { call } = rig()
    const result = await call<FlowShowResult>('flow-show', { flow: 'tidy', cwd: root })
    expect(result.toml).toBe(TIDY)
    expect(result.text).toContain('Tidy (personal)')
    expect(result.text).toContain('Steps 4 · loops 1 · gates 1')
    expect(result.text).toContain('[steps.ship]')
    expect((await failure(call('flow-show', { flow: 'nothing', cwd: root }))).code).toBe('not-found')
  })

  it('add: saves a flow, under --name when given; lists problems instead of saving a broken one; refuses a name you already have', async () => {
    const { call, calls } = rig()
    const renamed = await call<FlowAddResult>('flow-add', { toml: TIDY, name: 'Tidy (mine)' })
    expect(renamed).toMatchObject({ saved: true, flow: { name: 'Tidy (mine)', source: 'personal' } })
    expect((calls[0][1] as { toml: string }).toml.split('\n')[0]).toBe('name = "Tidy (mine)"')
    const broken = await call<FlowAddResult>('flow-add', { toml: 'name = "Broken"' })
    expect(broken.saved).toBe(false)
    expect(broken.problems?.length).toBeGreaterThan(0)
    expect(broken.text).toContain('Not saved')
    const clash = await failure(call('flow-add', { toml: TIDY }))
    expect(clash.code).toBe('invalid')
    expect(clash.message).toContain('already have a personal flow named “Tidy”')
    expect(withFlowName('# a comment\n[start]\nstep = "a"', 'X')).toBe('name = "X"\n# a comment\n[start]\nstep = "a"')
  })

  it('remove: personal flows only', async () => {
    const { call, calls } = rig()
    expect((await call<{ text: string }>('flow-remove', { flow: 'Tidy' })).text).toContain('Removed the personal flow “Tidy”')
    expect(calls).toEqual([['deletePersonalFlow', 'flow-tidy']])
    const builtIn = await failure(call('flow-remove', { flow: 'fix-until-green' }))
    expect(builtIn.code).toBe('refused')
    expect(builtIn.message).toContain('built into Foreman')
  })

  describe('run', () => {
    it('answers with the approval summary first and starts nothing', async () => {
      const { call, calls } = rig()
      const result = await call<FlowRunPreviewResult>('flow-run', { flow: 'tidy', cwd: root, inputs: { task: 'the parser' } })
      expect(result).toMatchObject({ started: false, needsConfirmation: true, fingerprint: FP, inputs: { task: 'the parser' } })
      for (const line of ['Run “Tidy” (a personal flow', 'Repository: api; the run starts from develop in a fresh workspace', 'Steps: 4 · loops: 1 · gates: 1', 'Setup script: npm ci', 'Checks: test (npm test)', 'Integrations: linear: Work (read)', 'Inputs: task = "the parser"', 'Unattended turns are Claude only']) expect(result.text).toContain(line)
      expect(calls).toEqual([['flowRunPreview', { flowId: 'flow-tidy', repoId: 'r1', baseBranch: 'develop' }]])
    })

    it('asks for missing inputs and refuses unknown ones, before anything starts', async () => {
      const { call, calls } = rig()
      const missing = await failure(call('flow-run', { flow: 'tidy', cwd: root }))
      expect(missing.code).toBe('invalid')
      expect(missing.message).toContain('asks for task (What to tidy)')
      expect(missing.hint).toContain('--input task=')
      expect((await failure(call('flow-run', { flow: 'tidy', cwd: root, inputs: { task: 'x', colour: 'red' } }))).message).toContain('has no input “colour”')
      expect(calls.some((c) => c[0] === 'startFlowRun')).toBe(false)
    })

    it('refuses a flow this version can’t run, naming the steps', async () => {
      const { call } = rig({ api: { flowRunPreview: async () => preview({ unsupported: [{ step: 'review', kind: 'review' }], notClaude: [{ step: 'try', agent: 'Codex' }] }) } })
      const err = await failure(call('flow-run', { flow: 'tidy', cwd: root, inputs: { task: 'x' } }))
      expect(err.code).toBe('not-supported')
      expect(err.message).toContain('Not yet: review (review)')
      expect(err.message).toContain('try (Codex)')
    })

    it('starts what was shown and answers with the run, its workspace and its first turn; --open brings it forward', async () => {
      const { call, calls, runs, reveal } = rig()
      const result = await call<FlowRunStartedResult>('flow-run', { flow: 'tidy', cwd: root, inputs: { task: ' the parser ' }, base: 'main', open: true, shown: FP })
      expect(calls[1]).toEqual(['startFlowRun', { flowId: 'flow-tidy', source: 'personal', repoId: 'r1', baseBranch: 'main', inputs: { task: 'the parser' }, shown: FP }])
      expect(result).toMatchObject({ started: true, session: 's1', turn: 'turn-1', run: { id: 'new-run-0001', workspace: { id: 'ws1', name: 'lisbon' } } })
      expect(result.text).toContain('  run        new-run-0001')
      expect(result.text).toContain('  workspace  lisbon (ws1)')
      expect(result.text).toContain('  turn       turn-1')
      expect(result.seen).toBe('running|1|running||w')
      expect(reveal).toHaveBeenCalledWith('ws1')
      expect(runs).toHaveLength(1)
    })

    it('refuses when what was shown changed, saying so', async () => {
      const { call } = rig({ api: { startFlowRun: async () => Promise.reject(new Error(`${SHOWN_CHANGED}. Changed: the repo’s checks.`)) } })
      const err = await failure(call('flow-run', { flow: 'tidy', cwd: root, inputs: { task: 'x' }, shown: { ...FP, checks: 'old' } }))
      expect(err.code).toBe('refused')
      expect(err.message).toContain('Changed: the repo’s checks')
    })

    it('is refused to an agent without the repository’s opt-in, as foreman run is', () => {
      const caller = { sessionId: 's1', turnId: 't', token: 'k' }
      const agent = (mayStart: boolean) => stubHost({ identifyCaller: () => ({ kind: 'turn', session: tab, ws, turnId: 't', live: true }), agentsMayStart: () => mayStart })
      expect(tierCheck('flow-run', 'act', { v: 2, method: 'flow-run', params: {}, caller }, agent(false))).toMatchObject({ code: 'refused', error: expect.stringContaining('Let agents start workspaces and queue messages') })
      expect(tierCheck('flow-run', 'act', { v: 2, method: 'flow-run', params: {}, caller }, agent(true))).toBeNull()
      expect(tierCheck('flow-run', 'act', { v: 2, method: 'flow-run', params: {} }, stubHost())).toBeNull()
      expect(tierCheck('flow-status', 'read', { v: 2, method: 'flow-status', caller }, agent(false))).toBeNull()
      // An agent can't answer a gate: approve is admin.
      expect(tierCheck('approve', 'admin', { v: 2, method: 'approve', params: {}, caller, token: 'test-token' }, agent(true))).toMatchObject({ code: 'refused' })
    })
  })

  it('runs: newest first, with state and where each is; --all and --repo don’t mix', async () => {
    const old = aRun({ id: 'old-run-0000', state: 'completed', startedAt: '2026-11-04T10:00:00.000Z', endedAt: '2026-11-04T10:30:00.000Z' })
    const { call } = rig({ runs: [old, aRun()] })
    const result = await call<FlowRunsResult>('flow-runs', { cwd: root })
    expect(result.runs.map((r) => r.id)).toEqual(['run11111-2222', 'old-run-0000'])
    expect(result.text.split('\n')[0]).toMatch(/^RUN\s+FLOW\s+REPO\s+STATE\s+AT\s+STARTED\s+WORKSPACE$/)
    expect(result.text).toContain('fix #2')
    expect((await failure(call('flow-runs', { cwd: root, all: true, repo: 'api' }))).code).toBe('invalid')
  })

  it('status: state, the step it is at, its loop bounds, the steps so far and the gate it waits at', async () => {
    const waiting = aRun({ state: 'waiting', current: { step: 'ship', iteration: 1 }, steps: [...aRun().steps.slice(0, 2), { name: 'ship', kind: 'gate', iteration: 1, state: 'waiting', startedAt: '2026-11-05T10:07:00.000Z', sessionId: 's1' }] })
    const { call } = rig({ runs: [waiting], pending: [gateRequest('run11111-2222')] })
    const result = await call<FlowStatusResult>('flow-status', { run: 'run1' })
    expect(result.run.gate).toMatchObject({ id: 'gate1234-abcd', step: 'ship', ask: 'Ship it?' })
    for (const line of ['Run run11111 of “Tidy” in api (from develop): waiting', 'At: ship, iteration 1', 'Loop green: iteration 2 of at most 3 · 7 of 30 min', 'Workspace: lisbon (ws1)', '  work, iteration 1: completed (delta) · 2 files +10 −1', '  checks, iteration 1: completed (failed) · test failed', '  ship, iteration 1: waiting for you', 'Waiting for you at ship: Ship it? — answer with `foreman approve gate1234-abcd --continue | --send-back --note "…" | --stop`', '  Changes: 2 files changed, +10 −1']) expect(result.text).toContain(line)
    expect((await failure(call('flow-status', { run: 'zzzz' }))).code).toBe('not-found')
  })

  it('wait: answers at once when the run moved since `seen`, and after the timeout when it didn’t', async () => {
    const run = aRun()
    const { call } = rig({ runs: [run] })
    const moved = await call<FlowWaitResult>('flow-wait', { run: run.id, seen: 'running|2|running||w' })
    expect(moved).toMatchObject({ seen: 'running|3|running||w', ended: false })
    const still = await call<FlowWaitResult>('flow-wait', { run: run.id, seen: moved.seen, timeoutSec: 0.05 })
    expect(still.seen).toBe(moved.seen)
  })

  it('stop: stops a run that is going and refuses one that ended', async () => {
    const { call, calls } = rig({ runs: [aRun(), aRun({ id: 'done-run-0000', state: 'completed' })] })
    expect((await call<{ text: string }>('flow-stop', { run: 'run11111-2222' })).text).toBe('Stopped the run of “Tidy” at fix. Its workspace stays.')
    expect(calls).toEqual([['stopFlowRun', 'run11111-2222']])
    expect((await failure(call('flow-stop', { run: 'done-run-0000' }))).code).toBe('refused')
  })

  it('a run row counts the loop a run has left from its steps', () => {
    const row = runRow(aRun({ state: 'completed', loops: {} }), { repos: [repo], workspaces: [ws] })
    expect(row.loops).toEqual([{ loop: 'green', iterations: 2, maxIterations: 3, minutes: 1, maxMinutes: 30 }])
  })
})

describe('gates through approve', () => {
  const gate = gateRequest('run11111-2222')

  it('lists a gate with its ask and show rows', async () => {
    const { call } = rig({ pending: [gate] })
    const result = await call<ApprovalsResult>('approvals')
    expect(result.approvals[0]).toMatchObject({ kind: 'gate', flow: 'Tidy', step: 'ship', ask: 'Tidy · ship: Ship it?', show: gate.show })
    expect(result.text).toContain('    Changes: 2 files changed, +10 −1')
  })

  it('continues, sends back with a note, or stops', async () => {
    const { call, calls } = rig({ pending: [gate] })
    expect((await call<ApprovalAnswerResult>('approve', { id: 'gate1234', gate: 'continue' })).answer).toBe('continued')
    expect((await call<ApprovalAnswerResult>('approve', { id: 'gate1234', gate: 'send-back', note: 'Keep the old API' })).answer).toBe('sent back with a note')
    expect((await call<ApprovalAnswerResult>('approve', { id: 'gate1234', gate: 'stop' })).answer).toBe('stopped')
    expect(calls).toEqual([
      ['respondApproval', 'gate1234-abcd', { kind: 'gate', answer: 'continued' }],
      ['respondApproval', 'gate1234-abcd', { kind: 'gate', answer: 'sent-back', note: 'Keep the old API' }],
      ['respondApproval', 'gate1234-abcd', { kind: 'gate', answer: 'stopped' }]
    ])
  })

  it('wants one of the three answers, and deny refuses a gate pointing at them', async () => {
    const { call, calls } = rig({ pending: [gate, { id: 'tool1111-xxxx', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: { command: 'ls' } }] })
    expect((await failure(call('approve', { id: 'gate1234' }))).message).toContain('--continue')
    expect((await failure(call('approve', { id: 'gate1234', gate: 'continue', note: 'x' }))).message).toBe('--note goes with --send-back.')
    expect((await failure(call('approve', { id: 'tool1111', gate: 'stop' }))).message).toContain('answer a flow’s gate')
    const denied = await failure(call('deny', { id: 'gate1234', message: 'no' }))
    expect(denied.code).toBe('invalid')
    expect(denied.message).toContain('deny doesn’t answer')
    expect(denied.message).toContain('--send-back')
    expect(calls).toEqual([])
  })
})

// ---- the command's side ----

type Answers = Record<string, unknown>

async function runLine(line: string[], answers: Answers = {}) {
  const found = findCommand(line, COMMANDS)
  if ('error' in found) throw new Error(found.error)
  const { opts, positionals } = parseCommandArgs(found.spec, found.rest)
  const sent: [string, Record<string, unknown>][] = []
  const out: string[] = []
  const context: Context = {
    args: positionals,
    opts,
    json: Boolean(opts.json),
    quiet: true,
    yes: Boolean(opts.yes),
    cwd: '/work',
    send: (async (method: string, params?: unknown) => {
      sent.push([method, (params ?? {}) as Record<string, unknown>])
      const answer = answers[method]
      return typeof answer === 'function' ? (answer as (p: Record<string, unknown>) => unknown)((params ?? {}) as Record<string, unknown>) : answer
    }) as Context['send'],
    print: (value, text) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
    confirm: (question) => confirm(question, { yes: Boolean(opts.yes), interactive: false }),
    note: () => undefined,
    progress: () => undefined
  }
  const name = commandName(found.spec)
  const runner = flowRunners[name] ?? approvalRunners[name]
  return { done: runner(context), sent, out }
}

const previewAnswer: FlowRunPreviewResult = { started: false, needsConfirmation: true, fingerprint: FP, summary: preview().summary, inputs: { task: 'x' }, text: 'Run “Tidy” (a personal flow)' }

function rowAt(over: Partial<FlowRunRow>): FlowRunRow {
  return { id: 'run11111-2222', flow: 'Tidy', flowId: 'flow-tidy', source: 'personal', repo: 'api', repoId: 'r1', base: 'develop', state: 'running', startedAt: '2026-11-05T10:00:00.000Z', workspace: { id: 'ws1', name: 'lisbon' }, loops: [], steps: [], ...over }
}

const step = (name: string, state: FlowRunRow['steps'][number]['state'], over: Partial<FlowRunRow['steps'][number]> = {}) => ({ name, kind: 'turn' as const, iteration: 1, state, startedAt: 'x', ...over })

describe('foreman flow', () => {
  it('run --yes asks for the summary, then starts what it showed', async () => {
    const started: FlowRunStartedResult = { started: true, run: rowAt({ steps: [step('work', 'running')] }), seen: 'a', text: 'Started “Tidy” in api from develop' }
    const r = await runLine(['flow', 'run', 'tidy', '--input', 'task=x', '--yes'], { 'flow-run': (p: Record<string, unknown>) => (p.shown ? started : previewAnswer) })
    await r.done
    expect(r.sent.map(([m, p]) => [m, p.shown])).toEqual([
      ['flow-run', undefined],
      ['flow-run', FP]
    ])
    expect(r.sent[0][1]).toMatchObject({ flow: 'tidy', cwd: '/work', inputs: { task: 'x' }, open: false })
    expect(r.out).toEqual(['Started “Tidy” in api from develop'])
    expect(process.exitCode).toBeUndefined()
  })

  it('run in a script without --yes starts nothing and exits 6', async () => {
    const r = await runLine(['flow', 'run', 'tidy', '--input', 'task=x'], { 'flow-run': previewAnswer })
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toHaveLength(1)
  })

  it('run --wait follows the run through a gate to completion, printing each step, and exits 0', async () => {
    const gate = { id: 'gate1234-abcd', step: 'ship', ask: 'Ship it?', show: [{ kind: 'diff' as const, summary: '2 files changed' }] }
    const states: FlowWaitResult[] = [
      { run: rowAt({ steps: [step('work', 'completed', { fact: 'delta' }), step('checks', 'running', { kind: 'checks' })] }), seen: 'b', ended: false },
      { run: rowAt({ state: 'waiting', steps: [step('work', 'completed', { fact: 'delta' }), step('checks', 'completed', { kind: 'checks', fact: 'passed', detail: 'test passed' }), step('ship', 'waiting', { kind: 'gate' })], gate }), seen: 'c', ended: false },
      { run: rowAt({ state: 'completed', steps: [step('work', 'completed', { fact: 'delta' }), step('checks', 'completed', { kind: 'checks', fact: 'passed', detail: 'test passed' }), step('ship', 'completed', { kind: 'gate', fact: 'continued', detail: 'Continued' })] }), seen: 'd', ended: true }
    ]
    const started: FlowRunStartedResult = { started: true, run: rowAt({ steps: [step('work', 'running')] }), seen: 'a', text: 'Started “Tidy” in api from develop' }
    const r = await runLine(['flow', 'run', 'tidy', '--yes', '--wait'], { 'flow-run': (p: Record<string, unknown>) => (p.shown ? started : previewAnswer), 'flow-wait': () => states.shift() })
    await r.done
    expect(r.sent.filter(([m]) => m === 'flow-wait').map(([, p]) => p.seen)).toEqual(['a', 'b', 'c'])
    const text = r.out.join('\n')
    for (const line of [
      'work, iteration 1: started',
      'work, iteration 1: completed (delta)',
      'checks, iteration 1: started',
      'checks, iteration 1: completed (passed) · test passed',
      'ship, iteration 1: started',
      'Waiting for you at ship: Ship it? — answer with `foreman approve gate1234-abcd --continue | --send-back --note "…" | --stop`',
      '  Changes: 2 files changed',
      'ship, iteration 1: completed (continued) · Continued',
      'The flow “Tidy” completed.'
    ])
      expect(text).toContain(line)
    // The gate is said once, however many answers come back while it waits.
    expect(text.split('Waiting for you at ship').length).toBe(2)
    expect(process.exitCode).toBe(0)
  })

  it('run --wait exits 1 when the run stops or needs you, saying which; --json prints one document at the end', async () => {
    const started: FlowRunStartedResult = { started: true, run: rowAt({ steps: [step('work', 'running')] }), seen: 'a', text: 'Started' }
    const end = (state: FlowRunRow['state'], reason: string): FlowWaitResult => ({ run: rowAt({ state, reason, steps: [step('work', 'stopped')] }), seen: 'z', ended: true })
    const stopped = await runLine(['flow', 'run', 'tidy', '--yes', '--wait'], { 'flow-run': (p: Record<string, unknown>) => (p.shown ? started : previewAnswer), 'flow-wait': end('needs-you', 'Stopped: Bash wanted approval.') })
    await stopped.done
    expect(stopped.out.at(-1)).toBe('The flow “Tidy” needs you: Stopped: Bash wanted approval.')
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    const json = await runLine(['flow', 'run', 'tidy', '--yes', '--wait', '--json'], { 'flow-run': (p: Record<string, unknown>) => (p.shown ? started : previewAnswer), 'flow-wait': end('stopped', 'Stopped by you.') })
    await json.done
    expect(json.out).toHaveLength(1)
    expect(JSON.parse(json.out[0])).toMatchObject({ started: true, run: { state: 'stopped', reason: 'Stopped by you.' } })
    expect(process.exitCode).toBe(1)
  })

  it('the step printer says each start and end once', () => {
    const lines: string[] = []
    const update = stepPrinter((l) => lines.push(l))
    update(rowAt({ steps: [step('work', 'running')] }))
    update(rowAt({ steps: [step('work', 'running')] }))
    update(rowAt({ steps: [step('work', 'completed'), step('fix', 'completed', { iteration: 2 })] }))
    expect(lines).toEqual(['work, iteration 1: started', 'work, iteration 1: completed', 'fix, iteration 2: started', 'fix, iteration 2: completed'])
  })

  it('add reads the file where the command ran; a flow with problems exits 1', async () => {
    const read = vi.spyOn(io, 'readFile').mockResolvedValue('name = "Broken"')
    const r = await runLine(['flow', 'add', 'flows/broken.toml', '--name', 'B'], { 'flow-add': { saved: false, problems: ['No steps.'], text: 'Not saved: the flow has a problem.\n  No steps.' } })
    await r.done
    expect(read).toHaveBeenCalledWith('flows/broken.toml', '/work')
    expect(r.sent).toEqual([['flow-add', { toml: 'name = "Broken"', name: 'B' }]])
    expect(r.out[0]).toContain('No steps.')
    expect(process.exitCode).toBe(1)
  })

  it('remove asks first; list, show, runs, status and stop send their words', async () => {
    const removing = await runLine(['flow', 'remove', 'tidy'], {})
    await expect(removing.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(removing.sent).toEqual([])
    const lines: [string[], string, Record<string, unknown>][] = [
      [['flow', 'list', '--repo', 'api'], 'flow-list', { repo: 'api', cwd: '/work' }],
      [['flow', 'show', 'tidy'], 'flow-show', { flow: 'tidy', cwd: '/work' }],
      [['flow', 'runs', '--all'], 'flow-runs', { cwd: '/work', all: true }],
      [['flow', 'status', '7c1e'], 'flow-status', { run: '7c1e' }],
      [['flow', 'stop', '7c1e'], 'flow-stop', { run: '7c1e' }],
      [['flow', 'remove', 'tidy', '--yes'], 'flow-remove', { flow: 'tidy' }]
    ]
    for (const [line, method, params] of lines) {
      const r = await runLine(line, { [method]: { text: 'ok' } })
      await r.done
      expect(r.sent, line.join(' ')).toEqual([[method, expect.objectContaining(params)]])
      expect(r.out).toEqual(['ok'])
    }
  })

  it('approve sends a gate’s answer and refuses two answers or a note without --send-back', async () => {
    const r = await runLine(['approve', 'gate1234', '--send-back', '--note', 'Keep the old API'], { approve: { text: 'ok' } })
    await r.done
    expect(r.sent[0][1]).toMatchObject({ id: 'gate1234', gate: 'send-back', note: 'Keep the old API' })
    await expect((await runLine(['approve', 'gate1234', '--continue', '--stop'])).done).rejects.toThrow('Give one of --continue, --send-back and --stop.')
    await expect((await runLine(['approve', 'gate1234', '--continue', '--note', 'x'])).done).rejects.toThrow('--note goes with --send-back.')
  })
})
