// @vitest-environment jsdom
// An organization's Memory view (docs/ai-employees.md §10): the folder tree (keyboard too), a file opened and rendered,
// an edit whose file changed meanwhile showing both versions, search, the callout for changes Foreman didn't make with
// Accept, and the ways in from the space switcher and the Spaces page.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryStatus } from '../src/shared/memory'
import type { Organization } from '../src/shared/organizations'
import { MemoryView, memoryRows } from '../src/renderer/src/components/spaces/MemoryView'
import { SpaceSwitcher } from '../src/renderer/src/components/spaces/SpaceSwitcher'
import { SpacesPage } from '../src/renderer/src/components/settings/SpacesPage'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const org = (id: string, name: string, memoryRepoId?: string): Organization => ({ id, name, ...(memoryRepoId ? { memoryRepoId } : {}), createdAt: '2026-11-05T00:00:00.000Z' })
const ENTRIES = [
  { path: 'bots/.gitkeep', blob: 'k1', size: 0 },
  { path: 'memory/bots/.gitkeep', blob: 'k2', size: 0 },
  { path: 'memory/org/PROJECT.md', blob: 'b1', size: 20 },
  { path: 'memory/org/data/people.json', blob: 'b2', size: 2 },
  { path: 'repos/.gitkeep', blob: 'k3', size: 0 }
]

