// A newer Foreman is out (main/updates.ts): the sidebar's card above the footer, through the whole update. Found (Download,
// Later, Skip this version), downloading (a meter and Stop), ready (Restart, which waits for running agents, or install at
// quit), and waiting for agents (Restart now or Cancel). Where this copy can't install updates itself, Download opens the
// release page and installing stays with the user. "What's new" opens the release notes (WhatsNew.tsx).
import { Download, RotateCcw } from 'lucide-react'
import { formatMemory } from '../../../shared/i18n/time'
import { useT } from '../i18n'
import { api, attempt, useStore } from '../store'
import { Button, Callout, Meter } from '../ui'
import { openWhatsNew, runningWorkspaces } from './WhatsNew'

export function UpdateNotice() {
  const t = useT()
  const view = useStore((s) => s.snapshot!.update)
  const running = useStore((s) => runningWorkspaces(s.snapshot!).join('\n'))
  const notice = view?.notice
  if (!notice) return null
  const { version, current, url, phase } = notice
  const installable = !view.installUnavailable
  const agents = running ? running.split('\n') : []
  const whatsNew = (
    <Button size="sm" variant="ghost" onClick={() => openWhatsNew(version)}>
      {t('update.whatsNew')}
    </Button>
  )
  const later = (
    <Button size="sm" title={t('update.laterTitle')} onClick={() => void attempt(() => api.dismissUpdate(false))}>
      {t('update.later')}
    </Button>
  )

  if (phase.state === 'downloading') {
    const percent = phase.total > 0 ? Math.round((phase.transferred / phase.total) * 100) : 0
    const progress = phase.total > 0 ? t('update.progress', { done: formatMemory(phase.transferred, t.locale), total: formatMemory(phase.total, t.locale) }) : t('update.starting')
    return (
      <Callout
        tone="info"
        role="status"
        className="update-notice"
        title={t('update.downloading', { version })}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.stopUpdateDownload())}>
              {t('update.stop')}
            </Button>
            {whatsNew}
          </>
        }
      >
        <span className="update-progress">
          <span>{progress}</span>
          {phase.total > 0 && <span>{t('update.percent', { percent })}</span>}
        </span>
        <Meter value={percent} label={t('update.progressLabel')} valueText={progress} />
      </Callout>
    )
  }

  if (phase.state === 'ready') {
    return (
      <Callout
        tone="ok"
        role="status"
        className="update-notice"
        title={t('update.ready', { version })}
        actions={
          <>
            <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} title={t('update.restartTitle')} onClick={() => void attempt(() => api.restartToUpdate(true))}>
              {agents.length ? t('update.restartWhenIdle') : t('update.restart')}
            </Button>
            {!phase.onQuit && (
              <Button size="sm" onClick={() => void attempt(() => api.installUpdateOnQuit(true))}>
                {t('update.onQuit')}
              </Button>
            )}
            {whatsNew}
          </>
        }
      >
        {phase.onQuit ? t('update.readyOnQuit') : t('update.readyBody')}
      </Callout>
    )
  }

  if (phase.state === 'waiting') {
    return (
      <Callout
        tone="warn"
        role="status"
        className="update-notice"
        title={t('update.waiting', { count: Math.max(1, agents.length) })}
        actions={
          <>
            <Button size="sm" title={t('update.restartNowTitle')} onClick={() => void attempt(() => api.restartToUpdate(false))}>
              {t('update.restartNow')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.cancelUpdateRestart())}>
              {t('common.cancel')}
            </Button>
          </>
        }
      >
        {agents.length ? t('update.waitingBody', { names: agents.join(', ') }) : t('update.waitingSoon')}
      </Callout>
    )
  }

  if (phase.failed) {
    return (
      <Callout
        tone="warn"
        role="status"
        className="update-notice"
        title={t('update.failed', { version })}
        actions={
          <>
            <Button size="sm" variant="primary" onClick={() => void attempt(() => api.downloadUpdate())}>
              {t('update.retry')}
            </Button>
            <Button size="sm" title={t('update.downloadTitle')} onClick={() => void attempt(() => api.openExternal(url))}>
              {t('update.releasePage')}
            </Button>
            {later}
          </>
        }
      >
        {t('update.failedBody')}
      </Callout>
    )
  }

  return (
    <Callout
      tone="info"
      role="status"
      className="update-notice"
      title={t('update.available', { version })}
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            icon={<Download size={12} />}
            title={installable ? t('update.downloadInAppTitle') : t('update.downloadTitle')}
            onClick={() => void attempt(() => (installable ? api.downloadUpdate() : api.openExternal(url)))}
          >
            {t('update.download')}
          </Button>
          {later}
          <Button size="sm" variant="ghost" title={t('update.skipTitle', { version })} onClick={() => void attempt(() => api.dismissUpdate(true))}>
            {t('update.skip')}
          </Button>
          {whatsNew}
        </>
      }
    >
      {installable ? t('update.bodyInstallable', { current }) : t('update.body', { current })}
    </Callout>
  )
}
