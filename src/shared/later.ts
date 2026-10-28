// Save for later: a workspace put away until a day you pick (or with no day). While it waits it is out of sight
// everywhere but the Later view and search, unless something live (an agent asking, or running) brings it into
// Needs you or Working anyway. On its day, triage puts it in Needs you as "Back from Later" until it's opened,
// dismissed or saved for later again.
import type { Triage } from './triage'
import type { Workspace } from './types'

export type LaterChoice = 'tomorrow' | 'in-3-days' | 'next-week' | 'no-date'

export const LATER_CHOICES: readonly LaterChoice[] = ['tomorrow', 'in-3-days', 'next-week', 'no-date']

// Things come back at the start of a working day, in the computer's own time.
const BACK_AT_HOUR = 9

/** When a choice brings the workspace back, from `now`: 9:00 tomorrow, in three days, or next Monday. */
export function laterUntil(choice: LaterChoice, now: number): string | undefined {
  if (choice === 'no-date') return undefined
  const at = new Date(now)
  const days = choice === 'tomorrow' ? 1 : choice === 'in-3-days' ? 3 : (8 - at.getDay()) % 7 || 7
  at.setDate(at.getDate() + days)
  at.setHours(BACK_AT_HOUR, 0, 0, 0)
  return at.toISOString()
}

/** Its day has come. */
export function laterDue(ws: Pick<Workspace, 'later'>, now: number): boolean {
  return Boolean(ws.later?.until && Date.parse(ws.later.until) <= now)
}

/** Waiting in Later: saved, its day not come yet. */
export function waitingLater(ws: Pick<Workspace, 'later'>, now: number): boolean {
  return Boolean(ws.later) && !laterDue(ws, now)
}

/** Out of sight: waiting in Later with nothing live about it. */
export function putAway(t: Triage, now: number): boolean {
  return waitingLater(t.ws, now) && t.bucket !== 'attention' && t.bucket !== 'working'
}

/** The next moment something waiting comes back, to look again then; null when nothing is dated. */
export function nextLaterDue(workspaces: readonly Pick<Workspace, 'later'>[], now: number): number | null {
  const times = workspaces.map((w) => (w.later?.until ? Date.parse(w.later.until) : NaN)).filter((at) => at > now)
  return times.length ? Math.min(...times) : null
}

/** A patch's `later` from outside: null takes it out, otherwise an optional ISO time to come back. */
export function parseLater(value: unknown): { until?: string } | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Later must be null or { until? }')
  const until = (value as { until?: unknown }).until
  if (until === undefined) return {}
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) throw new Error('Later: until must be a date and time')
  return { until: new Date(until).toISOString() }
}
