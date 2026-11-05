// Running a flow (docs/loops-and-graphs.md, "Running a flow"): FlowService with fake deps, as tests/schedules.test.ts
// drives ScheduleService. A run is written before anything launches; every step kind follows its edges; loop bounds
// (iterations, minutes, cost) stop the run naming the bound; the iteration policies; Stop, needs-you, the fingerprint
// and the start refusals; `[after]`; uncertain after a restart.
import { describe, expect, it, vi } from 'vitest'
import { FlowService, flowFingerprintOf, type FlowCommand, type FlowCommandStart, type FlowPullRequest, type FlowServiceDeps, type PreparedFlow } from '../src/main/flows'
import { SHOWN_CHANGED } from '../src/main/schedules'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type FlowRun } from '../src/shared/flows'
import { parsePersona, type Persona } from '../src/shared/personas'
import { PERSONA_STARTERS } from '../src/shared/personaStarters'
import type { Loadout } from '../src/shared/agents'
import type { ApprovalRequest, ApprovalResponse, ChatItem, CheckResult, Session, TurnOutcome } from '../src/shared/types'
import { ForemanActions } from '../src/main/foremanActions'

const GREEN = `name = "Green"

[inputs]
task = "What to do"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build this: {{task}}"
persona = "developer"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
prompt = "Fix the checks."
context = ["checks.results", "build.answer"]
same_tab = "build"

[steps.ship]
kind = "gate"
show = ["diff", "checks.results"]
ask = "Ship it?"

[edges]
build = "checks"
checks = { passed = "ship", failed = "fix" }
fix = "checks"
ship = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.green]
over = ["checks", "fix"]
at_most = { iterations = 3, minutes = 30 }
`

// A turn and a gate in one loop with a minutes bound: time at the gate must not count.
const ASKING = `name = "Asking"

[start]
step = "work"

[steps.work]
kind = "turn"
prompt = "Work on it."

[steps.ask]
kind = "gate"
ask = "Good?"

[edges]
work = "ask"
ask = { continued = "done", sent-back = "work" }

[loops.ask-again]
over = ["work", "ask"]
at_most = { minutes = 15 }
`

/** The built-in personas by name, as a flow in any repository finds them. */
const STARTER_PERSONAS: Record<string, Persona> = Object.fromEntries(
  PERSONA_STARTERS.map((s) => {
    const read = parsePersona(s.markdown, 'built-in')
    if (!('persona' in read)) throw new Error(read.problems.join(' '))
    return [s.name, read.persona]
  })
)

type Asked = Omit<Extract<ApprovalRequest, { kind: 'gate' }>, 'id' | 'sessionId'> | Omit<Extract<ApprovalRequest, { kind: 'pick' }>, 'id' | 'sessionId'>
type Gate = { id: string; sessionId: string; request: Asked; resolve(r: ApprovalResponse): void }
const showOf = (request: Asked) => (request.kind === 'gate' ? request.show : [])

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1\n'

function harness(
  toml = GREEN,
  options: {
    checks?: CheckResult['status'][]
    loadouts?: Loadout[]
    state?: { flowRuns?: FlowRun[] }
    maxActive?: number
    flushFailures?: number
    personas?: Record<string, Persona | undefined>
    commands?: Record<string, FlowCommand | undefined>
  } = {}
) {
  let flushFailures = options.flushFailures ?? 0
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
  const { flow } = parsed
  const state = options.state ?? { flowRuns: [] as FlowRun[] }
  let clock = Date.parse('2026-11-05T10:00:00Z')
  const flushed: FlowRun[][] = []
  const sent: { sessionId: string; text: string; turnId: string; unattended?: unknown; persona?: unknown; origin?: unknown }[] = []
  // Who each check run was started by, as the service names it.
  const checksBy: unknown[] = []
  const chats = new Map<string, ChatItem[]>()
  const gates: Gate[] = []
  const checks = [...(options.checks ?? [])]
  let n = 0
  // The personas the flow's steps name, as prepare resolves them: the built-in ones unless the test says otherwise.
  const personas: Record<string, Persona | undefined> = {}
  for (const step of flow.steps) if ('persona' in step && step.persona) personas[step.persona] = options.personas ? options.personas[step.persona] : STARTER_PERSONAS[step.persona]
  const commands: Record<string, FlowCommand | undefined> = options.commands ?? {}
  for (const step of flow.steps) if (step.kind === 'script' && !options.commands) commands[step.command] = { name: step.command, command: `npm run ${step.command}`, source: 'repo' }
  // What each turn reported (`done`, `review`, `decide`), by turn id.
  const reports = new Map<string, { kind: string; text: string }[]>()
  const prepared: PreparedFlow = {
    flow,
    ref: { id: 'flow-1', name: flow.name, source: 'personal' },
    templates: {},
    personas,
    commands,
    fingerprint: flowFingerprintOf({ flow, templates: [], personas: Object.values(personas).filter((p): p is Persona => Boolean(p)), setupScript: '', checks: [{ name: 'Tests', command: 'npm test' }], mcp: [], commands: Object.values(commands).filter((c): c is FlowCommand => Boolean(c)) })
  }
  const launch = vi.fn<FlowServiceDeps['launch']>(async (_run, first, handle) => {
    handle.created('ws-1', 's-1')
    sent.push({ sessionId: 's-1', text: first.text, turnId: 't-first', persona: first.persona })
  })
  const deps: FlowServiceDeps = {
    store: {
      state,
      flush: () => {
        if (flushFailures-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
        flushed.push(structuredClone(state.flowRuns ?? []))
      }
    },
    now: () => clock,
    newId: () => `id-${++n}`,
    prepare: () => prepared,
    loadouts: () => options.loadouts ?? [{ agent: 'claude', model: 'claude-sonnet-5', fast: false }],
    launch,
    createSession: vi.fn<FlowServiceDeps['createSession']>(() => `s-new-${++n}`),
    deliver: async (sessionId, text, o) => {
      sent.push({ sessionId, text, turnId: o.turnId, unattended: o.unattended, ...(o.origin ? { origin: o.origin } : {}) })
    },
    cancel: vi.fn(async () => {}),
    startChecks: async (_ws, by) => {
      checksBy.push(by)
      const status = checks.shift() ?? 'passed'
      return { kind: 'started', done: Promise.resolve([{ name: 'Tests', command: 'npm test', status, startedAt: '', logPath: '', fingerprint: { tree: '', command: '', source: 'local' } } as CheckResult]) }
    },
    cancelChecks: vi.fn(async () => {}),
    checksResults: async () => '### Tests (exit 1)\nexpected 1 to be 2',
    readChat: async (sessionId) => chats.get(sessionId) ?? [],
    reported: (_ws, turnId) => reports.get(turnId) ?? [],
    diffStat: async () => 'src/a.ts +3 −1\n1 file changed, +3 −1',
    tree: async () => 'Base branch: main\nWorking tree: abc1234',
    captureDiff: async () => ({ text: PATCH, tree: 'abc1234def', baseRef: 'main', files: 1, additions: 1, deletions: 0, cut: false }),
    reviewPrompt: () => '',
    runCommand: vi.fn<FlowServiceDeps['runCommand']>(async (): Promise<FlowCommandStart> => ({ kind: 'started', done: Promise.resolve({ code: 0, output: 'all good' }) })),
    cancelCommand: vi.fn(async () => {}),
    pullRequest: vi.fn<FlowServiceDeps['pullRequest']>(async (): Promise<FlowPullRequest> => ({ kind: 'facts', facts: { checks: 'passed', review: 'unknown' } })),
    newWorkspace: vi.fn<FlowServiceDeps['newWorkspace']>(async () => ({ workspaceId: 'ws-2', sessionId: 's-ws2' })),
    afterRun: vi.fn(),
    // A wait's minute between looks passes at once on the fake clock.
    sleep: async (ms) => {
      clock += ms
    },
    requestGate: (sessionId, request) => {
      let resolve!: (r: ApprovalResponse) => void
      const answer = new Promise<ApprovalResponse>((r) => (resolve = r))
      const gate = { id: `g-${++n}`, sessionId, request, resolve }
      gates.push(gate)
      return { id: gate.id, answer }
    },
    cancelGate: vi.fn((id: string) => gates.find((g) => g.id === id)?.resolve({ kind: 'gate', answer: 'stopped' })),
    changed: () => {},
    maxActive: options.maxActive
  }
  const service = new FlowService(deps)
  const run = () => state.flowRuns![0]
  return {
    service,
    deps,
    state,
    flushed,
    sent,
    checksBy,
    gates,
    prepared,
    launch,
    run,
    advance: (minutes: number) => (clock += minutes * 60_000),
    now: () => clock,
    /** The agent reported this in the latest message's turn. */
    report: (kind: string, text = '') => {
      const turnId = sent.at(-1)!.turnId
      reports.set(turnId, [...(reports.get(turnId) ?? []), { kind, text }])
    },
    start: async (inputs: Record<string, string> = { task: 'add a button' }) => {
      const started = service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs, shown: prepared.fingerprint })
      await settle()
      return started
    },
    /** The latest message's turn ends: its answer and how long it took go in the chat, then the service hears of it. */
    endTurn: async (outcome: TurnOutcome = 'completed', answer = 'I did it.', minutes = 1, costUsd?: number, delta?: { files: { path: string; additions: number; deletions: number }[]; additions: number; deletions: number }) => {
      const last = sent.at(-1)!
      chats.set(last.sessionId, [
        ...(chats.get(last.sessionId) ?? []),
        { kind: 'assistant', id: `a-${last.turnId}`, turnId: last.turnId, text: answer },
        ...(costUsd !== undefined ? [{ kind: 'result' as const, id: `r-${last.turnId}`, turnId: last.turnId, ok: true, costUsd }] : []),
        { kind: 'turn-end', id: `e-${last.turnId}`, turnId: last.turnId, outcome, durationMs: minutes * 60_000, ...(delta ? { delta } : {}) }
      ])
      await service.turnEnded(last.sessionId, last.turnId, outcome)
      await settle()
    }
  }
}

