// The loopback endpoint outside agents sign in to and call (docs/agent-access.md §5 and §6): `http://127.0.0.1:<port>`,
// its own listener, never the phone's (whose private one Tailscale Serve forwards to). OAuth 2.1 with PKCE, dynamic
// registration, and a waiting page whose code the person types into Foreman. Plain node:http, as mobile.ts: the SDK's
// server/auth helpers need express, so only its schemas are reused. `POST /mcp` is authenticated here and handed, with
// the grant its token names, to the handler `setMcpHandler` installs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomInt, randomUUID } from 'node:crypto'
import { OAuthClientMetadataSchema, type OAuthMetadata, type OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  AGENT_ACCESS_LEVELS,
  AGENT_ACCESS_PORT,
  DEFAULT_AGENT_ACCESS_LEVEL,
  isAgentAccessLevel,
  type AgentAccessInfo,
  type AgentAccessLevel,
  type AgentAccessPending,
  type AgentGrant
} from '../../shared/agentAccess'
import type { PlainKey, TFunction } from '../../shared/i18n'
import { mainLocale, mainT } from '../i18n'
import type { SecretStore } from '../secrets'
import type { Store } from '../store'
import { errorPage, PAGE_CSS, PAGE_JS, waitingPage } from './pages'
import { cleanName, loopbackRedirect, OAuthError, randomToken, redirectHost, redirectMatches, same, SignInRecords, validChallenge } from './records'

export { AGENT_ACCESS_PORT }

export const PENDING_MS = 5 * 60_000
export const MAX_PENDING = 3
export const MAX_WRONG_CODES = 3
export const MAX_MCP_BODY = 1024 * 1024
const MAX_BODY = 64 * 1024
const MAX_REDIRECTS = 10
const MAX_URI = 2000
// How long a sign-in that ended (approved, denied, expired) can still tell its page where to go.
const KEEP_ENDED_MS = 10 * 60_000
const MIN_PORT = 1024
const MAX_PORT = 65_535

/**
 * `POST /mcp` once its bearer token checks out: the request, the response, the sign-in it acts for, and the JSON body
 * (at most 1 MB, already read and parsed). The handler owns the response from here.
 */
export type McpHandler = (req: IncomingMessage, res: ServerResponse, grant: AgentGrant, body: unknown) => Promise<void>

export interface AgentAccessDeps {
  store: Store
  secrets: SecretStore
  // A sign-in started waiting, ended, was approved or revoked, or the listener started or stopped: for the window's list
  // and the notification.
  onChanged(): void
  // A sign-in ended: drop what its tree queued (docs/agent-access.md §4, "Revoking").
  onRevoked?(grantId: string): void
  now?: () => number
  // Tests: listen here (0 for any free port) instead of `agentAccessPort`.
  port?: number
}

type Pending = {
  id: string
  // What the page polls with: never in info(), so nothing that reads Foreman's state can follow the sign-in.
  pageKey: string
  clientId: string
  name: string
  redirectUri: string
  challenge: string
  state?: string
  code: string
  expiresAt: number
  wrong: number
  status: 'waiting' | 'approved' | 'denied'
  authCode?: string
}

