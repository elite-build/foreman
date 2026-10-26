// SandboxProvider on Daytona: sandboxes through `@daytonaio/sdk`.
// The SDK is loaded on first use and every client is made with the connection's key, URL and target, never
// from the environment. Sandboxes start from a Foreman snapshot (daytonaImage.ts, one per size and region,
// built on first use); a repository's base is a stopped sandbox whose cold snapshot workspaces start from.
// Nothing but exec's `wake` starts a stopped sandbox: the other calls check the state first.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Daytona, Sandbox } from '@daytonaio/sdk'
import { CLOUD_PROVIDERS, type PlanLimits, type ProviderCapabilities, type ProviderStatus } from '../../shared/cloud'
import { DAYTONA_API_URL, type ConnectionIdentity, type DaytonaConnectionInfo } from '../../shared/integrations'
import type { RuntimeExecResult } from '../runtime/types'
import { DAYTONA_BASE_IMAGE, DAYTONA_DOCKERFILE, daytonaResources, daytonaSnapshotName } from './daytonaImage'
import { connectDaytonaPty, sh } from './daytonaPty'
import {
  SandboxNotRunningError,
  type CreateSandboxOptions,
  type ForkSandboxOptions,
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

export interface DaytonaCredentials {
  apiKey: string
  // https://app.daytona.io/api, or a self-hosted Daytona's.
  apiUrl: string
  // The region sandboxes are made in (us, eu); absent: the organization's default.
  target?: string
}

type Sdk = typeof import('@daytonaio/sdk')
let sdk: Promise<Sdk> | null = null
const load = (): Promise<Sdk> => (sdk ??= import('@daytonaio/sdk'))

// One client per key, URL and target: providers are made often, clients are not.
const clients = new Map<string, Promise<Daytona>>()
// Snapshots being made or checked right now, so two creates don't both build one.
const snapshotsReady = new Map<string, Promise<string>>()

// Foreman's own labels beside the tags; list() hides them.
export const NAME_LABEL = 'foreman.name'
export const APP_LABEL = 'foreman.app'
const HIDDEN_LABELS = new Set([NAME_LABEL, APP_LABEL, 'code-toolbox-language'])

// Foreman sleeps idle sandboxes itself: no auto-stop (Daytona's is idle-based, and counts only SDK calls as
// activity), never auto-deleted. Auto-archive keeps Daytona's default (7 days stopped): an archived sandbox keeps its
// files in object storage and starts again, more slowly.
const LIFECYCLE = { autoStopInterval: 0, autoDeleteInterval: -1, public: false } as const

const CREATE_TIMEOUT_S = 5 * 60
const WAKE_TIMEOUT_S = 10 * 60
const STOP_TIMEOUT_S = 2 * 60
const SNAPSHOT_TIMEOUT_S = 30 * 60
const SNAPSHOT_WAIT_MS = 45 * 60_000

const STOPPED_STATES = new Set(['stopped', 'archived', 'archiving', 'paused'])
const PENDING_STATES = new Set(['creating', 'restoring', 'starting', 'pending_build', 'building_snapshot', 'pulling_snapshot', 'resuming', 'resizing', 'unknown'])
const GONE_STATES = new Set(['destroyed', 'destroying'])

/** A sandbox's state as Foreman's status. Archived is stopped: its files are kept and a start restores them. */
export function daytonaStatus(state: string | undefined): ProviderStatus {
  if (state === 'started' || state === 'forking') return 'running'
  if (state === 'stopping' || state === 'pausing') return 'stopping'
  if (state === 'snapshotting') return 'snapshotting'
  if (state === 'error' || state === 'build_failed') return 'failed'
  if (state && STOPPED_STATES.has(state)) return 'stopped'
  if (state && GONE_STATES.has(state)) return 'aborted'
  return 'pending'
}

function statusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { status?: number } } | null
  return e?.statusCode ?? e?.response?.status
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const notFound = (err: unknown) => statusCode(err) === 404 || /not found|no such file/i.test(message(err))

/** Daytona refused to make a snapshot for this key (no write:snapshots, or the snapshot quota is used up). */
function snapshotRefused(err: unknown): boolean {
  const code = statusCode(err)
  return code === 403 || ((code === 400 || code === 422) && /quota|limit|permission/i.test(message(err)))
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  const clean = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
  return Object.keys(clean).length ? clean : undefined
}

/**
 * The environment for a session command, as one base64 line written to its stdin: session commands take no env and
 * their command text is written to a file in the sandbox, so secrets (GH_TOKEN) travel this way instead.
 */
