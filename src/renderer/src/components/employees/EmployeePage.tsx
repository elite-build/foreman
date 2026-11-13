// One employee's page (docs/ai-employees.md §10): its hat, name, role and state; what it does and is responsible for,
// its model, what it can do, its memory folder and its approval here, with "changed since approval" and what changed;
// Approve, Pause or Resume, Edit and Retire. Edit is the precise form for every field: saving writes its file through
// the memory service, and a change to anything but its hat means approving it again. Ask <name>… and Run now start
// work (docs/ai-employees.md §6); its Tasks, Runs and Triggers are tabs beside the overview (§8). Paused after two
// runs in a row didn't finish, it says so with how the last ended (§9).
import { useState } from 'react'
import { quoteChanges } from '../../../../shared/diffSelection'
import { employeeMemoryFolder, employeeNameProblem, employeeProblems, employeeStatus, type EmployeeDefinition, type EmployeeView } from '../../../../shared/employees'
import { formatDateTime } from '../../../../shared/i18n/time'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, openMemory, showToast, useStore } from '../../store'
import { employeeActivity } from '../../../../shared/employeeWork'
import { Button, Callout, Card, Dialog, Disclosure, Field, HardHat, Status, Tab, TabList, TabPanel, Tabs, TextInput, type HardHatColour } from '../../ui'
import { AskEmployee, EmployeeRuns, EmployeeTasks } from './EmployeeWork'
import { Markdown } from '../Markdown'
import { ApproveDialog } from './ApproveDialog'
import { ActionRules } from './HeldActions'
import { AccessFields, CanDo, HatPicker, InstructionsField, WordFields } from './EmployeeFields'
import { TriggersField, TriggersTab } from './EmployeeTriggers'
import type { EmployeesData } from './EmployeesView'
import { colourName, modelText, workStatus } from './words'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The organization's repository names (its memory repository left out), its memory repository's name, and its employees. */
function useOrganization(orgId: string) {
  const snapshot = useStore((s) => s.snapshot!)
  const organization = snapshot.organizations?.find((o) => o.id === orgId)
  const repos = reposInSpace(snapshot.repos, snapshot.organizations ?? [], orgId)
    .filter((r) => r.id !== organization?.memoryRepoId)
    .map((r) => r.name)
  const memory = snapshot.repos.find((r) => r.id === organization?.memoryRepoId)?.name ?? ''
  const roster = snapshot.employees?.[orgId]?.employees ?? []
  return { repos, memory, roster }
}

