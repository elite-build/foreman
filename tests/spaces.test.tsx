// @vitest-environment jsdom
// Spaces in the window (docs/ai-employees.md §3 and §10): the switcher always there (Personal until an organization
// exists), New organization… in it and in the Add repository menu, and the New organization dialog: one name, the
// repositories to bring (the one in view ticked), its memory repository in a line, the rest behind More options.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../src/shared/organizations'
import { SpaceSwitcher } from '../src/renderer/src/components/spaces/SpaceSwitcher'
import { CreateOrganizationDialog } from '../src/renderer/src/components/spaces/CreateOrganizationDialog'
import { AddRepoItems, CloneRepoDialog, QuickStartDialog } from '../src/renderer/src/components/AddRepository'
import { SpacesPage } from '../src/renderer/src/components/settings/SpacesPage'
import { MenuButton } from '../src/renderer/src/ui'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const PARENT = 'C:\\code'

const repo = (id: string, spaceId?: string) => ({ id, name: id, rootPath: `${PARENT}\\${id}`, defaultBranch: 'main', ...(spaceId ? { spaceId } : {}) })
const org = (id: string, name: string, memoryRepoId?: string): Organization => ({ id, name, ...(memoryRepoId ? { memoryRepoId } : {}), createdAt: '2026-11-05T00:00:00.000Z' })

function setSnapshot(organizations: Organization[], repos = [repo('blog'), repo('dotfiles'), repo('site', 'o1'), repo('foreman-memory', 'o1')]) {
  fakeState.snapshot = {
    ...original,
    repos,
    organizations,
    workspaces: [
      { id: 'w1', repoId: 'blog', state: 'ready' },
      { id: 'w2', repoId: 'blog', state: 'ready' },
      { id: 'w3', repoId: 'blog', state: 'archived' }
    ],
    recentRepos: [],
    homeDir: 'C:\\Users\\me',
    settings: { ...original.settings, cloneDirectory: PARENT }
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['setSpace', 'openCreateOrganization', 'openSettingsPage']) spy(name).mockReset()
  fakeState.space = null
  fakeState.sidebarView = { repo: null }
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
  delete fakeState.sidebarView
})

