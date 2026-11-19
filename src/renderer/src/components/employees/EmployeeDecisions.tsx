// What of an organization's AI employees waits for a person (docs/ai-employees.md §6.4, §9, §10), as decisions drawn by
// components/DecisionCard.tsx: an employee's question, a task that needs a person (a refusal, a run Foreman isn't sure
// about, a chain out of runs), an employee paused after two failed runs, a held outward action and a memory proposal.
// The same decision is a card on an employee's page and in its run, and a row that opens into the card in the Team
// page's lists. Read from the snapshot (shared/employeeDecisions.ts merges and orders them).
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { needsYouItems, runItems, type NeedsYouItem } from '../../../../shared/employeeDecisions'
import { canCancelTask, canRetryTask, type EmployeeTask } from '../../../../shared/employeeWork'
import { projectTaskRetryable } from '../../../../shared/projects'
import type { EmployeeSummary } from '../../../../shared/employees'
import { timeAgo } from '../../../../shared/i18n/time'
import type { Workspace } from '../../../../shared/types'
import { announce } from '../../announce'
import { useT } from '../../i18n'
import { shortcutHint } from '../../shortcuts'
import { api, attempt, openEmployees, selectWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Field, Kbd, MenuButton, MenuItem, RadioList, TextArea } from '../../ui'
import { DecisionList, PlacedDecision, type DecisionPlace } from '../DecisionCard'
import { ActionDecision } from './HeldActions'
import { EmployeeWho, ProposalDecision } from './MemoryProposals'
import { holdText } from './words'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A decision, or an employee paused after two runs in a row didn't finish (§9): it waits for a person to resume it. */
export type DecisionItem = NeedsYouItem | { kind: 'paused'; id: string; employeeId: string; at: string; employee: EmployeeSummary }

/** The decisions of an organization (or of one employee), oldest first, with its employees paused for failures first. */
export function useDecisionItems(orgId: string, employeeId?: string): DecisionItem[] {
  const view = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees)
  const paused: DecisionItem[] = (roster ?? [])
    .filter((e) => e.state === 'paused' && e.pausedKind === 'failures' && (employeeId === undefined || e.id === employeeId))
    .map((e) => ({ kind: 'paused', id: `paused:${e.id}`, employeeId: e.id, at: '', employee: e }))
  return [...paused, ...needsYouItems(view, employeeId)]
}

/**
 * Whether a person's Retry may reopen the task (canRetryTask): a project's task only while its project still waits on
 * it (projectTaskRetryable); once the project went on, Try again is in its channel.
 */
export function useTaskRetryable(task: EmployeeTask | undefined): boolean {
  const projects = useStore((s) => (task?.project ? s.snapshot!.projects?.[task.orgId] : undefined))
  if (!task || !canRetryTask(task)) return false
  return projectTaskRetryable(task, task.project ? projects?.find((p) => p.id === task.project!.id) : undefined)
}

/** The workspace of the task's latest run, while Foreman still has it. */
function useTaskWorkspace(task: Pick<EmployeeTask, 'id' | 'orgId'>): string | undefined {
  return useStore((s) => {
    const made = s.snapshot!.workspaces.filter((w) => w.startedBy?.via === 'employee' && w.startedBy.taskId === task.id && w.startedBy.orgId === task.orgId)
    return made.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id
  })
}

/** More: Cancel task and Open its workspace, the acts a question card keeps out of its buttons. */
function TaskMore({ task }: { task: EmployeeTask }) {
  const t = useT()
  const workspace = useTaskWorkspace(task)
  if (!canCancelTask(task) && !workspace) return null
  return (
    <MenuButton
      label={t('employees.decision.more')}
      look="ghost"
      small
      trigger={
        <>
          <MoreHorizontal size={14} aria-hidden /> {t('employees.decision.more')}
        </>
      }
    >
      {workspace && <MenuItem onSelect={() => selectWorkspace(workspace)}>{t('employees.task.openWorkspace')}</MenuItem>}
      {canCancelTask(task) && <MenuItem onSelect={() => void attempt(() => api.cancelEmployeeTask(task.id))}>{t('employees.decision.cancelTask')}</MenuItem>}
    </MenuButton>
  )
}

