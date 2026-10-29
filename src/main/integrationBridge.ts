// The integration bridge. Each turn of an agent that takes stdio
// MCP servers gets `foreman-linear` (and `foreman-slack`, `foreman-langfuse`), whose command is Foreman's own CLI in bridge mode. The CLI
// holds no credential: it shows this table's grant id over the app's owner-only socket, and the
// app answers MCP requests, forwarding allowed tool calls to Linear's hosted MCP with the real
// key. So the key never reaches an agent, an MCP server process or argv; the grant id does
// (agents put MCP config on their command line), which is why it's scoped, checked on every call
// against the repository's connection as it is now, and dropped when the session closes.
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import type { McpLaunch } from './agents/types'
import {
  bridgeServerName,
  changedIdentities,
  INTEGRATION_SERVICES,
  LINEAR_MCP_READONLY_URL,
  LINEAR_MCP_URL,
  snapshotOf,
  slackEscape,
  ownServerService,
  SERVICE_LABELS,
  toolAllowed,
  type AgentAccess,
  type BridgeActivity,
  type Connection,
  type IntegrationService,
  type IntegrationSnapshot,
  type OwnMcpServer
} from '../shared/integrations'
import type { Integrations } from './integrations'
import { LANGFUSE_TOOLS, langfuseCall, LangfuseError } from './langfuse'
import { isAuthError, slackPost } from './slack'

export interface UpstreamTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  title?: string
}

export interface Upstream {
  listTools(): Promise<UpstreamTool[]>
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<Record<string, unknown>>
  close(): Promise<void>
}

/** Opens an MCP session to a hosted server with a bearer token. */
export type UpstreamFactory = (url: string, token: string) => Promise<Upstream>

export const sdkUpstream: UpstreamFactory = async (url, token) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'foreman', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' } }))
  return {
    listTools: async () => (await client.listTools()).tools as UpstreamTool[],
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as Record<string, unknown>,
    close: () => client.close()
  }
}

interface Grant {
  id: string
  sessionId: string
  workspaceId: string
  repoId: string
  service: IntegrationService
  // What the latest turn started with: a call uses this connection or none (never another account).
  connectionId: string
  rev: number
  access: AgentAccess
  // A probe-only grant (idle MCP status) may list tools and nothing else.
  probe?: boolean
}

export interface BridgeDeps {
  integrations: Integrations
  platform?: NodeJS.Platform
  // How to start `foreman mcp-bridge`: an absolute executable, never `foreman` on PATH.
  launch: () => { command: string; args: string[]; env: Record<string, string> } | null
  socket: () => string | null
  upstream?: UpstreamFactory
  now?: () => number
  fetch?: typeof fetch
}

export interface TurnIntegrations {
  servers: Record<string, McpLaunch>
  // The user's own servers for services Foreman resolves here, switched off for this turn.
  blocked: OwnMcpServer[]
  snapshot: IntegrationSnapshot[]
  // Services whose identity changed since this tab's last turn, for the receipt.
  changed: { service: IntegrationService; was?: string; now?: string }[]
  // Lines for the agent's instructions: what it can use, and what is off and why.
  notes: string[]
}

const LABEL = SERVICE_LABELS
// Agents get tools through the bridge for these services (GitHub's hosted MCP comes later).
const BRIDGED: IntegrationService[] = ['linear', 'slack', 'langfuse']
const ACTIVITY_LIMIT = 300

export class IntegrationBridge {
  private grants = new Map<string, Grant>()
  private sessionGrants = new Map<string, string>()
  private upstreams = new Map<string, Promise<Upstream>>()
  private toolCache = new Map<string, UpstreamTool[]>()
  private log: BridgeActivity[] = []

  constructor(private deps: BridgeDeps) {}

  /** A repo-proposed server for a managed service must not reintroduce another account. */
  filterRepoServers(repoId: string, servers: Record<string, McpLaunch>): Record<string, McpLaunch> {
    const allowOwn = this.deps.integrations.repoChoices(repoId)?.allowOwnMcp ?? []
    return Object.fromEntries(Object.entries(servers).filter(([name, config]) => {
      const service = ownServerService(name, config)
      if (!service || allowOwn.includes(service)) return true
      const r = this.deps.integrations.resolve(repoId, service)
      return r.state !== 'ready' && r.state !== 'broken'
    }))
  }

  private get upstreamFactory(): UpstreamFactory {
    return this.deps.upstream ?? sdkUpstream
  }

