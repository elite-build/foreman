// Cloud workspaces: the agent host as it runs inside a sandbox (sandboxHost.ts), reached through the
// attach bridge (sandboxAttach.ts, run for real as a child process) and through an in-process duplex.
// The socket is a Unix socket, or a named pipe on Windows (hostSocketPath).
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalResponse, ChatItem } from '../src/shared/types'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { duplexFromStreams, HostClient, type TurnContext } from '../src/main/agentHost/client'
import { hostSocketPath, readLog } from '../src/main/agentHost/protocol'
import { createSandboxHost, parseSandboxConfig, sandboxDriver, sandboxTokenPath } from '../src/main/agentHost/sandboxHost'
import { bundleClosure, packageOf, pinned, SANDBOX_DEPENDENCIES, sandboxPackageJson } from '../src/main/agentHost/sandboxPackage'
import type { HostServer } from '../src/main/agentHost/server'
import { fakeDriver, fakeRequest } from './agentHostFake'

// sandboxDriver's executable override, seen from the driver's side.
const claudeSeen = vi.hoisted(() => [] as TurnRequest[])
vi.mock('../src/main/agents/claude', () => ({
  claudeDriver: {
    kind: 'claude',
    createTurn: (req: TurnRequest) => {
      claudeSeen.push(req)
      return {}
    },
    status: async () => ({ agent: 'claude', installed: true, ready: true })
  }
}))

const JITI = path.join(process.cwd(), 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
const ATTACH = path.join(process.cwd(), 'src', 'main', 'agentHost', 'sandboxAttach.ts')
const OUT = path.join(process.cwd(), 'out', 'main')

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function recorder() {
  const items: ChatItem[] = []
  const finished: unknown[] = []
  const asked: string[] = []
  const cb: TurnCallbacks = {
    item: (item, transient) => {
      if (!transient) items.push(item)
    },
    sessionStarted: () => undefined,
    assistantMessage: () => undefined,
    approveTool: async (request) => {
      asked.push(`tool:${request.toolName}`)
      return { kind: 'tool', allow: true } as ApprovalResponse as never
    },
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => ({ kind: 'question', answers: { 'Which?': 'A' } }) as never,
    planModeChanged: () => undefined,
    autoAcceptEdits: () => undefined,
    usage: () => undefined,
    finished: (r) => void finished.push(r)
  }
  const said = () => items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : []))
  return { cb, finished, asked, said }
}

const context: TurnContext = {
  hostTools: {
    workspaceDiff: async (file) => `+1 -0 ${file}`,
    diffComments: async () => 'none',
    addDiffComments: async () => 'ok'
  }
}

const started: { servers: HostServer[]; clients: HostClient[]; children: ChildProcess[] } = { servers: [], clients: [], children: [] }
afterEach(() => {
  for (const c of started.clients) c.close()
  for (const s of started.servers) s.close()
  for (const child of started.children) child.kill()
  started.servers = []
  started.clients = []
  started.children = []
})

async function sandbox(driver: AgentDriver = fakeDriver) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-sandbox-'))
  const socket = hostSocketPath(dir)
  const host = async () => {
    const server = await createSandboxHost({ dir, socket, driver: () => driver, keepaliveMs: 50, exit: () => undefined })
    if (server) started.servers.push(server)
    return server
  }
  return { dir, socket, host, token: () => readFileSync(sandboxTokenPath(dir), 'utf8') }
}

/** Transports to the host: what CloudTurnHost does with a sandbox command, here with local stand-ins. */
interface Transport {
  connect(): Promise<Duplex>
  // Cut the current connection the way a network drop would.
  drop(): void
  // While down, every dial fails.
  down: boolean
}

/** The attach bridge for real: a child `sandboxAttach` whose stdin and stdout are the transport. */
function attachTransport(socket: string): Transport {
  let current: ChildProcess | null = null
  const t: Transport = {
    down: false,
    connect: async () => {
      if (t.down) throw new Error('network down')
      const child = spawn(process.execPath, [JITI, ATTACH, '--socket', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      started.children.push(child)
      current = child
      return duplexFromStreams(child.stdin!, child.stdout!)
    },
    drop: () => current?.kill()
  }
  return t
}

/** The same bridge in-process: two pass-throughs and a socket. A drop leaves the host's end open (a lingering attach). */
function inProcessTransport(socket: string): Transport {
  let current: Duplex | null = null
  const t: Transport = {
    down: false,
    connect: async () => {
      if (t.down) throw new Error('network down')
      const sock = net.connect(socket)
      await once(sock, 'connect')
      const toHost = new PassThrough()
      const fromHost = new PassThrough()
      toHost.pipe(sock)
      sock.pipe(fromHost)
      sock.on('error', () => fromHost.destroy())
      current = duplexFromStreams(toHost, fromHost)
      return current
    },
    drop: () => current?.destroy()
  }
  return t
}

const probe = await (async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-sandbox-probe-'))
  const server = net.createServer()
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(hostSocketPath(dir), () => resolve(true))
  })
  server.close()
  return ok
})()

