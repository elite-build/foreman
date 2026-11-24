// @vitest-environment jsdom
// The composer's riskiest surfaces: sending with Enter next to IME composition, the @ and / suggestions, and the queue
// (a labelled list of rows with an inline editor and reordering).
import './domShims'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer, STOP_DELAY_MS } from '../src/renderer/src/components/composer/Composer'
import { staticCapabilitiesView } from '../src/shared/agentCatalog'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const workspace = { id: 'w1', repoId: 'r1', state: 'active', name: 'main' } as never

function session(overrides: Record<string, unknown> = {}) {
  return { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'default', status: 'idle', queue: [], queueRevision: 3, ...overrides } as never
}

function renderComposer(overrides: Record<string, unknown> = {}) {
  return render(<Composer session={session(overrides)} workspace={workspace} active hasHistory={false} />)
}

const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
/** The line under the box, one entry per key: "Enter send". */
const keyLine = () => Array.from(document.querySelectorAll('.composer-keys > span')).map((el) => el.textContent?.replace(/\s+/g, ' ').trim())

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
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
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

  it('says an outside agent queued a message, not `foreman send`, and keeps its turn for `foreman wait`', async () => {
    const user = userEvent.setup()
    const outside = { id: 'q3', text: 'from outside', attachments: [], turnId: 'turn-abcdef12', via: 'cli', origin: { kind: 'outside', grantId: 'g1', name: 'Claude Code' } }
    const script = { id: 'q4', text: 'from a script', attachments: [], turnId: 'turn-12345678', via: 'cli' }
    renderComposer({ queue: [outside, script] })
    await user.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Edit' }))
    const row = screen.getAllByRole('listitem')[0]
    expect(row.textContent).toContain('Outside agent')
    expect(row.textContent).toContain('queued by Claude Code (outside agent) · editing')
    expect(row.textContent).not.toContain('foreman send')
    expect(row.textContent).toContain('foreman wait')
    await user.keyboard('{Escape}')
    // A script's message still says `foreman send` queued it.
    await user.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Edit' }))
    const scripted = screen.getAllByRole('listitem')[1]
    expect(scripted.textContent).toContain('CLI')
    expect(scripted.textContent).toContain('foreman send')
    expect(scripted.textContent).not.toContain('outside agent')
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

describe('the queue’s send action', () => {
  const queue = [{ id: 'q1', text: 'first', attachments: [] }] as never

  it('says Interrupt and send for an agent that can only be interrupted, and sends at once, as the phone does', async () => {
    fakeApi.steerQueued = vi.fn(async () => undefined)
    const user = userEvent.setup()
    renderComposer({ agent: 'cursor', status: 'running', queue })
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    const button = screen.getByRole('button', { name: /^Interrupt and send/ })
    expect(button.title).toMatch(/cuts work in progress/)
    await user.click(button)
    expect(fakeApi.steerQueued).toHaveBeenCalledWith('s1', 'q1')
  })

  it('stays Send now for an agent that steers', () => {
    renderComposer({ agent: 'claude', status: 'running', queue })
    expect(screen.getByRole('button', { name: 'Send now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Interrupt and send/ })).toBeNull()
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
    // From the Add menu, which names the key that opens it too.
    await user.click(screen.getByRole('button', { name: /^Add/ }))
    const item = screen.getByRole('menuitem', { name: /^Prompt template/ })
    expect(item.textContent).toContain('Ctrl+J')
    await user.click(item)
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
    const trigger = screen.getByRole('button', { name: /^Add/ })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: /^Prompt template/ }))
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

  it('an agent with no plan mode keeps the Plan chip, disabled, with the record’s reason as its tooltip', async () => {
    fakeApi.updateSession = vi.fn(async () => undefined)
    const user = userEvent.setup()
    renderComposer({ agent: 'cursor', planMode: false })
    const plan = screen.getByRole('button', { name: /Plan/ }) as HTMLButtonElement
    expect(plan.disabled).toBe(true)
    expect(plan.getAttribute('aria-pressed')).toBeNull()
    expect(plan.title).toBe('This agent hasn’t offered a plan mode.')
    await user.click(plan)
    expect(fakeApi.updateSession).not.toHaveBeenCalled()
  })

  it('an ACP agent that declared a plan mode has Plan on; one that did not shows it disabled', () => {
    const before = fakeState.snapshot.agentCapabilities
    fakeState.snapshot.agentCapabilities = { ...staticCapabilitiesView(), declared: { antigravity: { '': { planMode: true } } } }
    try {
      const { unmount } = renderComposer({ agent: 'antigravity' })
      expect((screen.getByRole('button', { name: /Plan/ }) as HTMLButtonElement).disabled).toBe(false)
      unmount()
      renderComposer({ agent: 'qwen' })
      expect((screen.getByRole('button', { name: /Plan/ }) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      fakeState.snapshot.agentCapabilities = before
    }
  })

  it('says who holds the permission mode, from the record: on the read-only chip and on the auto-accept chip', () => {
    fakeState.snapshot.settings.requireToolApprovals = true
    renderComposer({ agent: 'codex', readOnly: true, autoAcceptEdits: true })
    // Codex's own sandbox and approval policy hold the rules.
    expect(screen.getByText('Read-only').closest('[title]')!.getAttribute('title')).toMatch(/read-only sandbox.*Enforced by: the agent$/)
    expect(screen.getByRole('button', { name: /Auto-accept/ }).title).toMatch(/Enforced by: the agent$/)
    cleanup()
    // Cursor's is Foreman's review: the chip says so (Cursor is never read-only, so this is the auto-accept chip).
    renderComposer({ agent: 'cursor', autoAcceptEdits: true })
    expect(screen.getByRole('button', { name: /Auto-accept/ }).title).toMatch(/Enforced by: Foreman$/)
  })

  it('Steer follows the record: Claude can take a message into a running turn, an agent with no way to take one only queues', async () => {
    const user = userEvent.setup()
    renderComposer({ agent: 'claude', status: 'running' })
    await user.type(box(), 'and the tests')
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'More ways to send' }))
    expect(within(screen.getByRole('group', { name: 'How this message goes' })).getAllByRole('menuitemradio').map((r) => r.querySelector('.ui-menu__label')?.textContent)).toEqual(['Steer', 'Queue'])
    cleanup()
    // Qwen's record is the ACP one, which can interrupt (below); a record with neither only queues, and says why.
    const before = fakeState.snapshot.agentCapabilities
    try {
      const view = staticCapabilitiesView()
      fakeState.snapshot.agentCapabilities = { ...view, agents: { ...view.agents, cursor: { ...view.agents.cursor, turns: { steer: { level: 'none', why: 'agentCaps.why.steer' } } } } }
      renderComposer({ agent: 'cursor', status: 'running' })
      await user.type(box(), 'and the tests')
      const queue = screen.getByRole('button', { name: 'Queue' })
      expect(queue.title).toMatch(/can.t take messages mid-turn/)
      await user.click(screen.getByRole('button', { name: 'More ways to send' }))
      const only = within(screen.getByRole('group', { name: 'How this message goes' })).getAllByRole('menuitemradio')
      expect(only).toHaveLength(1)
      expect(only[0].textContent).toMatch(/^Queue.*can.t take messages mid-turn/)
      // No other follow-up, so the key line offers none.
      expect(keyLine()).toEqual(['Enter queue', 'Shift+Enter new line', 'Esc stop'])
    } finally {
      fakeState.snapshot.agentCapabilities = before
    }
  })

  it('Interrupt and send is an explicit choice for an agent that can only be interrupted: Queue is the default', async () => {
    const user = userEvent.setup()
    renderComposer({ agent: 'cursor', status: 'running' })
    await user.type(box(), 'try again')
    // Queue by default; the menu offers the interrupt with what it costs, and its key.
    expect(screen.getByRole('button', { name: 'Queue' }).title).toBe('Send when this turn ends (Enter)')
    expect(keyLine()).toEqual(['Enter queue', 'Ctrl+Enter interrupt and send', 'Shift+Enter new line', 'Esc stop'])
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
    expect(fakeApi.sendMessage.mock.calls[0][2]).toMatchObject({ mode: 'queue' })

    await user.type(box(), 'stop that')
    await user.click(screen.getByRole('button', { name: 'More ways to send' }))
    const interrupt = screen.getByRole('menuitemradio', { name: /^Interrupt and send/ })
    expect(interrupt.textContent).toMatch(/Work in progress is cut/)
    expect(interrupt.querySelector('.ui-menu__hint')?.textContent).toBe('Ctrl+Enter')
    await user.click(interrupt)
    const button = screen.getByRole('button', { name: 'Interrupt and send' })
    expect(button.title).toMatch(/Work in progress is cut/)
    expect(keyLine()[0]).toBe('Enter interrupt and send')
    await user.click(box())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2))
    expect(fakeApi.sendMessage.mock.calls[1][2]).toMatchObject({ mode: 'interrupt' })
  })

  it('stays on one row: two groups on the left, then context and the send button kept together on the right', async () => {
    const user = userEvent.setup()
    renderComposer({ status: 'running' })
    await user.type(box(), 'and the tests')
    const toolbar = document.querySelector('.composer-toolbar')!
    // jsdom can't measure, so the structure: [model · Plan] [Add] spacer [context · Stop · send], and the CSS that keeps
    // context and send together at the right.
    expect(Array.from(toolbar.children).map((el) => el.className)).toEqual(['composer-group', 'composer-group', 'spacer', 'composer-group composer-send'])
    const [how, add, , send] = Array.from(toolbar.children) as HTMLElement[]
    expect(within(how).getByRole('button', { name: /Plan/ })).toBeTruthy()
    expect(within(add).getByRole('button', { name: /^Add/ }).getAttribute('aria-haspopup')).toBe('menu')
    expect(within(send).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Stop the agent (Esc)', 'Queue', 'More ways to send'])
    // The running toolbar no longer adds a Steer chip, its key text, a paperclip or a template icon.
    expect(screen.queryByRole('button', { name: /Attach files|Insert a prompt template/ })).toBeNull()
    expect(toolbar.textContent).not.toMatch(/to steer|to queue|Also try/)
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles/composer.css'), 'utf8')
    expect(css).toMatch(/\.composer-group\.composer-send \{[^}]*flex: none;[^}]*flex-wrap: nowrap;[^}]*margin-left: auto/)
  })
})

