// SandboxProvider on Docker: a container per workspace on Docker
// Desktop here or on a daemon on the LAN, through the docker CLI with `--context` (or DOCKER_HOST in that one
// child's environment, never Foreman's). The image is resources/sandbox/Dockerfile (Vercel's universal image,
// the same layout), built on each daemon on first use. A base is a stopped container; workspaces start from an
// image committed from it. Commands run as the image's user `ubuntu`; `sudo` runs them as root.
// Spawned commands (the agent host, its attach bridge) run detached inside the container through a wrapper
// that keeps their output in /tmp/foreman-cmd/<id>.{out,err,code,pid}: they outlive the `docker exec` client
// (and the app), a kill reaches them in the container, and attachCommand replays them from those files
// once this process no longer holds the client.
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import dockerfileText from '../../../resources/sandbox/Dockerfile?raw'
import { CLOUD_PROVIDERS, GB_PER_VCPU, type PlanLimits, type ProviderCapabilities, type ProviderStatus } from '../../shared/cloud'
import type { ConnectionIdentity, DockerConnectionInfo } from '../../shared/integrations'
import { findOnPath, isWindows } from '../platform'
import type { RuntimeExecResult } from '../runtime/types'
import { openDockerPty, type DockerPtyProcess } from './dockerPty'
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

/** Which Docker daemon: a context name, or a DOCKER_HOST string. Neither: the CLI's current context. */
export interface DockerTarget {
  context?: string
  host?: string
}

// ---- the docker CLI ----

/** One `docker` call. `env` is added to the CLI's own environment (undefined removes a variable). */
export interface DockerCallOptions {
  env?: Record<string, string | undefined>
  input?: Buffer | string
  onOutput?: (chunk: string) => void
  // Kills the docker client (not what it started in a container: see killGroup).
  signal?: AbortSignal
}

export interface DockerOutput {
  code: number
  stdout: Buffer
  stderr: string
}

/** A long-lived docker client: its stdio and how it ended. */
export interface DockerChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exited: Promise<number>
  kill(): void
}

/** How the provider reaches the docker binary; tests stand in for it. Every `args` already points at the daemon. */
export interface DockerCli {
  // Runs to the end. A non-zero exit is a result; a docker that can't start rejects (DockerMissingError).
  run(args: string[], o?: DockerCallOptions): Promise<DockerOutput>
  start(args: string[], o?: { env?: Record<string, string | undefined> }): DockerChild
  pty(args: string[], o: { env?: Record<string, string | undefined>; cols: number; rows: number }): Promise<DockerPtyProcess>
}

export class DockerMissingError extends Error {
  constructor() {
    super('Docker isn’t installed on this computer (there is no docker command). Install Docker Desktop, or put the docker CLI on the PATH.')
  }
}

// Docker Desktop's CLI when the app's PATH doesn't have it (a GUI app on macOS, a fresh install on Windows).
function fallbackBinaries(): string[] {
  if (isWindows) return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
  return ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', path.join(os.homedir(), '.docker', 'bin', 'docker'), '/usr/bin/docker']
}

let binaryPath: string | null = null

/** The docker CLI's full path (node-pty on Windows needs one), or null when it isn't installed. */
export function dockerBinary(): string | null {
  if (binaryPath && existsSync(binaryPath)) return binaryPath
  binaryPath = findOnPath('docker') ?? fallbackBinaries().find((p) => existsSync(p)) ?? null
  return binaryPath
}

/** The CLI's environment: Foreman's, with `extra` over it. Windows names are case-insensitive, so a Path goes before a PATH. */
export function dockerEnv(extra: Record<string, string | undefined> = {}, base: NodeJS.ProcessEnv = process.env, windows = isWindows): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  for (const [k, v] of Object.entries(extra)) {
    if (windows) {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === k.toLowerCase()) delete env[existing]
    } else delete env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

function needBinary(): string {
  const bin = dockerBinary()
  if (!bin) throw new DockerMissingError()
  return bin
}

/** The real docker CLI. */
export const dockerCli: DockerCli = {
  run(args, o = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(needBinary(), args, { env: dockerEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      let err = ''
      const outText = new StringDecoder('utf8')
      const errText = new StringDecoder('utf8')
      const emit = (s: string) => s && o.onOutput?.(s)
      child.stdout.on('data', (b: Buffer) => {
        out.push(b)
        if (o.onOutput) emit(outText.write(b))
      })
      child.stderr.on('data', (b: Buffer) => {
        const s = errText.write(b)
        err += s
        emit(s)
      })
      const abort = () => child.kill()
      if (o.signal?.aborted) abort()
      o.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', (e: NodeJS.ErrnoException) => {
        o.signal?.removeEventListener('abort', abort)
        reject(e.code === 'ENOENT' ? new DockerMissingError() : e)
      })
      child.once('close', (code, signal) => {
        o.signal?.removeEventListener('abort', abort)
        err += errText.end()
        resolve({ code: code ?? (signal ? 137 : 1), stdout: Buffer.concat(out), stderr: err })
      })
      // A command that doesn't read its input closes the pipe first.
      child.stdin.on('error', () => undefined)
      child.stdin.end(o.input)
    })
  },
  start(args, o = {}) {
    const child = spawnChild(needBinary(), args, { env: dockerEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdin.on('error', () => undefined)
    const exited = new Promise<number>((resolve) => {
      child.once('error', () => resolve(127))
      // 'close' comes after the output streams end, so every chunk is in by then.
      child.once('close', (code, signal) => resolve(code ?? (signal ? 137 : 1)))
    })
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, kill: () => void child.kill() }
  },
  async pty(args, o) {
    const nodePty = (await import('node-pty')).default
    return nodePty.spawn(needBinary(), args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: os.homedir(), env: dockerEnv(o.env) })
  }
}

