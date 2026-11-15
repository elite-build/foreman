// @vitest-environment jsdom
// The settings frame (B6): the menu and its search box, and the environment sheet.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPicker } from '../src/renderer/src/components/settings/GithubAccount'
import { AddVariableSheet } from '../src/renderer/src/components/settings/EnvSheet'
import { SettingsNav } from '../src/renderer/src/components/settings/SettingsNav'
import { openSettingsPage, type SettingsPage } from '../src/renderer/src/store'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeState.snapshot.repos = [{ id: 'r1', name: 'alpha', rootPath: '/code/alpha' }]
  fakeState.snapshot.platform = 'win32'
  vi.mocked(openSettingsPage).mockClear()
})
afterEach(cleanup)

/** The menu as the settings view holds it: the search text is the view's. */
function Nav({ page, onClose }: { page: SettingsPage; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  return <SettingsNav page={page} repoTab={() => 'git'} onClose={onClose} query={query} onQuery={setQuery} results={[]} inputRef={input} onResults={() => undefined} />
}

const nav = (onClose = vi.fn(), page: SettingsPage = { section: 'general' }) => render(<Nav page={page} onClose={onClose} />)

describe('SettingsNav', () => {
  it('is a tree: the open page’s category is open, the others closed, and the open page is current', () => {
    nav(vi.fn(), { section: 'general', part: 'chat' })
    const tree = screen.getByRole('tree', { name: 'Settings' })
    const general = within(tree).getByRole('treeitem', { name: /^General/ })
    expect(general.getAttribute('aria-expanded')).toBe('true')
    expect(within(tree).getByRole('treeitem', { name: /^Appearance/ }).getAttribute('aria-expanded')).toBe('false')
    // General's parts, in page order, under it.
    const chat = within(tree).getByRole('treeitem', { name: 'Chat' })
    expect(chat.getAttribute('aria-current')).toBe('page')
    expect(chat.getAttribute('aria-selected')).toBe('true')
    const names = within(tree).getAllByRole('treeitem').map((i) => i.textContent)
    expect(names.indexOf('Language')).toBeLessThan(names.indexOf('Chat'))
    expect(names.indexOf('Chat')).toBeLessThan(names.indexOf('Notifications'))
  })

  it('opening a closed category opens its first page; ← closes the open one and selects it', async () => {
    const user = userEvent.setup()
    nav()
    const tree = screen.getByRole('tree', { name: 'Settings' })
    await user.click(within(tree).getByRole('treeitem', { name: /^Appearance/ }))
    expect(openSettingsPage).toHaveBeenCalledWith({ section: 'appearance', part: 'interface' })
    const general = within(tree).getByRole('treeitem', { name: /^General/ })
    general.focus()
    await user.keyboard('{ArrowLeft}')
    expect(general.getAttribute('aria-expanded')).toBe('false')
    // The open page is hidden in it now, so the category carries the selection.
    expect(general.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowRight}')
    expect(general.getAttribute('aria-expanded')).toBe('true')
  })

  it('a page opens with Enter', async () => {
    const user = userEvent.setup()
    nav()
    const notifications = screen.getByRole('treeitem', { name: 'Notifications' })
    notifications.focus()
    await user.keyboard('{Enter}')
    expect(openSettingsPage).toHaveBeenCalledWith({ section: 'general', part: 'notifications' })
  })

  it('Agents & models lists the agents, each with its own pages', async () => {
    nav(vi.fn(), { section: 'agents', agent: 'claude', part: 'accounts' })
    const tree = screen.getByRole('tree', { name: 'Settings' })
    const claude = within(tree).getByRole('treeitem', { name: 'Claude Code' })
    expect(claude.getAttribute('aria-expanded')).toBe('true')
    expect(within(tree).getByRole('treeitem', { name: 'Accounts' }).getAttribute('aria-current')).toBe('page')
    expect(within(tree).getByRole('treeitem', { name: 'Codex' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(tree).getByRole('treeitem', { name: 'Default models' })).toBeTruthy()
  })

  it('the repository opens its page and marks itself current when it is the page', async () => {
    const user = userEvent.setup()
    nav(vi.fn(), { section: 'repo', repoId: 'r1', tab: 'git' })
    const repos = screen.getByRole('tree', { name: 'Repositories' })
    expect(within(repos).getByRole('treeitem', { name: 'Git' }).getAttribute('aria-current')).toBe('page')
    const head = within(repos).getByRole('treeitem', { name: 'alpha' })
    head.focus()
    await user.keyboard('{ArrowLeft}')
    expect(head.getAttribute('aria-current')).toBe('page')
    cleanup()
    nav()
    await user.click(screen.getByRole('treeitem', { name: 'alpha' }))
    expect(openSettingsPage).toHaveBeenCalledWith({ section: 'repo', repoId: 'r1', tab: 'git' })
  })

  it('Escape clears the search first and is left for the page to close settings the second time', async () => {
    const user = userEvent.setup()
    nav()
    // What the settings view's own Escape handler sees: it ignores an Escape that was handled.
    const seen = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && seen(e)
    const box = screen.getByRole('textbox', { name: /search/i }) as HTMLInputElement
    await user.type(box, 'zzzz-no-such-setting')
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