const names = (run: FlowRun) => run.steps.map((s) => s.name)

describe('running a flow', () => {
  it('writes the run, flushed, before anything launches', async () => {
    const h = harness()
    let seenAtLaunch: FlowRun[] | undefined
    h.launch.mockImplementationOnce(async (_run, first, handle) => {
      seenAtLaunch = structuredClone(h.state.flowRuns!)
      handle.created('ws-1', 's-1')
      h.sent.push({ sessionId: 's-1', text: first.text, turnId: 't-first' })
    })
    await h.start()
    expect(h.flushed[0]).toHaveLength(1)
    expect(h.flushed[0][0]).toMatchObject({ state: 'starting', flow: { name: 'Green' }, inputs: { task: 'add a button' }, fingerprint: h.prepared.fingerprint })
    expect(seenAtLaunch?.[0].steps.map((s) => s.name)).toEqual(['build'])
    expect(h.flushed.length).toBeGreaterThan(1)
    expect(h.sent[0].text).toBe('Build this: add a button')
    expect(h.run()).toMatchObject({ state: 'running', workspaceId: 'ws-1', current: { step: 'build', iteration: 1 } })
    expect(h.run().steps[0]).toMatchObject({ persona: 'developer', detail: 'persona: developer' })
  })

  it('turn → checks failed → fix → checks passed → gate continued → done completes', async () => {
    const h = harness(GREEN, { checks: ['failed', 'passed'] })
    await h.start()
    await h.endTurn('completed', 'Built the button.')
    // The fix continues the build's tab, unattended, with the failing output and the build's answer.
    const fix = h.sent.at(-1)!
    expect(fix.sessionId).toBe('s-1')
    // It continues the developer's tab, so it runs as the developer too.
    expect(fix.unattended).toEqual({ flowRunId: h.run().id, step: 'fix', persona: { name: 'developer', instructions: STARTER_PERSONAS.developer.instructions } })
    expect(fix.text).toContain('Fix the checks.')
    expect(fix.text).toContain('## Check results\n\n### Tests (exit 1)')
    expect(fix.text).toContain('## Answer from “build”\n\nBuilt the button.')
    // In the fixed order: a step's answer before the check results.
    expect(fix.text.indexOf('Answer from')).toBeLessThan(fix.text.indexOf('Check results'))
    // The developer persona is shown the task as well.
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'fix', persona: 'developer', shown: ['task', 'build.answer', 'checks.results'] })
    // The message says which run, step and pass sent it, and the check run which run and step started it.
    expect(fix.origin).toEqual({ kind: 'flow', runId: h.run().id, step: 'fix', iteration: 1 })
    expect(h.checksBy).toEqual([{ flowRun: h.run().id, step: 'checks' }])
    await h.endTurn()
    // Checks passed: the gate asks in the latest tab, showing the diff and the check results.
    expect(h.run().state).toBe('waiting')
    expect(h.gates).toHaveLength(1)
    expect(h.gates[0]).toMatchObject({ sessionId: 's-1', request: { kind: 'gate', step: 'ship', ask: 'Ship it?', flowName: 'Green' } })
    expect(showOf(h.gates[0].request)).toEqual([
      { kind: 'diff', summary: '1 file changed, +3 −1' },
      { kind: 'checks.results', summary: 'Tests passed' }
    ])
    h.gates[0].resolve({ kind: 'gate', answer: 'continued' })
    await settle()
    expect(h.run().state).toBe('completed')
    expect(names(h.run())).toEqual(['build', 'checks', 'fix', 'checks', 'ship'])
    expect(h.run().steps.map((s) => s.fact)).toEqual([undefined, 'failed', undefined, 'passed', 'continued'])
    expect(h.run().steps.every((s) => s.state === 'completed')).toBe(true)
    expect(h.run().steps[3].loops).toEqual({ green: 2 })
  })

  it('a bound on iterations ends the run as stopped, naming the loop and the bound', async () => {
    const h = harness(GREEN, { checks: ['failed', 'failed', 'failed', 'failed'] })
    await h.start()
    await h.endTurn()
    for (let i = 0; i < 3; i++) await h.endTurn()
    expect(h.run().state).toBe('stopped')
    expect(h.run().reason).toBe('Stopped: the loop “green” reached its bound of 3 iterations.')
    expect(names(h.run())).toEqual(['build', 'checks', 'fix', 'checks', 'fix', 'checks', 'fix'])
  })

  it('a bound on minutes ends the run as stopped, and time spent at a gate doesn’t count', async () => {
    const h = harness(ASKING)
    await h.start({})
    await h.endTurn('completed', 'First go.', 10)
    expect(h.gates).toHaveLength(1)
    // Two hours at the gate: none of it counts against the loop's 15 minutes.
    h.advance(120)
    h.gates[0].resolve({ kind: 'gate', answer: 'sent-back', note: 'Use the other API.' })
    await settle()
    const again = h.sent.at(-1)!
    expect(again.sessionId).toBe('s-1')
    expect(again.text).toContain('You sent the run back from the gate “ask” with this note. It is your instruction for this step:\n\nUse the other API.')
    expect(again.text).not.toContain('## Note from you')
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'work', iteration: 2, shown: ['note from you'] })
    expect(h.run().loops['ask-again'].minutesUsed).toBe(10)
    await h.endTurn('completed', 'Second go.', 10)
    expect(h.run().state).toBe('stopped')
    expect(h.run().reason).toBe('Stopped: the loop “ask-again” reached its bound of 15 minutes.')
    expect(names(h.run())).toEqual(['work', 'ask', 'work'])
  })

  it('a flush that fails doesn’t end the step: the record stays in memory and the gate still asks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness(GREEN, { checks: ['passed'], flushFailures: 3 })
      await h.start()
      await h.endTurn()
      expect(h.gates).toHaveLength(1)
      expect(h.run().state).toBe('waiting')
      expect(error).toHaveBeenCalled()
      // Later flushes write the record as usual.
      expect(h.flushed.at(-1)?.[0]).toMatchObject({ state: 'waiting' })
    } finally {
      error.mockRestore()
    }
  })

  it('a gate answered “send back” routes along its edge with the note', async () => {
    const h = harness(GREEN, { checks: ['passed', 'passed'] })
    await h.start()
    await h.endTurn()
    h.gates[0].resolve({ kind: 'gate', answer: 'sent-back', note: 'Rename the button.' })
    await settle()
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'ship', fact: 'sent-back', detail: 'Sent back: Rename the button.' })
    expect(h.run().steps.at(-1)?.name).toBe('fix')
    expect(h.sent.at(-1)!.text).toContain('You sent the run back from the gate “ship” with this note. It is your instruction for this step:\n\nRename the button.')
    // Leaving the loop through the gate closed its first pass; the send-back opened a second one with fresh bounds.
    expect(h.run().loops.green).toMatchObject({ pass: 2, open: true, iterations: 1 })
    expect(h.run().note).toBeUndefined()
  })

  it('Stop cancels the current turn and marks the run stopped', async () => {
    const h = harness()
    await h.start()
    await h.service.stopRun(h.run().id)
    expect(h.deps.cancel).toHaveBeenCalledWith('s-1')
    expect(h.run()).toMatchObject({ state: 'stopped', reason: 'Stopped by you.' })
    expect(h.run().steps[0].state).toBe('stopped')
    // The cancelled turn ending afterwards changes nothing.
    await h.endTurn('cancelled')
    expect(h.run().reason).toBe('Stopped by you.')
  })

  it('Stop at a gate takes the gate away; Stop during checks cancels the check run', async () => {
    const h = harness(GREEN, { checks: ['passed'] })
    await h.start()
    await h.endTurn()
    expect(h.run().state).toBe('waiting')
    await h.service.stopRun(h.run().id)
    expect(h.deps.cancelGate).toHaveBeenCalledWith(h.gates[0].id)
    expect(h.run().state).toBe('stopped')

    const c = harness()
    let finish!: (r: CheckResult[]) => void
    c.deps.startChecks = async () => ({ kind: 'started', done: new Promise<CheckResult[]>((r) => (finish = r)) })
    await c.start()
    await c.endTurn()
    expect(c.run().steps.at(-1)).toMatchObject({ name: 'checks', state: 'running' })
    await c.service.stopRun(c.run().id)
    expect(c.deps.cancelChecks).toHaveBeenCalledWith('ws-1')
    finish([])
    await settle()
    expect(c.run()).toMatchObject({ state: 'stopped', reason: 'Stopped by you.' })
  })

  it('an unattended turn that asks for something stops the run for the human (needs-you)', async () => {
    const h = harness()
    await h.start()
    h.service.needsHuman('s-1', 'it asked for permission to use Bash')
    expect(h.run().state).toBe('needs-you')
    expect(h.run().reason).toBe('Stopped: it asked for permission to use Bash. Nobody can answer a flow’s turn, so it was denied and left for you.')
    await h.endTurn('cancelled')
    expect(h.run().state).toBe('needs-you')
  })

  it('checks that need approval leave the run for you', async () => {
    const h = harness()
    h.deps.startChecks = async () => ({ kind: 'consent', names: ['Tests'] })
    await h.start()
    await h.endTurn()
    expect(h.run().state).toBe('needs-you')
    expect(h.run().reason).toContain('the checks need approval (Tests)')
  })

  it('refuses a start whose shown fingerprint isn’t what would run, naming what changed', () => {
    const h = harness()
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, shown: { ...h.prepared.fingerprint, flow: 'old', checks: 'old' } })).toThrow(
      `${SHOWN_CHANGED}. Changed: the flow and the repo’s checks.`
    )
    expect(h.state.flowRuns).toEqual([])
    expect(h.launch).not.toHaveBeenCalled()
  })

  it('runs the built-in starters: every step kind they use is carried out', async () => {
    const loadouts: Loadout[] = [1, 2, 3].map(() => ({ agent: 'claude', model: 'claude-sonnet-5', fast: false }))
    for (const starter of FLOW_STARTERS) {
      const h = harness(starter.toml, { loadouts })
      await h.start({ task: 'x' })
      expect(h.run().state).toBe('running')
    }
  })

  it('refuses a turn on another agent: unattended turns are Claude only', () => {
    const h = harness(GREEN, { loadouts: [{ agent: 'codex', model: 'gpt-5', fast: false }] })
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, shown: h.prepared.fingerprint })).toThrow(/Unattended turns are Claude only.*Not Claude: build \(Codex\)/)
    expect(h.state.flowRuns).toEqual([])
  })

  it('refuses missing inputs and more than the app-wide number of runs at once', async () => {
    const h = harness(GREEN, { maxActive: 1 })
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: h.prepared.fingerprint })).toThrow('Fill in “task”')
    await h.start()
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, shown: h.prepared.fingerprint })).toThrow('1 flow runs are going already')
  })

  it('after a restart, runs that were in flight are uncertain and never retried', async () => {
    const h = harness()
    await h.start()
    // A new service over the same state: Foreman started again.
    const state = { flowRuns: structuredClone(h.state.flowRuns ?? []) }
    const again = harness(GREEN, { state })
    again.service.start(60_000)
    again.service.stopTimer()
    expect(state.flowRuns[0]).toMatchObject({ state: 'uncertain' })
    expect(state.flowRuns[0].reason).toContain('not known how far it got. It was not retried.')
    expect(state.flowRuns[0].steps[0].state).toBe('stopped')
    expect(again.launch).not.toHaveBeenCalled()
  })
})

