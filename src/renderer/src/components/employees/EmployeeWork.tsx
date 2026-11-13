// An employee's work in the window (docs/ai-employees.md §6, §10): Ask <name>… and Run now on its page, its Tasks and Runs
// tabs, the Team page's Needs you list, and a task's Stop, Retry and Cancel. Every task and run is read from the main
// process (the snapshot carries only the work not yet over), read again whenever the organization's work moves.
import { useCallback, useEffect, useState } from 'react'
import { RECEIPT_STAGES, receipts, type ReceiptStage } from '../../../../shared/employeeBroker'
import { canCancelTask, canRetryTask, isRunActive, isRunGoing, needsPerson, workableRepos, type EmployeeRun, type EmployeeTask, type EmployeeTaskChain } from '../../../../shared/employeeWork'
import { employeeStatus, type EmployeeDefinition, type EmployeeSummary } from '../../../../shared/employees'
import { formatDateTime, timeAgo } from '../../../../shared/i18n/time'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, selectWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Card, Disclosure, Field, LinkButton, RadioList, Select, Spinner, Status, Stepper, TextArea, type StepperStep } from '../../ui'
import { formatDuration } from '../turnResult'
import { ActionLog, HeldActions } from './HeldActions'
import { MemoryProposals } from './MemoryProposals'
import { ACCESS_LABEL, holdText, modelText, RUN_LABEL, RUN_TONE, taskWord } from './words'

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

export function AskEmployee({ orgId, employee, definition }: { orgId: string; employee: EmployeeSummary; definition: EmployeeDefinition }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const organization = snapshot.organizations?.find((o) => o.id === orgId)
  const repos = workableRepos(definition, reposInSpace(snapshot.repos, snapshot.organizations ?? [], orgId).filter((r) => r.id !== organization?.memoryRepoId))
  const [body, setBody] = useState('')
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
  return (
    <Card as="section" className="employee-section" aria-labelledby={`ask-${employee.id}`}>
      <h3 id={`ask-${employee.id}`} className="employee-subheading">
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
          <Field label={t('employees.ask.label', { name })}>{(c) => <TextArea {...c} rows={4} value={body} placeholder={t('employees.ask.placeholder')} onChange={(e) => setBody(e.target.value)} />}</Field>
          <Field label={t('employees.ask.repo')} description={t('employees.ask.repoHint', { name })}>
            {(c) => <Select {...c} value={repo} options={repos.map((r) => ({ value: r.id, label: t('employees.ask.repoOption', { repo: r.name, access: t(ACCESS_LABEL[r.access]) }) }))} onChange={setRepoId} />}
          </Field>
          <div className="employee-card-actions">
            <Button variant="primary" disabled={busy || !body.trim()} onClick={() => void send(() => api.askEmployee(orgId, employee.id, { body, repoId: repo }), true)}>
              {busy ? t('employees.ask.sending') : t('employees.ask.submit')}
            </Button>
            <Button disabled={busy} onClick={() => void send(() => api.runEmployeeNow(orgId, employee.id, { repoId: repo }), false)}>
              {t('employees.ask.runNow')}
            </Button>
            <span className="employee-faint">{t('employees.ask.runNowHint', { name })}</span>
          </div>
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

/**
 * The question a task waits on (ask_person, docs/ai-employees.md §6.4): the employee's words, its options as choices
 * beside an answer in your own words, and Send. One answer per question: it starts the task's next run. It never
 * approves anything.
 */
export function QuestionForm({ task }: { task: EmployeeTask }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[task.orgId]?.employees.find((e) => e.id === task.employeeId)?.name) || task.employeeId
  const question = task.question!
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = question.options
  const picked = choice !== undefined && choice !== 'own' ? options[Number(choice)] : undefined
  const answer = (options.length ? picked ?? (choice === 'own' ? own : '') : own).trim()
  const ownField = (
    <Field label={t(options.length ? 'employees.question.own' : 'employees.question.answer')}>
      {(c) => <TextArea {...c} rows={3} value={own} onChange={(e) => setOwn(e.target.value)} />}
    </Field>
  )
  const send = async () => {
    setBusy(true)
    setError('')
    try {
      await api.answerEmployeeQuestion(task.id, question.id, answer)
      showToast(t('employees.question.sent', { name }))
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="employee-question">
      <p className="employee-question-text">
        <strong>{t('employees.question.asks', { name })}</strong> {question.question}
      </p>
      {options.length > 0 ? (
        <RadioList
          legend={t('employees.question.choose')}
          value={choice}
          onChange={setChoice}
          options={[...options.map((o, i) => ({ value: String(i), label: o })), { value: 'own', label: t('employees.question.ownOption'), ...(choice === 'own' ? { extra: ownField } : {}) }]}
        />
      ) : (
        ownField
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      <div className="employee-card-actions">
        <Button size="sm" variant="primary" disabled={busy || !answer} onClick={() => void send()}>
          {busy ? t('employees.question.sending') : t('employees.question.send')}
        </Button>
        <span className="employee-faint">{t('employees.question.hint')}</span>
      </div>
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
      {task.question && <QuestionForm task={task} />}
      {task.resultSummary && <p className="employee-task-result">{task.resultSummary}</p>}
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
      <TaskActions task={task} runs={runs} />
    </Card>
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

// ---- Needs you ----

/**
 * The organization's tasks that wait for a person (a question to answer, a denied approval, an uncertain run, a
 * refusal), with Answer, Retry and Cancel; the outward actions held for them (§9), with Send, Edit then send and Skip;
 * and the memory changes its employees proposed, with Keep and Retire.
 */
export function EmployeesNeedYou({ orgId }: { orgId: string }) {
  const t = useT()
  const view = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees ?? [])
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  // A question, a refusal or an uncertain run, or a chain out of runs (§7); not work waiting on other employees.
  const waiting = (view?.tasks ?? []).filter(needsPerson)
  // Paused after two runs in a row didn't finish (§9): it waits for a person to look and resume it.
  const failing = roster.filter((e) => e.state === 'paused' && e.pausedKind === 'failures')
  if (!waiting.length && !view?.proposals?.length && !view?.actions?.length && !failing.length) return null
  const runs = view?.runs ?? []
  return (
    <section className="team-needs-you" aria-labelledby={`needs-you-${orgId}`}>
      <h2 id={`needs-you-${orgId}`} className="employee-subheading">
        {t('employees.needsYou.heading')}
      </h2>
      {failing.map((e) => (
        <Callout
          key={e.id}
          tone="warn"
          role="status"
          title={t('employees.employee.failuresTitle', { name: e.name || e.id })}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => openEmployees({ orgId, page: 'employee', id: e.id })}>
                {t('employees.needsYou.open')}
              </Button>
              <Button size="sm" onClick={() => void attempt(() => api.resumeEmployee(orgId, e.id))}>
                {t('employees.action.resume')}
              </Button>
            </>
          }
        >
          {e.pausedDetail ? t('employees.employee.failuresBody', { detail: e.pausedDetail }) : t('employees.employee.failuresBodyPlain')}
        </Callout>
      ))}
      {waiting.length > 0 && (
        <ul className="employee-work-list" aria-label={t('employees.needsYou.label', { organization: organization?.name ?? '' })}>
          {waiting.map((task) => (
            <TaskRow key={task.id} task={task} runs={runs} who={roster.find((e) => e.id === task.employeeId)?.name || task.employeeId} />
          ))}
        </ul>
      )}
      <HeldActions orgId={orgId} />
      <MemoryProposals orgId={orgId} headingLevel={3} />
    </section>
  )
}
