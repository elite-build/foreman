// SandboxProvider on E2B: Firecracker sandboxes through the `e2b` npm
// SDK. Credentials go explicitly on every call (the SDK would otherwise read E2B_API_KEY and E2B_DOMAIN from
// the environment), and the SDK loads on first use. E2B ids are generated, so Foreman's name and tags live
// in the sandbox's metadata. Sandboxes are made to pause, not die, at their timeout (lifecycle onTimeout
// 'pause', autoResume off), and stop() pauses: a paused sandbox keeps its filesystem and memory for as long
// as it exists, on every plan. Sandbox.connect resumes a paused sandbox, so only a woken exec calls it on
// one; everything else reads state with getInfo (which never resumes) and refuses with SandboxNotRunningError.
import { createHash } from 'node:crypto'
import type { CommandHandle, Sandbox, SandboxInfo as E2bSandboxInfo } from 'e2b'
import { CLOUD_PROVIDERS, type PlanLimits, type ProviderCapabilities, type ProviderStatus } from '../../shared/cloud'
import type { ConnectionIdentity, E2bConnectionInfo } from '../../shared/integrations'
import type { RuntimeExecResult } from '../runtime/types'
import { bashQuote, openE2bPty } from './e2bPty'
import { ensureE2bTemplate, type TemplateSdk } from './e2bTemplate'
import {
  SandboxNotRunningError,
  type CreateSandboxOptions,
  type PtyListener,
  type PtyStart,
  type PtyTransport,
  type RemoteLogLine,
  type SandboxExecOptions,
  type SandboxFile,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSession,
  type SpawnedRemote,
  type StopReceipt
} from './provider'

export interface E2bCredentials {
  apiKey: string
  // A self-hosted E2B's domain; absent: E2B's cloud.
  domain?: string
}

export const E2B_DOMAIN = 'e2b.app'
// Foreman's own metadata keys, beside the tags: the name, and the session length to resume with.
const NAME_KEY = 'foreman.name'
const TIMEOUT_KEY = 'foreman.timeoutMs'
// Connecting to a running sandbox extends its timeout to at least this; 1 s never extends anything.
const NO_EXTEND_MS = 1000
// A command's output kept for logs() to replay, per command.
const LOG_CAP_BYTES = 8 * 1024 * 1024
// How long an ended command stays attachable in this process.
const ENDED_KEEP_MS = 10 * 60_000

type Sdk = typeof import('e2b')
let sdk: Promise<Sdk> | null = null
const load = (): Promise<Sdk> => (sdk ??= import('e2b'))

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
}

/** E2B runs a command line in `bash -l -c`: every word quoted. */
export function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(bashQuote).join(' ')
}

/** The tags of a sandbox: its metadata without Foreman's own keys. */
function tagsOf(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([k]) => !k.startsWith('foreman.')))
}

export function statusOf(info: Pick<E2bSandboxInfo, 'state'>): ProviderStatus {
  return info.state === 'running' ? 'running' : 'stopped'
}

const errName = (err: unknown): string => (err as { name?: string })?.name ?? ''
const statusCode = (err: unknown): number | undefined => (err as { statusCode?: number })?.statusCode

function notFound(err: unknown): boolean {
  return errName(err) === 'SandboxNotFoundError' || errName(err) === 'NotFoundError' || statusCode(err) === 404
}

/** The SDK's answer for a sandbox that paused (or was killed) under a request: the proxy found it not running. */
function stoppedUnder(err: unknown): boolean {
  return errName(err) === 'SandboxNotRunningError'
}

/** A command's exit code from its wait(): E2B throws CommandExitError for a non-zero one. */
async function exitCode(wait: Promise<{ exitCode: number }>): Promise<number> {
  try {
    return (await wait).exitCode
  } catch (err) {
    const code = (err as { exitCode?: unknown })?.exitCode
    if (typeof code === 'number') return code
    throw err
  }
}

/** A pause can be refused (503) while the node finishes another snapshot; E2B says to retry. */
async function retryBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const busy = errName(err) === 'ServiceBusyError' || statusCode(err) === 503
      if (!busy || attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
}

/** A command's output as lines, replayable from the start by every logs() (up to LOG_CAP_BYTES, oldest dropped). */
export class LogBuffer {
  private lines: RemoteLogLine[] = []
  private dropped = 0
  private bytes = 0
  private done = false
  private waiting: (() => void)[] = []

