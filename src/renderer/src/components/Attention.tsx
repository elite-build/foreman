// #3 Attention history, tray and row glyphs: the renderer's parts. The PR glyph and its hover card
// ("PR #42 · CI failing (2 checks) · as of 14:02 · Refresh") on sidebar and Home rows, and Home →
// Recent, the history of what happened. Recent is history only: opening or marking it seen never
// resolves anything that needs you; the live reasons stay in Needs your attention.
import { Check, ChevronRight, Circle, CircleAlert, CircleCheck, CircleX, GitMerge, GitPullRequest, GitPullRequestDraft, MessageSquareText } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { prGlyph, unseenCount, type AttentionEvent, type PrGlyph } from '../../../shared/attention'
import { clockTime } from '../../../shared/usageLimit'
import type { Workspace } from '../../../shared/types'
import { api, applyLinkRoute, markAttentionSeen, useStore } from '../store'
import { useT, type RendererT } from '../i18n'
import { turnEndedEventSentence } from '../agentStatus'
import { ActionRow, HoverCard, LinkButton, Pressable, Spinner, Tag } from '../ui'
import './attention.css'

// ---- times ----

/** "14:02" today, "21 Oct 14:02" before. */
export function eventTime(iso: string, now: number, locale?: string): string {
  const at = Date.parse(iso)
  const time = clockTime(at, locale)
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay ? time : `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(at))} ${time}`
}

// ---- the PR glyph ----

const prRef = (t: RendererT, g: PrGlyph) => t(g.provider === 'gitlab' ? 'attention.pr.ref.gitlab' : 'attention.pr.ref.github', { number: g.number })

function PrIcon({ state }: { state: PrGlyph['state'] }) {
  if (state === 'merged') return <GitMerge size={12} aria-hidden />
  if (state === 'draft') return <GitPullRequestDraft size={12} aria-hidden />
  return <GitPullRequest size={12} aria-hidden />
}

/** The hover card's body: which PR, where its checks and review stand, and when that was read, with Refresh. */
function PrCardBody({ ws, glyph }: { ws: Workspace; glyph: PrGlyph }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const state = glyph.state === 'ci-failing' && glyph.failing ? t('attention.pr.ciFailingCount', { count: glyph.failing }) : t(`attention.pr.state.${glyph.state}`)
  const checks = glyph.state !== 'ci-failing' && glyph.state !== 'merged' && glyph.checks && glyph.checks !== 'failing' ? t(`attention.pr.checks.${glyph.checks}`) : null
  const review = glyph.state !== 'merged' && glyph.review && glyph.review !== 'unknown' ? t(`attention.pr.review.${glyph.review}`) : null
  const time = glyph.readAt ? clockTime(Date.parse(glyph.readAt), t.locale) : null
  const refresh = async () => {
    setBusy(true)
    setNote(null)
    const result = await api.refreshPullRequest(ws.id).catch(() => 'unavailable' as const)
    setBusy(false)
    if (result === 'paused') setNote(t('attention.pr.paused'))
    else if (result === 'unavailable') setNote(t('attention.pr.unavailable'))
  }
  return (
    <>
      <div className="pr-card-title">
        <PrIcon state={glyph.state} />
        <strong>{prRef(t, glyph)}</strong>
      </div>
      <div className={`pr-card-line ${glyph.state}`}>
        {glyph.state === 'ci-failing' ? <CircleX size={12} aria-hidden /> : <Circle size={12} aria-hidden />}
        {state}
      </div>
      {checks && (
        <div className="pr-card-line">
          {glyph.checks === 'passed' ? <Check size={12} aria-hidden /> : <Circle size={12} aria-hidden />}
          {checks}
        </div>
      )}
      {review && (
        <div className="pr-card-line">
          <Circle size={12} aria-hidden />
          {review}
        </div>
      )}
      <div className="pr-card-foot">
        <span>{time ? (glyph.stale ? t('attention.pr.stale', { time }) : t('attention.pr.asOf', { time })) : t('attention.pr.notRead')}</span>
        <span> · </span>
        <LinkButton size="sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? <Spinner size={11} /> : null}
          {t('attention.pr.refresh')}
        </LinkButton>
      </div>
      {note && <div className="pr-card-note">{note}</div>}
    </>
  )
}

