// Limits that recover (docs/agents.md 7.1): what the agents' own events say about each account's usage windows, kept per
// account, pooled into one sentence, and what a failed Codex turn reads its reset time from.
import { describe, expect, it } from 'vitest'
import {
  accountState,
  blockedUntil,
  claudeWindow,
  claudeWindows,
  codexLimit,
  codexWindows,
  codexWindowsFromRead,
  continueAccounts,
  continueOptions,
  limitFromWindows,
  limitsOf,
  mergeWindows,
  parseAccountLimits,
  pooled,
  reportsLimitWindows,
  settleWindow,
  tightestFirst,
  waitingOnLimit,
  windowState,
  withWindows,
  type AccountLimits,
  type LimitWindow
} from '../src/shared/limits'
import { staticCapabilities } from '../src/shared/agentCatalog'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const IN_2H = NOW + 2 * 3_600_000
const sec = (ms: number) => Math.floor(ms / 1000)
const iso = (ms: number) => new Date(ms).toISOString()

describe('records', () => {
  it('Claude and Codex report windows and reset times; the others say so', () => {
    expect(['claude', 'codex'].every((a) => reportsLimitWindows(a) && staticCapabilities(a)?.usage.resetTime)).toBe(true)
    expect(['cursor', 'opencode'].some((a) => reportsLimitWindows(a))).toBe(false)
  })
})

describe('state', () => {
  it('is blocked at the limit or when refused, a warning from 80%, else ok', () => {
    expect([windowState(undefined), windowState(79), windowState(80), windowState(99), windowState(100), windowState(10, true)]).toEqual(['ok', 'ok', 'warning', 'warning', 'blocked', 'blocked'])
  })
})

describe('Claude rate_limit_event', () => {
  it('maps each limit type to its window', () => {
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.22, resetsAt: sec(IN_2H) })).toEqual({ kind: 'session', usedPercent: 22, resetsAt: iso(IN_2H), state: 'ok' })
    expect(claudeWindow({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.84, resetsAt: sec(IN_2H) })).toMatchObject({ kind: 'weekly', usedPercent: 84, state: 'warning' })
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.5 })).toEqual({ kind: 'model-weekly', label: 'Opus', usedPercent: 50, state: 'ok' })
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'seven_day_sonnet', utilization: 0.1 })).toMatchObject({ kind: 'model-weekly', label: 'Sonnet' })
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'seven_day_overage_included', utilization: 0.1 })).toMatchObject({ kind: 'weekly' })
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'overage', utilization: 0.1 })).toMatchObject({ kind: 'other', label: 'overage' })
  })

  it('a rejected event is blocked at 100% even with no figure, and a warning status without one is a warning', () => {
    expect(claudeWindow({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(IN_2H) })).toEqual({ kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' })
    expect(claudeWindow({ status: 'allowed_warning', rateLimitType: 'five_hour' })).toEqual({ kind: 'session', state: 'warning' })
  })

  it('reads a figure above 1 as a percentage, accepts milliseconds, and ignores a type it doesn’t know', () => {
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'five_hour', utilization: 42, resetsAt: IN_2H })).toMatchObject({ usedPercent: 42, resetsAt: iso(IN_2H) })
    expect(claudeWindow({ status: 'allowed', rateLimitType: 'something_new' })).toBeUndefined()
    expect(claudeWindow(undefined)).toBeUndefined()
  })

  it('reads every window from unifiedWindows, the shape Claude Code 2.1.301 sends, with the status on its own type only', () => {
    const info = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(IN_2H), unifiedWindows: { five_hour: { utilization: 1, resetsAt: sec(IN_2H) }, seven_day: { utilization: 0.02, resetsAt: sec(IN_2H + 86_400_000) } } }
    expect(claudeWindows(info)).toEqual([
      { kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' },
      { kind: 'weekly', usedPercent: 2, resetsAt: iso(IN_2H + 86_400_000), state: 'ok' }
    ])
    expect(claudeWindows({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.22 })).toEqual([{ kind: 'session', usedPercent: 22, state: 'ok' }])
    expect(claudeWindows(undefined)).toEqual([])
  })
})

describe('Codex rate-limit snapshot', () => {
  const snapshot = { limitId: 'codex', primary: { usedPercent: 54, windowDurationMins: 300, resetsAt: sec(IN_2H) }, secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: sec(IN_2H + 86_400_000) } }

  it('names the primary and secondary windows by their duration', () => {
    expect(codexWindows(snapshot)).toEqual([
      { kind: 'session', usedPercent: 54, resetsAt: iso(IN_2H), state: 'ok' },
      { kind: 'weekly', usedPercent: 18, resetsAt: iso(IN_2H + 86_400_000), state: 'ok' }
    ])
  })

  it('is blocked at 100%, with an odd duration named by its length, and nothing for a missing window', () => {
    expect(codexWindows({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: sec(IN_2H) }, secondary: null })).toEqual([{ kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' }])
    expect(codexWindows({ primary: { usedPercent: 10, windowDurationMins: 1440, resetsAt: null } })).toEqual([{ kind: 'other', label: '1440 min', usedPercent: 10, state: 'ok' }])
    expect(codexWindows(null)).toEqual([])
  })

  it('a read adds the other buckets that name a model, as that model’s windows', () => {
    const read = codexWindowsFromRead({ rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot, spark: { limitId: 'spark', limitName: 'GPT-6 Spark', primary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: null } } } })
    expect(read.map((w) => [w.kind, w.label])).toEqual([['session', undefined], ['weekly', undefined], ['model-weekly', 'GPT-6 Spark']])
  })
})

