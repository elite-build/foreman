import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForemanActions } from '../src/main/foremanActions'
import { ForemanMcp } from '../src/main/foremanMcp'
import { startCliServer } from '../src/main/cli/server'
import { runBridge } from '../src/cli/bridge'
import type { Session, Workspace, RunChecksOutcome } from '../src/shared/types'
import { stubHost } from './cliHost'
import { tempDir } from './helpers'
import { setupSessions, fakeDriver, gate } from './sessionHarness'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnRequest } from '../src/main/agents/types'
import type { ForemanDelegation } from '../src/main/foremanDelegation'
import { delegationRig } from './foremanDelegationHarness'
import { ForemanCli } from '../src/main/foremanCli'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterEach(() => { registerDriver(claudeDriver); vi.restoreAllMocks() })

function rig() {
  const ws: Workspace = { id: 'w', repoId: 'r', name: 'Work', branch: 'task', baseBranch: 'main', portBase: 50030, createdAt: '', state: 'ready', setupRun: {
    id: 'setup', startedAt: '', steps: [{ name: 'install', command: 'secret-command', status: 'done', exitCode: 0 }]
  } }
  const session = { id: 's', workspaceId: 'w', status: 'running', agent: 'claude', planMode: false } as Session
  const state = { workspaces: [ws], sessions: [session] }
  const api = {
    checksStatus: vi.fn(async () => ({ configured: true, running: false, rows: [] })),
    runChecks: vi.fn(async (): Promise<RunChecksOutcome> => ({ started: true })),
    openPreview: vi.fn(async () => {})
  }
  const actions = new ForemanActions({ state: () => state, api })
  return { ws, session, state, api, actions }
}

function agent(env: Record<string, string>) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const lines: { id: number; result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown }[] = []
  let buffer = ''
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
    }
  })
  const done = runBridge('app', env, { stdin, stdout })
  cleanup.push(async () => { stdin.end(); await done })
  let id = 0
  return async (method: string, params = {}) => {
    const mine = ++id
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`)
    await vi.waitFor(() => expect(lines.some((l) => l.id === mine)).toBe(true))
    return lines.find((l) => l.id === mine)!
  }
}

async function setup(delegation?: ForemanDelegation, cli?: ForemanCli) {
  const r = rig()
  const dir = await tempDir('foreman-app-mcp-')
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\foreman-test-${randomUUID()}` : path.join(dir, 'cli.sock')
  const bridge = new ForemanMcp({ actions: r.actions, session: (id) => r.state.sessions.find((s) => s.id === id),
    launch: () => ({ command: 'foreman-test', args: [], env: {} }), socket: () => socket })
  bridge.delegation = delegation
  bridge.cli = cli
  const server = await startCliServer(socket, stubHost({ bridge: (conn, params, rest) => bridge.attach(conn, params, rest) }))
  cleanup.push(() => new Promise<void>((resolve) => { bridge.close(); server.close(() => resolve()) }))
  const config = bridge.forTurn(r.session, false)['foreman-app']
  const call = agent(config.env)
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  return { ...r, bridge, config, call, socket }
}