/**
 * The PR glyph beside a row's own (attention-first) glyph: open, draft, merged, or red when CI fails, as last
 * read. Hovering or focusing it shows when that was, with Refresh. Nothing for no PR, a closed one, or one not read yet.
 * Keep it beside a row's main button, never inside it: it is a button of its own.
 */
export function PrGlyphView({ ws, number }: { ws: Workspace; number?: boolean }) {
  const t = useT()
  const glyph = prGlyph(ws)
  if (!glyph) return null
  const name = `${prRef(t, glyph)} · ${t(`attention.pr.state.${glyph.state}`)}`
  return (
    <span className={`pr-glyph ${glyph.state}${glyph.stale ? ' stale' : ''}`}>
      <HoverCard
        label={name}
        width={260}
        trigger={(p) => (
          <Pressable {...p} aria-label={name} onClick={(e) => e.stopPropagation()}>
            <PrIcon state={glyph.state} />
            {number && (
              <span className="pr-glyph-num">
                {glyph.provider === 'gitlab' ? '!' : '#'}
                {glyph.number}
              </span>
            )}
          </Pressable>
        )}
      >
        <PrCardBody ws={ws} glyph={glyph} />
      </HoverCard>
    </span>
  )
}

// ---- Home → Recent ----

const SHOWN = 5

function EventIcon({ e }: { e: AttentionEvent }) {
  switch (e.kind) {
    case 'pr-merged':
      return <GitMerge size={13} className="blue" aria-hidden />
    case 'ci-failed':
      return <CircleX size={13} className="red" aria-hidden />
    case 'ci-passed':
      return <CircleCheck size={13} className="green" aria-hidden />
    case 'approval-answered':
      return <Check size={13} className="green" aria-hidden />
    case 'agent-report':
      return <MessageSquareText size={13} className="amber" aria-hidden />
    case 'reason':
      return <CircleAlert size={13} className="amber" aria-hidden />
    case 'reason-cleared':
      return <CircleCheck size={13} className="faint" aria-hidden />
    case 'turn-ended':
      return e.outcome === 'completed' ? <CircleCheck size={13} className="green" aria-hidden /> : e.outcome === 'error' ? <CircleX size={13} className="red" aria-hidden /> : <Circle size={13} className="faint" aria-hidden />
  }
}

/** What one event says: the headline, and the facts after it. */
export function eventText(e: AttentionEvent, t: RendererT): { head: string; rest: string[]; says?: boolean } {
  const ref = e.pr !== undefined ? t(e.gitlab ? 'attention.pr.ref.gitlab' : 'attention.pr.ref.github', { number: e.pr }) : ''
  switch (e.kind) {
    case 'reason':
      return { head: e.label ?? '', rest: e.detail ? [e.detail] : [] }
    case 'reason-cleared':
      return { head: t('attention.event.cleared', { label: e.label ?? '' }), rest: [] }
    case 'turn-ended':
      return { head: t(`attention.event.turn.${e.outcome ?? 'completed'}`), rest: [e.tab ? t('attention.event.tab', { n: e.tab }) : '', e.detail ?? ''].filter(Boolean) }
    case 'pr-merged':
      return { head: t('attention.event.prMerged', { ref }), rest: [] }
    case 'ci-failed':
      return { head: t('attention.event.ciFailed'), rest: [ref, e.detail ? t('attention.event.failing', { count: Number(e.detail) }) : ''].filter(Boolean) }
    case 'ci-passed':
      return { head: t('attention.event.ciPassed'), rest: [ref] }
    case 'approval-answered': {
      const what = e.label === 'plan' ? t('attention.event.plan') : e.label === 'question' ? t('attention.event.question') : (e.label ?? '')
      // G2: where it was answered, when the event says (older events don't).
      return { head: t(e.allowed ? 'attention.event.approvalAllowed' : 'attention.event.approvalDenied', { what }), rest: e.via ? [t(e.via === 'phone' ? 'attention.event.viaPhone' : 'attention.event.viaWindow')] : [] }
    }
    case 'agent-report': {
      const kind = e.label === 'review' ? t('attention.event.reportReview') : e.label && ['needs-input', 'stuck', 'checkpoint', 'done'].includes(e.label) ? t(`reports.kind.${e.label as 'needs-input'}`) : (e.label ?? '')
      return { head: t('attention.event.report', { kind }), rest: e.detail ? [`“${e.detail}”`] : [], says: true }
    }
  }
}

