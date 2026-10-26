import { describe, expect, it } from 'vitest'
import { effectiveMode, oppositeMode, planDelivery, receiptText } from '../src/shared/delivery'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import type { AgentDriver } from '../src/main/agents/types'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import type { Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'
import { afterEach, vi } from 'vitest'

afterEach(() => registerDriver(claudeDriver))

describe('delivery plan', () => {
  const base = { starting: false, running: true, mode: 'steer' as const, canSteer: true }
  it('starts a turn when nothing runs', () => expect(planDelivery({ ...base, running: false })).toBe('start'))
  it('steers a running turn in steer mode', () => expect(planDelivery(base)).toBe('steer'))
  it('queues in queue mode', () => expect(planDelivery({ ...base, mode: 'queue' })).toBe('queue'))
  it('queues when the agent cannot steer', () => expect(planDelivery({ ...base, canSteer: false })).toBe('queue'))
  it('queues while a turn is still starting', () => expect(planDelivery({ ...base, starting: true })).toBe('queue'))
})

describe('send mode', () => {
  it('uses the override for one message, else the setting', () => {
    expect(effectiveMode('steer', null, true)).toBe('steer')
    expect(effectiveMode('steer', 'queue', true)).toBe('queue')
    expect(effectiveMode('steer', 'steer', false)).toBe('queue')
    expect(oppositeMode('queue')).toBe('steer')
  })
  it('words the receipt from the disposition', () => {
    expect(receiptText('steered')).toBe('Sent to running agent')
    expect(receiptText('queued')).toBe('Queued · sends when this turn ends')
    expect(receiptText('started')).toBeNull()
  })
})

async function setup(steer: boolean) {
  const store = new Store(await tempDir('foreman-delivery-'))
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const ws: Workspace = {
    id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main',
    path: await makeRepo(), portBase: 50050, state: 'ready', createdAt: new Date().toISOString()
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const driver: AgentDriver = {
    ...claudeDriver,
    createTurn: (_req, cb) => ({
      run: async () => {
        await gate
        cb.finished({ ok: true })
      },
      stop: async () => release(),
      steer: () => steer,
      setPlanMode: async () => {},
      setModel: async () => {}
    })
  }
  registerDriver(driver)
  const workspaces = { workspace: () => ws, env: () => ({}), settingsFor: () => ({ prompts: { general: '' } }), agentContext: () => '' }
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, {
    changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {}
  })
  const session = sessions.createSession(ws.id, { agent: 'claude', title: 'chat' })
  return { sessions, session, release }
}

describe('SessionService.send disposition', () => {
  it('reports started, steered, and queued from what happened', async () => {
    const { sessions, session, release } = await setup(true)
    expect(await sessions.send(session.id, 'go')).toBe('started')
    expect(await sessions.send(session.id, 'more', { mode: 'steer' })).toBe('steered')
    expect(await sessions.send(session.id, 'later', { mode: 'queue' })).toBe('queued')
    expect(session.queue.map((m) => m.text)).toEqual(['later'])
    release()
  })

  it('steering the agent refuses falls back to the queue receipt', async () => {
    const { sessions, session, release } = await setup(false)
    await sessions.send(session.id, 'go')
    expect(await sessions.send(session.id, 'more', { mode: 'steer' })).toBe('queued')
    expect(session.queue).toHaveLength(1)
    release()
  })
})
