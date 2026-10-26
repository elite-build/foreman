// The red card under a turn that changed files under the repository's sensitive
// paths, and the dialog that shows what changed between the turn's start and end.
import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SensitiveAlert, WorkspaceDiff } from '../../../shared/types'
import { api, attempt, fillComposer, openAlertDiff, useStore } from '../store'
import { FileDiffView } from './Changes'
import { Button, Callout, Dialog } from '../ui'
import { useT } from '../i18n'

export function tellAgentText(files: string[]): string {
  return `${files.length === 1 ? 'This file' : 'These files'} matches the repository's sensitive paths and changed in your last turn:\n${files.map((f) => `- ${f}`).join('\n')}\n\nPlease explain why, and revert anything that isn't needed.`
}

export function SensitiveCard({ alert, workspaceId }: { alert: SensitiveAlert; workspaceId: string }) {
  const t = useT()
  return (
    <Callout
      tone="error"
      role="alert"
      className="sensitive-card"
      title={
        <span className="sensitive-title">
          <ShieldAlert size={14} /> {alert.unavailable ? t('sensitive.unavailableTitle') : t('sensitive.title')}
        </span>
      }
      actions={
        <>
          {!alert.unavailable && (
            <>
              <Button size="sm" onClick={() => openAlertDiff({ workspaceId, alertId: alert.id })}>
                {t('sensitive.viewDiff')}
              </Button>
              <Button size="sm" onClick={() => fillComposer(workspaceId, alert.sessionId, tellAgentText(alert.files))}>
                {t('sensitive.tellAgent')}
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => void attempt(() => api.dismissAlert(workspaceId, alert.id))}>
            {t('common.dismiss')}
          </Button>
        </>
      }
    >
      {alert.unavailable ? (
        <div className="recovery-detail">{t('sensitive.unavailable')}</div>
      ) : (
        <ul className="sensitive-files mono">
          {alert.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <div className="recovery-detail">{t('sensitive.scope')}</div>
    </Callout>
  )
}

export function AlertDiffDialog({ workspaceId, alertId }: { workspaceId: string; alertId: string }) {
  const alert = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.alerts?.find((a) => a.id === alertId))
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const t = useT()
  const close = () => openAlertDiff(null)
  useEffect(() => {
    void attempt(() => api.getAlertDiff(workspaceId, alertId)).then((d) => (d ? setDiff(d) : close()))
  }, [workspaceId, alertId])
  if (!alert) return null
  return (
    <Dialog title={t('sensitive.diff.title')} onClose={close} size="xl">
      {!diff && <p className="muted">{t('common.loading')}</p>}
      {/* G3 · O6: the new side is the turn's end checkpoint, so the unchanged lines between hunks come from it. */}
      {diff?.files.map((f) => <FileDiffView key={f.path} file={f} workspaceId={workspaceId} readonly headingLevel={3} readContent={(path) => api.alertFile(workspaceId, alertId, path)} />)}
      {diff?.truncated && <p className="faint small">{t('sensitive.diff.truncated')}</p>}
      {diff && diff.files.length === 0 && <p className="muted">{t('sensitive.diff.empty')}</p>}
    </Dialog>
  )
}
