// The sidebar's Team section for an organization (docs/ai-employees.md §10): each employee's hat beside its name and
// role, and on a line under them one state in a glyph and a word (Needs you while anything of it waits for a person,
// else Working, Paused, Idle or what stops it running) then its current task or reason (that gives way, never the name).
// Each opens its page; "Team" opens the Team page and "+" the New employee page. Shown only while spaces apply, an
// organization is the space shown and it has a memory repository; retired employees aren't listed here (the Team page
// keeps them).
import { Plus } from 'lucide-react'
import { employeeActivity, needsPerson } from '../../../../shared/employeeWork'
import { currentSpace, spacesOn } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { openEmployees, useStore } from '../../store'
import { ActionRow, HardHat, IconButton, LinkButton, Status, type HardHatColour } from '../../ui'
import { activityText, rowStatus } from './words'
import './employees.css'

export function TeamSection() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(snapshot.settings, organizations)) return null
  const space = currentSpace(organizations, wanted)
  const org = organizations.find((o) => o.id === space)
  if (!org?.memoryRepoId) return null
  const employees = (snapshot.employees?.[org.id]?.employees ?? []).filter((e) => e.state !== 'retired')
  const work = snapshot.employeeWork?.[org.id]
  const headingId = `team-${org.id}`
  return (
    <section className="team-section" aria-labelledby={headingId}>
      <div className="team-section-head">
        <span id={headingId} role="heading" aria-level={3}>
          <LinkButton size="sm" onClick={() => openEmployees({ orgId: org.id, page: 'team' })}>
            {t('employees.team.heading')}
          </LinkButton>
        </span>
        <span className="team-section-count">{employees.length}</span>
        <IconButton label={t('employees.team.add', { organization: org.name })} onClick={() => openEmployees({ orgId: org.id, page: 'new' })}>
          <Plus size={13} />
        </IconButton>
      </div>
      {employees.length ? (
        <ul className="team-list" aria-label={t('employees.team.label', { organization: org.name })}>
          {employees.map((e) => {
            const activity = employeeActivity(work, e.id)
            const state = rowStatus(e, activity, t)
            // What waits for the person comes first on the line when the state says Needs you.
            const waiting = (work?.tasks ?? []).find((x) => x.employeeId === e.id && needsPerson(x))
            const line = activityText(activity.needsYou > 0 && waiting ? { ...activity, current: waiting } : activity, t)
            const open = route?.orgId === org.id && route.page === 'employee' && route.id === e.id
            return (
              <li key={e.id}>
                <ActionRow className="team-row" primaryProps={{ className: 'team-row-main' }} selected={open} onPress={() => openEmployees({ orgId: org.id, page: 'employee', id: e.id })}>
                  {/* A grid like a workspace row's: the hat beside the name and role, the state and task on the line under them. */}
                  <HardHat className="team-row-hat" colour={e.colour as HardHatColour} size={20} />
                  <span className="team-row-who">
                    <span className="team-row-name">{e.name || e.id}</span>
                    {e.role && <span className="team-row-role">{e.role}</span>}
                  </span>
                  <span className="team-row-line">
                    <Status className="team-row-status" tone={state.tone} label={state.label} />
                    {line && (
                      <span className="team-row-doing" title={line}>
                        {line}
                      </span>
                    )}
                  </span>
                </ActionRow>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="team-empty">{t('employees.team.empty')}</p>
      )}
    </section>
  )
}
