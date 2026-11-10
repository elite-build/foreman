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
  /**
   * The perf name's prefix; by default `ipc` for the window (the name telemetry already uses), `remote` for a computer,
   * `ws` otherwise. Null: not timed here, because the caller times the call itself (the window's IPC handler, which also
   * times the calls it routes to another computer).
   */
  perfPrefix?: (session: ApiSession) => string | null
}

const defaultPrefix = (session: ApiSession) => (session.kind === 'window' ? 'ipc' : session.kind === 'computer' ? 'remote' : 'ws')

/**
 * What a session without admin is not told of a pairing in progress: the sign-in link (it carries the one-time secret),
 * the six digits a device signing in shows, and the code a paired computer would type. Each would let a session that
 * may only watch or operate sign in another device, or pair a computer, which then holds admin, while the person here
 * is pairing. Who is paired, and that a pairing is under way, stay readable.
 */
const PAIRING_SECRETS: Partial<Record<keyof Api, readonly string[]>> = { mobileInfo: ['pairing', 'pending'], devicesInfo: ['pairing'] }

function withoutPairingSecrets(method: keyof Api, session: ApiSession, value: unknown): unknown {
  const fields = PAIRING_SECRETS[method]
  if (!fields || holds(session.scopes, 'admin') || !value || typeof value !== 'object') return value
  const copy = { ...(value as Record<string, unknown>) }
  for (const field of fields) delete copy[field]
  return copy
}

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
    const prefix = (this.deps.perfPrefix ?? defaultPrefix)(session)
    const value = await (prefix === null ? api[method](...list) : perf.timed(`${prefix}.${method}`, () => api[method](...list)))
    return withoutPairingSecrets(method, session, value)
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
