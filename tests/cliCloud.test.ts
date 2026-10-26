import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestV2 } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { cloudRunners } from '../src/cli/commands/cloud'
import { renderCommandHelp } from '../src/cli/help'
import { socketPath } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { BUILD_WAIT, CLOUD_METHODS } from '../src/main/cli/cloud'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, METHODS, startCliServer, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { COMMON_OPTIONS, commandName, findCommand } from '../src/shared/cliCommands'
import { CLOUD_COMMANDS } from '../src/shared/cliCommandsGit'
import type { CloudActionResult, CloudBuildResult, CloudContinueResult, CloudPreflightResult, CloudStatusResult, CloudUsageResult } from '../src/shared/cli/cloud'
import type { Api, CloudBuild, MainEvent, Repo, Session, Workspace, WorkspaceCloud } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')

const build = (patch: Partial<CloudBuild> = {}): CloudBuild => ({ id: 'build-1234abcd', status: 'building', startedAt: '2026-10-24T12:00:00.000Z', ...patch })
const repoOf = (patch: Partial<Repo> = {}): Repo => ({ id: 'r1', name: 'app', rootPath: '/app', defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: '2026-09-01T10:00:00.000Z', cloud: { enabled: true, provider: 'vercel', vcpus: 2, region: 'iad1', idleMinutes: 20, autoContinue: true, installScript: '' }, ...patch }) as Repo
const cloud = (patch: Partial<WorkspaceCloud> = {}): WorkspaceCloud => ({ provider: 'vercel', id: 'foreman-ws-ws1', status: 'running', region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox/repo', lastActivityAt: '2026-10-24T11:48:00.000Z', ...patch })
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'api-fix', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/x', createdAt: '2026-10-01T10:00:00.000Z', cloud: cloud(), ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session

const ctx = (token?: string, progress: string[] = [], signal?: AbortSignal): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal, progress: (text) => void progress.push(text) })

function rig(options: { repos?: Repo[]; workspaces?: Workspace[]; sessions?: Session[]; api?: Partial<Api>; host?: Partial<CliHost>; connections?: unknown[] } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const api = fakeApi({
    cloudWake: record('cloudWake', cloud({ status: 'running' })) as Api['cloudWake'],
    cloudSleep: record('cloudSleep', cloud({ status: 'sleeping' })) as Api['cloudSleep'],
    cloudRestart: record('cloudRestart', cloud({ status: 'running' })) as Api['cloudRestart'],
    cloudStatus: record('cloudStatus', cloud({ status: 'running' })) as Api['cloudStatus'],
    cloudReattach: record('cloudReattach') as Api['cloudReattach'],
    cloudContinue: record('cloudContinue', { disposition: 'started', turnId: 'turn-3' }) as Api['cloudContinue'],
    cloudUsage: record('cloudUsage', []) as Api['cloudUsage'],
    cloudBuildBase: record('cloudBuildBase', build()) as Api['cloudBuildBase'],
    cloudPreflight: record('cloudPreflight', { ok: true }) as Api['cloudPreflight'],
    ...options.api
  })
  const host = stubHost({
    api,
    state: () => ({ repos: options.repos ?? [repoOf()], workspaces: options.workspaces ?? [ws()], sessions: options.sessions ?? [tab('s1')], settings: defaultSettings() }),
    snapshot: () => ({ integrations: { connections: options.connections ?? [] } }) as never,
    ...options.host
  })
  const call = async <T>(method: string, params: unknown, token?: string, progress?: string[], signal?: AbortSignal): Promise<T> => (await CLOUD_METHODS[method].handle(host, params, ctx(token, progress, signal))) as T
  return { host, calls, call }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CliCodedError)
    return err as CliCodedError
  }
  throw new Error('expected a failure')
}

const turnHost = (mayStart: boolean): Partial<CliHost> => ({
  identifyCaller: () => ({ kind: 'turn', session: tab('s1'), ws: ws(), turnId: 't', live: true }),
  agentsMayStart: () => mayStart
})

