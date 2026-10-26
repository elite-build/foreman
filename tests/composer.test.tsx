// @vitest-environment jsdom
// The composer's riskiest surfaces: sending with Enter next to IME composition, the @ and / suggestions, and the queue
// (a labelled list of rows with an inline editor and reordering).
import './domShims'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/renderer/src/components/composer/Composer'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const workspace = { id: 'w1', repoId: 'r1', state: 'active', name: 'main' } as never

function session(overrides: Record<string, unknown> = {}) {
  return { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'default', status: 'idle', queue: [], queueRevision: 3, ...overrides } as never
}

function renderComposer(overrides: Record<string, unknown> = {}) {
  return render(<Composer session={session(overrides)} workspace={workspace} active hasHistory={false} />)
}

const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement

/** Animation frames held by the test until `run()`, so it decides what happens before the next frame instead of racing it. */
function holdFrames() {
  const waiting: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => waiting.push(callback))
  return {
    pending: () => waiting.length,
    run: () => act(() => waiting.splice(0).forEach((callback) => callback(performance.now())))
  }
}

beforeEach(() => {
  resetFake()
  fakeState.snapshot.settings.messageSendKey = 'enter'
  fakeApi.sendMessage = vi.fn(async () => 'sent')
  fakeApi.slashCommands = vi.fn(async () => [])
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('sending', () => {
  it('Enter sends the message and clears the box', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'hello there')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
    expect(fakeApi.sendMessage.mock.calls[0].slice(0, 2)).toEqual(['s1', 'hello there'])
    expect(box().value).toBe('')
  })

  it('Shift+Enter makes a new line instead of sending', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'a{Shift>}{Enter}{/Shift}b')
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
    expect(box().value).toBe('a\nb')
  })

  it('an Enter that confirms an IME composition does not send', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'konnichiwa')
    fireEvent.compositionStart(box())
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
    expect(box().value).toBe('konnichiwa')
    fireEvent.compositionEnd(box())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
  })

  it('with Ctrl+Enter as the send key, plain Enter only types', async () => {
    fakeState.snapshot.settings.messageSendKey = 'mod-enter'
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'x{Enter}')
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
  })

  it('the send button is named and sends too', async () => {
    const user = userEvent.setup()
    renderComposer()
    const send = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await user.type(box(), 'hi')
    expect(send.disabled).toBe(false)
    await user.click(send)
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
  })
})

describe('suggestions', () => {
  beforeEach(() => {
    fakeApi.listFiles = vi.fn(async () => ['src/alpha.ts', 'src/beta.ts', 'readme.md'])
  })

  it('@ lists files in a listbox the textarea points at with aria-activedescendant', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'see @src')
    const list = await screen.findByRole('listbox', { name: 'Suggestions' })
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['src/beta.ts', 'src/alpha.ts'])
    expect(box().getAttribute('aria-activedescendant')).toBe(options[0].id)
    expect(box().getAttribute('aria-controls')).toBe(list.id)
    // The focus never leaves the textarea.
    expect(document.activeElement).toBe(box())
    await user.keyboard('{ArrowDown}')
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1].id)
  })

  it('Tab and Enter accept the highlighted suggestion', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'see @src')
    await screen.findByRole('listbox', { name: 'Suggestions' })
    await user.keyboard('{ArrowDown}{Tab}')
    expect(box().value).toBe('see @src/alpha.ts ')
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull()
    // Enter accepted a suggestion rather than sending.
    await user.type(box(), '@read')
    await screen.findByRole('listbox', { name: 'Suggestions' })
    await user.keyboard('{Enter}')
    expect(box().value).toBe('see @src/alpha.ts @readme.md ')
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })

  it('clicking a suggestion accepts it, and Escape closes the list', async () => {
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), '@src')
    await user.click(await screen.findByRole('option', { name: 'src/alpha.ts' }))
    expect(box().value).toBe('@src/alpha.ts ')
    await user.type(box(), '@r')
    await screen.findByRole('listbox', { name: 'Suggestions' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull()
  })

  it.each(['{Tab}', '{Enter}'])('after %s accepts a suggestion, keys typed before the next frame go after it', async (accept) => {
    const frames = holdFrames()
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), '@src')
    await screen.findByRole('listbox', { name: 'Suggestions' })
    await user.keyboard(accept)
    expect(box().value).toBe('@src/beta.ts ')
    expect(box().selectionStart).toBe('@src/beta.ts '.length)
    // A frame lands between two keys: the caret stays at the end of what was typed.
    await user.keyboard('@')
    frames.run()
    await user.keyboard('r')
    expect(box().value).toBe('@src/beta.ts @r')
    expect(box().selectionStart).toBe(box().value.length)
    await screen.findByRole('listbox', { name: 'Suggestions' })
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })
})

