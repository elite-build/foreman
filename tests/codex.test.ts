import type { ThreadEvent } from '@openai/codex-sdk'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { modelInfo } from '../src/shared/agents'
import type { ChatItem } from '../src/shared/types'
import {
  CodexEventMapper,
  CodexTurn,
  codexDriver,
  codexOptions,
  expandCustomPrompt,
  type ThreadOpener
} from '../src/main/agents/codex'
import type { TurnCallbacks, TurnRequest, TurnResult } from '../src/main/agents/types'
import { makeRepo, tempDir } from './helpers'

const CWD = path.resolve('/work/repo')

function request(patch: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 't1',
    prompt: 'hello',
    cwd: CWD,
    env: { PATH: '/usr/bin' },
    model: 'gpt-6.1-sol',
    effort: 'high',
    fastMode: false,
    planMode: false,
    approvals: 'never-ask',
    systemPromptAppend: '',
    ...patch
  }
}

function recorder() {
  const log: { item: ChatItem; transient: boolean }[] = []
  const calls: string[] = []
  const results: TurnResult[] = []
  const cb: TurnCallbacks = {
    item: (item, transient = false) => {
      log.push({ item: structuredClone(item), transient })
      calls.push(`item:${item.kind}`)
    },
    sessionStarted: (id) => calls.push(`session:${id}`),
    assistantMessage: () => undefined,
    approveTool: () => Promise.reject(new Error('unexpected approval')),
    reviewPlan: () => Promise.reject(new Error('unexpected plan')),
    ask: () => Promise.reject(new Error('unexpected question')),
    planModeChanged: () => undefined,
    autoAcceptEdits: () => undefined,
    usage: (u) => calls.push(`usage:${u.used}/${u.limit}`),
    finished: (result) => {
      results.push(result)
      calls.push('finished')
    }
  }
  // What the chat log would hold after replay: the last persisted version of each id.
  const persisted = () => {
    const byId = new Map<string, ChatItem>()
    for (const { item, transient } of log) if (!transient) byId.set(item.id, item)
    return [...byId.values()]
  }
  return { cb, log, calls, results, persisted }
}

function fakeOpener(events: (signal: AbortSignal) => AsyncGenerator<ThreadEvent>) {
  const prompts: string[] = []
  const opener: ThreadOpener = () => ({
    runStreamed: async (input, options) => {
      prompts.push(String(input))
      return { events: events(options!.signal!) }
    }
  })
  return { opener, prompts }
}

async function* list(events: ThreadEvent[], thenThrow?: string): AsyncGenerator<ThreadEvent> {
  for (const event of events) yield event
  if (thenThrow) throw new Error(thenThrow)
}

