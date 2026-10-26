import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import { PassThrough } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { FOREMAN_TOOLS, type ForemanToolName } from '../shared/foremanTools'
import type { Session } from '../shared/types'
import type { McpLaunch } from './agents/types'
import type { ForemanActions } from './foremanActions'
import { DELEGATION_TOOLS, type DelegationToolName } from '../shared/foremanDelegation'
import type { ForemanDelegation } from './foremanDelegation'
import type { ForemanCli } from './foremanCli'
import { FOREMAN_CLI_TOOL } from '../shared/foremanCli'

interface Grant { id: string; sessionId: string; workspaceId: string; readOnly: boolean }
interface Deps {
  actions: ForemanActions
  session(id: string): Session | undefined
  launch(): { command: string; args: string[]; env: Record<string, string> } | null
  socket(): string | null
}

/** Local capabilities, never the CLI's optional/cooperative caller identity. */
export class ForemanMcp {
  delegation?: ForemanDelegation
  cli?: ForemanCli
  private grants = new Map<string, Grant>()
  private connections = new Map<net.Socket, string>()

  constructor(private deps: Deps) {}

  forTurn(session: Session, cloud: boolean): Record<string, McpLaunch> {
    this.endSession(session.id)
    const launch = this.deps.launch()
    const socket = this.deps.socket()
    if (cloud || !launch || !socket) return {}
    const grant: Grant = { id: randomUUID(), sessionId: session.id, workspaceId: session.workspaceId, readOnly: Boolean(session.readOnly || session.planMode) }
    this.grants.set(grant.id, grant)
    return { 'foreman-app': { command: launch.command, args: [...launch.args, 'mcp-bridge', 'app'], env: { ...launch.env, FOREMAN_BRIDGE_SOCKET: socket, FOREMAN_BRIDGE_GRANT: grant.id } } }
  }

  private scope(id: string) {
    const grant = this.grants.get(id)
    const session = grant && this.deps.session(grant.sessionId)
    if (!grant || !session || session.closedAt || session.workspaceId !== grant.workspaceId) throw new Error('Foreman access for this turn has ended. Start a new turn.')
    return { workspaceId: grant.workspaceId, sessionId: grant.sessionId, readOnly: grant.readOnly || Boolean(session.readOnly || session.planMode) }
  }

  attach(conn: net.Socket, params: { grant: string; service: string }, rest: string): void {
    try {
      if (params.service !== 'app') throw new Error('Unknown Foreman service.')
      this.scope(params.grant)
    } catch (err) {
      conn.end(`${JSON.stringify({ bridgeError: err instanceof Error ? err.message : String(err) })}\n`)
      return
    }
    const server = new McpServer({ name: 'foreman-app', version: '1' })
    if (this.cli) server.registerTool(FOREMAN_CLI_TOOL.name, {
      description: FOREMAN_CLI_TOOL.description,
      inputSchema: FOREMAN_CLI_TOOL.schema,
      annotations: { readOnlyHint: true }
    }, async (args, extra) => {
      try {
        const result = await this.cli!.call(args, { ...this.scope(params.grant), refresh: () => this.scope(params.grant), signal: extra.signal })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
      }
    })
    if (this.delegation) for (const name of Object.keys(DELEGATION_TOOLS) as DelegationToolName[]) {
      const definition = DELEGATION_TOOLS[name]
      if (this.scope(params.grant).readOnly && !definition.readOnly) continue
      server.registerTool(name, {
        description: definition.description,
        inputSchema: definition.schema as z.ZodObject<z.ZodRawShape>,
        annotations: { readOnlyHint: definition.readOnly }
      }, async (args, extra) => {
        try {
          const result = await this.delegation!.call(name, args, { ...this.scope(params.grant), refresh: () => this.scope(params.grant), signal: extra.signal })
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      })
    }
    for (const name of Object.keys(FOREMAN_TOOLS) as ForemanToolName[]) {
      const definition = FOREMAN_TOOLS[name]
      if (this.scope(params.grant).readOnly && !definition.readOnly) continue
      server.registerTool(name, {
        description: definition.description,
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: definition.readOnly }
      }, async () => {
        try {
          const scope = this.scope(params.grant)
          const result = await this.deps.actions.call(name, { workspaceId: scope.workspaceId }, scope)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      })
    }
    // Reuse the SDK's stdio framing over the existing owner-local CLI socket/Windows pipe.
    const input = new PassThrough()
    const transport = new StdioServerTransport(input, conn, { maxBufferSize: 1024 * 1024 })
    this.connections.set(conn, params.grant)
    if (rest) input.write(rest)
    conn.pipe(input)
    server.server.onerror = () => conn.destroy()
    conn.on('error', () => undefined)
    conn.once('close', () => {
      this.connections.delete(conn)
      input.destroy()
      void server.close().catch(() => undefined)
    })
    void server.connect(transport).catch(() => conn.destroy())
  }

  endSession(sessionId: string): void {
    for (const [id, grant] of this.grants) {
      if (grant.sessionId !== sessionId) continue
      this.grants.delete(id)
      for (const [conn, bound] of this.connections) if (bound === id) conn.end()
    }
  }

  close(): void {
    this.grants.clear()
    for (const conn of this.connections.keys()) conn.destroy()
    this.connections.clear()
  }
}
