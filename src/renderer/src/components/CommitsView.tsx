// O5: the Commits tab: the branch's commits since the merge base, newest first,
// with uncommitted work on top. Selecting a commit lists its files; a file opens
// that commit's diff alone, read-only.
import { Circle, CircleDot, GitCommitHorizontal, MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BranchCommit, BranchCommits, DiffFile, WorkspaceDiff } from '../../../shared/types'
import { useT } from '../i18n'
import { formatDateTime } from '../../../shared/i18n/time'
import { api, showError, timeAgo } from '../store'
import { ActionRow, Button, Checkbox, LinkButton, Tag } from '../ui'
import { FileDiffView, StatusIcon } from './Changes'
import { DiffBadge } from './Sidebar'
import './diffSource.css'

/** A commit's file opened in the center. */
export interface CommitFile {
  commit: BranchCommit
  diff: WorkspaceDiff
  path: string
}

const short = (sha: string) => sha.slice(0, 7)

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) }
}

/** Who made it: the tab Foreman saw make it, else the git author (never a guess). */
export function CommitWho({ commit }: { commit: BranchCommit }) {
  const t = useT()
  if (commit.tab) {
    return (
      <span className="commit-who" title={t('commits.tabTitle')}>
        <MessageSquare size={11} /> {commit.tab.title || t('commits.untitledTab')}
      </span>
    )
  }
  return (
    <span className="commit-who" title={t('commits.authorTitle')}>
      {commit.you ? t('commits.you') : commit.author}
    </span>
  )
}

export function CommitsView({
  workspaceId,
  reloadKey,
  selected,
  picking,
  picked,
  onOpen,
  onShowUncommitted,
  onPick,
  onShowPicked
}: {
  workspaceId: string
  // Changes when the list should be read again (Refresh, a turn ending).
  reloadKey: string
  selected: CommitFile | null
  picking: boolean
  picked: string[]
  onOpen: (file: CommitFile) => void
  onShowUncommitted: () => void
  onPick: (picking: boolean) => void
  onShowPicked: (shas: string[]) => void
}) {
  const t = useT()
  const [list, setList] = useState<BranchCommits | null>(null)
  const [open, setOpen] = useState<{ sha: string; diff: WorkspaceDiff | null } | null>(null)
  const [ticked, setTicked] = useState<string[]>(picked)

  useEffect(() => {
    let live = true
    api.branchCommits(workspaceId).then(
      (next) => live && setList(next),
      (err) => live && showError(err)
    )
    return () => {
      live = false
    }
  }, [workspaceId, reloadKey])

  useEffect(() => {
    if (picking) setTicked(picked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking])

  const expand = (commit: BranchCommit) => {
    if (open?.sha === commit.sha) return setOpen(null)
    setOpen({ sha: commit.sha, diff: null })
    // A commit never changes, so its diff is read once.
    api.getDiff(workspaceId, 'commit', [commit.sha]).then(
      (diff) => setOpen((cur) => (cur?.sha === commit.sha ? { sha: commit.sha, diff } : cur)),
      (err) => showError(err)
    )
  }

  if (!list) return <div className="panel-empty faint">{t('commits.loading')}</div>
  const base = list.baseRef
  const { uncommitted } = list

  return (
    <div className="commits">
      <div className="commits-head faint small">{list.commits.length ? t('commits.since', { count: list.commits.length, base }) : t('commits.none', { base })}</div>
      <ActionRow className="commit-entry" primaryProps={{ className: 'commit-row' }} onPress={onShowUncommitted} disabled={!uncommitted.files}>
        <CircleDot size={13} className="commit-dot uncommitted" />
        <span className="commit-subject">{uncommitted.files ? t('commits.uncommitted') : t('commits.nothingUncommitted')}</span>
        <DiffBadge additions={uncommitted.additions} deletions={uncommitted.deletions} />
        {uncommitted.files > 0 && (
          <span className="commit-meta faint small">
            {t('diffSource.files', { count: uncommitted.files })}
            {uncommitted.staged > 0 && <> · {t('commits.staged', { count: uncommitted.staged })}</>}
          </span>
        )}
      </ActionRow>
      {list.commits.map((c) => (
        <div key={c.sha}>
          <div className="commit-item">
            {picking && (
              <Checkbox
                className="commit-pick"
                checked={ticked.includes(c.sha)}
                aria-label={c.subject}
                onChange={(e) => setTicked(e.target.checked ? [...ticked, c.sha] : ticked.filter((s) => s !== c.sha))}
              />
            )}
            <ActionRow className="commit-entry" selected={open?.sha === c.sha} primaryProps={{ className: 'commit-row', 'aria-expanded': open?.sha === c.sha, title: c.subject }} onPress={() => expand(c)}>
              <GitCommitHorizontal size={13} className="commit-dot" />
              <span className="commit-subject">{c.subject}</span>
              <DiffBadge additions={c.additions} deletions={c.deletions} />
              <span className="commit-meta faint small">
                <span className="mono">{short(c.sha)}</span> · <CommitWho commit={c} /> · <span title={formatDateTime(c.at, t.locale)}>{timeAgo(c.at)}</span>
                {c.pushed === false && <Tag>{t('commits.notPushed')}</Tag>}
              </span>
            </ActionRow>
          </div>
          {open?.sha === c.sha && (
            <div className="commit-files">
              {!open.diff ? (
                <div className="panel-empty faint">{t('commits.loading')}</div>
              ) : open.diff.files.length === 0 ? (
                <div className="panel-empty faint">{t('commits.noFiles')}</div>
              ) : (
                open.diff.files.map((f) => {
                  const { name, dir } = splitPath(f.path)
                  return (
                    <ActionRow
                      key={f.path}
                      className="change-entry"
                      selected={selected?.commit.sha === c.sha && selected.path === f.path}
                      primaryProps={{ className: 'change-row', title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }}
                      onPress={() => onOpen({ commit: c, diff: open.diff!, path: f.path })}
                    >
                      <StatusIcon status={f.status} />
                      <span className="change-name mono">{name}</span>
                      <span className="change-dir mono">{dir}</span>
                      <DiffBadge additions={f.additions} deletions={f.deletions} />
                    </ActionRow>
                  )
                })
              )}
            </div>
          )}
        </div>
      ))}
      {list.more && <div className="panel-empty faint">{t('commits.more')}</div>}
      {list.commits.length > 0 &&
        (picking ? (
          <div className="commits-pick">
            <span className="faint small">{t('commits.picking', { count: ticked.length })}</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => onPick(false)}>
              {t('commits.cancelPick')}
            </Button>
            <Button size="sm" variant="primary" disabled={!ticked.length} onClick={() => onShowPicked(ticked)}>
              {t('commits.showPicked')}
            </Button>
          </div>
        ) : (
          <div className="commits-pick">
            <LinkButton size="sm" onClick={() => onPick(true)}>
              {t('commits.pick')}
            </LinkButton>
          </div>
        ))}
      <div className="commits-foot faint small">
        {list.commits.length > 0 && <p>{t('commits.attribution')}</p>}
        <p>
          {t('commits.branched', { base, sha: short(list.mergeBase) })} {list.pushedTo ? t('commits.pushedTo', { sha: short(list.pushedTo) }) : t('commits.noRemote')}
        </p>
      </div>
    </div>
  )
}

