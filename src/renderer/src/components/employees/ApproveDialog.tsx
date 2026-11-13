// Approving an employee shows the plan first (docs/ai-employees.md §5.3): the model and its fallbacks, how it is
// attended, its repositories and access, the execution profile and MCP servers, outward actions and whether each is
// held, delegation, triggers, limits, what Foreman writes (only the memory repository) and what this approval does not
// cover. Confirming records the definition's fingerprint on this computer (or creates the employee approved).
import { useState } from 'react'
import { effortLabel } from '../../../../shared/agents'
import { DEFAULT_WORK_LIMITS } from '../../../../shared/employeeBroker'
import { employeeMemoryFolder, employeePath, type EmployeeDefinition } from '../../../../shared/employees'
import { useT } from '../../i18n'
import { Button, Callout, Dialog, Tag } from '../../ui'
import { ActionRules } from './HeldActions'
import { ACCESS_LABEL, agentLabel, modelText, triggerAsks, triggerWhen } from './words'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ApproveDialog({
  definition,
  memory,
  names,
  creating,
  onConfirm,
  onClose
}: {
  definition: EmployeeDefinition
  // The memory repository's name.
  memory: string
  // An employee id's name, for delegation.
  names: (id: string) => string
  // Create and approve: the confirm button says so.
  creating?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const d = definition
  const name = d.name || d.id
  const repos = Object.entries(d.access.repos)
  const confirm = async () => {
    setWorking(true)
    setError('')
    try {
      await onConfirm()
    } catch (err) {
      setError(message(err))
      setWorking(false)
    }
  }
  return (
    <Dialog
      title={t('employees.approve.title', { name })}
      description={t('employees.approve.intro', { name })}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" disabled={working} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={working} onClick={() => void confirm()}>
            {working ? t('employees.approve.working') : creating ? t('employees.approve.confirmCreate') : t('employees.approve.confirm')}
          </Button>
        </>
      }
    >
      <div className="employee-plan">
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
        <dl className="employee-plan-list">
          <dt>{t('employees.approve.model')}</dt>
          <dd>
            <span>{modelText(d.model.agent, d.model.model, t) || agentLabel(d.model.agent)}</span>
            {d.model.effort && <span className="employee-faint"> · {t('employees.approve.effort', { effort: effortLabel(d.model.effort, t) })}</span>}
            <span className="employee-faint">{d.model.fallbacks.length ? t('employees.approve.fallbacks', { models: d.model.fallbacks.join(t('employees.list.separator')) }) : t('employees.approve.noFallbacks')}</span>
          </dd>
          <dt>{t('employees.approve.attendance')}</dt>
          <dd>{d.attendance === 'unattended' ? t('employees.access.unattendedHint') : t('employees.access.attendedHint')}</dd>
          <dt>{t('employees.approve.repos')}</dt>
          <dd>
            {repos.length ? (
              <ul className="employee-plan-items">
                {repos.map(([repo, access]) => (
                  <li key={repo}>
                    <span className="mono">{repo}</span> <Tag tone="outline">{t(ACCESS_LABEL[access])}</Tag>
                  </li>
                ))}
              </ul>
            ) : (
              t('employees.can.readsNone')
            )}
          </dd>
          <dt>{t('employees.approve.profile')}</dt>
          <dd>
            {d.access.profile === 'shell' ? t('employees.can.shell') : t('employees.can.noShell')}
            <span className="employee-faint">{d.access.mcp.length ? t('employees.can.mcp', { servers: d.access.mcp.join(t('employees.list.separator')) }) : t('employees.approve.noMcp')}</span>
          </dd>
          <dt>{t('employees.approve.actions')}</dt>
          <dd>
            <ActionRules definition={d} />
          </dd>
          <dt>{t('employees.approve.delegates')}</dt>
          <dd>
            {d.access.delegate_to.length ? t('employees.can.delegates', { names: d.access.delegate_to.map(names).join(t('employees.list.separator')) }) : t('employees.approve.noDelegates')}
            {d.access.delegate_to.length > 0 && (
              <span className="employee-faint">
                {' '}
                {t('employees.approve.delegatesLimits', { runs: DEFAULT_WORK_LIMITS.runs, depth: DEFAULT_WORK_LIMITS.depth, perRun: DEFAULT_WORK_LIMITS.delegationsPerRun, tasks: DEFAULT_WORK_LIMITS.descendants })}
              </span>
            )}
          </dd>
          <dt>{t('employees.approve.triggers')}</dt>
          <dd>
            {d.triggers?.length ? (
              <ul className="employee-plan-items">
                {d.triggers.map((trigger, i) => (
                  <li key={i}>
                    <span>{triggerWhen(trigger, t)}</span>
                    <span className="employee-faint">
                      {' · '}
                      {[
                        triggerAsks(trigger, t),
                        trigger.repo ? t('employees.trigger.inRepo', { repo: trigger.repo }) : t('employees.trigger.inDefaultRepo'),
                        trigger.kind === 'event'
                          ? t('employees.approve.triggerEvent', { seconds: trigger.debounce })
                          : trigger.missed === 'run-once'
                            ? t('employees.approve.triggerRunOnce')
                            : t('employees.approve.triggerSkip')
                      ].join(' · ')}
                    </span>
                    {!trigger.enabled && <Tag tone="outline">{t('employees.trigger.off')}</Tag>}
                  </li>
                ))}
              </ul>
            ) : (
              t('employees.approve.noTriggers')
            )}
          </dd>
          <dt>{t('employees.approve.limits')}</dt>
          <dd>
            {t('employees.can.limits', { runs: d.limits.runs_per_day, minutes: d.limits.minutes_per_run })}
            {d.limits.cost_per_day_usd !== undefined && (
              <span className="employee-faint">
                {t('employees.can.cost', { cost: new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD' }).format(d.limits.cost_per_day_usd) })} {t('employees.approve.costOvershoot')}
              </span>
            )}
            <span className="employee-faint">{t('employees.approve.failures')}</span>
          </dd>
          <dt>{t('employees.approve.writes')}</dt>
          <dd>{t('employees.approve.writesBody', { memory, path: employeePath(d.id), folder: `${employeeMemoryFolder(d.id)}/` })}</dd>
        </dl>
        <section className="employee-plan-section" aria-labelledby="employee-plan-not-covered">
          <h3 id="employee-plan-not-covered" className="employee-subheading">
            {t('employees.approve.notCovered')}
          </h3>
          <ul className="employee-plan-bullets">
            <li>{d.triggers?.length ? t('employees.approve.notCovered1Triggers') : t('employees.approve.notCovered1')}</li>
            <li>{t('employees.approve.notCovered2')}</li>
            <li>{t('employees.approve.notCovered3')}</li>
            <li>{t('employees.approve.notCovered4')}</li>
            <li>{t('employees.approve.notCovered5')}</li>
          </ul>
        </section>
        <p className="employee-faint">{t('employees.approve.local')}</p>
      </div>
    </Dialog>
  )
}