describe('the send button names what Enter does', () => {
  beforeEach(() => {
    fakeApi.cancel = vi.fn(async () => undefined)
    fakeApi.respondApproval = vi.fn(async () => undefined)
    fakeState.snapshot.settings.followUpMode = 'queue'
  })
  afterEach(() => {
    fakeState.snapshot.settings.followUpMode = 'queue'
  })

  it('idle: Send, and the key line says Enter sends; unfocused and empty it says how to focus', async () => {
    const user = userEvent.setup()
    renderComposer()
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.title).toBe('Send this message (Enter)')
    expect(send.disabled).toBe(true)
    // The menu stays usable with nothing typed.
    expect((screen.getByRole('button', { name: 'More ways to send' }) as HTMLButtonElement).disabled).toBe(false)
    expect(keyLine()).toEqual(['Ctrl+L to focus', 'Enter send'])
    await user.click(box())
    expect(keyLine()).toEqual(['Enter send', 'Shift+Enter new line', '@ add a file', '/ run a command'])
  })

  it('follows the send-key setting', async () => {
    fakeState.snapshot.settings.messageSendKey = 'mod-enter'
    const user = userEvent.setup()
    renderComposer()
    await user.type(box(), 'hi')
    expect(screen.getByRole('button', { name: 'Send' }).title).toBe('Send this message (Ctrl+Enter)')
    expect(keyLine()).toEqual(['Ctrl+Enter send', 'Enter new line', '@ add a file', '/ run a command'])
  })

  it('running with Steer as the follow-up: Steer, Queue one key away, Esc stops', async () => {
    fakeState.snapshot.settings.followUpMode = 'steer'
    const user = userEvent.setup()
    renderComposer({ status: 'running' })
    await user.type(box(), 'also the tests')
    expect(screen.getByRole('button', { name: 'Steer' }).title).toBe('Send into the running turn now (Enter)')
    expect(keyLine()).toEqual(['Enter steer now', 'Ctrl+Enter queue', 'Shift+Enter new line', 'Esc stop'])
    await user.click(screen.getByRole('button', { name: 'More ways to send' }))
    const menu = screen.getByRole('menu', { name: 'More ways to send' })
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows.map((r) => [r.querySelector('.ui-menu__label')?.textContent, r.querySelector('.ui-menu__desc')?.textContent, r.querySelector('.ui-menu__hint')?.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['Steer', 'Sends into the running turn now', 'Enter', 'true'],
      ['Queue', 'Waits until this turn ends', 'Ctrl+Enter', 'false']
    ])
    // Stop isn't a way to send: it has its own button, not a place in this menu.
    expect(within(menu).queryByRole('menuitem', { name: /Stop/ })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /^Also try with other models/ })).toBeTruthy()
    // Picking Queue changes the label and the keys, for this message.
    await user.click(rows[1])
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy()
    expect(keyLine()).toEqual(['Enter queue', 'Ctrl+Enter steer now', 'Shift+Enter new line', 'Esc stop'])
    await user.click(box())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
    expect(fakeApi.sendMessage.mock.calls[0][2]).toMatchObject({ mode: 'queue' })
    // Sent: the next message goes by the setting again, and the button stays a send button, greyed with nothing typed.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Steer' }) as HTMLButtonElement).disabled).toBe(true))
  })

  it('running with Queue as the follow-up: Queue, with Steer on the other key', async () => {
    const user = userEvent.setup()
    renderComposer({ status: 'running' })
    await user.type(box(), 'later')
    expect(screen.getByRole('button', { name: 'Queue' }).title).toBe('Send when this turn ends (Enter)')
    expect(keyLine()).toEqual(['Enter queue', 'Ctrl+Enter steer now', 'Shift+Enter new line', 'Esc stop'])
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1))
    expect(fakeApi.sendMessage.mock.calls[0][2]).toMatchObject({ mode: 'steer' })
  })

  it('running with nothing typed: the send button stays a greyed send button; Stop is its own button beside it, and stops', async () => {
    const user = userEvent.setup()
    renderComposer({ status: 'running' })
    expect((screen.getByRole('button', { name: 'Queue' }) as HTMLButtonElement).disabled).toBe(true)
    const stop = screen.getByRole('button', { name: 'Stop the agent (Esc)' }) as HTMLButtonElement
    expect(stop.getAttribute('aria-keyshortcuts')).toBe('Escape')
    expect(keyLine()).toEqual(['Enter queue', 'Ctrl+Enter steer now', 'Esc stop'])
    expect(box().placeholder).toBe('Queue a follow-up…')
    // Typing doesn't move it.
    await user.type(box(), 'later')
    expect(screen.getByRole('button', { name: 'Stop the agent (Esc)' })).toBe(stop)
    await user.click(stop)
    expect(fakeApi.cancel).toHaveBeenCalledWith('s1')
  })

  it('Stop appears only once a turn has run for a moment, so the click after Send can’t stop it', () => {
    vi.useFakeTimers()
    try {
      const view = renderComposer()
      expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull()
      view.rerender(<Composer session={session({ status: 'running' })} workspace={workspace} active hasHistory={false} />)
      // A second click on the send button lands on a greyed send button, not on Stop.
      const send = screen.getByRole('button', { name: 'Queue' }) as HTMLButtonElement
      expect(send.disabled).toBe(true)
      fireEvent.click(send)
      expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull()
      act(() => vi.advanceTimersByTime(STOP_DELAY_MS - 1))
      expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('button', { name: 'Stop the agent (Esc)' })).toBeTruthy()
      // The turn ends: it goes, and the next turn waits again.
      view.rerender(<Composer session={session({ status: 'idle' })} workspace={workspace} active hasHistory={false} />)
      expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull()
      view.rerender(<Composer session={session({ status: 'running' })} workspace={workspace} active hasHistory={false} />)
      expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull()
      // Esc stops at once all the same.
      fireEvent.keyDown(box(), { key: 'Escape' })
      expect(fakeApi.cancel).toHaveBeenCalledWith('s1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('plan review: Send changes, and the menu and Ctrl+Shift+Enter approve', async () => {
    const plan = { kind: 'plan', id: 'p1', sessionId: 's1', plan: '1. Do it' } as never
    const user = userEvent.setup()
    render(<Composer session={session()} workspace={workspace} active hasHistory={false} pendingPlan={plan} />)
    await user.type(box(), 'add a test for an expired token')
    expect(screen.getByRole('button', { name: 'Send changes' }).title).toBe('Send what you typed as changes to the plan (Enter)')
    expect(keyLine()).toEqual(['Enter send changes', 'Ctrl+Shift+Enter approve the plan', 'Shift+Enter new line'])
    await user.click(screen.getByRole('button', { name: 'More ways to send' }))
    const approve = screen.getByRole('menuitem', { name: /^Approve the plan/ })
    expect(approve.querySelector('.ui-menu__hint')?.textContent).toBe('Ctrl+Shift+Enter')
    await user.click(approve)
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('p1', { kind: 'plan', approve: true })
    expect(box().value).toBe('add a test for an expired token')
  })

  it('the key line is the message box’s description', async () => {
    renderComposer()
    const line = document.getElementById(box().getAttribute('aria-describedby')!)
    expect(line?.className).toContain('composer-keys')
  })

  it('in an AI employee’s run, says that what is typed is the person’s own, not an answer to the employee’s question', () => {
    const before = fakeState.snapshot.employees
    fakeState.snapshot.employees = { o1: { employees: [{ id: 'e1', name: 'Ada' }] } }
    try {
      const ws = { ...(workspace as object), startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e1', runId: 'r1', taskId: 't1', title: 'Fix it' } } as never
      render(<Composer session={session()} workspace={ws} active hasHistory={false} />)
      expect(document.querySelector('.composer-keys')?.textContent).toContain('Messages here run as you: they don’t answer Ada, and they don’t send what Ada asked to send.')
    } finally {
      fakeState.snapshot.employees = before
    }
  })
})

