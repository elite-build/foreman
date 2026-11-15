// @vitest-environment jsdom
// B2's riskiest surfaces: the approval and question cards (keys 1 to n+1, Enter, Ctrl+Enter, Esc, arrows over the
// question tabs) and the chat find bar (⌘F, Enter, Esc, named buttons).
import './domShims'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionPanel, ToolApprovalPanel } from '../src/renderer/src/components/ApprovalPanel'
import { ChatSearch } from '../src/renderer/src/components/ChatSearch'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeApi.respondApproval = vi.fn(async () => undefined)
})
afterEach(cleanup)

const tool = (overrides: Record<string, unknown> = {}) =>
  ({ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, ...overrides }) as never

describe('tool approval', () => {
  it('Enter allows, Esc denies, and the buttons say so', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    expect(screen.getByRole('button', { name: 'Run Enter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Don’t run Esc' })).toBeTruthy()
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', { kind: 'tool', allow: true, alternate: false, message: undefined })
    await user.keyboard('{Escape}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', { kind: 'tool', allow: false, alternate: false, message: undefined })
  })

  it('Enter in the reason field denies with that reason; the field has a name', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    const reason = screen.getAllByRole('textbox')[0]
    expect(reason.getAttribute('aria-label')).toBeTruthy()
    await user.type(reason, 'not now{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', { kind: 'tool', allow: false, alternate: false, message: 'not now' })
  })

  it('offers the alternate answer when the request has one', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    // Decline, alternate, main: the main one last.
    const foot = document.querySelector('.decision-foot') as HTMLElement
    expect(within(foot).getAllByRole('button').map((b) => b.textContent)).toEqual(['Don’t run Esc', 'Always allow Ctrl+Enter', 'Run Enter'])
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', { kind: 'tool', allow: true, alternate: true, message: undefined })
  })
})

const question = (n = 2) =>
  ({
    kind: 'question',
    id: 'q1',
    sessionId: 's1',
    questions: Array.from({ length: n }, (_, i) => ({
      header: `H${i}`,
      question: `Question ${i + 1}?`,
      multiSelect: false,
      options: [
        { label: 'Alpha', description: 'first' },
        { label: 'Beta', description: 'second' }
      ]
    }))
  }) as never

