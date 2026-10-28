// Settings → Appearance → Sidebar & Home: the views list, and how the sidebar's tabs, the board's lanes and the
// sidebar's filter follow it.
import { describe, expect, it } from 'vitest'
import { boardLanes, keyboardLane, LANES } from '../src/shared/board'
import { sidebarGroups, triageAll, type SidebarView } from '../src/shared/triage'
import { defaultSettings } from '../src/main/store'
import { canShow, DEFAULT_VIEWS, matchesView, normalizeViews, parseViews, resolveFilter, VIEW_IDS, viewsOn, type ViewSetting } from '../src/shared/views'
import type { AppSnapshot, Settings, Workspace } from '../src/shared/types'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const opts = { now: NOW, doneDays: 7 }

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r', name: id, branch: id, baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: ago(100), ...patch }) as Workspace

// One workspace for each view but Needs you: pinned, in review, ready to merge, done, and one setting up (Working).
const WORKSPACES = [
  ws('pinned', { pinned: true }),
  ws('review', { status: 'in-review' }),
  ws('ready', { prInfo: { number: 4, state: 'OPEN', url: 'u', facts: { readAt: ago(5), provider: 'github', checks: 'passed', checksPassed: 1, checksTotal: 1, requiredOnly: false, review: 'approved', mergeable: 'yes', draft: false } } }),
  ws('done', { status: 'done', statusAt: ago(60) }),
  ws('setup', { state: 'setting-up' })
]

function input(settings: Partial<Settings> = {}) {
  const snapshot = { workspaces: WORKSPACES, sessions: [], repos: [], settings: { ...defaultSettings(), ...settings } } as unknown as AppSnapshot
  return { snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW }
}

const view = (filter: string): SidebarView => ({ repo: null, filter: filter as SidebarView['filter'], query: '', showFinished: false })
const names = (settings: Partial<Settings>, filter: string) =>
  sidebarGroups(input(settings), view(filter))
    .groups.flatMap((g) => g.items.map((t) => t.ws.id))
    .sort()

describe('the views list', () => {
  it('starts as the sidebar, board and Home were: four tabs, five lanes, two Home sections', () => {
    expect(defaultSettings().views).toEqual(DEFAULT_VIEWS)
    expect(viewsOn(undefined, 'tab')).toEqual(['all', 'needs-you', 'working', 'pinned'])
    expect(viewsOn(undefined, 'lane')).toEqual(LANES)
    expect(viewsOn(undefined, 'home')).toEqual(['needs-you', 'working'])
  })

  it('All is a tab only, and Pinned is no lane', () => {
    expect(canShow('all', 'tab')).toBe(true)
    expect(canShow('all', 'lane')).toBe(false)
    expect(canShow('all', 'home')).toBe(false)
    expect(canShow('pinned', 'lane')).toBe(false)
    expect(canShow('pinned', 'home')).toBe(true)
    expect(canShow('done', 'lane')).toBe(true)
  })

  it('a saved list keeps its order, drops what it does not know, and gains views added since', () => {
    const saved = [
      { id: 'pinned', tab: true, lane: true, home: false },
      { id: 'someday', tab: true, lane: false, home: false },
      { id: 'pinned', tab: false, lane: false, home: false },
      { id: 'working', tab: false, lane: true, home: true },
      'junk'
    ]
    const views = normalizeViews(saved)
    expect(views.map((v) => v.id)).toEqual(['pinned', 'working', 'all', 'needs-you', 'later', 'in-review', 'ready', 'done'])
    // Pinned can't be a lane, whatever was saved; the first Pinned wins.
    expect(views[0]).toEqual({ id: 'pinned', tab: true, lane: false, home: false })
    expect(views.find((v) => v.id === 'all')).toEqual(DEFAULT_VIEWS[0])
  })

  it('the sidebar always keeps a tab: with none on, All comes back', () => {
    const none = VIEW_IDS.map((id) => ({ id, tab: false, lane: true, home: false }))
    expect(viewsOn(none, 'tab')).toEqual(['all'])
  })

  it('refuses a list from outside unless every entry is a known view, once, with on/off places', () => {
    expect(() => parseViews('all')).toThrow(/list/)
    expect(() => parseViews([{ id: 'someday', tab: true, lane: true, home: true }])).toThrow(/Unknown view/)
    expect(() => parseViews([{ id: 'all', tab: true, lane: false, home: false }, { id: 'all', tab: true, lane: false, home: false }])).toThrow(/twice/)
    expect(() => parseViews([{ id: 'all', tab: 'yes', lane: false, home: false }])).toThrow(/tab must be on or off/)
    const reordered: ViewSetting[] = [{ id: 'done', tab: true, lane: true, home: true }]
    expect(parseViews(reordered)[0]).toEqual(reordered[0])
  })
})

describe('what each view holds', () => {
  const triaged = triageAll(input(), null)
  const holds = (id: Parameters<typeof matchesView>[0]) =>
    triaged
      .filter((t) => matchesView(id, t, opts))
      .map((t) => t.ws.id)
      .sort()

  it('follows triage for Needs you and Working, the pin for Pinned, and the board for its lanes', () => {
    expect(holds('all')).toHaveLength(WORKSPACES.length)
    expect(holds('working')).toEqual(['setup'])
    expect(holds('pinned')).toEqual(['pinned'])
    expect(holds('in-review')).toEqual(['review'])
    expect(holds('ready')).toEqual(['ready'])
    expect(holds('done')).toEqual(['done'])
  })
})

describe('the sidebar filter', () => {
  it('a tab filters the list to its view, finished work included', () => {
    const views = normalizeViews([{ id: 'done', tab: true, lane: true, home: false }])
    expect(names({ views }, 'done')).toEqual(['done'])
    expect(names({ views }, 'pinned')).toEqual(['pinned'])
  })

  it('reads the Running saved before views as Working', () => {
    expect(resolveFilter('running', undefined)).toBe('working')
    expect(names({}, 'running')).toEqual(['setup'])
  })

  it('a tab turned off falls back to the first tab; Needs you stays, for the sidebar chip', () => {
    const views = normalizeViews([
      { id: 'working', tab: true, lane: true, home: true },
      { id: 'all', tab: false, lane: false, home: false },
      { id: 'pinned', tab: false, lane: false, home: false },
      { id: 'needs-you', tab: false, lane: true, home: true }
    ])
    expect(resolveFilter('pinned', views)).toBe('working')
    expect(resolveFilter('nonsense', views)).toBe('working')
    expect(resolveFilter('needs-you', views)).toBe('needs-you')
    expect(names({ views }, 'pinned')).toEqual(['setup'])
  })
})

describe('the board follows the lanes that are on', () => {
  const triaged = triageAll(input(), null)

  it('a lane turned off holds nothing and lists nothing under the board', () => {
    const shown = LANES.filter((l) => l !== 'done')
    const board = boardLanes(triaged, opts, shown)
    expect(board.lanes.done).toEqual([])
    expect(board.lanes['in-review'].map((p) => p.t.ws.id)).toEqual(['review'])
    expect(board.off.map((p) => p.t.ws.id)).not.toContain('done')
  })

  it('Alt+arrows move between the shown lanes that take drops, in their order', () => {
    expect(keyboardLane('needs-you', 1)).toBe('in-review')
    expect(keyboardLane('needs-you', 1, ['needs-you', 'done', 'in-review'])).toBe('done')
    expect(keyboardLane('needs-you', 1, ['needs-you', 'working', 'ready'])).toBeNull()
  })
})