  /**
   * What a turn gets: bridge servers for services that resolve to a working connection agents may
   * use, the user's own same-service servers to switch off, and the identity snapshot.
   * `agent` decides only whether MCP is passed at all (supportsMcp) and how own servers are named.
   */
  forTurn(input: { sessionId: string; workspaceId: string; repoId: string; cwd: string; supportsMcp: boolean; last?: IntegrationSnapshot[] }, probe = false): TurnIntegrations {
    if (!probe) this.endSession(input.sessionId)
    const { integrations } = this.deps
    const servers: Record<string, McpLaunch> = {}
    const blocked: OwnMcpServer[] = []
    const notes: string[] = []
    const snapshot: IntegrationSnapshot[] = []
    const allowOwn = integrations.repoChoices(input.repoId)?.allowOwnMcp ?? []
    const own = integrations.ownServers(input.cwd)
    const launch = this.deps.launch()
    const socket = this.deps.socket()
    for (const service of INTEGRATION_SERVICES) {
      const r = integrations.resolve(input.repoId, service)
      const captured = snapshotOf(service, r)
      if (service === 'github' && r.state === 'ready') {
        captured.identity = integrations.githubKey(input.repoId)
        if (r.connection.auth.kind === 'gh-active' && captured.identity && !captured.identity.startsWith('blocked:')) captured.name = `${r.connection.name} · ${captured.identity}`
      }
      snapshot.push(captured)
      // Foreman provides this service here (or deliberately can't): the user's own servers for it would be another account.
      const governs = r.state === 'ready' || r.state === 'broken'
      if (governs && !allowOwn.includes(service)) blocked.push(...own.filter((s) => s.service === service))
      if (r.state === 'broken') {
        notes.push(`${integrations.brokenText(input.repoId, service)} Don’t use any other ${LABEL[service]} account or server for this repository.`)
        continue
      }
      if (r.state !== 'ready' || !BRIDGED.includes(service)) continue
      const c = r.connection
      if (c.agentAccess === 'off') continue
      if (!input.supportsMcp || !launch || !socket || (this.deps.platform ?? process.platform) === 'win32') {
        notes.push(`${LABEL[service]} tools aren’t available to this agent.`)
        continue
      }
      const grant = this.grantFor(input, service, c, probe)
      const name = bridgeServerName(service)
      servers[name] = { command: launch.command, args: [...launch.args, 'mcp-bridge', service], env: { ...launch.env, FOREMAN_BRIDGE_SOCKET: socket, FOREMAN_BRIDGE_GRANT: grant.id } }
      notes.push(
        `${LABEL[service]}: use the ${name} MCP server's tools. They act as “${c.name}”${c.identity?.org ? ` (${c.identity.org})` : ''}${c.agentAccess === 'read' ? ', read only' : ''}. Don’t use any other ${LABEL[service]} account or server for this repository.`
      )
    }
    return { servers, blocked, snapshot, changed: changedIdentities(input.last, snapshot), notes }
  }

  /** A fresh capability per turn. Old bridge processes never acquire a later turn's account. */
  private grantFor(input: { sessionId: string; workspaceId: string; repoId: string }, service: IntegrationService, c: Connection, probe = false): Grant {
    const key = `${input.sessionId}:${service}`
    const grant: Grant = { id: randomUUID(), sessionId: input.sessionId, workspaceId: input.workspaceId, repoId: input.repoId, service, connectionId: c.id, rev: c.rev, access: c.agentAccess, probe }
    this.grants.set(grant.id, grant)
    if (!probe) this.sessionGrants.set(key, grant.id)
    return grant
  }

