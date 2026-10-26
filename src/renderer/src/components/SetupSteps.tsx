// O19: the Setup tab's step panel. Each step of the latest setup run with its
// status and time (✓ 48s · ⟳ 0:31 / 2:00 · ○ waiting · ✗ exit 1), the selected or
// running step's own log below it, and Stop setup / Retry failed step.
import { Circle, CircleCheck, CircleSlash, CircleStop, CircleX, ScrollText, Square, StepForward } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { clock, duration, failedStep } from '../../../shared/setupSteps'
import type { SetupStepResult, Workspace } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { api, attempt, bridge, showToast } from '../store'
import { ActionRow, Button, Card, LinkButton, Spinner } from '../ui'
import './setupSteps.css'

/** Each step's own log for the workspace's latest run: loaded once, then kept up to date from setup-log events. */
function useStepLogs(workspaceId: string, runId: string | undefined): string[] {
  const [state, setState] = useState<{ runId: string; logs: string[] } | null>(null)
  useEffect(() => {
    if (!runId) return
    let loaded = false
    let live = true
    const off = bridge.onEvent((event) => {
      if (event.type !== 'setup-log' || event.workspaceId !== workspaceId || event.step === undefined || !event.runId || !loaded) return
      const { step, chunk, runId: id } = event
      setState((prev) => {
        // A new run's step logs start empty.
        const logs = prev && prev.runId === id ? [...prev.logs] : []
        logs[step] = (logs[step] ?? '') + chunk
        return { runId: id, logs }
      })
    })
    api
      .getSetupStepLogs(workspaceId)
      .then((saved) => {
        if (!live) return
        loaded = true
        if (saved) setState(saved)
      })
      .catch(() => (loaded = true))
    return () => {
      live = false
      off()
    }
  }, [workspaceId, runId])
  return state && state.runId === runId ? state.logs : []
}

/** The time now, ticking every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return on ? now : Date.now()
}

function StepIcon({ status }: { status: SetupStepResult['status'] }) {
  switch (status) {
    case 'done':
      return <CircleCheck size={14} className="setup-step-icon green" />
    case 'running':
      return (
        <span className="setup-step-icon blue">
          <Spinner size={14} />
        </span>
      )
    case 'failed':
    case 'timed-out':
      return <CircleX size={14} className="setup-step-icon red" />
    case 'stopped':
      return <CircleStop size={14} className="setup-step-icon faint" />
    case 'skipped':
      return <CircleSlash size={14} className="setup-step-icon faint" />
    default:
      return <Circle size={14} className="setup-step-icon faint" />
  }
}

/** The right-hand time or state of a step row. */
function stepTime(step: SetupStepResult, now: number, t: RendererT): ReactNode {
  const runs = (step.attempts ?? 0) > 1 ? ` · ${t('setupTab.runs', { count: step.attempts! })}` : ''
  const took = step.durationMs !== undefined ? duration(step.durationMs, t) : ''
  switch (step.status) {
    case 'running': {
      const elapsed = clock(now - Date.parse(step.startedAt ?? new Date(now).toISOString()))
      return (
        <>
          {elapsed}
          {step.timeoutSec ? <span className="faint"> / {clock(step.timeoutSec * 1000)}</span> : null}
        </>
      )
    }
    case 'done':
      return `${took}${runs}`
    case 'failed':
      return `${t('setupTab.exitCode', { code: step.exitCode ?? '?' })} · ${took}${runs}`
    case 'timed-out':
      return `${t('setupTab.timedOut')} · ${clock((step.timeoutSec ?? 0) * 1000)}${runs}`
    case 'stopped':
      return `${t('setupTab.stopped')}${took ? ` · ${took}` : ''}`
    case 'skipped':
      return <span className="faint">{t('setupTab.skipped')}</span>
    default:
      return <span className="faint">{t('setupTab.waiting')}</span>
  }
}

/**
 * The step panel for the Setup tab. `actions` go in the tab's header, `panel` above
 * the log, and `text` is the log to show: the chosen step's, or null for the full log.
 */
export function useSetupSteps(workspace: Workspace, fullLog: string): { actions: ReactNode; panel: ReactNode; text: string | null } {
  const t = useT()
  const run = workspace.setupRun
  const setting = workspace.state === 'setting-up'
  const steps = run?.steps ?? []
  // A step left "running" by a restart isn't running.
  const running = setting ? steps.findIndex((s) => s.status === 'running') : -1
  const failed = failedStep(run)
  const logs = useStepLogs(workspace.id, run?.id)
  const now = useNow(running >= 0)
  // A step the user clicked, or the full log; otherwise the running step, then the one that failed, then the last.
  const [chosen, setChosen] = useState<number | 'full' | null>(null)
  useEffect(() => setChosen(null), [run?.id, workspace.id])

  if (!run || !steps.length || workspace.state === 'creating' || workspace.state === 'error') return { actions: null, panel: null, text: null }

  const shown = chosen === 'full' ? -1 : chosen ?? (running >= 0 ? running : failed >= 0 ? failed : steps.length - 1)
  const copyAll = () =>
    void navigator.clipboard.writeText(fullLog).then(
      () => showToast(t('setupTab.copied')),
      () => showToast(t('terminalChat.copyFailed'), 'error')
    )

  const actions = (
    <>
      {running >= 0 && (
        <Button size="sm" icon={<Square size={11} />} title={t('setupTab.stopTitle')} onClick={() => void attempt(() => api.stopSetup(workspace.id))}>
          {t('setupTab.stop')}
        </Button>
      )}
      {workspace.state === 'setup-failed' && failed >= 0 && (
        <Button size="sm" icon={<StepForward size={11} />} title={t('setupTab.retryTitle')} onClick={() => void attempt(() => api.retrySetup(workspace.id))}>
          {t('setupTab.retry')}
        </Button>
      )}
    </>
  )

  const panel = (
    <>
      <Card size="sm" className="setup-steps" role="list" aria-label={t('setupTab.steps')}>
        {steps.map((step, i) => {
          const status = step.status === 'running' && !setting ? 'stopped' : step.status
          return (
            <ActionRow
              key={i}
              role="listitem"
              divided
              selected={i === shown}
              onPress={() => setChosen(i)}
              primaryProps={{ className: `setup-step ${status}`, title: step.command }}
            >
              <StepIcon status={status} />
              <span className="setup-step-name">{step.name}</span>
              <code className="setup-step-command">{step.command.split('\n')[0]}</code>
              <span className="setup-step-time">{stepTime({ ...step, status }, now, t)}</span>
            </ActionRow>
          )
        })}
      </Card>
      <div className="setup-step-log-head small">
        <ScrollText size={12} />
        {shown >= 0 ? (
          <>
            <span>{steps[shown].name}</span>
            <span className="faint">· {t('setupTab.log')}</span>
          </>
        ) : (
          <span>{t('setupTab.fullLog')}</span>
        )}
        <span className="spacer" />
        {shown >= 0 && (
          <LinkButton size="sm" title={t('setupTab.fullLogTitle')} onClick={() => setChosen('full')}>
            {t('setupTab.fullLog')}
          </LinkButton>
        )}
        <LinkButton size="sm" onClick={copyAll}>
          {t('setupTab.copyFullLog')}
        </LinkButton>
      </div>
    </>
  )
  const text = shown >= 0 ? (logs[shown] ?? '').replace(/^\n+/, '') || t('setupTab.noOutput') : null
  return { actions, panel, text }
}
