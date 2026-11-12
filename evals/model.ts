// The one place that calls a model: Claude Code through the Claude Agent SDK, as the app runs Claude, with its own tools
// off and the case's fake tools on an in-process MCP server. It uses whatever sign-in this computer's Claude Code has
// (an API key in ANTHROPIC_API_KEY, or a login) and costs real money.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { APP_SERVER } from './fakeApp'
import type { RunModel } from './runner'
import type { RunOutput, ToolCall } from './types'

const PREFIX = `mcp__${APP_SERVER}__`

/** The answer's text blocks, from an assistant message. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('')
}

/**
 * One run. The setup is the same wherever it runs, so a result doesn't depend on the computer: no user, project or local
 * settings (so no hooks, skills, plugins or memory files), no MCP server but the fake one, no built-in tools, no saved
 * session, a custom system prompt rather than Claude Code's, and a scratch directory as the working directory.
 */
export const runModel: RunModel = async (spec, { model }) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'foreman-eval-'))
  const calls: ToolCall[] = []
  const counts = new Map<string, number>()
  const fake = spec.tools?.length
    ? createSdkMcpServer({
        name: APP_SERVER,
        version: '1.0.0',
        tools: spec.tools.map((t) =>
          tool(t.name, t.description, t.schema, async (args) => {
            const nth = counts.get(t.name) ?? 0
            counts.set(t.name, nth + 1)
            calls.push({ name: t.name, args: args as Record<string, unknown> })
            return { content: [{ type: 'text' as const, text: t.reply(args as Record<string, unknown>, nth) }] }
          })
        )
      })
    : undefined
  let last = ''
  let result = ''
  let costUsd = 0
  let error: string | undefined
  try {
    const q = query({
      prompt: spec.prompt,
      options: {
        cwd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        model,
        systemPrompt: spec.system ?? 'You are a helpful assistant.',
        tools: [],
        settingSources: [],
        persistSession: false,
        mcpServers: fake ? { [APP_SERVER]: fake } : {},
        strictMcpConfig: true,
        allowedTools: (spec.tools ?? []).map((t) => `${PREFIX}${t.name}`),
        permissionMode: 'dontAsk',
        maxTurns: spec.maxTurns ?? (spec.tools?.length ? 8 : 1)
      }
    })
    for await (const message of q) {
      if (message.type === 'assistant') {
        const text = textOf((message as { message?: { content?: unknown } }).message?.content)
        if (text.trim()) last = text
      } else if (message.type === 'result') {
        costUsd = message.total_cost_usd ?? 0
        if (message.subtype === 'success') result = message.result
        // Running out of turns still leaves a transcript worth checking; any other failure is the run's, not the text's.
        else if (message.subtype !== 'error_max_turns') error = `${message.subtype}${'errors' in message && Array.isArray(message.errors) ? `: ${message.errors.join('; ')}` : ''}`
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
  const output: RunOutput = { text: (result || last).trim(), calls, costUsd, ...(error ? { error } : {}) }
  return output
}
