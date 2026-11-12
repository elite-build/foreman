// Idle compaction (docs/agents.md 3): the timer, and what makes it stand down.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_COMPACT_LEAD_MS, IdleCompactor, type IdleCompactDeps } from '../src/main/idleCompact'

const MINUTE = 60_000

function setup(over: Partial<Omit<IdleCompactDeps, 'threshold'>> & { threshold?: number } = {}) {
  const run = vi.fn(async (_id: string) => undefined)
  const { threshold, ...deps } = over
  const state = { threshold: threshold ?? 100_000, eligible: true }
  const compactor = new IdleCompactor({
    threshold: () => state.threshold,
    eligible: () => state.eligible,
    run,
    ...deps
  })
  return { compactor, run, state }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('arming', () => {
  it('fires 30 seconds before a five-minute cache expires', () => {
    const { compactor, run } = setup()
    expect(compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })).toBe(5 * MINUTE - IDLE_COMPACT_LEAD_MS)
    vi.advanceTimersByTime(5 * MINUTE - IDLE_COMPACT_LEAD_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledWith('s', undefined)
  })

  it('hands the cap the turn ran under to the compaction', () => {
    const { compactor, run } = setup()
    const cap = { ceiling: 'ask' as const, grantId: 'g', name: 'Claude Code' }
    compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true }, cap })
    vi.advanceTimersByTime(5 * MINUTE)
    expect(run).toHaveBeenCalledWith('s', cap)
  })

  it('reads the one-hour time-to-live when the turn reported it', () => {
    const { compactor, run } = setup()
    expect(compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '1h', warm: true } })).toBe(60 * MINUTE - IDLE_COMPACT_LEAD_MS)
    vi.advanceTimersByTime(59 * MINUTE)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('is off at 0, the default, and stays off for a context under the threshold', () => {
    expect(setup({ threshold: 0 }).compactor.arm({ sessionId: 's', tokens: 900_000, cache: { ttl: '5m', warm: true } })).toBeUndefined()
    const under = setup({ threshold: 100_000 })
    expect(under.compactor.arm({ sessionId: 's', tokens: 99_999, cache: { ttl: '5m', warm: true } })).toBeUndefined()
    expect(under.compactor.armed('s')).toBe(false)
  })

  it('needs the cache to have been warm: a cold cache has nothing to save, and an agent that doesn\'t say never arms it', () => {
    const { compactor } = setup()
    expect(compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: false } })).toBeUndefined()
    expect(compactor.arm({ sessionId: 's', tokens: 150_000 })).toBeUndefined()
  })

  it('a new turn replaces the timer the tab had', () => {
    const { compactor, run } = setup()
    compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    vi.advanceTimersByTime(4 * MINUTE)
    compactor.arm({ sessionId: 's', tokens: 160_000, cache: { ttl: '5m', warm: true } })
    vi.advanceTimersByTime(4 * MINUTE)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('standing down', () => {
  it('typing, queueing, sending or closing the tab cancels it', () => {
    const { compactor, run } = setup()
    compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    expect(compactor.armed('s')).toBe(true)
    compactor.cancel('s')
    expect(compactor.armed('s')).toBe(false)
    vi.advanceTimersByTime(10 * MINUTE)
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing when the tab is no longer one to compact (unattended, a resume armed, a turn running) or the setting was turned off', () => {
    const a = setup()
    a.compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    a.state.eligible = false
    vi.advanceTimersByTime(5 * MINUTE)
    expect(a.run).not.toHaveBeenCalled()

    const b = setup()
    b.compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    b.state.threshold = 0
    vi.advanceTimersByTime(5 * MINUTE)
    expect(b.run).not.toHaveBeenCalled()
  })

  it('tells the owner when sending the compaction fails, and is not left armed', async () => {
    const failed = vi.fn()
    const { compactor } = setup({ run: async () => { throw new Error('nope') }, failed })
    compactor.arm({ sessionId: 's', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(failed).toHaveBeenCalledWith('s', expect.any(Error))
    expect(compactor.armed('s')).toBe(false)
  })

  it('one tab\'s timer is not another\'s', () => {
    const { compactor, run } = setup()
    compactor.arm({ sessionId: 'a', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    compactor.arm({ sessionId: 'b', tokens: 150_000, cache: { ttl: '5m', warm: true } })
    compactor.cancel('a')
    vi.advanceTimersByTime(5 * MINUTE)
    expect(run.mock.calls.map((c) => c[0])).toEqual(['b'])
  })
})
