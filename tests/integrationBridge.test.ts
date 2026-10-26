// The integration bridge end to end: an agent's `foreman mcp-bridge linear` (src/cli/bridge.ts)
// pipes MCP JSON-RPC over the app's real CLI socket server to the bridge, which checks the grant
// and forwards allowed calls to a hosted MCP server, here a real MCP server over Streamable HTTP
// standing in for Linear's. The key never appears in what agents are given.
import http from 'node:http'
import type net from 'node:net'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBridge } from '../src/cli/bridge'
import { socketPath } from '../src/cli/protocol'
import { startCliServer, type CliHost } from '../src/main/cliServer'
import { Environment } from '../src/main/environment'
import { IntegrationBridge, sdkUpstream } from '../src/main/integrationBridge'
import { Integrations, secretKey } from '../src/main/integrations'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { Repo } from '../src/shared/types'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

// ---- a stand-in for Linear's hosted MCP server ----

interface Upstream {
  url: string
  auth: string[]
  calls: string[]
  close(): Promise<void>
}

async function fakeLinear(key: string): Promise<Upstream> {
  const auth: string[] = []
  const calls: string[] = []
  const server = http.createServer(async (req, res) => {
    auth.push(String(req.headers.authorization ?? ''))
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end()
      return
    }
    const mcp = new Server({ name: 'fake-linear', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'get_issue', description: 'Read an issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
        { name: 'save_comment', description: 'Comment on an issue', inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } } }
      ]
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(`${req.url} ${request.params.name}`)
      return { content: [{ type: 'text', text: `${request.params.name} ${JSON.stringify(request.params.arguments)}` }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => void transport.close())
    await mcp.connect(transport)
    let body = ''
    for await (const chunk of req) body += chunk
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    auth,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

// ---- the app side ----

async function rig() {
  const dir = await tempDir('foreman-bridge-')
  const store = new Store(dir)
  await store.load()
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), plain)
  const root = await tempDir('foreman-bridge-repo-')
  store.state.repos.push({ id: 'r', name: 'web', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as Repo)
  const repo = (id: string) => {
    const r = store.state.repos.find((x) => x.id === id)
    if (!r) throw new Error('no repo')
    return r
  }
  const environment = new Environment(secrets, () => store.state.settings, repo)
  const linearOrg = (key: string) => (key.startsWith('lin_acme') ? { id: 'org-acme', name: 'Acme', urlKey: 'acme' } : { id: 'org-me', name: 'Lab', urlKey: 'lab' })
  const slackPosts: Record<string, unknown>[] = []
  const fetchStub = (async (_url: string, init: RequestInit) => {
    if (String(_url).startsWith('https://slack.com/api/')) {
      if (String(_url).includes('auth.test')) return Response.json({ ok: true, team: 'Acme', team_id: 'T1', user: 'foreman', user_id: 'UBOT' })
      slackPosts.push(JSON.parse(String(init.body)))
      return Response.json({ ok: true, channel: 'C1', ts: '1.2' })
    }
    const key = new Headers(init.headers).get('authorization') ?? ''
    const q = JSON.parse(String(init.body)).query as string
    const body = q.includes('integrations') ? { data: { integrations: { nodes: [] } } } : { data: { viewer: { id: 'u', name: 'Yatin', organization: linearOrg(key) } } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  const integrations = new Integrations({
    store,
    secrets,
    repo,
    repoGithubToken: (id) => environment.repoGithubToken(id),
    remoteUrl: async () => null,
    githubAccounts: async () => [],
    accountToken: () => '',
    activeLogin: async () => undefined,
    changed: () => undefined,
    fetch: fetchStub,
    home: dir
  })
  return { dir, store, secrets, integrations, slackPosts, fetch: fetchStub }
}

describe('the integration bridge', () => {
  let upstream: Upstream
  let cli: net.Server | null = null
  let bridges: IntegrationBridge[] = []
  beforeEach(async () => {
    upstream = await fakeLinear('lin_acme')
  })
  afterEach(async () => {
    await Promise.all(bridges.map((b) => b.close()))
    bridges = []
    await upstream.close()
    await new Promise<void>((r) => (cli ? cli.close(() => r()) : r()))
    cli = null
  })

  async function setup(platform: NodeJS.Platform = 'darwin') {
    const r = await rig()
    const added = await r.integrations.addConnection({ service: 'linear', name: 'Acme Linear', auth: { kind: 'token' }, token: 'lin_acme' })
    if (!added.ok) throw new Error(added.error)
    const urls: string[] = []
    const socket = socketPath(r.dir)
    const bridge = new IntegrationBridge({
      integrations: r.integrations,
      // The bridge policy is POSIX-only today; exercise that policy over the host's
      // native socket transport, and cover the Windows refusal separately below.
      platform,
      launch: () => ({ command: '/Applications/Foreman.app/Contents/MacOS/Foreman', args: ['/app.asar/out/main/cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
      socket: () => socket,
      fetch: r.fetch,
      // Linear's URLs, served by the stand-in (the path says which endpoint was asked for).
      upstream: (url, token) => {
        urls.push(url)
        return sdkUpstream(`${upstream.url}${new URL(url).pathname}`, token)
      }
    })
    bridges.push(bridge)
    const attach: NonNullable<CliHost['bridge']> = (conn, params, rest) => bridge.attach(conn, params, rest)
    cli = await startCliServer(socket, { bridge: attach } as CliHost)
    return { ...r, bridge, connection: added.connection, urls, socket }
  }

  /** Start `foreman mcp-bridge linear` as an agent would, and talk MCP to it. */
  function agent(env: Record<string, string>, service = 'linear') {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const lines: Record<string, unknown>[] = []
    let buffer = ''
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, end)))
        buffer = buffer.slice(end + 1)
      }
    })
    const done = runBridge(service, env, { stdin, stdout })
    let id = 0
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const mine = ++id
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`)
      for (let i = 0; i < 400; i++) {
        const hit = lines.find((l) => l.id === mine)
        if (hit) return hit as { result?: Record<string, unknown>; error?: { message: string } }
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error(`no reply to ${method}`)
    }
    return { call, close: () => (stdin.end(), done) }
  }

  const turnInput = { sessionId: 's1', workspaceId: 'w1', repoId: 'r', cwd: '/w', supportsMcp: true }

  it('keeps managed bridge tools unavailable on Windows', async () => {
    const { bridge } = await setup('win32')
    const turn = bridge.forTurn(turnInput)
    expect(turn.servers).toEqual({})
    expect(turn.notes.join(' ')).toContain('tools aren’t available to this agent')
  })

  it('Slack is opt-in and can post only to allowed channels, without leaking its token', async () => {
    const { bridge, integrations, slackPosts } = await setup()
    const added = await integrations.addConnection({ service: 'slack', auth: { kind: 'token' }, token: 'xoxb-private' })
    if (!added.ok) throw new Error(added.error)
    expect(bridge.forTurn(turnInput).servers['foreman-slack']).toBeUndefined()
    await integrations.updateConnection(added.connection.id, { agentAccess: 'write', destinations: [{ id: 'C1', name: 'review' }] })
    const turn = bridge.forTurn(turnInput)
    expect(JSON.stringify(turn.servers)).not.toContain('xoxb-private')
    const s = agent(turn.servers['foreman-slack'].env, 'slack')
    const list = await s.call('tools/list')
    expect((list.result!.tools as { name: string }[]).map((t) => t.name)).toEqual(['slack_post'])
    expect((await s.call('tools/call', { name: 'slack_post', arguments: { channel: 'UOTHER', text: 'hello' } })).result).toMatchObject({ isError: true })
    expect((await s.call('tools/call', { name: 'slack_post', arguments: { channel: 'C1', text: '<!here> hi' } })).result).not.toHaveProperty('isError', true)
    expect(slackPosts).toEqual([expect.objectContaining({ channel: 'C1', text: '&lt;!here&gt; hi' })])
    await s.close()
  })

  it('gives agents a bridge server that holds no key, and forwards only read tools for a read-only connection', async () => {
    const { bridge } = await setup()
    const turn = bridge.forTurn(turnInput)
    const server = turn.servers['foreman-linear']
    expect(server.command).toBe('/Applications/Foreman.app/Contents/MacOS/Foreman')
    expect(server.args).toEqual(['/app.asar/out/main/cli.js', 'mcp-bridge', 'linear'])
    expect(JSON.stringify(turn.servers)).not.toContain('lin_acme')
    expect(turn.notes.join(' ')).toMatch(/foreman-linear MCP server.*“Acme Linear” \(Acme\), read only/)

    const a = agent(server.env)
    const init = await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } })
    expect(init.result).toMatchObject({ serverInfo: { name: 'foreman-linear' } })
    const list = await a.call('tools/list')
    expect((list.result!.tools as { name: string }[]).map((t) => t.name)).toEqual(['get_issue'])
    const read = await a.call('tools/call', { name: 'get_issue', arguments: { id: 'ENG-1' } })
    expect(read.result).toMatchObject({ content: [{ type: 'text', text: 'get_issue {"id":"ENG-1"}' }] })
    const write = await a.call('tools/call', { name: 'save_comment', arguments: { id: 'ENG-1', body: 'hi' } })
    expect(write.result).toMatchObject({ isError: true })
    expect(String((write.result!.content as { text: string }[])[0].text)).toMatch(/may only read/)
    await a.close()

    // Read-only goes to Linear's read-only endpoint, with the key as a bearer token, and nothing else wrote.
    expect(upstream.calls).toEqual(['/mcp/readonly get_issue'])
    expect(upstream.auth.every((h) => h === 'Bearer lin_acme')).toBe(true)
    expect(bridge.activity('r').map((x) => [x.tool, x.ok])).toEqual([
      ['save_comment', false],
      ['get_issue', true]
    ])
  })

  it('takes write access from the next turn, never in the middle of one', async () => {
    const { bridge, integrations, connection } = await setup()
    const first = bridge.forTurn(turnInput)
    await integrations.updateConnection(connection.id, { agentAccess: 'write' })
    const a = agent(first.servers['foreman-linear'].env)
    await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const during = await a.call('tools/call', { name: 'save_comment', arguments: { id: 'ENG-1' } })
    expect(during.result).toMatchObject({ isError: true })
    // The next turn starts with a fresh capability. The old process cannot acquire it.
    const next = bridge.forTurn(turnInput)
    expect(next.servers['foreman-linear'].env.FOREMAN_BRIDGE_GRANT).not.toBe(first.servers['foreman-linear'].env.FOREMAN_BRIDGE_GRANT)
    expect((await a.call('tools/call', { name: 'save_comment' })).result).toMatchObject({ isError: true })
    await a.close()
    const b = agent(next.servers['foreman-linear'].env)
    await b.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const after = await b.call('tools/call', { name: 'save_comment', arguments: { id: 'ENG-1' } })
    expect(after.result).toMatchObject({ content: [{ text: expect.stringContaining('save_comment') }] })
    await b.close()
    expect(upstream.calls).toEqual(['/mcp save_comment'])
  })

  it('refuses a call once the repository switched accounts, or the key was revoked', async () => {
    const { bridge, integrations, secrets } = await setup()
    const turn = bridge.forTurn(turnInput)
    const personal = await integrations.addConnection({ service: 'linear', auth: { kind: 'token' }, token: 'lin_mine' })
    if (!personal.ok) throw new Error('setup')
    const a = agent(turn.servers['foreman-linear'].env)
    await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    integrations.setRepoChoice('r', 'linear', personal.connection.id)
    const switched = await a.call('tools/call', { name: 'get_issue', arguments: { id: 'ENG-1' } })
    expect(String((switched.result!.content as { text: string }[])[0].text)).toMatch(/changed for this repository/)
    // Back to Acme, then its key is refused by Linear: the connection needs attention and the call says so.
    integrations.setRepoChoice('r', 'linear', 'default')
    secrets.setAppSecret(secretKey(integrations.state().defaults.linear!), 'lin_revoked')
    await integrations.updateConnection(integrations.state().defaults.linear!, { agentAccess: 'read' })
    const refused = await a.call('tools/call', { name: 'get_issue', arguments: { id: 'ENG-1' } })
    expect(refused.result).toMatchObject({ isError: true })
    await a.close()
    expect(upstream.calls).toEqual([])
  })

  it('answers by itself when the grant is unknown or Foreman is closed', async () => {
    const { bridge, socket } = await setup()
    const stale = agent({ FOREMAN_BRIDGE_SOCKET: socket, FOREMAN_BRIDGE_GRANT: 'not-a-grant' })
    await stale.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    const r1 = await stale.call('tools/call', { name: 'get_issue', arguments: {} })
    expect(String((r1.result!.content as { text: string }[])[0].text)).toMatch(/access for this turn has ended/)
    await stale.close()

    const turn = bridge.forTurn(turnInput)
    await new Promise<void>((r) => cli!.close(() => r()))
    cli = null
    const closed = agent(turn.servers['foreman-linear'].env)
    const init = await closed.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(init.result).toMatchObject({ serverInfo: { name: 'foreman-linear' } })
    const r2 = await closed.call('tools/call', { name: 'get_issue', arguments: {} })
    expect(String((r2.result!.content as { text: string }[])[0].text)).toMatch(/unavailable while Foreman is closed/)
    expect((await closed.call('tools/list')).result).toEqual({ tools: [] })
    await closed.close()
  })

  it('ends a tab’s grant when it closes, and gives probes a grant that can only list', async () => {
    const { bridge } = await setup()
    const probe = bridge.probeServers(turnInput)
    const p = agent(probe['foreman-linear'].env)
    await p.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(((await p.call('tools/list')).result!.tools as unknown[]).length).toBe(1)
    expect((await p.call('tools/call', { name: 'get_issue', arguments: {} })).result).toMatchObject({ isError: true })
    await p.close()
    const turn = bridge.forTurn(turnInput)
    bridge.endSession('s1')
    const a = agent(turn.servers['foreman-linear'].env)
    await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(String(((await a.call('tools/call', { name: 'get_issue', arguments: {} })).result!.content as { text: string }[])[0].text)).toMatch(/has ended/)
    await a.close()
  })

  it('switches off the user’s own Linear servers where Foreman provides Linear, per agent, unless allowed', async () => {
    const { bridge, integrations, dir } = await setup()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } }))
    await mkdir(path.join(dir, '.codex'), { recursive: true })
    await writeFile(path.join(dir, '.codex', 'config.toml'), '[mcp_servers.linear-work]\nurl = "https://mcp.linear.app/mcp"\n')
    const prev = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
    try {
      const turn = bridge.forTurn(turnInput)
      expect(IntegrationBridge.blockedFor('claude', turn.blocked).claude.sort()).toEqual(['claude_ai_Linear', 'linear'])
      expect(IntegrationBridge.blockedFor('codex', turn.blocked).codex).toEqual(['linear-work'])
      expect(IntegrationBridge.blockedFor('opencode', turn.blocked)).toEqual({ claude: [], codex: [] })
      integrations.setRepoOptions('r', { allowOwnMcp: ['linear'] })
      expect(bridge.forTurn(turnInput).blocked).toEqual([])
      // Where Foreman doesn't provide Linear, the user's own servers are left alone.
      integrations.setRepoOptions('r', { allowOwnMcp: [] })
      integrations.setRepoChoice('r', 'linear', 'off')
      expect(bridge.forTurn(turnInput).blocked.filter((s) => s.service === 'linear')).toEqual([])
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev
    }
  })

  it('gives nothing to agents that take no MCP servers, and says so in their instructions', async () => {
    const { bridge } = await setup()
    const turn = bridge.forTurn({ ...turnInput, supportsMcp: false })
    expect(turn.servers).toEqual({})
    expect(turn.notes).toEqual(['Linear tools aren’t available to this agent.'])
  })
})
