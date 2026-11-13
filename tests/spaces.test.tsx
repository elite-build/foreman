// @vitest-environment jsdom
// Spaces in the window (docs/ai-employees.md §3 and §10): the switcher only while AI employees are on and an organization
// exists, Create an organization… in the Add repository menu only while on, and the Create an organization dialog's
// checks before it calls the API.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../src/shared/organizations'
import { SpaceSwitcher } from '../src/renderer/src/components/spaces/SpaceSwitcher'
import { CreateOrganizationDialog } from '../src/renderer/src/components/spaces/CreateOrganizationDialog'
import { AddRepoItems } from '../src/renderer/src/components/AddRepository'
import { SpacesPage } from '../src/renderer/src/components/settings/SpacesPage'
import { MenuButton } from '../src/renderer/src/ui'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const PARENT = 'C:\\code'

const repo = (id: string, spaceId?: string) => ({ id, name: id, rootPath: `${PARENT}\\${id}`, defaultBranch: 'main', ...(spaceId ? { spaceId } : {}) })
const org = (id: string, name: string, memoryRepoId?: string): Organization => ({ id, name, ...(memoryRepoId ? { memoryRepoId } : {}), createdAt: '2026-11-05T00:00:00.000Z' })

function setSnapshot(aiEmployees: boolean, organizations: Organization[], repos = [repo('blog'), repo('dotfiles'), repo('site', 'o1'), repo('foreman-memory', 'o1')]) {
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
    settings: { ...original.settings, aiEmployees, cloneDirectory: PARENT }
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['setSpace', 'openCreateOrganization', 'openSettingsPage']) spy(name).mockReset()
  fakeState.space = null
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('the space switcher', () => {
  it('is absent while AI employees are off, even with organizations', () => {
    setSnapshot(false, [org('o1', 'Foreman', 'foreman-memory')])
    render(<SpaceSwitcher />)
    expect(screen.queryByRole('button', { name: /^Space:/ })).toBeNull()
  })

  it('is absent while on with no organization: Personal alone needs no switcher', () => {
    setSnapshot(true, [])
    render(<SpaceSwitcher />)
    expect(screen.queryByRole('button', { name: /^Space:/ })).toBeNull()
  })

  it('lists each space with its counts, the current one checked, then Create and Manage', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory'), org('o2', 'XYZ')])
    render(<SpaceSwitcher />)
    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    const menu = screen.getByRole('menu', { name: 'Spaces' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Personal2 repositories · no memory repository', 'true'],
      ['Foreman2 repositories · memory in foreman-memory', 'false'],
      ['XYZ0 repositories · no memory repository', 'false']
    ])
    await user.click(items[1])
    expect(spy('setSpace')).toHaveBeenCalledWith('o1')

    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    await user.click(screen.getByRole('menuitem', { name: 'Create an organization…' }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'Space: Personal' }))
    await user.click(screen.getByRole('menuitem', { name: 'Manage spaces…' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'spaces' })
  })

  it('names the current organization, and falls back to Personal when it is gone', () => {
    setSnapshot(true, [org('o1', 'Foreman')])
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
  const open = async () => {
    const user = userEvent.setup()
    render(
      <MenuButton label="Add repository" trigger="+">
        <AddRepoItems />
      </MenuButton>
    )
    await user.click(screen.getByRole('button', { name: '+' }))
    return user
  }

  it('offers Create an organization… only while AI employees are on', async () => {
    setSnapshot(false, [])
    await open()
    expect(screen.queryByRole('menuitem', { name: /Create an organization/ })).toBeNull()
    cleanup()
    setSnapshot(true, [])
    const user = await open()
    await user.click(screen.getByRole('menuitem', { name: /Create an organization/ }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
  })
})

describe('Create an organization', () => {
  const create = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement

  it('needs a name, and names the new memory repository after it', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [])
    render(<CreateOrganizationDialog />)
    await screen.findByRole('dialog', { name: 'Create an organization' })
    expect(create().disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Foreman')
    expect((screen.getByRole('textbox', { name: 'Repository name' }) as HTMLInputElement).value).toBe('foreman-memory')
    expect(screen.getByText('Each organization has its own memory repository. It is never shared with another organization.')).toBeTruthy()
    // Joined with the platform's separator, never a mix ("C:\code/foreman-memory").
    expect(screen.getByText(`Creates ${PARENT}\\foreman-memory with one commit.`)).toBeTruthy()
    expect(create().disabled).toBe(false)
  })

  it('refuses a name another organization has, and a memory repository name Quick start would refuse', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory')])
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'foreman')
    expect(screen.getByText('There is already an organization with this name.')).toBeTruthy()
    expect(create().disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' two')
    expect(create().disabled).toBe(false)
    const memory = screen.getByRole('textbox', { name: 'Repository name' })
    await user.clear(memory)
    await user.type(memory, 'bad name!')
    expect(screen.getByText('Use letters, numbers, dots, dashes or underscores.')).toBeTruthy()
    expect(create().disabled).toBe(true)
  })

  it('offers existing repositories, says why another organization’s are not, and waits for a choice', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory')])
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'XYZ')
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
    expect(screen.getByText('1 repository moves, with its workspaces and chats. Nothing in the repository changes.')).toBeTruthy()
  })

  it('says what moves, creates, and then shows the new organization', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [])
    fakeApi.createOrganization = vi.fn(async () => org('new', 'Foreman'))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Foreman')
    expect(screen.getByText('No repositories move now. You can move any of them later, in Spaces.')).toBeTruthy()
    const bring = screen.getByRole('group', { name: 'Bring repositories from Personal' })
    await user.click(within(bring).getByRole('checkbox', { name: /blog/ }))
    expect(within(bring).getByText('2 workspaces')).toBeTruthy()
    expect(screen.getByText('1 repository moves, with its workspaces and chats. Nothing in the repository changes.')).toBeTruthy()
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Foreman', memory: { kind: 'create', name: 'foreman-memory', parentDir: PARENT }, repoIds: ['blog'] }))
    await waitFor(() => expect(spy('setSpace')).toHaveBeenCalledWith('new', { home: true }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(false)
  })

  it('decides later without a memory repository, and shows a refusal as an alert', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [])
    fakeApi.createOrganization = vi.fn(async () => Promise.reject(new Error('AI employees are off. Turn them on in Settings → Experimental.')))
    render(<CreateOrganizationDialog />)
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Acme')
    await user.click(screen.getByRole('radio', { name: 'Decide later' }))
    expect(screen.queryByRole('textbox', { name: 'Repository name' })).toBeNull()
    await user.click(create())
    await waitFor(() => expect(fakeApi.createOrganization).toHaveBeenCalledWith({ name: 'Acme', memory: { kind: 'later' }, repoIds: [] }))
    expect((await screen.findByRole('alert')).textContent).toContain('AI employees are off')
    expect(spy('setSpace')).not.toHaveBeenCalled()
  })
})