describe('Foreman actions', () => {
  it('restricts workspace scope, arguments, availability and writes independently of tool discovery', async () => {
    const { actions, api, ws } = rig()
    const scope = { workspaceId: 'w', readOnly: false }
    await expect(actions.call('get_workspace_status', { workspaceId: 'other' }, scope)).rejects.toThrow('own workspace')
    await expect(actions.call('run_checks', { workspaceId: 'w', approve: true }, scope)).rejects.toThrow()
    await expect(actions.call('run_checks', { workspaceId: 'w' }, { ...scope, readOnly: true })).rejects.toThrow('only read')
    expect(api.runChecks).not.toHaveBeenCalled()
    const status = await actions.call('get_workspace_status', { workspaceId: 'w' }, scope)
    expect(JSON.stringify(status)).not.toContain('secret-command')
    expect(status).toMatchObject({ setup: { steps: [{ name: 'install', status: 'done', exitCode: 0 }] } })
    ws.state = 'archived'
    await expect(actions.call('open_preview', { workspaceId: 'w' }, scope)).rejects.toThrow('no longer available')
    expect(api.openPreview).not.toHaveBeenCalled()
  })

  it('preserves check consent and returns progress without waiting for completion', async () => {
    const { actions, api } = rig()
    api.runChecks.mockResolvedValueOnce({ started: false, consent: [{ name: 'test', command: 'private-command', source: 'shared' }] })
    const scope = { readOnly: false }
    expect(await actions.call('run_checks', { workspaceId: 'w' }, scope)).toMatchObject({ started: false, needsConsent: ['test'] })
    expect(api.runChecks).toHaveBeenCalledWith('w')
    expect(await actions.call('run_checks', { workspaceId: 'w' }, scope)).toEqual({ workspaceId: 'w', started: true })
    await actions.call('get_check_results', { workspaceId: 'w' }, scope)
    expect(api.checksStatus).toHaveBeenCalledWith('w')
  })
})

