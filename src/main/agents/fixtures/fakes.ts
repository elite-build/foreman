// The protocol fakes the `simulated` fixtures are recorded from (docs/agents.md, 9.4): neither OpenCode, Cursor nor any
// of the catalog's ACP chat agents is installed where this was built, so their fixtures are recorded from
//   - an in-process ACP conformance agent (the one tests/acp.test.ts drives its adapter with, here as a script per scenario), and
//   - Cursor's SDK replaced by a fake, under the worker's own event loop (src/main/cursorWorker.ts, run in-process),
// and say so (`evidence: simulated`). They prove the adapter's handling of the protocol, not what the real agent says.
// Run by `npm run record:agent -- simulated`; the Cursor SDK is faked by vi.mock in scripts/record/record.record.ts.
import * as acp from '@agentclientprotocol/sdk/unstable'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AcpConnector } from '../acp'
import { cursorDriver } from '../cursor'
import type { CursorEvent, CursorStart } from '../cursor/process'
import type { CursorForker } from '../transport'
import type { AgentTurn, TurnCallbacks } from '../types'

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
]

export type AcpScenario = 'plain' | 'approval' | 'interrupt' | 'crash' | 'resume' | 'question' | 'terminal' | 'terminal-direct' | 'terminal-swap' | 'terminal-env' | 'version1' | 'version2'