describe('the Spaces page', () => {
  it('shows a card per space with its memory repository and repositories, and moves one', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory'), org('o2', 'XYZ')])
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
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory')])
    render(<SpacesPage />)
    await user.click(within(screen.getByRole('region', { name: 'Foreman' })).getByRole('button', { name: 'Actions for foreman-memory' }))
    const [personal, foreman] = screen.getAllByRole('menuitemradio') as HTMLButtonElement[]
    expect(personal.disabled).toBe(true)
    expect(personal.title).toBe('The memory repository stays in Foreman.')
    expect(foreman.textContent).toContain('The memory repository stays in Foreman.')
  })

  it('deletes an organization after saying its repositories go back to Personal', async () => {
    const user = userEvent.setup()
    setSnapshot(true, [org('o1', 'Foreman', 'foreman-memory')])
    fakeApi.deleteOrganization = vi.fn(async () => undefined)
    render(<SpacesPage />)
    await user.click(within(screen.getByRole('region', { name: 'Foreman' })).getByRole('button', { name: 'Delete…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Foreman?' })
    expect(dialog.textContent).toContain('Its 2 repositories, the memory repository too, move back to Personal')
    await user.click(within(dialog).getByRole('button', { name: 'Delete organization' }))
    await waitFor(() => expect(fakeApi.deleteOrganization).toHaveBeenCalledWith('o1'))
  })
})
