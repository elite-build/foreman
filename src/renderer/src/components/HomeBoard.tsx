// #21 Board view on Home: an optional Kanban layout, off by default (Settings →
// Appearance → Home). Lanes come from src/shared/board.ts on every render and are
// never stored; dragging a card only sets the manual status, as the sidebar's
// right-click Status menu does, and lanes worked out from live facts refuse drops.
import { Ban, Check, CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Info, Kanban, List, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { modelInfo } from '../../../shared/agents'
import { boardLanes, canDrop, DEFAULT_DONE_DAYS, dropStatus, keyboardLane, laneAfterDrop, LANES, moveChanges, prUnknown, type BoardOptions, type Lane, type Placement } from '../../../shared/board'
import { prGlyph } from '../../../shared/attention'
import { isGitlabWorkspace } from '../../../shared/scm'
import type { HomeLayout, Session, WorkspaceStatus } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import type { Locale } from '../../../shared/i18n'
import { timeWaited } from '../../../shared/i18n/time'
import { api, attempt, showRepoHome, showToast, useStore } from '../store'
import { liveRepo, type Triage } from '../triage'
import { AgentIcon } from './composer/AgentPicker'
import { ActionRow, Card, HoverCard, LinkButton, Segmented, Select, Spinner, Status, type StatusTone } from '../ui'
import { openTriaged } from './Sidebar'
import { PrGlyphView } from './Attention'
import { CloudGlyph } from './cloud/CloudBits'
import './homeBoard.css'

// ---- which layout Home shows ----

// The switch on Home holds until quit; Settings' "Default Home layout" is what it opens in.
let chosen: HomeLayout | null = null
const listeners = new Set<() => void>()

/** Pick Home's layout for this run (null: back to the default from Settings). */
export function chooseHomeLayout(layout: HomeLayout | null): void {
  chosen = layout
  for (const listener of listeners) listener()
}

/** Whether the board is turned on, and the layout Home shows now (always List while it's off). */
export function useHomeLayout(): { enabled: boolean; layout: HomeLayout } {
  const enabled = useStore((s) => Boolean(s.snapshot?.settings.homeBoard))
  const fallback = useStore((s) => s.snapshot?.settings.homeLayout ?? 'list')
  const picked = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => chosen
  )
  return { enabled, layout: enabled ? (picked ?? fallback) : 'list' }
}

/** Home's header controls while the board is on: the repo filter (the rail's choice) and List | Board. */
export function HomeLayoutControls() {
  const t = useT()
  const { layout } = useHomeLayout()
  const repos = useStore((s) => s.snapshot!.repos)
  const repoId = useStore((s) => liveRepo(s.snapshot!, s.sidebarView.repo))
  return (
    <>
      {repos.length > 1 && (
        <Select
          label={t('home.board.repoFilter')}
          width={170}
          value={repoId ?? ''}
          options={[{ value: '', label: t('home.board.allRepos') }, ...repos.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={(id) => showRepoHome(id || null)}
        />
      )}
      <Segmented<HomeLayout>
        plain
        className="board-switch"
        label={t('home.board.layout')}
        value={layout}
        options={[
          { value: 'list', label: <><List size={13} aria-hidden /> {t('home.board.list')}</> },
          { value: 'board', label: <><Kanban size={13} aria-hidden /> {t('home.board.board')}</> }
        ]}
        onChange={chooseHomeLayout}
      />
    </>
  )
}

// ---- small helpers ----

/** "6m", "2h", "3d" in the UI language; null under a minute. */
function shortAge(iso: string | undefined, now: number, locale: Locale): string | null {
  if (!iso) return null
  if (Math.floor((now - Date.parse(iso)) / 60_000) < 1) return null
  return timeWaited(iso, locale, now)
}

const LANE_DOT: Record<Lane, string> = { 'needs-you': 'amber', working: 'blue', 'in-review': '', ready: 'green', done: 'merged' }
// A lane's mark says what it is in shape as well as colour; the lane's title beside it says it in words.
const LANE_TONE: Record<string, StatusTone> = { amber: 'warn', blue: 'info', '': 'off', green: 'ok', merged: 'ok' }
const TONE: Record<string, StatusTone> = { amber: 'warn', red: 'error', green: 'ok', blue: 'info', accent: 'info' }

function statusName(t: RendererT, status: WorkspaceStatus): string {
  return t(`home.board.status.${status}`)
}

// ---- cards ----

/** G2: whether a card's workspace is on GitLab (its MR, its last read, or its repo's remote), for "MR !N". */
function useGitlab(ws: Placement['t']['ws']): boolean {
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === ws.repoId))
  const hosts = useStore((s) => s.snapshot!.settings.gitlabHosts)
  return isGitlabWorkspace(ws, repo, hosts ?? [])
}

