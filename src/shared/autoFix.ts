// #5 Auto-fix CI: the rules, pure, so they can be tested without a clock, gh or
// an agent. When CI fails on the watched PR, Foreman may send the failing logs to
// the tab the user approved, once per failure (PR + head SHA + failing checks),
// within a budget, only while the workspace is idle and no other auto-fix runs.
// It stops instead of looping, and never says CI recovered: only the checks do.
import type { AutoFix, AutoFixAttempt, AutoFixStop, CiWatch, TurnOutcome } from './types'

/** The mock's defaults: 2 per head commit, 5 per PR, 20 minutes per fix turn. */
export const AUTO_FIX_BUDGET = { perHead: 2, perPr: 5, maxMinutes: 20 } as const

/** How long after a finished fix Foreman waits to see a new head commit on the PR before it calls it "no new commit". */
export const AUTO_FIX_HEAD_GRACE_MS = 3 * 60_000

// Spent failures kept per workspace; old ones can't come back (their head is gone).
const CONSUMED_KEEP = 100

/** The failure a fix answers: repo#number, head SHA and the sorted failing check names. */
export function autoFixIdentity(pr: string, sha: string, checks: readonly string[]): string {
  return `${pr}@${sha}:${[...new Set(checks)].sort().join('\n')}`
}

/** `consumed` with this identity added, oldest dropped past the cap. */
export function consume(consumed: readonly string[], identity: string): string[] {
  return [...consumed.filter((c) => c !== identity), identity].slice(-CONSUMED_KEEP)
}

/** The attempt still in flight (its turn running, or waiting for a new head), if any. */
export function activeAttempt(autoFix: AutoFix | undefined): AutoFixAttempt | undefined {
  return autoFix?.attempts.find((a) => a.state !== 'done')
}

export function usedOnHead(autoFix: AutoFix, sha: string): number {
  return autoFix.attempts.filter((a) => a.sha === sha).length
}

/** One look at the PR, as auto-fix needs it. */
export interface AutoFixObservation {
  pr: string
  open: boolean
  sha: string
  failing: string[]
}

export interface DispatchGates {
  // No tab running or queued, no checks or setup running, and the workspace is ready.
  idle: boolean
  // No other auto-fix turn is running anywhere in the app.
  slotFree: boolean
  // "Quit when turns finish" is holding new turns back.
  draining: boolean
  // The approved tab, agent, permissions and prompt are all still what they were.
  consentValid: boolean
}

export type DispatchDecision =
  // Nothing new to fix: no failure, already spent, already dealt with by hand, or auto-fix is stopped.
  | { kind: 'none' }
  // A failure to fix, but not now; looked at again on the next poll. Nothing is spent.
  | { kind: 'wait'; why: 'in-flight' | 'draining' | 'slot' | 'busy' }
  | { kind: 'stop'; reason: Extract<AutoFixStop, 'budget' | 'consent'> }
  | { kind: 'dispatch'; identity: string; n: number; of: number }

export function decideDispatch(autoFix: AutoFix, ci: CiWatch | undefined, obs: AutoFixObservation, gates: DispatchGates): DispatchDecision {
  if (autoFix.stopped) return { kind: 'none' }
  if (!obs.open || !obs.sha || !obs.failing.length) return { kind: 'none' }
  const identity = autoFixIdentity(obs.pr, obs.sha, obs.failing)
  if (autoFix.consumed.includes(identity)) return { kind: 'none' }
  // The user already sent this head's failure with Fix CI in…, or dismissed it.
  if (ci?.acked === obs.sha) return { kind: 'none' }
  if (activeAttempt(autoFix)) return { kind: 'wait', why: 'in-flight' }
  const attempts = autoFix.pr === obs.pr ? autoFix.attempts : []
  const onHead = attempts.filter((a) => a.sha === obs.sha).length
  if (onHead >= autoFix.consent.perHead || attempts.length >= autoFix.consent.perPr) return { kind: 'stop', reason: 'budget' }
  if (gates.draining) return { kind: 'wait', why: 'draining' }
  if (!gates.slotFree) return { kind: 'wait', why: 'slot' }
  if (!gates.idle) return { kind: 'wait', why: 'busy' }
  if (!gates.consentValid) return { kind: 'stop', reason: 'consent' }
  return { kind: 'dispatch', identity, n: onHead + 1, of: autoFix.consent.perHead }
}

/** How a fix turn's end leaves auto-fix: stopped, or waiting to see a new head commit. */
export function afterTurn(outcome: TurnOutcome, timedOut: boolean): AutoFixStop | 'waiting' {
  if (outcome === 'completed') return 'waiting'
  if (outcome === 'cancelled') return timedOut ? 'timeout' : 'stopped'
  return 'failed'
}

/** A look at the PR after a finished fix: a new head moves on; the same head past the grace period is "no new commit". */
export function afterFinishedFix(attempt: AutoFixAttempt, headSha: string, now: number): 'new-head' | 'no-commit' | 'wait' {
  if (headSha && headSha !== attempt.sha) return 'new-head'
  const ended = attempt.endedAt ? Date.parse(attempt.endedAt) : now
  return now - ended >= AUTO_FIX_HEAD_GRACE_MS ? 'no-commit' : 'wait'
}

/** The line appended to the CI-failed reason. Never says CI is fixed. */
export interface AutoFixLine {
  // The last fix sent for this failure's head: when, its count on the head, and whether its turn is still going.
  sent?: { at: string; n: number; of: number; running: boolean; sessionId: string }
  stopped?: AutoFixStop
}

export function autoFixLine(autoFix: AutoFix | undefined, failure: { sha: string } | null | undefined): AutoFixLine | null {
  if (!autoFix) return null
  const line: AutoFixLine = {}
  const onHead = failure ? autoFix.attempts.filter((a) => a.sha === failure.sha) : []
  const last = onHead[onHead.length - 1]
  if (last) line.sent = { at: last.at, n: onHead.length, of: autoFix.consent.perHead, running: last.state === 'running', sessionId: last.sessionId }
  if (autoFix.stopped) line.stopped = autoFix.stopped.reason
  return line.sent || line.stopped ? line : null
}
