// OpenCode's own server (`opencode serve`), which the adapter talks to over HTTP and server-sent events through
// @opencode-ai/sdk. One server for each turn (docs/agents.md 3.2): its environment names the turn (`FOREMAN_TURN_ID` and
// its token, which `foreman report` attributes by), and the server has no environment per session, so one that outlived
// its turn would run the next turn's commands as the first. The server listens on loopback only, behind a password made
// for it alone: `/config/providers` answers with the provider keys in its environment, so it must never be reachable
// without one.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isWindows, killProcessTree, treeSpawnOptions } from '../../platform'
import { trackChild } from '../../processRoots'
import { launchFor } from '../catalogDetect'
import { absoluteCommand } from '../acp/command'
import type { ApprovalPolicy } from '../../../shared/permissions'
import type { McpLaunch } from '../types'

const MAX_STDERR = 4000
const START_TIMEOUT_MS = 30_000
const LISTENING = /opencode server listening on (https?:\/\/\S+)/

/** What starting a server needs: the program, its arguments, and the turn's folder and environment. */
export interface OpencodeLaunch {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** A running OpenCode server, or a replay standing in for one (fixtures/replayTransports.ts). */
export interface OpencodeServer {
  baseUrl: string
  /** Every request to the server goes through this: it carries the server's password. */
  fetch: typeof fetch
  /** Why the server could not run or stopped (e.g. ENOENT), and the tail of its error output. */
  failure(): { error?: Error; stderr: string }
  close(): Promise<void>
  /** The server's process, where there is one (the recorder records its exit, and can kill it). */
  process?: ChildProcess
}

export type OpencodeLauncher = (launch: OpencodeLaunch) => Promise<OpencodeServer>

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * npm installs OpenCode on Windows as an `opencode.cmd` shim, which Node can
 * only start through a shell. The real opencode.exe sits in the package's
 * per-platform dependency next to the shim, so run that instead.
 */
function exeBehindShim(shim: string): string | undefined {
  const modules = path.join(path.dirname(shim), 'node_modules')
  const variants = process.arch === 'arm64' ? ['arm64'] : ['x64', 'x64-baseline']
  return variants
    .flatMap((v) => [
      path.join(modules, 'opencode-ai', 'node_modules', `opencode-windows-${v}`, 'bin', 'opencode.exe'),
      path.join(modules, `opencode-windows-${v}`, 'bin', 'opencode.exe')
    ])
    .find((candidate) => existsSync(candidate))
}

/** The OpenCode binary to run: the configured path, else the one on PATH. */
export function opencodeBinary(executablePath?: string): string {
  const configured = executablePath?.trim()
  if (!isWindows) return configured || 'opencode'
  if (configured && !/\.(cmd|bat|ps1)$/i.test(configured)) return configured
  if (!configured) {
    const exe = onPath('opencode.exe')
    if (exe) return exe
  }
  const shim = configured || onPath('opencode.cmd')
  // Unresolvable shims fail as "not installed", which points at Settings.
  return (shim && exeBehindShim(shim)) || 'opencode.exe'
}

/** `opencode serve` on loopback; the port is the server's choice and read back from what it prints. */
export function serveArgs(): string[] {
  return ['serve', '--hostname=127.0.0.1', '--port=0']
}

// What OpenCode asks about when Foreman holds the turn to Ask or Ask except edits: every tool that changes something or
// reaches out (its edits, shell, web, MCP and plugin tools, and anything outside the workspace), and none that only reads
// or keeps its own notes. Foreman answers each request by the turn's mode.
const ASK_ALL: Record<string, 'ask' | 'allow'> = {
  '*': 'ask',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  lsp: 'allow',
  todowrite: 'allow',
  todoread: 'allow',
  task: 'allow',
  question: 'allow',
  skill: 'allow'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `over` laid on `base`, objects merged key by key (what OpenCode does with its own config layers). */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = isObject(value) && isObject(out[key]) ? merge(out[key] as Record<string, unknown>, value) : value
  return out
}

/**
 * The repository's approved MCP servers (#20) as OpenCode's `mcp` config: local servers it starts itself, with only
 * the variables they declared. A repo path resolves against the workspace and a Windows .cmd shim runs through cmd.exe.
 */
export function opencodeMcp(servers: Record<string, McpLaunch> | undefined, cwd: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([name, s]) => {
      const launch = launchFor(absoluteCommand(s.command, cwd, env, platform), s.args, platform)
      return [name, { type: 'local', command: [launch.file, ...launch.args], environment: s.env, enabled: true }]
    })
  )
}

/**
 * The config a turn's server starts with (`OPENCODE_CONFIG_CONTENT`, which OpenCode lays over the user's own files): the
 * repository's MCP servers, and under Ask or Ask except edits a permission set that makes OpenCode ask Foreman before
 * anything that changes or reaches out. Under Never ask the user's own permission config stands, so a command they
 * denied in OpenCode stays denied. Whatever `OPENCODE_CONFIG_CONTENT` already held is kept underneath.
 */
export function serverConfig(options: { approvals: ApprovalPolicy; mcpServers?: Record<string, McpLaunch>; cwd: string; env: Record<string, string> }): string {
  let base: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT ?? '{}')
    if (isObject(parsed)) base = parsed
  } catch {
    // Not JSON: OpenCode would refuse it too, so Foreman's own config replaces it.
  }
  const ours: Record<string, unknown> = {}
  const mcp = opencodeMcp(options.mcpServers, options.cwd, options.env)
  if (Object.keys(mcp).length) ours.mcp = mcp
  if (options.approvals !== 'never-ask') ours.permission = ASK_ALL
  return JSON.stringify(merge(base, ours))
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref?.())])
}

/** Starts `opencode serve` as a child of this turn and resolves once it says where it listens. */
export const spawnOpencodeServer: OpencodeLauncher = ({ file, args, cwd, env }) => {
  const password = randomBytes(24).toString('hex')
  const child = spawn(file, args, { cwd, env: { ...env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], ...treeSpawnOptions })
  trackChild(child, env, 'agent')
  let error: Error | undefined
  let stderr = ''
  let stdout = ''
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  child.on('error', (err) => (error = err))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-MAX_STDERR)))
  child.stdout.setEncoding('utf8')
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.pid) await killProcessTree(child.pid)
    else child.kill()
    await settlesWithin(exited, 3000)
  }
  return new Promise<OpencodeServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      void close()
      reject(new Error(`OpenCode's server didn't start within ${START_TIMEOUT_MS / 1000} seconds.${stderr.trim() ? `\n\n${stderr.trim()}` : ''}`))
    }, START_TIMEOUT_MS)
    const listen = (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_STDERR)
      const url = LISTENING.exec(stdout)?.[1]
      if (!url) return
      clearTimeout(timer)
      child.stdout.off('data', listen)
      // What it prints from now on is of no use to the turn, but the pipe must keep draining.
      child.stdout.resume()
      const authorized: typeof fetch = (input, init) => {
        const request = new Request(input, init)
        request.headers.set('Authorization', authorization)
        return fetch(request)
      }
      resolve({ baseUrl: url.replace(/\/+$/, ''), fetch: authorized, failure: () => ({ error, stderr }), close, process: child })
    }
    child.stdout.on('data', listen)
    void exited.then(() => {
      clearTimeout(timer)
      reject(error ?? new Error(`OpenCode's server exited before it started.${stderr.trim() ? `\n\n${stderr.trim()}` : ''}`))
    })
  })
}
