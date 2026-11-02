// The performance meter (docs/telemetry.md, Layer A): what the main process does, counted where it happens and read
// by `foreman app perf`. Nothing leaves the computer. Counters are integers in a Map; timings add a duration to a
// running total; a sample every few seconds reads the main process's CPU and memory, the event-loop delay (a stall
// on the main thread) and, through an injected reader, every one of the app's processes (main, renderer, GPU). With
// FOREMAN_PERF_LOG set, each sample also goes to one JSON line in userData/logs/perf.jsonl, with the counter deltas.
//
// Electron is reached only through what `start` is given, so this file and its tests never import it.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks'
import type { PerfLogLine, PerfProcess, PerfReport, PerfSample, PerfStall, PerfTiming } from '../shared/perf'

export const SAMPLE_MS = 5_000
/** Ten minutes of samples at SAMPLE_MS. */
export const SAMPLES_KEPT = 120
/** How often the event-loop histogram samples; its readings include this, so it is taken off (an idle loop reads 0). */
export const LOOP_RESOLUTION_MS = 20
/** A sample whose worst event-loop delay reaches this is a stall: the watchdog reports it with what ran meanwhile. */
export const STALL_MS = 500
/** perf.jsonl starts again (the old file kept as perf.jsonl.1) past this. */
export const LOG_MAX_BYTES = 20 * 1024 * 1024

const MB = 1024 * 1024

export interface PerfSources {
  /** Every one of the app's processes (Electron's app.getAppMetrics, mapped). Absent in tests and the CLI. */
  processes?: () => PerfProcess[]
  now?: () => number
  cpuUsage?: () => NodeJS.CpuUsage
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>
  /** The event-loop histogram to read; null: none (tests). Left out: one is started at LOOP_RESOLUTION_MS. */
  loop?: Pick<IntervalHistogram, 'percentile' | 'max' | 'reset' | 'enable' | 'disable'> | null
  /** What a given `loop` histogram's readings include (its sampling interval); 0 when left out. */
  loopResolutionMs?: number
  /** The watchdog: called from `sample` when the interval's worst loop delay reaches `stallMs` (STALL_MS). */
  onStall?: (stall: PerfStall) => void
  stallMs?: number
}

type Deltas = { counters: Record<string, number>; timings: Record<string, PerfTiming> }

type Timing = { count: number; totalMs: number; maxMs: number }

/** The counters that have no cost until read: `count`, `time` and `gauge` are a Map lookup and an add. */
export class PerfMeter {
  private counters = new Map<string, number>()
  private timings = new Map<string, Timing>()
  private gauges = new Map<string, number>()
  private samples: PerfSample[] = []
  private since: number
  private started: number
  private timer: NodeJS.Timeout | null = null
  private lastCpu: { usage: NodeJS.CpuUsage; at: number } | null = null
  private loop: PerfSources['loop'] = null
  private loopResolutionMs = 0
  private sources: PerfSources = {}
  private log: { file: string; bytes: number; maxBytes: number; writing: Promise<void> } | null = null
  // The counters and timings as of the previous sample, for that sample's deltas (the log line and the watchdog).
  private last = { counters: new Map<string, number>(), timings: new Map<string, Timing>() }

  constructor(private now: () => number = Date.now) {
    this.since = now()
    this.started = this.since
  }