  push(stream: RemoteLogLine['stream'], data: string): void {
    this.lines.push({ stream, data })
    this.bytes += data.length
    while (this.bytes > LOG_CAP_BYTES && this.lines.length > 1) {
      this.bytes -= this.lines.shift()!.data.length
      this.dropped++
    }
    this.notify()
  }

  end(): void {
    this.done = true
    this.notify()
  }

  private notify(): void {
    const waiting = this.waiting
    this.waiting = []
    for (const wake of waiting) wake()
  }

  async *read(): AsyncIterable<RemoteLogLine> {
    for (let i = 0; ; ) {
      if (i < this.dropped) i = this.dropped
      const at = i - this.dropped
      if (at < this.lines.length) {
        yield this.lines[at]
        i++
        continue
      }
      if (this.done) return
      await new Promise<void>((r) => this.waiting.push(r))
    }
  }
}

/** A spawned command this process started or attached to. E2B's own reconnect doesn't replay output, so this does. */
interface Tracked {
  pid: number
  logs: LogBuffer
  result: Promise<{ code: number }>
}
const tracked = new Map<string, Tracked>()

function track(key: string, pid: number, logs: LogBuffer, handle: CommandHandle): Tracked {
  // A dropped connection (the stream, not the command, ended) reads as -1: the command may still be running.
  const result = exitCode(handle.wait()).then(
    (code) => ({ code }),
    () => ({ code: -1 })
  )
  const entry: Tracked = { pid, logs, result }
  tracked.set(key, entry)
  void result.then(() => {
    logs.end()
    setTimeout(() => {
      if (tracked.get(key) === entry) tracked.delete(key)
    }, ENDED_KEEP_MS).unref?.()
  })
  return entry
}

export class E2bProvider implements SandboxProvider {
  readonly id = 'e2b' as const

  constructor(
    private creds: E2bCredentials,
    private info: E2bConnectionInfo | undefined
  ) {}

  /** The connection options for one SDK call: explicit, so nothing comes from E2B_* environment variables. */
  auth(): { apiKey: string; domain: string; debug: false } {
    return { apiKey: this.creds.apiKey, domain: this.creds.domain || E2B_DOMAIN, debug: false }
  }

  limits(): PlanLimits {
    return this.info?.limits ?? CLOUD_PROVIDERS.e2b.limits
  }

  // No fork or base (every workspace is cloned and set up), pause keeps everything, sessions capped by the plan.
  capabilities(): ProviderCapabilities {
    return CLOUD_PROVIDERS.e2b.capabilities
  }

  sdk(): Promise<Sdk> {
    return load()
  }

  /** The template for a size, built once per team (minutes). Exposed so a UI can prepare it ahead of a create. */
  async ensureTemplate(vcpus: number, log?: (line: string) => void): Promise<string> {
    const { apiKey, domain } = this.auth()
    return ensureE2bTemplate((await load()) as unknown as TemplateSdk, { apiKey, domain }, vcpus, log)
  }

  // A session can't outlast the plan's cap; E2B refuses a longer timeout.
  sessionMs(ms: number): number {
    return Math.max(NO_EXTEND_MS, Math.min(ms, this.limits().maxSessionMs))
  }

  async create(o: CreateSandboxOptions): Promise<SandboxHandle> {
    // SandboxManager clones itself; E2B has no clone-at-create.
    if (o.source) throw new Error('E2B sandboxes don’t clone at creation; clone in the sandbox instead.')
    const template = await this.ensureTemplate(o.vcpus, (line) => console.log(`[e2b] ${line.trimEnd()}`))
    const { Sandbox } = await load()
    const timeoutMs = this.sessionMs(o.timeoutMs)
    const sb = await Sandbox.create(template, {
      ...this.auth(),
      timeoutMs,
      metadata: { ...o.tags, [NAME_KEY]: o.name, [TIMEOUT_KEY]: String(timeoutMs) },
      lifecycle: { onTimeout: 'pause', autoResume: false }
    })
    return new E2bHandle(this, sb.sandboxId, o.name, { state: 'running', startedAt: new Date(), metadata: { [TIMEOUT_KEY]: String(timeoutMs) } }, sb)
  }

  async get(name: string): Promise<SandboxHandle | null> {
    // Running and paused alike (the list's default); the newest if a name was ever reused.
    const found = await this.listInfos({ [NAME_KEY]: name })
    const info = found.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
    return info ? new E2bHandle(this, info.sandboxId, name, info) : null
  }

