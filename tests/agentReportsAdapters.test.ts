// #2: each adapter hands the turn's identity to the agent process, Claude gets `report` and
// `request_review` on Foreman's MCP server, and both survive the background agent host (O10).
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver, foremanReportTools } from '../src/main/agents/claude'
import { codexOptions } from '../src/main/agents/codex'
import { createAcpDriver } from '../src/main/agents/acp'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { HostClient } from '../src/main/agentHost/client'
import { HostServer } from '../src/main/agentHost/server'
import { fakeRequest } from './agentHostFake'
import { tempDir } from './helpers'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => ({ name, handler })),
  createSdkMcpServer: vi.fn((options: unknown) => options)
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

const IDENTITY = { FOREMAN_SESSION_ID: 's1', FOREMAN_TURN_ID: 't1', FOREMAN_TURN_TOKEN: 'tok' }

function callbacks(): TurnCallbacks {
  return {
    item: () => undefined,
    sessionStarted: () => undefined,
    assistantMessage: () => undefined,
    approveTool: async () => ({ kind: 'tool', allow: true }) as never,
    reviewPlan: async () => ({ kind: 'plan', approve: true }) as never,
    ask: async () => ({ kind: 'question', skipped: true }) as never,
    planModeChanged: () => undefined,
    autoAcceptEdits: () => undefined,
    usage: () => undefined,
    finished: () => undefined
  }
}

/** Claude Code that ends at once, remembering the options it was started with. */
function quickClaude() {
  const seen: { env?: Record<string, string>; mcp?: { tools: { name: string }[] } }[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: { env: Record<string, string>; mcpServers: { foreman: { tools: { name: string }[] } } } }) => {
    seen.push({ env: options.env, mcp: options.mcpServers.foreman })
    const iterator = prompt[Symbol.asyncIterator]()
    return {
      async *[Symbol.asyncIterator]() {
        await iterator.next()
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1, result: 'ok', uuid: 'u', session_id: 'c1' } as unknown as SDKMessage
      },
      interrupt: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 100 })),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined)
    }
  })
  return seen
}

const hostTools = (report?: (...args: unknown[]) => string) => ({
  workspaceDiff: async () => '',
  diffComments: async () => '',
  addDiffComments: async () => '',
  ...(report ? { report } : {})
})

afterEach(() => {
  sdk.query.mockReset()
})

describe('turn identity reaches the agent process', () => {
  it('Claude Code: in its env, and report / request_review on Foreman’s MCP server only when offered', async () => {
    const seen = quickClaude()
    const report = vi.fn(() => 'Noted.')
    await claudeDriver.createTurn({ ...fakeRequest('t1', 'go'), env: IDENTITY, hostTools: hostTools(report) }, callbacks()).run()
    expect(seen[0].env).toMatchObject(IDENTITY)
    expect(seen[0].mcp!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['report', 'request_review']))
    await claudeDriver.createTurn({ ...fakeRequest('t2', 'go'), env: IDENTITY, hostTools: hostTools() }, callbacks()).run()
    expect(seen[1].mcp!.tools.map((t) => t.name)).not.toContain('report')
  })

  it('the tools pass the agent’s words through and answer with what the app says', async () => {
    const report = vi.fn((kind: string) => (kind === 'review' ? 'review noted' : 'noted'))
    const [reportTool, reviewTool] = foremanReportTools(report) as unknown as { handler: (args: unknown) => Promise<{ content: { text: string }[] }> }[]
    expect((await reportTool.handler({ kind: 'stuck', text: 'no browsers' })).content[0].text).toBe('noted')
    expect((await reviewTool.handler({ what: 'retry timeout' })).content[0].text).toBe('review noted')
    expect(report.mock.calls).toEqual([
      ['stuck', 'no browsers', undefined],
      ['review', 'retry timeout']
    ])
  })

  it('Codex: in the SDK client env', () => {
    const { client } = codexOptions({ ...fakeRequest('t1', 'go'), env: { ...IDENTITY, PATH: '/bin' } } as TurnRequest)
    expect(client.env).toMatchObject(IDENTITY)
  })

  it('OpenCode and other ACP agents: in the spawned process env', async () => {
    let launched: Record<string, string> | undefined
    const driver = createAcpDriver({
      kind: 'opencode',
      label: 'OpenCode',
      command: () => ({ file: 'opencode', args: ['acp'] }),
      connect: (launch) => {
        launched = launch.env
        throw new Error('not starting a real agent')
      }
    })
    await driver.createTurn({ ...fakeRequest('t1', 'go'), env: IDENTITY }, callbacks()).run().catch(() => undefined)
    expect(launched).toMatchObject(IDENTITY)
  })
})

describe('in the background agent host', () => {
  const servers: HostServer[] = []
  const clients: HostClient[] = []
  afterEach(() => {
    for (const c of clients.splice(0)) c.close()
    for (const s of servers.splice(0)) s.close()
  })

  it('the env goes through the wire, and a report made in the host reaches the app with its time', async () => {
    let env: Record<string, string> | undefined
    const reporter: AgentDriver = {
      ...claudeDriver,
      createTurn: (req, cb) => ({
        run: async () => {
          env = req.env
          req.hostTools?.report?.('needs-input', 'EUR?')
          cb.finished({ ok: true })
        },
        stop: async () => undefined,
        steer: () => false,
        setPlanMode: async () => {},
        setModel: async () => {}
      })
    }
    const dir = await tempDir('foreman-host-reports-')
    const server = new HostServer({ dir, driver: () => reporter, idleMs: 60_000, exit: () => undefined })
    expect(await server.listen()).toBe(true)
    servers.push(server)
    const client = new HostClient({ dir })
    clients.push(client)
    const report = vi.fn(() => 'Noted.')
    await client
      .start({ sessionId: 's1', agent: 'claude', request: { ...fakeRequest('t1', 'go'), env: IDENTITY }, hostTools: { followups: false, reports: true }, label: { workspace: 'lisbon' } }, { hostTools: hostTools(report) }, callbacks())
      .run()
    expect(env).toMatchObject(IDENTITY)
    expect(report).toHaveBeenCalledWith('needs-input', 'EUR?', undefined, expect.stringMatching(/^\d{4}-\d\d-\d\dT/))
  })
})