describe('Also try with other models', () => {
  const ready = { ...(workspace as object), state: 'ready', path: '/work/lisbon' } as never

  it('is in the send menu; while another tab works it is off, with its reason readable and reachable', async () => {
    const before = fakeState.snapshot.sessions
    fakeState.snapshot.sessions = [{ id: 's2', workspaceId: 'w1', status: 'running', queue: [], title: 'Session tests' }]
    try {
      const user = userEvent.setup()
      render(<Composer session={session()} workspace={ready} active hasHistory={false} />)
      await user.click(screen.getByRole('button', { name: 'More ways to send' }))
      const item = screen.getByRole('menuitem', { name: /^Also try with other models/ })
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.querySelector('.ui-menu__reason')?.textContent).toMatch(/Session tests/)
      // The only item: the keyboard lands on it, so the reason is read.
      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(item)
      await user.click(item)
      expect(storeModule.openCompareDialog).not.toHaveBeenCalled()
    } finally {
      fakeState.snapshot.sessions = before
    }
  })

  it('opens the comparison with the draft when every tab is idle', async () => {
    const user = userEvent.setup()
    render(<Composer session={session()} workspace={ready} active hasHistory={false} />)
    await user.type(box(), 'fix the redirect')
    await user.click(screen.getByRole('button', { name: 'More ways to send' }))
    await user.click(screen.getByRole('menuitem', { name: /^Also try with other models/ }))
    expect(storeModule.openCompareDialog).toHaveBeenCalledWith({ workspaceId: 'w1', sessionId: 's1', prompt: 'fix the redirect' })
  })
})

