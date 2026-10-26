// SandboxProvider on Vercel Sandbox (@vercel/sandbox, research.md). Credentials go explicitly on
// every static call, never through the environment, and never into a sandbox. The SDK is loaded
// on first use, so an app with no cloud workspace never loads it.
import path from 'node:path'
import type { Command, Sandbox, Session } from '@vercel/sandbox'
import { CLOUD_IMAGE, CLOUD_PROVIDERS, type PlanLimits, type ProviderCapabilities, type ProviderStatus } from '../../shared/cloud'
import type { RuntimeExecResult } from '../runtime/types'
import {
  SandboxNotRunningError,
  type CreateSandboxOptions,
  type ForkSandboxOptions,
  type GitSource,
  type PtyListener,
  type PtyStart,
  type PtyTransport,
  type SandboxExecOptions,
  type SandboxFile,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSession,
  type SpawnedRemote,
  type StopReceipt
} from './provider'
import { connectVercelPty } from './vercelPty'

export interface VercelCredentials {
  token: string
  teamId: string
  projectId: string
}

type Sdk = typeof import('@vercel/sandbox')
let sdk: Promise<Sdk> | null = null
const load = (): Promise<Sdk> => (sdk ??= import('@vercel/sandbox'))

// Every sandbox snapshots on stop and keeps only its latest snapshot, so storage stays flat.
const PERSISTENCE = { persistent: true, keepLastSnapshots: { count: 1 } } as const

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
}

function gitSource(s: GitSource) {
  const base = { type: 'git' as const, url: s.url, ...(s.depth ? { depth: s.depth } : {}), ...(s.revision ? { revision: s.revision } : {}) }
  return s.username && s.password ? { ...base, username: s.username, password: s.password } : base
}

function notFound(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 404
}

/** The SDK's answer for a session that stopped, or is stopping or snapshotting (its own calls would resume it). */
function sessionStopped(err: unknown): boolean {
  const e = err as { response?: { status?: number }; json?: { error?: { code?: string } } }
  return e?.response?.status === 410 || (e?.response?.status === 422 && ['sandbox_stopping', 'sandbox_snapshotting'].includes(e.json?.error?.code ?? ''))
}

/** A sandbox fetched without a session (never started, or long stopped) reads as stopped. */
function statusOf(sb: Sandbox): ProviderStatus {
  try {
    return sb.status
  } catch {
    return 'stopped'
  }
}

export class VercelProvider implements SandboxProvider {
  readonly id = 'vercel' as const

  constructor(
    private creds: VercelCredentials,
    private planLimits: PlanLimits
  ) {}

  /** The credentials for one SDK call. */
  auth(): VercelCredentials {
    return { token: this.creds.token, teamId: this.creds.teamId, projectId: this.creds.projectId }
  }

  limits(): PlanLimits {
    return this.planLimits
  }

  // Forks, snapshots on stop (persistent sandboxes), sessions capped by the plan, a PTY over WebSocket.
  capabilities(): ProviderCapabilities {
    return CLOUD_PROVIDERS.vercel.capabilities
  }

  async create(o: CreateSandboxOptions): Promise<SandboxHandle> {
    const { Sandbox } = await load()
    const sb = await Sandbox.create({
      ...this.auth(),
      name: o.name,
      image: CLOUD_IMAGE,
      ...(o.source ? { source: gitSource(o.source) } : {}),
      resources: { vcpus: o.vcpus },
      region: o.region,
      timeout: o.timeoutMs,
      tags: o.tags,
      ...PERSISTENCE
    })
    return new VercelHandle(sb, this)
  }

  async fork(sourceName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    const { Sandbox } = await load()
    const sb = await Sandbox.fork({
      ...this.auth(),
      sourceSandbox: sourceName,
      name: o.name,
      ...(o.vcpus ? { resources: { vcpus: o.vcpus } } : {}),
      ...(o.region ? { region: o.region } : {}),
      timeout: o.timeoutMs,
      tags: o.tags,
      ...PERSISTENCE
    })
    return new VercelHandle(sb, this)
  }

  // A workspace starts from its repository's base as a fork of it (the base's last snapshot).
  createFromBase(baseName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    return this.fork(baseName, o)
  }

  async get(name: string): Promise<SandboxHandle | null> {
    const sb = await this.fetch(name)
    return sb ? new VercelHandle(sb, this) : null
  }

  /** The sandbox's metadata as it is now, without resuming it. */
  async fetch(name: string): Promise<Sandbox | null> {
    const { Sandbox } = await load()
    try {
      return await Sandbox.get({ ...this.auth(), name, resume: false })
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }

  async list(tag: Record<string, string>): Promise<SandboxInfo[]> {
    const { Sandbox } = await load()
    const page = await Sandbox.list({ ...this.auth(), tags: tag })
    const all = await page.toArray()
    return all.map((s) => ({
      name: s.name,
      status: s.status,
      tags: s.tags,
      createdAt: new Date(s.createdAt),
      ...(s.expiresAt ? { expiresAt: new Date(s.expiresAt) } : {})
    }))
  }
}

class VercelHandle implements SandboxHandle {
  constructor(
    private sb: Sandbox,
    private provider: VercelProvider
  ) {}

  get name(): string {
    return this.sb.name
  }

