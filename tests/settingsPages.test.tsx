// @vitest-environment jsdom
// Settings you can browse: each menu entry opens one short page (a part of a settings page), Previous and Next walk
// them, old links land on the page that now holds their row and light it, and search fills the page with results.
import './domShims'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createT } from '../src/shared/i18n'
import { SETTINGS } from '../src/shared/settingsRegistry'
import { settingFlashParts } from '../src/renderer/src/components/settings/flashParts'
import { PAGE_PARTS, pageNode, pageNodes, settingsTree } from '../src/renderer/src/components/settings/pages'
import { SettingsView } from '../src/renderer/src/components/settings/SettingsView'
import { openSettingsPage, type SettingsPage } from '../src/renderer/src/store'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const t = createT('en')
const tree = (platform = 'win32') => settingsTree({ t, platform, agentPrefs: {} })
const opens = (page: SettingsPage, platform?: string) => pageNode(tree(platform), page)?.id

describe('the pages (pages.ts)', () => {
  it('a category opens on its first page; an agent on its sign-in', () => {
    expect(opens({ section: 'general' })).toBe('general/language')
    expect(opens({ section: 'agents' })).toBe('agents/catalog')
    expect(opens({ section: 'agents', agent: 'claude' })).toBe('agents/claude/signin')
    expect(opens({ section: 'models' })).toBe('models/loadout')
    expect(opens({ section: 'environment' })).toBe('environment')
    expect(opens({ section: 'spaces' })).toBe('spaces')
  })

  it('a link to a row opens the page that holds it, wherever the link thought it was', () => {
    // Links from around the app, as they were written before the pages were split.
    expect(opens({ section: 'general', scrollTo: 'keep-awake' })).toBe('general/system')
    expect(opens({ section: 'general', scrollTo: 'check-for-updates' })).toBe('general/updates')
    expect(opens({ section: 'general', scrollTo: 'editor-command' })).toBe('general/open-in')
    expect(opens({ section: 'account', scrollTo: 'privacy-mode' })).toBe('account/privacy')
    expect(opens({ section: 'models', scrollTo: 'loadout' })).toBe('models/loadout')
    expect(opens({ section: 'git', scrollTo: 'gitlab-accounts' })).toBe('git/accounts')
    expect(opens({ section: 'appearance', scrollTo: 'sidebar-side' })).toBe('appearance/layout')
    expect(opens({ section: 'advanced', scrollTo: 'keep-agents-running' })).toBe('advanced/keep-running')
    expect(opens({ section: 'data', scrollTo: 'git-backup-destination' })).toBe('data/git-backup')
    // The device rows moved from Data to Devices; their old links follow them.
    expect(opens({ section: 'data', scrollTo: 'remote-control' })).toBe('devices/computers')
    expect(opens({ section: 'data', scrollTo: 'agent-access' })).toBe('devices/agents')
    expect(opens({ section: 'agents', agent: 'claude', scrollTo: 'models-claude' })).toBe('agents/claude/models')
    expect(opens({ section: 'agents', agent: 'claude', scrollTo: 'chrome-mode' })).toBe('agents/claude/signin')
    // A named part wins.
    expect(opens({ section: 'agents', agent: 'claude', part: 'accounts' })).toBe('agents/claude/accounts')
  })

  it('every setting in the registry lives on a page of the menu that has its part', () => {
    const pages = tree()
    for (const row of SETTINGS) {
      if (row.page.section === 'repo') continue
      const node = pageNode(pages, { ...(row.page as SettingsPage), scrollTo: row.id })
      expect(node, row.id).toBeTruthy()
      expect(node!.page!.section, row.id).toBe(row.page.section)
      expect(node!.page!.part, row.id).toBe(row.part)
      const parts = PAGE_PARTS[row.page.section as keyof typeof PAGE_PARTS]
      if (parts && row.page.section !== 'agents') expect(parts.map((p) => p.key), row.id).toContain(row.part)
    }
  })

  it('the Windows terminal page is only on Windows', () => {
    expect(opens({ section: 'general', part: 'terminal' }, 'win32')).toBe('general/terminal')
    expect(pageNodes(tree('darwin')).some((n) => n.id === 'general/terminal')).toBe(false)
  })

  it('Previous and Next walk the menu in order, across categories', () => {
    const ids = pageNodes(tree()).map((n) => n.id)
    expect(ids[0]).toBe('general/language')
    expect(ids.indexOf('agents/claude/accounts')).toBe(ids.indexOf('agents/claude/signin') + 1)
    expect(ids.indexOf('appearance/interface')).toBe(ids.indexOf('general/terminal') + 1)
    expect(ids.at(-1)).toBe('spaces')
  })
})

