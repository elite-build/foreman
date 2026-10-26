// Cloud workspaces, phase 2b: a cloud workspace's turns run in the agent host inside its sandbox (CloudTurnHost).
// The sandbox is the fake provider; the host is the real sandbox host (createSandboxHost) in-process, reached over
// an in-process duplex instead of a sandbox command, running the scripted fake agent (agentHostFake.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { once } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { duplexFromStreams } from '../src/main/agentHost/client'
import { hostSocketPath } from '../src/main/agentHost/protocol'
import { createSandboxHost, sandboxTokenPath } from '../src/main/agentHost/sandboxHost'
import type { HostServer } from '../src/main/agentHost/server'
import type { AgentDriver, TurnRequest } from '../src/main/agents/types'
import { FakeProvider, type FakeSandbox } from '../src/main/cloud/fakeProvider'
import { SandboxManager } from '../src/main/cloud/sandboxes'
import { CloudTurnHost, CONNECTION_LOST_REASON, HOST_GONE_REASON, reconnectDelay, SANDBOX_GONE_REASON, sandboxTransport, type CloudTransport } from '../src/main/cloud/turnHost'
import { git } from '../src/main/git'
import { secretKey } from '../src/main/integrations'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import type { SessionService } from '../src/main/sessions'
import { CLAUDE_SETUP_TOKEN_KEY, CLOUD_CONTINUE_PROMPT, CLOUD_CWD, patchCloudSettings, planLimits } from '../src/shared/cloud'
import type { Connection } from '../src/shared/integrations'
import type { ApprovalRequest, ChatItem, TurnOutcome, Workspace } from '../src/shared/types'
import { fakeDriver } from './agentHostFake'
import { makeRepo, tempDir } from './helpers'
import { setupSessions } from './sessionHarness'

const MIN = 60_000
const VERCEL_TOKEN = 'vercel_SECRET_token_1234'
const SETUP_TOKEN = 'sk-ant-oat01-setup-token-for-tests'
const GH_TOKEN = 'gho_cloud_turn_token'
const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// Named pipes on Windows, Unix sockets elsewhere: skip where neither can be listened on.
const probe = await (async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-cloud-probe-'))
  const server = net.createServer()
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(hostSocketPath(dir), () => resolve(true))
  })
  server.close()
  return ok
})()

/** The host inside the sandbox, in-process: started by `spawn`, reached through a duplex that a test can drop. */
function sandboxHost(sandbox: () => FakeSandbox, driver: AgentDriver, dir: string) {
  const socket = hostSocketPath(dir)
  const servers: HostServer[] = []
  let current: Duplex | null = null
  const t = {
    down: false,
    spawned: 0,
    servers,
    drop: () => current?.destroy(),
    /** The VM stopped: the host and everything in it are gone. */
    kill: async () => {
      for (const s of servers.splice(0)) {
        s.close()
        // The agent in it stops too (nobody hears its end: the connection went with the VM).
        await s.stopAll().catch(() => undefined)
      }
    },
    transport: {
      connect: async () => {
        // As sandboxTransport: never attach to (and so resume) a sandbox that isn't running.
        if (t.down || (await sandbox().status()) !== 'running') throw new Error('network down')
        const sock = net.connect(socket)
        await once(sock, 'connect')
        const toHost = new PassThrough()
        const fromHost = new PassThrough()
        toHost.pipe(sock)
        sock.pipe(fromHost)
        sock.on('error', () => fromHost.destroy())
        sock.on('close', () => fromHost.destroy())
        current = duplexFromStreams(toHost, fromHost)
        current.on('close', () => sock.destroy())
        return current
      },
      token: async () => readFileSync(sandboxTokenPath(dir), 'utf8'),
      spawn: async () => {
        t.spawned++
        const server = await createSandboxHost({ dir, socket, driver: () => driver, keepaliveMs: 50, exit: () => undefined })
        if (server) servers.push(server)
      }
    } satisfies CloudTransport
  }
  cleanup.push(() => t.kill())
  return t
}