export function EmployeePage({ orgId, employee, edit, data }: { orgId: string; employee: EmployeeView; edit: boolean; data: EmployeesData }) {
  const t = useT()
  const { repos, memory, roster } = useOrganization(orgId)
  // The lifecycle as the snapshot has it now (the fetched view can be a moment behind).
  const live = roster.find((e) => e.id === employee.id)
  const e = live ? { ...employee, state: live.state, changed: live.changed, approvedAt: live.approvedAt, pausedKind: live.pausedKind, pausedDetail: live.pausedDetail } : employee
  const [approveOpen, setApproveOpen] = useState(false)
  const [retireOpen, setRetireOpen] = useState(false)
  const [tab, setTab] = useState('overview')
  const work = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const activity = employeeActivity(work, employee.id)
  const d = e.definition
  const name = e.name || e.id
  const status = employeeStatus(e)
  const word = workStatus(status, activity)
  const others = roster.filter((o) => o.id !== e.id).map((o) => ({ id: o.id, name: o.name }))
  const names = (id: string) => roster.find((o) => o.id === id)?.name || id

  if (edit && d && e.state !== 'retired') return <EmployeeEdit orgId={orgId} employee={e} definition={d} repos={repos} memory={memory} data={data} />

  return (
    <div className="employee-page">
      <div className="employee-page-head">
        <HardHat colour={e.colour as HardHatColour} size={64} />
        <div className="employee-page-who">
          <h2 className="employee-name">{name}</h2>
          {e.role && <span className="employee-faint">{e.role}</span>}
          <Status tone={word.tone} label={t(word.label)} />
          {activity.needsYou > 0 && <Status tone="warn" label={t('employees.needsYou.count', { count: activity.needsYou })} />}
        </div>
        <div className="employee-card-actions">
          {d && e.state !== 'retired' && (e.state === 'draft' || e.changed) && (
            <Button variant="primary" onClick={() => setApproveOpen(true)}>
              {t('employees.action.approve')}
            </Button>
          )}
          {e.state === 'active' && <Button onClick={() => void attempt(() => api.pauseEmployee(orgId, e.id))}>{t('employees.action.pause')}</Button>}
          {e.state === 'paused' && <Button onClick={() => void attempt(() => api.resumeEmployee(orgId, e.id))}>{t('employees.action.resume')}</Button>}
          {d && e.state !== 'retired' && (
            <Button variant="ghost" onClick={() => openEmployees({ orgId, page: 'employee', id: e.id, edit: true })}>
              {t('common.edit')}
            </Button>
          )}
          {e.state !== 'retired' && (
            <Button variant="ghost" onClick={() => setRetireOpen(true)}>
              {t('employees.action.retire')}
            </Button>
          )}
        </div>
      </div>

      {e.problems.length > 0 && (
        <Callout
          tone="error"
          role="alert"
          title={t('employees.employee.problemsTitle', { path: e.path })}
          actions={
            <Button size="sm" onClick={() => openMemory(orgId)}>
              {t('employees.employee.openMemory')}
            </Button>
          }
        >
          <ul className="employee-plan-bullets">
            {e.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p>{t('employees.employee.problemsBody')}</p>
        </Callout>
      )}
      {e.changed && !e.problems.length && (
        <Callout tone="warn" role="status" title={t('employees.employee.changedTitle')}>
          <p>{t('employees.employee.changedBody')}</p>
          {e.approvedText !== undefined && e.text !== null ? <DefinitionDiff before={e.approvedText} after={e.text} path={e.path} /> : <p>{t('employees.employee.diffUnavailable')}</p>}
        </Callout>
      )}
      {e.state === 'retired' && <Callout tone="neutral">{t('employees.employee.retiredNote', { memory })}</Callout>}
      {e.state === 'paused' && e.pausedKind === 'failures' && (
        <Callout
          tone="warn"
          role="status"
          title={t('employees.employee.failuresTitle', { name })}
          actions={
            <Button size="sm" onClick={() => void attempt(() => api.resumeEmployee(orgId, e.id))}>
              {t('employees.action.resume')}
            </Button>
          }
        >
          {e.pausedDetail ? t('employees.employee.failuresBody', { detail: e.pausedDetail }) : t('employees.employee.failuresBodyPlain')}
        </Callout>
      )}

      {d && e.state !== 'retired' && <AskEmployee orgId={orgId} employee={e} definition={d} />}

      <Tabs value={tab} onChange={setTab}>
        <TabList label={t('employees.tabs.label', { name })}>
          <Tab value="overview">{t('employees.tabs.overview')}</Tab>
          <Tab value="tasks">{t('employees.tabs.tasks')}</Tab>
          <Tab value="runs">{t('employees.tabs.runs')}</Tab>
          <Tab value="triggers">{t('employees.tabs.triggers')}</Tab>
        </TabList>
        <TabPanel value="triggers" className="employee-tab">
          <TriggersTab orgId={orgId} employee={e} />
        </TabPanel>
        <TabPanel value="tasks" className="employee-tab">
          <EmployeeTasks orgId={orgId} employee={e} />
        </TabPanel>
        <TabPanel value="runs" className="employee-tab">
          <EmployeeRuns orgId={orgId} employee={e} />
        </TabPanel>
        <TabPanel value="overview" className="employee-tab">
          {d && (
            <div className="employee-sections">
              {d.description && <p className="employee-description">{d.description}</p>}
              <Card as="section" className="employee-section" aria-labelledby="employee-duties">
                <h3 id="employee-duties" className="employee-subheading">
                  {t('employees.field.responsibilities')}
                </h3>
                {d.responsibilities.length ? (
                  <ul className="employee-plan-bullets">
                    {d.responsibilities.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="employee-faint">{t('employees.employee.noResponsibilities')}</p>
                )}
                {d.personality && <p className="employee-faint">{t('employees.employee.personality', { personality: d.personality })}</p>}
                {d.ask_me_about && <p className="employee-faint">{t('employees.employee.askMeAbout', { topics: d.ask_me_about })}</p>}
              </Card>
              <Card as="section" className="employee-section" aria-labelledby="employee-can">
                <h3 id="employee-can" className="employee-subheading">
                  {t('employees.can.heading', { name })}
                </h3>
                <CanDo value={d} repos={repos} others={others} heading={t('employees.can.heading', { name })} />
              </Card>
              <Card as="section" className="employee-section" aria-labelledby="employee-actions">
                <h3 id="employee-actions" className="employee-subheading">
                  {t('employees.rules.heading')}
                </h3>
                <ActionRules definition={d} />
              </Card>
              <Card as="section" className="employee-section" aria-labelledby="employee-approval">
                <h3 id="employee-approval" className="employee-subheading">
                  {t('employees.employee.approval')}
                </h3>
                <p>
                  {e.approvedAt && e.state !== 'draft'
                    ? t('employees.employee.approvedAt', { date: formatDateTime(e.approvedAt, t.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) })
                    : t('employees.employee.notApproved')}
                </p>
                <p className="employee-faint">{t('employees.employee.model', { model: modelText(d.model.agent, d.model.model, t) })}</p>
                <p className="employee-faint">{t('employees.employee.memoryBody', { folder: `${employeeMemoryFolder(e.id)}/`, memory })}</p>
                <p className="employee-faint">{t('employees.edit.file', { path: e.path, memory })}</p>
              </Card>
              <Disclosure label={t('employees.field.instructions')}>
                {d.instructions ? (
                  <div className="employee-instructions">
                    <Markdown text={d.instructions} />
                  </div>
                ) : (
                  <p className="employee-faint">{t('employees.employee.noInstructions')}</p>
                )}
              </Disclosure>
            </div>
          )}
        </TabPanel>
      </Tabs>

      {approveOpen && d && e.fingerprint && (
        <ApproveDialog
          definition={d}
          memory={memory}
          names={names}
          onClose={() => setApproveOpen(false)}
          onConfirm={async () => {
            await api.approveEmployee(orgId, e.id, e.fingerprint)
            setApproveOpen(false)
            showToast(t('employees.approve.done', { name }))
            data.reload()
          }}
        />
      )}
      {retireOpen && (
        <Dialog
          title={t('employees.retire.title', { name })}
          closeLabel={t('common.close')}
          onClose={() => setRetireOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRetireOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRetireOpen(false)
                  void attempt(() => api.retireEmployee(orgId, e.id))
                }}
              >
                {t('employees.retire.confirm')}
              </Button>
            </>
          }
        >
          <p>{t('employees.retire.body', { name })}</p>
        </Dialog>
      )}
    </div>
  )
}