  async list(tag: Record<string, string>): Promise<SandboxInfo[]> {
    const infos = await this.listInfos(tag)
    return infos
      .filter((s) => s.metadata?.[NAME_KEY])
      .map((s) => ({
        name: s.metadata[NAME_KEY],
        status: statusOf(s),
        tags: tagsOf(s.metadata),
        createdAt: s.startedAt,
        ...(s.state === 'running' ? { expiresAt: s.endAt } : {})
      }))
  }

  private async listInfos(metadata: Record<string, string>): Promise<E2bSandboxInfo[]> {
    const { Sandbox } = await load()
    const pages = Sandbox.list({ ...this.auth(), query: { metadata, state: ['running', 'paused'] }, limit: 100 })
    const all: E2bSandboxInfo[] = []
    while (pages.hasNext) all.push(...(await pages.nextItems()))
    return all
  }

  /** The sandbox as it is now, without resuming it; null when it no longer exists. */
  async fetch(id: string): Promise<E2bSandboxInfo | null> {
    const { Sandbox } = await load()
    try {
      return await Sandbox.getInfo(id, this.auth())
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }
}

type KnownInfo = Pick<E2bSandboxInfo, 'state' | 'startedAt'> & { metadata?: Record<string, string>; endAt?: Date; cpuCount?: number }

class E2bHandle implements SandboxHandle {
  private state: 'running' | 'paused'
  private metadata: Record<string, string>
  // When this process last resumed it: E2B's startedAt may be the first start, and a receipt wants this session.
  private sessionStart: Date

  constructor(
    private provider: E2bProvider,
    readonly id: string,
    readonly name: string,
    info: KnownInfo,
    // The connected sandbox (commands, files, PTY). Only ever made for a running sandbox, or by a wake.
    private sb: Sandbox | null = null
  ) {
    this.state = info.state
    this.metadata = info.metadata ?? {}
    this.sessionStart = info.startedAt
  }

  private async refresh(): Promise<E2bSandboxInfo> {
    const info = await this.provider.fetch(this.id)
    if (!info) throw new Error(`The sandbox ${this.name} no longer exists`)
    this.state = info.state
    this.metadata = info.metadata ?? this.metadata
    if (info.state !== 'running') this.sb = null
    return info
  }

  async status(): Promise<ProviderStatus> {
    return statusOf(await this.refresh())
  }

  async session(): Promise<SandboxSession> {
    const info = await this.refresh()
    if (info.state !== 'running') return { status: 'stopped' }
    const startedAt = info.startedAt > this.sessionStart ? info.startedAt : this.sessionStart
    return { status: 'running', expiresAt: info.endAt, startedAt }
  }

  /** Map the SDK's "it paused under you" to the contract's refusal. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (stoppedUnder(err)) {
        this.state = 'paused'
        this.sb = null
        throw new SandboxNotRunningError(this.name)
      }
      throw err
    }
  }

  /** The connected sandbox, never resuming it: a paused one refuses, a running one is connected once. */
  private async live(): Promise<Sandbox> {
    // Known to be paused: refuse without a round trip (status() and a wake learn otherwise).
    if (this.state !== 'running') throw new SandboxNotRunningError(this.name)
    if (this.sb) return this.sb
    // connect() would resume a paused sandbox, so check first, from a fresh read.
    const info = await this.refresh()
    if (info.state !== 'running') throw new SandboxNotRunningError(this.name)
    const { Sandbox } = await this.provider.sdk()
    this.sb = await this.guard(() => Sandbox.connect(this.id, { ...this.provider.auth(), timeoutMs: NO_EXTEND_MS }))
    return this.sb
  }

  /** The connected sandbox, resumed first when paused, with the session length it was made with. */
  private async woken(): Promise<Sandbox> {
    const info = await this.refresh()
    if (info.state === 'running' && this.sb) return this.sb
    const { Sandbox } = await this.provider.sdk()
    const made = Number(this.metadata[TIMEOUT_KEY])
    const timeoutMs = info.state === 'running' ? NO_EXTEND_MS : this.provider.sessionMs(Number.isFinite(made) && made > 0 ? made : this.provider.limits().maxSessionMs)
    this.sb = await Sandbox.connect(this.id, { ...this.provider.auth(), timeoutMs })
    if (info.state !== 'running') this.sessionStart = new Date()
    this.state = 'running'
    return this.sb
  }

