// An organization's Team page (docs/ai-employees.md §10): the team itself. A column per employee, side by side (at most
// three to a row, one column below about 1000 px of room), each with its hat, name, role and model, its state in a glyph
// and a word (Idle, Working on “…”, Needs you, Draft — review and approve), when it next runs, what of it waits for you
// as one-line decisions that open in place (components/DecisionCard.tsx), its last task, and Open, Pause or Resume, Edit
// and the lead. What waits for you from the whole organization rather than one employee (a change to PROJECT.md) is a
// strip above the columns. Work one employee handed to another outside any project is drawn as a map under it
// (HandOffMap.tsx). What went out without asking you in the last day is under Decided for you (§6.6). New
// employee is a secondary button in the header: the decisions are the page's main acts.
import { Plus, Star } from 'lucide-react'
import { isOrganizationWide } from '../../../../shared/employeeDecisions'
import { employeeStatus, type EmployeeSummary } from '../../../../shared/employees'
import { employeeActivity } from '../../../../shared/employeeWork'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, showToast, useStore } from '../../store'
import { Button, Callout, Card, HardHat, LinkButton, Spinner, Status, Tag, type HardHatColour, type StatusTone } from '../../ui'
import { DecisionRows, useDecisionItems, type DecisionItem } from './EmployeeDecisions'
import { DecidedForYou } from './HeldActions'
import { HandOffs } from './HandOffMap'
import { AddProgramManager, PersonColumn } from './TeamRoles'
import type { EmployeesData } from './EmployeesView'
import { lastResultText, modelText, nextRunText, workStatus } from './words'

/** A proposal for the whole organization isn't one employee's: it goes in the strip above the columns. */
const orgWide = (item: DecisionItem) => item.kind === 'proposal' && isOrganizationWide(item.proposal)

