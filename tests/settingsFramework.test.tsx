// @vitest-environment jsdom
// The settings frame (B6): the menu and its search box, and the environment sheet.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPicker } from '../src/renderer/src/components/settings/GithubAccount'
import { AddVariableSheet } from '../src/renderer/src/components/settings/EnvSheet'
import { SettingsNav } from '../src/renderer/src/components/settings/SettingsNav'
import { openSettingsPage } from '../src/renderer/src/store'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeState.snapshot.repos = [{ id: 'r1', name: 'alpha', rootPath: '/code/alpha' }]
  fakeState.snapshot.platform = 'win32'
  vi.mocked(openSettingsPage).mockClear()
})
afterEach(cleanup)

const nav = (onClose = vi.fn()) => render(<SettingsNav page={{ section: 'general' }} repoTab={() => 'git'} onClose={onClose} />)

describe('SettingsNav', () => {
  it('a group opens and closes with its chevron, which says which it is doing', async () => {
    const user = userEvent.setup()
    nav()
    const toggle = screen.getByRole('button', { name: /^(Collapse|Expand) Appearance$/ })
    const opened = toggle.getAttribute('aria-expanded') === 'true'
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe(opened ? 'false' : 'true')
  })

  it('the repository head opens the repository page and marks itself current when it is the page', async () => {
    const user = userEvent.setup()
    render(<SettingsNav page={{ section: 'repo', repoId: 'r1', tab: 'git' }} repoTab={() => 'git'} onClose={() => undefined} />)
    const head = screen.getByRole('button', { name: 'alpha' })
    expect(head.getAttribute('aria-current')).toBe('page')
    await user.click(head)
    expect(openSettingsPage).toHaveBeenCalledWith({ section: 'repo', repoId: 'r1', tab: 'git' })
  })

  it('typing lists matches in a listbox: arrows move, Enter opens the page and clears the box', async () => {
    const user = userEvent.setup()
    nav()
    const box = screen.getByRole('combobox', { name: /search/i })
    await user.type(box, 'branch')
    const list = screen.getByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0].id)
    if (options.length > 1) {
      await user.keyboard('{ArrowDown}')
      expect(box.getAttribute('aria-activedescendant')).toBe(options[1].id)
      await user.keyboard('{ArrowUp}')
    }
    await user.keyboard('{Enter}')
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect((box as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape clears the search first and is left for the page to close settings the second time', async () => {
    const user = userEvent.setup()
    nav()
    // What the settings view's own Escape handler sees: it ignores an Escape that was handled.
    const seen = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && seen(e)
    const box = screen.getByRole('combobox', { name: /search/i }) as HTMLInputElement
    await user.type(box, 'zzzz-no-such-setting')
    expect(screen.getByRole('status').textContent).toMatch(/zzzz-no-such-setting/)
    window.addEventListener('keydown', onKey)
    await user.keyboard('{Escape}')
    expect(box.value).toBe('')
    // The search handled it: the settings view's own Escape handler (which skips defaultPrevented) must not close.
    expect(seen).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.results[0].value).toBe(false)
    window.removeEventListener('keydown', onKey)
  })

  it('Back goes through onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    nav(onClose)
    await user.click(screen.getByRole('button', { name: /Back/ }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the environment sheet', () => {
  it('is a dialog with named fields: it saves what was typed and Escape closes it', async () => {
    fakeApi.setEnvVars = vi.fn(async () => undefined)
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    render(<AddVariableSheet scope={{ kind: 'user' }} existing={new Set()} onClose={onClose} onSaved={onSaved} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    const value = within(dialog).getByRole('textbox', { name: 'Value' })
    expect(document.activeElement).toBe(name)
    await user.type(name, 'MY_VAR')
    await user.type(value, 'secret')
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(fakeApi.setEnvVars).toHaveBeenCalledWith({ kind: 'user' }, [{ key: 'MY_VAR', value: 'secret' }]))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSaved).toHaveBeenCalled()
  })

  it('says why a name is refused, as an alert', async () => {
    const user = userEvent.setup()
    render(<AddVariableSheet scope={{ kind: 'user' }} existing={new Set(['TAKEN'])} onClose={() => undefined} onSaved={() => undefined} />)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'TAKEN')
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/exist|already/i)
  })

  it('Escape closes the sheet', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<AddVariableSheet scope={{ kind: 'user' }} existing={new Set()} onClose={onClose} onSaved={() => undefined} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the GitHub account picker', () => {
  const accounts = [
    { login: 'work', active: true },
    { login: 'me', active: false }
  ]

  it('opens a listbox of accounts, chooses with the keyboard and gives focus back', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<AccountPicker accounts={accounts} value="work" allowDefault onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: /work/ })
    await user.click(trigger)
    const list = screen.getByRole('listbox', { name: 'GitHub account' })
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options.find((o) => o.getAttribute('aria-selected') === 'true')?.textContent).toContain('work')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('me')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape closes it without choosing', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<AccountPicker accounts={accounts} value="work" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: /work/ })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(onChange).not.toHaveBeenCalled()
  })
})
