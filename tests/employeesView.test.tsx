// @vitest-environment jsdom
// AI employees in the window (docs/ai-employees.md §5.3, §10): the sidebar's Team section only for an organization with
// a memory repository while AI employees are on; the New employee page's Save as is and Generate → draft → suggestions
// off → Create and approve with a mocked API; Generate kept off under Privacy mode and a failed draft keeping the
// person's words; and the approval plan's content.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEmployee, type EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import { TeamSection } from '../src/renderer/src/components/employees/TeamSection'
import { NewEmployeePage } from '../src/renderer/src/components/employees/NewEmployeePage'
import { ApproveDialog } from '../src/renderer/src/components/employees/ApproveDialog'
import { TeamPage } from '../src/renderer/src/components/employees/TeamPage'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const org = (id: string, name: string, memoryRepoId?: string): Organization => ({ id, name, ...(memoryRepoId ? { memoryRepoId } : {}), createdAt: '2026-11-05T00:00:00.000Z' })
const summary = (id: string, name: string, patch: Partial<EmployeeSummary> = {}): EmployeeSummary => ({
  id,
  path: `bots/${id}.toml`,
  name,
  role: 'Marketing',
  colour: 'pink',
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  responsibilities: ['Write launch posts', 'Draft the changelog email', 'Answer questions'],
  problems: [],
  state: 'draft',
  changed: false,
  ...patch
})

const INSTRUCTIONS = '## Role\nMarketing.\n\n## What you do\nPosts.\n\n## How you write\nShort.\n\n## What you never do\nPublish.\n\n## How you finish\nA summary.'

function setSnapshot({ organizations = [org('o1', 'Foreman', 'mem')], employees = [] as EmployeeSummary[], privacyMode = false } = {}) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'foreman-memory', rootPath: 'C:\\code\\foreman-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'foreman-website', rootPath: 'C:\\code\\foreman-website', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'app', name: 'foreman', rootPath: 'C:\\code\\foreman', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'blog', name: 'blog', rootPath: 'C:\\code\\blog', defaultBranch: 'main' }
    ],
    organizations,
    workspaces: [],
    employees: { o1: { head: 'h1', employees } },
    settings: { ...original.settings, privacyMode, loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5', fast: false }] }
  }
}