export function envLine(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Not an environment variable name: ${key}`)
    return `export ${key}=${sh(value)}`
  })
  return `${Buffer.from(lines.join('\n')).toString('base64')}\n`
}

const EXEC_MARK = 'FOREMAN-EXEC'

/**
 * A command run through `process.executeCommand`, which merges stdout and stderr into one text: the command's two
 * streams go to files and come back base64 after its exit code, byte for byte. Its stdin is /dev/null (the daemon's
 * shell reads this script from its own stdin). Only POSIX tools and options: base64 wraps its lines on some systems and
 * takes no file operand or -w on others, so it reads stdin and tr drops the line breaks.
 */
export function execScript(cmdline: string): string {
  return [
    '__d=$(mktemp -d /tmp/foreman-exec.XXXXXX) || exit 97',
    `${cmdline} </dev/null >"$__d/o" 2>"$__d/e"`,
    '__c=$?',
    `printf '${EXEC_MARK} %s\\n' "$__c"`,
    `base64 <"$__d/o" | tr -d '\\n'; echo`,
    `base64 <"$__d/e" | tr -d '\\n'; echo`,
    'rm -rf "$__d"'
  ].join('\n')
}

/** execScript's output as a result. Without its marks the command never ran: the daemon's text is the error. */
export function parseExec(result: string, exitCode: number | undefined): RuntimeExecResult {
  const m = new RegExp(`(?:^|\\n)${EXEC_MARK} (-?\\d+)\\n([A-Za-z0-9+/=]*)\\n([A-Za-z0-9+/=]*)\\n?$`).exec(result)
  if (!m) return { stdout: '', stderr: result, code: exitCode === undefined || exitCode < 0 ? 127 : exitCode || 1 }
  return { code: Number(m[1]), stdout: Buffer.from(m[2], 'base64').toString('utf8'), stderr: Buffer.from(m[3], 'base64').toString('utf8') }
}

/** The line closeStdin sends; the spawn's filter ends the command's stdin on it. Derived from the session id, so a re-attach knows it. */
export const eofMarker = (sessionId: string) => `FOREMAN_EOF_${sessionId}`

// Runs the command (argv[2], through /bin/sh) with its own stdin pipe and passes stdin to it line by line until the
// EOF marker (argv[1]), then ends that pipe; lines after the marker are dropped. Exits as the command does (128+n for
// a signal), so nothing is left behind. A pipe, not a fifo: macOS may never report a fifo's end to its reader.
const STDIN_FILTER =
  'const[m,c]=process.argv.slice(1);let b="",open=true;' +
  'const p=require("child_process").spawn("/bin/sh",["-c","exec "+c],{stdio:["pipe","inherit","inherit"]});' +
  'p.stdin.on("error",()=>{});p.on("error",()=>process.exit(127));' +
  'p.on("exit",(code,sig)=>process.exit(code??128+(require("os").constants.signals[sig]||0)));' +
  'const end=()=>{open=false;process.stdin.pause();p.stdin.end()};process.stdin.setEncoding("utf8");' +
  'process.stdin.on("data",(d)=>{if(!open)return;b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l===m)return end();p.stdin.write(l+"\\n")}});' +
  'process.stdin.on("end",()=>{if(!open)return;if(b)p.stdin.write(b);end()})'

/**
 * A session command's script (run by the session's shell, so all of it in a subshell). With `env`, the first stdin
 * line is envLine's. With `stdin`, STDIN_FILTER runs the command and ends its stdin at that marker (the daemon keeps a
 * session command's stdin open and has no way to close it); otherwise its stdin is /dev/null.
 */
export function sessionScript(cmdline: string, o: { cwd?: string; env?: boolean; stdin?: string }): string {
  const lines = ['(']
  if (o.env) lines.push(`IFS= read -r __e && eval "$(printf '%s' "$__e" | base64 -d)"; unset __e`)
  if (o.cwd) lines.push(`cd -- ${sh(o.cwd)} || exit 1`)
  lines.push(o.stdin ? `exec node -e ${sh(STDIN_FILTER)} ${sh(o.stdin)} ${sh(cmdline)}` : `exec ${cmdline} </dev/null`)
  lines.push(')')
  return lines.join('\n')
}

/** The name of a base's cold snapshot: one per base sandbox (a rebuilt base is a new sandbox, with a new id). */
export const baseSnapshotName = (base: Pick<Sandbox, 'name' | 'id'>) => `${base.name}-${base.id.slice(0, 8)}`

/** Build output from a snapshot, to the main log, with its tail kept for the error if the build fails. */
function buildLog(name: string): { push: (chunk: string) => void; fail: (err: unknown) => Error } {
  const tail: string[] = []
  return {
    push: (chunk) => {
      console.info(`[daytona] ${name}: ${chunk}`)
      tail.push(chunk)
      if (tail.length > 30) tail.shift()
    },
    fail: (err) => new Error(`Daytona couldn’t build the snapshot ${name}: ${message(err)}${tail.length ? `\n${tail.join('\n')}` : ''}`)
  }
}

export class DaytonaProvider implements SandboxProvider {
  readonly id = 'daytona' as const

  constructor(
    private creds: DaytonaCredentials,
    private info: DaytonaConnectionInfo | undefined
  ) {}

  // No forks (containers can't), bases through cold snapshots, files kept on stop, no session cap, a PTY.
  capabilities(): ProviderCapabilities {
    return CLOUD_PROVIDERS.daytona.capabilities
  }

  limits(): PlanLimits {
    return this.info?.limits ?? CLOUD_PROVIDERS.daytona.limits
  }

  /** The SDK client for these credentials, given explicitly (the SDK reads the environment only for what's missing). */
  client(): Promise<Daytona> {
    const { apiKey, apiUrl, target } = this.creds
    const key = `${apiUrl}\n${target ?? ''}\n${apiKey}`
    let client = clients.get(key)
    if (!client) {
      // Polling, not the SDK's event socket: a client must not hold a connection open for the app's life.
      client = load().then(({ Daytona }) => new Daytona({ apiKey, apiUrl, ...(target ? { target } : {}), useDeprecatedPolling: true }))
      clients.set(key, client)
      client.catch(() => clients.delete(key))
    }
    return client
  }

  private region(region: string | undefined): string | undefined {
    return region || this.creds.target || undefined
  }

  labels(name: string, tags: Record<string, string>): Record<string, string> {
    return { ...tags, [APP_LABEL]: 'foreman', [NAME_LABEL]: name }
  }

  async create(o: CreateSandboxOptions): Promise<SandboxHandle> {
    if (o.source) throw new Error('Daytona sandboxes are cloned by Foreman after they are made, not at creation')
    const d = await this.client()
    const target = this.region(o.region)
    const common = { name: o.name, labels: this.labels(o.name, o.tags), ...LIFECYCLE, ...(target ? { target } : {}) }
    const snapshot = await this.ensureSnapshot(o.vcpus, target).catch((err: unknown) => {
      if (!snapshotRefused(err)) throw err
      console.warn(`[daytona] can’t make the Foreman snapshot (${message(err)}); building the image for this sandbox instead.`)
      return null
    })
    let sb: Sandbox
    if (snapshot) sb = await d.create({ ...common, snapshot }, { timeout: CREATE_TIMEOUT_S })
    else {
      // Slower: Daytona builds the image for this sandbox (cached on its runner for a day).
      const { Image } = await load()
      const log = buildLog(o.name)
      const image = Image.base(DAYTONA_BASE_IMAGE).dockerfileCommands(DAYTONA_DOCKERFILE)
      sb = await d.create({ ...common, image, resources: daytonaResources(o.vcpus) }, { timeout: 0, onSnapshotCreateLogs: log.push }).catch((err: unknown) => {
        throw log.fail(err)
      })
    }
    return new DaytonaHandle(sb, this)
  }

  /**
   * A new sandbox from the stopped base's cold snapshot (made when a base stops, or here the first time). It has the
   * base's size; a larger one is asked for by resizing, which Daytona allows only where the organization has it on.
   */
  async createFromBase(baseName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    const base = await this.fetch(baseName)
    if (!base) throw new Error(`The base ${baseName} no longer exists on Daytona. Build it again.`)
    const snapshot = await this.baseSnapshot(base)
    const d = await this.client()
    const target = base.target || this.region(o.region)
    const sb = await d.create({ name: o.name, snapshot, labels: this.labels(o.name, o.tags), ...LIFECYCLE, ...(target ? { target } : {}) }, { timeout: CREATE_TIMEOUT_S })
    if (o.vcpus && o.vcpus > sb.cpu) {
      await sb.resize({ cpu: o.vcpus, memory: daytonaResources(o.vcpus).memory }).catch((err: unknown) => {
        console.warn(`[daytona] ${o.name} keeps the base’s ${sb.cpu} vCPUs: ${message(err)}`)
      })
    }
    return new DaytonaHandle(sb, this)
  }

  async get(name: string): Promise<SandboxHandle | null> {
    const sb = await this.fetch(name)
    return sb ? new DaytonaHandle(sb, this) : null
  }

  /** The sandbox by its name, without starting it; null when missing or being deleted. */
  async fetch(name: string): Promise<Sandbox | null> {
    const d = await this.client()
    try {
      const sb = await d.get(name)
      return sb.state && GONE_STATES.has(sb.state) ? null : sb
    } catch (err) {
      if (statusCode(err) === 404) return null
      throw err
    }
  }

  async list(tag: Record<string, string>): Promise<SandboxInfo[]> {
    const d = await this.client()
    const out: SandboxInfo[] = []
    for await (const sb of d.list({ labels: tag })) {
      if (sb.state && GONE_STATES.has(sb.state)) continue
      out.push({
        name: sb.labels?.[NAME_LABEL] ?? sb.name,
        status: daytonaStatus(sb.state),
        tags: Object.fromEntries(Object.entries(sb.labels ?? {}).filter(([k]) => !HIDDEN_LABELS.has(k))),
        ...(sb.createdAt ? { createdAt: new Date(sb.createdAt) } : {})
      })
    }
    return out
  }

  private once(name: string, make: () => Promise<string>): Promise<string> {
    const key = `${this.creds.apiUrl}\n${this.creds.apiKey}\n${name}`
    let ready = snapshotsReady.get(key)
    if (!ready) {
      // Only while in flight: a snapshot can go inactive or be deleted later, so each create checks it again.
      ready = make().finally(() => snapshotsReady.delete(key))
      snapshotsReady.set(key, ready)
    }
    return ready
  }

  private async snapshotState(name: string): Promise<string | null> {
    const d = await this.client()
    try {
      return (await d.snapshot.get(name)).state
    } catch (err) {
      if (statusCode(err) === 404) return null
      throw err
    }
  }

  /** Waits for a snapshot to be usable, activating it if it went inactive (two weeks unused). */
  private async activeSnapshot(name: string): Promise<void> {
    const d = await this.client()
    const started = Date.now()
    for (;;) {
      const s = await d.snapshot.get(name)
      if (s.state === 'active') return
      if (s.state === 'error' || s.state === 'build_failed') throw new Error(`Daytona couldn’t make the snapshot ${name}: ${s.errorReason || s.state}`)
      if (s.state === 'inactive') await d.snapshot.activate(name).catch(() => undefined)
      if (Date.now() - started > SNAPSHOT_WAIT_MS) throw new Error(`The Daytona snapshot ${name} is still ${s.state}. Try again in a few minutes.`)
      await sleep(2000)
    }
  }

  /** The Foreman snapshot for a size and region, built from daytonaImage.ts the first time (minutes; its log goes to the main log). */
  ensureSnapshot(vcpus: number, target: string | undefined): Promise<string> {
    const name = daytonaSnapshotName(vcpus, target)
    return this.once(name, async () => {
      const d = await this.client()
      let state = await this.snapshotState(name)
      if (state === 'error' || state === 'build_failed') {
        await d.snapshot.delete(name).catch(() => undefined)
        state = null
      }
      if (state === null) {
        const { Image } = await load()
        const log = buildLog(name)
        try {
          const image = Image.base(DAYTONA_BASE_IMAGE).dockerfileCommands(DAYTONA_DOCKERFILE)
          await d.snapshot.create({ name, image, resources: daytonaResources(vcpus), ...(target ? { regionId: target } : {}) }, { onLogs: log.push, timeout: 0 })
          return name
        } catch (err) {
          // 409: another Foreman is building it; wait for theirs.
          if (statusCode(err) !== 409) throw snapshotRefused(err) ? err : log.fail(err)
        }
      }
      await this.activeSnapshot(name)
      return name
    })
  }

  /**
   * The base's cold snapshot (Daytona snapshots a container's filesystem only when it is stopped). A base archived
   * before it was snapshotted is started and stopped once to bring its files back.
   */
  baseSnapshot(base: Sandbox): Promise<string> {
    const name = baseSnapshotName(base)
    return this.once(name, async () => {
      const state = await this.snapshotState(name)
      if (state === null || state === 'error' || state === 'build_failed') {
        if (state !== null) await (await this.client()).snapshot.delete(name).catch(() => undefined)
        await base.refreshData()
        if (base.state === 'archived') {
          await base.start(WAKE_TIMEOUT_S)
          await base.stop(STOP_TIMEOUT_S)
        } else if (base.state === 'stopping' || base.state === 'snapshotting') await base.waitUntilStopped(SNAPSHOT_TIMEOUT_S)
        else if (base.state !== 'stopped') throw new Error(`The base ${base.name} must be stopped before a workspace starts from it (it is ${base.state ?? 'unknown'}).`)
        try {
          await base.createSnapshot(name, SNAPSHOT_TIMEOUT_S)
        } catch (err) {
          if (statusCode(err) !== 409) throw err
        }
      }
      await this.activeSnapshot(name)
      return name
    })
  }

  /** A sandbox's snapshots: the ones Daytona says were made from it, and its base snapshot by name. */
  async deleteSnapshotsOf(sb: Pick<Sandbox, 'name' | 'id'>): Promise<void> {
    const d = await this.client()
    const names = new Set([baseSnapshotName(sb)])
    const page = await d.snapshot.list({ sourceSandboxId: sb.id, limit: 100 }).catch(() => null)
    for (const s of page?.items ?? []) names.add(s.name)
    for (const name of names) {
      await d.snapshot.delete(name).catch((err: unknown) => {
        if (statusCode(err) !== 404) console.warn(`[daytona] couldn’t delete the snapshot ${name}: ${message(err)}`)
      })
    }
  }
}

class DaytonaHandle implements SandboxHandle {
  constructor(
    private sb: Sandbox,
    private provider: DaytonaProvider
  ) {}

  get name(): string {
    return this.sb.labels?.[NAME_LABEL] ?? this.sb.name
  }

  private async refresh(): Promise<Sandbox> {
    try {
      await this.sb.refreshData()
    } catch (err) {
      if (statusCode(err) === 404) throw new Error(`The sandbox ${this.name} no longer exists`)
      throw err
    }
    if (this.sb.state && GONE_STATES.has(this.sb.state)) throw new Error(`The sandbox ${this.name} no longer exists`)
    return this.sb
  }

  async status(): Promise<ProviderStatus> {
    return daytonaStatus((await this.refresh()).state)
  }

  // No session cap and no start time from Daytona: just the status.
  async session(): Promise<SandboxSession> {
    return { status: daytonaStatus((await this.refresh()).state) }
  }

  /**
   * Run `fn` only on a started sandbox. Last known started: try it, and a failure from a sandbox that stopped since
   * refuses. Anything else: one fetch decides. Never starts it.
   */
  private async live<T>(fn: (sb: Sandbox) => Promise<T>): Promise<T> {
    if (this.sb.state !== 'started') await this.refresh()
    if (this.sb.state !== 'started') throw new SandboxNotRunningError(this.name)
    try {
      return await fn(this.sb)
    } catch (err) {
      if (err instanceof SandboxNotRunningError) throw err
      const state = await this.refresh().then(
        (sb) => sb.state,
        () => undefined
      )
      if (state !== 'started') throw new SandboxNotRunningError(this.name)
      throw err
    }
  }

  /** A user's action or a turn: start it (an archived one is restored first, which takes longer). */
  private async wake(): Promise<void> {
    const sb = await this.refresh()
    const state = sb.state ?? 'unknown'
    if (state === 'started') return
    if (PENDING_STATES.has(state)) return sb.waitUntilStarted(WAKE_TIMEOUT_S)
    if (state === 'stopping' || state === 'pausing' || state === 'snapshotting') await sb.waitUntilStopped(SNAPSHOT_TIMEOUT_S)
    if (state === 'error') {
      if (!sb.recoverable) throw new Error(`The sandbox ${this.name} failed: ${sb.errorReason || 'error'}`)
      return sb.recover(WAKE_TIMEOUT_S)
    }
    await sb.start(WAKE_TIMEOUT_S)
  }

  /** A short command of our own (mkdir, chmod); a failure is an error. */
  private async run(sb: Sandbox, script: string): Promise<RuntimeExecResult> {
    const r = parseExec((await sb.process.executeCommand(execScript(script))).result, undefined)
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`)
    return r
  }

  async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}): Promise<RuntimeExecResult> {
    const cmdline = `${opts.sudo ? 'sudo -E -- ' : ''}${[cmd, ...args].map(sh).join(' ')}`
    const env = cleanEnv(opts.env)
    if (opts.wake) await this.wake()
    return this.live((sb) => (opts.onOutput || opts.signal ? this.streamed(sb, cmdline, opts, env) : this.direct(sb, cmdline, opts, env)))
  }

  /** One request: exact bytes on both streams; env goes in the request, to this command's shell only. */
  private async direct(sb: Sandbox, cmdline: string, opts: SandboxExecOptions, env: Record<string, string> | undefined): Promise<RuntimeExecResult> {
    const seconds = opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : undefined
    try {
      const r = await sb.process.executeCommand(execScript(cmdline), opts.cwd, env, seconds)
      return parseExec(r.result, r.exitCode)
    } catch (err) {
      // The daemon kills the command's process group at the timeout and answers 408.
      if (seconds && statusCode(err) === 408) return { stdout: '', stderr: `Timed out after ${seconds} s`, code: 124 }
      throw err
    }
  }

  /**
   * Streamed or stoppable: a session command, its output as the daemon logs it (by line), killed by deleting its
   * session. The daemon adds a newline to a last line that has none.
   */
  private async streamed(sb: Sandbox, cmdline: string, opts: SandboxExecOptions, env: Record<string, string> | undefined): Promise<RuntimeExecResult> {
    const sid = `foreman-exec-${hex(8)}`
    await sb.process.createSession(sid)
    let killed: 'signal' | 'timeout' | null = null
    let markKilled: () => void = () => undefined
    const killedNow = new Promise<void>((resolve) => (markKilled = resolve))
    const kill = (why: 'signal' | 'timeout') => {
      if (killed) return
      killed = why
      void sb.process
        .deleteSession(sid)
        .catch(() => undefined)
        // The log stream ends when the session goes; don't wait on it for long if it doesn't.
        .finally(() => setTimeout(markKilled, 2000))
    }
    const onAbort = () => kill('signal')
    const timer = opts.timeoutMs ? setTimeout(() => kill('timeout'), opts.timeoutMs) : null
    try {
      const { cmdId } = await sb.process.executeSessionCommand(sid, { command: sessionScript(cmdline, { cwd: opts.cwd, env: Boolean(env) }), runAsync: true, suppressInputEcho: true })
      if (env) await sb.process.sendSessionCommandInput(sid, cmdId, envLine(env))
      if (opts.signal?.aborted) onAbort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      let stdout = ''
      let stderr = ''
      const logs = sb.process.getSessionCommandLogs(
        sid,
        cmdId,
        (chunk) => {
          stdout += chunk
          opts.onOutput?.(chunk)
        },
        (chunk) => {
          stderr += chunk
          opts.onOutput?.(chunk)
        }
      )
      await Promise.race([
        logs.catch((err: unknown) => {
          if (!killed) throw err
        }),
        killedNow
      ])
      if (killed) return { stdout, stderr, code: killed === 'timeout' ? 124 : 130 }
      return { stdout, stderr, code: (await exitCodeOf(sb, sid, cmdId, 10_000)) ?? 1 }
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (!killed) void sb.process.deleteSession(sid).catch(() => undefined)
    }
  }

  // Each spawn has its own session: a session runs its commands one after another.
  async spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote> {
    const cmdline = [cmd, ...args].map(sh).join(' ')
    const env = cleanEnv(opts.env)
    return this.live(async (sb) => {
      const sid = `foreman-cmd-${hex(8)}`
      await sb.process.createSession(sid)
      try {
        const { cmdId } = await sb.process.executeSessionCommand(sid, { command: sessionScript(cmdline, { cwd: opts.cwd, env: Boolean(env), stdin: eofMarker(sid) }), runAsync: true, suppressInputEcho: true })
        if (env) await sb.process.sendSessionCommandInput(sid, cmdId, envLine(env))
        return this.remote(sid, cmdId)
      } catch (err) {
        await sb.process.deleteSession(sid).catch(() => undefined)
        throw err
      }
    })
  }

  async attachCommand(cmdId: string): Promise<SpawnedRemote> {
    const at = cmdId.indexOf(':')
    if (at < 0) throw new Error(`Not a Daytona command id: ${cmdId}`)
    const sid = cmdId.slice(0, at)
    const id = cmdId.slice(at + 1)
    await this.live((sb) => sb.process.getSessionCommand(sid, id))
    return this.remote(sid, id)
  }

  private remote(sid: string, id: string): SpawnedRemote {
    const decoder = new TextDecoder()
    let partial = ''
    let chain: Promise<void> = Promise.resolve()
    const input = (data: string) => this.live((sb) => sb.process.sendSessionCommandInput(sid, id, data))
    const queue = (data: string) => {
      const next = chain.then(() => input(data))
      chain = next.catch(() => undefined)
      return next
    }
    const proc = () => this.sb.process
    return {
      cmdId: `${sid}:${id}`,
      // Whole lines only: the daemon adds a newline to every write that lacks one.
      write: (data) => {
        partial += typeof data === 'string' ? data : decoder.decode(data, { stream: true })
        const cut = partial.lastIndexOf('\n')
        if (cut < 0) return chain
        const lines = partial.slice(0, cut + 1)
        partial = partial.slice(cut + 1)
        return queue(lines)
      },
      closeStdin: async () => {
        const rest = partial + decoder.decode()
        partial = ''
        if (rest) await queue(rest)
        // A command that already ended has no stdin to close (410).
        await queue(`${eofMarker(sid)}\n`).catch((err: unknown) => {
          if (statusCode(err) !== 410 && statusCode(err) !== 404) throw err
        })
      },
      // From the start of the command's log, as the daemon replays it.
      logs: async function* () {
        const lines: RemoteLogLine[] = []
        let done = false
        let failure: unknown = null
        let notify: (() => void) | null = null
        const push = (line: RemoteLogLine) => {
          lines.push(line)
          notify?.()
        }
        void proc()
          .getSessionCommandLogs(
            sid,
            id,
            (data) => push({ stream: 'stdout', data }),
            (data) => push({ stream: 'stderr', data })
          )
          .then(
            () => undefined,
            (err: unknown) => {
              // A killed command's session is gone: its log just ends.
              if (statusCode(err) !== 404) failure = err
            }
          )
          .finally(() => {
            done = true
            notify?.()
          })
        for (;;) {
          const line = lines.shift()
          if (line) {
            yield line
            continue
          }
          if (done) break
          await new Promise<void>((resolve) => (notify = resolve))
          notify = null
        }
        if (failure) throw failure
      },
      // The log stream ends when the command does; its exit code is then on the command.
      wait: async () => {
        let delay = 1000
        for (;;) {
          await proc()
            .getSessionCommandLogs(
              sid,
              id,
              () => undefined,
              () => undefined
            )
            .catch(() => undefined)
          const code = await this.live((sb) => exitCodeOf(sb, sid, id, 2000))
          if (code !== undefined) return { code: code ?? 137 }
          await sleep(delay)
          delay = Math.min(delay * 2, 15_000)
        }
      },
      // Deleting the session ends its process group.
      kill: async () => {
        await proc()
          .deleteSession(sid)
          .catch((err: unknown) => {
            if (statusCode(err) !== 404) throw err
          })
      }
    }
  }

  async readFile(p: string): Promise<Buffer | null> {
    return this.live(async (sb) => {
      try {
        return await sb.fs.downloadFile(p)
      } catch (err) {
        if (notFound(err)) return null
        throw err
      }
    })
  }

  async writeFile(p: string, data: Buffer | string, mode?: number): Promise<void> {
    await this.writeFiles([{ path: p, data, mode }])
  }

  // Folders first (an upload may not make them), one upload, then the modes in one command.
  async writeFiles(files: SandboxFile[]): Promise<void> {
    if (!files.length) return
    await this.live(async (sb) => {
      const dirs = [...new Set(files.map((f) => path.posix.dirname(f.path)))]
      await this.run(sb, `mkdir -p -- ${dirs.map(sh).join(' ')}`)
      await sb.fs.uploadFiles(files.map((f) => ({ source: typeof f.data === 'string' ? Buffer.from(f.data) : f.data, destination: f.path })))
      const modes = files.filter((f) => f.mode !== undefined)
      if (modes.length) await this.run(sb, modes.map((f) => `chmod ${(f.mode! & 0o7777).toString(8)} -- ${sh(f.path)}`).join(' && '))
    })
  }

  async mkdir(p: string): Promise<void> {
    await this.live((sb) => this.run(sb, `mkdir -p -- ${sh(p)}`)).catch((err: unknown) => {
      if (err instanceof SandboxNotRunningError) throw err
      throw new Error(`Couldn’t make ${p}: ${message(err)}`)
    })
  }

  async exists(p: string): Promise<boolean> {
    return this.live(async (sb) => (await sb.process.executeCommand(`test -e ${sh(p)}`)).exitCode === 0)
  }

  async openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
    return this.live((sb) => connectDaytonaPty(sb.process, start, listener))
  }

  /**
   * Stop it; its files stay (an archive later keeps them too). Daytona gives no receipt: the length is from the last
   * state change (the start, as far as Foreman's own calls go) to now. A Foreman base is snapshotted as it stops, so
   * workspaces start from it without waiting and an archived base still has its snapshot.
   */
  async stop(): Promise<StopReceipt> {
    const sb = await this.refresh()
    const state = sb.state ?? 'unknown'
    if (STOPPED_STATES.has(state)) return {}
    if (state === 'stopping') {
      await sb.waitUntilStopped(STOP_TIMEOUT_S)
      return {}
    }
    const since = state === 'started' && sb.updatedAt ? Date.parse(sb.updatedAt) : NaN
    await sb.stop(STOP_TIMEOUT_S)
    const receipt: StopReceipt = Number.isFinite(since) ? { durationMs: Math.max(0, Date.now() - since), vcpus: sb.cpu } : {}
    if (sb.labels?.role === 'base') {
      try {
        receipt.snapshotId = await this.provider.baseSnapshot(sb)
      } catch (err) {
        console.warn(`[daytona] couldn’t snapshot the base ${this.name} yet (the first workspace will): ${message(err)}`)
      }
    }
    return receipt
  }

  // No session cap (the manager never calls this): marks activity, refusing a stopped sandbox.
  async extendTimeout(_ms: number): Promise<void> {
    await this.live((sb) => sb.refreshActivity())
  }

  async delete(opts: { snapshots?: boolean } = {}): Promise<void> {
    try {
      await this.sb.delete(STOP_TIMEOUT_S, true)
    } catch (err) {
      if (statusCode(err) !== 404) throw err
    }
    if (opts.snapshots) await this.provider.deleteSnapshotsOf(this.sb)
  }
}

