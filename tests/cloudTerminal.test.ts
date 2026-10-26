// Cloud terminal tabs: a PTY in a cloud workspace's sandbox behind
// PtyManager, on the fake provider's in-process PTY. Spawn, type, resize, kill; killWorkspace and
// exclusive run mode; read-only while the sandbox sleeps and a new shell once it wakes; the idle ticker;
// and the Vercel WebSocket framing (research.md "PTY protocol") against a stand-in socket.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeProvider, type FakePty, type FakeSandbox } from '../src/main/cloud/fakeProvider'
import { SandboxManager } from '../src/main/cloud/sandboxes'
import { CloudPtyBackend, cloudPtyStart, cloudTerminalFolder, TERMINAL_IDLE_MS } from '../src/main/cloud/terminal'
import { connectVercelPty, ptySocketUrl, type PtySocket } from '../src/main/cloud/vercelPty'
import { secretKey } from '../src/main/integrations'
import { PtyManager } from '../src/main/pty'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { CLOUD_CWD, patchCloudSettings, planLimits } from '../src/shared/cloud'
import { createT } from '../src/shared/i18n'
import type { Connection } from '../src/shared/integrations'
import type { Repo, RepoSettings, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const MIN = 60_000
const VERCEL_TOKEN = 'vercel_SECRET_token_1234'
const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

async function rig() {
  const dataDir = await tempDir('foreman-cloud-term-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.cloud = patchCloudSettings(store.state.settings, { enabled: true })
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), plain)
  const limits = planLimits('pro')
  const connection: Connection = { id: 'vc1', service: 'vercel', name: 'Vercel', rev: 1, auth: { kind: 'token' }, agentAccess: 'off', vercel: { teamId: 'team_1', projectId: 'prj_1', plan: 'pro', limits }, createdAt: 'x' }
  secrets.setAppSecret(secretKey(connection.id), VERCEL_TOKEN)
  let now = Date.parse('2026-10-23T10:00:00Z')
  const clock = () => now
  const fake = new FakeProvider(await tempDir('foreman-cloud-term-sb-'), { limits, clock })
  const holder: { ptys?: PtyManager } = {}
  const manager = new SandboxManager({
    store,
    secrets,
    connection: (service) => (service === 'vercel' ? { state: 'ready', connection, source: 'default' } : { state: 'none', source: 'default', off: false }),
    provider: () => fake,
    clock,
    githubToken: () => undefined,
    cloneUrl: async () => null,
    gitIdentity: async () => ({}),
    settingsFor: () => ({}) as RepoSettings,
    changed: () => undefined,
    buildLog: () => undefined,
    turnRunning: () => false,
    // As core wires it: a cloud terminal in use keeps the sandbox awake.
    terminalOpen: (id) => holder.ptys?.keepsAwake(id) ?? false,
    focused: () => false
  })
  const out = new Map<string, string>()
  const exits = new Map<string, number>()
  const states: { id: string; asleep: boolean; reason?: string }[] = []
  const backend = new CloudPtyBackend({ sandboxes: manager, workspace: (id) => store.state.workspaces.find((w) => w.id === id), t: () => createT('en'), clock })
  const ptys = new PtyManager(
    {
      data: (id, data) => out.set(id, (out.get(id) ?? '') + data),
      exit: (id, code) => exits.set(id, code),
      state: (id, asleep, reason) => states.push({ id, asleep, reason })
    },
    backend
  )
  holder.ptys = ptys
  store.state.repos.push({ id: 'r1', name: 'app', rootPath: dataDir, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as Repo)
  const cloudWs = (id: string, repoId = 'r1') =>
    ({
      id,
      repoId,
      name: `ws-${id}`,
      branch: `test/${id}`,
      baseBranch: 'main',
      state: 'ready',
      portBase: 0,
      createdAt: new Date(now).toISOString(),
      cloud: { provider: 'vercel', id: `foreman-ws-${id}`, status: 'running', region: 'iad1', vcpus: 2, cwd: CLOUD_CWD, lastActivityAt: new Date(now).toISOString() }
    }) as Workspace
  const add = async (id: string) => {
    const ws = cloudWs(id)
    store.state.workspaces.push(ws)
    const sandbox = (await fake.create({ name: ws.cloud!.id, vcpus: 2, region: 'iad1', timeoutMs: 45 * MIN, tags: {} })) as FakeSandbox
    return { ws, sandbox }
  }
  const { ws, sandbox } = await add('w1')
  const env = { FOREMAN_WORKSPACE_PATH: CLOUD_CWD, FOREMAN_IS_CLOUD: '1', GH_TOKEN: 'gho_repo' }
  const live = (id: string) => waitFor(() => backend.stateOf(id) === 'live', `${id} to connect`)
  const lastPty = (sb: FakeSandbox = sandbox): FakePty => sb.openPtys().at(-1)!
  return { store, fake, manager, backend, ptys, ws, sandbox, add, env, out, exits, states, live, lastPty, advance: (ms: number) => (now += ms), now: clock }
}

describe('cloud terminal tabs', () => {
  it('opens a login shell in the sandbox, types, resizes and ends on kill, with pty-data and pty-exit', async () => {
    const r = await rig()
    const id = r.ptys.spawnCloud(r.ws, 120, 30, { cwd: CLOUD_CWD, env: r.env })
    await r.live(id)
    await waitFor(() => (r.out.get(id) ?? '').includes('$ '), 'the prompt')
    const open = r.fake.callsOf('openPty')[0]
    expect(open).toMatchObject({ sandbox: 'foreman-ws-w1', cmd: 'bash', args: ['-l'], detail: { cwd: CLOUD_CWD, cols: 120, rows: 30 } })
    expect(open.env).toMatchObject({ ...r.env, TERM: 'xterm-256color', TERM_PROGRAM: 'Foreman' })
    // The Vercel token never reaches the sandbox.
    expect(JSON.stringify(r.fake.calls)).not.toContain(VERCEL_TOKEN)
    expect(r.ptys.list()).toEqual([expect.objectContaining({ workspaceId: 'w1', kind: 'shell' })])

    r.ptys.write(id, 'echo hi\r')
    await waitFor(() => (r.out.get(id) ?? '').includes('echo hi'), 'the echo')
    expect(r.lastPty().input).toBe('echo hi\r')
    r.ptys.resize(id, 100, 40)
    expect(r.lastPty().resizes).toEqual([{ cols: 100, rows: 40 }])

    const pty = r.lastPty()
    r.ptys.kill(id)
    await waitFor(() => r.exits.has(id), 'pty-exit')
    expect(pty.closed).toBe(true)
    expect(r.ptys.list()).toEqual([])
  })

  it('reports the shell’s own exit code, and run scripts and snippets run in bash in the sandbox', async () => {
    const r = await rig()
    const shell = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    await r.live(shell)
    r.ptys.write(shell, 'exit 3\r')
    await waitFor(() => r.exits.get(shell) === 3, 'exit 3')

    const run = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env, script: 'npm run dev' })
    await waitFor(() => r.exits.has(run), 'the script to finish')
    expect(r.out.get(run)).toContain('npm run dev')
    const snippet = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env, script: 'ls -la', snippet: true })
    await waitFor(() => r.exits.has(snippet), 'the snippet to finish')
    expect(r.fake.callsOf('openPty').slice(1).map((c) => c.args)).toEqual([
      ['-lc', 'npm run dev'],
      ['--noprofile', '--norc', '-c', 'ls -la']
    ])
    expect(cloudPtyStart({ cwd: CLOUD_CWD, env: {} }, 80, 24)).toMatchObject({ command: 'bash', args: ['-l'] })
  })

  it('types a saved command in once the shell is up, below its banner', async () => {
    const r = await rig()
    const typed: string[] = []
    const backend = new CloudPtyBackend({
      sandboxes: r.manager,
      workspace: (id) => r.store.state.workspaces.find((w) => w.id === id),
      t: () => createT('en'),
      // Like pty.ts's: called on each chunk of output, it types once.
      typeWhenQuiet: (target, input) => () => {
        if (typed.length) return
        typed.push(input)
        target.write(input)
      }
    })
    const out: string[] = []
    const pty = backend.open('p1', r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env, notice: 'Seed DB', input: 'make seed\r' }, { data: (d) => out.push(d), exit: () => undefined, state: () => undefined })
    await waitFor(() => typed.length === 1, 'the command to be typed')
    expect(out[0]).toContain('Seed DB')
    expect(r.lastPty().input).toBe('make seed\r')
    pty.kill()
  })

  it('killWorkspace closes the workspace’s cloud terminals, and exclusive run mode’s killScripts reaches cloud scripts', async () => {
    const r = await rig()
    r.fake.ptyScriptsExit = false
    const other = await r.add('w2')
    const a = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    const b = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    const script = r.ptys.spawnCloud(other.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env, script: 'npm run dev' })
    await Promise.all([r.live(a), r.live(b), r.live(script)])
    expect(r.ptys.hasScripts('w2')).toBe(true)

    r.ptys.killScripts(['w2'])
    await waitFor(() => r.exits.has(script), 'the script to stop')
    expect(other.sandbox.openPtys()).toEqual([])
    expect(r.ptys.hasScripts('w2')).toBe(false)

    expect(r.sandbox.openPtys()).toHaveLength(2)
    r.ptys.killWorkspace('w1')
    await waitFor(() => r.exits.has(a) && r.exits.has(b), 'both shells to end')
    expect(r.sandbox.openPtys()).toEqual([])
    expect(r.ptys.list()).toEqual([])
  })

  it('goes read-only when the sandbox sleeps, and Wake starts a new shell in the same tab', async () => {
    const r = await rig()
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    await r.live(id)
    const first = r.lastPty()

    await r.manager.sleep(r.ws)
    await waitFor(() => r.backend.stateOf(id) === 'asleep' && r.states.some((s) => s.asleep), 'read-only')
    expect(first.closed).toBe(true)
    expect(r.ws.cloud!.status).toBe('sleeping')
    expect(r.states.at(-1)).toMatchObject({ id, asleep: true, reason: createT('en')('cloud.terminal.asleep') })
    expect(r.out.get(id)).toContain('read-only')
    // Not an exit: the tab stays, its output kept, and typing does nothing.
    expect(r.exits.has(id)).toBe(false)
    r.ptys.write(id, 'ls\r')
    expect(r.sandbox.openPtys()).toEqual([])
    // A sleeping terminal doesn't keep the sandbox awake.
    expect(r.ptys.keepsAwake('w1')).toBe(false)

    await r.manager.wake(r.ws)
    await r.live(id)
    expect(r.states.at(-1)).toMatchObject({ id, asleep: false })
    expect(r.out.get(id)).toContain('new shell')
    const second = r.lastPty()
    expect(second).not.toBe(first)
    r.ptys.write(id, 'pwd\r')
    expect(second.input).toBe('pwd\r')
    expect(r.fake.callsOf('openPty')).toHaveLength(2)
  })

  it('a run script ends when its sandbox stops, rather than coming back', async () => {
    const r = await rig()
    r.fake.ptyScriptsExit = false
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env, script: 'npm run dev' })
    await r.live(id)
    await r.manager.sleep(r.ws)
    await waitFor(() => r.exits.has(id), 'the script to end')
    expect(r.exits.get(id)).toBe(1)
    await r.manager.wake(r.ws)
    expect(r.fake.callsOf('openPty')).toHaveLength(1)
  })

  it('opening a terminal wakes a sleeping sandbox first', async () => {
    const r = await rig()
    await r.manager.sleep(r.ws)
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    r.ptys.write(id, 'git status\r')
    await r.live(id)
    expect(r.out.get(id)).toContain('Waking the sandbox')
    expect(r.ws.cloud!.status).toBe('running')
    expect(r.fake.callsOf('resume')).toHaveLength(1)
    // Typed while it was connecting: sent once it's up.
    expect(r.lastPty().input).toBe('git status\r')
    r.ptys.kill(id)
  })

  it('opening a terminal on a sandbox stopped at the session limit doesn’t wake it: read-only until Continue or Wake', async () => {
    const r = await rig()
    await r.sandbox.stop()
    r.manager.markCapped(r.ws)
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    await waitFor(() => r.backend.stateOf(id) === 'asleep', 'read-only')
    expect(r.states.at(-1)).toMatchObject({ asleep: true, reason: expect.stringContaining('session limit') })
    expect(r.fake.callsOf('resume')).toHaveLength(0)
    expect(r.ws.cloud!.status).toBe('capped')
    // Wake (or Continue, which wakes) brings the shell up.
    await r.manager.wake(r.ws)
    await r.live(id)
    expect(r.fake.callsOf('resume')).toHaveLength(1)
    r.ptys.kill(id)
  })

  it('a wake that is refused leaves the shell read-only with the reason, and a later wake connects it', async () => {
    const r = await rig()
    await r.manager.sleep(r.ws)
    r.fake.failNext('exec', new Error('network down'))
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    r.ptys.write(id, 'echo early\r')
    await waitFor(() => r.backend.stateOf(id) === 'asleep', 'read-only')
    expect(r.states.at(-1)).toMatchObject({ asleep: true })
    expect(r.states.at(-1)!.reason).toContain('network down')
    await r.manager.wake(r.ws)
    await r.live(id)
    r.ptys.kill(id)
  })

  it('the idle ticker sees an open terminal in use, extends the session on typing, and sleeps the sandbox once it’s idle', async () => {
    const r = await rig()
    const id = r.ptys.spawnCloud(r.ws, 80, 24, { cwd: CLOUD_CWD, env: r.env })
    await r.live(id)
    r.ptys.write(id, 'vim\r')
    expect(r.ptys.keepsAwake('w1')).toBe(true)

    r.advance(5 * MIN)
    await r.manager.tick()
    expect(r.ws.cloud!.lastActivityAt).toBe(new Date(r.now()).toISOString())
    expect(r.ws.cloud!.status).toBe('running')

    // Typing late in the session asks for more of it (the first ask, at 0, had plenty left).
    r.advance(30 * MIN)
    r.ptys.write(id, ':w\r')
    await waitFor(() => r.fake.callsOf('extendTimeout').length === 1, 'the session to be extended')
    await r.manager.tick()
    expect(r.ws.cloud!.lastActivityAt).toBe(new Date(r.now()).toISOString())

    // Nobody types or prints for a while: the terminal no longer counts, and idle sleep takes the sandbox.
    r.advance(TERMINAL_IDLE_MS + MIN)
    expect(r.ptys.keepsAwake('w1')).toBe(false)
    await r.manager.tick()
    expect(r.ws.cloud!.status).toBe('running')
    r.advance(20 * MIN)
    await r.manager.tick()
    expect(r.ws.cloud!.status).toBe('sleeping')
    await waitFor(() => r.backend.stateOf(id) === 'asleep', 'the terminal to go read-only')
  })
})

