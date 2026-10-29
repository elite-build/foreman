import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ChevronRight,
  Play,
  Square,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Moon,
  RotateCw,
  ScanSearch,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { durationText, fingerprintText, isFailure, STATUS_TEXT, summarizeChecks, type ChecksTone } from '../../../shared/checks'
import type { CheckRow, ChecksStatus, DiffComment, GitActionKind, GitStatus, PrCheck, PullRequestInfo } from '../../../shared/types'
import { jobDuration } from '../../../shared/scm'
import { McpSection } from './McpConsent'
import { activeSessionId, api, attempt, getState, modKey, openArchiveDialog, openFixChecks, openHandOffDialog, openSettingsPage, runChecks, timeAgo, useStore, useWindowVisible } from '../store'
import { useStoreMemo } from '../storeMemo'
import { useT } from '../i18n'
import type { PlainKey } from '../../../shared/i18n'
import { formatClock, formatDateTime } from '../../../shared/i18n/time'
import { cloudStatusWord } from '../cloudView'
import { Button, Checkbox, IconButton, Kbd, LinkButton, MenuItem, MenuSeparator, Spinner, SplitButton, Stepper, Tag, type StepperStep } from '../ui'
import { statusText } from './cloud/CloudBits'
import { GitlabMark } from './GitlabMark'
import { AutoFixStatus, AutoFixToggle } from './AutoFix'
import { Reviews } from './Reviews'

export function useGitStatus(workspaceId: string, shown: boolean, running: boolean) {
  // Nobody sees it while the window is minimized; it reads again when the window comes back.
  const visible = useWindowVisible()
  const enabled = shown && visible
  const [status, setStatus] = useState<GitStatus | null>(null)
  const busy = useRef(false)
  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      setStatus(await api.gitStatus(workspaceId))
    } catch {
      // Not a git state we can read right now; keep the last one.
    } finally {
      busy.current = false
    }
  }, [workspaceId])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    // Poll gently: GitHub rate limits apply to the CLI too.
    const timer = setInterval(() => void refresh(), running ? 10_000 : 20_000)
    return () => clearInterval(timer)
  }, [enabled, running, refresh])

  return { status, refresh }
}

