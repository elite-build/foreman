// An organization's Team page (docs/ai-employees.md §10): a card per employee with its hat, name, role, model as text,
// its state, its first two responsibilities, and Approve, Pause, Resume and Edit; New employee. Retired employees are
// listed apart, without actions. Each card says what the employee is on or waiting for, how much is queued, how many
// tasks need you and its last result (§10); tasks that wait for a person are listed first, with Retry and Cancel. An
// approved employee with triggers says when it next runs on its own (§8). What went out without asking you in the last
// day is listed under Decided for you, with which of it can't be undone (§6.6).
import { Plus, Star } from 'lucide-react'
import { useState } from 'react'
import { employeeStatus, type EmployeeSummary } from '../../../../shared/employees'
import { employeeActivity } from '../../../../shared/employeeWork'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, showToast, useStore } from '../../store'
import { Button, Callout, Card, HardHat, LinkButton, Spinner, Status, Tag, type HardHatColour } from '../../ui'
import { ApproveDialog } from './ApproveDialog'
import { EmployeesNeedYou } from './EmployeeWork'
import { DecidedForYou } from './HeldActions'
import type { EmployeesData } from './EmployeesView'
import { activityText, lastResultText, modelText, nextRunText, workStatus } from './words'

export function TeamPage({ orgId, data }: { orgId: string; data: EmployeesData }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  const memory = useStore((s) => s.snapshot!.repos.find((r) => r.id === organization?.memoryRepoId)?.name ?? '')
  const roster = useStore((s) => s.snapshot!.employees?.[orgId])
  const [approving, setApproving] = useState<string | null>(null)
  const employees = roster?.employees ?? []
  const current = employees.filter((e) => e.state !== 'retired')
  const retired = employees.filter((e) => e.state === 'retired')
  const view = approving ? data.employees?.find((e) => e.id === approving) : undefined
  const names = (id: string) => employees.find((e) => e.id === id)?.name || id
  return (
    <div className="team-page">
      <div className="team-page-head">
        <p className="employee-faint">{t('employees.page.intro', { path: `${memory}/bots/` })}</p>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => openEmployees({ orgId, page: 'new' })}>
          {t('employees.page.new')}
        </Button>
      </div>
      {roster?.error && (
        <Callout tone="warn" role="status">
          {roster.error}
        </Callout>
      )}
      <EmployeesNeedYou orgId={orgId} />
      <DecidedForYou orgId={orgId} />
      {!roster && !data.employees && !data.error ? (
        <div className="employees-loading" role="status">
          <Spinner size={13} /> <span>{t('common.loading')}</span>
        </div>
      ) : current.length === 0 ? (
        <Callout tone="neutral">{t('employees.page.empty')}</Callout>
      ) : (
        <ul className="team-grid" aria-label={t('employees.team.label', { organization: organization?.name ?? '' })}>
          {current.map((e) => (
            <EmployeeCard key={e.id} orgId={orgId} employee={e} onApprove={() => setApproving(e.id)} />
          ))}
        </ul>
      )}
      {retired.length > 0 && (
        <section className="team-retired" aria-labelledby="team-retired">
          <h2 id="team-retired" className="employee-subheading">
            {t('employees.page.retired', { count: retired.length })}
          </h2>
          <ul className="team-grid">
            {retired.map((e) => (
              <EmployeeCard key={e.id} orgId={orgId} employee={e} />
            ))}
          </ul>
        </section>
      )}
      {approving && view?.definition && view.fingerprint && (
        <ApproveDialog
          definition={view.definition}
          memory={memory}
          names={names}
          onClose={() => setApproving(null)}
          onConfirm={async () => {
            await api.approveEmployee(orgId, view.id, view.fingerprint)
            setApproving(null)
            showToast(t('employees.approve.done', { name: view.name || view.id }))
            data.reload()
          }}
        />
      )}
    </div>
  )
}

function EmployeeCard({ orgId, employee: e, onApprove }: { orgId: string; employee: EmployeeSummary; onApprove?: () => void }) {
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
  const activity = employeeActivity(useStore((s) => s.snapshot!.employeeWork?.[orgId]), e.id)
  const triggerStates = useStore((s) => s.snapshot!.employeeTriggers)
  const next = nextRunText(orgId, e, triggerStates, t)
  const word = workStatus(status, activity)
  const doing = activityText(activity, t)
  const last = lastResultText(activity, t)
  const name = e.name || t('employees.card.unnamed', { id: e.id })
  const open = (edit = false) => openEmployees({ orgId, page: 'employee', id: e.id, ...(edit ? { edit: true } : {}) })
  const shown = e.responsibilities.slice(0, 2)
  return (
    <Card as="li" className="employee-card">
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
        <Status tone={word.tone} label={t(word.label)}>
          {status === 'draft' && <span className="employee-faint"> · {t('employees.status.draftDetail')}</span>}
        </Status>
        {activity.needsYou > 0 && <Status tone="warn" label={t('employees.needsYou.count', { count: activity.needsYou })} />}
        {activity.queued > 0 && <span className="employee-faint">{t('employees.activity.queued', { count: activity.queued })}</span>}
      </div>
      {doing && <p className="employee-card-doing">{doing}</p>}
      {next && <p className="employee-faint employee-card-next">{next}</p>}
      {last && <p className="employee-faint">{last}</p>}
      {e.problems.length > 0 ? (
        <p className="employee-faint">{t('employees.card.problems', { count: e.problems.length, path: e.path })}</p>
      ) : (
        shown.length > 0 && (
          <ul className="employee-card-duties" aria-label={t('employees.card.responsibilities', { name })}>
            {shown.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {e.responsibilities.length > 2 && <li className="employee-faint">{t('employees.card.more', { count: e.responsibilities.length - 2 })}</li>}
          </ul>
        )
      )}
      {e.state !== 'retired' && (
        <div className="employee-card-actions">
          {onApprove && !e.problems.length && (e.state === 'draft' || e.changed) && (
            <Button size="sm" variant="primary" onClick={onApprove}>
              {t('employees.action.approve')}
            </Button>
          )}
          {e.state === 'active' && (
            <Button size="sm" onClick={() => void attempt(() => api.pauseEmployee(orgId, e.id))}>
              {t('employees.action.pause')}
            </Button>
          )}
          {e.state === 'paused' && (
            <Button size="sm" onClick={() => void attempt(() => api.resumeEmployee(orgId, e.id))}>
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