// Two turns: an architect plans (read-only, its own tab), then a developer implements in a new tab.
const PLANNED = `name = "Planned"

[start]
step = "plan"

[steps.plan]
kind = "turn"
prompt = "Plan it."
persona = "architect"

[steps.build]
kind = "turn"
prompt = "Build it."
persona = "developer"
mcp = ["docs"]

[edges]
plan = "build"
`

describe('personas in a run', () => {
  const narrowDeveloper = (() => {
    const read = parsePersona('---\nname: developer\nloadout: 2\nmcp: [docs, github]\n---\nYou build.', 'personal')
    if (!('persona' in read)) throw new Error(read.problems.join(' '))
    return read.persona
  })()

  it('carries each step’s persona to its turn: the instructions, read-only and the servers it keeps', async () => {
    const loadouts: Loadout[] = [{ agent: 'claude', model: 'claude-sonnet-5', fast: false }, { agent: 'claude', model: 'claude-opus-5', fast: false }]
    const h = harness(PLANNED, { loadouts, personas: { architect: STARTER_PERSONAS.architect, developer: narrowDeveloper } })
    const created: Loadout[] = []
    h.deps.createSession = (_ws, loadout) => (created.push(loadout), 's-2')
    await h.start({})
    // The architect's turn makes the workspace, read-only, with its instructions.
    expect(h.sent[0].persona).toEqual({ name: 'architect', instructions: STARTER_PERSONAS.architect.instructions, readOnly: true })
    expect(h.run().steps[0]).toMatchObject({ name: 'plan', persona: 'architect', readOnly: true })
    // Shown the task and the tree: before the workspace exists, the tree is the base branch it starts from.
    expect(h.run().steps[0].detail).toBe('persona: architect (read-only)')
    expect(h.run().steps[0].shown).toEqual(['tree'])
    expect(h.sent[0].text).toContain('## Tree\n\nBase branch: main')
    await h.endTurn('completed', 'The plan.')
    // The developer's turn: a new tab on the persona's default loadout, its MCP servers narrowed by the step.
    expect(created).toEqual([loadouts[1]])
    expect(h.sent[1].unattended).toEqual({ flowRunId: h.run().id, step: 'build', persona: { name: 'developer', instructions: 'You build.', mcp: ['docs'] } })
    expect(h.run().steps[1]).toMatchObject({ persona: 'developer', detail: 'persona: developer' })
    expect(h.run().steps[1].readOnly).toBeUndefined()
  })

  it('refuses to start when a persona a step names isn’t there, naming it', () => {
    const h = harness(GREEN, { personas: {} })
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, shown: h.prepared.fingerprint })).toThrow(
      'The persona “developer” (step “build”) isn’t here: no personal, repository, .claude/agents or built-in persona has that name.'
    )
    expect(h.state.flowRuns).toEqual([])
    expect(h.launch).not.toHaveBeenCalled()
  })

  it('refuses a step that loosens its persona, and a read-only persona on an agent that can’t hold it', () => {
    const loose = harness(PLANNED.replace('persona = "architect"', 'persona = "architect"\nread_only = false'))
    expect(() => loose.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: loose.prepared.fingerprint })).toThrow('can’t turn that off')
    const cursor = harness(PLANNED, { loadouts: [{ agent: 'cursor', model: 'auto', fast: false }] })
    expect(() => cursor.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: cursor.prepared.fingerprint })).toThrow(
      'The step “plan” is read-only (persona “architect”), which Cursor can’t enforce.'
    )
  })

  it('a persona’s default loadout that isn’t set refuses the start, naming the persona', () => {
    const h = harness(PLANNED, { personas: { architect: STARTER_PERSONAS.architect, developer: narrowDeveloper } })
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: h.prepared.fingerprint })).toThrow('Loadout 2 (persona “developer”, step “build”) isn’t set in Settings.')
  })

  it('a changed persona changes the fingerprint, so what was shown no longer starts', () => {
    const before = harness(PLANNED)
    const edited = { ...STARTER_PERSONAS.architect, instructions: `${STARTER_PERSONAS.architect.instructions} Be brief.` }
    const after = harness(PLANNED, { personas: { architect: edited, developer: STARTER_PERSONAS.developer } })
    expect(after.prepared.fingerprint.personas).not.toBe(before.prepared.fingerprint.personas)
    expect({ ...after.prepared.fingerprint, personas: '' }).toEqual({ ...before.prepared.fingerprint, personas: '' })
    // A new revision of the same text counts too: it is another file.
    const moved = harness(PLANNED, { personas: { architect: { ...STARTER_PERSONAS.architect, rev: 'abc' }, developer: STARTER_PERSONAS.developer } })
    expect(moved.prepared.fingerprint.personas).not.toBe(before.prepared.fingerprint.personas)
    expect(() => after.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: before.prepared.fingerprint })).toThrow(`${SHOWN_CHANGED}. Changed: its personas.`)
  })
})

