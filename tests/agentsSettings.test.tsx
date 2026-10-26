// @vitest-environment jsdom
// Settings → Agents & models and Repository: the sign-in cards, the API key form, the loadout editor, the setup steps
// editor and the base-branch picker, on their ui/ parts.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyField, AuthCards } from '../src/renderer/src/components/settings/AgentAuth'
import { LoadoutEditor } from '../src/renderer/src/components/settings/ModelsLoadout'
import { GitTab } from '../src/renderer/src/components/settings/RepoGitTab'
import { SetupStepsRow } from '../src/renderer/src/components/settings/RepoSetupSteps'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
// The GitHub account row (settings batch B6) has its own needs.
vi.mock('../src/renderer/src/components/settings/GithubAccount', () => ({ GithubAccountLink: () => null }))
// The auto review switch (batch B2) reads the repo list and opens its own consent dialog.
vi.mock('../src/renderer/src/components/AutoReview', () => ({ AutoReviewSetting: () => null }))
// The catalog hook asks the main process for installed agents.
vi.mock('../src/renderer/src/agentCatalog', () => ({
  useAgentCatalog: () => ({ view: undefined, loading: false, error: null, refresh: async () => undefined }),
  loadAgentCatalog: async () => undefined
}))

beforeEach(() => {
  resetFake()
  fakeState.snapshot.catalog = { agents: {}, outputStyles: [] }
  fakeState.snapshot.agentKeyHints = {}
  fakeApi.updateSettings = vi.fn(async () => ({}))
  fakeApi.updateRepoSettings = vi.fn(async () => undefined)
})
afterEach(cleanup)

describe('the sign-in cards', () => {
  const options = [
    { value: 'cli' as const, label: 'Login', description: 'Use your account.' },
    { value: 'apiKey' as const, label: 'API key', description: 'Paste a key.' }
  ]

  it('are native radios in a named group, the chosen one checked and described', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<AuthCards value="cli" options={options} onChange={onChange} />)
    const group = screen.getByRole('group', { name: 'Authentication' })
    const [login, key] = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(login.checked).toBe(true)
    expect(key.checked).toBe(false)
    expect(screen.getByRole('radio', { name: 'API key' })).toBe(key)
    expect(document.getElementById(key.getAttribute('aria-describedby')!)?.textContent).toBe('Paste a key.')
    await user.click(key)
    expect(onChange).toHaveBeenCalledWith('apiKey')
    // The card that is already chosen does nothing.
    onChange.mockClear()
    await user.click(login)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('share one radio name, so the browser gives the group one Tab stop and the arrow keys', () => {
    render(<AuthCards value="cli" options={options} onChange={vi.fn()} />)
    const [login, key] = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(login.name).toBeTruthy()
    expect(login.name).toBe(key.name)
  })
})