/** A cloud workspace on the fake provider with its worktree cloned, a chat in it, and the cloud host wired as Core does. */
async function rig(options: { autoContinue?: boolean; vars?: Record<string, string>; reconnectMs?: number; recoverRetryMs?: number[] } = {}) {
  let now = Date.parse('2026-10-23T10:00:00Z')
  const fake = new FakeProvider(await tempDir('foreman-cloudturn-sb-'), { clock: () => now })
  const upstream = await makeRepo({ 'README.md': 'hello\n' })
  const ws: Workspace = {
    id: 'ws', repoId: 'repo', name: 'lisbon', branch: 'b', baseBranch: 'main', portBase: 0, state: 'ready', createdAt: new Date(now).toISOString(),
    cloud: { provider: 'vercel', id: 'foreman-ws-ws', status: 'running', region: 'iad1', vcpus: 2, cwd: CLOUD_CWD }
  }
  const sb = (await fake.create({ name: 'foreman-ws-ws', vcpus: 2, region: 'iad1', timeoutMs: 20 * MIN, tags: { app: 'foreman' } })) as FakeSandbox
  await git(os.tmpdir(), ['clone', '-q', upstream, sb.real(CLOUD_CWD)])
  ws.cloud!.sessionExpiresAt = new Date(sb.expires).toISOString()

  const approvals: ApprovalRequest[] = []
  const ended: TurnOutcome[] = []
  let sessions!: SessionService
  let cloud!: CloudTurnHost
  const h = await setupSessions({
    ws,
    events: {
      approval: (request) => {
        approvals.push(request)
        void sessions.respondApproval(request.id, { kind: 'tool', allow: true })
      },
      turnEnded: (_id, outcome) => void ended.push(outcome)
    },
    workspaces: { gitTarget: (w: Workspace) => manager.runtime(w) }
  })
  sessions = h.sessions
  const { store } = h
  store.state.settings.cloud = patchCloudSettings(store.state.settings, { enabled: true, claudeAuth: 'setup-token' })
  store.state.repos.push({ id: 'repo', name: 'app', rootPath: upstream, defaultBranch: 'main', cloud: { enabled: true, vcpus: 2, region: 'iad1', idleMinutes: 20, autoContinue: options.autoContinue ?? true, installScript: '' } } as never)
  const secrets = new SecretStore(path.join(await tempDir('foreman-cloudturn-secrets-'), 'secrets.bin'), plain)
  const connection: Connection = { id: 'vc1', service: 'vercel', name: 'Vercel', rev: 1, auth: { kind: 'token' }, agentAccess: 'off', vercel: { teamId: 't', projectId: 'p', plan: 'hobby', limits: planLimits('hobby') }, createdAt: 'x' }
  secrets.setAppSecret(secretKey(connection.id), VERCEL_TOKEN)
  secrets.setAgentKey('claude', CLAUDE_SETUP_TOKEN_KEY, SETUP_TOKEN)
  const manager: SandboxManager = new SandboxManager({
    store,
    secrets,
    connection: (service) => (service === 'vercel' ? { state: 'ready', connection, source: 'default' } : { state: 'none', source: 'default', off: false }),
    provider: () => fake,
    clock: () => now,
    githubToken: () => GH_TOKEN,
    cloneUrl: async () => upstream,
    gitIdentity: async () => ({}),
    settingsFor: () => ({}) as never,
    changed: () => undefined,
    buildLog: () => undefined,
    turnRunning: (id) => cloud.running(id) || store.state.sessions.some((s) => s.workspaceId === id && (s.status === 'running' || Boolean(s.turnId))),
    terminalOpen: () => false,
    focused: () => false
  })
  const seen: TurnRequest[] = []
  const driver: AgentDriver = { ...fakeDriver, createTurn: (req, cb) => (seen.push(req), fakeDriver.createTurn(req, cb)) }
  const hostDir = await tempDir('foreman-cloudturn-host-')
  const host = sandboxHost(() => sb, driver, hostDir)
  // The waits asked for between redials (2 s, 4 s, … in the app; short here).
  const redials: number[] = []
  const makeCloud = () => {
    const c = new CloudTurnHost({
      store, sandboxes: manager, secrets, vars: () => options.vars ?? {}, githubToken: () => GH_TOKEN, dir: path.join(hostDir, 'app'), changed: () => undefined, transport: () => host.transport,
      reconnectMs: options.reconnectMs ?? 20_000, connectTimeoutMs: 20_000, recoverRetryMs: options.recoverRetryMs,
      reconnectDelayMs: (attempt) => (redials.push(attempt), Math.min(50 * 2 ** attempt, 400))
    })
    cleanup.push(() => c.close())
    return c
  }
  cloud = makeCloud()
  sessions.cloudHost = cloud
  cloud.bind(sessions)
  const chat = async (sessionId = h.session.id) => sessions.getChat(sessionId)
  const said = (items: ChatItem[]) => items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : []))
  return {
    ...h, sessions, store, fake, sb, ws, manager, host, seen, approvals, ended, chat, said, hostDir, secrets, redials,
    get cloud() {
      return cloud
    },
    advance: (ms: number) => (now += ms),
    /** Foreman quits (the turns go on in the sandbox) and starts again on the same state: a new SessionService and host. */
    restart: async () => {
      await sessions.shutdown()
      cloud.close()
      const next = await setupSessions({ store, ws, events: { turnEnded: (_id, outcome) => void ended.push(outcome) }, workspaces: { gitTarget: (w: Workspace) => manager.runtime(w) } })
      sessions = next.sessions
      cloud = makeCloud()
      sessions.cloudHost = cloud
      cloud.bind(sessions)
      return sessions
    }
  }
}