// ---- the other step kinds ----

const start = (h: ReturnType<typeof harness>, inputs: Record<string, string> = {}) => h.start(inputs)
const findingsBlock = (items: unknown[]) => `Looked at it.\n\n\`\`\`foreman-findings\n${JSON.stringify(items)}\n\`\`\``

// A build, a read-only review of its diff, and an address step in the build's tab until the review is clean.
const REVIEWED = `name = "Reviewed"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build it."

[steps.review]
kind = "review"
context = ["build.answer"]

[steps.address]
kind = "turn"
same_tab = "build"
context = ["review.findings"]

[edges]
build = "review"
review = { clean = "done", findings = "address" }
address = "review"

[loops.review-loop]
over = ["review", "address"]
at_most = { iterations = 3 }
`

describe('review steps', () => {
  it('reads the captured diff in a read-only tab; an empty findings block is clean', async () => {
    const h = harness(REVIEWED)
    await start(h)
    await h.endTurn('completed', 'Built it.')
    const review = h.sent.at(-1)!
    expect(h.deps.createSession).toHaveBeenLastCalledWith('ws-1', { agent: 'claude', model: 'claude-sonnet-5', fast: false }, { title: 'Review · review' })
    expect(review.sessionId).not.toBe('s-1')
    expect(review.unattended).toEqual({ flowRunId: h.run().id, step: 'review', persona: { readOnly: true } })
    expect(review.text).toContain('foreman-findings')
    expect(review.text).toContain('## Answer from “build”\n\nBuilt it.')
    expect(review.text).toContain(`## Diff against main\n\n${PATCH}`)
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'review', readOnly: true, tree: { start: 'abc1234def' }, shown: ['build.answer', 'diff'] })
    await h.endTurn('completed', findingsBlock([]))
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'review', fact: 'clean' })
    expect(h.run().steps.at(-1)!.detail).toContain('No findings')
  })

  it('findings go to the next step as its `review.findings` section, and the loop reviews again', async () => {
    const h = harness(REVIEWED)
    await start(h)
    await h.endTurn('completed', 'Built it.')
    await h.endTurn('completed', findingsBlock([{ severity: 'high', file: 'src/a.ts', line: 3, title: 'Off by one', body: 'The loop skips the last item.' }]))
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'review', fact: 'findings' })
    const address = h.sent.at(-1)!
    expect(address.sessionId).toBe('s-1')
    expect(address.text).toContain('## Review findings from “review”')
    expect(address.text).toContain('1. [High] src/a.ts:3: Off by one')
    expect(address.text).toContain('tree abc1234')
    await h.endTurn('completed', 'Fixed it.')
    // The second review continues the reviewer's own tab.
    expect(h.sent.at(-1)!.sessionId).toBe(h.sent.at(-3)!.sessionId)
    await h.endTurn('completed', findingsBlock([]))
    expect(h.run().state).toBe('completed')
    expect(names(h.run())).toEqual(['build', 'review', 'address', 'review'])
  })

  it('a persona that ends with findings or done, ending with neither, is undecided and takes the findings edge', async () => {
    const qa = parsePersona('---\nname: qa\nread_only: true\nends_with: [review, done]\n---\nYou find.', 'personal')
    if (!('persona' in qa)) throw new Error('qa')
    const toml = REVIEWED.replace('kind = "review"\n', 'kind = "review"\npersona = "qa"\n')
    const h = harness(toml, { personas: { qa: qa.persona } })
    await start(h)
    await h.endTurn('completed', 'Built it.')
    await h.endTurn('completed', 'It looks fine to me.')
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'review', fact: 'undecided', persona: 'qa' })
    expect(h.run().steps.at(-1)!.name).toBe('address')
    expect(h.sent.at(-1)!.text).toContain('it is not known whether it found anything')
    // The same answer with `done` reported is clean; a review request is findings.
    await h.endTurn('completed', 'Fixed.')
    h.report('done')
    await h.endTurn('completed', 'Nothing left.')
    expect(h.run()).toMatchObject({ state: 'completed' })
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'review', fact: 'clean' })

    const asked = harness(toml, { personas: { qa: qa.persona } })
    await start(asked)
    await asked.endTurn('completed', 'Built it.')
    asked.report('review', 'The retry loop in src/a.ts')
    await asked.endTurn('completed', 'See my request.')
    expect(asked.run().steps.at(-2)).toMatchObject({ name: 'review', fact: 'findings' })
    expect(asked.sent.at(-1)!.text).toContain('- The retry loop in src/a.ts')
  })

  it('without such a persona, an answer with no findings block is clean', async () => {
    const h = harness(REVIEWED)
    await start(h)
    await h.endTurn('completed', 'Built it.')
    await h.endTurn('completed', 'No findings.')
    expect(h.run()).toMatchObject({ state: 'completed' })
    expect(h.run().steps.at(-1)).toMatchObject({ fact: 'clean' })
  })

  it('refuses at start a reviewer that can’t be held to read-only', () => {
    const h = harness(REVIEWED.replace('kind = "review"\n', 'kind = "review"\nagent = "cursor"\n'))
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: h.prepared.fingerprint })).toThrow('The review step “review” runs on Cursor, which can’t be held to read-only')
  })
})