const data = () => ({ employees: [], error: '', reload: vi.fn() })

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'openMemory']) spy(name).mockReset()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
  fakeApi.createEmployee = vi.fn(async (_org: string, definition: { id: string; name: string }) => ({ ...summary(definition.id, definition.name), blob: 'b1', text: '' }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('the Team section', () => {
  it('is absent in Personal, and for an organization without a memory repository', () => {
    setSnapshot({ employees: [summary('e-1abc', 'Ada')] })
    fakeState.space = null
    const second = render(<TeamSection />)
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull()
    second.unmount()
    setSnapshot({ organizations: [org('o1', 'Foreman')] })
    fakeState.space = 'o1'
    render(<TeamSection />)
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull()
  })

  it('lists each employee with its hat, name, role and state in words, opens its page, and adds one with +', async () => {
    const user = userEvent.setup()
    setSnapshot({
      employees: [
        summary('e-1abc', 'Ada', { role: 'Developer', state: 'active' }),
        summary('e-2abc', 'Max'),
        summary('e-3abc', 'Pat', { state: 'paused' }),
        summary('e-4abc', 'Sam', { state: 'active', changed: true }),
        summary('e-5abc', 'Old', { state: 'retired' })
      ]
    })
    render(<TeamSection />)
    expect(screen.getByRole('heading', { name: 'Team' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Employees of Foreman' })
    const rows = within(list).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual(['AdaDeveloperIdle', 'MaxMarketingDraft', 'PatMarketingPaused', 'SamMarketingChanged since approval'])
    // The hat is drawn beside the name, so it is hidden from assistive tech.
    expect(list.querySelector('svg.ui-hard-hat')?.getAttribute('aria-hidden')).toBe('true')
    await user.click(rows[1])
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-2abc' })
    await user.click(screen.getByRole('button', { name: 'New employee in Foreman' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'new' })
    await user.click(screen.getByRole('button', { name: 'Team' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
  })
})

describe('the Team page', () => {
  it('shows a card per employee with its model as text, its state, two responsibilities and the actions its state allows', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-1abc', 'Ada', { state: 'active' }), summary('e-2abc', 'Max')] })
    fakeApi.pauseEmployee = vi.fn(async () => undefined)
    render(<TeamPage orgId="o1" data={data()} />)
    const cards = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('Marketing · Claude Code · ')
    expect(cards[0].textContent).toContain('Idle')
    expect(within(cards[0]).getByRole('list', { name: 'Responsibilities of Ada' }).textContent).toBe('Write launch postsDraft the changelog email…and 1 more')
    expect(within(cards[1]).getByText('Draft')).toBeTruthy()
    expect(within(cards[1]).getByRole('button', { name: 'Approve…' })).toBeTruthy()
    expect(within(cards[0]).queryByRole('button', { name: 'Approve…' })).toBeNull()
    await user.click(within(cards[0]).getByRole('button', { name: 'Pause' }))
    expect(fakeApi.pauseEmployee).toHaveBeenCalledWith('o1', 'e-1abc')
    await user.click(within(cards[1]).getByRole('button', { name: 'Edit' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-2abc', edit: true })
  })
})

describe('the New employee page', () => {
  it('Save as is keeps the person’s words as the instructions, at the safest settings, and creates a draft', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-1abc', 'Ada')] })
    const d = data()
    render(<NewEmployeePage orgId="o1" data={d} />)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'Writes the release notes.')
    await user.click(screen.getByRole('button', { name: 'Concise' }))
    expect(screen.getByRole('button', { name: 'Concise' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Save as is' }))
    expect(fakeApi.generateEmployeeDraft).toBeUndefined()
    const name = screen.getByRole('textbox', { name: 'Name' })
    expect((name as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Give the employee a name.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
    expect((screen.getByRole('textbox', { name: 'Personality' }) as HTMLInputElement).value).toBe('Concise')
    // What it can do starts at the safest settings.
    expect(screen.getByText('Reads foreman-website, foreman.')).toBeTruthy()
    expect(screen.getByText('No shell: Foreman’s own tools only.')).toBeTruthy()
    expect(screen.getByText('Messages to other people and every other outward action wait for you.')).toBeTruthy()
    expect(screen.getByText('Runs only when asked.')).toBeTruthy()
    await user.type(name, 'Ada')
    expect(screen.getByText('Another employee in this organization has this name.')).toBeTruthy()
    await user.clear(name)
    await user.type(name, 'Rae')
    expect(screen.getByText(/^Saves bots\/e-[a-z0-9]{4}\.toml in foreman-memory\.$/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    const [orgId, definition, options] = fakeApi.createEmployee.mock.calls[0]
    expect(orgId).toBe('o1')
    expect(options).toEqual({ approve: false })
    expect(definition).toMatchObject({ name: 'Rae', instructions: 'Writes the release notes.', personality: 'Concise', attendance: 'unattended', model: { agent: 'claude', model: 'claude-sonnet-5-5' } })
    expect(definition.access).toEqual(defaultEmployee({ id: definition.id, colour: 'orange', repos: ['foreman-website', 'foreman'], loadouts: [] }).access)
    // Ada wears pink, so the first free hat is orange.
    expect(definition.look).toEqual({ family: 'hardhat', colour: 'orange' })
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
    expect(d.reload).toHaveBeenCalled()
  })

  it('Generate drafts the words; suggestions start off; Create and approve shows the plan, then creates it approved', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.generateEmployeeDraft = vi.fn(async () => ({
      text: { name: 'Max', role: 'Marketing', description: 'Launch posts.', personality: 'Casual.', responsibilities: ['Write launch posts'], ask_me_about: 'Releases', instructions: INSTRUCTIONS },
      colour: 'teal',
      suggested: [
        { kind: 'repo-write', detail: 'foreman-website', reason: 'It edits the changelog page.' },
        { kind: 'schedule', detail: 'Mondays at 9', reason: 'A weekly update.' },
        { kind: 'event', detail: 'a pull request merges in foreman', reason: 'Release notes follow merges.' }
      ],
      agent: 'claude',
      model: 'claude-sonnet-5-5'
    }))
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'A marketing person.')
    await user.click(screen.getByRole('button', { name: 'Casual' }))
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
    expect(fakeApi.generateEmployeeDraft).toHaveBeenCalledWith('o1', { description: 'A marketing person.', traits: ['casual'] })
    expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe('Max')
    expect(screen.getByText(/^Drafted by Claude Code · /)).toBeTruthy()
    expect(screen.getByText('Hat: Teal')).toBeTruthy()
    const write = screen.getByRole('switch', { name: 'Write to foreman-website' })
    expect(write.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'A schedule: Mondays at 9' })).toHaveProperty('disabled', true)
    // An event, as a schedule: a trigger to add in Edit once created, never granted from the draft.
    expect(screen.getByRole('switch', { name: 'Start on: a pull request merges in foreman' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Add it as an event trigger in Edit once it is created: a trigger is part of what you approve.')).toBeTruthy()
    expect(screen.getByText('The AI drafts; it never grants.')).toBeTruthy()
    expect(screen.getByText('Reads foreman-website, foreman.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Create and approve…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve Max on this computer' })
    expect(within(dialog).getByText('What this approval does not cover')).toBeTruthy()
    expect(dialog.textContent).toMatch(/foreman-website\s*Read/)
    expect(dialog.textContent).toContain('None: it runs only when asked.')
    expect(dialog.textContent).toMatch(/Only the memory repository foreman-memory: bots\/e-[a-z0-9]{4}\.toml and memory\/bots\/e-[a-z0-9]{4}\/\. Nothing in your code repositories\./)
    await user.click(within(dialog).getByRole('button', { name: 'Create and approve' }))
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    const [, definition, options] = fakeApi.createEmployee.mock.calls[0]
    expect(options).toEqual({ approve: true })
    expect(definition).toMatchObject({ name: 'Max', instructions: INSTRUCTIONS, look: { family: 'hardhat', colour: 'teal' } })
    // The suggestion was never turned on, so nothing was granted.
    expect(definition.access.repos).toEqual({ 'foreman-website': 'read', foreman: 'read' })
    expect(definition.access.profile).toBe('no-shell')
  })

  it('turning a suggestion on is the person’s grant, and says so', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.generateEmployeeDraft = vi.fn(async () => ({
      text: { name: 'Max', role: 'Marketing', description: 'd', personality: 'p', responsibilities: ['r'], ask_me_about: 'a', instructions: INSTRUCTIONS },
      colour: 'teal',
      suggested: [{ kind: 'repo-write', detail: 'foreman-website', reason: 'It edits the changelog page.' }],
      agent: 'claude',
      model: ''
    }))
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'A marketing person.')
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
    await user.click(await screen.findByRole('switch', { name: 'Write to foreman-website' }))
    expect(screen.getByText('You turned this on')).toBeTruthy()
    expect(screen.getByText('Writes to foreman-website, in its own branch.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    expect(fakeApi.createEmployee.mock.calls[0][1].access.repos).toEqual({ 'foreman-website': 'write', foreman: 'read' })
  })

  it('keeps Generate off under Privacy mode, saying why, while Save as is still works', async () => {
    const user = userEvent.setup()
    setSnapshot({ privacyMode: true })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'Writes notes.')
    expect(screen.getByRole('button', { name: 'Generate with AI' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Privacy mode is on, so nothing leaves this computer: only Save as is is available.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save as is' })).toHaveProperty('disabled', false)
  })

  it('says why a draft failed and keeps the person’s words', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.generateEmployeeDraft = vi.fn(async () => {
      throw new Error('The draft didn’t come back as expected: The answer wasn’t a JSON object. Try again, or use Save as is.')
    })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    const box = screen.getByRole('textbox', { name: 'Describe your employee' })
    await user.type(box, 'A marketing person.')
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The employee couldn’t be drafted')
    expect(alert.textContent).toContain('Try again, or use Save as is.')
    expect((screen.getByRole('textbox', { name: 'Describe your employee' }) as HTMLTextAreaElement).value).toBe('A marketing person.')
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
  })
})

describe('the approval plan', () => {
  it('shows the model, repositories and access, the profile, actions and whether held, limits, what Foreman writes and what it doesn’t cover', async () => {
    const user = userEvent.setup()
    setSnapshot()
    const definition = {
      ...defaultEmployee({ id: 'e-7k2m', colour: 'orange', repos: ['foreman', 'foreman-website'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max', role: 'Marketing' } }),
      access: { ...defaultEmployee({ id: 'e-7k2m', colour: 'orange', repos: [], loadouts: [] }).access, repos: { foreman: 'read' as const, 'foreman-website': 'write' as const }, delegate_to: ['e-1abc'] },
      limits: { runs_per_day: 6, minutes_per_run: 30, cost_per_day_usd: 5 }
    }
    definition.model.fallbacks = ['claude-haiku-5-5']
    definition.access.actions['push'] = 'allowed'
    const onConfirm = vi.fn(async () => undefined)
    render(<ApproveDialog definition={definition} memory="foreman-memory" names={(id) => (id === 'e-1abc' ? 'Ada' : id)} onConfirm={onConfirm} onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog', { name: 'Approve Max on this computer' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('Fallbacks, not used yet: claude-haiku-5-5')
    expect(text).toContain('Runs with nobody there: any approval it asks for is refused and the run stops.')
    expect(text).toMatch(/foreman\s*Read/)
    expect(text).toMatch(/foreman-website\s*Write/)
    expect(text).toContain('No shell: Foreman’s own tools only.')
    expect(text).toMatch(/Slack messages\s*Held/)
    expect(text).toMatch(/Pushes\s*Allowed/)
    expect(text).toContain('May hand tasks to Ada.')
    expect(text).toContain('None: it runs only when asked.')
    expect(text).toContain('At most 6 runs a day, 30 minutes a run.')
    expect(text).toContain('New work pauses after $5.00 a day.')
    expect(text).toContain('Only the memory repository foreman-memory: bots/e-7k2m.toml and memory/bots/e-7k2m/. Nothing in your code repositories.')
    for (const line of ['A new trigger or schedule.', 'A different agent or model.', 'Any outward action not listed here.', 'Any other change to its definition: it needs approving again.']) expect(text).toContain(line)
    expect(text).toContain('Recorded on this computer only.')
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }))
    expect(onConfirm).toHaveBeenCalled()
  })
})