describe('the Add menu', () => {
  it('holds files, a template and a workspace file, each with its key; the @ item starts a mention', async () => {
    fakeApi.listFiles = vi.fn(async () => ['src/alpha.ts'])
    fakeApi.pickFiles = vi.fn(async () => [])
    const user = userEvent.setup()
    render(<Composer session={session()} workspace={{ ...(workspace as object), id: 'w-add' } as never} active hasHistory={false} />)
    await user.type(box(), 'see')
    await user.click(screen.getByRole('button', { name: /^Add/ }))
    const menu = screen.getByRole('menu', { name: 'Add to the message' })
    expect(within(menu).getAllByRole('menuitem').map((i) => [i.querySelector('.ui-menu__label')?.textContent, i.querySelector('.ui-menu__hint')?.textContent])).toEqual([
      ['Files or images…', 'Ctrl+U'],
      ['Prompt template…', 'Ctrl+J'],
      ['A file from this workspace', '@']
    ])
    await user.click(within(menu).getByRole('menuitem', { name: /^A file from this workspace/ }))
    expect(box().value).toBe('see @')
    expect(await screen.findByRole('listbox', { name: 'Suggestions' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^Add/ }))
    await user.click(screen.getByRole('menuitem', { name: /^Files or images/ }))
    expect(fakeApi.pickFiles).toHaveBeenCalled()
  })
})

