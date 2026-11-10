// The one place a call from any client enters the core (docs/server.md, "The dispatcher"): the window over IPC, a paired
// computer over its channel, and later phones and browsers over the socket. It checks the method is one the Api has and
// that the session holds the scope it needs, then calls it, timed by who asked. Arguments pass through as they are: the
// core's methods already treat every caller as untrusted.
import { ApiRefused, holds, METHOD_SCOPES, SIGNAL_SCOPES, type ApiSession } from '../../shared/api'
import { API_METHODS, SIGNAL_METHODS, type Api, type Signals } from '../../shared/types'
import { perf } from '../perf'

export interface ApiDispatcherDeps {
  api: Record<string, (...args: unknown[]) => unknown>
  signals: Record<string, (...args: unknown[]) => void>
  /** The perf name's prefix; by default `ipc` for the window (the name telemetry already uses), `remote` for a computer, `ws` otherwise. */
  perfPrefix?: (session: ApiSession) => string
}

const defaultPrefix = (session: ApiSession) => (session.kind === 'window' ? 'ipc' : session.kind === 'computer' ? 'remote' : 'ws')

const isMethod = (method: string): method is keyof Api => (API_METHODS as readonly string[]).includes(method)
const isSignal = (method: string): method is keyof Signals => (SIGNAL_METHODS as readonly string[]).includes(method)

export class ApiDispatcher {
  constructor(private deps: ApiDispatcherDeps) {}

  /** A call: rejects with 'Unknown API method', an ApiRefused, or whatever the method throws. */
  async invoke(session: ApiSession, method: string, args: unknown[]): Promise<unknown> {
    if (!isMethod(method)) throw new Error('Unknown API method')
    const needed = METHOD_SCOPES[method]
    if (!holds(session.scopes, needed)) throw ApiRefused.lacking(session, needed)
    const { api } = this.deps
    if (typeof api[method] !== 'function') throw new Error(`Unknown method ${method}`)
    const list = Array.isArray(args) ? args : []
    // Every call by who asked and which method, with how long main took to answer (`ipc.getDiff`, `remote.gitStatus`).
    return perf.timed(`${(this.deps.perfPrefix ?? defaultPrefix)(session)}.${method}`, () => api[method](...list))
  }

  /**
   * A signal: fire and forget, so an unknown one or one the session may not send is dropped without a word, as the
   * window's channel always has. Not timed: keystrokes arrive one by one and answer nothing.
   */
  signal(session: ApiSession, method: string, args: unknown[]): void {
    if (!isSignal(method) || !holds(session.scopes, SIGNAL_SCOPES[method])) return
    this.deps.signals[method]?.(...(Array.isArray(args) ? args : []))
  }
}
