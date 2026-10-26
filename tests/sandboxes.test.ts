// Cloud workspaces' sandbox lifecycle against the fake provider:
// base builds, creating a workspace, wake and sleep, idle sleep, session caps, the soft limit,
// archive, forget, orphans, and that nothing happens without a cloud workspace.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeProvider, type FakeSandbox } from '../src/main/cloud/fakeProvider'
import { SandboxNotRunningError } from '../src/main/cloud/provider'
import { createProvider } from '../src/main/cloud/providers'
import { CloudLimitError, CloudUnavailableError, SandboxManager } from '../src/main/cloud/sandboxes'
import { Environment } from '../src/main/environment'
import { git, gitOut } from '../src/main/git'
import { secretKey } from '../src/main/integrations'
import { workspaceTarget } from '../src/main/runtime'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import {
  addUsage,
  cleanRepoCloudPatch,
  CLOUD_PROVIDERS,
  cloudDefaults,
  cloudSettings,
  cloudStatusFrom,
  extensionMs,
  githubHttpsUrl,
  patchCloudSettings,
  planAllowances,
  planLimits,
  receiptGbHours,
  redactSecrets,
  sandboxNotRunningReason,
  sessionBudgetMs,
  usageMonth,
  type PlanLimits,
  type ProviderCapabilities
} from '../src/shared/cloud'
import type { Connection, Resolution } from '../src/shared/integrations'
import type { Workspace } from '../src/shared/types'
import { chatsOnly, isHistoryOnly } from '../src/shared/workspacePath'
import { makeRepo, tempDir } from './helpers'

const MIN = 60_000
const VERCEL_TOKEN = 'vercel_SECRET_token_1234'
const GH_TOKEN = 'gho_repo_token'
const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

async function rig(options: { limits?: PlanLimits; connected?: boolean; capabilities?: Partial<ProviderCapabilities> } = {}) {
  const limits = options.limits ?? planLimits('hobby')
  const dataDir = await tempDir('foreman-cloud-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-cloud-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  // Phase 2b: cloud workspaces are made only with the feature on (Settings → Cloud workspaces).
  store.state.settings.cloud = patchCloudSettings(store.state.settings, { enabled: true })
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), plain)
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  let now = Date.parse('2026-10-23T10:00:00Z')
  const fake = new FakeProvider(await tempDir('foreman-cloud-sb-'), { limits, clock: () => now, capabilities: options.capabilities })
  const connection: Connection = { id: 'vc1', service: 'vercel', name: 'Vercel', rev: 1, auth: { kind: 'token' }, agentAccess: 'off', vercel: { teamId: 'team_1', projectId: 'prj_1', plan: 'hobby', limits }, createdAt: 'x' }
  const connected = options.connected ?? true
  if (connected) secrets.setAppSecret(secretKey(connection.id), VERCEL_TOKEN)
  const vercel: { resolution: Resolution } = { resolution: connected ? { state: 'ready', connection, source: 'default' } : { state: 'none', source: 'default', off: false } }
  const factory: { connection?: Connection; secret?: string; made: number } = { made: 0 }
  const activity = { turn: new Set<string>(), terminal: new Set<string>(), focused: new Set<string>() }
  const buildLogs: string[] = []
  const upstream = await makeRepo({ 'README.md': 'hi\n' })
  const clone = await tempDir()
  await git(path.dirname(clone), ['clone', '-q', upstream, clone])
  const manager = new SandboxManager({
    store,
    secrets,
    connection: (service) => (service === 'vercel' ? vercel.resolution : { state: 'none', source: 'default', off: false }),
    provider: (connection, secret) => {
      factory.connection = connection
      factory.secret = secret
      factory.made++
      return fake
    },
    clock: () => now,
    githubToken: () => GH_TOKEN,
    cloneUrl: async () => upstream,
    gitIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    settingsFor: (id) => service.settingsFor(id),
    changed: () => undefined,
    buildLog: (_repo, _build, chunk) => buildLogs.push(chunk),
    turnRunning: (id) => activity.turn.has(id),
    terminalOpen: (id) => activity.terminal.has(id),
    focused: (id) => activity.focused.has(id)
  })
  service.cloud = manager
  const repo = await service.addRepo(clone)
  return { store, service, manager, fake, repo, upstream, factory, activity, buildLogs, vercel, connection, advance: (ms: number) => (now += ms), now: () => now }
}

type Rig = Awaited<ReturnType<typeof rig>>

async function waitForState(ws: Workspace, states: Workspace['state'][]): Promise<void> {
  for (let i = 0; i < 400 && !states.includes(ws.state); i++) await new Promise((r) => setTimeout(r, 50))
  expect(states).toContain(ws.state)
}

/** A repository with an active build, and a ready cloud workspace. */
async function built(r: Rig) {
  r.service.updateRepo(r.repo.id, { cloud: { enabled: true, installScript: 'echo installing\necho built > built.txt' } })
  const build = await r.manager.buildBase(r.repo.id)
  expect(build.error).toBeUndefined()
  return build
}

async function cloudWorkspace(r: Rig): Promise<Workspace> {
  const ws = await r.service.createWorkspace(r.repo.id, { location: 'cloud' })
  await waitForState(ws, ['ready', 'error', 'setup-failed'])
  expect(ws.error).toBeUndefined()
  expect(ws.state).toBe('ready')
  return ws
}

const sandboxOf = (r: Rig, ws: Workspace) => r.fake.sandboxes.get(ws.cloud!.id) as FakeSandbox

