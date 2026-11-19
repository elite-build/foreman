// @vitest-environment jsdom
// Home puts the work first (the app audit's Home pick, reworked for AI employees): one needs-you block of every kind
// from the shared list, each row tagged with its kind, its space while Home shows every space and the employee's hat
// when one asks, with Next; a Space filter (All spaces / Personal / each organization); Get started folded to one row
// under the work; and one primary New workspace (the sidebar's). The board's Needs you lane holds the same items.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { Home } from '../src/renderer/src/components/Home'
import { chooseHomeLayout } from '../src/renderer/src/components/HomeBoard'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]
const original = fakeState.snapshot

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const repo = (id: string, spaceId?: string) => ({ id, name: id, rootPath: `/code/${id}`, defaultBranch: 'main', ...(spaceId ? { spaceId } : {}) })
const ws = (id: string, repoId: string, extra: Record<string, unknown> = {}) => ({ id, repoId, name: id, branch: id, baseBranch: 'main', path: `/w/${id}`, state: 'ready', createdAt: at(300), ...extra })
const person = (id: string, name: string, colour: string) => ({ id, path: `bots/${id}.toml`, name, role: 'Writer', colour, responsibilities: [], problems: [], state: 'active', changed: false })

function setSnapshot() {
  fakeState.snapshot = {
    ...original,
    platform: 'win32',
    repos: [repo('atlas'), repo('acme-memory', 'o1'), repo('site', 'o1')],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'acme-memory', createdAt: at(9000) }],
    workspaces: [
      ws('osaka', 'atlas'),
      ws('lisbon', 'atlas'),
      ws('lima', 'site', { createdAt: at(30), startedBy: { via: 'employee', orgId: 'o1', employeeId: 'ada', runId: 'r3', taskId: 'date', title: 'Which day?' } }),
      ws('kyoto', 'site', { createdAt: at(70), startedBy: { via: 'employee', orgId: 'o1', employeeId: 'max', runId: 'r2', taskId: 'launch', title: 'Launch post' } })
    ],
    sessions: [
      { id: 's-osaka', workspaceId: 'osaka', title: 'Rate limit the API', agent: 'claude', model: 'm', status: 'idle', queue: [], createdAt: at(200), lastActivityAt: at(180), lastTurn: { outcome: 'error', endedAt: at(180) } },
      { id: 's-lisbon', workspaceId: 'lisbon', title: 'Fix login', agent: 'claude', model: 'm', status: 'idle', queue: [], createdAt: at(20), lastActivityAt: at(12) }
    ],
    employees: { o1: { head: 'h', employees: [person('ada', 'Ada', 'pink'), person('max', 'Max', 'orange')] } },
    employeeWork: {
      o1: {
        tasks: [{ id: 'date', orgId: 'o1', employeeId: 'ada', requestId: 'q', rootId: 'date', parentId: null, title: 'Which day?', body: '', from: 'person', targetRepoId: 'site', state: 'waiting', waitingOn: 'person', question: { id: 'q1', question: 'Which day does Atlas 2.4 launch?', options: ['Tuesday', 'Thursday'], runId: 'r3', askedAt: at(32) }, createdAt: at(32), updatedAt: at(32) }],
        runs: [],
        last: {},
        proposals: [{ id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append', text: '- 2.3 shipped on a Thursday.', employeeId: 'ada', runId: 'r3', createdAt: at(24) }],
        actions: [{ id: 'a1', orgId: 'o1', employeeId: 'max', taskId: 'launch', runId: 'r2', repoId: 'site', kind: 'push', payload: { kind: 'push', workspaceId: 'kyoto', branch: 'max/launch-2.4', base: 'main', head: 'abc', ahead: 1, commits: [], connection: 'gh' }, policy: 'held', state: 'held', key: 'k', createdAt: at(42), updatedAt: at(42) }],
        revision: 1
      }
    },
    schedules: [],
    occurrences: [],
    transfers: [],
    slackAsks: [],
    attentionHistory: { events: [] },
    integrations: { connections: [], suggestions: {} },
    settings: { ...original.settings, homeDoneDays: 7, onboarding: { milestones: { tiles: at(100) }, checklistHidden: false }, loadouts: [{ agent: 'claude', model: 'm' }] }
  }
}

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  fakeApi.agentStatus = vi.fn(async (agent: string) => ({ agent, installed: true, ready: true }))
  setSnapshot()
  Object.assign(fakeState, { attentionHistory: { events: [] }, space: null, homeScope: 'all', sidebarView: { repo: null, query: '', filter: 'all', showFinished: false }, unread: {}, unreadSessions: {}, approvals: [], checklistOpen: false, assistant: { gate: { state: 'ready', agent: 'claude' } } })
  chooseHomeLayout('list')
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  for (const key of ['space', 'homeScope', 'checklistOpen']) delete fakeState[key]
  chooseHomeLayout(null)
})

const block = () => document.querySelector('.home-needs') as HTMLElement
const rows = () => within(within(block()).getByRole('list')).getAllByRole('listitem')