describe('the queue', () => {
  const queue = [
    { id: 'q1', text: 'first message', attachments: [] },
    { id: 'q2', text: 'second message', attachments: [] }
  ]

  it('is a labelled list with one item per message, and the actions are buttons beside the text', () => {
    renderComposer({ queue })
    const list = screen.getByRole('list', { name: 'Queued messages' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('first message')
    // No listbox: the actions are siblings, not owned by an option.
    expect(screen.queryByRole('listbox', { name: 'Queued messages' })).toBeNull()
    const names = within(items[0]).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual([expect.stringMatching(/^Move up/), expect.stringMatching(/^Move down/), 'Send now', 'Edit', 'Delete'])
    // The first row can't move up, the last can't move down.
    expect((within(items[0]).getByRole('button', { name: /^Move up/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(items[1]).getByRole('button', { name: /^Move down/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Edit opens the editor in the row; Ctrl+Enter saves against the queue revision', async () => {
    fakeApi.editQueued = vi.fn(async () => ({ ok: true }))
    const user = userEvent.setup()
    renderComposer({ queue })
    const items = within(screen.getByRole('list', { name: 'Queued messages' })).getAllByRole('listitem')
    await user.click(within(items[0]).getByRole('button', { name: 'Edit' }))
    const editor = within(screen.getAllByRole('listitem')[0]).getByRole('textbox', { name: 'Edit queued message' }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe('first message')
    await user.type(editor, ' edited')
    // An Enter that confirms a composition is not Save.
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(fakeApi.editQueued).not.toHaveBeenCalled()
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.editQueued).toHaveBeenCalledTimes(1))
    expect(fakeApi.editQueued).toHaveBeenCalledWith('s1', 'q1', 'first message edited', 3, [])
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull())
  })

  it('Escape cancels the edit without saving and without stopping the agent', async () => {
    fakeApi.editQueued = vi.fn(async () => ({ ok: true }))
    fakeApi.cancel = vi.fn(async () => undefined)
    const user = userEvent.setup()
    renderComposer({ queue, status: 'running' })
    await user.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Edit' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).toBeNull()
    expect(fakeApi.editQueued).not.toHaveBeenCalled()
    expect(fakeApi.cancel).not.toHaveBeenCalled()
    // Focus is back on the row's Edit button.
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Edit' })))
  })

  it('the arrow buttons reorder through the queue revision', async () => {
    fakeApi.moveQueued = vi.fn(async () => ({ ok: true }))
    const user = userEvent.setup()
    renderComposer({ queue })
    const items = screen.getAllByRole('listitem')
    await user.click(within(items[0]).getByRole('button', { name: /^Move down/ }))
    expect(fakeApi.moveQueued).toHaveBeenLastCalledWith('s1', 'q1', 'down', 3)
    await user.click(within(items[1]).getByRole('button', { name: /^Move up/ }))
    expect(fakeApi.moveQueued).toHaveBeenLastCalledWith('s1', 'q2', 'up', 3)
  })

  it('Alt+↑ and Alt+↓ with focus anywhere in a row move that row', async () => {
    fakeApi.moveQueued = vi.fn(async () => ({ ok: true }))
    const frames = holdFrames()
    const user = userEvent.setup()
    renderComposer({ queue })
    const items = screen.getAllByRole('listitem')
    const edit = within(items[1]).getByRole('button', { name: 'Edit' })
    edit.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(fakeApi.moveQueued).toHaveBeenLastCalledWith('s1', 'q2', 'up', 3)
    // Focus is put back on the button it was on, once the move is done, in case the reordered row lost it.
    await waitFor(() => expect(frames.pending()).toBe(1))
    edit.blur()
    frames.run()
    expect(document.activeElement).toBe(edit)
    // The first row can't go up: no call.
    fakeApi.moveQueued.mockClear()
    within(items[0]).getByRole('button', { name: 'Edit' }).focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(fakeApi.moveQueued).not.toHaveBeenCalled()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(fakeApi.moveQueued).toHaveBeenLastCalledWith('s1', 'q1', 'down', 3)
  })

  it('a finished move leaves focus where it went in the meantime', async () => {
    fakeApi.moveQueued = vi.fn(async () => ({ ok: true }))
    const frames = holdFrames()
    const user = userEvent.setup()
    renderComposer({ queue })
    const items = screen.getAllByRole('listitem')
    within(items[1]).getByRole('button', { name: 'Edit' }).focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(frames.pending()).toBe(1))
    // Focus moves to the first row before the move's frame: it stays there, and the next keys move that row.
    const first = within(items[0]).getByRole('button', { name: 'Edit' })
    first.focus()
    frames.run()
    expect(document.activeElement).toBe(first)
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(fakeApi.moveQueued).toHaveBeenLastCalledWith('s1', 'q1', 'down', 3)
  })

  it('Send now and Delete call the queue', async () => {
    fakeApi.steerQueued = vi.fn(async () => undefined)
    fakeApi.removeQueued = vi.fn(async () => undefined)
    const user = userEvent.setup()
    renderComposer({ queue })
    const items = screen.getAllByRole('listitem')
    await user.click(within(items[1]).getByRole('button', { name: 'Send now' }))
    expect(fakeApi.steerQueued).toHaveBeenCalledWith('s1', 'q2')
    await user.click(within(items[0]).getByRole('button', { name: 'Delete' }))
    expect(fakeApi.removeQueued).toHaveBeenCalledWith('s1', 'q1')
  })
})

describe('the template picker', () => {
  beforeEach(() => {
    fakeState.snapshot.settings.promptTemplates = [
      { id: 't1', name: 'Fix a bug', body: 'Fix the bug in {{file}}' },
      { id: 't2', name: 'Write tests', body: 'Write tests for {{thing}}' }
    ]
  })
  afterEach(() => {
    fakeState.snapshot.settings.promptTemplates = []
  })

  it('opens a popover with a searchable list, and Enter inserts the highlighted template', async () => {
    const user = userEvent.setup()
    renderComposer()
    const trigger = screen.getByRole('button', { name: /Insert a prompt template/ })
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Prompt templates' })
    const search = within(panel).getByRole('combobox', { name: 'Search templates' })
    expect(document.activeElement).toBe(search)
    expect(within(panel).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Fix a bug'), expect.stringContaining('Write tests')])
    await user.type(search, 'tests')
    expect(within(panel).getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog', { name: 'Prompt templates' })).toBeNull()
    await waitFor(() => expect(box().value).toBe('Write tests for {{thing}}'))
  })

  it('arrow keys move the highlight and Escape closes with focus back on the button', async () => {
    const user = userEvent.setup()
    renderComposer()
    const trigger = screen.getByRole('button', { name: /Insert a prompt template/ })
    await user.click(trigger)
    const search = screen.getByRole('combobox', { name: 'Search templates' })
    const [first, second] = screen.getAllByRole('option')
    expect(search.getAttribute('aria-activedescendant')).toBe(first.id)
    await user.keyboard('{ArrowDown}')
    expect(search.getAttribute('aria-activedescendant')).toBe(second.id)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Prompt templates' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('the agent picker', () => {
  it('opens as a popover with a named search, and Escape closes it with focus back on the trigger', async () => {
    const user = userEvent.setup()
    renderComposer()
    const trigger = screen.getByRole('button', { name: /Claude|Default|Sonnet|Opus/i })
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Agent and model' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: 'Search models' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Agent and model' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('the toolbar', () => {
  it('Plan is a toggle button', async () => {
    fakeApi.updateSession = vi.fn(async () => undefined)
    const user = userEvent.setup()
    renderComposer({ planMode: false })
    const plan = screen.getByRole('button', { name: /Plan/ })
    expect(plan.getAttribute('aria-pressed')).toBe('false')
    await user.click(plan)
    expect(fakeApi.updateSession).toHaveBeenCalledWith('s1', { planMode: true })
  })
})