describe('base builds', () => {
  it('clones with the GitHub token, moves the clone into repo/, runs the install script and snapshots', async () => {
    const r = await rig()
    const build = await built(r)
    expect(build.status).toBe('active')
    expect(build.snapshotId).toMatch(/^snap_foreman-base-/)
    expect(build.commit).toBe(await gitOut(r.upstream, ['rev-parse', 'HEAD']))
    const base = r.fake.sandboxes.get(`foreman-base-${r.repo.id}`) as FakeSandbox
    expect(base.state).toBe('stopped')
    // The test looks inside: reads don't resume a stopped sandbox.
    await base.exec('true', [], { wake: true })
    const create = r.fake.callsOf('create')[0].detail as { source?: Record<string, unknown>; tags: Record<string, string>; vcpus: number; region: string; timeoutMs: number }
    // The clone happens inside the sandbox (the SDK's git source lands in the image's working directory, not ours).
    expect(create.source).toBeUndefined()
    const clone = r.fake.callsOf('exec').find((c) => (c.args as string[])[1]?.includes('git -c credential.helper'))
    expect(clone?.env).toMatchObject({ FOREMAN_CLONE_URL: r.upstream, FOREMAN_CLONE_DIR: '/vercel/sandbox/repo', GH_TOKEN })
    expect(create.tags).toEqual({ app: 'foreman', repo: r.repo.id, role: 'base' })
    expect(create).toMatchObject({ vcpus: 2, region: 'iad1', timeoutMs: 30 * MIN })
    expect((await base.readFile('/vercel/sandbox/repo/built.txt'))?.toString().trim()).toBe('built')
    expect(await base.exists('/vercel/sandbox/repo/README.md')).toBe(true)
    expect(await base.exists('/vercel/foreman/README.md')).toBe(true)
    // The clone keeps no credentials: origin is the plain URL.
    const config = (await base.readFile('/vercel/sandbox/repo/.git/config'))!.toString()
    expect(config).not.toContain(GH_TOKEN)
    expect(r.buildLogs.join('')).toContain('installing')
    expect(r.repo.cloud?.build?.log).toContain('installing')
    expect(r.manager.usage()).toMatchObject({ stops: 1, activeCpuMs: 1000 })
    // The install script gets the repository's GitHub token (the user's decision, for private packages) and nothing else.
    const install = r.fake.callsOf('exec').find((c) => c.cmd === 'bash' && c.args?.[1]?.includes('installing'))!
    expect(install.args?.[1]).toMatch(/^set -euo pipefail\n/)
    expect(install.env).toEqual({ GH_TOKEN })
    expect(JSON.stringify(r.fake.calls)).not.toContain(VERCEL_TOKEN)
  })

  it('records a failed install script and stops the sandbox; a rebuild replaces the base', async () => {
    const r = await rig()
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, installScript: 'echo nope; exit 7' } })
    const failed = await r.manager.buildBase(r.repo.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/exit code 7/)
    expect((r.fake.sandboxes.get(`foreman-base-${r.repo.id}`) as FakeSandbox).state).toBe('stopped')
    r.service.updateRepo(r.repo.id, { cloud: { installScript: '' } })
    const again = await r.manager.buildBase(r.repo.id)
    expect(again.status).toBe('active')
    expect(r.fake.callsOf('delete')[0]).toMatchObject({ sandbox: `foreman-base-${r.repo.id}`, detail: { snapshots: true } })
    expect(r.repo.cloud?.build?.id).toBe(again.id)
    // A failed build doesn't hold the repository: it can be built, and turned off, again.
    expect(r.manager.building(r.repo.id)).toBe(false)
  })

  it('saves a running build’s log every couple of seconds, not per chunk, and all of it at the end', async () => {
    const r = await rig()
    const save = vi.spyOn(r.store, 'save')
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, installScript: 'for i in $(seq 1 40); do echo "line $i"; sleep 0.01; done' } })
    save.mockClear()
    const build = await r.manager.buildBase(r.repo.id)
    expect(build.status).toBe('active')
    // Every chunk reaches the window; the disk is written a handful of times (the build's own steps), not once a chunk.
    expect(r.buildLogs.length).toBeGreaterThan(10)
    expect(save.mock.calls.length).toBeLessThan(r.buildLogs.length / 2)
    expect(r.store.state.repos.find((x) => x.id === r.repo.id)?.cloud?.build?.log).toContain('Build finished.')
  })

  it('refuses to turn the cloud off or remove the repository while its base is building', async () => {
    const r = await rig()
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, installScript: 'sleep 1' } })
    const { done } = r.manager.startBuild(r.repo.id)
    expect(r.manager.building(r.repo.id)).toBe(true)
    expect(() => r.service.updateRepo(r.repo.id, { cloud: { enabled: false } })).toThrow(/being built/)
    expect(r.repo.cloud?.enabled).toBe(true)
    await expect(r.service.removeRepo(r.repo.id)).rejects.toThrow(/being built/)
    await expect(r.manager.deleteBase(r.repo)).rejects.toThrow(/being built/)
    expect((await done).status).toBe('active')
    expect(r.manager.building(r.repo.id)).toBe(false)
    expect(r.fake.sandboxes.has(`foreman-base-${r.repo.id}`)).toBe(true)
    r.service.updateRepo(r.repo.id, { cloud: { enabled: false } })
    for (let i = 0; i < 100 && r.fake.sandboxes.has(`foreman-base-${r.repo.id}`); i++) await new Promise((res) => setTimeout(res, 20))
    expect(r.fake.sandboxes.has(`foreman-base-${r.repo.id}`)).toBe(false)
  })

  it('needs a Vercel connection, and a GitHub remote', async () => {
    const off = await rig({ connected: false })
    expect(() => off.manager.startBuild(off.repo.id)).toThrow(CloudUnavailableError)
    const r = await rig()
    const noRemote = new SandboxManager({ ...(r.manager as unknown as { deps: ConstructorParameters<typeof SandboxManager>[0] }).deps, cloneUrl: async () => null })
    const build = await noRemote.buildBase(r.repo.id)
    expect(build.status).toBe('failed')
    expect(build.error).toMatch(/GitHub remote/)
  })
})

