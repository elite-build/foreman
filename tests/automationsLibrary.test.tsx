// @vitest-environment jsdom
// The Automations library: template cards that say when they run and how their runs went, the tabs and the search,
// and the side panel's list of every schedule (which replaced the week calendar).
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedCommand } from '../src/shared/savedCommands'
import type { Occurrence, PromptTemplate, Schedule } from '../src/shared/types'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

const template = (id: string, name: string, body: string, extra: Partial<PromptTemplate> = {}): PromptTemplate => ({ id, name, body, ...extra })

function schedule(id: string, templateId: string, over: Partial<Schedule> = {}): Schedule {
  return {
    id,
    templateId,
    templateName: templateId,
    repoId: 'r1',
    baseBranch: 'main',
    recurrence: 'weekly',
    startDate: '2026-11-02',
    weekdays: [1, 2, 3, 4, 5],
    time: '09:00',
    timezone: 'UTC',
    model: 'claude-sonnet-5-5',
    maxMinutes: 30,
    state: 'active',
    nextRunAt: '2026-11-06T09:00:00.000Z',
    consecutiveFailures: 0,
    approved: {} as Schedule['approved'],
    approvedAt: '2026-11-01T00:00:00.000Z',
    ...over
  } as Schedule
}

const run = (id: string, scheduleId: string, state: Occurrence['state']): Occurrence => ({ id, scheduleId, plannedAt: '2026-11-05T09:00:00.000Z', state })

const original = fakeState.snapshot
function setSnapshot(over: { templates?: PromptTemplate[]; repoTemplates?: Record<string, PromptTemplate[]>; schedules?: Schedule[]; occurrences?: Occurrence[]; commands?: SavedCommand[] } = {}) {
  fakeState.snapshot = {
    ...original,
    repos: [{ id: 'r1', name: 'foreman' }],
    workspaces: [],
    repoTemplates: over.repoTemplates ?? {},
    repoCommands: {},
    schedules: over.schedules ?? [],
    occurrences: over.occurrences ?? [],
    settings: { ...original.settings, promptTemplates: over.templates ?? [], savedCommands: over.commands ?? [] }
  }
  fakeState.automations = { selected: null }
  fakeState.selectedWorkspaceId = null
}

beforeEach(() => {
  resetFake()
  for (const name of ['selectAutomation', 'openScheduleDialog', 'closeAutomations']) spy(name).mockClear()
  setSnapshot()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  fakeState.automations = null
})

/** The card whose main button is named `name` (the template's title starts its accessible name). */
const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('.auto-card') as HTMLElement