function setSnapshot(status: MemoryStatus | undefined, organizations = [org('o1', 'Acme', 'mem')]) {
  fakeState.snapshot = {
    ...original,
    repos: [{ id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' }],
    organizations,
    workspaces: [],
    memory: status ? { o1: status } : {},
    settings: { ...original.settings, aiEmployees: true }
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['closeMemory', 'openMemory', 'openSettingsPage']) spy(name).mockReset()
  fakeState.space = null
  fakeApi.memoryStatus = vi.fn(async () => ({ state: 'ok', head: 'h1' }))
  fakeApi.memoryTree = vi.fn(async () => ({ head: 'h1', entries: ENTRIES }))
  fakeApi.memoryReadFile = vi.fn(async (_org: string, path: string) => ({ path, head: 'h1', blob: 'b1', size: 20, text: '# Acme\n\nShip it.\n', binary: false, tooLarge: false }))
  fakeApi.memoryFileHistory = vi.fn(async () => [
    { commit: 'c0ffee1234', author: 'Max', email: 'e-1@employees.foreman', date: '2026-11-13T09:30:00Z', subject: 'Memory from run r1', trailers: [{ key: 'Foreman-Employee', value: 'e-1' }] }
  ])
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('the Memory view', () => {
  it('builds the tree from the files: folders first, .gitkeep only making folders, open folders’ children under them', () => {
    const rows = memoryRows(ENTRIES, new Set(['memory', 'memory/org']))
    expect(rows.map((r) => [r.path, r.depth, r.dir])).toEqual([
      ['bots', 0, true],
      ['memory', 0, true],
      ['memory/bots', 1, true],
      ['memory/org', 1, true],
      ['memory/org/data', 2, true],
      ['memory/org/PROJECT.md', 2, false],
      ['repos', 0, true]
    ])
  })

  it('lists employees’ proposals above the folders while any wait, with Keep and Retire', async () => {
    setSnapshot({ state: 'ok', head: 'h1' })
    fakeState.snapshot.employees = { o1: { head: 'h1', employees: [{ id: 'e-max1', name: 'Max' }] } }
    fakeState.snapshot.employeeWork = { o1: { tasks: [], runs: [], last: {}, revision: 1, proposals: [{ id: 'p1', orgId: 'o1', path: 'memory/org/decisions.md', kind: 'append', text: '- Use bun.\n', employeeId: 'e-max1', runId: 'r1', createdAt: '2026-11-13T10:00:00Z' }] } }
    const { unmount } = render(<MemoryView organizationId="o1" />)
    const list = screen.getByRole('list', { name: 'Memory proposals · 1' })
    expect(within(list).getByText('Max proposes adding to memory/org/decisions.md')).toBeTruthy()
    await userEvent.click(within(list).getByRole('button', { name: 'Retire' }))
    expect(fakeApi.retireMemoryProposal).toHaveBeenCalledWith('o1', 'p1')
    unmount()
    fakeState.snapshot.employeeWork.o1.proposals = []
    render(<MemoryView organizationId="o1" />)
    expect(screen.queryByRole('list', { name: /Memory proposals/ })).toBeNull()
  })

  it('shows the folders as a tree, asks the service to look, and opens a file rendered (by keyboard too)', async () => {
    const user = userEvent.setup()
    setSnapshot({ state: 'ok', head: 'h1' })
    render(<MemoryView organizationId="o1" />)
    expect(screen.getByRole('heading', { name: 'Memory · Acme' })).toBeTruthy()
    const tree = await screen.findByRole('tree', { name: 'Memory files' })
    expect(within(tree).getAllByRole('treeitem').map((i) => i.textContent)).toEqual(['bots', 'memory', 'bots', 'org', 'data', 'PROJECT.md', 'repos'])
    expect(fakeApi.memoryStatus).toHaveBeenCalledWith('o1')
    expect(screen.getByText('Every AI employee in Acme can read all of this memory.')).toBeTruthy()

    const file = within(tree).getByRole('treeitem', { name: 'PROJECT.md' })
    file.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fakeApi.memoryReadFile).toHaveBeenCalledWith('o1', 'memory/org/PROJECT.md'))
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeTruthy()
    expect(file.getAttribute('aria-selected')).toBe('true')

    // A folder closes with ←.
    within(tree).getByRole('treeitem', { name: 'memory' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(within(tree).queryByRole('treeitem', { name: 'PROJECT.md' })).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'History' }))
    const history = await screen.findByRole('list', { name: 'Commits that changed memory/org/PROJECT.md' })
    expect(history.textContent).toContain('Memory from run r1')
    expect(history.textContent).toContain('Foreman-Employee: e-1')

    await user.click(screen.getByRole('button', { name: 'Close memory' }))
    expect(spy('closeMemory')).toHaveBeenCalled()
  })

  it('saves an edit against the version opened, and when the file changed meanwhile shows both versions', async () => {
    const user = userEvent.setup()
    setSnapshot({ state: 'ok', head: 'h1' })
    fakeApi.memoryWriteFile = vi.fn().mockResolvedValueOnce({ ok: false, conflict: { blob: 'b9', text: '# Acme\n\nTheirs.\n' } }).mockResolvedValueOnce({ ok: true, blob: 'b10', commit: 'c2' })
    render(<MemoryView organizationId="o1" />)
    await user.click(await screen.findByRole('treeitem', { name: 'PROJECT.md' }))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit memory/org/PROJECT.md' })
    await user.clear(editor)
    await user.type(editor, 'Mine.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(fakeApi.memoryWriteFile).toHaveBeenCalledWith('o1', 'memory/org/PROJECT.md', 'Mine.', 'b1')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This file changed since you opened it')
    expect(screen.getByRole('region', { name: 'Saved now' }).textContent).toContain('Theirs.')
    expect(screen.getByRole('region', { name: 'Your version' }).textContent).toContain('Mine.')

    await user.click(screen.getByRole('button', { name: 'Save mine over it' }))
    // Over the version now saved.
    expect(fakeApi.memoryWriteFile).toHaveBeenLastCalledWith('o1', 'memory/org/PROJECT.md', 'Mine.', 'b9')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved now' })).toBeNull())
  })

  it('searches the index and opens a result', async () => {
    const user = userEvent.setup()
    setSnapshot({ state: 'ok', head: 'h1' })
    fakeApi.memorySearch = vi.fn(async () => [{ path: 'memory/org/data/people.json', blob: 'b2', snippet: 'the \u0001goals\u0002 list', rank: -1 }])
    render(<MemoryView organizationId="o1" />)
    await user.type(screen.getByRole('combobox', { name: 'Search memory' }), 'goals')
    const option = await screen.findByRole('option', { name: /memory\/org\/data\/people\.json/ })
    expect(fakeApi.memorySearch).toHaveBeenCalledWith('o1', 'goals')
    expect(option.querySelector('mark')?.textContent).toBe('goals')
    await user.click(option)
    await waitFor(() => expect(fakeApi.memoryReadFile).toHaveBeenCalledWith('o1', 'memory/org/data/people.json'))
  })

  it('names changes Foreman didn’t make, keeps Edit off, and accepts them', async () => {
    const user = userEvent.setup()
    setSnapshot({
      state: 'foreign',
      head: 'h2',
      baseline: 'h1',
      commits: [{ commit: 'abcdef1234', author: 'Sam', date: '2026-11-13T10:00:00Z', subject: 'Fix a typo' }],
      moreCommits: 2,
      dirty: ['memory/org/notes.md']
    })
    fakeApi.memoryAcceptForeign = vi.fn(async () => ({ state: 'ok', head: 'h2' }))
    render(<MemoryView organizationId="o1" />)
    const note = screen.getByText('Changes Foreman didn’t make:').closest('[role="status"]') as HTMLElement
    expect(note).toBeTruthy()
    expect(within(note).getByRole('list', { name: 'Commits made outside Foreman' }).textContent).toContain('abcdef1 Fix a typo · Sam')
    expect(note.textContent).toContain('…and 2 more')
    expect(within(note).getByRole('list', { name: 'Uncommitted changes' }).textContent).toContain('memory/org/notes.md')
    expect(note.textContent).toContain('Accept them to let Foreman write again.')
    expect(note.textContent).toContain('Accepting commits the uncommitted changes as yours.')

    await user.click(await screen.findByRole('treeitem', { name: 'PROJECT.md' }))
    expect((await screen.findByRole('button', { name: 'Edit' })).hasAttribute('disabled')).toBe(true)

    await user.click(within(note).getByRole('button', { name: 'Accept' }))
    expect(fakeApi.memoryAcceptForeign).toHaveBeenCalledWith('o1')
  })

  it('says why Foreman can’t write when the folder is on another branch', () => {
    setSnapshot({ state: 'unavailable', reason: 'branch', branch: 'main' })
    render(<MemoryView organizationId="o1" />)
    expect(screen.getByText('It isn’t on main. Check out main there so Foreman can write.')).toBeTruthy()
  })

  it('points to Spaces for an organization without a memory repository', async () => {
    const user = userEvent.setup()
    setSnapshot(undefined, [org('o1', 'Acme')])
    render(<MemoryView organizationId="o1" />)
    expect(screen.getByText('Acme has no memory repository yet.')).toBeTruthy()
    expect(fakeApi.memoryTree).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Choose one in Spaces' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'spaces' })
  })
})

describe('ways into the Memory view', () => {
  it('the space switcher offers it for the organization shown, when it has a memory repository', async () => {
    const user = userEvent.setup()
    setSnapshot({ state: 'ok', head: 'h1' }, [org('o1', 'Acme', 'mem'), org('o2', 'XYZ')])
    fakeState.space = 'o1'
    const { unmount } = render(<SpaceSwitcher />)
    await user.click(screen.getByRole('button', { name: 'Space: Acme' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open Acme’s memory' }))
    expect(spy('openMemory')).toHaveBeenCalledWith('o1')
    unmount()
    fakeState.space = 'o2'
    render(<SpaceSwitcher />)
    await user.click(screen.getByRole('button', { name: 'Space: XYZ' }))
    expect(screen.queryByRole('menuitem', { name: /memory/ })).toBeNull()
  })

  it('the Spaces page has Open memory on an organization’s card', async () => {
    const user = userEvent.setup()
    setSnapshot({ state: 'ok', head: 'h1' })
    render(<SpacesPage />)
    await user.click(screen.getByRole('button', { name: 'Open memory' }))
    expect(spy('openMemory')).toHaveBeenCalledWith('o1')
  })
})