describe('cloud workspaces', () => {
  it('forks the base, checks out its branch with the git identity, and runs setup in the sandbox', async () => {
    const r = await rig()
    await built(r)
    r.service.updateRepoSettings(r.repo.id, { setupScript: 'echo "$FOREMAN_WORKSPACE_PATH|$FOREMAN_IS_CLOUD|${FOREMAN_PORT:-none}" > setup.txt' })
    const ws = await cloudWorkspace(r)
    expect(ws.path).toBeUndefined()
    expect(ws.cloud).toMatchObject({ provider: 'vercel', id: `foreman-ws-${ws.id}`, status: 'running', region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox/repo', buildId: r.repo.cloud?.build?.id })
    expect(isHistoryOnly(ws)).toBe(false)
    expect(chatsOnly(ws)).toBe(false)
    const rt = r.manager.runtime(ws)
    expect(await gitOut(rt, ['branch', '--show-current'])).toBe(ws.branch)
    expect(ws.branch).toBe(`test/${ws.name}`)
    // Not tracking the base, like a local workspace.
    expect((await git(rt, ['rev-parse', '--abbrev-ref', '@{upstream}'], { allowFail: true })).code).not.toBe(0)
    expect(await gitOut(rt, ['config', 'user.name'])).toBe('Ada Lovelace')
    expect(await gitOut(rt, ['config', 'user.email'])).toBe('ada@example.com')
    expect((await rt.readFile('built.txt'))?.toString().trim()).toBe('built')
    expect((await rt.readFile('setup.txt'))?.toString().trim()).toMatch(/\/vercel\/sandbox\/repo\|1\|none$/)
    const fork = r.fake.callsOf('fork')[0].detail as Record<string, unknown>
    expect(fork).toMatchObject({ source: `foreman-base-${r.repo.id}`, name: ws.cloud!.id, timeoutMs: 45 * MIN, tags: { app: 'foreman', repo: r.repo.id, workspace: ws.id } })
    const gh = r.fake.callsOf('exec').find((c) => c.cmd === 'gh')!
    expect(gh.args).toEqual(['auth', 'setup-git'])
    expect(gh.env).toEqual({ GH_TOKEN })
    // Setup got the workspace's variables, not this computer's shell environment or tokens.
    const setup = r.fake.callsOf('exec').find((c) => c.cmd === 'bash' && c.args?.[1]?.includes('setup.txt'))!
    expect(setup.env).toMatchObject({ FOREMAN_IS_CLOUD: '1', FOREMAN_WORKSPACE_PATH: '/vercel/sandbox/repo' })
    expect(Object.keys(setup.env!)).not.toContain('PATH')
    expect(Object.keys(setup.env!)).not.toContain('GH_TOKEN')
    expect(r.service.env(ws)).not.toHaveProperty('FOREMAN_PORT')
    expect(await r.service.setupLog(ws.id)).toContain('git checkout --no-track -b')
    // The Vercel token reached the provider factory (with the connection's team and project) and nothing else.
    expect(r.factory.secret).toBe(VERCEL_TOKEN)
    expect(r.factory.connection?.vercel).toMatchObject({ teamId: 'team_1', projectId: 'prj_1' })
    expect(JSON.stringify(r.fake.calls)).not.toContain(VERCEL_TOKEN)
  })

  it('renames its branch through the sandbox', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    expect(await r.service.renameBranch(ws, 'test/better-name')).toBe('test/better-name')
    expect(await gitOut(r.manager.runtime(ws), ['branch', '--show-current'])).toBe('test/better-name')
  })

  it('is refused without a connection or an active build, before anything is recorded', async () => {
    const off = await rig({ connected: false })
    await expect(off.service.createWorkspace(off.repo.id, { location: 'cloud' })).rejects.toThrow(CloudUnavailableError)
    const r = await rig()
    await expect(r.service.createWorkspace(r.repo.id, { location: 'cloud' })).rejects.toThrow(/Build .* base on Vercel first/)
    expect(r.store.state.workspaces).toHaveLength(0)
    await expect(r.service.createWorkspace(r.repo.id, { location: 'cloud', branch: { kind: 'direct', name: 'main' } })).rejects.toThrow(/repository folder/)
  })

  it('records a failed fork as an error with the reason', async () => {
    const r = await rig()
    await built(r)
    r.fake.failNext('fork', new Error('quota exceeded'))
    const ws = await r.service.createWorkspace(r.repo.id, { location: 'cloud' })
    await waitForState(ws, ['error', 'ready'])
    expect(ws.state).toBe('error')
    expect(ws.error).toBe('quota exceeded')
    expect(ws.cloud).toMatchObject({ status: 'failed', error: 'quota exceeded' })
  })

  it('sleeps and wakes, adding up stop receipts', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    await r.manager.sleep(ws)
    expect(ws.cloud!.status).toBe('sleeping')
    expect(ws.cloud!.sessionExpiresAt).toBeUndefined()
    expect(sandboxOf(r, ws).state).toBe('stopped')
    expect(r.manager.usage()).toMatchObject({ stops: 2, activeCpuMs: 2000 })
    await r.manager.wake(ws)
    expect(ws.cloud!.status).toBe('running')
    expect(sandboxOf(r, ws).resumes).toBe(1)
    expect(ws.cloud!.sessionExpiresAt).toBe(new Date(r.now() + 45 * MIN).toISOString())
    await r.manager.restart(ws)
    expect(ws.cloud!.status).toBe('running')
    expect(sandboxOf(r, ws).stops).toBe(2)
    expect(sandboxOf(r, ws).resumes).toBe(2)
  })

  it('marks a workspace whose sandbox disappeared as gone', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    await sandboxOf(r, ws).delete()
    expect((await r.manager.refreshStatus(ws)).status).toBe('gone')
    await expect(r.manager.wake(ws)).rejects.toThrow(/no longer exists/)
  })

  it('reports a provider that can’t be reached as unresponsive', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    r.fake.failNext('get', new Error('ECONNRESET'))
    expect(await r.manager.refreshStatus(ws)).toMatchObject({ status: 'unresponsive', error: 'ECONNRESET' })
    expect((await r.manager.refreshStatus(ws)).status).toBe('running')
  })

  it('never resumes a sandbox for a read: an old `running` is checked first, and a stopped sandbox refuses', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    // Fresh: a read trusts the status it has (no fetch).
    const fetches = r.fake.callsOf('session').length
    await r.manager.ready(ws, false)
    expect(r.fake.callsOf('session').length).toBe(fetches)
    // The session timed out by itself; Foreman still thinks it runs.
    r.advance(46 * MIN)
    expect(ws.cloud!.status).toBe('running')
    await expect(gitOut(workspaceTarget(ws), ['status', '--porcelain'])).rejects.toThrow(/asleep/)
    expect(ws.cloud!.status).toBe('sleeping')
    // Even past the check, the sandbox's own commands refuse instead of resuming it (and billing a session).
    await expect(r.manager.runtime(ws).exec('git', ['status'])).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(sandboxOf(r, ws).resumes).toBe(0)
    // A user's action wakes it.
    await gitOut(workspaceTarget(ws, { wake: true }), ['status', '--porcelain'])
    expect(sandboxOf(r, ws).resumes).toBe(1)
    expect(ws.cloud!.status).toBe('running')
    // A read in a sandbox still being made says so.
    ws.cloud!.status = 'creating'
    await expect(r.manager.ready(ws, false)).rejects.toThrow(/still being created/)
  })
})

