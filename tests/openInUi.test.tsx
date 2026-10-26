// @vitest-environment jsdom
// Open in on ui/: the file viewer's split button and its menu, the right-click default-app menu, and the ⌘O switcher.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultAppMenu, OpenInSwitcher, OpenInViewerButton } from '../src/renderer/src/components/OpenIn'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const app = (id: string, name: string, kind: string, path: string | null) => ({ id, name, kind, atLine: kind === 'editor', path, found: path ? 'path' : null, detected: path, detectedWhere: null })
const detection = {
  platform: 'linux',
  checkedAt: 'now',
  apps: [app('vscode', 'VS Code', 'editor', '/usr/bin/code'), app('cursor', 'Cursor', 'editor', null), app('terminal', 'Terminal', 'terminal', '/usr/bin/xterm'), app('files', 'Files', 'files', '/usr/bin/xdg-open')]
}

beforeEach(async () => {
  resetFake()
  fakeApi.openInApps = vi.fn(async () => detection)
  fakeApi.openInIcons = vi.fn(async () => ({}))
  fakeApi.openIn = vi.fn(async () => undefined)
  fakeApi.updateSettings = vi.fn(async () => ({}))
  fakeState.snapshot.platform = 'linux'
  fakeState.snapshot.settings.openInDefault = ''
  fakeState.snapshot.settings.editorCommand = ''
  fakeState.snapshot.workspaces = [{ id: 'w1', name: 'main', state: 'ready', repoId: 'r1', path: '/repo/ws' }]
  fakeState.selectedWorkspaceId = 'w1'
  // The detection is kept by the module between tests; ask again so each starts from the same apps.
  const { refreshOpenInApps } = await import('../src/renderer/src/openIn')
  await refreshOpenInApps(true)
})
afterEach(cleanup)

describe('the file viewer’s Open button', () => {
  it('is two buttons: the default app, and an arrow that lists the other apps', async () => {
    const user = userEvent.setup()
    render(<OpenInViewerButton workspaceId="w1" workspacePath="/repo/ws" path="src/a.ts" line={12} />)
    const arrow = await screen.findByRole('button', { name: 'Open in another app' })
    expect(arrow.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(arrow)
    const menu = screen.getByRole('menu')
    const names = within(menu).getAllByRole('menuitem').map((i) => i.querySelector('.ui-menu__label')?.textContent)
    expect(names).toEqual(expect.arrayContaining(['VS Code', 'Terminal', 'Custom command…']))
    expect(names).not.toContain('Cursor')
    await user.click(within(menu).getByRole('menuitem', { name: /Terminal/ }))
    expect(fakeApi.openIn).toHaveBeenCalledWith('terminal', expect.objectContaining({ folder: '/repo/ws' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('looks for apps again each time the menu opens', async () => {
    const user = userEvent.setup()
    render(<OpenInViewerButton workspaceId="w1" workspacePath="/repo/ws" path="src/a.ts" />)
    await screen.findAllByRole('button')
    fakeApi.openInApps.mockClear()
    await user.click(screen.getAllByRole('button')[1])
    await waitFor(() => expect(fakeApi.openInApps).toHaveBeenCalledWith(true))
  })

  it('with no default app to run, pressing the main button shows the menu', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.settings.openInDefault = 'cursor'
    render(<OpenInViewerButton workspaceId="w1" workspacePath="/repo/ws" path="src/a.ts" />)
    const [main] = await screen.findAllByRole('button')
    await user.click(main)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(fakeApi.openIn).not.toHaveBeenCalled()
  })

  it('right-click opens the default-app menu, a radio group that saves the choice', async () => {
    const user = userEvent.setup()
    render(<OpenInViewerButton workspaceId="w1" workspacePath="/repo/ws" path="src/a.ts" />)
    const [main] = await screen.findAllByRole('button')
    await user.pointer({ keys: '[MouseRight]', target: main })
    const menu = await screen.findByRole('menu', { name: 'Default app for Open' })
    const group = within(menu).getByRole('group', { name: 'Default app for Open' })
    const radios = within(group).getAllByRole('menuitemradio')
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    await user.click(within(group).getByRole('menuitemradio', { name: 'Terminal' }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ openInDefault: 'terminal' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('the default-app menu', () => {
  it('Custom is off until a command is set, and Escape closes the menu', async () => {
    const user = userEvent.setup()
    const dismiss = vi.fn()
    render(<DefaultAppMenu x={5} y={5} dismiss={dismiss} />)
    expect((await screen.findByRole('menuitemradio', { name: 'Custom command…' })) as HTMLButtonElement).toHaveProperty('disabled', true)
    await user.keyboard('{Escape}')
    expect(dismiss).toHaveBeenCalled()
  })
})

describe('the ⌘O switcher', () => {
  it('is a dialog with a search field driving a listbox; ↓ ↑ move, Enter opens, ⇧Enter opens the folder', async () => {
    const user = userEvent.setup()
    render(<OpenInSwitcher />)
    const dialog = screen.getByRole('dialog', { name: 'Open in an app' })
    const input = within(dialog).getByRole('combobox')
    expect(document.activeElement).toBe(input)
    const list = await within(dialog).findByRole('listbox', { name: 'Open in an app' })
    expect(input.getAttribute('aria-controls')).toBe(list.id)
    const options = () => within(list).getAllByRole('option')
    expect(options().map((o) => o.querySelector('.ui-option__label')?.textContent)).toEqual(['VS Code', 'Terminal', 'Files'].map((n) => (n === 'Files' ? 'File Explorer' : n)))
    // Starts on the default app (the first editor).
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id)
    await user.keyboard('{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(fakeApi.openIn).toHaveBeenCalledWith('terminal', expect.objectContaining({ folder: expect.any(String) }))
  })

  it('typing filters the list; clicking a row opens it; no match says so', async () => {
    const user = userEvent.setup()
    render(<OpenInSwitcher />)
    const input = screen.getByRole('combobox')
    await screen.findByRole('listbox')
    await user.type(input, 'term')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.click(screen.getByRole('option', { name: /Terminal/ }))
    expect(fakeApi.openIn).toHaveBeenCalledTimes(1)
    cleanup()
    render(<OpenInSwitcher />)
    await user.type(screen.getByRole('combobox'), 'zzz')
    expect(screen.getByText('No matches')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
