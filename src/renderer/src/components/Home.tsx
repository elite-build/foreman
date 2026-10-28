// Home: what needs the user across all repositories (or the one picked in the
// sidebar's rail), what's running, and what was active lately.
import { IntegrationsHome } from './IntegrationsHome'
import { Plus } from 'lucide-react'
import { Fragment, useId, useState } from 'react'
import { api, attempt, markWorkspaceUnread, modKey, openFixCi, openHandOffDialog, openImportDialog, openResolveBase, openNewWorkspace, selectWorkspace, sendUnseenReviews, timeWaited, useStore } from '../store'
import { useClock } from '../clock'
import { BUCKET_LABEL, liveRepo, oldestFirst, triageAll, type Triage } from '../triage'
import type { PlainKey } from '../../../shared/i18n'
import { compareGroups } from '../../../shared/compare'
import { DEFAULT_DONE_DAYS } from '../../../shared/board'
import { matchesView, VIEW_LABEL, viewsOn, type ViewId } from '../../../shared/views'
import { putAway } from '../../../shared/later'
import { laterWhen, saveForLater, takeOutOfLater } from '../later'
import { AddRepoCards } from './AddRepository'
import { GetStarted } from './GetStarted'
import { CompareRow } from './CompareDialogs'
import { ScheduledCard } from './ScheduleDialogs'
import { PendingHandOffs } from './HandOffDialogs'
import { StoppedLine } from './StopSafely'
import { ReconnectedLine } from './KeepRunning'
import { DockerLeftLines } from './ArchiveDialog'
import { finishedWhileClosed } from '../../../shared/agentHost'
import { openTriaged, useTriageInput } from './Sidebar'
import { HomeBoard, HomeLayoutControls, useHomeLayout } from './HomeBoard'
import { useT } from '../i18n'
import { workspaceNarration } from '../agentStatus'
import { useAutoFixText } from './AutoFix'
import { PrGlyphView, RecentCard } from './Attention'
import { CloudGlyph } from './cloud/CloudBits'
import { clockTime } from '../../../shared/usageLimit'
import { AutoReviewRowActions, AutoReviewStaleTag, useAutoReviewRow } from './AutoReview'
import { ActionRow, Button, Callout, LinkButton, Spinner, Tag, type TagTone } from '../ui'

const RECENT_LIMIT = 6
const ALL_CLEAR_MESSAGES: PlainKey[] = [
  'home.empty.quip1',
  'home.empty.quip2',
  'home.empty.quip3',
  'home.empty.quip4',
  'home.empty.quip5',
  'home.empty.quip6',
  'home.empty.quip7',
  'home.empty.quip8',
  'home.empty.quip9',
  'home.empty.quip10',
  'home.empty.quip11',
  'home.empty.quip12',
  'home.empty.quip13',
  'home.empty.quip14',
  'home.empty.quip15'
]

/** "12h ago" → "12h" ("a moment" under a minute), in the UI language. */
function waited(since: string): string {
  return timeWaited(since)
}

function actionLabel(t: Triage, tr: ReturnType<typeof useT>): string {
  if (t.bucket !== 'attention') return tr('common.open')
  if (t.tone === 'amber') return tr('home.action.respond')
  if (t.tone === 'green') return tr('home.action.review')
  return tr('common.open')
}

/** #2 "Worker asks for a review · Open…": the Code review dialog, filled in. Nothing runs until Start. */
function openReviewRequest(t: Triage): void {
  selectWorkspace(t.ws.id)
  if (t.sessionId) openHandOffDialog({ sourceId: t.sessionId, kind: 'review', prefill: t.reportText, reportId: t.reportId })
}

/** A row's pill says its state in shape as well as colour. */
const PILL_TONE: Record<string, TagTone> = { amber: 'warn', red: 'error', green: 'ok', blue: 'info', accent: 'info' }

