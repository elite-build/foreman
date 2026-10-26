import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver, toMcpServers } from '../src/main/agents/claude'

const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

afterEach(() => sdk.query.mockReset())

describe('MCP status', () => {
  it('maps servers and leaves out the app’s own tools', () => {
    const list: McpServerStatus[] = [
      { name: 'foreman', status: 'connected', source: 'sdk', config: { type: 'sdk', name: 'foreman' }, tools: [{ name: 'DiffComment' }] },
      {
        name: 'linear',
        status: 'connected',
        scope: 'user',
        config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        tools: [{ name: 'list_issues' }, { name: 'get_issue' }]
      },
      { name: 'hiveterm', status: 'failed', error: 'ECONNREFUSED', scope: 'project', config: { type: 'sse', url: 'http://localhost:9' } },
      { name: 'rea', status: 'pending', source: 'plugin', config: { command: 'rea', args: ['mcp', '--stdio'] } },
      { name: 'notion', status: 'needs-auth', scope: 'claudeai', tools: [{ name: 'ignored' }] }
    ]
    expect(toMcpServers(list)).toEqual([
      { name: 'linear', status: 'connected', error: undefined, scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', tools: ['list_issues', 'get_issue'] },
      { name: 'hiveterm', status: 'failed', error: 'ECONNREFUSED', scope: 'project', transport: 'sse', target: 'http://localhost:9', tools: undefined },
      { name: 'rea', status: 'pending', error: undefined, scope: 'plugin', transport: 'stdio', target: 'rea mcp --stdio', tools: undefined },
      { name: 'notion', status: 'needs-auth', error: undefined, scope: 'claudeai', transport: undefined, target: undefined, tools: undefined }
    ])
  })

  it('probes the workspace with its project settings, then closes', async () => {
    let released = false
    const close = vi.fn()
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void (async () => {
        for await (const _ of prompt) void _
        released = true
      })()
      return {
        initializationResult: async () => ({}),
        mcpServerStatus: async () => [{ name: 'linear', status: 'pending', scope: 'user' }],
        reconnectMcpServer: vi.fn(async () => undefined),
        close
      }
    })
    const probe = claudeDriver.mcpProbe!({ cwd: '/tmp/ws', env: {} })
    expect(sdk.query.mock.calls[0][0].options).toMatchObject({ cwd: '/tmp/ws', settingSources: ['user', 'project', 'local'], persistSession: false })
    expect((await probe.status()).map((s) => s.status)).toEqual(['pending'])
    probe.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(close).toHaveBeenCalled()
    expect(released).toBe(true)
  })

  it('reports a probe that fails to start', async () => {
    sdk.query.mockImplementation(() => ({
      initializationResult: () => Promise.reject(new Error('spawn claude ENOENT')),
      mcpServerStatus: vi.fn(),
      close: vi.fn()
    }))
    const probe = claudeDriver.mcpProbe!({ cwd: '/tmp/ws', env: {} })
    await expect(probe.status()).rejects.toThrow('spawn claude ENOENT')
    probe.close()
  })
})
