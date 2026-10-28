// Archived workspaces as an inbox: why each was archived (by you, after its scheduled run completed, after its pull
// request was merged), filtered by that, restored or deleted one at a time or together, Keep to spare one from the
// cleanup, and the cleanup's window itself (the same setting as Settings → Git).
import { Eye, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ARCHIVE_CLEANUP_DAYS, archiveReason, ARCHIVED_FILTERS, cleanupAt, matchesArchivedFilter, type ArchivedFilter } from '../../../shared/autoArchive'
import { cloudSettings } from '../../../shared/cloud'
import type { PlainKey } from '../../../shared/i18n'
import type { ArchivedWork, Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, openArchivedChats, openSessions, restoreArchived, showToast, timeAgo, useStore } from '../store'
import { ActionRow, Button, Callout, Checkbox, Dialog, IconButton, Segmented, Select, Tag } from '../ui'
import { saveSettings } from './settings/controls'
import './stopSafely.css'

const FILTER_LABEL: Record<ArchivedFilter, PlainKey> = {
  all: 'archivedList.filter.all',
  auto: 'archivedList.filter.auto',
  merged: 'archivedList.filter.merged',
  run: 'archivedList.filter.run',
  manual: 'archivedList.filter.manual'
}

const DAY_MS = 24 * 60 * 60_000

function ReasonTag({ ws }: { ws: Workspace }) {
  const t = useT()
  const reason = archiveReason(ws)
  if (reason.kind === 'merged') return <Tag tone="ok">{t('archivedList.reason.merged', { number: reason.number })}</Tag>
  if (reason.kind === 'run') return <Tag tone="info">{t('archivedList.reason.run')}</Tag>
  return <Tag>{t('archivedList.reason.manual')}</Tag>
}

/** The Archived overlay's body; Overlays.tsx gives it the overlay around it. */
export function ArchivedInbox() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const days = snapshot.settings.archiveCleanupDays ?? 0
  const archived = snapshot.workspaces.filter((w) => w.state === 'archived').sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
  const [filter, setFilter] = useState<ArchivedFilter>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string[] | null>(null)
  const shown = archived.filter((w) => matchesArchivedFilter(w, filter))
  // Only rows still archived and on screen count as picked.
  const selected = shown.filter((w) => picked.has(w.id))
  const pick = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const restore = async (id: string) => {
    setBusy(id)
    await restoreArchived(id)
    setBusy(null)
  }
  const restoreSelected = async () => {
    setBusy('selected')
    for (const w of selected) await attempt(() => api.unarchiveWorkspace(w.id))
    setPicked(new Set())
    setBusy(null)
  }
  const now = Date.now()
  if (!archived.length) return <p className="faint">{t('archivedList.empty')}</p>
  return (
    <div className="archived-inbox">
      <p className="faint small archived-hint">{t('archivedView.list.hint')}</p>
      <Segmented<ArchivedFilter>
        label={t('archivedList.filter')}
        small
        value={filter}
        onChange={(next) => (setFilter(next), setPicked(new Set()))}
        options={ARCHIVED_FILTERS.map((f) => ({ value: f, label: `${t(FILTER_LABEL[f])} ${archived.filter((w) => matchesArchivedFilter(w, f)).length}` }))}
      />
      {shown.length > 0 && (
        <div className="archived-bulk">
          <Checkbox
            checked={selected.length > 0 && selected.length === shown.length}
            indeterminate={selected.length > 0 && selected.length < shown.length}
            onChange={(e) => setPicked(new Set(e.target.checked ? shown.map((w) => w.id) : []))}
          >
            {selected.length ? t('archivedList.selected', { count: selected.length }) : t('archivedList.selectAll')}
          </Checkbox>
          {selected.length > 0 && (
            <>
              <Button size="sm" icon={<RotateCcw size={12} />} disabled={busy !== null} onClick={() => void restoreSelected()}>
                {t('archivedList.restore')}
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={busy !== null} onClick={() => setDeleting(selected.map((w) => w.id))}>
                {t('archivedList.deleteSelected')}
              </Button>
            </>
          )}
        </div>
      )}
      {shown.length === 0 && <p className="faint">{t('archivedList.filterEmpty')}</p>}
      <div role="list">
        {shown.map((w) => {
          const repo = snapshot.repos.find((r) => r.id === w.repoId)
          const at = cleanupAt(w, days)
          const left = at === null ? null : Math.max(0, Math.ceil((at - now) / DAY_MS))
          return (
            <ActionRow
              key={w.id}
              role="listitem"
              divided
              selected={picked.has(w.id)}
              actions={
                <>
                  {/* #13: read without restoring; nothing is called in main. */}
                  <Button size="sm" icon={<Eye size={12} />} title={t('archivedView.list.readTitle')} onClick={() => openArchivedChats(w.id)} disabled={busy !== null}>
                    {t('archivedView.list.read')}
                  </Button>
                  <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void restore(w.id)} disabled={busy !== null}>
                    {busy === w.id ? t('archivedView.restoring') : t('archivedList.restore')}
                  </Button>
                  <IconButton label={t('archivedList.delete', { name: w.name })} onClick={() => setDeleting([w.id])} disabled={busy !== null}>
                    <Trash2 size={13} />
                  </IconButton>
                </>
              }
            >
              <div className="archived-row">
                <Checkbox aria-label={t('archivedList.select', { name: w.name })} checked={picked.has(w.id)} onChange={(e) => pick(w.id, e.target.checked)} />
                <div className="archived-row-text">
                  <div className="archived-row-head">
                    <span className="archived-name">{w.name}</span>
                    <ReasonTag ws={w} />
                    {left !== null && <Tag tone="warn">{t('archivedList.deletesIn', { count: left })}</Tag>}
                    {w.keepArchived && <Tag>{t('archivedList.kept')}</Tag>}
                  </div>
                  <div className="faint small mono">
                    {repo?.name} · {w.branch} · {t('archivedList.archivedAgo', { time: timeAgo(w.archivedAt) })} · {t('archivedView.list.chats', { count: openSessions(snapshot, w.id).length })}
                  </div>
                </div>
                {/* Keep: only where the cleanup could delete it (auto-archived, cleanup on), or to undo a Keep. */}
                {(left !== null || w.keepArchived) && (
                  <Checkbox checked={Boolean(w.keepArchived)} title={t('archivedList.keepTitle')} onChange={(e) => void attempt(() => api.keepArchived(w.id, e.target.checked))}>
                    {t('archivedList.keep')}
                  </Checkbox>
                )}
              </div>
            </ActionRow>
          )
        })}
      </div>
      <div className="archived-cleanup">
        <Select
          label={t('settings.git.archiveCleanup.label')}
          width={130}
          value={String(days)}
          options={ARCHIVE_CLEANUP_DAYS.map((n) => ({ value: String(n), label: n ? t('settings.git.archiveCleanup.days', { count: n }) : t('settings.git.archiveCleanup.never') }))}
          onChange={(value) => void saveSettings({ archiveCleanupDays: Number(value) })}
        />
        <span className="faint small">{t('archivedList.cleanupNote')}</span>
      </div>
      {deleting && (
        <DeleteArchivedDialog
          ids={deleting}
          onClose={(deleted) => {
            setDeleting(null)
            if (deleted) setPicked(new Set())
          }}
        />
      )}
    </div>
  )
}