function HomeRow({ t, repoName }: { t: Triage; repoName?: string }) {
  const tr = useT()
  // #5: the CI-failed reason gains auto-fix's line ("Foreman sent a fix at 14:02 · 1 of 2"), never "fixed".
  const autoFix = useAutoFixText(t.ws)
  // #2: an agent's report reads as its own words ("Tab 2 says it's stuck: …") rather than the sidebar's short detail.
  // #17: an auto review's row is worded here, in the user's language ("3 findings · Opus 5.5, read-only · reviewed a41c9e0 at 14:20").
  const autoReview = useAutoReviewRow(t)
  // #11 (via #3): a tab waiting out its usage limit: "Limit reached", then its chat and "resumes at 14:30".
  const limit = t.limitResume
  const limitChat = useStore((s) => (limit ? s.snapshot!.sessions.find((x) => x.id === limit.sessionId)?.title : undefined))
  const detail = limit ? [limitChat, tr('attention.limit.resumesAtLower', { time: clockTime(Date.parse(limit.resetAt), tr.locale) })].filter(Boolean).join(' · ') : t.detail
  // G3 · O10: a kept turn that finished while Foreman was closed says so on its row, until Home's line is dismissed.
  const closedEnd = useStore((s) => finishedWhileClosed(s.snapshot?.reconnected, s.snapshot!.sessions, t.ws.id))
  const closedNote = closedEnd ? tr('keepRunning.home.rowFinished', { time: clockTime(Date.parse(closedEnd), tr.locale) }) : null
  const sub = autoReview
    ? [autoReview.sub, repoName].filter(Boolean).join(' · ')
    : [t.summary ?? detail, closedNote, t.action?.kind === 'fix-ci' ? autoFix : null, ...(t.facts ?? []), repoName].filter(Boolean).join(' · ')
  const review = t.action?.kind === 'open-review'
  // E4: the narrator's sentence (what is waiting, or how the last turn ended) as the row's description.
  const describedBy = useId()
  const sessions = useStore((s) => s.snapshot!.sessions)
  const approvals = useStore((s) => s.approvals)
  const narration = workspaceNarration(tr, t.ws, sessions, approvals)
  return (
    <ActionRow
      role="listitem"
      divided
      className="home-line"
      onPress={() => openTriaged(t)}
      primaryProps={{ className: 'home-row-flow', 'aria-describedby': narration ? describedBy : undefined }}
      actions={
        <div className="home-row-actions">
          {/* #3: the PR's own glyph, apart from the pill that says what needs you. It is a button of its own, so it sits beside the row's main button. */}
          <PrGlyphView ws={t.ws} number />
          {review && t.reportId && (
            <LinkButton size="sm" onClick={() => void attempt(() => api.closeAgentReport(t.ws.id, t.reportId!, 'dismissed'))}>
              {tr('reports.dismiss')}
            </LinkButton>
          )}
          {t.action && (
            <Button
              size="sm"
              onClick={() => {
                if (t.action?.kind === 'open-review') return openReviewRequest(t)
                selectWorkspace(t.ws.id)
                if (t.action?.kind === 'fix-ci') openFixCi(t.ws.id)
                else if (t.action?.kind === 'resolve-base') openResolveBase(t.ws.id)
                else void sendUnseenReviews(t.ws.id)
              }}
            >
              {t.action.label}
            </Button>
          )}
          {t.tone === 'green' && t.bucket === 'attention' && (
            <LinkButton size="sm" onClick={() => markWorkspaceUnread(t.ws.id, false)}>
              {tr('home.row.markRead')}
            </LinkButton>
          )}
          {autoReview && t.bucket === 'attention' && <AutoReviewRowActions review={autoReview.review} />}
          {/* Back from Later: take it out, or put it away for another day. */}
          {t.laterBack && (
            <>
              <LinkButton size="sm" onClick={() => void takeOutOfLater(t.ws, tr)}>
                {tr('later.dismiss')}
              </LinkButton>
              <Button size="sm" onClick={() => void saveForLater(t.ws, 'tomorrow', tr)}>
                {tr('later.again')}
              </Button>
            </>
          )}
          {!review && (
            <Button size="sm" onClick={() => openTriaged(t)}>
              {actionLabel(t, tr)}
            </Button>
          )}
        </div>
      }
    >
      {narration && (
        <span id={describedBy} hidden>
          {narration}
        </span>
      )}
      <Tag tone={PILL_TONE[t.tone ?? ''] ?? 'neutral'} className="home-pill">
        {t.spinning && <Spinner size={11} />}
        {autoReview?.label ?? (limit ? tr('attention.limit.reached') : (t.label ?? tr('home.row.idle')))}
      </Tag>
      <span className="home-row-main">
        <span className="home-row-title">
          <CloudGlyph ws={t.ws} size={12} />
          <span className="home-row-name">{t.ws.name}</span>
          <span className="home-row-branch">{t.ws.branch}</span>
          {t.says && (
            <Tag tone="outline" className="says" title={tr('reports.saysTitle')}>
              {tr('reports.says')}
            </Tag>
          )}
          {autoReview?.stale && <AutoReviewStaleTag />}
        </span>
        {sub && <span className="home-row-sub">{sub}</span>}
      </span>
      {t.extra ? <span className="home-row-age" title={tr('home.row.moreTitle')}>{tr('home.row.more', { count: t.extra })}</span> : null}
      <span className="home-row-age">{waited(t.since)}</span>
    </ActionRow>
  )
}

