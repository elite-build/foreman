// The idle budget (docs/telemetry.md, Budgets): a Core with twelve ready workspaces and nothing running does no
// git, gh or state work on its own. Ten minutes pass on a simulated clock; the performance meter's counters say
// what happened. If this fails, a timer started doing work for workspaces that asked for none.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { perf } from '../src/main/perf'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { MainEvent, Repo, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const WORKSPACES = 12
const IDLE_MS = 10 * 60_000

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('twelve idle workspaces (main)', () => {
  it('spawns no git or gh process and rebuilds no state in ten quiet minutes', async () => {
    const dir = await tempDir('foreman-idle-')
    const store = new Store(dir)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
    const events: MainEvent[] = []
    const core = new Core(store, secrets, {
      broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const roots = await Promise.all(Array.from({ length: WORKSPACES }, () => makeRepo()))
    for (const [i, root] of roots.entries()) {
      const repo = { id: `repo-${i}`, name: `repo-${i}`, rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: new Date().toISOString() } as Repo
      const ws: Workspace = { id: `ws-${i}`, repoId: repo.id, name: `ws-${i}`, branch: 'main', baseBranch: 'main', path: root, portBase: 51000 + i * 10, state: 'ready', createdAt: new Date().toISOString() }
      store.state.repos.push(repo)
      store.state.workspaces.push(ws)
      core.sessions.createSession(ws.id, { agent: 'claude', title: `agent ${i}` })
    }
    // The services index.ts starts, as it starts them; the PR poller runs from the constructor.
    core.prWatch.start()
    core.baseWatch.start()
    core.schedules.start()
    core.autoArchive.start()
    core.limitResume.start()
    core.data.start()
    core.gitBackup.start()
    await Promise.resolve()
    core.flushState()
    await new Promise<void>((resolve) => setImmediate(resolve))
    perf.reset()
    events.length = 0

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-10-29T10:00:00Z'))
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    const report = perf.report()
    const spawned = Object.keys(report.timings).filter((name) => name.startsWith('git.') || name.startsWith('gh.'))
    expect(spawned, `processes started while idle: ${spawned.join(', ')}`).toEqual([])
    expect(report.counters['state.flush'] ?? 0, 'state rebuilds while idle').toBe(0)
    expect(events.filter((e) => e.type === 'state')).toHaveLength(0)
    core.attention.stop()
    await core.shutdown()
  }, 120_000)
})