/** An in-process ACP agent that plays `scenario` for its one prompt. */
export function acpFake(scenario: AcpScenario): acp.AgentApp & { attach(c: { kill(): void }): void } {
  let onCancel = () => {}
  let conn: { kill(): void } | undefined
  // What the client said it can do, from `initialize`: the agent asks only for what was advertised.
  let advertised: acp.ClientCapabilities | undefined
  let folder = ''
  const app = acp
    .agent({ name: 'conformance-fake' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      advertised = params.clientCapabilities ?? undefined
      // `version1` and `version2` are a plain turn from an OpenCode that says it is 1.x or 2.x: Foreman declares it and starts a server for the turn either way.
      const version = scenario === 'version1' ? '1.14.3' : scenario === 'version2' ? '2.1.0' : '1.0.0'
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, agentInfo: { name: scenario.startsWith('version') ? 'opencode' : 'conformance-fake', version } }
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => ((folder = params.cwd), { sessionId: 'sess-1' }))
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      // Loading replays the earlier conversation to the client first.
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } } })
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const send = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })
      const text = (t: string) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
      const cancelled = new Promise<void>((resolve) => (onCancel = resolve))
      const usage = () => send({ sessionUpdate: 'usage_update', used: 1200, size: 200_000, cost: { amount: 0.05, currency: 'USD' } })
      if (scenario === 'approval') {
        await text('Running the tests. ')
        await send({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', description: 'Run tests' } })
        const { outcome } = await client.request(acp.methods.client.session.requestPermission, { sessionId: params.sessionId, toolCall: { toolCallId: 'call-1' }, options: PERMISSION_OPTIONS })
        const allowed = outcome.outcome === 'selected' && outcome.optionId.startsWith('allow')
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? '12 passed' : 'Rejected by the user' } }] })
        await usage()
        await text('All green.')
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'terminal-direct') {
        // Not recorded: a command asked for with no tool call before it, which the tests give each policy. The agent reports what it was told.
        try {
          const { terminalId } = await client.request(acp.methods.client.terminal.create, { sessionId: params.sessionId, command: 'node', args: ['-e', 'console.log(40 + 2)'] })
          const exit = await client.request(acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId })
          const out = await client.request(acp.methods.client.terminal.output, { sessionId: params.sessionId, terminalId })
          await text(`ran: ${out.output.trim()} (exit ${exit.exitCode})`)
        } catch (err) {
          await text(`refused: ${err instanceof Error ? err.message : String(err)}`)
        }
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'terminal-env') {
        // Not recorded: the person allows `node -e "console.log(1 + 1)"`, then the agent asks for terminals that run it with variables of its own
        // or in another folder (which the card of the tool call never showed), and with the variables that change how a command starts.
        await send({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'node -e', kind: 'execute', status: 'pending', rawInput: { command: 'node -e "console.log(1 + 1)"' } })
        await client.request(acp.methods.client.session.requestPermission, { sessionId: params.sessionId, toolCall: { toolCallId: 'call-1' }, options: PERMISSION_OPTIONS })
        const set = (name: string) => ({ label: name, env: [{ name, value: 'x' }] })
        const attempts: { label: string; env?: { name: string; value: string }[]; cwd?: string }[] = [
          set('FOO'), set('FOO'), set('BAR'), { label: 'sub', cwd: `${folder.replace(/[/\\]+$/, '')}/sub` }, { label: 'plain' },
          ...['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'FOREMAN_TURN_ID', 'SWITCHYARD_PORT'].map(set)
        ]
        const said: string[] = []
        for (const { label, env, cwd } of attempts) {
          try {
            const create: acp.CreateTerminalRequest = { sessionId: params.sessionId, command: 'node', args: ['-e', 'console.log(1 + 1)'], ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }
            const { terminalId } = await client.request(acp.methods.client.terminal.create, create)
            await client.request(acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId })
            said.push(`ran ${label}`)
          } catch (err) {
            said.push(`refused ${label}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        await text(said.join('|'))
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'terminal-swap') {
        // Not recorded: the person is asked about one command and allows it, and the agent then asks for terminals running others.
        await send({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'node -e', kind: 'execute', status: 'pending', rawInput: { command: 'node -e "console.log(1 + 1)"' } })
        const { outcome } = await client.request(acp.methods.client.session.requestPermission, { sessionId: params.sessionId, toolCall: { toolCallId: 'call-1' }, options: PERMISSION_OPTIONS })
        const said: string[] = []
        if (outcome.outcome === 'selected' && outcome.optionId.startsWith('allow')) {
          for (const args of [['-e', 'console.log(40 + 2)'], ['-e', 'console.log(1 + 1)'], ['-e', 'console.log(1 + 1)']]) {
            try {
              const { terminalId } = await client.request(acp.methods.client.terminal.create, { sessionId: params.sessionId, command: 'node', args })
              await client.request(acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId })
              said.push(`ran ${args[1]}`)
            } catch {
              said.push(`refused ${args[1]}`)
            }
          }
        }
        await text(said.join('; '))
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'terminal') {
        // A command through the client's terminal: the agent asks permission for the tool call, then `terminal/create` (the person's answer
        // covers it), reads the output and releases it. Only if the client said it has terminals.
        if (!advertised?.terminal) {
          await text('I have no terminal, so I did not run it.')
          return { stopReason: 'end_turn' as const }
        }
        await send({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'node -e', kind: 'execute', status: 'pending', rawInput: { command: 'node -e "console.log(1 + 1)"' } })
        const { outcome } = await client.request(acp.methods.client.session.requestPermission, { sessionId: params.sessionId, toolCall: { toolCallId: 'call-1' }, options: PERMISSION_OPTIONS })
        if (outcome.outcome !== 'selected' || !outcome.optionId.startsWith('allow')) {
          await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' })
          await text('Not run.')
          return { stopReason: 'end_turn' as const }
        }
        const { terminalId } = await client.request(acp.methods.client.terminal.create, { sessionId: params.sessionId, command: 'node', args: ['-e', 'console.log(1 + 1)'] })
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress', content: [{ type: 'terminal', terminalId }] })
        const exit = await client.request(acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId })
        const out = await client.request(acp.methods.client.terminal.output, { sessionId: params.sessionId, terminalId })
        await client.request(acp.methods.client.terminal.release, { sessionId: params.sessionId, terminalId })
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: exit.exitCode === 0 ? 'completed' : 'failed' })
        await text(`It printed ${out.output.trim()} (exit ${exit.exitCode}).`)
        await usage()
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'question') {
        // A form: a choice (titled options), a multi-select, a yes/no and a number. The agent asks only if the client said it could.
        if (!advertised?.elicitation?.form) {
          await text('I can’t ask you, so I picked vitest.')
          return { stopReason: 'end_turn' as const }
        }
        const reply = await client.request(acp.methods.client.elicitation.create, {
          sessionId: params.sessionId,
          mode: 'form',
          message: 'How should I run the tests?',
          requestedSchema: {
            type: 'object',
            properties: {
              runner: { type: 'string', title: 'Runner', oneOf: [{ const: 'vitest', title: 'Vitest' }, { const: 'jest', title: 'Jest' }] },
              suites: { type: 'array', title: 'Suites', items: { type: 'string', enum: ['unit', 'e2e'] } },
              watch: { type: 'boolean', title: 'Watch mode' },
              workers: { type: 'integer', title: 'Workers', minimum: 1 }
            },
            required: ['runner']
          }
        })
        await text(reply.action === 'accept' ? `Running with ${JSON.stringify(reply.content)}.` : `No answer (${reply.action}).`)
        await usage()
        return { stopReason: 'end_turn' as const }
      }
      if (scenario === 'interrupt') {
        await text('Working on it')
        await cancelled
        return { stopReason: 'cancelled' as const }
      }
      if (scenario === 'crash') {
        await text('Working on')
        // The agent process dies: its end of the connection closes with the prompt unanswered.
        queueMicrotask(() => conn?.kill())
        await new Promise(() => undefined)
      }
      if (scenario === 'resume') {
        await text('pineapple')
        await usage()
        return { stopReason: 'end_turn' as const }
      }
      await text('ok')
      await usage()
      return { stopReason: 'end_turn' as const }
    })
    .onNotification(acp.methods.agent.session.cancel, () => onCancel())
  return Object.assign(app, { attach: (c: { kill(): void }) => void (conn = c) })
}

/** A connector whose agent is the in-process fake: what a spawned process would be. */
export function inProcessAcp(app: ReturnType<typeof acpFake>): AcpConnector {
  return () => {
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    let end!: TransformStreamDefaultController<acp.AnyMessage>
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>({ start: (controller) => void (end = controller) })
    const connection = app.connect({ readable: toAgent.readable, writable: toClient.writable })
    // A process dying ends the client's stream without a word, which `terminate` does.
    app.attach({ kill: () => end.terminate() })
    return {
      stream: { readable: toClient.readable, writable: toAgent.writable },
      failure: () => ({ stderr: '' }),
      close: async () => connection.close()
    }
  }
}

// ---- Cursor ---- (its SDK fake is cursorSdkFake.ts)

/**
 * `fork` for Cursor's turn process, with the worker's own message loop (cursorWorker.ts) in this process: the same
 * `start` in, the same events out. It records as a worker would, since the tee sees `send` and 'message'.
 */
export function inProcessCursorWorker(): CursorForker {
  const start = (() => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      connected: true,
      killed: false,
      stderr: new PassThrough(),
      disconnect() {
        if (!child.connected) return
        child.connected = false
        queueMicrotask(() => child.emit('exit', 0, null))
      },
      kill() {
        child.disconnect()
        return true
      },
      send(message: CursorStart | { type: 'stop' }) {
        const emit = (event: CursorEvent) => queueMicrotask(() => child.emit('message', event))
        if (message.type === 'stop') {
          void turn?.stop()
          return true
        }
        const cb: TurnCallbacks = {
          item: (...args) => emit({ type: 'item', args }),
          sessionStarted: (...args) => emit({ type: 'sessionStarted', args }),
          usage: (...args) => emit({ type: 'usage', args }),
          finished: (...args) => emit({ type: 'finished', args }),
          assistantMessage: () => undefined,
          planModeChanged: () => undefined,
          autoAcceptEdits: () => undefined,
          approveTool: async () => ({ kind: 'tool', allow: false }),
          reviewPlan: async () => ({ kind: 'plan', approve: false }),
          ask: async () => ({ kind: 'question', skipped: true })
        }
        turn = cursorDriver.createTurn(message.request as never, cb)
        void turn.run().finally(() => emit({ type: 'ended' }))
        return true
      }
    })
    let turn: AgentTurn | undefined
    return child
  }) as unknown as CursorForker
  start.standsIn = true
  return start
}
