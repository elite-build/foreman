import { commandName } from '../shared/cliCommands'
import { CLI_DEDICATED_TOOLS, FOREMAN_CLI_TOOL, MCP_CLI_READ_COMMANDS } from '../shared/foremanCli'
import { parseCommandArgs, plan, runnerFor } from '../cli/registry'
import { renderCommandHelp, renderHelp } from '../cli/help'
import { replyError } from '../cli/client'
import type { Context } from '../cli/command'
import type { CliReplyV2 } from '../cli/protocol'
import { inProcessRefusal } from './cli/inProcess'
import { METHODS } from './cli/methods'
import { handleRequest } from './cli/server'
import type { CliHost } from './cli/host'
import type { DelegationScope } from './foremanDelegation'

/** CLI parsing and handlers remain authoritative. No shell, admin token or user-confirmation bypass. */
export class ForemanCli {
  constructor(private host: CliHost) {}

  private current(scope: DelegationScope) {
    if (scope.signal?.aborted) throw new Error('The CLI request was cancelled.')
    const current = scope.refresh?.() ?? scope
    const state = this.host.state()
    const ws = state.workspaces.find((w) => w.id === current.workspaceId && w.state !== 'archived')
    if (!ws || !state.sessions.some((s) => s.id === current.sessionId && s.workspaceId === ws.id && !s.closedAt)) throw new Error('The coordinating chat is no longer available.')
    return ws
  }

  async call(input: unknown, scope: DelegationScope) {
    const ws = this.current(scope)
    const { args: argv } = FOREMAN_CLI_TOOL.schema.parse(input)
    const planned = plan(argv)
    const result = (text: string) => ({ output: text.slice(0, 32_000), truncated: text.length > 32_000, contentIsData: true })
    if (planned.kind === 'overview') return result(renderHelp())
    if (planned.kind === 'error') throw new Error(planned.message)
    const { spec } = planned
    const { opts, positionals } = parseCommandArgs(spec, planned.args)
    const refusal = inProcessRefusal(spec, opts)
    if (refusal) throw new Error(refusal)
    if (opts.help || spec.path.length === 1 && spec.path[0] === 'settings') return result(renderCommandHelp(spec))
    const name = commandName(spec)
    const dedicated = CLI_DEDICATED_TOOLS[name]
    if (dedicated) throw new Error(`Use the dedicated MCP tool: ${dedicated.join(' or ')}.`)
    const method = Object.hasOwn(MCP_CLI_READ_COMMANDS, name) ? MCP_CLI_READ_COMMANDS[name] : undefined
    if (!method || spec.tier !== 'read') throw new Error('That command is not available through the workspace CLI fallback. Use a dedicated tool, or ask the user to run it.')
    if (opts.open || opts.yes) throw new Error('The workspace CLI fallback cannot open settings or grant confirmation.')

    const output: string[] = []
    const ctx: Context = {
      args: positionals, opts, json: true, quiet: true, yes: false, cwd: ws.path ?? '',
      send: async <T>(requested: string, params?: unknown): Promise<T> => {
        this.current(scope)
        if (requested !== method || METHODS[requested]?.tier !== 'read') throw new Error('The CLI request is outside the reviewed fallback policy.')
        if (requested === 'settings-path' && (params as { open?: boolean })?.open) throw new Error('The CLI fallback cannot open settings.')
        // Always mark this as an agent call, so the CLI applies its existing
        // readable-settings filter. This marker is not a launch/admin token.
        const reply = await handleRequest(this.host, { v: 2, method: requested, params, caller: { token: 'mcp-read-only' } }, scope.signal) as CliReplyV2<T>
        this.current(scope)
        if (!reply.ok) throw replyError(reply)
        return reply.result
      },
      print: (value) => { output.push(JSON.stringify(value)) },
      confirm: async () => { throw new Error('The workspace CLI fallback cannot grant confirmation.') },
      note: () => {}, progress: () => {}
    }
    await runnerFor(spec)(ctx)
    this.current(scope)
    return result(output.join('\n'))
  }
}
