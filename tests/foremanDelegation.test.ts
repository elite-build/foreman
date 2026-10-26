import { describe, expect, it } from 'vitest'
import { delegationRig } from './foremanDelegationHarness'
import { send } from '../src/main/cli/work'

describe('CLI-backed Foreman delegation', () => {
  it('discovers loadouts and runs research, planning, then two implementation tasks in isolated workspaces', async () => {
    const r = delegationRig()
    expect(await r.service.call('list_delegation_options', {}, r.scope)).toMatchObject({ delegationEnabled: true, loadouts: [
      { slot: 1, agent: 'claude', model: 'fable' }, { slot: 2, agent: 'codex', model: 'astra' },
      { slot: 3, agent: 'opencode' }, { slot: 4, agent: 'cursor' }
    ], repositories: [{ id: 'r' }] })
    await r.service.call('start_task', { prompt: 'Research the problem', loadout: 1 }, r.scope)
    expect(r.createWorkspace).toHaveBeenLastCalledWith('r', expect.objectContaining({ prompt: 'Research the problem', loadout: r.state.settings.loadouts[0], branch: { kind: 'new', name: undefined } }))
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
    expect(r.deliver).toHaveBeenCalledWith(r.state.sessions[2].id, 'Revise the plan with this finding.', expect.objectContaining({ mode: 'queue', via: 'cli' }))
    expect(await r.service.call('cancel_turn', { turnId: handoff.turn }, r.scope)).toMatchObject({ outcome: 'cancelled', was: 'queued' })
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
