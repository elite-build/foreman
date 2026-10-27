// A narrow HTTP surface for a paired phone. Private HTTPS is proxied from the
// loopback listener; nearby phones can opt into a separate LAN listener.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import webpush from 'web-push'
import { triageAll } from '../shared/triage'
import { phoneRecent, prGlyph } from '../shared/attention'
import { isGitlabWorkspace } from '../shared/scm'
import type { MobileDevice, MobileInfo } from '../shared/mobile'
import type { Api, AppSnapshot, ApprovalRequest, ApprovalResponse, CheckConsentItem, MainEvent } from '../shared/types'
import { mainT } from './i18n'
import { lanAddresses, onSameLan } from './lan'
import type { Store } from './store'
import type { SecretStore } from './secrets'

export const MOBILE_PORT = 47632
export const MOBILE_LAN_PORT = 47633
const STALL_MS = 15 * 60_000
const PAIR_MS = 2 * 60_000
const MAX_BODY = 64 * 1024

type Mode = 'private' | 'lan'
type Pending = { id: string; name: string; code: string; mode: Mode; expiresAt: number; state: 'waiting' | 'approved' | 'denied'; deviceId?: string; auth?: string }
type Pairing = { mode: Mode; token: string; expiresAt: number; url: string; qr: string }
type MobileDeps = {
  store: Store
  secrets: SecretStore
  api: Api
  snapshot(): AppSnapshot
  approvals(): ApprovalRequest[]
  consentNeeded(workspaceId: string): CheckConsentItem[]
  appPath: string
  onChanged(): void
  onEnabledChange(on: boolean): void
}

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

  constructor(private deps: MobileDeps, private port = MOBILE_PORT, private lanPort = MOBILE_LAN_PORT, private getLanAddresses = lanAddresses) {
    this.deps.store.state.mobileDevices ??= []
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
    await Promise.all([this.closePrivate(), this.closeLan()])
  }

  private async closeServer(server: Server | null): Promise<void> {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  }

  private async closePrivate(): Promise<void> {
    const server = this.privateServer
    this.privateServer = null
    await this.closeServer(server)
    this.stopTimerWhenIdle()
  }

  private async closeLan(): Promise<void> {
    const server = this.lanServer
    this.lanServer = null
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
      const status = err instanceof HttpError ? err.status : 500
      this.json(res, status, { error: status === 500 ? 'Foreman could not complete that request.' : (err as Error).message })
    }))
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
      pending: pending ? { id: pending.id, name: pending.name, code: pending.code, mode: pending.mode, expiresAt: pending.expiresAt } : undefined
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

  approve(id: string, allow: boolean): MobileInfo {
    const p = this.pending.get(id)
    if (!p || p.state !== 'waiting' || p.expiresAt <= Date.now()) throw new Error('That pairing request expired.')
    if (allow) {
      p.deviceId = randomUUID()
      p.auth = token()
      this.deps.secrets.setAppSecret(`mobile:${p.deviceId}`, p.auth)
      this.deps.store.state.mobileDevices!.push({ id: p.deviceId, name: p.name, pairedAt: new Date().toISOString(), transport: p.mode })
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

  private headers(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'")
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
  private auth(req: IncomingMessage, mode: Mode): MobileDevice | null {
    const cookie = /(?:^|;\s*)foreman_mobile=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const [id, credential] = cookie?.split('.') ?? []
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
    if (req.method !== 'POST') return
    const origin = req.headers.origin
    const expected = mode === 'private' ? this.deps.store.state.settings.mobileUrl : `http://${this.deps.store.state.settings.mobileLanAddress}:${this.boundLanPort}`
    if (!origin || origin !== expected) throw new HttpError(403, 'Wrong origin.')
  }
  private async staticFile(res: ServerResponse, name: string, mime: string): Promise<void> {
    const file = path.join(this.deps.appPath, 'resources', 'mobile', name)
    const data = await readFile(file)
    this.headers(res)
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
  }

  private state() {
    const snapshot = this.deps.snapshot()
    const approvals = this.deps.approvals()
    const waiting = new Set(approvals.map((a) => a.sessionId))
    const rows = triageAll({ snapshot, approvals, unread: {}, unreadSessions: {} }, null)
    return {
      repos: snapshot.repos.map((r) => ({ id: r.id, name: r.name })),
      workspaces: rows.map((t) => {
        const stalledSession = snapshot.sessions.find((s) => s.workspaceId === t.ws.id && this.isStalled(s, waiting))
        const stalled = Boolean(stalledSession)
        const stalledSince = stalledSession?.lastActivityAt ?? stalledSession?.turnStartedAt
        return { id: t.ws.id, repoId: t.ws.repoId, name: t.ws.name, branch: t.ws.branch, state: t.ws.state, bucket: stalled && t.bucket === 'working' ? 'attention' : t.bucket, label: stalled && t.bucket === 'working' ? 'Possible stall' : t.label, detail: stalled && t.bucket === 'working' ? `${stalledSession!.agent} · no activity for ${Math.floor((Date.now() - new Date(stalledSince!).getTime()) / 60_000)} min` : t.detail, sessionId: stalledSession?.id ?? t.sessionId, facts: t.facts, stalled, stalledSince, since: t.since, pr: this.prGlyph(t.ws, snapshot), checks: t.ws.checks ? { running: t.ws.checks.running, stale: t.ws.checks.stale, results: t.ws.checks.results.map((r) => ({ name: r.name, status: r.status })) } : null }
      }),
      sessions: snapshot.sessions.filter((s) => !s.closedAt).map((s) => ({ id: s.id, workspaceId: s.workspaceId, title: s.title, agent: s.agent, model: s.model, status: s.status, waitingForSlot: s.waitingForSlot, turnStartedAt: s.turnStartedAt, lastActivityAt: s.lastActivityAt, lastTurn: s.lastTurn, queued: s.queue.length, limitResume: s.limitResume })),
      approvals,
      templates: snapshot.settings.promptTemplates.map((t) => ({ id: t.id, name: t.name, body: t.body }))
    }
  }

  /** G2: the row's PR glyph as the window shows it (open, draft, merged, CI failing), worded for GitLab when it is. */
  private prGlyph(ws: AppSnapshot['workspaces'][number], snapshot: AppSnapshot) {
    const glyph = prGlyph(ws)
    if (!glyph) return null
    const repo = snapshot.repos.find((r) => r.id === ws.repoId)
    return { ...glyph, provider: isGitlabWorkspace(ws, repo, snapshot.settings?.gitlabHosts ?? []) ? 'gitlab' : glyph.provider }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, mode: Mode): Promise<void> {
    if (mode === 'lan') {
      const host = this.getLanAddresses().find((candidate) => candidate.address === this.deps.store.state.settings.mobileLanAddress)
      if (!host || req.headers.host !== `${host.address}:${this.boundLanPort}` || !onSameLan(req.socket.remoteAddress ?? '', host)) {
        throw new HttpError(403, 'This connection must come from the selected local network.')
      }
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/') return this.staticFile(res, 'index.html', 'text/html; charset=utf-8')
    const files: Record<string, string> = { '/app.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8', '/sw.js': 'text/javascript; charset=utf-8', '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' }
    if (req.method === 'GET' && files[pathname]) return this.staticFile(res, pathname.slice(1), files[pathname])
    this.requireOrigin(req, mode)
    if (req.method === 'POST' && pathname === '/api/pair/start') {
      const body = await this.body(req)
      const pairing = this.pairing
      if (!pairing || pairing.mode !== mode || pairing.expiresAt <= Date.now() || !same(String(body.token ?? ''), pairing.token)) throw new HttpError(410, 'This pairing link expired. Show a new QR code in Foreman.')
      this.pairing = null
      const id = token()
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : 'Phone'
      const pending: Pending = { id, name: name || 'Phone', mode, code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIR_MS, state: 'waiting' }
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
    // G2: Home → Recent, for the phone. History only: reading it marks nothing seen and resolves nothing.
    if (req.method === 'GET' && pathname === '/api/recent') {
      const history = await this.deps.api.attentionHistory()
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
    if (req.method === 'GET' && chat) return this.json(res, 200, await this.deps.api.getChat(chat[1]))
    const send = /^\/api\/chat\/([^/]+)\/send$/.exec(pathname)
    if (req.method === 'POST' && send) {
      const body = await this.body(req)
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 100_000) throw new HttpError(400, 'Enter a message under 100,000 characters.')
      const disposition = await this.deps.api.sendMessage(send[1], body.text, { mode: 'queue' })
      return this.json(res, 200, { disposition })
    }
    // G4 #11: tick (or untick) a usage-limit failure's "Resume at …" from the phone; the same rules as the window's card.
    const resumeAt = /^\/api\/chat\/([^/]+)\/resume-at$/.exec(pathname)
    if (req.method === 'POST' && resumeAt) {
      const body = await this.body(req)
      if (body.cancel === true) await this.deps.api.cancelLimitResume(resumeAt[1])
      else {
        if (typeof body.turnId !== 'string') throw new HttpError(400, 'Which turn?')
        await this.deps.api.armLimitResume(resumeAt[1], body.turnId)
      }
      return this.json(res, 200, { ok: true })
    }
    const stop = /^\/api\/chat\/([^/]+)\/stop$/.exec(pathname)
    if (req.method === 'POST' && stop) { await this.deps.api.cancel(stop[1]); return this.json(res, 200, { ok: true }) }
    const approval = /^\/api\/approval\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && approval) {
      const body = await this.body(req)
      const pending = this.deps.approvals().find((a) => a.id === approval[1])
      if (!pending) throw new HttpError(409, 'This request was already resolved.')
      if (body.kind !== pending.kind) throw new HttpError(400, 'The response does not match this request.')
      let response: ApprovalResponse
      if (pending.kind === 'tool') response = { kind: 'tool', allow: body.allow === true, message: typeof body.message === 'string' ? body.message.slice(0, 2000) : undefined }
      else if (pending.kind === 'plan') response = { kind: 'plan', approve: body.approve === true, feedback: typeof body.feedback === 'string' ? body.feedback.slice(0, 2000) : undefined }
      else response = { kind: 'question', answers: typeof body.answers === 'object' && body.answers && !Array.isArray(body.answers) ? Object.fromEntries(Object.entries(body.answers).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 2000)])) : undefined, skipped: body.skipped === true }
      await this.deps.api.respondApproval(approval[1], response, 'phone')
      return this.json(res, 200, { ok: true })
    }
    const diff = /^\/api\/workspace\/([^/]+)\/diff$/.exec(pathname)
    if (req.method === 'GET' && diff) return this.json(res, 200, await this.deps.api.getDiff(diff[1], 'all'))
    const checks = /^\/api\/workspace\/([^/]+)\/checks$/.exec(pathname)
    if (req.method === 'GET' && checks) return this.json(res, 200, await this.deps.api.checksStatus(checks[1]))
    if (req.method === 'POST' && checks) {
      const body = await this.body(req)
      if (body.approve === true) {
        const expected = body.expected
        if (!Array.isArray(expected) || JSON.stringify(expected) !== JSON.stringify(this.deps.consentNeeded(checks[1]))) {
          throw new HttpError(409, 'Check commands changed. Review them again before approving.')
        }
      }
      return this.json(res, 200, await this.deps.api.runChecks(checks[1], body.approve === true))
    }
    const git = /^\/api\/workspace\/([^/]+)\/git$/.exec(pathname)
    if (req.method === 'GET' && git) return this.json(res, 200, await this.deps.api.gitStatus(git[1]))
    const newChat = /^\/api\/workspace\/([^/]+)\/chat$/.exec(pathname)
    if (req.method === 'POST' && newChat) return this.json(res, 200, await this.deps.api.createSession(newChat[1]))
    const archive = /^\/api\/workspace\/([^/]+)\/archive$/.exec(pathname)
    if (req.method === 'POST' && archive) {
      // #1: refuses while an agent runs; a failed checkpoint or archive script deletes nothing.
      const outcome = await this.deps.api.archiveWorkspace(archive[1], false)
      if (!outcome.ok) throw new HttpError(409, outcome.step === 'checkpoint' ? `Couldn’t save the uncommitted changes (${outcome.detail}). Nothing was deleted.` : `The archive script failed (${outcome.detail}). Nothing was deleted.`)
      return this.json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && pathname === '/api/workspace') {
      const body = await this.body(req)
      const repoId = String(body.repoId ?? '')
      if (!this.deps.snapshot().repos.some((r) => r.id === repoId)) throw new HttpError(400, 'Choose a repository.')
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 100_000) : ''
      if (!prompt) throw new HttpError(400, 'Enter a first message.')
      const ws = await this.deps.api.createWorkspace(repoId, { prompt })
      return this.json(res, 200, { id: ws.id })
    }
    throw new HttpError(404, 'Not found.')
  }
}
