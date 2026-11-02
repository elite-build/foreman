// Archive a workspace (#1 Stop safely): names the running tabs it stops, shows what's kept and
// what's deleted and the steps in order, and stops before deleting anything if the checkpoint or
// the archive script fails ("Retry this step" / "Keep workspace"). O18: with the repo setting on, it lists
// the labelled Docker containers it removes, and after archiving says which couldn't be removed.
// G3: each step shows as it goes (main streams archive-progress), the archive script's own steps included.
// A cloud workspace has no checkpoint or folder to remove: its sandbox stops, and its snapshot keeps the work.
import { Check, CircleStop, Cloud, GitBranch, Minus, Trash2, X } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { previewCount, removalNeedsAttention, type DockerPreview, type DockerRemoval } from '../../../shared/docker'
import { cloudSettings } from '../../../shared/cloud'
import { turnRunning } from '../../../shared/stopSafely'
import type { ArchiveOptions, ArchiveOutcome, ArchivePreview, ArchiveProgress, ArchiveProgressStep, SetupStepResult } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, backgroundArchive, bridge, finishBackgroundArchive, getState, openArchiveDialog, rememberArchiveChoice, selectWorkspace, showToast, stopBackgroundArchive, useStore } from '../store'
import { Button, Callout, Card, Dialog, Segmented, Spinner, Tag } from '../ui'
import { toolSummary } from './ToolRow'
import { formatDuration } from './turnResult'
import './stopSafely.css'

type Failure = Extract<ArchiveOutcome, { ok: false }>

