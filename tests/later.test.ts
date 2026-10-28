// Save for later: when a choice brings a workspace back, how triage and the sidebar treat it while it waits and
// once its day comes, and what a patch from outside may say.
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/store'
import { laterDue, laterUntil, nextLaterDue, parseLater, putAway, waitingLater } from '../src/shared/later'
import { sidebarGroups, triageAll, type SidebarView } from '../src/shared/triage'
import { normalizeViews, viewsOn } from '../src/shared/views'
import type { AppSnapshot, Session, Workspace } from '../src/shared/types'

// A Wednesday morning, local time.
const NOW = new Date(2026, 9, 28, 8, 30).getTime()
const at = (days: number, hour = 9) => new Date(2026, 9, 28 + days, hour, 0, 0, 0).toISOString()

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r', name: id, branch: id, baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: at(-5), ...patch }) as Workspace
const running = (workspaceId: string): Session =>
  ({ id: `s-${workspaceId}`, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'running', queue: [], createdAt: at(-1), turnStartedAt: at(0, 8) }) as Session

function input(workspaces: Workspace[], sessions: Session[] = [], now = NOW) {
  const snapshot = { workspaces, sessions, repos: [], settings: defaultSettings() } as unknown as AppSnapshot
  return { snapshot, approvals: [], unread: {}, unreadSessions: {}, now }
}
const view = (filter: string, query = ''): SidebarView => ({ repo: null, filter: filter as SidebarView['filter'], query, showFinished: false })
const shown = (workspaces: Workspace[], filter: string, query = '', sessions: Session[] = []) =>
  sidebarGroups(input(workspaces, sessions), view(filter, query))
    .groups.flatMap((g) => g.items.map((t) => t.ws.id))
    .sort()

describe('when a choice brings it back', () => {
  it('tomorrow, in three days and next Monday, at 9:00; no date means never by itself', () => {
    expect(laterUntil('tomorrow', NOW)).toBe(at(1))
    expect(laterUntil('in-3-days', NOW)).toBe(at(3))
    // Wednesday → Monday.
    expect(laterUntil('next-week', NOW)).toBe(at(5))
    // From a Monday, next week is the Monday after, not today.
    expect(laterUntil('next-week', new Date(2026, 10, 2, 8).getTime())).toBe(new Date(2026, 10, 9, 9).toISOString())
    expect(laterUntil('no-date', NOW)).toBeUndefined()
  })

  it('is due once its time has come; undated waits until taken out', () => {
    expect(laterDue({ later: { at: at(-1), until: at(0, 8) } }, NOW)).toBe(true)
    expect(laterDue({ later: { at: at(-1), until: at(1) } }, NOW)).toBe(false)
    expect(laterDue({ later: { at: at(-1) } }, NOW)).toBe(false)
    expect(waitingLater({ later: { at: at(-1) } }, NOW)).toBe(true)
    expect(waitingLater({}, NOW)).toBe(false)
  })

  it('knows the next moment something comes back, ignoring the past and the undated', () => {
    const list = [{ later: { at: at(-2), until: at(-1) } }, { later: { at: at(-1) } }, { later: { at: at(0), until: at(3) } }, { later: { at: at(0), until: at(1) } }, {}]
    expect(nextLaterDue(list, NOW)).toBe(Date.parse(at(1)))
    expect(nextLaterDue([{}], NOW)).toBeNull()
  })

  it('takes null to remove, or an optional date and time; anything else is refused', () => {
    expect(parseLater(null)).toBeNull()
    expect(parseLater({})).toEqual({})
    expect(parseLater({ until: at(1) })).toEqual({ until: at(1) })
    expect(() => parseLater('tomorrow')).toThrow()
    expect(() => parseLater({ until: 'someday' })).toThrow(/date/)
  })
})

describe('while it waits', () => {
  const saved = ws('saved', { later: { at: at(-1), until: at(2) } })
  const plain = ws('plain')

  it('is out of All and Pinned, but in Later and found by search', () => {
    const pinnedSaved = { ...saved, pinned: true }
    expect(shown([saved, plain], 'all')).toEqual(['plain'])
    expect(shown([pinnedSaved, plain], 'pinned')).toEqual([])
    expect(shown([saved, plain], 'later')).toEqual(['saved'])
    expect(shown([saved, plain], 'all', 'sav')).toEqual(['saved'])
  })

  it('still shows while its agent runs: live facts win', () => {
    const [t] = triageAll(input([saved], [running('saved')]), null)
    expect(t.bucket).toBe('working')
    expect(putAway(t, NOW)).toBe(false)
    expect(shown([saved], 'all', '', [running('saved')])).toEqual(['saved'])
  })
})

describe('when its day comes', () => {
  const back = ws('back', { later: { at: at(-3), until: at(0, 8) } })

  it('is in Needs you as Back from Later, from the time it came back', () => {
    const [t] = triageAll(input([back]), null)
    expect(t).toMatchObject({ bucket: 'attention', label: 'Back from Later', laterBack: true, since: at(0, 8) })
    expect(shown([back], 'needs-you')).toEqual(['back'])
    // No longer waiting, so not in Later.
    expect(shown([back], 'later')).toEqual([])
  })
})

describe('Later as a view', () => {
  it('is off by default and is no lane; a list saved before it gains it, off', () => {
    expect(viewsOn(undefined, 'tab')).not.toContain('later')
    expect(normalizeViews([{ id: 'later', tab: true, lane: true, home: true }]).find((v) => v.id === 'later')).toEqual({ id: 'later', tab: true, lane: false, home: true })
    const old = [{ id: 'all', tab: true, lane: false, home: false }]
    expect(normalizeViews(old).find((v) => v.id === 'later')).toEqual({ id: 'later', tab: false, lane: false, home: false })
  })

  it('the sidebar filter keeps Later even when it isn’t a tab (the "Later · 2" line)', () => {
    expect(shown([ws('x', { later: { at: at(-1) } })], 'later')).toEqual(['x'])
  })
})
