import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import webpush from 'web-push'
import { MobileService } from '../src/main/mobile'
import type { Api, AppSnapshot, ApprovalRequest, Repo, Session, Workspace } from '../src/shared/types'
import type { MobileDevice } from '../src/shared/mobile'
import type { Store } from '../src/main/store'
import type { SecretStore } from '../src/main/secrets'

const services: MobileService[] = []
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.close())) })

describe('paired mobile access', () => {
  it('requires desktop approval, an authenticated cookie, and the expected origin for mutations', async () => {
    const credentials = new Map<string, string>()
    const state = { settings: { mobileEnabled: false, mobileUrl: '' }, mobileDevices: [] as MobileDevice[] }
    const store = { state, save: vi.fn() } as unknown as Store
    const secrets = {
      appSecret: (key: string) => credentials.get(key),
      setAppSecret: (key: string, value: string | null) => value === null ? credentials.delete(key) : credentials.set(key, value)
    } as unknown as SecretStore
    const approvals: ApprovalRequest[] = [{ id: 'approval-1', sessionId: 'chat-1', kind: 'tool', toolName: 'Edit', input: { path: 'src/app.ts' } }]
    const respondApproval = vi.fn(async () => { approvals.splice(0) })
    const sendMessage = vi.fn(async () => 'queued' as const)
    const cancel = vi.fn(async () => undefined)
    const runChecks = vi.fn(async () => ({ started: true }))
    // G2: Home → Recent's history, for the phone.
    const attentionHistory = vi.fn(async () => ({
      events: [
        { id: 'e2', kind: 'ci-failed', workspaceId: 'ws-1', topic: 'ci', key: 'k', firstAt: '2026-10-22T10:00:00Z', at: '2026-10-22T10:05:00Z', count: 2, pr: 9, gitlab: true },
        { id: 'e1', kind: 'turn-ended', workspaceId: 'removed', topic: 't', key: 'k', firstAt: '2026-10-22T09:00:00Z', at: '2026-10-22T09:00:00Z', count: 1 }
      ],
      seenAt: '2026-10-22T10:00:00Z'
    }))
    const api = { respondApproval, sendMessage, cancel, runChecks, attentionHistory } as unknown as Api
    const needed = [{ name: 'test', command: 'npm test', source: 'local' as const }]
    const snapshot = { repos: [], workspaces: [], sessions: [], settings: { ...state.settings, promptTemplates: [] } } as unknown as AppSnapshot
    const service = new MobileService({
      store, secrets, api, snapshot: () => snapshot, approvals: () => approvals,
      consentNeeded: () => needed,
      appPath: process.cwd(), onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0)
    services.push(service)
    const origin = 'https://foreman.example.ts.net'
    const info = await service.configure(true, origin)
    const base = `http://127.0.0.1:${info.port}`
    expect(info.port).toBeGreaterThan(0)
    expect((await fetch(base + '/api/state')).status).toBe(401)

    const pairing = await service.startPairing()
    const token = new URL(pairing.pairing!.url).searchParams.get('pair')
    const start = await fetch(base + '/api/pair/start', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: 'Test phone' })
    })
    const request = await start.json() as { id: string; code: string }
    expect(start.status).toBe(200)
    expect(service.info().pending?.code).toBe(request.code)
    expect((await fetch(base + '/api/pair/start', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: 'Another phone' })
    })).status).toBe(410)
    expect((await fetch(base + '/api/pair/status?id=' + request.id)).headers.get('set-cookie')).toBeNull()

    service.approve(request.id, true)
    const status = await fetch(base + '/api/pair/status?id=' + request.id)
    const cookie = status.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const auth = cookie.split(';')[0]
    const stateResponse = await fetch(base + '/api/state', { headers: { Cookie: auth } })
    expect(stateResponse.status).toBe(200)
    expect(await stateResponse.json()).not.toHaveProperty('settings')
    const sent = await fetch(base + '/api/chat/chat-1/send', {
      method: 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Please continue' })
    })
    expect(sent.status).toBe(200)
    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'Please continue', { mode: 'queue' })
    const stopped = await fetch(base + '/api/chat/chat-1/stop', {
      method: 'POST', headers: { Cookie: auth, Origin: origin }
    })
    expect(stopped.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith('chat-1')
    const checkRequest = (expected: unknown) => fetch(base + '/api/workspace/ws-1/checks', {
      method: 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true, expected })
    })
    expect((await checkRequest([{ ...needed[0], command: 'changed' }])).status).toBe(409)
    expect(runChecks).not.toHaveBeenCalled()
    expect((await checkRequest(needed)).status).toBe(200)
    expect(runChecks).toHaveBeenCalledWith('ws-1', true)
    expect((await fetch(base + '/api/approval/approval-1', {
      method: 'POST', headers: { Cookie: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tool', allow: true })
    })).status).toBe(403)
    const answer = () => fetch(base + '/api/approval/approval-1', {
      method: 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tool', allow: true })
    })
    expect((await answer()).status).toBe(200)
    // G2: answered on the phone, which Home → Recent records.
    expect(respondApproval).toHaveBeenCalledWith('approval-1', { kind: 'tool', allow: true, message: undefined }, 'phone')
    expect((await answer()).status).toBe(409)
    const old = new Date(Date.now() - 20 * 60_000).toISOString()
    snapshot.repos.push({ id: 'repo-1', name: 'Repo' } as Repo)
    snapshot.workspaces.push({ id: 'ws-1', repoId: 'repo-1', name: 'Stalled work', branch: 'feature/stall', state: 'ready', status: 'in-progress', createdAt: old } as Workspace)
    snapshot.sessions.push({ id: 'chat-1', workspaceId: 'ws-1', agent: 'claude', model: 'opus', status: 'running', turnId: 'turn-1', turnStartedAt: old, lastActivityAt: old, queue: [] } as unknown as Session)
    const attention = await (await fetch(base + '/api/state', { headers: { Cookie: auth } })).json() as { workspaces: { bucket: string; label: string; stalled: boolean }[] }
    expect(attention.workspaces[0]).toMatchObject({ bucket: 'attention', label: 'Possible stall', stalled: true })
    // G2: the phone's PR glyph and Recent list (history only, removed workspaces left out).
    snapshot.workspaces[0].prInfo = { number: 9, state: 'OPEN', url: 'u', facts: { readAt: old, provider: 'gitlab', checks: 'failing', checksPassed: 1, checksTotal: 3, checksFailing: 2, requiredOnly: false, review: 'unknown', mergeable: 'unknown', draft: false } }
    const withPr = await (await fetch(base + '/api/state', { headers: { Cookie: auth } })).json() as { workspaces: { pr: unknown }[] }
    expect(withPr.workspaces[0].pr).toMatchObject({ state: 'ci-failing', number: 9, provider: 'gitlab', failing: 2 })
    const recent = await (await fetch(base + '/api/recent', { headers: { Cookie: auth } })).json() as { events: { name: string; text: string }[]; seenAt: string }
    expect(recent).toEqual({ seenAt: '2026-10-22T10:00:00Z', events: [expect.objectContaining({ name: 'Stalled work', text: 'CI failed · MR !9', count: 2 })] })
    expect((await fetch(base + '/api/recent')).status).toBe(401)
    const push = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as never)
    state.mobileDevices[0].push = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'key', auth: 'auth' } }
    service.notify({ type: 'notify', workspaceId: 'w1', sessionId: 'chat-1', title: 'Secret project', body: 'Needs permission: private command' })
    await vi.waitFor(() => expect(push).toHaveBeenCalled())
    expect(push.mock.calls[0][1]).toBe(JSON.stringify({ title: 'Foreman needs you', body: 'Open your attention inbox.', url: '/' }))
    push.mockRestore()
    service.revoke(service.info().devices[0].id)
    expect((await fetch(base + '/api/state', { headers: { Cookie: auth } })).status).toBe(401)
  })

  it('pairs on the selected LAN address without Tailscale and keeps transport credentials separate', async () => {
    const credentials = new Map<string, string>()
    const state = { settings: { mobileEnabled: false, mobileUrl: '', mobileLanEnabled: false, mobileLanAddress: '' }, mobileDevices: [] as MobileDevice[] }
    const store = { state, save: vi.fn() } as unknown as Store
    const secrets = {
      appSecret: (key: string) => credentials.get(key),
      setAppSecret: (key: string, value: string | null) => value === null ? credentials.delete(key) : credentials.set(key, value)
    } as unknown as SecretStore
    const sendMessage = vi.fn(async () => 'queued' as const)
    const snapshot = { repos: [], workspaces: [], sessions: [], settings: { ...state.settings, promptTemplates: [] } } as unknown as AppSnapshot
    const service = new MobileService({
      store, secrets, api: { sendMessage } as unknown as Api, snapshot: () => snapshot,
      approvals: () => [], consentNeeded: () => [], appPath: process.cwd(),
      onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0, 0, () => [{ name: 'test LAN', address: '127.0.0.1', netmask: '255.0.0.0' }])
    services.push(service)

    const info = await service.configureLan(true, '127.0.0.1')
    const origin = `http://127.0.0.1:${info.lan.port}`
    expect(info.lan.enabled).toBe(true)
    expect((await fetch(origin + '/')).status).toBe(200)
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(origin + '/api/state', { headers: { Host: 'other.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(wrongHost).toBe(403)
    expect((await fetch(origin + '/api/state')).status).toBe(401)

    const pairing = await service.startPairing('lan')
    expect(pairing.pairing?.mode).toBe('lan')
    const secret = new URL(pairing.pairing!.url).searchParams.get('pair')
    const started = await fetch(origin + '/api/pair/start', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secret, name: 'Nearby phone' })
    })
    expect(started.status).toBe(200)
    const request = await started.json() as { id: string; code: string }
    expect(service.info().pending?.code).toBe(request.code)
    service.approve(request.id, true)
    const result = await fetch(origin + '/api/pair/status?id=' + request.id)
    const cookie = result.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly; SameSite=Strict; Max-Age=86400')
    expect(cookie).not.toContain('Secure')
    const auth = cookie.split(';')[0]
    expect((await fetch(origin + '/api/state', { headers: { Cookie: auth } })).status).toBe(200)
    expect((await fetch(origin + '/api/push-key', { headers: { Cookie: auth } })).status).toBe(403)
    expect((await fetch(origin + '/api/chat/chat-1/send', {
      method: 'POST', headers: { Cookie: auth, Origin: 'https://other.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Please continue' })
    })).status).toBe(403)
    expect((await fetch(origin + '/api/chat/chat-1/send', {
      method: 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Please continue' })
    })).status).toBe(200)
    expect(sendMessage).toHaveBeenCalledOnce()

    const privateInfo = await service.configure(true, 'https://foreman.example.ts.net')
    const privateBase = `http://127.0.0.1:${privateInfo.port}`
    expect((await fetch(privateBase + '/api/state', { headers: { Cookie: auth } })).status).toBe(401)
    const privatePairing = await service.startPairing('private')
    const privateToken = new URL(privatePairing.pairing!.url).searchParams.get('pair')
    expect((await fetch(origin + '/api/pair/start', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: privateToken, name: 'Wrong transport' })
    })).status).toBe(410)
    await service.configureLan(false, '127.0.0.1')
    expect((await fetch(privateBase + '/')).status).toBe(200)
    service.revoke(service.info().devices[0].id)
  })
})
