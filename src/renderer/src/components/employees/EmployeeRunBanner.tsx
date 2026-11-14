// A workspace an AI employee's run made says so (docs/ai-employees.md §10): the employee's hat and name, the task it is
// for, the task's state and why, and Stop, Retry or Cancel where they apply, with a way to the employee's page. Shown
// only while AI employees are on.
import { canCancelTask, canRetryTask, isRunActive } from '../../../../shared/employeeWork'
import type { Workspace } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, useStore } from '../../store'
import { Button, Callout, HardHat, LinkButton, Status, type HardHatColour } from '../../ui'
import { holdText, taskWord } from './words'
import './employees.css'

export function EmployeeRunBanner({ ws }: { ws: Workspace }) {
  const t = useT()
  const by = ws.startedBy?.via === 'employee' ? ws.startedBy : undefined
  const employee = useStore((s) => (by ? s.snapshot!.employees?.[by.orgId]?.employees.find((e) => e.id === by.employeeId) : undefined))
  const work = useStore((s) => (by ? s.snapshot!.employeeWork?.[by.orgId] : undefined))
  if (!by) return null
  const task = work?.tasks.find((x) => x.id === by.taskId) ?? (work?.last[by.employeeId]?.id === by.taskId ? work.last[by.employeeId] : undefined)
  const run = work?.runs.find((r) => r.id === by.runId && isRunActive(r.state))
  const name = employee?.name || by.employeeId
  const word = task ? taskWord(task) : undefined
  const why = task ? (task.state === 'closed' ? task.closureDetail : holdText(task, t)) : undefined
  return (
    <Callout
      banner
      role="status"
      actions={
        <>
          {run && (
            <Button size="sm" onClick={() => void attempt(() => api.stopEmployeeRun(run.id))}>
              {t('employees.task.stop')}
            </Button>
          )}
          {task && canRetryTask(task) && (
            <Button size="sm" variant="primary" onClick={() => void attempt(() => api.retryEmployeeTask(task.id))}>
              {t('employees.task.retry')}
            </Button>
          )}
          {task && canCancelTask(task) && !run && (
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.cancelEmployeeTask(task.id))}>
              {t('employees.task.cancel')}
            </Button>
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
        {word && <Status tone={word.tone} label={t(word.label)} />}
        {why && <span className="employee-faint">{why}</span>}
      </span>
    </Callout>
  )
}
