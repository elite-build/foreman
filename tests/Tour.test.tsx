// @vitest-environment jsdom
// The welcome tour's card (components/Tour.tsx): the keys that move through it, where focus goes, what a screen reader
// hears on each step, the card for a control that is hidden, the step buttons, and keycaps that follow the platform.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announcer } from '../src/renderer/src/announce'
import { Tour } from '../src/renderer/src/components/Tour'
import * as store from '../src/renderer/src/store'
import { TOUR_STEPS } from '../src/shared/tour'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

const IDS = TOUR_STEPS.map((s) => s.id)
const at = (id: string) => IDS.indexOf(id)

// The targets that are "on screen": every one by default.
let present = new Set<string>()
const element = document.createElement('div')
element.getBoundingClientRect = () => ({ left: 10, top: 100, width: 40, height: 30, right: 50, bottom: 130, x: 10, y: 100, toJSON: () => ({}) })

const show = (id: string, platform = 'win32') => {
  fakeState.snapshot.platform = platform
  fakeState.tour = { steps: IDS, index: at(id) }
}
const dialog = () => screen.getByRole('dialog')

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  present = new Set(TOUR_STEPS.flatMap((s) => (s.target ? [s.target] : [])))
  storeModule.findTourTarget = vi.fn((target: string) => (present.has(target) ? element : null))
  fakeState.snapshot.settings = { ...fakeState.snapshot.settings, windowLayout: 'panes' }
  announcer.reset()
})
afterEach(() => {
  cleanup()
  fakeState.tour = null
})