describe('status and the sandbox controls', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(NOW))
  afterEach(() => void vi.useRealTimers())

  it('lists every live remote workspace with its state, size, idle time and what needs attention', async () => {
    const { call, calls } = rig({
      workspaces: [ws(), ws({ id: 'ws2', name: 'docs', cloud: cloud({ provider: 'docker', status: 'sleeping', vcpus: 4, region: '', disconnected: true }) }), ws({ id: 'ws3', name: 'local', cloud: undefined }), ws({ id: 'ws4', name: 'gone', state: 'archived' })]
    })
    const result = await call<CloudStatusResult>('cloud-status', { cwd: '/' })
    expect(result.workspaces.map((r) => [r.workspace, r.provider, r.status, r.vcpus, r.idleMinutes, r.sleepsAfterMinutes, r.disconnected])).toEqual([
      ['api-fix', 'Vercel', 'running', 2, 12, 20, undefined],
      ['docs', 'Docker', 'sleeping', 4, undefined, undefined, true]
    ])
    expect(result.text).toBe(
      ['WORKSPACE  PROVIDER  STATE     SIZE           IDLE        NOTES', 'api-fix    Vercel    running   2 vCPU · iad1  12m of 20m', 'docs       Docker    sleeping  4 vCPU                     disconnected: `foreman cloud reattach` picks the turn up again'].join('\n')
    )
    expect(calls).toEqual([])
  })

  it('asks the provider again for one workspace, and falls back to what it knew when it can’t', async () => {
    const { call, calls } = rig({ api: { cloudStatus: (async (...args: unknown[]) => (calls.push(['cloudStatus', ...args]), cloud({ status: 'capped' }))) as Api['cloudStatus'] } })
    const result = await call<CloudStatusResult>('cloud-status', { workspace: 'api-fix', cwd: '/' })
    expect(calls).toEqual([['cloudStatus', 'ws1']])
    expect(result.workspaces[0].status).toBe('capped')
    const down = rig({ api: { cloudStatus: (async () => Promise.reject(new Error('Vercel is down.'))) as Api['cloudStatus'] } })
    const fallback = await down.call<CloudStatusResult>('cloud-status', { workspace: 'api-fix', cwd: '/' })
    expect(fallback.workspaces[0].status).toBe('running')
    expect(fallback.text).toContain('Couldn’t ask Vercel: Vercel is down. Showing what Foreman last knew.')
  })

  it('says when there are none, and refuses a workspace that runs on this computer', async () => {
    const { call } = rig({ workspaces: [ws({ cloud: undefined })] })
    expect((await call<CloudStatusResult>('cloud-status', {})).text).toBe('No remote workspaces.')
    for (const method of ['cloud-status', 'cloud-wake', 'cloud-sleep', 'cloud-restart', 'cloud-reattach']) {
      const error = await failure(call(method, { workspace: 'api-fix', cwd: '/' }))
      expect(error.code, method).toBe('invalid')
      expect(error.message).toContain('runs on this computer')
    }
  })

  it('wakes, sleeps, restarts and reattaches through the calls the Remote screen makes, and an agent turn may', async () => {
    const { call, calls } = rig({ host: turnHost(false) })
    const woke = await call<CloudActionResult>('cloud-wake', { workspace: 'api-fix', cwd: '/' }, 'k')
    expect(woke).toMatchObject({ verb: 'wake', status: 'running', workspace: { id: 'ws1', name: 'api-fix' } })
    expect(woke.text).toBe('Woke api-fix’s sandbox: running.')
    expect((await call<CloudActionResult>('cloud-sleep', { workspace: 'api-fix', cwd: '/' })).text).toContain('Its files are kept')
    await call('cloud-restart', { workspace: 'api-fix', cwd: '/' })
    const reattached = await call<CloudActionResult>('cloud-reattach', { workspace: 'api-fix', cwd: '/' })
    expect(reattached.status).toBeUndefined()
    expect(calls).toEqual([['cloudWake', 'ws1'], ['cloudSleep', 'ws1'], ['cloudRestart', 'ws1'], ['cloudReattach', 'ws1']])
  })
})

