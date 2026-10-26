// G1: Cursor gets the repo's MCP servers and Foreman's report tools through its SDK (#20, #2), and Cursor and
// OpenCode turns can run in the background agent host (O10). The Cursor SDK is a fake here (no Cursor key) and
// OpenCode is a fake ACP agent, so this proves Foreman's side only; a real Cursor or OpenCode never ran.
import * as acp from '@agentclientprotocol/sdk'
import type { RunResult, SDKMessage } from '@cursor/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keptRunning } from '../src/shared/agentHost'
import { AGENTS } from '../src/shared/agents'
import { hasReportTools, isReportCall, teachText } from '../src/shared/agentReports'
import { repoMcpReach, repoMcpSupport } from '../src/shared/agentCatalog'
import type { ChatItem } from '../src/shared/types'
import { createAcpDriver, type AcpConnector } from '../src/main/agents/acp'
import { cursorDriver, cursorMcpServers, cursorReportTools } from '../src/main/agents/cursor'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { HostClient } from '../src/main/agentHost/client'
import { readLog } from '../src/main/agentHost/protocol'
import { HostServer } from '../src/main/agentHost/server'
import { tempDir } from './helpers'

const sdk = vi.hoisted(() => {
  class AgentNotFoundError extends Error {}
  class AuthenticationError extends Error {}
  return { Agent: { create: vi.fn(), resume: vi.fn() }, Cursor: { models: { list: vi.fn(async () => []) } }, AgentNotFoundError, AuthenticationError }
})
vi.mock('@cursor/sdk', () => sdk)

const started: { servers: HostServer[]; clients: HostClient[] } = { servers: [], clients: [] }
afterEach(() => {
  for (const c of started.clients) c.close()
  for (const s of started.servers) s.close()
  started.servers = []
  started.clients = []
  sdk.Agent.create.mockReset()
})

function recorder() {
  const items: ChatItem[] = []
  const finished: unknown[] = []
  const asked: string[] = []
  const cb: TurnCallbacks = {
    item: (item, transient) => void (!transient && items.push(item)),
    sessionStarted: () => undefined,
    assistantMessage: () => undefined,
    approveTool: async (request) => {
      asked.push(`tool:${request.toolName}`)
      return { kind: 'tool', allow: true }
    },
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => ({ kind: 'question', skipped: true }),
    planModeChanged: () => undefined,
    autoAcceptEdits: () => undefined,
    usage: () => undefined,
    finished: (r) => void finished.push(r)
  }
  return { cb, items, finished, asked }
}

function request(turnId: string, over: Partial<TurnRequest> = {}): TurnRequest {
  return { turnId, prompt: 'go', cwd: process.cwd(), env: { CURSOR_API_KEY: 'key_123456789' }, model: 'auto', fastMode: false, planMode: false, approvals: 'ask', systemPromptAppend: '', ...over }
}

async function host(driver: (kind: string) => AgentDriver) {
  const dir = await tempDir('foreman-g1-host-')
  const server = new HostServer({ dir, driver: driver as never, idleMs: 60_000, exit: () => undefined })
  expect(await server.listen()).toBe(true)
  started.servers.push(server)
  const client = new HostClient({ dir })
  started.clients.push(client)
  return { dir, client }
}

const ids = { agent_id: 'agent-1', run_id: 'run-1' }

/** A fake Cursor agent whose run calls the custom `report` tool it was given, then answers. */
function cursorWithReport(seen: { options?: Record<string, unknown> }) {
  sdk.Agent.create.mockImplementation(async (options: Record<string, unknown>) => {
    seen.options = options
    const tools = (options.local as { customTools?: Record<string, { execute: (a: Record<string, unknown>, c: object) => unknown }> }).customTools
    return {
      agentId: 'agent-1',
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: 'run-1',
        agentId: 'agent-1',
        stream: async function* () {
          const answer = tools ? await tools.report.execute({ kind: 'needs-input', text: 'Which database?' }, {}) : 'no tools'
          yield { type: 'tool_call', ...ids, call_id: 'c1', name: 'mcp', status: 'completed', args: { providerIdentifier: 'custom-user-tools', toolName: 'report', args: {} }, result: { status: 'success', value: { content: [] } } } as unknown as SDKMessage
          yield { type: 'assistant', ...ids, message: { role: 'assistant', content: [{ type: 'text', text: String(answer) }] } } as SDKMessage
        },
        wait: vi.fn(async () => ({ id: 'run-1', status: 'finished', durationMs: 5 }) as RunResult),
        cancel: vi.fn(async () => undefined)
      }))
    }
  })
}