describe('idle sleep and the session budget', () => {
  it('sleeps a sandbox idle past the repository’s idle minutes, unless a turn, terminal or focus keeps it awake', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    r.advance(10 * MIN)
    await r.manager.tick()
    expect(ws.cloud!.status).toBe('running')
    r.activity.focused.add(ws.id)
    r.advance(15 * MIN)
    await r.manager.tick()
    expect(ws.cloud!.status).toBe('running')
    expect(ws.cloud!.lastActivityAt).toBe(new Date(r.now()).toISOString())
    r.activity.focused.delete(ws.id)
    r.activity.terminal.add(ws.id)
    r.advance(25 * MIN)
    await r.manager.tick()
    expect(ws.cloud!.status).toBe('running')
    r.activity.terminal.delete(ws.id)
    r.advance(19 * MIN)
    await r.manager.tick()
    expect(ws.cloud!.status).toBe('running')
    r.advance(2 * MIN)
    await r.manager.tick()
    expect(ws.cloud!.status).toBe('sleeping')
    expect(sandboxOf(r, ws).state).toBe('stopped')
  })

  it('keeps 15 minutes of headroom while a terminal is open, up to the plan’s cap, with one session fetch a tick', async () => {
    const r = await rig({ limits: planLimits('pro') })
    await built(r)
    const ws = await cloudWorkspace(r)
    const started = r.now()
    expect(ws.cloud!.sessionExpiresAt).toBe(new Date(started + 120 * MIN).toISOString())
    r.activity.terminal.add(ws.id)
    r.advance(100 * MIN)
    const fetches = r.fake.callsOf('session').length
    await r.manager.tick()
    expect(r.fake.callsOf('extendTimeout')).toHaveLength(0)
    expect(r.fake.callsOf('session').length - fetches).toBe(1)
    r.advance(10 * MIN)
    await r.manager.tick()
    // 10 minutes left: topped up to 30.
    expect(r.fake.callsOf('extendTimeout').map((c) => c.detail)).toEqual([20 * MIN])
    expect(ws.cloud!.sessionExpiresAt).toBe(new Date(started + 140 * MIN).toISOString())
    // A turn's keepalives extend its session (CloudTurnHost): the ticker leaves it to them.
    r.activity.terminal.delete(ws.id)
    r.activity.turn.add(ws.id)
    r.advance(20 * MIN)
    const before = r.fake.calls.length
    await r.manager.tick()
    expect(r.fake.calls.slice(before)).toEqual([])
    expect(ws.cloud!.status).toBe('running')
  })

  it('can’t extend a Hobby session past 45 minutes', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    r.advance(40 * MIN)
    expect(await r.manager.extendWhileActive(ws)).toBe(0)
    expect(r.fake.callsOf('extendTimeout')).toHaveLength(0)
  })

  it('calls a session that ended at its cap during a turn capped, and one that ended otherwise asleep', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    r.activity.turn.add(ws.id)
    r.advance(46 * MIN)
    expect((await r.manager.refreshStatus(ws)).status).toBe('capped')
    expect(ws.cloud!.sessionExpiresAt).toBeDefined()
    // The cut-off turn is recorded and nothing runs: it stays capped (Continue, no wake on open) and a read says why.
    r.activity.turn.delete(ws.id)
    expect((await r.manager.refreshStatus(ws)).status).toBe('capped')
    r.advance(5 * MIN)
    expect((await r.manager.refreshStatus(ws)).status).toBe('capped')
    await expect(r.manager.ready(ws, false)).rejects.toThrow(/session limit; Continue or Wake/)
    expect(sandboxOf(r, ws).resumes).toBe(0)
    // Waking it (Continue, Wake, or a new turn) is what clears it.
    await r.manager.wake(ws)
    expect(ws.cloud!.status).toBe('running')
    // Stopped by Foreman while a turn was marked running: not a cap.
    await r.manager.sleep(ws)
    r.activity.turn.add(ws.id)
    r.advance(60 * MIN)
    expect((await r.manager.refreshStatus(ws)).status).toBe('sleeping')
  })
})

describe('the soft limit on running sandboxes', () => {
  it('refuses another running sandbox past Settings’ limit, listing the running ones', async () => {
    const r = await rig()
    await built(r)
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { maxRunning: 1 })
    const first = await cloudWorkspace(r)
    const refused = await r.service.createWorkspace(r.repo.id, { location: 'cloud' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(CloudLimitError)
    expect((refused as CloudLimitError).running).toEqual([{ workspaceId: first.id, name: first.name, repoId: r.repo.id }])
    expect((refused as CloudLimitError).message).toContain(first.name)
    // Only the message crosses IPC, so it names the sandbox too; cloudPreflight lists them before trying.
    expect((refused as CloudLimitError).message).toContain(`foreman-ws-${first.id}`)
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'limit', running: [{ workspaceId: first.id, name: first.name }] })
    await r.manager.sleep(first)
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: true })
    const second = await cloudWorkspace(r)
    await expect(r.manager.wake(first)).rejects.toThrow(CloudLimitError)
    expect(first.cloud!.status).toBe('sleeping')
    await r.manager.sleep(second)
    await r.manager.wake(first)
    expect(first.cloud!.status).toBe('running')
  })

  it('applies a repository’s own limit too, and never more than the plan allows', async () => {
    const r = await rig({ limits: { ...planLimits('hobby'), maxConcurrent: 1 } })
    await built(r)
    await cloudWorkspace(r)
    await expect(r.service.createWorkspace(r.repo.id, { location: 'cloud' })).rejects.toMatchObject({ code: 'cloud-max-running', scope: 'app', limit: 1 })
    const p = await rig()
    await built(p)
    p.service.updateRepo(p.repo.id, { cloud: { maxRunning: 1 } })
    await cloudWorkspace(p)
    await expect(p.service.createWorkspace(p.repo.id, { location: 'cloud' })).rejects.toMatchObject({ scope: 'repo', limit: 1 })
  })
})

