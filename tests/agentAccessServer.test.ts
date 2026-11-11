// docs/agent-access.md §5 and §6: the loopback endpoint and signing in, over real HTTP on an ephemeral port: discovery,
// registration, the waiting page and the typed code, PKCE, codes, refresh with its grace window, revoking, the guards,
// and the records left out of backups.
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { AGENT_ACCESS_PORT, AgentAccessService, MAX_PENDING, type McpHandler } from '../src/main/agentAccess/server'
import { MAX_CLIENTS } from '../src/main/agentAccess/records'
import { Core } from '../src/main/core'
import { makeGitBackupFiles, parseGitBackup } from '../src/main/gitBackup'
import { SecretStore } from '../src/main/secrets'
import { Store, defaultSettings } from '../src/main/store'
import type { AgentAccessLevel, AgentClient } from '../src/shared/agentAccess'
import { tempDir } from './helpers'

const services: AgentAccessService[] = []
const stores: Store[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()))
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const s of stores.splice(0)) s.close()
})

function fakes() {
  const vault = new Map<string, string>()
  const state = { settings: { language: 'en', agentAccessEnabled: true, agentAccessPort: AGENT_ACCESS_PORT } } as unknown as Store['state']
  const store = { state, save: vi.fn() } as unknown as Store
  const secrets = {
    appSecret: (key: string) => vault.get(key),
    setAppSecret: (key: string, value: string | null) => void (value === null ? vault.delete(key) : vault.set(key, value))
  } as unknown as SecretStore
  return { store, secrets, vault, state }
}

async function rig(base = fakes()) {
  let clock = Date.parse('2026-11-10T09:00:00Z')
  const onChanged = vi.fn()
  const service = new AgentAccessService({ store: base.store, secrets: base.secrets, onChanged, now: () => clock, port: 0 })
  services.push(service)
  await service.start()
  const origin = service.origin
  return {
    ...base, service, onChanged, origin,
    advance: (ms: number) => { clock += ms },
    get: (route: string, init: RequestInit = {}) => fetch(`${origin}${route}`, { redirect: 'manual', ...init }),
    form: (route: string, values: Record<string, string>) => fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() }),
    register: async (body: Record<string, unknown> = {}) => {
      const res = await fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:1234/cb'], ...body }) })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
  }
}
type Rig = Awaited<ReturnType<typeof rig>>

/** A raw request, so the Host header can be anything. */
function raw(port: number, route: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
    })
    req.on('error', reject)
    req.end()
  })
}

const verifier = 'v'.repeat(43) + 'erifier-for-this-test'
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url')

/** GET /oauth/authorize as the browser does: the page, with the code it shows and where it polls. */
async function authorize(r: Rig, clientId: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:5678/cb', code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state: 'xyz', ...extra })
  const res = await r.get(`/oauth/authorize?${params}`)
  const html = await res.text()
  const code = /class="code">(\d{3}) (\d{3})</.exec(html)
  const status = /data-status="([^"]+)"/.exec(html)?.[1]
  return { res, html, code: code ? code[1] + code[2] : undefined, status }
}

async function poll(r: Rig, status: string) {
  return await (await r.get(status)).json() as { state: string; location?: string }
}

/** Register, authorize, approve with the typed code, and exchange: the tokens. */
async function signIn(r: Rig, level: AgentAccessLevel = 'ask') {
  const { body } = await r.register()
  const clientId = body.client_id as string
  const page = await authorize(r, clientId)
  const pending = r.service.info().pending.at(-1)!
  r.service.approve(pending.id, page.code!, level)
  const { location } = await poll(r, page.status!)
  const code = new URL(location!).searchParams.get('code')!
  const res = await r.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:5678/cb', client_id: clientId, code_verifier: verifier, resource: `${r.origin}/mcp` })
  expect(res.status).toBe(200)
  return { clientId, code, tokens: await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string } }
}

const mcp = (r: Rig, token?: string, method = 'POST') => r.get('/mcp', { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined })

describe('discovery and metadata', () => {
  it('answers /mcp without a token with 401 and where to read the metadata, which name this origin', async () => {
    const r = await rig()
    expect(AGENT_ACCESS_PORT).toBe(47634)
    const res = await mcp(r)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${r.origin}/.well-known/oauth-protected-resource"`)
    const bad = await mcp(r, 'nonsense')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"')
    for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = await (await r.get(route)).json()
      expect(prm).toMatchObject({ resource: `${r.origin}/mcp`, authorization_servers: [r.origin], scopes_supported: ['read', 'ask', 'ask-except-edits', 'auto', 'never-ask'] })
    }
    const as = await (await r.get('/.well-known/oauth-authorization-server')).json()
    expect(as).toMatchObject({
      issuer: r.origin, authorization_endpoint: `${r.origin}/oauth/authorize`, token_endpoint: `${r.origin}/oauth/token`,
      registration_endpoint: `${r.origin}/oauth/register`, revocation_endpoint: `${r.origin}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
    })
    expect((await mcp(r, undefined, 'GET')).status).toBe(405)
    expect((await mcp(r, undefined, 'DELETE')).status).toBe(405)
  })

  it('signs in with the SDK’s own client functions, and hands /mcp to the handler with the grant', async () => {
    const r = await rig()
    const info = await discoverOAuthServerInfo(`${r.origin}/mcp`)
    expect(info.authorizationServerUrl.replace(/\/$/, '')).toBe(r.origin)
    const metadata = info.authorizationServerMetadata!
    const client = await registerClient(info.authorizationServerUrl, { metadata, clientMetadata: { client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'], token_endpoint_auth_method: 'none' } })
    const redirectUrl = 'http://localhost:40001/callback'
    const resource = new URL(info.resourceMetadata!.resource)
    const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, { metadata, clientInformation: client, redirectUrl, state: 's1', resource })
    const html = await (await fetch(authorizationUrl, { redirect: 'manual' })).text()
    expect(html).toContain('This sign-in calls itself <strong>Claude Code</strong>.')
    expect(html).not.toMatch(/<script>|style=/)
    const code = /class="code">(\d{3}) (\d{3})</.exec(html)!
    const pending = r.service.info().pending
    expect(pending).toEqual([{ id: expect.any(String), name: 'Claude Code', redirect: 'localhost:40001', expiresAt: expect.any(Number) }])
    // Nothing Foreman reports holds the code.
    expect(JSON.stringify(r.service.info())).not.toContain(code[1] + code[2])
    r.service.approve(pending[0].id, `${code[1]} ${code[2]}`, 'auto')
    const status = /data-status="([^"]+)"/.exec(html)![1]
    const { state, location } = await poll(r, status)
    expect(state).toBe('approved')
    const back = new URL(location!)
    expect(`${back.origin}${back.pathname}`).toBe(redirectUrl)
    expect(back.searchParams.get('state')).toBe('s1')
    expect(back.searchParams.get('iss')).toBe(r.origin)
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata, clientInformation: client, authorizationCode: back.searchParams.get('code')!, codeVerifier, redirectUri: redirectUrl, resource })
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'auto' })
    expect(r.service.info().grants).toEqual([expect.objectContaining({ clientId: client.client_id, name: 'Claude Code', redirect: 'localhost:40001', level: 'auto' })])
    // No handler yet: 503. With one: the grant and the parsed body.
    expect((await mcp(r, tokens.access_token)).status).toBe(503)
    const handler = vi.fn<McpHandler>(async (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    r.service.setMcpHandler(handler)
    expect((await mcp(r, tokens.access_token)).status).toBe(200)
    expect(handler.mock.calls[0][2]).toMatchObject({ level: 'auto', name: 'Claude Code' })
    expect(handler.mock.calls[0][3]).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const again = await refreshAuthorization(info.authorizationServerUrl, { metadata, clientInformation: client, refreshToken: tokens.refresh_token!, resource })
    expect(again.access_token).not.toBe(tokens.access_token)
  })

  it('refuses an MCP body over 1 MB', async () => {
    const r = await rig()
    const { tokens } = await signIn(r)
    const handler = vi.fn<McpHandler>(async (_req, res) => { res.end() })
    r.service.setMcpHandler(handler)
    // The answer comes from the declared length, before any of the body is sent.
    const port = Number(new URL(r.origin).port)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024 + 1) } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        req.destroy()
      })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('registration', () => {
  it('takes loopback http redirects only, and answers a public client', async () => {
    const r = await rig()
    for (const uri of ['https://example.com/cb', 'http://example.com/cb', 'https://127.0.0.1:1/cb', 'http://127.0.0.1.example.com/cb', 'http://user:pw@127.0.0.1:1/cb', 'http://127.0.0.1:1/cb#frag']) {
      const { status, body } = await r.register({ redirect_uris: [uri] })
      expect(status, uri).toBe(400)
      expect(body.error, uri).toBe('invalid_redirect_uri')
    }
    expect((await r.register({ redirect_uris: [] })).status).toBe(400)
    const ok = await r.register({ client_name: `  Claude‮ Code\u0007 ${'x'.repeat(80)}`, redirect_uris: ['http://localhost:1/cb', 'http://[::1]:2/cb', 'http://127.0.0.1/cb'], token_endpoint_auth_method: 'client_secret_post' })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
    expect(ok.body).not.toHaveProperty('client_secret')
    expect(ok.body.client_name).toBe(`Claude Code ${'x'.repeat(38)}`)
    expect([...ok.body.client_name as string]).toHaveLength(50)
    expect(r.state.agentAccess?.clients).toHaveLength(1)
    expect((await r.register({ client_name: undefined })).body.client_name).toBe('MCP client')
  })

  it('drops a registration that never signed in after a day or when the list is full, and keeps one that did', async () => {
    const r = await rig()
    const { clientId } = await signIn(r)
    const unused = (await r.register()).body.client_id
    r.advance(25 * 60 * 60_000)
    await r.register()
    const ids = r.state.agentAccess!.clients.map((c) => c.id)
    expect(ids).toContain(clientId)
    expect(ids).not.toContain(unused)
    // Full: the oldest that never signed in goes; one with a current sign-in never does.
    const clients = r.state.agentAccess!.clients
    while (clients.length < MAX_CLIENTS) clients.push({ id: `c${clients.length}`, name: 'x', redirectUris: ['http://127.0.0.1/cb'], createdAt: new Date(Date.parse('2026-11-11T09:00:00Z') + clients.length).toISOString() } as AgentClient)
    const oldestUnused = clients.filter((c) => !c.everSignedIn).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].id
    await r.register()
    expect(r.state.agentAccess!.clients).toHaveLength(MAX_CLIENTS)
    expect(r.state.agentAccess!.clients.map((c) => c.id)).not.toContain(oldestUnused)
    expect(r.state.agentAccess!.clients.map((c) => c.id)).toContain(clientId)
  })
})

describe('authorization', () => {
  it('matches a loopback redirect with any port, and shows an error page without redirecting for a bad client or path', async () => {
    const r = await rig()
    const id = (await r.register()).body.client_id as string
    const page = await authorize(r, id)
    expect(page.res.status).toBe(200)
    expect(page.res.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(page.res.headers.get('x-frame-options')).toBe('DENY')
    expect(page.code).toMatch(/^\d{6}$/)
    const bad: Record<string, string>[] = [{ redirect_uri: 'http://127.0.0.1:5678/other' }, { redirect_uri: 'http://localhost:5678/cb' }, { redirect_uri: 'https://127.0.0.1:5678/cb' }, { client_id: 'unknown' }]
    for (const extra of bad) {
      const refused = await authorize(r, id, extra)
      expect(refused.res.status, JSON.stringify(extra)).toBe(400)
      expect(refused.res.headers.get('location')).toBeNull()
      expect(refused.html).toContain('This sign-in can’t go on')
    }
  })

  it('sends any other bad parameter back to the client with the OAuth error, the state and the issuer', async () => {
    const r = await rig()
    const id = (await r.register()).body.client_id as string
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'http://127.0.0.1:1/mcp' }, 'invalid_target']
    ]
    for (const [extra, error] of cases) {
      const { res } = await authorize(r, id, extra)
      expect(res.status).toBe(302)
      const back = new URL(res.headers.get('location')!)
      expect(back.searchParams.get('error')).toBe(error)
      expect(back.searchParams.get('state')).toBe('xyz')
      expect(back.searchParams.get('iss')).toBe(r.origin)
    }
    expect(r.service.info().pending).toEqual([])
  })

  it('approves only with the typed code; three wrong codes deny it, and the page goes back with access_denied', async () => {
    const r = await rig()
    const id = (await r.register()).body.client_id as string
    const page = await authorize(r, id)
    const pending = r.service.info().pending[0]
    const wrong = page.code === '000000' ? '111111' : '000000'
    expect(() => r.service.approve(pending.id, wrong, 'ask')).toThrow('2 tries left')
    expect(() => r.service.approve(pending.id, 'abc', 'ask')).toThrow('1 try left')
    expect(await poll(r, page.status!)).toEqual({ state: 'waiting' })
    expect(() => r.service.approve(pending.id, wrong, 'ask')).toThrow('denied')
    expect(() => r.service.approve(pending.id, page.code!, 'ask')).toThrow('expired or was already answered')
    const denied = await poll(r, page.status!)
    expect(denied.state).toBe('denied')
    expect(new URL(denied.location!).searchParams.get('error')).toBe('access_denied')
    expect(await poll(r, page.status!)).toEqual({ state: 'gone' })
    // Denied from Foreman, and expired.
    const second = await authorize(r, id)
    r.service.deny(r.service.info().pending[0].id)
    expect(new URL((await poll(r, second.status!)).location!).searchParams.get('error')).toBe('access_denied')
    const third = await authorize(r, id)
    const late = r.service.info().pending[0]
    r.advance(5 * 60_000 + 1)
    expect(r.service.info().pending).toEqual([])
    expect(() => r.service.approve(late.id, third.code!, 'ask')).toThrow('expired')
    expect(new URL((await poll(r, third.status!)).location!).searchParams.get('error')).toBe('access_denied')
    expect(() => r.service.approve('nope', '123456', 'root' as AgentAccessLevel)).toThrow('access level')
  })

  it('lets at most three sign-ins wait, and refuses a fourth without dropping one', async () => {
    const r = await rig()
    const id = (await r.register()).body.client_id as string
    for (let i = 0; i < MAX_PENDING; i++) expect((await authorize(r, id)).res.status).toBe(200)
    const before = r.service.info().pending.map((p) => p.id)
    const fourth = await authorize(r, id)
    expect(fourth.res.status).toBe(429)
    expect(fourth.html).toContain('Three sign-ins are already waiting')
    expect(r.service.info().pending.map((p) => p.id)).toEqual(before)
    r.service.deny(before[0])
    expect((await authorize(r, id)).res.status).toBe(200)
  })

  it('shows the page in the user’s language', async () => {
    const r = await rig()
    ;(r.state.settings as { language: string }).language = 'de'
    const id = (await r.register()).body.client_id as string
    const page = await authorize(r, id)
    expect(page.html).toContain('<html lang="de">')
    expect(page.html).toContain('Diese Anmeldung nennt sich <strong>Claude Code</strong>.')
  })
})

describe('tokens', () => {
  it('checks the PKCE verifier, the client, the redirect and the resource, and uses a code once', async () => {
    const r = await rig()
    const id = (await r.register()).body.client_id as string
    const approveOne = async () => {
      const page = await authorize(r, id)
      r.service.approve(r.service.info().pending[0].id, page.code!, 'read')
      return new URL((await poll(r, page.status!)).location!).searchParams.get('code')!
    }
    const exchange = (code: string, extra: Record<string, string> = {}) => r.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:5678/cb', client_id: id, code_verifier: verifier, ...extra })
    const code = await approveOne()
    const wrong = await exchange(code, { code_verifier: 'w'.repeat(43) })
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toBe('invalid_grant')
    // Single use, whatever the outcome.
    expect((await exchange(code)).status).toBe(400)
    expect((await (await exchange(await approveOne(), { redirect_uri: 'http://127.0.0.1:9999/cb' })).json()).error).toBe('invalid_grant')
    expect((await (await exchange(await approveOne(), { resource: 'http://127.0.0.1:1/mcp' })).json()).error).toBe('invalid_target')
    expect((await exchange(await approveOne(), { client_id: 'other' })).status).toBe(401)
    const late = await approveOne()
    r.advance(61_000)
    expect((await (await exchange(late)).json()).error).toBe('invalid_grant')
    const json = await r.get('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect((await json.json()).error).toBe('invalid_request')
    expect(r.service.info().grants).toEqual([])
  })

  it('revokes what a code was exchanged for when the code comes again', async () => {
    const r = await rig()
    const { clientId, code, tokens } = await signIn(r, 'ask')
    expect(tokens.scope).toBe('ask')
    expect(r.service.info().grants).toHaveLength(1)
    const again = await r.form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:5678/cb', client_id: clientId, code_verifier: verifier })
    expect((await again.json()).error).toBe('invalid_grant')
    expect(r.service.info().grants).toEqual([])
    expect((await mcp(r, tokens.access_token)).status).toBe(401)
    expect(r.vault.size).toBe(0)
  })

  it('rotates refresh tokens, answers the same pair within the grace window, and revokes on reuse after it', async () => {
    const r = await rig()
    const { clientId, tokens } = await signIn(r)
    const grantId = r.service.info().grants[0].id
    expect(JSON.parse(r.vault.get(`agent-access:${grantId}`)!)).toEqual({ current: expect.any(String) })
    expect(r.vault.get(`agent-access:${grantId}`)).not.toContain(tokens.refresh_token)
    const refresh = (token: string) => r.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId })
    const first = await (await refresh(tokens.refresh_token)).json()
    expect(first.refresh_token).not.toBe(tokens.refresh_token)
    r.advance(30_000)
    const same = await (await refresh(tokens.refresh_token)).json()
    expect(same.access_token).toBe(first.access_token)
    expect(same.refresh_token).toBe(first.refresh_token)
    // Another client can't use it.
    expect((await r.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: (await r.register()).body.client_id as string })).status).toBe(400)
    // The new one works, and rotates again; the original, presented after the window, is a copy.
    const second = await (await refresh(first.refresh_token)).json()
    expect((await mcp(r, second.access_token)).status).toBe(503)
    r.advance(61_000)
    const reused = await refresh(first.refresh_token)
    expect((await reused.json()).error).toBe('invalid_grant')
    expect(r.service.info().grants).toEqual([])
    expect((await mcp(r, second.access_token)).status).toBe(401)
    expect((await refresh(second.refresh_token)).status).toBe(400)
  })

  it('ends access tokens after an hour', async () => {
    const r = await rig()
    const { tokens } = await signIn(r)
    r.advance(60 * 60_000 + 1)
    expect((await mcp(r, tokens.access_token)).status).toBe(401)
  })

  it('revokes (RFC 7009): an access token alone, a refresh token the whole sign-in, an unknown token nothing', async () => {
    const r = await rig()
    const { clientId, tokens } = await signIn(r)
    expect((await r.form('/oauth/revoke', { token: 'unknown' })).status).toBe(200)
    expect((await r.form('/oauth/revoke', { token: tokens.access_token, client_id: clientId })).status).toBe(200)
    expect((await mcp(r, tokens.access_token)).status).toBe(401)
    const fresh = await (await r.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json()
    expect((await mcp(r, fresh.access_token)).status).toBe(503)
    r.onChanged.mockClear()
    expect((await r.form('/oauth/revoke', { token: fresh.refresh_token })).status).toBe(200)
    expect(r.onChanged).toHaveBeenCalled()
    expect(r.service.info().grants).toEqual([])
    expect((await mcp(r, fresh.access_token)).status).toBe(401)
  })

  it('revokes from Foreman at once, and forgets access tokens on restart while refresh still works', async () => {
    const base = fakes()
    const r = await rig(base)
    const { clientId, tokens } = await signIn(r)
    await r.service.close()
    const again = await rig(base)
    expect((await mcp(again, tokens.access_token)).status).toBe(401)
    const fresh = await (await again.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json()
    expect((await mcp(again, fresh.access_token)).status).toBe(503)
    again.service.revoke(again.service.info().grants[0].id)
    expect((await mcp(again, fresh.access_token)).status).toBe(401)
    expect(base.vault.size).toBe(0)
  })
})

describe('guards', () => {
  it('refuses another Host or Origin, and sends no CORS headers', async () => {
    const r = await rig()
    const port = Number(new URL(r.origin).port)
    expect((await raw(port, '/.well-known/oauth-authorization-server', { Host: `127.0.0.1:${port}` })).status).toBe(200)
    expect((await raw(port, '/.well-known/oauth-authorization-server', { Host: `localhost:${port}` })).status).toBe(403)
    expect((await raw(port, '/.well-known/oauth-authorization-server', { Host: `evil.example:${port}` })).status).toBe(403)
    expect((await raw(port, '/mcp', { Host: `localhost:${port}` }, 'POST')).status).toBe(403)
    const foreign = await raw(port, '/.well-known/oauth-authorization-server', { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' })
    expect(foreign.status).toBe(403)
    expect((await raw(port, '/oauth/register', { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:3000' }, 'POST')).status).toBe(403)
    const own = await raw(port, '/oauth/authorize/status?id=x', { Host: `127.0.0.1:${port}`, Origin: r.origin })
    expect(own.status).toBe(200)
    for (const res of [foreign, own]) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    }
    const js = await r.get('/oauth/page.js')
    expect(js.headers.get('content-type')).toContain('javascript')
    expect((await r.get('/oauth/style.css')).headers.get('content-type')).toContain('text/css')
  })
})

describe('turning it on and off', () => {
  it('turns the setting off and says why when the port is taken, and keeps sign-ins when turned off', async () => {
    const r = await rig()
    await signIn(r)
    await r.service.configure(false)
    expect(r.service.listening).toBe(false)
    expect(r.service.info()).toMatchObject({ enabled: false, grants: [expect.any(Object)] })
    const holder = createServer()
    servers.push(holder)
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const taken = (holder.address() as { port: number }).port
    const other = new AgentAccessService({ store: r.store, secrets: r.secrets, onChanged: () => undefined })
    services.push(other)
    await expect(other.configure(true, taken)).rejects.toThrow(`127.0.0.1:${taken}`)
    expect(r.state.settings.agentAccessEnabled).toBe(false)
    expect(other.info().error).toContain('another program is using it')
    await expect(other.configure(true, 80)).rejects.toThrow('1024 to 65535')
  })

  it('runs on, off and on again in quick succession one after another, ending on one listener', async () => {
    const base = fakes()
    base.state.settings.agentAccessEnabled = false
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise((resolve) => probe.close(resolve))
    const service = new AgentAccessService({ store: base.store, secrets: base.secrets, onChanged: () => undefined })
    services.push(service)
    const all = await Promise.all([service.configure(true, port), service.configure(false), service.configure(true)])
    expect(all.map((info) => info.enabled)).toEqual([true, false, true])
    expect(service.listening).toBe(true)
    expect(service.info()).toMatchObject({ enabled: true, port })
    expect(service.info().error).toBeUndefined()
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).status).toBe(200)
    // Off really closes it: nothing was left listening behind the last one.
    await service.configure(false)
    await expect(fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).rejects.toThrow()
    // A refused call doesn't hold up the next.
    await expect(service.configure(true, 80)).rejects.toThrow('1024 to 65535')
    expect((await service.configure(true)).enabled).toBe(true)
  })

  it('says why in the user’s language: a wrong code, the tries left, a port that can’t be bound or isn’t valid', async () => {
    const r = await rig()
    r.state.settings.language = 'de'
    const id = (await r.register()).body.client_id as string
    const page = await authorize(r, id)
    const pending = r.service.info().pending[0]
    const wrong = page.code === '000000' ? '111111' : '000000'
    expect(() => r.service.approve(pending.id, wrong, 'ask')).toThrow('Noch 2 Versuche')
    expect(() => r.service.approve(pending.id, wrong, 'ask')).toThrow('Noch 1 Versuch.')
    expect(() => r.service.approve(pending.id, wrong, 'ask')).toThrow('3-mal falsch')
    await expect(r.service.configure(true, 80)).rejects.toThrow('ganze Zahl von 1024 bis 65535')
    const holder = createServer()
    servers.push(holder)
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const taken = (holder.address() as { port: number }).port
    const other = new AgentAccessService({ store: r.store, secrets: r.secrets, onChanged: () => undefined })
    services.push(other)
    await expect(other.configure(true, taken)).rejects.toThrow(`127.0.0.1:${taken} nicht auf Agenten warten (ein anderes Programm verwendet ihn)`)
  })

  it('follows updateSettings, as `foreman settings set devices.agent-access` writes it', async () => {
    const dir = await tempDir('foreman-agent-access-core-')
    const store = new Store(dir)
    await store.load()
    stores.push(store)
    expect(store.state.settings).toMatchObject({ agentAccessEnabled: false, agentAccessPort: AGENT_ACCESS_PORT })
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const service = new AgentAccessService({ store, secrets, onChanged: () => undefined, port: 0 })
    services.push(service)
    core.bindAgentAccess(service)
    await core.api.updateSettings({ agentAccessEnabled: true, theme: 'dark' })
    expect(service.listening).toBe(true)
    expect(store.state.settings).toMatchObject({ agentAccessEnabled: true, theme: 'dark' })
    await core.api.updateSettings({ agentAccessPort: 47700 })
    expect(store.state.settings.agentAccessPort).toBe(47700)
    await expect(core.api.updateSettings({ agentAccessPort: 5 })).rejects.toThrow('1024 to 65535')
    await core.api.updateSettings({ agentAccessEnabled: false })
    expect(service.listening).toBe(false)
  })
})

describe('records', () => {
  it('keeps sign-ins in state.json’s agentAccess, never in Settings, and leaves them and the listener out of a Git backup', async () => {
    const dir = await tempDir('foreman-agent-access-backup-')
    const store = new Store(dir)
    await store.load()
    stores.push(store)
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
    store.state.settings.agentAccessEnabled = true
    store.state.settings.agentAccessPort = 47700
    const r = await rig({ store, secrets, vault: new Map(), state: store.state })
    await signIn(r)
    expect(store.state.agentAccess?.grants).toHaveLength(1)
    expect(Object.keys(defaultSettings())).not.toContain('agentAccess')
    const files = makeGitBackupFiles(store, secrets, new Date('2026-11-10T00:00:00Z'))
    const text = JSON.stringify(files)
    expect(text).not.toContain('agentAccess')
    expect(text).not.toContain(store.state.agentAccess!.grants[0].id)
    expect(text).not.toContain('Claude Code')
    // A backup that names them anyway doesn't restore them.
    const parsed = parseGitBackup({ ...files, 'variable-names': files.variableNames, settings: { ...files.settings, agentAccessEnabled: true, agentAccessPort: 47700 } })
    expect(parsed.settings).not.toHaveProperty('agentAccessEnabled')
    expect(parsed.settings).not.toHaveProperty('agentAccessPort')
  })
})