describe('codex event mapping', () => {
  it('maps a full turn to chat items', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t1', CWD, modelInfo('codex', 'gpt-6.1-sol').contextWindow, r.cb)
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Looking around**' } },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } },
      { type: 'item.updated', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\nb.txt\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } },
      {
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'src/new.ts', kind: 'add' },
            { path: path.join(CWD, 'README.md'), kind: 'update' },
            { path: 'old.txt', kind: 'delete' }
          ]
        }
      },
      { type: 'item.started', item: { id: 'item_4', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'in_progress' } },
      {
        type: 'item.completed',
        item: {
          id: 'item_4',
          type: 'mcp_tool_call',
          server: 'docs',
          tool: 'search',
          arguments: { q: 'x' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'found it' }], structured_content: null }
        }
      },
      { type: 'item.started', item: { id: 'item_5', type: 'web_search', query: 'codex sdk' } },
      { type: 'item.completed', item: { id: 'item_5', type: 'web_search', query: 'codex sdk' } },
      { type: 'item.started', item: { id: 'item_6', type: 'todo_list', items: [{ text: 'Read', completed: false }, { text: 'Fix', completed: false }] } },
      { type: 'item.updated', item: { id: 'item_6', type: 'todo_list', items: [{ text: 'Read', completed: true }, { text: 'Fix', completed: false }] } },
      { type: 'item.completed', item: { id: 'item_7', type: 'error', message: 'Skill failed to load' } },
      { type: 'item.updated', item: { id: 'item_8', type: 'agent_message', text: 'Done' } },
      { type: 'item.completed', item: { id: 'item_8', type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 12345, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } }
    ]
    for (const event of events) mapper.handle(event)
    mapper.finish(false)

    const items = r.persisted()
    const byId = (id: string) => items.find((i) => i.id === id)

    expect(r.calls[0]).toBe('session:thread-1')
    expect(byId('t1:item_0')).toEqual({ kind: 'thinking', id: 't1:item_0', turnId: 't1', text: '**Looking around**' })

    // Running command shown live, then finished in place.
    expect(r.log.find((l) => l.item.id === 't1:item_1' && l.transient)?.item).toMatchObject({ status: 'running', output: 'a.txt\n' })
    expect(byId('t1:item_1')).toMatchObject({ kind: 'tool', name: 'Bash', input: { command: 'ls' }, status: 'done', output: 'a.txt\nb.txt\n' })
    expect(byId('t1:item_2')).toMatchObject({ name: 'Bash', status: 'error', output: 'Exit code 1' })

    expect(byId('t1:item_3:0')).toMatchObject({ name: 'Write', input: { file_path: path.join(CWD, 'src/new.ts') }, status: 'done' })
    expect(byId('t1:item_3:1')).toMatchObject({ name: 'Edit', input: { file_path: path.join(CWD, 'README.md') }, status: 'done' })
    expect(byId('t1:item_3:2')).toMatchObject({ name: 'Edit', input: { file_path: path.join(CWD, 'old.txt') }, output: 'Deleted.' })

    expect(byId('t1:item_4')).toMatchObject({ name: 'mcp__docs__search', input: { q: 'x' }, status: 'done', output: 'found it' })
    expect(byId('t1:item_5')).toMatchObject({ name: 'WebSearch', input: { query: 'codex sdk' }, status: 'done' })
    expect(byId('t1:item_6')).toMatchObject({
      name: 'TodoWrite',
      input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'pending' }] }
    })
    expect(r.log.filter((l) => l.item.id === 't1:item_6')).toHaveLength(2)
    expect(byId('t1:item_7')).toMatchObject({ kind: 'notice', level: 'error', text: 'Skill failed to load' })

    // Streaming preview first, then the final text under the same id.
    expect(r.log.find((l) => l.item.id === 't1:item_8' && l.transient)?.item).toMatchObject({ kind: 'assistant', text: 'Done', streaming: true })
    expect(byId('t1:item_8')).toEqual({ kind: 'assistant', id: 't1:item_8', turnId: 't1', text: 'Done.' })

    const result = items.find((i) => i.kind === 'result')
    expect(result).toMatchObject({ ok: true, turnId: 't1' })
    expect(typeof (result as { durationMs?: number }).durationMs).toBe('number')
    const tail = r.calls.slice(r.calls.indexOf('item:result'))
    expect(tail).toEqual(['item:result', `usage:12345/${modelInfo('codex', 'gpt-6.1-sol').contextWindow}`, 'finished'])
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: true }])
    // Nothing was left running.
    expect(items.filter((i) => i.kind === 'tool' && i.status === 'running')).toEqual([])
  })

  it('persists unfinished previews and closes running tools on finish', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t2', CWD, 400_000, r.cb)
    mapper.handle({ type: 'item.updated', item: { id: 'item_0', type: 'agent_message', text: 'partial' } })
    mapper.handle({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'sleep 9', aggregated_output: '', status: 'in_progress' } })
    mapper.finish(true)
    const items = r.persisted()
    expect(items.find((i) => i.id === 't2:item_0')).toMatchObject({ kind: 'assistant', text: 'partial', streaming: false })
    expect(items.find((i) => i.id === 't2:item_1')).toMatchObject({ status: 'error', output: 'Interrupted.' })
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
  })
})