describe('restored cloud tabs', () => {
  it('keep a folder only when it is inside the sandbox’s worktree, never a path on this computer', () => {
    expect(cloudTerminalFolder(`${CLOUD_CWD}/src`, CLOUD_CWD)).toBe(`${CLOUD_CWD}/src`)
    expect(cloudTerminalFolder(`${CLOUD_CWD}/`, CLOUD_CWD)).toBe(CLOUD_CWD)
    expect(cloudTerminalFolder(CLOUD_CWD, CLOUD_CWD)).toBe(CLOUD_CWD)
    expect(cloudTerminalFolder(`${CLOUD_CWD}/../../etc`, CLOUD_CWD)).toBeUndefined()
    expect(cloudTerminalFolder('/vercel/sandbox/repository', CLOUD_CWD)).toBeUndefined()
    expect(cloudTerminalFolder('C:\\Users\\yatin\\repo', CLOUD_CWD)).toBeUndefined()
    expect(cloudTerminalFolder(undefined, CLOUD_CWD)).toBeUndefined()
  })
})

/** A WebSocket stand-in: records what is sent and lets the test play the controller. */
class FakeSocket implements PtySocket {
  readyState = 0
  binaryType = 'blob'
  sent: (string | Uint8Array)[] = []
  closed = false
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = 1
    if (type === 'close') this.readyState = 3
    for (const l of this.listeners.get(type) ?? []) l({ data })
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
}