  /** The tab closed (or its workspace went away): its grants end. */
  endSession(sessionId: string): void {
    for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id)
    for (const service of INTEGRATION_SERVICES) {
      const key = `${sessionId}:${service}`
      const id = this.sessionGrants.get(key)
      if (id) this.grants.delete(id)
      this.sessionGrants.delete(key)
    }
  }

  endProbes(sessionId: string): void {
    for (const [id, grant] of this.grants) if (grant.sessionId === sessionId && grant.probe) this.grants.delete(id)
  }

  /** A grant for an idle MCP status probe: it can list tools, nothing more. */
  probeServers(input: { sessionId: string; workspaceId: string; repoId: string; cwd: string; supportsMcp: boolean }): Record<string, McpLaunch> {
    const turn = this.forTurn(input, true)
    return turn.servers
  }

  /** Names of the user's own servers to switch off, for the driver: Claude's tool prefixes, Codex's server names. */
  static blockedFor(agent: string, blocked: OwnMcpServer[]): { claude: string[]; codex: string[] } {
    const claude = agent === 'claude' ? blocked.filter((s) => s.from === 'claude' || s.from === 'claude.ai').map((s) => s.name) : []
    const codex = agent === 'codex' ? blocked.filter((s) => s.from === 'codex').map((s) => s.name) : []
    return { claude, codex }
  }

  activity(repoId?: string): BridgeActivity[] {
    return (repoId ? this.log.filter((a) => a.repoId === repoId) : this.log).slice(-100).reverse()
  }

  private record(grant: Grant, tool: string, ok: boolean, error?: string): void {
    this.log.push({ at: new Date(this.deps.now?.() ?? Date.now()).toISOString(), repoId: grant.repoId, workspaceId: grant.workspaceId, sessionId: grant.sessionId, connectionId: grant.connectionId, service: grant.service, tool, ok, ...(error ? { error } : {}) })
    if (this.log.length > ACTIVITY_LIMIT) this.log.splice(0, this.log.length - ACTIVITY_LIMIT)
  }

  /** Is the grant still good, as the repository is now? A reason when it isn't. */
  private check(grant: Grant): { connection: Connection; token: string; access: AgentAccess } | { refused: string } {
    const label = LABEL[grant.service]
    const r = this.deps.integrations.resolve(grant.repoId, grant.service)
    if (!this.grants.has(grant.id) || r.state !== 'ready' || r.connection.id !== grant.connectionId) {
      // Switched to another account, removed or broken: this turn's arguments were meant for the old one.
      return { refused: r.state === 'broken' ? this.deps.integrations.brokenText(grant.repoId, grant.service) : `${label} changed for this repository since this turn started. Start a new turn to use it.` }
    }
    if (r.connection.rev !== grant.rev) return { refused: `${label} access changed since this turn started. Start a new turn to use it.` }
    const token = this.deps.integrations.secret(r.connection.id)
    if (!token) return { refused: `${label}’s key is missing. Replace it in Settings → Integrations.` }
    // The stricter of what the turn started with and what's allowed now.
    const access: AgentAccess = r.connection.agentAccess === 'off' || grant.access === 'off' ? 'off' : r.connection.agentAccess === 'write' && grant.access === 'write' ? 'write' : 'read'
    if (access === 'off') return { refused: `Agents can’t use ${label} tools for this connection.` }
    return { connection: r.connection, token, access }
  }

  private upstream(connection: Connection, token: string, access: AgentAccess): Promise<Upstream> {
    const url = access === 'write' ? LINEAR_MCP_URL : LINEAR_MCP_READONLY_URL
    const key = `${connection.id}:${connection.rev}:${url}`
    let hit = this.upstreams.get(key)
    if (!hit) {
      // A new revision (key replaced, access changed) closes the old session.
      for (const [k, v] of this.upstreams) {
        if (k.startsWith(`${connection.id}:`) && k !== key) {
          this.upstreams.delete(k)
          void v.then((u) => u.close()).catch(() => undefined)
        }
      }
      hit = this.upstreamFactory(url, token)
      hit.catch(() => this.upstreams.delete(key))
      this.upstreams.set(key, hit)
    }
    return hit
  }

  private async tools(connection: Connection, token: string, access: AgentAccess): Promise<UpstreamTool[]> {
    if (connection.service === 'slack') return access === 'write' ? [{
      name: 'slack_post', description: `Post as the Foreman bot to an allowed channel: ${(connection.slack?.destinations ?? []).map((d) => `${d.id} (#${d.name})`).join(', ') || 'none configured'}.`,
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string', maxLength: 4000 } }, required: ['channel', 'text'], additionalProperties: false }
    }] : []
    // Foreman's own read-only tools over Langfuse's public API (Langfuse's hosted MCP manages prompts, not traces).
    if (connection.service === 'langfuse') return LANGFUSE_TOOLS
    const key = `${connection.id}:${connection.rev}:${access}`
    const hit = this.toolCache.get(key)
    if (hit) return hit
    const all = await (await this.upstream(connection, token, access)).listTools()
    const tools = all.filter((t) => toolAllowed(access, t.name))
    this.toolCache.set(key, tools)
    return tools
  }

  /** An agent's bridge connected (cliServer hands it over after the first line). */
  attach(conn: net.Socket, params: { grant: string; service: string }, rest: string): void {
    const grant = this.grants.get(params.grant)
    const send = (msg: unknown) => {
      if (!conn.destroyed) conn.write(`${JSON.stringify(msg)}\n`)
    }
    if (!grant || grant.service !== params.service) {
      const label = LABEL[params.service as IntegrationService] ?? params.service
      send({ bridgeError: `${label} access for this turn has ended (Foreman restarted, or the tab closed). Start a new turn to use it.` })
      conn.end()
      return
    }
    let buffer = rest
    const onLines = () => {
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        // Looked up per message: an agent process that lives across turns (ACP) gets each turn's grant, and a closed tab's none.
        const current = this.grants.get(params.grant)
        if (!current) {
          send({ bridgeError: `${LABEL[grant.service]} access for this turn has ended (the tab closed). Start a new turn to use it.` })
          conn.end()
          return
        }
        void this.handle(current, line).then((reply) => reply && send(reply))
      }
    }
    conn.setEncoding('utf8')
    conn.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) return conn.destroy()
      onLines()
    })
    conn.on('error', () => undefined)
    onLines()
  }

  /** One JSON-RPC line from the agent; the reply, or null for a notification. */
  async handle(grant: Grant, line: string): Promise<Record<string, unknown> | null> {
    let msg: { id?: string | number | null; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(line)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid request')
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
    }
    if (msg.id === undefined || msg.id === null) return null
    const id = msg.id
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
    const label = LABEL[grant.service]
    switch (msg.method) {
      case 'initialize': {
        const c = this.deps.integrations.connection(grant.connectionId)
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: bridgeServerName(grant.service), version: '1' },
          instructions: `${label} tools, through Foreman, as “${c?.name ?? label}”${c?.identity?.org ? ` (${c.identity.org})` : ''}.`
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list': {
        const ok = this.check(grant)
        if ('refused' in ok) return reply({ tools: [] })
        try {
          const tools = await this.tools(ok.connection, ok.token, ok.access)
          return reply({ tools: tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) })
        } catch (err) {
          return fail(-32603, `${label} didn’t answer: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      case 'tools/call': {
        const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
        const args = (msg.params?.arguments ?? undefined) as Record<string, unknown> | undefined
        const refuse = (text: string) => {
          this.record(grant, name, false, text)
          return reply({ content: [{ type: 'text', text }], isError: true })
        }
        if (grant.probe) return refuse('This is a status check; tools can’t run here.')
        const ok = this.check(grant)
        if ('refused' in ok) return refuse(ok.refused)
        if (!toolAllowed(ok.access, name)) return refuse(`“${name}” changes ${label}, and agents may only read with “${ok.connection.name}”. The user can allow writing in Settings → Integrations.`)
        try {
          if (grant.service === 'slack') {
            if (name !== 'slack_post' || ok.access !== 'write') return refuse('Slack posting is not allowed for this connection.')
            const channel = args?.channel
            const text = args?.text
            if (typeof channel !== 'string' || !ok.connection.slack?.destinations.some((d) => d.id === channel)) return refuse('Choose a channel allowed by this Slack connection. Direct messages are not available to agents.')
            if (typeof text !== 'string' || !text.trim() || text.length > 4000) return refuse('A message must contain between 1 and 4000 characters.')
            const posted = await slackPost(ok.token, channel, slackEscape(text), this.deps.fetch)
            this.record(grant, name, true)
            return reply({ content: [{ type: 'text', text: `Posted to ${posted.channel} (${posted.ts}).` }] })
          }
          if (grant.service === 'langfuse') {
            const info = ok.connection.langfuse
            if (!info) return refuse('This Langfuse connection has no host or public key. Replace its keys in Settings → Integrations.')
            const result = await langfuseCall({ ...info, secretKey: ok.token }, name, args, this.deps.fetch, this.deps.now?.())
            this.record(grant, name, !result.isError)
            return reply(result)
          }
          const upstream = await this.upstream(ok.connection, ok.token, ok.access)
          const current = this.check(grant)
          if ('refused' in current) return refuse(current.refused)
          const result = await upstream.callTool(name, args)
          this.record(grant, name, !result.isError)
          return reply(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // The service refused the key: the connection needs attention, for every repository using it.
          if (isAuthError(err) || (err instanceof LangfuseError && err.auth) || /\b401\b|unauthori[sz]ed|invalid.*(token|key)/i.test(message)) this.deps.integrations.markProblem(ok.connection.id, `${label} refused the key (${message})`)
          this.record(grant, name, false, message)
          return reply({ content: [{ type: 'text', text: `${label} error: ${message}` }], isError: true })
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`)
    }
  }

  /** Close upstream sessions (app quit). */
  async close(): Promise<void> {
    const all = [...this.upstreams.values()]
    this.upstreams.clear()
    await Promise.all(all.map((u) => u.then((x) => x.close()).catch(() => undefined)))
  }
}
