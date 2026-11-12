// Idle compaction (docs/agents.md 3, Claude Code): a chat left alone with a large context is compacted just before its
// prompt cache expires, so the next message re-sends a summary instead of the whole context. It spends usage (a respawn, a
// resume and one full-context call), which is why it is opt-in (Settings → Agents → Claude Code → Compact idle chats).
//
// This is the timer and its rules. What the compaction is (a `/compact` sent as a message) and whether the tab is still
// eligible when the timer fires are the session service's, passed in.
import type { TurnCap } from '../shared/agentAccess'

/** How long before the cache's time-to-live runs out the compaction starts. */
export const IDLE_COMPACT_LEAD_MS = 30_000

const TTL_MS: Record<'5m' | '1h', number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

export interface IdleCompactDeps {
  /** The setting: compact when the context is over this many tokens; 0 is off. Read when arming and again when the timer fires. */
  threshold(): number
  /** Whether the tab is still one to compact (idle, nothing queued, nobody typing, no resume armed, not unattended). */
  eligible(sessionId: string): boolean
  /** Sends the compaction, under the cap the turn it follows ran under (if any); its result is not awaited here. */
  run(sessionId: string, cap?: TurnCap): Promise<void>
  /** Told when a compaction could not be sent. */
  failed?(sessionId: string, error: unknown): void
}

export interface IdleCompactInput {
  sessionId: string
  /** The chat's context size after its turn, in tokens. */
  tokens: number
  /** The prompt cache the turn's last request left: its time-to-live and whether it touched the cache at all. */
  cache?: { ttl: '5m' | '1h'; warm: boolean }
  /** The #170 cap the turn ran under, which the compaction carries: it is a turn of the same outside caller's chat. */
  cap?: TurnCap
}

export class IdleCompactor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private deps: IdleCompactDeps) {}

  /**
   * After a turn: arms a compaction `IDLE_COMPACT_LEAD_MS` before the cache expires, when the setting is on, the context is
   * over it and the cache was warm. Replaces a timer the tab already had. Returns when it will fire (ms from now), or undefined.
   */
  arm(input: IdleCompactInput): number | undefined {
    this.cancel(input.sessionId)
    const threshold = this.deps.threshold()
    if (threshold <= 0 || input.tokens < threshold) return undefined
    if (!input.cache?.warm) return undefined
    const delay = Math.max(0, TTL_MS[input.cache.ttl] - IDLE_COMPACT_LEAD_MS)
    const timer = setTimeout(() => {
      this.timers.delete(input.sessionId)
      // The setting may have been turned off, and the tab may have been used, since.
      if (this.deps.threshold() <= 0 || !this.deps.eligible(input.sessionId)) return
      this.deps.run(input.sessionId, input.cap).catch((err) => this.deps.failed?.(input.sessionId, err))
    }, delay)
    timer.unref?.()
    this.timers.set(input.sessionId, timer)
    return delay
  }

  /** Anything the person did in the tab (typing, queueing, sending, restoring, closing) or a new turn: no compaction after all. */
  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  armed(sessionId: string): boolean {
    return this.timers.has(sessionId)
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