  count(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n)
  }

  time(name: string, ms: number): void {
    const t = this.timings.get(name)
    if (t) {
      t.count++
      t.totalMs += ms
      if (ms > t.maxMs) t.maxMs = ms
    } else this.timings.set(name, { count: 1, totalMs: ms, maxMs: ms })
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value)
  }

  /** Runs `fn` and records how long it took under `name`, whether it returns a value or a promise, and whether it throws. */
  timed<T>(name: string, fn: () => T): T {
    const started = performance.now()
    const done = () => this.time(name, performance.now() - started)
    let result: T
    try {
      result = fn()
    } catch (err) {
      done()
      throw err
    }
    if (result instanceof Promise) return result.finally(done) as T
    done()
    return result
  }

  /**
   * Take samples every `intervalMs` from `sources` (the timer never keeps the process alive). Reads the event-loop
   * delay through `sources.loop`, or starts a histogram when it is left out.
   */
  start(sources: PerfSources = {}, intervalMs = SAMPLE_MS): void {
    this.stop()
    this.sources = sources
    if (sources.now) this.now = sources.now
    if (sources.loop === undefined) {
      this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
      this.loopResolutionMs = LOOP_RESOLUTION_MS
    } else {
      this.loop = sources.loop
      this.loopResolutionMs = sources.loopResolutionMs ?? 0
    }
    this.loop?.enable()
    const cpuUsage = sources.cpuUsage ?? (() => process.cpuUsage())
    this.lastCpu = { usage: cpuUsage(), at: this.now() }
    this.timer = setInterval(() => void this.sample(), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.loop?.disable()
    this.loop = null
  }

  /**
   * Also write every sample to `file` (perf.jsonl), one JSON line each, with what changed since the previous line.
   * Past `maxBytes` the file is kept as `.1` and a new one starts.
   */
  async record(file: string, maxBytes = LOG_MAX_BYTES): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const bytes = await stat(file).then((s) => s.size, () => 0)
    // The first line's deltas start here, not at the app's start.
    this.last = { counters: new Map(this.counters), timings: copyTimings(this.timings) }
    this.log = { file, bytes, maxBytes, writing: this.log?.writing ?? Promise.resolve() }
  }

  /** Stop writing samples to the file (the setting went off); sampling goes on. */
  stopRecording(): void {
    this.log = null
  }

  /** The file samples are written to, or null. */
  get recording(): string | null {
    return this.log?.file ?? null
  }

  /** Waits for the last log line to be on disk (tests, and quitting). */
  flushed(): Promise<void> {
    return this.log?.writing ?? Promise.resolve()
  }

  /** One sample now. Returns it; also keeps it (the last SAMPLES_KEPT) and logs it when recording. */
  async sample(): Promise<PerfSample> {
    const at = this.now()
    const cpuUsage = this.sources.cpuUsage ?? (() => process.cpuUsage())
    const memoryUsage = this.sources.memoryUsage ?? (() => process.memoryUsage())
    const usage = cpuUsage()
    let cpuPercent = 0
    if (this.lastCpu) {
      const elapsedMs = at - this.lastCpu.at
      const usedMs = (usage.user - this.lastCpu.usage.user + usage.system - this.lastCpu.usage.system) / 1000
      cpuPercent = elapsedMs > 0 ? Math.round((usedMs / elapsedMs) * 1000) / 10 : 0
    }
    this.lastCpu = { usage, at }
    const memory = memoryUsage()
    const delay = (ns: number) => round(Math.max(0, loopMs(ns) - this.loopResolutionMs))
    const loop = this.loop ? { p50: delay(this.loop.percentile(50)), p99: delay(this.loop.percentile(99)), max: delay(this.loop.max) } : { p50: 0, p99: 0, max: 0 }
    this.loop?.reset()
    let processes: PerfProcess[] = []
    try {
      processes = this.sources.processes?.() ?? []
    } catch {
      // Electron can refuse app metrics while quitting; the sample does without.
    }
    const sample: PerfSample = { at: new Date(at).toISOString(), cpuPercent, rssMb: Math.round(memory.rss / MB), heapUsedMb: Math.round(memory.heapUsed / MB), loop, processes }
    this.samples.push(sample)
    if (this.samples.length > SAMPLES_KEPT) this.samples.splice(0, this.samples.length - SAMPLES_KEPT)
    const deltas = this.deltas()
    if (loop.max >= (this.sources.stallMs ?? STALL_MS) && this.sources.onStall) {
      try {
        this.sources.onStall({ at: sample.at, maxMs: loop.max, p99Ms: loop.p99, ...deltas })
      } catch {
        // The watchdog's listener must never break sampling.
      }
    }
    if (this.log) await this.writeLine(this.log, sample, deltas)
    return sample
  }

  report(): PerfReport {
    const now = this.now()
    const counters = Object.fromEntries([...this.counters].sort((a, b) => b[1] - a[1]))
    const timings = Object.fromEntries([...this.timings].sort((a, b) => b[1].totalMs - a[1].totalMs).map(([k, v]) => [k, roundTiming(v)]))
    return {
      since: new Date(this.since).toISOString(),
      uptimeMs: now - this.started,
      sample: this.samples.at(-1) ?? null,
      samples: [...this.samples],
      counters,
      timings,
      gauges: Object.fromEntries(this.gauges)
    }
  }

  /** Start the counters and timings again; samples and gauges stay. */
  reset(): void {
    this.counters.clear()
    this.timings.clear()
    this.since = this.now()
    this.last = { counters: new Map(), timings: new Map() }
  }

  /** What the counters and timings did since the previous sample; moves the baseline to now. */
  private deltas(): Deltas {
    const counters: Record<string, number> = {}
    for (const [name, value] of this.counters) {
      const delta = value - (this.last.counters.get(name) ?? 0)
      if (delta) counters[name] = delta
    }
    const timings: Record<string, PerfTiming> = {}
    for (const [name, t] of this.timings) {
      const before = this.last.timings.get(name)
      const delta: Timing = { count: t.count - (before?.count ?? 0), totalMs: t.totalMs - (before?.totalMs ?? 0), maxMs: t.maxMs }
      if (delta.count) timings[name] = roundTiming(delta)
    }
    this.last = { counters: new Map(this.counters), timings: copyTimings(this.timings) }
    return { counters, timings }
  }

  private writeLine(log: NonNullable<PerfMeter['log']>, sample: PerfSample, deltas: Deltas): Promise<void> {
    const line: PerfLogLine = { ...sample, ...deltas, gauges: Object.fromEntries(this.gauges) }
    const text = `${JSON.stringify(line)}\n`
    log.writing = log.writing
      .then(async () => {
        if (log.bytes + text.length > log.maxBytes) {
          await rename(log.file, `${log.file}.1`).catch(() => undefined)
          log.bytes = 0
        }
        await appendFile(log.file, text)
        log.bytes += text.length
      })
      .catch(() => undefined)
    return log.writing
  }
}

function copyTimings(timings: Map<string, Timing>): Map<string, Timing> {
  return new Map([...timings].map(([k, v]) => [k, { ...v }]))
}

/** The histogram counts nanoseconds; NaN (nothing recorded yet) reads 0. */
function loopMs(ns: number): number {
  return Number.isFinite(ns) ? ns / 1e6 : 0
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

function roundTiming(t: Timing): PerfTiming {
  return { count: t.count, totalMs: round(t.totalMs), maxMs: round(t.maxMs) }
}

/** The first words of a command's arguments that name what it does: `git rev-parse` → rev-parse, `gh pr view` → pr.view. */
export function commandLabel(args: readonly string[], words = 1): string {
  const named = args.filter((a) => !a.startsWith('-')).slice(0, words)
  return named.length ? named.join('.') : '(none)'
}

export const perf = new PerfMeter()