describe('Home’s needs-you block', () => {
  it('leads with every kind from the shared list: 4 = 1 in Personal + 3 in Acme, oldest first, each tagged with its kind and space', () => {
    render(<Home />)
    expect(block().querySelector('.ui-callout__title')?.textContent).toMatch(/^4 need you · 1 in Personal, 3 in Acme · the oldest has waited/)
    const tags = rows().map((r) => [r.querySelector('.home-pill')?.textContent, r.querySelector('.home-row-space')?.textContent])
    expect(tags).toEqual([
      ['Turn failed', 'Personal'],
      ['Held action', 'Acme'],
      ['Question', 'Acme'],
      ['Memory proposal', 'Acme']
    ])
    // lima's workspace is Ada's question: one row, not two.
    expect(rows().filter((r) => r.textContent?.includes('lima'))).toHaveLength(1)
  })

  it('names what an employee asks or wants with its hat, how to answer, and that a push leaves this computer', async () => {
    render(<Home />)
    const [, pushRow, askRow, proposalRow] = rows()
    expect(pushRow.querySelector('.home-row-name')?.textContent).toBe('Max wants to push max/launch-2.4')
    expect(pushRow.querySelector('.home-row-title svg.ui-hard-hat')).not.toBeNull()
    expect(pushRow.querySelector('.home-row-sub')?.textContent).toBe('Leaves this computer · site')
    expect(askRow.querySelector('.home-row-name')?.textContent).toBe('Ada: Which day does Atlas 2.4 launch?')
    expect(askRow.querySelector('.home-row-sub')?.textContent).toBe('2 choices or your own words · in lima · site')
    expect(proposalRow.querySelector('.home-row-name')?.textContent).toBe('Ada proposes a change to memory/org/PROJECT.md')
    await userEvent.setup().click(within(askRow).getByRole('button', { name: 'Answer' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
  })

  it('Next opens the oldest, and its shortcut is the platform’s', async () => {
    render(<Home />)
    const next = within(block()).getByRole('button', { name: /^Next/ })
    expect(next.getAttribute('title')).toBe('Next needing attention (Ctrl+Alt+L)')
    await userEvent.setup().click(next)
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('osaka')
  })

  it('shows every space by default, with a Space filter whose options say how much waits in each', async () => {
    render(<Home />)
    const filter = screen.getByRole('radiogroup', { name: 'Space' })
    const options = within(filter).getAllByRole('radio')
    expect(options.map((o) => o.textContent)).toEqual(['All spaces4All spaces, 4 need you', 'Personal1Personal, 1 needs you', 'Acme3Acme, 3 need you'])
    expect(options[0].querySelectorAll('[data-glyph="warn"]')).toHaveLength(1)
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    await userEvent.setup().click(options[2])
    expect(spy('setHomeSpace')).toHaveBeenCalledWith('o1')
  })

  it('narrowed to one space, lists only its items, untagged', () => {
    Object.assign(fakeState, { homeScope: 'space', space: 'o1' })
    render(<Home />)
    expect(block().querySelector('.ui-callout__title')?.textContent).toMatch(/^3 need you · the oldest/)
    expect(rows().every((r) => !r.querySelector('.home-row-space'))).toBe(true)
    expect(screen.getByText(/^Acme · \d+ workspaces?$/)).toBeTruthy()
  })

  it('says all clear with nothing waiting', () => {
    Object.assign(fakeState.snapshot, { organizations: [], employeeWork: undefined, workspaces: [ws('lisbon', 'atlas')] })
    render(<Home />)
    expect(document.querySelector('.home-needs')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Space' })).toBeNull()
  })
})

describe('the rest of Home', () => {
  it('folds Get started to one row under the work', () => {
    render(<Home />)
    const getStarted = document.querySelector('.get-started') as HTMLElement
    expect(within(getStarted).getByRole('button', { name: 'Get started' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(getStarted).getByRole('meter', { name: 'Get started progress' })).toBeTruthy()
    // After the needs-you block and the recent work.
    expect(block().compareDocumentPosition(getStarted) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves New workspace and Import to the sidebar’s New: no primary button and neither of them in the header', () => {
    render(<Home />)
    expect(screen.queryByRole('button', { name: 'New workspace' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
    expect(document.querySelectorAll('.home .ui-btn--primary')).toHaveLength(0)
  })

  it('puts an employee’s decisions on the board’s Needs you lane with the workspaces', () => {
    Object.assign(fakeState.snapshot.settings, { homeBoard: true })
    chooseHomeLayout('board')
    render(<Home />)
    const lane = screen.getByRole('region', { name: 'Needs you' })
    expect(lane.querySelector('.blane-count')?.textContent).toBe('4')
    expect(lane.querySelectorAll('.needs-card')).toHaveLength(2)
    expect(within(lane).getByText('Max wants to push max/launch-2.4')).toBeTruthy()
    // Get started sits under the lanes.
    const board = document.querySelector('.board')!
    expect(board.compareDocumentPosition(document.querySelector('.get-started')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