const isTextField = (el: EventTarget) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['radio', 'checkbox'].includes(el.type))

/**
 * The question a task waits on (ask_person, §6.4): the employee's words, its options with keys 1 to n and an answer in
 * your own words, and Send answer (Enter, or Ctrl+Enter from the text box). One answer per question: it starts the
 * task's next run. Cancel task is under More.
 */
export function QuestionDecision({ task, place, who }: { task: EmployeeTask; place: DecisionPlace; who: ReactNode }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[task.orgId]?.employees.find((e) => e.id === task.employeeId)?.name) || task.employeeId
  const question = task.question!
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = question.options
  const picked = choice !== undefined && choice !== 'own' ? options[Number(choice)] : undefined
  const answer = (options.length ? (picked ?? (choice === 'own' ? own : '')) : own).trim()
  const ownField = (
    <Field label={t(options.length ? 'employees.question.own' : 'employees.question.answer')}>{(c) => <TextArea {...c} rows={3} value={own} onChange={(e) => setOwn(e.target.value)} />}</Field>
  )
  const send = async () => {
    if (!answer) return
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
  // Keys 1 to n pick an option, n+1 answers in your own words; never inside a text box.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!options.length || isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return
    const n = Number(e.key) - 1
    if (n < options.length) setChoice(String(n))
    else if (n === options.length) setChoice('own')
    else return
    e.preventDefault()
  }
  const body = (
    <div className="employee-question">
      <p className="employee-question-text">{t('employees.decision.question.said', { name, question: question.question })}</p>
      {options.length > 0 ? (
        <RadioList
          legend={t('employees.question.choose')}
          value={choice}
          onChange={setChoice}
          options={[
            ...options.map((o, i) => ({
              value: String(i),
              label: (
                <>
                  <Kbd aria-hidden="true">{i + 1}</Kbd> {o}
                </>
              )
            })),
            {
              value: 'own',
              label: (
                <>
                  <Kbd aria-hidden="true">{options.length + 1}</Kbd> {t('employees.question.ownOption')}
                </>
              ),
              ...(choice === 'own' ? { extra: ownField } : {})
            }
          ]}
        />
      ) : (
        ownField
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
    </div>
  )
  return (
    <PlacedDecision
      place={place}
      parts={{
        who,
        kind: t('decision.kind.question'),
        age: timeAgo(question.askedAt, t.locale),
        subject: question.question,
        children: body,
        onKeyDown,
        consequence: t('employees.decision.question.consequence', { name }),
        footStart: <TaskMore task={task} />,
        main: { label: busy ? t('employees.question.sending') : t('employees.question.send'), disabled: busy || !answer, onAct: () => void send() },
        rowAct: { label: t('decision.answer'), onAct: place.onToggle ?? (() => undefined) }
      }}
    />
  )
}

/**
 * A project's chain out of runs: Stop the project, asked first as the project's own Stop asks (its words), since its
 * chain's first task closed long ago and only the project can end what is left of it (§15).
 */
function StopProjectConfirm({ projectId, title, onDone }: { projectId: string; title: string; onDone: () => void }) {
  const t = useT()
  return (
    <Callout
      tone="warn"
      role="alert"
      title={t('projects.stop.title')}
      actions={
        <>
          <Button size="sm" onClick={onDone}>
            {t('projects.stop.keep')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void attempt(async () => {
                await api.stopProject(projectId)
                onDone()
                showToast(t('projects.stop.done', { title }))
              })
            }
          >
            {t('projects.action.stop')}
          </Button>
        </>
      }
    >
      {t('projects.stop.body')}
    </Callout>
  )
}

/**
 * A task that needs a person for another reason (§6.2, §7): a refusal or an ended run it can retry, a run Foreman closed
 * on (retry or cancel), a chain out of runs (raise its limit or cancel the chain; a project's: stop the project).
 */
export function TaskDecision({ task, place, who }: { task: EmployeeTask; place: DecisionPlace; who: ReactNode }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[task.orgId]?.employees.find((e) => e.id === task.employeeId)?.name) || task.employeeId
  const project = useStore((s) => (task.project ? s.snapshot!.projects?.[task.orgId]?.find((p) => p.id === task.project!.id) : undefined))
  const [stopping, setStopping] = useState(false)
  const spent = task.state === 'open' && task.hold === 'root-limit'
  // A project's chain is ended by stopping the project: its first task is closed, so canceling the chain would do nothing.
  const stopsProject = spent && Boolean(task.project) && project?.phase !== 'closed'
  const why = holdText(task, t)
  const retry = useTaskRetryable(task)
  const main = spent
    ? {
        label: t('employees.chain.raise'),
        onAct: () =>
          void attempt(async () => {
            const ledger = await api.raiseEmployeeRootLimit(task.rootId)
            showToast(t('employees.chain.raised', { runs: ledger.runsAllowed }))
          })
      }
    : retry
      ? { label: t('employees.task.retry'), onAct: () => void attempt(() => api.retryEmployeeTask(task.id)) }
      : undefined
  const decline = stopsProject
    ? { label: t('employees.chain.stopProject'), onAct: () => setStopping(true) }
    : spent
      ? { label: t('employees.chain.cancel'), onAct: () => void attempt(() => api.cancelEmployeeTask(task.rootId)) }
      : canCancelTask(task)
        ? { label: t('employees.decision.cancelTask'), onAct: () => void attempt(() => api.cancelEmployeeTask(task.id)) }
        : undefined
  return (
    <PlacedDecision
      place={place}
      parts={{
        who,
        kind: t('decision.kind.task'),
        age: timeAgo(task.updatedAt, t.locale),
        subject: task.title,
        children:
          why || (stopsProject && stopping) ? (
            <>
              {why && <p className="employee-task-why">{why}</p>}
              {stopsProject && stopping && <StopProjectConfirm projectId={task.project!.id} title={project?.title ?? task.title} onDone={() => setStopping(false)} />}
            </>
          ) : null,
        consequence: spent ? t('employees.decision.task.raise') : retry ? t('employees.decision.task.retry', { name }) : undefined,
        footStart: <TaskMore task={task} />,
        decline,
        // Stopping a whole project is pressed on its button, never Esc.
        ...(stopsProject ? { escDeclines: false } : {}),
        main,
        rowAct: main ? { label: main.label, onAct: main.onAct } : { label: t('decision.review'), onAct: place.onToggle ?? (() => undefined) }
      }}
    />
  )
}