describe('the Automations library', () => {
  it('shows no calendar: a library with tabs and a search, and the schedules beside it', () => {
    render(<AutomationsView />)
    expect(screen.getByRole('tablist', { name: 'Show' })).toBeTruthy()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Templates', 'Commands'])
    expect(screen.getByRole('searchbox', { name: 'Search templates and commands' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Previous week' })).toBeNull()
    const side = screen.getByRole('complementary', { name: 'Schedules and details' })
    expect(within(side).getByText(/Nothing scheduled yet/)).toBeTruthy()
  })

  it('says on each card when the template runs and how its last run went', () => {
    setSnapshot({
      templates: [template('t1', 'Dependency check', 'Run npm audit'), template('t2', 'Fix a bug', 'Fix {{bug}}'), template('t3', 'Changelog', 'Summarise merged PRs')],
      schedules: [schedule('s1', 't1'), schedule('s3', 't3', { state: 'paused', pausedReason: 'Template changed', nextRunAt: undefined })],
      occurrences: [run('o1', 's1', 'failed'), run('o2', 's1', 'completed')]
    })
    render(<AutomationsView />)
    expect(within(card('Dependency check')).getByText('Weekdays at 09:00')).toBeTruthy()
    expect(within(card('Dependency check')).getByText('Last run: Completed')).toBeTruthy()
    expect(within(card('Fix a bug')).getByText('On demand')).toBeTruthy()
    expect(within(card('Changelog')).getByText('Paused')).toBeTruthy()
  })

  it('shows a run in progress over the last result, and counts several schedules', () => {
    setSnapshot({
      templates: [template('t1', 'Nightly', 'Run the e2e suite')],
      schedules: [schedule('s1', 't1'), schedule('s2', 't1', { recurrence: 'daily', time: '02:00', nextRunAt: '2026-11-06T02:00:00.000Z' })],
      occurrences: [run('o1', 's1', 'completed'), run('o2', 's2', 'running')]
    })
    render(<AutomationsView />)
    expect(within(card('Nightly')).getByText(/^2 schedules · Next /)).toBeTruthy()
    expect(within(card('Nightly')).getByText('Running')).toBeTruthy()
  })

  it('groups a repository’s templates under its name, and opens a template from its card', async () => {
    const u = userEvent.setup()
    setSnapshot({ templates: [template('t1', 'Mine', 'x')], repoTemplates: { r1: [template('rt1', 'implement-issue', 'Implement {{issue}}', { source: 'repo', repoId: 'r1', file: '.foreman/templates/implement-issue.md' })] } })
    render(<AutomationsView />)
    expect(screen.getByText('From foreman')).toBeTruthy()
    await u.click(screen.getByRole('button', { name: /^implement-issue/ }))
    expect(spy('selectAutomation')).toHaveBeenCalledWith('t:rt1')
  })

  it('keeps Schedule and Run off for an empty template', () => {
    setSnapshot({ templates: [template('t1', 'Blank', '')] })
    render(<AutomationsView />)
    const blank = card('Blank')
    expect(within(blank).getByText('Empty')).toBeTruthy()
    expect((within(blank).getByRole('button', { name: 'Schedule…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(blank).getByRole('button', { name: 'Run now in a new workspace' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('searches names and prompts across templates and commands, and says when nothing matches', async () => {
    const u = userEvent.setup()
    setSnapshot({
      templates: [template('t1', 'Write tests', 'Cover the error paths'), template('t2', 'Refactor', 'Simplify')],
      commands: [{ id: 'c1', name: 'Lint', command: 'npm run lint', scope: 'all' }]
    })
    render(<AutomationsView />)
    const search = screen.getByRole('searchbox', { name: 'Search templates and commands' })
    await u.type(search, 'error')
    expect(screen.getByRole('button', { name: /^Write tests/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Refactor/ })).toBeNull()
    expect(screen.getByText('Nothing matches “error”.')).toBeTruthy()
    await u.clear(search)
    await u.type(search, 'zzz')
    expect(screen.getAllByText('Nothing matches “zzz”.')).toHaveLength(2)
  })

  it('shows one kind per tab', async () => {
    const u = userEvent.setup()
    setSnapshot({ templates: [template('t1', 'Write tests', 'x')], commands: [{ id: 'c1', name: 'Lint', command: 'npm run lint', scope: 'all' }] })
    render(<AutomationsView />)
    await u.click(screen.getByRole('tab', { name: 'Commands' }))
    expect(screen.queryByRole('button', { name: /^Write tests/ })).toBeNull()
    expect(screen.getByText('npm run lint')).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Templates' }))
    expect(screen.getByRole('button', { name: /^Write tests/ })).toBeTruthy()
    expect(screen.queryByText('npm run lint')).toBeNull()
  })

  it('lists every schedule beside the library, active first, and opens one', async () => {
    const u = userEvent.setup()
    setSnapshot({
      schedules: [
        schedule('s1', 't1', { templateName: 'Weekly changelog', state: 'paused', pausedReason: 'Template changed', nextRunAt: undefined }),
        schedule('s2', 'gone', { templateName: 'Deleted template', recurrence: 'daily', time: '07:30' })
      ]
    })
    render(<AutomationsView />)
    const list = screen.getByRole('list', { name: 'Schedules' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.auto-row-title')?.textContent)).toEqual(['Deleted template', 'Weekly changelog'])
    expect(within(rows[0]).getByText(/^Every day at 07:30 · Next /)).toBeTruthy()
    expect(within(rows[1]).getByText('Weekdays at 09:00 · Template changed')).toBeTruthy()
    await u.click(within(rows[1]).getByRole('button'))
    expect(spy('selectAutomation')).toHaveBeenCalledWith('s:s1')
  })
})

describe('a template’s own page', () => {
  const open = (id: string) => (fakeState.automations = { selected: `t:${id}` })

  it('takes the place of the library and the side panel, with breadcrumbs back', async () => {
    const u = userEvent.setup()
    setSnapshot({ templates: [template('t1', 'Nightly', 'Run the e2e suite')] })
    open('t1')
    render(<AutomationsView />)
    expect(screen.getByRole('heading', { level: 1, name: 'Nightly' })).toBeTruthy()
    // The library stays mounted but hidden, so it isn't in the accessibility tree.
    expect(screen.queryByRole('tablist', { name: 'Show' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Schedules and details' })).toBeNull()
    const crumbs = screen.getByRole('navigation', { name: 'Where you are' })
    expect(within(crumbs).getByText('Nightly').getAttribute('aria-current')).toBe('page')
    await u.click(within(crumbs).getByRole('button', { name: 'Templates' }))
    expect(spy('selectAutomation')).toHaveBeenLastCalledWith(null)
    spy('selectAutomation').mockClear()
    await u.click(screen.getByTitle('Back to the library'))
    expect(spy('selectAutomation')).toHaveBeenLastCalledWith(null)
  })

  it('lists the template’s schedules and its recent runs, newest first, and no one else’s', () => {
    setSnapshot({
      templates: [template('t1', 'Nightly', 'Run the e2e suite'), template('t2', 'Other', 'x')],
      schedules: [schedule('s1', 't1'), schedule('s2', 't2')],
      occurrences: [run('o1', 's1', 'failed'), run('o2', 's2', 'cancelled'), run('o3', 's1', 'completed')]
    })
    open('t1')
    render(<AutomationsView />)
    expect(within(screen.getByRole('list', { name: 'Schedules' })).getAllByRole('listitem')).toHaveLength(1)
    const runs = screen.getByRole('heading', { name: 'Recent runs' }).nextElementSibling as HTMLElement
    expect([...runs.querySelectorAll('.auto-run .auto-row-main > span:first-child')].map((s) => s.textContent)).toEqual(['Completed', 'Failed'])
  })

  it('duplicates a template from its ⋯ menu and opens the copy', async () => {
    const u = userEvent.setup()
    fakeApi.updateSettings = vi.fn(async () => ({}))
    const nightly = template('t1', 'Nightly', 'Run the e2e suite', { startModel: { agent: 'claude', model: 'claude-opus-5-5' } })
    setSnapshot({ templates: [nightly] })
    open('t1')
    render(<AutomationsView />)
    await u.click(screen.getByRole('button', { name: 'More for Nightly' }))
    await u.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    await waitFor(() => expect(spy('selectAutomation')).toHaveBeenCalledWith(expect.stringMatching(/^t:/)))
    const [{ promptTemplates }] = fakeApi.updateSettings.mock.calls[0] as [{ promptTemplates: PromptTemplate[] }]
    expect(promptTemplates).toHaveLength(2)
    const copy = promptTemplates[1]
    expect(copy).toMatchObject({ name: 'Nightly (copy)', body: 'Run the e2e suite', startModel: nightly.startModel })
    expect(copy.id).not.toBe('t1')
    expect(spy('selectAutomation')).toHaveBeenCalledWith(`t:${copy.id}`)
  })

  it('deletes a template from its ⋯ menu and goes back to the library', async () => {
    const u = userEvent.setup()
    fakeApi.updateSettings = vi.fn(async () => ({}))
    setSnapshot({ templates: [template('t1', 'Nightly', 'x'), template('t2', 'Keep', 'y')] })
    open('t1')
    render(<AutomationsView />)
    await u.click(screen.getByRole('button', { name: 'More for Nightly' }))
    await u.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ promptTemplates: [template('t2', 'Keep', 'y')] })
    expect(spy('selectAutomation')).toHaveBeenCalledWith(null)
  })

  it('shows a repository’s template read-only, with no ⋯ menu', () => {
    setSnapshot({ repoTemplates: { r1: [template('rt1', 'implement-issue', 'Implement {{issue}}', { source: 'repo', repoId: 'r1', file: '.foreman/templates/implement-issue.md', rev: 'abcdef123' })] } })
    open('rt1')
    const { container } = render(<AutomationsView />)
    // The hidden library has the same text on its card; look at the page only.
    const page = within(container.querySelector('.auto-page') as HTMLElement)
    expect(page.getByText('Template · from foreman')).toBeTruthy()
    expect(page.getByText('Implement {{issue}}')).toBeTruthy()
    expect(page.queryByRole('textbox')).toBeNull()
    expect(page.queryByRole('button', { name: /^More for/ })).toBeNull()
  })

  it('goes back on Escape, but not while a field has it', async () => {
    const u = userEvent.setup()
    setSnapshot({ templates: [template('t1', 'Nightly', 'Run the e2e suite')] })
    open('t1')
    render(<AutomationsView />)
    await u.click(screen.getByRole('textbox', { name: 'Template name' }))
    await u.keyboard('{Escape}')
    expect(spy('selectAutomation')).not.toHaveBeenCalled()
    ;(document.activeElement as HTMLElement).blur()
    await u.keyboard('{Escape}')
    expect(spy('selectAutomation')).toHaveBeenCalledWith(null)
  })

  it('goes back to the library when the template is deleted elsewhere', () => {
    setSnapshot({ templates: [] })
    open('gone')
    render(<AutomationsView />)
    expect(spy('selectAutomation')).toHaveBeenCalledWith(null)
  })
})
