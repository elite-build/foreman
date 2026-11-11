// docs/agent-access.md §9: Foreman's side of agents on this computer. The Api methods' scopes (reading is read, the rest
// admin), the `agent-access` event every session hears, and the notification a waiting sign-in raises, at most one a minute.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaitingNotices } from '../src/main/agentAccess/notice'
import type { AgentAccessService } from '../src/main/agentAccess/server'
import { ApiDispatcher } from '../src/main/api/dispatch'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { AgentAccessInfo, AgentAccessPending } from '../src/shared/agentAccess'
import { ApiRefused, eventReach, METHOD_SCOPES, sentToView, type ApiSession, type Scope } from '../src/shared/api'
import { hostForwards } from '../src/shared/remote'
import type { MainEvent } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const phone = (scopes: Scope[]): ApiSession => ({ id: 'p1', kind: 'phone', name: 'iPhone', scopes })
const waiting = (id: string, expiresAt = 1_000): AgentAccessPending => ({ id, name: `Agent ${id}`, redirect: '127.0.0.1:53682', expiresAt })
const info = (pending: AgentAccessPending[] = []): AgentAccessInfo => ({ enabled: true, port: 47634, url: 'http://127.0.0.1:47634/mcp', pending, grants: [] })

describe('the Api', () => {
  it('reads in read, and everything that changes who may sign in is admin', () => {
    expect(METHOD_SCOPES.agentAccessInfo).toBe('read')
    for (const m of ['agentAccessConfigure', 'agentAccessApprove', 'agentAccessDeny', 'agentAccessRevoke'] as const) expect([m, METHOD_SCOPES[m]]).toEqual([m, 'admin'])
  })

  it('lets a watching phone read, refuses an operating one an approval, and lets Full control approve', async () => {
    const calls: string[] = []
    const record = (method: string) => async () => (calls.push(method), info())
    const dispatcher = new ApiDispatcher({ api: Object.fromEntries(['agentAccessInfo', 'agentAccessApprove', 'agentAccessDeny', 'agentAccessRevoke', 'agentAccessConfigure'].map((m) => [m, record(m)])), signals: {} })
    await expect(dispatcher.invoke(phone(['read']), 'agentAccessInfo', [])).resolves.toEqual(info())
    for (const method of ['agentAccessApprove', 'agentAccessDeny', 'agentAccessRevoke', 'agentAccessConfigure']) {
      const refused = dispatcher.invoke(phone(['read', 'operate']), method, ['p', '123456', 'ask'])
      await expect(refused, method).rejects.toBeInstanceOf(ApiRefused)
      await expect(refused, method).rejects.toMatchObject({ code: 'refused' })
    }
    await expect(dispatcher.invoke(phone(['read', 'operate', 'admin']), 'agentAccessApprove', ['p', '123456', 'ask'])).resolves.toEqual(info())
    expect(calls).toEqual(['agentAccessInfo', 'agentAccessApprove'])
  })
})

describe('the agent-access event', () => {
  it('reaches every session, whatever it views, and crosses to a computer in control', () => {
    const event: MainEvent = { type: 'agent-access', info: info([waiting('a')]) }
    expect(eventReach('agent-access')).toBe('always')
    expect(hostForwards(event)).toBe(true)
    for (const view of [{ all: true } as const, { sessionId: 's1' }, {}]) expect(sentToView(event, view, ['read'])).toBe(true)
  })
})

describe('the notification for a waiting sign-in', () => {
  it('is raised for a sign-in that starts waiting, at most once a minute, and not again for one already seen', () => {
    let now = 10_000
    const notices = new WaitingNotices(() => now)
    expect(notices.take([])).toBeNull()
    expect(notices.take([waiting('a')])?.id).toBe('a')
    // The same one again (approved elsewhere, the list redrawn): nothing.
    expect(notices.take([waiting('a')])).toBeNull()
    // Another within the minute: nothing.
    now += 30_000
    expect(notices.take([waiting('a'), waiting('b')])).toBeNull()
    // A third once the minute is up: the newest of those not seen before.
    now += 30_000
    expect(notices.take([waiting('a'), waiting('b'), waiting('c', 2_000)])?.id).toBe('c')
    // One that ended and a new one with it: told about the new one, after the minute.
    now += 60_000
    expect(notices.take([waiting('d')])?.id).toBe('d')
  })

  it('goes out from core with the agent-access event, its action opening the agents section, text in the user’s language', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-10T10:00:00Z'))
      const dir = await tempDir('foreman-agent-access-api-')
      const store = new Store(dir)
      await store.load()
      vi.spyOn(store, 'save').mockImplementation(() => {})
      const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
      const events: MainEvent[] = []
      const core = new Core(store, secrets, {
        broadcast: (e) => void events.push(e), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
        openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
        metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
      })
      let current = info()
      core.bindAgentAccess({ info: () => current } as unknown as AgentAccessService)
      const notifies = () => events.filter((e): e is Extract<MainEvent, { type: 'notify' }> => e.type === 'notify')

      core.agentAccessChanged()
      expect(events).toEqual([{ type: 'agent-access', info: info() }])

      current = info([waiting('a')])
      core.agentAccessChanged()
      expect(events.at(-2)).toEqual({ type: 'agent-access', info: current })
      expect(notifies()).toEqual([{ type: 'notify', workspaceId: '', sessionId: '', title: 'An agent asks to sign in to Foreman', body: expect.stringContaining('Agent a is waiting in Settings → Data & devices → Agents on this computer'), action: 'agent-access', kind: 'info' }])

      current = info([waiting('a'), waiting('b')])
      core.agentAccessChanged()
      expect(notifies()).toHaveLength(1)

      vi.setSystemTime(new Date('2026-11-10T10:01:00Z'))
      current = info([waiting('a'), waiting('b'), waiting('c', 5_000)])
      core.agentAccessChanged()
      expect(notifies()).toHaveLength(2)
      expect(notifies()[1].body).toContain('Agent c')

      store.state.settings.language = 'de'
      vi.setSystemTime(new Date('2026-11-10T10:02:00Z'))
      current = info([waiting('d')])
      core.agentAccessChanged()
      expect(notifies()[2].title).toBe('Ein Agent möchte sich bei Foreman anmelden')
      expect(events.filter((e) => e.type === 'agent-access')).toHaveLength(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without the service, the Api says it is starting and nothing is broadcast', async () => {
    const dir = await tempDir('foreman-agent-access-api-none-')
    const store = new Store(dir)
    await store.load()
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const broadcast = vi.fn()
    const core = new Core(store, secrets, {
      broadcast, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    await expect(core.api.agentAccessInfo()).rejects.toThrow('starting')
    core.agentAccessChanged()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