const label = { workspace: 'lisbon' }

describe.skipIf(!probe).each([
  ['the attach bridge', attachTransport],
  ['an in-process duplex', inProcessTransport]
])('sandbox host over %s', (_name, transport) => {
  it('streams a turn, relays an approval and a host-tool call, keeps alive, and picks up after a drop', async () => {
    const box = await sandbox()
    expect(await box.host()).not.toBeNull()
    const t = transport(box.socket)
    let keepalives = 0
    const client = new HostClient({ dir: box.dir, connect: () => t.connect(), token: box.token, reconnectMs: 20_000, onKeepalive: () => keepalives++ })
    started.clients.push(client)
    const gateA = path.join(box.dir, 'go-a')
    const gateB = path.join(box.dir, 'go-b')
    const r = recorder()
    const script = ['say:one', `gate:${gateA}`, 'approve:Bash', 'diff:src/a.ts', 'say:two', `gate:${gateB}`, 'say:three', 'approve:Edit', 'say:four']
    const turn = client.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', script.join('\n')), hostTools: { followups: false }, label }, context, r.cb)
    const run = turn.run()

    // Streaming: the first message arrives while the turn is still held at the gate, then keepalives.
    await until(() => r.said().includes('one'))
    await until(() => keepalives > 0)
    writeFileSync(gateA, '')
    await until(() => r.said().includes('two'))
    expect(r.asked).toEqual(['tool:Bash'])
    expect(r.said()).toEqual(['one', 'approved', 'diff: +1 -0 src/a.ts', 'two'])

    // The connection drops; the turn goes on in the host and waits on an approval nobody can see yet.
    t.down = true
    t.drop()
    await until(() => !client.connected)
    writeFileSync(gateB, '')
    await until(() => readLog(box.dir, 't1').some((e) => e.type === 'item' && e.item.kind === 'assistant' && e.item.text === 'three'))
    expect(r.said()).not.toContain('three')

    // It comes back: the missed events once each, in order, then the waiting approval, then live to the end.
    t.down = false
    await run
    expect(r.said()).toEqual(['one', 'approved', 'diff: +1 -0 src/a.ts', 'two', 'three', 'approved', 'four'])
    expect(r.asked).toEqual(['tool:Bash', 'tool:Edit'])
    expect(r.finished).toEqual([{ ok: true }])
  }, 60_000)

  it('a relaunched app adopts the turn after the last event it saw', async () => {
    const box = await sandbox()
    await box.host()
    const t = transport(box.socket)
    const gate = path.join(box.dir, 'go')
    const a = new HostClient({ dir: box.dir, connect: () => t.connect(), token: box.token })
    started.clients.push(a)
    const first = recorder()
    void a.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', ['say:one', `gate:${gate}`, 'say:two', 'say:three'].join('\n')), label }, {}, first.cb).run()
    await until(() => first.said().includes('one'))
    const seen = readLog(box.dir, 't1').at(-1)!.seq
    a.close()
    writeFileSync(gate, '')
    await until(() => readLog(box.dir, 't1').some((e) => e.type === 'ended'))

    const b = new HostClient({ dir: box.dir, connect: () => t.connect(), token: box.token })
    started.clients.push(b)
    expect(await b.connect({ spawn: false })).toEqual([expect.objectContaining({ turnId: 't1', ended: true })])
    const second = recorder()
    const { turn, missed } = await b.adopt('t1', seen, {}, second.cb)
    expect(missed[0].seq).toBe(seen + 1)
    await turn.run()
    expect(second.said()).toEqual(['two', 'three'])
    await b.ack('t1')
    expect(readLog(box.dir, 't1')).toEqual([])
  }, 60_000)

  it('finds no host when nothing listens, and starts one when allowed', async () => {
    const box = await sandbox()
    const t = transport(box.socket)
    const client = new HostClient({ dir: box.dir, connect: () => t.connect(), token: box.token, spawn: () => box.host(), connectTimeoutMs: 20_000 })
    started.clients.push(client)
    await expect(client.connect({ spawn: false })).rejects.toThrow('No background agent host is running.')
    expect(await client.connect()).toEqual([])
    expect(await client.request('ping', {})).toEqual({ ok: true })
  }, 60_000)
})

