// SandboxManager: the life of remote workspaces'
// sandboxes on any provider. A base sandbox per repository (clone, install script, saved) when the
// provider keeps bases, a sandbox per workspace started from it (or cloned and set up from scratch
// when it doesn't), wake and sleep, the session budget, plan limits, orphans and idle sleep. It branches
// on the provider's capabilities, never on its id. Foreman's main process coordinates sandbox work; a
// provider's key is read from the vault here and nowhere else, and never goes into a sandbox. GitHub's
// token reaches a sandbox only as one command's environment.
import { randomUUID } from 'node:crypto'
import {
  addUsage,
  baseSandboxName,
  CLOUD_APP_TAG,
  CLOUD_CWD,
  CLOUD_HOST_DIR,
  CLOUD_PROVIDER_IDS,
  CLOUD_PROVIDERS,
  cloudProvider,
  cloudSettings,
  cloudStatusFrom,
  extensionMs,
  holdsSlot,
  logTail,
  providerRegion,
  providerVcpus,
  redactSecrets,
  repoCloud,
  repoProvider,
  sandboxNotRunningReason,
  sessionBudgetMs,
  usageMonth,
  workspaceSandboxName,
  type CloudProviderId,
  type PlanLimits,
  type ProviderCapabilities,
  type ProviderStatus
} from '../../shared/cloud'
import { resolvedConnection, sandboxServiceFor, type Connection, type Resolution, type SandboxService } from '../../shared/integrations'
import type { CloudBuild, CloudPreflight, CloudProviderView, CloudUsage, CloudUsageView, Repo, RepoSettings, Workspace, WorkspaceCloud } from '../../shared/types'
import type { HostBundle } from '../agentHost/sandboxPackage'
import { baseStartPoint, git, gitOut, revParse } from '../git'
import { fetchPullHead } from '../intake'
import { secretKey } from '../integrations'
import { useCloudSandboxes, type CloudSandboxes } from '../runtime'
import { cloudRuntime } from '../runtime/cloud'
import type { WorkspaceRuntime } from '../runtime/types'
import type { SecretStore } from '../secrets'
import type { Store } from '../store'
import { CloudUnavailableError, type SandboxFile, type SandboxHandle, type SandboxProvider, type StopReceipt } from './provider'
import { createProvider, type ProviderFactory } from './providers'

export { CloudUnavailableError }

const MINUTE = 60_000
// A base build gets one session of at most this long (Hobby allows 45 minutes).
const BUILD_SESSION_MS = 30 * MINUTE
// A build's log is saved this often while it runs (an install prints thousands of chunks), and at its end.
const BUILD_LOG_SAVE_MS = 2_000
// A read that may not wake the sandbox trusts a `running` status this old; older, it asks the provider first.
const STATUS_FRESH_MS = 15_000

/** Starting or waking one more would pass the soft limit on running sandboxes. Lists the running ones, for "Sleep". */
export class CloudLimitError extends Error {
  readonly code = 'cloud-max-running'
  constructor(
    readonly limit: number,
    readonly running: { workspaceId: string; name: string; repoId: string }[],
    readonly scope: 'app' | 'repo'
  ) {
    // Electron passes only the message over IPC, so it names the workspaces and their sandboxes itself.
    super(
      `${running.length} remote workspace${running.length === 1 ? ' is' : 's are'} already running${scope === 'repo' ? ' in this repository' : ''} (the limit is ${limit}): ${running.map((r) => `${r.name} (${workspaceSandboxName(r.workspaceId)})`).join(', ')}. Put one to sleep first.`
    )
  }
}

/**
 * Which provider, and which of its connections: a workspace's binding (WorkspaceCloud), a repository's settings
 * (RepoCloud) and a base build (CloudBuild) all carry these. No provider: the user's default (shared/cloud.ts
 * repoProvider). No connection: the provider's service's default connection.
 */
export interface ProviderRef {
  provider?: CloudProviderId
  connectionId?: string
}

/** A resolved provider: its id, the connection it was made from, and the cache key (the connection's id and revision). */
interface Target {
  id: CloudProviderId
  connection: Connection
  key: string
  provider: SandboxProvider
}

export interface SandboxManagerDeps {
  store: Store
  secrets: SecretStore
  // A sandbox service's connection: the one chosen by id, else the service's default (Integrations.sandboxConnection()).
  connection: (service: SandboxService, connectionId?: string) => Resolution
  // The provider for a ready connection and its secret (none for Docker). Default: the registry (providers.ts). Tests return a FakeProvider.
  provider?: ProviderFactory
  clock?: () => number
  // The repository's GitHub token, for the clone and as GH_TOKEN on single commands. Never stored.
  githubToken: (repoId: string) => string | undefined
  // The https URL to clone, without credentials; null when the repository isn't on GitHub.
  cloneUrl: (repoId: string) => Promise<string | null>
  // Who the repository commits as on this computer, copied into the sandbox's git config.
  gitIdentity: (repoId: string) => Promise<{ name?: string; email?: string }>
  settingsFor: (repoId: string) => RepoSettings
  changed: () => void
  // A chunk of a base build's output.
  buildLog: (repoId: string, buildId: string, chunk: string) => void
  // Activity, for idle sleep and the session budget.
  turnRunning: (workspaceId: string) => boolean
  terminalOpen: (workspaceId: string) => boolean
  focused: (workspaceId: string) => boolean
}

// Clones the repository inside the sandbox into exactly the folder Foreman uses. The SDK's own git source
// lands wherever the image's working directory is (not /vercel/sandbox on the universal image), so we
// clone ourselves. The token reaches git through a credential helper reading GH_TOKEN, never argv or disk.
const CLONE_REPO = [
  'set -euo pipefail',
  '[ -d "$FOREMAN_CLONE_DIR/.git" ] && exit 0',
  'mkdir -p "$(dirname "$FOREMAN_CLONE_DIR")"',
  'export GIT_TERMINAL_PROMPT=0',
  // --depth 1 implies --single-branch, which would leave the fetch refspec covering only the default branch;
  // then a pushed workspace branch gets no remote-tracking ref and the Git panel sees no upstream.
  'git -c credential.helper=\'!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN:-}"; }; f\' clone --depth 1 --no-single-branch "$FOREMAN_CLONE_URL" "$FOREMAN_CLONE_DIR"'
].join('\n')