describe('codex turn', () => {
  it('reports a failed turn once, flags auth errors, and ignores the exit error', async () => {
    const r = recorder()
    const message = 'unexpected status 401 Unauthorized: Missing bearer authentication'
    const { opener } = fakeOpener(() =>
      list(
        [
          { type: 'thread.started', thread_id: 'thread-2' },
          { type: 'error', message },
          { type: 'turn.failed', error: { message } }
        ],
        'Codex Exec exited with code 1: boom'
      )
    )
    await new CodexTurn(request(), r.cb, opener).run()
    const items = r.persisted()
    const notices = items.filter((i) => i.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ level: 'error', text: message, action: 'open-settings' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    // Codex calls finished after turn.failed; it must say so.
    expect(r.results).toEqual([{ ok: false, error: message }])
  })

  it('shows the CLI error when the process dies without a turn result', async () => {
    const r = recorder()
    const { opener } = fakeOpener(() => list([], 'Codex Exec exited with code 1: Error: model not found'))
    await new CodexTurn(request(), r.cb, opener).run()
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: 'Error: model not found' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.at(-1)).toBe('finished')
    expect(r.results).toEqual([{ ok: false, error: 'Error: model not found' }])
  })

  it('points at Settings when the CLI path is wrong', async () => {
    const r = recorder()
    await codexDriver.createTurn(request({ executablePath: path.join(os.tmpdir(), 'no-such-codex') }), r.cb).run()
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: expect.stringMatching(/^Codex CLI not found at /), action: 'open-settings' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.at(-1)).toBe('finished')
  })

  it('stops a running turn through the abort signal', async () => {
    const r = recorder()
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const { opener } = fakeOpener(async function* (signal) {
      yield { type: 'thread.started', thread_id: 'thread-3' }
      yield { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep 60', aggregated_output: '', status: 'in_progress' } }
      started()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('The operation was aborted'))))
    })
    const turn = new CodexTurn(request(), r.cb, opener)
    const done = turn.run()
    await running
    await turn.stop()
    await done
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'info', text: 'Stopped.' })
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error', output: 'Interrupted.' })
    expect(items.some((i) => i.kind === 'result')).toBe(false)
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    expect(turn.steer('more')).toBe(false)
  })

  it('expands custom prompts before sending', async () => {
    const home = await tempDir()
    await mkdir(path.join(home, 'prompts'))
    await writeFile(path.join(home, 'prompts', 'review.md'), '---\ndescription: Review a file\n---\nReview $1 for $FOCUS. All: $ARGUMENTS. Cost $$5.\n')
    const r = recorder()
    const { opener, prompts } = fakeOpener(() => list([{ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }]))
    await new CodexTurn(request({ prompt: '/prompts:review a.ts FOCUS=bugs\n\nAttached: x.png', env: { CODEX_HOME: home } }), r.cb, opener).run()
    expect(prompts[0]).toBe('Review a.ts for bugs. All: a.ts FOCUS=bugs. Cost $5.\n\nAttached: x.png')
    expect(await expandCustomPrompt('/prompts:missing x', home)).toBe('/prompts:missing x')
    expect(await expandCustomPrompt('plain text', home)).toBe('plain text')
  })
})

describe('codex options', () => {
  it('maps a request to SDK options', () => {
    const { client, thread } = codexOptions(
      request({ effort: 'none', fastMode: true, systemPromptAppend: 'Workspace notes', approvals: 'never-ask' }),
      { file: '/opt/codex', pathDirs: ['/opt/helpers'] }
    )
    expect(thread).toEqual({
      model: 'gpt-6.1-sol',
      workingDirectory: CWD,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
      approvalPolicy: 'never',
      modelReasoningEffort: 'minimal'
    })
    expect(client.codexPathOverride).toBe('/opt/codex')
    expect(client.env?.PATH).toBe(['/opt/helpers', '/usr/bin'].join(path.delimiter))
    expect(client.config).toEqual({ developer_instructions: 'Workspace notes', service_tier: 'priority' })
  })

  it('keeps the sandbox when approvals are on and omits empty settings', () => {
    const { client, thread } = codexOptions(request({ model: '', effort: undefined, approvals: 'ask' }))
    expect(thread.sandboxMode).toBe('workspace-write')
    expect(thread.approvalPolicy).toBe('never')
    expect(thread.model).toBeUndefined()
    expect(thread.modelReasoningEffort).toBeUndefined()
    expect(client.config).toEqual({})
    expect(client.env).toEqual({ PATH: '/usr/bin' })
  })

  it('lets the sandbox write the repository git folder and use the network', () => {
    const { thread } = codexOptions(request({ approvals: 'ask', extraWritableDirs: ['/repo/.git'] }))
    expect(thread.sandboxMode).toBe('workspace-write')
    expect(thread.additionalDirectories).toEqual(['/repo/.git'])
    expect(thread.networkAccessEnabled).toBe(true)
  })
})

