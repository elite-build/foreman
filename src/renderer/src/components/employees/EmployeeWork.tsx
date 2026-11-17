// An employee's work in the window (docs/ai-employees.md §6, §10): Ask <name> and Run now on its page, its Tasks and Runs
// tabs, and a task's Stop, Retry and Cancel. What waits for a person is a decision (EmployeeDecisions.tsx). Every task and
// run is read from the main process (the snapshot carries only the work not yet over), read again whenever the
// organization's work moves.
import { useCallback, useEffect, useRef, useState } from 'react'
import { RECEIPT_STAGES, receipts, type ReceiptStage } from '../../../../shared/employeeBroker'
import { canCancelTask, canRetryTask, isRunActive, isRunGoing, workableRepos, type EmployeeRun, type EmployeeTask, type EmployeeTaskChain } from '../../../../shared/employeeWork'
import { employeeStatus, type EmployeeDefinition, type EmployeeSummary } from '../../../../shared/employees'
import { formatDateTime, timeAgo } from '../../../../shared/i18n/time'
import { memoryArtifacts } from '../../../../shared/memory'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { formatChord } from '../../shortcuts'
import { api, attempt, selectWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Card, Disclosure, Field, Kbd, LinkButton, Select, Spinner, Status, Stepper, TextArea, TextInput, type StepperStep } from '../../ui'
import { formatDuration } from '../turnResult'
import { ActionLog } from './HeldActions'
import { PageLinks } from './PageLinks'
import { ACCESS_LABEL, activityText, holdText, modelText, RUN_LABEL, RUN_TONE, taskWord } from './words'

export { EmployeesNeedYou } from './EmployeeDecisions'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The organization's work revision: it moves whenever a task or run of it does. */
function useWorkRevision(orgId: string): number {
  return useStore((s) => s.snapshot!.employeeWork?.[orgId]?.revision ?? 0)
}