/** Delete for good: what goes, what stays, and any work that isn't anywhere else, asked of main when it opens. */
export function DeleteArchivedDialog({ ids, onClose }: { ids: string[]; onClose: (deleted: boolean) => void }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const workspaces = ids.map((id) => snapshot.workspaces.find((w) => w.id === id)).filter((w): w is Workspace => Boolean(w))
  const [work, setWork] = useState<ArchivedWork[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void api.archivedWork(ids).then(
      (found) => live && setWork(found),
      // Couldn't ask: every one counts as unknown, so the dialog says so instead of claiming it's safe.
      () => live && setWork(ids.map((id) => ({ id, branch: '', deletesBranch: false, unpushed: null, uncommitted: false })))
    )
    return () => {
      live = false
    }
  }, [ids.join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id
  const atRisk = (work ?? []).filter((w) => w.unpushed !== 0 || w.uncommitted)
  const branches = (work ?? []).filter((w) => w.deletesBranch)
  const cloud = workspaces.filter((w) => w.cloud).length
  const keepSnapshots = cloud > 0 && !cloudSettings(snapshot.settings).deleteSnapshotsOnForget
  const count = workspaces.length
  const remove = async () => {
    setBusy(true)
    const done = await attempt(async () => (await api.deleteArchived(ids), true))
    setBusy(false)
    if (!done) return
    showToast(count === 1 ? t('archivedDelete.done.one', { name: workspaces[0]?.name ?? '' }) : t('archivedDelete.done.other', { count }))
    onClose(true)
  }
  return (
    <Dialog
      title={count === 1 ? t('archivedDelete.title.one', { name: workspaces[0]?.name ?? '' }) : t('archivedDelete.title.other', { count })}
      onClose={() => onClose(false)}
      size="md"
      className="stop-modal"
      footer={
        <>
          <Button onClick={() => onClose(false)}>{t('stop.archive.cancel')}</Button>
          <Button variant="danger" disabled={busy || !work} onClick={() => void remove()}>
            {busy ? t('archivedDelete.busy') : atRisk.length ? t('archivedDelete.goAnyway') : t('archivedDelete.go', { count })}
          </Button>
        </>
      }
    >
      <p className="muted stop-lede">{t('archivedDelete.lede')}</p>
      <div className="stop-columns">
        <div className="stop-column">
          <div className="stop-column-head deleted">
            <Trash2 size={13} /> {t('stop.archive.deleted')}
          </div>
          <div className="stop-item">{t('archivedDelete.chats')}</div>
          {branches.length > 0 && (
            <div className="stop-item">
              {branches.length === 1 ? t('archivedDelete.branch', { branch: branches[0].branch }) : t('archivedDelete.branches', { count: branches.length })}
            </div>
          )}
          {count > cloud && <div className="stop-item">{t('archivedDelete.saved')}</div>}
          {cloud > 0 && <div className="stop-item">{t('archivedDelete.sandbox', { count: cloud })}</div>}
          <div className="stop-item">{t('archivedDelete.logs')}</div>
        </div>
        <div className="stop-column">
          <div className="stop-column-head kept">{t('stop.archive.kept')}</div>
          <div className="stop-item">{t('archivedDelete.remote')}</div>
          <div className="stop-item">{t('archivedDelete.pr')}</div>
          {keepSnapshots && <div className="stop-item">{t('archivedDelete.snapshots')}</div>}
        </div>
      </div>
      {!work ? (
        <p className="faint small">{t('archivedDelete.checking')}</p>
      ) : atRisk.length ? (
        <Callout tone="warn" title={t('archivedDelete.atRisk', { count: atRisk.length })}>
          <ul className="archived-risk">
            {atRisk.map((w) => (
              <li key={w.id}>
                {w.unpushed === null
                  ? t('archivedDelete.unknown', { name: nameOf(w.id) })
                  : w.unpushed > 0
                    ? t('archivedDelete.unpushed', { name: nameOf(w.id), count: w.unpushed, against: w.against ?? '' })
                    : t('archivedDelete.uncommitted', { name: nameOf(w.id) })}
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="ok">{t('archivedDelete.safe')}</Callout>
      )}
    </Dialog>
  )
}
