// An in-process SandboxProvider for tests. Each sandbox is a real
// temporary folder standing in for the VM's filesystem (/vercel/... maps into it), and commands run
// here with child_process, so git works for real. It keeps the semantics the design depends on:
// stop keeps the files and resumes on a command that asks to wake it, sessions time out, fork copies, and the
// plan's limits are whatever a test sets. Every call is recorded. Commands other than git, bash and
// node need a stub (gh is stubbed to succeed), so nothing reaches the user's own accounts or config.
// Its id and capabilities are a test's to set too (Vercel's by default), so it can stand in for a provider
// without a base, a fork or a session cap.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CLOUD_PROVIDERS, planLimits, type CloudProviderId, type PlanLimits, type ProviderCapabilities, type ProviderStatus } from '../../shared/cloud'
import { findOnPath, isWindows, killProcessTree, treeSpawnOptions } from '../platform'
import type { RuntimeExecResult } from '../runtime/types'
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

export interface FakeCall {
  op: string
  sandbox?: string
  cmd?: string
  args?: string[]
  env?: Record<string, string>
  detail?: unknown
}

export type FakeStub = (args: string[], ctx: { sandbox: FakeSandbox; cwd: string; env: Record<string, string> }) => RuntimeExecResult | Promise<RuntimeExecResult>

const REAL = new Set(['git', 'bash', 'node'])

let bashPath: string | null | undefined
/** Git for Windows' bash (never WSL's), or bash on the PATH elsewhere. */
function bash(): string {
  if (bashPath === undefined) {
    if (!isWindows) bashPath = 'bash'
    else {
      const git = findOnPath('git')
      const root = git ? path.dirname(path.dirname(git)) : ''
      bashPath = [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')].find((p) => root && existsSync(p)) ?? findOnPath('bash')
    }
  }
  if (!bashPath) throw new Error('The fake sandbox needs bash (Git for Windows on Windows)')
  return bashPath
}

export class FakeProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly calls: FakeCall[] = []
  readonly stubs = new Map<string, FakeStub>([['gh', () => ({ stdout: '', stderr: '', code: 0 })]])
  planLimits: PlanLimits
  id: CloudProviderId
  caps: ProviderCapabilities
  now: () => number
  // Active CPU each stop reports.
  cpuMsPerStop = 1000
  // A PTY script (bash -c) prints its text and exits at once; off, it keeps running until killed or stopped.
  ptyScriptsExit = true
  private failures = new Map<string, Error>()

  constructor(
    readonly root: string,
    opts: { limits?: PlanLimits; clock?: () => number; id?: CloudProviderId; capabilities?: Partial<ProviderCapabilities> } = {}
  ) {
    this.planLimits = opts.limits ?? planLimits('hobby')
    this.now = opts.clock ?? Date.now
    this.id = opts.id ?? 'vercel'
    this.caps = { ...CLOUD_PROVIDERS.vercel.capabilities, ...opts.capabilities }
  }

  capabilities(): ProviderCapabilities {
    return this.caps
  }

  /** The next call of `op` (create, fork, get, list, exec, stop, delete, …) throws `error`. */
  failNext(op: string, error: Error): void {
    this.failures.set(op, error)
  }

  /** Throws when a failure was set up for `op`, after recording the call. */
  check(op: string, call: Omit<FakeCall, 'op'> = {}): void {
    this.calls.push({ op, ...call })
    const err = this.failures.get(op)
    if (err) {
      this.failures.delete(op)
      throw err
    }
  }

  callsOf(op: string): FakeCall[] {
    return this.calls.filter((c) => c.op === op)
  }

  limits(): PlanLimits {
    return this.planLimits
  }

  async create(o: CreateSandboxOptions): Promise<SandboxHandle> {
    this.check('create', { sandbox: o.name, detail: o })
    if (this.sandboxes.has(o.name)) throw new Error(`A sandbox named ${o.name} already exists`)
    const sb = new FakeSandbox(this, o.name, path.join(this.root, o.name), o.timeoutMs, o.tags, o.vcpus)
    await mkdir(sb.real('/vercel/sandbox'), { recursive: true })
    if (o.source) {
      const args = ['clone', '-q', ...(o.source.revision ? ['--branch', o.source.revision] : []), o.source.url, sb.real('/vercel/sandbox')]
      const r = await run('git', args, { cwd: this.root, env: sb.baseEnv() })
      if (r.code !== 0) throw new Error(`Clone failed: ${r.stderr.trim()}`)
    }
    this.sandboxes.set(o.name, sb)
    return sb
  }

  async fork(sourceName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    this.check('fork', { sandbox: o.name, detail: { source: sourceName, ...o } })
    if (!this.caps.fork) throw new Error('This provider can’t fork a sandbox')
    return this.copy(sourceName, o)
  }

  // With a base: a copy of the base's files, as a fork or an image made from it would start.
  async createFromBase(baseName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    // As Vercel's: with fork, a workspace starts as a fork of its base (recorded as one).
    if (this.caps.fork) return this.fork(baseName, o)
    this.check('createFromBase', { sandbox: o.name, detail: { base: baseName, ...o } })
    if (!this.caps.base) throw new Error('This provider has no bases')
    return this.copy(baseName, o)
  }

  private async copy(sourceName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    const source = this.sandboxes.get(sourceName)
    if (!source) throw new Error(`No sandbox named ${sourceName}`)
    if (this.sandboxes.has(o.name)) throw new Error(`A sandbox named ${o.name} already exists`)
    const sb = new FakeSandbox(this, o.name, path.join(this.root, o.name), o.timeoutMs, o.tags, o.vcpus ?? source.vcpus)
    await cp(source.dir, sb.dir, { recursive: true })
    this.sandboxes.set(o.name, sb)
    return sb
  }

  async get(name: string): Promise<SandboxHandle | null> {
    this.check('get', { sandbox: name })
    return this.sandboxes.get(name) ?? null
  }

  async list(tag: Record<string, string>): Promise<SandboxInfo[]> {
    this.check('list', { detail: tag })
    const [key, value] = Object.entries(tag)[0] ?? []
    return [...this.sandboxes.values()]
      .filter((s) => key === undefined || s.tags[key] === value)
      .map((s) => {
        s.syncTimeout()
        return { name: s.name, status: s.state, tags: { ...s.tags }, ...(s.state === 'running' && this.caps.sessionCap ? { expiresAt: new Date(s.expires) } : {}) }
      })
  }
}