/** A session command's exit code: a number when it ended, null when its session is gone (killed), undefined still running. */
async function exitCodeOf(sb: Sandbox, sid: string, id: string, waitMs: number): Promise<number | null | undefined> {
  const started = Date.now()
  for (;;) {
    try {
      const cmd = await sb.process.getSessionCommand(sid, id)
      if (typeof cmd.exitCode === 'number') return cmd.exitCode
    } catch (err) {
      if (statusCode(err) === 404) return null
      throw err
    }
    if (Date.now() - started >= waitMs) return undefined
    await sleep(200)
  }
}

/** The provider for one Daytona key. Must not touch the network: the manager makes providers to read capabilities(). */
export function createDaytonaProvider(creds: DaytonaCredentials, info: DaytonaConnectionInfo | undefined): SandboxProvider {
  return new DaytonaProvider(creds, info)
}

interface DaytonaApiKey {
  name?: string
  userId?: string
  organizationId?: string
}

interface DaytonaRegionUsage {
  regionId?: string
  totalCpuQuota?: number
  maxCpuPerSandbox?: number | null
}

/**
 * Checks a key before it is saved. Identity: the organization the key belongs to (orgId: its id). Throw with
 * `auth: true` when Daytona refused the key; an unreachable API is a plain error.
 */
