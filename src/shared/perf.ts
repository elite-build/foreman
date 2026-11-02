// What the performance meter (src/main/perf.ts) reports: the shape `foreman app perf` prints and the lines
// FOREMAN_PERF_LOG writes. Shared so the command and the app can't disagree. See docs/telemetry.md.

/** One of the app's own processes, from Electron's app metrics: main, renderer, GPU or utility. */
export interface PerfProcess {
  type: string
  pid: number
  /** Share of one core since the previous reading, like `ps`. */
  cpuPercent: number
  memoryMb: number
}

/** One look at the main process, taken every few seconds. */
export interface PerfSample {
  /** ISO 8601. */
  at: string
  /** The main process's share of one core since the previous sample. */
  cpuPercent: number
  rssMb: number
  heapUsedMb: number
  /** Event-loop delay over the interval, in milliseconds: a stall on the main thread shows here. */
  loop: { p50: number; p99: number; max: number }
  processes: PerfProcess[]
}

export interface PerfTiming {
  count: number
  totalMs: number
  maxMs: number
}

export interface PerfReport {
  /** When the counters were last started (app start, or the last reset). ISO 8601. */
  since: string
  uptimeMs: number
  /** The latest sample, or null before the first. */
  sample: PerfSample | null
  /** The last samples, oldest first. */
  samples: PerfSample[]
  counters: Record<string, number>
  timings: Record<string, PerfTiming>
  gauges: Record<string, number>
}

/** One line of perf.jsonl: a sample plus what the counters and timings did since the previous line. */
export interface PerfLogLine extends PerfSample {
  counters: Record<string, number>
  timings: Record<string, PerfTiming>
  gauges: Record<string, number>
}

/** A main-thread stall the watchdog saw: the worst event-loop delay in a sample's interval, with what ran meanwhile. */
export interface PerfStall {
  at: string
  maxMs: number
  p99Ms: number
  /** Counter and timing deltas over the interval: the work that was going on when the thread stalled. */
  counters: Record<string, number>
  timings: Record<string, PerfTiming>
}