/** G2: "PR #42 open" or, on GitLab, "MR !42 open". */
function prTitle(t: RendererT, gitlab: boolean, state: 'open' | 'merged' | 'closed' | 'draft', number: number): string {
  if (!gitlab) return t(state === 'open' ? 'home.board.prOpen' : state === 'merged' ? 'home.board.prMerged' : state === 'closed' ? 'home.board.prClosed' : 'home.board.prDraft', { number })
  return t(state === 'open' ? 'home.board.mrOpen' : state === 'merged' ? 'home.board.mrMerged' : state === 'closed' ? 'home.board.mrClosed' : 'home.board.mrDraft', { number })
}

/** The card's PR facts that aren't a control: "no PR", or the PR and CI marks when there's no glyph with a hover card. */
function PrFacts({ p, now }: { p: Placement; now: number }) {
  const t = useT()
  const { ws } = p.t
  const gitlab = useGitlab(ws)
  const pr = ws.prInfo
  const number = pr?.number ?? ws.pullRequest?.number
  if (number === undefined) return <span className="bcard-nopr">{t('home.board.noPr')}</span>
  const facts = pr?.facts
  const state = pr?.state
  const draft = state === 'OPEN' && facts?.draft
  const [Icon, tone, title] =
    state === 'MERGED'
      ? [GitMerge, 'merged', prTitle(t, gitlab, 'merged', number)]
      : state === 'CLOSED'
        ? [GitPullRequestClosed, 'bad', prTitle(t, gitlab, 'closed', number)]
        : draft
          ? [GitPullRequestDraft, 'faint', prTitle(t, gitlab, 'draft', number)]
          : state === 'OPEN'
            ? [GitPullRequest, 'ok', prTitle(t, gitlab, 'open', number)]
            : [GitPullRequest, 'faint', t('home.board.prUnknown')]
  // CI only from a recent, successful read of an open PR.
  const ci = state === 'OPEN' && facts && !prUnknown(facts, now) && facts.checks !== 'none' ? facts.checks : null
  return (
    <>
      {!prGlyph(ws) && (
        <span className={`bcard-pr ${tone}`} title={title}>
          <Icon size={11} aria-hidden />
          {gitlab ? '!' : '#'}
          {number}
        </span>
      )}
      {ci && (
        <span className={`bcard-ci ${ci === 'passed' ? 'ok' : ci === 'failing' ? 'bad' : 'warn'}`} title={t(`home.board.ci.${ci}`)}>
          {ci === 'passed' ? <Check size={10} aria-hidden /> : ci === 'failing' ? <X size={10} aria-hidden /> : <Status compact aria-hidden tone="warn" label={t(`home.board.ci.${ci}`)} />}
          CI
        </span>
      )}
    </>
  )
}

/** The card's one line: why it needs you or what runs, the status you set, the merge, or the latest turn. */
function Reason({ p, sessions }: { p: Placement; sessions: Session[] }) {
  const t = useT()
  const { t: tri } = p
  const gitlab = useGitlab(tri.ws)
  if (tri.label && (p.lane === 'needs-you' || p.lane === 'working')) {
    return (
      <span className={`bcard-reason ${tri.tone ?? ''}`}>
        {tri.spinning ? <Spinner size={11} /> : <Status compact aria-hidden tone={TONE[tri.tone ?? ''] ?? 'off'} label={tri.label} />}
        <span className="bcard-reason-text">
          {tri.label}
          {(tri.detail || tri.facts?.length) && <span className="bcard-detail"> · {[tri.detail, ...(tri.facts ?? [])].filter(Boolean).join(' · ')}</span>}
        </span>
        {tri.extra ? <span className="bcard-more">+{tri.extra}</span> : null}
      </span>
    )
  }
  if (p.why.includes('status-done') || p.why.includes('status-in-review')) {
    return <span className="bcard-reason"><span className="bcard-reason-text">{t('home.board.statusByYou', { status: statusName(t, tri.ws.status!) })}</span></span>
  }
  if (p.why.includes('pr-merged')) {
    return (
      <span className="bcard-reason">
        <span className="bcard-reason-text">
          {t('home.board.merged')}
          <span className="bcard-detail"> · {gitlab ? `MR !${tri.ws.prInfo!.number}` : `PR #${tri.ws.prInfo!.number}`}</span>
        </span>
      </span>
    )
  }
  const latest = sessions.filter((s) => s.workspaceId === tri.ws.id && s.lastTurn && !s.closedAt).sort((a, b) => b.lastTurn!.endedAt.localeCompare(a.lastTurn!.endedAt))[0]
  const line = tri.label ?? latest?.title
  if (!line) return null
  return <span className="bcard-reason"><span className="bcard-reason-text">{line}</span></span>
}

