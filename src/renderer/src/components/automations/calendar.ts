// The Automations week: which runs fall in it, where each sits, and side-by-side lanes when
// runs overlap. Times are this computer's local time.
import { nextRuns } from '../../../../shared/schedule'
import type { Occurrence, Schedule } from '../../../../shared/types'

export const DAY_MS = 86_400_000
// Planned runs per schedule to look at: enough for an hourly schedule's whole week.
const MAX_PLANNED = 7 * 24 + 1
// Runs shorter than this still get a readable block.
const MIN_MINUTES = 20

export interface CalendarBlock {
  id: string
  scheduleId: string
  start: number
  minutes: number
  // Planned (future) or a recorded run.
  kind: 'planned' | 'run'
  occurrence?: Occurrence
  // 0-based day of the week (Monday = 0).
  day: number
  lane: number
  lanes: number
}

/** Local midnight of the Monday `offset` weeks from the one containing `now`. */
export function startOfWeek(now: number, offset = 0): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7)
  return d.getTime()
}

/** The local day a moment falls on, counted from `weekStart`; DST-safe (days aren't always 24h). */
export function dayIndex(at: number, weekStart: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  const start = new Date(weekStart)
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / DAY_MS)
}

export function minuteOfDay(at: number): number {
  const d = new Date(at)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * Every run in the week starting at `weekStart`: recorded runs (skipped ones left out) and,
 * for active schedules, the planned runs still ahead of `now`.
 */
export function weekBlocks(schedules: Schedule[], occurrences: Occurrence[], weekStart: number, now: number): CalendarBlock[] {
  const weekEnd = startOfWeek(weekStart, 1)
  const raw: Omit<CalendarBlock, 'lane' | 'lanes'>[] = []
  const byId = new Map(schedules.map((s) => [s.id, s]))
  for (const o of occurrences) {
    if (o.state === 'skipped') continue
    const start = Date.parse(o.startedAt ?? o.plannedAt)
    if (!(start >= weekStart && start < weekEnd)) continue
    const end = o.endedAt ? Date.parse(o.endedAt) : o.state === 'running' || o.state === 'starting' ? now : start
    const planned = byId.get(o.scheduleId)?.maxMinutes ?? MIN_MINUTES
    const minutes = Math.max(MIN_MINUTES, o.endedAt || o.state === 'running' || o.state === 'starting' ? (end - start) / 60_000 : planned)
    raw.push({ id: `run:${o.id}`, scheduleId: o.scheduleId, start, minutes, kind: 'run', occurrence: o, day: dayIndex(start, weekStart) })
  }
  for (const s of schedules) {
    if (s.state !== 'active') continue
    for (const at of nextRuns(s, Math.max(weekStart, now) - 1, MAX_PLANNED)) {
      if (at >= weekEnd) break
      raw.push({ id: `plan:${s.id}:${at}`, scheduleId: s.id, start: at, minutes: Math.max(MIN_MINUTES, s.maxMinutes), kind: 'planned', day: dayIndex(at, weekStart) })
    }
  }
  return assignLanes(raw)
}

/** Overlapping blocks on a day share its width; each cluster of overlaps gets its own lane count. */
function assignLanes(raw: Omit<CalendarBlock, 'lane' | 'lanes'>[]): CalendarBlock[] {
  const out: CalendarBlock[] = []
  const days = new Map<number, typeof raw>()
  for (const b of raw) days.set(b.day, [...(days.get(b.day) ?? []), b])
  for (const list of days.values()) {
    list.sort((a, b) => a.start - b.start || b.minutes - a.minutes)
    let cluster: CalendarBlock[] = []
    let clusterEnd = -Infinity
    const laneEnds: number[] = []
    const flush = () => {
      const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1))
      for (const b of cluster) b.lanes = lanes
      out.push(...cluster)
      cluster = []
      laneEnds.length = 0
    }
    for (const b of list) {
      const end = b.start + b.minutes * 60_000
      if (b.start >= clusterEnd && cluster.length) flush()
      let lane = laneEnds.findIndex((e) => e <= b.start)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = end
      cluster.push({ ...b, lane, lanes: 1 })
      clusterEnd = Math.max(cluster.length === 1 ? -Infinity : clusterEnd, end)
    }
    if (cluster.length) flush()
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Hours to draw: 06:00–24:00, widened to take in any run outside it. */
export function hourRange(blocks: CalendarBlock[]): { first: number; last: number } {
  let first = 6
  for (const b of blocks) first = Math.min(first, Math.floor(minuteOfDay(b.start) / 60))
  return { first, last: 24 }
}