describe('keeping windows', () => {
  const session: LimitWindow = { kind: 'session', usedPercent: 20, state: 'ok' }
  const weekly: LimitWindow = { kind: 'weekly', usedPercent: 40, state: 'ok' }

  it('a window replaces the one of its kind and label; the others stay', () => {
    expect(mergeWindows([session, weekly], [{ kind: 'session', usedPercent: 90, state: 'warning' }])).toEqual([{ kind: 'session', usedPercent: 90, state: 'warning' }, weekly])
    expect(mergeWindows([], [{ kind: 'model-weekly', label: 'Opus', state: 'ok' }, { kind: 'model-weekly', label: 'Sonnet', state: 'ok' }])).toHaveLength(2)
  })

  it('is kept per account, and unchanged windows leave the list as it was', () => {
    let list: AccountLimits[] = []
    list = withWindows(list, 'claude', undefined, [session], NOW)
    list = withWindows(list, 'claude', 'ai-work', [weekly], NOW)
    expect(list.map((l) => [l.agent, l.instance])).toEqual([['claude', undefined], ['claude', 'ai-work']])
    expect(limitsOf(list, 'claude', 'ai-work')?.windows).toEqual([weekly])
    expect(withWindows(list, 'claude', undefined, [session], NOW + 1000)).toBe(list)
    // A read replaces the account's windows, a notification merges.
    expect(limitsOf(withWindows(list, 'claude', undefined, [weekly], NOW, true), 'claude', undefined)?.windows).toEqual([weekly])
    expect(limitsOf(withWindows(list, 'claude', undefined, [weekly], NOW), 'claude', undefined)?.windows).toEqual([session, weekly])
  })

  it('a window whose reset time has passed says nothing about now', () => {
    const blocked: LimitWindow = { kind: 'session', usedPercent: 100, resetsAt: iso(NOW - 1000), state: 'blocked' }
    expect(settleWindow(blocked, NOW)).toEqual({ kind: 'session', state: 'ok' })
    expect(accountState({ windows: [blocked] }, NOW)).toBe('ok')
    expect(settleWindow({ ...blocked, resetsAt: iso(NOW + 1000) }, NOW).state).toBe('blocked')
  })

  it('sorts tightest first and reads when a blocked account can work again (the latest of its blocked windows)', () => {
    const windows: LimitWindow[] = [weekly, { kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' }, { kind: 'weekly', label: 'x', usedPercent: 85, state: 'warning' }]
    expect(tightestFirst(windows).map((w) => w.state)).toEqual(['blocked', 'warning', 'ok'])
    expect(blockedUntil({ windows }, NOW)).toBe(IN_2H)
    expect(blockedUntil({ windows: [{ kind: 'session', state: 'blocked' }] }, NOW)).toBeUndefined()
  })

  it('reads back what state.json held, dropping what is malformed', () => {
    const good: AccountLimits = { agent: 'claude', windows: [session], updatedAt: iso(NOW) }
    expect(parseAccountLimits([good, { agent: 'claude' }, 'x', { ...good, windows: [{ kind: 'nope', state: 'ok' }, session] }, { ...good, updatedAt: 'not a date' }])).toEqual([good, good])
    expect(parseAccountLimits(undefined)).toEqual([])
  })
})

describe('pooled', () => {
  const account = (label: string, instance: string | undefined, windows: LimitWindow[]) => ({ label, instance, limits: windows.length ? ({ agent: 'claude', instance, windows, updatedAt: iso(NOW) } as AccountLimits) : undefined })

  it('puts the tightest account first and says who is blocked until when', () => {
    const view = pooled([account('Work', 'ai-w', [{ kind: 'session', usedPercent: 22, state: 'ok' }]), account('Personal', undefined, [{ kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' }])], NOW)
    expect(view).toMatchObject({ tone: 'error', blocked: 1 })
    expect(view.accounts.map((a) => [a.label, a.state, a.until])).toEqual([['Personal', 'blocked', IN_2H], ['Work', 'ok', undefined]])
  })

  it('is a warning when one is close, off when none reported, ok otherwise', () => {
    expect(pooled([account('A', undefined, [{ kind: 'weekly', usedPercent: 85, state: 'warning' }])], NOW).tone).toBe('warn')
    expect(pooled([account('A', undefined, []), account('B', 'x', [])], NOW)).toMatchObject({ tone: 'off', blocked: 0 })
    expect(pooled([account('A', undefined, [{ kind: 'weekly', usedPercent: 5, state: 'ok' }])], NOW).tone).toBe('ok')
  })
})

describe('a Codex turn that failed at a limit', () => {
  const blocked: LimitWindow[] = [{ kind: 'session', usedPercent: 100, resetsAt: iso(IN_2H), state: 'blocked' }, { kind: 'weekly', usedPercent: 30, resetsAt: iso(IN_2H + 5 * 86_400_000), state: 'ok' }]

  it('takes its reset time from the blocked window', () => {
    expect(limitFromWindows(blocked, NOW)).toEqual({ resetAt: iso(IN_2H), source: 'five_hour', timeZone: 'UTC', from: 'event' })
    expect(codexLimit("You've hit your usage limit.", blocked, NOW, 'UTC')).toEqual({ resetAt: iso(IN_2H), source: 'five_hour', timeZone: 'UTC', from: 'event' })
  })

  it('the error’s own time wins; words with no time anywhere are a limit with an unknown reset; a plain failure is none', () => {
    expect(codexLimit('usage limit reached, resets 2:30pm (Europe/London)', blocked, Date.parse('2026-10-22T10:52:00Z'), 'UTC')?.source).toBe('resets 2:30pm (Europe/London)')
    expect(codexLimit("You've hit your usage limit.", [], NOW, 'UTC')).toEqual({})
    expect(codexLimit('Something else broke', [], NOW, 'UTC')).toBeUndefined()
    // A window that is past, or not blocked, gives no time.
    expect(limitFromWindows([{ kind: 'session', state: 'blocked', resetsAt: iso(NOW - 3_600_000) }], NOW)).toBeUndefined()
  })
})

describe('continuing on another account', () => {
  const accounts = [{ label: 'Personal' }, { label: 'Work', instance: 'ai-work' }, { label: 'Side', instance: 'ai-side' }]
  const limits: AccountLimits[] = [
    { agent: 'claude', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: iso(IN_2H) }], updatedAt: iso(NOW) },
    { agent: 'claude', instance: 'ai-work', windows: [{ kind: 'session', usedPercent: 22, state: 'ok' }], updatedAt: iso(NOW) },
    { agent: 'claude', instance: 'ai-side', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: iso(IN_2H) }], updatedAt: iso(NOW) }
  ]

  it('offers an account that reported room, not the current one, not a blocked one, and only where the move rule allows', () => {
    expect(continueAccounts(accounts, undefined, limits, 'claude', NOW, () => true)).toEqual([{ label: 'Work', instance: 'ai-work' }])
    expect(continueAccounts(accounts, undefined, limits, 'claude', NOW, () => false)).toEqual([])
    // One that never reported isn't known to have room.
    expect(continueAccounts(accounts, undefined, limits.slice(0, 1), 'claude', NOW, () => true)).toEqual([])
    // On the account with room, the default (blocked) isn't offered either.
    expect(continueAccounts(accounts, 'ai-work', limits, 'claude', NOW, () => true)).toEqual([])
  })

  it('uses the agent’s move rule and its accounts’ folders', () => {
    const work = { id: 'ai-work', agent: 'claude' as const, label: 'Work', home: 'C:\\work', auth: 'cli' as const }
    const settings = { agentInstances: [work], agentPrefs: {} }
    // The default rule is never, unless the chat has no conversation yet or both accounts share a folder.
    expect(continueOptions({ agent: 'claude', agentSessionId: 'abc' }, settings, limits, NOW, 'Default')).toEqual([])
    expect(continueOptions({ agent: 'claude' }, settings, limits, NOW, 'Default')).toEqual([{ instance: 'ai-work', label: 'Work' }])
    expect(continueOptions({ agent: 'claude', agentSessionId: 'abc' }, { ...settings, agentPrefs: { claude: { moveChats: 'as-text' } } }, limits, NOW, 'Default')).toEqual([{ instance: 'ai-work', label: 'Work' }])
    // An agent without accounts has nowhere to go.
    expect(continueOptions({ agent: 'opencode' }, settings, limits, NOW, 'Default')).toEqual([])
  })
})

describe('waiting on a limit', () => {
  it('is a paused chat whose resume is armed, not missed', () => {
    expect(waitingOnLimit({ lastTurn: { outcome: 'limit' }, limitResume: {} })).toBe(true)
    expect(waitingOnLimit({ lastTurn: { outcome: 'limit' }, limitResume: { missed: true } })).toBe(false)
    expect(waitingOnLimit({ lastTurn: { outcome: 'limit' } })).toBe(false)
    expect(waitingOnLimit({ lastTurn: { outcome: 'error' }, limitResume: {} })).toBe(false)
  })
})