function BoardCard({
  p,
  repoName,
  sessions,
  now,
  dragging,
  onDragStart,
  onDragEnd,
  onMove
}: {
  p: Placement
  repoName?: string
  sessions: Session[]
  now: number
  // Some card is being dragged: the "why" card stays closed.
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  // G2: Alt+← / Alt+→ on a focused card.
  onMove: (dir: -1 | 1) => void
}) {
  const t = useT()
  const { ws } = p.t
  const [why, setWhy] = useState(false)
  const running = sessions.filter((s) => s.workspaceId === ws.id && s.status === 'running' && !s.closedAt)
  const facts = ws.prInfo?.facts
  const ready = p.lane === 'ready' && facts
  const readAge = ready ? shortAge(facts.readAt, now, t.locale) : null
  const age = shortAge(p.t.since, now, t.locale)
  const glyph = prGlyph(ws)
  const lane = p.lane as Lane
  return (
    <HoverCard
      label={t('home.board.why', { name: ws.name, lane: t(`home.board.lane.${lane}`) })}
      side="right"
      width={318}
      openDelay={350}
      open={why && !dragging}
      onOpenChange={setWhy}
      trigger={(h) => (
        <ActionRow
          card
          className={`bcard ${glyph ? 'has-pr' : ''}`}
          draggable
          onDragStart={(e: DragEvent) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', ws.name)
            setWhy(false)
            onDragStart()
          }}
          onDragEnd={onDragEnd}
          onPress={() => openTriaged(p.t)}
          primaryProps={{
            ...h,
            ...({ 'data-board-card': ws.id } as object),
            className: 'bcard-flow',
            'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
              h.onKeyDown(e)
              if (e.defaultPrevented) return
              if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault()
                onMove(e.key === 'ArrowLeft' ? -1 : 1)
              }
            }
          }}
          // The PR glyph is a button of its own (it opens the same PR card as on the other rows), so it sits beside the card's main button.
          actions={glyph ? <PrGlyphView ws={ws} number /> : undefined}
        >
          <span className="bcard-top">
            <CloudGlyph ws={ws} size={12} />
            <span className="bcard-name">{ws.name}</span>
            {ws.diffStat && (ws.diffStat.additions > 0 || ws.diffStat.deletions > 0) && (
              <span className="diff-badge">
                <span className="ok">+{ws.diffStat.additions}</span>
                <span className="bad">−{ws.diffStat.deletions}</span>
              </span>
            )}
          </span>
          <span className="bcard-meta">
            {repoName && <>{repoName} · </>}
            <span className="bcard-branch">{ws.branch}</span>
          </span>
          <Reason p={p} sessions={sessions} />
          {ready && (
            <span className="bcard-basis">
              <Check size={11} className="ok" aria-hidden />
              <span>
                {t('home.board.basis.checks')} · {t('home.board.basis.approved')} · {t('home.board.basis.conflicts')}
              </span>
            </span>
          )}
          <span className="bcard-foot">
            <PrFacts p={p} now={now} />
            {running.map((s) => (
              <span key={s.id} className="bcard-model" title={s.title}>
                <AgentIcon agent={s.agent} size={11} />
                {modelInfo(s.agent, s.model).label}
              </span>
            ))}
            <span className="bcard-age">{ready ? (readAge ? t('home.board.readAgo', { age: readAge }) : t('home.board.readJustNow')) : age}</span>
          </span>
        </ActionRow>
      )}
    >
      <WhyBody p={p} lane={lane} sessions={sessions} now={now} />
    </HoverCard>
  )
}

