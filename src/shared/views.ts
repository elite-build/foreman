// Settings → Appearance → Sidebar & Home: one ordered list of views. Each view can be a tab in the sidebar, a lane
// on Home's board and a section on Home's list; the list's order is their order on all three. Views are fixed
// filters Foreman already works out (triage and the board's lanes), so nothing here is stored but which view shows
// where, and in what order.
import { LANES, placeOne, type BoardOptions, type Lane } from './board'
import type { PlainKey } from './i18n'
import type { Triage } from './triage'
import { waitingLater } from './later'

export type ViewId = 'all' | 'pinned' | 'later' | Lane
export type ViewSurface = 'tab' | 'lane' | 'home'

export interface ViewSetting {
  id: ViewId
  tab: boolean
  lane: boolean
  home: boolean
}

export const VIEW_IDS: readonly ViewId[] = ['all', 'needs-you', 'working', 'pinned', 'later', 'in-review', 'ready', 'done']

/** What the sidebar, the board and Home showed before views could be changed. */
export const DEFAULT_VIEWS: readonly ViewSetting[] = [
  { id: 'all', tab: true, lane: false, home: false },
  { id: 'needs-you', tab: true, lane: true, home: true },
  { id: 'working', tab: true, lane: true, home: true },
  { id: 'pinned', tab: true, lane: false, home: false },
  // Off until turned on: the sidebar's "Later · 2" line reaches it meanwhile.
  { id: 'later', tab: false, lane: false, home: false },
  { id: 'in-review', tab: false, lane: true, home: false },
  { id: 'ready', tab: false, lane: true, home: false },
  { id: 'done', tab: false, lane: true, home: false }
]

/** Each view's name, as a key; the same name on a tab, a lane and a Home section. */
export const VIEW_LABEL: Record<ViewId, PlainKey> = {
  all: 'sidebar.filter.all',
  'needs-you': 'sidebar.filter.needsYou',
  working: 'home.board.lane.working',
  pinned: 'sidebar.filter.pinned',
  later: 'views.later',
  'in-review': 'home.board.lane.in-review',
  ready: 'home.board.lane.ready',
  done: 'home.board.lane.done'
}

const isLane = (id: ViewId): id is Lane => (LANES as readonly string[]).includes(id)

/**
 * Where a view can go. All is a tab only: as a lane or a Home section it would hold everything. Pinned and Later are
 * no lanes, since a card sits in the one lane its facts decide.
 */
export function canShow(id: ViewId, surface: ViewSurface): boolean {
  if (surface === 'tab') return true
  if (id === 'all') return false
  return surface === 'home' || isLane(id)
}

/**
 * The saved list made whole: known views in the saved order, each once, then any view added since (with its default
 * places). A view never shows where it can't go, and the sidebar always keeps a tab.
 */
export function normalizeViews(saved: unknown): ViewSetting[] {
  const out: ViewSetting[] = []
  for (const entry of Array.isArray(saved) ? saved : []) {
    if (!entry || typeof entry !== 'object') continue
    const { id, tab, lane, home } = entry as Partial<ViewSetting>
    if (!VIEW_IDS.includes(id as ViewId) || out.some((v) => v.id === id)) continue
    const view = id as ViewId
    out.push({ id: view, tab: Boolean(tab), lane: Boolean(lane) && canShow(view, 'lane'), home: Boolean(home) && canShow(view, 'home') })
  }
  for (const view of DEFAULT_VIEWS) if (!out.some((v) => v.id === view.id)) out.push({ ...view })
  if (!out.some((v) => v.tab)) out.find((v) => v.id === 'all')!.tab = true
  return out
}

/** A list from outside (Settings, the command line): refused unless every entry is a known view with on/off places. */
export function parseViews(value: unknown): ViewSetting[] {
  if (!Array.isArray(value)) throw new Error('Views must be a list')
  const seen = new Set<string>()
  for (const entry of value) {
    const v = entry as Partial<ViewSetting> | null
    if (!v || typeof v !== 'object' || !VIEW_IDS.includes(v.id as ViewId)) throw new Error(`Unknown view: ${JSON.stringify((v as { id?: unknown } | null)?.id ?? v)}`)
    if (seen.has(v.id!)) throw new Error(`View listed twice: ${v.id}`)
    seen.add(v.id!)
    for (const key of ['tab', 'lane', 'home'] as const) if (typeof v[key] !== 'boolean') throw new Error(`View ${v.id}: ${key} must be on or off`)
  }
  return normalizeViews(value)
}

/** The views on one surface, in order. */
export function viewsOn(saved: unknown, surface: 'tab' | 'home'): ViewId[]
export function viewsOn(saved: unknown, surface: 'lane'): Lane[]
export function viewsOn(saved: unknown, surface: ViewSurface): ViewId[] {
  return normalizeViews(saved)
    .filter((v) => v[surface])
    .map((v) => v.id)
}

/** Whether a triaged workspace belongs in a view. The lane views match where the board would put it. */
export function matchesView(id: ViewId, t: Triage, opts: BoardOptions): boolean {
  if (id === 'all') return true
  if (id === 'needs-you') return t.bucket === 'attention'
  if (id === 'working') return t.bucket === 'working'
  if (id === 'pinned') return Boolean(t.ws.pinned)
  if (id === 'later') return waitingLater(t.ws, opts.now)
  return placeOne(t, opts).lane === id
}

/**
 * The sidebar's filter as it can be shown: a tab that's on, Needs you (the "Needs you · 3" chip filters to it even
 * when it isn't a tab) or Later (so does the "Later · 2" line). Anything else, including the "running" saved before
 * views, falls back.
 */
export function resolveFilter(filter: string, saved: unknown): ViewId {
  const id = filter === 'running' ? 'working' : filter
  const tabs = viewsOn(saved, 'tab')
  if (VIEW_IDS.includes(id as ViewId) && (tabs.includes(id as ViewId) || id === 'needs-you' || id === 'later')) return id as ViewId
  return tabs[0]
}
