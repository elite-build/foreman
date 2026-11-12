// @vitest-environment jsdom
// #127: the phone page itself (resources/mobile/app.js) offers the window's actions: queue or steer while a turn runs,
// the queue's Send now and Delete, a comment on a diff line, a workspace's terminals and its usage. Driven as a phone
// would be, against a fake server: what it shows, and what it asks the computer to do.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, waitFor, within } from '@testing-library/dom'

const SCRIPT = readFileSync(path.join(process.cwd(), 'resources/mobile/app.js'), 'utf8')
const at = new Date().toISOString()

function model(overrides: Record<string, unknown> = {}) {
  return {
    repos: [{ id: 'repo-1', name: 'Repo' }],
    workspaces: [{ id: 'ws-1', repoId: 'repo-1', name: 'Work', branch: 'feature/x', bucket: 'working', label: 'Working', since: at, sessionId: 'chat-1', facts: [], checks: null, pr: null }],
    sessions: [{ id: 'chat-1', workspaceId: 'ws-1', agent: 'claude', model: 'opus', status: 'running', queued: 1, queue: [{ id: 'q1', text: 'Then run the tests' }], canSteer: true, context: { used: 84_000, limit: 200_000 } }],
    approvals: [],
    templates: [],
    followUpMode: 'steer',
    comments: [
      { id: 'c-mine', workspaceId: 'ws-1', file: 'src/a.ts', line: 4, side: 'new', body: 'Rename this', author: 'user', state: 'pending' },
      { id: 'c-agent', workspaceId: 'ws-1', file: 'src/a.ts', line: 9, side: 'new', body: 'Left a TODO', author: 'agent', authorLabel: 'Claude · opus', state: 'open' }
    ],
    ...overrides
  }
}
const diff = {
  baseRef: 'main', truncated: false,
  files: [{ path: 'src/a.ts', additions: 1, deletions: 1, binary: false, hunks: [{ header: '@@ -3,2 +3,2 @@', lines: [
    { type: 'ctx', oldNo: 3, newNo: 3, text: 'const a = 1' },
    { type: 'del', oldNo: 4, text: 'const b = 2' },
    { type: 'add', newNo: 4, text: 'const b = 3' }
  ] }] }]
}
const terminals = [
  { id: 'p1', kind: 'shell', startedAt: at, text: '$ ls\nsrc' },
  { id: 'p2', kind: 'script', command: 'npm run dev', startedAt: at, text: 'ready on :5173', code: 1 }
]
const usage = { tabs: { 'chat-1': { turns: 3, agentMs: 600_000, costUsd: 1.5 } }, total: { turns: 5, agentMs: 1_200_000, costUsd: 2.25, partial: false } }

let calls: { method: string; path: string; body?: unknown }[]
function serve(state: ReturnType<typeof model>, scopes = ['read', 'operate'], chat: unknown[] = []) {
  calls = []
  const routes: Record<string, unknown> = {
    'GET /api/state': state, 'GET /api/session': { id: 'd', name: 'Phone', kind: 'phone', scopes }, 'GET /api/chat/chat-1?live=1': chat,
    'GET /api/workspace/ws-1/diff': diff, 'GET /api/workspace/ws-1/terminals': terminals, 'GET /api/workspace/ws-1/usage': usage,
    'POST /api/chat/chat-1/send': { disposition: 'queued' }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, path: url, ...(init.body ? { body: JSON.parse(init.body) } : {}) })
    const value = routes[`${method} ${url}`] ?? { ok: true }
    return { ok: true, status: 200, json: async () => value }
  }))
}
const app = () => document.getElementById('app')!
const button = (name: string | RegExp) => within(app()).getByRole('button', { name })
async function start(state = model(), scopes?: string[], chat: unknown[] = []) {
  serve(state, scopes, chat)
  new Function(SCRIPT)()
  await waitFor(() => expect(within(app()).getByText('Work')).toBeTruthy())
  fireEvent.click(within(app()).getByText('Work').closest('button')!)
  await waitFor(() => expect(calls.some((c) => c.path === '/api/chat/chat-1?live=1')).toBe(true))
}
const posted = (pathname: string) => calls.filter((c) => c.method === 'POST' && c.path === pathname).map((c) => c.body)

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="toast" role="status"></div>'
  sessionStorage.clear()
  history.replaceState(null, '', '/')
})
afterEach(() => vi.unstubAllGlobals())