// ---- why a card is in its lane ----

interface WhyLine {
  // true: holds, false: doesn't, null: just a fact.
  ok: boolean | null
  text: string
  source: string
  age?: string | null
}

function whyLines(p: Placement, sessions: Session[], t: RendererT, now: number, gitlab = false): WhyLine[] {
  const { ws } = p.t
  const pr = ws.prInfo
  const facts = pr?.facts
  const host = t(facts?.provider === 'gitlab' ? 'home.board.source.gitlab' : 'home.board.source.github')
  const foreman = t('home.board.source.foreman')
  const lines: WhyLine[] = []
  for (const fact of p.why) {
    if (fact === 'attention' && p.t.label) lines.push({ ok: false, text: [p.t.label, p.t.detail].filter(Boolean).join(' · '), source: foreman })
    if (fact === 'setup') lines.push({ ok: null, text: t('home.board.fact.setup'), source: foreman })
    if (fact === 'running') {
      const count = sessions.filter((s) => s.workspaceId === ws.id && s.status === 'running').length
      lines.push({ ok: null, text: t('home.board.fact.running', { count: Math.max(1, count) }), source: foreman })
    }
    if (fact === 'status-done') lines.push({ ok: null, text: t('home.board.fact.statusDone'), source: t('home.board.source.you'), age: shortAge(ws.statusAt, now, t.locale) })
    if (fact === 'status-in-review') lines.push({ ok: null, text: t('home.board.fact.statusInReview'), source: t('home.board.source.you'), age: shortAge(ws.statusAt, now, t.locale) })
    if (fact === 'pr-merged') lines.push({ ok: null, text: prTitle(t, gitlab, 'merged', pr!.number), source: host, age: shortAge(facts?.stateSince, now, t.locale) })
    if (fact === 'pr-open') {
      const number = pr?.number ?? ws.pullRequest?.number ?? 0
      if (!facts || prUnknown(facts, now)) {
        lines.push({ ok: null, text: prTitle(t, gitlab, 'open', number), source: host })
        continue
      }
      const checks =
        facts.checks === 'passed'
          ? t(facts.requiredOnly ? 'home.board.fact.checksRequired' : 'home.board.fact.checksAll', { passed: facts.checksPassed, total: facts.checksTotal })
          : facts.checks === 'pending'
            ? t('home.board.fact.checksPending', { passed: facts.checksPassed, total: facts.checksTotal })
            : facts.checks === 'failing'
              ? t('home.board.fact.checksFailing')
              : t('home.board.fact.checksNone')
      lines.push({ ok: facts.checks === 'passed' ? true : facts.checks === 'failing' ? false : null, text: checks, source: host })
      const review =
        facts.review === 'approved'
          ? facts.approvedBy?.length
            ? t('home.board.fact.approvedBy', { number, names: facts.approvedBy.join(', ') })
            : t('home.board.fact.approved', { number })
          : facts.review === 'changes-requested'
            ? t('home.board.fact.changesRequested')
            : facts.review === 'required'
              ? t('home.board.fact.reviewRequired')
              : t('home.board.fact.reviewUnknown')
      lines.push({ ok: facts.review === 'approved' ? true : facts.review === 'changes-requested' ? false : null, text: review, source: host })
      const merge =
        facts.mergeable === 'yes'
          ? t('home.board.fact.noConflicts', { base: ws.baseBranch })
          : facts.mergeable === 'conflicts'
            ? t('home.board.fact.conflicts', { base: ws.baseBranch })
            : t('home.board.fact.mergeUnknown')
      lines.push({ ok: facts.mergeable === 'yes' ? true : facts.mergeable === 'conflicts' ? false : null, text: merge, source: host })
      if (facts.draft) lines.push({ ok: false, text: t('home.board.fact.draft'), source: host })
    }
    if (fact === 'pr-unknown') lines.push({ ok: null, text: t('home.board.prUnknown'), source: host })
    if (fact === 'quiet') lines.push({ ok: true, text: t('home.board.fact.quiet'), source: foreman })
  }
  return lines
}

