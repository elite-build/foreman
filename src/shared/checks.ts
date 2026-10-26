// Pure rules for recorded checks: staleness, and the one evidence row's wording.
// Passing checks are evidence of what was run, never "verified" or "ready".
import { createT, type PlainKey, type TFunction } from './i18n'
import type { CheckFingerprint, CheckResult, CheckRow, CheckStatus } from './types'

const enT = createT('en')

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000

/** A result is stale when what it ran against differs from what is there now. */
export function isStale(recorded: CheckFingerprint, current: CheckFingerprint): boolean {
  return recorded.tree !== current.tree || recorded.command !== current.command || recorded.source !== current.source
}

/** Statuses that count as the command failing (as opposed to being stopped). */
export const FAILED_STATUSES: readonly CheckStatus[] = ['failed', 'timeout', 'error']

export const isFailure = (result: CheckResult): boolean => FAILED_STATUSES.includes(result.status)

export type ChecksTone = 'ok' | 'bad' | 'warn' | 'running' | 'idle'

export interface ChecksSummary {
  tone: ChecksTone
  text: string
}

/**
 * The evidence row's text. `comments` is the number of open review comments,
 * given only when a pull request exists and the count is known.
 */
export function summarizeChecks(rows: CheckRow[], opts: { running: boolean; comments?: number | null }, t: TFunction = enT): ChecksSummary {
  const append = (text: string) => {
    const n = opts.comments
    return n === null || n === undefined ? text : `${text} · ${t('checks.summary.commentsOpen', { count: n })}`
  }
  if (opts.running) return { tone: 'running', text: append(t('checks.summary.running')) }
  const recorded = rows.filter((r) => r.result)
  if (!recorded.length) return { tone: 'idle', text: append(t('checks.summary.notRun')) }
  const failed = recorded.filter((r) => isFailure(r.result!))
  if (rows.some((r) => r.stale)) return { tone: 'warn', text: append(failed.length ? t('checks.summary.staleFailed', { count: failed.length }) : t('checks.summary.stale')) }
  if (failed.length) {
    const names = failed.length > 2 ? `${failed[0].name}, ${failed[1].name} +${failed.length - 2}` : failed.map((r) => r.name).join(', ')
    return { tone: 'bad', text: append(t('checks.summary.failed', { failed: failed.length, count: rows.length, names })) }
  }
  if (recorded.some((r) => r.result!.status === 'interrupted')) return { tone: 'warn', text: append(t('checks.summary.interrupted')) }
  if (recorded.some((r) => r.result!.status === 'cancelled')) return { tone: 'warn', text: append(t('checks.summary.cancelled')) }
  return { tone: 'ok', text: append(t('checks.summary.passed')) }
}

/** "2.3s", "1m 5s". */
export function durationText(ms: number, t: TFunction = enT): string {
  const s = ms / 1000
  if (s < 10) return t('checks.duration.seconds', { s: s.toFixed(1) })
  const whole = Math.round(s)
  return whole < 60 ? t('checks.duration.seconds', { s: whole }) : t('checks.duration.minutes', { m: Math.floor(whole / 60), s: whole % 60 })
}

/** The short fingerprint shown in the expanded row: the tree and command hashes. */
export function fingerprintText(fp: CheckFingerprint, t: TFunction = enT): string {
  return t('checks.fingerprint', { tree: fp.tree.slice(0, 7), command: fp.command.slice(0, 7), source: fp.source === 'shared' ? 'settings.toml' : t('checks.fingerprint.thisComputer') })
}

export const STATUS_TEXT: Record<CheckStatus, PlainKey> = {
  running: 'checks.status.running',
  passed: 'checks.status.passed',
  failed: 'checks.status.failed',
  timeout: 'checks.status.timeout',
  cancelled: 'checks.status.cancelled',
  interrupted: 'checks.status.interrupted',
  error: 'checks.status.error'
}

/** Statuses that say what a command did when it ran to the end. A stopped or interrupted run says nothing. */
const VALID_STATUSES: readonly CheckStatus[] = ['passed', 'failed']

/**
 * Whether an automatic run can be skipped: every configured check has a result
 * that ran to the end against exactly these files and this command. An empty
 * diff doesn't count; only a matching fingerprint does.
 */
export function canSkipAutoRun(rows: CheckRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.result && VALID_STATUSES.includes(r.result.status) && !r.stale)
}