const SCRIPTED = `name = "Scripted"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build it."

[steps.lint]
kind = "script"
command = "lint"

[steps.fix]
kind = "turn"
same_tab = "build"
prompt = "Fix what the linter says."
context = ["lint.output"]

[edges]
build = "lint"
lint = { ok = "done", failed = "fix" }
fix = "lint"

[loops.lint-clean]
over = ["lint", "fix"]
at_most = { iterations = 3 }
`

describe('script steps', () => {
  it('runs the saved command: failed sends its output to the next step, ok goes on', async () => {
    const h = harness(SCRIPTED)
    const outputs = [{ code: 1, output: 'src/a.ts:3 unused variable' }, { code: 0, output: 'clean' }]
    vi.mocked(h.deps.runCommand).mockImplementation(async () => ({ kind: 'started', done: Promise.resolve(outputs.shift()!) }))
    await start(h)
    await h.endTurn()
    await settle()
    expect(h.deps.runCommand).toHaveBeenCalledWith('ws-1', 'lint')
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'lint', fact: 'failed', detail: 'lint: exit 1' })
    expect(h.sent.at(-1)!.text).toContain('## Output of “lint”\n\nsrc/a.ts:3 unused variable')
    await h.endTurn()
    await settle()
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.map((s) => s.fact)).toEqual([undefined, 'failed', undefined, 'ok'])
  })

  it('a command that needs approval leaves the run for you', async () => {
    const h = harness(SCRIPTED)
    vi.mocked(h.deps.runCommand).mockResolvedValue({ kind: 'consent', name: 'lint' })
    await start(h)
    await h.endTurn()
    await settle()
    expect(h.run().state).toBe('needs-you')
    expect(h.run().reason).toContain('the command needs approval (lint)')
  })

  it('refuses at start a command that isn’t saved, and Stop cancels one that runs', async () => {
    const missing = harness(SCRIPTED, { commands: {} })
    expect(() => missing.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: {}, shown: missing.prepared.fingerprint })).toThrow('The command “lint” (step “lint”) isn’t saved for this repository')

    const h = harness(SCRIPTED)
    vi.mocked(h.deps.runCommand).mockResolvedValue({ kind: 'started', done: new Promise(() => {}) })
    await start(h)
    await h.endTurn()
    await settle()
    await h.service.stopRun(h.run().id)
    expect(h.deps.cancelCommand).toHaveBeenCalledWith('ws-1')
    expect(h.run().state).toBe('stopped')
  })

  it('a script command is part of the fingerprint', () => {
    const a = harness(SCRIPTED)
    const b = harness(SCRIPTED, { commands: { lint: { name: 'lint', command: 'npm run lint -- --fix', source: 'repo' } } })
    expect(b.prepared.fingerprint.checks).not.toBe(a.prepared.fingerprint.checks)
  })
})

