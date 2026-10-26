import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/cli/command'
import { tabRunners } from '../src/cli/commands/tab'
import { renderCommandHelp } from '../src/cli/help'
import { parseCommandArgs } from '../src/cli/registry'
import { CliCodedError, tierCheck, type CliHost } from '../src/main/cliServer'
import type { CliContext } from '../src/main/cli/methods'
import { TAB_METHODS } from '../src/main/cli/tabs'
import { defaultSettings } from '../src/main/store'
import { modelsFor } from '../src/shared/agents'
import { COMMON_OPTIONS, commandName } from '../src/shared/cliCommands'
import { TAB_COMMANDS } from '../src/shared/cliCommandsOps'
import { afterTurn, lastTurns, renderChat, type ChatResult, type McpResult, type QueueResult, type SearchResult, type SlashResult, type TabChangeResult, type TabsResult } from '../src/shared/cli/tabs'
import type { Api, ChatItem, QueuedMessage, Repo, Session, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: '2026-10-01T10:00:00.000Z', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session
const message = (id: string, text: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, text, attachments: [], ...patch })

const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: () => undefined })

const turnHost = (mayStart: boolean): Partial<CliHost> => ({
  identifyCaller: () => ({ kind: 'turn', session: tab('s1'), ws: ws(), turnId: 't', live: true }),
  agentsMayStart: () => mayStart
})

function rig(options: { sessions?: Session[]; api?: Partial<Api>; host?: Partial<CliHost> } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const sessions = options.sessions ?? [tab('s1', { title: 'Login bug' })]
  const api = fakeApi({
    createSession: (async (...args: unknown[]) => (calls.push(['createSession', ...args]), tab('s-new', { title: 'Fresh' }))) as Api['createSession'],
    updateSession: record('updateSession') as Api['updateSession'],
    closeSession: record('closeSession') as Api['closeSession'],
    reopenSession: (async (...args: unknown[]) => (calls.push(['reopenSession', ...args]), tab('s-closed', { title: 'Old' }))) as Api['reopenSession'],
    forkSession: (async (...args: unknown[]) => (calls.push(['forkSession', ...args]), tab('s-fork'))) as Api['forkSession'],
    removeQueued: record('removeQueued') as Api['removeQueued'],
    steerQueued: record('steerQueued') as Api['steerQueued'],
    editQueued: record('editQueued', { ok: true, revision: 8 }) as Api['editQueued'],
    moveQueued: record('moveQueued', { ok: true, revision: 8 }) as Api['moveQueued'],
    restoreCheckpoint: record('restoreCheckpoint') as Api['restoreCheckpoint'],
    resumeLimitNow: record('resumeLimitNow') as Api['resumeLimitNow'],
    reconnectMcpServer: record('reconnectMcpServer') as Api['reconnectMcpServer'],
    mcpStatus: (async (...args: unknown[]) => (calls.push(['mcpStatus', ...args]), { supported: true, live: true, servers: [{ name: 'linear', status: 'connected', scope: 'user' }, { name: 'slack', status: 'failed', error: 'no token' }] })) as Api['mcpStatus'],
    ...options.api
  })
  const host = stubHost({ api, state: () => ({ repos: [repo], workspaces: [ws()], sessions, settings: defaultSettings() }), ...options.host })
  const call = async <T>(method: string, params: unknown, token?: string): Promise<T> => (await TAB_METHODS[method].handle(host, params, ctx(token))) as T
  return { host, calls, call, sessions }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CliCodedError)
    return err as CliCodedError
  }
  throw new Error('expected a failure')
}

const base = { workspace: 'lisbon', cwd: '/' }