describe('archive, restore and forget', () => {
  it('stops the sandbox on archive, keeps it asleep on restore, and deletes it with its snapshots on forget', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    await r.service.archiveWorkspace(ws.id, false)
    expect(ws.state).toBe('archived')
    expect(ws.cloud!.status).toBe('archived')
    expect(sandboxOf(r, ws).state).toBe('stopped')
    await r.service.unarchiveWorkspace(ws.id)
    expect(ws.state).toBe('ready')
    expect(ws.cloud!.status).toBe('sleeping')
    await r.service.archiveWorkspace(ws.id, false)
    const name = ws.cloud!.id
    await r.service.forgetWorkspace(ws.id)
    expect(r.fake.sandboxes.has(name)).toBe(false)
    expect(r.fake.callsOf('delete').find((c) => c.sandbox === name)?.detail).toEqual({ snapshots: true })
    expect(r.store.state.workspaces.some((w) => w.id === ws.id)).toBe(false)
  })

  it('keeps snapshots when Settings say so', async () => {
    const r = await rig()
    await built(r)
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { deleteSnapshotsOnForget: false })
    const ws = await cloudWorkspace(r)
    await r.service.archiveWorkspace(ws.id, false)
    await r.service.forgetWorkspace(ws.id)
    expect(r.fake.callsOf('delete').at(-1)?.detail).toEqual({ snapshots: false })
  })

  it('can’t restore a workspace whose sandbox is gone', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    await r.service.archiveWorkspace(ws.id, false)
    await sandboxOf(r, ws).delete()
    await expect(r.service.unarchiveWorkspace(ws.id)).rejects.toThrow(/no longer exists/)
    expect(ws.state).toBe('archived')
    expect(ws.cloud!.status).toBe('gone')
  })

  it('deletes the repository’s sandboxes and its base when the repository is removed', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    await r.service.removeRepo(r.repo.id)
    expect(r.fake.sandboxes.has(ws.cloud!.id)).toBe(false)
    expect(r.fake.sandboxes.has(`foreman-base-${r.repo.id}`)).toBe(false)
  })
})

describe('orphans and staying inert', () => {
  it('stops foreman sandboxes nothing here owns only when Settings ask, and never deletes them', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    const stranger = (await r.fake.create({ name: 'foreman-ws-stranger', vcpus: 2, region: 'iad1', timeoutMs: 45 * MIN, tags: { app: 'foreman', workspace: 'x' } })) as FakeSandbox
    const other = (await r.fake.create({ name: 'someone-else', vcpus: 2, region: 'iad1', timeoutMs: 45 * MIN, tags: { app: 'other' } })) as FakeSandbox
    expect(await r.manager.stopOrphans()).toEqual([])
    expect(stranger.state).toBe('running')
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { stopOrphansOnLaunch: true })
    expect(await r.manager.stopOrphans()).toEqual(['foreman-ws-stranger'])
    expect(stranger.state).toBe('stopped')
    expect(r.fake.sandboxes.has('foreman-ws-stranger')).toBe(true)
    expect(other.state).toBe('running')
    expect(sandboxOf(r, ws).state).toBe('running')
    expect(r.fake.callsOf('delete')).toHaveLength(0)
  })

  it('makes no provider calls without a cloud workspace, connected or not', async () => {
    const off = await rig({ connected: false })
    off.store.state.settings.cloud = patchCloudSettings(off.store.state.settings, { stopOrphansOnLaunch: true })
    await off.manager.tick()
    expect(await off.manager.stopOrphans()).toEqual([])
    expect(off.fake.calls).toEqual([])
    expect(off.factory.made).toBe(0)
    const on = await rig()
    const ws = await on.service.createWorkspace(on.repo.id)
    await waitForState(ws, ['ready', 'error'])
    on.advance(60 * MIN)
    await on.manager.tick()
    expect(on.fake.calls).toEqual([])
  })

  it('makes the provider again when the connection changes', async () => {
    const r = await rig()
    r.manager.provider()
    r.manager.provider()
    expect(r.factory.made).toBe(1)
    r.vercel.resolution = { state: 'ready', connection: { ...r.connection, rev: 2 }, source: 'default' }
    r.manager.provider()
    expect(r.factory.made).toBe(2)
    r.vercel.resolution = { state: 'broken', source: 'default', reason: 'problem', connectionId: 'vc1', connection: { ...r.connection, problem: 'Vercel refused this token.' } }
    expect(() => r.manager.provider()).toThrow(/Vercel refused this token/)
  })
})

describe('repository and personal cloud settings', () => {
  it('patches a repository’s cloud settings, checking each value and keeping the build', async () => {
    const r = await rig()
    expect(r.repo.cloud).toBeUndefined()
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, vcpus: 4, idleMinutes: 30 } })
    expect(r.repo.cloud).toMatchObject({ ...cloudDefaults(), enabled: true, vcpus: 4, idleMinutes: 30 })
    expect(() => r.service.updateRepo(r.repo.id, { cloud: { vcpus: 100 } })).toThrow(/vCPUs/)
    expect(() => r.service.updateRepo(r.repo.id, { cloud: { idleMinutes: 0 } })).toThrow(/Idle minutes/)
    await built(r)
    const build = r.repo.cloud!.build
    r.service.updateRepo(r.repo.id, { cloud: null })
    expect(r.repo.cloud).toEqual({ ...cloudDefaults(), build })
  })

  it('deletes the base sandbox when a repository’s cloud setting is turned off', async () => {
    const r = await rig()
    await built(r)
    r.service.updateRepo(r.repo.id, { cloud: { enabled: false } })
    for (let i = 0; i < 100 && r.fake.sandboxes.has(`foreman-base-${r.repo.id}`); i++) await new Promise((res) => setTimeout(res, 20))
    expect(r.fake.sandboxes.has(`foreman-base-${r.repo.id}`)).toBe(false)
    expect(r.repo.cloud?.build).toBeUndefined()
  })

  it('defaults personal settings, Claude following the local sign-in', () => {
    expect(cloudSettings({ claudeAuth: 'cli' })).toEqual({ enabled: false, claudeAuth: 'setup-token', stopOrphansOnLaunch: false, deleteSnapshotsOnForget: true, maxRunning: 8, wakeOnOpen: true })
    expect(cloudSettings({ claudeAuth: 'apiKey' }).claudeAuth).toBe('api-key')
    expect(cloudSettings({ claudeAuth: 'apiKey', cloud: { ...cloudSettings({ claudeAuth: 'cli' }), claudeAuth: 'setup-token' } }).claudeAuth).toBe('setup-token')
    expect(patchCloudSettings({ claudeAuth: 'cli' }, { maxRunning: 3 })).toMatchObject({ maxRunning: 3, claudeAuth: 'setup-token' })
    expect(() => patchCloudSettings({ claudeAuth: 'cli' }, { maxRunning: 0 })).toThrow()
    expect(() => patchCloudSettings({ claudeAuth: 'cli' }, { claudeAuth: 'oauth' as 'api-key' })).toThrow()
    expect(cleanRepoCloudPatch({ region: 'fra1' })).toEqual({ region: 'fra1' })
    expect(() => cleanRepoCloudPatch({ region: 'Frankfurt' })).toThrow()
  })
})

