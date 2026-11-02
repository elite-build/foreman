// The computer being controlled (shared/remote.ts): it serves the window calls of a paired computer that holds a control
// link, streams its events back, and tells every linked computer how many workspaces are working and need someone.
// A background link (the other computer's chip and alerts) needs only the pairing; taking control needs the setting on,
// and, when the person here asked to be asked, their Allow. An Allow lasts until they disconnect it or Foreman restarts.
import { randomUUID } from 'node:crypto'
import { hostAccepts, hostForwards, LOCAL_SIGNALS, REMOTE_PROTOCOL, sameSummary, type ClientFrame, type ComputerController, type ComputerSummary, type ControlRequest, type RemoteHello, type RemoteMode, type RemoteWelcome, type ServerFrame } from '../../shared/remote'
import { API_METHODS, SIGNAL_METHODS, type MainEvent } from '../../shared/types'
import type { Channel } from './channel'

/** How long the person here has to answer before the request is turned down. */
export const ASK_MS = 2 * 60_000

export interface RemoteHostDeps {
  version: string
  platform: string
  name(): string
  /** Paired computers may take control (Settings → Computers). */
  allowed(): boolean
  /** Ask the person here before one does. */
  ask(): boolean
  deviceName(deviceId: string): string
  api: Record<string, (...args: unknown[]) => unknown>
  signals: Record<string, (...args: unknown[]) => void>
  onEvent(listener: (event: MainEvent) => void): () => void
  summary(): ComputerSummary
  /** Who is connected, or asking, changed. */
  changed(): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

interface Link {
  id: string
  deviceId: string
  platform: string
  channel: Channel
  mode: RemoteMode
  since?: string
}

interface Pending extends ControlRequest {
  link: Link
  timer: { cancel(): void }
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

export class RemoteHost {
  private links = new Set<Link>()
  private pending = new Map<string, Pending>()
  // Computers the person here let in, until they disconnect one or Foreman restarts.
  private approved = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private lastSummary: ComputerSummary | undefined

  constructor(private deps: RemoteHostDeps) {}

  private get timer() {
    return this.deps.setTimer ?? defaultTimer
  }

  /** The welcome for a computer that asked for a channel (deviceNet's onRemote). */
  welcome(deviceId: string, hello: RemoteHello): { welcome: RemoteWelcome; attach?: (channel: Channel) => void } {
    const base = { version: this.deps.version, platform: this.deps.platform, name: this.deps.name() }
    if (hello.protocol !== REMOTE_PROTOCOL) return { welcome: { ...base, ok: false, refused: 'protocol' } }
    if (hello.version !== this.deps.version) return { welcome: { ...base, ok: false, refused: 'version' } }
    if (!this.deps.allowed()) return { welcome: { ...base, ok: false, refused: 'off' } }
    return { welcome: { ...base, ok: true }, attach: (channel) => this.attach(deviceId, hello.platform, channel) }
  }

  private attach(deviceId: string, platform: string, channel: Channel): void {
    const link: Link = { id: randomUUID(), deviceId, platform, channel, mode: 'background' }
    this.links.add(link)
    this.unsubscribe ??= this.deps.onEvent((event) => this.event(event))
    channel.start(
      (message) => void this.receive(link, message as ClientFrame),
      () => this.drop(link)
    )
    this.send(link, { t: 'summary', summary: this.currentSummary() })
  }