describe('the settings view', () => {
  beforeEach(() => {
    resetFake()
    fakeState.snapshot.repos = []
    fakeState.snapshot.repoSettings = {}
    fakeState.snapshot.platform = 'win32'
    fakeState.snapshot.settings.agentPrefs = {}
    fakeState.snapshot.settings.sound = 'chime'
    vi.mocked(openSettingsPage).mockClear()
  })
  afterEach(cleanup)

  it('an entry opens only its own part, under a heading and a breadcrumb that name it', () => {
    render(<SettingsView page={{ section: 'general', part: 'chat' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Chat' })).toBeTruthy()
    // The part's own title gives way to the page heading.
    expect(screen.queryByRole('heading', { level: 2, name: 'Chat' })).toBeNull()
    expect(document.getElementById('setting-message-send-key')).toBeTruthy()
    // Other parts of General are not drawn.
    expect(document.getElementById('setting-language')).toBeNull()
    expect(document.getElementById('setting-notifications')).toBeNull()
    const crumbs = screen.getByRole('navigation', { name: 'Where you are in Settings' })
    expect(crumbs.textContent).toBe('SettingsGeneralChat')
    expect(within(crumbs).getByText('Chat').getAttribute('aria-current')).toBe('page')
  })

  it('Previous and Next open the pages either side', async () => {
    const user = userEvent.setup()
    render(<SettingsView page={{ section: 'general', part: 'chat' }} />)
    const pager = screen.getByRole('navigation', { name: 'Settings pages' })
    await user.click(within(pager).getByRole('button', { name: 'Previous Language' }))
    expect(openSettingsPage).toHaveBeenLastCalledWith({ section: 'general', part: 'language' })
    await user.click(within(pager).getByRole('button', { name: 'Next Assistant' }))
    expect(openSettingsPage).toHaveBeenLastCalledWith({ section: 'general', part: 'assistant' })
  })

  it('a link to a row opens its page and lights the row', async () => {
    render(<SettingsView page={{ section: 'general', scrollTo: 'tray-icon' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy()
    const row = document.getElementById('setting-tray-icon')!
    expect(row).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-ui-flash]')).toBeTruthy())
    expect(row.contains(document.querySelector('[data-ui-flash]'))).toBe(true)
  })

  it('a tall section that is the page lights the page heading, as its title', () => {
    render(<SettingsView page={{ section: 'usage', scrollTo: 'usage-report' }} />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Cost and turns' })
    const section = document.getElementById('setting-usage-report')!
    expect(settingFlashParts(section)[0]).toBe(heading)
  })

  it('search fills the page with results grouped by category, counted in the menu; ↓ and Enter open one', async () => {
    const user = userEvent.setup()
    render(<SettingsView page={{ section: 'general' }} />)
    const box = screen.getByRole('textbox', { name: 'Search settings' })
    await user.type(box, 'tray icon')
    const results = screen.getByRole('region', { name: 'Matching settings' })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/match(es)? “tray icon”/)
    const general = within(results).getByRole('region', { name: 'General' })
    const row = within(general).getByRole('button', { name: /Tray icon/ })
    // Where it lives, and its current value.
    expect(row.textContent).toContain('Notifications')
    expect(within(row).getByText(/^(On|Off)$/)).toBeTruthy()
    // The menu counts the matches in each category.
    expect(within(screen.getByRole('tree', { name: 'Settings' })).getByRole('treeitem', { name: /^General/ }).textContent).toMatch(/found/)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.matches('button.set-result-main')).toBe(true)
    const focused = document.activeElement as HTMLElement
    await user.keyboard('{Enter}')
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    const target = vi.mocked(openSettingsPage).mock.calls[0][0] as SettingsPage
    expect(target.scrollTo ?? target.part).toBeTruthy()
    expect(focused.textContent).toBeTruthy()
    expect((box as HTMLInputElement).value).toBe('')
  })

  it('↑ from the first result goes back to the box, and Escape there clears it', async () => {
    const user = userEvent.setup()
    render(<SettingsView page={{ section: 'general' }} />)
    const box = screen.getByRole('textbox', { name: 'Search settings' }) as HTMLInputElement
    await user.type(box, 'theme')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(box)
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe('')
    expect(screen.queryByRole('region', { name: 'Matching settings' })).toBeNull()
  })

  it('an agent that is not signed in can be fixed from its result', async () => {
    fakeApi.agentStatus = vi.fn(async (agent: string) => ({ agent, installed: true, ready: false }))
    const user = userEvent.setup()
    render(<SettingsView page={{ section: 'general' }} />)
    await user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'claude code')
    const results = screen.getByRole('region', { name: 'Matching settings' })
    const fix = await within(results).findAllByRole('button', { name: 'Sign in' })
    await act(async () => fix[0].click())
    expect(openSettingsPage).toHaveBeenCalledWith({ section: 'agents', agent: 'claude', part: 'signin' })
  })
})
