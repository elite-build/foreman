import { describe, expect, it } from 'vitest'
import { dayIndex, hourRange, startOfWeek, weekBlocks } from '../src/renderer/src/components/automations/calendar'
import { phoneLabel, phoneStatus } from '../src/renderer/src/components/phone/status'
import type { MobileInfo } from '../src/shared/mobile'
import type { Occurrence, Schedule } from '../src/shared/types'

// Everything here is in this machine's zone, as the calendar draws it.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
// Wednesday 21 October 2026, 10:00.
const NOW = local(2026, 10, 21, 10)

function schedule(patch: Partial<Schedule>): Schedule {
  return {
    id: 's1',
    templateId: 't1',
    templateName: 'Triage',
    repoId: 'r1',
    baseBranch: 'main',
    recurrence: 'daily',
    startDate: '2026-10-01',
    weekdays: [],
    time: '09:00',
    timezone: zone,
    model: 'opus',
    maxMinutes: 30,
    state: 'active',
    consecutiveFailures: 0,
    approved: {} as Schedule['approved'],
    approvedAt: '',
    createdAt: '',
    ...patch
  }
}

const run = (patch: Partial<Occurrence>): Occurrence => ({ id: 'o1', scheduleId: 's1', plannedAt: new Date(local(2026, 10, 20, 9)).toISOString(), state: 'completed', ...patch })

describe('week bounds', () => {
  it('starts on the Monday of the week, at local midnight', () => {
    expect(startOfWeek(NOW)).toBe(local(2026, 10, 19))
    expect(startOfWeek(NOW, 1)).toBe(local(2026, 10, 26))
    expect(startOfWeek(NOW, -1)).toBe(local(2026, 10, 12))
    // Sunday belongs to the week that started six days before.
    expect(startOfWeek(local(2026, 10, 25, 23))).toBe(local(2026, 10, 19))
  })

  it('counts days by the calendar, not by 24-hour steps', () => {
    const start = startOfWeek(NOW)
    expect(dayIndex(local(2026, 10, 19, 0, 1), start)).toBe(0)
    expect(dayIndex(local(2026, 10, 25, 23, 59), start)).toBe(6)
  })
})

describe('week blocks', () => {
  const start = startOfWeek(NOW)

  it('plans only what is still ahead, and records what already ran', () => {
    const blocks = weekBlocks([schedule({})], [run({ startedAt: new Date(local(2026, 10, 20, 9)).toISOString(), endedAt: new Date(local(2026, 10, 20, 9, 12)).toISOString() })], start, NOW)
    const planned = blocks.filter((b) => b.kind === 'planned')
    // Today's 09:00 has passed: Thursday to Sunday remain.
    expect(planned.map((b) => b.day)).toEqual([3, 4, 5, 6])
    expect(planned[0].minutes).toBe(30)
    const ran = blocks.filter((b) => b.kind === 'run')
    expect(ran).toHaveLength(1)
    expect(ran[0].day).toBe(1)
    // A 12-minute run is drawn at the minimum height.
    expect(ran[0].minutes).toBe(20)
  })

  it('leaves out skipped runs, paused schedules and other weeks', () => {
    const blocks = weekBlocks(
      [schedule({ state: 'paused' })],
      [run({ state: 'skipped' }), run({ id: 'o2', plannedAt: new Date(local(2026, 10, 12, 9)).toISOString() })],
      start,
      NOW
    )
    expect(blocks).toEqual([])
  })

  it('fills a whole week of an hourly schedule', () => {
    const hourly = schedule({ recurrence: 'hourly', startDate: '2026-10-21', time: '00:15', maxMinutes: 10 })
    const blocks = weekBlocks([hourly], [], start, NOW)
    // Every elapsed hour from 10:15 Wednesday to the end of Sunday (a DST day has 23 or 25).
    const first = local(2026, 10, 21, 10, 15)
    expect(blocks[0].start).toBe(first)
    expect(blocks).toHaveLength(Math.ceil((startOfWeek(NOW, 1) - first) / 3_600_000))
    expect(blocks.slice(1).every((b, n) => b.start - blocks[n].start === 3_600_000)).toBe(true)
  })

  it('puts overlapping runs side by side', () => {
    const a = schedule({ id: 'a', time: '14:00', maxMinutes: 60 })
    const b = schedule({ id: 'b', time: '14:30', maxMinutes: 30 })
    const c = schedule({ id: 'c', time: '16:00', maxMinutes: 30 })
    const thursday = weekBlocks([a, b, c], [], start, NOW).filter((x) => x.day === 3)
    const byId = Object.fromEntries(thursday.map((x) => [x.scheduleId, x]))
    expect([byId.a.lane, byId.a.lanes]).toEqual([0, 2])
    expect([byId.b.lane, byId.b.lanes]).toEqual([1, 2])
    // Starts after both end: full width again.
    expect([byId.c.lane, byId.c.lanes]).toEqual([0, 1])
  })

  it('widens the hours to show an early run', () => {
    const early = weekBlocks([schedule({ time: '04:30' })], [], start, NOW)
    expect(hourRange(early)).toEqual({ first: 4, last: 24 })
    expect(hourRange([])).toEqual({ first: 6, last: 24 })
  })
})

describe('phone pill', () => {
  const info = (patch: Partial<MobileInfo> = {}): MobileInfo => ({
    enabled: false,
    url: '',
    port: 47632,
    lan: { enabled: false, address: '', port: 47633, candidates: [] },
    devices: [],
    ...patch
  })

  it('says what to do next', () => {
    expect([phoneStatus(null), phoneLabel(null)]).toEqual(['loading', 'Phone'])
    expect([phoneStatus(info()), phoneLabel(info())]).toEqual(['off', 'Connect phone'])
    const lan = info({ lan: { enabled: true, address: '192.168.1.4', port: 47633, candidates: [] } })
    expect([phoneStatus(lan), phoneLabel(lan)]).toEqual(['ready', 'Connect phone'])
    const pending = info({ pending: { id: 'p', name: 'iPhone', code: '1234', mode: 'lan', expiresAt: 0 } })
    expect([phoneStatus(pending), phoneLabel(pending)]).toEqual(['pending', 'Confirm pairing'])
  })

  it('names the paired phone, or counts them', () => {
    const one = info({ devices: [{ id: 'd1', name: 'Yatin’s iPhone', pairedAt: '' }] })
    expect([phoneStatus(one), phoneLabel(one)]).toEqual(['paired', 'Yatin’s iPhone'])
    const two = info({ devices: [{ id: 'd1', name: 'A', pairedAt: '' }, { id: 'd2', name: 'B', pairedAt: '' }] })
    expect(phoneLabel(two)).toBe('2 phones')
  })
})
