// @vitest-environment jsdom
// Subagents as first-class (docs/agents.md 6), in the window: a Task call opens into what its subagent did (a Tree, folded
// by default, one tab stop), each running subagent has its own Stop named for it, an approval from one says who asks, and
// a chat draws the subagent's items under its Task row instead of in the log.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { QuestionPanel, ToolApprovalPanel } from '../src/renderer/src/components/ApprovalPanel'
import { ToolRow, type Subtree } from '../src/renderer/src/components/ToolRow'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-10-27T10:00:00.000Z'
const task = (over: Record<string, unknown> = {}) =>
  ({ kind: 'tool', id: 'tu1', turnId: 't1', name: 'Task', input: { description: 'explore-tests', subagent_type: 'Explore' }, status: 'running', childId: 'task-1', task: { status: 'running', toolUses: 2, durationMs: 4000 }, ...over }) as never
const call = (id: string, name: string, input: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ kind: 'tool', id, turnId: 't1', parentToolUseId: 'tu1', name, input, status: 'done', output: 'ok', ...over }) as never
const said = (id: string, text: string) => ({ kind: 'assistant', id, turnId: 't1', parentToolUseId: 'tu1', text }) as never

const children = [call('c1', 'Read', { file_path: 'tests/sessions.test.ts' }), call('c2', 'Bash', { command: 'npm test', description: 'Run the sessions tests' }), said('m1', 'The three failures share a tmpdir')]
const subtree = (list = children, root = 'tu1'): Subtree => new Map([[root, list as never]])

function row(options: { item?: never; subtree?: Subtree; onStop?: (id: string) => Promise<boolean | undefined>; waiting?: ReadonlySet<string> } = {}) {
  return render(
    <ToolRow item={options.item ?? task()} workspacePath="/w" expandByDefault={false} subtree={options.subtree ?? subtree()} onStopChild={options.onStop} waiting={options.waiting} />
  )
}

beforeEach(resetFake)
afterEach(cleanup)