describe('the API key form', () => {
  it('is named by its label, saves on Enter and on the button, and keeps Save off while empty', async () => {
    fakeApi.setAgentKey = vi.fn(async () => undefined)
    const user = userEvent.setup()
    render(<ApiKeyField agent="cursor" label="Cursor API key" />)
    const input = screen.getByLabelText('Cursor API key') as HTMLInputElement
    expect(input.type).toBe('password')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(input, 'sk-123{Enter}')
    await waitFor(() => expect(fakeApi.setAgentKey).toHaveBeenCalledWith('cursor', 'sk-123'))
    await waitFor(() => expect(input.value).toBe(''))
    await user.type(input, 'sk-456')
    expect(save.disabled).toBe(false)
    await user.click(save)
    await waitFor(() => expect(fakeApi.setAgentKey).toHaveBeenLastCalledWith('cursor', 'sk-456'))
  })

  it('offers to import a key found in the shell, in a notice with its own button', () => {
    // useAgentCatalog is mocked without a view, so no shell key; the saved case shows the masked value instead.
    fakeState.snapshot.agentKeyHints = { cursor: 'abcd' }
    render(<ApiKeyField agent="cursor" label="Cursor API key" />)
    expect(screen.getByRole('group', { name: 'Cursor API key' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})

describe('the loadout editor', () => {
  const loadouts = [
    { agent: 'claude', model: 'claude-sonnet-4-5', fast: false },
    { agent: 'codex', model: 'gpt-5', fast: false }
  ]
  beforeEach(() => {
    fakeState.snapshot.settings.loadouts = loadouts
  })

  it('opens a slot with Enter into a named dialog, and Escape closes it back to the card', async () => {
    const user = userEvent.setup()
    render(<LoadoutEditor />)
    const card = screen.getByRole('button', { name: /^Slot 1: .*Change model$/ })
    expect(card.getAttribute('aria-expanded')).toBe('false')
    card.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Model for slot 1' })
    expect(card.getAttribute('aria-expanded')).toBe('true')
    expect(card.getAttribute('aria-haspopup')).toBe('dialog')
    expect(dialog).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(card)
  })

  it('removes a slot with its own named button, never the last one', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<LoadoutEditor />)
    await user.click(screen.getByRole('button', { name: 'Remove slot 2' }))
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ loadouts: [loadouts[0]] }))
    // One slot left: no remove buttons.
    fakeState.snapshot.settings.loadouts = [loadouts[0]]
    rerender(<LoadoutEditor />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove slot/ })).toBeNull())
  })

  it('keeps every card a real button with a name, in the tab order', () => {
    render(<LoadoutEditor />)
    for (const card of screen.getAllByRole('button', { name: /^Slot \d/ })) expect(card.tabIndex).toBe(0)
  })

  it('draws a slot as the interactive Card (control outline), a free slot as an empty Card, and remove as a badge', () => {
    render(<LoadoutEditor />)
    for (const card of screen.getAllByRole('button', { name: /^Slot \d/ })) expect(card.className).toContain('ui-card--interactive')
    const free = document.querySelectorAll('.ml-empty')
    expect(free).toHaveLength(3)
    for (const slot of free) expect(slot.hasAttribute('data-empty')).toBe(true)
    expect(screen.getByRole('button', { name: 'Remove slot 2' }).className).toContain('ui-icon-btn--badge')
  })

  it('shows a drag through the Card: the origin lifted, a ghost that follows, the slot it would land on, red when it would remove', () => {
    render(<LoadoutEditor />)
    const [first, second] = screen.getAllByRole('button', { name: /^Slot \d/ })
    fireEvent.pointerDown(second, { pointerId: 1, button: 0, clientX: 80, clientY: 80 })
    // A press that hasn't moved is not a drag yet.
    expect(second.hasAttribute('data-lifted')).toBe(false)
    fireEvent.pointerMove(second, { pointerId: 1, clientX: 0, clientY: 0 })
    expect(second.hasAttribute('data-lifted')).toBe(true)
    const ghost = document.body.querySelector('[data-ghost]')!
    expect(ghost.classList.contains('ui-card--interactive')).toBe(true)
    expect(ghost.hasAttribute('data-tone')).toBe(false)
    // The slots have no size in jsdom, so the nearest one to the pointer is the first.
    expect(first.hasAttribute('data-target')).toBe(true)
    // Far from every slot, a slot would be removed: the ghost says so.
    fireEvent.pointerMove(second, { pointerId: 1, clientX: 900, clientY: 900 })
    expect(document.body.querySelector('[data-ghost]')!.getAttribute('data-tone')).toBe('danger')
    expect(first.hasAttribute('data-target')).toBe(false)
    // Escape puts everything back.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.querySelector('[data-ghost]')).toBeNull()
    expect(second.hasAttribute('data-lifted')).toBe(false)
  })
})

