// Home: the work first. One block of what needs the person (every kind, from the shared needs-you list: workspaces and
// AI employees' questions, held actions and proposals), then what runs and what was active lately, then Get started
// folded to one row. It shows every space unless its Space filter (or the rail) narrows it.
import { IntegrationsHome } from './IntegrationsHome'
import { Plus } from 'lucide-react'
import { Fragment, useId, useState, type ReactNode } from 'react'
import { api, attempt, clientKind, markWorkspaceUnread, modKey, openFixCi, openHandOffDialog, openImportDialog, openResolveBase, openNewWorkspace, selectWorkspace, sendUnseenReviews, setHomeSpace, timeWaited, useStore } from '../store'
import { useClock } from '../clock'
import { BUCKET_LABEL, listsWorkspace, liveRepo, projectWorkspaceIds, triageAll, type Triage } from '../triage'
import { currentSpace, newWorkspaceTarget, snapshotInSpace, spacesOn } from '../../../shared/organizations'
import { itemsInSpace, type NeedsYouItem } from '../../../shared/needsYou'
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
import { openTriaged } from './Sidebar'
import { needsYouOf, useTriageInput } from '../needsYou'
import { employeeOf, isEmployeeItem, itemSub, itemTitle, kindTag, openEmployeeItem, spaceLabel } from './needsYouWords'
import { HomeBoard, HomeLayoutControls, useHomeLayout } from './HomeBoard'
import { useT, type RendererT } from '../i18n'
import { shortcutHint } from '../shortcuts'
import { workspaceNarration } from '../agentStatus'
import { useAutoFixText } from './AutoFix'
import { PrGlyphView, RecentCard } from './Attention'
import { CloudGlyph } from './cloud/CloudBits'
import { clockTime } from '../../../shared/usageLimit'
import { AutoReviewRowActions, AutoReviewStaleTag, useAutoReviewRow } from './AutoReview'
import { ActionRow, Button, Callout, Card, Glyph, HardHat, Kbd, LinkButton, Segmented, Spinner, Tag, type HardHatColour, type TagTone } from '../ui'

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
  return since ? timeWaited(since) : ''
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

/** The space a row belongs to, as a tag, while Home shows every space. */
function SpaceTag({ name }: { name?: string }) {
  return name ? (
    <Tag tone="outline" className="home-row-space">
      {name}
    </Tag>
  ) : null
}

/** An employee's hat before a title or a line: identity only (the row's tag says the state). */
function Hat({ colour }: { colour: string }) {
  return (
    <span className="home-row-hat">
      <HardHat colour={colour as HardHatColour} size={16} />
    </span>
  )
}

