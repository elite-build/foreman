// @vitest-environment jsdom
// Each turn closes with a receipt: how it ended (a shape and a word), its time and cost, and what this turn did (its files and
// commands, never the workspace's total). The latest turn's is open, with a chip per file and per command; older ones fold to
// one line. A failed turn's card leads with the cause, names what the turn left, offers its output, Retry (with Restore in its
// menu only when the message has a checkpoint) and "Ask … to fix it", which fills the composer without sending.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-10-27T10:00:00.000Z'
const workspace = (over: Record<string, unknown> = {}) =>
  ({ id: 'w1', name: 'osaka', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1', diffStat: { files: 3, additions: 7, deletions: 3 }, ...over }) as never
const session = { id: 's1', workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Rate limit', createdAt: at } as never

const user = (n: number, over: Record<string, unknown> = {}) => ({ kind: 'user', id: `u${n}`, turnId: `t${n}`, text: `Question ${n}`, at, ...over })
const bash = (n: number, ok: boolean) => ({
  kind: 'tool',
  id: `b${n}`,
  turnId: `t${n}`,
  name: 'Bash',
  input: { command: 'npm test -- session', description: 'Run the session tests' },
  status: ok ? 'done' : 'error',
  output: ok ? 'Tests 4 passed (4)' : 'Exit code 1\n× resets the window after a minute\nTests 1 failed | 4 passed (5)'
})
const result = (n: number, costUsd: number) => ({ kind: 'result', id: `r${n}`, turnId: `t${n}`, ok: true, costUsd })
const end = (n: number, over: Record<string, unknown> = {}) => ({ kind: 'turn-end', id: `e${n}`, turnId: `t${n}`, outcome: 'completed', durationMs: 41_000, ...over })
const delta = (path: string, additions: number, deletions: number) => ({ files: [{ path, additions, deletions }], additions, deletions })

const fillComposer = () => storeModule.fillComposer as Mock

beforeEach(() => {
  resetFake()
  Object.assign(fakeState, { approvals: [], activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
  fakeApi.restoreCheckpoint = vi.fn(async () => undefined)
  fakeApi.sendMessage = vi.fn(async () => undefined)
  fillComposer().mockClear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const receipts = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.turn-receipt')]
const fold = (receipt: HTMLElement) => within(receipt).getAllByRole('button').find((b) => b.hasAttribute('aria-controls'))!

describe('the receipt', () => {
  it('says the turn completed, its time and cost, and this turn’s files and commands, open on the latest turn', () => {
    fakeState.chats = { s1: [user(1), bash(1, true), result(1, 0.18), end(1, { delta: delta('src/session.ts', 1, 1) })] }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [receipt] = receipts(container)
    expect(receipt.querySelector('.ui-status--ok')?.textContent).toBe('Completed')
    expect(receipt.textContent).toContain('41s · $0.18')
    const button = fold(receipt)
    expect(button.textContent).toBe('1 file +1 −1 · 1 command')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(receipt.textContent).toContain('Changed')
    expect(within(receipt).getByRole('button', { name: /src\/session\.ts/ })).toBeTruthy()
    const ran = within(receipt).getByRole('button', { name: /npm test -- session/ })
    expect(ran.textContent).toContain('Passed')
    // The workspace's total stays in the header and side panel, not the transcript.
    expect(container.textContent).not.toContain('workspace changes')
    expect(container.textContent).not.toContain('+7')
  })

  it('folds older turns to one line and opens them on request', async () => {
    fakeState.chats = { s1: [user(1), bash(1, true), end(1, { delta: delta('src/login.ts', 2, 2) }), user(2), bash(2, true), end(2, { delta: delta('src/session.ts', 1, 1) })] }
    const u = userEvent.setup()
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [older, latest] = receipts(container)
    expect(fold(older).getAttribute('aria-expanded')).toBe('false')
    expect(fold(older).textContent).toBe('1 file +2 −2 · 1 command')
    expect(fold(latest).getAttribute('aria-expanded')).toBe('true')
    await u.click(fold(older))
    expect(fold(older).getAttribute('aria-expanded')).toBe('true')
  })

  it('names no files for a turn without both checkpoints, rather than the workspace’s', () => {
    fakeState.chats = { s1: [user(1), bash(1, true), end(1)] }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [receipt] = receipts(container)
    expect(fold(receipt).textContent).toBe('1 command')
    expect(receipt.textContent).not.toContain('Changed')
  })

  it('a turn with nothing to list has no fold', () => {
    fakeState.chats = { s1: [user(1), end(1)] }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [receipt] = receipts(container)
    expect(receipt.querySelector('[aria-controls]')).toBeNull()
    expect(receipt.textContent).toContain('Completed')
  })

  it('a turn that ended by asking the person waits for you, not Completed', () => {
    const ask = { kind: 'tool', id: 'q1', turnId: 't1', name: 'mcp__foreman-app__ask_person', input: { question: 'Which region?' }, status: 'done', output: 'Asked.' }
    fakeState.chats = { s1: [user(1), ask, end(1)] }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [receipt] = receipts(container)
    expect(receipt.querySelector('.ui-status--warn')?.textContent).toBe('Waiting for you')
    expect(receipt.textContent).not.toContain('Completed')
  })

  it('a turn whose push was held for approval waits for you too', () => {
    const push = { kind: 'tool', id: 'p1', turnId: 't1', name: 'mcp__foreman-app__request_push', input: {}, status: 'done', output: 'Held for the person: a push is recorded.' }
    fakeState.chats = { s1: [user(1), push, end(1)] }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    expect(receipts(container)[0].querySelector('.ui-status--warn')?.textContent).toBe('Waiting for you')
  })
})

describe('a failed turn', () => {
  const failed = (userOver: Record<string, unknown> = {}) => [
    user(1, userOver),
    bash(1, false),
    end(1, { outcome: 'error', error: 'The agent stopped: npm test exited with code 1.', delta: delta('src/rateLimit.ts', 1, 0) })
  ]

  it('ends with ◆ Failed, and the command chip says it failed', () => {
    fakeState.chats = { s1: failed() }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const [receipt] = receipts(container)
    expect(receipt.querySelector('.ui-status--error')?.textContent).toBe('Failed')
    expect(fold(receipt).textContent).toBe('1 file +1 · 1 command, 1 failed')
    expect(within(receipt).getByRole('button', { name: /npm test -- session/ }).textContent).toContain('Failed · exit 1')
  })

  it('has a card whose title is the cause and which names what the turn left', () => {
    fakeState.chats = { s1: failed() }
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const card = container.querySelector<HTMLElement>('.turn-recovery')!
    expect(card.querySelector('.ui-callout__title')?.textContent).toBe('npm test exited with code 1')
    expect(card.textContent).not.toContain('This turn ended with an error')
    expect(card.textContent).toContain('Claude Code stopped at “Run the session tests”, after 41s.')
    expect(card.textContent).toContain('This turn left 1 changed file:')
    expect(card.textContent).toContain('src/rateLimit.ts')
    expect(card.textContent).toContain('The changes are still in osaka.')
  })

  it('shows the failing command’s last lines on request', async () => {
    fakeState.chats = { s1: failed() }
    const u = userEvent.setup()
    const { container } = render(<ChatView session={session} workspace={workspace()} active />)
    const card = container.querySelector<HTMLElement>('.turn-recovery')!
    await u.click(within(card).getByRole('button', { name: 'Show output' }))
    expect(within(card).getByRole('button', { name: 'Hide output' }).getAttribute('aria-expanded')).toBe('true')
    expect(card.querySelector('.tool-output')?.textContent).toContain('Tests 1 failed | 4 passed (5)')
  })

  it('Ask Claude Code to fix it fills the composer and sends nothing', async () => {
    fakeState.chats = { s1: failed() }
    const u = userEvent.setup()
    render(<ChatView session={session} workspace={workspace()} active />)
    await u.click(screen.getByRole('button', { name: 'Ask Claude Code to fix it…' }))
    expect(fillComposer()).toHaveBeenCalledWith('w1', 's1', 'npm test exited with code 1. Find out why, fix it, and run `npm test -- session` again.')
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })

  it('Retry is the primary action and keeps the change; with no checkpoint it has no menu', async () => {
    fakeState.chats = { s1: failed() }
    const u = userEvent.setup()
    render(<ChatView session={session} workspace={workspace()} active />)
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry.className).toContain('ui-btn--primary')
    expect(screen.queryByRole('button', { name: 'More ways to retry' })).toBeNull()
    await u.click(retry)
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', 'Question 1', expect.anything()))
    expect(fakeApi.restoreCheckpoint).not.toHaveBeenCalled()
  })

  it('with a checkpoint, Retry’s menu restores and then sends again, after asking', async () => {
    fakeState.chats = { s1: failed({ checkpoint: 'cp1' }) }
    const u = userEvent.setup()
    render(<ChatView session={session} workspace={workspace()} active />)
    await u.click(screen.getByRole('button', { name: 'More ways to retry' }))
    expect(screen.getByRole('menuitem', { name: /Restore only/ })).toBeTruthy()
    await u.click(screen.getByRole('menuitem', { name: /Restore, then retry/ }))
    const dialog = screen.getByRole('dialog', { name: 'Restore to before this message?' })
    expect(fakeApi.restoreCheckpoint).not.toHaveBeenCalled()
    await u.click(within(dialog).getByRole('button', { name: 'Restore, then retry' }))
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', 'Question 1', expect.anything()))
    expect(fakeApi.restoreCheckpoint).toHaveBeenCalledWith('s1', 't1')
    expect((fakeApi.restoreCheckpoint as Mock).mock.invocationCallOrder[0]).toBeLessThan((fakeApi.sendMessage as Mock).mock.invocationCallOrder[0])
  })

  it('Restore only puts things back and sends nothing', async () => {
    fakeState.chats = { s1: failed({ checkpoint: 'cp1' }) }
    const u = userEvent.setup()
    render(<ChatView session={session} workspace={workspace()} active />)
    await u.click(screen.getByRole('button', { name: 'More ways to retry' }))
    await u.click(screen.getByRole('menuitem', { name: /Restore only/ }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(fakeApi.restoreCheckpoint).toHaveBeenCalledWith('s1', 't1'))
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })

  it('in an AI employee’s run, Retry is the run banner’s: the card offers only your own message', async () => {
    fakeState.chats = { s1: failed({ checkpoint: 'cp1' }) }
    const u = userEvent.setup()
    const run = workspace({ startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e1', taskId: 'k1', runId: 'r1', title: 'Rate limit' } })
    render(<ChatView session={session} workspace={run} active />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More ways to retry' })).toBeNull()
    const ask = screen.getByRole('button', { name: 'Ask Claude Code yourself…' })
    expect(ask.title).toMatch(/your own message/)
    await u.click(ask)
    expect(fillComposer()).toHaveBeenCalledTimes(1)
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })

  it('an older failed turn keeps its card but no actions', () => {
    fakeState.chats = { s1: [...failed(), user(2), end(2)] }
    render(<ChatView session={session} workspace={workspace()} active />)
    expect(screen.getByText('npm test exited with code 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