describe('the Vercel PTY protocol', () => {
  const start = { command: 'bash', args: ['-l'], cwd: CLOUD_CWD, env: { GH_TOKEN: 'gho_x' }, cols: 120, rows: 30 }
  const healthyFetch = (seen: string[]) => (async (url: string | URL | Request) => (seen.push(String(url)), new Response('ok'))) as typeof fetch

  async function connect() {
    const seen: string[] = []
    let socket: FakeSocket | undefined
    const data: string[] = []
    const exits: (number | null)[] = []
    const pending = connectVercelPty({ url: 'wss://sb-123.vercel.run/interactive', token: 't o/k' }, start, { data: (d) => data.push(d), exit: (c) => exits.push(c) }, {
      fetch: healthyFetch(seen),
      socket: (url) => (socket = new FakeSocket(url))
    })
    await waitFor(() => Boolean(socket), 'the socket')
    socket!.emit('open')
    const transport = await pending
    return { transport, socket: socket!, seen, data, exits }
  }

  it('checks health, sends the token in the query and a JSON start frame, keystrokes as binary and resize as JSON', async () => {
    const { transport, socket, seen } = await connect()
    expect(seen).toEqual(['https://sb-123.vercel.run/health'])
    expect(socket.url).toBe('wss://sb-123.vercel.run/interactive?token=t%20o%2Fk')
    expect(ptySocketUrl('wss://x/y?a=1', 'k')).toBe('wss://x/y?a=1&token=k')
    expect(socket.binaryType).toBe('arraybuffer')
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'start', command: 'bash', args: ['-l'], env: ['TERM=xterm-256color', 'GH_TOKEN=gho_x'], cwd: CLOUD_CWD, cols: 120, rows: 30 })
    transport.write('ls\r')
    expect(socket.sent[1]).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(socket.sent[1] as Uint8Array)).toBe('ls\r')
    transport.resize(100, 40)
    expect(JSON.parse(socket.sent[2] as string)).toEqual({ type: 'resize', cols: 100, rows: 40 })
  })

  it('reads binary frames as output (a character split across frames too) and the exit message as the code', async () => {
    const { socket, data, exits } = await connect()
    const bytes = new TextEncoder().encode('héllo')
    socket.emit('message', bytes.slice(0, 2).buffer)
    socket.emit('message', bytes.slice(2).buffer)
    socket.emit('message', 'not json')
    socket.emit('message', JSON.stringify({ type: 'exit', code: 7 }))
    socket.emit('close')
    expect(data.join('')).toBe('héllonot json')
    expect(exits).toEqual([7])
  })

  it('a connection that drops without an exit says so with null; closing it ourselves says nothing', async () => {
    const dropped = await connect()
    dropped.socket.emit('close')
    expect(dropped.exits).toEqual([null])
    const closed = await connect()
    closed.transport.close()
    expect(closed.socket.closed).toBe(true)
    expect(closed.exits).toEqual([])
  })

  it('retries the health check, then gives up', async () => {
    let calls = 0
    const failing = (async () => (calls++, new Response('no', { status: 503, statusText: 'Service Unavailable' }))) as typeof fetch
    await expect(connectVercelPty({ url: 'wss://sb/x', token: 't' }, start, { data: () => undefined, exit: () => undefined }, { fetch: failing, healthRetries: 2, healthDelayMs: 1, socket: () => new FakeSocket('') })).rejects.toThrow(/isn’t healthy/)
    expect(calls).toBe(3)
  })
})