describe('continue and usage', () => {
  it('continues the picked tab and prints the turn, like send', async () => {
    const { call, calls } = rig({ sessions: [tab('s1'), tab('s2')] })
    expect((await failure(call('cloud-continue', { workspace: 'api-fix', cwd: '/' }))).code).toBe('ambiguous')
    const result = await call<CloudContinueResult>('cloud-continue', { workspace: 'api-fix', cwd: '/', tab: 2 })
    expect(calls).toEqual([['cloudContinue', 's2']])
    expect(result).toMatchObject({ tab: 2, session: 's2', turn: 'turn-3', disposition: 'started' })
    expect(result.text).toBe('Sent to tab 2 (Claude · Opus 5.5) as turn turn-3')
  })

  it('needs the repository’s opt-in from an agent turn, and sends nothing without it', async () => {
    const refused = rig({ host: turnHost(false) })
    expect((await failure(refused.call('cloud-continue', { workspace: 'api-fix', cwd: '/' }, 'k'))).code).toBe('refused')
    expect(refused.calls).toEqual([])
    const allowed = rig({ host: turnHost(true) })
    expect((await allowed.call<CloudContinueResult>('cloud-continue', { workspace: 'api-fix', cwd: '/' }, 'k')).turn).toBe('turn-3')
    const forged = rig({ host: { identifyCaller: () => null } })
    expect((await failure(forged.call('cloud-continue', { workspace: 'api-fix', cwd: '/' }, 'x'))).message).toContain('doesn’t recognise')
  })

  it('prints each provider’s usage this month', async () => {
    const usage = [{ provider: 'vercel', usage: { month: '2026-10', activeCpuMs: 2 * 3_600_000, stops: 4, memoryGbHours: 12.34 }, limits: { maxSessionMs: 45 * 60_000, maxVcpus: 4, maxConcurrent: 10 }, capabilities: { sessionCap: true }, running: 1, connectionName: 'Work' }]
    const { call } = rig({ api: { cloudUsage: (async () => usage) as unknown as Api['cloudUsage'] } })
    const result = await call<CloudUsageResult>('cloud-usage', undefined)
    expect(result.text).toBe(['Vercel (Work)  2026-10', '  running   1 (the plan allows 10 at once)', '  cpu       2h active, 4 stops', '  memory    12.3 GB-hours', '  a session ends after 45 minutes'].join('\n'))
    expect((await rig().call<CloudUsageResult>('cloud-usage', undefined)).text).toContain('No remote provider is connected')
  })
})