describe('Compact now', () => {
  const usage = {
    used: 152_000,
    limit: 200_000,
    breakdown: { categories: [{ name: 'Messages', tokens: 152_000, kind: 'used' }, { name: 'Free space', tokens: 15_000, kind: 'free' }, { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' }], mcpServers: [], memoryFiles: [], skills: [] }
  }

  it('sends /compact as its own message and leaves the draft in the box', async () => {
    const user = userEvent.setup()
    renderComposer({ contextUsage: usage })
    await user.type(box(), 'half a thought')
    await user.click(screen.getByRole('button', { name: /Auto-compacts in about 15K/ }))
    expect(screen.getByText('Your draft stays in the box. It isn’t sent with /compact.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Compact now' }))
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', '/compact', {}))
    expect(box().value).toBe('half a thought')
  })

  it('queues it while a turn runs', async () => {
    const user = userEvent.setup()
    renderComposer({ contextUsage: usage, status: 'running' })
    await user.click(screen.getByRole('button', { name: /Auto-compacts in about 15K/ }))
    expect(screen.getByText(/^Queues \/compact/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Compact now' }))
    await waitFor(() => expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', '/compact', { mode: 'queue' }))
  })
})

describe('integrations for this workspace', () => {
  const before = { repos: fakeState.snapshot.repos, integrations: fakeState.snapshot.integrations }
  beforeEach(() => {
    fakeState.snapshot.repos = [{ id: 'r1', name: 'web' }] as never
    fakeState.snapshot.integrations = {
      connections: [
        { id: 'lin', service: 'linear', name: 'Acme Linear', rev: 1, auth: { kind: 'token' }, agentAccess: 'write', createdAt: 'x', usedBy: 1, isDefault: true },
        { id: 'sl', service: 'slack', name: 'Acme Slack', rev: 1, auth: { kind: 'token' }, agentAccess: 'write', createdAt: 'x', usedBy: 1, isDefault: true, startsOff: true }
      ]
    } as never
    fakeApi.setWorkspaceIntegration = vi.fn(async () => undefined)
    fakeApi.integrationToolCosts = vi.fn(async () => [])
  })
  afterEach(() => Object.assign(fakeState.snapshot, before))

  it('a chip says how many are on, and switching one goes to the workspace for its next turns', async () => {
    const user = userEvent.setup()
    renderComposer()
    const chip = screen.getByRole('button', { name: 'Integrations: Linear' })
    expect(chip.textContent).toContain('1')
    expect(chip.getAttribute('title')).toContain('next message')
    await user.click(chip)
    await user.click(within(await screen.findByRole('menu', { name: 'Integrations' })).getByRole('menuitemcheckbox', { name: /Slack/ }))
    expect(fakeApi.setWorkspaceIntegration).toHaveBeenCalledWith('w1', 'slack', true)
  })

  it('isn’t shown in a cloud workspace, where these tools don’t reach the sandbox', () => {
    render(<Composer session={session()} workspace={{ ...(workspace as object), cloud: { provider: 'vercel' } } as never} active hasHistory={false} />)
    expect(screen.queryByRole('button', { name: /^Integrations/ })).toBeNull()
  })
})

describe('Escape with the @ or / suggestions open', () => {
  beforeEach(() => {
    fakeApi.cancel = vi.fn(async () => undefined)
  })

  it('closes a menu with nothing in it and leaves the running agent alone; the next Escape stops it', async () => {
    fakeApi.listFiles = vi.fn(async () => ['src/alpha.ts'])
    const user = userEvent.setup()
    render(<Composer session={session({ status: 'running' })} workspace={{ ...(workspace as object), id: 'w-nomatch' } as never} active hasHistory={false} />)
    await user.type(box(), 'see @zzz')
    // Nothing matches, so no list is drawn, but the menu is open.
    await waitFor(() => expect(fakeApi.listFiles).toHaveBeenCalled())
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(fakeApi.cancel).not.toHaveBeenCalled()
    expect(box().value).toBe('see @zzz')
    await user.keyboard('{Escape}')
    expect(fakeApi.cancel).toHaveBeenCalledWith('s1')
  })

  it('closes a menu that is still loading without stopping the agent', async () => {
    // Another workspace, so the file list isn't cached from the tests above, and a list that never arrives.
    fakeApi.listFiles = vi.fn(() => new Promise<string[]>(() => undefined))
    fakeApi.slashCommands = vi.fn(() => new Promise(() => undefined))
    const user = userEvent.setup()
    render(<Composer session={session({ status: 'running' })} workspace={{ ...(workspace as object), id: 'w-loading' } as never} active hasHistory={false} />)
    await user.type(box(), '@')
    await user.keyboard('{Escape}')
    expect(fakeApi.cancel).not.toHaveBeenCalled()
    await user.clear(box())
    await user.type(box(), '/')
    await user.keyboard('{Escape}')
    expect(fakeApi.cancel).not.toHaveBeenCalled()
  })
})

describe('a plan waiting for review', () => {
  const plan = { kind: 'plan', id: 'p1', sessionId: 's1', plan: '1. Do it' } as never
  const renderPlan = () => render(<Composer session={session()} workspace={workspace} active hasHistory={false} pendingPlan={plan} />)

  beforeEach(() => {
    fakeApi.respondApproval = vi.fn(async () => undefined)
  })

  it('Ctrl+Shift+Enter approves, as the key line says, and keeps what was typed in the box', async () => {
    const user = userEvent.setup()
    renderPlan()
    // The plan's own card (docked above the box) has Approve; the composer has no plan bar, only its key line.
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(document.querySelector('.composer-keys')?.textContent).toContain('Ctrl+Shift+Enter approve the plan')
    expect(box().placeholder).toBe('Or say what to change, and press Enter to keep planning')
    await user.type(box(), 'and add tests')
    await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}')
    await waitFor(() => expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('p1', { kind: 'plan', approve: true })
    expect(box().value).toBe('and add tests')
    expect(fakeApi.sendMessage).not.toHaveBeenCalled()
  })

  it('plain Enter still sends what was typed as feedback on the plan', async () => {
    const user = userEvent.setup()
    renderPlan()
    await user.type(box(), 'and add tests')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.respondApproval).toHaveBeenCalledTimes(1))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('p1', { kind: 'plan', approve: false, feedback: 'and add tests' })
    expect(box().value).toBe('')
  })
})

describe('key hints follow the platform', () => {
  const queue = [
    { id: 'q1', text: 'first message', attachments: [] },
    { id: 'q2', text: 'second message', attachments: [] }
  ]
  const plan = { kind: 'plan', id: 'p1', sessionId: 's1', plan: '1. Do it' } as never
  afterEach(() => {
    fakeState.snapshot.platform = 'win32'
  })

  async function renderAll() {
    const user = userEvent.setup()
    render(<Composer session={session({ status: 'running', queue, planMode: false })} workspace={workspace} active hasHistory={false} pendingPlan={plan} />)
    // The queue's editor, for its Save key.
    await user.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Edit' }))
  }

  it('spells the keys out on Windows, with no Mac symbols anywhere in the composer', async () => {
    fakeState.snapshot.platform = 'win32'
    await renderAll()
    expect(screen.getByRole('button', { name: /^Plan/ }).title).toBe('Plan mode (Shift+Tab)')
    expect(document.querySelector('.composer-keys')?.textContent).toContain('Ctrl+Shift+Enter approve the plan')
    expect(screen.getByRole('button', { name: /^Save/ }).textContent).toBe('Save Ctrl+Enter')
    expect(screen.getAllByRole('button', { name: /^Move up/ })[0].getAttribute('aria-label')).toMatch(/Alt\+Up/)
    const titles = Array.from(document.querySelectorAll('[title], [aria-label]')).map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`)
    expect(`${document.body.textContent} ${titles.join(' ')}`).not.toMatch(/[⌘⌥⇧↵⌫]/)
  })

  it('draws the symbols on macOS', async () => {
    fakeState.snapshot.platform = 'darwin'
    await renderAll()
    expect(screen.getByRole('button', { name: /^Plan/ }).title).toBe('Plan mode (⇧Tab)')
    expect(document.querySelector('.composer-keys')?.textContent).toContain('⌘⇧↵ approve the plan')
    expect(screen.getByRole('button', { name: /^Save/ }).textContent).toBe('Save ⌘↵')
    expect(screen.getAllByRole('button', { name: /^Move up/ })[0].getAttribute('aria-label')).toMatch(/⌥↑/)
  })
})