/** Tasks and runs read from main, again whenever the organization's work moves. */
export function useEmployeeWork(orgId: string, employeeId?: string): { tasks: EmployeeTask[] | null; runs: EmployeeRun[] | null; error: string; reload: () => void } {
  const revision = useWorkRevision(orgId)
  const [tasks, setTasks] = useState<EmployeeTask[] | null>(null)
  const [runs, setRuns] = useState<EmployeeRun[] | null>(null)
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)
  const reload = useCallback(() => setRound((n) => n + 1), [])
  useEffect(() => {
    let live = true
    Promise.all([api.listEmployeeTasks(orgId, employeeId), api.listEmployeeRuns(orgId, employeeId)]).then(
      ([t, r]) => {
        if (!live) return
        setTasks(t ?? [])
        setRuns(r ?? [])
        setError('')
      },
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [orgId, employeeId, revision, round])
  return { tasks, runs, error, reload }
}

// ---- Ask <name>… and Run now ----

/** Why an employee can't be asked anything now, or null. A paused one can: the work waits for Resume. */
function cantAsk(e: Pick<EmployeeSummary, 'problems' | 'state' | 'changed'>): 'invalid' | 'retired' | 'changed' | 'draft' | null {
  const status = employeeStatus(e)
  return status === 'invalid' || status === 'retired' || status === 'changed' || status === 'draft' ? status : null
}

const CANT_ASK = {
  invalid: 'employees.ask.cantRun.invalid',
  retired: 'employees.ask.cantRun.retired',
  changed: 'employees.ask.cantRun.changed',
  draft: 'employees.ask.cantRun.draft'
} as const

/**
 * Ask <name>, on one line: what to do (Ctrl+Enter asks), the repository when it has more than one, Ask and Run now. An
 * empty ask says what is missing at the field instead of a button that does nothing.
 */
export function AskEmployee({ orgId, employee, definition }: { orgId: string; employee: EmployeeSummary; definition: EmployeeDefinition }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const organization = snapshot.organizations?.find((o) => o.id === orgId)
  const repos = workableRepos(definition, reposInSpace(snapshot.repos, snapshot.organizations ?? [], orgId).filter((r) => r.id !== organization?.memoryRepoId))
  const [body, setBody] = useState('')
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [empty, setEmpty] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const name = employee.name || employee.id
  const blocked = cantAsk(employee)
  const repo = repos.some((r) => r.id === repoId) ? repoId : (repos[0]?.id ?? '')
  const said = (task: EmployeeTask) => {
    if (task.state === 'waiting') showToast(t('employees.ask.refused', { name, reason: task.reason ?? '' }))
    else if (task.state === 'open') showToast(t('employees.ask.held', { name, reason: holdText(task, t) ?? '' }))
    else showToast(t('employees.ask.sent', { name, title: task.title }))
  }
  const send = async (run: () => Promise<EmployeeTask>, clear: boolean) => {
    setBusy(true)
    setError('')
    try {
      said(await run())
      if (clear) setBody('')
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const ask = () => {
    if (!body.trim()) {
      setEmpty(true)
      field.current?.focus()
      return
    }
    void send(() => api.askEmployee(orgId, employee.id, { body, repoId: repo }), true)
  }
  return (
    <Card as="section" className="employee-section employee-ask" aria-labelledby={`ask-${employee.id}`}>
      <h3 id={`ask-${employee.id}`} className="sr-only">
        {t('employees.ask.heading', { name })}
      </h3>
      {blocked ? (
        <Callout tone="info">{t(CANT_ASK[blocked], { name })}</Callout>
      ) : !repos.length ? (
        <Callout tone="info">{t('employees.ask.noRepo', { name })}</Callout>
      ) : (
        <>
          {employee.state === 'paused' && <Callout tone="warn">{t('employees.ask.paused', { name })}</Callout>}
          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}
          <div className="employee-ask-line">
            <Field label={t('employees.ask.heading', { name })} error={empty && !body.trim() ? t('employees.ask.empty', { name }) : undefined} className="employee-ask-field">
              {(c) => (
                <TextInput
                  {...c}
                  ref={field}
                  value={body}
                  placeholder={t('employees.ask.placeholder')}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
                      e.preventDefault()
                      ask()
                    }
                  }}
                />
              )}
            </Field>
            {repos.length > 1 && (
              <Field label={t('employees.ask.repo')}>
                {(c) => <Select {...c} value={repo} options={repos.map((r) => ({ value: r.id, label: t('employees.ask.repoOption', { repo: r.name, access: t(ACCESS_LABEL[r.access]) }) }))} onChange={setRepoId} />}
              </Field>
            )}
            <span className="employee-ask-buttons">
              <Button variant="primary" disabled={busy} onClick={ask}>
                {busy ? t('employees.ask.sending') : t('employees.ask.submit')} <Kbd>{formatChord('mod+Enter', snapshot.platform)}</Kbd>
              </Button>
              <Button disabled={busy} onClick={() => void send(() => api.runEmployeeNow(orgId, employee.id, { repoId: repo }), false)}>
                {t('employees.ask.runNow')}
              </Button>
            </span>
          </div>
          <span className="employee-faint">{t('employees.ask.runNowHint', { name })}</span>
        </>
      )}
    </Card>
  )
}

// ---- a task ----

/** The workspace of the task's latest run, while Foreman still has it (archived ones open read-only). */
function useTaskWorkspace(task: Pick<EmployeeTask, 'id' | 'orgId'>): string | undefined {
  return useStore((s) => {
    const made = s.snapshot!.workspaces.filter((w) => w.startedBy?.via === 'employee' && w.startedBy.taskId === task.id && w.startedBy.orgId === task.orgId)
    return made.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id
  })
}