function HomeRow({ t, repoName, space }: { t: Triage; repoName?: string; space?: string }) {
  const tr = useT()
  // #5: the CI-failed reason gains auto-fix's line ("Foreman sent a fix at 14:02 · 1 of 2"), never "fixed".
  const autoFix = useAutoFixText(t.ws)
  // #2: an agent's report reads as its own words ("Tab 2 says it's stuck: …") rather than the sidebar's short detail.
  // #17: an auto review's row is worded here, in the user's language ("3 findings · Opus 5.5, read-only · reviewed a41c9e0 at 14:20").
  const autoReview = useAutoReviewRow(t)
  // #11 (via #3): a tab waiting out its usage limit: "Limit reached", then its chat and "resumes at 14:30".
  const limit = t.limitResume
  const limitChat = useStore((s) => (limit ? s.snapshot!.sessions.find((x) => x.id === limit.sessionId)?.title : undefined))
  // The row's label already says "Waiting · resumes at 14:20" (triage); the line under it names the chat and why.
  const detail = limit ? [limitChat, tr('attention.limit.usageLimit')].filter(Boolean).join(' · ') : t.detail
  // G3 · O10: a kept turn that finished while Foreman was closed says so on its row, until Home's line is dismissed.
  const closedEnd = useStore((s) => finishedWhileClosed(s.snapshot?.reconnected, s.snapshot!.sessions, t.ws.id))
  const closedNote = closedEnd ? tr('keepRunning.home.rowFinished', { time: clockTime(Date.parse(closedEnd), tr.locale) }) : null
  // docs/ai-employees.md §10: an employee's run says whose it is.
  const snapshot = useStore((s) => s.snapshot!)
  const by = t.ws.startedBy?.via === 'employee' ? t.ws.startedBy : undefined
  const employee = by ? employeeOf(snapshot, by) : undefined
  const runOf = employee && by && t.bucket !== 'attention' ? tr('sidebar.row.employeeRun', { name: employee.name, title: by.title }) : null
  const sub = autoReview
    ? [autoReview.sub, repoName].filter(Boolean).join(' · ')
    : [runOf, t.summary ?? detail, closedNote, t.action?.kind === 'fix-ci' ? autoFix : null, ...(t.facts ?? []), repoName].filter(Boolean).join(' · ')
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
                if (t.action?.kind === 'resolve-archive') return openTriaged(t)
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
          {/* A stopped archive's one way forward is its dialog, which Resolve… opens; Open would only repeat it. */}
          {!review && t.action?.kind !== 'resolve-archive' && (
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
        {autoReview?.label ?? t.label ?? tr('home.row.idle')}
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
        {sub && (
          <span className="home-row-sub">
            {employee && runOf && <Hat colour={employee.colour} />}
            {sub}
          </span>
        )}
      </span>
      <span className="home-row-meta">
        {t.extra ? (
          <span className="home-row-age" title={tr('home.row.moreTitle')}>
            {tr('home.row.more', { count: t.extra })}
          </span>
        ) : null}
        <SpaceTag name={space} />
        <span className="home-row-age">{waited(t.since)}</span>
      </span>
    </ActionRow>
  )
}

/** The button an employee's item offers: Answer a question, Review an action or a proposal, else Open. */
function employeeAction(item: NeedsYouItem, t: RendererT): string {
  if (item.task?.question) return t('needsYou.answer')
  if (item.kind === 'action' || item.kind === 'proposal' || item.kind === 'project') return t('home.action.review')
  return t('common.open')
}

/**
 * An employee's item in Home's block (docs/ai-employees.md §10): its kind as a tag, the employee's hat with what it asks
 * or wants ("Max wants to push max/launch-2.4"), how to answer or that it leaves this computer, its space and how long it
 * has waited. It opens the Team page, where it is decided (a pause, the employee's page).
 */
function EmployeeHomeRow({ item, repoName, space }: { item: NeedsYouItem; repoName?: string; space?: string }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const tag = kindTag(item, t)
  const employee = employeeOf(snapshot, item)
  const sub = [...itemSub(item, t), repoName].filter(Boolean).join(' · ')
  const open = () => openEmployeeItem(item)
  return (
    <ActionRow
      role="listitem"
      divided
      className="home-line"
      onPress={open}
      primaryProps={{ className: 'home-row-flow' }}
      actions={
        <div className="home-row-actions">
          <Button size="sm" onClick={open}>
            {employeeAction(item, t)}
          </Button>
        </div>
      }
    >
      <Tag tone={tag?.tone ?? 'warn'} className="home-pill">
        {tag?.label}
      </Tag>
      <span className="home-row-main">
        <span className="home-row-title">
          {employee && <Hat colour={employee.colour} />}
          <span className="home-row-name">{itemTitle(item, snapshot, t)}</span>
        </span>
        {sub && <span className="home-row-sub">{sub}</span>}
      </span>
      <span className="home-row-meta">
        <SpaceTag name={space} />
        <span className="home-row-age">{waited(item.since)}</span>
      </span>
    </ActionRow>
  )
}

function HomeCard({ title, hint, items, repoNames, spaceOf }: { title: string; hint?: string; items: Triage[]; repoNames?: Map<string, string>; spaceOf?: (repoId: string) => string | undefined }) {
  if (!items.length) return null
  return (
    <section className="home-card">
      <header className="home-card-head">
        <span className="home-card-title">{title}</span>
        <span className="home-card-hint">{hint ?? items.length}</span>
      </header>
      <div role="list">
        {items.map((t) => (
          <HomeRow key={t.ws.id} t={t} repoName={repoNames?.get(t.ws.repoId)} space={spaceOf?.(t.ws.repoId)} />
        ))}
      </div>
    </section>
  )
}

/**
 * Home's one needs-you block: how many need you (in which spaces, while showing all of them) and how long the oldest
 * has waited, with Next; then every item, oldest first, each tagged with its kind (and its space). With nothing
 * waiting, it is the all-clear line.
 */
function NeedsYouBlock({ items, working, repoNames, spaceOf, spaceName, bySpace, quip }: { items: NeedsYouItem[]; working: number; repoNames?: Map<string, string>; spaceOf?: (repoId: string) => string | undefined; spaceName?: (space: string | null) => string | undefined; bySpace?: [string, number][]; quip: PlainKey }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const titleId = useId()
  const key = shortcutHint('workspace.nextAttention', platform)
  const busy = working > 0 ? ` · ${t('triage.agentsWorking', { count: working })}` : ''
  if (!items.length) {
    return (
      <Callout tone={working ? 'info' : 'neutral'} role="status" className="home-banner">
        <strong>{t(quip)}</strong>
        {busy}
      </Callout>
    )
  }
  const open = (item: NeedsYouItem) => (item.triage && !isEmployeeItem(item) ? openTriaged(item.triage) : openEmployeeItem(item))
  const where = bySpace && bySpace.length ? ` · ${bySpace.map(([space, n]) => t('needsYou.inSpace', { count: n, space })).join(t('needsYou.separator'))}` : ''
  return (
    <Callout
      tone="warn"
      role="status"
      className="home-banner home-needs"
      aria-labelledby={titleId}
      title={
        <span id={titleId}>
          <strong>{t('home.banner.needYou', { count: items.length })}</strong>
          {where} · {t('attention.tray.oldest', { age: waited(items[0].since) })}
          {busy}
        </span>
      }
      actions={
        <Button onClick={() => open(items[0])} title={key ? t('home.banner.nextTitle', { key }) : undefined} aria-keyshortcuts={platform === 'darwin' ? 'Meta+Alt+L' : 'Control+Alt+L'}>
          {t('home.banner.next')}
          {key && <Kbd aria-hidden>{key}</Kbd>}
        </Button>
      }
    >
      <Card className="home-needs-list">
        <div role="list" aria-labelledby={titleId}>
          {items.map((item) => {
            const space = spaceName?.(item.space)
            const repoName = item.repoId ? repoNames?.get(item.repoId) : undefined
            return item.triage && !isEmployeeItem(item) ? (
              <HomeRow key={item.id} t={item.triage} repoName={repoName} space={item.repoId ? spaceOf?.(item.repoId) : space} />
            ) : (
              <EmployeeHomeRow key={item.id} item={item} repoName={repoName} space={space} />
            )
          })}
        </div>
      </Card>
    </Callout>
  )
}

/** "Personal ▲1": a space in the filter, with how much waits in it in shape and number, and in words for a screen reader. */
function SpaceOption({ name, count }: { name: string; count: number }): ReactNode {
  const t = useT()
  if (!count) return name
  return (
    <>
      <span aria-hidden>
        {name}
        <span className="home-space-count">
          <Glyph name="warn" />
          {count}
        </span>
      </span>
      <span className="sr-only">{t('home.space.option', { space: name, count })}</span>
    </>
  )
}

export function Home() {
  const base = useTriageInput()
  const [allClearIndex] = useState(() => Math.floor(Math.random() * ALL_CLEAR_MESSAGES.length))
  // Elapsed times on running rows move with the clock (stopped while the window is minimized or hidden).
  const now = useClock(30_000)
  const input = { ...base, now }
  const { snapshot } = input
  const organizations = snapshot.organizations ?? []
  const spaces = spacesOn(organizations)
  // Every space by default; the Space filter (or the sidebar, while it narrows Home) shows one.
  const scope = useStore((s) => s.homeScope)
  const wanted = useStore((s) => s.space)
  const space = currentSpace(organizations, wanted)
  const allSpaces = !spaces || scope !== 'space'
  const shown = allSpaces ? snapshot : snapshotInSpace(snapshot, space)
  const repoId = useStore((s) => liveRepo(s.snapshot!, s.sidebarView.repo))
  const repo = snapshot.repos.find((r) => r.id === repoId)
  const mod = modKey(snapshot.platform)
  const scoped = { ...input, snapshot: shown }
  const all = triageAll(scoped, repoId)
  // Put away for later: out of Home and the board until its day (a Later section can still show them). A project's
  // workspace is its channel's: only listed while it waits on an approval.
  const projectIds = projectWorkspaceIds(snapshot)
  const items = all.filter((x) => !putAway(x, now) && listsWorkspace(x, projectIds, input.approvals))
  // What needs you: the shared list over every space, narrowed like the rest of Home.
  const need = needsYouOf(input)
  const needs = itemsInSpace(need.items, allSpaces ? undefined : space).filter((i) => !repoId || i.repoId === repoId)
  const attention = needs.flatMap((i) => (i.triage ? [i.triage] : []))
  // A comparison gets one row of its own; a member that needs you still shows in the needs-you block.
  const compares = compareGroups(shown.workspaces.filter((w) => !repoId || w.repoId === repoId), snapshot.sessions)
  const compared = new Set(compares.flatMap((g) => g.members.map((m) => m.ws.id)))
  const working = items.filter((t) => t.bucket === 'working' && !compared.has(t.ws.id))
  const recent = items
    .filter((t) => t.bucket === 'idle' && !compared.has(t.ws.id))
    .sort((a, b) => b.since.localeCompare(a.since))
    .slice(0, RECENT_LIMIT)
  // Only worth saying which repo a row belongs to when showing them all, and which space when showing every space.
  const repoNames = repo ? undefined : new Map(snapshot.repos.map((r) => [r.id, r.name]))
  const t = useT()
  const tagSpaces = spaces && allSpaces && !repo
  const spaceName = tagSpaces ? (id: string | null) => spaceLabel(snapshot, id, t) : undefined
  const repoSpace = new Map(snapshot.repos.map((r) => [r.id, r.spaceId && organizations.some((o) => o.id === r.spaceId) ? r.spaceId : null]))
  const spaceOf = spaceName ? (id: string) => spaceName(repoSpace.get(id) ?? null) : undefined
  // "1 in Personal, 3 in Acme": only while showing every space and more than one has something.
  const bySpace = tagSpaces ? [null, ...organizations.map((o) => o.id)].flatMap((id) => (need.counts.bySpace.get(id) ? [[spaceLabel(snapshot, id, t), need.counts.bySpace.get(id)!] as [string, number]] : [])) : undefined
  // The repository the sidebar's New workspace opens on: in the space shown, never an organization's memory repository.
  const newRepoId = useStore((s) => newWorkspaceTarget(s.snapshot!, { space: s.space, picked: s.sidebarView.repo, selectedWorkspaceId: null }))
  // #21: the board replaces the list below the header when it's on and picked.
  const { enabled: boardEnabled, layout } = useHomeLayout()
  const board = layout === 'board' && snapshot.repos.length > 0
  // The sections Settings → Appearance → Sidebar & Home turns on, in its order. Needs you is the block at the top.
  const homeViews = viewsOn(snapshot.settings.views, 'home')
  const doneDays = snapshot.settings.homeDoneDays || DEFAULT_DONE_DAYS
  const sectionTitle = (id: ViewId) => (id === 'working' ? t(BUCKET_LABEL.working) : t(VIEW_LABEL[id]))
  const sectionItems = (id: ViewId): Triage[] =>
    id === 'working'
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
  const subtitle = repo ? repo.rootPath : !spaces ? t('home.subtitle', { count: items.length }) : allSpaces ? t('home.subtitle.allSpaces', { count: items.length }) : t('home.subtitle.space', { space: spaceLabel(snapshot, space, t), count: items.length })
  // The Space filter: All spaces, Personal and each organization, each with how much waits in it.
  const spaceFilter = spaces && snapshot.repos.length > 0 && (
    <div className="home-space">
      <span className="home-space-label" aria-hidden>
        {t('home.space.label')}
      </span>
      <Segmented<string>
        small
        label={t('home.space.label')}
        value={allSpaces ? 'all' : (space ?? 'personal')}
        options={[
          { value: 'all', label: <SpaceOption name={t('home.space.all')} count={need.counts.total} /> },
          { value: 'personal', label: <SpaceOption name={t('spaces.personal')} count={need.counts.bySpace.get(null) ?? 0} /> },
          ...organizations.map((o) => ({ value: o.id, label: <SpaceOption name={o.name} count={need.counts.bySpace.get(o.id) ?? 0} /> }))
        ]}
        onChange={(value) => setHomeSpace(value === 'all' ? 'all' : value === 'personal' ? null : value)}
      />
    </div>
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
                {subtitle}
                {board && ` · ${t('home.board.fromFacts')}`}
              </div>
            </div>
            <div className="header-actions">
              {boardEnabled && snapshot.repos.length > 0 && <HomeLayoutControls />}
              {snapshot.repos.length > 0 && clientKind === 'window' && (
                <Button onClick={openImportDialog} title={t('sidebar.import.title')}>
                  {t('sidebar.import')}
                </Button>
              )}
              {/* The sidebar's New workspace is the one primary; this is a plain button. */}
              {newRepoId && (
                <Button icon={<Plus size={14} />} onClick={() => openNewWorkspace(newRepoId)}>
                  {t('palette.newWorkspace')}
                </Button>
              )}
            </div>
          </header>
          {spaceFilter}

          {snapshot.repos.length === 0 ? (
            <>
              {/* Nothing to work on yet: Get started is the first thing, open. */}
              <GetStarted expanded />
              <div className="home-empty">
                <p className="muted">{t('home.empty.intro')}</p>
                <AddRepoCards />
              </div>
            </>
          ) : board ? (
            <>
              <ReconnectedLine />
              <StoppedLine repoId={repoId} />
              <DockerLeftLines />
              <HomeBoard items={items} needs={needs.filter((i) => i.kind !== 'workspace')} repoNames={repoNames} spaceOf={spaceOf} spaceName={spaceName} now={now} />
              {/* Get started under the lanes, one row, so the lanes keep the height. */}
              <GetStarted />
            </>
          ) : (
            <>
              {/* #1: turns a quit or crash stopped, one line until each is retried or dismissed. */}
              <ReconnectedLine />
              <StoppedLine repoId={repoId} />
              {/* G3 · O18: Docker containers an archive couldn't remove. */}
              <DockerLeftLines />
              {/* What needs you, first: one block, every kind. */}
              <NeedsYouBlock items={needs} working={working.length} repoNames={repoNames} spaceOf={spaceOf} spaceName={spaceName} bySpace={bySpace && bySpace.length > 1 ? bySpace : undefined} quip={ALL_CLEAR_MESSAGES[allClearIndex]} />
              <PendingHandOffs repoId={repoId ?? undefined} />
              {/* Integrations: Slack messages waiting for Send or Skip, connections that need attention. */}
              <IntegrationsHome repoId={repoId ?? undefined} />
              {/* Scheduled runs follow what needs you; comparisons follow Working, wherever it is (or last without it). */}
              <ScheduledCard repoId={repoId ?? undefined} />
              {homeViews
                .filter((id) => id !== 'needs-you')
                .map((id) => (
                  <Fragment key={id}>
                    <HomeCard title={sectionTitle(id)} items={sectionItems(id)} repoNames={repoNames} spaceOf={spaceOf} />
                    {id === 'working' && comparesCard}
                  </Fragment>
                ))}
              {!homeViews.includes('working') && comparesCard}
              <HomeCard title={t('home.recent.title')} items={recent} repoNames={repoNames} spaceOf={spaceOf} />
              {/* #3: what happened, as history; it never resolves anything above, so it comes after the work. */}
              <RecentCard repoId={repoId} repoNames={repoNames} />
              {items.length === 0 && attention.length === 0 && <p className="faint home-hint">{t('home.empty.noWorkspaces')}</p>}
              {/* Get started, folded to one row under the work (⌘K brings it back once hidden). */}
              <GetStarted />
              <p className="faint small home-hint">{t('home.shortcuts', { mod, nextKey: shortcutHint('workspace.nextAttention', snapshot.platform) ?? '' })}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
