// One short-lived cache of pull-request lookups, shared by the Git panel's status
// and the CI / review watchers so `gh` is asked once, not once per reader.
// Auth failures and rate limits also pause lookups for a while: every lookup made
// as the same GitHub account, since repos can be linked to different accounts.
import type { Workspace } from '../shared/types'
import { pullRequest, type PrResult } from './github'

export interface PrCacheOptions {
  fetch?: (ws: Workspace) => Promise<PrResult>
  // Who a lookup runs as (a gh account, or '' for the default); failures pause only that identity.
  identity?: (ws: Workspace) => string
  // Settles once identities can be told (gh's active account is known): a lookup waits for it first.
  ready?: () => Promise<unknown>
  now?: () => number
  ttlMs?: number
  authBackoffMs?: number
  rateBackoffMs?: number
  // Told about every answer that says something about the branch's PR (found, or none).
  onResult?: (ws: Workspace, result: PrResult) => void
}

interface Entry {
  key: string
  at: number
  result: PrResult
}

export class PrCache {
  private entries = new Map<string, Entry>()
  private inflight = new Map<string, Promise<PrResult>>()
  // The failure that paused lookups, and until when, per identity.
  private paused = new Map<string, { until: number; result: PrResult }>()
  private opts: Required<Omit<PrCacheOptions, 'onResult' | 'ready'>> & Pick<PrCacheOptions, 'onResult' | 'ready'>

  constructor(options: PrCacheOptions = {}) {
    this.opts = {
      fetch: options.fetch ?? ((ws) => pullRequest(ws)),
      identity: options.identity ?? (() => ''),
      now: options.now ?? Date.now,
      ttlMs: options.ttlMs ?? 15_000,
      authBackoffMs: options.authBackoffMs ?? 5 * 60_000,
      rateBackoffMs: options.rateBackoffMs ?? 5 * 60_000,
      ready: options.ready,
      onResult: options.onResult
    }
  }

  private key(ws: Workspace): string {
    return `${ws.branch}|${ws.pullRequest ? `${ws.pullRequest.repo}#${ws.pullRequest.number}` : ''}|${this.opts.identity(ws)}`
  }

  /** The PR for a workspace: a recent answer if there is one, else a fresh lookup (unless paused by a failure). */
  get(ws: Workspace, options: { fresh?: boolean } = {}): Promise<PrResult> {
    const ready = this.opts.ready?.()
    return ready ? ready.then(() => this.lookup(ws, options), () => this.lookup(ws, options)) : this.lookup(ws, options)
  }

  private lookup(ws: Workspace, options: { fresh?: boolean }): Promise<PrResult> {
    const key = this.key(ws)
    const entry = this.entries.get(ws.id)
    if (!options.fresh && entry && entry.key === key && this.opts.now() - entry.at < this.opts.ttlMs) return Promise.resolve(entry.result)
    const paused = this.paused.get(this.opts.identity(ws))
    if (paused && this.opts.now() < paused.until) return Promise.resolve(paused.result)
    const requestKey = `${ws.id}|${key}`
    const identity = this.opts.identity(ws)
    const pending = this.inflight.get(requestKey)
    if (pending) return pending
    const lookup = this.opts.fetch(ws).then(
      (result) => {
        // A response belongs to the account and branch that started it. An old lookup must
        // neither publish data nor pause the new account after a repository switches.
        if (this.key(ws) === key) this.settle(ws, key, identity, result)
        return result
      },
      (err): PrResult => ({ kind: 'unavailable', message: err instanceof Error ? err.message : String(err) })
    )
    this.inflight.set(requestKey, lookup)
    void lookup.finally(() => this.inflight.delete(requestKey))
    return lookup
  }

  private settle(ws: Workspace, key: string, identity: string, result: PrResult): void {
    if (result.kind === 'auth-error') this.paused.set(identity, { until: this.opts.now() + this.opts.authBackoffMs, result })
    else if (result.kind === 'unavailable' && result.rateLimited) this.paused.set(identity, { until: this.opts.now() + this.opts.rateBackoffMs, result })
    else {
      if (result.kind === 'ok' || result.kind === 'no-pr') this.paused.delete(identity)
      this.entries.set(ws.id, { key, at: this.opts.now(), result })
      this.opts.onResult?.(ws, result)
    }
  }

  /** Another reader of GitHub (review threads) hit a failure that should pause everyone using the same identity as `ws`. */
  pause(kind: 'auth-error' | 'rate-limit', message: string, ws?: Workspace): void {
    const result: PrResult = kind === 'auth-error' ? { kind, message } : { kind: 'unavailable', message, rateLimited: true }
    this.paused.set(ws ? this.opts.identity(ws) : '', { until: this.opts.now() + (kind === 'auth-error' ? this.opts.authBackoffMs : this.opts.rateBackoffMs), result })
  }

  /** Forget a workspace's answer (after an action that changes the PR). */
  invalidate(workspaceId: string): void {
    this.entries.delete(workspaceId)
  }

  /** The token or login changed: try again right away. */
  resume(): void {
    this.paused.clear()
  }
}