export async function verifyDaytona(apiKey: string, info: { apiUrl?: string; target?: string }, doFetch: typeof fetch = fetch): Promise<{ identity: ConnectionIdentity; daytona: DaytonaConnectionInfo }> {
  const apiUrl = (info.apiUrl?.trim() || DAYTONA_API_URL).replace(/\/+$/, '')
  const target = info.target?.trim() || undefined
  const get = async (p: string): Promise<Response> => {
    try {
      return await doFetch(`${apiUrl}${p}`, { redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'Foreman' }, signal: AbortSignal.timeout(15_000) })
    } catch (err) {
      throw new Error(`Couldn’t reach Daytona at ${apiUrl}: ${message(err)}`)
    }
  }
  // Listing sandboxes is what Foreman needs the key for: a refusal here is the key's.
  const listed = await get('/sandbox?limit=1')
  if (listed.status === 401 || listed.status === 403) throw Object.assign(new Error('Daytona refused this API key. It may have expired, been revoked, or lack sandbox access.'), { auth: true })
  if (!listed.ok) throw new Error(`Daytona answered ${listed.status} at ${apiUrl}`)
  // Who it is, the organization and its quota: best effort (a self-hosted or older Daytona may not have them).
  const json = async <T>(p: string): Promise<T | null> => {
    try {
      const res = await get(p)
      return res.ok ? ((await res.json()) as T) : null
    } catch {
      return null
    }
  }
  const key = await json<DaytonaApiKey>('/api-keys/current')
  const orgId = key?.organizationId
  const org = orgId ? await json<{ name?: string; maxCpuPerSandbox?: number }>(`/organizations/${encodeURIComponent(orgId)}`) : null
  const usage = orgId ? await json<{ regionUsage?: DaytonaRegionUsage[] }>(`/organizations/${encodeURIComponent(orgId)}/usage`) : null
  const defaults = CLOUD_PROVIDERS.daytona.limits
  const region = usage?.regionUsage?.find((r) => r.regionId === target) ?? usage?.regionUsage?.[0]
  const perSandbox = region?.maxCpuPerSandbox ?? org?.maxCpuPerSandbox
  const limits: PlanLimits = {
    maxSessionMs: defaults.maxSessionMs,
    maxVcpus: perSandbox && perSandbox > 0 ? Math.min(perSandbox, Math.max(...CLOUD_PROVIDERS.daytona.capabilities.vcpuOptions)) : defaults.maxVcpus,
    // The compute pool counted in default-size workspaces.
    maxConcurrent: region?.totalCpuQuota && region.totalCpuQuota > 0 ? Math.max(1, Math.floor(region.totalCpuQuota / CLOUD_PROVIDERS.daytona.defaultVcpus)) : defaults.maxConcurrent
  }
  const identity: ConnectionIdentity = {
    user: key?.name ?? 'Daytona API key',
    ...(key?.userId ? { userId: key.userId } : {}),
    ...(org?.name ? { org: org.name } : {}),
    ...(orgId ? { orgId } : {}),
    url: apiUrl,
    checkedAt: new Date().toISOString()
  }
  return { identity, daytona: { apiUrl, ...(target ? { target } : {}), limits } }
}