describe('tabs', () => {
  const sessions = [
    tab('s1', { title: 'Login bug', status: 'running', effort: 'high', fastMode: true, queue: [message('m1', 'a')] }),
    tab('s2', { agent: 'codex', model: modelsFor('codex')[0]?.id ?? 'x', planMode: true, lastTurn: { outcome: 'error', turnId: 'turn-5', endedAt: '2026-10-02T00:00:00Z' } }),
    tab('s3', { title: 'Old', closedAt: '2026-10-03T00:00:00Z' })
  ]

  it('lists the open tabs with position, model, effort, flags, status, queue and last turn', async () => {
    const { call } = rig({ sessions })
    const result = await call<TabsResult>('tabs', base)
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[0]).toMatchObject({ tab: 1, id: 's1', title: 'Login bug', agent: 'claude', modelText: 'Claude · Opus 5.5', effort: 'high', fast: true, plan: false, status: 'running', queued: 1 })
    expect(result.tabs[1]).toMatchObject({ tab: 2, title: 'New chat', agent: 'codex', plan: true, status: 'idle', queued: 0, lastTurn: { outcome: 'error', turn: 'turn-5' } })
    const lines = result.text.split('\n')
    expect(lines[0]).toMatch(/^TAB\s+TITLE\s+MODEL\s+EFFORT\s+FLAGS\s+STATUS\s+QUEUE\s+LAST TURN$/)
    expect(lines[1]).toContain('fast')
    expect(lines[1]).toContain('running')
    expect(lines[2]).toContain('plan')
    expect(lines[2]).toContain('failed')
  })

  it('lists the closed tabs by id with --closed', async () => {
    const { call } = rig({ sessions })
    const result = await call<TabsResult>('tabs', { ...base, closed: true })
    expect(result.tabs.map((t) => [t.id, t.closed, t.tab])).toEqual([['s3', true, undefined]])
    expect(result.text).toContain('s3')
  })
})

