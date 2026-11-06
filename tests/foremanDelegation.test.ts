import { describe, expect, it, vi } from 'vitest'
import { delegationRig } from './foremanDelegationHarness'
import { send } from '../src/main/cli/work'
import { DELEGATION_TOOLS, delegationToolNames } from '../src/shared/foremanDelegation'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import type { FlowListing, FlowRun, FlowRunOrigin, FlowRunStart, FlowRunSummary } from '../src/shared/flows'

describe('CLI-backed Foreman delegation', () => {
  it('discovers loadouts and runs research, planning, then two implementation tasks in isolated workspaces', async () => {
    const r = delegationRig()
    expect(await r.service.call('list_delegation_options', {}, r.scope)).toMatchObject({ delegationEnabled: true, loadouts: [
      { slot: 1, agent: 'claude', model: 'fable' }, { slot: 2, agent: 'codex', model: 'astra' },
      { slot: 3, agent: 'opencode' }, { slot: 4, agent: 'cursor' }
    ], repositories: [{ id: 'r' }] })
    await r.service.call('start_task', { prompt: 'Research the problem', loadout: 1 }, r.scope)
    // The new workspace records the coordinating chat and its running turn (Workspace.startedBy).
    expect(r.createWorkspace).toHaveBeenLastCalledWith('r', expect.objectContaining({ prompt: 'Research the problem', loadout: r.state.settings.loadouts[0], branch: { kind: 'new', name: undefined } }), { startedBy: { sessionId: 's', turnId: 'own', via: 'delegation' } })
    expect(r.setupOutcome).not.toHaveBeenCalled()
    const research = r.state.workspaces[1]
    expect(await r.service.call('get_task_status', { workspaceId: research.id }, r.scope)).toMatchObject({ state: 'setting-up', setupHeld: false })
    research.state = 'ready'
    const researchChat = r.state.sessions[1]
    researchChat.lastTurn = { turnId: 'research', outcome: 'completed', endedAt: '' }
    r.turns.set('research', { workspaceId: research.id, sessionId: researchChat.id, turnId: 'research', state: 'ended', outcome: 'completed' })
    r.chats.set(researchChat.id, [{ kind: 'assistant', id: 'a', turnId: 'research', text: 'Use two independent modules.' }])
    expect(await r.service.call('get_task_status', { workspaceId: research.id }, r.scope)).toMatchObject({ sessions: [{ lastTurn: { turnId: 'research' } }] })
    expect(await r.service.call('wait_for_turn', { turnId: 'research' }, r.scope)).toMatchObject({ outcome: 'completed' })
    const result = await r.service.call('get_turn_result', { turnId: 'research' }, r.scope) as { reply: string }
    await r.service.call('start_task', { prompt: `Plan from these findings: ${result.reply}`, loadout: 2 }, r.scope)
    await Promise.all([3, 4].map((loadout) => r.service.call('start_task', { prompt: `Implement module ${loadout}`, loadout }, r.scope)))
    expect(r.createWorkspace.mock.calls.map(([, options]) => options.loadout?.agent)).toEqual(['claude', 'codex', 'opencode', 'cursor'])
    expect(new Set(r.state.workspaces.map((w) => w.id)).size).toBe(5)
    const child = r.state.workspaces[2]
    child.state = 'ready'
    const handoff = await r.service.call('send_task', { workspaceId: child.id, sessionId: r.state.sessions[2].id, prompt: 'Revise the plan with this finding.' }, r.scope) as { turn: string }
    // The queued message says which chat sent it (MessageOrigin delegation).
    expect(r.deliver).toHaveBeenCalledWith(r.state.sessions[2].id, 'Revise the plan with this finding.', expect.objectContaining({ mode: 'queue', via: 'cli', origin: { kind: 'delegation', sessionId: 's', turnId: 'own' } }))
    expect(await r.service.call('cancel_turn', { turnId: handoff.turn }, r.scope)).toMatchObject({ outcome: 'cancelled', was: 'queued' })
  })

  it('a workspace the assistant starts records its thread', async () => {
    const r = delegationRig()
    await r.service.call('start_task', { prompt: 'Research', loadout: 1, repoId: 'r' }, { readOnly: false, assistantThread: 'thread-1' })
    expect(r.createWorkspace).toHaveBeenLastCalledWith('r', expect.objectContaining({ prompt: 'Research' }), { startedBy: { sessionId: 'thread-1', via: 'assistant' } })
  })

  it('requires the repo opt-in, refuses cross-repo targets, and never accepts bypass flags', async () => {
    const r = delegationRig()
    r.allowed.value = false
    await expect(r.service.call('start_task', { prompt: 'Research', loadout: 1 }, r.scope)).rejects.toThrow('Let agents')
    expect(await r.service.call('list_delegation_options', {}, r.scope)).toMatchObject({ delegationEnabled: false })
    r.allowed.value = true
    await expect(r.service.call('start_task', { prompt: 'Research', loadout: 1, repoId: 'other' }, r.scope)).rejects.toThrow('coordinating repository')
    await expect(r.service.call('start_task', { prompt: 'Research', loadout: 1, startAnyway: true }, r.scope)).rejects.toThrow()
    await expect(r.service.call('start_task', { prompt: 'Research', loadout: 5 }, r.scope)).rejects.toThrow('not configured')
    await expect(r.service.call('start_task', { prompt: 'Research', loadout: 1 }, { ...r.scope, readOnly: true })).rejects.toThrow('only read')
    r.state.workspaces.push({ ...r.ws, id: 'foreign', repoId: 'other' })
    r.turns.set('foreign-turn', { workspaceId: 'foreign', sessionId: 'foreign-chat', turnId: 'foreign-turn', state: 'ended', outcome: 'completed' })
    await expect(r.service.call('get_turn_result', { turnId: 'foreign-turn' }, r.scope)).rejects.toThrow('coordinating repository')
    expect(r.getChat).not.toHaveBeenCalled()
    expect(r.createWorkspace).not.toHaveBeenCalled()
  })

  it('returns only the selected turn’s visible reply with explicit truncation', async () => {
    const r = delegationRig()
    r.chats.set('s', [
      { kind: 'assistant', id: 'old', turnId: 'old', text: 'other-turn' },
      { kind: 'thinking', id: 'thinking', turnId: 'own', text: 'private-reasoning' },
      { kind: 'tool', id: 'tool', turnId: 'own', name: 'read', input: {}, status: 'done', output: 'tool-secret' },
      { kind: 'assistant', id: 'reply', turnId: 'own', text: '1234567890' }
    ])
    const result = await r.service.call('get_turn_result', { turnId: 'own', maxChars: 5 }, r.scope)
    expect(result).toMatchObject({ state: 'running', reply: '67890', truncated: true, contentIsData: true })
    expect(JSON.stringify(result)).not.toMatch(/private-reasoning|tool-secret|other-turn/)
  })

  it('waits are bounded, cannot wait/cancel the coordinator chat, and recheck revoked grants while polling', async () => {
    const r = delegationRig()
    await expect(r.service.call('wait_for_turn', { turnId: 'own' }, r.scope)).rejects.toThrow('own chat')
    await expect(r.service.call('cancel_turn', { turnId: 'own' }, r.scope)).rejects.toThrow('own chat')
    r.turns.set('queued-own', { workspaceId: 'w', sessionId: 's', turnId: 'queued-own', state: 'queued' })
    await expect(r.service.call('wait_for_turn', { turnId: 'queued-own' }, r.scope)).rejects.toThrow('own chat')
    r.turns.set('child', { workspaceId: 'w', sessionId: 'child-chat', turnId: 'child', state: 'running' })
    expect(await r.service.call('wait_for_turn', { turnId: 'child', timeoutSeconds: 0 }, r.scope)).toMatchObject({ outcome: 'timeout' })
    expect(r.cancelTurn).not.toHaveBeenCalled()
    let active = true
    let polling!: () => void
    const polled = new Promise<void>((resolve) => { polling = resolve })
    const originalStatus = r.host.turnStatus
    let reads = 0
    r.host.turnStatus = async (id) => {
      if (++reads === 3) polling()
      return originalStatus(id)
    }
    const waiting = r.service.call('wait_for_turn', { turnId: 'child', timeoutSeconds: 30 }, { ...r.scope, refresh: () => {
      if (!active) throw new Error('grant revoked')
      return r.scope
    } })
    await polled
    active = false
    await expect(waiting).rejects.toThrow('grant revoked')
    await expect(r.service.call('wait_for_turn', { turnId: 'child', timeoutSeconds: 31 }, r.scope)).rejects.toThrow()
  })

  it('lends the coordinator’s agent slot while it waits, and takes it back however the wait ends', async () => {
    const r = delegationRig()
    const loans: string[] = []
    let open = 0
    r.host.lendSlot = (sessionId) => {
      loans.push(sessionId)
      open++
      return () => void open--
    }
    const child = { workspaceId: 'w', sessionId: 'child-chat', turnId: 'child', state: 'queued' as const }
    let reads = 0
    const originalStatus = r.host.turnStatus
    r.host.turnStatus = async (id) => {
      if (id !== 'child') return originalStatus(id)
      // Two reads check the turn; then it is polled, lent meanwhile, while the delegate waits for a slot, starts and ends.
      if (++reads >= 3) expect(open).toBe(1)
      else expect(open).toBe(0)
      return reads < 4 ? child : { ...child, state: 'ended', outcome: 'completed' }
    }
    expect(await r.service.call('wait_for_turn', { turnId: 'child' }, r.scope)).toMatchObject({ outcome: 'completed' })
    expect(loans).toEqual(['s'])
    expect(open).toBe(0)
    reads = 0
    r.host.turnStatus = async (id) => {
      if (id === 'child' && ++reads === 3) throw new Error('gone')
      return id === 'child' ? child : originalStatus(id)
    }
    await expect(r.service.call('wait_for_turn', { turnId: 'child' }, r.scope)).rejects.toThrow('gone')
    expect(loans).toEqual(['s', 's'])
    expect(open).toBe(0)
  })

  it('reports cancellation when a queued turn disappears while waiting', async () => {
    const r = delegationRig()
    const child = { workspaceId: 'w', sessionId: 'child-chat', turnId: 'child', state: 'queued' as const }
    let reads = 0
    r.host.turnStatus = async () => ++reads <= 2 ? child : null
    expect(await r.service.call('wait_for_turn', { turnId: 'child' }, r.scope)).toMatchObject({ outcome: 'cancelled' })
    expect(r.cancelTurn).not.toHaveBeenCalled()
  })

  it('rechecks opt-in after an asynchronous read and never returns another workspace’s reply after revocation', async () => {
    const r = delegationRig()
    r.state.workspaces.push({ ...r.ws, id: 'child' })
    r.turns.set('child-turn', { workspaceId: 'child', sessionId: 'child-chat', turnId: 'child-turn', state: 'ended', outcome: 'completed' })
    r.getChat.mockImplementationOnce(async () => {
      r.allowed.value = false
      return [{ kind: 'assistant', id: 'a', turnId: 'child-turn', text: 'Do not disclose after revocation' }]
    })
    await expect(r.service.call('get_turn_result', { turnId: 'child-turn' }, r.scope)).rejects.toThrow('Let agents')
    await expect(r.service.call('get_task_status', { workspaceId: 'child' }, r.scope)).rejects.toThrow('Let agents')
  })

  it('holds setup failures and uses stable chat IDs rather than silently redirecting a handoff', async () => {
    const r = delegationRig()
    r.ws.heldMessage = { text: 'held' } as typeof r.ws.heldMessage
    await expect(r.service.call('send_task', { workspaceId: 'w', sessionId: 's', prompt: 'handoff' }, r.scope)).rejects.toThrow('first message is held')
    expect(r.deliver).not.toHaveBeenCalled()
    r.ws.heldMessage = undefined
    await expect(r.service.call('send_task', { workspaceId: 'w', sessionId: 'missing', prompt: 'handoff' }, r.scope)).rejects.toThrow('open chat')
    r.state.settings.promptTemplates.push({ id: 't', name: 'Research', body: 'unwanted template' } as never)
    await r.service.call('send_task', { workspaceId: 'w', sessionId: 's', prompt: 'Research' }, r.scope)
    expect(r.deliver).toHaveBeenLastCalledWith('s', 'Research', expect.anything())
    // Ordinary CLI callers retain template expansion.
    await send(r.host, { workspace: 'w', tab: 1, args: ['Research'], cwd: '' })
    expect(r.deliver).toHaveBeenLastCalledWith('s', 'unwanted template', expect.anything())
  })
})

