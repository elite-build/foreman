// One paired computer, from the side that controls it (shared/remote.ts): a lasting channel that stays up in the
// background (its chip row and its alerts) and is raised to control while this window shows it. It reconnects on its
// own, more slowly the longer the other computer stays away.
import type { ClientFrame, ComputerStatus, ComputerSummary, RemoteHello, RemoteMode, RemoteWelcome, ServerFrame } from '../../shared/remote'
import type { MainEvent } from '../../shared/types'
import type { Channel } from './channel'

const PING_MS = 15_000
/** A window call that hasn't come back in this long is given up on (the channel closing ends them all sooner). */
const CALL_MS = 15 * 60_000
const RETRY_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000]
/** A computer that said no (another version, or control off there) is asked again this often. */
const REFUSED_RETRY_MS = 60_000

export type ControlError = 'denied' | 'off' | 'timeout' | 'unreachable' | 'mismatch'

export interface RemoteLinkDeps {
  deviceId: string
  hello(): RemoteHello
  open(hello: RemoteHello): Promise<{ welcome: RemoteWelcome; channel?: Channel }>
  /** Status, summary, waiting or control changed. */
  changed(): void
  /** An event from the other computer, while this link holds control. */
  onEvent(event: MainEvent): void
  /** A notification from the other computer, while this link is in the background. */
  onNotify(event: Extract<MainEvent, { type: 'notify' }>): void
  /**
   * Control this window held, or was getting back after a drop, is gone: the person there disconnected you or said no,
   * nobody answered, control was turned off there, or it came back running another version.
   */
  onRevoked(reason: 'denied' | 'off' | 'timeout' | 'mismatch'): void
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

interface Call {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: { cancel(): void }
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return { cancel: () => clearTimeout(t) }
}

export class ControlRefused extends Error {
  constructor(readonly reason: ControlError) {
    super(reason)
  }
}

export class RemoteLink {
  status: ComputerStatus = 'connecting'
  summary?: ComputerSummary
  platform?: string
  name?: string
  // mismatch: the other computer's version.
  version?: string
  /** Control is granted on the current channel. */
  mode: RemoteMode = 'background'
  /** The other computer is asking its person whether to let this one in. */
  waiting = false
  /** This window wants control (it shows this computer, or is about to). */
  private wanted = false
  private channel: Channel | null = null
  private calls = new Map<number, Call>()
  private nextId = 1
  private attempt = 0
  private retry: { cancel(): void } | null = null
  private pinger: { cancel(): void } | null = null
  private stopped = false
  private connecting: Promise<void> | null = null
  private granted: { resolve(): void; reject(e: ControlRefused): void } | null = null

  constructor(private deps: RemoteLinkDeps) {}

  private get timer() {
    return this.deps.setTimer ?? defaultTimer
  }

  get id(): string {
    return this.deps.deviceId
  }

  get connected(): boolean {
    return Boolean(this.channel && !this.channel.closed)
  }

  /** Keep a background link up from now on. */
  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.wanted = false
    this.retry?.cancel()
    this.retry = null
    this.channel?.close()
    this.channel = null
  }

  /** Try again now (Settings' Check, or the banner's Retry). */
  retryNow(): void {
    if (this.stopped || this.connected) return
    this.retry?.cancel()
    this.retry = null
    this.attempt = 0
    void this.connect()
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = this.dial().finally(() => (this.connecting = null))
    return this.connecting
  }