/** What changed in the file since it was approved: changed lines with one line around each, the rest folded. */
export function DefinitionDiff({ before, after, path }: { before: string; after: string; path: string }) {
  const t = useT()
  const changes = quoteChanges(before.replace(/\n$/, '').split('\n'), after.replace(/\n$/, '').split('\n'), 1)
  const near = (i: number) => changes.slice(Math.max(0, i - 1), i + 2).some((c) => c.kind !== 'same')
  const rows: ({ kind: 'same' | 'add' | 'del'; text: string } | null)[] = []
  changes.forEach((c, i) => {
    if (c.kind !== 'same' || near(i)) rows.push(c)
    else if (rows[rows.length - 1] !== null) rows.push(null)
  })
  return (
    <ol className="employee-diff" aria-label={t('employees.employee.diff', { path })}>
      {rows.map((row, i) =>
        row === null ? (
          <li key={i} className="employee-diff-gap" aria-hidden>
            …
          </li>
        ) : (
          <li key={i} className="employee-diff-line mono">
            <span aria-hidden>{row.kind === 'add' ? '+ ' : row.kind === 'del' ? '− ' : '  '}</span>
            {row.kind !== 'same' && <span className="sr-only">{row.kind === 'add' ? t('employees.diff.added') : t('employees.diff.removed')} </span>}
            {row.text || ' '}
          </li>
        )
      )}
    </ol>
  )
}

