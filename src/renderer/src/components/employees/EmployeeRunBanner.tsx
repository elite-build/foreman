// A workspace an AI employee's run made says so (docs/ai-employees.md §10): the employee's hat and name, the task it is
// for and the task's state, with Stop or Retry where they apply and a way to the employee's page; Cancel task is under
// More. While a decision of the run waits for you (its question, a push it asked for, a memory change it proposed) the
// banner says "Needs you" with what, never "Done", and carries the same decision card: Answer… or Review… opens it under
// the banner, where it is decided as on the employee's page. The run's chat docks it too, above the message box. A project
// run's chat takes no more messages once its turn ended (ProjectRunEnded, in place of the message box).
import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { runItems } from '../../../../shared/employeeDecisions'
import { canCancelTask, canRetryTask, isRunActive } from '../../../../shared/employeeWork'
import type { Session, Workspace } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, useStore } from '../../store'
import { Button, Callout, HardHat, LinkButton, MenuButton, MenuItem, Status, type HardHatColour } from '../../ui'
import { EmployeeRunDecision } from './EmployeeDecisions'
import { actionKindWord } from './HeldActions'
import { projectChannel } from './projectWords'
import { holdText, taskWord } from './words'
import './employees.css'

const KIND = { question: 'decision.kind.question', task: 'decision.kind.task', proposal: 'decision.kind.memory' } as const

export function EmployeeRunBanner({ ws }: { ws: Workspace }) {
  const t = useT()
  const by = ws.startedBy?.via === 'employee' ? ws.startedBy : undefined
  const employee = useStore((s) => (by ? s.snapshot!.employees?.[by.orgId]?.employees.find((e) => e.id === by.employeeId) : undefined))
  const work = useStore((s) => (by ? s.snapshot!.employeeWork?.[by.orgId] : undefined))
  const [open, setOpen] = useState(false)
  if (!by) return null
  const task = work?.tasks.find((x) => x.id === by.taskId) ?? (work?.last[by.employeeId]?.id === by.taskId ? work.last[by.employeeId] : undefined)
  const run = work?.runs.find((r) => r.id === by.runId && isRunActive(r.state))
  const item = runItems(work, { employeeId: by.employeeId, taskId: by.taskId, runId: by.runId })[0]
  const name = employee?.name || by.employeeId
  const word = task ? taskWord(task) : undefined
  const why = task && !item ? (task.state === 'closed' ? task.closureDetail : holdText(task, t)) : undefined
  const what = item ? (item.kind === 'action' ? actionKindWord(item.action.payload, t) : t(KIND[item.kind])) : ''
  return (
    <>
      <Callout
        banner
        role="status"
        actions={
          <>
            {item && (
              <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? t('employees.banner.hide') : item.kind === 'question' ? t('decision.answer') : t('decision.review')}
              </Button>
            )}
            {run && (
              <Button size="sm" onClick={() => void attempt(() => api.stopEmployeeRun(run.id))}>
                {t('employees.task.stop')}
              </Button>
            )}
            {task && !item && canRetryTask(task) && (
              <Button size="sm" variant="primary" onClick={() => void attempt(() => api.retryEmployeeTask(task.id))}>
                {t('employees.task.retry')}
              </Button>
            )}
            {task && canCancelTask(task) && !run && (
              <MenuButton label={t('employees.decision.more')} look="ghost" small iconOnly trigger={<MoreHorizontal size={14} aria-hidden />}>
                <MenuItem onSelect={() => void attempt(() => api.cancelEmployeeTask(task.id))}>{t('employees.decision.cancelTask')}</MenuItem>
              </MenuButton>
            )}
            <LinkButton size="sm" underline onClick={() => openEmployees({ orgId: by.orgId, page: 'employee', id: by.employeeId })}>
              {t('employees.banner.open', { name })}
            </LinkButton>
          </>
        }
      >
        <span className="employee-run-banner">
          <HardHat colour={(employee?.colour ?? '') as HardHatColour} size={18} />
          <strong>{t('employees.banner.title', { name })}</strong>
          <span className="employee-run-banner-task">{t('employees.banner.task', { title: by.title })}</span>
          {item ? <Status tone="warn" label={t('employees.banner.needs', { what })} /> : word && <Status tone={word.tone} label={t(word.label)} />}
          {why && <span className="employee-faint">{why}</span>}
        </span>
      </Callout>
      {item && open && (
        <div className="employee-run-drawer">
          <EmployeeRunDecision ws={ws} active={false} docked={false} />
        </div>
      )}
    </>
  )
}

/**
 * In place of the message box in a project run's chat once its turn ended (docs/ai-employees.md §15): the chat is the run's
 * and read-only, as main holds it (its context is out of date, and nothing of the project would see a new turn). The
 * person asks the employee in the project's channel, which this opens.
 */
export function ProjectRunEnded({ session }: { session: Session }) {
  const t = useT()
  const run = session.employeeRun
  const name = useStore((s) => (run ? s.snapshot!.employees?.[run.orgId]?.employees.find((e) => e.id === run.employeeId)?.name : undefined)) || run?.employeeId || ''
  const project = useStore((s) => (run?.projectId ? s.snapshot!.projects?.[run.orgId]?.find((p) => p.id === run.projectId) : undefined))
  if (!run?.projectId) return null
  const projectId = run.projectId
  return (
    <Callout
      role="status"
      actions={
        <Button size="sm" variant="primary" onClick={() => openEmployees({ orgId: run.orgId, page: 'project', id: projectId })}>
          {project ? t('employees.runEnded.open', { channel: projectChannel(project) }) : t('employees.runEnded.openChannel')}
        </Button>
      }
    >
      {project ? t('employees.runEnded.body', { name, channel: projectChannel(project) }) : t('employees.runEnded.bodyGone', { name })}
    </Callout>
  )
}
