// @vitest-environment jsdom
// AI employees in the window (docs/ai-employees.md §5.3, §10): the sidebar's Team section only for an organization with
// a memory repository while AI employees are on; the New employee page's Use my words and Generate → draft → suggestions
// off → Create, which saves a draft and opens its page, with a mocked API; Generate kept off under Privacy mode and a
// failed draft keeping the person's words; and the plan a draft's page shows (EmployeeReview) and its Approve button.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEmployee, type EmployeeSummary, type EmployeeView } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import { TeamSection } from '../src/renderer/src/components/employees/TeamSection'
import { NewEmployeePage } from '../src/renderer/src/components/employees/NewEmployeePage'
import { EmployeePage, EmployeeReview } from '../src/renderer/src/components/employees/EmployeePage'
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
// The page opens on Pick a job; Write your own is today's page behind the switch.
const writeYourOwn = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('radio', { name: 'Write your own' }))

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'openMemory', 'toggleTeamOpen']) spy(name).mockReset()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
  fakeApi.createEmployee = vi.fn(async (_org: string, definition: { id: string; name: string }) => ({ ...summary(definition.id, definition.name), blob: 'b1', text: '' }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
  delete fakeState.teamOpen
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
    fakeState.teamOpen = true
    render(<TeamSection />)
    expect(screen.getByRole('region', { name: 'Team' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Employees of Foreman' })
    const rows = within(list).getAllByRole('button')
    // The person first (docs/ai-employees.md §15), with what waits for them here, then the employees.
    expect(rows.map((r) => r.textContent)).toEqual(['YoupersonNothing waiting', 'AdaDeveloperIdle', 'MaxMarketingDraft', 'PatMarketingPaused', 'SamMarketingChanged since approval'])
    // The hat is drawn beside the name, so it is hidden from assistive tech.
    expect(list.querySelector('svg.ui-hard-hat')?.getAttribute('aria-hidden')).toBe('true')
    await user.click(rows[2])
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-2abc' })
    await user.click(screen.getByRole('button', { name: 'New employee in Foreman' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'new' })
    await user.click(screen.getByRole('button', { name: 'Team' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
  })

  it('is one row like Automations: the hats stacked, the needs-you count, and a chevron that shows the employees and is remembered', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-1abc', 'Ada', { state: 'active' }), summary('e-2abc', 'Max', { state: 'active', colour: 'orange' }), summary('e-3abc', 'Old', { state: 'retired' })] })
    const proposal = { id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append' as const, text: '- x', employeeId: 'e-1abc', runId: 'r1', createdAt: '2026-11-13T10:00:00.000Z' }
    fakeState.snapshot = { ...fakeState.snapshot, employeeWork: { o1: { tasks: [], runs: [], last: {}, proposals: [proposal], revision: 1 } } }
    fakeState.teamOpen = false
    const { rerender } = render(<TeamSection />)
    // The row: Team, two hats (the retired one is on the Team page only) and ▲1 for Ada's proposal.
    const row = screen.getByRole('button', { name: 'Team · 1 needs you' })
    expect(row.querySelectorAll('.team-entry-hats svg.ui-hard-hat')).toHaveLength(2)
    expect(row.querySelector('.team-entry-count [data-glyph="warn"]')).not.toBeNull()
    // The employees are folded away until the chevron shows them; its state is the store's, kept for next time.
    const fold = screen.getByRole('button', { name: 'Employees' })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list', { name: 'Employees of Foreman' })).toBeNull()
    await user.click(fold)
    expect(spy('toggleTeamOpen')).toHaveBeenCalled()
    fakeState.teamOpen = true
    rerender(<TeamSection />)
    expect(screen.getByRole('button', { name: 'Employees' }).getAttribute('aria-expanded')).toBe('true')
    const ada = within(screen.getByRole('list', { name: 'Employees of Foreman' })).getByRole('button', { name: /Ada/ })
    expect(within(ada).getByText('Needs you · 1')).toBeTruthy()
    // The row opens the Team page; it is the selected row while the Team page is open.
    await user.click(row)
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
  })
})

describe('the Team page', () => {
  it('shows a card per employee with its model as text, its state, two responsibilities and the actions its state allows', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-1abc', 'Ada', { state: 'active' }), summary('e-2abc', 'Max'), summary('e-3abc', 'Sam', { state: 'active', changed: true })] })
    fakeApi.pauseEmployee = vi.fn(async () => undefined)
    render(<TeamPage orgId="o1" data={data()} />)
    expect(screen.getByRole('heading', { name: 'Employees · 3' })).toBeTruthy()
    // New employee is a secondary button: the decisions are the page's main acts.
    expect(screen.getByRole('button', { name: 'New employee' }).className).not.toMatch(/primary/)
    const columns = screen.getByRole('list', { name: 'Employees of Foreman' })
    const cards = within(columns)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('employee-card'))
    expect(cards).toHaveLength(3)
    expect(cards[0].textContent).toContain('Marketing · Claude Code · ')
    expect(cards[0].textContent).toContain('Idle')
    expect(within(cards[0]).getByRole('list', { name: 'Responsibilities of Ada' }).textContent).toBe('Write launch postsDraft the changelog email…and 1 more')
    // One state each, in words: a draft or a changed definition says what to do about it.
    expect(within(cards[1]).getByText('Draft — review and approve')).toBeTruthy()
    expect(within(cards[2]).getByText('Changed — review and approve')).toBeTruthy()
    // Approving happens on the employee's page, which is its plan: the Team page only opens it.
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
    expect(within(cards[0]).queryByRole('button', { name: 'Review and approve' })).toBeNull()
    await user.click(within(cards[1]).getByRole('button', { name: 'Review and approve' }))
    expect(spy('openEmployees')).toHaveBeenLastCalledWith({ orgId: 'o1', page: 'employee', id: 'e-2abc' })
    await user.click(within(cards[2]).getByRole('button', { name: 'Review and approve' }))
    expect(spy('openEmployees')).toHaveBeenLastCalledWith({ orgId: 'o1', page: 'employee', id: 'e-3abc' })
    await user.click(within(cards[0]).getByRole('button', { name: 'Open' }))
    expect(spy('openEmployees')).toHaveBeenLastCalledWith({ orgId: 'o1', page: 'employee', id: 'e-1abc' })
    await user.click(within(cards[0]).getByRole('button', { name: 'Pause' }))
    expect(fakeApi.pauseEmployee).toHaveBeenCalledWith('o1', 'e-1abc')
    await user.click(within(cards[1]).getByRole('button', { name: 'Edit' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-2abc', edit: true })
  })
})

describe('the New employee page', () => {
  it('Use my words keeps the person’s words as the instructions, at the safest settings, and creates a draft', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-1abc', 'Ada')] })
    const d = data()
    render(<NewEmployeePage orgId="o1" data={d} />)
    await writeYourOwn(user)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'Writes the release notes.')
    await user.click(screen.getByRole('button', { name: 'Concise' }))
    expect(screen.getByRole('button', { name: 'Concise' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Use my words' }))
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
    expect(screen.getByText('Saved as a draft in foreman-memory. Its page shows what it may do, and you approve it there.')).toBeTruthy()
    // One way to create: a draft, approved on its page.
    expect(screen.queryByRole('button', { name: /Create and approve/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    const [orgId, definition, options] = fakeApi.createEmployee.mock.calls[0]
    expect(orgId).toBe('o1')
    expect(options.approve).toBeFalsy()
    expect(definition).toMatchObject({ name: 'Rae', instructions: 'Writes the release notes.', personality: 'Concise', attendance: 'unattended', model: { agent: 'claude', model: 'claude-sonnet-5-5' } })
    expect(definition.access).toEqual(defaultEmployee({ id: definition.id, colour: 'orange', repos: ['foreman-website', 'foreman'], loadouts: [] }).access)
    // Ada wears pink, so the first free hat is orange.
    expect(definition.look).toEqual({ family: 'hardhat', colour: 'orange' })
    // The draft's page opens: it is the plan, approved there.
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: definition.id })
    expect(storeModule.showToast).toHaveBeenCalledWith('Rae was created as a draft. Approve it to let it run on this computer.')
    expect(d.reload).toHaveBeenCalled()
  })

  it('Generate drafts the words; suggestions start off; Create saves a draft with nothing granted and opens its page', async () => {
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
    await writeYourOwn(user)
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

    expect(screen.queryByRole('button', { name: /Create and approve/ })).toBeNull()
    const create = screen.getByRole('button', { name: 'Create' })
    expect(create.className).toMatch(/primary/)
    await user.click(create)
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    const [, definition, options] = fakeApi.createEmployee.mock.calls[0]
    // Created as a draft, never approved from here: approving is on its page, which shows the plan.
    expect(options.approve).toBeFalsy()
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: definition.id })
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
    await writeYourOwn(user)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'A marketing person.')
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
    await user.click(await screen.findByRole('switch', { name: 'Write to foreman-website' }))
    expect(screen.getByText('You turned this on')).toBeTruthy()
    expect(screen.getByText('Writes to foreman-website, in its own branch.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fakeApi.createEmployee).toHaveBeenCalled())
    expect(fakeApi.createEmployee.mock.calls[0][1].access.repos).toEqual({ 'foreman-website': 'write', foreman: 'read' })
  })

  it('keeps Generate off under Privacy mode, saying why, while Use my words still works', async () => {
    const user = userEvent.setup()
    setSnapshot({ privacyMode: true })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await writeYourOwn(user)
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'Writes notes.')
    expect(screen.getByRole('button', { name: 'Generate with AI' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Privacy mode is on, so nothing leaves this computer: only Use my words is available.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use my words' })).toHaveProperty('disabled', false)
  })

  it('says why a draft failed and keeps the person’s words', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.generateEmployeeDraft = vi.fn(async () => {
      throw new Error('The draft didn’t come back as expected: The answer wasn’t a JSON object. Try again, or press Use my words.')
    })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await writeYourOwn(user)
    const box = screen.getByRole('textbox', { name: 'Describe your employee' })
    await user.type(box, 'A marketing person.')
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The employee couldn’t be drafted')
    expect(alert.textContent).toContain('Try again, or press Use my words.')
    expect((screen.getByRole('textbox', { name: 'Describe your employee' }) as HTMLTextAreaElement).value).toBe('A marketing person.')
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
  })
})

describe('the New employee page: Pick a job (docs/ai-employees.md §16)', () => {
  const view = (id: string, name: string, patch: Partial<EmployeeSummary> = {}): EmployeeView => ({ ...summary(id, name, { state: 'active', ...patch }), blob: 'b1', text: '' })
  const chip = (name: string) => within(screen.getByRole('group', { name: 'Pick a job' })).getByRole('button', { name })
  const pressed = () =>
    within(screen.getByRole('group', { name: 'Pick a job' }))
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent)
  const described = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? ''

  it('opens on Pick a job with every job listed and Add off until one is chosen, and says both ways are there', () => {
    setSnapshot()
    render(<NewEmployeePage orgId="o1" data={data()} />)
    const ways = screen.getByRole('radiogroup', { name: 'How to add' })
    expect(within(ways).getByRole('radio', { name: 'Pick a job' }).getAttribute('aria-checked')).toBe('true')
    expect(within(ways).getByRole('radio', { name: 'Write your own' }).getAttribute('aria-checked')).toBe('false')
    // Every job, in the catalogue's order, named by its title; none chosen.
    const jobs = within(screen.getByRole('group', { name: 'Pick a job' })).getAllByRole('button')
    expect(jobs).toHaveLength(15)
    expect(jobs[0].textContent).toBe('Software engineer')
    expect(pressed()).toEqual([])
    // Each is described by its line and its access.
    expect(described(chip('QA engineer'))).toBe('Reviews what others build and says what breaks. · Read')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toHaveProperty('disabled', true)
    expect(described(add)).toBe('Pick a job to add.')
    // The fallback is always in sight; Write your own's form is hidden until it is chosen.
    expect(screen.getByRole('button', { name: 'Write your own' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Describe your employee' })).toBeNull()
  })

  it('chooses one job at a time: another replaces it, the same one again clears it', async () => {
    const user = userEvent.setup()
    setSnapshot()
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('Frontend engineer'))
    expect(pressed()).toEqual(['Frontend engineer'])
    await user.click(chip('QA engineer'))
    expect(pressed()).toEqual(['QA engineer'])
    await user.click(chip('QA engineer'))
    expect(pressed()).toEqual([])
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
  })

  it('shows who Add makes and says what it approves, naming Write and the repositories', async () => {
    const user = userEvent.setup()
    setSnapshot()
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('Frontend engineer'))
    const who = screen.getByRole('region', { name: 'Who you get' })
    expect(who.textContent).toContain('Mei')
    expect(who.textContent).toContain('Staff frontend engineer · hands back')
    expect(who.textContent).toContain('Write on foreman-website and foreman')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toHaveProperty('disabled', false)
    expect(described(add)).toBe('Adding approves Mei at once: Write on foreman-website and foreman. Mei’s pushes and pull requests still wait for you.')
    await user.click(chip('QA engineer'))
    expect(described(add)).toBe('Adding approves Quinn at once: Read on foreman-website and foreman.')
  })

  it('marks a job the organization already has, in words, and shows the new name and hat with why', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-qu1n', 'Quinn', { role: 'Staff QA engineer', colour: 'green', state: 'active' }), summary('e-old1', 'Old', { role: 'Staff UX designer', state: 'retired' })] })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    const qa = chip('QA engineer')
    expect(qa.textContent).toBe('QA engineer · you have Quinn')
    expect(described(qa)).toContain('You already have Quinn')
    // A job only a retired employee held isn't marked.
    expect(chip('UX designer').textContent).toBe('UX designer')
    await user.click(qa)
    const who = screen.getByRole('region', { name: 'Who you get' })
    expect(who.textContent).toContain('Quinn (QA engineer)')
    expect(who.textContent).toContain('You already have Quinn')
    expect(who.textContent).toContain('Named Quinn (QA engineer): an employee of Foreman is already called Quinn.')
    expect(who.textContent).toContain('Quinn already wears Green, so the hat is Orange.')
    expect(described(screen.getByRole('button', { name: 'Add' }))).toBe('Adding approves Quinn (QA engineer) at once: Read on foreman-website and foreman.')
  })

  it('names the last name taken when a third copy is numbered', async () => {
    const user = userEvent.setup()
    setSnapshot({
      employees: [
        summary('e-qu1n', 'Quinn', { role: 'Staff QA engineer', colour: 'green', state: 'active' }),
        summary('e-qu2n', 'Quinn (QA engineer)', { role: 'Staff QA engineer', colour: 'orange', state: 'active' })
      ]
    })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('QA engineer'))
    expect(screen.getByRole('region', { name: 'Who you get' }).textContent).toContain('Named Quinn (QA engineer) 2: an employee of Foreman is already called Quinn (QA engineer).')
  })

  it('says so when the organization has no repositories', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeState.snapshot = { ...fakeState.snapshot, repos: fakeState.snapshot.repos.filter((r: { id: string }) => r.id === 'mem' || r.id === 'blog') }
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('Security engineer'))
    expect(screen.getByRole('region', { name: 'Who you get' }).textContent).toContain('None yet: Foreman has no repositories')
    expect(described(screen.getByRole('button', { name: 'Add' }))).toBe('Adding approves Omar at once. Omar can’t read any repository yet: this organization has none. Give access on Omar’s page once you add one.')
    // A Write job's tag still says Write, though the access it is saved with lists no repository.
    await user.click(chip('Software engineer'))
    const who = screen.getByRole('region', { name: 'Who you get' })
    expect(who.textContent).toContain('Ravi')
    expect(within(who).getByText('Write')).toBeTruthy()
    expect(within(who).queryByText('Read')).toBeNull()
  })

  it('Add makes and approves it in main, says the name it got, opens its page, and can’t be pressed twice meanwhile', async () => {
    const user = userEvent.setup()
    setSnapshot()
    let answer: (value: { employee: EmployeeView }) => void = () => undefined
    fakeApi.addTemplateEmployee = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const d = data()
    render(<NewEmployeePage orgId="o1" data={d} />)
    await user.click(chip('Frontend engineer'))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(fakeApi.addTemplateEmployee).toHaveBeenCalledWith('o1', 'frontend-engineer')
    const working = screen.getByRole('button', { name: 'Adding…' })
    expect(working).toHaveProperty('disabled', true)
    await user.click(working)
    expect(fakeApi.addTemplateEmployee).toHaveBeenCalledTimes(1)
    // Main chose the name: someone took Mei meanwhile.
    answer({ employee: view('e-me12', 'Mei (Frontend engineer)') })
    await waitFor(() => expect(storeModule.showToast).toHaveBeenCalledWith('Mei (Frontend engineer) added and approved.'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-me12' })
    expect(d.reload).toHaveBeenCalled()
  })

  it('keeps the job chosen and says why when Add fails; a failed approval still opens the draft’s page', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.addTemplateEmployee = vi.fn(async () => {
      throw new Error('acme-memory has changes Foreman didn’t make.')
    })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('QA engineer'))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t add Quinn')
    expect(alert.textContent).toContain('acme-memory has changes Foreman didn’t make.')
    expect(pressed()).toEqual(['QA engineer'])
    expect(spy('openEmployees')).not.toHaveBeenCalled()
    // The callout names the job it was for, so choosing another clears it.
    await user.click(chip('Frontend engineer'))
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(chip('QA engineer'))
    fakeApi.addTemplateEmployee = vi.fn(async () => ({ employee: view('e-qu1n', 'Quinn', { state: 'draft' }), approveError: 'The disk is full.' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(storeModule.showToast).toHaveBeenCalledWith('Quinn was added as a draft, but approving it failed: The disk is full. Approve it on its page.'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-qu1n' })
  })

  it('works under Privacy mode: picking a job sends nothing to a model', async () => {
    const user = userEvent.setup()
    setSnapshot({ privacyMode: true })
    fakeApi.addTemplateEmployee = vi.fn(async () => ({ employee: view('e-qu1n', 'Quinn') }))
    render(<NewEmployeePage orgId="o1" data={data()} />)
    await user.click(chip('QA engineer'))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(fakeApi.addTemplateEmployee).toHaveBeenCalled())
    expect(fakeApi.generateEmployeeDraft).toBeUndefined()
  })

  it('works from the keyboard: the switch, the jobs with their hover card, Compare jobs and back, and the way into Write your own', async () => {
    const user = userEvent.setup()
    setSnapshot({ employees: [summary('e-qu1n', 'Quinn', { role: 'Staff QA engineer', colour: 'green', state: 'active' })] })
    render(<NewEmployeePage orgId="o1" data={data()} />)
    // The switch is one Tab stop; the arrows change the way, and what each holds stays.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Pick a job' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Write your own' }).getAttribute('aria-checked')).toBe('true')
    await user.type(screen.getByRole('textbox', { name: 'Describe your employee' }), 'Writes notes.')
    screen.getByRole('radio', { name: 'Write your own' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Pick a job' }).getAttribute('aria-checked')).toBe('true')
    // Tab: Compare jobs, then the jobs; focus opens a job's hover card, and Space chooses it.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compare jobs…' }))
    await user.tab()
    expect(document.activeElement).toBe(chip('Software engineer'))
    expect(screen.getByRole('group', { name: 'Software engineer' }).textContent).toContain('Ravi · hands back')
    await user.keyboard(' ')
    expect(pressed()).toEqual(['Software engineer'])
    // Compare jobs: focus to its first card, the same single choice, and Done back to the link.
    await user.click(screen.getByRole('button', { name: 'Compare jobs…' }))
    expect(document.activeElement?.textContent).toContain('Software engineer')
    const qa = screen.getByRole('button', { name: 'QA engineer' })
    expect(described(qa)).toContain('You already have Quinn')
    await user.click(qa)
    expect(qa.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Software engineer' }).getAttribute('aria-pressed')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compare jobs…' }))
    expect(pressed()).toEqual(['QA engineer · you have Quinn'])
    // "None of these fits? Write your own": the switch moves, with focus on it, and the words typed are still there.
    await user.click(screen.getByRole('button', { name: 'Write your own' }))
    const write = screen.getByRole('radio', { name: 'Write your own' })
    expect(write.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(write)
    expect((screen.getByRole('textbox', { name: 'Describe your employee' }) as HTMLTextAreaElement).value).toBe('Writes notes.')
  })
})

describe('the approval plan: a draft’s page', () => {
  const plan = () => {
    const definition = {
      ...defaultEmployee({ id: 'e-7k2m', colour: 'orange', repos: ['foreman', 'foreman-website'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max', role: 'Marketing' } }),
      access: { ...defaultEmployee({ id: 'e-7k2m', colour: 'orange', repos: [], loadouts: [] }).access, repos: { foreman: 'read' as const, 'foreman-website': 'write' as const }, delegate_to: ['e-1abc'] },
      limits: { runs_per_day: 6, minutes_per_run: 30, cost_per_day_usd: 5 }
    }
    definition.model.fallbacks = ['claude-haiku-5-5']
    definition.access.actions['push'] = 'allowed'
    const view: EmployeeView = { ...summary('e-7k2m', 'Max'), blob: 'b1', text: null, definition, fingerprint: 'f1' }
    return { definition, view }
  }
  const group = (name: string) => {
    const heading = screen.getByRole('heading', { name })
    return within(heading.closest('section')!)
      .getAllByRole('listitem')
      .map((li) => li.textContent)
  }

  it('says what it can, can’t and asks first in plain words, when it runs, its model, and what approval doesn’t cover', async () => {
    const user = userEvent.setup()
    setSnapshot()
    const { definition, view } = plan()
    render(<EmployeeReview employee={view} definition={definition} memory="foreman-memory" organization="Foreman" names={(id) => (id === 'e-1abc' ? 'Ada' : id)} />)
    const review = screen.getByRole('region', { name: 'What Max may do once you approve it' })
    // Only what is true for this definition, in three groups.
    expect(group('Can')).toEqual(['Read foreman', 'Change foreman-website, in its own branch', 'Keep its own notes in foreman-memory', 'Hand work to Ada', 'Push its branches without asking you'])
    expect(group('Can’t')).toEqual(['Post to Slack or change Linear It keeps no Slack or Linear tools.', 'Use a shell'])
    expect(group('Asks you first')).toEqual(['Before changing Foreman’s shared memory You add or discard each change.', 'Before each pull request'])
    const text = review.textContent ?? ''
    // When it runs, with its limits and who watches; the model on one line.
    expect(text).toContain('Only when you ask · at most 6 runs a day, 30 minutes a run, $5.00 a day')
    expect(text).toContain('With nobody watching: if a run needs your approval, it stops.')
    expect(text).toMatch(/Model\s*Claude Code · /)
    expect(text).toContain('Recorded on this computer only.')
    // What it is told, and what approval doesn't cover, are folded away.
    expect(within(review).getByText('What Max is told')).toBeTruthy()
    await user.click(within(review).getByText('What this approval does not cover'))
    for (const line of ['A new trigger or schedule.', 'A different agent or model.', 'Any outward action not listed here.', 'Any other change to its definition: it needs approving again.']) expect(review.textContent).toContain(line)
    // A draft has nothing changed since approval to show.
    expect(screen.queryByText(/Changed since you approved it/)).toBeNull()
  })

  it('is the draft’s page, with Approve <name> as its main button, which approves it at once', async () => {
    const user = userEvent.setup()
    const { view } = plan()
    setSnapshot({ employees: [summary('e-7k2m', 'Max'), summary('e-1abc', 'Ada', { state: 'active' })] })
    fakeApi.approveEmployee = vi.fn(async () => view)
    const d = data()
    render(<EmployeePage orgId="o1" employee={view} edit={false} data={d} />)
    expect(screen.getByText('Draft — review and approve')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'What Max may do once you approve it' })).toBeTruthy()
    // A draft has nothing to ask yet: the plan is where Ask would be.
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
    const approve = screen.getByRole('button', { name: 'Approve Max' })
    expect(approve.className).toMatch(/primary/)
    await user.click(approve)
    expect(fakeApi.approveEmployee).toHaveBeenCalledWith('o1', 'e-7k2m', 'f1')
    expect(storeModule.showToast).toHaveBeenCalledWith('Max is approved on this computer.')
    expect(d.reload).toHaveBeenCalled()
    // No dialog stands between the plan and approving it.
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
