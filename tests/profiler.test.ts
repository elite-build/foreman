// On-demand profiles (docs/telemetry.md, "Evidence"): a real CPU profile and heap snapshot of this process through
// the in-process inspector, and the renderer paths against a stand-in DevTools session.
import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heapSnapshotMain, heapSnapshotRenderer, profileFileName, profileMain, profileRenderer, type DevToolsTarget } from '../src/main/profiler'
import { tempDir } from './helpers'

/** A DevTools session that answers like Chromium's and remembers what it was asked. */
function fakeTarget(chunks: string[] = []) {
  const calls: string[] = []
  let attached = false
  const listeners = new Set<(event: unknown, method: string, params: Record<string, unknown>) => void>()
  const target: DevToolsTarget = {
    attach: () => void (attached = true),
    detach: () => void (attached = false),
    isAttached: () => attached,
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    sendCommand: async (method) => {
      calls.push(method)
      if (method === 'Profiler.stop') return { profile: { nodes: [{ id: 1 }], startTime: 1, endTime: 2, samples: [1], timeDeltas: [1] } }
      if (method === 'HeapProfiler.takeHeapSnapshot') for (const chunk of chunks) for (const l of listeners) l({}, 'HeapProfiler.addHeapSnapshotChunk', { chunk })
      return {}
    }
  }
  return { target, calls, attached: () => attached, listeners }
}

describe('profiler', () => {
  it('profiles the main process in place and returns a V8 profile', async () => {
    // Keep the thread busy so there is something to sample.
    const busy = setInterval(() => {
      let n = 0
      for (let i = 0; i < 20_000; i++) n += i
      return n
    }, 1)
    try {
      const profile = (await profileMain(250)) as { nodes: unknown[]; startTime: number; endTime: number; samples: unknown[] }
      expect(profile.nodes.length).toBeGreaterThan(0)
      expect(profile.endTime).toBeGreaterThan(profile.startTime)
      expect(profile.samples.length).toBeGreaterThan(0)
    } finally {
      clearInterval(busy)
    }
  }, 20_000)

  it('writes a heap snapshot of the main process', async () => {
    const file = path.join(await tempDir('foreman-heap-'), 'main.heapsnapshot')
    expect(heapSnapshotMain(file)).toBe(file)
    const size = (await stat(file)).size
    expect(size).toBeGreaterThan(1000)
    expect((await readFile(file, 'utf8')).startsWith('{"snapshot"')).toBe(true)
  }, 60_000)

  it('profiles the renderer over its DevTools session, attaching only for the call', async () => {
    const { target, calls, attached } = fakeTarget()
    const waits: number[] = []
    const profile = await profileRenderer(target, 1234, async (ms) => void waits.push(ms))
    expect(profile).toMatchObject({ nodes: [{ id: 1 }] })
    expect(calls).toEqual(['Profiler.enable', 'Profiler.start', 'Profiler.stop', 'Profiler.disable'])
    expect(waits).toEqual([1234])
    expect(attached()).toBe(false)
  })

  it('leaves a session that was already attached attached', async () => {
    const { target, attached } = fakeTarget()
    target.attach()
    await profileRenderer(target, 1, async () => {})
    expect(attached()).toBe(true)
  })

  it('writes the renderer heap snapshot from the chunks DevTools sends, and stops listening after', async () => {
    const { target, calls, listeners } = fakeTarget(['{"snap', 'shot":1}'])
    const file = path.join(await tempDir('foreman-heap-'), 'renderer.heapsnapshot')
    await heapSnapshotRenderer(target, file)
    expect(await readFile(file, 'utf8')).toBe('{"snapshot":1}')
    expect(calls).toEqual(['HeapProfiler.enable', 'HeapProfiler.takeHeapSnapshot', 'HeapProfiler.disable'])
    expect(listeners.size).toBe(0)
  })

  it('names files by kind, time and target', () => {
    const at = new Date(2026, 10, 2, 10, 30, 15)
    expect(profileFileName('main', 'cpuprofile', at)).toBe('profile-2026-11-02-103015-main.cpuprofile')
    expect(profileFileName('renderer', 'heapsnapshot', at)).toBe('heap-2026-11-02-103015-renderer.heapsnapshot')
  })
})