/** Stop its going run, Retry, Cancel, and its workspace; for a chain out of runs (§7), Raise limit and Cancel chain. */
function TaskActions({ task, runs }: { task: EmployeeTask; runs: EmployeeRun[] }) {
  const t = useT()
  const going = runs.find((r) => r.taskId === task.id && isRunActive(r.state))
  const workspace = useTaskWorkspace(task)
  const spent = task.state === 'open' && task.hold === 'root-limit'
  return (
    <div className="employee-card-actions">
      {going && !spent && (
        <Button size="sm" onClick={() => void attempt(() => api.stopEmployeeRun(going.id))}>
          {t('employees.task.stop')}
        </Button>
      )}
      {spent && (
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void attempt(async () => {
              const ledger = await api.raiseEmployeeRootLimit(task.rootId)
              showToast(t('employees.chain.raised', { runs: ledger.runsAllowed }))
            })
          }
        >
          {t('employees.chain.raise')}
        </Button>
      )}
      {canRetryTask(task) && (
        <Button size="sm" variant="primary" onClick={() => void attempt(() => api.retryEmployeeTask(task.id))}>
          {t('employees.task.retry')}
        </Button>
      )}
      {spent ? (
        <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.cancelEmployeeTask(task.rootId))}>
          {t('employees.chain.cancel')}
        </Button>
      ) : (
        canCancelTask(task) && (
          <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.cancelEmployeeTask(task.id))}>
            {t('employees.task.cancel')}
          </Button>
        )
      )}
      {workspace && (
        <LinkButton size="sm" underline onClick={() => selectWorkspace(workspace)}>
          {t('employees.task.openWorkspace')}
        </LinkButton>
      )}
    </div>
  )
}

const RECEIPT_LABEL: Record<ReceiptStage, 'employees.receipts.saved' | 'employees.receipts.delivered' | 'employees.receipts.started' | 'employees.receipts.completed'> = {
  saved: 'employees.receipts.saved',
  delivered: 'employees.receipts.delivered',
  started: 'employees.receipts.started',
  completed: 'employees.receipts.completed'
}

/**
 * A task's chain and receipts (docs/ai-employees.md §6.5, §7), read when opened and again as the work moves: the task it
 * was handed off from, those handed off from it with their states, its chain's runs, and saved → delivered → started →
 * completed (a started task never reads as completed).
 */
export function TaskChain({ task }: { task: Pick<EmployeeTask, 'id' | 'orgId' | 'state' | 'updatedAt'> }) {
  const t = useT()
  const revision = useWorkRevision(task.orgId)
  const roster = useStore((s) => s.snapshot!.employees?.[task.orgId]?.employees ?? [])
  const [chain, setChain] = useState<EmployeeTaskChain | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.employeeTaskChain(task.id).then(
      (c) => live && setChain(c ?? null),
      (err: unknown) => live && setError(message(err))
    )
    return () => {
      live = false
    }
  }, [task.id, task.updatedAt, revision])
  if (error)
    return (
      <Callout tone="error" role="alert">
        {error}
      </Callout>
    )
  if (!chain)
    return (
      <div className="employees-loading" role="status">
        <Spinner size={13} /> <span>{t('common.loading')}</span>
      </div>
    )
  const name = (id: string) => roster.find((e) => e.id === id)?.name || id
  const reached = receipts(chain.transitions)
  const next = RECEIPT_STAGES.find((s) => !reached[s])
  const steps: StepperStep[] = RECEIPT_STAGES.map((stage) => ({
    id: stage,
    label: (
      <>
        {t(RECEIPT_LABEL[stage])}
        {reached[stage] && <span className="employee-faint"> {formatDateTime(reached[stage]!, t.locale, { hour: '2-digit', minute: '2-digit' })}</span>}
      </>
    ),
    status: reached[stage] ? 'done' : stage === next && chain.task.state !== 'closed' ? 'current' : 'upcoming'
  }))
  const parent = chain.parent
  return (
    <div className="employee-chain">
      {parent && (
        <p className="employee-chain-line">
          <span>{t('employees.chain.from', { name: name(parent.employeeId), title: parent.title })}</span> <Status tone={taskWord(parent).tone} label={t(taskWord(parent).label)} />
        </p>
      )}
      {chain.children.length > 0 && (
        <ul className="employee-chain-list" aria-label={t('employees.chain.children')}>
          {chain.children.map((c) => (
            <li key={c.id} className="employee-chain-line">
              <Status tone={taskWord(c).tone} label={t(taskWord(c).label)} />
              <span>{t('employees.task.who', { name: name(c.employeeId), title: c.title })}</span>
            </li>
          ))}
        </ul>
      )}
      {chain.root && (parent || chain.children.length > 0 || chain.root.descendants > 0) && (
        <p className="employee-faint">{t('employees.chain.runs', { used: chain.root.runsUsed, allowed: chain.root.runsAllowed })}</p>
      )}
      <Stepper label={t('employees.receipts.label')} steps={steps} statusText={{ done: t('employees.receipts.done'), upcoming: t('employees.receipts.upcoming') }} />
      <ActionLog actions={chain.actions ?? []} />
    </div>
  )
}