  private drop(link: Link): void {
    if (!this.links.delete(link)) return
    for (const [id, p] of this.pending) {
      if (p.link !== link) continue
      p.timer.cancel()
      this.pending.delete(id)
    }
    if (!this.links.size) {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
    this.deps.changed()
  }

  private send(link: Link, frame: ServerFrame): void {
    try {
      link.channel.send(frame)
    } catch (err) {
      // Too large to send: the caller hears an error rather than nothing.
      if (frame.t === 'reply') link.channel.send({ t: 'reply', id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async receive(link: Link, frame: ClientFrame): Promise<void> {
    if (!frame || typeof frame !== 'object') return
    if (frame.t === 'ping') return this.send(link, { t: 'pong' })
    if (frame.t === 'mode') return this.setMode(link, frame.mode)
    if (frame.t === 'signal') {
      const method = frame.method as (typeof SIGNAL_METHODS)[number]
      if (link.mode !== 'control' || !SIGNAL_METHODS.includes(method) || LOCAL_SIGNALS.has(method)) return
      this.deps.signals[method]?.(...(Array.isArray(frame.args) ? frame.args : []))
      return
    }
    if (frame.t !== 'call' || typeof frame.id !== 'number') return
    const refuse = (error: string) => this.send(link, { t: 'reply', id: frame.id, ok: false, error })
    if (link.mode !== 'control') return refuse('This computer hasn’t let you take control.')
    const method = frame.method as (typeof API_METHODS)[number]
    if (!API_METHODS.includes(method) || !hostAccepts(method)) return refuse('That can only be done on the computer itself.')
    const fn = this.deps.api[method]
    if (typeof fn !== 'function') return refuse(`Unknown method ${method}`)
    try {
      const value = await fn(...(Array.isArray(frame.args) ? frame.args : []))
      this.send(link, { t: 'reply', id: frame.id, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err))
    }
  }

  private setMode(link: Link, mode: RemoteMode): void {
    if (mode === 'background') {
      const was = link.mode
      link.mode = 'background'
      link.since = undefined
      this.send(link, { t: 'mode', mode: 'background' })
      if (was === 'control') this.deps.changed()
      return
    }
    if (mode !== 'control') return
    if (!this.deps.allowed()) return this.send(link, { t: 'mode', mode: 'background', error: 'off' })
    if (!this.deps.ask() || this.approved.has(link.deviceId)) return this.grant(link)
    if ([...this.pending.values()].some((p) => p.link === link)) return this.send(link, { t: 'mode', mode: 'background', waiting: true })
    const id = randomUUID()
    const timer = this.timer(() => {
      if (!this.pending.delete(id)) return
      this.send(link, { t: 'mode', mode: 'background', error: 'timeout' })
      this.deps.changed()
    }, ASK_MS)
    this.pending.set(id, { id, deviceId: link.deviceId, name: this.deps.deviceName(link.deviceId), platform: link.platform, link, timer })
    this.send(link, { t: 'mode', mode: 'background', waiting: true })
    this.deps.changed()
  }

  private grant(link: Link): void {
    link.mode = 'control'
    link.since = new Date((this.deps.now ?? Date.now)()).toISOString()
    this.send(link, { t: 'mode', mode: 'control' })
    this.deps.changed()
  }

  /** The person here answered a request. */
  answer(requestId: string, allow: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) throw new Error('That request is no longer waiting.')
    this.pending.delete(requestId)
    p.timer.cancel()
    if (allow && this.deps.allowed() && this.links.has(p.link)) {
      this.approved.add(p.deviceId)
      this.grant(p.link)
    } else {
      this.send(p.link, { t: 'mode', mode: 'background', error: 'denied' })
      this.deps.changed()
    }
  }

  /** Stop a computer controlling this one. Its links stay for the chip and alerts; it has to be let in again. */
  disconnect(deviceId: string): void {
    this.approved.delete(deviceId)
    for (const link of this.links) {
      if (link.deviceId !== deviceId || link.mode !== 'control') continue
      link.mode = 'background'
      link.since = undefined
      this.send(link, { t: 'mode', mode: 'background', error: 'denied' })
    }
    this.deps.changed()
  }

  /** The setting went off, or a computer was unpaired: close what no longer may stay open. */
  refresh(paired: (deviceId: string) => boolean): void {
    const allowed = this.deps.allowed()
    for (const link of [...this.links]) if (!allowed || !paired(link.deviceId)) link.channel.close()
    if (!allowed) this.approved.clear()
    for (const id of [...this.approved]) if (!paired(id)) this.approved.delete(id)
  }

  controllers(): ComputerController[] {
    const byDevice = new Map<string, ComputerController>()
    for (const l of this.links) {
      if (l.mode !== 'control' || byDevice.has(l.deviceId)) continue
      byDevice.set(l.deviceId, { id: l.deviceId, name: this.deps.deviceName(l.deviceId), platform: l.platform, since: l.since ?? '' })
    }
    return [...byDevice.values()]
  }

  requests(): ControlRequest[] {
    return [...this.pending.values()].map(({ id, deviceId, name, platform }) => ({ id, deviceId, name, platform }))
  }

  close(): void {
    for (const link of [...this.links]) link.channel.close()
    for (const p of this.pending.values()) p.timer.cancel()
    this.pending.clear()
  }

  // ---- events ----

  private currentSummary(): ComputerSummary {
    this.lastSummary = this.deps.summary()
    return this.lastSummary
  }

  private event(event: MainEvent): void {
    const forward = hostForwards(event)
    for (const link of this.links) {
      if (link.mode === 'control' && forward) this.send(link, { t: 'event', event })
      else if (link.mode === 'background' && event.type === 'notify') this.send(link, { t: 'notify', event })
    }
  }

  /** The attention pass ran here (already debounced): tell every linked computer when the counts moved. */
  summaryChanged(): void {
    if (!this.links.size) return
    const before = this.lastSummary
    const now = this.currentSummary()
    if (sameSummary(before, now)) return
    for (const link of this.links) this.send(link, { t: 'summary', summary: now })
  }
}