describe('build', () => {
  const MESSAGE = 'E2B keeps no base to build: each remote workspace is cloned and set up when it’s made.'
  const saved = { ...BUILD_WAIT }
  afterEach(() => Object.assign(BUILD_WAIT, saved))

  it('refuses a repository on a provider with no base, as not-supported, and starts nothing', async () => {
    const { call, calls } = rig({ repos: [repoOf({ cloud: { enabled: true, provider: 'e2b', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' } })] })
    const error = await failure(call('cloud-build', { repo: 'app', cwd: '/' }))
    expect(error).toMatchObject({ code: 'not-supported', message: MESSAGE })
    expect(error.hint).toContain('foreman cloud preflight')
    expect(calls).toEqual([])
  })

  it('refuses a repository whose provider is the connected default, when that is E2B', async () => {
    const { call, calls } = rig({ repos: [repoOf({ cloud: { enabled: true, vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' } })], connections: [{ id: 'c9', service: 'e2b', name: 'E2B', isDefault: true }] })
    expect((await failure(call('cloud-build', { repo: 'app', cwd: '/', wait: true }))).code).toBe('not-supported')
    expect(calls).toEqual([])
  })

  it('without --wait starts it and says where to follow it', async () => {
    const { call, calls } = rig()
    const result = await call<CloudBuildResult>('cloud-build', { repo: 'app', cwd: '/' })
    expect(calls).toEqual([['cloudBuildBase', 'r1']])
    expect(result).toMatchObject({ outcome: 'building', provider: 'vercel', build: { id: 'build-1234abcd' } })
    expect(result.text).toContain('Started building app’s base on Vercel (build build-12)')
  })

  it('with --wait forwards the build’s log lines as progress and returns when the build settles', async () => {
    BUILD_WAIT.pollMs = 5
    const repos = [repoOf({ cloud: { enabled: true, provider: 'vercel', vcpus: 2, region: 'iad1', idleMinutes: 20, autoContinue: true, installScript: '', build: build() } })]
    let listener: ((event: MainEvent) => void) | undefined
    const unsubscribed = vi.fn()
    const progress: string[] = []
    const { call, calls } = rig({
      repos,
      host: { onEvent: (l) => ((listener = l), unsubscribed) },
      api: {
        cloudBuildBase: (async (...args: unknown[]) => {
          calls.push(['cloudBuildBase', ...args])
          setTimeout(() => {
            listener?.({ type: 'cloud-build-log', repoId: 'other', buildId: 'x', chunk: 'not ours\n' })
            listener?.({ type: 'cloud-build-log', repoId: 'r1', buildId: 'build-1234abcd', chunk: 'Cloning…\nnpm install\r\n' })
          }, 10)
          setTimeout(() => {
            listener?.({ type: 'cloud-build-log', repoId: 'r1', buildId: 'build-1234abcd', chunk: 'Snapshot saved\n' })
            repos[0].cloud!.build = build({ status: 'active', snapshotId: 'snap', commit: '3f9a1c2d4e', finishedAt: '2026-10-24T12:03:00.000Z' })
          }, 40)
          return build()
        }) as Api['cloudBuildBase']
      }
    })
    const result = await call<CloudBuildResult>('cloud-build', { repo: 'app', cwd: '/', wait: true }, undefined, progress)
    expect(progress).toEqual(['Cloning…', 'npm install', 'Snapshot saved'])
    expect(result.outcome).toBe('active')
    expect(result.build.status).toBe('active')
    expect(result.text).toBe('Built app’s base on Vercel at 3f9a1c2. Remote workspaces start from it now.')
    expect(unsubscribed).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([['cloudBuildBase', 'r1']])
  })

  it('reports a failed build with the reason and the end of its log', async () => {
    BUILD_WAIT.pollMs = 5
    const repos = [repoOf({ cloud: { enabled: true, provider: 'docker', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '', build: build() } })]
    const { call } = rig({
      repos,
      api: {
        cloudBuildBase: (async () => {
          setTimeout(() => void (repos[0].cloud!.build = build({ status: 'failed', error: 'install script exited 1', log: 'step 1\nnpm ERR! boom\n' })), 20)
          return build()
        }) as Api['cloudBuildBase']
      }
    })
    const result = await call<CloudBuildResult>('cloud-build', { repo: 'app', cwd: '/', wait: true })
    expect(result.outcome).toBe('failed')
    expect(result.text).toBe('Building app’s base failed: install script exited 1\nstep 1\nnpm ERR! boom')
  })

  it('ends the wait when another build replaces this one, gives up at the cap, and stops when the command goes away', async () => {
    BUILD_WAIT.pollMs = 5
    const replaced = [repoOf({ cloud: { enabled: true, provider: 'vercel', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '', build: build() } })]
    const one = rig({
      repos: replaced,
      api: { cloudBuildBase: (async () => (setTimeout(() => void (replaced[0].cloud!.build = build({ id: 'newer', status: 'building' })), 15), build())) as Api['cloudBuildBase'] }
    })
    expect((await one.call<CloudBuildResult>('cloud-build', { repo: 'app', cwd: '/', wait: true })).build.id).toBe('newer')

    BUILD_WAIT.capMs = 30
    const stuck = [repoOf({ cloud: { enabled: true, provider: 'vercel', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '', build: build() } })]
    const two = rig({ repos: stuck })
    const cap = await failure(two.call('cloud-build', { repo: 'app', cwd: '/', wait: true }))
    expect(cap.message).toContain('still building after 0 minutes')
    expect(cap.message).toContain('keeps running in the app')

    BUILD_WAIT.capMs = 60_000
    const gone = new AbortController()
    setTimeout(() => gone.abort(), 20)
    const three = rig({ repos: stuck })
    expect((await failure(three.call('cloud-build', { repo: 'app', cwd: '/', wait: true }, undefined, undefined, gone.signal))).message).toContain('Stopped waiting')
  })

  it('stops listening when starting the build fails', async () => {
    const unsubscribed = vi.fn()
    const { call } = rig({ host: { onEvent: () => unsubscribed }, api: { cloudBuildBase: (async () => Promise.reject(new Error('app’s base is already being built'))) as Api['cloudBuildBase'] } })
    await expect(call('cloud-build', { repo: 'app', cwd: '/', wait: true })).rejects.toThrow('already being built')
    expect(unsubscribed).toHaveBeenCalledTimes(1)
  })
})

describe('preflight', () => {
  it('says a workspace can be made, or why not, with the sandboxes holding the slots', async () => {
    const ok = await rig().call<CloudPreflightResult>('cloud-preflight', { repo: 'app', cwd: '/' })
    expect(ok.text).toBe('A remote workspace can be made in app now.')
    const limit = rig({ api: { cloudPreflight: (async () => ({ ok: false, reason: 'limit', message: 'Running 8 of 8 remote workspaces.', running: [{ workspaceId: 'ws1', name: 'api-fix' }, { workspaceId: 'ws2', name: 'docs' }] })) as Api['cloudPreflight'] } })
    const no = await limit.call<CloudPreflightResult>('cloud-preflight', { repo: 'app', cwd: '/' })
    expect(no.preflight).toMatchObject({ ok: false, reason: 'limit' })
    expect(no.text).toBe(['A remote workspace can’t be made in app now: Running 8 of 8 remote workspaces.', '  running  api-fix, docs', '  why      limit: Sleep or archive one of those, or raise the limit in Repository settings → Remote.'].join('\n'))
    const nobuild = rig({ api: { cloudPreflight: (async () => ({ ok: false, reason: 'no-build', message: 'Build the base first.' })) as Api['cloudPreflight'] } })
    expect((await nobuild.call<CloudPreflightResult>('cloud-preflight', { cwd: '/app' })).text).toContain('`foreman cloud build`')
  })
})

describe('policy and the socket', () => {
  const SPEC_OF: Record<string, string> = {
    'cloud-status': 'cloud status',
    'cloud-wake': 'cloud wake',
    'cloud-sleep': 'cloud sleep',
    'cloud-restart': 'cloud restart',
    'cloud-reattach': 'cloud reattach',
    'cloud-continue': 'cloud continue',
    'cloud-usage': 'cloud usage',
    'cloud-build': 'cloud build',
    'cloud-preflight': 'cloud preflight'
  }

  it('gives each method the tier its command declares, and every command a method', () => {
    expect(Object.keys(CLOUD_METHODS).sort()).toEqual(Object.keys(SPEC_OF).sort())
    for (const [method, name] of Object.entries(SPEC_OF)) {
      const spec = CLOUD_COMMANDS.find((c) => commandName(c) === name)
      expect(spec, name).toBeTruthy()
      expect(CLOUD_METHODS[method].tier, method).toBe(spec!.tier)
    }
    expect(CLOUD_COMMANDS).toHaveLength(Object.keys(SPEC_OF).length)
  })

  it('refuses a build from any agent turn, and without the launch token', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    expect(tierCheck('cloud-build', 'admin', { v: 2, method: 'cloud-build', params: {}, caller, token: 'test-token' }, host)).toMatchObject({ code: 'refused' })
    expect(tierCheck('cloud-build', 'admin', { v: 2, method: 'cloud-build', params: {} }, host)).toMatchObject({ code: 'refused' })
    expect(tierCheck('cloud-build', 'admin', { v: 2, method: 'cloud-build', params: {}, token: 'test-token' }, host)).toBeNull()
    for (const method of ['cloud-status', 'cloud-usage', 'cloud-preflight', 'cloud-wake']) expect(tierCheck(method, CLOUD_METHODS[method].tier, { v: 2, method, params: {}, caller }, host), method).toBeNull()
  })

  describe('over the socket', () => {
    let close: (() => void) | undefined
    afterEach(() => {
      close?.()
      for (const key of Object.keys(CLOUD_METHODS)) delete METHODS[key]
    })

    it('streams the build log as progress frames, refuses E2B as not-supported and a build from a turn with 7', async () => {
      Object.assign(METHODS, CLOUD_METHODS)
      BUILD_WAIT.pollMs = 5
      const dataDir = await tempDir()
      const repos = [repoOf({ cloud: { enabled: true, provider: 'vercel', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '', build: build() } }), repoOf({ id: 'r2', name: 'edge', rootPath: '/edge', cloud: { enabled: true, provider: 'e2b', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' } })]
      let listener: ((event: MainEvent) => void) | undefined
      const { host } = rig({
        repos,
        host: { onEvent: (l) => ((listener = l), () => undefined) },
        api: {
          cloudBuildBase: (async () => {
            setTimeout(() => {
              listener?.({ type: 'cloud-build-log', repoId: 'r1', buildId: 'build-1234abcd', chunk: 'Installing\n' })
              repos[0].cloud!.build = build({ status: 'active' })
            }, 20)
            return build()
          }) as Api['cloudBuildBase']
        }
      })
      const socket = socketPath(dataDir)
      const server = await startCliServer(socket, host)
      close = () => server.close()
      const frames: unknown[] = []
      const result = await requestV2<CloudBuildResult>(socket, 'cloud-build', { repo: 'app', cwd: '/', wait: true }, { token: 'test-token', onProgress: (p) => frames.push(p) })
      expect(frames).toEqual([{ text: 'Installing' }])
      expect(result.outcome).toBe('active')
      await expect(requestV2(socket, 'cloud-build', { repo: 'edge', cwd: '/' }, { token: 'test-token' })).rejects.toMatchObject({ code: 'not-supported', exitCode: 1 })
      await expect(requestV2(socket, 'cloud-build', { repo: 'app', cwd: '/' }, { token: 'test-token', caller: { sessionId: 's', turnId: 't', token: 'k' } })).rejects.toMatchObject({ code: 'refused', exitCode: 7 })
    })
  })
})

describe('the commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
    const sent: [string, unknown, unknown?][] = []
    const out: string[] = []
    const context: Context = {
      args,
      opts,
      json: Boolean(opts.json),
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string, params?: unknown, options?: unknown) => {
        sent.push([method, params, options])
        return answers[method]
      }) as Context['send'],
      print: (value, text) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
      confirm: async () => true,
      note: () => undefined,
      progress: () => undefined
    }
    return { context, sent, out }
  }

  afterEach(() => void (process.exitCode = undefined))

  it('does not ask before building: a build only spends compute', async () => {
    const result: CloudBuildResult = { repo: { id: 'r1', name: 'app' }, provider: 'vercel', build: build(), outcome: 'building', text: 'Started building' }
    const { context, sent, out } = fakeContext(['app'], {}, { 'cloud-build': result })
    await cloudRunners['cloud build'](context)
    expect(sent).toEqual([['cloud-build', { repo: 'app', cwd: '/work', wait: undefined }, { waiting: false }]])
    expect(out).toEqual(['Started building'])
    expect(process.exitCode).toBeUndefined()
  })

  it('build --wait is a waiting request, and a failed build exits 1', async () => {
    const failed: CloudBuildResult = { repo: { id: 'r1', name: 'app' }, provider: 'vercel', build: build({ status: 'failed' }), outcome: 'failed', text: 'Building app’s base failed' }
    const { context, sent } = fakeContext([], { wait: true }, { 'cloud-build': failed })
    await cloudRunners['cloud build'](context)
    expect(sent[0]).toEqual(['cloud-build', { repo: undefined, cwd: '/work', wait: true }, { waiting: true }])
    expect(process.exitCode).toBe(1)
  })

  it('preflight exits 1 when a workspace can’t be made', async () => {
    const no: CloudPreflightResult = { repo: { id: 'r1', name: 'app' }, preflight: { ok: false, reason: 'disabled', message: 'Off.' }, text: 'can’t' }
    await cloudRunners['cloud preflight'](fakeContext(['app'], {}, { 'cloud-preflight': no }).context)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await cloudRunners['cloud preflight'](fakeContext(['app'], {}, { 'cloud-preflight': { ...no, preflight: { ok: true } } }).context)
    expect(process.exitCode).toBeUndefined()
  })

  it('sends the words each command takes, and refuses what it can’t use', async () => {
    const answers = Object.fromEntries(Object.keys(CLOUD_METHODS).map((m) => [m, { text: 'ok' }]))
    const run = async (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      const { context, sent } = fakeContext(args, opts, answers)
      await cloudRunners[name](context)
      return sent.map(([m, p]) => [m, p])
    }
    expect(await run('cloud status', [])).toEqual([['cloud-status', { workspace: undefined, cwd: '/work' }]])
    expect(await run('cloud status', ['api-fix'])).toEqual([['cloud-status', { workspace: 'api-fix', cwd: '/work' }]])
    expect(await run('cloud wake', ['api-fix'])).toEqual([['cloud-wake', { workspace: 'api-fix', cwd: '/work' }]])
    expect(await run('cloud continue', ['api-fix'], { tab: '2' })).toEqual([['cloud-continue', { workspace: 'api-fix', cwd: '/work', tab: 2 }]])
    expect(await run('cloud usage', [])).toEqual([['cloud-usage', undefined]])
    for (const [name, args, opts] of [
      ['cloud wake', [], {}],
      ['cloud sleep', ['a', 'b'], {}],
      ['cloud continue', ['a'], { tab: 'x' }],
      ['cloud usage', ['a'], {}],
      ['cloud build', ['a', 'b'], {}],
      ['cloud preflight', ['a', 'b'], {}]
    ] as [string, string[], Record<string, unknown>][]) {
      await expect(run(name, args, opts), `${name} ${args.join(' ')}`).rejects.toMatchObject({ exitCode: 2 })
    }
  })
})

describe('the command table', () => {
  it('resolves each path', () => {
    expect(findCommand(['cloud', 'build', 'api', '--wait'], CLOUD_COMMANDS)).toMatchObject({ spec: { path: ['cloud', 'build'] }, rest: ['api', '--wait'] })
    expect(findCommand(['cloud', 'status'], CLOUD_COMMANDS)).toMatchObject({ spec: { path: ['cloud', 'status'] } })
  })

  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of CLOUD_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(cloudRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      expect(help).toContain(spec.usage)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) {
        expect(help).toContain(example)
        expect(findCommand(example.replace(/^foreman /, '').split(' '), CLOUD_COMMANDS), example).toHaveProperty('spec')
      }
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, name).toBe(shorts.length)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(cloudRunners).sort()).toEqual(CLOUD_COMMANDS.map(commandName).sort())
  })

  it('parses the options each declares', () => {
    const build = CLOUD_COMMANDS.find((c) => commandName(c) === 'cloud build')!
    expect(parseCommandArgs(build, ['app', '--wait'])).toMatchObject({ positionals: ['app'], opts: { wait: true } })
    expect(() => parseCommandArgs(build, ['app', '--tab', '2'])).toThrow('doesn’t take --tab')
    const cont = CLOUD_COMMANDS.find((c) => commandName(c) === 'cloud continue')!
    expect(parseCommandArgs(cont, ['api-fix', '-t', '2']).opts).toMatchObject({ tab: '2' })
  })
})