export function ArchiveDialog({ workspaceId, hidden = false }: { workspaceId: string; hidden?: boolean }) {
  const t = useT()
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const sessions = useStore((s) => s.snapshot!.sessions)
  const deleteSnapshots = useStore((s) => cloudSettings(s.snapshot!.settings).deleteSnapshotsOnForget)
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(() => getState().archiveDeleteBranch)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // O18: the archive went through but the Docker step left something behind (or couldn't ask Docker).
  const [docker, setDocker] = useState<DockerRemoval | null>(null)
  // "Archive anyway…" asks for a second click.
  const [armed, setArmed] = useState(false)
  const [now, setNow] = useState(Date.now())
  // G3 · #1: each step's state as main reports it, and the archive script's own steps (O19).
  const [progress, setProgress] = useState<Partial<Record<ArchiveProgressStep, ArchiveProgress['status']>>>({})
  const [scriptSteps, setScriptSteps] = useState<SetupStepResult[] | null>(null)
  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event.type !== 'archive-progress' || event.workspaceId !== workspaceId) return
        setProgress((prev) => ({ ...prev, [event.progress.step]: event.progress.status }))
        if (event.progress.scriptSteps) setScriptSteps(event.progress.scriptSteps)
      }),
    [workspaceId]
  )
  const running = sessions.filter((s) => s.workspaceId === workspaceId && turnRunning(s)).length
  useEffect(() => {
    let live = true
    void api.archivePreview(workspaceId).then((p) => live && setPreview(p), () => live && setPreviewFailed(true))
    return () => {
      live = false
    }
  }, [workspaceId, running])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const close = () => {
    if (busy || failure) openArchiveDialog(null)
    else finishBackgroundArchive(workspaceId)
  }
  if (!ws) return null
  if (docker && !hidden) return <DockerResult workspaceId={workspaceId} name={ws.name} initial={docker} onClose={close} />

  const kind = preview?.kind ?? (ws.direct ? 'direct' : ws.adopted ? 'adopted' : 'worktree')
  const cloud = Boolean(ws.cloud)
  // A cloud workspace's branch is in its sandbox, which archiving keeps: only a local worktree offers the choice.
  const branchChoice = kind === 'worktree' && !cloud

  const run = async (options: ArchiveOptions) => {
    if (busy) return
    if (branchChoice) rememberArchiveChoice(deleteBranch)
    // A retry keeps the steps before the one it retries.
    setProgress((prev) => (options.from === 'script' ? { stop: prev.stop, checkpoint: prev.checkpoint, diff: prev.diff } : options.from ? { stop: prev.stop } : {}))
    if (options.from !== 'script') setScriptSteps(null)
    setBusy(true)
    setFailure(null)
    backgroundArchive(workspaceId)
    if (getState().selectedWorkspaceId === workspaceId) selectWorkspace(null)
    showToast(t('stop.archive.background', { name: ws.name }), 'info', {
      action: { label: t('stop.archive.viewProgress'), run: () => openArchiveDialog(workspaceId) }
    })
    const outcome = await attempt(() => api.archiveWorkspace(workspaceId, !ws.adopted && deleteBranch, options))
    setBusy(false)
    setArmed(false)
    if (!outcome) {
      // Keep the controller available after an unexpected IPC or cleanup error.
      stopBackgroundArchive(workspaceId)
      if (!getState().archiveTarget) openArchiveDialog(workspaceId)
      return
    }
    if (!outcome.ok) {
      setFailure(outcome)
      stopBackgroundArchive(workspaceId)
      showToast(t('stop.archive.backgroundFailed', { name: ws.name }), 'error', {
        action: { label: t('stop.archive.viewProgress'), run: () => openArchiveDialog(workspaceId) }, report: false
      })
      return
    }
    if (removalNeedsAttention(outcome.docker)) {
      setDocker(outcome.docker!)
      showToast(t('docker.result.archived', { name: ws.name }), 'info', {
        action: { label: t('stop.archive.viewProgress'), run: () => openArchiveDialog(workspaceId) }
      })
      return
    }
    if (outcome.docker?.removed.length) showToast(t('docker.result.removed', { count: outcome.docker.removed.length }))
    else showToast(t('stop.archive.completed', { name: ws.name }))
    finishBackgroundArchive(workspaceId)
  }

  if (hidden) return null

  const stopping = preview?.running ?? []
  const dockerPreview: DockerPreview | undefined = preview?.docker?.enabled ? preview.docker : undefined
  const containers = previewCount(dockerPreview)
  const steps: { id: ArchiveProgressStep; label: string }[] = [
    ...(stopping.length ? [{ id: 'stop' as const, label: t('stop.archive.step.stop', { count: stopping.length }) }] : []),
    ...(cloud ? [] : [{ id: 'checkpoint' as const, label: t('stop.archive.step.checkpoint') }]),
    { id: 'diff', label: t('stop.archive.step.diff') },
    ...(preview?.hasArchiveScript ? [{ id: 'script' as const, label: preview.archiveSteps ? t('stop.archive.step.scriptSteps', { count: preview.archiveSteps.length }) : t('stop.archive.step.script') }] : []),
    ...(dockerPreview ? [{ id: 'docker' as const, label: containers === null ? t('docker.archive.stepUnknown') : t('docker.archive.step', { count: containers }) }] : []),
    cloud ? { id: 'sandbox' as const, label: t('cloud.archive.step.sandbox') } : { id: 'remove' as const, label: t('stop.archive.step.remove') }
  ]
  const code = (text: string) => <code key="c">{text}</code>

  return (
    <Dialog
      title={t('stop.archive.title', { name: ws.name })}
      onClose={close}
      size="lg"
      className="stop-modal"
      footer={
        failure ? (
          <>
            <Button className="stop-left" variant={armed ? 'danger' : 'default'} disabled={busy} onClick={() => (armed ? void run({ from: failure.step, anyway: true }) : setArmed(true))}>
              {armed ? t(failure.step === 'checkpoint' ? 'stop.archive.anywayCheckpoint' : 'stop.archive.anywayScript') : t('stop.archive.anyway')}
            </Button>
            <Button onClick={() => finishBackgroundArchive(workspaceId)}>{t('stop.archive.keep')}</Button>
            <Button variant="primary" autoFocus disabled={busy} onClick={() => void run({ from: failure.step })}>
              {busy ? t('stop.archive.busy') : t('stop.archive.retry')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>{t(busy ? 'stop.archive.hide' : 'stop.archive.cancel')}</Button>
            <Button variant="danger" disabled={busy || (!preview && !previewFailed)} onClick={() => void run({ stopTabs: true })}>
              {busy ? t('stop.archive.busy') : stopping.length ? t('stop.archive.goStop', { count: stopping.length }) : branchChoice && deleteBranch ? t('stop.archive.goDeleteBranch') : t('stop.archive.go')}
            </Button>
          </>
        )
      }
    >
      <p className="muted stop-lede">
        {kind === 'direct'
          ? t('stop.archive.direct')
          : kind === 'adopted'
            ? t('stop.archive.adopted')
            : kind === 'history'
              ? t('stop.archive.history')
              : cloud
                ? stopping.length
                  ? t('cloud.archive.running', { count: stopping.length })
                  : t('cloud.archive.idle')
                : stopping.length
                  ? t('stop.archive.running', { count: stopping.length })
                  : t('stop.archive.idle')}
      </p>
      {stopping.length > 0 && !failure && (
        <section className="stop-group">
          <header className="stop-group-head">
            <CircleStop size={13} />
            {t('stop.archive.willStop')}
            <span className="stop-group-hint">{t('stop.archive.willStopHint')}</span>
          </header>
          {stopping.map((r) => (
            <div className="stop-row" key={r.sessionId}>
              <span className="stop-row-icon"><Spinner size={14} /></span>
              <span className="stop-row-ws">{r.title ?? t('stop.untitled')}</span>
              <span className="stop-row-text">{r.lastStep ? `${r.lastStep.name} ${toolSummary(r.lastStep.name, r.lastStep.input, preview?.folder ?? '')}`.trim() : ''}</span>
              <Tag tone="outline">{r.model}</Tag>
              {r.startedAt && <span className="stop-row-time">{formatDuration(now - Date.parse(r.startedAt))}</span>}
            </div>
          ))}
          {preview?.checksRunning && (
            <div className="stop-row">
              <span className="stop-row-icon"><Spinner size={14} /></span>
              <span className="stop-row-ws">{t('stop.archive.checkRun')}</span>
            </div>
          )}
        </section>
      )}
      {kind === 'worktree' && preview && !failure && (
        <>
          <div className="stop-columns">
            <div className="stop-column">
              <div className="stop-column-head kept">
                <Check size={13} /> {t('stop.archive.kept')}
              </div>
              <div className="stop-item">
                {t('stop.archive.chats')}
                <div className="stop-item-hint">{t('stop.archive.chatsHint')}</div>
              </div>
              {/* With the choice offered, the branch has its own row below, so choosing doesn't move it between columns. */}
              {!branchChoice && (
                <div className="stop-item">
                  {t.rich('stop.archive.branch', { branch: code(preview.branch) })}
                  {preview.unpushed && <div className="stop-item-hint">{t('stop.archive.unpushed', { count: preview.unpushed.count, against: preview.unpushed.against })}</div>}
                </div>
              )}
              <div className="stop-item">
                {preview.uncommitted === null ? t('stop.archive.uncommittedUnknown') : t('stop.archive.uncommitted', { count: preview.uncommitted })}
                {preview.uncommitted !== 0 && <div className="stop-item-hint">{t(cloud ? 'cloud.archive.uncommittedHint' : 'stop.archive.uncommittedHint')}</div>}
              </div>
              {cloud && (
                <div className="stop-item">
                  {t('cloud.archive.sandbox')}
                  <div className="stop-item-hint">{t(deleteSnapshots ? 'cloud.archive.sandboxHint' : 'cloud.archive.sandboxHintKeep')}</div>
                </div>
              )}
              {dockerPreview && (
                <div className="stop-item">
                  {t('docker.archive.kept')}
                  <div className="stop-item-hint">{t('docker.archive.keptHint')}</div>
                </div>
              )}
            </div>
            <div className="stop-column">
              <div className="stop-column-head deleted">
                <Trash2 size={13} /> {t(cloud ? 'cloud.archive.stopped' : 'stop.archive.deleted')}
              </div>
              {cloud ? (
                <div className="stop-item">
                  <Cloud size={12} /> {t('cloud.archive.processes')}
                  <div className="stop-item-hint">{t('cloud.archive.processesHint')}</div>
                </div>
              ) : (
                <div className="stop-item">
                  {t('stop.archive.folder')}
                  <div className="stop-item-hint mono">{preview.folder}</div>
                </div>
              )}
              {dockerPreview && <DockerLine preview={dockerPreview} />}
              {preview.terminals > 0 && <div className="stop-item">{t('stop.archive.terminals', { count: preview.terminals })}</div>}
            </div>
          </div>
        </>
      )}
      {branchChoice && !failure && (
        <Card className="stop-branch">
          <GitBranch size={14} className="stop-branch-icon" />
          <div className="stop-branch-text">
            {t.rich('stop.archive.branch', { branch: code(preview?.branch ?? ws.branch) })}
            {preview?.unpushed && <div className="stop-item-hint">{t('stop.archive.unpushed', { count: preview.unpushed.count, against: preview.unpushed.against })}</div>}
          </div>
          <Segmented
            label={t('stop.archive.branchChoice')}
            value={deleteBranch ? 'delete' : 'keep'}
            onChange={(v) => setDeleteBranch(v === 'delete')}
            options={[
              { value: 'keep', label: t('stop.archive.keepBranch'), disabled: busy },
              { value: 'delete', label: t('stop.archive.deleteBranchChoice'), disabled: busy }
            ]}
          />
        </Card>
      )}
      {kind === 'worktree' && (
        <div className="stop-steps">
          <span>{t('stop.archive.order')}</span>
          {steps.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <span aria-hidden>›</span>}
              <span className={`stop-step ${failure?.step === s.id || progress[s.id] === 'failed' ? 'failed' : ''} ${progress[s.id] ?? ''}`}>
                <StepMark n={i + 1} status={progress[s.id]} /> {s.label}
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {/* O19: the archive script's own steps, as they run (parallel ones together). */}
      {kind === 'worktree' && scriptSteps && scriptSteps.length > 1 && (
        <div className="stop-steps sub" aria-label={t('stop.archive.scriptStepsLabel')}>
          {scriptSteps.map((s, i) => (
            <span key={i} className={`stop-step ${s.status === 'failed' || s.status === 'timed-out' ? 'failed' : ''}`} title={s.parallel ? t('setupSteps.parallelTag') : undefined}>
              <StepMark n={i + 1} status={s.status === 'done' ? 'done' : s.status === 'running' ? 'running' : s.status === 'skipped' || s.status === 'stopped' ? 'skipped' : s.status === 'pending' ? undefined : 'failed'} /> {s.name}
            </span>
          ))}
        </div>
      )}
      {kind === 'worktree' && dockerPreview && !failure && <p className="faint small">{t('docker.archive.nonBlocking')}</p>}
      {!preview && !previewFailed && !failure && <p className="faint small">{t('stop.archive.loading')}</p>}
      {failure && (
        <Callout tone="error" role="alert" className="stop-failure">
          {t(failure.step === 'checkpoint' ? 'stop.archive.failed.checkpoint' : 'stop.archive.failed.script')}
          <div className="recovery-detail">{failure.detail}</div>
          <div className="recovery-detail">{t(cloud ? 'cloud.archive.failedLog' : 'stop.archive.failed.log')}</div>
        </Callout>
      )}
    </Dialog>
  )
}

/** G3 · #1: a step's number until it starts, then a spinner, a tick, a cross, or a dash when it was skipped. */
function StepMark({ n, status }: { n: number; status?: ArchiveProgress['status'] }) {
  if (status === 'running') return <span className="stop-step-mark"><Spinner size={12} /></span>
  if (status === 'done') return <Check size={12} className="stop-step-mark done" />
  if (status === 'failed') return <X size={12} className="stop-step-mark failed" />
  if (status === 'skipped') return <Minus size={12} className="stop-step-mark" />
  return <span className="stop-step-n">{n}</span>
}

/** O18: the Deleted column's Docker line, from docker ps when the dialog opened. */
function DockerLine({ preview }: { preview: DockerPreview & { enabled: true } }) {
  const t = useT()
  if (preview.status !== 'ok') {
    return (
      <div className="stop-item">
        {t(preview.status === 'missing' ? 'docker.archive.missing' : preview.status === 'not-running' ? 'docker.archive.notRunning' : 'docker.archive.error')}
        {preview.status === 'error' && <div className="stop-item-hint">{preview.detail}</div>}
      </div>
    )
  }
  if (!preview.containers.length) return <div className="stop-item">{t('docker.archive.none')}</div>
  return (
    <div className="stop-item">
      {t('docker.archive.removes', { count: preview.containers.length })}
      {preview.containers.map((c) => (
        <div key={c.id} className="stop-item-hint mono">
          {c.name}
        </div>
      ))}
    </div>
  )
}

/**
 * G3 · O18: Home's line for an archived workspace whose Docker step left containers behind (or couldn't ask Docker),
 * with Remove again and Dismiss. It stays until one of them, so closing the archive dialog doesn't lose it.
 */
export function DockerLeftLines() {
  const t = useT()
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const left = workspaces.filter((w) => w.state === 'archived' && w.dockerLeft)
  const [busy, setBusy] = useState<string | null>(null)
  if (!left.length) return null
  const again = async (id: string) => {
    setBusy(id)
    const result = await attempt(() => api.removeDockerContainers(id))
    setBusy(null)
    if (result && !removalNeedsAttention(result)) showToast(t('docker.result.removed', { count: result.removed.length }))
  }
  return (
    <>
      {left.map((ws) => {
        const info = ws.dockerLeft!
        const title = info.containers.length
          ? info.containers.length === 1
            ? t('docker.home.oneLeft', { name: info.containers[0] })
            : t('docker.home.left', { count: info.containers.length })
          : t(info.status === 'missing' ? 'docker.home.missing' : info.status === 'not-running' ? 'docker.home.notRunning' : 'docker.home.error')
        return (
          <Callout
            key={ws.id}
            tone="warn"
            role="status"
            actions={
              <>
                <Button title={t('docker.home.dismissTitle')} onClick={() => void attempt(() => api.dismissDockerLeft(ws.id))}>
                  {t('docker.home.dismiss')}
                </Button>
                <Button variant="primary" disabled={busy === ws.id} onClick={() => void again(ws.id)}>
                  {busy === ws.id ? t('docker.result.busy') : t('docker.result.retry')}
                </Button>
              </>
            }
          >
            <span title={info.containers.join(', ') || info.detail}>
              <strong>{title}</strong> · {t('docker.home.after', { name: ws.name })}
            </span>
          </Callout>
        )
      })}
    </>
  )
}

/** O18: shown after an archive whose Docker step left containers behind or couldn't ask Docker. */
function DockerResult({ workspaceId, name, initial, onClose }: { workspaceId: string; name: string; initial: DockerRemoval; onClose: () => void }) {
  const t = useT()
  const [result, setResult] = useState(initial)
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    const next = await attempt(() => api.removeDockerContainers(workspaceId))
    setBusy(false)
    if (!next) return
    if (!removalNeedsAttention(next)) {
      if (next.removed.length) showToast(t('docker.result.removed', { count: next.removed.length }))
      return onClose()
    }
    setResult(next)
  }
  return (
    <Dialog
      title={t('stop.archive.title', { name })}
      onClose={onClose}
      size="lg"
      className="stop-modal"
      footer={
        <>
          <Button onClick={onClose}>{t('docker.result.close')}</Button>
          <Button variant="primary" autoFocus disabled={busy} onClick={() => void retry()}>
            {busy ? t('docker.result.busy') : t('docker.result.retry')}
          </Button>
        </>
      }
    >
      <p className="muted stop-lede">{t('docker.result.archived', { name })}</p>
      <Callout tone="error" role="alert" className="stop-failure">
        {result.status === 'missing'
          ? t('docker.result.missing')
          : result.status === 'not-running'
            ? t('docker.result.notRunning')
            : result.status === 'error'
              ? t('docker.result.error', { detail: result.detail ?? '' })
              : t('docker.result.failed', { count: result.failed.length })}
        {result.failed.map((f) => (
          <div key={f.name} className="recovery-detail">
            <code>{f.name}</code> {f.detail}
          </div>
        ))}
        {result.removed.length > 0 && <div className="recovery-detail">{t('docker.result.removed', { count: result.removed.length })}</div>}
        <div className="recovery-detail">{t('docker.result.log')}</div>
      </Callout>
    </Dialog>
  )
}
