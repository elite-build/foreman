// @vitest-environment jsdom
// Phase 0 of the accessibility plan: a focused button in the approval and question cards does what it says.
// Enter and Space on Run, the alternate, Don’t run, Skip or Send fire that button's action and nothing else; the card's
// own keys (Esc declines, Ctrl+Enter the alternate, Enter the main act, 1-n an option) work only inside the card, and
// nothing takes focus as a card arrives.
import '../domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionPanel, ToolApprovalPanel } from '../../src/renderer/src/components/ApprovalPanel'
import { fakeApi, fakeState, resetFake } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeApi.respondApproval = vi.fn(async () => undefined)
})
afterEach(cleanup)

const tool = (overrides: Record<string, unknown> = {}) =>
  ({ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, ...overrides }) as never

const toolAnswer = (allow: boolean, alternate: boolean, message?: string) => ({ kind: 'tool', allow, alternate, message })

const question = (multiSelect = false) =>
  ({
    kind: 'question',
    id: 'q1',
    sessionId: 's1',
    questions: [
      {
        header: 'H',
        question: 'Which one?',
        multiSelect,
        options: [
          { label: 'Alpha', description: 'first' },
          { label: 'Beta', description: 'second' }
        ]
      }
    ]
  }) as never

const checked = (role: 'checkbox' | 'radio', name: RegExp | string) => (screen.getByRole(role, { name }) as HTMLInputElement).checked

const KEYS = [
  ['Enter', '{Enter}'],
  ['Space', ' ']
] as const

describe('tool approval buttons', () => {
  describe.each(KEYS)('%s on a focused button', (_name, key) => {
    it('Run approves', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /^Run\s*Enter$/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(true, false))
    })

    it('the alternate answer is the alternate, not a plain yes', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /^Always allow/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(true, true))
    })

    it('Don’t run denies, it does not approve', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /^Don’t run/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(false, false))
    })
  })

  it('takes no focus as it arrives', () => {
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    expect(document.activeElement).toBe(document.body)
  })

  it('Enter and Esc work while the card itself has focus', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(true, false))
    await user.keyboard('{Escape}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(false, false))
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(2)
  })

  it('its keys do nothing while focus is outside the card', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    await user.keyboard('{Enter}{Escape}{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('Mod+Enter takes the alternate answer', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(true, true))
  })

  it('Mod+Enter takes the main act when there is no alternate', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(true, false))
  })

  it('Backspace no longer denies, on the card or on a focused button', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Backspace}')
    screen.getByRole('button', { name: /^Run/ }).focus()
    await user.keyboard('{Backspace}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('Esc stays in the card: it denies and never reaches the view around it', async () => {
    const user = userEvent.setup()
    const outside = vi.fn()
    render(
      <div onKeyDown={(e) => e.key === 'Escape' && outside()}>
        <ToolApprovalPanel request={tool()} workspacePath="/w" />
      </div>
    )
    screen.getByRole('button', { name: /^Run/ }).focus()
    await user.keyboard('{Escape}')
    expect(outside).not.toHaveBeenCalled()
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(false, false))
  })

  it('a command that leaves this computer has no key: Enter and Ctrl+Enter on the card run nothing', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool({ input: { command: 'git push origin main' }, alternate: 'always-allow' })} workspacePath="/w" />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Enter}{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    // The button itself still does what it says.
    screen.getByRole('button', { name: 'Run' }).focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(true, false))
  })

  it('Enter in the reason box denies with that reason, and the box says so', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    const reason = screen.getByRole('textbox')
    const help = document.getElementById(reason.getAttribute('aria-describedby') ?? '')
    expect(help?.textContent).toMatch(/Enter/)
    await user.type(reason, 'use rg{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(false, false, 'use rg'))
  })

  it('is a named group labelled by its visible title', () => {
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    const group = screen.getByRole('group', { name: 'Run this command?' })
    const title = document.getElementById(group.getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('Run this command?')
  })
})

describe('question buttons', () => {
  describe.each(KEYS)('%s on a focused button', (_name, key) => {
    it('Skip skips', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question()} />)
      screen.getByRole('button', { name: /Skip/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', skipped: true })
    })

    it('Send sends the answers', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question(true)} />)
      await user.click(screen.getByRole('checkbox', { name: /Alpha/ }))
      screen.getByRole('button', { name: /^Send answer/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'Which one?': 'Alpha' } })
    })
  })

  it('Space on an option toggles it; the question is not sent', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    screen.getByRole('checkbox', { name: /Beta/ }).focus()
    await user.keyboard(' ')
    expect(checked('checkbox', /Beta/)).toBe(true)
    expect(checked('checkbox', /Alpha/)).toBe(false)
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('each option toggles on its own', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    screen.getByRole('checkbox', { name: /Alpha/ }).focus()
    await user.keyboard(' ')
    expect(checked('checkbox', /Alpha/)).toBe(true)
    expect(checked('checkbox', /Beta/)).toBe(false)
    await user.keyboard(' ')
    expect(checked('checkbox', /Alpha/)).toBe(false)
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('picking a single-choice option does not send it', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question()} />)
    await user.click(screen.getByRole('radio', { name: 'Alpha' }))
    expect(checked('radio', 'Alpha')).toBe(true)
    expect(checked('radio', 'Beta')).toBe(false)
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('with nothing answered, Send is off and Enter sends nothing', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    expect((screen.getByRole('button', { name: /^Send answer/ }) as HTMLButtonElement).disabled).toBe(true)
    screen.getByRole('group', { name: 'Which one?' }).focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
  })

  it('Enter and the digit keys work while the card itself has focus', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    screen.getByRole('group', { name: 'Which one?' }).focus()
    await user.keyboard('2')
    expect(checked('checkbox', /Beta/)).toBe(true)
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'Which one?': 'Beta' } })
  })

  it('a digit typed in the text box is text; it does not pick an option', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    const own = screen.getByRole('textbox', { name: 'Other: answer in your own words' })
    await user.type(own, '1')
    expect((own as HTMLTextAreaElement).value).toBe('1')
    expect(checked('checkbox', /Alpha/)).toBe(false)
  })

  it('is a named group labelled by its visible title', () => {
    render(<QuestionPanel request={question()} />)
    const group = screen.getByRole('group', { name: 'Which one?' })
    const title = document.getElementById(group.getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('Which one?')
  })
})

describe('the key hints on the buttons', () => {
  afterEach(() => {
    fakeState.snapshot.platform = 'win32'
  })

  it('spell the keys out on Windows, with no Mac symbols', () => {
    fakeState.snapshot.platform = 'win32'
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    expect(screen.getByRole('button', { name: 'Don’t run Esc' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run Enter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always allow Ctrl+Enter' })).toBeTruthy()
    cleanup()
    render(<QuestionPanel request={question()} />)
    expect(screen.getByRole('button', { name: /^Send answer/ }).textContent).toMatch(/Enter$/)
    expect(document.body.textContent).not.toMatch(/[⌘⌥⇧↵⌫]/)
  })

  it('draw the symbols on macOS', () => {
    fakeState.snapshot.platform = 'darwin'
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    expect(screen.getByRole('button', { name: 'Don’t run Esc' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run ↵' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always allow ⌘↵' })).toBeTruthy()
  })
})
