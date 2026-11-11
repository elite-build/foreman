// When a sign-in starts waiting, the person at the computer hears of it (docs/agent-access.md §6, step 4): a system
// notification whose action opens Settings at Agents on this computer, at most one a minute however many sign-ins start.
import type { AgentAccessPending } from '../../shared/agentAccess'

export const WAITING_NOTICE_GAP_MS = 60_000

export class WaitingNotices {
  private seen = new Set<string>()
  private last = Number.NEGATIVE_INFINITY

  constructor(private now: () => number = Date.now) {}

  /**
   * The sign-in to tell the person about, given what waits now: the newest one that wasn't waiting at the last look,
   * unless a notice went out less than a minute ago. Null when there is nothing to say.
   */
  take(pending: readonly AgentAccessPending[]): AgentAccessPending | null {
    const fresh = pending.filter((p) => !this.seen.has(p.id))
    this.seen = new Set(pending.map((p) => p.id))
    if (!fresh.length) return null
    const now = this.now()
    if (now - this.last < WAITING_NOTICE_GAP_MS) return null
    this.last = now
    return fresh.reduce((a, b) => (b.expiresAt > a.expiresAt ? b : a))
  }
}