  private async dial(): Promise<void> {
    if (this.stopped || this.connected) return
    this.retry?.cancel()
    this.retry = null
    this.status = 'connecting'
    this.deps.changed()
    let opened: { welcome: RemoteWelcome; channel?: Channel }
    try {
      opened = await this.deps.open(this.deps.hello())
    } catch {
      this.status = 'offline'
      this.failControl('unreachable')
      this.deps.changed()
      return this.again(RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)])
    }
    const { welcome, channel } = opened
    this.platform = welcome.platform
    this.name = welcome.name
    if (!channel || !welcome.ok) {
      const reason = welcome.refused === 'off' ? 'off' : 'mismatch'
      this.status = reason === 'off' ? 'refused' : 'mismatch'
      this.version = reason === 'off' ? undefined : welcome.version
      this.failControl(reason)
      if (this.wanted) {
        this.wanted = false
        this.deps.onRevoked(reason)
      }
      this.deps.changed()
      return this.again(REFUSED_RETRY_MS)
    }
    if (this.stopped) return void channel.close()
    this.attempt = 0
    this.version = undefined
    this.channel = channel
    this.status = 'online'
    this.mode = 'background'
    channel.start(
      (message) => this.receive(message as ServerFrame),
      () => this.closed(channel)
    )
    this.ping()
    if (this.wanted) this.send({ t: 'mode', mode: 'control' })
    this.deps.changed()
  }

  private again(ms: number): void {
    if (this.stopped) return
    this.retry = this.timer(() => {
      this.retry = null
      void this.connect()
    }, ms)
  }

  private ping(): void {
    this.pinger?.cancel()
    this.pinger = this.timer(() => {
      this.pinger = null
      if (!this.connected) return
      this.send({ t: 'ping' })
      this.ping()
    }, PING_MS)
  }

  private closed(channel: Channel): void {
    if (this.channel !== channel) return
    this.channel = null
    this.pinger?.cancel()
    this.pinger = null
    this.mode = 'background'
    this.waiting = false
    for (const call of this.calls.values()) {
      call.timer.cancel()
      call.reject(new Error(`${this.name ?? 'The other computer'} isn’t reachable.`))
    }
    this.calls.clear()
    this.failControl('unreachable')
    this.status = this.stopped ? this.status : 'offline'
    this.deps.changed()
    this.again(RETRY_MS[0])
  }

  private send(frame: ClientFrame): void {
    this.channel?.send(frame)
  }

  private receive(frame: ServerFrame): void {
    if (!frame || typeof frame !== 'object') return
    switch (frame.t) {
      case 'reply': {
        const call = this.calls.get(frame.id)
        if (!call) return
        this.calls.delete(frame.id)
        call.timer.cancel()
        if (frame.ok) call.resolve(frame.value)
        else call.reject(new Error(frame.error))
        return
      }
      case 'event':
        if (this.mode === 'control') this.deps.onEvent(frame.event)
        return
      case 'notify':
        this.deps.onNotify(frame.event)
        return
      case 'summary':
        this.summary = frame.summary
        this.deps.changed()
        return
      case 'mode':
        return this.modeAnswer(frame)
      default:
        return
    }
  }

  private modeAnswer(frame: Extract<ServerFrame, { t: 'mode' }>): void {
    this.mode = frame.mode
    this.waiting = Boolean(frame.waiting)
    if (frame.mode === 'control') {
      this.granted?.resolve()
      this.granted = null
    } else if (frame.error) {
      const wanted = this.wanted
      this.wanted = false
      // A first request hears its answer through requestControl; control held (or being regained) hears it here.
      if (this.granted) this.failControl(frame.error)
      else if (wanted) this.deps.onRevoked(frame.error)
    }
    this.deps.changed()
  }

  private failControl(reason: ControlError): void {
    const g = this.granted
    this.granted = null
    g?.reject(new ControlRefused(reason))
  }

  /** Ask for control and wait for it: at once when allowed, or until the person there answers. */
  async requestControl(): Promise<void> {
    this.wanted = true
    if (this.mode === 'control' && this.connected) return
    const granted = new Promise<void>((resolve, reject) => {
      this.granted?.reject(new ControlRefused('denied'))
      this.granted = { resolve, reject }
    })
    if (this.connected) this.send({ t: 'mode', mode: 'control' })
    else {
      this.retry?.cancel()
      this.retry = null
      this.attempt = 0
      await this.connect()
    }
    return granted
  }

  /** This window no longer shows this computer: back to a background link. */
  release(): void {
    this.wanted = false
    this.waiting = false
    this.failControl('denied')
    if (this.mode === 'control') this.send({ t: 'mode', mode: 'background' })
    this.mode = 'background'
    this.deps.changed()
  }

  get wantsControl(): boolean {
    return this.wanted
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    if (!this.connected || this.mode !== 'control') return Promise.reject(new Error(`${this.name ?? 'The other computer'} isn’t reachable.`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.timer(() => {
        if (!this.calls.delete(id)) return
        reject(new Error(`${this.name ?? 'The other computer'} didn’t answer.`))
      }, CALL_MS)
      this.calls.set(id, { resolve, reject, timer })
      try {
        this.send({ t: 'call', id, method, args })
      } catch (err) {
        this.calls.delete(id)
        timer.cancel()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  signal(method: string, args: unknown[]): void {
    if (this.connected && this.mode === 'control') this.send({ t: 'signal', method, args })
  }
}
