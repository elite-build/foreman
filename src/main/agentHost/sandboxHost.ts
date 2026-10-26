// Cloud workspaces: the background agent host inside a workspace's sandbox VM. Plain Node, no
// Electron: the same HostServer and drivers as the local host (electronHost.ts), on a Unix socket,
// without the tray, notifications, dialogs or checkpoints (the sandbox snapshot plays that role).
// The app reaches it through sandboxAttach.js over a sandbox command's stdio and reads <dir>/token.
//   node sandboxHost.js --dir <stateDir> [--socket /tmp/foreman-host.sock]
//     [--executables claude=<path>,codex=<path>] [--idle-ms <ms>]
// The same settings can come from FOREMAN_HOST_DIR, FOREMAN_HOST_SOCKET, FOREMAN_HOST_EXECUTABLES.
import { randomBytes } from 'node:crypto'
import { realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentKind } from '../../shared/agents'
import { CLOUD_HOST_IDLE_MS } from '../../shared/cloud'
import { catalogDriver } from '../agents/catalogDrivers'
import { claudeDriver } from '../agents/claude'
import { codexDriver } from '../agents/codex'
import { opencodeDriver } from '../agents/opencode'
import type { AgentDriver } from '../agents/types'
import { hostSocketPath } from './protocol'
import { HostServer } from './server'

export const SANDBOX_SOCKET = '/tmp/foreman-host.sock'

export type Executables = Partial<Record<AgentKind, string>>

export interface SandboxHostConfig {
  dir: string
  // parseSandboxConfig fills it (defaultSandboxSocket); tests pass their own.
  socket: string
  executables?: Executables
  idleMs?: number
}

export interface SandboxHostOptions extends SandboxHostConfig {
  keepaliveMs?: number
  // Tests swap in a fake agent; the real host uses sandboxDriver.
  driver?(kind: AgentKind): AgentDriver
  exit(): void
}

function refused(kind: AgentKind, detail: string): AgentDriver {
  return {
    kind,
    createTurn: () => {
      throw new Error(detail)
    },
    status: async () => ({ agent: kind, installed: false, ready: false, detail })
  }
}

// Not the registry (driverFor): it imports the Cursor driver, whose SDK isn't installed in the sandbox.
const BUILT_IN: Partial<Record<AgentKind, AgentDriver>> = { claude: claudeDriver, codex: codexDriver, opencode: opencodeDriver }

/**
 * The sandbox's own environment (PATH, HOME, …) under a turn's: the app sends only the turn's variables and
 * credentials, never its computer's PATH, so the agent finds the image's binaries.
 */
export function sandboxEnv(turnEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const own = Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('FOREMAN_HOST_')))
  return { ...own, ...turnEnv }
}

/** The driver for an agent in the sandbox, pointed at the sandbox's own binary when one is configured. */
export function sandboxDriver(kind: AgentKind, executables: Executables = {}): AgentDriver {
  // Cursor's SDK runs its agent in-process on this computer; it has no way to run inside a sandbox.
  if (kind === 'cursor') return refused(kind, 'Cursor can’t run in a cloud workspace yet. Use Claude Code, Codex or OpenCode there.')
  const base = BUILT_IN[kind] ?? catalogDriver(kind)
  if (!base) return refused(kind, `${kind} can’t run in a cloud workspace.`)
  // The app's executablePath is a path on its own computer: the sandbox's wins, else the agent's own lookup.
  const executablePath = executables[kind]
  return { ...base, createTurn: (req, cb) => base.createTurn({ ...req, env: sandboxEnv(req.env), executablePath }, cb) }
}

/** The socket when none is given: the VM's fixed path, or a named pipe where Unix sockets can't go (a Windows dev run). */
export function defaultSandboxSocket(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? hostSocketPath(dir, platform) : SANDBOX_SOCKET
}

/** Where the host writes its token, readable only by the sandbox user. */
export function sandboxTokenPath(dir: string): string {
  return path.join(dir, 'token')
}

/**
 * Listen and write the token. Null when another host already listens on the socket (its token file stays).
 * A new attach takes over from an old one: the old attach command can outlive a dropped connection.
 */
export async function createSandboxHost(opts: SandboxHostOptions): Promise<HostServer | null> {
  const executables = opts.executables ?? {}
  const token = randomBytes(24).toString('hex')
  const server = new HostServer({
    dir: opts.dir,
    socket: opts.socket,
    driver: opts.driver ?? ((kind) => sandboxDriver(kind, executables)),
    // No saveCheckpoint: the end checkpoint is never taken here, so `endCheckpointSaved` stays unset.
    idleMs: opts.idleMs ?? CLOUD_HOST_IDLE_MS,
    keepaliveMs: opts.keepaliveMs,
    token,
    takeover: true,
    exit: opts.exit
  })
  if (!(await server.listen())) return null
  const file = sandboxTokenPath(opts.dir)
  writeFileSync(`${file}.tmp`, token, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return server
}

/** Settings from the command line, then the environment. Null without a state folder. */
export function parseSandboxConfig(argv: string[], env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform): SandboxHostConfig | null {
  const flag = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    if (at >= 0) return argv[at + 1]
    return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  }
  const dir = flag('dir') ?? env.FOREMAN_HOST_DIR
  if (!dir) return null
  const executables: Executables = {}
  for (const pair of (flag('executables') ?? env.FOREMAN_HOST_EXECUTABLES ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at > 0) executables[pair.slice(0, at).trim() as AgentKind] = pair.slice(at + 1).trim()
  }
  const idle = Number(flag('idle-ms'))
  return { dir, socket: flag('socket') ?? env.FOREMAN_HOST_SOCKET ?? defaultSandboxSocket(dir, platform), executables, idleMs: idle > 0 ? idle : undefined }
}

async function main(): Promise<void> {
  const config = parseSandboxConfig(process.argv.slice(2), process.env)
  if (!config) {
    process.stderr.write('usage: node sandboxHost.js --dir <stateDir> [--socket <path>] [--executables claude=<path>,codex=<path>]\n')
    return process.exit(64)
  }
  const server = await createSandboxHost({ ...config, exit: () => process.exit(0) })
  // Another host already answers on the socket: it is the one to use, so starting is still a success.
  if (!server) {
    process.stdout.write(`${JSON.stringify({ ready: true, socket: config.socket, existing: true })}\n`)
    return process.exit(0)
  }
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    // Running turns end as Stopped (logged), then the socket and token go; a stuck agent doesn't hold the exit.
    const timer = setTimeout(() => process.exit(0), 5_000)
    void server
      .stopAll()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        server.close()
        process.exit(0)
      })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdout.write(`${JSON.stringify({ ready: true, socket: server.socket, pid: process.pid })}\n`)
}

function isEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (!process.versions.electron && isEntry()) void main()