export function TeamPage({ orgId, data }: { orgId: string; data: EmployeesData }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  const roster = useStore((s) => s.snapshot!.employees?.[orgId])
  const items = useDecisionItems(orgId)
  const employees = roster?.employees ?? []
  const current = employees.filter((e) => e.state !== 'retired')
  const retired = employees.filter((e) => e.state === 'retired')
  const shared = items.filter(orgWide)
  const name = organization?.name ?? ''
  return (
    <div className="team-page">
      <div className="team-page-head">
        <h2 className="employee-subheading">
          {t('employees.team.employees')} <span className="employee-faint">· {current.length}</span>
        </h2>
        <Button icon={<Plus size={14} />} onClick={() => openEmployees({ orgId, page: 'new' })}>
          {t('employees.page.new')}
        </Button>
      </div>
      <AddProgramManager orgId={orgId} />
      {roster?.error && (
        <Callout tone="warn" role="status">
          {roster.error}
        </Callout>
      )}
      {shared.length > 0 && (
        <section className="team-needs-you" aria-labelledby={`team-shared-${orgId}`}>
          <h3 id={`team-shared-${orgId}`} className="employee-subheading">
            {t('employees.team.shared', { organization: name })} <span className="employee-faint">· {shared.length}</span>
          </h3>
          <DecisionRows orgId={orgId} items={shared} label={t('employees.team.sharedLabel', { organization: name })} />
        </section>
      )}
      <HandOffs orgId={orgId} />
      {!roster && !data.employees && !data.error ? (
        <div className="employees-loading" role="status">
          <Spinner size={13} /> <span>{t('common.loading')}</span>
        </div>
      ) : current.length === 0 ? (
        <Callout tone="neutral">{t('employees.page.empty')}</Callout>
      ) : (
        <ul className="team-columns" aria-label={t('employees.team.label', { organization: name })}>
          {/* The person is one of the team (§15): first, deciding at every gate. */}
          <PersonColumn orgId={orgId} />
          {current.map((e) => (
            <EmployeeColumn key={e.id} orgId={orgId} employee={e} items={items.filter((i) => i.employeeId === e.id && !orgWide(i))} />
          ))}
        </ul>
      )}
      <DecidedForYou orgId={orgId} />
      {retired.length > 0 && (
        <section className="team-retired" aria-labelledby="team-retired">
          <h2 id="team-retired" className="employee-subheading">
            {t('employees.page.retired', { count: retired.length })}
          </h2>
          <ul className="team-columns">
            {retired.map((e) => (
              <EmployeeColumn key={e.id} orgId={orgId} employee={e} items={[]} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** One employee's column: who, its state, its waiting decisions, its last task, and what you can do with it. */
function EmployeeColumn({ orgId, employee: e, items }: { orgId: string; employee: EmployeeSummary; items: DecisionItem[] }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  // The organization's lead on this computer (§7): unaddressed work and escalations go to it.
  const lead = organization?.leadEmployeeId === e.id
  const setLead = (on: boolean) =>
    void attempt(async () => {
      await api.setOrganizationLead(orgId, on ? e.id : null)
      showToast(on ? t('employees.lead.set', { name: e.name || e.id, organization: organization?.name ?? '' }) : t('employees.lead.cleared', { organization: organization?.name ?? '' }))
    })
  const status = employeeStatus(e)
  const work = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const activity = employeeActivity(work, e.id)
  const triggerStates = useStore((s) => s.snapshot!.employeeTriggers)
  const next = nextRunText(orgId, e, triggerStates, t)
  const last = lastResultText(activity, t)
  const name = e.name || t('employees.card.unnamed', { id: e.id })
  const open = (edit = false) => openEmployees({ orgId, page: 'employee', id: e.id, ...(edit ? { edit: true } : {}) })
  const reviewing = !e.problems.length && e.state !== 'retired' && (e.state === 'draft' || e.changed)
  // One state, in a glyph and a word: a draft or a changed definition says what to do; then what waits for you; then
  // what it works on; then its lifecycle.
  const state: { tone: StatusTone; label: string } =
    status === 'draft'
      ? { tone: 'off', label: t('employees.state.draftReview') }
      : status === 'changed'
        ? { tone: 'warn', label: t('employees.state.changedReview') }
        : items.length
          ? { tone: 'warn', label: t('employees.needsYou.count', { count: items.length }) }
          : activity.running && activity.current
            ? { tone: 'info', label: t('employees.state.workingOn', { title: activity.current.title }) }
            : (() => {
                const word = workStatus(status, activity)
                return { tone: word.tone, label: t(word.label) }
              })()
  const shown = e.responsibilities.slice(0, 2)
  return (
    <Card as="li" className="employee-card team-column">
      <div className="employee-card-head">
        <HardHat colour={e.colour as HardHatColour} size={40} />
        <div className="employee-card-who">
          <span className="employee-card-tags">
            <LinkButton className="employee-card-name" onClick={() => open()}>
              {name}
            </LinkButton>
            {lead && (
              <Tag>
                <Star size={11} aria-hidden="true" /> {t('employees.lead.tag')}
              </Tag>
            )}
          </span>
          <span className="employee-faint">{[e.role, modelText(e.agent, e.model, t)].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <div className="employee-card-state">
        <Status tone={state.tone} label={state.label} />
        {next && <span className="employee-faint">{next}</span>}
        {activity.queued > 0 && <span className="employee-faint">{t('employees.activity.queued', { count: activity.queued })}</span>}
      </div>
      {items.length > 0 && <DecisionRows orgId={orgId} items={items} label={t('employees.needsYou.of', { name })} />}
      {e.problems.length > 0 ? (
        <p className="employee-faint">{t('employees.card.problems', { count: e.problems.length, path: e.path })}</p>
      ) : (
        shown.length > 0 &&
        (status === 'draft' || !last) && (
          <ul className="employee-card-duties" aria-label={t('employees.card.responsibilities', { name })}>
            {shown.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {e.responsibilities.length > 2 && <li className="employee-faint">{t('employees.card.more', { count: e.responsibilities.length - 2 })}</li>}
          </ul>
        )
      )}
      {last && <p className="employee-faint">{last}</p>}
      {e.state !== 'retired' && (
        <div className="employee-card-actions">
          {reviewing ? (
            <Button size="sm" onClick={() => open()}>
              {t('employees.action.review')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => open()}>
              {t('employees.needsYou.open')}
            </Button>
          )}
          {e.state === 'active' && (
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.pauseEmployee(orgId, e.id))}>
              {t('employees.action.pause')}
            </Button>
          )}
          {e.state === 'paused' && (
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.resumeEmployee(orgId, e.id))}>
              {t('employees.action.resume')}
            </Button>
          )}
          {!e.problems.length && (
            <Button size="sm" variant="ghost" onClick={() => open(true)}>
              {t('common.edit')}
            </Button>
          )}
          {!e.problems.length && (lead || e.state === 'active' || e.state === 'paused') && (
            <Button size="sm" variant="ghost" onClick={() => setLead(!lead)}>
              {lead ? t('employees.lead.remove') : t('employees.lead.make')}
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