const HOST_README = [
  'Foreman keeps its own files for this sandbox here: the agent host (sandboxHost.js and its chunks),',
  'the attach bridge (sandboxAttach.js), their package.json and node_modules, and state/ (the host’s token',
  'and turn logs). Turn logs can contain sensitive tool output; keep this directory private.',
  ''
].join('\n')

const NPM_INSTALL = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']

// Read through a call, so a status changed by an awaited call isn't narrowed away.
const gone = (cloud: WorkspaceCloud): boolean => cloud.status === 'gone'
const running = (cloud: WorkspaceCloud): boolean => cloud.status === 'running'

/** The provider and connection a base was built with. No provider: Vercel, from before there were others. */
const buildRef = (build: CloudBuild): ProviderRef => ({ provider: build.provider ?? 'vercel', connectionId: build.connectionId })

export class SandboxManager implements CloudSandboxes {
  // One provider per connection, made again when the connection changes (its revision).
  private cached = new Map<string, { key: string; provider: SandboxProvider }>()
  // Handles by sandbox name, with the provider key they came from.
  private handles = new Map<string, { key: string; handle: SandboxHandle }>()
  private builds = new Map<string, Promise<CloudBuild>>()
  // Sandboxes Foreman stopped itself, so a stop isn't mistaken for a session cap.
  private sleptByUs = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  // The agent host files to upload (index.ts reads them from out/main); null where there are none (tests, unbuilt dev).
  hostBundle: (() => HostBundle | null) | null = null
  // Told when a workspace's sandbox is (again) running: cloud terminals left read-only reconnect (cloud/terminal.ts).
  private runningListeners = new Set<(ws: Workspace) => void>()
  // Told after every status read or wake that found the sandbox running: CloudTurnHost picks up turns it lost track of.
  private seenListeners = new Set<(ws: Workspace) => void>()
  // When each sandbox's status was last confirmed with the provider (by sandbox name).
  private checkedAt = new Map<string, number>()

  constructor(private deps: SandboxManagerDeps) {
    // Code that holds only a Workspace (diffs, git status, attachments) reaches its sandbox through this manager.
    useCloudSandboxes(this)
  }

  private now(): number {
    return (this.deps.clock ?? Date.now)()
  }

  private get state() {
    return this.deps.store.state
  }

  private changed(): void {
    this.deps.store.save()
    this.deps.changed()
  }

  // ---- the provider ----

  /** The provider a ref names: its own, else the user's default sandbox service, else Vercel. */
  providerId(ref: ProviderRef = {}): CloudProviderId {
    return repoProvider(ref, this.state.integrations?.defaults)
  }

  private resolution(ref: ProviderRef): { id: CloudProviderId; resolution: Resolution } {
    const id = this.providerId(ref)
    return { id, resolution: this.deps.connection(sandboxServiceFor(id), ref.connectionId || undefined) }
  }

  /** Whether the ref's provider is implemented and its connection is usable (no network). */
  available(ref: ProviderRef = {}): boolean {
    const { id, resolution } = this.resolution(ref)
    return CLOUD_PROVIDERS[id].implemented && resolution.state === 'ready'
  }

  /** The provider and connection for a ref as they are now; the provider is made again when the connection changes. */
  private target(ref: ProviderRef = {}): Target {
    const { id, resolution: r } = this.resolution(ref)
    const info = cloudProvider(id)
    if (r.state !== 'ready') {
      const problem = r.state === 'broken' ? r.connection?.problem : undefined
      throw new CloudUnavailableError(problem ? `${info.label} needs attention: ${problem}` : `Connect ${info.label} first (Settings → Integrations) to use remote workspaces.`)
    }
    if (!info.implemented) throw new CloudUnavailableError(`${info.label} remote workspaces are coming soon.`)
    const c = r.connection
    const key = `${c.id}:${c.rev}`
    const hit = this.cached.get(c.id)
    if (hit?.key === key) return { id, connection: c, key, provider: hit.provider }
    const secret = c.auth.kind === 'token' ? this.deps.secrets.appSecret(secretKey(c.id)) : undefined
    if (c.auth.kind === 'token' && !secret) throw new CloudUnavailableError(`The ${info.label} connection is incomplete. Edit it in Settings → Integrations.`)
    const provider = (this.deps.provider ?? createProvider)(c, secret)
    this.cached.set(c.id, { key, provider })
    return { id, connection: c, key, provider }
  }

  /** The provider for a ref (a workspace's binding, a repository's cloud settings), or the default one. */
  provider(ref: ProviderRef = {}): SandboxProvider {
    return this.target(ref).provider
  }

  /** What the ref's provider can do and allows: from the provider when it can be made, else shared/cloud.ts's defaults. */
  private info(ref: ProviderRef): { capabilities: ProviderCapabilities; limits: PlanLimits } {
    if (this.available(ref)) {
      try {
        const provider = this.provider(ref)
        return { capabilities: provider.capabilities(), limits: provider.limits() }
      } catch {
        // An incomplete connection: the defaults below.
      }
    }
    const fallback = cloudProvider(this.providerId(ref))
    return { capabilities: fallback.capabilities, limits: fallback.limits }
  }

  capabilities(ref: ProviderRef = {}): ProviderCapabilities {
    return this.info(ref).capabilities
  }

  limits(ref: ProviderRef = {}): PlanLimits {
    return this.info(ref).limits
  }

  /** Whether the workspace's provider ends sessions at a time limit (so a stop under a turn may be the cap). */
  sessionCapped(ws: Workspace): boolean {
    return this.capabilities(this.cloudOf(ws)).sessionCap
  }

  /** A provider as the window sees it: which, through which connection, and its limits and capabilities. */
  providerView(ref: ProviderRef = {}): CloudProviderView {
    const { id, resolution } = this.resolution(ref)
    const c = resolvedConnection(resolution)
    return { id, ...(c ? { connectionId: c.id, connectionName: c.name } : {}), ready: this.available(ref), ...this.info(ref) }
  }

  private cloudOf(ws: Workspace): WorkspaceCloud {
    if (!ws.cloud) throw new Error(`${ws.name} isn’t a remote workspace`)
    return ws.cloud
  }

