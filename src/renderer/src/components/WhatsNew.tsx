// "What's new": a release's notes from GitHub, opened from the update card or the "Updated to …" toast. For the offered
// update it also lists the agents a restart would stop and offers what the card does (download, restart now or when they
// finish). After an update, the first window to load says so once with a toast (main/updates.ts keeps the version it was on).
import { Download, RotateCcw } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { releaseUrl, type ReleaseNotes } from '../../../shared/appUpdate'
import { turnRunning } from '../../../shared/stopSafely'
import type { AppSnapshot } from '../../../shared/types'
import { formatDate } from '../../../shared/i18n/time'
import { useT } from '../i18n'
import { api, attempt, showToast, useStore } from '../store'
import { Button, Callout, Dialog, LinkButton, Spinner, Status } from '../ui'
import { Markdown } from './Markdown'
import './whatsNew.css'

// ---- which release is open (local to this feature) ----

let open: string | null = null
const listeners = new Set<() => void>()

function setOpen(version: string | null): void {
  open = version
  for (const listener of listeners) listener()
}

/** Show `version`'s notes. */
export function openWhatsNew(version: string): void {
  setOpen(version)
}

function useOpen(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open
  )
}

/** The live workspaces with a turn running here (cloud turns go on in their sandboxes and are never waited for). */
export function runningWorkspaces(snapshot: Pick<AppSnapshot, 'sessions' | 'workspaces'>): string[] {
  const names = new Set<string>()
  for (const s of snapshot.sessions) {
    const ws = snapshot.workspaces.find((w) => w.id === s.workspaceId)
    if (ws && ws.state !== 'archived' && !ws.cloud && turnRunning(s)) names.add(ws.name)
  }
  return [...names]
}

/** Mounted once in App: the dialog while open, and the toast after an update. */
export function WhatsNew() {
  const t = useT()
  const version = useOpen()
  const appVersion = useStore((s) => s.snapshot?.appVersion)
  const updatedFrom = useStore((s) => s.snapshot?.update?.updatedFrom)
  useEffect(() => {
    if (!updatedFrom || !appVersion) return
    showToast(t('update.updated', { version: appVersion }), 'info', { action: { label: t('update.whatsNew'), run: () => openWhatsNew(appVersion) }, durationMs: 15_000 })
    void api.dismissUpdated().catch(() => undefined)
  }, [updatedFrom, appVersion, t])
  return version ? <WhatsNewDialog version={version} /> : null
}

type Notes = ReleaseNotes | 'loading' | 'unknown'

function WhatsNewDialog({ version }: { version: string }) {
  const t = useT()
  const close = () => setOpen(null)
  const view = useStore((s) => s.snapshot!.update)
  const running = useStore((s) => runningWorkspaces(s.snapshot!).join('\n'))
  const agents = running ? running.split('\n') : []
  const notice = view?.notice?.version === version ? view.notice : undefined
  const installable = !view?.installUnavailable
  const [notes, setNotes] = useState<Notes>('loading')
  useEffect(() => {
    let alive = true
    setNotes('loading')
    api.releaseNotes(version).then(
      (found) => alive && setNotes(found ?? 'unknown'),
      () => alive && setNotes('unknown')
    )
    return () => {
      alive = false
    }
  }, [version])

  const phase = notice?.phase.state
  const run = (action: () => Promise<void>) => () => {
    close()
    void attempt(action)
  }
  const released = typeof notes === 'object' && notes.publishedAt ? t('update.dialog.released', { date: formatDate(notes.publishedAt, t.locale, { dateStyle: 'medium' }) }) : ''
  const where = !notice
    ? t('update.dialog.installed')
    : phase === 'ready' || phase === 'waiting'
      ? t('update.dialog.ready', { current: notice.current })
      : phase === 'downloading'
        ? t('update.dialog.downloading', { current: notice.current })
        : t('update.dialog.available', { current: notice.current })

  const footer = !notice ? (
    <Button variant="primary" autoFocus onClick={close}>
      {t('common.close')}
    </Button>
  ) : phase === 'ready' ? (
    <>
      <Button variant="ghost" className="whats-new-left" title={t('update.skipTitle', { version })} onClick={run(() => api.dismissUpdate(true))}>
        {t('update.skip')}
      </Button>
      {agents.length > 0 && (
        <Button title={t('update.restartNowTitle')} onClick={run(() => api.restartToUpdate(false))}>
          {t('update.restartNow')}
        </Button>
      )}
      <Button variant="primary" autoFocus icon={<RotateCcw size={14} />} title={t('update.restartTitle')} onClick={run(() => api.restartToUpdate(true))}>
        {agents.length ? t('update.restartWhenIdle') : t('update.restart')}
      </Button>
    </>
  ) : phase === 'available' ? (
    <>
      <Button variant="ghost" className="whats-new-left" title={t('update.skipTitle', { version })} onClick={run(() => api.dismissUpdate(true))}>
        {t('update.skip')}
      </Button>
      <Button title={t('update.laterTitle')} onClick={run(() => api.dismissUpdate(false))}>
        {t('update.later')}
      </Button>
      <Button
        variant="primary"
        autoFocus
        icon={<Download size={14} />}
        title={installable ? t('update.downloadInAppTitle') : t('update.downloadTitle')}
        onClick={run(() => (installable ? api.downloadUpdate() : api.openExternal(notice.url)))}
      >
        {t('update.download')}
      </Button>
    </>
  ) : (
    <Button variant="primary" autoFocus onClick={close}>
      {t('common.close')}
    </Button>
  )

  return (
    <Dialog title={t('update.dialog.title', { version })} description={released ? `${where} · ${released}` : where} onClose={close} closeLabel={t('common.close')} size="lg" footer={footer}>
      <div className="whats-new">
        {notes === 'loading' ? (
          <Spinner label={t('update.dialog.loading')} />
        ) : notes === 'unknown' ? (
          <Callout tone="neutral">{t('update.dialog.unknown')}</Callout>
        ) : notes.notes ? (
          <Markdown text={notes.notes} headingStart={3} />
        ) : (
          <p>{t('update.dialog.noNotes')}</p>
        )}
        <LinkButton underline onClick={() => void attempt(() => api.openExternal(notice?.url ?? releaseUrl(version)))}>
          {t('update.dialog.releasePage')}
        </LinkButton>
        {phase === 'ready' && agents.length > 0 && (
          <section className="whats-new-agents" aria-labelledby="whats-new-agents">
            <h3 id="whats-new-agents">{t('update.dialog.agents')}</h3>
            <ul>
              {agents.map((name) => (
                <li key={name}>
                  <Status tone="warn" label={t('update.dialog.working')} /> <strong>{name}</strong>
                </li>
              ))}
            </ul>
            <p className="faint small">{t('update.dialog.agentsHint')}</p>
          </section>
        )}
      </div>
    </Dialog>
  )
}
