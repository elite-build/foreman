// @vitest-environment jsdom
// Making, renaming, archiving and deleting channels (docs/ai-employees.md §15): the sidebar's + opens the organization's
// channel with "@Priya " in its box; a channel's ⋯ menu renames it (refusing a taken name) and deletes it (one still going
// is stopped first, its files kept unless the box is ticked); a closed channel archives from its header, an archived one
// is read-only with Restore; and the Channels page lists every channel, archived ones too, filters them and deletes
// several at once, never the organization's own.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { Project } from '../src/shared/projects'
import { ChannelsPage } from '../src/renderer/src/components/employees/ChannelsPage'
import { OrgChannel } from '../src/renderer/src/components/employees/OrgChannel'
import { ProjectPage } from '../src/renderer/src/components/employees/ProjectPage'
import { ProjectsSection } from '../src/renderer/src/components/employees/ProjectsSection'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const NOW = new Date().toISOString()
const org: Organization = { id: 'o1', name: 'FRLK', memoryRepoId: 'mem', programManagerId: 'e-pri1', leadEmployeeId: 'e-pri1', createdAt: NOW }
const member = (id: string, name: string): EmployeeSummary => ({ id, path: `bots/${id}.toml`, name, role: 'Program manager', colour: 'teal', responsibilities: [], problems: [], state: 'active', changed: false })

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    orgId: 'o1',
    slug: 'csv-export',
    title: 'Export reports to CSV',
    requirement: 'Export reports to CSV',
    repoId: 'site',
    pmId: 'e-pri1',
    phase: 'planning',
    plans: [],
    parts: {},
    replans: 0,
    steps: [],
    artifacts: {},
    waits: [],
    decisions: [],
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

const going = project()
const done = project({ id: 'p2', slug: 'weekly-email', title: 'Weekly metrics email', phase: 'closed', outcome: 'done', closedAt: NOW })
const archived = project({ id: 'p3', slug: 'onboarding', title: 'Onboarding emails', phase: 'closed', outcome: 'done', closedAt: NOW, archivedAt: NOW })

function setSnapshot(projects: Project[]) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'frlk-memory', rootPath: 'C:\\code\\frlk-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [org],
    workspaces: [],
    employees: { o1: { head: 'h1', employees: [member('e-pri1', 'Priya')] } },
    employeeWork: { o1: { tasks: [], runs: [], last: {}, proposals: [], roots: {}, actions: [], decided: [], revision: 1 } },
    projects: { o1: projects }
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'toggleProjectsOpen']) spy(name).mockReset()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
  fakeState.projectsOpen = true
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
  delete fakeState.projectsOpen
})