/** An employee paused after two runs in a row didn't finish (§9): how the last ended, and Resume. */
function PausedDecision({ orgId, employee: e, place, who }: { orgId: string; employee: EmployeeSummary; place: DecisionPlace; who: ReactNode }) {
  const t = useT()
  const name = e.name || e.id
  const resume = () => void attempt(() => api.resumeEmployee(orgId, e.id))
  return (
    <PlacedDecision
      place={place}
      parts={{
        who,
        kind: t('decision.kind.paused'),
        subject: t('employees.employee.failuresTitle', { name }),
        children: <p className="employee-task-why">{e.pausedDetail ? t('employees.employee.failuresBody', { detail: e.pausedDetail }) : t('employees.employee.failuresBodyPlain')}</p>,
        consequence: t('employees.decision.paused.consequence', { name }),
        footStart: (
          <MenuButton label={t('employees.decision.more')} look="ghost" small trigger={<MoreHorizontal size={14} aria-hidden />} iconOnly>
            <MenuItem onSelect={() => openEmployees({ orgId, page: 'employee', id: e.id })}>{t('employees.needsYou.open')}</MenuItem>
          </MenuButton>
        ),
        main: { label: t('employees.action.resume'), onAct: resume },
        rowAct: { label: t('employees.action.resume'), onAct: resume }
      }}
    />
  )
}