// ---- the image ----

// Normalized, so a checkout with CRLF line endings hashes (and builds) the same.
export const SANDBOX_DOCKERFILE = dockerfileText.replace(/\r\n/g, '\n')

/** The image tag for a Dockerfile: changing the file makes a new tag, so the next create rebuilds. */
export function sandboxImageTag(text: string = SANDBOX_DOCKERFILE): string {
  return `foreman-sandbox:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

// One build per daemon at a time, shared by every provider for it.
const imageBuilds = new Map<string, Promise<string>>()

/** Forget the builds this process remembers (tests). */
export function resetDockerImageCache(): void {
  imageBuilds.clear()
}

// ---- labels, names, states ----

const NAME_LABEL = 'foreman.name'
// Tags are labels under their own prefix, so a tag can't collide with Foreman's own labels.
const TAG_LABEL = 'foreman.tag.'
const VCPUS_LABEL = 'foreman.vcpus'
const SNAPSHOT_OF_LABEL = 'foreman.snapshotOf'
const FINISHED_LABEL = 'foreman.finishedAt'
// Where spawned commands keep their pid, output and exit code.
const CMD_DIR = '/tmp/foreman-cmd'
// A `running` answer is trusted this long before the next call checks again.
const RUNNING_CACHE_MS = 1500

/** The labels for a sandbox's name and tags. */
export function labelArgs(name: string, tags: Record<string, string>): string[] {
  return [`${NAME_LABEL}=${name}`, ...Object.entries(tags).map(([k, v]) => `${TAG_LABEL}${k}=${v}`)].flatMap((l) => ['--label', l])
}

/** A container's tags from its labels. Blank ones were cleared when a base was committed (see commitBase). */
export function tagsOf(labels: Record<string, string> | null | undefined): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const [k, v] of Object.entries(labels ?? {})) if (k.startsWith(TAG_LABEL) && v) tags[k.slice(TAG_LABEL.length)] = v
  return tags
}

/** An image reference for a base's committed snapshot. */
export function snapshotRef(baseName: string): string {
  return `foreman-snapshot/${baseName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}:latest`
}

/** What `docker container inspect` says, the parts used here. */
export interface ContainerInspect {
  Id: string
  Name: string
  // The image's id it was made from.
  Image?: string
  Created?: string
  State: { Status: string; Running: boolean; Paused?: boolean; StartedAt?: string; FinishedAt?: string }
  Config: { Labels?: Record<string, string> | null; Image?: string }
  HostConfig?: { NanoCpus?: number }
}

/** A container's state as a provider status. */
export function statusOf(state: ContainerInspect['State']): ProviderStatus {
  if (state.Status === 'paused' || state.Paused) return 'stopped'
  if (state.Running || state.Status === 'running') return 'running'
  if (state.Status === 'created' || state.Status === 'restarting') return 'pending'
  if (state.Status === 'removing') return 'stopping'
  if (state.Status === 'dead') return 'failed'
  return 'stopped'
}

const ZERO_TIME = /^0001-01-01/
const dateOf = (s: string | undefined): Date | undefined => (s && !ZERO_TIME.test(s) && !Number.isNaN(Date.parse(s)) ? new Date(s) : undefined)

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? ''

const lastLines = (text: string, n = 12): string => text.trim().split(/\r?\n/).slice(-n).join('\n')

// The daemon refusing a call because the container isn't running (or is paused): the sandbox stopped under us.
const NOT_RUNNING = /Error response from daemon:.*(is not running|is paused|is restarting)/i
const NO_SUCH = /No such (container|object)/i

// Variables the docker CLI itself reads: passed in argv (none of them secret), so the client keeps its own.
const CLIENT_VARS = /^(HOME|PATH|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|SSH_AUTH_SOCK|DOCKER_.*|XDG_.*)$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `docker exec` arguments. Each variable goes as `-e NAME` with its value in the CLI's environment (returned as
 * `env`), so a token never shows in a process list; the few the CLI reads itself go inline instead.
 */
export function execArgs(
  name: string,
  cmd: string,
  args: string[],
  o: { cwd?: string; env?: Record<string, string | undefined>; sudo?: boolean; interactive?: boolean; tty?: boolean } = {}
): { args: string[]; env: Record<string, string> } {
  const flags = ['exec']
  if (o.interactive) flags.push('-i')
  if (o.tty) flags.push('-t')
  if (o.sudo) flags.push('-u', 'root')
  if (o.cwd) flags.push('-w', o.cwd)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined || !ENV_NAME.test(k)) continue
    if (CLIENT_VARS.test(k)) flags.push('-e', `${k}=${v}`)
    else {
      flags.push('-e', k)
      env[k] = v
    }
  }
  return { args: [...flags, name, cmd, ...args], env }
}

// ---- in-container scripts (bash, as `bash -c SCRIPT $0 $1…`) ----

// Records the process's pid (it becomes the command by exec), so a kill can reach its process group. Run with
// `sh -c`: a non-interactive bash would drop PS1 from the environment before exec'ing a terminal's shell.
export const PID_WRAP = 'mkdir -p -m 1777 /tmp/foreman-cmd 2>/dev/null; echo $$ > "$0"; exec "$@"'

/**
 * A spawned command ($0: its file prefix; "$@": the command). It runs in its own session with stdout and stderr
 * going to files, so it never writes to the client's pipe and keeps running when the client (the app) goes. This
 * wrapper streams the files back while it runs and exits with the command's code.
 */
export const SPAWN_WRAP = [
  'f="$0"',
  'mkdir -p -m 1777 /tmp/foreman-cmd 2>/dev/null',
  // Old commands' files go after a day.
  'find /tmp/foreman-cmd -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null',
  ': > "$f.out"; : > "$f.err"; rm -f "$f.code"',
  'exec 3<&0',
  'setsid -w bash -c \'echo $$ > "$0.pid"; "$@" >> "$0.out" 2>> "$0.err"; echo $? > "$0.code"\' "$f" "$@" <&3 3<&- &',
  'p=$!',
  'exec 3<&- 0</dev/null',
  'tail -c +1 -s 0.2 -f --pid="$p" "$f.out" & a=$!',
  'tail -c +1 -s 0.2 -f --pid="$p" "$f.err" >&2 & b=$!',
  'wait "$p"; c=$?',
  'wait "$a" "$b"',
  '[ -s "$f.code" ] || echo "$c" > "$f.code"',
  'exit "$(cat "$f.code")"'
].join('\n')

/** Re-attach to a spawned command from its files ($0: its file prefix): the output from the start, then its code. */
export const ATTACH_WRAP = [
  'f="$0"',
  'p=$(cat "$f.pid" 2>/dev/null)',
  'if [ -n "$p" ] && [ ! -s "$f.code" ] && kill -0 "$p" 2>/dev/null; then',
  '  tail -c +1 -s 0.2 -f --pid="$p" "$f.out" & a=$!',
  '  tail -c +1 -s 0.2 -f --pid="$p" "$f.err" >&2 & b=$!',
  '  wait "$a" "$b"',
  '  for i in $(seq 50); do [ -s "$f.code" ] && break; sleep 0.1; done',
  'else',
  '  cat "$f.out"; cat "$f.err" >&2',
  'fi',
  '[ -s "$f.code" ] && exit "$(cat "$f.code")"',
  // Killed with its wrapper: no code was written.
  'exit 137'
].join('\n')

/** Signal a process group from its pid file ($0: the file, $1: the first signal), then KILL what's left after 5 s. */
export const KILL_GROUP = [
  'for i in $(seq 20); do [ -s "$0" ] && break; sleep 0.1; done',
  'p=$(cat "$0" 2>/dev/null) || exit 0',
  '[ -n "$p" ] || exit 0',
  'kill -"$1" -- "-$p" 2>/dev/null || kill -"$1" "$p" 2>/dev/null || exit 0',
  'for i in $(seq 50); do kill -0 -- "-$p" 2>/dev/null || exit 0; sleep 0.1; done',
  'kill -KILL -- "-$p" 2>/dev/null',
  'exit 0'
].join('\n')

/** Size the tty of the process in the pid file ($0) to $1 rows and $2 columns; the kernel sends it SIGWINCH. */
export const RESIZE_TTY = 'p=$(cat "$0" 2>/dev/null) || exit 0; t=$(readlink "/proc/$p/fd/0") || exit 0; case "$t" in /dev/pts/*) stty -F "$t" rows "$1" cols "$2" ;; esac'

// ---- tar, for writeFiles ----

function octal(h: Buffer, value: number, offset: number, length: number): void {
  h.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function tarHeader(name: string, size: number, mode: number, type: '0' | 'x', mtime: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  octal(h, mode & 0o7777, 100, 8)
  octal(h, 0, 108, 8)
  octal(h, 0, 116, 8)
  octal(h, size, 124, 12)
  octal(h, mtime, 136, 12)
  h.fill(' ', 148, 156)
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

const pad = (size: number): Buffer => Buffer.alloc((512 - (size % 512)) % 512)

/** A pax record ("<len> path=<value>\n"), whose length counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return Buffer.from(`${len}${body}`, 'utf8')
}

/** A tar of the files, paths relative to / (extracted with -C /); a path too long for ustar gets a pax header. */
export function tarFiles(files: SandboxFile[], now = Date.now()): Buffer {
  const mtime = Math.floor(now / 1000)
  const parts: Buffer[] = []
  for (const f of files) {
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data
    const name = path.posix.normalize(f.path).replace(/^\/+/, '')
    if (!name || name === '.' || name.split('/').includes('..')) throw new Error(`Can’t write ${f.path}: not a file path`)
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord('path', name)
      parts.push(tarHeader('PaxHeader', pax.length, 0o644, 'x', mtime), pax, pad(pax.length))
    }
    parts.push(tarHeader(Buffer.byteLength(name) > 100 ? name.slice(0, 99) : name, data.length, f.mode ?? 0o644, '0', mtime), data, pad(data.length))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

// ---- the provider ----

/** The provider for one Docker daemon. Making one doesn't touch the daemon: the manager makes providers to read capabilities(). */
export function createDockerProvider(target: DockerTarget, info: DockerConnectionInfo | undefined): SandboxProvider {
  return new DockerProvider(target, info)
}

const randomId = (): string => randomBytes(8).toString('hex')

export class DockerProvider implements SandboxProvider {
  readonly id = 'docker' as const

  constructor(
    readonly target: DockerTarget,
    private info: DockerConnectionInfo | undefined,
    readonly cli: DockerCli = dockerCli,
    readonly dockerfile: string = SANDBOX_DOCKERFILE,
    // Resize a PTY's tty from inside the container too (the Windows docker CLI doesn't forward ConPTY resizes).
    readonly resizeInContainer: boolean = isWindows
  ) {}

  // A base (a committed image), snapshot on stop (a stopped container keeps its files), no session cap, a PTY
  // through the local docker CLI, no regions.
  capabilities(): ProviderCapabilities {
    return CLOUD_PROVIDERS.docker.capabilities
  }

  limits(): PlanLimits {
    return this.info?.limits ?? CLOUD_PROVIDERS.docker.limits
  }

  /** Which daemon, as a key for things kept per daemon. */
  get daemonKey(): string {
    return this.target.context ? `context:${this.target.context}` : this.target.host ? `host:${this.target.host}` : 'current'
  }

  /** `docker <args>` against this daemon: `--context` first, or DOCKER_HOST in the CLI's environment. */
  args(rest: string[]): string[] {
    return this.target.context ? ['--context', this.target.context, ...rest] : rest
  }

  env(extra: Record<string, string> = {}): Record<string, string | undefined> {
    // A context names the daemon; a DOCKER_HOST or DOCKER_CONTEXT in Foreman's own environment mustn't override it.
    const point = this.target.context ? { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined } : this.target.host ? { DOCKER_HOST: this.target.host, DOCKER_CONTEXT: undefined } : {}
    return { ...point, ...extra }
  }

  docker(args: string[], o: Omit<DockerCallOptions, 'env'> & { env?: Record<string, string> } = {}): Promise<DockerOutput> {
    return this.cli.run(this.args(args), { ...o, env: this.env(o.env) })
  }

  /** A docker call that must succeed; its stdout. */
  async ok(args: string[], what: string, o: Omit<DockerCallOptions, 'env'> = {}): Promise<string> {
    const r = await this.docker(args, o)
    if (r.code !== 0) throw new Error(`${what}: ${firstLine(r.stderr) || `docker exited with code ${r.code}`}`)
    return r.stdout.toString('utf8')
  }

  get imageTag(): string {
    return sandboxImageTag(this.dockerfile)
  }

  /** The sandbox image on this daemon, built from the Dockerfile the first time (minutes; its output goes to onOutput). */
  ensureImage(onOutput?: (chunk: string) => void): Promise<string> {
    const key = `${this.daemonKey}|${this.imageTag}`
    let build = imageBuilds.get(key)
    if (!build) {
      build = this.buildImage(onOutput).catch((err: unknown) => {
        imageBuilds.delete(key)
        throw err
      })
      imageBuilds.set(key, build)
    }
    return build
  }

  private async buildImage(onOutput?: (chunk: string) => void): Promise<string> {
    const tag = this.imageTag
    if ((await this.docker(['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0) return tag
    onOutput?.(`Building Foreman’s sandbox image ${tag} on this Docker daemon (the first time takes a few minutes).\n`)
    // From stdin with no build context, so a remote daemon gets just the Dockerfile.
    const r = await this.docker(['build', '--progress=plain', '-t', tag, '-'], { input: this.dockerfile, onOutput })
    if (r.code !== 0) throw new Error(`Couldn’t build the sandbox image ${tag}:\n${lastLines(r.stderr)}`)
    return tag
  }

  async create(o: CreateSandboxOptions): Promise<SandboxHandle> {
    // SandboxManager clones by itself; a provider may refuse a source.
    if (o.source) throw new Error('Docker sandboxes don’t clone at create: Foreman clones the repository itself.')
    const image = await this.ensureImage(o.onOutput)
    return this.run(o.name, image, o.vcpus, o.tags)
  }

  // A workspace starts from an image committed from the base as its last stop left it.
  async createFromBase(baseName: string, o: ForkSandboxOptions): Promise<SandboxHandle> {
    const image = await this.baseImage(baseName, o.onOutput)
    return this.run(o.name, image, o.vcpus ?? CLOUD_PROVIDERS.docker.defaultVcpus, o.tags)
  }

  private async run(name: string, image: string, vcpus: number, tags: Record<string, string>): Promise<SandboxHandle> {
    const cpus = Math.max(1, Math.min(Math.round(vcpus) || 1, this.limits().maxVcpus))
    const r = await this.docker([
      'run',
      '-d',
      '--name',
      name,
      ...labelArgs(name, tags),
      '--label',
      `${VCPUS_LABEL}=${cpus}`,
      '--cpus',
      String(cpus),
      '--memory',
      `${cpus * GB_PER_VCPU}g`,
      // tini reaps what the agents leave behind, and stops promptly.
      '--init',
      // The computer running Docker, as Docker Desktop names it, on a Linux daemon too.
      '--add-host',
      'host.docker.internal:host-gateway',
      image,
      'sleep',
      'infinity'
    ])
    if (r.code !== 0) throw new Error(`Couldn’t start the container ${name}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
    const handle = new DockerHandle(name, this)
    handle.markRunning()
    return handle
  }

  async inspect(name: string): Promise<ContainerInspect | null> {
    const r = await this.docker(['container', 'inspect', name])
    if (r.code !== 0) {
      if (NO_SUCH.test(r.stderr)) return null
      throw new Error(`Couldn’t check the container ${name}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
    }
    return (JSON.parse(r.stdout.toString('utf8')) as ContainerInspect[])[0] ?? null
  }

  async get(name: string): Promise<SandboxHandle | null> {
    return (await this.inspect(name)) ? new DockerHandle(name, this) : null
  }

  async list(tag: Record<string, string>): Promise<SandboxInfo[]> {
    const [entry] = Object.entries(tag)
    const filter = entry ? `label=${TAG_LABEL}${entry[0]}=${entry[1]}` : `label=${NAME_LABEL}`
    const ids = (await this.ok(['ps', '-a', '-q', '--no-trunc', '--filter', filter], 'Couldn’t list the sandboxes')).split(/\s+/).filter(Boolean)
    if (!ids.length) return []
    // One inspect for all of them: their labels whole (ps joins them with commas). One removed meanwhile is skipped.
    const r = await this.docker(['container', 'inspect', ...ids])
    const found = r.stdout.length ? (JSON.parse(r.stdout.toString('utf8')) as ContainerInspect[]) : []
    return found.map((c) => {
      const labels = c.Config.Labels ?? {}
      const createdAt = dateOf(c.Created)
      return { name: labels[NAME_LABEL] || c.Name.replace(/^\//, ''), status: statusOf(c.State), tags: tagsOf(labels), ...(createdAt ? { createdAt } : {}) }
    })
  }

  /**
   * The base's snapshot image: committed when there is none for its last stop (a base stopped by stop() was
   * committed then). The base's own labels are blanked in the image, so containers made from it don't list as it.
   */
  async baseImage(baseName: string, onOutput?: (chunk: string) => void): Promise<string> {
    const base = await this.inspect(baseName)
    if (!base) throw new Error(`There is no base ${baseName} on this Docker daemon. Build the repository’s base again.`)
    const ref = snapshotRef(baseName)
    const image = await this.imageLabels(ref)
    if (image && !base.State.Running && image.labels[FINISHED_LABEL] === (base.State.FinishedAt ?? '')) return ref
    onOutput?.(`Saving ${baseName} as an image.\n`)
    await this.commit(base, ref, image?.id)
    return ref
  }

  private async imageLabels(ref: string): Promise<{ id: string; labels: Record<string, string> } | null> {
    const r = await this.docker(['image', 'inspect', '--format', '{{json .}}', ref])
    if (r.code !== 0) return null
    const img = JSON.parse(r.stdout.toString('utf8')) as { Id: string; Config?: { Labels?: Record<string, string> | null } }
    return { id: img.Id, labels: img.Config?.Labels ?? {} }
  }

  /** `docker commit` the container to `ref`; the image it replaces goes when nothing uses it. Returns the image id. */
  async commit(c: ContainerInspect, ref: string, previous?: string): Promise<string> {
    const name = c.Name.replace(/^\//, '')
    const blank = Object.keys(c.Config.Labels ?? {})
      .filter((k) => k.startsWith('foreman.') && k !== SNAPSHOT_OF_LABEL && k !== FINISHED_LABEL)
      .map((k) => `${k}=""`)
    const label = ['LABEL', ...blank, `${SNAPSHOT_OF_LABEL}="${name}"`, `${FINISHED_LABEL}="${c.State.FinishedAt ?? ''}"`].join(' ')
    const id = (await this.ok(['commit', '--change', label, name, ref], `Couldn’t save ${name} as an image`)).trim()
    if (previous && previous !== id) await this.docker(['image', 'rm', previous]).catch(() => undefined)
    return id
  }

  /** Signal the process group whose leader's pid is in `pidFile`, as root (a sudo command's too). */
  async killGroup(name: string, pidFile: string, signal: 'TERM' | 'HUP' = 'TERM'): Promise<void> {
    await this.docker(['exec', '-u', 'root', name, 'bash', '-c', KILL_GROUP, pidFile, signal])
  }

  /** Images committed from the sandbox (a base's snapshots), removed where nothing uses them. */
  async removeSnapshots(name: string): Promise<void> {
    const r = await this.docker(['image', 'ls', '-q', '--no-trunc', '--filter', `label=${SNAPSHOT_OF_LABEL}=${name}`])
    const ids = [...new Set(r.stdout.toString('utf8').split(/\s+/).filter(Boolean))]
    for (const id of ids) await this.docker(['image', 'rm', id]).catch(() => undefined)
    // The tag itself, in case the label was lost.
    await this.docker(['image', 'rm', snapshotRef(name)]).catch(() => undefined)
  }
}

// Spawned commands this process holds the client of, by daemon, sandbox and cmdId.
const liveCommands = new Map<string, DockerCommand>()

class DockerHandle implements SandboxHandle {
  private runningAt = 0

  constructor(
    readonly name: string,
    private p: DockerProvider
  ) {}

  markRunning(): void {
    this.runningAt = Date.now()
  }

  private async inspect(): Promise<ContainerInspect> {
    const c = await this.p.inspect(this.name)
    if (!c) {
      this.runningAt = 0
      throw new Error(`The sandbox ${this.name} no longer exists`)
    }
    if (statusOf(c.State) === 'running') this.markRunning()
    else this.runningAt = 0
    return c
  }

  async status(): Promise<ProviderStatus> {
    return statusOf((await this.inspect()).State)
  }

  // No session cap: no expiresAt.
  async session(): Promise<SandboxSession> {
    const c = await this.inspect()
    const status = statusOf(c.State)
    const startedAt = status === 'running' ? dateOf(c.State.StartedAt) : undefined
    return startedAt ? { status, startedAt } : { status }
  }

  /** Refuse unless running; never starts it. A `running` answer is trusted for a moment, then checked again. */
  private async live(): Promise<void> {
    if (Date.now() - this.runningAt < RUNNING_CACHE_MS) return
    if ((await this.status()) !== 'running') throw new SandboxNotRunningError(this.name)
  }

  /** The one way a stopped container starts: an exec that asks to wake it. */
  private async wake(): Promise<void> {
    const c = await this.inspect()
    if (statusOf(c.State) === 'running') return
    if (c.State.Paused) await this.p.ok(['unpause', this.name], `Couldn’t resume ${this.name}`)
    else await this.p.ok(['start', this.name], `Couldn’t start ${this.name}`)
    this.markRunning()
  }

  /** A docker call on the container: one the daemon refused because it stopped meanwhile is the refusal. */
  private async call(args: string[], o: Omit<DockerCallOptions, 'env'> & { env?: Record<string, string> } = {}): Promise<DockerOutput> {
    const r = await this.p.docker(args, o)
    if (r.code !== 0 && NOT_RUNNING.test(r.stderr)) {
      this.runningAt = 0
      throw new SandboxNotRunningError(this.name)
    }
    if (r.code !== 0 && NO_SUCH.test(firstLine(r.stderr))) throw new Error(`The sandbox ${this.name} no longer exists`)
    return r
  }

  async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}): Promise<RuntimeExecResult> {
    if (opts.wake) await this.wake()
    else await this.live()
    // A stoppable command records its pid, so stopping it kills its process group in the container (killing the
    // docker client wouldn't). A `docker exec` process already leads its own session and group.
    const stoppable = Boolean(opts.signal || opts.timeoutMs)
    const pidFile = `${CMD_DIR}/exec-${randomId()}.pid`
    const [file, argv]: [string, string[]] = stoppable ? ['sh', ['-c', PID_WRAP, pidFile, cmd, ...args]] : [cmd, args]
    const call = execArgs(this.name, file, argv, { cwd: opts.cwd, env: opts.env, sudo: opts.sudo })
    const client = new AbortController()
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      // The docker client ends with the process; one that doesn't (a lost daemon) goes after a grace period.
      void this.p
        .killGroup(this.name, pidFile)
        .catch(() => undefined)
        .then(() => setTimeout(() => client.abort(), 10_000).unref?.())
    }
    if (opts.signal?.aborted) stop()
    opts.signal?.addEventListener('abort', stop, { once: true })
    const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : null
    try {
      const r = await this.call(call.args, { env: call.env, onOutput: opts.onOutput, signal: client.signal })
      return { stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code }
    } finally {
      opts.signal?.removeEventListener('abort', stop)
      if (timer) clearTimeout(timer)
    }
  }

  async spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote> {
    await this.live()
    const cmdId = `cmd-${randomId()}`
    const call = execArgs(this.name, 'bash', ['-c', SPAWN_WRAP, `${CMD_DIR}/${cmdId}`, cmd, ...args], { cwd: opts.cwd, env: opts.env, interactive: true })
    const child = this.p.cli.start(this.p.args(call.args), { env: this.p.env(call.env) })
    const key = `${this.p.daemonKey}|${this.name}|${cmdId}`
    const command = new DockerCommand(cmdId, child, true, () => this.p.killGroup(this.name, `${CMD_DIR}/${cmdId}.pid`))
    liveCommands.set(key, command)
    // Once it has ended its files replay it, so the client's copy goes.
    void command.wait().then(() => liveCommands.delete(key))
    return command
  }

  /**
   * The command's output from the start and its exit. While this process holds its client, from memory; otherwise
   * (an app restart, or it has ended) from its files in the container. Re-attached that way its stdin is gone.
   */
  async attachCommand(cmdId: string): Promise<SpawnedRemote> {
    const held = liveCommands.get(`${this.p.daemonKey}|${this.name}|${cmdId}`)
    if (held?.replayable) return held.view()
    await this.live()
    if (!/^cmd-[a-f0-9]+$/.test(cmdId)) throw new Error(`There is no command ${cmdId} in ${this.name}`)
    const prefix = `${CMD_DIR}/${cmdId}`
    if ((await this.call(['exec', this.name, 'test', '-e', `${prefix}.out`])).code !== 0) throw new Error(`There is no command ${cmdId} in ${this.name}`)
    const child = this.p.cli.start(this.p.args(['exec', this.name, 'bash', '-c', ATTACH_WRAP, prefix]), { env: this.p.env() })
    return new DockerCommand(cmdId, child, false, () => this.p.killGroup(this.name, `${prefix}.pid`))
  }

  async readFile(p: string): Promise<Buffer | null> {
    await this.live()
    const r = await this.call(['exec', this.name, 'bash', '-c', 'if [ -f "$0" ]; then exec cat -- "$0"; elif [ -e "$0" ]; then echo "$0 isn’t a file" >&2; exit 2; else exit 44; fi', p])
    if (r.code === 44) return null
    if (r.code !== 0) throw new Error(`Couldn’t read ${p}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
    return r.stdout
  }

  async writeFile(p: string, data: Buffer | string, mode?: number): Promise<void> {
    await this.writeFiles([{ path: p, data, mode }])
  }

  // One tar through `docker exec -i … tar -x`: folders made as needed, owned by the sandbox's user, modes kept.
  async writeFiles(files: SandboxFile[]): Promise<void> {
    await this.live()
    if (!files.length) return
    const r = await this.call(['exec', '-i', this.name, 'tar', '-x', '-p', '--no-same-owner', '-C', '/', '-f', '-'], { input: tarFiles(files) })
    if (r.code !== 0) throw new Error(`Couldn’t write ${files.length === 1 ? files[0].path : `${files.length} files`}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
  }

  async mkdir(p: string): Promise<void> {
    await this.live()
    const r = await this.call(['exec', this.name, 'mkdir', '-p', p])
    if (r.code !== 0) throw new Error(`Couldn’t make ${p}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
  }

  async exists(p: string): Promise<boolean> {
    await this.live()
    return (await this.call(['exec', this.name, 'test', '-e', p])).code === 0
  }

  // node-pty here running `docker exec -it`: the CLI forwards keystrokes, output and resizes.
  async openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport> {
    await this.live()
    const pidFile = `${CMD_DIR}/pty-${randomId()}.pid`
    const call = execArgs(this.name, 'sh', ['-c', PID_WRAP, pidFile, start.command, ...start.args], { cwd: start.cwd, env: start.env, interactive: true, tty: true })
    const proc = await this.p.cli.pty(this.p.args(call.args), { env: this.p.env(call.env), cols: start.cols, rows: start.rows })
    return openDockerPty(proc, listener, {
      // An exit while the container still runs is the process's; otherwise the sandbox stopped under it.
      stillRunning: async () => {
        this.runningAt = 0
        return (await this.status().catch(() => 'failed' as const)) === 'running'
      },
      // Killing the client leaves the shell running in the container: hang it up there.
      killInContainer: () => this.p.killGroup(this.name, pidFile, 'HUP'),
      // The Windows docker CLI never notices ConPTY resizing (stty still says the first size): set it on the tty.
      ...(this.p.resizeInContainer ? { resizeInContainer: (cols: number, rows: number) => this.p.docker(['exec', '-u', 'root', this.name, 'bash', '-c', RESIZE_TTY, pidFile, String(rows), String(cols)]).then(() => undefined) } : {})
    })
  }

  async stop(): Promise<StopReceipt> {
    const c = await this.inspect()
    if (statusOf(c.State) !== 'running') return {}
    this.runningAt = 0
    const r = await this.p.docker(['stop', '-t', '10', this.name])
    if (r.code !== 0 && !NOT_RUNNING.test(r.stderr)) throw new Error(`Couldn’t stop ${this.name}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
    const started = dateOf(c.State.StartedAt)
    const vcpus = c.HostConfig?.NanoCpus ? c.HostConfig.NanoCpus / 1e9 : Number(c.Config.Labels?.[VCPUS_LABEL]) || undefined
    const receipt: StopReceipt = started ? { durationMs: Math.max(0, Date.now() - started.getTime()), ...(vcpus ? { vcpus } : {}) } : {}
    // A repository's base is saved as an image when it stops, so its workspaces start without waiting for that.
    if (tagsOf(c.Config.Labels).role === 'base') {
      const stopped = await this.p.inspect(this.name)
      if (stopped) receipt.snapshotId = await this.p.commit(stopped, snapshotRef(this.name), (await this.imageId(snapshotRef(this.name))) ?? undefined)
    }
    return receipt
  }

  private async imageId(ref: string): Promise<string | null> {
    const r = await this.p.docker(['image', 'inspect', '--format', '{{.Id}}', ref])
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null
  }

  // No session cap: SandboxManager never calls this for Docker.
  async extendTimeout(): Promise<void> {}

  async delete(opts: { snapshots?: boolean } = {}): Promise<void> {
    this.runningAt = 0
    const c = await this.p.inspect(this.name).catch(() => null)
    const r = await this.p.docker(['rm', '-f', this.name])
    if (r.code !== 0 && !NO_SUCH.test(r.stderr)) throw new Error(`Couldn’t delete ${this.name}: ${firstLine(r.stderr) || `exit code ${r.code}`}`)
    if (opts.snapshots) await this.p.removeSnapshots(this.name)
    // A base deleted while workspaces used its image leaves the image behind; the last of them takes it.
    const source = c?.Config.Labels?.[SNAPSHOT_OF_LABEL]
    if (c?.Image && source && source !== this.name && !(await this.p.inspect(source).catch(() => true))) await this.p.docker(['image', 'rm', c.Image]).catch(() => undefined)
  }
}

/** A spawned command's client: logs replay from the start for every reader while it is held. */
class DockerCommand implements SpawnedRemote {
  private lines: RemoteLogLine[] = []
  private waiters: (() => void)[] = []
  private done = false
  private ended: Promise<{ code: number }>
  // Lines dropped from the front once the buffer is big (a long-lived attach bridge): replays then come from files.
  private dropped = 0
  private size = 0
  private static readonly KEEP_BYTES = 4 * 1024 * 1024

  constructor(
    readonly cmdId: string,
    private child: DockerChild,
    private writable: boolean,
    private killer: () => Promise<void>
  ) {
    const push = (stream: RemoteLogLine['stream']) => {
      const decoder = new StringDecoder('utf8')
      return (b: Buffer) => {
        const data = decoder.write(b)
        if (!data) return
        this.lines.push({ stream, data })
        this.size += data.length
        while (this.size > DockerCommand.KEEP_BYTES && this.lines.length > 1) {
          this.size -= this.lines.shift()!.data.length
          this.dropped++
        }
        this.wake()
      }
    }
    child.stdout.on('data', push('stdout'))
    child.stderr.on('data', push('stderr'))
    this.ended = child.exited.then((code) => {
      this.done = true
      this.wake()
      return { code }
    })
  }

  /** Every line it printed is still here. */
  get replayable(): boolean {
    return this.dropped === 0
  }

  /** Another reader of the same command (a re-attach while held). */
  view(): SpawnedRemote {
    return { cmdId: this.cmdId, write: (d) => this.write(d), closeStdin: () => this.closeStdin(), logs: () => this.logs(), wait: () => this.wait(), kill: () => this.kill() }
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (!this.writable) throw new Error('This command was re-attached from its logs; its input isn’t open here.')
    await new Promise<void>((resolve, reject) => this.child.stdin.write(data, (err) => (err ? reject(err) : resolve())))
  }

  async closeStdin(): Promise<void> {
    if (this.writable) this.child.stdin.end()
  }

  async *logs(): AsyncIterable<RemoteLogLine> {
    let i = this.dropped
    for (;;) {
      if (i < this.dropped) i = this.dropped
      if (i - this.dropped < this.lines.length) {
        yield this.lines[i - this.dropped]
        i++
        continue
      }
      if (this.done) return
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  wait(): Promise<{ code: number }> {
    return this.ended
  }

  // In the container; the client then ends with it. A stopped or lost daemon: the client goes.
  async kill(): Promise<void> {
    if (this.done) return
    await this.killer().catch(() => undefined)
    const late = setTimeout(() => this.child.kill(), 10_000)
    late.unref?.()
    void this.ended.then(() => clearTimeout(late))
  }
}

// ---- verify ----

interface DockerContext {
  Name: string
  Current?: boolean
  DockerEndpoint?: string
  Description?: string
  Error?: string
}

const AUTH_REFUSED = /permission denied|Permission denied \(publickey|access denied|unauthorized|x509:|tls: |certificate/i

/** Whether an endpoint is another computer (ssh, tcp to a non-local host) rather than this one's socket or pipe. */
export function remoteEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  const m = /^(ssh|tcp|https?):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/i.exec(endpoint)
  if (!m) return false
  return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(m[2])
}

/** The daemon's refusal as an error: an auth one only when the daemon (or ssh, or TLS) refused the credentials. */
function daemonError(stderr: string, target: DockerTarget): Error {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => !/^(WARNING|Client|Context|Version|API version)\b/i.test(l)) ?? firstLine(stderr)
  const where = target.context ? ` (context ${target.context})` : target.host ? ` at ${target.host}` : ''
  if (AUTH_REFUSED.test(stderr)) return Object.assign(new Error(`The Docker daemon${where} refused the connection: ${line}`), { auth: true })
  if (/context .* (does not exist|not found)/i.test(stderr)) return new Error(`There is no Docker context ${target.context ?? ''} on this computer. Run docker context ls to see them.`)
  if (/Cannot connect|error during connect|Is the docker daemon running|dockerDesktopLinuxEngine|docker_engine|connection refused|no such host|i\/o timeout/i.test(stderr))
    return new Error(`Docker isn’t running${where}. Start Docker Desktop (or the Docker daemon) and check again. (${line})`)
  return new Error(`Couldn’t reach Docker${where}: ${line || 'docker version failed'}`)
}

/** The CLI's contexts (Name, Current, DockerEndpoint), for picking one. */
export async function listDockerContexts(cli: DockerCli = dockerCli): Promise<DockerContext[]> {
  const r = await cli.run(['context', 'ls', '--format', '{{json .}}'], { env: { DOCKER_CONTEXT: undefined } })
  if (r.code !== 0) return []
  return r.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as DockerContext)
}

/**
 * Checks a connection before it is saved: `docker version` and `docker info` against the context or host. Identity:
 * the daemon (orgId: the host or context, so the same daemon twice is a duplicate). Throws with `auth: true` only
 * when the daemon refused the credentials; a daemon that isn't running is a plain error. Also lists the contexts.
 */
export async function verifyDocker(
  target: DockerTarget,
  cli: DockerCli = dockerCli
): Promise<{ identity: ConnectionIdentity; docker: DockerConnectionInfo; contexts: { name: string; current: boolean; endpoint?: string }[] }> {
  const clean: DockerTarget = { ...(target.context?.trim() ? { context: target.context.trim() } : {}), ...(target.host?.trim() ? { host: target.host.trim() } : {}) }
  if (clean.context && clean.host) throw new Error('Give a Docker context or a host, not both.')
  const provider = new DockerProvider(clean, undefined, cli)
  const version = await provider.docker(['version', '--format', '{{json .}}'])
  const parsed = (() => {
    try {
      return JSON.parse(version.stdout.toString('utf8')) as { Client?: { Context?: string }; Server?: { Version?: string; Os?: string; Arch?: string; Platform?: { Name?: string } } | null }
    } catch {
      return null
    }
  })()
  if (version.code !== 0 || !parsed?.Server) throw daemonError(version.stderr, clean)
  const info = JSON.parse(await provider.ok(['info', '--format', '{{json .}}'], 'Couldn’t read docker info')) as { NCPU?: number; OperatingSystem?: string; OSType?: string; Architecture?: string; Name?: string }
  const contexts = await listDockerContexts(cli).catch(() => [])
  const currentName = parsed.Client?.Context
  const endpoint = clean.host ?? contexts.find((c) => (clean.context ? c.Name === clean.context : c.Current || c.Name === currentName))?.DockerEndpoint ?? process.env.DOCKER_HOST
  const server = parsed.Server
  const system = [info.OperatingSystem ?? server.Platform?.Name, server.Os && server.Arch ? `${server.Os}/${server.Arch}` : info.Architecture].filter(Boolean)
  return {
    identity: { user: clean.context ?? clean.host ?? currentName ?? 'default', org: 'Docker', orgId: clean.host ?? clean.context ?? 'default', checkedAt: new Date().toISOString() },
    docker: {
      ...clean,
      ...(server.Version ? { serverVersion: server.Version } : {}),
      ...(system.length ? { os: system.length > 1 ? `${system[0]} (${system[1]})` : system[0] } : {}),
      remote: remoteEndpoint(endpoint),
      limits: { maxVcpus: info.NCPU && info.NCPU > 0 ? info.NCPU : CLOUD_PROVIDERS.docker.limits.maxVcpus, maxConcurrent: CLOUD_PROVIDERS.docker.limits.maxConcurrent, maxSessionMs: CLOUD_PROVIDERS.docker.limits.maxSessionMs }
    },
    contexts: contexts.map((c) => ({ name: c.Name, current: Boolean(c.Current), ...(c.DockerEndpoint ? { endpoint: c.DockerEndpoint } : {}) }))
  }
}