const DECIDED = `name = "Decided"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build it."

[steps.size]
kind = "decide"
options = ["small", "large"]
prompt = "How big is this change?"

[steps.split]
kind = "turn"
prompt = "Split it into two changes."

[steps.ask]
kind = "gate"
ask = "Nobody decided. Look?"

[edges]
build = "size"
size = { small = "done", large = "split", undecided = "ask" }
`

describe('decide steps', () => {
  it('a read-only turn offered the decide tool; the option it decides chooses the edge', async () => {
    const h = harness(DECIDED)
    await start(h)
    await h.endTurn()
    const decide = h.sent.at(-1)!
    expect(decide.unattended).toEqual({ flowRunId: h.run().id, step: 'size', persona: { readOnly: true }, decide: ['small', 'large'] })
    expect(decide.text).toContain('How big is this change?')
    expect(decide.text).toContain('Decide exactly one of these options: small, large.')
    expect(h.deps.createSession).toHaveBeenLastCalledWith('ws-1', expect.anything(), { title: 'Decide · size' })
    h.report('decide', 'large')
    await h.endTurn('completed', 'It is large.')
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'size', fact: 'large', readOnly: true })
    expect(h.run().steps.at(-1)!.name).toBe('split')
  })

  it('a turn that ends without deciding, or decides something else, is undecided; words in the answer never count', async () => {
    const h = harness(DECIDED)
    await start(h)
    await h.endTurn()
    h.report('decide', 'huge')
    await h.endTurn('completed', 'small')
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'size', fact: 'undecided' })
    expect(h.run().state).toBe('waiting')
    expect(h.gates[0].request).toMatchObject({ kind: 'gate', step: 'ask' })
  })
})

describe('the decide tool', () => {
  const rig = (unattended: Session['unattended']) => {
    const session = { id: 's', workspaceId: 'w', status: 'running', agent: 'claude', turnId: 't', unattended } as Session
    const record = vi.fn(() => ({ added: true }))
    const actions = new ForemanActions({ state: () => ({ workspaces: [], sessions: [session] }), api: {} as never, record })
    return { actions, record }
  }

  it('records an option the step names, and refuses one it doesn’t', () => {
    const { actions, record } = rig({ flowRunId: 'run', step: 'size', decide: ['small', 'large'] })
    expect(() => actions.decide('s', 'huge')).toThrow('“huge” isn’t one of the options. Decide one of: small, large.')
    expect(record).not.toHaveBeenCalled()
    expect(actions.decide('s', ' large ').decided).toBe('large')
    expect(record).toHaveBeenCalledWith({ workspaceId: 'w', sessionId: 's', turnId: 't', kind: 'decide', text: 'large', via: 'mcp' })
  })

  it('refuses outside a decide step’s turn', () => {
    expect(() => rig({ flowRunId: 'run', step: 'build' }).actions.decide('s', 'small')).toThrow('Only a flow’s decide step decides')
    expect(() => rig(undefined).actions.decide('s', 'small')).toThrow('Only a flow’s decide step decides')
  })
})

const WAITED = `name = "Waited"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build it and open a pull request."

[steps.ci]
kind = "wait"
on = "ci"
at_most = { minutes = 30 }

[steps.fix]
kind = "turn"
same_tab = "build"
prompt = "CI failed. Fix it."

[edges]
build = "ci"
ci = { green = "done", failed = "fix", none = "done", timed-out = "done" }
fix = "ci"

[loops.ci-green]
over = ["ci", "fix"]
at_most = { iterations = 3, minutes = 20 }
`

const facts = (checks: 'passed' | 'failing' | 'pending' | 'none', review: 'approved' | 'changes-requested' | 'required' | 'unknown' = 'unknown'): FlowPullRequest => ({ kind: 'facts', facts: { checks, review } })

describe('wait steps', () => {
  it('looks once a minute until CI is green, and the wait counts no loop minutes', async () => {
    const h = harness(WAITED)
    const answers = [facts('pending'), facts('pending'), facts('passed')]
    vi.mocked(h.deps.pullRequest).mockImplementation(async () => answers.shift()!)
    await start(h)
    const before = h.now()
    await h.endTurn('completed', 'Opened #12.', 2)
    await settle()
    expect(h.deps.pullRequest).toHaveBeenCalledTimes(3)
    // Two minutes between the three looks: never faster than once a minute.
    expect(h.now() - before).toBe(2 * 60_000)
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'ci', fact: 'green', minutes: 0, detail: 'CI passed after 2 min' })
    expect(h.run().loops['ci-green'].minutesUsed).toBe(0)
  })

  it('failed CI takes the failed edge; nothing settling within the bound is timed-out', async () => {
    const h = harness(WAITED)
    const answers = [facts('failing'), facts('pending')]
    vi.mocked(h.deps.pullRequest).mockImplementation(async () => answers.shift() ?? facts('pending'))
    await start(h)
    await h.endTurn()
    await settle()
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'ci', fact: 'failed' })
    expect(h.run().steps.at(-1)!.name).toBe('fix')
    await h.endTurn()
    await settle()
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'ci', fact: 'timed-out', detail: 'Nothing settled within 30 minutes after 30 min' })
  })

  it('a review wait settles on approved or changes requested; no pull request fails the run', async () => {
    const review = harness(WAITED.replace('on = "ci"', 'on = "review"').replace('ci = { green = "done", failed = "fix", none = "done", timed-out = "done" }', 'ci = { approved = "done", changes-requested = "fix", timed-out = "done" }'))
    const answers = [facts('passed', 'required'), facts('passed', 'changes-requested')]
    vi.mocked(review.deps.pullRequest).mockImplementation(async () => answers.shift() ?? facts('passed', 'approved'))
    await start(review)
    await review.endTurn()
    await settle()
    expect(review.run().steps.at(-2)).toMatchObject({ name: 'ci', fact: 'changes-requested' })

    const none = harness(WAITED)
    vi.mocked(none.deps.pullRequest).mockResolvedValue({ kind: 'no-pr' })
    await start(none)
    await none.endTurn()
    await settle()
    expect(none.run()).toMatchObject({ state: 'failed', reason: 'The wait step “ci” needs a pull request, and this workspace has none.' })
  })
})