describe('the phone page (#127)', () => {
  it('queues or steers while a turn runs, starting from the computer’s setting, and sends the queue’s Send now and Delete', async () => {
    await start()
    const mode = button('Steer')
    expect(mode.getAttribute('aria-pressed')).toBe('true')
    // #164: a steered message doesn't take your diff comments; the next turn's first message does.
    expect(within(app()).getByText('1 diff comment waits for the next turn, not this message')).toBeTruthy()
    // Switched for this chat, in place (the draft keeps its focus).
    fireEvent.click(mode)
    expect(mode.textContent).toBe('Queue')
    expect(mode.getAttribute('aria-pressed')).toBe('false')
    expect(within(app()).getByText('1 diff comment will go with this message')).toBeTruthy()
    const draft = app().querySelector<HTMLTextAreaElement>('#draft')!
    expect(draft.placeholder).toBe('Queue a follow-up…')
    fireEvent.input(draft, { target: { value: 'Also update the docs' } })
    fireEvent.click(button('Send'))
    await waitFor(() => expect(posted('/api/chat/chat-1/send')).toEqual([{ text: 'Also update the docs', mode: 'queue' }]))

    const queued = within(app()).getByRole('group', { name: 'Queued messages' })
    expect(within(queued).getByText('Then run the tests')).toBeTruthy()
    fireEvent.click(within(queued).getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(posted('/api/chat/chat-1/queued/q1')).toEqual([{ action: 'steer' }]))
    fireEvent.click(within(within(app()).getByRole('group', { name: 'Queued messages' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(posted('/api/chat/chat-1/queued/q1')).toEqual([{ action: 'steer' }, { action: 'remove' }]))
  })

  it('labels the queue’s action by what it does: Interrupt and send for an agent that can only be interrupted, Send now for one that steers', async () => {
    const state = model()
    state.sessions[0] = { ...state.sessions[0], agent: 'cursor', canSteer: false, canInterrupt: true } as typeof state.sessions[0]
    await start(state)
    const queued = within(app()).getByRole('group', { name: 'Queued messages' })
    expect(within(queued).queryByRole('button', { name: 'Send now' })).toBeNull()
    const interrupt = within(queued).getByRole('button', { name: 'Interrupt and send' })
    expect(interrupt.getAttribute('title')).toMatch(/Work in progress is cut/)
    // Neither action asks first: the label is the warning, here and in the window.
    fireEvent.click(interrupt)
    await waitFor(() => expect(posted('/api/chat/chat-1/queued/q1')).toEqual([{ action: 'steer' }]))
    await waitFor(() => expect(document.getElementById('toast')!.textContent).toBe('Interrupted the agent and sent'))
  })

  it('offers no steering for an agent that can’t take a message mid-turn', async () => {
    const state = model()
    state.sessions[0] = { ...state.sessions[0], canSteer: false }
    await start(state)
    expect(within(app()).queryByRole('button', { name: /^(Steer|Queue)$/ })).toBeNull()
    expect(within(app()).queryByRole('button', { name: 'Send now' })).toBeNull()
    expect(within(app()).getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('offers a resume time for a usage limit only where the agent’s record says its reset time can be read', async () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString()
    const failed = [{ id: 'e1', kind: 'turn-end', turnId: 't1', outcome: 'failed', error: 'limit', limit: { source: 'resets 2:30pm', resetAt, from: 'text' } }]
    const readsReset = { usage: { resetTime: true } }
    // The record carries it for the agent in use: the time and where it came from.
    const reads = model({ agentCapabilities: { claude: readsReset } })
    reads.sessions[0] = { ...reads.sessions[0], status: 'idle', queued: 0, queue: [] }
    await start(reads, undefined, failed)
    await waitFor(() => expect(within(app()).getByText(/^Resets \d\d:\d\d · from Claude/)).toBeTruthy())
    expect(within(app()).queryByText('Reset time unknown')).toBeNull()
    document.body.innerHTML = '<div id="app"></div><div id="toast" role="status"></div>'
    // Another agent whose record says it can't, and an agent with no record at all, say the time is unknown.
    for (const agentCapabilities of [{ cursor: { usage: { resetTime: false } } }, undefined]) {
      const unknown = model({ agentCapabilities })
      unknown.sessions[0] = { ...unknown.sessions[0], agent: 'cursor', status: 'idle', queued: 0, queue: [] }
      await start(unknown, undefined, failed)
      await waitFor(() => expect(within(app()).getByText('Reset time unknown')).toBeTruthy())
      document.body.innerHTML = '<div id="app"></div><div id="toast" role="status"></div>'
    }
  })

  // Docs/agents.md 7.2: the phone's card for a chat paused at a usage limit: when it resumes by itself, Resume now, Dismiss, and
  // Continue on the account with room (the window sends the options; the phone never works them out).
  it('shows a paused chat’s card with Resume now, Continue on the other account and Dismiss, and asks the computer for each', async () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString()
    const failed = [{ id: 'e1', kind: 'turn-end', turnId: 't1', outcome: 'error', error: 'limit', limit: { source: 'five_hour', resetAt, from: 'event' } }]
    const paused = model()
    paused.sessions[0] = { ...paused.sessions[0], status: 'idle', queued: 0, queue: [], lastTurn: { outcome: 'limit', turnId: 't1', endedAt: at, resetAt }, limitResume: { turnId: 't1', resetAt, at: resetAt, source: 'five_hour', text: 'Continue where you left off.', armedAt: at, auto: true }, continueOn: [{ instance: 'ai-work', label: 'Work' }] } as never
    await start(paused, undefined, failed)
    await waitFor(() => expect(within(app()).getByText(/^Paused: limit · resets \d\d:\d\d$/)).toBeTruthy())
    expect(within(app()).queryByText(/Turn failed/)).toBeNull()
    expect(within(app()).getByText(/sends “Continue where you left off.” at \d\d:\d\d, once/i)).toBeTruthy()
    fireEvent.click(button('Continue on account Work'))
    await waitFor(() => expect(posted('/api/chat/chat-1/resume-at')).toEqual([{ continueOn: 'ai-work' }]))
    fireEvent.click(button('Resume now'))
    await waitFor(() => expect(posted('/api/chat/chat-1/resume-at')).toContainEqual({ now: true }))
    fireEvent.click(button('Dismiss'))
    await waitFor(() => expect(posted('/api/chat/chat-1/resume-at')).toContainEqual({ cancel: true }))
  })

  it('comments on a diff line, and shows the comments waiting there with Delete and Resolve', async () => {
    await start()
    fireEvent.click(button('Changes'))
    await waitFor(() => expect(within(app()).getByText('a.ts')).toBeTruthy())
    expect(within(app()).getByText('1 comment will go with your next message.')).toBeTruthy()
    fireEvent.click(within(app()).getByText('a.ts').closest('button')!)
    // Your comment under its line; the agent's, on a line the diff doesn't show, under the file.
    expect(within(app()).getByText('Rename this')).toBeTruthy()
    expect(within(app()).getByText('Other comments')).toBeTruthy()
    expect(within(app()).getByText('Left a TODO')).toBeTruthy()
    // Every line takes a comment: on its new number, and (#164) a removed line on its old one.
    expect(within(app()).getAllByRole('button', { name: /^Comment on/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Comment on line 3', 'Comment on removed line 4', 'Comment on line 4'])
    fireEvent.click(button('Comment on line 4'))
    const box = within(app()).getByRole('textbox', { name: 'Comment on line 4' })
    fireEvent.input(box, { target: { value: 'Should be 4?' } })
    fireEvent.click(button('Add comment'))
    await waitFor(() => expect(posted('/api/workspace/ws-1/comment')).toEqual([{ file: 'src/a.ts', line: 4, side: 'new', body: 'Should be 4?' }]))
    // A removed line's comment quotes the line, so the agent knows which one was meant.
    fireEvent.click(button('Comment on removed line 4'))
    fireEvent.input(within(app()).getByRole('textbox', { name: 'Comment on removed line 4' }), { target: { value: 'Keep this one' } })
    fireEvent.click(button('Add comment'))
    await waitFor(() => expect(posted('/api/workspace/ws-1/comment')).toHaveLength(2))
    expect(posted('/api/workspace/ws-1/comment')[1]).toEqual({ file: 'src/a.ts', line: 4, side: 'old', quote: 'const b = 2', body: 'Keep this one' })
    fireEvent.click(button('Delete'))
    fireEvent.click(button('Resolve'))
    await waitFor(() => expect([...posted('/api/comment/c-mine'), ...posted('/api/comment/c-agent')]).toEqual([{ action: 'delete' }, { action: 'resolve' }]))
  })

  it('reads a workspace’s terminals, each with its end of output and whether it still runs', async () => {
    await start()
    fireEvent.click(button(/^Terminal/))
    await waitFor(() => expect(within(app()).getByText('ready on :5173')).toBeTruthy())
    // The newest is shown; the others are a tap away.
    expect(within(app()).getByText('Ended · exit 1')).toBeTruthy()
    fireEvent.click(button('Terminal 1'))
    expect(within(app()).getByText(/\$ ls/)).toBeTruthy()
    expect(within(app()).getByText('Running')).toBeTruthy()
    expect(within(app()).getByText('Read-only here. Type in it in Foreman on your computer.')).toBeTruthy()
  })

  it('shows the chat’s context and what the chat and the workspace used in the workspace menu', async () => {
    await start()
    fireEvent.click(button('Workspace actions'))
    await waitFor(() => expect(within(app()).getByText('3 turns · 10 min · $1.50')).toBeTruthy())
    expect(within(app()).getByText('42% · 84k of 200k')).toBeTruthy()
    expect(within(app()).getByText('5 turns · 20 min · $2.25')).toBeTruthy()
  })

  it('says which subagent asks on a permission card, and shows only the Task row for a subagent’s own calls (docs/agents.md 6)', async () => {
    const state = model({
      approvals: [{ id: 'a1', sessionId: 'chat-1', kind: 'tool', toolName: 'Bash', input: { command: 'npm test' }, subagent: { id: 'task-1', name: 'explore-tests' } }]
    })
    const chat = [
      { id: 'tu1', kind: 'tool', turnId: 't1', name: 'Task', input: { description: 'explore-tests' }, status: 'running' },
      { id: 'c1', kind: 'tool', turnId: 't1', name: 'Grep', input: { pattern: 'child-only-needle' }, status: 'done', parentToolUseId: 'tu1' },
      { id: 'm1', kind: 'assistant', turnId: 't1', text: 'child-only-words', parentToolUseId: 'tu1' }
    ]
    await start(state, undefined, chat)
    await waitFor(() => expect(within(app()).getByText('From subagent explore-tests')).toBeTruthy())
    expect(within(app()).getByText('Permission needed · Bash')).toBeTruthy()
    expect(app().textContent).not.toMatch(/child-only/)
    // Answering is unchanged.
    fireEvent.click(button('Allow'))
    await waitFor(() => expect(posted('/api/approval/a1')).toEqual([{ kind: 'tool', allow: true }]))
  })

  it('offers a watching phone none of it: no composer, no line to comment on, no terminals', async () => {
    await start(model(), ['read'])
    await waitFor(() => expect(within(app()).getByText('This phone can watch. Approve it again with more access to act.')).toBeTruthy())
    expect(within(app()).queryByRole('button', { name: /^Terminal/ })).toBeNull()
    expect(within(app()).queryByRole('button', { name: 'Send now' })).toBeNull()
    fireEvent.click(button('Changes'))
    await waitFor(() => expect(within(app()).getByText('a.ts')).toBeTruthy())
    fireEvent.click(within(app()).getByText('a.ts').closest('button')!)
    expect(within(app()).queryByRole('button', { name: /^Comment on line/ })).toBeNull()
    expect(within(app()).queryByRole('button', { name: 'Delete' })).toBeNull()
  })
})
