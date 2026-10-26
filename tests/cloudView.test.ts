// Cloud workspaces in the window: what a cloud workspace shows, when a
// repository may offer Cloud, how a sandbox's status reads, the setup token's age, and this month's usage.
import { describe, expect, it } from 'vitest'
import { workspaceSurfaces } from '../src/renderer/src/archivedView'
import {
  barTone,
  blocksChoice,
  cloudCap,
  cloudDot,
  cloudReadiness,
  cloudStatusWord,
  countBar,
  cpuUsageBar,
  memoryUsageBar,
  minutesLeft,
  sessionCap,
  setupTokenState,
  shortSessions,
  shortSessionsFor,
  showsConcurrency,
  usageResetsAt,
  vercelConnection
} from '../src/renderer/src/cloudView'
import { CLOUD_PROVIDERS, planLimits } from '../src/shared/cloud'
import type { ConnectionView } from '../src/shared/integrations'
import type { CloudBuild, CloudStatus, Repo, RepoCloud, Settings, Workspace, WorkspaceCloud } from '../src/shared/types'

const HOUR = 3_600_000

const binding = (status: CloudStatus): WorkspaceCloud => ({ provider: 'vercel', id: 'foreman-ws-w', status, region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox/repo' })

const ws = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'w1', repoId: 'r1', name: 'tacoma', branch: 'yatin/tacoma', baseBranch: 'main', portBase: 0, state: 'ready', createdAt: '2026-10-01T10:00:00Z', ...patch }) as Workspace

const build = (status: CloudBuild['status']): CloudBuild => ({ id: 'b1', status, startedAt: '2026-10-23T10:00:00Z' })

const repo = (cloud?: Partial<RepoCloud>): Repo => ({ id: 'r1', name: 'foreman', cloud: cloud && { enabled: true, vcpus: 2, region: 'iad1', idleMinutes: 20, autoContinue: true, installScript: '', ...cloud } }) as Repo

const vercel = (patch: Partial<ConnectionView> = {}): ConnectionView =>
  ({ id: 'v1', service: 'vercel', name: 'Lab', isDefault: true, vercel: { teamId: 'team_1', projectId: 'prj_1', plan: 'hobby' }, ...patch }) as ConnectionView

const settings = (cloud?: Partial<NonNullable<Settings['cloud']>>): Pick<Settings, 'claudeAuth' | 'cloud'> => ({
  claudeAuth: 'cli',
  cloud: cloud && { enabled: true, claudeAuth: 'setup-token', stopOrphansOnLaunch: false, deleteSnapshotsOnForget: true, maxRunning: 8, wakeOnOpen: true, ...cloud }
})

describe('a cloud workspace’s surfaces', () => {
  it('keeps chats, Changes, commits, the git panel and the terminal tab, and drops what needs a folder here', () => {
    expect(workspaceSurfaces(ws({ cloud: binding('running') }))).toEqual({ worktree: true, chats: true, archived: false, setupLog: true, terminal: true, exportable: false, local: false, cloud: true })
  })

  it('a sleeping one is the same: chats still open, the sandbox wakes for a turn', () => {
    expect(workspaceSurfaces(ws({ cloud: binding('sleeping') }))).toMatchObject({ worktree: true, local: false, cloud: true })
  })

  it('archived, it reads like any archived workspace', () => {
    expect(workspaceSurfaces(ws({ state: 'archived', cloud: binding('archived') }))).toMatchObject({ archived: true, worktree: false, cloud: false, local: false, terminal: false })
  })

  it('a local workspace keeps its folder surfaces', () => {
    expect(workspaceSurfaces(ws({ path: '/wt/tacoma' }))).toMatchObject({ local: true, cloud: false, exportable: true })
  })
})