/** One commit's file in the center: which commit, read only, with a way back to All changes. */
/**
 * G2 (O5): the same file in All changes (the whole branch plus uncommitted work), for "this commit +a −b · whole
 * branch +x −y". `branchFile` is the Changes panel's when it shows All changes (null: not changed there); otherwise
 * it is read once here.
 */
function useBranchFile(workspaceId: string, path: string, given: DiffFile | null | undefined): DiffFile | null | undefined {
  const [read, setRead] = useState<{ path: string; file: DiffFile | null } | null>(null)
  useEffect(() => {
    if (given !== undefined) return
    let live = true
    api.getDiff(workspaceId, 'all').then(
      (d) => live && setRead({ path, file: d.files.find((f) => f.path === path) ?? null }),
      () => live && setRead(null)
    )
    return () => {
      live = false
    }
  }, [workspaceId, path, given])
  if (given !== undefined) return given
  return read?.path === path ? read.file : undefined
}

export function CommitFileView({ file, workspaceId, branchFile, onOpenInAll }: { file: CommitFile; workspaceId: string; branchFile?: DiffFile | null; onOpenInAll: () => void }) {
  const t = useT()
  const diffFile = file.diff.files.find((f) => f.path === file.path)
  const { commit } = file
  const whole = useBranchFile(workspaceId, file.path, branchFile)
  return (
    <>
      <div className="commit-banner">
        <Circle size={9} className="faint" />
        <span className="mono faint">{short(commit.sha)}</span>
        <span className="commit-subject">{commit.subject}</span>
        <span className="faint">
          <CommitWho commit={commit} /> · {timeAgo(commit.at)}
        </span>
        <span className="spacer" />
        {diffFile && (
          <span className="faint small commit-totals" title={t('commits.totalsTitle')}>
            {t('commits.thisCommit')} <span className="ok">+{diffFile.additions}</span> <span className="bad">−{diffFile.deletions}</span>
            {whole !== undefined && (
              <>
                {' · '}
                {t('commits.wholeBranch')}{' '}
                {whole ? (
                  <>
                    <span className="ok">+{whole.additions}</span> <span className="bad">−{whole.deletions}</span>
                  </>
                ) : (
                  t('commits.wholeBranchNone')
                )}
              </>
            )}
          </span>
        )}
        <Tag tone="outline">{t('commits.readOnly')}</Tag>
        <LinkButton size="sm" onClick={onOpenInAll}>
          {t('commits.openInAll')}
        </LinkButton>
      </div>
      {diffFile ? <FileDiffView file={diffFile} workspaceId={workspaceId} readonly commentsHidden /> : <div className="center-empty muted">{t('commits.fileGone')}</div>}
    </>
  )
}