describe('G1 · Cursor through its SDK: repo MCP servers and report tools (fake SDK, untested with a real key)', () => {
  it('Cursor takes repo MCP servers now, and they reach it first in the consent list', () => {
    expect(repoMcpSupport('cursor')).toEqual({ supported: true, via: 'cursor' })
    expect(AGENTS.cursor.supportsRepoMcp).toBe(true)
    expect(repoMcpReach({}).map((r) => [r.id, r.support.supported])).toEqual([
      ['claude', true],
      ['codex', true],
      ['cursor', true],
      ['opencode', true]
    ])
  })

  it('maps approved servers to the SDK’s stdio servers with only their declared variables', () => {
    expect(cursorMcpServers(undefined, '/w')).toBeUndefined()
    expect(cursorMcpServers({ echo: { command: '/bin/echo-mcp', args: ['--x'], env: { TOKEN: 't' } } }, '/w')).toEqual({ echo: { type: 'stdio', command: '/bin/echo-mcp', args: ['--x'], env: { TOKEN: 't' }, cwd: '/w' } })
  })

  it('passes the servers and the report tools to Agent.create, and a report reaches the app', async () => {
    const seen: { options?: Record<string, unknown> } = {}
    cursorWithReport(seen)
    const reports: unknown[] = []
    const r = recorder()
    const req = request('t1', {
      mcpServers: { echo: { command: '/bin/echo-mcp', args: [], env: {} } },
      hostTools: { workspaceDiff: async () => '', diffComments: async () => '', addDiffComments: async () => '', report: (kind, text) => (reports.push([kind, text]), 'Noted.') }
    })
    await cursorDriver.createTurn(req, r.cb).run()
    expect(seen.options?.mcpServers).toEqual({ echo: { type: 'stdio', command: '/bin/echo-mcp', args: [], env: {}, cwd: process.cwd() } })
    expect(Object.keys((seen.options?.local as { customTools: object }).customTools)).toEqual(['report', 'request_review'])
    expect(reports).toEqual([['needs-input', 'Which database?']])
    expect(r.items.some((i) => i.kind === 'assistant' && i.text === 'Noted.')).toBe(true)
    expect(r.finished).toEqual([{ ok: true }])
    // The tool call that made the report folds into the report's own line, as Claude's does.
    const call = r.items.find((i) => i.kind === 'tool')
    expect(call && isReportCall(call as never)).toBe(true)
  })

  it('gives no tools without "Teach agents Foreman", and refuses bad arguments', async () => {
    const seen: { options?: Record<string, unknown> } = {}
    cursorWithReport(seen)
    await cursorDriver.createTurn(request('t2'), recorder().cb).run()
    expect((seen.options?.local as { customTools?: object }).customTools).toBeUndefined()
    expect(seen.options?.mcpServers).toBeUndefined()
    const tools = cursorReportTools(() => 'ok')
    expect(await tools.report.execute({ kind: 'party', text: 'x' }, {})).toMatchObject({ isError: true })
    expect(await tools.request_review.execute({ what: '  ' }, {})).toMatchObject({ isError: true })
    expect(await tools.request_review.execute({ what: 'the migration' }, {})).toBe('ok')
  })

  it('teaches Cursor the tools, not the CLI', () => {
    expect(hasReportTools('cursor')).toBe(true)
    expect(teachText({ agent: 'cursor', cli: false, mayStart: false, checksAfterTurn: false })).toMatchObject({ via: 'tools', commands: ['report', 'review'] })
  })
})

describe('G1 · O10: Cursor and OpenCode turns in the background host (fakes; untested with the real agents)', () => {
  it('keeps Cursor and OpenCode turns; Chat agents still stop at Quit', () => {
    expect(keptRunning('cursor')).toBe(true)
    expect(keptRunning('opencode')).toBe(true)
    expect(keptRunning('gemini')).toBe(false)
  })

  it('runs a Cursor turn in the host: the report tool is logged there and replayed to the app', async () => {
    const seen: { options?: Record<string, unknown> } = {}
    cursorWithReport(seen)
    const h = await host(() => cursorDriver)
    const r = recorder()
    await h.client.start({ sessionId: 's1', agent: 'cursor', request: request('t3'), hostTools: { followups: false, reports: true }, label: { workspace: 'lisbon' } }, {}, r.cb).run()
    expect(r.finished).toEqual([{ ok: true }])
    expect(readLog(h.dir, 't3').some((e) => e.type === 'report' && e.kind === 'needs-input' && e.text === 'Which database?')).toBe(true)
  })

  it('runs an OpenCode (ACP) turn in the host: the agent process belongs to the host, and approvals still come to the app', async () => {
    let connections = 0
    const fakeOpencode: AcpConnector = () => {
      connections++
      const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
      const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
      const conn = acp
        .agent({ name: 'opencode-fake' })
        .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'oc-1' }))
        .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
          const answer = await client.request(acp.methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'k1', title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } },
            options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
          })
          const picked = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled'
          await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `picked ${picked}` } } })
          return { stopReason: 'end_turn' }
        })
        .connect({ readable: toAgent.readable, writable: toClient.writable })
      return { stream: { readable: toClient.readable, writable: toAgent.writable }, failure: () => ({ stderr: '' }), close: async () => conn.close() }
    }
    const opencode = createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'opencode', args: ['acp'] }), connect: fakeOpencode })
    const h = await host(() => opencode)
    const r = recorder()
    await h.client.start({ sessionId: 's2', agent: 'opencode', request: request('t4', { model: '' }), label: { workspace: 'quito' } }, {}, r.cb).run()
    expect(connections).toBe(1)
    expect(r.asked).toEqual(['tool:Bash'])
    expect(r.items.some((i) => i.kind === 'assistant' && i.text === 'picked ok')).toBe(true)
    expect(r.finished).toEqual([{ ok: true }])
  })
})
