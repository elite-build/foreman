// @vitest-environment jsdom
// The settings building blocks: a row's label and help name the control inside it, and the General page's language picker.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralPage } from '../src/renderer/src/components/settings/GeneralPage'
import { HomeSection } from '../src/renderer/src/components/settings/HomeSection'
import { MaskedValue, Row, TextAreaRow, TextRow, ToggleRow } from '../src/renderer/src/components/settings/controls'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeState.snapshot.settings.language = 'system'
  fakeApi.updateSettings = vi.fn(async () => ({}))
})
afterEach(cleanup)

describe('Row and its controls', () => {
  it('a toggle row names its switch by the label and describes it by the help', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleRow label="Keep awake" help="Stops the computer sleeping." detail="Only on power." checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Keep awake' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    const described = sw.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(described).toEqual(['Stops the computer sleeping.', 'Only on power.'])
    await user.click(screen.getByText('Keep awake'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('a text row commits on blur and on Enter, but not on the Enter that confirms a composition', async () => {
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<TextRow label="Branch prefix" help="Used for new branches." value="old" onCommit={onCommit} />)
    const input = screen.getByRole('textbox', { name: 'Branch prefix' }) as HTMLInputElement
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    await user.clear(input)
    await user.type(input, 'new')
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledWith('new')
    expect(document.activeElement).not.toBe(input)
  })

  it('a text area row is named by its label', () => {
    render(<TextAreaRow label="Setup script" value="npm i" onCommit={() => undefined} />)
    expect((screen.getByRole('textbox', { name: 'Setup script' }) as HTMLTextAreaElement).value).toBe('npm i')
  })

  it('a row with a reset offers it in a menu', async () => {
    const reset = vi.fn()
    const user = userEvent.setup()
    render(<Row label="Thing" onReset={reset}>{(c) => <input {...c} aria-label="x" />}</Row>)
    await user.click(screen.getByRole('button', { name: 'Setting actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reset' }))
    expect(reset).toHaveBeenCalled()
  })

  it('MaskedValue keeps the old props and reveals on demand', async () => {
    const reveal = vi.fn(async () => 'sk-secret')
    const user = userEvent.setup()
    render(<MaskedValue label="API key" hint="abcd" reveal={reveal} />)
    expect(screen.getByRole('group', { name: 'API key' }).textContent).toContain('••••••••abcd')
    expect(reveal).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Reveal API key/ }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'API key' }).textContent).toContain('sk-secret'))
  })
})

describe('Settings → General', () => {
  beforeEach(() => {
    fakeApi.fullDiskAccess = vi.fn(async () => true)
  })

  it('the language picker is a popover with a listbox: arrows move, Enter chooses, Escape closes', async () => {
    const user = userEvent.setup()
    render(<GeneralPage />)
    const trigger = screen.getByRole('button', { name: /^Language: / })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    await user.click(trigger)
    const list = screen.getByRole('listbox', { name: /language/i })
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeGreaterThan(5)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    // Each language is named in its own language.
    expect(options.find((o) => o.textContent?.includes('日本語'))?.getAttribute('lang')).toBe('ja')
    expect(document.activeElement).toBe(list)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await user.click(trigger)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledTimes(1))
    expect(fakeApi.updateSettings.mock.calls[0][0]).toEqual({ language: expect.any(String) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('every setting here has a named control', () => {
    render(<GeneralPage />)
    expect(screen.getByRole('combobox', { name: 'Send messages with' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Agent notifications' })).toBeTruthy()
  })
})

describe('Appearance → Sidebar & Home: the views', () => {
  afterEach(() => {
    delete (fakeState.snapshot.settings as { views?: unknown; homeBoard?: unknown }).views
    delete (fakeState.snapshot.settings as { homeBoard?: unknown }).homeBoard
  })

  it('a switch per place each view can go, named by view and place; turning one on saves the list', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.settings.homeBoard = true
    render(<HomeSection />)
    // All is a tab only; Pinned is no lane.
    expect(screen.queryByRole('switch', { name: 'All: Board lane' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Pinned: Board lane' })).toBeNull()
    const inReview = screen.getByRole('switch', { name: 'In review: Sidebar tab' })
    expect(inReview.getAttribute('aria-checked')).toBe('false')
    await user.click(inReview)
    const saved = (fakeApi.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(saved.views.find((v: { id: string }) => v.id === 'in-review')).toEqual({ id: 'in-review', tab: true, lane: true, home: false })
  })

  it('the board column shows only while Board view is on', () => {
    render(<HomeSection />)
    expect(screen.getByRole('switch', { name: 'Working: Sidebar tab' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Working: Board lane' })).toBeNull()
  })

  it('the last tab on can’t be turned off', () => {
    fakeState.snapshot.settings.views = [
      { id: 'all', tab: false, lane: false, home: false },
      { id: 'needs-you', tab: false, lane: true, home: true },
      { id: 'working', tab: true, lane: true, home: true },
      { id: 'pinned', tab: false, lane: false, home: false }
    ]
    render(<HomeSection />)
    expect((screen.getByRole('switch', { name: 'Working: Sidebar tab' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: 'Working: Home section' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Move up and Move down reorder the list; the ends are disabled', async () => {
    const user = userEvent.setup()
    render(<HomeSection />)
    expect((screen.getByRole('button', { name: 'Move All up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move Done down' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Move Pinned up' }))
    const saved = (fakeApi.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
    expect(saved.views.map((v: { id: string }) => v.id)).toEqual(['all', 'needs-you', 'pinned', 'working', 'later', 'in-review', 'ready', 'done'])
  })
})