describe('Foreman MCP over the local CLI socket', () => {
  it('exposes the CLI fallback beside dedicated tools over the real transport without granting writes', async () => {
    const d = delegationRig()
    const { call, session, bridge, config } = await setup(d.service, new ForemanCli(d.host))
    const names = (await call('tools/list')).result?.tools?.map((t) => t.name)
    expect(names).toContain('run_foreman')
    expect(names).toContain('start_task')
    const read = await call('tools/call', { name: 'run_foreman', arguments: { args: ['settings', 'get', 'appearance.theme'] } })
    expect(read.result?.isError).not.toBe(true)
    expect(JSON.stringify(read)).toContain('appearance.theme')
    session.planMode = true
    expect((await call('tools/call', { name: 'run_foreman', arguments: { args: ['settings', 'set', 'appearance.theme', 'dark'] } })).result?.isError).toBe(true)
    bridge.endSession('s')
    const stale = agent(config.env)
    expect((await stale('tools/call', { name: 'run_foreman', arguments: { args: ['settings', 'list'] } })).result?.isError).toBe(true)
  })

  it('passes typed delegation tools through the real bridge, enforcing opt-in and grant revocation', async () => {
    const d = delegationRig()
    const { call, bridge } = await setup(d.service)
    expect((await call('tools/list')).result?.tools?.map((t) => t.name)).toContain('start_task')
    d.allowed.value = false
    expect((await call('tools/call', { name: 'start_task', arguments: { prompt: 'Research', loadout: 1 } })).result?.isError).toBe(true)
    expect(d.createWorkspace).not.toHaveBeenCalled()
    d.allowed.value = true
    expect((await call('tools/call', { name: 'start_task', arguments: { prompt: 'Research', loadout: 1 } })).result?.isError).not.toBe(true)
    expect(d.createWorkspace).toHaveBeenCalledTimes(1)
    const child = d.state.workspaces[1]
    d.turns.set('child', { workspaceId: child.id, sessionId: d.state.sessions[1].id, turnId: 'child', state: 'running' })
    const status = vi.spyOn(d.host, 'turnStatus')
    const pending = call('tools/call', { name: 'wait_for_turn', arguments: { turnId: 'child', timeoutSeconds: 30 } })
    await vi.waitFor(() => expect(status).toHaveBeenCalled())
    bridge.endSession('s')
    expect((await pending).result?.isError).toBe(true)
    expect(d.cancelTurn).not.toHaveBeenCalled()
  })

  it('exposes scoped tools, rejects extra arguments, and runs the existing services', async () => {
    const { call, api } = await setup()
    expect((await call('tools/list')).result?.tools?.map((t) => t.name)).toEqual(['get_workspace_status', 'get_check_results', 'open_preview', 'run_checks'])
    expect((await call('tools/call', { name: 'open_preview', arguments: { workspaceId: 'other' } })).result?.isError).toBe(true)
    expect(api.openPreview).not.toHaveBeenCalled()
    expect((await call('tools/call', { name: 'run_checks', arguments: { approve: true } })).result?.isError).toBe(true)
    expect((await call('tools/call', { name: 'open_preview', arguments: {} })).result?.isError).not.toBe(true)
    expect(api.openPreview).toHaveBeenCalledWith('w')
    await call('tools/call', { name: 'run_checks', arguments: {} })
    expect(api.runChecks).toHaveBeenCalledWith('w')
  })

  it('enforces live read-only state and revokes old processes and grants at turn end', async () => {
    const { call, session, api, bridge, config } = await setup()
    session.planMode = true
    expect((await call('tools/call', { name: 'run_checks', arguments: {} })).result?.isError).toBe(true)
    expect(api.runChecks).not.toHaveBeenCalled()
    const next = bridge.forTurn(session, false)['foreman-app']
    const fresh = agent(next.env)
    expect((await fresh('tools/list')).result?.tools?.map((t) => t.name)).toEqual(['get_workspace_status', 'get_check_results'])
    const stale = agent(config.env)
    expect((await stale('tools/call', { name: 'open_preview' })).result?.isError).toBe(true)
    bridge.endSession(session.id)
    expect((await fresh('tools/call', { name: 'get_workspace_status' })).result?.isError).toBe(true)
  })

  it('refuses absent grants, closed sessions and archived workspaces; does not provision cloud turns', async () => {
    const { bridge, config, call, session, ws } = await setup()
    const unknown = agent({ ...config.env, FOREMAN_BRIDGE_GRANT: randomUUID() })
    expect((await unknown('tools/list')).result?.tools).toEqual([])
    ws.state = 'archived'
    expect((await call('tools/call', { name: 'get_workspace_status' })).result?.isError).toBe(true)
    session.closedAt = 'now'
    expect((await call('tools/call', { name: 'open_preview' })).result?.isError).toBe(true)
    expect(bridge.forTurn(session, true)).toEqual({})
  })

  it('accepts MCP initialization coalesced with the socket handshake', async () => {
    const { config, socket } = await setup()
    const conn = net.createConnection(socket)
    cleanup.push(() => { conn.destroy() })
    let response = ''
    conn.on('data', (chunk) => { response += chunk.toString() })
    conn.write(`${JSON.stringify({ method: 'mcp-bridge', params: { service: 'app', grant: config.env.FOREMAN_BRIDGE_GRANT } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
    await vi.waitFor(() => expect(response).toContain('foreman-app'))
  })
})

describe('workspace turn lifecycle', () => {
  it('injects the bridge into agent requests and revokes it on completion and failed startup', async () => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const { sessions, session, store } = await setupSessions({ events: { turnEnded: () => finish() } })
    const bridge = new ForemanMcp({ actions: rig().actions, session: (id) => store.state.sessions.find((s) => s.id === id),
      launch: () => ({ command: 'foreman-test', args: [], env: {} }), socket: () => 'test-socket' })
    cleanup.push(() => bridge.close())
    sessions.foremanMcp = bridge
    const revoke = vi.spyOn(bridge, 'endSession')
    const held = gate()
    let request: TurnRequest | undefined
    registerDriver(fakeDriver(async (req, cb, signal) => { request = req; await held.script(req, cb, signal) }))
    await sessions.send(session.id, 'Inspect my workspace')
    expect(request?.mcpServers?.['foreman-app'].env.FOREMAN_BRIDGE_GRANT).toBeTruthy()
    revoke.mockClear()
    held.release()
    await finished
    expect(revoke).toHaveBeenCalledWith(session.id)
    registerDriver({ ...claudeDriver, createTurn: () => { throw new Error('startup failed') } })
    revoke.mockClear()
    await sessions.send(session.id, 'Try again')
    expect((await sessions.getChat(session.id)).some((item) => item.kind === 'turn-end' && item.error === 'startup failed')).toBe(true)
    // forTurn revokes the preceding grant, and the startup catch revokes the newly minted one.
    expect(revoke).toHaveBeenCalledTimes(2)
  })
})
