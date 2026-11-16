// An organization's employees views, covering the main area like the Memory view (docs/ai-employees.md §10): the Team
// page, the New employee page, one employee's page, the organization's channel and a project's channel (§15). It reads the employees in full through the service (the
// snapshot carries only their summaries) whenever the memory repository's head or an employee's lifecycle moves.
import { ArrowLeft, Users, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmployeeView } from '../../../../shared/employees'
import { useT } from '../../i18n'
import { api, closeEmployees, openEmployees, openSettingsPage, useStore, type EmployeesRoute } from '../../store'
import { Callout, IconButton, LinkButton, Spinner } from '../../ui'
import { EmployeePage } from './EmployeePage'
import { NewEmployeePage } from './NewEmployeePage'
import { OrgChannel } from './OrgChannel'
import { ProjectPage } from './ProjectPage'
import { TeamPage } from './TeamPage'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const TEXT_FIELDS = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"]'

/**
 * Whether a text field on the page holds words the person typed and hasn't sent: an answer in their own words, a held
 * action's text being edited, an Ask draft. Escape leaves those alone, wherever focus is.
 */
export function holdsTypedText(root: ParentNode | null): boolean {
  return Boolean(root && [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS)].some((f) => f.value.trim() !== ''))
}

/** The employees in full and how to read them again; null until the first answer. */
export interface EmployeesData {
  employees: EmployeeView[] | null
  error: string
  reload: () => void
}

export function EmployeesView({ route }: { route: EmployeesRoute }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === route.orgId))
  const memory = useStore((s) => s.snapshot!.repos.find((r) => r.id === organization?.memoryRepoId))
  const roster = useStore((s) => s.snapshot!.employees?.[route.orgId])
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null)
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)
  const reload = useCallback(() => setRound((n) => n + 1), [])
  // What the snapshot says moved: the head, or any employee's lifecycle here.
  const pulse = roster ? `${roster.head}|${roster.employees.map((e) => `${e.id}:${e.state}:${e.changed}:${e.approvedAt ?? ''}`).join(',')}` : ''
  const name = organization?.name ?? ''

  useEffect(() => {
    if (!memory) return
    let live = true
    api.listEmployees(route.orgId).then(
      (list) => {
        if (!live) return
        setEmployees(list.employees)
        setError('')
      },
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [route.orgId, memory, pulse, round])

  // Escape closes the Team page and an employee's overview; the New employee page and Edit hold unsaved words, so not
  // those, and not while a field here holds words not yet sent (focus may be on Skip, Cancel, Run now or Send).
  const unsaved = route.page === 'new' || (route.page === 'employee' && Boolean(route.edit))
  const view = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (unsaved) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.modal, .ui-dialog, input, textarea, select, [role="menu"], [role="listbox"], [role="dialog"]')) return
      if (holdsTypedText(view.current)) return
      e.preventDefault()
      closeEmployees()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [unsaved])

  const employee = route.page === 'employee' ? employees?.find((e) => e.id === route.id) : undefined
  const project = useStore((s) => (route.page === 'project' ? s.snapshot!.projects?.[route.orgId]?.find((p) => p.id === route.id) : undefined))
  const title =
    route.page === 'team'
      ? t('employees.view.team', { organization: name })
      : route.page === 'new'
        ? t('employees.view.new', { organization: name })
        : route.page === 'project'
          ? t('projects.view.title', { title: project?.slug ?? '', organization: name })
          : route.page === 'channel'
            ? t('projects.view.channel', { organization: name })
          : t('employees.view.employee', { name: employee?.name || (route.page === 'employee' ? route.id : ''), organization: name })
  const data: EmployeesData = { employees, error, reload }

  return (
    <div className="employees-view" ref={view}>
      <header className="titlebar drag employees-head">
        {route.page !== 'team' && (
          <IconButton label={t('employees.view.back')} onClick={() => openEmployees({ orgId: route.orgId, page: 'team' })}>
            <ArrowLeft size={15} />
          </IconButton>
        )}
        <span className="employees-title" role="heading" aria-level={1}>
          <Users size={15} aria-hidden /> {title}
        </span>
        <span className="employees-head-end">
          <IconButton label={t('employees.view.close')} onClick={closeEmployees}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      <div className="employees-body">
        {!memory ? (
          <Callout tone="info" title={t('employees.view.noMemory', { organization: name })}>
            <LinkButton underline onClick={() => openSettingsPage({ section: 'spaces' })}>
              {t('memory.noMemoryLink')}
            </LinkButton>
          </Callout>
        ) : (
          <>
            {error && (
              <Callout tone="error" role="alert">
                {error}
              </Callout>
            )}
            {route.page === 'team' && <TeamPage orgId={route.orgId} data={data} />}
            {route.page === 'new' && <NewEmployeePage orgId={route.orgId} data={data} />}
            {route.page === 'channel' && <OrgChannel orgId={route.orgId} />}
            {route.page === 'project' && (project ? <ProjectPage key={project.id} orgId={route.orgId} project={project} /> : <Callout tone="warn">{t('projects.view.notFound', { organization: name })}</Callout>)}
            {route.page === 'employee' &&
              (employee ? (
                <EmployeePage key={employee.id} orgId={route.orgId} employee={employee} edit={Boolean(route.edit)} data={data} />
              ) : employees === null && !error ? (
                <div className="employees-loading" role="status">
                  <Spinner size={13} /> <span>{t('common.loading')}</span>
                </div>
              ) : (
                !error && <Callout tone="warn">{t('employees.view.notFound', { organization: name })}</Callout>
              ))}
          </>
        )}
      </div>
    </div>
  )
}