// Two tries in sibling workspaces, then a person picks one and the run goes on there.
const SIBLINGS = `name = "Siblings"

[start]
step = "try-a"

[steps.try-a]
kind = "turn"
prompt = "Do it one way."

[steps.second]
kind = "workspace"

[steps.try-b]
kind = "turn"
prompt = "Do it another way."

[steps.choose]
kind = "pick"
over = ["try-a", "try-b"]

[steps.polish]
kind = "turn"
prompt = "Polish it."

[edges]
try-a = "second"
second = "try-b"
try-b = "choose"
choose = "polish"
`

describe('workspace and pick steps', () => {
  it('a workspace step makes a new workspace from the base branch; later turns run there; a pick goes on in the chosen one', async () => {
    const h = harness(SIBLINGS)
    await start(h)
    await h.endTurn('completed', 'Way A.')
    await settle()
    expect(h.deps.newWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: h.run().id }), undefined)
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'second', fact: 'ready', workspaceId: 'ws-2', detail: 'From main' })
    expect(h.deps.createSession).toHaveBeenLastCalledWith('ws-2', expect.anything(), undefined)
    expect(h.run()).toMatchObject({ workspaceId: 'ws-2', workspaces: ['ws-1', 'ws-2'] })
    await h.endTurn('completed', 'Way B.')
    expect(h.run().state).toBe('waiting')
    const pick = h.gates[0]
    expect(pick.request).toMatchObject({ kind: 'pick', step: 'choose', flowName: 'Siblings' })
    const choices = pick.request.kind === 'pick' ? pick.request.choices : []
    expect(choices.map((c) => [c.step, c.workspaceId])).toEqual([
      ['try-a', 'ws-1'],
      ['try-b', 'ws-2']
    ])
    expect(choices[0].summary).toBe('1 file changed, +3 −1 · last turn try-a: completed · checks: not run')
    pick.resolve({ kind: 'pick', chosen: 'try-a' })
    await settle()
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'choose', fact: 'try-a', workspaceId: 'ws-1' })
    expect(h.run().workspaceId).toBe('ws-1')
    expect(h.deps.createSession).toHaveBeenLastCalledWith('ws-1', expect.anything(), undefined)
  })

  it('from a step: the workspace starts from that turn’s end; a failed setup with no edge for it fails the run', async () => {
    const h = harness(SIBLINGS.replace('kind = "workspace"', 'kind = "workspace"\nfrom = "try-a"'))
    await start(h)
    await h.endTurn('completed', 'Way A.')
    await settle()
    expect(h.deps.newWorkspace).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', sessionId: 's-1', turnId: 't-first' })
    expect(h.run().steps.at(-2)).toMatchObject({ name: 'second', fact: 'ready', detail: 'From the end of “try-a”' })

    const failed = harness(SIBLINGS)
    vi.mocked(failed.deps.newWorkspace).mockResolvedValue({ workspaceId: 'ws-2', sessionId: 's-ws2', failed: 'npm install exited 1' })
    await start(failed)
    await failed.endTurn()
    await settle()
    expect(failed.run()).toMatchObject({ state: 'failed', reason: 'Setup failed in the workspace “second” made, so the steps after it didn’t run.' })
  })

  it('a pick answered with nothing stops the run', async () => {
    const h = harness(SIBLINGS)
    await start(h)
    await h.endTurn()
    await settle()
    await h.endTurn()
    h.gates[0].resolve({ kind: 'pick', chosen: null })
    await settle()
    expect(h.run()).toMatchObject({ state: 'stopped', reason: 'Stopped at the pick “choose”: nothing was chosen.' })
  })
})

describe('iteration policies', () => {
  const COMPACT = GREEN.replace('at_most = { iterations = 3, minutes = 30 }', 'at_most = { iterations = 3, minutes = 30 }\niteration = "compact-when-full"\ncompact_above = 70')

  it('compact-when-full sends /compact first when the tab is past the threshold, and waits for it', async () => {
    const h = harness(COMPACT, { checks: ['failed'] })
    h.deps.contextUsage = () => ({ used: 150_000, limit: 200_000 })
    h.deps.canCompact = () => true
    await h.start()
    await h.endTurn()
    const compact = h.sent.at(-1)!
    expect(compact).toMatchObject({ sessionId: 's-1', text: '/compact' })
    expect(compact.unattended).toEqual({ flowRunId: h.run().id, step: 'fix' })
    // The compaction ends; then the step's own message goes in the same tab.
    await h.endTurn('completed', '')
    expect(h.sent.at(-1)!.text).toContain('Fix the checks.')
    expect(h.sent.at(-1)!.sessionId).toBe('s-1')
    expect(h.run().steps.at(-1)!.detail).toContain('compacted at 75% of the context window')
  })

  it('below the threshold nothing is compacted; an agent with no compact command gets a fresh tab with the ledger', async () => {
    const below = harness(COMPACT, { checks: ['failed'] })
    below.deps.contextUsage = () => ({ used: 100_000, limit: 200_000 })
    below.deps.canCompact = () => true
    await below.start()
    await below.endTurn()
    expect(below.sent.map((s) => s.text)).not.toContain('/compact')
    expect(below.sent.at(-1)!.sessionId).toBe('s-1')

    const cant = harness(COMPACT, { checks: ['failed'] })
    cant.deps.contextUsage = () => ({ used: 190_000, limit: 200_000 })
    cant.deps.canCompact = () => false
    await cant.start()
    await cant.endTurn()
    expect(cant.sent.at(-1)!.sessionId).not.toBe('s-1')
    expect(cant.sent.at(-1)!.text).toContain('## Run ledger')
    expect(cant.run().steps.at(-1)!.shown).toContain('ledger')
  })

  it('fresh-with-summary starts each pass in a new tab, seeded with the run ledger', async () => {
    const h = harness(GREEN.replace('at_most = { iterations = 3, minutes = 30 }', 'at_most = { iterations = 3, minutes = 30 }\niteration = "fresh-with-summary"'), { checks: ['failed'] })
    await h.start()
    await h.endTurn('completed', 'Built the button.')
    const fix = h.sent.at(-1)!
    expect(fix.sessionId).not.toBe('s-1')
    expect(fix.text).toContain('## Run ledger\n\n- build (turn, run 1) · completed')
    expect(fix.text).toContain('  Last answer: Built the button.')
    expect(fix.text).toContain('- checks (checks, run 1, green iteration 1) · ended: failed · Tests failed')
    expect(h.run().steps.at(-1)!.shown).toEqual(['task', 'build.answer', 'checks.results', 'ledger'])
  })
})