describe('keyboard', () => {
  it('→ goes to the next step, ← to the previous one and Esc ends the tour', () => {
    show('needsYou')
    render(<Tour />)
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    expect(spy('goToTourStep')).toHaveBeenLastCalledWith(at('needsYou') + 1)
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' })
    expect(spy('goToTourStep')).toHaveBeenLastCalledWith(at('needsYou') - 1)
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(spy('endTour')).toHaveBeenCalledTimes(1)
  })

  it('← does nothing on the first step and → does nothing on the last', () => {
    show('welcome')
    const { rerender } = render(<Tour />)
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' })
    show('help')
    rerender(<Tour />)
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    expect(spy('goToTourStep')).not.toHaveBeenCalled()
  })

  it('the buttons go back, on, skip and finish', async () => {
    const user = userEvent.setup()
    show('automations')
    const { rerender } = render(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Next' }))
    expect(spy('goToTourStep')).toHaveBeenLastCalledWith(at('automations') + 1)
    await user.click(within(dialog()).getByRole('button', { name: 'Back' }))
    expect(spy('goToTourStep')).toHaveBeenLastCalledWith(at('automations') - 1)
    await user.click(within(dialog()).getByRole('button', { name: 'Skip tour' }))
    expect(spy('endTour')).toHaveBeenCalledTimes(1)
    show('help')
    rerender(<Tour />)
    expect(within(dialog()).queryByRole('button', { name: 'Skip tour' })).toBeNull()
    await user.click(within(dialog()).getByRole('button', { name: 'Done' }))
    expect(spy('endTour')).toHaveBeenCalledTimes(2)
  })
})

describe('focus', () => {
  it('is a labelled modal dialog and focus starts on its main button, on every step', () => {
    show('welcome')
    const { rerender } = render(<Tour />)
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(within(dialog()).getByRole('heading', { name: 'Welcome to Foreman' })).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Show me around' }))
    // Focus moved elsewhere in the card, then a new step: back on Next.
    within(dialog()).getByRole('button', { name: 'Skip tour' }).focus()
    show('addRepo')
    rerender(<Tour />)
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Next' }))
  })

  it('Tab wraps inside the card and never leaves it', async () => {
    // jsdom has no layout, so nothing "takes up space"; the focus trap only counts what does.
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    try {
      const user = userEvent.setup()
      show('layout')
      render(<Tour />)
      const buttons = within(dialog()).getAllByRole('button')
      buttons.at(-1)!.focus()
      await user.tab()
      expect(document.activeElement).toBe(buttons[0])
      await user.tab({ shift: true })
      expect(document.activeElement).toBe(buttons.at(-1))
    } finally {
      rects.mockRestore()
    }
  })
})

describe('announcing each step', () => {
  it('says which step it is, its title and its text, with the keys for this platform', async () => {
    show('assistant', 'win32')
    const { rerender } = render(<Tour />)
    await waitFor(() => expect(announcer.current().text).toContain(`Tour, step ${at('assistant') + 1} of ${IDS.length}: Ask the assistant.`), { timeout: 3000 })
    expect(announcer.current().text).toContain('Ask here (Ctrl+Shift+A).')
    show('layout', 'darwin')
    rerender(<Tour />)
    await waitFor(() => expect(announcer.current().text).toContain('Two ways to see your work'), { timeout: 3000 })
    expect(announcer.current().text).toContain('⌘K')
  })

  it('says how to find a hidden control as well', async () => {
    present.delete('automations')
    show('automations')
    render(<Tour />)
    await waitFor(() => expect(announcer.current().text).toContain('The sidebar is hidden. Show it with Ctrl+B, then look for Automations, at the top of the sidebar.'), { timeout: 3000 })
  })
})

describe('a control that is not on screen', () => {
  it('centers the card and says exactly what to open and what to look for', () => {
    present.delete('needs-you')
    show('needsYou')
    render(<Tour />)
    expect(dialog().className).toContain('side-center')
    const away = within(dialog()).getByText(/The sidebar is hidden/)
    expect(away.textContent).toBe('The sidebar is hidden. Show it with Ctrl+B, then look for the All, Needs you, Running and Pinned filters.')
    expect(within(away).getByText('Ctrl+B')).toBeTruthy()
  })

  it('names the sidebar toggle for the platform', () => {
    present.delete('settings')
    show('settings', 'darwin')
    render(<Tour />)
    expect(within(dialog()).getByText(/The sidebar is hidden/).textContent).toBe('The sidebar is hidden. Show it with ⌘B, then look for the gear in the strip of repository icons.')
  })

  it('has no such note when the control is there, and none on the cards that point at nothing', () => {
    show('needsYou')
    const { rerender } = render(<Tour />)
    expect(dialog().className).not.toContain('side-center')
    expect(within(dialog()).queryByText(/The sidebar is hidden/)).toBeNull()
    show('layout')
    rerender(<Tour />)
    expect(dialog().className).toContain('side-center')
    expect(within(dialog()).queryByText(/The sidebar is hidden/)).toBeNull()
  })
})

describe('the step buttons', () => {
  it('Needs you: filters the sidebar to what needs you and ends the tour', async () => {
    show('needsYou')
    render(<Tour />)
    await userEvent.setup().click(within(dialog()).getByRole('button', { name: 'Show what needs you' }))
    expect(spy('setSidebarFilter')).toHaveBeenCalledWith('needs-you')
    expect(spy('endTour')).toHaveBeenCalledTimes(1)
  })

  it('layout: switches to Tiles from three panes, and back from Tiles', async () => {
    const user = userEvent.setup()
    show('layout')
    const { rerender } = render(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Switch to Tiles' }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ windowLayout: 'tiles' })
    expect(spy('endTour')).toHaveBeenCalledTimes(1)
    fakeState.snapshot.settings.windowLayout = 'tiles'
    rerender(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Switch to three panes' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ windowLayout: 'panes' })
  })

  it('Automations, the assistant and Settings open the real place', async () => {
    const user = userEvent.setup()
    show('automations')
    const { rerender } = render(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Open Automations' }))
    expect(spy('openAutomations')).toHaveBeenCalledTimes(1)
    show('assistant')
    rerender(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Open the assistant' }))
    expect(spy('openAssistant')).toHaveBeenCalledTimes(1)
    show('settings')
    rerender(<Tour />)
    await user.click(within(dialog()).getByRole('button', { name: 'Open Settings → Accessibility' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'accessibility' })
    expect(spy('endTour')).toHaveBeenCalledTimes(3)
  })

  it('cards without something to do have no extra button', () => {
    for (const id of ['welcome', 'addRepo', 'newWorkspace', 'help']) {
      show(id)
      const { unmount } = render(<Tour />)
      const names = within(dialog())
        .getAllByRole('button')
        .map((b) => b.textContent)
      expect(names.every((n) => ['Show me around', 'Next', 'Back', 'Skip tour', 'Done'].includes(n ?? ''))).toBe(true)
      unmount()
    }
  })
})

describe('keycaps follow the platform', () => {
  it('Windows spells the keys out: Ctrl+Shift+A, Ctrl+Alt+L, never ⇧ or ⌥', () => {
    for (const [id, keys] of [
      ['newWorkspace', ['Ctrl+N']],
      ['needsYou', ['Ctrl+Alt+L', 'Ctrl+Alt+.']],
      ['layout', ['Ctrl+K']],
      ['assistant', ['Ctrl+Shift+A']],
      ['help', ['Ctrl+K', 'Ctrl+Alt+/']]
    ] as const) {
      show(id, 'win32')
      const { unmount } = render(<Tour />)
      for (const key of keys) expect(within(dialog()).getByText(key).tagName).toBe('KBD')
      expect(dialog().textContent).not.toMatch(/[⌘⇧⌥⌃]/)
      unmount()
    }
  })

  it('macOS draws the symbols: ⌘⇧A, ⌘⌥L', () => {
    for (const [id, keys] of [
      ['newWorkspace', ['⌘N']],
      ['needsYou', ['⌘⌥L', '⌘⌥.']],
      ['assistant', ['⌘⇧A']],
      ['help', ['⌘K', '⌘⌥/']]
    ] as const) {
      show(id, 'darwin')
      const { unmount } = render(<Tour />)
      for (const key of keys) expect(within(dialog()).getByText(key).tagName).toBe('KBD')
      expect(dialog().textContent).not.toContain('Ctrl')
      unmount()
    }
  })

  it('no step has a shortcut written into its words', () => {
    for (const id of IDS) {
      show(id, 'win32')
      const { unmount } = render(<Tour />)
      expect(within(dialog()).getByRole('heading').textContent).not.toMatch(/[⌘⇧⌥⌃]/)
      expect(dialog().textContent).not.toMatch(/[⌘⇧⌥⌃]/)
      unmount()
    }
  })
})
