// Add employee's Pick a job (docs/ai-employees.md §5.3, §16): New organization's job chips, hover cards and Compare
// jobs, choosing one; who that makes, as it will be saved (a name or hat already taken gives way, and says why); and
// Add, which makes and approves it at once with the template's own access. The sentence beside Add says what it
// approves, naming Write and the repositories. Main decides the name, hat and id at Add by the same rule this preview
// runs on the roster the window has, and the toast says the name it got. Nothing here sends anything to a model.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { EMPLOYEE_TEMPLATES, employeeTemplate, templateDefinitions, templateHolders, type EmployeeTemplateId } from '../../../../shared/employeeTemplates'
import type { EmployeeSummary } from '../../../../shared/employees'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { api, openEmployees, showToast, useStore } from '../../store'
import { Button, Callout, Card, isHardHatColour, LinkButton, Spinner } from '../../ui'
import { CompareJobs, PickedWho, TemplateChips, useNameList, useTemplateText, type JobHolders } from '../spaces/TeamTemplates'
import type { EmployeesData } from './EmployeesView'
import { colourName } from './words'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const NO_EMPLOYEES: EmployeeSummary[] = []

export function PickJob({ orgId, data, onWrite }: { orgId: string; data: EmployeesData; onWrite: () => void }) {
  const t = useT()
  const names = useNameList()
  const text = useTemplateText()
  const snapshot = useStore((s) => s.snapshot!)
  const organization = snapshot.organizations?.find((o) => o.id === orgId)
  const orgName = organization?.name ?? ''
  const roster = snapshot.employees?.[orgId]?.employees ?? NO_EMPLOYEES
  const loadouts = snapshot.settings.loadouts
  const repos = useMemo(
    () => reposInSpace(snapshot.repos, snapshot.organizations ?? [], orgId).filter((r) => r.id !== organization?.memoryRepoId).map((r) => r.name),
    [snapshot.repos, snapshot.organizations, orgId, organization?.memoryRepoId]
  )
  // Who already does each job: said on its chip, its hover card, its card in Compare jobs and under who you get.
  const holders = useMemo(() => {
    const entries = roster.map((e) => ({ name: e.name, role: e.role, retired: e.state === 'retired' }))
    const out: JobHolders = {}
    for (const tpl of EMPLOYEE_TEMPLATES) {
      const had = templateHolders(tpl, entries)
      if (had.length) out[tpl.id] = had
    }
    return out
  }, [roster])

  const [chosen, setChosen] = useState<EmployeeTemplateId | null>(null)
  const [comparing, setComparing] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<{ name: string; reason: string } | null>(null)
  const firstCard = useRef<HTMLButtonElement>(null)
  const compareLink = useRef<HTMLButtonElement>(null)
  const comparedOnce = useRef(false)
  const pickId = useId()
  const compareId = useId()
  const whoId = useId()
  const sayId = useId()

  // Into Compare jobs, focus goes to its first card; back out, to the link that opened it.
  useEffect(() => {
    if (comparing) {
      comparedOnce.current = true
      firstCard.current?.focus()
    } else if (comparedOnce.current) compareLink.current?.focus()
  }, [comparing])

  const template = chosen ? employeeTemplate(chosen) : null
  // Who Add makes, by the rule main runs at Add (templateDefinitions): the name, the hat and the access as saved.
  const preview = useMemo(
    () =>
      template
        ? templateDefinitions({
            templates: [template.id],
            repos,
            loadouts,
            taken: roster.map((e) => e.id),
            takenNames: roster.map((e) => e.name).filter(Boolean),
            worn: roster.filter((e) => e.state !== 'retired' && e.colour).map((e) => e.colour)
          })[0]
        : null,
    [template, repos, loadouts, roster]
  )
  // One job at a time: choosing another replaces it, choosing it again clears it.
  const picked = useMemo(() => new Set<EmployeeTemplateId>(chosen ? [chosen] : []), [chosen])
  const choose = (id: EmployeeTemplateId, on: boolean) => setChosen(on ? id : null)

  const write = preview ? Object.values(preview.access.repos).includes('write') : false
  const repoList = names(repos)
  const colour = preview && isHardHatColour(preview.look.colour) ? preview.look.colour : undefined
  const had = template ? holders[template.id] : undefined
  const notes =
    template && preview
      ? [
          had?.length ? t('spaces.team.youHave', { names: names(had) }) : '',
          preview.name !== template.name ? t('employees.add.renamed', { name: preview.name, organization: orgName, taken: template.name }) : '',
          colour && colour !== template.colour
            ? t('employees.add.recoloured', {
                holder: roster.find((e) => e.state !== 'retired' && e.colour === template.colour)?.name ?? '',
                worn: colourName(template.colour, t),
                colour: colourName(colour, t)
              })
            : ''
        ].filter(Boolean)
      : []
  const says = !preview
    ? t('employees.add.pickFirst')
    : !repos.length
      ? t('employees.add.approvesNone', { name: preview.name })
      : write
        ? t('employees.add.approvesWrite', { name: preview.name, repos: repoList })
        : t('employees.add.approvesRead', { name: preview.name, repos: repoList })

  const add = async () => {
    if (!chosen || working) return
    setWorking(true)
    setError(null)
    try {
      const { employee, approveError } = await api.addTemplateEmployee(orgId, chosen)
      // Made but not approved: it is a draft, and its page (where Approve is) opens all the same.
      showToast(approveError ? t('employees.add.notApproved', { name: employee.name, reason: approveError }) : t('employees.add.added', { name: employee.name }))
      data.reload()
      openEmployees({ orgId, page: 'employee', id: employee.id })
    } catch (err) {
      setError({ name: preview?.name ?? '', reason: message(err) })
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="new-employee">
      {error && (
        <Callout tone="error" role="alert" title={t('employees.add.failed', { name: error.name })}>
          {error.reason}
        </Callout>
      )}
      {comparing ? (
        <Card
          as="section"
          className="new-employee-card"
          aria-labelledby={compareId}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.defaultPrevented) {
              e.preventDefault()
              setComparing(false)
            }
          }}
        >
          <div className="new-employee-pick-head">
            <h2 id={compareId} className="employee-subheading">
              {t('spaces.compare.title')}
            </h2>
            <Button variant="ghost" onClick={() => setComparing(false)}>
              {t('common.back')}
            </Button>
            <Button variant="primary" onClick={() => setComparing(false)}>
              {t('common.done')}
            </Button>
          </div>
          <p className="employee-faint">{t('spaces.compare.desc')}</p>
          <CompareJobs picked={picked} onToggle={choose} firstRef={firstCard} holders={holders} />
        </Card>
      ) : (
        <Card as="section" className="new-employee-card" aria-labelledby={pickId}>
          <div className="new-employee-pick-head">
            <h2 id={pickId} className="employee-subheading">
              {t('employees.add.pick')}
            </h2>
            <LinkButton ref={compareLink} onClick={() => setComparing(true)}>
              {t('spaces.team.compare')}
            </LinkButton>
          </div>
          <TemplateChips single picked={picked} onToggle={choose} labelledBy={pickId} holders={holders} />
        </Card>
      )}
      <p className="employee-faint">
        {t('employees.add.noneFits')} <LinkButton onClick={onWrite}>{t('employees.add.write')}</LinkButton>
      </p>

      {template && preview ? (
        <Card as="section" className="new-employee-card" aria-labelledby={whoId}>
          <h2 id={whoId} className="employee-subheading">
            {t('employees.add.who')}
          </h2>
          <PickedWho template={template} name={preview.name} colour={colour} access={write ? 'write' : 'read'} size={40} />
          <span className="employee-faint">{t('employees.add.roleLine', { role: preview.role, what: text(template).gives })}</span>
          <dl className="new-employee-facts">
            <dt className="employee-faint">{t('employees.add.does')}</dt>
            <dd>{text(template).line}</dd>
            <dt className="employee-faint">{t('employees.add.access')}</dt>
            <dd>{!repos.length ? t('employees.add.accessNone', { organization: orgName }) : write ? t('employees.add.accessWrite', { repos: repoList }) : t('employees.add.accessRead', { repos: repoList })}</dd>
            {notes.length > 0 && (
              <>
                <dt className="employee-faint">{t('employees.add.note')}</dt>
                <dd>{notes.join(' ')}</dd>
              </>
            )}
          </dl>
        </Card>
      ) : (
        <Card empty className="new-employee-card">
          <p className="employee-faint">{t('employees.add.whoEmpty', { organization: orgName })}</p>
        </Card>
      )}

      <div className="new-employee-footer">
        <span id={sayId} className="employee-faint">
          {says}
        </span>
        <Button variant="primary" icon={working ? <Spinner size={13} /> : undefined} disabled={!chosen || working} aria-describedby={sayId} onClick={() => void add()}>
          {working ? t('employees.add.adding') : t('employees.add.add')}
        </Button>
      </div>
    </div>
  )
}
