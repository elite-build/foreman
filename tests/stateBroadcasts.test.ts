// State broadcasts with many agents: a burst of changes builds and sends one snapshot, the snapshot's reads of
// repository folders are reused for a few seconds, and a window gaining focus only sends the state when it changed.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { AppSnapshot, MainEvent } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup() {
  const dir = await tempDir('foreman-state-broadcasts-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const events: MainEvent[] = []
  let screenReader = false
  const core = new Core(store, secrets, {
    broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => '', screenReader: () => screenReader
  })
  core.attention.stop()
  // Whatever construction queued goes first, so each test counts only its own.
  await Promise.resolve()
  core.flushState()
  events.length = 0
  const states = () => events.filter((e): e is Extract<MainEvent, { type: 'state' }> => e.type === 'state').map((e) => e.snapshot)
  return { core, store, dir, events, states, setScreenReader: (on: boolean) => (screenReader = on) }
}

describe('coalesced state broadcasts', () => {
  it('sends one state for many changes in one tick, with the final values', async () => {
    const { core, states } = await setup()
    const snapshot = vi.spyOn(core, 'snapshot')
    void core.api.updateSettings({ contentFontSize: 13 })
    void core.api.updateSettings({ contentFontSize: 14 })
    void core.api.updateSettings({ contentFontSize: 15 })
    expect(states()).toHaveLength(0)
    await Promise.resolve()
    expect(states()).toHaveLength(1)
    expect(states()[0].settings.contentFontSize).toBe(15)
    expect(snapshot).toHaveBeenCalledTimes(1)
    // The next tick's change is a broadcast of its own.
    await core.api.updateSettings({ contentFontSize: 16 })
    expect(states().map((s) => s.settings.contentFontSize)).toEqual([15, 16])
  })

  it('flushState sends a waiting broadcast at once, and nothing when none waits', async () => {
    const { core, states } = await setup()
    void core.api.updateSettings({ contentFontSize: 17 })
    core.flushState()
    expect(states()).toHaveLength(1)
    await Promise.resolve()
    core.flushState()
    expect(states()).toHaveLength(1)
  })

  it('sends nothing when the snapshot is the same as the last one sent, and sends the next real change', async () => {
    const { core, store, states } = await setup()
    await core.api.updateSettings({ contentFontSize: 13 })
    expect(states()).toHaveLength(1)
    // A save that changed nothing the window shows.
    await core.api.updateSettings({ contentFontSize: 13 })
    expect(states()).toHaveLength(1)
    // A change made in place to a stored record still goes out.
    const sent = states()[0]
    store.state.settings.contentFontSize = 14
    void core.api.updateSettings({})
    core.flushState()
    expect(states()).toHaveLength(2)
    expect(states()[1].settings.contentFontSize).toBe(14)
    expect(sent).not.toBe(states()[1])
  })
})

describe('the snapshot reads repository folders', () => {
  it('reuses a recent answer across broadcasts, and picks up an outside change after a few seconds', async () => {
    const { core, store, dir, states } = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
    const old = path.join(dir, 'old-repo')
    await mkdir(old)
    store.state.recentRepoPaths = [old, path.join(dir, 'never-there')]
    await core.api.updateSettings({ contentFontSize: 13 })
    expect(states().at(-1)!.recentRepos).toEqual([old])
    // Removed outside Foreman: the next broadcasts within the window keep the last answer, without looking.
    await rm(old, { recursive: true })
    vi.setSystemTime(new Date('2026-10-27T10:00:02Z'))
    await core.api.updateSettings({ contentFontSize: 14 })
    expect(states().at(-1)!.recentRepos).toEqual([old])
    // A snapshot asked for directly (the window's first load, the command line) always looks.
    expect(core.snapshot().recentRepos).toEqual([])
    store.state.recentRepoPaths = [old]
    await mkdir(old)
    vi.setSystemTime(new Date('2026-10-27T10:00:03Z'))
    await core.api.updateSettings({ contentFontSize: 15 })
    expect(states().at(-1)!.recentRepos).toEqual([])
    vi.setSystemTime(new Date('2026-10-27T10:00:07Z'))
    await core.api.updateSettings({ contentFontSize: 16 })
    expect(states().at(-1)!.recentRepos).toEqual([old])
  })
})

describe('a window gaining focus', () => {
  it('sends the state only when the screen reader flag or a repository folder changed', async () => {
    const { core, store, dir, states, setScreenReader } = await setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
    const old = path.join(dir, 'old-repo')
    await mkdir(old)
    store.state.recentRepoPaths = [old]
    await core.api.updateSettings({ contentFontSize: 13 })
    const sent = states().length
    // Nothing changed: no broadcast.
    core.screenReaderChanged()
    await Promise.resolve()
    expect(states()).toHaveLength(sent)
    // The flag changed.
    setScreenReader(true)
    core.screenReaderChanged()
    await Promise.resolve()
    expect(states()).toHaveLength(sent + 1)
    expect(states().at(-1)!.screenReader).toBe(true)
    // A folder went away outside Foreman: focus looks at once, inside the reuse window.
    await rm(old, { recursive: true })
    core.screenReaderChanged()
    await Promise.resolve()
    expect(states()).toHaveLength(sent + 2)
    expect((states().at(-1) as AppSnapshot).recentRepos).toEqual([])
  })
})
