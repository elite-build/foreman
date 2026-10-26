// @vitest-environment jsdom
// Phase 0 of the accessibility plan: a focused button in the approval and question panels does what it says.
// Enter and Space on Yes, the alternate, No, an option, Skip or Submit fire that button's action and nothing else;
// the panel-level shortcuts work only while the panel itself has focus.
import '../domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionPanel, ToolApprovalPanel } from '../../src/renderer/src/components/ApprovalPanel'
import { fakeApi, resetFake } from '../rendererStore'

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

const KEYS = [
  ['Enter', '{Enter}'],
  ['Space', ' ']
] as const

describe('tool approval buttons', () => {
  describe.each(KEYS)('%s on a focused button', (_name, key) => {
    it('Yes approves', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /^Yes\s*↵/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(true, false))
    })

    it('the alternate answer is the alternate, not a plain yes', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /ask again/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(true, true))
    })

    it('No denies, it does not approve', async () => {
      const user = userEvent.setup()
      render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
      screen.getByRole('button', { name: /^No/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', toolAnswer(false, false))
    })
  })

  it('Enter and Backspace still work while the panel itself has focus', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    expect(document.activeElement).toBe(screen.getAllByRole('group')[0])
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(true, false))
    await user.keyboard('{Backspace}')
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(false, false))
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(2)
  })

  it('Mod+Enter takes the alternate answer', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool({ alternate: 'always-allow' })} workspacePath="/w" />)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('a1', toolAnswer(true, true))
  })

  it('Backspace on a focused button does not deny', async () => {
    const user = userEvent.setup()
    render(<ToolApprovalPanel request={tool()} workspacePath="/w" />)
    screen.getByRole('button', { name: /^Yes/ }).focus()
    await user.keyboard('{Backspace}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
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
    it('an option toggles; the question is not submitted', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question(true)} />)
      screen.getByRole('button', { name: /Beta/ }).focus()
      await user.keyboard(key)
      expect(screen.getByRole('button', { name: /Beta/ }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('button', { name: /Alpha/ }).getAttribute('aria-pressed')).toBe('false')
      expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    })

    it('each option toggles on its own', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question(true)} />)
      screen.getByRole('button', { name: /Alpha/ }).focus()
      await user.keyboard(key)
      expect(screen.getByRole('button', { name: /Alpha/ }).getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('button', { name: /Beta/ }).getAttribute('aria-pressed')).toBe('false')
      expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    })

    it('Skip skips', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question()} />)
      screen.getByRole('button', { name: /Skip/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', skipped: true })
    })

    it('Submit submits the answers', async () => {
      const user = userEvent.setup()
      render(<QuestionPanel request={question(true)} />)
      await user.click(screen.getByRole('button', { name: /Alpha/ }))
      screen.getByRole('button', { name: /Submit/ }).focus()
      await user.keyboard(key)
      expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
      expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'Which one?': 'Alpha' } })
    })
  })

  it('Enter and the digit keys still work while the panel itself has focus', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    expect(document.activeElement).toBe(screen.getAllByRole('group')[0])
    await user.keyboard('2')
    expect(screen.getByRole('button', { name: /Beta/ }).getAttribute('aria-pressed')).toBe('true')
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'Which one?': 'Beta' } })
  })

  it('a digit on a focused button does not pick an option', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={question(true)} />)
    screen.getByRole('button', { name: /Skip/ }).focus()
    await user.keyboard('1')
    expect(screen.getByRole('button', { name: /Alpha/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('is a named group labelled by its visible title', () => {
    render(<QuestionPanel request={question()} />)
    const group = screen.getByRole('group', { name: 'H: Which one?' })
    const title = document.getElementById(group.getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('H: Which one?')
  })
})