describe('whether a repository offers Cloud', () => {
  const ready = { settings: settings({}), repo: repo({ build: build('active') }), connections: [vercel()], workspaces: [] as Workspace[] }

  it('is hidden while the switch or the repository’s setting is off', () => {
    expect(cloudReadiness({ ...ready, settings: settings() })).toMatchObject({ offer: false, block: 'flag' })
    expect(cloudReadiness({ ...ready, settings: settings({ enabled: false }) })).toMatchObject({ offer: false, block: 'flag' })
    expect(cloudReadiness({ ...ready, repo: repo() })).toMatchObject({ offer: false, block: 'repo' })
    expect(cloudReadiness({ ...ready, repo: repo({ enabled: false, build: build('active') }) })).toMatchObject({ offer: false, block: 'repo' })
  })

  it('is shown but can’t be picked without a working connection for its provider or a successful build', () => {
    expect(cloudReadiness({ ...ready, connections: [] })).toMatchObject({ offer: true, block: 'connection', provider: 'vercel' })
    // Not the default one: main uses only the default, unless the repository chose it.
    expect(cloudReadiness({ ...ready, connections: [vercel({ isDefault: false })] }).block).toBe('connection')
    expect(cloudReadiness({ ...ready, repo: repo({ build: build('active'), connectionId: 'v1' }), connections: [vercel({ isDefault: false })] }).block).toBe('no-build')
    expect(cloudReadiness({ ...ready, connections: [vercel({ problem: 'Vercel answered 403' })] }).block).toBe('connection-problem')
    expect(cloudReadiness({ ...ready, repo: repo({}) }).block).toBe('no-build')
    expect(cloudReadiness({ ...ready, repo: repo({ build: build('building') }) }).block).toBe('building')
    expect(cloudReadiness({ ...ready, repo: repo({ build: build('failed') }) }).block).toBe('build-failed')
    for (const block of ['soon', 'connection', 'connection-problem', 'no-build', 'building', 'build-failed'] as const) expect(blocksChoice(block)).toBe(true)
  })

  it('follows the repository’s provider: its connection, whether it’s implemented, and whether it keeps a base', () => {
    const docker = { ...vercel({ id: 'd1', service: 'docker', name: 'Desktop' }), vercel: undefined } as ConnectionView
    // A provider that isn't implemented: coming soon, whatever is connected.
    CLOUD_PROVIDERS.docker.implemented = false
    try {
      expect(cloudReadiness({ ...ready, repo: repo({ provider: 'docker' }), connections: [vercel(), docker] })).toMatchObject({ block: 'soon', provider: 'docker' })
    } finally {
      CLOUD_PROVIDERS.docker.implemented = true
    }
    // A base built on Vercel is no base for another provider.
    const built = { ...build('active'), provider: 'vercel' as const }
    expect(cloudReadiness({ ...ready, repo: repo({ build: built }) }).block).toBeUndefined()
    // No provider chosen: the first sandbox service with a default connection; Docker keeps bases, so it needs its own.
    expect(cloudReadiness({ ...ready, repo: repo({ build: built }), connections: [docker] })).toMatchObject({ provider: 'docker', block: 'no-build' })
    // A provider that keeps no base (main's view says so) needs no build.
    const view = { id: 'vercel' as const, ready: true, limits: planLimits('hobby'), capabilities: { fork: false, base: false, snapshotOnStop: true, sessionCap: false, pty: true, regions: [], vcpuOptions: [2], billed: false } }
    expect(cloudReadiness({ ...ready, repo: repo({}), provider: view }).block).toBeUndefined()
  })

  it('counts the plan’s concurrency on the provider’s own workspaces, and Settings’ limit across all', () => {
    const elsewhere = ['a', 'b'].map((id) => ws({ id, name: id, repoId: 'r2', cloud: { ...binding('running'), provider: 'docker' } }))
    expect(cloudReadiness({ ...ready, settings: settings({ maxRunning: 3 }), workspaces: elsewhere }).block).toBeUndefined()
    expect(cloudReadiness({ ...ready, settings: settings({ maxRunning: 2 }), workspaces: elsewhere })).toMatchObject({ block: 'limit', cap: 2, capScope: 'app' })
  })

  it('is ready with a connection and an active build', () => {
    expect(cloudReadiness(ready)).toMatchObject({ offer: true, cap: 8 })
    expect(cloudReadiness(ready).block).toBeUndefined()
    expect(blocksChoice(undefined)).toBe(false)
  })

  it('at the running limit, refuses with the sandboxes holding the slots (archived and asleep ones don’t count)', () => {
    const running = ['a', 'b', 'c'].map((id) => ws({ id, name: id, repoId: 'r2', cloud: binding('running') }))
    const others = [ws({ id: 'z', cloud: binding('sleeping') }), ws({ id: 'y', state: 'archived', cloud: binding('running') }), ws({ id: 'x', path: '/wt/x' })]
    const result = cloudReadiness({ ...ready, settings: settings({ maxRunning: 3 }), workspaces: [...running, ...others] })
    expect(result).toMatchObject({ block: 'limit', cap: 3, capScope: 'app' })
    expect(result.running.map((w) => w.id)).toEqual(['a', 'b', 'c'])
    // The limit stops the submit, not the choice: the refusal offers Sleep.
    expect(blocksChoice('limit')).toBe(false)
  })

  it('also honours the repository’s own limit', () => {
    const mine = [ws({ id: 'a', cloud: binding('running') }), ws({ id: 'b', cloud: binding('waking') })]
    expect(cloudReadiness({ ...ready, repo: repo({ build: build('active'), maxRunning: 2 }), workspaces: mine })).toMatchObject({ block: 'limit', cap: 2, capScope: 'repo' })
  })

  it('never lets the soft limit pass the plan’s concurrency', () => {
    expect(cloudCap(settings({ maxRunning: 50 }), planLimits('hobby'))).toBe(10)
    expect(cloudCap(settings({ maxRunning: 50 }), planLimits('pro'))).toBe(50)
    expect(showsConcurrency(planLimits('hobby'))).toBe(true)
    expect(showsConcurrency(planLimits('pro'))).toBe(false)
  })

  it('picks the default Vercel connection only', () => {
    expect(vercelConnection([vercel({ id: 'a', isDefault: false }), vercel({ id: 'b' })])?.id).toBe('b')
    expect(vercelConnection([{ ...vercel(), service: 'github' } as ConnectionView])).toBeUndefined()
  })
})