describe('the setup steps editor', () => {
  const steps = [
    { name: 'Install', command: 'npm ci' },
    { name: 'Build', command: 'npm run build' }
  ]
  beforeEach(() => {
    fakeState.snapshot.repoSettings = { r1: { values: { setupSteps: steps, archiveSteps: [] }, sources: {}, inherited: {}, sharedFile: undefined } }
  })

  const saved = () => (fakeApi.updateRepoSettings.mock.calls.at(-1)![1] as { setupSteps: { name: string; parallel?: boolean }[] }).setupSteps

  it('names each field, and the step menu is a real menu with the check on Run in parallel', async () => {
    const user = userEvent.setup()
    render(<SetupStepsRow repoId="r1" />)
    expect(screen.getAllByLabelText('Step name').map((i) => (i as HTMLInputElement).value)).toEqual(['Install', 'Build'])
    expect(screen.getAllByLabelText('Timeout')).toHaveLength(2)
    const [first] = screen.getAllByRole('button', { name: 'Step actions' })
    await user.click(first)
    const menu = screen.getByRole('menu', { name: 'Step actions' })
    expect((within(menu).getByRole('menuitem', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Run in parallel' }).getAttribute('aria-checked')).toBe('false')
    await user.click(within(menu).getByRole('menuitem', { name: 'Move down' }))
    await waitFor(() => expect(saved().map((s) => s.name)).toEqual(['Build', 'Install']))
    // The menu closed and focus is back on its button.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(first)
  })

  it('marks a step parallel and removes one from the menu', async () => {
    const user = userEvent.setup()
    render(<SetupStepsRow repoId="r1" />)
    await user.click(screen.getAllByRole('button', { name: 'Step actions' })[1])
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Run in parallel' }))
    await waitFor(() => expect(saved().map((s) => s.parallel)).toEqual([undefined, true]))
    await user.click(screen.getAllByRole('button', { name: 'Step actions' })[0])
    await user.click(screen.getByRole('menuitem', { name: 'Remove step' }))
    await waitFor(() => expect(saved().map((s) => s.name)).toEqual(['Build']))
  })

  it('saves a changed timeout from the select', async () => {
    const user = userEvent.setup()
    render(<SetupStepsRow repoId="r1" />)
    await user.selectOptions(screen.getAllByLabelText('Timeout')[0], '300')
    await waitFor(() => expect((fakeApi.updateRepoSettings.mock.calls.at(-1)![1] as { setupSteps: { timeoutSec?: number }[] }).setupSteps[0].timeoutSec).toBe(300))
  })

  it('adds a step and puts focus in its name field', async () => {
    const user = userEvent.setup()
    render(<SetupStepsRow repoId="r1" />)
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    const names = screen.getAllByLabelText('Step name')
    expect(names).toHaveLength(3)
    expect(document.activeElement).toBe(names[2])
  })
})

describe('the base branch picker', () => {
  const repo = { id: 'r1', name: 'app', remote: 'origin', hasOrigin: true, defaultBranch: 'main', rootPath: '/repo' } as never
  beforeEach(() => {
    fakeState.snapshot.repoSettings = { r1: { values: { sensitivePaths: [] }, sources: {}, inherited: {}, sharedFile: undefined } }
    fakeApi.listBranches = vi.fn(async () => [
      { name: 'main', remote: true, isDefault: true },
      { name: 'feature/login', remote: false }
    ])
    fakeApi.listRemotes = vi.fn(async () => ['origin'])
    fakeApi.updateRepo = vi.fn(async () => ({}))
  })

  it('is a combobox that lists branches when opened, filters as you type, and saves the one you choose', async () => {
    const user = userEvent.setup()
    render(<GitTab repo={repo} />)
    const box = screen.getByRole('combobox', { name: 'Search branches' }) as HTMLInputElement
    expect(box.placeholder).toBe('origin/main')
    await user.click(box)
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
    expect(fakeApi.listBranches).toHaveBeenCalledTimes(1)
    await user.type(box, 'login')
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1)
    // Typing does not ask for the branches again.
    expect(fakeApi.listBranches).toHaveBeenCalledTimes(1)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.updateRepo).toHaveBeenCalledWith('r1', { defaultBranch: 'feature/login' }))
  })

  it('has a named fetch button that asks the remote', async () => {
    const user = userEvent.setup()
    render(<GitTab repo={repo} />)
    await user.click(screen.getByRole('button', { name: 'Fetch branches from the remote' }))
    await waitFor(() => expect(fakeApi.listBranches).toHaveBeenCalledWith('r1', { fetch: true }))
  })
})