describe('a Task call with a subagent’s own calls', () => {
  it('keeps them folded until the row opens, then lists them in one tree with a single tab stop', async () => {
    const user = userEvent.setup()
    row()
    expect(screen.queryByRole('tree')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    const tree = screen.getByRole('tree', { name: 'What subagent explore-tests did' })
    const items = within(tree).getAllByRole('treeitem')
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('tests/sessions.test.ts'), expect.stringContaining('Run the sessions tests'), expect.stringContaining('The three failures share a tmpdir')])
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1)
    // Keyboard: arrows move between rows.
    items[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(items[1])
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(items[2])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(items[0])
  })

  it('jumps to a row by typing what it shows, not the item’s id', async () => {
    const user = userEvent.setup()
    row()
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    const items = within(screen.getByRole('tree')).getAllByRole('treeitem')
    items[0].focus()
    // The ids are c1, c2 and m1: "c" would find a row by its id. The rows are named for what they say.
    await user.keyboard('The three')
    expect(document.activeElement).toBe(items[2])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(items[0])
    // Typing pauses between searches.
    await new Promise((resolve) => setTimeout(resolve, 900))
    await user.keyboard('Run the')
    expect(document.activeElement).toBe(items[1])
  })

  it('opens from the keyboard too', async () => {
    const user = userEvent.setup()
    row()
    const header = screen.getByRole('button', { name: /^explore-tests/ })
    header.focus()
    await user.keyboard('{Enter}')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('tree')).toBeTruthy()
  })

  it('draws a plain tool row, with no tree and no Stop, when the agent reported no subagent', async () => {
    const user = userEvent.setup()
    render(<ToolRow item={task({ childId: undefined, task: undefined, status: 'done' })} workspacePath="/w" expandByDefault={false} onStopChild={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('marks a failed call of the subagent by shape and word, not colour', async () => {
    const user = userEvent.setup()
    row({ subtree: subtree([call('c9', 'Bash', { command: 'false' }, { status: 'error' })]) })
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    expect(within(screen.getByRole('tree')).getByText('Failed')).toBeTruthy()
  })
})

describe('Stop on a subagent', () => {
  it('is a button named for the subagent, beside the row, and tells the agent once', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn(async () => true as boolean | undefined)
    row({ onStop })
    const stop = screen.getByRole('button', { name: 'Stop subagent explore-tests' })
    await user.click(stop)
    expect(onStop).toHaveBeenCalledWith('task-1')
    // Not the row opening.
    expect(screen.queryByRole('tree')).toBeNull()
    const sent = screen.getByRole('button', { name: 'Stopping subagent explore-tests' })
    expect((sent as HTMLButtonElement).disabled).toBe(true)
  })

  it('comes back when the agent could not be told', async () => {
    const user = userEvent.setup()
    row({ onStop: vi.fn(async () => undefined) })
    await user.click(screen.getByRole('button', { name: 'Stop subagent explore-tests' }))
    expect((await screen.findByRole('button', { name: 'Stop subagent explore-tests' })) as HTMLButtonElement).toHaveProperty('disabled', false)
  })

  it('is not offered once the subagent has ended, or for an agent that can’t stop one', () => {
    const { unmount } = row({ item: task({ status: 'done', task: { status: 'completed' } }), onStop: vi.fn(async () => true) })
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
    unmount()
    row({})
    expect(screen.queryByRole('button', { name: /^Stop/ })).toBeNull()
  })

  it('says a subagent is waiting for you while its approval is open', () => {
    row({ waiting: new Set(['task-1']), onStop: vi.fn(async () => true) })
    expect(screen.getByText('Waiting for you')).toBeTruthy()
  })

  it('has its own Stop on a subagent inside the subagent, and keys on it stay its own', async () => {
    const user = userEvent.setup()
    const nested = call('tu2', 'Task', { description: 'find-flaky' }, { status: 'running', childId: 'task-2', task: { status: 'running', toolUses: 5 } })
    const onStop = vi.fn(async () => true as boolean | undefined)
    const tree: Subtree = new Map<string, never[]>([
      ['tu1', [nested] as never],
      ['tu2', [call('c5', 'Grep', { pattern: 'tmpdir' }, { parentToolUseId: 'tu2' })] as never]
    ])
    row({ subtree: tree, onStop })
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    const treeEl = screen.getByRole('tree')
    const branch = within(treeEl).getByRole('treeitem', { name: /find-flaky/ })
    expect(branch.getAttribute('aria-expanded')).toBe('false')
    await user.click(within(branch).getByRole('button', { name: 'Stop subagent find-flaky' }))
    expect(onStop).toHaveBeenCalledWith('task-2')
    // Stopping did not open the branch; → does.
    expect(branch.getAttribute('aria-expanded')).toBe('false')
    branch.focus()
    await user.keyboard('{ArrowRight}')
    expect(branch.getAttribute('aria-expanded')).toBe('true')
    expect(within(treeEl).getAllByRole('treeitem')).toHaveLength(2)
  })
})

describe('an approval from a subagent', () => {
  it('says who is asking on the tool card and the question card', () => {
    const { unmount } = render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' }, subagent: { id: 'task-1', name: 'explore-tests' } } as never} workspacePath="/w" />)
    expect(screen.getByText('explore-tests').closest('div')!.textContent).toBe('From subagent explore-tests')
    expect(screen.getByRole('group', { name: /command|Run|Bash/i }).getAttribute('aria-describedby')).toBeTruthy()
    unmount()
    render(<QuestionPanel request={{ kind: 'question', id: 'q1', sessionId: 's1', questions: [{ question: 'Which?', options: [{ label: 'A' }] }], subagent: { id: 'task-1', name: 'explore-tests' } } as never} />)
    expect(screen.getByText('From subagent', { exact: false }).textContent).toContain('explore-tests')
  })

  it('says “From a subagent” when it has no name, and nothing on an ordinary card', () => {
    const { unmount } = render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, subagent: { id: 'x', name: '' } } as never} workspacePath="/w" />)
    expect(screen.getByText('From a subagent')).toBeTruthy()
    unmount()
    render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a2', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' } } as never} workspacePath="/w" />)
    expect(screen.queryByText(/From (a )?subagent/)).toBeNull()
  })

  it('still answers as it did', async () => {
    const user = userEvent.setup()
    fakeApi.respondApproval = vi.fn(async () => undefined)
    render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, subagent: { id: 'task-1', name: 'explore-tests' } } as never} workspacePath="/w" />)
    await user.click(screen.getByRole('button', { name: /^Yes/ }))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', { kind: 'tool', allow: true, alternate: false, message: undefined })
  })
})