describe('flow delegation: start_flow, get_flow_status and the flows list', () => {
  const FP = { flow: 'f', templates: 't', setup: 's', checks: 'c', mcp: 'm', personas: 'p' }
  const listing = (over: Partial<FlowListing> = {}): FlowListing => ({
    id: 'built-in:fix-until-green', source: 'built-in', starter: 'fix-until-green', name: 'Fix until green',
    toml: FLOW_STARTERS[0].toml, summary: { steps: 6, loops: 2, gates: 1, personas: ['developer', 'qa-engineer'] }, problems: [], warnings: [], ...over
  })
  const summary = (over: Partial<FlowRunSummary> = {}) => ({ flowName: 'Fix until green', notClaude: [], problems: [], ...over }) as FlowRunSummary
  const run = (over: Partial<FlowRun> = {}): FlowRun => ({
    id: 'run-1', flow: { id: 'built-in:fix-until-green', name: 'Fix until green', source: 'built-in' }, repoId: 'r', baseBranch: 'main', inputs: { task: 'x' }, fingerprint: FP,
    state: 'running', startedAt: '', workspaceId: 'task-ws', current: { step: 'build', iteration: 1 },
    steps: [{ name: 'build', kind: 'turn', iteration: 1, state: 'running', startedAt: '', sessionId: 'task-chat', turnId: 'task-turn' }], loops: {}, ...over
  })
  function flowRig() {
    const r = delegationRig()
    r.state.settings.flows = true
    const runs: FlowRun[] = [run(), run({ id: 'foreign-run', repoId: 'other', workspaceId: 'elsewhere' })]
    const flows = [listing(), listing({ id: 'personal-broken', source: 'personal', name: 'Broken', problems: ['No start.'] })]
    const preview = { fingerprint: FP, summary: summary(), inputs: [{ name: 'task', description: 'What to build or fix' }] }
    r.host.api.listFlows = vi.fn(async () => flows)
    r.host.api.flowRunPreview = vi.fn(async () => preview)
    r.host.api.listFlowRuns = vi.fn(async () => runs)
    const startFlowRun = vi.fn(async (input: FlowRunStart, origin?: FlowRunOrigin) => run({ id: 'run-new', state: 'starting', workspaceId: undefined, steps: [], inputs: input.inputs, origin }))
    r.host.startFlowRun = startFlowRun
    return { ...r, runs, flows, preview, startFlowRun }
  }

  it('lists the runnable flows with their inputs and personas, only while Flows are on', async () => {
    const r = flowRig()
    // Why one can't run is what a start would refuse it with: the run preview's problems, as start_flow reads them.
    const notClaude = 'Unattended turns are Claude only, as scheduled runs are: nobody can answer another agent’s approvals yet (review and decide steps may run on Codex). Not Claude: build (Codex).'
    // As core's preview has it: turns on other agents listed apart from the other problems.
    r.preview.summary = summary({ notClaude: [{ step: 'build', agent: 'Codex' }], problems: [] })
    const options = (await r.service.call('list_delegation_options', {}, r.scope)) as { flows: unknown[] }
    // The broken one isn't listed; one whose turn is on the Codex loadout says why it can't run unattended.
    expect(options.flows).toEqual([
      { id: 'built-in:fix-until-green', name: 'Fix until green', source: 'built-in', inputs: [{ name: 'task', description: 'What to build or fix' }], personas: ['developer', 'qa-engineer'], cantRun: notClaude }
    ])
    expect(r.host.api.flowRunPreview).toHaveBeenCalledWith({ flowId: 'built-in:fix-until-green', repoId: 'r', baseBranch: 'main' })
    expect(r.host.api.listFlows).toHaveBeenCalledWith('r')
    r.state.settings.flows = false
    expect(await r.service.call('list_delegation_options', {}, r.scope)).not.toHaveProperty('flows')
    expect(delegationToolNames(false)).not.toContain('start_flow')
    expect(delegationToolNames(false)).not.toContain('get_flow_status')
    expect(delegationToolNames(true)).toEqual(expect.arrayContaining(['start_flow', 'get_flow_status']))
  })

  it('starts a flow in the coordinator’s repository with the approval shown now, recording the coordinating chat', async () => {
    const r = flowRig()
    const started = await r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: ' Fix the flaky tests ' } }, r.scope)
    expect(r.host.api.flowRunPreview).toHaveBeenCalledWith({ flowId: 'built-in:fix-until-green', repoId: 'r', baseBranch: 'main' })
    expect(r.startFlowRun).toHaveBeenCalledWith(
      { flowId: 'built-in:fix-until-green', source: 'built-in', repoId: 'r', baseBranch: 'main', inputs: { task: 'Fix the flaky tests' }, shown: FP },
      { kind: 'delegation', sessionId: 's', turnId: 'own' }
    )
    expect(started).toMatchObject({ runId: 'run-new', state: 'starting', baseBranch: 'main' })
    // The assistant names the repository; its thread is the origin.
    await r.service.call('start_flow', { flowId: 'built-in:fix-until-green', repoId: 'r', baseBranch: 'develop', inputs: { task: 'x' } }, { readOnly: false, assistantThread: 'thread-1' })
    expect(r.startFlowRun).toHaveBeenLastCalledWith(expect.objectContaining({ baseBranch: 'develop' }), { kind: 'assistant', threadId: 'thread-1' })
  })

  it('refuses without the opt-in, across repositories, read-only, while Flows are off, a broken flow, a non-Claude flow and a missing input', async () => {
    const r = flowRig()
    r.allowed.value = false
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } }, r.scope)).rejects.toThrow('Let agents')
    r.allowed.value = true
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', repoId: 'other', inputs: { task: 'x' } }, r.scope)).rejects.toThrow('coordinating repository')
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } }, { ...r.scope, readOnly: true })).rejects.toThrow('only read')
    await expect(r.service.call('start_flow', { flowId: 'personal-broken', inputs: {} }, r.scope)).rejects.toThrow('has problems')
    await expect(r.service.call('start_flow', { flowId: 'nope' }, r.scope)).rejects.toThrow('list_delegation_options')
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green' }, r.scope)).rejects.toThrow('asks for task (What to build or fix)')
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x', colour: 'red' } }, r.scope)).rejects.toThrow('has no input “colour”')
    r.preview.summary = summary({ notClaude: [{ step: 'build', agent: 'Codex' }] })
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } }, r.scope)).rejects.toThrow('Unattended turns are Claude only')
    r.state.settings.flows = false
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } }, r.scope)).rejects.toThrow('Flows are off')
    await expect(r.service.call('get_flow_status', { runId: 'run-1' }, r.scope)).rejects.toThrow('Flows are off')
    expect(r.startFlowRun).not.toHaveBeenCalled()
  })

  it('reads a run in the coordinator’s repository, says a gate waits for the user, and refuses another repository’s run', async () => {
    const r = flowRig()
    expect(await r.service.call('get_flow_status', { runId: 'run-1' }, r.scope)).toMatchObject({
      runId: 'run-1', flow: 'Fix until green', state: 'running', current: { step: 'build', iteration: 1 },
      steps: [{ name: 'build', kind: 'turn', state: 'running', sessionId: 'task-chat', turnId: 'task-turn' }], contentIsData: true
    })
    r.runs[0].state = 'waiting'
    expect(await r.service.call('get_flow_status', { runId: 'run-1' }, r.scope)).toMatchObject({ waitingFor: expect.stringContaining('never by an agent') })
    await expect(r.service.call('get_flow_status', { runId: 'foreign-run' }, r.scope)).rejects.toThrow('coordinating repository')
    await expect(r.service.call('get_flow_status', { runId: 'gone' }, r.scope)).rejects.toThrow('not found')
    r.allowed.value = false
    await expect(r.service.call('get_flow_status', { runId: 'run-1' }, r.scope)).rejects.toThrow('Let agents')
    // No tool answers a gate: an agent can only read.
    expect(Object.keys(DELEGATION_TOOLS).some((name) => /approve|answer|gate/.test(name))).toBe(false)
  })
})