/** One task: its state in a glyph and a word, its title, why it is held, waiting or closed, its result, and what can be done. */
export function TaskRow({ task, runs, who }: { task: EmployeeTask; runs: EmployeeRun[]; who?: string }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === task.targetRepoId)?.name)
  const root = useStore((s) => s.snapshot!.employeeWork?.[task.orgId]?.roots?.[task.rootId])
  const [open, setOpen] = useState(false)
  const word = taskWord(task)
  const attempts = runs.filter((r) => r.taskId === task.id && r.state !== 'queued').length
  const why = task.state === 'closed' ? task.closureDetail : holdText(task, t)
  // Part of a chain of work (§7): who handed it over, and how many of its chain's runs are used.
  const chained = Boolean(task.parentId || (root && root.descendants > 0))
  return (
    <Card as="li" className="employee-task">
      <div className="employee-task-head">
        <Status tone={word.tone} label={t(word.label)} />
        <span className="employee-task-title">{who ? t('employees.task.who', { name: who, title: task.title }) : task.title}</span>
      </div>
      {why && !task.question && <p className="employee-task-why">{why}</p>}
      {task.question && <p className="employee-task-why">{activityText({ current: task, running: false, needsYou: 1, queued: 0 }, t)}</p>}
      {task.resultSummary && <p className="employee-task-result">{task.resultSummary}</p>}
      <PageLinks orgId={task.orgId} files={memoryArtifacts(task.result?.artifacts)} />
      <span className="employee-faint">
        {[
          task.requestedBy ? t(task.kind === 'message' ? 'employees.chain.sentBy' : 'employees.chain.askedBy', { name: task.requestedBy.name }) : '',
          repo ? t('employees.task.repo', { repo }) : '',
          task.from === 'event' && task.event
            ? t('employees.task.fromEvent', { what: task.event.subjects.join(t('employees.list.separator')) })
            : task.trigger ? t('employees.task.fromTrigger', { when: formatDateTime(task.trigger.plannedAt, t.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : '',
          t('employees.task.created', { when: timeAgo(task.createdAt, t.locale) }),
          attempts ? t('employees.task.attempts', { count: attempts }) : '',
          root && chained ? t('employees.chain.runs', { used: root.runsUsed, allowed: root.runsAllowed }) : ''
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <Disclosure quiet label={t('employees.chain.details')} open={open} onOpenChange={setOpen}>
        {open && <TaskChain task={task} />}
      </Disclosure>
      {task.state === 'closed' && task.closureReason !== 'canceled' && <FollowUp task={task} who={who} />}
      <TaskActions task={task} runs={runs} />
    </Card>
  )
}

/**
 * Ask a follow-up of a finished task's employee (docs/ai-employees.md §15: an employee doesn't disappear once its task is
 * done): a new task for them in the same chain, reading what this one said and the memory it named.
 */
function FollowUp({ task, who }: { task: EmployeeTask; who?: string }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[task.orgId]?.employees.find((e) => e.id === task.employeeId)?.name) || who || task.employeeId
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const ask = () => {
    if (!question.trim() || busy) return
    setBusy(true)
    void attempt(async () => {
      await api.askEmployeeFollowUp(task.id, question)
      setQuestion('')
      setOpen(false)
      showToast(t('projects.followUp.sent', { name }))
    }).finally(() => setBusy(false))
  }
  return (
    <Disclosure quiet label={t('employees.followUp.open')} open={open} onOpenChange={setOpen}>
      <div className="employee-follow-up">
        <Field label={t('projects.followUp.label', { name })} description={t('employees.followUp.hint')}>
          {(control) => <TextArea {...control} rows={2} value={question} placeholder={t('projects.followUp.placeholder')} onChange={(e) => setQuestion(e.target.value)} />}
        </Field>
        <div className="employee-card-actions">
          <Button size="sm" disabled={!question.trim() || busy} onClick={ask}>
            {busy ? t('employees.ask.sending') : t('projects.followUp.ask')}
          </Button>
        </div>
      </div>
    </Disclosure>
  )
}

export function EmployeeTasks({ orgId, employee }: { orgId: string; employee: EmployeeSummary }) {
  const t = useT()
  const { tasks, runs, error } = useEmployeeWork(orgId, employee.id)
  const name = employee.name || employee.id
  if (error)
    return (
      <Callout tone="error" role="alert">
        {error}
      </Callout>
    )
  if (!tasks || !runs)
    return (
      <div className="employees-loading" role="status">
        <Spinner size={13} /> <span>{t('common.loading')}</span>
      </div>
    )
  if (!tasks.length) return <p className="employee-faint">{t('employees.tasks.empty', { name })}</p>
  return (
    <ul className="employee-work-list" aria-label={t('employees.tasks.label', { name })}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} runs={runs} />
      ))}
    </ul>
  )
}