describe('tab new, set, close, reopen, fork', () => {
  it('creates a tab with the agent, a model of that agent and a title', async () => {
    const model = modelsFor('codex')[0]
    const { call, calls } = rig()
    const result = await call<TabChangeResult>('tab-new', { ...base, agent: 'codex', model: model.id, title: 'Second opinion', plan: true })
    expect(calls).toEqual([['createSession', 'ws1', { title: 'Second opinion', agent: 'codex', model: model.id, planMode: true }]])
    expect(result.text).toContain('Opened')
    // No words, no patch.
    await call('tab-new', base)
    expect(calls[1]).toEqual(['createSession', 'ws1', undefined])
  })

  it('refuses an unknown agent, model or effort', async () => {
    const { call, calls } = rig()
    expect((await failure(call('tab-new', { ...base, agent: 'gpt-nine' }))).code).toBe('invalid')
    expect((await failure(call('tab-new', { ...base, agent: 'claude', model: 'nope' }))).code).toBe('invalid')
    expect((await failure(call('tab-new', { ...base, effort: 'turbo' }))).code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('changes a tab’s title, model and flags through updateSession', async () => {
    const { call, calls } = rig()
    await call('tab-set', { ...base, patch: { title: 'Migration', fast: false, includeNote: true } })
    expect(calls).toEqual([['updateSession', 's1', { title: 'Migration', fastMode: false, includeNote: true }]])
    const err = await failure(call('tab-set', { ...base, patch: {} }))
    expect(err.code).toBe('invalid')
  })

  it('switches agent with that agent’s default model unless one is given', async () => {
    const { call, calls } = rig()
    await call('tab-set', { ...base, patch: { agent: 'codex' } })
    const patch = calls[0][2] as { agent: string; model: string }
    expect(patch.agent).toBe('codex')
    expect(patch.model).toBeTruthy()
  })

  it('refuses plan mode and auto-accept edits from an agent turn, and allows the other changes', async () => {
    const { call, calls } = rig()
    for (const patch of [{ plan: true }, { plan: false }, { autoAcceptEdits: true }, { title: 'x', plan: true }]) {
      const err = await failure(call('tab-set', { ...base, patch }, 'tok'))
      expect(err.code, JSON.stringify(patch)).toBe('refused')
    }
    expect(calls).toEqual([])
    await call('tab-set', { ...base, patch: { title: 'Fine' } }, 'tok')
    expect(calls).toEqual([['updateSession', 's1', { title: 'Fine' }]])
    // The person at the terminal may.
    await call('tab-set', { ...base, patch: { plan: true } })
    expect(calls[1]).toEqual(['updateSession', 's1', { planMode: true }])
  })

  it('closes a tab and says how to bring it back', async () => {
    const { call, calls } = rig({ sessions: [tab('s1'), tab('s2', { title: 'B' })] })
    const result = await call<TabChangeResult>('tab-close', { ...base, tab: 2 })
    expect(calls).toEqual([['closeSession', 's2']])
    expect(result.text).toContain('foreman tab reopen lisbon --tab s2')
    expect((await failure(call('tab-close', base))).code).toBe('ambiguous')
  })

  it('reopens the latest closed tab, or one named by the start of its id', async () => {
    const { call, calls } = rig({ sessions: [tab('s1'), tab('abcd1234', { closedAt: '2026-10-01T00:00:00Z' }), tab('abce5678', { closedAt: '2026-10-02T00:00:00Z' })] })
    await call('tab-reopen', base)
    await call('tab-reopen', { ...base, id: 'abcd' })
    expect(calls).toEqual([['reopenSession', 'ws1', undefined], ['reopenSession', 'ws1', 'abcd1234']])
    expect((await failure(call('tab-reopen', { ...base, id: 'zzzz' }))).code).toBe('not-found')
    expect((await failure(call('tab-reopen', { ...base, id: 'abc' }))).code).toBe('not-found')
    const none = rig()
    expect((await failure(none.call('tab-reopen', base))).code).toBe('not-found')
  })

  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', turnId: 'aaaa1111', text: 'first', at: 'x', checkpoint: 'c1' },
    { kind: 'assistant', id: 'a1', turnId: 'aaaa1111', text: 'ok' },
    { kind: 'turn-end', id: 'e1', turnId: 'aaaa1111', outcome: 'completed' },
    { kind: 'user', id: 'u2', turnId: 'bbbb2222', text: 'second', at: 'x' }
  ]

  it('forks from after the latest answer, or from a turn (before it)', async () => {
    const { call, calls } = rig({ api: { getChat: async () => items } })
    await call('tab-fork', base)
    await call('tab-fork', { ...base, turn: 'aaaa', before: true })
    expect(calls).toEqual([['forkSession', 's1', undefined, undefined], ['forkSession', 's1', 'aaaa1111', { before: true }]])
    expect((await failure(call('tab-fork', { ...base, turn: 'nope' }))).code).toBe('not-found')
    expect((await failure(call('tab-fork', { ...base, before: true }))).code).toBe('invalid')
  })

  it('rewinds to a turn that has a restore point, and nothing else', async () => {
    const { call, calls } = rig({ api: { getChat: async () => items } })
    await call('rewind', { ...base, turn: 'aaaa1111' })
    expect(calls).toEqual([['restoreCheckpoint', 's1', 'aaaa1111']])
    expect((await failure(call('rewind', { ...base, turn: 'bbbb2222' }))).code).toBe('invalid')
    expect((await failure(call('rewind', { ...base, turn: 'cccc' }))).code).toBe('not-found')
    expect(calls).toHaveLength(1)
  })
})

describe('chat', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', turnId: 'aaaa1111', text: 'Fix the login button', at: 'x', attachments: [{ name: 'trace.log' } as never] },
    { kind: 'thinking', id: 'th1', turnId: 'aaaa1111', text: 'hmm' },
    { kind: 'assistant', id: 'a1', turnId: 'aaaa1111', text: 'Looking at it.' },
    { kind: 'tool', id: 't1', turnId: 'aaaa1111', name: 'Bash', input: { command: 'npm test\nsecond line' }, status: 'done', output: 'all green\n3 passed' },
    { kind: 'tool', id: 't2', turnId: 'aaaa1111', name: 'Edit', input: { file_path: 'src/app.ts' }, status: 'error' },
    { kind: 'notice', id: 'n1', turnId: 'aaaa1111', level: 'info', text: 'Model changed' },
    { kind: 'turn-end', id: 'e1', turnId: 'aaaa1111', outcome: 'completed', durationMs: 65_000, delta: { additions: 4, deletions: 2, files: ['a'] } as never },
    { kind: 'user', id: 'u2', turnId: 'bbbb2222', text: 'Thanks', at: 'x' },
    { kind: 'assistant', id: 'a2', turnId: 'bbbb2222', text: 'Done.' },
    { kind: 'turn-end', id: 'e2', turnId: 'bbbb2222', outcome: 'error', error: 'boom' }
  ]

  it('renders user, assistant and tool lines, notices and how each turn ended', async () => {
    const { call } = rig({ api: { getChat: async () => items } })
    const result = await call<ChatResult>('chat', base)
    expect(result.text).toContain('You · turn aaaa1111\n  Fix the login button\n  Attachments: trace.log')
    expect(result.text).toContain('Claude\n  Looking at it.')
    expect(result.text).toContain('  · Bash npm test\n  · Edit src/app.ts (error)')
    expect(result.text).not.toContain('all green')
    expect(result.text).not.toContain('hmm')
    expect(result.text).toContain('  - Model changed')
    expect(result.text).toContain('= turn aaaa1111 completed (1m 5s, +4 -2)')
    expect(result.text).toContain('= turn bbbb2222 failed: boom')
    expect(result.tab).toBe(1)
    expect(result.items.some((i) => i.kind === 'thinking')).toBe(false)
    const tool = result.items.find((i) => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' ? tool.output : 'x').toBeUndefined()
  })

  it('includes tool output on request, keeps the last turns and what came after one', async () => {
    const { call } = rig({ api: { getChat: async () => items } })
    const withOutput = await call<ChatResult>('chat', { ...base, toolOutput: true })
    expect(withOutput.text).toContain('      all green\n      3 passed')
    const tail = await call<ChatResult>('chat', { ...base, tail: 1 })
    expect(tail.text).toContain('Thanks')
    expect(tail.text).not.toContain('Fix the login button')
    const since = await call<ChatResult>('chat', { ...base, since: 'aaaa' })
    expect(since.text).toContain('Thanks')
    expect(since.text).not.toContain('Looking at it')
    expect((await failure(call('chat', { ...base, since: 'zzzz' }))).code).toBe('not-found')
    expect((await failure(call('chat', { ...base, tail: 0 }))).code).toBe('invalid')
  })

  it('has pure helpers that agree', () => {
    expect(lastTurns(items, 5)).toBe(items)
    expect(afterTurn(items, 'bbbb2222')).toEqual([])
    expect(renderChat([])).toBe('')
  })
})

describe('queue', () => {
  const queue = [message('m1aaaaaa', 'first message', { turnId: 'turn-a' }), message('m2bbbbbb', 'second message')]
  const sessions = [tab('s1', { queue, queueRevision: 7 })]

  it('lists the queue with positions', async () => {
    const { call } = rig({ sessions })
    const result = await call<QueueResult>('queue', { ...base, verb: 'list' })
    expect(result.queue.map((r) => [r.position, r.id, r.turn])).toEqual([[1, 'm1aaaaaa', 'turn-a'], [2, 'm2bbbbbb', undefined]])
    expect(result.text).toContain('second message')
    expect((await call<QueueResult>('queue', base)).queue).toHaveLength(2)
    expect((await rig().call<QueueResult>('queue', base)).text).toContain('Nothing is queued')
  })

  it('passes the queue revision on edit and on move', async () => {
    const { call, calls } = rig({ sessions })
    await call('queue', { ...base, verb: 'edit', message: '1', text: 'edited text' })
    await call('queue', { ...base, verb: 'move', message: 'm2bb', direction: 'up' })
    expect(calls).toEqual([['editQueued', 's1', 'm1aaaaaa', 'edited text', 7], ['moveQueued', 's1', 'm2bbbbbb', 'up', 7]])
  })

  it('removes by position, id or turn id, and steers', async () => {
    const { call, calls } = rig({ sessions })
    await call('queue', { ...base, verb: 'remove', message: '2' })
    await call('queue', { ...base, verb: 'remove', message: 'turn-a' })
    await call('queue', { ...base, verb: 'steer', message: 'm1aa' })
    expect(calls).toEqual([['removeQueued', 's1', 'm2bbbbbb'], ['removeQueued', 's1', 'm1aaaaaa'], ['steerQueued', 's1', 'm1aaaaaa']])
    expect((await failure(call('queue', { ...base, verb: 'remove', message: '9' }))).code).toBe('not-found')
    expect((await failure(call('queue', { ...base, verb: 'remove' }))).code).toBe('invalid')
    expect((await failure(call('queue', { ...base, verb: 'move', message: '1', direction: 'sideways' }))).code).toBe('invalid')
    expect((await failure(call('queue', { ...base, verb: 'edit', message: '1', text: ' ' }))).code).toBe('invalid')
    expect((await failure(call('queue', { ...base, verb: 'shuffle' }))).code).toBe('invalid')
  })

  it('says so when the queue changed, the message started or it was removed', async () => {
    const result = (reason: 'stale' | 'started' | 'removed') => ({ api: { editQueued: async () => ({ ok: false as const, reason, revision: 9 }) } })
    const edit = { ...base, verb: 'edit', message: '1', text: 'x' }
    expect((await failure(rig({ sessions, ...result('stale') }).call('queue', edit))).code).toBe('busy')
    expect((await failure(rig({ sessions, ...result('started') }).call('queue', edit))).code).toBe('failed')
    expect((await failure(rig({ sessions, ...result('removed') }).call('queue', edit))).code).toBe('not-found')
  })

  it('steering from an agent turn needs the repository’s opt-in', async () => {
    const closed = rig({ sessions, host: turnHost(false) })
    expect((await failure(closed.call('queue', { ...base, verb: 'steer', message: '1' }, 'tok'))).code).toBe('refused')
    expect(closed.calls).toEqual([])
    const open = rig({ sessions, host: turnHost(true) })
    await open.call('queue', { ...base, verb: 'steer', message: '1' }, 'tok')
    expect(open.calls).toEqual([['steerQueued', 's1', 'm1aaaaaa']])
    // Looking and removing need none.
    await closed.call('queue', { ...base, verb: 'list' }, 'tok')
    await closed.call('queue', { ...base, verb: 'remove', message: '1' }, 'tok')
    expect(closed.calls).toEqual([['removeQueued', 's1', 'm1aaaaaa']])
  })
})

describe('resume-now, mcp, slash, search', () => {
  it('resume-now sends through the start policy', async () => {
    const plain = rig()
    const result = await plain.call<{ text: string }>('resume-now', base)
    expect(plain.calls).toEqual([['resumeLimitNow', 's1']])
    expect(result.text).toContain('Resumed')
    const closed = rig({ host: turnHost(false) })
    expect((await failure(closed.call('resume-now', base, 'tok'))).code).toBe('refused')
    expect(closed.calls).toEqual([])
    const open = rig({ host: turnHost(true) })
    await open.call('resume-now', base, 'tok')
    expect(open.calls).toEqual([['resumeLimitNow', 's1']])
  })

  it('shows MCP status, restarts and reconnects a server', async () => {
    const { call, calls } = rig()
    const status = await call<McpResult>('mcp', { ...base, verb: 'status' })
    expect(status.servers).toHaveLength(2)
    expect(status.text).toContain('linear')
    expect(status.text).toContain('no token')
    await call('mcp', { ...base, verb: 'restart' })
    const reconnect = await call<McpResult>('mcp', { ...base, verb: 'reconnect', name: 'slack' })
    expect(calls).toEqual([['mcpStatus', 's1', false], ['mcpStatus', 's1', true], ['reconnectMcpServer', 's1', 'slack'], ['mcpStatus', 's1']])
    expect(reconnect.text).toContain('reconnect slack')
    expect((await failure(call('mcp', { ...base, verb: 'reconnect' }))).code).toBe('invalid')
  })

  it('says when the agent reports no MCP status', async () => {
    const { call } = rig({ api: { mcpStatus: async () => ({ supported: false, servers: [], live: false }) } })
    expect((await call<McpResult>('mcp', base)).text).toContain('can’t report MCP status')
  })

  it('lists the /commands a tab offers', async () => {
    const { call } = rig({ api: { slashCommands: async () => [{ name: 'clear', description: 'Clear the chat' }, { name: 'deploy', description: 'Ship it', kind: 'command' as const, source: 'repo' as const }] } })
    const result = await call<SlashResult>('slash', base)
    expect(result.commands).toHaveLength(2)
    expect(result.text).toContain('/deploy')
    expect(result.text).toContain('Ship it')
  })

  it('searches chats (and notes) and brackets the matches', async () => {
    const hit = { sessionId: 's1', itemId: 'i1', workspaceId: 'ws1', workspaceName: 'lisbon', repoName: 'app', tabTitle: 'Login bug', agent: 'claude' as const, model: 'm', kind: 'assistant' as const, snippet: 'the \u0001rate limiter\u0002 is here', at: '2026-10-02T09:00:00Z', archived: false, closed: false, cleared: false }
    const { call, calls } = rig({
      api: {
        searchChats: (async (...args: unknown[]) => (calls.push(['searchChats', ...args]), [hit])) as Api['searchChats'],
        searchNotes: (async (...args: unknown[]) => (calls.push(['searchNotes', ...args]), [{ workspaceId: 'ws1', workspaceName: 'lisbon', repoName: 'app', revision: 2, snippet: 'a \u0001rate\u0002 note', archived: true }])) as Api['searchNotes']
      }
    })
    const result = await call<SearchResult>('search', { query: 'rate limiter', toolOutput: true, notes: true, limit: 5 })
    expect(calls).toEqual([['searchChats', 'rate limiter', { includeToolOutput: true, limit: 5 }], ['searchNotes', 'rate limiter']])
    expect(result.hits.map((h) => h.kind)).toEqual(['chat', 'note'])
    expect(result.text).toContain('the [rate limiter] is here')
    expect(result.text).toContain('note r2')
    expect(result.text).toContain('archived')
    expect((await failure(call('search', { query: ' ' }))).code).toBe('invalid')
  })
})

describe('policy', () => {
  it('declares the tiers: reads read, rewind admin, the rest act', () => {
    expect(Object.fromEntries(Object.entries(TAB_METHODS).map(([m, d]) => [m, d.tier]))).toEqual({
      tabs: 'read',
      'tab-new': 'act',
      'tab-set': 'act',
      'tab-close': 'act',
      'tab-reopen': 'act',
      'tab-fork': 'act',
      chat: 'read',
      queue: 'act',
      rewind: 'admin',
      'resume-now': 'act',
      mcp: 'act',
      slash: 'read',
      search: 'read'
    })
    const specTier = Object.fromEntries(TAB_COMMANDS.map((c) => [commandName(c), c.tier]))
    expect(specTier).toMatchObject({ tabs: 'read', 'tab new': 'act', 'tab set': 'act', chat: 'read', queue: 'act', rewind: 'admin', 'resume-now': 'act', mcp: 'act', slash: 'read', search: 'read' })
  })

  it('refuses rewind from an agent turn', () => {
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    expect(tierCheck('rewind', 'admin', { v: 2, method: 'rewind', params: {}, caller, token: 'test-token' }, stubHost())).toMatchObject({ code: 'refused' })
    expect(tierCheck('chat', 'read', { v: 2, method: 'chat', params: {}, caller }, stubHost())).toBeNull()
  })
})

describe('the commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, extra: Partial<Context> = {}) {
    const sent: [string, Record<string, unknown>][] = []
    const out: string[] = []
    const context: Context = {
      args,
      opts,
      json: false,
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string, params?: unknown) => (sent.push([method, params as Record<string, unknown>]), { text: 'ok' })) as Context['send'],
      print: (_value, text) => void out.push(typeof text === 'function' ? text() : text),
      confirm: async () => true,
      note: () => undefined,
      progress: () => undefined,
      ...extra
    }
    return { context, sent, out }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('sends the tab number as a number and the workspace as typed', async () => {
    const chat = fakeContext(['api'], { tab: '2', tail: '3', since: 'aaaa', 'tool-output': true })
    await tabRunners.chat(chat.context)
    expect(chat.sent[0]).toEqual(['chat', { workspace: 'api', cwd: '/work', tab: 2, tail: 3, since: 'aaaa', toolOutput: true }])
    await expect(tabRunners.chat(fakeContext(['api'], { tab: 'two' }).context)).rejects.toThrow('--tab takes a tab number')
    await expect(tabRunners.chat(fakeContext([], {}).context)).rejects.toThrow('Name a workspace')
  })

  it('tab set builds the patch from the flag pairs and refuses contradictions and empty changes', async () => {
    const run = fakeContext(['api'], { tab: '1', title: 'T', 'no-fast': true, plan: true, 'include-note': true })
    await tabRunners['tab set'](run.context)
    expect(run.sent[0][1]).toMatchObject({ workspace: 'api', tab: 1, patch: { title: 'T', fast: false, plan: true, includeNote: true } })
    await expect(tabRunners['tab set'](fakeContext(['api'], { fast: true, 'no-fast': true }).context)).rejects.toThrow('can’t be used together')
    await expect(tabRunners['tab set'](fakeContext(['api'], {}).context)).rejects.toThrow('Say what to change')
  })

  it('queue turns its words into a verb, a message and the text', async () => {
    const edit = fakeContext(['api', 'edit', '2', 'new', 'words'], { tab: '1' })
    await tabRunners.queue(edit.context)
    expect(edit.sent[0][1]).toMatchObject({ verb: 'edit', message: '2', text: 'new words', tab: 1 })
    const move = fakeContext(['api', 'move', '2', 'up'])
    await tabRunners.queue(move.context)
    expect(move.sent[0][1]).toMatchObject({ verb: 'move', direction: 'up' })
    const list = fakeContext(['api'])
    await tabRunners.queue(list.context)
    expect(list.sent[0][1]).toMatchObject({ verb: 'list' })
    await expect(tabRunners.queue(fakeContext(['api', 'move', '2', 'left']).context)).rejects.toThrow('up|down')
    await expect(tabRunners.queue(fakeContext(['api', 'remove']).context)).rejects.toThrow('Name the queued message')
  })

  it('rewind needs the turn and asks first; a no sends nothing', async () => {
    const asked: string[] = []
    const yes = fakeContext(['api'], { turn: 'aaaa', tab: '2' }, { confirm: async (q) => (asked.push(q), true) })
    await tabRunners.rewind(yes.context)
    expect(yes.sent[0]).toEqual(['rewind', { workspace: 'api', cwd: '/work', tab: 2, turn: 'aaaa' }])
    expect(asked[0]).toContain('tab 2 of api')
    await expect(tabRunners.rewind(fakeContext(['api'], {}).context)).rejects.toThrow('Say which turn')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const no = fakeContext(['api'], { turn: 'aaaa' }, { confirm: async () => false })
    await tabRunners.rewind(no.context)
    expect(no.sent).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('tab reopen sends the closed tab’s id; search joins its words', async () => {
    const reopen = fakeContext(['api'], { tab: '3f9a' })
    await tabRunners['tab reopen'](reopen.context)
    expect(reopen.sent[0][1]).toMatchObject({ id: '3f9a' })
    const search = fakeContext(['rate', 'limiter'], { notes: true, limit: '5' })
    await tabRunners.search(search.context)
    expect(search.sent[0]).toEqual(['search', { query: 'rate limiter', toolOutput: undefined, notes: true, limit: 5 }])
  })
})

describe('the command table', () => {
  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of TAB_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(tabRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, name).toBe(shorts.length)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(tabRunners).sort()).toEqual(TAB_COMMANDS.map(commandName).sort())
  })

  it('marks rewind as something the assistant only shows, and parses the flag pairs', () => {
    expect(TAB_COMMANDS.find((c) => commandName(c) === 'rewind')?.noAssistant).toBeTruthy()
    const set = TAB_COMMANDS.find((c) => commandName(c) === 'tab set')!
    expect(parseCommandArgs(set, ['api', '--tab', '2', '--no-plan', '--auto-accept-edits']).opts).toMatchObject({ tab: '2', 'no-plan': true, 'auto-accept-edits': true })
    expect(() => parseCommandArgs(set, ['api', '--turn', 'x'])).toThrow('doesn’t take --turn')
  })
})