describe('after a run, and cost bounds', () => {
  it('a completed run archives the workspaces it made, as `[after]` says; a stopped one keeps them', async () => {
    const h = harness(`${ASKING}\n[after]\nworkspace = "archive"\n`)
    await h.start({})
    await h.endTurn()
    h.gates[0].resolve({ kind: 'gate', answer: 'continued' })
    await settle()
    expect(h.run().state).toBe('completed')
    expect(h.deps.afterRun).toHaveBeenCalledWith(h.run(), 'ws-1', 'archive')

    const stopped = harness(`${ASKING}\n[after]\nworkspace = "delete-unchanged"\n`)
    await stopped.start({})
    await stopped.service.stopRun(stopped.run().id)
    expect(stopped.deps.afterRun).not.toHaveBeenCalled()
  })

  it('a cost bound sums what the loop’s turns cost and stops the run naming it', async () => {
    const h = harness(GREEN.replace('at_most = { iterations = 3, minutes = 30 }', 'at_most = { cost = 1 }'), { checks: ['failed', 'failed', 'failed'] })
    await h.start()
    await h.endTurn('completed', 'Built.', 1, 5)
    // The build is outside the loop: its cost doesn't count.
    await h.endTurn('completed', 'Fixed.', 1, 0.6)
    expect(h.run().loops.green.costUsed).toBeCloseTo(0.6)
    expect(h.run().steps.find((x) => x.name === 'fix')).toMatchObject({ costUsd: 0.6 })
    expect(h.run().steps.find((x) => x.name === 'build')).toMatchObject({ costUsd: 5 })
    await h.endTurn('completed', 'Fixed again.', 1, 0.6)
    expect(h.run().state).toBe('stopped')
    expect(h.run().reason).toBe('Stopped: the loop “green” reached its bound of $1.00 (what Claude’s turns reported they cost).')
  })
})

// The lenses' records (docs/loops-and-graphs.md, "Four graphs over one flow"): each step keeps the window its turn ended
// with, the memory it read and wrote, the note revision it saw and its trees, and a step whose tree moved says so.
const LENS = `name = "Lens"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build it."

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "build"
prompt = "Fix it."
context = ["note", "checks.results"]

[edges]
build = "checks"
checks = { passed = "done", failed = "fix" }
fix = "checks"

[loops.green]
over = ["checks", "fix"]
at_most = { iterations = 3 }
`

describe('what the lenses read', () => {
  it('records each turn’s window, memory read and written, note revision, model and trees, and marks a moved tree', async () => {
    const h = harness(LENS, { checks: ['failed', 'passed'] })
    // The working tree as each read finds it: the build's end, the checks' start, the fix's start (moved), its end, the checks' start.
    const trees = ['a'.repeat(40), 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'c'.repeat(40)]
    h.deps.workingTree = vi.fn(async () => trees.shift())
    h.deps.note = () => 'Keep the API.'
    h.deps.noteRevision = () => 3
    let used = 61_000
    h.deps.contextUsage = () => ({
      used,
      limit: 1_000_000,
      breakdown: { categories: [], mcpServers: [], skills: [], memoryFiles: [{ path: '/repo/CLAUDE.md', tokens: 900 }, { path: '/repo/docs/team-notes.md', tokens: 300 }] }
    })
    await h.start({})
    const files = (paths: string[]) => ({ files: paths.map((path) => ({ path, additions: 1, deletions: 0 })), additions: paths.length, deletions: 0 })
    await h.endTurn('completed', 'Built.', 4, undefined, files(['src/a.ts', 'CLAUDE.md', 'docs/team-notes.md', 'docs/readme.md']))
    const [build, checks] = h.run().steps
    expect(build).toMatchObject({
      name: 'build',
      model: 'claude-sonnet-5',
      usage: { used: 61_000, limit: 1_000_000 },
      memoryFiles: ['/repo/CLAUDE.md', '/repo/docs/team-notes.md'],
      memoryWrites: ['CLAUDE.md', 'docs/team-notes.md'],
      tree: { end: 'aaaaaaaaaaaa' }
    })
    // The launching turn has no start tree: its workspace didn't exist before it.
    expect(build.tree?.start).toBeUndefined()
    // Checks read the tree the build ended on: not moved.
    expect(checks).toMatchObject({ name: 'checks', tree: { start: 'aaaaaaaaaaaa' }, fact: 'failed' })
    expect(checks.moved).toBeUndefined()
    // Something changed files between the checks and the fix.
    const fix = h.run().steps.at(-1)!
    expect(fix).toMatchObject({ name: 'fix', tree: { start: 'bbbbbbbbbbbb' }, moved: true, noteRevision: 3, shown: ['checks.results', 'note'] })
    used = 84_000
    await h.endTurn('completed', 'Fixed.', 2, undefined, files(['src/a.ts']))
    const fixed = h.run().steps.find((s) => s.name === 'fix')!
    expect(fixed).toMatchObject({ usage: { used: 84_000, limit: 1_000_000 }, tree: { start: 'bbbbbbbbbbbb', end: 'cccccccccccc' } })
    expect(fixed.memoryWrites).toBeUndefined()
    expect(fixed.detail).toContain('tree moved since the last step')
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.at(-1)).toMatchObject({ name: 'checks', tree: { start: 'cccccccccccc' } })
    expect(h.run().steps.at(-1)!.moved).toBeUndefined()
    // Short: twelve characters a hash, whatever the reader gave.
    for (const step of h.run().steps) for (const hash of Object.values(step.tree ?? {})) expect(hash).toHaveLength(12)
  })

  it('a tree that can’t be read is left out, never a reason to stop; a script and a workspace step record theirs', async () => {
    const h = harness(LENS, { checks: ['passed'] })
    h.deps.workingTree = vi.fn(async () => {
      throw new Error('not a git repository')
    })
    await h.start({})
    await h.endTurn()
    expect(h.run().state).toBe('completed')
    expect(h.run().steps.every((s) => s.tree === undefined && !s.moved)).toBe(true)

    const scripted = harness(`name = "Scripted"

[start]
step = "work"

[steps.work]
kind = "turn"
prompt = "Work."

[steps.lint]
kind = "script"
command = "lint"

[steps.again]
kind = "workspace"

[edges]
work = "lint"
lint = "again"
`)
    scripted.deps.workingTree = vi.fn(async (ws: string) => (ws === 'ws-2' ? 'f'.repeat(40) : 'e'.repeat(40)))
    await scripted.start({})
    await scripted.endTurn()
    await settle()
    const steps = scripted.run().steps
    expect(steps.find((s) => s.name === 'lint')).toMatchObject({ tree: { start: 'eeeeeeeeeeee' } })
    expect(steps.find((s) => s.name === 'again')).toMatchObject({ tree: { end: 'ffffffffffff' } })
  })
})