describe('a sandbox’s status, as the sidebar and header say it', () => {
  it('words', () => {
    expect(cloudStatusWord('running', true)).toBe('working')
    expect(cloudStatusWord('running', false)).toBe('awake')
    expect(cloudStatusWord('sleeping', false)).toBe('asleep')
    expect(cloudStatusWord('creating', false)).toBe('starting')
    expect(cloudStatusWord('waking', false)).toBe('waking')
    expect(cloudStatusWord('capped', false)).toBe('capped')
    expect(cloudStatusWord('unresponsive', false)).toBe('unresponsive')
  })

  it('dots', () => {
    expect(cloudDot('running')).toBe('green')
    expect(cloudDot('waking')).toBe('blue')
    expect(cloudDot('capped')).toBe('amber')
    expect(cloudDot('gone')).toBe('red')
    expect(cloudDot('sleeping')).toBe('')
  })

  it('minutes left in the session', () => {
    const now = Date.parse('2026-10-23T12:00:00Z')
    expect(minutesLeft('2026-10-23T12:30:30Z', now)).toBe(31)
    expect(minutesLeft('2026-10-23T11:59:00Z', now)).toBeUndefined()
    expect(minutesLeft(undefined, now)).toBeUndefined()
  })

  it('the session cap, and the Hobby caveat (only for providers with a cap)', () => {
    expect(sessionCap(planLimits('hobby'))).toEqual({ minutes: 45 })
    expect(sessionCap(planLimits('pro'))).toEqual({ hours: 24 })
    expect(shortSessions(planLimits('hobby'))).toBe(true)
    expect(shortSessions(planLimits('pro'))).toBe(false)
    expect(shortSessionsFor({ sessionCap: true }, planLimits('hobby'))).toBe(true)
    expect(shortSessionsFor({ sessionCap: false }, planLimits('hobby'))).toBe(false)
  })
})

describe('Claude’s setup token', () => {
  const now = Date.parse('2026-10-23T12:00:00Z')
  it('is missing, fine, expiring within two weeks, or expired after about a year', () => {
    expect(setupTokenState(null, now)).toBe('missing')
    expect(setupTokenState({ savedAt: '2026-10-03T12:00:00Z' }, now)).toBe('ok')
    expect(setupTokenState({ savedAt: '2025-10-30T12:00:00Z' }, now)).toBe('expiring')
    expect(setupTokenState({ savedAt: '2025-10-21T12:00:00Z' }, now)).toBe('expired')
    // Saved before Foreman recorded the date: assume it's fine.
    expect(setupTokenState({}, now)).toBe('ok')
  })
})

describe('this month on Vercel', () => {
  it('active CPU against Hobby’s 5 hours; no ceiling on Pro or on a provider without allowances', () => {
    expect(cpuUsageBar({ month: '2026-10', activeCpuMs: 2 * HOUR, stops: 1 }, null)).toEqual({ used: 2 })
    expect(cpuUsageBar({ month: '2026-10', activeCpuMs: 1.2 * HOUR, stops: 4 }, 'hobby')).toEqual({ used: 1.2, of: 5, fraction: 0.24 })
    expect(cpuUsageBar(null, 'hobby')).toEqual({ used: 0, of: 5, fraction: 0 })
    expect(cpuUsageBar({ month: '2026-10', activeCpuMs: 30 * HOUR, stops: 4 }, 'pro')).toEqual({ used: 30 })
    expect(cpuUsageBar({ month: '2026-10', activeCpuMs: 9 * HOUR, stops: 4 }, 'hobby').fraction).toBe(1)
  })

  it('provisioned memory against Hobby’s 420 GB-hours; unknown when the stops carried no length', () => {
    expect(memoryUsageBar({ month: '2026-10', activeCpuMs: 0, stops: 2, memoryGbHours: 42 }, 'hobby')).toEqual({ used: 42, of: 420, fraction: 0.1 })
    expect(memoryUsageBar(null, 'hobby')).toEqual({ used: 0, of: 420, fraction: 0 })
    expect(memoryUsageBar({ month: '2026-10', activeCpuMs: 0, stops: 1, memoryGbHours: 12.34 }, 'pro')).toEqual({ used: 12.3 })
    expect(memoryUsageBar({ month: '2026-10', activeCpuMs: 0, stops: 3 }, 'hobby')).toBeNull()
  })

  it('running sandboxes against the limit, and the bar’s tone', () => {
    expect(countBar(3, 10)).toEqual({ used: 3, of: 10, fraction: 0.3 })
    expect(barTone(0.3)).toBe('green')
    expect(barTone(0.8)).toBe('amber')
    expect(barTone(1)).toBe('red')
    expect(barTone(undefined)).toBe('green')
  })

  it('starts over on the first of next month', () => {
    const at = usageResetsAt(new Date(2026, 11, 15).getTime())
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2027, 0, 1])
  })
})
