// The sidebar's Team row for an organization (docs/ai-employees.md §10): one row like Automations, with the employees'
// hats stacked, how many things of theirs wait for the person (the shared needs-you count, src/shared/needsYou.ts) and a
// chevron that shows the employees under it, remembered open or closed. The row opens the Team page. Each employee, when
// shown, has its hat beside its name and role, and on a line under them one state in a glyph and a word (Needs you while
// anything of it waits for a person, else Working, Paused, Idle or what stops it running) then its current task or
// reason (that gives way, never the name); each opens its page, and New employee the New employee page. Shown only
// while spaces apply, an organization is the space shown and it has a memory repository; retired employees aren't
// listed here (the Team page keeps them).
import { ChevronDown, ChevronRight, Plus, Users } from 'lucide-react'
import { useId } from 'react'
import { employeeActivity } from '../../../../shared/employeeWork'
import { employeeKey } from '../../../../shared/needsYou'
import { currentSpace, spacesOn } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { useNeedsYou } from '../../needsYou'
import { openEmployees, toggleTeamOpen, useStore } from '../../store'
import { ActionRow, Button, HardHat, IconButton, Status, type HardHatColour } from '../../ui'
import { activityText, needsYouText, rowStatus } from './words'
import './employees.css'

// Hats in the row's stack; the rest are on the Team page.
const STACK = 4

export function TeamSection() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const open = useStore((s) => Boolean(s.teamOpen))
  const { counts } = useNeedsYou()
  const listId = useId()
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
  // Everything of this organization that waits for the person, theirs and the projects' alike.
  const mine = counts.bySpace.get(org.id) ?? 0
  const teamOpen = route?.orgId === org.id && route.page === 'team'
  return (
    <section className="team-section" aria-label={t('employees.team.heading')}>
      {/* A row of the Automations and Assistant entries' size and inset; its icon isn't a brand icon, so not their colour. */}
      <ActionRow
        card
        className="team-entry"
        selected={teamOpen}
        onPress={() => openEmployees({ orgId: org.id, page: 'team' })}
        primaryProps={{ 'aria-label': total ? t('sidebar.rail.needYou', { label: t('employees.team.heading'), count: total }) : undefined }}
        actions={
          <IconButton className="team-entry-fold" label={t('sidebar.team.employees')} aria-expanded={open} aria-controls={listId} onClick={toggleTeamOpen}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </IconButton>
        }
      >
        <Users size={14} aria-hidden />
        <span className="team-entry-label">{t('employees.team.heading')}</span>
        {/* Who is on the team, by hat; their names are beside them under the chevron and on the Team page. */}
        <span className="team-entry-hats" aria-hidden>
          {employees.slice(0, STACK).map((e) => (
            <HardHat key={e.id} colour={e.colour as HardHatColour} size={16} />
          ))}
        </span>
        {total > 0 && (
          <Status className="team-entry-count" compact tone="warn" label={t('home.banner.needYou', { count: total })}>
            <span aria-hidden>{total}</span>
          </Status>
        )}
      </ActionRow>
      <div id={listId} className="team-fold" hidden={!open}>
        {employees.length ? (
          <ul className="team-list" aria-label={t('employees.team.label', { organization: org.name })}>
            {/* The person is one of the team (docs/ai-employees.md §15): what waits for them here, opening the Team page. */}
            <li>
              <ActionRow className="team-row" primaryProps={{ className: 'team-row-main' }} onPress={() => openEmployees({ orgId: org.id, page: 'team' })}>
                <HardHat className="team-row-hat" colour="slate" size={20} />
                <span className="team-row-who">
                  <span className="team-row-name">{t('projects.you')}</span>
                  <span className="team-row-role">{t('projects.person.short')}</span>
                </span>
                <span className="team-row-line">
                  <Status className="team-row-status" tone={mine ? 'warn' : 'off'} label={mine ? t('employees.needsYou.count', { count: mine }) : t('projects.person.nothing')} />
                </span>
              </ActionRow>
            </li>
            {employees.map((e) => {
              const activity = { ...employeeActivity(work, e.id), needsYou: waiting(e.id) - (e.pausedKind === 'failures' ? 1 : 0) }
              const state = rowStatus(e, activity, t)
              // What waits for the person comes first on the line when the state says Needs you: a question or a stuck
              // task, a held outward action or a memory proposal, each in words.
              const line = (activity.needsYou > 0 ? needsYouText(work, e.id, t) : undefined) ?? activityText(activity, t)
              const selected = route?.orgId === org.id && route.page === 'employee' && route.id === e.id
              return (
                <li key={e.id}>
                  <ActionRow className="team-row" primaryProps={{ className: 'team-row-main' }} selected={selected} onPress={() => openEmployees({ orgId: org.id, page: 'employee', id: e.id })}>
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
        <Button variant="ghost" size="sm" className="team-new" icon={<Plus size={13} />} aria-label={t('employees.team.add', { organization: org.name })} onClick={() => openEmployees({ orgId: org.id, page: 'new' })}>
          {t('sidebar.team.newEmployee')}
        </Button>
      </div>
    </section>
  )
}
