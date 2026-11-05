// Running a flow (docs/loops-and-graphs.md, "Running a flow"): FlowService with fake deps, as tests/schedules.test.ts
// drives ScheduleService. A run is written before anything launches; turns, checks and gates follow the edges; loop
// bounds stop the run naming the bound; Stop, needs-you, the fingerprint and the start refusals; uncertain after a restart.
import { describe, expect, it, vi } from 'vitest'
import { FlowService, flowFingerprintOf, type FlowServiceDeps, type PreparedFlow } from '../src/main/flows'
import { SHOWN_CHANGED } from '../src/main/schedules'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type FlowRun } from '../src/shared/flows'
import { parsePersona, type Persona } from '../src/shared/personas'
import { PERSONA_STARTERS } from '../src/shared/personaStarters'
import type { Loadout } from '../src/shared/agents'
import type { ApprovalRequest, ApprovalResponse, ChatItem, CheckResult, TurnOutcome } from '../src/shared/types'

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

type Gate = { id: string; sessionId: string; request: Omit<Extract<ApprovalRequest, { kind: 'gate' }>, 'id' | 'sessionId'>; resolve(r: ApprovalResponse): void }

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

function harness(toml = GREEN, options: { checks?: CheckResult['status'][]; loadouts?: Loadout[]; state?: { flowRuns?: FlowRun[] }; maxActive?: number; flushFailures?: number; personas?: Record<string, Persona | undefined> } = {}) {
  let flushFailures = options.flushFailures ?? 0
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
  const { flow } = parsed
  const state = options.state ?? { flowRuns: [] as FlowRun[] }
  let clock = Date.parse('2026-11-05T10:00:00Z')
  const flushed: FlowRun[][] = []
  const sent: { sessionId: string; text: string; turnId: string; unattended?: unknown; persona?: unknown }[] = []
  const chats = new Map<string, ChatItem[]>()
  const gates: Gate[] = []
  const checks = [...(options.checks ?? [])]
  let n = 0
  // The personas the flow's steps name, as prepare resolves them: the built-in ones unless the test says otherwise.
  const personas: Record<string, Persona | undefined> = {}
  for (const step of flow.steps) if ('persona' in step && step.persona) personas[step.persona] = options.personas ? options.personas[step.persona] : STARTER_PERSONAS[step.persona]
  const prepared: PreparedFlow = {
    flow,
    ref: { id: 'flow-1', name: flow.name, source: 'personal' },
    templates: {},
    personas,
    fingerprint: flowFingerprintOf({ flow, templates: [], personas: Object.values(personas).filter((p): p is Persona => Boolean(p)), setupScript: '', checks: [{ name: 'Tests', command: 'npm test' }], mcp: [] })
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
    createSession: () => `s-new-${++n}`,
    deliver: async (sessionId, text, o) => {
      sent.push({ sessionId, text, turnId: o.turnId, unattended: o.unattended })
    },
    cancel: vi.fn(async () => {}),
    startChecks: async () => {
      const status = checks.shift() ?? 'passed'
      return { kind: 'started', done: Promise.resolve([{ name: 'Tests', command: 'npm test', status, startedAt: '', logPath: '', fingerprint: { tree: '', command: '', source: 'local' } } as CheckResult]) }
    },
    cancelChecks: vi.fn(async () => {}),
    checksResults: async () => '### Tests (exit 1)\nexpected 1 to be 2',
    readChat: async (sessionId) => chats.get(sessionId) ?? [],
    reported: () => [],
    diffStat: async () => 'src/a.ts +3 −1\n1 file changed, +3 −1',
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
    gates,
    prepared,
    launch,
    run,
    advance: (minutes: number) => (clock += minutes * 60_000),
    start: async (inputs: Record<string, string> = { task: 'add a button' }) => {
      const started = service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs, shown: prepared.fingerprint })
      await settle()
      return started
    },
    /** The latest message's turn ends: its answer and how long it took go in the chat, then the service hears of it. */
    endTurn: async (outcome: TurnOutcome = 'completed', answer = 'I did it.', minutes = 1) => {
      const last = sent.at(-1)!
      chats.set(last.sessionId, [
        ...(chats.get(last.sessionId) ?? []),
        { kind: 'assistant', id: `a-${last.turnId}`, turnId: last.turnId, text: answer },
        { kind: 'turn-end', id: `e-${last.turnId}`, turnId: last.turnId, outcome, durationMs: minutes * 60_000 }
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
    await h.endTurn()
    // Checks passed: the gate asks in the latest tab, showing the diff and the check results.
    expect(h.run().state).toBe('waiting')
    expect(h.gates).toHaveLength(1)
    expect(h.gates[0]).toMatchObject({ sessionId: 's-1', request: { kind: 'gate', step: 'ship', ask: 'Ship it?', flowName: 'Green' } })
    expect(h.gates[0].request.show).toEqual([
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

  it('refuses a flow with step kinds this version can’t run, listing them', () => {
    const h = harness(FLOW_STARTERS[0].toml)
    expect(() => h.service.begin({ flowId: 'flow-1', repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, shown: h.prepared.fingerprint })).toThrow('can’t run review steps yet: review (review)')
    expect(h.state.flowRuns).toEqual([])
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
    // Shown the task and the tree: the tree isn't sent in this version, and the step says so.
    expect(h.run().steps[0].detail).toBe('persona: architect (read-only) · not sent yet: tree')
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