/** Open what an event was about: the workspace and its tab; an archived one read-only (#13). */
function openEvent(e: AttentionEvent, ws: Workspace, tabOpen: boolean): void {
  const sessionId = tabOpen ? e.sessionId : undefined
  applyLinkRoute(ws.state === 'archived' ? { kind: 'archived', workspaceId: ws.id, sessionId } : { kind: 'workspace', workspaceId: ws.id, sessionId })
}

function RecentRow({ e, ws, now, seen, tabOpen, repo }: { e: AttentionEvent; ws: Workspace; now: number; seen: boolean; tabOpen: boolean; repo?: string }) {
  const t = useT()
  const text = eventText(e, t)
  const rest: ReactNode[] = [...text.rest, repo].filter(Boolean)
  // E4: a turn that ended reads as the narrator's sentence ("Claude finished in api-fix"), as the row's description.
  const describedBy = useId()
  const session = useStore((s) => (e.sessionId ? s.snapshot!.sessions.find((x) => x.id === e.sessionId) : undefined))
  const narration = e.kind === 'turn-ended' ? turnEndedEventSentence(t, { session, workspace: ws, outcome: e.outcome }) : null
  return (
    <ActionRow
      role="listitem"
      divided
      className={`recent-row ${seen ? 'seen' : ''}`}
      primaryProps={{ className: 'recent-flow', 'aria-describedby': narration ? describedBy : undefined }}
      onPress={() => openEvent(e, ws, tabOpen)}
    >
      {narration && (
        <span id={describedBy} hidden>
          {narration}
        </span>
      )}
      <span className="recent-time">{eventTime(e.at, now, t.locale)}</span>
      <EventIcon e={e} />
      <span className="recent-ws">{ws.name}</span>
      <span className="recent-text">
        <strong>{text.head}</strong>
        {text.says && (
          <Tag tone="outline" className="says" title={t('reports.saysTitle')}>
            {t('reports.says')}
          </Tag>
        )}
        {rest.length > 0 && <span className="muted"> · {rest.join(' · ')}</span>}
        {e.count > 1 && <Tag className="recent-repeats">{t('attention.recent.repeats', { count: e.count, time: eventTime(e.firstAt, now, t.locale) })}</Tag>}
      </span>
      <ChevronRight size={13} className="faint" aria-hidden />
    </ActionRow>
  )
}

export function RecentCard({ repoId, repoNames }: { repoId: string | null; repoNames?: Map<string, string> }) {
  const t = useT()
  const history = useStore((s) => s.attentionHistory)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const sessions = useStore((s) => s.snapshot!.sessions)
  const [all, setAll] = useState(false)
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  // Events about a workspace that has been removed have nowhere to go.
  const events = history.events.filter((e) => {
    const ws = byId.get(e.workspaceId)
    return ws && (!repoId || ws.repoId === repoId)
  })
  if (!events.length) return null
  const now = Date.now()
  const unseen = unseenCount(events, history.seenAt)
  const shown = all ? events : events.slice(0, SHOWN)
  const openTabs = new Set(sessions.filter((s) => !s.closedAt).map((s) => s.id))
  return (
    <section className="home-card recent-card">
      <header className="home-card-head">
        <span className="home-card-title">{t('attention.recent.title')}</span>
        {unseen > 0 && (
          <Tag className="recent-count" title={t('attention.recent.unseen', { count: unseen })}>
            {unseen}
          </Tag>
        )}
        <span className="home-card-hint">{t('attention.recent.hint')}</span>
        <span className="spacer" />
        {unseen > 0 && (
          <LinkButton size="sm" title={t('attention.recent.markSeenTitle')} onClick={() => void markAttentionSeen()}>
            {t('attention.recent.markSeen')}
          </LinkButton>
        )}
      </header>
      <div role="list">
        {shown.map((e) => (
          <RecentRow key={e.id} e={e} ws={byId.get(e.workspaceId)!} now={now} seen={Boolean(history.seenAt && e.at <= history.seenAt)} tabOpen={Boolean(e.sessionId && openTabs.has(e.sessionId))} repo={repoNames?.get(byId.get(e.workspaceId)!.repoId)} />
        ))}
      </div>
      <footer className="recent-foot">
        <span>{t('attention.recent.kept')}</span>
        {events.length > SHOWN && (
          <LinkButton size="sm" onClick={() => setAll(!all)}>
            {all ? t('attention.recent.less') : t('attention.recent.more', { count: events.length - SHOWN })}
          </LinkButton>
        )}
      </footer>
    </section>
  )
}