describe('the space switcher', () => {
  it('is there before any organization exists: Personal, with New organization… to make one', async () => {
    const user = userEvent.setup()
    setSnapshot([], [repo('blog'), repo('dotfiles')])
    render(<SpaceSwitcher />)
    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    const menu = screen.getByRole('menu', { name: 'Spaces' })
    expect(within(menu).getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([['Personal2 repositories · no memory repository', 'true']])
    const make = screen.getByRole('menuitem', { name: /New organization…/ })
    expect(make.textContent).toContain('Repositories you work on with others, with AI employees and a memory they share')
    await user.click(make)
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
  })

  it('lists each space with its counts, the current one checked, then New organization and Manage', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory'), org('o2', 'XYZ')])
    render(<SpaceSwitcher />)
    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    const menu = screen.getByRole('menu', { name: 'Spaces' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Personal2 repositories · no memory repository', 'true'],
      // Code repositories only: the memory repository isn't one to work in.
      ['Foreman1 repository · memory in foreman-memory', 'false'],
      ['XYZ0 repositories · no memory repository', 'false']
    ])
    await user.click(items[1])
    expect(spy('setSpace')).toHaveBeenCalledWith('o1')

    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    await user.click(screen.getByRole('menuitem', { name: /New organization…/ }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    await user.click(screen.getByRole('menuitem', { name: 'Manage spaces…' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'spaces' })
  })

  it('names the current organization, and falls back to Personal when it is gone', () => {
    setSnapshot([org('o1', 'Foreman')])
    fakeState.space = 'o1'
    const { unmount } = render(<SpaceSwitcher />)
    expect(screen.getByRole('button', { name: 'Space: Foreman' })).toBeTruthy()
    unmount()
    fakeState.space = 'gone'
    render(<SpaceSwitcher />)
    expect(screen.getByRole('button', { name: 'Space: Personal' })).toBeTruthy()
  })
})

describe('the Add repository menu', () => {
  it('offers New organization…', async () => {
    setSnapshot([])
    const user = userEvent.setup()
    render(
      <MenuButton label="Add repository" trigger="+">
        <AddRepoItems />
      </MenuButton>
    )
    await user.click(screen.getByRole('button', { name: '+' }))
    await user.click(screen.getByRole('menuitem', { name: /New organization…/ }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
  })
})

describe('New organization', () => {
  const create = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement

  it('starts with you and Priya, both always; without a memory repository she comes later', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'FRLK'))
    render(<CreateOrganizationDialog />)
    const team = await screen.findByRole('group', { name: 'Your team' })
    for (const who of [/You/, /Priya/]) {
      const box = within(team).getByRole('checkbox', { name: who }) as HTMLInputElement
      expect(box.checked && box.disabled).toBe(true)
    }
    expect(within(team).getByText('2 members')).toBeTruthy()
    expect(within(team).getByText('Priya proposes employees as projects need them. Each one waits for your approval.')).toBeTruthy()
    expect(screen.getByText('Create approves Priya’s fixed definition on this computer.')).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'FRLK')
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalled())
    expect((fakeApi.createOrganization as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('team')
  })

  it('adds employees from the job chips: each joins the team, its count and the footer, and comes with Create', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Acme'))
    render(<CreateOrganizationDialog />)
    const team = await screen.findByRole('group', { name: 'Your team' })
    const chips = within(team).getByRole('group', { name: 'Add' })
    expect(within(chips).getAllByRole('button')).toHaveLength(15)
    const chip = (name: string) => within(chips).getByRole('button', { name })
    expect(chip('Software engineer').getAttribute('aria-pressed')).toBe('false')
    await user.click(chip('Software engineer'))
    await user.click(chip('UX designer'))
    expect(chip('Software engineer').getAttribute('aria-pressed')).toBe('true')
    expect((within(team).getByRole('checkbox', { name: /Ravi/ }) as HTMLInputElement).checked).toBe(true)
    expect(within(team).getByRole('checkbox', { name: /Uma/ })).toBeTruthy()
    expect(within(team).getByText('4 members')).toBeTruthy()
    expect(screen.getByText('Create approves Priya, Ravi, and Uma on this computer.')).toBeTruthy()
    // Unticking a row takes them out again, and their chip with it.
    await user.click(within(team).getByRole('checkbox', { name: /Ravi/ }))
    expect(within(team).queryByRole('checkbox', { name: /Ravi/ })).toBeNull()
    expect(chip('Software engineer').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Create approves Priya and Uma on this computer.')).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Acme')
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalled())
    expect((fakeApi.createOrganization as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ name: 'Acme', templates: ['ux-designer'] })
  })

  it('compares the jobs as cards, the same choice as the chips, and comes back to the form with Done', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Acme')
    await user.click(screen.getByRole('button', { name: 'Software engineer' }))
    await user.click(screen.getByRole('button', { name: 'Compare jobs…' }))
    expect(screen.getByRole('dialog', { name: 'Compare jobs' })).toBeTruthy()
    const card = (name: string) => screen.getByRole('button', { name })
    expect(card('Software engineer').getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(card('Software engineer'))
    // Named by its title, described by what it does, its access, and who you get.
    expect(card('Web designer').getAttribute('aria-pressed')).toBe('false')
    const described = document.getElementById(card('Web designer').getAttribute('aria-describedby')!)!
    expect(described.textContent).toContain('Designs and builds marketing and content sites.')
    expect(described.textContent).toContain('Leo · hands back site designs and changes')
    await user.click(card('Web designer'))
    expect(screen.getByText('2 picked: Ravi and Leo')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    // Back on the form, with the name kept, Leo in the team, and focus on the link that opened the cards.
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Acme')
    expect(screen.getByRole('button', { name: 'Web designer' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('checkbox', { name: /Leo/ })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compare jobs…' }))
  })

  it('offers no employees while the memory repository is decided later, and sends none', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Later'))
    render(<CreateOrganizationDialog />)
    await user.click(await screen.findByRole('button', { name: 'Software engineer' }))
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.click(screen.getByRole('radio', { name: /Decide later/ }))
    expect(screen.queryByRole('group', { name: 'Add' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Ravi/ })).toBeNull()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Later')
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalled())
    expect((fakeApi.createOrganization as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('templates')
  })

  it('says so when its program manager couldn’t be made', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => ({ ...org('new', 'Solo'), teamProblem: 'git refused' }))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Solo')
    await user.click(create())
    await waitFor(() => expect(storeModule.showToast).toHaveBeenCalledWith('The organization was made, but its program manager wasn’t: git refused'))
  })

  it('needs only a name: its memory repository is named after it and made beside the others, said in one line', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Foreman'))
    render(<CreateOrganizationDialog />)
    await screen.findByRole('dialog', { name: 'New organization' })
    expect(create().disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Foreman')
    expect(screen.getByText(/Makes foreman-memory beside your repositories, private to this computer\./)).toBeTruthy()
    // Nothing else to decide unless asked for.
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Repository name' })).toBeNull()
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Foreman', memory: { kind: 'create', name: 'foreman-memory', parentDir: PARENT }, repoIds: [] }))
    await waitFor(() => expect(spy('setSpace')).toHaveBeenCalledWith('new', { home: true }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(false)
  })

  it('ticks the repository in view, and brings the ones ticked', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeState.sidebarView = { repo: 'dotfiles' }
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Acme'))
    render(<CreateOrganizationDialog />)
    const bring = await screen.findByRole('group', { name: 'Bring in' })
    expect((within(bring).getByRole('checkbox', { name: /dotfiles/ }) as HTMLInputElement).checked).toBe(true)
    expect((within(bring).getByRole('checkbox', { name: /blog/ }) as HTMLInputElement).checked).toBe(false)
    expect(within(bring).getByText('2 workspaces')).toBeTruthy()
    await user.click(within(bring).getByRole('checkbox', { name: /blog/ }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Acme')
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Acme', memory: { kind: 'create', name: 'acme-memory', parentDir: PARENT }, repoIds: ['blog', 'dotfiles'] }))
  })

  it('keeps its repositories in one folder when asked: named after it, its memory repository made there', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Acme'))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Acme')
    const together = screen.getByRole('checkbox', { name: 'Keep its repositories in one folder' })
    expect((together as HTMLInputElement).checked).toBe(false)
    expect(together.getAttribute('aria-describedby')).toBeTruthy()
    expect(screen.getByText('Repositories you clone for Acme, and its memory, go in a folder of their own.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Location' })).toBeNull()
    await user.click(together)
    expect((screen.getByRole('textbox', { name: 'Location' }) as HTMLInputElement).value).toBe(`${PARENT}\\acme`)
    expect(screen.getByText(/Makes acme-memory in acme, private to this computer\./)).toBeTruthy()
    await user.click(create())
    await waitFor(() =>
      expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Acme', memory: { kind: 'create', name: 'acme-memory', parentDir: `${PARENT}\\acme` }, repoIds: [], folder: `${PARENT}\\acme` })
    )
  })

  it('names the folder <name>-org when a repository already is <name>, and keeps a memory folder chosen under More options', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Blog'))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Blog')
    await user.click(screen.getByRole('checkbox', { name: 'Keep its repositories in one folder' }))
    const location = screen.getByRole('textbox', { name: 'Location' }) as HTMLInputElement
    expect(location.value).toBe(`${PARENT}\\blog-org`)
    await user.click(screen.getByRole('button', { name: 'More options' }))
    // Under More options the memory repository's own folder starts as the organization's.
    const memoryLocation = screen.getAllByRole('textbox', { name: 'Location' })[1] as HTMLInputElement
    expect(memoryLocation.value).toBe(`${PARENT}\\blog-org`)
    await user.clear(memoryLocation)
    await user.type(memoryLocation, 'D:\\memories')
    await user.click(create())
    await waitFor(() =>
      expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Blog', memory: { kind: 'create', name: 'blog-memory', parentDir: 'D:\\memories' }, repoIds: [], folder: `${PARENT}\\blog-org` })
    )
  })

  it('refuses a name another organization has, and under More options a memory repository name Quick start would refuse', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory')])
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'foreman')
    expect(screen.getByText('There is already an organization with this name.')).toBeTruthy()
    expect(create().disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' two')
    expect(create().disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: 'More options' }))
    // Joined with the platform's separator, never a mix ("C:\code/foreman two-memory").
    expect(screen.getByText(`Creates ${PARENT}\\foreman-two-memory with one commit.`)).toBeTruthy()
    const memory = screen.getByRole('textbox', { name: 'Repository name' })
    await user.clear(memory)
    await user.type(memory, 'bad name!')
    expect(screen.getByText('Use letters, numbers, dots, dashes or underscores.')).toBeTruthy()
    expect(create().disabled).toBe(true)
  })

  it('under More options, offers existing repositories, says why another organization’s are not, and waits for a choice', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory')])
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'XYZ')
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.click(screen.getByRole('radio', { name: 'Use an existing repository' }))
    expect(create().disabled).toBe(true)
    const select = screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Choose a repository', true],
      ['blog', false],
      ['dotfiles', false],
      ['foreman-memory · Foreman’s memory repository', true],
      ['site · in Foreman', true]
    ])
    await user.selectOptions(select, 'dotfiles')
    expect(create().disabled).toBe(false)
    // The memory repository moves too, and isn't offered again in the list to bring.
    expect(screen.queryByRole('checkbox', { name: /dotfiles/ })).toBeNull()
  })

  it('decides later without a memory repository, and shows a refusal as an alert', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.createOrganization = vi.fn(async () => Promise.reject(new Error('There is already an organization with this name.')))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Acme')
    await user.click(screen.getByRole('button', { name: 'More options' }))
    await user.click(screen.getByRole('radio', { name: 'Decide later' }))
    expect(screen.queryByRole('textbox', { name: 'Repository name' })).toBeNull()
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Acme', memory: { kind: 'later' }, repoIds: [] }))
    expect((await screen.findByRole('alert')).textContent).toContain('There is already an organization')
    expect(spy('setSpace')).not.toHaveBeenCalled()
  })
})