const gateFile = (dir: string, name: string) => path.join(dir, `gate-${name}`)

describe.skipIf(!probe)('cloud turns in the sandbox host', () => {
  it('streams a turn into the chat with the sandbox’s cwd and credentials, relays an approval and a host-tool call', async () => {
    const r = await rig()
    writeFileSync(r.sb.real(`${CLOUD_CWD}/README.md`), 'hello cloud\n')
    const script = ['say:one', 'approve:Bash', 'diff:README.md', 'say:two'].join('\n')
    await r.sessions.send(r.session.id, script)
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['completed'])
    const items = await r.chat()
    expect(r.said(items)).toEqual(['one', 'approved', expect.stringContaining('+hello cloud'), 'two'])
    expect(r.approvals.map((a) => a.kind === 'tool' && a.toolName)).toEqual(['Bash'])
    expect(r.host.spawned).toBe(1)

    // What the agent got: the sandbox worktree, no local paths, the setup token and GitHub token, never Vercel's.
    const req = r.seen[0]
    expect(req.cwd).toBe(CLOUD_CWD)
    expect(req.executablePath).toBeUndefined()
    expect(req.extraWritableDirs).toBeUndefined()
    expect(req.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN, GH_TOKEN })
    expect(req.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(JSON.stringify(r.seen)).not.toContain(VERCEL_TOKEN)
    // The turn's record is gone once its end was applied.
    expect(r.store.state.hostedTurns).toEqual([])
    expect(items.find((i) => i.kind === 'turn-end')).toMatchObject({ outcome: 'completed' })
    expect(r.ws.cloud!.lastActivityAt).toBeDefined()
  }, 60_000)

  it('saves the turn’s checkpoints in the sandbox from the app’s side: the turn has a delta and Restore to here works', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'checkpoint')
    await r.sessions.send(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    // What the agent does in the sandbox while the turn runs.
    writeFileSync(r.sb.real(`${CLOUD_CWD}/README.md`), 'hello\nfrom the agent\n')
    writeFileSync(r.sb.real(`${CLOUD_CWD}/made.txt`), 'made\n')
    writeFileSync(gate, '')
    await until(() => r.ended.length === 1)
    const items = await r.chat()
    const user = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')!
    expect(user.checkpoint).toBeTruthy()
    const refs = (await git(r.sb.real(CLOUD_CWD), ['for-each-ref', '--format=%(refname)', 'refs/switchyard-checkpoints/'])).stdout
    expect(refs).toContain(`${user.turnId}-start`)
    expect(refs).toContain(`${user.turnId}-end`)
    const end = items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')!
    expect(end.outcome).toBe('completed')
    expect(end.delta?.files.map((f) => f.path).sort()).toEqual(['README.md', 'made.txt'])

    await r.sessions.restore(r.session.id, user.turnId)
    // (The rig clones with this computer's git config, which may check out CRLF.)
    expect(readFileSync(r.sb.real(`${CLOUD_CWD}/README.md`), 'utf8')).toMatch(/^hello\r?\n$/)
    expect(existsSync(r.sb.real(`${CLOUD_CWD}/made.txt`))).toBe(false)
  }, 60_000)

  it('keepalives extend the sandbox’s session while the turn runs, and the idle ticker counts the turn as activity', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'keepalive')
    await r.sessions.send(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    expect(r.cloud.running(r.ws.id)).toBe(true)
    // 10 minutes into a 20-minute session: the next keepalive tops it up, never past Hobby's 45 minutes from the start.
    r.advance(10 * MIN)
    const before = r.sb.expires
    await until(() => r.fake.callsOf('extendTimeout').length > 0)
    expect(r.sb.expires).toBeGreaterThan(before)
    expect(r.sb.expires - r.sb.started).toBeLessThanOrEqual(45 * MIN)
    // Idle sleep never takes a sandbox with a turn running.
    r.advance(5 * MIN)
    await r.manager.tick()
    expect(r.sb.state).toBe('running')
    writeFileSync(gate, '')
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['completed'])
  }, 60_000)

  it('a dropped connection reconnects and picks the turn up after the last event applied', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'drop')
    await r.sessions.send(r.session.id, ['say:one', `gate:${gate}`, 'say:two', 'say:three'].join('\n'))
    await until(() => r.host.servers.length === 1)
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.host.down = true
    r.host.drop()
    writeFileSync(gate, '')
    await new Promise((res) => setTimeout(res, 300))
    r.host.down = false
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['completed'])
    expect(r.said(await r.chat())).toEqual(['one', 'two', 'three'])
    // Still running: the sandbox was never treated as stopped, and the same host kept the turn.
    expect(r.host.spawned).toBe(1)
    // Redials backed off (each costs a status fetch and an attach command), counting up from the first.
    expect(r.redials.length).toBeGreaterThan(0)
    expect(r.redials).toEqual(r.redials.map((_, i) => i))
  }, 60_000)

  it('after the reconnect window, a turn whose sandbox still runs ends as connection-lost, keeps its record, and Reconnect picks it up', async () => {
    const r = await rig({ reconnectMs: 300 })
    const gate = gateFile(r.hostDir, 'lost')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.host.down = true
    r.host.drop()
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['interrupted'])
    const lost = (await r.chat()).find((i) => i.kind === 'turn-end' && i.turnId === turnId)
    expect(lost).toMatchObject({ outcome: 'interrupted', interrupted: 'connection-lost', error: CONNECTION_LOST_REASON })
    // Not the local host's wording, and nothing given up: the agent goes on in the sandbox.
    expect(CONNECTION_LOST_REASON).not.toMatch(/stopped unexpectedly/)
    expect(r.store.state.hostedTurns).toEqual([expect.objectContaining({ turnId, detached: true })])
    expect(r.ws.cloud!.disconnected).toBe(true)
    expect(r.sb.state).toBe('running')
    // Back online: the agent finished meanwhile, and Reconnect (Api.cloudReattach) adopts the turn without relaunching.
    writeFileSync(gate, '')
    r.host.down = false
    await r.cloud.reattach(r.ws.id)
    await until(() => r.ended.length === 2)
    expect(r.ended).toEqual(['interrupted', 'completed'])
    const items = await r.chat()
    expect(r.said(items)).toEqual(['one', 'two'])
    expect(items.filter((i) => i.kind === 'turn-end' && i.turnId === turnId)).toEqual([expect.objectContaining({ outcome: 'completed' })])
    expect(r.store.state.hostedTurns).toEqual([])
    expect(r.ws.cloud!.disconnected).toBeUndefined()
    expect(r.host.spawned).toBe(1)
  }, 60_000)

  it('a message on a chat whose turn lost its connection queues behind that turn when the host still has it', async () => {
    const r = await rig({ reconnectMs: 300 })
    const gate = gateFile(r.hostDir, 'lost-send')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.host.down = true
    r.host.drop()
    await until(() => r.ended.length === 1)
    r.host.down = false
    const receipt = await r.sessions.deliver(r.session.id, 'say:next', { mode: 'queue' })
    // Picked up again, and the new message waits for it: no second agent was started in the sandbox.
    expect(receipt.disposition).toBe('queued')
    expect(r.session.turnId).toBe(turnId)
    expect(r.seen).toHaveLength(1)
    writeFileSync(gate, '')
    await until(() => r.ended.length === 3)
    expect(r.ended).toEqual(['interrupted', 'completed', 'completed'])
    expect(r.seen.map((s) => s.prompt)).toEqual([expect.stringContaining('say:one'), expect.stringContaining('say:next')])
    expect(r.said(await r.chat())).toEqual(['one', 'two', 'next'])
  }, 60_000)

  it('a message on a chat whose lost turn the host no longer has starts a new turn at once', async () => {
    const r = await rig({ reconnectMs: 300 })
    const gate = gateFile(r.hostDir, 'lost-gone')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.host.down = true
    r.host.drop()
    await until(() => r.ended.length === 1)
    // The host went (and its turn with it); a new one answers with no turns.
    await r.host.kill()
    await r.host.transport.spawn()
    r.host.down = false
    const receipt = await r.sessions.deliver(r.session.id, 'say:fresh', { mode: 'queue' })
    expect(receipt.disposition).toBe('started')
    expect((await r.chat()).find((i) => i.kind === 'turn-end' && i.turnId === turnId)).toMatchObject({ outcome: 'interrupted', error: HOST_GONE_REASON })
    await until(() => r.ended.length === 2)
    expect(r.ended).toEqual(['interrupted', 'completed'])
    expect(r.seen.at(-1)?.prompt).toContain('say:fresh')
    expect(r.store.state.hostedTurns).toEqual([])
    expect(r.ws.cloud!.disconnected).toBeUndefined()
  }, 60_000)

  it('a lost turn is picked up by itself on the next status read that finds the sandbox running', async () => {
    const r = await rig({ reconnectMs: 300 })
    const gate = gateFile(r.hostDir, 'lost-auto')
    await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.host.down = true
    r.host.drop()
    await until(() => r.ended.length === 1)
    r.host.down = false
    writeFileSync(gate, '')
    // The window's 30-second poll.
    await r.manager.refreshStatus(r.ws)
    await until(() => r.ended.length === 2)
    expect(r.ended).toEqual(['interrupted', 'completed'])
    expect(r.store.state.hostedTurns).toEqual([])
  }, 60_000)

  it('waits between redials with a growing delay, capped at 15 s', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000])
  })

  it('stops the previous attach command before starting the next, with one status fetch per dial', async () => {
    const r = await rig()
    // A stand-in bridge that never exits by itself.
    await r.sb.writeFile('/vercel/foreman/sandboxAttach.js', 'setInterval(() => undefined, 1000)\n')
    const transport = sandboxTransport(r.manager, r.ws)
    const statuses = r.fake.callsOf('status').length
    const first = await transport.connect()
    const spawned = r.fake.callsOf('spawn').length
    const firstCmd = await r.sb.attachCommand(`cmd_${spawned}`)
    const second = await transport.connect()
    // The first one ended: a dropped connection's bridge doesn't linger in the sandbox.
    expect(await firstCmd.wait()).toMatchObject({ code: expect.any(Number) })
    expect(r.fake.callsOf('status').length - statuses).toBe(2)
    for (const stream of [first, second]) stream.on('error', () => undefined).destroy()
  }, 60_000)

  it('a session that hits the plan’s cap ends the turn as interrupted and, with autoContinue, continues it in a new session', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'cap')
    const first = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    // The plan's 45 minutes run out: the VM stops, and the host and the agent with it.
    r.advance(50 * MIN)
    await r.host.kill()
    r.host.drop()
    await until(() => r.ended.length === 2, 30_000)
    expect(r.ended).toEqual(['interrupted', 'completed'])
    const items = await r.chat()
    const end = items.find((i) => i.kind === 'turn-end' && i.turnId === first)
    expect(end).toMatchObject({ outcome: 'interrupted', interrupted: 'session-cap', error: expect.stringContaining('45-minute session limit') })
    // The continuation: the same chat, the agent's own conversation resumed, in a woken sandbox with a new host.
    const next = items.find((i) => i.kind === 'user' && i.text === CLOUD_CONTINUE_PROMPT)
    expect(next).toBeDefined()
    expect(r.seen.at(-1)?.prompt).toBe(CLOUD_CONTINUE_PROMPT)
    expect(r.seen.at(-1)?.resume).toBe(`agent-${first}`)
    expect(r.fake.callsOf('resume')).toHaveLength(1)
    expect(r.host.spawned).toBe(2)
    expect(r.ws.cloud!.status).toBe('running')
    expect(r.session.lastTurn?.outcome).toBe('completed')
  }, 60_000)

  it('without autoContinue the capped turn just stops, and Continue sends the continuation', async () => {
    const r = await rig({ autoContinue: false })
    const gate = gateFile(r.hostDir, 'cap-off')
    await r.sessions.send(r.session.id, ['say:one', `gate:${gate}`].join('\n'))
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    r.advance(50 * MIN)
    await r.host.kill()
    r.host.drop()
    await until(() => r.ended.length === 1)
    await new Promise((res) => setTimeout(res, 200))
    expect(r.ended).toEqual(['interrupted'])
    expect(r.session.queue).toEqual([])
    expect(r.ws.cloud!.status).toBe('capped')
    // The turn's end is recorded and nothing runs: the next poll leaves it capped (Continue stays, wake on open doesn't fire).
    expect((await r.manager.refreshStatus(r.ws)).status).toBe('capped')
    const receipt = await r.cloud.continueSession(r.session.id)
    expect(receipt.disposition).toBe('started')
    await until(() => r.ended.length === 2)
    expect(r.ended).toEqual(['interrupted', 'completed'])
    expect(r.seen.at(-1)?.prompt).toBe(CLOUD_CONTINUE_PROMPT)
  }, 60_000)

  it('after a restart, re-adopts a turn still running in the sandbox', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'recover')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    expect(r.store.state.hostedTurns).toEqual([expect.objectContaining({ turnId, cloud: true })])
    const sessions = await r.restart()
    writeFileSync(gate, '')
    await r.cloud.recover()
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['completed'])
    expect(r.said(await sessions.getChat(r.session.id))).toEqual(['one', 'two'])
    expect(r.store.state.hostedTurns).toEqual([])
    expect(r.host.spawned).toBe(1)
  }, 60_000)

  it('after a restart, a sandbox it can’t reach yet keeps the turn and tries again', async () => {
    const r = await rig({ recoverRetryMs: [100, 100] })
    const gate = gateFile(r.hostDir, 'recover-retry')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`, 'say:two'].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    const sessions = await r.restart()
    // Vercel doesn't answer on launch.
    r.fake.failNext('get', new Error('ECONNRESET'))
    await r.cloud.recover()
    expect(r.store.state.hostedTurns).toEqual([expect.objectContaining({ turnId })])
    expect(r.ended).toEqual([])
    expect((await sessions.getChat(r.session.id)).some((i) => i.kind === 'turn-end')).toBe(false)
    // The retry finds it running and adopts the turn.
    writeFileSync(gate, '')
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['completed'])
    expect(r.said(await sessions.getChat(r.session.id))).toEqual(['one', 'two'])
    expect(r.store.state.hostedTurns).toEqual([])
  }, 60_000)

  it('after a restart, a sandbox that hit its cap ends the turn at the limit, and one that is gone marks the workspace', async () => {
    const r = await rig()
    const gate = gateFile(r.hostDir, 'recover-cap')
    const turnId = (await r.sessions.deliver(r.session.id, ['say:one', `gate:${gate}`].join('\n'))).turnId!
    for (let i = 0; i < 400 && !r.said(await r.chat()).includes('one'); i++) await new Promise((res) => setTimeout(res, 20))
    await r.restart()
    // While Foreman was closed the session ran out.
    r.advance(50 * MIN)
    await r.host.kill()
    await r.cloud.recover()
    const end = (await r.chat()).find((i) => i.kind === 'turn-end' && i.turnId === turnId)
    expect(end).toMatchObject({ outcome: 'interrupted', interrupted: 'session-cap' })
    // Nobody was there to continue: the chat offers Continue instead.
    expect(r.session.queue).toEqual([])
    expect(r.store.state.hostedTurns).toEqual([])
    expect(r.fake.callsOf('resume')).toHaveLength(0)
    expect(r.ws.cloud!.status).toBe('capped')

    // A record whose sandbox was deleted.
    r.session.status = 'running'
    r.session.turnId = 'lost-turn'
    r.store.state.hostedTurns = [{ sessionId: r.session.id, turnId: 'lost-turn', agent: 'claude', startedAt: new Date().toISOString(), seq: 2, cloud: true }]
    await r.sb.delete()
    await r.cloud.recover()
    expect(r.ws.state).toBe('error')
    expect(r.ws.error).toBe(SANDBOX_GONE_REASON)
    expect((await r.chat()).find((i) => i.kind === 'turn-end' && i.turnId === 'lost-turn')).toMatchObject({ outcome: 'interrupted', error: SANDBOX_GONE_REASON })
  }, 60_000)

  it('refuses Cursor in a cloud workspace with a clear message', async () => {
    const r = await rig()
    const tab = r.sessions.createSession(r.ws.id, { agent: 'cursor', title: 'cursor' })
    await r.sessions.send(tab.id, 'say:hi')
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['error'])
    const items = await r.sessions.getChat(tab.id)
    expect(items.find((i) => i.kind === 'notice' && i.level === 'error')).toMatchObject({ text: expect.stringContaining('Cursor can’t run in a cloud workspace') })
    expect(r.host.spawned).toBe(0)
    expect(r.cloud.keeps('codex', r.ws)).toBe(true)
    expect(r.cloud.keeps('opencode', r.ws)).toBe(true)
    expect(r.cloud.keeps('claude', { ...r.ws, cloud: undefined })).toBe(false)
  }, 60_000)

  it('a missing Claude credential fails the turn before anything starts in the sandbox, without waking it', async () => {
    const r = await rig()
    r.store.state.settings.cloud = patchCloudSettings(r.store.state.settings, { claudeAuth: 'api-key' })
    await r.manager.sleep(r.ws)
    await r.sessions.send(r.session.id, 'say:hi')
    await until(() => r.ended.length === 1)
    expect(r.ended).toEqual(['error'])
    const notice = (await r.chat()).find((i) => i.kind === 'notice' && i.level === 'error')
    expect(notice).toMatchObject({ text: expect.stringContaining('API key') })
    expect(r.host.spawned).toBe(0)
    expect(existsSync(r.sb.real('/vercel/foreman/state'))).toBe(false)
    // No start checkpoint, no session started for nothing.
    expect(r.fake.callsOf('resume')).toHaveLength(0)
    expect(r.ws.cloud!.status).toBe('sleeping')
  }, 60_000)

  it('never gives an agent the Vercel token or integration secrets, even from Settings → Environment', async () => {
    const vars = { VERCEL_TOKEN, 'integration:vc1': 'secret', ANTHROPIC_API_KEY: 'sk-ant-from-env', CODEX_API_KEY: 'codex-from-env', MY_VAR: 'mine' }
    const r = await rig({ vars })
    r.secrets.setProviderKey('OPENAI_API_KEY', 'provider-key')
    const env = (agent: string, base: Record<string, string> = {}) => (r.cloud as unknown as { turnEnv(a: string, w: Workspace, b: Record<string, string>): Record<string, string> }).turnEnv(agent, r.ws, base)
    for (const agent of ['claude', 'codex', 'opencode', 'gemini']) {
      const got = env(agent, { VERCEL_TOKEN, TURN: 'x' })
      expect(got.VERCEL_TOKEN, agent).toBeUndefined()
      expect(got['integration:vc1'], agent).toBeUndefined()
      expect(JSON.stringify(got), agent).not.toContain(VERCEL_TOKEN)
      expect(got, agent).toMatchObject({ MY_VAR: 'mine', TURN: 'x', GH_TOKEN })
    }
    // OpenCode: the turn's variables over Settings → Environment over the provider keys, as the other agents.
    expect(env('opencode', { MY_VAR: 'turn' })).toMatchObject({ MY_VAR: 'turn', OPENAI_API_KEY: 'provider-key' })
  }, 60_000)
})
