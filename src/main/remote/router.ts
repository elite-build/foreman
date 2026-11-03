// Where the window's calls and this computer's events go while the window shows another computer (shared/remote.ts).
// main/index.ts asks this for every call, signal and event; with no other computer shown, everything stays here.
import path from 'node:path'
import type { TFunction } from '../../shared/i18n'
import { LOCAL_METHODS, LOCAL_SIGNALS, localWhileViewing, UNAVAILABLE_REMOTELY } from '../../shared/remote'
import type { Api, MainEvent, Signals } from '../../shared/types'

export interface RouterDeps {
  remote: {
    viewing(): { signal(method: string, args: unknown[]): void } | null
    readonly viewingName: string | null
    call(method: string, args: unknown[]): Promise<unknown>
    fallBackIfDown(): boolean
  }
  local: Record<string, (...args: unknown[]) => unknown>
  localSignals: Record<string, (...args: unknown[]) => void>
  selfName(): string
  readFile(file: string): Promise<Buffer>
  t(): TFunction
}

/** A local event on its way to the window: send this, drop it, or switch the window back to this computer first. */
export type WindowRoute = { send: MainEvent } | { drop: true } | { leave: { workspaceId?: string; sessionId?: string } }

export class RemoteRouter {
  constructor(private deps: RouterDeps) {}

  /** A call from the window. */
  async invoke(method: keyof Api, args: unknown[]): Promise<unknown> {
    const { remote, local } = this.deps
    if (!remote.viewing() || LOCAL_METHODS.has(method)) return local[method](...args)
    // The window loaded (or was reloaded) while the link is down: show this computer rather than nothing.
    if (method === 'getSnapshot' && remote.fallBackIfDown()) return local[method](...args)
    if (UNAVAILABLE_REMOTELY.has(method)) throw new Error(this.deps.t()('computers.unavailable', { name: remote.viewingName ?? '' }))
    // Files dropped on the composer are on this computer: their contents travel, not their paths.
    if (method === 'attachFiles') {
      const [workspaceId, paths] = args as [string, string[]]
      const out: unknown[] = []
      for (const file of paths) out.push(await remote.call('attachData', [workspaceId, path.basename(file), (await this.deps.readFile(file)).toString('base64')]))
      return out
    }
    return remote.call(method, args)
  }

  /** A signal from the window (terminal keystrokes, resizes). */
  signal(method: keyof Signals, args: unknown[]): void {
    const link = this.deps.remote.viewing()
    if (!link || LOCAL_SIGNALS.has(method)) return void this.deps.localSignals[method]?.(...args)
    link.signal(method, args)
  }

  /** One of this computer's own events, on its way to the window. */
  toWindow(event: MainEvent): WindowRoute {
    if (!this.deps.remote.viewing()) return { send: event }
    // Something here needs you: say so in the window, which shows the other computer.
    if (event.type === 'notify') {
      return { send: { type: 'computer-notify', computerId: null, computerName: this.deps.selfName(), workspaceId: event.workspaceId, sessionId: event.sessionId, title: event.title, body: event.body } }
    }
    // The tray, a notification or `foreman run --open` points at a workspace here: show this computer again first.
    if (event.type === 'navigate') return { leave: { workspaceId: event.workspaceId, sessionId: event.sessionId } }
    if (event.type === 'show-workspace') return { leave: { workspaceId: event.workspaceId } }
    return localWhileViewing(event) ? { send: event } : { drop: true }
  }
}
