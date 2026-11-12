// A narrow HTTP surface for a paired phone. Private HTTPS is proxied from the
// loopback listener; nearby phones can opt into a separate LAN listener.
// Every route that reaches the core goes through the dispatcher with the device's session, so the access chosen at
// pairing applies; `/api/ws` on either listener upgrades to the socket in api/socket.ts (docs/server.md).
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import webpush from 'web-push'
import { WebSocketServer } from 'ws'
import { capabilitiesFor, interruptsToSteer, type AgentCapabilities } from '../shared/agentCapabilities'
import { staticCapabilitiesView } from '../shared/agentCatalog'
import { ApiRefused } from '../shared/api'
import { triageAll } from '../shared/triage'
import { phoneRecent, prGlyph } from '../shared/attention'
import { isGitlabWorkspace } from '../shared/scm'
import { ACCESS_SCOPES, deviceSession, MOBILE_ACCESS, type MobileAccess, type MobileDevice, type MobileInfo } from '../shared/mobile'
import type { Api, AppSnapshot, ApprovalRequest, ApprovalResponse, CheckConsentItem, DiffSelection, MainEvent } from '../shared/types'
import type { ApiDispatcher } from './api/dispatch'
import { ApiSocketServer, MAX_INBOUND_BYTES, type ApiSocketDeps } from './api/socket'
import { continueOptions } from '../shared/limits'
import { mainT } from './i18n'
import { lanAddresses, onSameLan } from './lan'
import type { Store } from './store'
import type { SecretStore } from './secrets'

export const MOBILE_PORT = 47632
export const MOBILE_LAN_PORT = 47633
const STALL_MS = 15 * 60_000
const PAIR_MS = 2 * 60_000
const MAX_BODY = 64 * 1024

// What the built renderer's assets folder holds.
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json'
}