function HomeCard({ title, hint, items, repoNames }: { title: string; hint?: string; items: Triage[]; repoNames?: Map<string, string> }) {
  if (!items.length) return null
  return (
    <section className="home-card">
      <header className="home-card-head">
        <span className="home-card-title">{title}</span>
        <span className="home-card-hint">{hint ?? items.length}</span>
      </header>
      <div role="list">
        {items.map((t) => (
          <HomeRow key={t.ws.id} t={t} repoName={repoNames?.get(t.ws.repoId)} />
        ))}
      </div>
    </section>
  )
}

export function Home() {
  const base = useTriageInput()
  const [allClearIndex] = useState(() => Math.floor(Math.random() * ALL_CLEAR_MESSAGES.length))
  // Elapsed times on running rows move with the clock (stopped while the window is minimized or hidden).
  const now = useClock(30_000)
  const input = { ...base, now }
  const { snapshot } = input
  const repoId = useStore((s) => liveRepo(s.snapshot!, s.sidebarView.repo))
  const repo = snapshot.repos.find((r) => r.id === repoId)
  const mod = modKey(snapshot.platform)
  const all = triageAll(input, repoId)
  // Put away for later: out of Home and the board until its day (a Later section can still show them).
  const items = all.filter((x) => !putAway(x, now))
  const attention = oldestFirst(items.filter((t) => t.bucket === 'attention'))
  // A comparison gets one row of its own; a member that needs you still shows under Needs your attention.
  const compares = compareGroups(snapshot.workspaces.filter((w) => !repoId || w.repoId === repoId), snapshot.sessions)
  const compared = new Set(compares.flatMap((g) => g.members.map((m) => m.ws.id)))
  const working = items.filter((t) => t.bucket === 'working' && !compared.has(t.ws.id))
  const recent = items
    .filter((t) => t.bucket === 'idle' && !compared.has(t.ws.id))
    .sort((a, b) => b.since.localeCompare(a.since))
    .slice(0, RECENT_LIMIT)
  // Only worth saying which repo a row belongs to when showing them all.
  const repoNames = repo ? undefined : new Map(snapshot.repos.map((r) => [r.id, r.name]))
  const newRepoId = repoId ?? snapshot.repos[0]?.id
  // #21: the board replaces the list below the header when it's on and picked.
  const t = useT()
  const { enabled: boardEnabled, layout } = useHomeLayout()
  const board = layout === 'board' && snapshot.repos.length > 0
  // The sections Settings → Appearance → Sidebar & Home turns on, in its order.
  const homeViews = viewsOn(snapshot.settings.views, 'home')
  const doneDays = snapshot.settings.homeDoneDays || DEFAULT_DONE_DAYS
  const sectionTitle = (id: ViewId) => (id === 'needs-you' ? t(BUCKET_LABEL.attention) : id === 'working' ? t(BUCKET_LABEL.working) : t(VIEW_LABEL[id]))
  const sectionItems = (id: ViewId): Triage[] =>
    id === 'needs-you'
      ? attention
      : id === 'working'
        ? working
        : id === 'later'
          ? all.filter((x) => matchesView(id, x, { now, doneDays })).map((x) => (putAway(x, now) ? { ...x, label: laterWhen(x.ws, t), tone: undefined } : x))
          : items.filter((x) => matchesView(id, x, { now, doneDays })).sort((a, b) => b.since.localeCompare(a.since))
  const comparesCard = compares.length > 0 && (
    <section className="home-card">
      <header className="home-card-head">
        <span className="home-card-title">{t('home.compare.title')}</span>
        <span className="home-card-hint">{compares.length}</span>
      </header>
      {compares.map((g) => (
        <CompareRow key={g.id} group={g} />
      ))}
    </section>
  )

  return (
    <div className={`home ${board ? 'board-mode' : ''}`}>
      <div className="titlebar drag" />
      <div className="home-scroll">
        <div className="home-inner">
          <header className="home-head">
            <div className="home-head-text">
              <h1>{repo?.name ?? t('home.title')}</h1>
              <div className="faint small home-head-sub">
                {repo ? repo.rootPath : t('home.subtitle', { count: items.length })}
                {board && ` · ${t('home.board.fromFacts')}`}
              </div>
            </div>
            <div className="header-actions">
              {boardEnabled && snapshot.repos.length > 0 && <HomeLayoutControls />}
              {snapshot.repos.length > 0 && (
                <Button onClick={openImportDialog} title={t('sidebar.import.title')}>
                  {t('sidebar.import')}
                </Button>
              )}
              {newRepoId && (
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => openNewWorkspace(newRepoId)}>
                  {t('palette.newWorkspace')}
                </Button>
              )}
            </div>
          </header>

          {/* Get started: things worth trying, until it's done or hidden (⌘K brings it back). */}
          <GetStarted />

          {snapshot.repos.length === 0 ? (
            <div className="home-empty">
              <p className="muted">{t('home.empty.intro')}</p>
              <AddRepoCards />
            </div>
          ) : board ? (
            <>
              <ReconnectedLine />
              <StoppedLine />
              <DockerLeftLines />
              <HomeBoard items={items} repoNames={repoNames} now={now} />
            </>
          ) : (
            <>
              {/* #1: turns a quit or crash stopped, one line until each is retried or dismissed. */}
              <ReconnectedLine />
              <StoppedLine />
              {/* G3 · O18: Docker containers an archive couldn't remove. */}
              <DockerLeftLines />
              <Callout
                tone={attention.length ? 'warn' : working.length ? 'info' : 'neutral'}
                role="status"
                className="home-banner"
                actions={
                  attention.length > 0 ? (
                    <Button onClick={() => openTriaged(attention[0])} title={t('home.banner.nextTitle', { key: `${mod}⌥L` })}>
                      {t('home.banner.next')}
                    </Button>
                  ) : undefined
                }
              >
                {attention.length ? (
                  <>
                    <strong>{t('home.banner.needYou', { count: attention.length })}</strong> · {t('attention.tray.oldest', { age: waited(attention[0].since) })}
                  </>
                ) : (
                  <strong>{t(ALL_CLEAR_MESSAGES[allClearIndex])}</strong>
                )}
                {working.length > 0 && ` · ${t('triage.agentsWorking', { count: working.length })}`}
              </Callout>
              <PendingHandOffs repoId={repoId ?? undefined} />
              {/* Integrations: Slack messages waiting for Send or Skip, connections that need attention. */}
              <IntegrationsHome repoId={repoId ?? undefined} />
              {/* Scheduled runs follow Needs you, and comparisons follow Working, wherever those sections are (or first and last without them). */}
              {!homeViews.includes('needs-you') && <ScheduledCard repoId={repoId ?? undefined} />}
              {homeViews.map((id) => (
                <Fragment key={id}>
                  <HomeCard title={sectionTitle(id)} hint={id === 'needs-you' ? t('home.board.hint.needs-you') : undefined} items={sectionItems(id)} repoNames={repoNames} />
                  {id === 'needs-you' && <ScheduledCard repoId={repoId ?? undefined} />}
                  {id === 'working' && comparesCard}
                </Fragment>
              ))}
              {!homeViews.includes('working') && comparesCard}
              <HomeCard title={t('home.recent.title')} items={recent} repoNames={repoNames} />
              {/* #3: what happened, as history; it never resolves anything above, so it comes last. */}
              <RecentCard repoId={repoId} repoNames={repoNames} />
              {items.length === 0 && <p className="faint home-hint">{t('home.empty.noWorkspaces')}</p>}
              <p className="faint small home-hint">{t('home.shortcuts', { mod })}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
