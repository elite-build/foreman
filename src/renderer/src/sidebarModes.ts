// The sidebar's modes (the tabs on its rail, Sidebar.tsx): which a space has, and their names. Personal has Inbox and Work;
// an organization with a memory repository adds Team and Channels (docs/ai-employees.md §10). Never its memory: nothing on
// the left shows or opens what Foreman keeps for an organization (docs/decisions.md, 2026-11-18).
import type { PlainKey } from '../../shared/i18n'
import { currentSpace, spacesOn } from '../../shared/organizations'
import type { SidebarView } from '../../shared/triage'
import type { AppSnapshot } from '../../shared/types'
import type { SidebarMode } from './store'

export const SIDEBAR_MODE_LABEL: Record<SidebarMode, PlainKey> = {
  inbox: 'sidebar.mode.inbox',
  work: 'sidebar.mode.work',
  team: 'sidebar.mode.team',
  channels: 'sidebar.mode.channels'
}

/** The organization shown, while it is one with a memory repository (so it has a team and channels). */
export function shownOrganization(snapshot: Pick<AppSnapshot, 'organizations'>, wanted: string | null) {
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(organizations)) return undefined
  const org = organizations.find((o) => o.id === currentSpace(organizations, wanted))
  return org?.memoryRepoId ? org : undefined
}

/** The modes the space shown has, in the rail's order. */
export function sidebarModes(snapshot: Pick<AppSnapshot, 'organizations'>, wanted: string | null): SidebarMode[] {
  return shownOrganization(snapshot, wanted) ? ['inbox', 'work', 'team', 'channels'] : ['inbox', 'work']
}

/**
 * What the sidebar's Work list shows of the remembered view: every repository of the space (the picked repository is Home's
 * filter, and the Ctrl+N target), and all of it, or what is saved for later (a filter saved by an earlier sidebar is All).
 */
export function workView(view: SidebarView): SidebarView {
  return { ...view, repo: null, filter: view.filter === 'later' ? 'later' : 'all' }
}

/** The mode picked, or Work when the space shown hasn't it (Team in Personal). */
export function shownMode(mode: SidebarMode, modes: readonly SidebarMode[]): SidebarMode {
  return modes.includes(mode) ? mode : 'work'
}
