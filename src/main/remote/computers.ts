// This computer's side of other computers (shared/remote.ts): a background link to every paired computer (for the
// computer chip and its alerts), the one this window shows instead of this computer, and switching between them. The
// window's calls and the other computer's events go through here (main/index.ts routes them).
import type { TFunction } from '../../shared/i18n'
import type { ComputerRow, ComputersView, ComputerSummary, RemoteHello, RemoteWelcome } from '../../shared/remote'
import { REMOTE_PROTOCOL, sameSummary } from '../../shared/remote'
import type { MainEvent } from '../../shared/types'
import type { PairedDevice } from '../../shared/transfer'
import type { Channel } from './channel'
import type { RemoteHost } from './host'
import { ControlRefused, RemoteLink, type ControlError } from './link'

export type LeftReason = Extract<MainEvent, { type: 'computer-left' }>['reason']

export interface RemoteComputersDeps {
  self(): { id: string; name: string }
  platform: string
  version: string
  paired(): PairedDevice[]
  canDial(deviceId: string): boolean
  open(deviceId: string, hello: RemoteHello): Promise<{ welcome: RemoteWelcome; channel?: Channel }>
  host: RemoteHost
  localSummary(): ComputerSummary
  /** To this computer's window: the chip's view changed, or another computer needs you. */
  broadcast(event: MainEvent): void
  /** To this computer's window: an event from the computer it shows. */
  showEvent(event: MainEvent): void
  /** Load the window again, so it starts over from the computer it now shows. */
  reloadWindow(): void
  /** Once the window has loaded again: open a workspace, or say why it came back to this computer. */
  afterReload(event: MainEvent): void
  /** main's words, in the language Settings picked. */
  t(): TFunction
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

const CHANGED_MS = 150

export class RemoteComputers {
  private links = new Map<string, RemoteLink>()
  private viewingId: string | null = null
  // The link dropped while this window showed it.
  private lost = false
  private joining: { id: string; name: string } | null = null
  private changedTimer: ReturnType<typeof setTimeout> | null = null
  private lastSelf: ComputerSummary | undefined

  constructor(private deps: RemoteComputersDeps) {}

  /** Paired computers changed: link the new ones, drop the ones that are gone. */
  sync(): void {
    const wanted = new Set(this.deps.paired().filter((d) => this.deps.canDial(d.id)).map((d) => d.id))
    for (const [id, link] of this.links) {
      if (wanted.has(id)) continue
      link.stop()
      this.links.delete(id)
      if (this.viewingId === id) this.leave('unpaired')
    }
    for (const id of wanted) {
      if (this.links.has(id)) continue
      const link = new RemoteLink({
        deviceId: id,
        hello: () => ({ protocol: REMOTE_PROTOCOL, version: this.deps.version, platform: this.deps.platform, name: this.deps.self().name }),
        open: (hello) => this.deps.open(id, hello),
        changed: () => this.linkChanged(link),
        onEvent: (event) => {
          if (this.viewingId === id) this.deps.showEvent(this.rewrite(event))
        },
        onNotify: (event) => {
          if (this.viewingId === id) return
          this.deps.broadcast({ type: 'computer-notify', computerId: id, computerName: this.nameOf(id), workspaceId: event.workspaceId, sessionId: event.sessionId, title: event.title, body: event.body })
        },
        onRevoked: (reason) => {
          if (this.viewingId === id) this.leave(reason)
        },
        setTimer: this.deps.setTimer
      })
      this.links.set(id, link)
      link.start()
    }
    this.changed()
  }

  private linkChanged(link: RemoteLink): void {
    if (this.viewingId === link.id) {
      const live = link.connected && link.mode === 'control'
      if (!live && !this.lost) this.lost = true
      else if (live && this.lost) {
        // Back after a drop: start the window over, so nothing that happened meanwhile is missing.
        this.lost = false
        this.deps.reloadWindow()
      }
    }
    this.changed()
  }

  private nameOf(id: string): string {
    return this.deps.paired().find((d) => d.id === id)?.name ?? this.links.get(id)?.name ?? id
  }

  /** The window's view of the other computer: its platform is this computer's (shortcuts, title bar). */
  rewrite<T>(value: T): T {
    if (value && typeof value === 'object' && 'type' in value && (value as { type: unknown }).type === 'state') {
      const event = value as unknown as Extract<MainEvent, { type: 'state' }>
      return { ...event, snapshot: { ...event.snapshot, platform: this.deps.platform } } as T
    }
    return value
  }

  /** The link this window shows, while it shows another computer. */
  viewing(): RemoteLink | null {
    return this.viewingId ? (this.links.get(this.viewingId) ?? null) : null
  }

  get viewingName(): string | null {
    return this.viewingId ? this.nameOf(this.viewingId) : null
  }