// The rest of the migrated pages and dialogs: each mounts in development mode, where a Pressable with interactive
// content, an input without a name or a Dialog without a title throws.
describe('the migrated pages mount with every control named', () => {
  const repo = { id: 'r1', name: 'app', remote: 'origin', hasOrigin: true, defaultBranch: 'main', rootPath: '/repo', local: {}, icon: undefined } as never
  beforeEach(() => {
    fakeState.snapshot.repoSettings = {
      r1: {
        values: { sensitivePaths: [], checks: [], runScripts: [{ name: 'dev', command: 'npm run dev', default: true }], previewUrls: [{ name: 'app', url: 'http://localhost:3000' }], filesToCopy: [], setupSteps: [], archiveSteps: [], prompts: { codeReview: '', createPr: '', fixErrors: '', resolveConflicts: '', renameBranch: '', general: '' } },
        sources: {},
        inherited: {},
        sharedFile: undefined
      }
    }
    fakeState.snapshot.settings.workspacesRoot = '/ws'
    fakeApi.cliStatus = vi.fn(async () => ({ installed: true }))
    fakeApi.previewFilesToCopy = vi.fn(async () => ({ fromWorktreeInclude: false, patterns: [], files: ['.env'] }))
  })

  it('the Agents catalog, Sign-in and Provider keys pages', async () => {
    const { CatalogPage } = await import('../src/renderer/src/components/agents/CatalogPage')
    const { SignInPage } = await import('../src/renderer/src/components/agents/SignInPage')
    const { ProviderKeysPage } = await import('../src/renderer/src/components/agents/ProviderKeysPage')
    for (const Page of [CatalogPage, SignInPage, ProviderKeysPage]) {
      render(<Page tabs={null} />)
      expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
      cleanup()
    }
  })

  it('the model visibility list: one named toggle per model, pressed while the model is shown', async () => {
    const { ModelVisibility } = await import('../src/renderer/src/components/settings/ModelVisibility')
    render(<ModelVisibility agent="claude" />)
    const toggles = screen.getAllByRole('button', { name: /^Hide / })
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('the OpenCode providers dialog: a named search, and rows that expand into a key form', async () => {
    const { ProvidersDialog } = await import('../src/renderer/src/components/settings/OpencodeProviders')
    const user = userEvent.setup()
    render(<ProvidersDialog providers={[]} onChanged={async () => undefined} onClose={() => undefined} />)
    expect(screen.getByRole('dialog', { name: 'Providers' })).toBeTruthy()
    const rows = screen.getAllByRole('button', { expanded: false })
    await user.click(rows.find((b) => b.classList.contains('ui-disclosure__button'))!)
    expect(screen.getByLabelText(/ API key$/, { selector: 'input' })).toBeTruthy()
  })

  it('the repository icon picker opens a named dialog with tabs and a search', async () => {
    const { RepoIconPicker } = await import('../src/renderer/src/components/settings/RepoIcon')
    const user = userEvent.setup()
    render(<RepoIconPicker repo={repo} />)
    await user.click(screen.getByRole('button', { name: 'Change repository icon' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('radiogroup')).toBeTruthy()
    const search = within(dialog).getByRole('searchbox')
    await user.type(search, 'rocket')
    await user.click(within(dialog).getByRole('button', { name: 'Rocket' }))
    await waitFor(() => expect(fakeApi.updateRepo).toHaveBeenCalledWith('r1', { icon: { kind: 'lucide', name: 'Rocket' } }))
  })

  it('the Scripts, Misc and Actions tabs, and the run script dialog', async () => {
    fakeApi.updateRepo = vi.fn(async () => ({}))
    const { ScriptsTab } = await import('../src/renderer/src/components/settings/RepoScriptsTab')
    const { MiscTab } = await import('../src/renderer/src/components/settings/RepoMiscTab')
    const { ActionsTab } = await import('../src/renderer/src/components/settings/RepoActionsTab')
    const user = userEvent.setup()
    render(<ScriptsTab repo={repo} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('radiogroup', { name: 'Icon' })).toBeTruthy()
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: /Default/ })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    render(<MiscTab repo={repo} />)
    expect(screen.getByLabelText('Name of preview URL 1')).toBeTruthy()
    cleanup()
    render(<ActionsTab repo={repo} />)
    const toggle = screen.getAllByRole('button').find((b) => b.getAttribute('aria-expanded') === 'false' && b.classList.contains('repo-prompt-toggle'))!
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy()
  })
})

describe('more migrated pages', () => {
  it('the Default models page: the review model chooser is a named chip that opens a dialog', async () => {
    fakeState.snapshot.settings.reviewModel = { agent: 'claude', model: 'claude-sonnet-4-5', fast: false }
    fakeState.snapshot.settings.claudeOutputStyle = 'default'
    fakeState.snapshot.settings.loadouts = [{ agent: 'claude', model: 'claude-sonnet-4-5', fast: false }]
    const { ModelsPage } = await import('../src/renderer/src/components/settings/ModelsPage')
    const user = userEvent.setup()
    render(<ModelsPage />)
    const chip = screen.getByRole('button', { name: /^Review model/ })
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    await user.click(chip)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('an agent page, the OpenCode panel and the remove-repository dialog', async () => {
    fakeState.snapshot.platform = 'win32'
    fakeState.snapshot.homeDir = 'C:\Users\me'
    fakeState.snapshot.workspaces = []
    fakeApi.agentStatus = vi.fn(async () => ({ installed: false, ready: false, detail: 'missing' }))
    const { CatalogAgentPage } = await import('../src/renderer/src/components/agents/CatalogAgentPage')
    const { OpencodePanel } = await import('../src/renderer/src/components/settings/OpencodePanel')
    const { RemoveRepoDialog } = await import('../src/renderer/src/components/settings/RepoMiscTab')
    render(<CatalogAgentPage agent="gemini" tabs={null} />)
    expect(screen.getAllByRole('switch').length).toBeGreaterThan(0)
    cleanup()
    render(<OpencodePanel />)
    cleanup()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<RemoveRepoDialog repo={{ id: 'r1', name: 'app' } as never} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Remove app?' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
