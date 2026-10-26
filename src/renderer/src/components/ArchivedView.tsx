// #13: an archived workspace opened read-only. The composer becomes a banner with Restore as
// its own step, and the side panel lists what's known without a worktree. Nothing here calls
// main on its own: Restore is the existing restore; G3 adds "Fork into a new workspace" and,
// when asked, the diff kept at archive time (read from Foreman's data folder).
import { GitBranchPlus, GitPullRequest, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { formatDateTime } from '../../../shared/i18n/time'
import type { ArchivedDiff, Session, Workspace } from '../../../shared/types'
import { archivedFacts, archivedFolder } from '../archivedView'
import { useT } from '../i18n'
import { api, attempt, restoreArchived, selectWorkspace, timeAgo, useStore } from '../store'
import { FileDiffView } from './Changes'
import { DiffBadge } from './Sidebar'
import { Button, Callout } from '../ui'

/** "Archived · read only · no worktree" in place of the composer, with Restore workspace…. */
export function ArchivedBanner({ workspace, session }: { workspace: Workspace; session?: Session }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [forking, setForking] = useState(false)
  const restore = async () => {
    if (!window.confirm(t(`archivedView.restoreConfirm.${archivedFolder(workspace)}`, { name: workspace.name }))) return
    setBusy(true)
    await restoreArchived(workspace.id)
    setBusy(false)
  }
  // G3: a new workspace from the base branch whose first tab carries this chat's history; nothing is sent.
  const fork = async () => {
    if (!session || !window.confirm(t('archivedView.forkConfirm', { name: workspace.name }))) return
    setForking(true)
    const created = await attempt(() => api.forkArchivedChat(session.id))
    setForking(false)
    if (created) selectWorkspace(created.id)
  }
  return (
    <Callout
      role="status"
      title={t('archivedView.banner.title')}
      actions={
        <>
          {session && (
            <Button size="sm" icon={<GitBranchPlus size={12} />} disabled={forking} title={t('archivedView.forkTitle')} onClick={() => void fork()}>
              {forking ? t('archivedView.forking') : t('archivedView.fork')}
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} disabled={busy} title={t('archivedView.restoreTitle')} onClick={() => void restore()}>
            {busy ? t('archivedView.restoring') : t('archivedView.restore')}
          </Button>
        </>
      }
    >
      {t('archivedView.banner.body')}
    </Callout>
  )
}

/** The side panel of a read-only archived workspace: facts known without its worktree, and why there's no diff. */
export function ArchivedPanel({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const sessions = useStore((s) => s.snapshot!.sessions)
  const repoName = useStore((s) => s.snapshot!.repos.find((r) => r.id === workspace.repoId)?.name)
  const facts = archivedFacts(workspace, sessions)
  const when = (at: string | undefined) =>
    at ? `${formatDateTime(at, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${timeAgo(at)}` : t('archivedView.panel.unknown')
  const chats = [t('archivedView.panel.tabs', { count: facts.openTabs }), facts.closedTabs ? t('archivedView.panel.closedTabs', { count: facts.closedTabs }) : null].filter(Boolean).join(' · ')
  return (
    <>
      <header className="titlebar drag panel-header">
        <span className="panel-status">{t('archivedView.panel.title')}</span>
      </header>
      <div className="archived-facts">
        <dl>
          <dt>{t('archivedView.panel.archived')}</dt>
          <dd>{when(facts.archivedAt)}</dd>
          <dt>{t('archivedView.panel.repository')}</dt>
          <dd>{repoName ?? t('archivedView.panel.unknown')}</dd>
          <dt>{t('archivedView.panel.branch')}</dt>
          <dd className="mono">{facts.branch}</dd>
          <dt>{t('archivedView.panel.pr')}</dt>
          <dd title={facts.pr ? t('archivedView.panel.prTitle') : undefined}>
            {facts.pr ? (
              <>
                <GitPullRequest size={12} aria-hidden /> #{facts.pr.number} {t(`archivedView.panel.prState.${facts.pr.state}`)}
              </>
            ) : (
              t('archivedView.panel.prNone')
            )}
          </dd>
          <dt>{t('archivedView.panel.lastActivity')}</dt>
          <dd title={t('archivedView.panel.lastActivityTitle')}>{when(facts.lastActivity)}</dd>
          <dt>{t('archivedView.panel.chats')}</dt>
          <dd>{chats}</dd>
          <dt>{t('archivedView.panel.worktree')}</dt>
          <dd>{t(`archivedView.panel.folder.${facts.folder}`)}</dd>
        </dl>
        <p className="faint small">{t('archivedView.panel.footnote')}</p>
        <ArchivedDiffSection workspace={workspace} />
      </div>
    </>
  )
}

/**
 * G3 · #13: the diff as it was when the workspace was archived, read-only. Only its summary shows until asked for;
 * then it's read once from Foreman's data folder (no worktree, no git).
 */
function ArchivedDiffSection({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const summary = workspace.archiveDiff
  const [diff, setDiff] = useState<ArchivedDiff | null | 'loading' | 'gone'>(null)
  if (!summary) return <p className="faint small archived-diff-none">{t('archivedView.diff.none')}</p>
  const show = async () => {
    setDiff('loading')
    const loaded = await attempt(() => api.archivedDiff(workspace.id))
    setDiff(loaded ?? 'gone')
  }
  const when = formatDateTime(summary.at, t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <section className="archived-diff">
      <header className="archived-diff-head">
        <strong>{t('archivedView.diff.title')}</strong>
        <span className="faint small">{t('archivedView.diff.files', { count: summary.files })}</span>
        <DiffBadge additions={summary.additions} deletions={summary.deletions} />
        <span className="spacer" />
        {diff === null || diff === 'gone' ? (
          <Button size="sm" onClick={() => void show()}>
            {t('archivedView.diff.show')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setDiff(null)}>
            {t('archivedView.diff.hide')}
          </Button>
        )}
      </header>
      <p className="faint small">{t('archivedView.diff.when', { time: when })}</p>
      {summary.truncated && <p className="faint small">{t('archivedView.diff.truncated')}</p>}
      {diff === 'loading' && <p className="faint small">{t('archivedView.diff.loading')}</p>}
      {diff === 'gone' && <p className="faint small">{t('archivedView.diff.gone')}</p>}
      {diff && typeof diff === 'object' && diff.files.map((f) => <FileDiffView key={f.path} file={f} workspaceId={workspace.id} readonly commentsHidden />)}
    </section>
  )
}