  /** A window call routed to the computer it shows. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    const link = this.viewing()
    if (!link) throw new Error('This window shows this computer.')
    const value = await link.call(method, args)
    if (method === 'getSnapshot' && value && typeof value === 'object') return { ...(value as object), platform: this.deps.platform }
    return value
  }

  /** Show another computer in this window (null: this one again). */
  async view(deviceId: string | null, open?: { workspaceId: string; sessionId?: string }): Promise<void> {
    if (deviceId === this.viewingId && !this.lost) {
      if (open) this.deps.afterReload({ type: 'navigate', workspaceId: open.workspaceId, sessionId: open.sessionId })
      return
    }
    if (deviceId === null) {
      this.viewing()?.release()
      this.viewingId = null
      this.lost = false
      this.changed()
      this.deps.reloadWindow()
      if (open) this.deps.afterReload({ type: 'navigate', workspaceId: open.workspaceId, sessionId: open.sessionId })
      return
    }
    const link = this.links.get(deviceId)
    if (!link) throw new Error('That computer isn’t paired, or its address isn’t known.')
    this.joining = { id: deviceId, name: this.nameOf(deviceId) }
    this.changed()
    try {
      await link.requestControl()
    } catch (err) {
      if (err instanceof ControlRefused) throw new Error(refusalText(this.deps.t(), err.reason, this.nameOf(deviceId), link.version))
      throw err
    } finally {
      if (this.joining?.id === deviceId) this.joining = null
      this.changed()
    }
    const previous = this.viewing()
    if (previous && previous !== link) previous.release()
    this.viewingId = deviceId
    this.lost = false
    this.changed()
    this.deps.reloadWindow()
    if (open) this.deps.afterReload({ type: 'navigate', workspaceId: open.workspaceId, sessionId: open.sessionId })
  }

  /** Back to this computer, and say why. `reload` false: the window is loading already (it asked for a snapshot). */
  leave(reason: LeftReason, reload = true): void {
    if (!this.viewingId) return
    const name = this.nameOf(this.viewingId)
    if (reason !== 'unpaired') this.viewing()?.release()
    this.viewingId = null
    this.lost = false
    this.changed()
    if (!reload) return this.deps.broadcast({ type: 'computer-left', name, reason })
    this.deps.reloadWindow()
    this.deps.afterReload({ type: 'computer-left', name, reason })
  }

  /** The window loaded while the link is down: show this computer instead of nothing. Returns whether it fell back. */
  fallBackIfDown(): boolean {
    const link = this.viewing()
    if (!this.viewingId || (link?.connected && link.mode === 'control')) return false
    this.leave('unreachable', false)
    return true
  }

  retry(deviceId: string): void {
    this.links.get(deviceId)?.retryNow()
  }

  /** This computer's own state changed: the chip's count for it may have too. */
  localChanged(): void {
    if (!sameSummary(this.lastSelf, this.deps.localSummary())) this.changed()
  }

  /** Someone controlling this one, or asking to, changed. */
  hostChanged(): void {
    this.changed()
  }

  private changed(): void {
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.deps.broadcast({ type: 'computers', view: this.view_() })
    }, CHANGED_MS)
    this.changedTimer.unref?.()
  }

  /** What the computer chip shows. */
  view_(): ComputersView {
    const self = this.deps.self()
    this.lastSelf = this.deps.localSummary()
    const computers: ComputerRow[] = this.deps.paired().map((d) => {
      const link = this.links.get(d.id)
      if (!link) return { id: d.id, name: d.name, status: 'unknown' }
      return { id: d.id, name: d.name, platform: link.platform, status: link.status, summary: link.status === 'online' ? link.summary : undefined, version: link.version }
    })
    const viewingLink = this.viewing()
    const joiningLink = this.joining ? this.links.get(this.joining.id) : undefined
    return {
      self: { id: self.id, name: self.name, platform: this.deps.platform, summary: this.lastSelf },
      computers,
      viewing: this.viewingId ? { id: this.viewingId, name: this.nameOf(this.viewingId), state: viewingLink?.waiting ? 'waiting' : this.lost ? 'lost' : 'connected' } : null,
      joining: this.joining ? { ...this.joining, waiting: Boolean(joiningLink?.waiting) } : null,
      controllers: this.deps.host.controllers(),
      requests: this.deps.host.requests()
    }
  }

  close(): void {
    for (const link of this.links.values()) link.stop()
    this.links.clear()
    if (this.changedTimer) clearTimeout(this.changedTimer)
  }
}

/** Why switching to a computer didn't work, as the computer chip's error says it. */
function refusalText(t: TFunction, reason: ControlError, name: string, version?: string): string {
  switch (reason) {
    case 'denied':
      return t('computers.refused.denied', { name })
    case 'timeout':
      return t('computers.refused.timeout', { name })
    case 'off':
      return t('computers.refused.off', { name })
    case 'mismatch':
      return version ? t('computers.refused.version', { name, version }) : t('computers.refused.versionUnknown', { name })
    default:
      return t('computers.refused.unreachable', { name })
  }
}