describe('codex status', () => {
  let fakeCli = ''
  const env = (home: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', CODEX_HOME: home, ...extra })

  async function cli(): Promise<string> {
    if (fakeCli) return fakeCli
    const dir = await tempDir()
    fakeCli = path.join(dir, 'codex')
    await writeFile(fakeCli, '#!/bin/sh\necho "codex-cli 9.9.9"\n')
    await chmod(fakeCli, 0o755)
    return fakeCli
  }

  const jwt = (claims: object) =>
    ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part) => Buffer.from(part).toString('base64url')).join('.')

  it.skipIf(process.platform === 'win32')('reports a ChatGPT login without exposing tokens', async () => {
    const home = await tempDir()
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
          access_token: 'secret-access-token',
          refresh_token: 'secret-refresh-token'
        }
      })
    )
    const status = await codexDriver.status(env(home), await cli())
    expect(status).toEqual({
      agent: 'codex',
      installed: true,
      ready: true,
      version: '9.9.9',
      method: 'ChatGPT login',
      account: 'dev@example.com · ChatGPT Pro',
      detail: undefined
    })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it.skipIf(process.platform === 'win32')('reports an API key from auth.json or the environment', async () => {
    const home = await tempDir()
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret' }))
    const fromFile = await codexDriver.status(env(home), await cli())
    expect(fromFile).toMatchObject({ ready: true, method: 'API key', account: undefined })
    expect(JSON.stringify(fromFile)).not.toContain('sk-secret')

    const empty = await tempDir()
    expect(await codexDriver.status(env(empty, { CODEX_API_KEY: 'sk-env' }), await cli())).toMatchObject({ ready: true, method: 'API key' })
    expect(await codexDriver.status(env(empty), await cli())).toMatchObject({ installed: true, ready: false, detail: 'Not signed in' })
  })

  it('finds the bundled CLI and reports a missing one', async () => {
    const home = await tempDir()
    const bundled = await codexDriver.status(env(home))
    expect(bundled.installed).toBe(true)
    expect(bundled.version).toMatch(/^\d+\.\d+\.\d+/)
    const missing = await codexDriver.status(env(home), path.join(home, 'no-such-codex'))
    expect(missing).toMatchObject({ installed: false, ready: false })
  })
})

describe('codex custom prompts', () => {
  const saved = process.env.CODEX_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  })

  it('lists prompts with their descriptions', async () => {
    const home = await tempDir()
    await mkdir(path.join(home, 'prompts'))
    await writeFile(path.join(home, 'prompts', 'review.md'), '---\ndescription: "Review a file"\n---\nReview $1\n')
    await writeFile(path.join(home, 'prompts', 'plan.md'), '\n# Make a plan\n\nThen do it.\n')
    await writeFile(path.join(home, 'prompts', 'notes.txt'), 'ignored')
    process.env.CODEX_HOME = home
    expect(await codexDriver.slashCommands!(home)).toEqual([
      { name: 'prompts:plan', description: 'Make a plan' },
      { name: 'prompts:review', description: 'Review a file' }
    ])
  })
})

// Costs real tokens, so it only runs on request:
// FOREMAN_CODEX_SMOKE=1 npx vitest run tests/codex.test.ts
const smoke = process.env.FOREMAN_CODEX_SMOKE === '1' && existsSync(path.join(os.homedir(), '.codex', 'auth.json'))

describe.runIf(smoke)('codex smoke test', () => {
  it('runs one real turn', async () => {
    const repo = await makeRepo()
    const r = recorder()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    const turn = codexDriver.createTurn(
      request({
        turnId: 'smoke',
        prompt: 'Reply with just the word OK. Do not run any commands.',
        cwd: repo,
        env,
        effort: 'low',
        approvals: 'ask',
        systemPromptAppend: 'You are running inside Foreman (smoke test).'
      }),
      r.cb
    )
    await turn.run()
    const items = r.persisted()
    expect(r.calls.some((c) => c.startsWith('session:'))).toBe(true)
    expect(items.find((i) => i.kind === 'assistant')).toMatchObject({ text: expect.stringMatching(/OK/) })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: true })
  }, 180_000)
})