/** The hover card's body: the facts behind the card's lane, and a Refresh for the pull request they come from. */
function WhyBody({ p, lane, sessions, now }: { p: Placement; lane: Lane; sessions: Session[]; now: number }) {
  const t = useT()
  const gitlab = useGitlab(p.t.ws)
  const facts = p.t.ws.prInfo?.facts
  const [busy, setBusy] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)
  // G2: a fresh PR read from here, through the shared PR cache (its back-off still holds), as the PR glyph's card does.
  const refresh = async () => {
    setBusy(true)
    setRefreshNote(null)
    const result = await api.refreshPullRequest(p.t.ws.id).catch(() => 'unavailable' as const)
    setBusy(false)
    if (result === 'paused') setRefreshNote(t('attention.pr.paused'))
    else if (result === 'unavailable') setRefreshNote(t('attention.pr.unavailable'))
  }
  const hasPr = p.why.includes('pr-open') || p.why.includes('pr-merged') || p.why.includes('pr-unknown')
  const note = lane === 'ready' ? t('home.board.note.ready') : canDrop(lane) ? t('home.board.note.manual') : t('home.board.note.live')
  const readAge = facts ? shortAge(facts.readAt, now, t.locale) : null
  const host = t(facts?.provider === 'gitlab' ? 'home.board.source.gitlab' : 'home.board.source.github')
  return (
    <>
      <div className="bhover-title">{t('home.board.why', { name: p.t.ws.name, lane: t(`home.board.lane.${lane}`) })}</div>
      <ul className="bhover-facts">
        {whyLines(p, sessions, t, now, gitlab).map((line, i) => (
          <li key={i}>
            {line.ok === true ? <Check size={12} className="ok" aria-hidden /> : line.ok === false ? <X size={12} className="bad" aria-hidden /> : <CircleHelp size={12} className="faint" aria-hidden />}
            <span>{line.text}</span>
            <span className="bhover-src">
              {line.source}
              {line.age ? ` · ${line.age}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="bhover-sep" />
      <div className="bhover-note">{note}</div>
      {hasPr && (
        <div className="bhover-foot">
          {facts && (
            <>
              {readAge ? t('home.board.readFrom', { source: host, age: readAge }) : t('home.board.readFromJustNow', { source: host })}
              {facts.unreadable && <> · {t('home.board.prUnknown')}</>}
              {' · '}
            </>
          )}
          <LinkButton size="sm" disabled={busy} onClick={() => void refresh()}>
            {busy && <Spinner size={11} />}
            {t('attention.pr.refresh')}
          </LinkButton>
        </div>
      )}
      {refreshNote && <div className="bhover-foot">{refreshNote}</div>}
    </>
  )
}

// ---- the board ----

export function HomeBoard({ items, repoNames, now }: { items: Triage[]; repoNames?: Map<string, string>; now: number }) {
  const t = useT()
  const doneDays = useStore((s) => s.snapshot!.settings.homeDoneDays) || DEFAULT_DONE_DAYS
  const sessions = useStore((s) => s.snapshot!.sessions)
  const opts: BoardOptions = { now, doneDays }
  const board = boardLanes(items, opts)
  const [drag, setDrag] = useState<{ p: Placement; from: Lane } | null>(null)
  const [over, setOver] = useState<Lane | null>(null)

  const [focusId, setFocusId] = useState<string | null>(null)
  // G2: a card moved with the keyboard keeps focus in its new lane.
  useEffect(() => {
    if (!focusId) return
    document.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(focusId)}"]`)?.focus()
    setFocusId(null)
  })

  /** Set the manual status a lane stands for, then say where the card landed, with Undo (G2). */
  const move = async (p: Placement, from: Lane, lane: Lane) => {
    const status = dropStatus(lane)
    if (!status || !moveChanges(p.t, from, lane)) return
    const { id } = p.t.ws
    const before = p.t.ws.status ?? null
    const saved = await attempt(async () => (await api.updateWorkspace(id, { status }), true))
    if (!saved) return
    const landed = laneAfterDrop(p.t, lane, opts)
    const name = statusName(t, status)
    showToast(landed && landed !== lane ? t('home.board.toast.stays', { status: name, lane: t(`home.board.lane.${landed}`) }) : t('home.board.toast.set', { status: name }), 'info', {
      action: {
        label: t('home.board.undo'),
        run: async () => {
          await api.updateWorkspace(id, { status: before })
          setFocusId(id)
        }
      }
    })
  }

  const drop = async (lane: Lane) => {
    const from = drag
    setDrag(null)
    setOver(null)
    if (from) await move(from.p, from.from, lane)
  }

  const keyMove = async (p: Placement, from: Lane, dir: -1 | 1) => {
    const to = keyboardLane(from, dir)
    if (!to) return showToast(t(dir < 0 ? 'home.board.key.noLeft' : 'home.board.key.noRight'))
    await move(p, from, to)
    setFocusId(p.t.ws.id)
  }

  const laneProps = (lane: Lane) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag || !canDrop(lane)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (over !== lane) setOver(lane)
    },
    onDragLeave: (e: DragEvent) => {
      if (over === lane && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      void drop(lane)
    }
  })

  return (
    <>
      <div className={`board ${drag ? 'dragging' : ''}`}>
        {LANES.map((lane) => {
          const cards = board.lanes[lane]
          const dropClass = !drag ? '' : !canDrop(lane) ? 'drop-no' : over === lane ? 'drop-ok' : 'drop-maybe'
          const hint = lane === 'done' ? t('home.board.hint.done', { count: doneDays }) : t(`home.board.hint.${lane}`)
          return (
            <section key={lane} className={`blane ${dropClass}`} aria-label={t(`home.board.lane.${lane}`)} {...laneProps(lane)}>
              <header className="blane-head">
                <Status compact aria-hidden tone={LANE_TONE[LANE_DOT[lane]]} label={t(`home.board.lane.${lane}`)} className="blane-dot" />
                <span className="blane-title">{t(`home.board.lane.${lane}`)}</span>
                <span className="blane-count">{cards.length}</span>
                <span className="blane-hint">{hint}</span>
              </header>
              <div className="blane-body">
                {drag && !canDrop(lane) && (
                  <div className="blane-nodrop">
                    <Ban size={12} aria-hidden />
                    {lane === 'ready' ? t('home.board.noDropReady') : t('home.board.noDrop')}
                  </div>
                )}
                {drag && over === lane && (
                  <Card empty target className="drop-slot">
                    <span className="drop-slot-text">{t('home.board.dropHere', { lane: t(`home.board.lane.${lane}`) })}</span>
                  </Card>
                )}
                {cards.map((p) => (
                  <BoardCard
                    key={p.t.ws.id}
                    p={p}
                    repoName={repoNames?.get(p.t.ws.repoId)}
                    sessions={sessions}
                    now={now}
                    dragging={Boolean(drag)}
                    onDragStart={() => setDrag({ p, from: lane })}
                    onDragEnd={() => {
                      setDrag(null)
                      setOver(null)
                    }}
                    onMove={(dir) => void keyMove(p, lane, dir)}
                  />
                ))}
                {!cards.length && !drag && <div className="blane-empty">{t('home.board.empty')}</div>}
              </div>
            </section>
          )
        })}
      </div>
      {board.off.length > 0 && <OffBoard off={board.off} />}
    </>
  )
}

/** Workspaces no lane fits (idle with no PR, a closed PR, history only), named so nothing silently goes missing. */
function OffBoard({ off }: { off: Placement[] }) {
  const t = useT()
  const items: ReactNode[] = off.map((p, i) => {
    const reason = p.why[0] === 'pr-closed' ? 'pr-closed' : p.why[0] === 'history' ? 'history' : 'idle-no-pr'
    const status = p.t.ws.status ? `, ${t('home.board.offStatus', { status: statusName(t, p.t.ws.status) })}` : ''
    return (
      <span key={p.t.ws.id}>
        {i > 0 && ', '}
        <LinkButton size="sm" onClick={() => openTriaged(p.t)}>
          {p.t.ws.name}
        </LinkButton>
        <span> · {t(`home.board.offReason.${reason}`)}{status}</span>
      </span>
    )
  })
  return (
    <p className="board-foot">
      <Info size={12} aria-hidden />
      <span>
        {t('home.board.off', { count: off.length })} {items} · {t('home.board.offSuffix')}
      </span>
    </p>
  )
}