describe('the Spaces page', () => {
  it('shows a card per space with its memory repository and repositories, and moves one', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory'), org('o2', 'XYZ')])
    fakeApi.moveRepoToSpace = vi.fn(async () => undefined)
    render(<SpacesPage />)
    const personal = screen.getByRole('region', { name: 'Personal' })
    expect(within(personal).getByText('Personal has no memory repository.')).toBeTruthy()
    expect(within(personal).getAllByRole('listitem').map((li) => li.querySelector('.space-repo-name')?.textContent)).toEqual(['blog', 'dotfiles'])
    const foreman = screen.getByRole('region', { name: 'Foreman' })
    // The memory repository is listed first and tagged.
    expect(within(foreman).getAllByRole('listitem').map((li) => li.querySelector('.space-repo-name')?.textContent)).toEqual(['foreman-memorymemory', 'site'])
    const xyz = screen.getByRole('region', { name: 'XYZ' })
    expect(within(xyz).getByRole('button', { name: 'Choose one…' })).toBeTruthy()

    await user.click(within(personal).getByRole('button', { name: 'Actions for blog' }))
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Personal', 'true'],
      ['Foreman', 'false'],
      ['XYZ', 'false']
    ])
    await user.click(items[2])
    await waitFor(() => expect(fakeApi.moveRepoToSpace).toHaveBeenCalledWith('blog', 'o2'))
  })

  it('keeps a memory repository in its organization, and says why', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory')])
    render(<SpacesPage />)
    await user.click(within(screen.getByRole('region', { name: 'Foreman' })).getByRole('button', { name: 'Actions for foreman-memory' }))
    const [personal, foreman] = screen.getAllByRole('menuitemradio') as HTMLButtonElement[]
    expect(personal.disabled).toBe(true)
    expect(personal.title).toBe('The memory repository stays in Foreman.')
    expect(foreman.textContent).toContain('The memory repository stays in Foreman.')
  })

  it('deletes an organization after saying its repositories go back to Personal', async () => {
    const user = userEvent.setup()
    setSnapshot([org('o1', 'Foreman', 'foreman-memory')])
    fakeApi.deleteOrganization = vi.fn(async () => undefined)
    render(<SpacesPage />)
    await user.click(within(screen.getByRole('region', { name: 'Foreman' })).getByRole('button', { name: 'Delete…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Foreman?' })
    expect(dialog.textContent).toContain('Its 2 repositories, the memory repository too, move back to Personal')
    await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }))
    await waitFor(() => expect(fakeApi.deleteOrganization).toHaveBeenCalledWith('o1'))
  })
})

describe('Quick start and Clone while an organization with a folder of its own is showing', () => {
  const FOLDER = 'C:\\orgs\\foreman'
  const withFolder = (): Organization => ({ ...org('o1', 'Foreman', 'foreman-memory'), folder: FOLDER })

  it('start in its folder, say so, and make the repository in it', async () => {
    const user = userEvent.setup()
    setSnapshot([withFolder()])
    fakeState.space = 'o1'
    render(<QuickStartDialog />)
    const location = screen.getByRole('textbox', { name: 'Location' }) as HTMLInputElement
    expect(location.value).toBe(FOLDER)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'site')
    expect(screen.getByText(`Creates ${FOLDER}/site, in Foreman`)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Create project/ }))
    await waitFor(() => expect(spy('quickStartRepository')).toHaveBeenCalledWith(FOLDER, 'site', 'o1'))
  })

  it('use the clone location, in Personal, for an organization without one', () => {
    setSnapshot([org('o1', 'Foreman', 'foreman-memory')])
    fakeState.space = 'o1'
    render(<CloneRepoDialog />)
    expect((screen.getByRole('textbox', { name: 'Location' }) as HTMLInputElement).value).toBe(PARENT)
  })
})