// /app for a browser that isn't signed in. It says how, and nothing about this computer or its work.
const SIGN_IN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Foreman</title>
<link rel="stylesheet" href="/style.css"></head>
<body><div class="pair"><div class="logo">F</div><h1>Sign this browser in</h1>
<p>Foreman opens in a browser once the computer it runs on approves it.</p>
<div class="steps"><div><b>1</b>In a terminal on that computer, run <code>foreman phone link --browser</code>.</div>
<div><b>2</b>Open the link it prints in this browser. It works once, for two minutes.</div>
<div><b>3</b>Approve the code this browser shows: in Foreman’s phone dialog, or with <code>foreman phone approve</code> and the code.</div></div></div></body></html>
`

type Mode = 'private' | 'lan'
type Kind = 'phone' | 'browser'
type Pending = { id: string; name: string; kind: Kind; code: string; mode: Mode; expiresAt: number; state: 'waiting' | 'approved' | 'denied'; deviceId?: string; auth?: string }
type Pairing = { mode: Mode; token: string; expiresAt: number; url: string; qr: string }
type MobileDeps = {
  store: Store
  secrets: SecretStore
  // Every call a phone makes goes through the dispatcher with the device's session, so its scopes apply.
  dispatcher: ApiDispatcher
  snapshot(): AppSnapshot
  approvals(): ApprovalRequest[]
  consentNeeded(workspaceId: string): CheckConsentItem[]
  appPath: string
  /** The built renderer a browser loads at /app; `<appPath>/out/renderer` unless a test says otherwise. */
  rendererPath?: string
  onChanged(): void
  onEnabledChange(on: boolean): void
} & Pick<ApiSocketDeps, 'onEvent' | 'version' | 'platform' | 'name' | 'setTimer'>

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const token = () => randomBytes(32).toString('base64url')
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class MobileService {
  private privateServer: Server | null = null
  private lanServer: Server | null = null
  private pairing: Pairing | null = null
  private pending = new Map<string, Pending>()
  private stalled = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private vapid: { publicKey: string; privateKey: string } | null = null
  private boundPort = MOBILE_PORT
  private boundLanPort = MOBILE_LAN_PORT
  // /api/ws on both listeners: the upgrade is checked here, then the socket server owns the connection.
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES })
  private sockets: ApiSocketServer

  constructor(private deps: MobileDeps, private port = MOBILE_PORT, private lanPort = MOBILE_LAN_PORT, private getLanAddresses = lanAddresses) {
    this.deps.store.state.mobileDevices ??= []
    this.sockets = new ApiSocketServer(deps)
  }

  /** Live sockets, for the tests. */
  get connections(): number {
    return this.sockets.connections
  }

  async start(): Promise<void> {
    const settings = this.deps.store.state.settings
    if (settings.mobileEnabled) {
      try { await this.listenPrivate() } catch (err) { console.error('Private mobile access:', err); settings.mobileEnabled = false }
    }
    if (settings.mobileLanEnabled) {
      try { await this.listenLan(settings.mobileLanAddress) } catch (err) { console.error('Same-Wi-Fi mobile access:', err); settings.mobileLanEnabled = false }
    }
    this.deps.store.save()
    this.deps.onEnabledChange(settings.mobileEnabled || settings.mobileLanEnabled)
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.pairing = null
    this.pending.clear()
    this.sockets.close('shutdown')
    await Promise.all([this.closePrivate(), this.closeLan()])
  }

  private async closeServer(server: Server | null): Promise<void> {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  }

  /** Says `bye` to the sockets of a transport's devices; a listener's close() would otherwise wait for them. */
  private closeSockets(mode: Mode, reason: 'revoked' | 'off'): void {
    for (const d of this.deps.store.state.mobileDevices ?? []) if ((d.transport ?? 'private') === mode) this.sockets.closeSession(d.id, reason)
  }

  private async closePrivate(): Promise<void> {
    const server = this.privateServer
    this.privateServer = null
    this.closeSockets('private', 'off')
    await this.closeServer(server)
    this.stopTimerWhenIdle()
  }

  private async closeLan(): Promise<void> {
    const server = this.lanServer
    this.lanServer = null
    this.closeSockets('lan', 'off')
    await this.closeServer(server)
    this.stopTimerWhenIdle()
  }

  private stopTimerWhenIdle(): void {
    if (this.privateServer || this.lanServer || !this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private cancelWaiting(mode: Mode): void {
    if (this.pairing?.mode === mode) this.pairing = null
    for (const [id, pending] of this.pending) if (pending.mode === mode && pending.state === 'waiting') this.pending.delete(id)
  }

  private async listen(mode: Mode, address: string, port: number): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => void this.handle(req, res, mode).catch((err: unknown) => {
      // A call the device's scopes don't allow, or one only the computer's own window can make: 403 with the reason.
      if (err instanceof ApiRefused) return this.json(res, 403, { error: err.message, code: err.code })
      const status = err instanceof HttpError ? err.status : 500
      this.json(res, status, { error: status === 500 ? 'Foreman could not complete that request.' : (err as Error).message })
    }))
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head, mode))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, address, () => { server.off('error', reject); resolve() })
    })
    const bound = server.address()
    if (!this.timer) {
      this.timer = setInterval(() => this.checkStalls(), 60_000)
      this.timer.unref()
    }
    return { server, port: bound && typeof bound === 'object' ? bound.port : port }
  }

  private async listenPrivate(): Promise<void> {
    if (this.privateServer) return
    const bound = await this.listen('private', '127.0.0.1', this.port)
    this.privateServer = bound.server
    this.boundPort = bound.port
  }

  private async listenLan(address: string): Promise<void> {
    if (this.lanServer) return
    if (!this.getLanAddresses().some((candidate) => candidate.address === address)) throw new Error('That local network address is no longer available. Choose a current address.')
    const bound = await this.listen('lan', address, this.lanPort)
    this.lanServer = bound.server
    this.boundLanPort = bound.port
  }

  async configure(enabled: boolean, url: string): Promise<MobileInfo> {
    let clean = url.trim().replace(/\/$/, '')
    if (enabled) {
      let parsed: URL
      try { parsed = new URL(clean) } catch { throw new Error('Enter the private HTTPS address Tailscale Serve gives this computer.') }
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || !parsed.hostname) {
        throw new Error('Use an HTTPS address without a path, query, or fragment.')
      }
      clean = parsed.origin
      await this.listenPrivate()
    } else { await this.closePrivate(); this.cancelWaiting('private') }
    this.deps.store.state.settings.mobileEnabled = enabled
    this.deps.store.state.settings.mobileUrl = clean
    this.deps.store.save()
    this.deps.onEnabledChange(enabled || this.deps.store.state.settings.mobileLanEnabled)
    return this.info()
  }

  async configureLan(enabled: boolean, address: string): Promise<MobileInfo> {
    const selected = this.getLanAddresses().find((candidate) => candidate.address === address)
    if (enabled && !selected) throw new Error('Choose a current private network address for this computer.')
    if (enabled && (!this.lanServer || address !== this.deps.store.state.settings.mobileLanAddress)) {
      const old = this.lanServer
      const bound = await this.listen('lan', address, this.lanPort)
      this.lanServer = bound.server
      this.boundLanPort = bound.port
      // The old address's sockets go with its listener; their origin no longer matches anyway.
      if (old) this.closeSockets('lan', 'off')
      await this.closeServer(old)
    } else if (!enabled) { await this.closeLan(); this.cancelWaiting('lan') }
    this.deps.store.state.settings.mobileLanEnabled = enabled
    this.deps.store.state.settings.mobileLanAddress = address
    this.deps.store.save()
    this.deps.onEnabledChange(enabled || this.deps.store.state.settings.mobileEnabled)
    return this.info()
  }

  info(): MobileInfo {
    const settings = this.deps.store.state.settings
    if (this.pairing && this.pairing.expiresAt <= Date.now()) this.pairing = null
    for (const [id, p] of this.pending) if (p.expiresAt <= Date.now()) this.pending.delete(id)
    const pending = [...this.pending.values()].find((p) => p.state === 'waiting')
    return {
      enabled: settings.mobileEnabled,
      url: settings.mobileUrl,
      port: this.boundPort,
      lan: {
        enabled: settings.mobileLanEnabled && Boolean(this.lanServer),
        address: settings.mobileLanAddress,
        port: this.boundLanPort,
        candidates: this.getLanAddresses().map(({ name, address }) => ({ name, address }))
      },
      devices: (this.deps.store.state.mobileDevices ?? []).map(({ push: _push, ...d }) => d),
      pairing: this.pairing ? { mode: this.pairing.mode, url: this.pairing.url, qr: this.pairing.qr, expiresAt: this.pairing.expiresAt } : undefined,
      pending: pending ? { id: pending.id, name: pending.name, kind: pending.kind, code: pending.code, mode: pending.mode, expiresAt: pending.expiresAt } : undefined
    }
  }

  async startPairing(mode: Mode = 'private'): Promise<MobileInfo> {
    if (mode === 'private' && (!this.privateServer || !this.deps.store.state.settings.mobileEnabled)) throw new Error('Turn on private mobile access first.')
    if (mode === 'lan' && (!this.lanServer || !this.deps.store.state.settings.mobileLanEnabled)) throw new Error('Turn on same-Wi-Fi access first.')
    const secret = token()
    const origin = mode === 'private' ? this.deps.store.state.settings.mobileUrl : `http://${this.deps.store.state.settings.mobileLanAddress}:${this.boundLanPort}`
    const url = `${origin}/?pair=${secret}`
    this.pairing = { mode, token: secret, url, qr: await QRCode.toDataURL(url, { margin: 2, width: 220 }), expiresAt: Date.now() + PAIR_MS }
    return this.info()
  }

  /** The person at the desktop approves (choosing what the device may do, Operate by default) or denies a pairing. */
  approve(id: string, allow: boolean, access: MobileAccess = 'operate'): MobileInfo {
    if (!MOBILE_ACCESS.includes(access)) throw new Error('Choose what this device may do.')
    const p = this.pending.get(id)
    if (!p || p.state !== 'waiting' || p.expiresAt <= Date.now()) throw new Error('That pairing request expired.')
    if (allow) {
      p.deviceId = randomUUID()
      p.auth = token()
      this.deps.secrets.setAppSecret(`mobile:${p.deviceId}`, p.auth)
      this.deps.store.state.mobileDevices!.push({ id: p.deviceId, name: p.name, kind: p.kind, scopes: [...ACCESS_SCOPES[access]], pairedAt: new Date().toISOString(), transport: p.mode })
      this.deps.store.save()
      p.state = 'approved'
    } else p.state = 'denied'
    this.deps.onChanged()
    return this.info()
  }

  revoke(id: string): MobileInfo {
    this.deps.store.state.mobileDevices = (this.deps.store.state.mobileDevices ?? []).filter((d) => d.id !== id)
    this.deps.secrets.setAppSecret(`mobile:${id}`, null)
    this.deps.store.save()
    // Its open sockets end now, not at their next request: the credential they signed in with is gone.
    this.sockets.closeSession(id, 'revoked')
    return this.info()
  }

  /** Existing main-process notices become generic lock-screen notifications. */
  notify(event: Extract<MainEvent, { type: 'notify' }>): void {
    if ((!this.privateServer && !this.lanServer) || event.kind === 'stopped' || event.body === 'Stopped') return
    // O13b: the text is in the user's language, so `kind` says what it is; English words for a notice without one.
    const needsYou = event.kind ? event.kind === 'attention' : /permission|question|plan ready|failed|error|interrupted|sign-in|comments|conflicts/i.test(event.body)
    if (!needsYou) return
    const t = mainT(this.deps.store.state.settings)
    void this.push(t('mobile.push.title'), t('mobile.push.needsYou'))
  }

  private checkStalls(): void {
    const snapshot = this.deps.snapshot()
    const waiting = new Set(this.deps.approvals().map((a) => a.sessionId))
    const current = new Set<string>()
    for (const s of snapshot.sessions) {
      if (s.status !== 'running' || !s.turnId || waiting.has(s.id)) continue
      current.add(s.turnId)
      if (this.isStalled(s, waiting) && !this.stalled.has(s.turnId)) {
        this.stalled.add(s.turnId)
        const t = mainT(this.deps.store.state.settings)
        void this.push(t('mobile.push.title'), t('mobile.push.stalled'))
      }
    }
    for (const id of this.stalled) if (!current.has(id)) this.stalled.delete(id)
  }

  private isStalled(s: AppSnapshot['sessions'][number], waiting: Set<string>): boolean {
    return s.status === 'running' && !waiting.has(s.id) &&
      Date.now() - new Date(s.lastActivityAt ?? s.turnStartedAt ?? new Date().toISOString()).getTime() >= STALL_MS
  }

  private getVapid(): { publicKey: string; privateKey: string } {
    if (this.vapid) return this.vapid
    const saved = this.deps.secrets.appSecret('mobile:vapid')
    this.vapid = saved ? JSON.parse(saved) as { publicKey: string; privateKey: string } : webpush.generateVAPIDKeys()
    if (!saved) this.deps.secrets.setAppSecret('mobile:vapid', JSON.stringify(this.vapid))
    webpush.setVapidDetails('mailto:mobile@foreman.app', this.vapid!.publicKey, this.vapid!.privateKey)
    return this.vapid!
  }

  private async push(title: string, body: string): Promise<void> {
    const devices = this.deps.store.state.mobileDevices ?? []
    if (!devices.some((d) => d.push)) return
    this.getVapid()
    await Promise.all(devices.filter((d) => d.push).map(async (d) => {
      try {
        await webpush.sendNotification(d.push!, JSON.stringify({ title, body, url: '/' }), { TTL: 300 })
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) { delete d.push; this.deps.store.save() }
      }
    }))
  }

  private headers(res: ServerResponse, mode?: Mode): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    // Current browsers let 'self' cover the page's own ws: and wss: origin; older WebKit needs the socket's origin named.
    const socket = mode ? ` ${this.socketOrigin(mode)}` : ''
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${socket}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'`)
  }
  /** Where the page opens /api/ws: the private HTTPS address as wss:, or the same-Wi-Fi listener as ws:. */
  private socketOrigin(mode: Mode): string {
    const settings = this.deps.store.state.settings
    return mode === 'private' ? settings.mobileUrl.replace(/^https:/, 'wss:') : `ws://${settings.mobileLanAddress}:${this.boundLanPort}`
  }
  private json(res: ServerResponse, status: number, value: unknown): void {
    if (res.headersSent) return
    this.headers(res)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw new HttpError(413, 'Request is too large.')
      chunks.push(chunk)
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch { throw new HttpError(400, 'Invalid request.') }
  }
  /**
   * The paired device a request comes from, by its cookie. A socket upgrade with no cookie may instead carry the same
   * `<id>.<secret>` as `Authorization: Bearer`, for a client that is not a browser.
   */
  private auth(req: IncomingMessage, mode: Mode, bearer = false): MobileDevice | null {
    const cookie = /(?:^|;\s*)foreman_mobile=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const presented = cookie ?? (bearer ? /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1] : undefined)
    const [id, credential] = presented?.split('.') ?? []
    if (!id || !credential) return null
    const device = (this.deps.store.state.mobileDevices ?? []).find((d) => d.id === id)
    const secret = device && this.deps.secrets.appSecret(`mobile:${id}`)
    if (!device || (device.transport ?? 'private') !== mode || !secret || !same(credential, secret)) return null
    if (!device.lastSeen || Date.now() - new Date(device.lastSeen).getTime() > 60_000) {
      device.lastSeen = new Date().toISOString()
      this.deps.store.save()
    }
    return device
  }
  private requireOrigin(req: IncomingMessage, mode: Mode): void {
    if (req.method === 'POST') this.checkOrigin(req, mode)
  }
  /** The page's own origin, or nothing: what a POST and a socket upgrade must both show. */
  private checkOrigin(req: IncomingMessage, mode: Mode): void {
    const origin = req.headers.origin
    const expected = mode === 'private' ? this.deps.store.state.settings.mobileUrl : `http://${this.deps.store.state.settings.mobileLanAddress}:${this.boundLanPort}`
    if (!origin || origin !== expected) throw new HttpError(403, 'Wrong origin.')
  }
  private async staticFile(res: ServerResponse, name: string, mime: string, mode: Mode): Promise<void> {
    const file = path.join(this.deps.appPath, 'resources', 'mobile', name)
    const data = await readFile(file)
    this.headers(res, mode)
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
  }

  private get rendererPath(): string {
    return this.deps.rendererPath ?? path.join(this.deps.appPath, 'out', 'renderer')
  }

  /**
   * `/app`: the real renderer for a signed-in browser (docs/server.md, "A browser"). The built page carries a CSP meta
   * tag for Electron (`ws://localhost:*`, `foreman-preview:`); a browser applies both a meta tag and a header, and the
   * stricter wins, so the tag goes and one header says what this page may do here: its own scripts, and the socket.
   */
  private async app(res: ServerResponse, mode: Mode): Promise<void> {
    const html = (await readFile(path.join(this.rendererPath, 'index.html'), 'utf8')).replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
    this.headers(res, mode)
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${this.socketOrigin(mode)}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  /** `/assets/<name>`: the renderer's hashed scripts, styles and fonts. One name, no folders, so nothing outside is reachable. */
  private async asset(res: ServerResponse, name: string, mode: Mode): Promise<void> {
    const type = ASSET_TYPES[path.extname(name).toLowerCase()]
    if (!/^[\w.@-]+$/.test(name) || name.startsWith('.') || !type) throw new HttpError(404, 'Not found.')
    let data: Buffer
    try { data = await readFile(path.join(this.rendererPath, 'assets', name)) } catch { throw new HttpError(404, 'Not found.') }
    this.headers(res, mode)
    // The names carry a hash of their contents, so a browser may keep them.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.writeHead(200, { 'Content-Type': type })
    res.end(data)
  }

  /** `/app` for a browser that isn't signed in: how to sign in, and nothing else (English, as the phone page is). */
  private signIn(res: ServerResponse, mode: Mode): void {
    this.headers(res, mode)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(SIGN_IN_PAGE)
  }

  private redirect(res: ServerResponse, location: string): void {
    this.headers(res)
    res.writeHead(302, { Location: location })
    res.end()
  }

  private state() {
    const snapshot = this.deps.snapshot()
    const approvals = this.deps.approvals()
    const waiting = new Set(approvals.map((a) => a.sessionId))
    const rows = triageAll({ snapshot, approvals, unread: {}, unreadSessions: {} }, null)
    // docs/agents.md 2.3: what each agent in use can do, from the same record the window reads (canSteer follows from it).
    const capabilities = snapshot.agentCapabilities ?? staticCapabilitiesView()
    const open = snapshot.sessions.filter((s) => !s.closedAt)
    const agentCapabilities: Record<string, AgentCapabilities> = {}
    for (const s of open) {
      const record = capabilitiesFor(capabilities, s.agent)
      if (record) agentCapabilities[s.agent] = record
    }
    const shown = new Set(rows.map((t) => t.ws.id))
    return {
      repos: snapshot.repos.map((r) => ({ id: r.id, name: r.name })),
      workspaces: rows.map((t) => {
        const stalledSession = snapshot.sessions.find((s) => s.workspaceId === t.ws.id && this.isStalled(s, waiting))
        const stalled = Boolean(stalledSession)
        const stalledSince = stalledSession?.lastActivityAt ?? stalledSession?.turnStartedAt
        return { id: t.ws.id, repoId: t.ws.repoId, name: t.ws.name, branch: t.ws.branch, state: t.ws.state, bucket: stalled && t.bucket === 'working' ? 'attention' : t.bucket, label: stalled && t.bucket === 'working' ? 'Possible stall' : t.label, detail: stalled && t.bucket === 'working' ? `${stalledSession!.agent} · no activity for ${Math.floor((Date.now() - new Date(stalledSince!).getTime()) / 60_000)} min` : t.detail, sessionId: stalledSession?.id ?? t.sessionId, facts: t.facts, stalled, stalledSince, since: t.since, pr: this.prGlyph(t.ws, snapshot), checks: t.ws.checks ? { running: t.ws.checks.running, stale: t.ws.checks.stale, results: t.ws.checks.results.map((r) => ({ name: r.name, status: r.status })) } : null }
      }),
      agentCapabilities,
      // #127: whether a running turn takes a message now (steering), what waits in the queue, and how full the context is.
      sessions: open.map((s) => ({ id: s.id, workspaceId: s.workspaceId, title: s.title, agent: s.agent, model: s.model, status: s.status, waitingForSlot: s.waitingForSlot, turnStartedAt: s.turnStartedAt, lastActivityAt: s.lastActivityAt, lastTurn: s.lastTurn, queued: s.queue.length, queue: s.queue.map((q) => ({ id: q.id, text: q.text })), canSteer: capabilitiesFor(capabilities, s.agent, s.instanceId)?.turns.steer.level === 'native', canInterrupt: interruptsToSteer(capabilitiesFor(capabilities, s.agent, s.instanceId)), context: s.contextUsage ? { used: s.contextUsage.used, limit: s.contextUsage.limit } : null, limitResume: s.limitResume, ...(s.lastTurn?.outcome === 'limit' && !s.limitHeld ? { continueOn: continueOptions(s, snapshot.settings, snapshot.limits, Date.now(), 'Default') } : {}) })),
      // Docs/agents.md 7.1: what each account reported about its usage windows, as the window has it.
      limits: snapshot.limits ?? [],
      approvals,
      templates: snapshot.settings.promptTemplates.map((t) => ({ id: t.id, name: t.name, body: t.body })),
      // The window's "Follow-up behavior" setting: what a message sent during a turn does unless the phone says otherwise.
      followUpMode: snapshot.settings.followUpMode,
      // #127: the diff comments that still do something: yours waiting for your next message, and the agent's still open.
      comments: (snapshot.comments ?? []).filter((c) => (c.author === 'user' ? c.state === 'pending' : c.state === 'open') && shown.has(c.workspaceId))
        .map((c) => ({ id: c.id, workspaceId: c.workspaceId, file: c.file, line: c.line, side: c.selection?.side ?? 'new', body: c.body, author: c.author, authorLabel: c.authorLabel, state: c.state }))
    }
  }

  /** G2: the row's PR glyph as the window shows it (open, draft, merged, CI failing), worded for GitLab when it is. */
  private prGlyph(ws: AppSnapshot['workspaces'][number], snapshot: AppSnapshot) {
    const glyph = prGlyph(ws)
    if (!glyph) return null
    const repo = snapshot.repos.find((r) => r.id === ws.repoId)
    return { ...glyph, provider: isGitlabWorkspace(ws, repo, snapshot.settings?.gitlabHosts ?? []) ? 'gitlab' : glyph.provider }
  }

  /** Same Wi-Fi only: the request names the selected address and comes from its network. */
  private guardLan(req: IncomingMessage, mode: Mode): void {
    if (mode !== 'lan') return
    const host = this.getLanAddresses().find((candidate) => candidate.address === this.deps.store.state.settings.mobileLanAddress)
    if (!host || req.headers.host !== `${host.address}:${this.boundLanPort}` || !onSameLan(req.socket.remoteAddress ?? '', host)) {
      throw new HttpError(403, 'This connection must come from the selected local network.')
    }
  }

  /**
   * `GET /api/ws`: the same guards as a POST (the network, the origin, which a browser always sends on an upgrade, and the
   * device's credential), then the socket server takes it with the device's session. A refusal is a plain HTTP answer.
   */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: Mode): void {
    socket.on('error', () => undefined)
    let device: MobileDevice | null
    try {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/ws') throw new HttpError(404, 'Not found.')
      this.guardLan(req, mode)
      this.checkOrigin(req, mode)
      device = this.auth(req, mode, true)
      if (!device) throw new HttpError(401, 'This device is not paired.')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const body = JSON.stringify({ error: err instanceof HttpError ? err.message : 'Foreman could not complete that request.' })
      socket.once('finish', () => socket.destroy())
      const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`, 'Connection: close', 'Cache-Control: no-store', 'Content-Type: application/json; charset=utf-8', `Content-Length: ${Buffer.byteLength(body)}`]
      socket.end(`${head.join('\r\n')}\r\n\r\n${body}`)
      return
    }
    const session = deviceSession(device)
    this.wss.handleUpgrade(req, socket, head, (ws) => this.sockets.attach(ws, session))
  }

  /** A call from a paired device, under its session: the dispatcher refuses what its scopes don't allow. */
  private call<K extends keyof Api>(device: MobileDevice, method: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
    return this.deps.dispatcher.invoke(deviceSession(device), method, args) as Promise<Awaited<ReturnType<Api[K]>>>
  }

  private async handle(req: IncomingMessage, res: ServerResponse, mode: Mode): Promise<void> {
    this.guardLan(req, mode)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/') {
      // After pairing, the page goes on to the full app (a browser signing in) or stays here: no other `then` is kept.
      const then = url.searchParams.get('then')
      if (then !== null && then !== '/app') {
        url.searchParams.delete('then')
        return this.redirect(res, `/${url.search}`)
      }
      return this.staticFile(res, 'index.html', 'text/html; charset=utf-8', mode)
    }
    // The full app for a browser (docs/server.md, "A browser"): signed in, it loads; with a pairing link, the phone page
    // pairs it as a browser and comes back; otherwise it says how to sign in.
    if (req.method === 'GET' && pathname === '/app/') return this.redirect(res, `/app${url.search}`)
    if (req.method === 'GET' && pathname === '/app') {
      if (this.auth(req, mode)) return this.app(res, mode)
      const pair = url.searchParams.get('pair')
      if (pair) return this.redirect(res, `/?pair=${encodeURIComponent(pair)}&then=/app`)
      return this.signIn(res, mode)
    }
    if (pathname.startsWith('/app/')) throw new HttpError(404, 'Not found.')
    const asset = /^\/assets\/([^/]+)$/.exec(pathname)
    if (req.method === 'GET' && asset) {
      if (!this.auth(req, mode)) throw new HttpError(401, 'This browser is not signed in.')
      return this.asset(res, asset[1], mode)
    }
    const files: Record<string, string> = { '/app.js': 'text/javascript; charset=utf-8', '/live.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/sw.js': 'text/javascript; charset=utf-8', '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' }
    if (req.method === 'GET' && files[pathname]) return this.staticFile(res, pathname.slice(1), files[pathname], mode)
    this.requireOrigin(req, mode)
    if (req.method === 'POST' && pathname === '/api/pair/start') {
      const body = await this.body(req)
      const pairing = this.pairing
      if (!pairing || pairing.mode !== mode || pairing.expiresAt <= Date.now() || !same(String(body.token ?? ''), pairing.token)) throw new HttpError(410, 'This pairing link expired. Show a new QR code in Foreman.')
      this.pairing = null
      const id = token()
      // A phone unless it says it is a browser (docs/server.md, "Sessions"); the person approving sees which.
      if (body.kind !== undefined && body.kind !== 'phone' && body.kind !== 'browser') throw new HttpError(400, 'Invalid request.')
      const kind: Kind = body.kind ?? 'phone'
      const fallback = kind === 'browser' ? 'Browser' : 'Phone'
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : fallback
      const pending: Pending = { id, name: name || fallback, kind, mode, code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIR_MS, state: 'waiting' }
      this.pending.set(id, pending)
      this.deps.onChanged()
      return this.json(res, 200, { id, code: pending.code, expiresAt: pending.expiresAt })
    }
    if (req.method === 'GET' && pathname === '/api/pair/status') {
      const p = this.pending.get(url.searchParams.get('id') ?? '')
      if (!p || p.mode !== mode || p.expiresAt <= Date.now()) throw new HttpError(410, 'Pairing expired.')
      if (p.state === 'approved' && p.deviceId && p.auth) {
        res.setHeader('Set-Cookie', `foreman_mobile=${p.deviceId}.${p.auth}; Path=/; HttpOnly; ${mode === 'private' ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${mode === 'private' ? 31536000 : 86400}`)
        this.pending.delete(p.id)
      }
      return this.json(res, 200, { state: p.state })
    }
    const device = this.auth(req, mode)
    if (!device) throw new HttpError(401, 'This phone is not paired.')
    if (req.method === 'GET' && pathname === '/api/state') return this.json(res, 200, this.state())
    // Who this device signed in as and what it may do, so the page offers only that. Any paired device may ask.
    if (req.method === 'GET' && pathname === '/api/session') {
      const { id, name, kind, scopes } = deviceSession(device)
      return this.json(res, 200, { id, name, kind, scopes })
    }
    // G2: Home → Recent, for the phone. History only: reading it marks nothing seen and resolves nothing.
    if (req.method === 'GET' && pathname === '/api/recent') {
      const history = await this.call(device, 'attentionHistory')
      return this.json(res, 200, { events: phoneRecent(history.events, this.deps.snapshot().workspaces.filter((w) => w.state !== 'archived')), seenAt: history.seenAt ?? null })
    }
    if (mode === 'lan' && (pathname === '/api/push-key' || pathname === '/api/push')) throw new HttpError(403, 'Phone alerts need a private HTTPS connection.')
    if (req.method === 'GET' && pathname === '/api/push-key') return this.json(res, 200, { key: this.getVapid().publicKey })
    if (req.method === 'POST' && pathname === '/api/push') {
      const body = await this.body(req)
      if (typeof body.endpoint !== 'string' || !body.endpoint.startsWith('https://') || typeof body.keys !== 'object' || !body.keys) throw new HttpError(400, 'Invalid push subscription.')
      const keys = body.keys as Record<string, unknown>
      if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw new HttpError(400, 'Invalid push subscription.')
      device.push = { endpoint: body.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
      this.deps.store.save()
      return this.json(res, 200, { ok: true })
    }
    const chat = /^\/api\/chat\/([^/]+)$/.exec(pathname)
    // `?live=1`: with the reply still being written, which the socket's chat-append events then continue.
    if (req.method === 'GET' && chat) return this.json(res, 200, await this.call(device, 'getChat', chat[1], url.searchParams.get('live') === '1'))
    const send = /^\/api\/chat\/([^/]+)\/send$/.exec(pathname)
    if (req.method === 'POST' && send) {
      const body = await this.body(req)
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 100_000) throw new HttpError(400, 'Enter a message under 100,000 characters.')
      // #127: `steer` puts it into the running turn when the agent can take it there; otherwise it waits in the queue.
      const disposition = await this.call(device, 'sendMessage', send[1], body.text, { mode: body.mode === 'steer' ? 'steer' : 'queue' })
      return this.json(res, 200, { disposition })
    }
    // #127: a queued message sent into the running turn now, or taken out of the queue.
    const queued = /^\/api\/chat\/([^/]+)\/queued\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && queued) {
      const body = await this.body(req)
      if (body.action === 'steer') await this.call(device, 'steerQueued', queued[1], queued[2])
      else if (body.action === 'remove') await this.call(device, 'removeQueued', queued[1], queued[2])
      else throw new HttpError(400, 'Invalid request.')
      return this.json(res, 200, { ok: true })
    }
    // G4 #11: tick (or untick) a usage-limit failure's "Resume at …" from the phone; the same rules as the window's card.
    const resumeAt = /^\/api\/chat\/([^/]+)\/resume-at$/.exec(pathname)
    if (req.method === 'POST' && resumeAt) {
      const body = await this.body(req)
      if (body.cancel === true) await this.call(device, 'cancelLimitResume', resumeAt[1])
      // #127: a missed resume's "Resume now", as the window's card has it.
      else if (body.now === true) await this.call(device, 'resumeLimitNow', resumeAt[1])
      // Docs/agents.md 7.2: continue a paused chat on another account of its agent (null: the default account); never automatic.
      else if ('continueOn' in body) {
        if (body.continueOn !== null && typeof body.continueOn !== 'string') throw new HttpError(400, 'Which account?')
        await this.call(device, 'continueOnAccount', resumeAt[1], body.continueOn)
      }
      else {
        if (typeof body.turnId !== 'string') throw new HttpError(400, 'Which turn?')
        await this.call(device, 'armLimitResume', resumeAt[1], body.turnId)
      }
      return this.json(res, 200, { ok: true })
    }
    const stop = /^\/api\/chat\/([^/]+)\/stop$/.exec(pathname)
    if (req.method === 'POST' && stop) { await this.call(device, 'cancel', stop[1]); return this.json(res, 200, { ok: true }) }
    const approval = /^\/api\/approval\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && approval) {
      const body = await this.body(req)
      const pending = this.deps.approvals().find((a) => a.id === approval[1])
      if (!pending) throw new HttpError(409, 'This request was already resolved.')
      if (body.kind !== pending.kind) throw new HttpError(400, 'The response does not match this request.')
      let response: ApprovalResponse
      if (pending.kind === 'tool') response = { kind: 'tool', allow: body.allow === true, message: typeof body.message === 'string' ? body.message.slice(0, 2000) : undefined }
      else if (pending.kind === 'plan') response = { kind: 'plan', approve: body.approve === true, feedback: typeof body.feedback === 'string' ? body.feedback.slice(0, 2000) : undefined }
      // A flow's gate: Continue, Send back (with a note) or Stop.
      else if (pending.kind === 'gate') response = { kind: 'gate', answer: body.answer === 'continued' || body.answer === 'sent-back' ? body.answer : 'stopped', note: typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined }
      // A flow's pick: one of the results it offered, or none (the run stops).
      else if (pending.kind === 'pick') response = { kind: 'pick', chosen: typeof body.chosen === 'string' && pending.choices.some((c) => c.step === body.chosen) ? body.chosen : null }
      else response = { kind: 'question', answers: typeof body.answers === 'object' && body.answers && !Array.isArray(body.answers) ? Object.fromEntries(Object.entries(body.answers).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 2000)])) : undefined, skipped: body.skipped === true }
      await this.call(device, 'respondApproval', approval[1], response, 'phone')
      return this.json(res, 200, { ok: true })
    }
    const diff = /^\/api\/workspace\/([^/]+)\/diff$/.exec(pathname)
    if (req.method === 'GET' && diff) return this.json(res, 200, await this.call(device, 'getDiff', diff[1], 'all'))
    const checks = /^\/api\/workspace\/([^/]+)\/checks$/.exec(pathname)
    if (req.method === 'GET' && checks) return this.json(res, 200, await this.call(device, 'checksStatus', checks[1]))
    if (req.method === 'POST' && checks) {
      const body = await this.body(req)
      if (body.approve === true) {
        const expected = body.expected
        if (!Array.isArray(expected) || JSON.stringify(expected) !== JSON.stringify(this.deps.consentNeeded(checks[1]))) {
          throw new HttpError(409, 'Check commands changed. Review them again before approving.')
        }
      }
      return this.json(res, 200, await this.call(device, 'runChecks', checks[1], body.approve === true))
    }
    const git = /^\/api\/workspace\/([^/]+)\/git$/.exec(pathname)
    if (req.method === 'GET' && git) return this.json(res, 200, await this.call(device, 'gitStatus', git[1]))
    // #127: what the workspace's chats used (turns, agent time, cost), and its terminals' output (operate, as their live output is).
    const usage = /^\/api\/workspace\/([^/]+)\/usage$/.exec(pathname)
    if (req.method === 'GET' && usage) return this.json(res, 200, await this.call(device, 'workspaceUsage', usage[1]))
    const terminals = /^\/api\/workspace\/([^/]+)\/terminals$/.exec(pathname)
    if (req.method === 'GET' && terminals) return this.json(res, 200, await this.call(device, 'terminalOutput', terminals[1]))
    // #127: a comment on a line of the diff, sent with the next message as one written in the window is. #164: a removed
    // line has only its old number, so it goes (side 'old', with `quote`, the line as shown) as a one-line selection on the
    // old side, which is how the window comments on removed lines and how the agent is told which line was meant.
    const comment = /^\/api\/workspace\/([^/]+)\/comment$/.exec(pathname)
    if (req.method === 'POST' && comment) {
      const body = await this.body(req)
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      if (typeof body.file !== 'string' || !body.file || body.file.length > 1000 || !Number.isInteger(body.line) || (body.line as number) < 1) throw new HttpError(400, 'Invalid request.')
      if (body.side !== undefined && body.side !== 'new' && body.side !== 'old') throw new HttpError(400, 'Invalid request.')
      if (body.side === 'old' && (typeof body.quote !== 'string' || body.quote.length > 10_000)) throw new HttpError(400, 'Invalid request.')
      if (!text || text.length > 10_000) throw new HttpError(400, 'Write a comment under 10,000 characters.')
      const line = body.line as number
      if (body.side === 'old') {
        const selection: DiffSelection = { action: 'comment', side: 'old', start: line, end: line, lines: [body.quote as string], scope: 'all', at: new Date().toISOString() }
        await this.call(device, 'addComment', comment[1], body.file, line, text, selection)
      } else await this.call(device, 'addComment', comment[1], body.file, line, text)
      return this.json(res, 200, { ok: true })
    }
    // #127: delete one of your comments still waiting to go, or resolve one the agent left.
    const commentAction = /^\/api\/comment\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && commentAction) {
      const body = await this.body(req)
      const found = (this.deps.snapshot().comments ?? []).find((c) => c.id === commentAction[1])
      if (body.action === 'delete') {
        if (!found || found.author !== 'user' || found.state !== 'pending') throw new HttpError(409, 'This comment was already sent or removed.')
        await this.call(device, 'deleteComment', found.id)
      } else if (body.action === 'resolve') {
        if (!found || found.author !== 'agent' || found.state !== 'open') throw new HttpError(409, 'This comment was already resolved.')
        await this.call(device, 'updateComment', found.id, { state: 'resolved' })
      } else throw new HttpError(400, 'Invalid request.')
      return this.json(res, 200, { ok: true })
    }
    const newChat = /^\/api\/workspace\/([^/]+)\/chat$/.exec(pathname)
    if (req.method === 'POST' && newChat) return this.json(res, 200, await this.call(device, 'createSession', newChat[1]))
    const archive = /^\/api\/workspace\/([^/]+)\/archive$/.exec(pathname)
    if (req.method === 'POST' && archive) {
      // #1: refuses while an agent runs; a failed checkpoint or archive script deletes nothing.
      const outcome = await this.call(device, 'archiveWorkspace', archive[1], false)
      if (!outcome.ok) throw new HttpError(409, outcome.step === 'checkpoint' ? `Couldn’t save the uncommitted changes (${outcome.detail}). Nothing was deleted.` : `The archive script failed (${outcome.detail}). Nothing was deleted.`)
      return this.json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && pathname === '/api/workspace') {
      const body = await this.body(req)
      const repoId = String(body.repoId ?? '')
      if (!this.deps.snapshot().repos.some((r) => r.id === repoId)) throw new HttpError(400, 'Choose a repository.')
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 100_000) : ''
      if (!prompt) throw new HttpError(400, 'Enter a first message.')
      const ws = await this.call(device, 'createWorkspace', repoId, { prompt })
      return this.json(res, 200, { id: ws.id })
    }
    throw new HttpError(404, 'Not found.')
  }
}