  async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}): Promise<RuntimeExecResult> {
    const sb = opts.wake ? await this.woken() : await this.live()
    let stdout = ''
    let stderr = ''
    // Background, so a signal can kill it; the output streams as it comes either way.
    const handle = await this.guard(() =>
      sb.commands.run(commandLine(cmd, args), {
        background: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        envs: cleanEnv(opts.env),
        ...(opts.sudo ? { user: 'root' } : {}),
        // E2B's default kills a command after 60 s; Foreman's commands run to the end unless they ask.
        timeoutMs: opts.timeoutMs ?? 0,
        onStdout: (d) => {
          stdout += d
          opts.onOutput?.(d)
        },
        onStderr: (d) => {
          stderr += d
          opts.onOutput?.(d)
        }
      })
    )
    let aborted = false
    const onAbort = () => {
      aborted = true
      void handle.kill().catch(() => undefined)
    }
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let code: number
      try {
        code = await this.guard(() => exitCode(handle.wait()))
      } catch (err) {
        if (err instanceof SandboxNotRunningError) throw err
        // Its timeoutMs ran out: E2B killed it. As `timeout` reports it.
        if (opts.timeoutMs && errName(err) === 'TimeoutError') return { stdout, stderr: `${stderr}${err instanceof Error ? err.message : ''}`, code: 124 }
        if (aborted) return { stdout, stderr, code: 137 }
        throw err
      }
      return { stdout, stderr, code: aborted && code === 0 ? 137 : code }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  async spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote> {
    const sb = await this.live()
    const logs = new LogBuffer()
    const handle = await this.guard(() =>
      sb.commands.run(commandLine(cmd, args), {
        background: true,
        stdin: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        envs: cleanEnv(opts.env),
        // No timeout: the host must outlive this app's connection (E2B kills a background command at its timeout).
        timeoutMs: 0,
        onStdout: (d) => logs.push('stdout', d),
        onStderr: (d) => logs.push('stderr', d)
      })
    )
    return this.remote(sb, track(`${this.id}:${handle.pid}`, handle.pid, logs, handle))
  }

  /**
   * In this process, a re-attach replays the command's logs from the start. After an app restart E2B's own reconnect
   * streams only new output (E2B keeps none): nothing in Foreman re-attaches across restarts (the host's turn logs live in
   * its state folder, and the attach bridge is spawned anew).
   */
  async attachCommand(cmdId: string): Promise<SpawnedRemote> {
    const sb = await this.live()
    const known = tracked.get(`${this.id}:${cmdId}`)
    if (known) return this.remote(sb, known)
    const pid = Number(cmdId)
    if (!Number.isInteger(pid)) throw new Error(`No command ${cmdId} in ${this.name}`)
    const logs = new LogBuffer()
    const handle = await this.guard(() => sb.commands.connect(pid, { timeoutMs: 0, onStdout: (d) => logs.push('stdout', d), onStderr: (d) => logs.push('stderr', d) }))
    return this.remote(sb, track(`${this.id}:${pid}`, pid, logs, handle))
  }

  private remote(sb: Sandbox, t: Tracked): SpawnedRemote {
    return {
      cmdId: String(t.pid),
      write: (data) => this.guard(() => sb.commands.sendStdin(t.pid, data)),
      closeStdin: () => this.guard(() => sb.commands.closeStdin(t.pid)),
      logs: () => t.logs.read(),
      wait: () => t.result,
      kill: async () => {
        await this.guard(() => sb.commands.kill(t.pid))
      }
    }
  }

  async readFile(p: string): Promise<Buffer | null> {
    const sb = await this.live()
    return this.guard(async () => {
      try {
        const bytes = await sb.files.read(p, { format: 'bytes' })
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      } catch (err) {
        if (errName(err) === 'FileNotFoundError') return null
        throw err
      }
    })
  }

  writeFile(p: string, data: Buffer | string, mode?: number): Promise<void> {
    return this.writeFiles([{ path: p, data, mode }])
  }

  // One upload; E2B makes each file's folders. Modes go after, one chmod per mode.
  async writeFiles(files: SandboxFile[]): Promise<void> {
    const sb = await this.live()
    if (!files.length) return
    const entries = files.map((f) => ({ path: f.path, data: typeof f.data === 'string' ? f.data : new Uint8Array(f.data).buffer }))
    await this.guard(() => sb.files.write(entries))
    const byMode = new Map<number, string[]>()
    for (const f of files) if (f.mode !== undefined) byMode.set(f.mode, [...(byMode.get(f.mode) ?? []), f.path])
    if (!byMode.size) return
    const line = [...byMode].map(([mode, paths]) => `chmod ${mode.toString(8)} ${paths.map(bashQuote).join(' ')}`).join(' && ')
    const code = await this.guard(() => exitCode(sb.commands.run(line, { timeoutMs: 60_000 })))
    if (code !== 0) throw new Error(`Couldn’t set the files’ modes in ${this.name} (exit code ${code})`)
  }

  async mkdir(p: string): Promise<void> {
    const sb = await this.live()
    await this.guard(() => sb.files.makeDir(p))
  }

  async exists(p: string): Promise<boolean> {
    const sb = await this.live()
    return this.guard(() => sb.files.exists(p))
  }

  async openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
    const sb = await this.live()
    return this.guard(() => openE2bPty(sb.pty, start, listener))
  }

  async stop(): Promise<StopReceipt> {
    const info = await this.refresh()
    if (info.state !== 'running') return {}
    const { Sandbox } = await this.provider.sdk()
    await retryBusy(() => Sandbox.pause(this.id, this.provider.auth()))
    this.state = 'paused'
    this.sb = null
    const started = info.startedAt > this.sessionStart ? info.startedAt : this.sessionStart
    const durationMs = Date.now() - started.getTime()
    return durationMs >= 0 ? { durationMs, vcpus: info.cpuCount } : {}
  }

  // E2B's setTimeout sets the time left from now, not an addition.
  async extendTimeout(ms: number): Promise<void> {
    const info = await this.refresh()
    if (info.state !== 'running') throw new SandboxNotRunningError(this.name)
    const left = Math.max(0, info.endAt.getTime() - Date.now())
    const { Sandbox } = await this.provider.sdk()
    await this.guard(() => Sandbox.setTimeout(this.id, left + ms, this.provider.auth()))
  }

  // Killing a paused sandbox deletes its saved state too; Foreman takes no separate E2B snapshots.
  async delete(): Promise<void> {
    const { Sandbox } = await this.provider.sdk()
    await Sandbox.kill(this.id, this.provider.auth())
    this.sb = null
    this.state = 'paused'
  }
}

