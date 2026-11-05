// The workspace's Flow tab (docs/loops-and-graphs.md, "Running a flow"): the run this workspace belongs to, where it is,
// its loop bounds, Stop, and its steps in run order with their facts. A step opens the chat tab, the checks or the
// workspace it stands for (a run that makes more than one workspace shows it in each). No diagram yet.
import { Square } from 'lucide-react'
import { currentLoopBounds, isActiveRun, runForWorkspace, type FlowRunStep } from '../../../shared/flows'
import { useT } from '../i18n'
import { api, attempt, selectSession, selectWorkspace, showChecksPanel, timeAgo, useStore } from '../store'
import { Button, Card, CardButton, Status } from '../ui'
import { RUN_STATE, RUN_TONE, STEP_KIND, STEP_STATE, STEP_TONE } from './automations/flowRunWords'
import './flowRun.css'

/** The run a workspace's Flow tab shows: its active run, else its latest; none while Flows are off. */
export function useWorkspaceFlowRun(workspaceId: string) {
  return useStore((s) => (s.snapshot?.settings.flows ? runForWorkspace(s.snapshot.flowRuns, workspaceId) : undefined))
}

export function FlowRunPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const run = useWorkspaceFlowRun(workspaceId)
  if (!run) return null
  const active = isActiveRun(run)
  const bounds = active ? currentLoopBounds(run) : []
  return (
    <div className="flow-run">
      <div className="flow-run-head">
        <div className="flow-run-title">
          <strong>{run.flow.name}</strong>
          <Status tone={RUN_TONE[run.state]} label={t(RUN_STATE[run.state])} />
        </div>
        {active && run.current && <span className="small">{t('flowRun.panel.at', { step: run.current.step, iteration: run.current.iteration })}</span>}
        {bounds.map((b) => (
          <span key={b.loop} className="faint small">
            {[
              b.maxIterations ? t('flowRun.panel.loopIterationsMax', { loop: b.loop, iteration: b.iteration, max: b.maxIterations }) : t('flowRun.panel.loopIterations', { loop: b.loop, iteration: b.iteration }),
              b.maxMinutes ? t('flowRun.panel.loopMinutes', { minutes: b.minutes, max: b.maxMinutes }) : null,
              b.maxCost !== undefined ? t('flowRun.panel.loopCost', { cost: (b.cost ?? 0).toFixed(2), max: b.maxCost.toFixed(2) }) : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ))}
        {run.reason && <span className="small">{run.reason}</span>}
        <span className="faint small">{t('flowRun.panel.started', { when: timeAgo(run.startedAt) })}</span>
        {active && (
          <span>
            <Button size="sm" onClick={() => void attempt(() => api.stopFlowRun(run.id))}>
              <Square size={12} aria-hidden /> {t('flowRun.panel.stop')}
            </Button>
          </span>
        )}
      </div>
      {run.steps.length ? (
        <ol className="flow-run-steps" aria-label={t('flowRun.panel.steps')}>
          {run.steps.map((step, n) => (
            <li key={n}>
              <StepCard workspaceId={workspaceId} step={step} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint small">{t('flowRun.panel.empty')}</p>
      )}
    </div>
  )
}

/** One execution of a step; a button when there is a tab or check run to open for it. */
function StepCard({ workspaceId, step }: { workspaceId: string; step: FlowRunStep }) {
  const t = useT()
  const kind = t(STEP_KIND[step.kind])
  const elsewhere = useStore((s) => (step.workspaceId && step.workspaceId !== workspaceId ? (s.snapshot?.workspaces.find((w) => w.id === step.workspaceId)?.name ?? step.workspaceId) : undefined))
  const loops = Object.entries(step.loops ?? {})
  const body = (
    <>
      <span className="flow-step-head">
        <Status tone={STEP_TONE[step.state]} label={t(STEP_STATE[step.state])} />
        <strong>{step.name}</strong>
        <span className="faint small">{t('flowRun.panel.kindRun', { kind, n: step.iteration })}</span>
      </span>
      {step.persona && <span className="small">{t(step.readOnly ? 'flowRun.panel.personaReadOnly' : 'flowRun.panel.persona', { persona: step.persona })}</span>}
      {loops.length > 0 && <span className="faint small">{t('flowRun.panel.inLoops', { loops: loops.map(([name, i]) => t('flowRun.panel.loopAt', { loop: name, iteration: i })).join(', ') })}</span>}
      {step.detail && <span className="small">{step.detail}</span>}
      {step.delta && <span className="faint small">{t('flowRun.panel.delta', { count: step.delta.files, additions: step.delta.additions, deletions: step.delta.deletions })}</span>}
      {step.shown && step.shown.length > 0 && <span className="faint small">{t('flowRun.panel.shown', { sections: step.shown.join(', ') })}</span>}
      {step.costUsd !== undefined && <span className="faint small">{t('flowRun.panel.cost', { cost: step.costUsd.toFixed(2) })}</span>}
      {elsewhere && <span className="faint small">{t('flowRun.panel.inWorkspace', { workspace: elsewhere })}</span>}
      {step.fact && <span className="faint small">{t('flowRun.panel.fact', { fact: step.fact })}</span>}
    </>
  )
  const where = step.workspaceId ?? workspaceId
  const open =
    step.kind === 'checks' || step.kind === 'script'
      ? step.kind === 'checks'
        ? () => showChecksPanel(where)
        : undefined
      : step.kind === 'workspace' && step.workspaceId
        ? () => selectWorkspace(step.workspaceId!)
        : step.sessionId
          ? () => selectSession(where, step.sessionId!)
          : undefined
  if (!open) return <Card className="flow-step">{body}</Card>
  return (
    <CardButton className="flow-step" onClick={open} title={t(step.kind === 'checks' ? 'flowRun.panel.openChecks' : step.kind === 'workspace' ? 'flowRun.panel.openWorkspace' : 'flowRun.panel.openTab')}>
      {body}
    </CardButton>
  )
}