// ---- a run ----

function RunRow({ run, task }: { run: EmployeeRun; task?: EmployeeTask }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === run.repoId)?.name)
  const exists = useStore((s) => Boolean(run.workspaceId && s.snapshot!.workspaces.some((w) => w.id === run.workspaceId)))
  const access = run.access === 'read' ? t('employees.run.readOnly') : run.access === 'write' ? (run.profile === 'shell' ? t('employees.run.shell') : t('employees.run.noShell')) : ''
  const facts = [
    repo ? `${repo}${access ? ` (${access})` : ''}` : '',
    run.agent ? modelText(run.agent, run.model, t) : '',
    run.startedAt ? t('employees.run.started', { when: timeAgo(run.startedAt, t.locale) }) : '',
    run.usage?.durationMs ? t('employees.run.duration', { duration: formatDuration(run.usage.durationMs) }) : ''
  ].filter(Boolean)
  const memory = [run.memoryBase ? t('employees.run.memoryBase', { commit: run.memoryBase.slice(0, 7) }) : '', run.memoryCommit ? t('employees.run.memoryCommit', { commit: run.memoryCommit.slice(0, 7) }) : ''].filter(Boolean)
  return (
    <Card as="li" className="employee-task">
      <div className="employee-task-head">
        <Status tone={RUN_TONE[run.state]} label={t(RUN_LABEL[run.state])} />
        <span className="employee-task-title">{t('employees.run.attempt', { n: run.attempt, task: task?.title ?? run.taskId })}</span>
      </div>
      {run.reason && <p className="employee-task-why">{run.reason}</p>}
      {facts.length > 0 && <span className="employee-faint">{facts.join(' · ')}</span>}
      {memory.length > 0 && <span className="employee-faint mono">{memory.join(' · ')}</span>}
      <div className="employee-card-actions">
        {isRunGoing(run.state) || run.state === 'queued' ? (
          <Button size="sm" onClick={() => void attempt(() => api.stopEmployeeRun(run.id))}>
            {t('employees.task.stop')}
          </Button>
        ) : null}
        {run.workspaceId && exists && (
          <LinkButton size="sm" underline onClick={() => selectWorkspace(run.workspaceId!)}>
            {t('employees.task.openWorkspace')}
          </LinkButton>
        )}
      </div>
    </Card>
  )
}

export function EmployeeRuns({ orgId, employee }: { orgId: string; employee: EmployeeSummary }) {
  const t = useT()
  const { tasks, runs, error } = useEmployeeWork(orgId, employee.id)
  const name = employee.name || employee.id
  if (error)
    return (
      <Callout tone="error" role="alert">
        {error}
      </Callout>
    )
  if (!tasks || !runs)
    return (
      <div className="employees-loading" role="status">
        <Spinner size={13} /> <span>{t('common.loading')}</span>
      </div>
    )
  if (!runs.length) return <p className="employee-faint">{t('employees.runs.empty')}</p>
  return (
    <ul className="employee-work-list" aria-label={t('employees.runs.label', { name })}>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} task={tasks.find((x) => x.id === run.taskId)} />
      ))}
    </ul>
  )
}