describe('pure rules', () => {
  it('derives limits and the session budget from the plan', () => {
    expect(planLimits('hobby')).toEqual({ maxSessionMs: 45 * MIN, maxVcpus: 4, maxConcurrent: 10 })
    expect(planLimits('pro')).toEqual({ maxSessionMs: 24 * 60 * MIN, maxVcpus: 8, maxConcurrent: 10_000 })
    expect(planLimits('enterprise')).toEqual(planLimits('pro'))
    expect(planLimits(undefined)).toEqual(planLimits('hobby'))
    expect(sessionBudgetMs(planLimits('hobby'))).toBe(45 * MIN)
    expect(sessionBudgetMs(planLimits('pro'))).toBe(120 * MIN)
  })

  it('extends only below 15 minutes of headroom, never past the cap', () => {
    const t = 1_000_000_000
    expect(extensionMs({ now: t, expiresAt: t + 20 * MIN, startedAt: t - 60 * MIN, maxSessionMs: 24 * 60 * MIN })).toBe(0)
    expect(extensionMs({ now: t, expiresAt: t + 10 * MIN, startedAt: t - 60 * MIN, maxSessionMs: 24 * 60 * MIN })).toBe(20 * MIN)
    expect(extensionMs({ now: t, expiresAt: t + 10 * MIN, startedAt: t - 35 * MIN, maxSessionMs: 45 * MIN })).toBe(0)
    expect(extensionMs({ now: t, expiresAt: t + 10 * MIN, startedAt: t - 30 * MIN, maxSessionMs: 45 * MIN })).toBe(5 * MIN)
  })

  it('says why a read can’t run, in each status’s words', () => {
    expect(sandboxNotRunningReason('oslo', 'creating')).toBe('oslo’s sandbox is still being created.')
    expect(sandboxNotRunningReason('oslo', 'waking')).toBe('oslo’s sandbox is waking.')
    expect(sandboxNotRunningReason('oslo', 'unresponsive')).toBe('oslo’s sandbox is unresponsive; Restart it.')
    expect(sandboxNotRunningReason('oslo', 'capped')).toBe('oslo’s sandbox stopped at the session limit; Continue or Wake it.')
    expect(sandboxNotRunningReason('oslo', 'sleeping')).toBe('oslo’s sandbox is asleep. Wake it to see this.')
  })

  it('maps provider states to workspace statuses', () => {
    const t = 1_000_000
    expect(cloudStatusFrom(null, { now: t, turnRunning: false })).toBe('gone')
    expect(cloudStatusFrom('running', { now: t, turnRunning: true })).toBe('running')
    expect(cloudStatusFrom('pending', { now: t, turnRunning: false })).toBe('waking')
    expect(cloudStatusFrom('snapshotting', { now: t, turnRunning: false })).toBe('sleeping')
    expect(cloudStatusFrom('aborted', { now: t, turnRunning: false })).toBe('failed')
    expect(cloudStatusFrom('stopped', { now: t, expiresAt: t - 1, turnRunning: true })).toBe('capped')
    expect(cloudStatusFrom('stopped', { now: t, expiresAt: t + MIN, turnRunning: true })).toBe('sleeping')
    expect(cloudStatusFrom('stopped', { now: t, expiresAt: t - 1, turnRunning: true, sleptByUs: true })).toBe('sleeping')
  })

  it('adds usage by month and makes https clone URLs for GitHub remotes only', () => {
    const oct = Date.parse('2026-10-23T10:00:00')
    const nov = Date.parse('2026-11-02T10:00:00')
    const one = addUsage(undefined, { activeCpuMs: 500 }, oct)
    expect(one).toEqual({ month: '2026-10', activeCpuMs: 500, stops: 1 })
    expect(addUsage(one, {}, oct)).toEqual({ month: '2026-10', activeCpuMs: 500, stops: 2 })
    expect(addUsage(one, { activeCpuMs: 1 }, nov)).toEqual({ month: '2026-11', activeCpuMs: 1, stops: 1 })
    expect(githubHttpsUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app.git')
    expect(githubHttpsUrl('https://user:tok@github.com/acme/app')).toBe('https://github.com/acme/app.git')
    expect(githubHttpsUrl('https://gitlab.com/acme/app.git')).toBeNull()
  })

  it('phase 5: counts provisioned memory from receipts with a length and size, and the plan’s allowances', () => {
    const oct = Date.parse('2026-10-23T10:00:00')
    // 2 vCPUs (4 GB) for 90 minutes: 6 GB-hours.
    const one = addUsage(undefined, { activeCpuMs: 500, durationMs: 90 * MIN, vcpus: 2 }, oct)
    expect(one).toEqual({ month: '2026-10', activeCpuMs: 500, stops: 1, memoryGbHours: 6 })
    expect(addUsage(one, { activeCpuMs: 1 }, oct)).toEqual({ month: '2026-10', activeCpuMs: 501, stops: 2, memoryGbHours: 6 })
    expect(receiptGbHours({ durationMs: 30 * MIN, vcpus: 4 })).toBe(4)
    expect(receiptGbHours({ vcpus: 4 })).toBeUndefined()
    expect(planAllowances('hobby')).toEqual({ activeCpuMs: 5 * 60 * MIN, memoryGbHours: 420, snapshotGb: 15 })
    expect(planAllowances('pro')).toEqual({})
  })

  it('phase 5: redacts tokens and URL credentials from build output', () => {
    const token = 'ghp_abcdefghijklmnop'
    expect(redactSecrets(`fatal: https://x-access-token:${token}@github.com/acme/app.git not found; GH_TOKEN=${token}`, [token])).toBe(
      'fatal: https://***@github.com/acme/app.git not found; GH_TOKEN=***'
    )
    // Short values aren't secrets worth matching (they'd blank ordinary words).
    expect(redactSecrets('npm ci done', ['ci', undefined])).toBe('npm ci done')
  })

  it('phase 5: wake on open is on unless turned off', () => {
    expect(cloudSettings({ claudeAuth: 'cli' }).wakeOnOpen).toBe(true)
    expect(patchCloudSettings({ claudeAuth: 'cli' }, { wakeOnOpen: false }).wakeOnOpen).toBe(false)
    expect(patchCloudSettings({ claudeAuth: 'cli', cloud: patchCloudSettings({ claudeAuth: 'cli' }, { wakeOnOpen: false }) }, { maxRunning: 3 }).wakeOnOpen).toBe(false)
  })
})

describe('phase 2b: the feature switch and the agent host bundle', () => {
  it('refuses a cloud workspace while cloud workspaces are off, and says why before trying', async () => {
    const r = await rig()
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'no-build' })
    await built(r)
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { enabled: false })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'disabled', message: expect.stringContaining('Remote workspaces are off') })
    await expect(r.service.createWorkspace(r.repo.id, { location: 'cloud' })).rejects.toThrow('Remote workspaces are off')
    r.vercel.resolution = { state: 'none', source: 'default', off: false }
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { enabled: true })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('uploads the host at a base build and installs its packages, gives the install script GH_TOKEN, and re-uploads on wake after an update', async () => {
    const r = await rig()
    const pkg = '{"name":"foreman-sandbox-host","dependencies":{"zod":"4.0.0"}}\n'
    let bundle = { version: '1.0.0', files: [{ path: 'sandboxHost.js', data: Buffer.from('// host 1') }, { path: 'chunks/a.js', data: Buffer.from('// chunk') }, { path: 'sandboxAttach.js', data: Buffer.from('// attach') }], packageJson: pkg }
    r.manager.hostBundle = () => bundle
    const installs: string[] = []
    r.fake.stubs.set('npm', (args, ctx) => {
      installs.push(`${ctx.sandbox.name}:${ctx.cwd}:${args.join(' ')}`)
      return { stdout: '', stderr: '', code: 0 }
    })
    const build = await built(r)
    expect(build.hostVersion).toBe('1.0.0')
    const base = r.fake.sandboxes.get(`foreman-base-${r.repo.id}`) as FakeSandbox
    await base.exec('true', [], { wake: true })
    expect((await base.readFile('/vercel/foreman/chunks/a.js'))?.toString()).toBe('// chunk')
    expect((await base.readFile('/vercel/foreman/package.json'))?.toString()).toBe(pkg)
    expect(installs).toEqual([`foreman-base-${r.repo.id}:/vercel/foreman:install --omit=dev --no-audit --no-fund --loglevel=error`])
    const script = r.fake.callsOf('exec').find((c) => c.cmd === 'bash' && c.args?.[1]?.includes('echo installing'))
    expect(script?.env).toEqual({ GH_TOKEN })

    const ws = await cloudWorkspace(r)
    expect(ws.cloud!.hostVersion).toBe('1.0.0')
    await r.manager.sleep(ws)
    // An app update: new files, the same packages, so no install.
    bundle = { ...bundle, version: '1.1.0', files: [{ path: 'sandboxHost.js', data: Buffer.from('// host 2') }, { path: 'chunks/b.js', data: Buffer.from('// chunk 2') }] }
    const before = r.fake.calls.length
    await r.manager.wake(ws)
    expect(ws.cloud!.hostVersion).toBe('1.1.0')
    // One folder made and one upload for the whole bundle, not a round trip per file.
    const upload = r.fake.calls.slice(before).filter((c) => c.sandbox === ws.cloud!.id && ['mkdir', 'writeFile', 'writeFiles'].includes(c.op))
    expect(upload).toEqual([
      { op: 'mkdir', sandbox: ws.cloud!.id, detail: '/vercel/foreman' },
      { op: 'writeFiles', sandbox: ws.cloud!.id, detail: ['/vercel/foreman/sandboxHost.js', '/vercel/foreman/chunks/b.js'] }
    ])
    expect((await sandboxOf(r, ws).readFile('/vercel/foreman/chunks/b.js'))?.toString()).toBe('// chunk 2')
    expect((await sandboxOf(r, ws).readFile('/vercel/foreman/sandboxHost.js'))?.toString()).toBe('// host 2')
    expect(installs).toHaveLength(1)
    // A version that moved an SDK installs again.
    await r.manager.sleep(ws)
    bundle = { ...bundle, version: '1.2.0', packageJson: pkg.replace('4.0.0', '4.1.0') }
    await r.manager.wake(ws)
    expect(installs).toHaveLength(2)
  })
})