/** The provider for one E2B key. Must not touch the network: the manager makes providers to read capabilities(). */
export function createE2bProvider(creds: E2bCredentials, info: E2bConnectionInfo | undefined): SandboxProvider {
  return new E2bProvider(creds, info)
}

/**
 * Checks a key before it is saved. Identity: the team the key belongs to (orgId: its id, so the same team twice is a
 * duplicate). Throw with `auth: true` when E2B refused the key; an unreachable E2B is a plain error.
 *
 * An API key can list sandboxes and templates but not read its team (that, and the team's limits, take a dashboard
 * session), so the team is the namespace of the team's own templates when it has any, else the key itself; the limits
 * are Hobby's (src/shared/cloud.ts) until E2B lets a key read them.
 */
export async function verifyE2b(apiKey: string, info: { domain?: string }, doFetch: typeof fetch = fetch): Promise<{ identity: ConnectionIdentity; e2b: E2bConnectionInfo }> {
  const domain = info.domain?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || undefined
  const api = `https://api.${domain ?? E2B_DOMAIN}`
  const headers = { 'X-API-Key': apiKey }
  const get = async (path: string): Promise<Response> => {
    try {
      return await doFetch(`${api}${path}`, { headers })
    } catch (err) {
      throw new Error(`Couldn’t reach E2B at ${api}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const res = await get('/v2/sandboxes?limit=1')
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('E2B refused this API key. It may have been deleted or mistyped.'), { auth: true })
  if (!res.ok) throw new Error(`E2B answered ${res.status}`)
  let team: string | undefined
  try {
    const t = await get('/templates')
    if (t.ok) {
      const templates = (await t.json()) as { names?: string[]; isDefault?: boolean }[]
      team = templates
        .filter((x) => !x.isDefault)
        .flatMap((x) => x.names ?? [])
        .map((n) => (n.includes('/') ? n.split('/')[0] : ''))
        .find(Boolean)
    }
  } catch {
    // The team's name is a nicety; the key checked out.
  }
  const where = domain ?? E2B_DOMAIN
  const keyId = createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
  const identity: ConnectionIdentity = {
    user: team ?? `API key …${apiKey.slice(-4)}`,
    ...(team ? { org: team } : {}),
    orgId: team ? `${where}/${team}` : `${where}/key-${keyId}`,
    checkedAt: new Date().toISOString()
  }
  return { identity, e2b: { ...(domain ? { domain } : {}), limits: CLOUD_PROVIDERS.e2b.limits } }
}
