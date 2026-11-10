import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import vm from 'node:vm'
import webpush from 'web-push'
import { WebSocket } from 'ws'
import { ApiDispatcher } from '../src/main/api/dispatch'
import { MobileService } from '../src/main/mobile'
import { API_PROTOCOL } from '../src/shared/api'
import type { Api, AppSnapshot, ApprovalRequest, MainEvent, Repo, Session, Workspace } from '../src/shared/types'
import type { MobileDevice } from '../src/shared/mobile'
import type { Store } from '../src/main/store'
import type { SecretStore } from '../src/main/secrets'

const services: MobileService[] = []
const sockets: WebSocket[] = []
const cleanupDirs: string[] = []
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  await Promise.all(services.splice(0).map((s) => s.close()))
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
    rmSync(path.join(path.dirname(dir), 'secret.txt'), { force: true })
  }
})

/** What the service needs besides its store, secrets and snapshot: the core's methods behind a dispatcher, and the socket's. */
function serving(api: Partial<Api>) {
  const listeners = new Set<(event: MainEvent) => void>()
  return {
    dispatcher: new ApiDispatcher({ api: api as Record<string, (...args: unknown[]) => unknown>, signals: {} }),
    onEvent: (listener: (event: MainEvent) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    version: '1.2.3', platform: 'test', name: () => 'Desk',
    emit: (event: MainEvent) => { for (const l of listeners) l(event) }
  }
}

type Frame = Record<string, unknown> & { t: string }

/** Opens /api/ws with these headers: the HTTP status it was refused with, or the open socket and its frames. */
function upgrade(url: string, headers: Record<string, string>): Promise<{ status: number } | { ws: WebSocket; next: () => Promise<Frame>; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    sockets.push(ws)
    const frames: Frame[] = []
    const waiters: ((frame: Frame) => void)[] = []
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else frames.push(frame)
    })
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    ws.on('error', () => undefined)
    ws.once('unexpected-response', (req, res) => {
      resolve({ status: res.statusCode ?? 0 })
      req.destroy()
    })
    ws.once('open', () => resolve({ ws, closed, next: () => new Promise<Frame>((done) => { const f = frames.shift(); if (f) done(f); else waiters.push(done) }) }))
    ws.once('error', reject)
  })
}
const hello = { t: 'hello', protocol: API_PROTOCOL, version: '1.2.3', client: { kind: 'phone', name: 'iPhone' } }

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
      store, secrets, ...serving(api), snapshot: () => snapshot, approvals: () => approvals,
      consentNeeded: () => needed,
      appPath: process.cwd(), onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0)
    services.push(service)
    const origin = 'https://foreman.example.ts.net'
    const info = await service.configure(true, origin)
    const base = `http://127.0.0.1:${info.port}`
    expect(info.port).toBeGreaterThan(0)
    expect((await fetch(base + '/api/state')).status).toBe(401)
    // The page may open its socket: same origin, named as wss: too for WebKit that doesn't read 'self' as covering it.
    const page = await fetch(base + '/')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self' wss://foreman.example.ts.net;")
    expect((await fetch(base + '/live.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')

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
    // A flow's pick: one of the results it offered, else none (the run stops).
    const pickAnswer = async (chosen: unknown) => {
      approvals.push({ id: 'pick-1', sessionId: 'chat-1', kind: 'pick', flowRunId: 'run', flowName: 'Siblings', step: 'choose', ask: 'Which?', choices: [{ step: 'try-a', workspaceId: 'w1', summary: '' }, { step: 'try-b', workspaceId: 'w2', summary: '' }] })
      return fetch(base + '/api/approval/pick-1', { method: 'POST', headers: { Cookie: auth, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'pick', chosen }) })
    }
    expect((await pickAnswer('try-b')).status).toBe(200)
    expect(respondApproval).toHaveBeenLastCalledWith('pick-1', { kind: 'pick', chosen: 'try-b' }, 'phone')
    expect((await pickAnswer('try-z')).status).toBe(200)
    expect(respondApproval).toHaveBeenLastCalledWith('pick-1', { kind: 'pick', chosen: null }, 'phone')
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
      store, secrets, ...serving({ sendMessage } as unknown as Api), snapshot: () => snapshot,
      approvals: () => [], consentNeeded: () => [], appPath: process.cwd(),
      onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0, 0, () => [{ name: 'test LAN', address: '127.0.0.1', netmask: '255.0.0.0' }])
    services.push(service)

    const info = await service.configureLan(true, '127.0.0.1')
    const origin = `http://127.0.0.1:${info.lan.port}`
    expect(info.lan.enabled).toBe(true)
    const lanPage = await fetch(origin + '/')
    expect(lanPage.status).toBe(200)
    expect(lanPage.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://127.0.0.1:${info.lan.port};`)
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
    const lanSocket = await upgrade(origin.replace('http:', 'ws:') + '/api/ws', { Cookie: auth, Origin: origin })
    if (!('ws' in lanSocket)) throw new Error(`Refused with ${lanSocket.status}`)
    lanSocket.ws.send(JSON.stringify(hello))
    expect(await lanSocket.next()).toMatchObject({ t: 'welcome', ok: true })

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
    // Turning the listener off ends its sockets.
    expect(await lanSocket.next()).toEqual({ t: 'bye', reason: 'off' })
    expect(await lanSocket.closed).toBe(1000)
    expect((await fetch(privateBase + '/')).status).toBe(200)
    service.revoke(service.info().devices[0].id)
  })

  it('applies the access chosen at pairing to the routes and the socket, and checks the upgrade like a POST', async () => {
    const credentials = new Map<string, string>()
    const state = { settings: { mobileEnabled: false, mobileUrl: '' }, mobileDevices: [] as MobileDevice[] }
    const store = { state, save: vi.fn() } as unknown as Store
    const secrets = {
      appSecret: (key: string) => credentials.get(key),
      setAppSecret: (key: string, value: string | null) => value === null ? credentials.delete(key) : credentials.set(key, value)
    } as unknown as SecretStore
    const sendMessage = vi.fn(async () => 'queued' as const)
    const cancel = vi.fn(async () => undefined)
    const getChat = vi.fn(async () => ({ items: [] }))
    const snapshot = { repos: [], workspaces: [], sessions: [], settings: { ...state.settings, promptTemplates: [] } } as unknown as AppSnapshot
    const serve = serving({ sendMessage, cancel, getChat } as unknown as Api)
    const service = new MobileService({
      store, secrets, ...serve, snapshot: () => snapshot, approvals: () => [], consentNeeded: () => [],
      appPath: process.cwd(), onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0)
    services.push(service)
    const origin = 'https://foreman.example.ts.net'
    const base = `http://127.0.0.1:${(await service.configure(true, origin)).port}`
    const pair = async (body: Record<string, unknown>, access?: 'read' | 'operate' | 'admin') => {
      const token = new URL((await service.startPairing()).pairing!.url).searchParams.get('pair')
      const started = await fetch(base + '/api/pair/start', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }) })
      if (started.status !== 200) return { status: started.status, cookie: '' }
      const { id } = await started.json() as { id: string }
      const kind = service.info().pending?.kind
      service.approve(id, true, access)
      const cookie = (await fetch(base + '/api/pair/status?id=' + id)).headers.get('set-cookie')!.split(';')[0]
      return { status: 200, cookie, kind }
    }
    const send = (cookie: string) => fetch(base + '/api/chat/chat-1/send', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Go on' })
    })

    // Watch: reads answer, work is refused with the dispatcher's reason.
    const watcher = await pair({ name: 'Watcher' }, 'read')
    expect(watcher.kind).toBe('phone')
    expect(state.mobileDevices[0]).toMatchObject({ name: 'Watcher', kind: 'phone', scopes: ['read'] })
    expect((await fetch(base + '/api/state', { headers: { Cookie: watcher.cookie } })).status).toBe(200)
    expect((await fetch(base + '/api/chat/chat-1', { headers: { Cookie: watcher.cookie } })).status).toBe(200)
    // The page asks what it may do, and a phone that may only watch is told so (the route itself is a read).
    const watching = await fetch(base + '/api/session', { headers: { Cookie: watcher.cookie } })
    expect(watching.status).toBe(200)
    expect(await watching.json()).toEqual({ id: state.mobileDevices[0].id, name: 'Watcher', kind: 'phone', scopes: ['read'] })
    expect((await fetch(base + '/api/session')).status).toBe(401)
    const refused = await send(watcher.cookie)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'This phone can watch but not operate. Approve it again with more access.', code: 'refused' })
    expect((await fetch(base + '/api/chat/chat-1/stop', { method: 'POST', headers: { Cookie: watcher.cookie, Origin: origin } })).status).toBe(403)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()

    // No access named: Operate, as every phone could before.
    const operator = await pair({ name: 'Operator' })
    expect(state.mobileDevices[1]).toMatchObject({ kind: 'phone', scopes: ['read', 'operate'] })
    expect(await (await fetch(base + '/api/session', { headers: { Cookie: operator.cookie } })).json()).toMatchObject({ name: 'Operator', scopes: ['read', 'operate'] })
    expect((await send(operator.cookie)).status).toBe(200)
    // A browser says so, and anything else is not a kind.
    expect((await pair({ name: 'Chrome', kind: 'browser' }, 'admin')).kind).toBe('browser')
    expect(state.mobileDevices[2]).toMatchObject({ kind: 'browser', scopes: ['read', 'operate', 'admin'] })
    expect((await pair({ name: 'Toaster', kind: 'toaster' })).status).toBe(400)
    // A record saved before scopes existed operates.
    state.mobileDevices.push({ id: 'old-phone', name: 'Old', pairedAt: '2026-01-01T00:00:00Z', transport: 'private' })
    credentials.set('mobile:old-phone', 'old-secret')
    expect((await send('foreman_mobile=old-phone.old-secret')).status).toBe(200)
    expect(sendMessage).toHaveBeenCalledTimes(2)

    // The upgrade: the path, the origin (required) and the credential, by cookie or bearer.
    const ws = base.replace('http:', 'ws:') + '/api/ws'
    expect(await upgrade(ws, { Cookie: 'foreman_mobile=nobody.wrong', Origin: origin })).toEqual({ status: 401 })
    expect(await upgrade(ws, { Cookie: watcher.cookie, Origin: 'https://evil.example' })).toEqual({ status: 403 })
    expect(await upgrade(ws, { Cookie: watcher.cookie })).toEqual({ status: 403 })
    expect(await upgrade(base.replace('http:', 'ws:') + '/api/other', { Cookie: watcher.cookie, Origin: origin })).toEqual({ status: 404 })
    const live = await upgrade(ws, { Cookie: watcher.cookie, Origin: origin })
    if (!('ws' in live)) throw new Error(`Refused with ${live.status}`)
    live.ws.send(JSON.stringify(hello))
    expect(await live.next()).toMatchObject({ t: 'welcome', ok: true, session: { id: state.mobileDevices[0].id, kind: 'phone', name: 'Watcher', scopes: ['read'] }, version: '1.2.3', name: 'Desk' })
    live.ws.send(JSON.stringify({ t: 'call', id: 1, method: 'sendMessage', args: ['chat-1', 'hi'] }))
    expect(await live.next()).toMatchObject({ t: 'reply', id: 1, ok: false, code: 'refused' })
    serve.emit({ type: 'notify', workspaceId: 'w', sessionId: 'chat-1', title: 't', body: 'b' })
    expect(await live.next()).toMatchObject({ t: 'event', event: { type: 'notify' } })
    const bearer = await upgrade(ws, { Authorization: `Bearer ${operator.cookie.slice('foreman_mobile='.length)}`, Origin: origin })
    if (!('ws' in bearer)) throw new Error(`Refused with ${bearer.status}`)
    bearer.ws.send(JSON.stringify(hello))
    expect(await bearer.next()).toMatchObject({ t: 'welcome', ok: true, session: { name: 'Operator', scopes: ['read', 'operate'] } })
    expect(service.connections).toBe(2)

    // Revoking ends the live socket at once, and only that device's.
    service.revoke(state.mobileDevices[0].id)
    expect(await live.next()).toEqual({ t: 'bye', reason: 'revoked' })
    expect(await live.closed).toBe(1000)
    await vi.waitFor(() => expect(service.connections).toBe(1))
    // Quitting says goodbye to the rest.
    await service.close()
    expect(await bearer.next()).toEqual({ t: 'bye', reason: 'shutdown' })
  })

  it('serves the phone page’s own live.js a welcome, its calls and the broadcasts of the chat it views', async () => {
    const credentials = new Map<string, string>()
    const state = { settings: { mobileEnabled: false, mobileUrl: '' }, mobileDevices: [] as MobileDevice[] }
    const store = { state, save: vi.fn() } as unknown as Store
    const secrets = {
      appSecret: (key: string) => credentials.get(key),
      setAppSecret: (key: string, value: string | null) => value === null ? credentials.delete(key) : credentials.set(key, value)
    } as unknown as SecretStore
    const getChat = vi.fn(async (_id: string, live?: boolean) => [{ id: 'i1', kind: 'assistant', text: live ? 'Writ' : '', streaming: true }])
    const snapshot = { repos: [], workspaces: [], sessions: [], settings: { ...state.settings, promptTemplates: [] } } as unknown as AppSnapshot
    const serve = serving({ getChat } as unknown as Api)
    const service = new MobileService({
      store, secrets, ...serve, snapshot: () => snapshot, approvals: () => [], consentNeeded: () => [],
      appPath: process.cwd(), onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0)
    services.push(service)
    const origin = 'https://foreman.example.ts.net'
    const base = `http://127.0.0.1:${(await service.configure(true, origin)).port}`
    const token = new URL((await service.startPairing()).pairing!.url).searchParams.get('pair')
    const started = await fetch(base + '/api/pair/start', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: 'iPhone' }) })
    const { id } = await started.json() as { id: string }
    service.approve(id, true)
    const cookie = (await fetch(base + '/api/pair/status?id=' + id)).headers.get('set-cookie')!.split(';')[0]
    // The page's chat route can include the reply being written, which chat-append then continues.
    expect(await (await fetch(base + '/api/chat/chat-1?live=1', { headers: { Cookie: cookie } })).json()).toEqual([expect.objectContaining({ text: 'Writ' })])
    expect(getChat).toHaveBeenLastCalledWith('chat-1', true)

    // live.js as the page loads it, with `ws` as its WebSocket; a browser sends the page's cookie and origin itself.
    const window: Record<string, unknown> = {}
    vm.runInNewContext(readFileSync(path.join(process.cwd(), 'resources/mobile/live.js'), 'utf8'), { window })
    class PageSocket extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { Cookie: cookie, Origin: origin } })
        sockets.push(this)
      }
    }
    type Live = { setView(view: unknown): void; call(method: string, args: unknown[]): Promise<unknown>; close(): void }
    const statuses: string[] = []
    const events: MainEvent[] = []
    let scopes: string[] = []
    const live = (window.ForemanLive as { connect(options: Record<string, unknown>): Live }).connect({
      url: base.replace('http:', 'ws:') + '/api/ws', WebSocket: PageSocket, setTimeout, clearTimeout, document: null,
      client: { kind: 'phone', name: 'iPhone' },
      onStatus: (s: string) => statuses.push(s),
      onWelcome: (w: { session: { scopes: string[] } }) => { scopes = w.session.scopes },
      onEvent: (event: MainEvent) => events.push(event)
    })
    await vi.waitFor(() => expect(statuses).toEqual(['connecting', 'live']))
    expect(scopes).toEqual(['read', 'operate'])
    expect(await live.call('getChat', ['chat-1', true])).toEqual([expect.objectContaining({ id: 'i1' })])

    serve.emit({ type: 'state', snapshot })
    await vi.waitFor(() => expect(events).toEqual([{ type: 'state', snapshot }]))
    // The chat it views, and no other's. A call after the view frame is answered after the server read it.
    live.setView({ sessionId: 'chat-1' })
    await live.call('getChat', ['chat-1'])
    serve.emit({ type: 'chat-append', sessionId: 'chat-2', itemId: 'x', from: 0, text: 'other' })
    serve.emit({ type: 'chat-append', sessionId: 'chat-1', itemId: 'i1', from: 4, text: 'ing' })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toEqual({ type: 'chat-append', sessionId: 'chat-1', itemId: 'i1', from: 4, text: 'ing' })

    // Revoked on the desktop: the page hears it and stops.
    service.revoke(state.mobileDevices[0].id)
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('revoked'))
    live.close()
  })
  it('serves the renderer at /app to a signed-in browser, sends one without a cookie to pair or to how to sign in', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'foreman-renderer-'))
    cleanupDirs.push(dir)
    mkdirSync(path.join(dir, 'assets'))
    // As the build writes it: the meta tag over several lines.
    writeFileSync(path.join(dir, 'index.html'), [
      '<!doctype html><html><head>',
      '    <meta',
      '      http-equiv="Content-Security-Policy"',
      `      content="default-src 'self'; connect-src 'self' ws://localhost:*"`,
      '    />',
      '<title>Foreman</title><script type="module" crossorigin src="./assets/index-abc.js"></script></head><body><div id="root"></div></body></html>'
    ].join('\n'))
    writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)')
    writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'no')
    const credentials = new Map<string, string>()
    const state = { settings: { mobileEnabled: false, mobileUrl: '' }, mobileDevices: [] as MobileDevice[] }
    const store = { state, save: vi.fn() } as unknown as Store
    const secrets = {
      appSecret: (key: string) => credentials.get(key),
      setAppSecret: (key: string, value: string | null) => value === null ? credentials.delete(key) : credentials.set(key, value)
    } as unknown as SecretStore
    const snapshot = { repos: [{ id: 'r1', name: 'secret-repo' }], workspaces: [], sessions: [], settings: { ...state.settings, promptTemplates: [] } } as unknown as AppSnapshot
    const service = new MobileService({
      store, secrets, ...serving({} as Api), snapshot: () => snapshot, approvals: () => [], consentNeeded: () => [],
      appPath: process.cwd(), rendererPath: dir, onChanged: vi.fn(), onEnabledChange: vi.fn()
    }, 0)
    services.push(service)
    const origin = 'https://foreman.example.ts.net'
    const base = `http://127.0.0.1:${(await service.configure(true, origin)).port}`
    const get = (url: string, cookie?: string) => fetch(base + url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })

    // No cookie: how to sign in, and nothing of this computer's work.
    const signIn = await get('/app')
    expect(signIn.status).toBe(200)
    const signInText = await signIn.text()
    expect(signInText).toContain('foreman phone link --browser')
    expect(signInText).not.toContain('secret-repo')
    expect(signInText).not.toContain('index-abc.js')
    // With a pairing link: the phone page pairs it, as a browser, and comes back to /app.
    const toPair = await get('/app?pair=abc_123')
    expect(toPair.status).toBe(302)
    expect(toPair.headers.get('location')).toBe('/?pair=abc_123&then=/app')
    // The pairing page goes on to /app only. (Its script has no build step to catch a slip, so it is parsed here.)
    expect(() => new vm.Script(readFileSync(path.join(process.cwd(), 'resources/mobile/app.js'), 'utf8'))).not.toThrow()
    expect((await get('/?pair=abc&then=/app')).status).toBe(200)
    for (const evil of ['/evil', '//evil.example', 'https://evil.example/app']) {
      const res = await get(`/?pair=abc&then=${encodeURIComponent(evil)}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/?pair=abc')
    }
    expect((await get('/assets/index-abc.js')).status).toBe(401)
    expect((await get('/app/anything')).status).toBe(404)

    // Signed in as a browser.
    const token = new URL((await service.startPairing()).pairing!.url).searchParams.get('pair')
    const started = await fetch(base + '/api/pair/start', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: 'Chrome on Mac', kind: 'browser' }) })
    const { id } = await started.json() as { id: string }
    expect(service.info().pending?.kind).toBe('browser')
    service.approve(id, true)
    const cookie = (await fetch(base + '/api/pair/status?id=' + id)).headers.get('set-cookie')!.split(';')[0]

    const app = await get('/app', cookie)
    expect(app.status).toBe(200)
    const html = await app.text()
    expect(html).toContain('<script type="module" crossorigin src="./assets/index-abc.js">')
    // Electron's meta CSP is gone; one header names this page's socket.
    expect(html).not.toContain('Content-Security-Policy')
    const csp = app.headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'self';")
    expect(csp).toContain("connect-src 'self' wss://foreman.example.ts.net;")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('ws://localhost')
    expect(app.headers.get('x-frame-options')).toBe('DENY')
    expect(app.headers.get('cache-control')).toBe('no-store')
    expect((await get('/app/', cookie)).headers.get('location')).toBe('/app')

    const asset = await get('/assets/index-abc.js', cookie)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(await asset.text()).toBe('console.log(1)')
    // Sent as written: fetch would tidy the dots away before they reached the server.
    const raw = (url: string) => new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + '/', { path: url, headers: { Cookie: cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    for (const bad of ['/assets/../secret.txt', '/assets/..%2fsecret.txt', '/assets/%2e%2e%2fsecret.txt', '/assets/..%5Csecret.txt', '/assets/..\\secret.txt', '/assets/missing.js', '/assets/index-abc.exe']) {
      expect([400, 404]).toContain(await raw(bad))
    }
  })
})