describe('providers: the manager branches on capabilities, not on the provider', () => {
  it('without a base: nothing to build, and each workspace is cloned, given the host and install script, then its branch', async () => {
    const r = await rig({ capabilities: { base: false, fork: false } })
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, installScript: 'echo built > built.txt' } })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: true, provider: { id: 'vercel', ready: true, capabilities: { base: false } } })
    expect(() => r.manager.startBuild(r.repo.id)).toThrow(/keeps no base/)
    r.manager.hostBundle = () => ({ version: '9.9.9', files: [{ path: 'sandboxHost.js', data: Buffer.from('// host') }], packageJson: '{"name":"h"}' })
    r.fake.stubs.set('npm', () => ({ stdout: '', stderr: '', code: 0 }))
    const ws = await cloudWorkspace(r)
    expect(r.fake.callsOf('fork')).toHaveLength(0)
    expect(r.fake.callsOf('createFromBase')).toHaveLength(0)
    expect(r.fake.callsOf('create').map((c) => c.sandbox)).toEqual([ws.cloud!.id])
    const rt = r.manager.runtime(ws)
    expect((await rt.readFile('built.txt'))?.toString().trim()).toBe('built')
    expect(await gitOut(rt, ['branch', '--show-current'])).toBe(ws.branch)
    expect(ws.cloud).toMatchObject({ hostVersion: '9.9.9' })
    expect(ws.cloud!.buildId).toBeUndefined()
    // The clone's token never reaches the log.
    expect(await r.service.setupLog(ws.id)).not.toContain(GH_TOKEN)
  })

  it('with a base but no fork: workspaces start from the base through createFromBase', async () => {
    const r = await rig({ capabilities: { fork: false } })
    await built(r)
    const ws = await cloudWorkspace(r)
    expect(r.fake.callsOf('fork')).toHaveLength(0)
    expect(r.fake.callsOf('createFromBase')[0]).toMatchObject({ sandbox: ws.cloud!.id, detail: { base: `foreman-base-${r.repo.id}` } })
    expect((await r.manager.runtime(ws).readFile('built.txt'))?.toString().trim()).toBe('built')
  })

  it('without a session cap: no extension, no cap, and a stop under a turn is just a stop', async () => {
    const r = await rig({ capabilities: { sessionCap: false } })
    await built(r)
    const ws = await cloudWorkspace(r)
    expect(r.manager.sessionCapped(ws)).toBe(false)
    expect(ws.cloud!.maxSessionMs).toBeUndefined()
    expect(ws.cloud!.sessionExpiresAt).toBeUndefined()
    r.activity.terminal.add(ws.id)
    await r.manager.tick()
    expect(await r.manager.extendWhileActive(ws)).toBe(0)
    expect(r.fake.callsOf('extendTimeout')).toHaveLength(0)
    r.activity.turn.add(ws.id)
    await sandboxOf(r, ws).stop()
    r.advance(60 * MIN)
    expect((await r.manager.refreshStatus(ws)).status).toBe('sleeping')
  })

  it('with a session cap: the binding carries it for the window', async () => {
    const r = await rig()
    await built(r)
    const ws = await cloudWorkspace(r)
    expect(r.manager.sessionCapped(ws)).toBe(true)
    expect(ws.cloud!.maxSessionMs).toBe(45 * MIN)
  })

  it('without snapshotOnStop: archive still stops the sandbox, and warns', async () => {
    const r = await rig({ capabilities: { snapshotOnStop: false } })
    await built(r)
    const ws = await cloudWorkspace(r)
    const result = await r.manager.archive(ws)
    expect(result.warning).toMatch(/doesn’t keep a stopped sandbox’s files/)
    expect(sandboxOf(r, ws).state).toBe('stopped')
    const kept = await rig()
    await built(kept)
    expect(await kept.manager.archive(await cloudWorkspace(kept))).toEqual({})
  })

  it('counts usage per provider; the single total from before is Vercel’s', async () => {
    const r = await rig()
    r.store.state.cloudUsage = { month: usageMonth(r.now()), activeCpuMs: 5, stops: 1 }
    expect(r.manager.usage('vercel')).toMatchObject({ activeCpuMs: 5, stops: 1 })
    expect(r.store.state.cloudUsage).toBeUndefined()
    expect(r.manager.usage('docker')).toMatchObject({ activeCpuMs: 0, stops: 0 })
    await built(r)
    expect(r.manager.usage('vercel').stops).toBe(2)
    const views = r.manager.usageViews()
    expect(views.map((v) => v.provider)).toEqual(['vercel'])
    expect(views[0]).toMatchObject({ connectionId: 'vc1', connectionName: 'Vercel', limits: planLimits('hobby'), running: 0, usage: { stops: 2 } })
  })

  it('names the provider a repository chose when it can’t be used, and calls unimplemented providers coming soon', async () => {
    const r = await rig()
    r.service.updateRepo(r.repo.id, { cloud: { enabled: true, provider: 'docker' } })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('Connect Docker first'), provider: { id: 'docker', ready: false } })
    expect(r.manager.available({ provider: 'docker' })).toBe(false)
    const docker: Connection = { id: 'd1', service: 'docker', name: 'Docker', rev: 1, auth: { kind: 'docker-context' }, agentAccess: 'off', docker: { context: 'default' }, createdAt: 'x' }
    // A provider whose module isn't implemented is coming soon (Docker is; pretend it isn't).
    CLOUD_PROVIDERS.docker.implemented = false
    try {
      expect(() => createProvider(docker, undefined)).toThrow(CloudUnavailableError)
      expect(() => createProvider(docker, undefined)).toThrow(/coming soon/)
    } finally {
      CLOUD_PROVIDERS.docker.implemented = true
    }
    expect(createProvider(docker, undefined).id).toBe('docker')
    expect(() => createProvider({ ...r.connection, service: 'github' }, VERCEL_TOKEN)).toThrow(/isn’t a sandbox connection/)
  })

  it('counts the plan’s concurrency per provider, and Settings’ limit across all of them', async () => {
    const r = await rig({ limits: { ...planLimits('hobby'), maxConcurrent: 1 } })
    await built(r)
    const first = await cloudWorkspace(r)
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'limit' })
    // The same workspace counted against another provider: Vercel's plan has room again.
    first.cloud!.provider = 'docker'
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: true })
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { maxRunning: 1 })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'limit' })
  })

  it('moving a repository to another provider deletes its base where it was built, and asks for a build there', async () => {
    const r = await rig()
    await built(r)
    expect(r.repo.cloud).toMatchObject({ provider: 'vercel', build: { provider: 'vercel', status: 'active' } })
    r.service.updateRepo(r.repo.id, { cloud: { provider: 'docker' } })
    expect(r.repo.cloud?.build).toBeUndefined()
    for (let i = 0; i < 100 && r.fake.sandboxes.has(`foreman-base-${r.repo.id}`); i++) await new Promise((res) => setTimeout(res, 20))
    expect(r.fake.sandboxes.has(`foreman-base-${r.repo.id}`)).toBe(false)
    // Back on Vercel, there is no base until it's built again.
    r.service.updateRepo(r.repo.id, { cloud: { provider: 'vercel' } })
    expect(r.manager.preflightResult(r.repo)).toMatchObject({ ok: false, reason: 'no-build', message: expect.stringContaining('base on Vercel') })
  })
})