export class FakeSandbox implements SandboxHandle {
  state: ProviderStatus = 'running'
  started: number
  expires: number
  // How many times a stopped sandbox came back, stopped, and timed out by itself.
  resumes = 0
  stops = 0
  timeouts = 0
  snapshotId?: string
  private commands = new Map<string, FakeCommand>()
  private ptys: FakePty[] = []
  private posixDir: string

  constructor(
    private provider: FakeProvider,
    readonly name: string,
    readonly dir: string,
    readonly timeoutMs: number,
    readonly tags: Record<string, string>,
    readonly vcpus: number
  ) {
    this.started = provider.now()
    this.expires = this.started + timeoutMs
    this.posixDir = dir.replace(/\\/g, '/')
  }

  /** The folder here for a path in the sandbox. */
  real(p: string): string {
    return path.join(this.dir, ...path.posix.resolve('/vercel/sandbox', p).split('/').filter(Boolean))
  }

  /** Sandbox paths inside a string (an argument, a script, a variable) made real. */
  private mapText(text: string): string {
    return text.replace(/(^|[\s'"=:(])(\/(?:vercel|tmp))(?=[/\s'"]|$)/g, (_m, lead: string, p: string) => `${lead}${this.posixDir}${p}`)
  }

  /** Real paths in output turned back into sandbox paths. */
  private unmap(text: string): string {
    return text.split(this.posixDir).join('').split(this.dir).join('')
  }

  /** A sandbox's own environment: enough of this computer's to run programs, none of its variables or tokens. */
  baseEnv(): Record<string, string> {
    const keep = /^(path|pathext|systemroot|systemdrive|windir|comspec|temp|tmp|tmpdir|lang|lc_\w+|programfiles.*|programdata|appdata|localappdata|userprofile|username|os|number_of_processors|processor_\w+)$/i
    return {
      ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => keep.test(e[0]) && e[1] !== undefined))),
      HOME: this.real('/vercel'),
      GIT_CONFIG_GLOBAL: this.real('/vercel/.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  }

  /** A running session past its timeout stops by itself, keeping its files. */
  syncTimeout(): void {
    // Without a session cap a session only ends when it is stopped.
    if (!this.provider.caps.sessionCap) return
    if (this.state === 'running' && this.provider.now() >= this.expires) {
      this.state = 'stopped'
      this.timeouts++
      for (const p of this.openPtys()) p.drop()
      this.snapshotId = `snap_${this.name}_${this.timeouts + this.stops}`
      this.provider.calls.push({ op: 'timeout', sandbox: this.name })
    }
  }

  private gone(): void {
    if (!this.provider.sandboxes.has(this.name)) throw new Error(`The sandbox ${this.name} no longer exists`)
  }

  /** A stopped sandbox comes back, with a fresh session, only when the call asks to wake it (as VercelHandle). */
  private async ensureRunning(wake = false): Promise<void> {
    this.gone()
    this.syncTimeout()
    if (this.state === 'running') return
    if (!wake) throw new SandboxNotRunningError(this.name)
    this.state = 'running'
    this.resumes++
    this.started = this.provider.now()
    this.expires = this.started + this.timeoutMs
    this.provider.calls.push({ op: 'resume', sandbox: this.name })
  }

  async status(): Promise<ProviderStatus> {
    this.provider.check('status', { sandbox: this.name })
    this.gone()
    this.syncTimeout()
    return this.state
  }

  async session(): Promise<SandboxSession> {
    this.provider.check('session', { sandbox: this.name })
    this.gone()
    this.syncTimeout()
    if (this.state !== 'running') return { status: this.state }
    return this.provider.caps.sessionCap ? { status: this.state, expiresAt: new Date(this.expires), startedAt: new Date(this.started) } : { status: this.state, startedAt: new Date(this.started) }
  }

  private launch(cmd: string, args: string[], cwd: string, env: Record<string, string> | undefined): { file: string; args: string[]; cwd: string; env: Record<string, string> } {
    const mappedEnv = { ...this.baseEnv(), ...Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, this.mapText(v)])) }
    const mappedArgs = args.map((a) => this.mapText(a))
    if (cmd === 'bash') {
      // A login shell would read the host's profile (and may cd away); the sandbox has none.
      return { file: bash(), args: ['--noprofile', '--norc', ...mappedArgs.map((a) => (a === '-lc' ? '-c' : a))], cwd: this.real(cwd), env: mappedEnv }
    }
    return { file: cmd === 'node' ? process.execPath : cmd, args: mappedArgs, cwd: this.real(cwd), env: mappedEnv }
  }