  /** The workspace's sandbox. A sandbox that no longer exists marks the workspace's binding gone. */
  async sandbox(ws: Workspace): Promise<SandboxHandle> {
    const cloud = this.cloudOf(ws)
    const { provider, key } = this.target(cloud)
    const hit = this.handles.get(cloud.id)
    if (hit?.key === key) return hit.handle
    const handle = await provider.get(cloud.id)
    if (!handle) {
      this.mark(cloud, 'gone', 'The sandbox no longer exists.')
      throw new Error(`${ws.name}’s sandbox no longer exists`)
    }
    this.handles.set(cloud.id, { key, handle })
    return handle
  }

  /** Remember a handle just made or fetched for a workspace's sandbox. */
  private keep(cloud: WorkspaceCloud, handle: SandboxHandle, key = this.target(cloud).key): void {
    this.handles.set(cloud.id, { key, handle })
  }

  /** The workspace's worktree in its sandbox, as a runtime (git, scripts and files go through it). */
  runtime(ws: Workspace): WorkspaceRuntime {
    return cloudRuntime(() => this.sandbox(ws), this.cloudOf(ws).cwd)
  }

  private mark(cloud: WorkspaceCloud, status: WorkspaceCloud['status'], error?: string): void {
    cloud.status = status
    if (error) cloud.error = error
    else delete cloud.error
    this.changed()
  }

  /** The provider's session cap on the binding, for the window (the capped banner, the quit sheet); none without a cap. */
  private noteCap(cloud: WorkspaceCloud): void {
    const { capabilities, limits } = this.info(cloud)
    if (capabilities.sessionCap) cloud.maxSessionMs = limits.maxSessionMs
    else delete cloud.maxSessionMs
  }

  // ---- usage, per provider ----

  /** This month's usage by provider; the single total kept before there were providers is Vercel's. */
  private usageBy(): Partial<Record<CloudProviderId, CloudUsage>> {
    const state = this.state
    state.cloudUsageBy ??= {}
    if (state.cloudUsage) {
      state.cloudUsageBy.vercel ??= state.cloudUsage
      delete state.cloudUsage
    }
    return state.cloudUsageBy
  }

  private recordUsage(provider: CloudProviderId, receipt: StopReceipt): void {
    const by = this.usageBy()
    by[provider] = addUsage(by[provider], receipt, this.now())
    this.deps.store.save()
  }

  /** This month's stop receipts on one provider added up (Vercel's unless said). */
  usage(provider: CloudProviderId = 'vercel'): CloudUsage {
    const month = usageMonth(this.now())
    const u = this.usageBy()[provider]
    return u && u.month === month ? { ...u } : { month, activeCpuMs: 0, stops: 0 }
  }

  /** Usage per provider for Settings: every provider with a default connection, or with stops recorded this month. */
  usageViews(): CloudUsageView[] {
    const holding = this.state.workspaces.filter((w) => w.cloud && w.state !== 'archived' && holdsSlot(w.cloud.status))
    return CLOUD_PROVIDER_IDS.flatMap((id): CloudUsageView[] => {
      const usage = this.usage(id)
      const view = this.providerView({ provider: id })
      if (!view.connectionId && !usage.stops) return []
      return [
        {
          provider: id,
          usage,
          limits: view.limits,
          capabilities: view.capabilities,
          running: holding.filter((w) => w.cloud!.provider === id).length,
          ...(view.connectionId ? { connectionId: view.connectionId, connectionName: view.connectionName } : {})
        }
      ]
    })
  }

  /** GH_TOKEN for one command, when the repository has a GitHub token. */
  private tokenEnv(repoId: string): Record<string, string> {
    const token = this.deps.githubToken(repoId)
    return token ? { GH_TOKEN: token } : {}
  }

  /** GH_TOKEN for one git command in the workspace's sandbox (push, fetch). */
  githubEnv(ws: Workspace): Record<string, string> {
    return this.tokenEnv(ws.repoId)
  }

