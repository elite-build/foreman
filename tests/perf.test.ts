// The performance meter (docs/telemetry.md, Layer A): counters, timings, samples, the perf.jsonl lines, the
// `app-perf` method on the socket, and the text `foreman app perf` prints.
import { readFile, stat } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { perfText } from '../src/cli/commands/app'
import { socketPath } from '../src/cli/protocol'
import { startCliServer, type CliHost } from '../src/main/cliServer'
import { commandLabel, LOG_MAX_BYTES, LOOP_RESOLUTION_MS, PerfMeter, SAMPLES_KEPT } from '../src/main/perf'
import type { PerfReport } from '../src/shared/perf'
import { stubHost } from './cliHost'
import { tempDir } from './helpers'

/** A meter on a clock the test moves, with CPU, memory and loop-delay readings it sets. */
function meter() {
  let now = 1_000_000
  let cpu = { user: 0, system: 0 }
  let memory = { rss: 100 * 1024 * 1024, heapUsed: 40 * 1024 * 1024 }
  const loop = { p50: 0, p99: 0, max: 0, resets: 0 }
  const m = new PerfMeter(() => now)
  m.start(
    {
      now: () => now,
      cpuUsage: () => cpu,
      memoryUsage: () => memory,
      loop: { percentile: (p) => (p === 50 ? loop.p50 : loop.p99) * 1e6, get max() { return loop.max * 1e6 }, reset: () => loop.resets++, enable: () => true, disable: () => true },
      processes: () => [{ type: 'Browser', pid: 1, cpuPercent: 3, memoryMb: 150 }, { type: 'Tab', pid: 2, cpuPercent: 12.5, memoryMb: 101 }]
    },
    60_000
  )
  return {
    m,
    advance: (ms: number) => (now += ms),
    burn: (ms: number) => (cpu = { user: cpu.user + ms * 1000, system: cpu.system }),
    setMemory: (rssMb: number) => (memory = { ...memory, rss: rssMb * 1024 * 1024 }),
    setLoop: (p50: number, p99: number, max: number) => Object.assign(loop, { p50, p99, max }),
    loop
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('PerfMeter', () => {
  const meters: PerfMeter[] = []
  afterEach(() => meters.splice(0).forEach((m) => m.stop()))

  it('counts, times and gauges, and reports them busiest first', async () => {
    const { m } = meter()
    meters.push(m)
    m.count('event.chat-append')
    m.count('event.chat-append', 4)
    m.count('event.state')
    m.time('git.status', 12)
    m.time('git.status', 30)
    m.time('gh.pr.view', 400)
    m.gauge('state.bytes', 32_000)
    m.gauge('state.bytes', 33_000)
    expect(m.timed('db.readChat', () => 7)).toBe(7)
    expect(await m.timed('store.save', async () => 'saved')).toBe('saved')
    expect(() => m.timed('db.putItem', () => { throw new Error('boom') })).toThrow('boom')
    await expect(m.timed('ipc.getDiff', () => Promise.reject(new Error('no')))).rejects.toThrow('no')

    const report = m.report()
    expect(Object.keys(report.counters)).toEqual(['event.chat-append', 'event.state'])
    expect(report.counters['event.chat-append']).toBe(5)
    expect(Object.keys(report.timings).slice(0, 2)).toEqual(['gh.pr.view', 'git.status'])
    expect(report.timings['git.status']).toEqual({ count: 2, totalMs: 42, maxMs: 30 })
    // A thrown or rejected call still costs its time.
    for (const name of ['db.readChat', 'store.save', 'db.putItem', 'ipc.getDiff']) expect(report.timings[name].count, name).toBe(1)
    expect(report.gauges).toEqual({ 'state.bytes': 33_000 })
    expect(report.sample).toBeNull()
  })

  it('samples the main process, the event loop and every app process, keeping the last SAMPLES_KEPT', async () => {
    const { m, advance, burn, setMemory, setLoop, loop } = meter()
    meters.push(m)
    advance(10_000)
    burn(2_500)
    setMemory(176)
    setLoop(1.2, 48, 310)
    const sample = await m.sample()
    expect(sample.at).toBe(new Date(1_010_000).toISOString())
    // 2.5 s of CPU over 10 s is a quarter of one core.
    expect(sample.cpuPercent).toBe(25)
    expect(sample.rssMb).toBe(176)
    expect(sample.heapUsedMb).toBe(40)
    expect(sample.loop).toEqual({ p50: 1.2, p99: 48, max: 310 })
    // The histogram starts again for the next interval.
    expect(loop.resets).toBe(1)
    expect(sample.processes.map((p) => p.type)).toEqual(['Browser', 'Tab'])
    expect(m.report().sample).toEqual(sample)

    for (let i = 0; i < SAMPLES_KEPT + 5; i++) {
      advance(5_000)
      await m.sample()
    }
    const report = m.report()
    expect(report.samples).toHaveLength(SAMPLES_KEPT)
    expect(report.samples.at(-1)).toEqual(report.sample)
    // Nothing burned since: idle reads 0, not the first interval's quarter.
    expect(report.sample?.cpuPercent).toBe(0)
  })

  it('reset starts the counters and timings again but keeps the samples and gauges', async () => {
    const { m, advance } = meter()
    meters.push(m)
    m.count('state.flush', 3)
    m.time('git.status', 5)
    m.gauge('git.queue', 2)
    await m.sample()
    advance(1_000)
    m.reset()
    const report = m.report()
    expect(report.counters).toEqual({})
    expect(report.timings).toEqual({})
    expect(report.gauges).toEqual({ 'git.queue': 2 })
    expect(report.samples).toHaveLength(1)
    expect(report.since).toBe(new Date(1_001_000).toISOString())
    expect(report.uptimeMs).toBe(1_000)
  })

  it('writes one JSON line per sample with what changed since the previous line, and starts the file again past the cap', async () => {
    const { m, advance } = meter()
    meters.push(m)
    const file = path.join(await tempDir('foreman-perf-'), 'logs', 'perf.jsonl')
    m.count('event.state', 2)
    m.time('git.status', 10)
    await m.record(file)
    // Counted before recording started: not in the first line's deltas.
    m.count('event.state')
    m.time('git.status', 5)
    m.gauge('state.bytes', 1234)
    await m.sample()
    advance(5_000)
    await m.sample()
    m.count('event.chat-item', 7)
    advance(5_000)
    await m.sample()
    await m.flushed()
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ at: new Date(1_000_000).toISOString(), counters: { 'event.state': 1 }, timings: { 'git.status': { count: 1, totalMs: 5, maxMs: 10 } }, gauges: { 'state.bytes': 1234 } })
    expect(lines[1].counters).toEqual({})
    expect(lines[1].timings).toEqual({})
    expect(lines[2].counters).toEqual({ 'event.chat-item': 7 })
    expect(lines[2].processes).toHaveLength(2)

    // Past the cap (20 MB in the app; a few lines here), the file is kept as .1 and a new one starts.
    const small = new PerfMeter(() => 5)
    meters.push(small)
    const smallFile = path.join(await tempDir('foreman-perf-'), 'perf.jsonl')
    await small.record(smallFile, 600)
    const sizeOf = async (f: string) => (await stat(f).catch(() => ({ size: 0 }))).size
    for (let i = 0; i < 6; i++) await small.sample()
    await small.flushed()
    expect(await sizeOf(`${smallFile}.1`)).toBeGreaterThan(0)
    expect(await sizeOf(smallFile)).toBeLessThanOrEqual(600)
    expect(LOG_MAX_BYTES).toBe(20 * 1024 * 1024)
  })

  it('takes the histogram’s own sampling interval off the loop delay, so an idle loop reads 0', async () => {
    const readings = { p50: 21, p99: 60, max: 300 }
    const m = new PerfMeter(() => 0)
    meters.push(m)
    m.start({ loop: { percentile: (p) => (p === 50 ? readings.p50 : readings.p99) * 1e6, get max() { return readings.max * 1e6 }, reset() {}, enable: () => true, disable: () => true }, loopResolutionMs: LOOP_RESOLUTION_MS }, 60_000)
    expect((await m.sample()).loop).toEqual({ p50: 1, p99: 40, max: 280 })
    // Below the interval (NaN before anything was recorded, or a reading under it) never goes negative.
    Object.assign(readings, { p50: NaN, p99: 10, max: 10 })
    expect((await m.sample()).loop).toEqual({ p50: 0, p99: 0, max: 0 })
  })

  it('reports a stall with what ran during it, and only when the worst delay reaches the threshold', async () => {
    const stalls: import('../src/shared/perf').PerfStall[] = []
    const readings = { p50: 0, p99: 0, max: 0 }
    const m = new PerfMeter(() => 0)
    meters.push(m)
    m.start({ loop: { percentile: (p) => (p === 50 ? readings.p50 : readings.p99) * 1e6, get max() { return readings.max * 1e6 }, reset() {}, enable: () => true, disable: () => true }, onStall: (s) => stalls.push(s), stallMs: 500 }, 60_000)
    m.count('event.state', 2)
    Object.assign(readings, { p50: 1, p99: 40, max: 499 })
    await m.sample()
    expect(stalls).toEqual([])
    m.count('event.state', 5)
    m.time('db.putItem', 480)
    Object.assign(readings, { p50: 2, p99: 300, max: 1200 })
    await m.sample()
    expect(stalls).toHaveLength(1)
    // Only what happened since the previous sample: the first two state events are not blamed.
    expect(stalls[0]).toMatchObject({ maxMs: 1200, p99Ms: 300, counters: { 'event.state': 5 }, timings: { 'db.putItem': { count: 1, totalMs: 480, maxMs: 480 } } })
  })

  it('stops writing to the file when asked, and says whether it is recording', async () => {
    const { m } = meter()
    meters.push(m)
    const file = path.join(await tempDir('foreman-perf-'), 'perf.jsonl')
    expect(m.recording).toBeNull()
    await m.record(file)
    expect(m.recording).toBe(file)
    await m.sample()
    m.stopRecording()
    expect(m.recording).toBeNull()
    await m.sample()
    await m.flushed()
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('names a command by its first words, skipping flags', () => {
    expect(commandLabel(['status', '--porcelain'])).toBe('status')
    expect(commandLabel(['pr', 'view', '--json', 'url'], 2)).toBe('pr.view')
    expect(commandLabel(['auth', 'status'], 2)).toBe('auth.status')
    expect(commandLabel(['api', 'repos/x/y'], 1)).toBe('api')
    expect(commandLabel(['--version'])).toBe('(none)')
  })

  it('takes samples on its own timer and stops with it', async () => {
    const m = new PerfMeter()
    meters.push(m)
    m.start({ loop: null }, 10)
    await sleep(60)
    expect(m.report().samples.length).toBeGreaterThan(0)
    m.stop()
    const after = m.report().samples.length
    await sleep(40)
    expect(m.report().samples.length).toBe(after)
  })
})

describe('foreman app perf', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  async function serve(overrides: Partial<CliHost> = {}) {
    const dataDir = await tempDir()
    const host = stubHost({ appInfo: () => ({ version: '9.9.9', packaged: true, dataDir }), ...overrides })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()
    return (request: unknown) =>
      new Promise<{ ok: boolean; result?: PerfReport; code?: string; error?: string }>((resolve, reject) => {
        const conn = net.createConnection(socket, () => conn.write(`${JSON.stringify(request)}\n`))
        let out = ''
        conn.setEncoding('utf8')
        conn.on('data', (chunk: string) => (out += chunk))
        conn.on('end', () => resolve(JSON.parse(out.split('\n').filter(Boolean)[0])))
        conn.on('error', reject)
      })
  }

  it('answers app-perf with the report, resetting only when asked, and is a read method', async () => {
    const m = new PerfMeter(() => 42)
    m.count('state.flush', 9)
    const calls: boolean[] = []
    const ask = await serve({
      perf: ({ reset } = {}) => {
        calls.push(Boolean(reset))
        const report = m.report()
        if (reset) m.reset()
        return report
      }
    })
    const first = await ask({ v: 2, method: 'app-perf' })
    expect(first.ok).toBe(true)
    expect(first.result?.counters).toEqual({ 'state.flush': 9 })
    const second = await ask({ v: 2, method: 'app-perf', params: { reset: true }, caller: { sessionId: 's', turnId: 't', token: 'k' } })
    expect(second.result?.counters).toEqual({ 'state.flush': 9 })
    expect((await ask({ v: 2, method: 'app-perf' })).result?.counters).toEqual({})
    expect(calls).toEqual([false, true, false])
  })

  it('says so when the app keeps no counters', async () => {
    const ask = await serve()
    expect(await ask({ v: 2, method: 'app-perf' })).toMatchObject({ ok: false, code: 'not-supported' })
    expect(await ask({ v: 2, method: 'app-diagnostics' })).toMatchObject({ ok: false, code: 'not-supported' })
    expect(await ask({ v: 2, method: 'app-profile' })).toMatchObject({ ok: false, code: 'not-supported' })
    expect(await ask({ v: 2, method: 'app-heap' })).toMatchObject({ ok: false, code: 'not-supported' })
  })

  it('serves app-diagnostics, app-profile and app-heap as read methods, with the profile defaults filled in', async () => {
    const asked: unknown[] = []
    const ask = await serve({
      diagnostics: async () => ({ kind: 'foreman-diagnostics', format: 1, events: [], crashDumps: [] }) as never,
      profile: async (options) => (asked.push(options), { file: '/logs/p.cpuprofile', ms: options.seconds * 1000 }),
      heapSnapshot: async (options) => (asked.push(options), { file: `/logs/${options.target}.heapsnapshot` })
    })
    const bundle = (await ask({ v: 2, method: 'app-diagnostics', caller: { sessionId: 's', turnId: 't', token: 'k' } })) as { ok: boolean; result?: { kind: string } }
    expect(bundle.ok).toBe(true)
    expect(bundle.result?.kind).toBe('foreman-diagnostics')
    expect((await ask({ v: 2, method: 'app-profile' })) as object).toMatchObject({ ok: true, result: { file: '/logs/p.cpuprofile', ms: 20_000 } })
    expect((await ask({ v: 2, method: 'app-profile', params: { target: 'renderer', seconds: 3 } })) as object).toMatchObject({ ok: true, result: { ms: 3000 } })
    expect((await ask({ v: 2, method: 'app-heap', params: { target: 'renderer' } })) as object).toMatchObject({ ok: true, result: { file: '/logs/renderer.heapsnapshot' } })
    expect(asked).toEqual([{ target: 'main', seconds: 20 }, { target: 'renderer', seconds: 3 }, { target: 'renderer' }])
    expect((await ask({ v: 2, method: 'app-profile', params: { target: 'gpu' } })) as object).toMatchObject({ ok: false, code: 'invalid' })
    expect((await ask({ v: 2, method: 'app-profile', params: { seconds: -1 } })) as object).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('prints the processes, the main thread, and the busiest counters and timings', () => {
    const report: PerfReport = {
      since: '2026-10-29T10:00:00.000Z',
      uptimeMs: 125_000,
      sample: {
        at: '2026-10-29T10:02:05.000Z',
        cpuPercent: 6.6,
        rssMb: 176,
        heapUsedMb: 80,
        loop: { p50: 0.4, p99: 12, max: 230 },
        processes: [
          { type: 'Browser', pid: 376, cpuPercent: 6.6, memoryMb: 186 },
          { type: 'Tab', pid: 73132, cpuPercent: 12.5, memoryMb: 151 },
          { type: 'GPU', pid: 48892, cpuPercent: 14.1, memoryMb: 116 }
        ]
      },
      samples: [],
      counters: { 'event.chat-append': 9360, 'state.flush': 48, 'state.broadcast': 4 },
      timings: { 'gh.pr.view': { count: 3, totalMs: 4200, maxMs: 1600 }, 'git.status': { count: 12, totalMs: 360, maxMs: 45 } },
      gauges: { 'state.bytes': 32_768 }
    }
    const text = perfText(report, 2)
    expect(text).toContain('up 2 min 5 s')
    expect(text).toContain('GPU')
    expect(text).toContain('14.1% cpu')
    expect(text).toContain('p99 12 ms, max 230 ms')
    expect(text).toContain('Counters (top 2):')
    expect(text).toContain('event.chat-append')
    expect(text).not.toContain('state.broadcast')
    expect(text).toContain('gh.pr.view')
    expect(text).toContain('4.2 s')
    expect(text).toContain('1.4 s')
    expect(text).toContain('state.bytes')
    const empty = perfText({ ...report, sample: null, counters: {}, timings: {}, gauges: {} })
    expect(empty).toContain('No sample yet')
    expect(empty).toContain('Counters: none yet')
  })
})