/** One decision, drawn where `place` says. */
export function EmployeeDecision({ orgId, item, place }: { orgId: string; item: DecisionItem; place: DecisionPlace }) {
  const title = useStore((s) => {
    if (item.kind !== 'action') return undefined
    const view = s.snapshot!.employeeWork?.[orgId]
    return view?.tasks.find((x) => x.id === item.action.taskId)?.title ?? Object.values(view?.last ?? {}).find((x) => x.id === item.action.taskId)?.title
  })
  const who = <EmployeeWho orgId={orgId} employeeId={item.employeeId} />
  switch (item.kind) {
    case 'question':
      return <QuestionDecision task={item.task} place={place} who={who} />
    case 'task':
      return <TaskDecision task={item.task} place={place} who={who} />
    case 'action':
      return <ActionDecision action={item.action} place={place} who={who} task={title} />
    case 'proposal':
      return <ProposalDecision proposal={item.proposal} place={place} who={who} />
    case 'paused':
      return <PausedDecision orgId={orgId} employee={item.employee} place={place} who={who} />
  }
}

/** Decisions as cards, one under another (an employee's page). */
export function DecisionCards({ orgId, items, label }: { orgId: string; items: readonly DecisionItem[]; label: string }) {
  if (!items.length) return null
  return (
    <ul className="employee-work-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <EmployeeDecision orgId={orgId} item={item} place={{ form: 'card' }} />
        </li>
      ))}
    </ul>
  )
}

/** Decisions as one striped list of rows, one open at a time (the Team page). */
export function DecisionRows({ orgId, items, label, openFirst }: { orgId: string; items: readonly DecisionItem[]; label: string; openFirst?: boolean }) {
  return <DecisionList items={items} label={label} openFirst={openFirst} render={(item, open, toggle) => <EmployeeDecision key={item.id} orgId={orgId} item={item} place={{ form: 'row', open, onToggle: toggle }} />} />
}

/**
 * Everything of the organization that waits for a person, as cards under one "Needs you" heading: a question to answer,
 * a task to retry or cancel, an employee paused for failures, an outward action to push or post, a memory change to add.
 */
export function EmployeesNeedYou({ orgId, employeeId }: { orgId: string; employeeId?: string }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  const items = useDecisionItems(orgId, employeeId)
  if (!items.length) return null
  return (
    <section className="team-needs-you" aria-labelledby={`needs-you-${orgId}`}>
      <h2 id={`needs-you-${orgId}`} className="employee-subheading">
        {t('employees.needsYou.count', { count: items.length })}
      </h2>
      <DecisionCards orgId={orgId} items={items} label={t('employees.needsYou.label', { organization: organization?.name ?? '' })} />
    </section>
  )
}

/**
 * The decision an employee's run waits on, in that run's workspace: its question, what it asked to send, what it
 * proposed. Docked above the chat's message box (F6 reaches it; its arrival is announced, focus stays), or in the run's
 * banner.
 */
export function EmployeeRunDecision({ ws, active, docked = true }: { ws: Pick<Workspace, 'startedBy'>; active: boolean; docked?: boolean }) {
  const t = useT()
  const by = ws.startedBy?.via === 'employee' ? ws.startedBy : undefined
  const view = useStore((s) => (by ? s.snapshot!.employeeWork?.[by.orgId] : undefined))
  const platform = useStore((s) => s.snapshot!.platform)
  const name = useStore((s) => (by ? s.snapshot!.employees?.[by.orgId]?.employees.find((e) => e.id === by.employeeId)?.name : undefined))
  const item = by ? runItems(view, { employeeId: by.employeeId, taskId: by.taskId, runId: by.runId })[0] : undefined
  const reach = shortcutHint('approval.focus', platform)
  const said = useRef({ t, active, name })
  said.current = { t, active, name }
  useEffect(() => {
    if (!item || !docked || !said.current.active) return
    const { t: tr, name: who } = said.current
    announce(tr('decision.arrived', { who: who || by?.employeeId || '', what: tr(item.kind === 'question' ? 'decision.kind.question' : item.kind === 'action' ? 'decision.kind.send' : item.kind === 'proposal' ? 'decision.kind.memory' : 'decision.kind.task'), key: reach ?? '' }), `decision:${item.id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])
  if (!by || !item) return null
  const headEnd = docked && reach ? <span className="decision-reach">{t.rich('decision.reach', { key: <Kbd key="key">{reach}</Kbd> })}</span> : undefined
  return <EmployeeDecision orgId={by.orgId} item={item} place={{ form: 'card', docked, headEnd }} />
}