  /**
   * gh in the workspace's sandbox (it is in the image), as the repository's GitHub connection (else the account gh
   * is signed in as here, as a local workspace would): GH_TOKEN goes with this one command, and gh's own login files
   * never go into the sandbox. Rejects like a local gh call.
   */
  async gh(ws: Workspace, args: string[], timeoutMs = 20_000, options: { wake?: boolean } = {}): Promise<string> {
    await this.ready(ws, Boolean(options.wake))
    const r = await this.runtime(ws).exec('gh', args, { env: { ...this.tokenEnv(ws.repoId), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeoutMs })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited with code ${r.code}`)
    return r.stdout
  }

  // ---- limits ----

  /**
   * Refuse to start or wake one more sandbox past the soft limits: Settings' maxRunning across the app (and, among the
   * provider's own workspaces, never above its plan's concurrency), and the repository's own. `ws` is the one asking,
   * not counted; `ref` is its provider (the workspace's binding, or the repository's settings for a new one).
   */
  enforceLimits(ws?: Workspace, ref: ProviderRef = ws?.cloud ?? {}): void {
    const running = this.state.workspaces.filter((w) => w.cloud && w.id !== ws?.id && w.state !== 'archived' && holdsSlot(w.cloud.status))
    const list = (ws: Workspace[]) => ws.map((w) => ({ workspaceId: w.id, name: w.name, repoId: w.repoId }))
    const maxRunning = cloudSettings(this.state.settings).maxRunning
    const id = this.providerId(ref)
    const onProvider = running.filter((w) => w.cloud!.provider === id)
    const cap = Math.min(maxRunning, this.limits(ref).maxConcurrent)
    if (onProvider.length >= cap) throw new CloudLimitError(cap, list(onProvider), 'app')
    if (running.length >= maxRunning) throw new CloudLimitError(maxRunning, list(running), 'app')
    const repo = ws && this.state.repos.find((r) => r.id === ws.repoId)
    if (!repo) return
    const repoCap = repoCloud(repo).maxRunning
    const inRepo = running.filter((w) => w.repoId === repo.id)
    if (inRepo.length >= repoCap) throw new CloudLimitError(repoCap, list(inRepo), 'repo')
  }

  // ---- base builds ----

  /** Build the repository's base sandbox and wait for it. */
  buildBase(repoId: string): Promise<CloudBuild> {
    return this.startBuild(repoId).done
  }

  /** Start a base build: the record is saved as `building` before this returns; `done` settles with the result. */
  startBuild(repoId: string): { build: CloudBuild; done: Promise<CloudBuild> } {
    const repo = this.state.repos.find((r) => r.id === repoId)
    if (!repo) throw new Error('Repository not found')
    if (this.builds.has(repoId)) throw new Error(`${repo.name}’s base is already being built`)
    const settings = repoCloud(repo)
    const target = this.target(settings)
    if (!target.provider.capabilities().base) throw new Error(`${cloudProvider(target.id).label} keeps no base to build: each remote workspace is cloned and set up when it’s made.`)
    const build: CloudBuild = {
      id: randomUUID(),
      status: 'building',
      startedAt: new Date(this.now()).toISOString(),
      log: '',
      provider: target.id,
      ...(settings.connectionId ? { connectionId: settings.connectionId } : {})
    }
    // Building pins the provider: the base lives there.
    repo.cloud = { ...settings, provider: target.id, build }
    this.changed()
    const done: Promise<CloudBuild> = this.runBuild(repo, build, target).finally(() => {
      // However it ended, the repository can be built (or turned off) again.
      if (this.builds.get(repoId) === done) this.builds.delete(repoId)
    })
    this.builds.set(repoId, done)
    return { build, done }
  }

  /** A base build of the repository is running. */
  building(repoId: string): boolean {
    return this.builds.has(repoId)
  }

  /** The repository has an active base on the provider (and connection) its settings name now. */
  private baseReady(repo: Repo, id: CloudProviderId): boolean {
    const settings = repoCloud(repo)
    const build = settings.build
    return build?.status === 'active' && (build.provider ?? 'vercel') === id && (build.connectionId ?? '') === (settings.connectionId ?? '')
  }

  /**
   * Make a fresh sandbox the repository's: clone it into CLOUD_CWD, put the agent host in CLOUD_HOST_DIR (installing its
   * packages) and run the install script. A base build does this once; on a provider without bases, each workspace.
   */
  private async prepare(sandbox: SandboxHandle, repo: Repo, log: (chunk: string) => void): Promise<{ commit: string; hostVersion?: string }> {
    const token = this.deps.githubToken(repo.id)
    const url = await this.deps.cloneUrl(repo.id)
    if (!url) throw new Error(`${repo.name} needs a GitHub remote to work in a remote workspace.`)
    const cloned = await sandbox.exec('bash', ['-lc', CLONE_REPO], {
      env: { FOREMAN_CLONE_URL: url, FOREMAN_CLONE_DIR: CLOUD_CWD, ...(token ? { GH_TOKEN: token } : {}) },
      onOutput: log,
      timeoutMs: 10 * MINUTE
    })
    if (cloned.code !== 0) throw new Error(`Couldn’t clone ${repo.name}: ${cloned.stderr.trim() || `exit code ${cloned.code}`}`)
    const rt = cloudRuntime(async () => sandbox, CLOUD_CWD)
    const commit = await gitOut(rt, ['rev-parse', 'HEAD'])
    log(`Cloned ${repo.name} at ${commit.slice(0, 12)}.\n`)
    await sandbox.mkdir(CLOUD_HOST_DIR)
    await sandbox.writeFile(`${CLOUD_HOST_DIR}/README.md`, HOST_README)
    const bundle = this.hostBundle?.() ?? null
    let hostVersion: string | undefined
    if (bundle) {
      log(`\nInstalling Foreman’s agent host (${bundle.version}).\n`)
      await this.uploadHost(sandbox, bundle, { install: true, log })
      hostVersion = bundle.version
    } else log('\nThis build of Foreman has no agent host bundle; it is uploaded when a workspace wakes.\n')
    const script = repoCloud(repo).installScript
    if (script.trim()) {
      log('\nRunning the install script.\n')
      // The user chose to give the install script the repository's GitHub token (private packages, gh).
      const ran = await sandbox.exec('bash', ['-lc', `set -euo pipefail\n${script}`], { cwd: CLOUD_CWD, onOutput: log, env: this.tokenEnv(repo.id) })
      if (ran.code !== 0) throw new Error(`The install script failed with exit code ${ran.code}.`)
    }
    return { commit, ...(hostVersion ? { hostVersion } : {}) }
  }

  private async runBuild(repo: Repo, build: CloudBuild, target: Target): Promise<CloudBuild> {
    const { id, provider } = target
    // The install script runs with GH_TOKEN, and a failed clone's error may echo its URL: neither reaches the log or the window.
    const token = this.deps.githubToken(repo.id)
    const clean = (text: string) => redactSecrets(text, [token])
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const log = (raw: string) => {
      const chunk = clean(raw)
      if (!chunk) return
      build.log = logTail((build.log ?? '') + chunk)
      this.deps.buildLog(repo.id, build.id, chunk)
      // The window gets every chunk; the disk gets the log every BUILD_LOG_SAVE_MS and at the end.
      if (saveTimer) return
      saveTimer = setTimeout(() => {
        saveTimer = null
        this.deps.store.save()
      }, BUILD_LOG_SAVE_MS)
      saveTimer.unref?.()
    }
    const settings = repoCloud(repo)
    const name = baseSandboxName(repo.id)
    let handle: SandboxHandle | undefined
    try {
      const url = await this.deps.cloneUrl(repo.id)
      if (!url) throw new Error(`${repo.name} needs a GitHub remote to work in a remote workspace.`)
      const previous = await provider.get(name)
      if (previous) {
        log('Replacing the previous build.\n')
        // Snapshots only it uses go with it; workspaces made from it keep their own.
        await previous.delete({ snapshots: true })
      }
      const limits = provider.limits()
      const caps = provider.capabilities()
      const vcpus = providerVcpus(settings.vcpus, caps, limits)
      const region = providerRegion(settings.region, caps, id)
      log(`Creating ${name} on ${cloudProvider(id).label} (${[`${vcpus} vCPUs`, region].filter(Boolean).join(', ')}) from ${url}\n`)
      handle = await provider.create({
        name,
        vcpus,
        region,
        timeoutMs: Math.min(BUILD_SESSION_MS, limits.maxSessionMs),
        tags: { ...CLOUD_APP_TAG, repo: repo.id, role: 'base' },
        // Docker builds its sandbox image the first time: minutes worth showing.
        onOutput: log
      })
      const prepared = await this.prepare(handle, repo, log)
      build.commit = prepared.commit
      if (prepared.hostVersion) build.hostVersion = prepared.hostVersion
      log('\nSaving the build (stopping the sandbox saves it).\n')
      const receipt = await handle.stop()
      this.recordUsage(id, receipt)
      Object.assign(build, { status: 'active', finishedAt: new Date(this.now()).toISOString(), ...(receipt.snapshotId ? { snapshotId: receipt.snapshotId } : {}) })
      log('Build finished.\n')
    } catch (err) {
      build.status = 'failed'
      build.error = clean(err instanceof Error ? err.message : String(err))
      build.finishedAt = new Date(this.now()).toISOString()
      log(`\n${build.error}\n`)
      // The clone never writes credentials to disk (the helper reads GH_TOKEN from env), so a failed build can be kept for its log.
      if (handle) await handle.stop().then((r) => this.recordUsage(id, r), () => undefined)
    }
    if (saveTimer) clearTimeout(saveTimer)
    this.changed()
    return build
  }

  /**
   * Put the agent host files in /vercel/foreman. npm install runs at a base build, and later only when package.json
   * changed (an app update that moved an SDK version); otherwise a new app version just replaces the files.
   */
  private async uploadHost(sandbox: SandboxHandle, bundle: HostBundle, options: { install: boolean; log?: (chunk: string) => void }): Promise<void> {
    await sandbox.mkdir(CLOUD_HOST_DIR)
    const pkgPath = `${CLOUD_HOST_DIR}/package.json`
    const current = options.install ? null : (await sandbox.readFile(pkgPath))?.toString('utf8')
    const install = current !== bundle.packageJson
    // One upload for the whole bundle (and package.json when it changed), not a round trip per file.
    const files: SandboxFile[] = bundle.files.map((file) => ({ path: `${CLOUD_HOST_DIR}/${file.path}`, data: file.data }))
    if (install) files.push({ path: pkgPath, data: bundle.packageJson })
    await sandbox.writeFiles(files)
    if (!install) return
    const r = await sandbox.exec('npm', NPM_INSTALL, { cwd: CLOUD_HOST_DIR, onOutput: options.log, timeoutMs: 10 * MINUTE })
    if (r.code !== 0) throw new Error(`Installing the agent host’s packages failed: ${(r.stderr.trim() || `exit code ${r.code}`).slice(-500)}`)
  }

  /** A workspace's sandbox holding another Foreman version's host gets this one's files (on create and wake). */
  async refreshHost(ws: Workspace, handle?: SandboxHandle): Promise<void> {
    const cloud = this.cloudOf(ws)
    const bundle = this.hostBundle?.() ?? null
    if (!bundle || cloud.hostVersion === bundle.version) return
    await this.uploadHost(handle ?? (await this.sandbox(ws)), bundle, { install: false })
    cloud.hostVersion = bundle.version
    this.deps.store.save()
  }

  /**
   * The repository's base sandbox goes (the repository was removed, its cloud setting turned off, or it moved to another
   * provider), on the provider it was built on. The record goes too while it's still this build's.
   */
  async deleteBase(repo: Repo, build: CloudBuild | undefined = repo.cloud?.build): Promise<void> {
    // Deleting it under a running build would leave the build writing into a sandbox that's gone.
    if (this.builds.has(repo.id)) throw new Error(`${repo.name}’s base is being built. Wait for the build to finish, then try again.`)
    const ref = build ? buildRef(build) : repoCloud(repo)
    if (!this.available(ref)) return
    const handle = await this.provider(ref).get(baseSandboxName(repo.id))
    if (handle) await handle.delete({ snapshots: true })
    if (repo.cloud?.build && (!build || repo.cloud.build.id === build.id)) {
      delete repo.cloud.build
      this.changed()
    }
  }

  // ---- workspaces ----

  /** Checks before a remote workspace is recorded: the feature on, a connection, an active base (when the provider keeps one), room under the limits. */
  preflight(repo: Repo): void {
    if (!cloudSettings(this.state.settings).enabled) throw new Error('Remote workspaces are off. Turn them on in Settings → Remote workspaces.')
    const settings = repoCloud(repo)
    const target = this.target(settings)
    if (target.provider.capabilities().base && !this.baseReady(repo, target.id)) throw new Error(`Build ${repo.name}’s base on ${cloudProvider(target.id).label} first (Repository settings → Remote).`)
    this.enforceLimits({ id: '', repoId: repo.id } as Workspace, settings)
  }

  /** preflight() as an answer instead of an error, so the new-workspace dialog can say why before trying; with the provider's limits. */
  preflightResult(repo: Repo): CloudPreflight {
    const provider = this.providerView(repoCloud(repo))
    try {
      this.preflight(repo)
      return { ok: true, provider }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof CloudLimitError) return { ok: false, reason: 'limit', running: err.running.map(({ workspaceId, name }) => ({ workspaceId, name })), message, provider }
      if (err instanceof CloudUnavailableError) return { ok: false, reason: 'unavailable', message, provider }
      if (!cloudSettings(this.state.settings).enabled) return { ok: false, reason: 'disabled', message, provider }
      return { ok: false, reason: 'no-build', message, provider }
    }
  }

  /** The binding a new remote workspace of this repository gets (status creating), on the repository's provider. */
  newBinding(workspaceId: string, repo: Repo): WorkspaceCloud {
    const settings = repoCloud(repo)
    const id = this.providerId(settings)
    const { capabilities, limits } = this.info(settings)
    const fromBase = capabilities.base && settings.build
    return {
      provider: id,
      ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
      id: workspaceSandboxName(workspaceId),
      status: 'creating',
      region: providerRegion(settings.region, capabilities, id),
      vcpus: providerVcpus(settings.vcpus, capabilities, limits),
      cwd: CLOUD_CWD,
      ...(capabilities.sessionCap ? { maxSessionMs: limits.maxSessionMs } : {}),
      ...(fromBase ? { buildId: fromBase.id } : {}),
      ...(fromBase && fromBase.hostVersion ? { hostVersion: fromBase.hostVersion } : {})
    }
  }

  /**
   * Start the workspace's sandbox from the repository's base (or, on a provider without bases, clone and set it up
   * from scratch) and put its branch there: fetch the base, branch from it, the git identity, and gh as git's
   * credential helper so pushes work. Setup steps run next, through the runtime this returns (WorkspaceService.runSetup).
   */
  async createWorkspaceSandbox(ws: Workspace, repo: Repo, options: { existingBranch?: boolean; pullRequest?: number; log: (chunk: string) => void }): Promise<WorkspaceRuntime> {
    const cloud = this.cloudOf(ws)
    const { log } = options
    const target = this.target(cloud)
    const { provider } = target
    const label = cloudProvider(target.id).label
    const caps = provider.capabilities()
    if (caps.base && !this.baseReady(repo, target.id)) throw new Error(`Build ${repo.name}’s base on ${label} first (Repository settings → Remote).`)
    this.enforceLimits(ws)
    const size = [`${cloud.vcpus} vCPUs`, cloud.region].filter(Boolean).join(', ')
    const opts = { name: cloud.id, vcpus: cloud.vcpus, region: cloud.region, timeoutMs: sessionBudgetMs(provider.limits()), tags: { ...CLOUD_APP_TAG, repo: repo.id, workspace: ws.id }, onOutput: log }
    let handle: SandboxHandle
    if (caps.base) {
      if (!provider.createFromBase) throw new Error(`${label} keeps bases but can’t start a sandbox from one`)
      log(`Starting ${cloud.id} from ${repo.name}’s base on ${label} (${size}).\n`)
      handle = await provider.createFromBase(baseSandboxName(repo.id), opts)
    } else {
      log(`Creating ${cloud.id} on ${label} (${size}); it is cloned and set up from scratch.\n`)
      handle = await provider.create(opts)
    }
    this.keep(cloud, handle, target.key)
    cloud.status = 'running'
    cloud.lastActivityAt = new Date(this.now()).toISOString()
    const expires = (await handle.session()).expiresAt
    if (expires) cloud.sessionExpiresAt = expires.toISOString()
    this.checkedAt.set(cloud.id, this.now())
    this.changed()

    if (!caps.base) {
      // What a base build would have done, in this workspace's own sandbox.
      const token = this.deps.githubToken(repo.id)
      const prepared = await this.prepare(handle, repo, (chunk) => log(redactSecrets(chunk, [token])))
      if (prepared.hostVersion) cloud.hostVersion = prepared.hostVersion
    }

    const rt = this.runtime(ws)
    const env = this.tokenEnv(repo.id)
    if (env.GH_TOKEN) {
      log('$ gh auth setup-git\n')
      const r = await rt.exec('gh', ['auth', 'setup-git'], { env })
      if (r.code !== 0) log(`${r.stderr.trim()}\nPushing may ask for credentials.\n`)
    }
    // Bases built before the clone used --no-single-branch track only the default branch; a pushed workspace
    // branch then has no remote-tracking ref. Setting the full refspec here fixes those without a rebuild.
    await git(rt, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { allowFail: true })
    log(`$ git fetch origin ${ws.baseBranch}\n`)
    const fetched = await git(rt, ['fetch', 'origin', ws.baseBranch], { allowFail: true, timeoutMs: 120_000, env })
    if (fetched.code !== 0) log(`${fetched.stderr.trim()}\nContinuing with the build’s copy of ${ws.baseBranch}.\n`)
    let args: string[]
    if (options.pullRequest !== undefined) {
      // A pull request's head, fetched from the clone's remote into the workspace's branch (a fresh name if the build has one).
      if (await revParse(rt, `refs/heads/${ws.branch}`)) ws.branch = `${ws.branch}-${ws.id.slice(0, 6)}`
      const pulled = await fetchPullHead(rt, 'origin', options.pullRequest, ws.branch, env)
      log(`$ ${pulled.command}\n${pulled.output}`)
      args = ['checkout', ws.branch]
    } else if (options.existingBranch) {
      if (await revParse(rt, `refs/heads/${ws.branch}`)) args = ['checkout', ws.branch]
      else {
        await git(rt, ['fetch', 'origin', ws.branch], { allowFail: true, timeoutMs: 120_000, env })
        args = ['checkout', '--track', '-b', ws.branch, `origin/${ws.branch}`]
      }
    } else {
      // --no-track: the branch must not push to the base branch by accident.
      args = ['checkout', '--no-track', '-b', ws.branch, await baseStartPoint(rt, ws.baseBranch)]
    }
    log(`$ git ${args.join(' ')}\n`)
    const out = await git(rt, args)
    log(out.stderr + out.stdout)
    const identity = await this.deps.gitIdentity(repo.id).catch(() => ({}) as { name?: string; email?: string })
    if (identity.name) await git(rt, ['config', 'user.name', identity.name])
    if (identity.email) await git(rt, ['config', 'user.email', identity.email])
    if (this.deps.settingsFor(repo.id).pushAutoSetupRemote) await git(rt, ['config', 'push.autoSetupRemote', 'true'], { allowFail: true })
    // A build made by another Foreman version gets this one's host; the host itself starts with the first turn (CloudTurnHost).
    await this.refreshHost(ws, handle).catch((err: unknown) => log(`Couldn’t update the agent host: ${err instanceof Error ? err.message : String(err)}\n`))
    return rt
  }

  /**
   * A command that isn't a turn may run: the sandbox is running, or (with `wake`, a user's action) is woken first.
   * A `running` status older than STATUS_FRESH_MS is checked with the provider first (one fetch): the sandbox may have
   * stopped since, and its commands never resume it without `wake` (SandboxNotRunningError).
   */
  async ready(ws: Workspace, wake: boolean): Promise<void> {
    const cloud = this.cloudOf(ws)
    if (running(cloud) && this.now() - (this.checkedAt.get(cloud.id) ?? 0) > STATUS_FRESH_MS) await this.refreshStatus(ws)
    if (running(cloud)) return
    if (cloud.status === 'gone') throw new Error(`${ws.name}’s sandbox no longer exists`)
    if (ws.state === 'archived') throw new Error(`${ws.name} is archived. Restore it first.`)
    if (!wake) throw new Error(sandboxNotRunningReason(ws.name, cloud.status))
    await this.wake(ws)
  }

  /** Bring a sleeping sandbox back: a command that asks to wake it resumes it. */
  async wake(ws: Workspace): Promise<WorkspaceCloud> {
    const cloud = this.cloudOf(ws)
    if (ws.state === 'archived') throw new Error(`${ws.name} is archived. Restore it first.`)
    if (cloud.status === 'gone') throw new Error(`${ws.name}’s sandbox no longer exists`)
    if (cloud.status === 'running') {
      cloud.lastActivityAt = new Date(this.now()).toISOString()
      // Already running, but a terminal may have lost its connection: Wake is how it asks again.
      this.nowRunning(ws)
      this.seen(ws)
      return cloud
    }
    this.enforceLimits(ws)
    this.mark(cloud, 'waking')
    try {
      const handle = await this.sandbox(ws)
      // The one call that may resume a stopped sandbox.
      const r = await handle.exec('true', [], { wake: true })
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`)
      this.sleptByUs.delete(cloud.id)
      const expires = (await handle.session()).expiresAt
      if (expires) cloud.sessionExpiresAt = expires.toISOString()
      cloud.lastActivityAt = new Date(this.now()).toISOString()
      this.checkedAt.set(cloud.id, this.now())
      this.noteCap(cloud)
      this.mark(cloud, 'running')
      // The host itself is started by CloudTurnHost when a turn needs it (`hello`, else spawn).
      await this.refreshHost(ws, handle).catch((err: unknown) => console.warn(`Couldn’t update the agent host in ${cloud.id}:`, err instanceof Error ? err.message : err))
    } catch (err) {
      // sandbox() marks a sandbox that no longer exists as gone; anything else is unresponsive.
      if (!gone(cloud)) this.mark(cloud, 'unresponsive', err instanceof Error ? err.message : String(err))
      throw err
    }
    this.nowRunning(ws)
    this.seen(ws)
    return cloud
  }

  /** `listener` hears of every status read or wake that found the workspace's sandbox running. Returns the unsubscribe. */
  onSeenRunning(listener: (ws: Workspace) => void): () => void {
    this.seenListeners.add(listener)
    return () => this.seenListeners.delete(listener)
  }

  private seen(ws: Workspace): void {
    for (const listener of this.seenListeners) {
      try {
        listener(ws)
      } catch (err) {
        console.warn('A sandbox listener failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  /**
   * The plan's session limit stopped the sandbox under a turn. It stays `capped` (the Continue banner, no wake on
   * open) until the user continues or wakes it, or a new turn starts: each of those wakes it.
   */
  markCapped(ws: Workspace): void {
    const cloud = this.cloudOf(ws)
    if (cloud.status !== 'capped') this.mark(cloud, 'capped')
  }

  /** `listener` hears of each workspace whose sandbox is running again (woken, or found running). Returns the unsubscribe. */
  onRunning(listener: (ws: Workspace) => void): () => void {
    this.runningListeners.add(listener)
    return () => this.runningListeners.delete(listener)
  }

  private nowRunning(ws: Workspace): void {
    for (const listener of this.runningListeners) {
      try {
        listener(ws)
      } catch (err) {
        console.warn('A sandbox listener failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  /** Stop the session; the filesystem is kept and the next wake resumes it. */
  async sleep(ws: Workspace): Promise<WorkspaceCloud> {
    const cloud = this.cloudOf(ws)
    const handle = await this.sandbox(ws)
    this.sleptByUs.add(cloud.id)
    this.recordUsage(cloud.provider, await handle.stop())
    delete cloud.sessionExpiresAt
    this.mark(cloud, ws.state === 'archived' ? 'archived' : 'sleeping')
    return cloud
  }

  /** Force-stop and wake again (a stuck or unresponsive sandbox). */
  async restart(ws: Workspace): Promise<WorkspaceCloud> {
    const cloud = this.cloudOf(ws)
    const handle = await this.sandbox(ws)
    this.sleptByUs.add(cloud.id)
    this.recordUsage(cloud.provider, await handle.stop().catch(() => ({})))
    this.mark(cloud, 'sleeping')
    return this.wake(ws)
  }

  /**
   * Archive: the sandbox stops and stays until the workspace is forgotten. On a provider whose stopped sandboxes don't
   * keep their files (no snapshotOnStop) it is still only stopped, with a warning to say the work may not come back.
   */
  async archive(ws: Workspace): Promise<{ warning?: string }> {
    const cloud = this.cloudOf(ws)
    let warning: string | undefined
    // The archive diff and steps ran before this (WorkspaceService.archiveInSandbox).
    if (cloud.status !== 'gone' && this.available(cloud)) {
      if (!this.capabilities(cloud).snapshotOnStop) warning = `${cloudProvider(cloud.provider).label} doesn’t keep a stopped sandbox’s files, so restoring ${ws.name} may not bring its uncommitted work back. Push what you want to keep.`
      const handle = await this.sandbox(ws).catch(() => null)
      if (handle && (await handle.status().catch(() => null)) === 'running') {
        this.sleptByUs.add(cloud.id)
        this.recordUsage(cloud.provider, await handle.stop())
      }
    }
    delete cloud.sessionExpiresAt
    if (cloud.status !== 'gone') this.mark(cloud, 'archived')
    return warning ? { warning } : {}
  }

  /** Restore: the sandbox is there, asleep, and wakes when the workspace is opened. */
  async unarchive(ws: Workspace): Promise<void> {
    const cloud = this.cloudOf(ws)
    const target = this.target(cloud)
    const handle = await target.provider.get(cloud.id)
    if (!handle) {
      this.mark(cloud, 'gone', 'The sandbox no longer exists.')
      throw new Error(`${ws.name}’s sandbox no longer exists, so it can’t be restored`)
    }
    this.keep(cloud, handle, target.key)
    this.mark(cloud, 'sleeping')
  }

  /** Forget: the sandbox is deleted, with its snapshots unless Settings say to keep them. Without a connection there is nothing to reach. */
  async forget(ws: Workspace): Promise<void> {
    const cloud = this.cloudOf(ws)
    if (!this.available(cloud)) return
    const handle = await this.provider(cloud).get(cloud.id)
    if (handle) await handle.delete({ snapshots: cloudSettings(this.state.settings).deleteSnapshotsOnForget })
    this.handles.delete(cloud.id)
    this.sleptByUs.delete(cloud.id)
    cloud.status = 'gone'
  }

  /** Foreman stopped this sandbox itself (sleep, restart, archive) since the app started: a stop that isn't a cap. */
  sleptByUsSince(ws: Workspace): boolean {
    return this.sleptByUs.has(this.cloudOf(ws).id)
  }

  /**
   * While something is active, keep at least 15 minutes of session left, up to the plan's cap. Returns the extension.
   * A provider without a session cap has nothing to extend.
   */
  async extendWhileActive(ws: Workspace): Promise<number> {
    const cloud = this.cloudOf(ws)
    if (cloud.status !== 'running') return 0
    if (!this.capabilities(cloud).sessionCap) return 0
    const handle = await this.sandbox(ws)
    // One fetch for the session's end and start.
    const { expiresAt: expires, startedAt: started } = await handle.session()
    if (!expires) return 0
    const ms = extensionMs({ now: this.now(), expiresAt: expires.getTime(), startedAt: started?.getTime(), maxSessionMs: this.limits(cloud).maxSessionMs })
    if (ms <= 0) return 0
    await handle.extendTimeout(ms)
    cloud.sessionExpiresAt = new Date(expires.getTime() + ms).toISOString()
    this.deps.store.save()
    return ms
  }

  /** Ask the provider how the sandbox is, and record it. A session that ended at its cap during a turn is `capped`. */
  async refreshStatus(ws: Workspace): Promise<WorkspaceCloud> {
    const cloud = this.cloudOf(ws)
    let status: ProviderStatus | null
    let expires: Date | undefined
    try {
      const target = this.target(cloud)
      const handle = await target.provider.get(cloud.id)
      if (handle) {
        this.keep(cloud, handle, target.key)
        const session = await handle.session()
        status = session.status
        expires = session.expiresAt
      } else status = null
    } catch (err) {
      if (err instanceof CloudUnavailableError) throw err
      this.mark(cloud, 'unresponsive', err instanceof Error ? err.message : String(err))
      return cloud
    }
    const before = JSON.stringify(cloud)
    this.noteCap(cloud)
    // Only a provider with a session cap can stop a sandbox at one.
    const lastExpiry = cloud.sessionExpiresAt && cloud.maxSessionMs !== undefined ? Date.parse(cloud.sessionExpiresAt) : undefined
    let next = cloudStatusFrom(status, { now: this.now(), expiresAt: lastExpiry, turnRunning: this.deps.turnRunning(ws.id), sleptByUs: this.sleptByUs.has(cloud.id) })
    if (ws.state === 'archived' && next !== 'gone') next = 'archived'
    // Still being made: the workspace says when it's done.
    if (cloud.status === 'creating' && next === 'running') next = 'creating'
    // Capped stays capped while the sandbox is stopped: once the cut-off turn is recorded no turn runs, and reading it
    // as plain `sleeping` would drop the Continue banner and let wake on open resume it without continuing.
    if (cloud.status === 'capped' && next === 'sleeping') next = 'capped'
    const resumed = next === 'running' && cloud.status !== 'running'
    cloud.status = next
    if (next === 'gone') cloud.error = 'The sandbox no longer exists.'
    else delete cloud.error
    if (expires) cloud.sessionExpiresAt = expires.toISOString()
    else if (next !== 'capped') delete cloud.sessionExpiresAt
    // On `capped`, CloudTurnHost (cloud/turnHost.ts) ends the turn as interrupted at the session cap and, with autoContinue, continues it.
    if (JSON.stringify(cloud) !== before) this.changed()
    this.checkedAt.set(cloud.id, this.now())
    if (resumed) this.nowRunning(ws)
    if (next === 'running') this.seen(ws)
    return cloud
  }

  /**
   * With "Stop orphaned sandboxes on launch" on: on every provider with a usable connection, stop (never delete)
   * running sandboxes tagged app=foreman that no workspace or repository here owns. Returns their names. One
   * provider failing doesn't stop the others.
   */
  async stopOrphans(): Promise<string[]> {
    if (!cloudSettings(this.state.settings).stopOrphansOnLaunch) return []
    const owned = new Set([...this.state.workspaces.flatMap((w) => (w.cloud ? [w.cloud.id] : [])), ...this.state.repos.map((r) => baseSandboxName(r.id))])
    // Each provider's default connection, and any connection a workspace or repository chose.
    const refs: ProviderRef[] = [
      ...CLOUD_PROVIDER_IDS.map((provider) => ({ provider })),
      ...this.state.workspaces.flatMap((w) => (w.cloud?.connectionId ? [w.cloud] : [])),
      ...this.state.repos.flatMap((r) => (r.cloud?.connectionId ? [r.cloud] : []))
    ]
    const seen = new Set<string>()
    const stopped: string[] = []
    for (const ref of refs) {
      if (!this.available(ref)) continue
      let target: Target
      try {
        target = this.target(ref)
      } catch {
        continue
      }
      if (seen.has(target.connection.id)) continue
      seen.add(target.connection.id)
      try {
        for (const info of await target.provider.list(CLOUD_APP_TAG)) {
          if (owned.has(info.name) || stopped.includes(info.name) || (info.status !== 'running' && info.status !== 'pending')) continue
          const handle = await target.provider.get(info.name)
          if (!handle) continue
          this.recordUsage(target.id, await handle.stop())
          stopped.push(info.name)
        }
      } catch (err) {
        console.warn(`Couldn’t stop orphaned sandboxes on ${cloudProvider(target.id).label}:`, err instanceof Error ? err.message : err)
      }
    }
    return stopped
  }

  // ---- idle sleep ----

  /** Every minute: sleep idle sandboxes, and keep active ones' sessions from running out. Does nothing without remote workspaces. */
  startIdleTicker(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stopIdleTicker(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass of the idle ticker. Active: a turn running, a terminal open or the workspace focused. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const ws of this.state.workspaces) {
        const cloud = ws.cloud
        if (!cloud || ws.state === 'archived' || cloud.status !== 'running') continue
        // Being made or set up counts as activity.
        if (ws.state === 'creating' || ws.state === 'setting-up') continue
        const now = this.now()
        const turn = this.deps.turnRunning(ws.id)
        const terminal = this.deps.terminalOpen(ws.id)
        if (turn || terminal || this.deps.focused(ws.id)) {
          cloud.lastActivityAt = new Date(now).toISOString()
          this.deps.store.save()
          // A turn's keepalives extend its session (CloudTurnHost); the ticker does it for a terminal alone, so a
          // session is never asked about twice a minute.
          if (terminal && !turn) await this.extendWhileActive(ws).catch(() => 0)
          continue
        }
        const repo = this.state.repos.find((r) => r.id === ws.repoId)
        const idleMs = now - Date.parse(cloud.lastActivityAt ?? ws.createdAt)
        if (repo && idleMs >= repoCloud(repo).idleMinutes * MINUTE) {
          await this.sleep(ws).catch((err: unknown) => this.mark(cloud, 'unresponsive', err instanceof Error ? err.message : String(err)))
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
