// The sidebar's Team mode for an organization (docs/ai-employees.md §10): one row per employee, whoever needs the person
// first, then whoever is at work, then the rest. A row is the employee's hat, name and what they're doing or what they
// wait on you for, with ▲ and how many of their things wait (the shared needs-you count, src/shared/needsYou.ts) or a
// turning ring while at work; it opens their page. "Team page" under the rows opens the Team page; New employee is in the
// sidebar's + menu (NewMenu). Shown only while an organization with a memory repository is the space shown; retired
// employees aren't listed here (the Team page keeps them).
import { employeeActivity } from '../../../../shared/employeeWork'
import { employeeKey } from '../../../../shared/needsYou'
import { useT } from '../../i18n'
import { useNeedsYou } from '../../needsYou'
import { shownOrganization } from '../../sidebarModes'
import { openEmployees, useStore } from '../../store'
import { ActionRow, Glyph, HardHat, LinkButton, Spinner, type HardHatColour } from '../../ui'
import { activityText, needsYouText, rowStatus } from './words'
import './employees.css'

export function TeamList() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const { counts } = useNeedsYou()
  const org = shownOrganization(snapshot, wanted)
  if (!org) return null
  const employees = (snapshot.employees?.[org.id]?.employees ?? []).filter((e) => e.state !== 'retired')
  const work = snapshot.employeeWork?.[org.id]
  // One count per employee, from the same list every other surface counts (a question with its workspace once).
  const waiting = (id: string) => counts.byEmployee.get(employeeKey(org.id, id)) ?? 0
  const rows = employees
    .map((e) => {
      const activity = { ...employeeActivity(work, e.id), needsYou: waiting(e.id) - (e.pausedKind === 'failures' ? 1 : 0) }
      const state = rowStatus(e, activity, t)
      // What waits for the person comes first when the state says Needs you: a question or a stuck task, a held outward
      // action or a memory proposal, each in words; else what it is on.
      const line = (activity.needsYou > 0 ? needsYouText(work, e.id, t) : undefined) ?? activityText(activity, t)
      const needs = waiting(e.id)
      return { e, state, line, needs, working: !needs && activity.running, rank: needs ? 0 : activity.running ? 1 : 2 }
    })
    .sort((a, b) => a.rank - b.rank)
  const teamPage = route?.orgId === org.id && route.page === 'team'
  return (
    <>
      {employees.length ? (
        <ul className="sb-list" aria-label={t('employees.team.label', { organization: org.name })}>
          {rows.map(({ e, state, line, needs, working }) => {
            const selected = route?.orgId === org.id && route.page === 'employee' && route.id === e.id
            // Who, their role, their state in words and what they're on or wait on you for: the row's name and tooltip.
            const label = [e.name || e.id, e.role, state.label, line].filter(Boolean).join(' · ')
            return (
              <li key={e.id}>
                <ActionRow
                  className="sb-row team-row"
                  primaryProps={{ className: 'sb-row-main', 'aria-label': label, title: label }}
                  selected={selected}
                  onPress={() => openEmployees({ orgId: org.id, page: 'employee', id: e.id })}
                >
                  <span className="sb-row-icon">
                    <HardHat colour={e.colour as HardHatColour} size={18} />
                  </span>
                  <span className="sb-row-name">{e.name || e.id}</span>
                  <span className="sb-row-line">{line || e.role}</span>
                  {/* The state by shape at the end: ▲ and how many wait, or a turning ring at work; the name says it in words. */}
                  {needs > 0 ? (
                    <span className="sb-row-need" aria-hidden>
                      <Glyph name="warn" />
                      {needs}
                    </span>
                  ) : working ? (
                    <span className="sb-row-end ws-spin blue" aria-hidden>
                      <Spinner size={11} />
                    </span>
                  ) : null}
                </ActionRow>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="sb-empty">{t('employees.team.empty')}</p>
      )}
      <LinkButton size="sm" className="sb-link" aria-current={teamPage ? 'page' : undefined} onClick={() => openEmployees({ orgId: org.id, page: 'team' })}>
        {t('sidebar.team.page')}
      </LinkButton>
    </>
  )
}
