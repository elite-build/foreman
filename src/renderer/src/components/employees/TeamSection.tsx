// The sidebar's Team section for an organization (docs/ai-employees.md §10): a heading like every other section's
// (SidebarSection: it folds, remembered, and says ▲ and how many things of the employees wait for the person while
// folded; the shared needs-you count, src/shared/needsYou.ts), then a row of hats, one button per employee: ▲ on whoever
// needs the person, a turning ring on whoever is at work, ordered needs you, at work, then the rest. Each hat's name says
// who it is, its role, its state in words and its current task or what it waits on you for (its tooltip too), and opens
// its page. "Team page" under the hats opens the Team page; New employee is in the sidebar's + menu (NewMenu). Shown only
// while spaces apply, an organization is the space shown and it has a memory repository; retired employees aren't listed
// here (the Team page keeps them).
import { employeeActivity } from '../../../../shared/employeeWork'
import { employeeKey } from '../../../../shared/needsYou'
import { currentSpace, spacesOn } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { useNeedsYou } from '../../needsYou'
import { openEmployees, toggleTeamOpen, useStore } from '../../store'
import { Glyph, HardHat, IconButton, LinkButton, Spinner, type HardHatColour } from '../../ui'
import { SidebarSection } from '../SidebarSection'
import { activityText, needsYouText, rowStatus } from './words'
import './employees.css'

export function TeamSection() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const open = useStore((s) => Boolean(s.teamOpen))
  const { counts } = useNeedsYou()
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(organizations)) return null
  const space = currentSpace(organizations, wanted)
  const org = organizations.find((o) => o.id === space)
  if (!org?.memoryRepoId) return null
  const employees = (snapshot.employees?.[org.id]?.employees ?? []).filter((e) => e.state !== 'retired')
  const work = snapshot.employeeWork?.[org.id]
  // One count per employee, from the same list every other surface counts (a question with its workspace once).
  const waiting = (id: string) => counts.byEmployee.get(employeeKey(org.id, id)) ?? 0
  const total = employees.reduce((sum, e) => sum + waiting(e.id), 0)
  const hats = employees
    .map((e) => {
      const activity = { ...employeeActivity(work, e.id), needsYou: waiting(e.id) - (e.pausedKind === 'failures' ? 1 : 0) }
      const state = rowStatus(e, activity, t)
      // What waits for the person comes first when the state says Needs you: a question or a stuck task, a held outward
      // action or a memory proposal, each in words; else what it is on.
      const line = (activity.needsYou > 0 ? needsYouText(work, e.id, t) : undefined) ?? activityText(activity, t)
      const needs = waiting(e.id) > 0
      return { e, state, line, needs, working: !needs && activity.running, rank: needs ? 0 : activity.running ? 1 : 2 }
    })
    .sort((a, b) => a.rank - b.rank)
  return (
    <SidebarSection className="team-section" name={t('employees.team.heading')} count={employees.length} needs={total} open={open} onToggle={toggleTeamOpen}>
      {employees.length ? (
        <ul className="sb-hats" aria-label={t('employees.team.label', { organization: org.name })}>
          {hats.map(({ e, state, line, needs, working }) => {
            const selected = route?.orgId === org.id && route.page === 'employee' && route.id === e.id
            return (
              <li key={e.id}>
                <IconButton
                  className="sb-hat"
                  label={[e.name || e.id, e.role, state.label, line].filter(Boolean).join(' · ')}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => openEmployees({ orgId: org.id, page: 'employee', id: e.id })}
                >
                  <HardHat colour={e.colour as HardHatColour} size={18} />
                  {/* The state by shape on the hat's corner: ▲ needs you, a turning ring at work. */}
                  {needs ? (
                    <span className="sb-hat-mark">
                      <Glyph name="warn" />
                    </span>
                  ) : working ? (
                    <span className="sb-hat-mark ws-spin blue">
                      <Spinner size={9} />
                    </span>
                  ) : null}
                </IconButton>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="sb-empty">{t('employees.team.empty')}</p>
      )}
      <LinkButton size="sm" className="sb-link" aria-current={route?.orgId === org.id && route.page === 'team' ? 'page' : undefined} onClick={() => openEmployees({ orgId: org.id, page: 'team' })}>
        {t('sidebar.team.page')}
      </LinkButton>
    </SidebarSection>
  )
}