describe('a chat with a subagent', () => {
  const session = { id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', turnId: 't1', queue: [], title: 'Login bug', createdAt: at } as never
  const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never

  beforeEach(() => {
    fakeState.snapshot.agentCapabilities = undefined
    fakeState.approvals = []
    fakeState.chats = {
      s1: [
        { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the sessions tests', at },
        { kind: 'assistant', id: 'a1', turnId: 't1', text: 'I will look into it' },
        task(),
        ...children
      ]
    }
  })

  it('draws the subagent’s items under its Task row, not as rows of the log', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatView session={session} workspace={workspace} active headingLevel={2} />)
    // The log has the parent's own rows: its message, and the Task call. Not the subagent's calls or its message.
    expect(container.querySelectorAll('[data-tool]')).toHaveLength(1)
    expect(screen.queryByText('The three failures share a tmpdir')).toBeNull()
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByText('The three failures share a tmpdir')).toBeTruthy()
  })

  it('stops one subagent through the Api for the chat, for an agent whose record allows it', async () => {
    const user = userEvent.setup()
    fakeApi.stopChild = vi.fn(async () => undefined)
    render(<ChatView session={session} workspace={workspace} active headingLevel={2} />)
    await user.click(screen.getByRole('button', { name: 'Stop subagent explore-tests' }))
    expect(fakeApi.stopChild).toHaveBeenCalledWith('s1', 'task-1')
  })

  it('offers no Stop for an agent whose record has none, and marks the subagent that waits on an approval', () => {
    render(<ChatView session={{ ...(session as object), agent: 'codex' } as never} workspace={workspace} active headingLevel={2} />)
    expect(screen.queryByRole('button', { name: /^Stop subagent/ })).toBeNull()
    cleanup()
    fakeState.approvals = [{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' }, subagent: { id: 'task-1', name: 'explore-tests' } }]
    render(<ChatView session={session} workspace={workspace} active headingLevel={2} />)
    expect(screen.getAllByText('Waiting for you').length).toBeGreaterThan(0)
    expect(screen.getByText('From subagent', { exact: false }).textContent).toContain('explore-tests')
  })

  it('keeps the turn heading’s count of tool calls to the parent’s own', () => {
    render(<ChatView session={session} workspace={workspace} active headingLevel={2} />)
    expect(screen.getByRole('heading', { name: /1 tool call/ })).toBeTruthy()
  })

  it('draws a subagent resumed with SendMessage as a subagent row of its own, with what it did since', async () => {
    const user = userEvent.setup()
    fakeApi.stopChild = vi.fn(async () => undefined)
    const resumed = { kind: 'tool', id: 'sm1', turnId: 't1', name: 'SendMessage', input: { to: 'task-1', summary: 'Resume explore-tests', message: 'Carry on' }, status: 'done', output: 'Resumed', childId: 'task-1', task: { status: 'running', background: true, toolUses: 1 } } as never
    fakeState.chats = {
      s1: [
        { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the sessions tests', at },
        task({ status: 'done', task: { status: 'failed' } }),
        ...children,
        resumed,
        // The resumed run's frames still name the first call.
        call('c3', 'Grep', { pattern: 'tmpdir' })
      ]
    }
    const { container } = render(<ChatView session={session} workspace={workspace} active headingLevel={2} />)
    expect(screen.queryByText('SendMessage')).toBeNull()
    // The background strip names it the same way.
    expect(container.querySelector('.bg-tasks')?.textContent).toContain('Resume explore-tests')
    const resumeRow = within(container.querySelector<HTMLElement>('[data-tool="sm1"]')!).getByRole('button', { name: /^Resume explore-tests/ })
    expect(resumeRow.textContent).toContain('resumed')
    await user.click(screen.getByRole('button', { name: 'Stop subagent Resume explore-tests' }))
    expect(fakeApi.stopChild).toHaveBeenCalledWith('s1', 'task-1')
    await user.click(resumeRow)
    const since = within(screen.getByRole('tree', { name: 'What subagent Resume explore-tests did' })).getAllByRole('treeitem')
    expect(since.map((i) => i.textContent)).toEqual([expect.stringContaining('tmpdir')])
    // The first run keeps its own.
    await user.click(screen.getByRole('button', { name: /^explore-tests/ }))
    expect(within(screen.getByRole('tree', { name: 'What subagent explore-tests did' })).getAllByRole('treeitem')).toHaveLength(3)
  })
})