/** The precise form for every field (§5.3: the step-by-step form survives as Edit). */
function EmployeeEdit({ orgId, employee, definition, repos, memory, data }: { orgId: string; employee: EmployeeView; definition: EmployeeDefinition; repos: string[]; memory: string; data: EmployeesData }) {
  const t = useT()
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees ?? [])
  const [draft, setDraft] = useState<EmployeeDefinition>(definition)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const others = roster.filter((o) => o.id !== employee.id).map((o) => ({ id: o.id, name: o.name }))
  const worn = roster.filter((o) => o.id !== employee.id && o.state !== 'retired' && o.colour).map((o) => ({ colour: o.colour, name: o.name || o.id }))
  const nameProblem = employeeNameProblem(draft.name, others, employee.id)
  const nameError = nameProblem === 'empty' ? t('employees.name.empty') : nameProblem === 'long' ? t('employees.name.long') : nameProblem === 'taken' ? t('employees.name.taken') : undefined
  const problems = employeeProblems({ ...draft, name: draft.name.trim() || draft.id }, t)
  const approved = employee.state === 'active' || employee.state === 'paused'
  const close = () => openEmployees({ orgId, page: 'employee', id: employee.id })
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const result = await api.updateEmployee(orgId, employee.id, draft, employee.blob)
      if (!result.ok) {
        setConflict(true)
        return
      }
      showToast(t('employees.edit.saved', { path: employee.path }))
      data.reload()
      close()
    } catch (err) {
      setError(message(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="employee-page">
      <h2 className="employee-name">{t('employees.edit.title', { name: employee.name || employee.id })}</h2>
      {approved && <Callout tone="info">{t('employees.edit.reapprove')}</Callout>}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      {conflict && (
        <Callout
          tone="warn"
          role="alert"
          title={t('employees.edit.conflictTitle')}
          actions={
            <Button
              size="sm"
              onClick={() => {
                setConflict(false)
                data.reload()
                close()
              }}
            >
              {t('employees.edit.reload')}
            </Button>
          }
        >
          {t('employees.edit.conflict', { path: employee.path })}
        </Callout>
      )}
      <Card as="section" className="employee-section" aria-labelledby="employee-edit-who">
        <h3 id="employee-edit-who" className="employee-subheading">
          {t('employees.edit.sectionWho')}
        </h3>
        <WordFields value={draft} onChange={setDraft} nameError={nameError} />
        <Disclosure label={t('employees.draft.hat', { colour: colourName(draft.look.colour, t) })}>
          <HatPicker legend={t('employees.hat.legend')} value={draft.look.colour} onChange={(colour) => setDraft({ ...draft, look: { family: 'hardhat', colour } })} worn={worn} />
        </Disclosure>
      </Card>
      <Card as="section" className="employee-section" aria-labelledby="employee-edit-instructions">
        <h3 id="employee-edit-instructions" className="employee-subheading">
          {t('employees.field.instructions')}
        </h3>
        <InstructionsField value={draft.instructions} onChange={(instructions) => setDraft({ ...draft, instructions })} />
        <Field label={t('employees.field.persona')} description={t('employees.field.personaHint')}>
          {(c) => (
            <TextInput
              {...c}
              mono
              value={draft.persona ?? ''}
              onChange={(ev) => {
                const { persona: _persona, ...rest } = draft
                setDraft(ev.target.value ? { ...rest, persona: ev.target.value } : rest)
              }}
            />
          )}
        </Field>
      </Card>
      <Card as="section" className="employee-section" aria-labelledby="employee-edit-access">
        <h3 id="employee-edit-access" className="employee-subheading">
          {t('employees.edit.sectionAccess')}
        </h3>
        <AccessFields value={draft} onChange={setDraft} sections={['model', 'repos', 'memory', 'profile', 'actions', 'limits']} repos={repos} others={others} />
      </Card>
      <Card as="section" className="employee-section" aria-labelledby="employee-edit-triggers">
        <h3 id="employee-edit-triggers" className="employee-subheading">
          {t('employees.tabs.triggers')}
        </h3>
        <TriggersField value={draft} onChange={setDraft} approved={approved} />
      </Card>
      {problems.length > 0 && (
        <Callout tone="warn" role="status" title={t('employees.new.problems')}>
          <ul className="employee-plan-bullets">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="new-employee-footer">
        <span className="employee-faint">{t('employees.edit.file', { path: employee.path, memory })}</span>
        <Button variant="ghost" disabled={saving} onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={saving || conflict || Boolean(nameProblem) || problems.length > 0} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  )
}