  async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}): Promise<RuntimeExecResult> {
    const env = Object.fromEntries(Object.entries(opts.env ?? {}).filter((e): e is [string, string] => e[1] !== undefined))
    const cwd = opts.cwd ?? '/vercel/sandbox'
    this.provider.check('exec', { sandbox: this.name, cmd, args, env, detail: { cwd, sudo: opts.sudo } })
    await this.ensureRunning(opts.wake)
    const stub = this.provider.stubs.get(cmd)
    if (stub) return stub(args, { sandbox: this, cwd, env })
    if (cmd === 'true') return { stdout: '', stderr: '', code: 0 }
    if (!REAL.has(cmd)) return { stdout: '', stderr: `${cmd}: command not found\n`, code: 127 }
    if (!existsSync(this.real(cwd))) return { stdout: '', stderr: `cd: ${cwd}: No such file or directory\n`, code: 1 }
    const l = this.launch(cmd, args, cwd, env)
    const r = await run(l.file, l.args, { cwd: l.cwd, env: l.env, timeoutMs: opts.timeoutMs, signal: opts.signal, onOutput: opts.onOutput ? (d) => opts.onOutput!(this.unmap(d)) : undefined })
    return { stdout: this.unmap(r.stdout), stderr: this.unmap(r.stderr), code: r.code }
  }

  async spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote> {
    const cwd = opts.cwd ?? '/vercel/sandbox'
    this.provider.check('spawn', { sandbox: this.name, cmd, args, env: opts.env, detail: { cwd } })
    await this.ensureRunning()
    if (!REAL.has(cmd)) throw new Error(`${cmd}: command not found`)
    const l = this.launch(cmd, args, cwd, opts.env)
    const child = spawn(l.file, l.args, { cwd: l.cwd, env: l.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const command = new FakeCommand(`cmd_${this.commands.size + 1}`, child, (d) => this.unmap(d))
    this.commands.set(command.cmdId, command)
    return command
  }

  async attachCommand(cmdId: string): Promise<SpawnedRemote> {
    this.provider.check('attach', { sandbox: this.name, detail: cmdId })
    const command = this.commands.get(cmdId)
    if (!command) throw new Error(`No command ${cmdId}`)
    return command
  }

  async readFile(p: string): Promise<Buffer | null> {
    this.provider.check('readFile', { sandbox: this.name, detail: p })
    await this.ensureRunning()
    return readFile(this.real(p)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
  }

  async writeFile(p: string, data: Buffer | string, mode?: number): Promise<void> {
    this.provider.check('writeFile', { sandbox: this.name, detail: p })
    await this.ensureRunning()
    await mkdir(path.dirname(this.real(p)), { recursive: true })
    await writeFile(this.real(p), data)
    if (mode !== undefined) await chmod(this.real(p), mode)
  }

  async writeFiles(files: SandboxFile[]): Promise<void> {
    this.provider.check('writeFiles', { sandbox: this.name, detail: files.map((f) => f.path) })
    await this.ensureRunning()
    for (const f of files) {
      await mkdir(path.dirname(this.real(f.path)), { recursive: true })
      await writeFile(this.real(f.path), f.data)
      if (f.mode !== undefined) await chmod(this.real(f.path), f.mode)
    }
  }

  async mkdir(p: string): Promise<void> {
    this.provider.check('mkdir', { sandbox: this.name, detail: p })
    await this.ensureRunning()
    await mkdir(this.real(p), { recursive: true })
  }

  async exists(p: string): Promise<boolean> {
    this.provider.check('exists', { sandbox: this.name, detail: p })
    await this.ensureRunning()
    return existsSync(this.real(p))
  }

  async openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
    this.provider.check('openPty', { sandbox: this.name, cmd: start.command, args: start.args, env: start.env, detail: { cwd: start.cwd, cols: start.cols, rows: start.rows } })
    await this.ensureRunning()
    const pty = new FakePty(start, listener, this.provider.ptyScriptsExit)
    this.ptys.push(pty)
    pty.begin()
    return pty
  }

  /** The PTYs still open. */
  openPtys(): FakePty[] {
    return this.ptys.filter((p) => !p.closed)
  }

  async stop(): Promise<StopReceipt> {
    this.provider.check('stop', { sandbox: this.name })
    this.gone()
    this.syncTimeout()
    if (this.state !== 'running') return {}
    for (const c of this.commands.values()) c.kill()
    // A stop ends every process; PTY connections drop without an exit code.
    for (const p of this.openPtys()) p.drop()
    this.state = 'stopped'
    this.stops++
    this.snapshotId = `snap_${this.name}_${this.timeouts + this.stops}`
    return { snapshotId: this.snapshotId, activeCpuMs: this.provider.cpuMsPerStop, durationMs: this.provider.now() - this.started, vcpus: this.vcpus }
  }

  async extendTimeout(ms: number): Promise<void> {
    this.provider.check('extendTimeout', { sandbox: this.name, detail: ms })
    if (!this.provider.caps.sessionCap) throw new Error('This provider has no session timeout to extend')
    this.gone()
    this.syncTimeout()
    if (this.state !== 'running') throw new Error(`The sandbox ${this.name} isn’t running`)
    this.expires += ms
  }


  async delete(opts: { snapshots?: boolean } = {}): Promise<void> {
    this.provider.check('delete', { sandbox: this.name, detail: { snapshots: Boolean(opts.snapshots) } })
    for (const c of this.commands.values()) c.kill()
    for (const p of this.openPtys()) p.drop()
    this.provider.sandboxes.delete(this.name)
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

/**
 * An in-process PTY: a shell prints a prompt and echoes what is typed (Enter on `exit` ends it with 0, on
 * `exit N` with N); a `-c` script prints its text and, with `scriptsExit`, exits 0. Resize is recorded. No
 * WebSocket is involved.
 */
export class FakePty implements PtyTransport {
  closed = false
  cols: number
  rows: number
  // Everything written to it, and every size it was given.
  input = ''
  resizes: { cols: number; rows: number }[] = []
  private line = ''

  constructor(
    readonly start: PtyStart,
    private listener: PtyListener,
    private scriptsExit = true
  ) {
    this.cols = start.cols
    this.rows = start.rows
  }

  /** Output after open returns, as a real connection's would arrive. */
  begin(): void {
    const at = this.start.args.findIndex((a) => a === '-c' || a === '-lc')
    queueMicrotask(() => {
      if (this.closed) return
      if (at < 0) return this.emit('$ ')
      this.emit(`${this.start.args[at + 1] ?? ''}\r\n`)
      if (this.scriptsExit) this.exit(0)
    })
  }

  /** Output from the "process". */
  emit(data: string): void {
    if (!this.closed) this.listener.data(data)
  }

  /** The process ends with `code`. */
  exit(code: number): void {
    if (this.closed) return
    this.closed = true
    this.listener.exit(code)
  }

  /** The connection drops without an exit (the sandbox stopped). */
  drop(): void {
    if (this.closed) return
    this.closed = true
    this.listener.exit(null)
  }

  write(data: string): void {
    if (this.closed) return
    this.input += data
    this.emit(data.replace(/\r/g, '\r\n'))
    for (const ch of data) {
      if (ch !== '\r') {
        this.line += ch
        continue
      }
      const exit = this.line.trim().match(/^exit(?:\s+(\d+))?$/)
      this.line = ''
      if (exit) return this.exit(Number(exit[1] ?? 0))
      this.emit('$ ')
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push({ cols, rows })
  }

  close(): void {
    this.closed = true
  }
}

/** A spawned command; its logs replay from the start for every reader, as a re-attach does. */
class FakeCommand implements SpawnedRemote {
  private lines: RemoteLogLine[] = []
  private waiters: (() => void)[] = []
  private done = false
  private ended: Promise<{ code: number }>

  constructor(
    readonly cmdId: string,
    private child: ChildProcess,
    unmap: (text: string) => string
  ) {
    const push = (stream: RemoteLogLine['stream']) => (d: string) => {
      this.lines.push({ stream, data: unmap(d) })
      this.wake()
    }
    child.stdout?.setEncoding('utf8').on('data', push('stdout'))
    child.stderr?.setEncoding('utf8').on('data', push('stderr'))
    // 'close' comes after the output streams have ended, so every chunk is in by then.
    this.ended = new Promise((resolve) => {
      child.once('error', () => resolve({ code: 127 }))
      child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 137 : 1) }))
    })
    void this.ended.then(() => {
      this.done = true
      this.wake()
    })
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async write(data: string | Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => this.child.stdin?.write(data, (err) => (err ? reject(err) : resolve())))
  }

  async closeStdin(): Promise<void> {
    this.child.stdin?.end()
  }

  async *logs(): AsyncIterable<RemoteLogLine> {
    let i = 0
    for (;;) {
      if (i < this.lines.length) {
        yield this.lines[i++]
        continue
      }
      if (this.done) return
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  wait(): Promise<{ code: number }> {
    return this.ended
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill()
  }
}

/** Run a command here, collecting output. Never throws; a command that can't start is 127. */
function run(file: string, args: string[], o: { cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }): Promise<RuntimeExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: o.timeoutMs, ...treeSpawnOptions })
    // Aborting stops the whole tree, as stopping a sandbox command does (a script's children too).
    const stop = () => void (child.pid ? killProcessTree(child.pid) : undefined)
    if (o.signal?.aborted) stop()
    o.signal?.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
      o.onOutput?.(d)
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
      o.onOutput?.(d)
    })
    child.once('error', (err) => resolve({ stdout, stderr: stderr + err.message, code: 127 }))
    child.once('close', (code, signal) => {
      o.signal?.removeEventListener('abort', stop)
      resolve({ stdout, stderr, code: code ?? (signal ? 137 : 1) })
    })
  })
}