  private async refresh(): Promise<Sandbox> {
    const fresh = await this.provider.fetch(this.sb.name)
    if (!fresh) throw new Error(`The sandbox ${this.sb.name} no longer exists`)
    this.sb = fresh
    return fresh
  }

  async status(): Promise<ProviderStatus> {
    return statusOf(await this.refresh())
  }

  async session(): Promise<SandboxSession> {
    const sb = await this.refresh()
    const status = statusOf(sb)
    return status === 'running' ? { status, expiresAt: sb.expiresAt, startedAt: sb.currentSession().startedAt } : { status }
  }

  /**
   * Run `fn` on the running session, never resuming it: the SDK's Sandbox methods resume a stopped sandbox (and start
   * a billed session) on their own, so everything but a woken exec goes to the session directly.
   */
  private async live<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    let session: Session | null = null
    try {
      session = this.sb.currentSession()
    } catch {
      session = null
    }
    // Known to be stopped: refuse without a round trip. Starting or running: try it; one that stopped since answers 410.
    if (!session || (session.status !== 'running' && session.status !== 'pending')) throw new SandboxNotRunningError(this.sb.name)
    try {
      return await fn(session)
    } catch (err) {
      if (sessionStopped(err)) throw new SandboxNotRunningError(this.sb.name)
      throw err
    }
  }

  async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}): Promise<RuntimeExecResult> {
    const params = { cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: cleanEnv(opts.env), sudo: opts.sudo, timeoutMs: opts.timeoutMs }
    // Only `wake` goes through the SDK's resuming call.
    const wake = Boolean(opts.wake)
    if (!opts.onOutput && !opts.signal) {
      const done = wake ? await this.sb.runCommand(params) : await this.live((s) => s.runCommand(params))
      const [stdout, stderr] = await Promise.all([done.stdout(), done.stderr()])
      return { stdout, stderr, code: done.exitCode }
    }
    // Streamed or stoppable: detached, reading its logs as they come.
    const command = wake ? await this.sb.runCommand({ ...params, detached: true }) : await this.live((s) => s.runCommand({ ...params, detached: true }))
    const onAbort = () => void command.kill().catch(() => undefined)
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    let stderr = ''
    try {
      for await (const line of command.logs()) {
        if (line.stream === 'stdout') stdout += line.data
        else stderr += line.data
        opts.onOutput?.(line.data)
      }
      const done = await command.wait()
      return { stdout, stderr, code: done.exitCode }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  async spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote> {
    const command = await this.live((s) => s.runCommand({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: opts.env, detached: true, stdin: true }))
    return remote(command)
  }

  async attachCommand(cmdId: string): Promise<SpawnedRemote> {
    return remote(await this.live((s) => s.getCommand(cmdId)))
  }

  readFile(p: string): Promise<Buffer | null> {
    return this.live((s) => s.readFileToBuffer({ path: p }))
  }

  async writeFile(p: string, data: Buffer | string, mode?: number): Promise<void> {
    await this.mkdir(path.posix.dirname(p))
    await this.writeFiles([{ path: p, data, mode }])
  }

  // The upload is a tarball extracted at /, which makes each file's folders.
  async writeFiles(files: SandboxFile[]): Promise<void> {
    const batch = files.map((f) => ({ path: f.path, content: typeof f.data === 'string' ? Buffer.from(f.data) : f.data, ...(f.mode !== undefined ? { mode: f.mode } : {}) }))
    await this.live((s) => s.writeFiles(batch))
  }

  async mkdir(p: string): Promise<void> {
    const r = await this.live((s) => s.runCommand('mkdir', ['-p', p]))
    if (r.exitCode !== 0) throw new Error(`Couldn’t make ${p}: ${(await r.stderr()).trim() || `exit code ${r.exitCode}`}`)
  }

  async exists(p: string): Promise<boolean> {
    return (await this.live((s) => s.runCommand('test', ['-e', p]))).exitCode === 0
  }

  async openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
    return connectVercelPty(await this.live((s) => s.openInteractive()), start, listener)
  }

  async stop(): Promise<StopReceipt> {
    const r = await this.sb.stop()
    // The session's own length when Vercel reports it, else from its start and stop times (both epoch ms).
    const durationMs = r.duration ?? (r.startedAt !== undefined && r.stoppedAt !== undefined ? r.stoppedAt - r.startedAt : undefined)
    return {
      ...(r.snapshot?.id ? { snapshotId: r.snapshot.id } : {}),
      ...(r.activeCpuDurationMs !== undefined ? { activeCpuMs: r.activeCpuDurationMs } : {}),
      ...(durationMs !== undefined && durationMs >= 0 ? { durationMs, vcpus: r.vcpus } : {})
    }
  }

  async extendTimeout(ms: number): Promise<void> {
    // A stopped session is not extended into a new one.
    await this.live((s) => s.extendTimeout(ms))
  }


  delete(opts: { snapshots?: boolean } = {}): Promise<void> {
    return this.sb.delete({ deleteOrphanSnapshots: Boolean(opts.snapshots) })
  }
}

function remote(command: Command): SpawnedRemote {
  return {
    cmdId: command.cmdId,
    write: (data) => command.writeStdin(data),
    closeStdin: () => command.closeStdin(),
    logs: async function* () {
      for await (const line of command.logs()) yield { stream: line.stream, data: line.data }
    },
    wait: async () => ({ code: (await command.wait()).exitCode }),
    kill: () => command.kill()
  }
}