describe.skipIf(!probe)('sandbox host setup', () => {
  it('writes the token only the sandbox user can read, and a second host defers to the first', async () => {
    const box = await sandbox()
    const server = await box.host()
    expect(server).not.toBeNull()
    expect(box.token()).toMatch(/^[0-9a-f]{48}$/)
    if (process.platform !== 'win32') expect(statSync(sandboxTokenPath(box.dir)).mode & 0o777).toBe(0o600)
    const token = box.token()
    expect(await box.host()).toBeNull()
    expect(box.token()).toBe(token)
  })

  it('the attach bridge exits with code 2 when no host is listening', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-sandbox-none-'))
    const child = spawn(process.execPath, [JITI, ATTACH, '--socket', hostSocketPath(dir)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    started.children.push(child)
    const [code] = await once(child, 'exit')
    expect(code).toBe(2)
  }, 30_000)
})

describe('sandbox host drivers and settings', () => {
  it('refuses Cursor, and points an agent at the sandbox binary', () => {
    expect(() => sandboxDriver('cursor').createTurn(fakeRequest('t1', 'hi'), recorder().cb)).toThrow(/Cursor can’t run in a cloud workspace/)
    sandboxDriver('claude', { claude: '/usr/local/bin/claude' }).createTurn({ ...fakeRequest('t1', 'hi'), executablePath: 'C:\\Users\\me\\claude.exe' }, recorder().cb)
    expect(claudeSeen.at(-1)?.executablePath).toBe('/usr/local/bin/claude')
  })

  it('reads its settings from the command line, then the environment', () => {
    expect(parseSandboxConfig(['--dir', '/vercel/foreman/state', '--executables', 'claude=/bin/claude,codex=/bin/codex'], {}, 'linux')).toEqual({
      dir: '/vercel/foreman/state',
      socket: '/tmp/foreman-host.sock',
      executables: { claude: '/bin/claude', codex: '/bin/codex' },
      idleMs: undefined
    })
    expect(parseSandboxConfig(['--socket=/tmp/x.sock', '--idle-ms', '5000'], { FOREMAN_HOST_DIR: '/s' })).toEqual({ dir: '/s', socket: '/tmp/x.sock', executables: {}, idleMs: 5000 })
    expect(parseSandboxConfig([])).toBeNull()
    // The default is chosen in one place: a named pipe where Unix sockets can't go.
    expect(parseSandboxConfig(['--dir', 'C:\state'], {}, 'win32')?.socket).toBe(hostSocketPath('C:\state', 'win32'))
  })

  it('pins the sandbox package to the SDK versions Foreman ships', () => {
    const pkg = JSON.parse(sandboxPackageJson()) as { type: string; dependencies: Record<string, string> }
    expect(pkg.type).toBe('module')
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...SANDBOX_DEPENDENCIES].sort())
    for (const name of SANDBOX_DEPENDENCIES) {
      const installed = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
      expect(pkg.dependencies[name], name).toBe(installed.version)
    }
    expect(pinned('^1.8.0')).toBe('1.8.0')
  })
})

// Only after `npm run build`: what gets uploaded imports nothing the sandbox doesn't have.
describe.skipIf(!existsSync(path.join(OUT, 'sandboxHost.js')))('sandbox bundle', () => {
  it('the host needs only node builtins and the pinned SDKs; the attach bridge only builtins, in one file', () => {
    const host = bundleClosure(OUT, 'sandboxHost.js')
    const outside = host.packages.map(packageOf).filter((p): p is string => p !== null)
    expect(outside.filter((p) => !(SANDBOX_DEPENDENCIES as readonly string[]).includes(p))).toEqual([])
    expect(host.files[0]).toBe('sandboxHost.js')
    const attach = bundleClosure(OUT, 'sandboxAttach.js')
    expect(attach.files).toEqual(['sandboxAttach.js'])
    expect(attach.packages.map(packageOf).filter(Boolean)).toEqual([])
  })
})