/** What `configure` takes, checked before anything changes (core's updateSettings checks the same without a listener). */
export function checkAgentAccessSettings(enabled: unknown, port: unknown, t: TFunction): void {
  if (typeof enabled !== 'boolean') throw new Error(t('agentAccess.error.enabledInvalid'))
  if (port !== undefined && !(typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT)) throw new Error(t('settings.data.agentAccess.portInvalid', { min: MIN_PORT, max: MAX_PORT }))
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** A query or form's parameters, each sent at most once (RFC 6749 §3.1); `repeated` names the ones sent twice. */
function single(params: URLSearchParams): { get(name: string): string | undefined; repeated: Set<string> } {
  const repeated = new Set<string>()
  const values = new Map<string, string>()
  for (const [key, value] of params) {
    if (values.has(key)) repeated.add(key)
    else values.set(key, value)
  }
  return { get: (name) => values.get(name), repeated }
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value)
  return url.toString()
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'Request is too large.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Request is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export class AgentAccessService {
  readonly records: SignInRecords
  private server: Server | null = null
  private boundPort = 0
  private pending = new Map<string, Pending>()
  private timers = new Set<NodeJS.Timeout>()
  private error: string | undefined
  // configure() calls, run one after another.
  private configuring: Promise<unknown> = Promise.resolve()
  private mcpHandler: McpHandler | null = null
  private now: () => number

  constructor(private deps: AgentAccessDeps) {
    this.now = deps.now ?? Date.now
    this.records = new SignInRecords({ store: deps.store, secrets: deps.secrets, now: this.now, onChanged: () => deps.onChanged(), onRevoked: (id) => deps.onRevoked?.(id) })
  }

  /** Where `POST /mcp` goes once its token checks out; with none, it answers 503. */
  setMcpHandler(handler: McpHandler | null): void {
    this.mcpHandler = handler
  }

  /** The sign-in a tool call acts for, read again when it runs (revoking is felt at once); undefined once revoked. */
  grant(id: string): AgentGrant | undefined {
    return this.records.grant(id)
  }

  get listening(): boolean {
    return this.server !== null
  }

  /** `http://127.0.0.1:<bound port>`: the issuer, and the only Host and Origin a request may name. */
  get origin(): string {
    return `http://127.0.0.1:${this.boundPort}`
  }

  get resource(): string {
    return `${this.origin}/mcp`
  }

  private get settings() {
    return this.deps.store.state.settings
  }

  /** At startup: listens when the setting is on. A port that can't be bound turns it off and says why (info().error). */
  async start(): Promise<void> {
    if (!this.settings.agentAccessEnabled) return
    try {
      await this.listen(this.deps.port ?? this.settings.agentAccessPort)
    } catch (err) {
      this.cannotListen(err)
    }
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await this.closeListener()
  }

  /**
   * Turns access on or off, and moves it to another port. Turning it off closes the listener and forgets the sign-ins
   * waiting, the codes and the access tokens; approved sign-ins are kept, and their clients refresh once it is back.
   */
  async configure(enabled: boolean, port?: number): Promise<AgentAccessInfo> {
    checkAgentAccessSettings(enabled, port, mainT(this.settings))
    // One at a time: on, off and on again in quick succession would otherwise bind twice, or leave a listener behind.
    const run = this.configuring.then(() => this.configureNow(enabled, port))
    this.configuring = run.catch(() => undefined)
    return run
  }

  private async configureNow(enabled: boolean, port?: number): Promise<AgentAccessInfo> {
    const settings = this.settings
    const moved = port !== undefined && port !== settings.agentAccessPort
    if (port !== undefined) settings.agentAccessPort = port
    if (!enabled) await this.closeListener()
    else if (!this.server || moved) {
      await this.closeListener()
      try {
        await this.listen(this.deps.port ?? settings.agentAccessPort)
      } catch (err) {
        this.cannotListen(err)
        throw new Error(this.error)
      }
    }
    settings.agentAccessEnabled = enabled
    this.error = undefined
    this.deps.store.save()
    this.deps.onChanged()
    return this.info()
  }

  info(): AgentAccessInfo {
    this.sweep()
    const port = this.server ? this.boundPort : this.settings.agentAccessPort
    const pending: AgentAccessPending[] = this.waiting().map((p) => ({ id: p.id, name: p.name, redirect: redirectHost(p.redirectUri), expiresAt: p.expiresAt }))
    return {
      enabled: this.settings.agentAccessEnabled && this.server !== null,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      pending,
      grants: this.records.grants(),
      ...(this.error ? { error: this.error } : {})
    }
  }

  /**
   * The person at the computer approves a waiting sign-in at a level, with the code its browser page shows. Checked in
   * constant time; three wrong codes deny it.
   */
  approve(id: string, code: string, level: AgentAccessLevel = DEFAULT_AGENT_ACCESS_LEVEL): AgentAccessInfo {
    const t = mainT(this.settings)
    if (!isAgentAccessLevel(level)) throw new Error(t('agentAccess.error.levelInvalid'))
    const p = this.waitingOne(id)
    if (!same(String(code ?? '').replace(/\s+/g, ''), p.code)) {
      p.wrong += 1
      if (p.wrong >= MAX_WRONG_CODES) {
        p.status = 'denied'
        this.deps.onChanged()
        throw new Error(t('agentAccess.error.codeDenied', { count: MAX_WRONG_CODES }))
      }
      throw new Error(t('agentAccess.error.codeWrong', { count: MAX_WRONG_CODES - p.wrong }))
    }
    p.status = 'approved'
    p.authCode = this.records.issueCode({ clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, level })
    this.deps.onChanged()
    return this.info()
  }

  deny(id: string): AgentAccessInfo {
    this.waitingOne(id).status = 'denied'
    this.deps.onChanged()
    return this.info()
  }

  /** Ends a sign-in: its record, its vault entry and its access tokens, at once. */
  revoke(grantId: string): AgentAccessInfo {
    if (this.records.revokeGrant(grantId)) this.deps.onChanged()
    return this.info()
  }

  // ---- the listener ----

  private async listen(port: number): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch((err: unknown) => this.fail(res, err)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const bound = server.address()
    this.boundPort = bound && typeof bound === 'object' ? bound.port : port
    this.server = server
  }

  private async closeListener(): Promise<void> {
    const server = this.server
    this.server = null
    for (const [id, p] of this.pending) if (p.status === 'waiting') this.pending.delete(id)
    this.records.forgetLive()
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    // A long call (wait_for_turn) would otherwise hold the close until it answers.
    server.closeAllConnections()
    await closed
  }

  /** Another program, or another user of this computer, may hold the port: the setting goes off, and says why. */
  private cannotListen(err: unknown): void {
    const port = this.deps.port ?? this.settings.agentAccessPort
    const t = mainT(this.settings)
    const why = (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? t('agentAccess.error.portInUse') : err instanceof Error ? err.message : String(err)
    this.error = t('agentAccess.error.listen', { address: `127.0.0.1:${port}`, why })
    console.error('Agents on this computer:', err)
    this.settings.agentAccessEnabled = false
    this.deps.store.save()
    this.deps.onChanged()
  }

  // ---- pending sign-ins ----

  private sweep(): void {
    const now = this.now()
    for (const [id, p] of this.pending) if (p.expiresAt + KEEP_ENDED_MS <= now) this.pending.delete(id)
  }

  private waiting(): Pending[] {
    const now = this.now()
    return [...this.pending.values()].filter((p) => p.status === 'waiting' && p.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt)
  }

  private waitingOne(id: string): Pending {
    const p = this.pending.get(id)
    if (!p || p.status !== 'waiting' || p.expiresAt <= this.now()) throw new Error(mainT(this.settings)('agentAccess.error.expired'))
    return p
  }

  /** The clients with a sign-in in progress, which a registration never prunes. */
  private busyClients(): Set<string> {
    return new Set([...this.pending.values()].map((p) => p.clientId))
  }

  // ---- requests ----

  private headers(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    if (res.headersSent) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  private html(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  private fail(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err instanceof OAuthError) return this.json(res, err.status, { error: err.error, error_description: err.message })
    if (err instanceof HttpError) {
      // The rest of a body too large to read isn't read: the connection can't be used again.
      if (err.status === 413) res.setHeader('Connection', 'close')
      return this.json(res, err.status, { error: err.message })
    }
    console.error('Agents on this computer:', err)
    this.json(res, 500, { error: 'Foreman could not complete that request.' })
  }

  /** Guards on every request: the Host is exactly this origin's (never `localhost` or a rebound name), and an Origin, if sent, is too. No CORS. */
  private guard(req: IncomingMessage): void {
    if (req.headers.host !== `127.0.0.1:${this.boundPort}`) throw new HttpError(403, `Use http://127.0.0.1:${this.boundPort}.`)
    if (req.headers.origin !== undefined && req.headers.origin !== this.origin) throw new HttpError(403, 'Wrong origin.')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.headers(res)
    this.guard(req)
    const url = new URL(req.url ?? '/', this.origin)
    const route = url.pathname
    if (route === '/mcp') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        throw new HttpError(405, 'This endpoint takes POST only: there is no event stream and no session to end.')
      }
      return this.mcp(req, res)
    }
    if (req.method === 'GET') {
      if (route === '/.well-known/oauth-protected-resource' || route === '/.well-known/oauth-protected-resource/mcp') return this.json(res, 200, this.resourceMetadata())
      if (route === '/.well-known/oauth-authorization-server') return this.json(res, 200, this.serverMetadata())
      if (route === '/oauth/authorize') return this.authorize(url, res)
      if (route === '/oauth/authorize/status') return this.status(url, res)
      if (route === '/oauth/page.js') return this.file(res, PAGE_JS, 'text/javascript; charset=utf-8')
      if (route === '/oauth/style.css') return this.file(res, PAGE_CSS, 'text/css; charset=utf-8')
    }
    if (req.method === 'POST') {
      if (route === '/oauth/register') return this.register(req, res)
      if (route === '/oauth/token') return this.token(req, res)
      if (route === '/oauth/revoke') return this.revokeRoute(req, res)
    }
    throw new HttpError(404, 'Not found.')
  }

  private file(res: ServerResponse, text: string, type: string): void {
    res.writeHead(200, { 'Content-Type': type })
    res.end(text)
  }

  /** RFC 9728: the resource is this origin's /mcp, and this origin is its authorization server. */
  private resourceMetadata(): OAuthProtectedResourceMetadata {
    return { resource: this.resource, authorization_servers: [this.origin], scopes_supported: [...AGENT_ACCESS_LEVELS], bearer_methods_supported: ['header'], resource_name: 'Foreman' }
  }

  /** RFC 8414: `code` only, PKCE S256 only, public clients only; the scopes are the levels the person chooses from. */
  private serverMetadata(): OAuthMetadata {
    const o = this.origin
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...AGENT_ACCESS_LEVELS],
      authorization_response_iss_parameter_supported: true
    }
  }

  /** `POST /mcp`: a missing, bad, expired or revoked token is 401 with where to sign in. */
  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const grant = token ? this.records.authenticate(token) : null
    if (!grant) {
      const error = token ? ', error="invalid_token"' : ''
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"${error}`)
      return this.json(res, 401, { error: token ? 'invalid_token' : 'unauthorized', error_description: 'Sign in to Foreman first.' })
    }
    const handler = this.mcpHandler
    if (!handler) return this.json(res, 503, { error: 'Foreman’s tools aren’t available to agents on this computer yet.' })
    const raw = await readBody(req, MAX_MCP_BODY)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return this.json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
    }
    await handler(req, res, grant, body)
  }

  private page(res: ServerResponse, status: number, key: PlainKey): void {
    const t = mainT(this.settings)
    this.html(res, status, errorPage(mainLocale(this.settings), t, t(key)))
  }

  /**
   * `GET /oauth/authorize`. A bad client or redirect shows an error page and never redirects; any other bad parameter
   * goes back to the client with the OAuth error. A good one waits five minutes for the person to type its code.
   */
  private authorize(url: URL, res: ServerResponse): void {
    const params = single(url.searchParams)
    const clientId = params.get('client_id')
    const client = clientId && !params.repeated.has('client_id') ? this.records.client(clientId) : undefined
    if (!client) return this.page(res, 400, clientId ? 'agentAccess.error.client' : 'agentAccess.error.request')
    const redirectUri = params.get('redirect_uri')
    if (!redirectUri || params.repeated.has('redirect_uri') || !redirectMatches(client.redirectUris, redirectUri)) return this.page(res, 400, 'agentAccess.error.redirect')
    const state = params.get('state')
    const back = (error: string, description: string) => this.redirect(res, withParams(redirectUri, { error, error_description: description, state, iss: this.origin }))
    if (params.repeated.size) return back('invalid_request', `Sent more than once: ${[...params.repeated].join(', ')}.`)
    if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.')
    const challenge = params.get('code_challenge')
    if (params.get('code_challenge_method') !== 'S256' || !challenge || !validChallenge(challenge)) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
    const resource = params.get('resource')
    if (resource !== undefined && resource !== this.resource) return back('invalid_target', `The resource is ${this.resource}.`)
    this.sweep()
    // Never by dropping one that waits.
    if (this.waiting().length >= MAX_PENDING) return this.page(res, 429, 'agentAccess.error.busy')
    const p: Pending = {
      id: randomUUID(), pageKey: randomToken(), clientId: client.id, name: client.name, redirectUri, challenge, state,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: this.now() + PENDING_MS, wrong: 0, status: 'waiting'
    }
    this.pending.set(p.id, p)
    this.records.touch(client)
    // Its expiry changes the list too.
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.deps.onChanged()
    }, PENDING_MS)
    timer.unref()
    this.timers.add(timer)
    this.deps.onChanged()
    const t = mainT(this.settings)
    this.html(res, 200, waitingPage(mainLocale(this.settings), t, { name: p.name, code: p.code, statusUrl: `/oauth/authorize/status?id=${encodeURIComponent(p.pageKey)}` }))
  }

  /** The waiting page's poll: still waiting, or where to go now (the code once approved; access_denied once denied or expired). */
  private status(url: URL, res: ServerResponse): void {
    const key = url.searchParams.get('id') ?? ''
    const p = [...this.pending.values()].find((x) => same(x.pageKey, key))
    if (!p) return this.json(res, 200, { state: 'gone' })
    if (p.status === 'approved' && p.authCode) {
      this.pending.delete(p.id)
      return this.json(res, 200, { state: 'approved', location: withParams(p.redirectUri, { code: p.authCode, state: p.state, iss: this.origin }) })
    }
    if (p.status === 'denied' || p.expiresAt <= this.now()) {
      this.pending.delete(p.id)
      return this.json(res, 200, { state: 'denied', location: withParams(p.redirectUri, { error: 'access_denied', state: p.state, iss: this.origin }) })
    }
    this.json(res, 200, { state: 'waiting' })
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location })
    res.end()
  }

  /** RFC 7591, public clients only, every redirect `http` on a loopback host. The answer is a random client_id and no secret. */
  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'))
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new OAuthError(400, 'invalid_client_metadata', 'Send the client metadata as JSON.')
    }
    const parsed = OAuthClientMetadataSchema.safeParse(raw)
    if (!parsed.success) throw new OAuthError(400, 'invalid_client_metadata', 'The client metadata isn’t valid.')
    const uris = [...new Set(parsed.data.redirect_uris)]
    if (!uris.length || uris.length > MAX_REDIRECTS || uris.some((uri) => uri.length > MAX_URI || !loopbackRedirect(uri))) {
      throw new OAuthError(400, 'invalid_redirect_uri', 'Each redirect must be http on 127.0.0.1, [::1] or localhost: nothing remote can reach this server.')
    }
    const client = this.records.register(cleanName(parsed.data.client_name), uris, this.busyClients())
    // Whatever it asked for, it is a public client using codes and refresh tokens (RFC 7591 §3.2.1: the answer says so).
    this.json(res, 201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  }

  private async form(req: IncomingMessage): Promise<ReturnType<typeof single>> {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/x-www-form-urlencoded') throw new OAuthError(400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded.')
    const form = single(new URLSearchParams((await readBody(req, MAX_BODY)).toString('utf8')))
    if (form.repeated.size) throw new OAuthError(400, 'invalid_request', `Sent more than once: ${[...form.repeated].join(', ')}.`)
    return form
  }

  /** Codes and refresh tokens for tokens. */
  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.form(req)
    const clientId = form.get('client_id')
    if (!clientId || !this.records.client(clientId)) throw new OAuthError(401, 'invalid_client', 'Foreman doesn’t know this client. Register again.')
    const resource = form.get('resource')
    if (resource !== undefined && resource !== this.resource) throw new OAuthError(400, 'invalid_target', `The resource is ${this.resource}.`)
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') {
      const code = form.get('code'), redirectUri = form.get('redirect_uri'), verifier = form.get('code_verifier')
      if (!code || !redirectUri || !verifier) throw new OAuthError(400, 'invalid_request', 'Send code, redirect_uri and code_verifier.')
      return this.json(res, 200, this.records.exchangeCode(code, clientId, redirectUri, verifier))
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token')
      if (!refreshToken) throw new OAuthError(400, 'invalid_request', 'Send refresh_token.')
      return this.json(res, 200, this.records.refresh(refreshToken, clientId))
    }
    throw new OAuthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.')
  }

  /** RFC 7009: the answer is 200 whether or not the token was known. */
  private async revokeRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.form(req)
    const token = form.get('token')
    if (!token) throw new OAuthError(400, 'invalid_request', 'Send token.')
    if (this.records.revokeToken(token, form.get('client_id'))) this.deps.onChanged()
    res.writeHead(200)
    res.end()
  }
}