/** Recorded checks for a workspace, with staleness worked out against the tree as it is now. */
export function useChecksStatus(workspaceId: string): ChecksStatus | null {
  const configured = useStore((s) => {
    const ws = s.snapshot!.workspaces.find((w) => w.id === workspaceId)
    return (ws ? s.snapshot!.repoSettings[ws.repoId]?.values.checks.length : 0) ?? 0
  })
  // Anything that changes the record or the files should look again. Written out only when one of them is a new object.
  const key = useStoreMemo(
    (s) => {
      const ws = s.snapshot!.workspaces.find((w) => w.id === workspaceId)
      return [ws?.checks, ws?.diffStat, s.snapshot!.repoSettings[ws?.repoId ?? '']?.values.checks]
    },
    (parts) => JSON.stringify(parts)
  )
  const [status, setStatus] = useState<ChecksStatus | null>(null)
  const visible = useWindowVisible()
  useEffect(() => {
    if (!visible) return
    if (!configured) {
      setStatus(null)
      return
    }
    let live = true
    const load = () =>
      api
        .checksStatus(workspaceId)
        .then((next) => live && setStatus(next))
        .catch(() => undefined)
    void load()
    const timer = setInterval(() => void load(), 20_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [workspaceId, configured, key, visible])
  return configured ? status : null
}

const PR_STATE: Record<PullRequestInfo['state'], PlainKey> = { OPEN: 'gitlab.panel.state.open', CLOSED: 'gitlab.panel.state.closed', MERGED: 'gitlab.panel.state.merged' }

const TONE_ICON: Record<ChecksTone, typeof CircleCheck> = { ok: CircleCheck, bad: CircleX, warn: CircleAlert, running: Loader2, idle: CircleDashed }

function CheckRowDetail({ row }: { row: CheckRow }) {
  const result = row.result
  const t = useT()
  return (
    <div className="check-detail">
      <div className="check-detail-head">
        <span className="check-detail-name">{row.name}</span>
        <span className={`check-detail-status ${result && isFailure(result) ? 'bad' : ''}`}>
          {result ? t(STATUS_TEXT[result.status]) : t('gitPanel.check.notRun')}
          {result?.exitCode !== undefined && result.status !== 'passed' && ` · ${t('gitPanel.check.exit', { code: result.exitCode })}`}
          {result?.durationMs !== undefined && ` · ${durationText(result.durationMs, t)}`}
          {row.stale && result && ` · ${t('gitPanel.check.stale')}`}
        </span>
        <span className="spacer" />
        {result && (
          <LinkButton size="sm" title={result.logPath} onClick={() => void attempt(() => api.openPath(result.logPath))}>
            {t('gitPanel.check.log')}
          </LinkButton>
        )}
      </div>
      <code className="check-detail-command mono">{row.command.split('\n')[0]}</code>
      {result && (
        <div className="faint small check-detail-evidence" title={`${formatDateTime(result.startedAt, t.locale)} · ${fingerprintText(result.fingerprint, t)}`}>
          {formatDateTime(result.startedAt, t.locale)} · {fingerprintText(result.fingerprint, t)}
        </div>
      )}
    </div>
  )
}

/**
 * The one evidence row, above the other Git rows: what the configured checks last
 * did, and whether that still describes these files. Shown only when checks exist.
 * It states what ran; it never says anything is verified or ready.
 */
function ChecksEvidence({ workspaceId, comments }: { workspaceId: string; comments: number | null }) {
  const status = useChecksStatus(workspaceId)
  const auto = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.autoChecks?.state)
  const [open, setOpen] = useState(false)
  const t = useT()
  if (!status?.configured) return null
  const summary = summarizeChecks(status.rows, { running: status.running, comments }, t)
  if (status.running && auto === 'running') summary.text = summary.text.replace(t('checks.summary.running'), t('checks.summary.runningAfterTurn'))
  const Icon = TONE_ICON[summary.tone]
  const failing = status.rows.some((r) => r.result && isFailure(r.result))
  return (
    <div className={`checks-evidence tone-${summary.tone}`}>
      <div className="check-row">
        <IconButton aria-expanded={open} label={open ? t('gitPanel.check.hideDetails') : t('gitPanel.check.showDetails')} onClick={() => setOpen(!open)}>
          <ChevronRight size={13} className={open ? 'chev open' : 'chev'} />
        </IconButton>
        {status.running ? <span className={`evidence-icon ${summary.tone}`}><Spinner size={14} /></span> : <Icon size={14} className={`evidence-icon ${summary.tone}`} />}
        <span className="check-label" title={summary.text}>{summary.text}</span>
        {status.running ? (
          <Button size="sm" icon={<Square size={11} />} onClick={() => void attempt(() => api.cancelChecks(workspaceId))}>
            {t('common.cancel')}
          </Button>
        ) : (
          <>
            {failing && (
              <Button size="sm" icon={<Wrench size={12} />} onClick={() => openFixChecks(workspaceId)}>
                {t('gitPanel.check.fixInChat')}
              </Button>
            )}
            <Button size="sm" icon={<Play size={11} />} onClick={() => void runChecks(workspaceId)}>
              {t('gitPanel.check.run')}
            </Button>
          </>
        )}
      </div>
      {!status.running && auto === 'waiting' && <div className="faint small check-auto">{t('gitPanel.check.waiting')}</div>}
      {!status.running && auto === 'needs-approval' && (
        <div className="check-row check-auto">
          <span className="check-label">{t('gitPanel.check.needsApproval')}</span>
          <Button size="sm" onClick={() => void runChecks(workspaceId)}>
            {t('gitPanel.check.reviewCommands')}
          </Button>
        </div>
      )}
      {open && (
        <div className="check-details">
          {status.rows.map((row) => (
            <CheckRowDetail key={row.name} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}

const ACTION_ICON: Partial<Record<GitActionKind, typeof GitPullRequest>> = {
  'create-pr': GitPullRequest,
  'commit-and-push': ArrowUpFromLine,
  push: ArrowUpFromLine,
  pull: ArrowDownToLine,
  merge: GitMerge,
  'fix-errors': Wrench,
  'resolve-conflicts': GitMerge,
  'ready-for-review': Check,
  automerge: GitMerge,
  archive: Archive
}

const ACTION_LABEL: Partial<Record<GitActionKind, PlainKey>> = {
  'create-pr': 'gitPanel.action.createPr',
  'commit-and-push': 'gitPanel.action.commitAndPush',
  push: 'gitPanel.action.push',
  pull: 'gitPanel.action.pull',
  merge: 'gitPanel.action.merge',
  'fix-errors': 'gitPanel.action.fixErrors',
  'resolve-conflicts': 'gitPanel.action.resolve',
  'ready-for-review': 'gitPanel.action.readyForReview',
  archive: 'gitPanel.action.archive'
}

export async function runGitAction(workspaceId: string, action: GitActionKind, after?: () => void): Promise<void> {
  if (action === 'archive') {
    openArchiveDialog(workspaceId)
    return
  }
  const sessionId = activeSessionId(getState(), workspaceId)
  if (action === 'review') {
    // Review asks which model first, in the same dialog as Second opinion.
    if (sessionId) openHandOffDialog({ sourceId: sessionId, kind: 'review' })
    return
  }
  await attempt(() => api.gitAction(workspaceId, action, sessionId))
  after?.()
}

/** The pull request's number (a GitLab merge request's !iid), opening it in the browser. */
function PrNumberLink({ pr }: { pr: PullRequestInfo }) {
  const t = useT()
  const gitlab = pr.provider === 'gitlab'
  return (
    <LinkButton underline title={gitlab ? t('gitPanel.merged.openMr') : t('gitPanel.merged.openPr')} onClick={() => void attempt(() => api.openExternal(pr.url))}>
      {gitlab ? '!' : '#'}
      {pr.number}
    </LinkButton>
  )
}

/** The header's status while there is a pull request that hasn't merged: its number, so it's one click away, then the words. */
export function PrStatus({ pr, children }: { pr: PullRequestInfo; children: ReactNode }) {
  return (
    <span className="pr-status">
      <PrNumberLink pr={pr} />
      {children}
    </span>
  )
}

/** The header's status once the pull request merged: the state, then which PR, into what, and when. */
export function MergedStatus({ pr }: { pr: PullRequestInfo }) {
  const t = useT()
  return (
    <span className="merged-status">
      <Tag tone="info">{t('attention.pr.state.merged')}</Tag>
      <span className="merged-meta muted small">
        <PrNumberLink pr={pr} />{' '}
        {t.rich('gitPanel.merged.into', { branch: <code>{pr.baseRefName}</code> })}
        {pr.mergedAt && <> · {timeAgo(pr.mergedAt)}</>}
      </span>
    </span>
  )
}

/**
 * Under the header once the pull request merged: committed, opened, its checks (when it had any), merged. Every step
 * is behind it, and Merged is where the work is now, so the panel reads as finished rather than in progress.
 */
export function MergedProgress({ pr }: { pr: PullRequestInfo }) {
  const t = useT()
  const gitlab = pr.provider === 'gitlab'
  const passed = pr.checks.filter((c) => c.state === 'success').length
  const failed = pr.checks.some((c) => c.state === 'failure')
  const steps: StepperStep[] = [
    { id: 'committed', label: t('gitPanel.merged.step.committed'), status: 'done' },
    { id: 'pr', label: gitlab ? t('gitPanel.merged.step.mr', { number: pr.number }) : t('gitPanel.merged.step.pr', { number: pr.number }), status: 'done' },
    ...(pr.checks.length
      ? [{ id: 'checks', label: t('gitPanel.merged.step.checks', { passed, total: pr.checks.length }), status: 'done' as const, ...(failed ? { tone: 'error' as const, icon: <X size={11} strokeWidth={3} /> } : {}) }]
      : []),
    { id: 'merged', label: t('attention.pr.state.merged'), status: 'current', tone: 'info', icon: <GitMerge size={12} /> }
  ]
  return (
    <div className="merged-progress">
      <Stepper
        label={gitlab ? t('gitPanel.merged.progressMr') : t('gitPanel.merged.progress')}
        statusText={{ done: t('gitPanel.merged.step.done'), upcoming: t('gitPanel.merged.step.upcoming') }}
        steps={steps}
      />
    </div>
  )
}

/** The header's "next step" button, with the Create PR and merged Archive split menus, and Review. */
export function GitHeaderActions({ workspaceId, status, refresh, running }: { workspaceId: string; status: GitStatus | null; refresh: () => void; running: boolean }) {
  const platform = useStore((s) => s.snapshot!.platform)
  const [busy, setBusy] = useState<GitActionKind | null>(null)
  const mod = modKey(platform)

  const run = async (action: GitActionKind) => {
    setBusy(action)
    await runGitAction(workspaceId, action, refresh)
    setBusy(null)
  }

  const action = status?.primary.action
  const Icon = action ? ACTION_ICON[action] ?? Check : null
  const t = useT()
  // O2: GitLab's words for a GitLab repo.
  const gitlab = status?.scm?.kind === 'gitlab'
  const label = (a: GitActionKind) =>
    gitlab && a === 'create-pr' ? t('gitlab.header.createMr') : gitlab && a === 'ready-for-review' ? t('gitlab.header.markReady') : ACTION_LABEL[a] && t(ACTION_LABEL[a]!)
  const primary = action && Icon && (
    <>
      {busy === action ? <Spinner size={13} /> : <Icon size={13} />} {label(action) ?? status?.primary.label}
    </>
  )
  const primaryDisabled = busy !== null || (running && action !== 'archive')
  // An adopted checkout's branch isn't Foreman's to delete.
  const adopted = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.adopted)
  const pr = status?.pr
  // The merged Archive button runs whichever archive was used last; the dialog still confirms it.
  const archiveChoice = useStore((s) => s.archiveChoice)
  const deleteNext = archiveChoice === 'delete-branch' && !adopted
  const archiveDeleteBranch = () => openArchiveDialog(workspaceId, { deleteBranch: true })
  const lastUsed = t('gitPanel.merged.lastUsed')

  return (
    <div className="git-actions">
      {/* Nothing left to review once it merged. */}
      {action !== 'archive' && (
        <Button
          size="sm"
          variant="ghost"
          icon={<ScanSearch size={13} />}
          title={t('gitPanel.reviewTitle', { keys: `${mod}⇧R` })}
          onClick={() => void run('review')}
          disabled={busy !== null}
        >
          <span className="btn-label">{t('gitPanel.review')}</span>
        </Button>
      )}
      {action && Icon && action === 'create-pr' && (
        <SplitButton
          size="sm"
          label={primary}
          menuLabel={gitlab ? t('gitlab.header.moreOptions') : t('gitPanel.moreOptions')}
          onClick={() => void run(action)}
          disabled={primaryDisabled}
          // The menu's choices stay reachable while an agent runs or another action is busy, as before.
          menuDisabled={false}
          title={status?.primary.label}
        >
          <MenuItem icon={<GitPullRequest size={14} />} hint={<Kbd>{mod}⇧P</Kbd>} onSelect={() => void run('create-pr')}>
            {gitlab ? t('gitlab.header.createMr') : t('gitPanel.action.createPr')}
          </MenuItem>
          <MenuItem icon={<CircleDashed size={14} />} onSelect={() => void run('create-draft-pr')}>
            {gitlab ? t('gitlab.header.createDraftMr') : t('gitPanel.createDraftPr')}
          </MenuItem>
          <MenuItem icon={<ExternalLink size={14} />} onSelect={() => void run('create-pr-web')}>
            {gitlab ? t('gitlab.header.createMrWeb') : t('gitPanel.createPrWeb')}
          </MenuItem>
        </SplitButton>
      )}
      {action && Icon && action === 'archive' && (
        <SplitButton
          size="sm"
          variant="primary"
          label={
            deleteNext ? (
              <>
                <Trash2 size={13} /> {t('gitPanel.merged.archiveDeleteBranch')}
              </>
            ) : (
              primary
            )
          }
          menuLabel={t('gitPanel.merged.moreOptions')}
          onClick={() => (deleteNext ? archiveDeleteBranch() : void run(action))}
          disabled={primaryDisabled}
          title={deleteNext ? t('gitPanel.merged.archiveDeleteBranch') : status?.primary.label}
        >
          <MenuItem icon={<Archive size={14} />} hint={archiveChoice && !deleteNext ? lastUsed : undefined} onSelect={() => void run('archive')}>
            {t('gitPanel.action.archive')}
          </MenuItem>
          {!adopted && (
            <MenuItem icon={<Trash2 size={14} />} hint={deleteNext ? lastUsed : undefined} onSelect={archiveDeleteBranch}>
              {t('gitPanel.merged.archiveDeleteBranch')}
            </MenuItem>
          )}
          {pr && (
            <>
              <MenuSeparator />
              <MenuItem icon={<ExternalLink size={14} />} onSelect={() => void attempt(() => api.openExternal(pr.url))}>
                {gitlab ? t('gitPanel.merged.openMrNumber', { number: pr.number }) : t('gitPanel.merged.openPrNumber', { number: pr.number })}
              </MenuItem>
            </>
          )}
        </SplitButton>
      )}
      {action && Icon && action !== 'create-pr' && action !== 'archive' && (
        <Button size="sm" variant={action === 'merge' ? 'primary' : 'default'} onClick={() => void run(action)} disabled={primaryDisabled} title={status?.primary.label}>
          {primary}
        </Button>
      )}
    </div>
  )
}

function CheckIcon({ state }: { state: PrCheck['state'] }) {
  if (state === 'success') return <CircleCheck size={14} className="ok" />
  if (state === 'failure') return <CircleX size={14} className="bad" />
  if (state === 'pending') return <span className="warn"><Spinner size={14} /></span>
  return <CircleDashed size={14} className="faint" />
}

/** A cloud workspace whose sandbox isn't running: the rows below are from `asOf` (or there are none yet), with Wake. */
function SandboxNotRunning({ workspaceId, asOf }: { workspaceId: string; asOf?: string }) {
  const t = useT()
  const cloud = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.cloud)
  const [busy, setBusy] = useState(false)
  // Gone, failed or archived: the workspace's banner says so, with what can be done.
  if (!cloud || !['sleeping', 'capped', 'unresponsive', 'waking', 'creating'].includes(cloud.status)) return null
  const word = statusText(t, cloudStatusWord(cloud.status, false))
  // Still starting or waking: nothing to do but wait. Unresponsive: Restart, as its banner offers.
  const action = cloud.status === 'waking' || cloud.status === 'creating' ? null : cloud.status === 'unresponsive' ? 'restart' : 'wake'
  const sameDay = asOf && new Date(asOf).toDateString() === new Date().toDateString()
  const time = asOf ? (sameDay ? formatClock(asOf, t.locale) : formatDateTime(asOf, t.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : ''
  const act = () => {
    setBusy(true)
    void attempt(() => (action === 'restart' ? api.cloudRestart(workspaceId) : api.cloudWake(workspaceId))).finally(() => setBusy(false))
  }
  return (
    <Row
      icon={<Moon size={14} className="faint" />}
      label={asOf ? t('cloud.git.asOf', { time, status: word }) : t('cloud.git.notRunning', { status: word })}
      action={
        action ? (
          <Button size="sm" disabled={busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={act}>
            {action === 'restart' ? t('cloud.action.restart') : t('cloud.action.wake')}
          </Button>
        ) : undefined
      }
    />
  )
}

function Row({ icon, label, action }: { icon: React.ReactNode; label: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="check-row">
      {icon}
      <span className="check-label">{label}</span>
      {action}
    </div>
  )
}

/** The opt-in notifications for this workspace's pull request. */
function PrWatchToggles({ workspaceId, gitlab }: { workspaceId: string; gitlab?: boolean }) {
  const watch = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.prWatch)
  const t = useT()
  return (
    <div className="pr-watch">
      <Checkbox className="review-select" checked={Boolean(watch?.ci)} onChange={(e) => void attempt(() => api.setPrWatch(workspaceId, 'ci', e.target.checked))}>
        {gitlab ? t('gitlab.panel.watchCi') : t('gitPanel.watch.ci')}
      </Checkbox>
      <AutoFixToggle workspaceId={workspaceId} gitlab={gitlab} />
      <Checkbox className="review-select" checked={Boolean(watch?.reviews)} onChange={(e) => void attempt(() => api.setPrWatch(workspaceId, 'reviews', e.target.checked))}>
        {gitlab ? t('gitlab.panel.watchReviews') : t('gitPanel.watch.reviews')}
      </Checkbox>
    </div>
  )
}

/** Repo-wide opt-in: warn on Home when the base moves and now conflicts with committed work. */
function BaseWatchToggle({ workspaceId }: { workspaceId: string }) {
  const repoId = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.repoId)
  const on = useStore((s) => (repoId ? s.snapshot!.repoSettings[repoId]?.values.warnBaseMoved : false))
  const [support, setSupport] = useState<{ ok: boolean; version?: string } | null>(null)
  const t = useT()
  useEffect(() => {
    void api.baseWatchSupport().then(setSupport, () => setSupport(null))
  }, [])
  if (!repoId) return null
  const unsupported = support?.ok === false
  return (
    <div className="pr-watch">
      <Checkbox
        className="review-select"
        title={t('gitPanel.baseWatch.title')}
        checked={Boolean(on) && !unsupported}
        disabled={unsupported}
        onChange={(e) => void attempt(() => api.updateRepoSettings(repoId, { warnBaseMoved: e.target.checked }))}
      >
        <span title={t('gitPanel.baseWatch.title')}>{t('gitPanel.baseWatch.label')}</span>
        {unsupported && <span className="faint small"> · {support?.version ? t('gitPanel.baseWatch.needsGitHas', { version: support.version }) : t('gitPanel.baseWatch.needsGit')}</span>}
      </Checkbox>
    </div>
  )
}

export function ChecksView({ workspaceId, status, refresh }: { workspaceId: string; status: GitStatus | null; refresh: () => void }) {
  const comments = useStore((s) => s.snapshot!.comments)
  // Unresolved review threads on the pull request, once Reviews has counted them.
  const [openThreads, setOpenThreads] = useState<number | null>(null)
  const agentComments = comments.filter((c) => c.workspaceId === workspaceId && c.author === 'agent' && c.state === 'open')
  // A cloud workspace's sandbox status: while it isn't running, the rows are the last ones read (status.asOf).
  const cloudStatus = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.cloud?.status)
  const t = useT()
  const go = (action: GitActionKind, label?: string) => (
    <Button size="sm" onClick={() => void runGitAction(workspaceId, action, refresh)}>
      {label ?? (ACTION_LABEL[action] ? t(ACTION_LABEL[action]!) : action)}
    </Button>
  )

  if (!status) {
    return (
      <div className="checks">
        <ChecksEvidence workspaceId={workspaceId} comments={null} />
        {cloudStatus && cloudStatus !== 'running' ? <SandboxNotRunning workspaceId={workspaceId} /> : <div className="panel-empty faint">{t('gitPanel.checkingStatus')}</div>}
      </div>
    )
  }
  const pr = status.pr
  const failing = pr?.checks.filter((c) => c.state === 'failure') ?? []
  // O2: a GitLab repo, read with its host's token, in GitLab's words.
  const lab = status.scm?.kind === 'gitlab' ? status.scm : null
  const mr = pr?.provider === 'gitlab' ? pr : undefined

  return (
    <div className="checks">
      <ChecksEvidence workspaceId={workspaceId} comments={pr ? openThreads : null} />
      {status.asOf && cloudStatus !== 'running' && <SandboxNotRunning workspaceId={workspaceId} asOf={status.asOf} />}
      {!status.hasRemote && <Row icon={<CircleAlert size={14} className="faint" />} label={t('gitPanel.noRemote')} />}
      {status.hasRemote && !status.ghAvailable && !lab && (
        <Row icon={<CircleAlert size={14} className="warn" />} label={t('gitPanel.noGh')} />
      )}
      {lab && !lab.tokenSaved && (
        <Row icon={<CircleAlert size={14} className="warn" />} label={t('gitlab.panel.noToken', { host: lab.host })} action={<GitlabSettingsButton />} />
      )}
      {status.scm?.kind === 'unknown-gitlab' && (
        <Row icon={<GitlabMark className="faint" />} label={t('gitlab.panel.unknownHost', { host: status.scm.host })} action={<GitlabSettingsButton />} />
      )}
      {status.prProblem && (
        <Row
          icon={<CircleAlert size={14} className="warn" />}
          label={
            lab
              ? status.prProblem.kind === 'auth-error'
                ? t('gitlab.panel.authProblem', { host: lab.host })
                : t('gitlab.panel.readProblem', { message: status.prProblem.message.split('\n')[0] })
              : status.prProblem.kind === 'auth-error'
                ? t('gitPanel.prProblem.auth')
                : t('gitPanel.prProblem.read', { message: status.prProblem.message.split('\n')[0] })
          }
        />
      )}
      {status.hasRemote && status.ghAvailable && !status.onBase && <PrWatchToggles workspaceId={workspaceId} gitlab={Boolean(lab)} />}
      {!status.onBase && <BaseWatchToggle workspaceId={workspaceId} />}
      {mr ? (
        <GitlabMergeRequest workspaceId={workspaceId} status={status} mr={mr} refresh={refresh} />
      ) : pr ? (
        <Row
          icon={<GitPullRequest size={14} className={pr.state === 'MERGED' ? 'merged' : 'ok'} />}
          label={
            <>
              <LinkButton onClick={() => void api.openExternal(pr.url)}>
                #{pr.number} {pr.title}
              </LinkButton>
              <span className="faint small"> {pr.isDraft ? t('gitPanel.pr.draft') : t(PR_STATE[pr.state])}</span>
            </>
          }
        />
      ) : (
        status.hasRemote &&
        !status.onBase &&
        (status.aheadBase > 0 || status.uncommitted > 0) && (
          <Row
            icon={<GitPullRequest size={14} className="faint" />}
            label={lab ? t('gitlab.panel.noMr') : t('gitPanel.pr.none')}
            action={go('create-pr', lab ? t('gitlab.panel.createMr') : undefined)}
          />
        )
      )}
      {status.uncommitted > 0 && (
        <Row icon={<CircleAlert size={14} className="warn" />} label={t('gitPanel.uncommitted', { count: status.uncommitted })} action={go('commit-and-push')} />
      )}
      {status.behind > 0 && <Row icon={<ArrowDownToLine size={14} className="warn" />} label={t('gitPanel.behindRemote', { count: status.behind })} action={go('pull')} />}
      {status.ahead > 0 && <Row icon={<ArrowUpFromLine size={14} className="warn" />} label={t('gitPanel.unpushed', { count: status.ahead })} action={go('push')} />}
      {status.behindBase > 0 && !status.onBase && (
        <Row icon={<ArrowDownToLine size={14} className="faint" />} label={t('gitPanel.behindBase', { count: status.behindBase, base: status.baseRef })} action={go('pull')} />
      )}
      {(status.conflicted || pr?.mergeable === 'CONFLICTING') && <Row icon={<CircleX size={14} className="bad" />} label={t('gitPanel.conflicts')} action={go('resolve-conflicts')} />}
      {pr?.isDraft && (
        <Row
          icon={<CircleDashed size={14} className="faint" />}
          label={mr ? t('gitlab.panel.draftRow') : t('gitPanel.pr.isDraft')}
          action={go('ready-for-review', mr ? t('gitlab.panel.markReady') : undefined)}
        />
      )}
      {pr?.reviewDecision === 'CHANGES_REQUESTED' && <Row icon={<CircleX size={14} className="bad" />} label={t('gitPanel.changesRequested')} />}
      {pr?.reviewDecision === 'REVIEW_REQUIRED' && !mr && <Row icon={<CircleDashed size={14} className="warn" />} label={t('gitPanel.waitingForReview')} />}
      {pr && !mr && status.primary.action === 'merge' && <Row icon={<CircleCheck size={14} className="ok" />} label={t('gitPanel.readyToMerge')} action={go('merge')} />}

      {pr && <Reviews key={pr.url} workspaceId={workspaceId} pr={pr} onCount={setOpenThreads} />}

      {mr && (mr.checks.length > 0 || mr.pipeline) && <GitlabPipeline workspaceId={workspaceId} mr={mr} host={lab?.host} refresh={refresh} />}

      {pr && !mr && pr.checks.length > 0 && (
        <div className="checks-group">
          <div className="checks-head">
            <span>{t('gitPanel.checks')}</span>
            <span className="spacer" />
            {failing.length > 0 && (
              <>
                <Button size="sm" icon={<RotateCw size={12} />} onClick={() => void runGitAction(workspaceId, 'rerun-checks', refresh)}>
                  {t('gitPanel.rerunFailed')}
                </Button>
                <Button size="sm" icon={<Wrench size={12} />} onClick={() => void runGitAction(workspaceId, 'fix-errors', refresh)}>
                  {t('gitPanel.action.fixErrors')}
                </Button>
              </>
            )}
          </div>
          <AutoFixStatus workspaceId={workspaceId} />
          {pr.checks.map((check, n) => (
            <Row
              key={`${check.name}-${n}`}
              icon={<CheckIcon state={check.state} />}
              label={check.name}
              action={
                check.url ? (
                  <IconButton label={t('gitPanel.openLogs')} onClick={() => void api.openExternal(check.url!)}>
                    <ExternalLink size={12} />
                  </IconButton>
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      <McpSection workspaceId={workspaceId} />

      {agentComments.length > 0 && (
        <div className="checks-group">
          <div className="checks-head">
            <MessageSquare size={13} /> {t('gitPanel.reviewComments')}
          </div>
          {agentComments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function GitlabSettingsButton() {
  const t = useT()
  return (
    <Button size="sm" onClick={() => openSettingsPage({ section: 'git', scrollTo: 'gitlab-accounts' })}>
      {t('gitlab.panel.openSettings')}
    </Button>
  )
}

/** O2: "Merge request !87", its approvals, and whether GitLab will merge it (with why not). */
function GitlabMergeRequest({ workspaceId, status, mr, refresh }: { workspaceId: string; status: GitStatus; mr: PullRequestInfo; refresh: () => void }) {
  const t = useT()
  const state = mr.isDraft && mr.state === 'OPEN' ? t('gitlab.panel.state.draft') : mr.state === 'MERGED' ? t('gitlab.panel.state.merged') : mr.state === 'CLOSED' ? t('gitlab.panel.state.closed') : t('gitlab.panel.state.open')
  const approvals = mr.approvals
  const blocks = mr.mergeBlocked ?? []
  const open = mr.state === 'OPEN'
  const canMerge = open && status.primary.action === 'merge'
  const reasons = blocks.map((b) => t(`gitlab.panel.block.${b}`)).join(', ')
  return (
    <>
      <Row
        icon={<GitlabMark className={mr.state === 'MERGED' ? 'merged' : ''} />}
        label={
          <>
            <LinkButton onClick={() => void api.openExternal(mr.url)}>
              {t('gitlab.panel.mr', { number: mr.number })} · {mr.title}
            </LinkButton>
            <span className="faint small"> {state}</span>
          </>
        }
      />
      {open && approvals && (approvals.required > 0 || approvals.given > 0) && (
        <Row
          icon={approvals.given >= approvals.required ? <CircleCheck size={14} className="ok" /> : <CircleDashed size={14} className="warn" />}
          label={
            <>
              {t('gitlab.panel.approvals', { given: approvals.given, required: approvals.required })}
              <span className="faint small">
                {' · '}
                {[
                  approvals.by.length ? t('gitlab.panel.approvedBy', { names: approvals.by.join(', ') }) : t('gitlab.panel.noApprovals'),
                  approvals.required > approvals.given ? t('gitlab.panel.moreNeeded', { count: approvals.required - approvals.given }) : ''
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            </>
          }
        />
      )}
      {open && (
        <Row
          icon={canMerge ? <CircleCheck size={14} className="ok" /> : <CircleX size={14} className={blocks.length ? 'bad' : 'faint'} />}
          label={
            canMerge ? (
              t('gitlab.panel.readyToMerge')
            ) : (
              <>
                {t('gitlab.panel.cantMerge')}
                {reasons && <span className="faint small"> · {reasons}</span>}
              </>
            )
          }
        />
      )}
      {open && (
        <div className="gitlab-actions">
          <Button
            size="sm"
            variant={canMerge ? 'primary' : 'default'}
            icon={<GitMerge size={12} />}
            disabled={!canMerge}
            title={canMerge ? undefined : `${t('gitlab.panel.cantMerge')}${reasons ? ` · ${reasons}` : ''}`}
            onClick={() => void runGitAction(workspaceId, 'merge', refresh)}
          >
            {t('gitlab.panel.merge')}
          </Button>
          <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => void api.openExternal(mr.url)}>
            {t('gitlab.panel.openIn')}
          </Button>
        </div>
      )}
    </>
  )
}

/** O2: the head pipeline and its jobs. "Rerun failed jobs" retries the pipeline, which reruns only those. */
function GitlabPipeline({ workspaceId, mr, host, refresh }: { workspaceId: string; mr: PullRequestInfo; host?: string; refresh: () => void }) {
  const t = useT()
  const failing = mr.checks.filter((c) => c.state === 'failure' && c.required !== false)
  const pipeline = mr.pipeline
  return (
    <div className="checks-group">
      <div className="checks-head">
        {pipeline ? (
          <LinkButton disabled={!pipeline.url} onClick={() => pipeline.url && void api.openExternal(pipeline.url)}>
            {t('gitlab.panel.pipeline', { id: pipeline.id, status: pipeline.status })}
          </LinkButton>
        ) : (
          <span>{t('gitlab.panel.jobs')}</span>
        )}
        <span className="spacer" />
        {failing.length > 0 && (
          <>
            <Button size="sm" icon={<RotateCw size={12} />} title={t('gitlab.panel.rerunTitle')} onClick={() => void runGitAction(workspaceId, 'rerun-checks', refresh)}>
              {t('gitlab.panel.rerun')}
            </Button>
            <Button size="sm" icon={<Wrench size={12} />} onClick={() => void runGitAction(workspaceId, 'fix-errors', refresh)}>
              {t('gitlab.panel.fixErrors')}
            </Button>
          </>
        )}
      </div>
      <AutoFixStatus workspaceId={workspaceId} />
      {mr.checks.map((job, n) => (
        <Row
          key={`${job.jobId ?? job.name}-${n}`}
          icon={<CheckIcon state={job.state} />}
          label={
            <span className="checks-job">
              <span className="gitlab-job-stage">{job.stage}</span> {job.name}
              {job.state === 'failure' && job.required === false && <span className="faint small"> · {t('gitlab.panel.allowedToFail')}</span>}
              {job.downstream && <span className="faint small"> · {t('gitlab.panel.downstream', { id: job.downstream.id, status: job.downstream.status ?? '?' })}</span>}
            </span>
          }
          action={
            <>
              {job.trigger && <Tag title={t('gitlab.panel.triggerTitle')}>{t('gitlab.panel.trigger')}</Tag>}
              {job.manual ? <Tag>{t('gitlab.panel.manual')}</Tag> : <span className="gitlab-job-time">{jobDuration(job.duration, t)}</span>}
              {job.url && (
                <IconButton label={t(job.trigger ? 'gitlab.panel.openDownstream' : 'gitlab.panel.openJob')} onClick={() => void api.openExternal(job.url!)}>
                  <ExternalLink size={12} />
                </IconButton>
              )}
            </>
          }
        />
      ))}
      {pipeline?.sha && host && <div className="faint small gitlab-read-with">{t('gitlab.panel.readWith', { sha: pipeline.sha.slice(0, 7), host })}</div>}
    </div>
  )
}

function CommentRow({ comment }: { comment: DiffComment }) {
  const t = useT()
  return (
    <div className="comment-row">
      <div className="comment-meta faint small">
        <span className="mono">
          {comment.file}:{comment.line}
        </span>
        <span>{comment.authorLabel ?? comment.author}</span>
        <span className="spacer" />
        <IconButton label={t('gitPanel.comment.resolve')} onClick={() => void attempt(() => api.updateComment(comment.id, { state: 'resolved' }))}>
          <Check size={12} />
        </IconButton>
        <IconButton label={t('common.delete')} onClick={() => void attempt(() => api.deleteComment(comment.id))}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      <div className="comment-body">{comment.body}</div>
    </div>
  )
}