describe('questions', () => {
  it('keys 1-n choose an option without moving on; Enter goes to the next question, then sends every answer', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question()} />)
    const card = screen.getByRole('group', { name: '2 questions' })
    expect(screen.getByRole('tab', { name: /H0/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /H0/ }).textContent).toContain('not answered yet')
    expect(card.textContent).toContain('0 of 2 answered')
    card.focus()
    await user.keyboard('2')
    expect((screen.getByRole('radio', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
    // Picking doesn't advance: the first question stays, marked answered, and the main button names the next one.
    expect(screen.getByRole('tab', { name: /H0/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /H0/ }).textContent).not.toContain('not answered yet')
    expect(card.textContent).toContain('1 of 2 answered')
    expect(screen.getByRole('button', { name: /^Next: H1/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: /H1/ }).getAttribute('aria-selected')).toBe('true')
    await user.keyboard('1')
    expect(screen.getByRole('button', { name: /^Send answers/ })).toBeTruthy()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('q1', { kind: 'question', answers: { 'Question 1?': 'Beta', 'Question 2?': 'Alpha' } })
  })

  it('a single-choice question’s options are radios that show what is chosen', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(1)} />)
    expect(screen.getByRole('group', { name: 'Choose one' })).toBeTruthy()
    const alpha = screen.getByRole('radio', { name: 'Alpha' }) as HTMLInputElement
    expect(alpha.checked).toBe(false)
    await user.click(alpha)
    expect((screen.getByRole('radio', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(true)
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('a multiple-choice question’s options are checkboxes, and the answer joins them', async () => {
    const user = userEvent.setup()
    const request = question(1) as unknown as { questions: { multiSelect: boolean }[] }
    request.questions[0].multiSelect = true
    render(<QuestionPanel request={request as never} />)
    expect(screen.getByRole('group', { name: 'Choose any' })).toBeTruthy()
    await user.click(screen.getByRole('checkbox', { name: /Alpha/ }))
    await user.click(screen.getByRole('checkbox', { name: /Beta/ }))
    await user.click(screen.getByRole('button', { name: /^Send answer/ }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('q1', { kind: 'question', answers: { 'Question 1?': 'Alpha, Beta' } })
  })

  it('arrow keys on the question tabs move between questions once', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(3)} />)
    screen.getByRole('tab', { name: /H0/ }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /H1/ }).getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /H2/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('the key after the options (n+1) focuses the free-text answer, which is named, and typing there does not trigger keys', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(1)} />)
    screen.getByRole('group', { name: 'Question 1?' }).focus()
    await user.keyboard('3')
    const other = screen.getByRole('textbox', { name: 'Other: answer in your own words' }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(other)
    await user.keyboard('12')
    expect(other.value).toBe('12')
    expect((screen.getByRole('radio', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(false)
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    // An answer in one's own words is an answer.
    await user.click(screen.getByRole('button', { name: /^Send answer/ }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('q1', { kind: 'question', answers: { 'Question 1?': '12' } })
  })

  it('Skip sends a skipped answer', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(1)} />)
    await user.click(screen.getByRole('button', { name: /Skip/ }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('q1', { kind: 'question', skipped: true })
  })
})

describe('chat find', () => {
  beforeEach(() => {
    // jsdom has no CSS Custom Highlight API.
    ;(globalThis as any).CSS = { highlights: new Map(), escape: (s: string) => s }
    ;(globalThis as any).Highlight = class extends Set {}
  })

  const mount = (query = '') => {
    const root = { current: document.createElement('div') }
    root.current.textContent = 'one two one'
    const onQuery = vi.fn()
    const view = render(<ChatSearch root={root} items={[]} active workspaceId="w1" query={query} onQuery={onQuery} />)
    return { onQuery, view }
  }

  it('Ctrl+F opens a named search with named buttons; Escape closes it and returns to the composer', async () => {
    mount()
    expect(screen.queryByRole('search')).toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    await waitFor(() => expect(screen.getByRole('search')).toBeTruthy())
    expect(screen.getByRole('textbox', { name: /.+/ })).toBeTruthy()
    for (const name of [/Previous match/, /Next match/, /Close search/]) expect(screen.getByRole('button', { name })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('search')).toBeNull())
    expect(storeModule.sendUiCommand).toHaveBeenCalledWith('focus-composer', 'w1')
  })

  it('typing reports the query', async () => {
    const user = userEvent.setup()
    const { onQuery } = mount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    await user.type(await screen.findByRole('textbox'), 'o')
    expect(onQuery).toHaveBeenCalledWith('o')
  })
})

describe('chat tab', () => {
  const renderTab = async (extra: Record<string, unknown> = {}) => {
    fakeState.unreadSessions = {}
    fakeState.approvals = []
    const { ChatTab } = await import('../src/renderer/src/components/WorkspaceView')
    const { Tabs, TabList } = await import('../src/renderer/src/ui')
    const props = { onRenameDone: vi.fn(), onClose: vi.fn(), onContextMenu: vi.fn(), showModel: false, renaming: false, ...extra }
    const session = { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'default', status: 'idle', title: 'Fix login', queue: [] } as never
    render(
      <Tabs variant="chat" value="s1" onChange={() => undefined}>
        <TabList label="Chats">
          <ChatTab session={session} {...(props as any)} />
        </TabList>
      </Tabs>
    )
    return props
  }

  it('close is its own button beside the tab, not inside it', async () => {
    const props = await renderTab()
    const tab = screen.getByRole('tab', { name: /Fix login/ })
    const close = screen.getByRole('button', { name: 'Close chat' })
    expect(tab.contains(close)).toBe(false)
    await userEvent.setup().click(close)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('double-click renames: Enter saves the new title, Escape cancels', async () => {
    const user = userEvent.setup()
    fakeApi.updateSession = vi.fn(async () => undefined)
    const props = await renderTab()
    await user.dblClick(screen.getByRole('tab', { name: /Fix login/, hidden: false }))
    const field = await screen.findByRole('textbox', { name: 'Rename' })
    await user.clear(field)
    await user.type(field, 'Fix signup{Enter}')
    expect(fakeApi.updateSession).toHaveBeenCalledWith('s1', { title: 'Fix signup' })
    expect(props.onRenameDone).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull())

    fakeApi.updateSession.mockClear()
    await user.dblClick(screen.getByRole('tab', { name: /Fix login/ }))
    await user.type(await screen.findByRole('textbox', { name: 'Rename' }), 'x{Escape}')
    expect(fakeApi.updateSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull()
  })

  it('a fixed (archived) tab has no close button', async () => {
    await renderTab({ fixed: true })
    expect(screen.queryByRole('button', { name: 'Close chat' })).toBeNull()
  })
})