describe('making a channel', () => {
  it('opens the organization’s channel from the sidebar’s +, with Priya’s name in the box', async () => {
    const user = userEvent.setup()
    setSnapshot([going])
    const sidebar = render(<ProjectsSection />)
    await user.click(screen.getByRole('button', { name: 'New channel' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channel', mention: expect.any(Number) })
    sidebar.unmount()
    render(<OrgChannel orgId="o1" mention={1} />)
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message #frlk' })
    expect(box.value).toBe('@Priya ')
    expect(document.activeElement).toBe(box)
  })

  it('lists All channels under the projects and shows a renamed channel by its new name', async () => {
    const user = userEvent.setup()
    setSnapshot([project({ name: 'csv' })])
    render(<ProjectsSection />)
    const list = screen.getByRole('list', { name: 'Channels in FRLK' })
    expect(within(list).getByText('#csv')).toBeTruthy()
    await user.click(within(list).getByText('All channels'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channels' })
  })
})

describe('a channel’s menu', () => {
  it('renames, refusing another channel’s name', async () => {
    const user = userEvent.setup()
    setSnapshot([going, done])
    fakeApi.renameProject = vi.fn(async () => project({ name: 'csv' }))
    render(<ProjectsSection />)
    await user.click(screen.getByRole('button', { name: 'More for #csv-export' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }))
    const dialog = screen.getByRole('dialog', { name: 'Rename #csv-export' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'weekly-email')
    expect(within(dialog).getByText('Another channel is already called #weekly-email.')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    await user.clear(name)
    await user.type(name, 'csv{Enter}')
    await waitFor(() => expect(fakeApi.renameProject).toHaveBeenCalledWith('p1', 'csv'))
  })

  it('deletes a channel still going by stopping it first, its files kept unless ticked', async () => {
    const user = userEvent.setup()
    setSnapshot([going])
    fakeApi.deleteProject = vi.fn(async () => undefined)
    render(<ProjectsSection />)
    await user.click(screen.getByRole('button', { name: 'More for #csv-export' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete #csv-export?' })
    expect(within(dialog).getByText('It’s still going. Deleting stops it first, as Stop does.')).toBeTruthy()
    expect(within(dialog).getByText('The files stay in frlk-memory.')).toBeTruthy()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also delete its files from frlk-memory' }))
    await user.click(within(dialog).getByRole('button', { name: 'Stop and delete' }))
    await waitFor(() => expect(fakeApi.deleteProject).toHaveBeenCalledWith('p1', { removeFiles: true }))
    expect(storeModule.showToast).toHaveBeenCalledWith('#csv-export deleted.')
  })
})

describe('archiving', () => {
  it('archives a closed channel from its header, and an archived one is read-only until restored', async () => {
    const user = userEvent.setup()
    setSnapshot([done])
    fakeApi.archiveProject = vi.fn(async () => done)
    const closed = render(<ProjectPage orgId="o1" project={done} />)
    expect(screen.getByRole('textbox', { name: 'Message #weekly-email' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(fakeApi.archiveProject).toHaveBeenCalledWith('p2', true))
    closed.unmount()
    render(<ProjectPage orgId="o1" project={archived} />)
    expect(screen.queryByRole('textbox', { name: 'Message #onboarding' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(fakeApi.archiveProject).toHaveBeenCalledWith('p3', false))
  })
})

describe('the Channels page', () => {
  it('lists every channel, archived ones too, filters them, and deletes several at once but never the organization’s', async () => {
    const user = userEvent.setup()
    setSnapshot([going, done])
    fakeApi.listChannels = vi.fn(async () => [going, done, archived])
    fakeApi.deleteProject = vi.fn(async () => undefined)
    render(<ChannelsPage orgId="o1" />)
    const list = await screen.findByRole('list', { name: 'Channels in FRLK' })
    expect(within(list).getByText('#frlk')).toBeTruthy()
    expect(within(list).getByText('#onboarding')).toBeTruthy()
    // The organization's channel has no box to tick.
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3)
    await user.click(screen.getByRole('radio', { name: 'Archived 1' }))
    expect(within(list).queryByText('#csv-export')).toBeNull()
    expect(within(list).queryByText('#frlk')).toBeNull()
    await user.click(screen.getByRole('radio', { name: 'All 3' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select #weekly-email' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select #onboarding' }))
    await user.click(screen.getByRole('button', { name: 'Delete 2…' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete 2 channels?' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete 2 channels' }))
    await waitFor(() => expect(fakeApi.deleteProject).toHaveBeenCalledTimes(2))
    expect(fakeApi.deleteProject).toHaveBeenCalledWith('p2', { removeFiles: false })
    expect(fakeApi.deleteProject).toHaveBeenCalledWith('p3', { removeFiles: false })
  })

  it('searches by name or title', async () => {
    const user = userEvent.setup()
    setSnapshot([going, done])
    fakeApi.listChannels = vi.fn(async () => [going, done, archived])
    render(<ChannelsPage orgId="o1" />)
    const list = await screen.findByRole('list', { name: 'Channels in FRLK' })
    await user.type(screen.getByRole('searchbox', { name: 'Search channels' }), 'metrics')
    expect(within(list).getByText('#weekly-email')).toBeTruthy()
    expect(within(list).queryByText('#csv-export')).toBeNull()
  })
})
