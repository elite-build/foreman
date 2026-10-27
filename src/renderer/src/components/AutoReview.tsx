// #17 Auto review in the renderer: the repository opt-in and its consent dialog,
// the reviewer tab's receipt, findings (Reviews.tsx's thread markup) and stale bar,
// Home's wording for its reason, and Send to worker…, which shows the exact message
// before it goes. Nothing here starts a review or sends findings on its own: main
// decides when a review runs, and findings only move on the user's click.
import { Bot, Lock, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { AGENTS, modelInfo, modelsFor, type Loadout } from '../../../shared/agents'
import { canReview, findingPlace, findingsMessage, parseExclusions, reviewOf, usedToday } from '../../../shared/autoReview'
import type { AppSnapshot, AutoReview, AutoReviewShown, ChatItem, Session, Workspace } from '../../../shared/types'
import type { Triage } from '../triage'
import { useT, type RendererT } from '../i18n'
import { formatClock } from '../../../shared/i18n/time'
import { api, attempt, availableAgents, openHandOffDialog, openSessions, requestOpenFile, selectWorkspace, showToast, useStore } from '../store'
import { useClock } from '../clock'
import { Button, Callout, Checkbox, Dialog, Field, LinkButton, Select, Spinner, Switch, Tag, TextInput, type TagTone } from '../ui'
import { Row } from './settings/controls'
import './autoReview.css'

const modelName = (l: Loadout): string => modelInfo(l.agent, l.model).label
const minutesSince = (iso: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))

/** "Tab 2", by the tab's place among the workspace's open tabs; "a closed tab" reads as "Tab ?". */
function tabName(t: RendererT, snapshot: AppSnapshot, workspaceId: string, sessionId: string): string {
  const n = openSessions(snapshot, workspaceId).findIndex((s) => s.id === sessionId)
  return t('autoReview.tabName', { n: n < 0 ? '?' : n + 1 })
}

/** Why a review ended without an opinion, in the user's language (main's English reason goes in the tooltip). */
function stateText(t: RendererT, review: AutoReview): string {
  switch (review.state) {
    case 'timed-out':
      return t('autoReview.state.timed-out', { minutes: review.maxMinutes })
    case 'needs-you':
      return t('autoReview.state.needs-you')
    case 'failed':
      return t('autoReview.state.failed')
    default:
      return t('autoReview.state.stopped')
  }
}

// Stopped while the window is minimized or hidden (clock.ts).
const useNow = (everyMs = 30_000): number => useClock(everyMs)

/** "Review again…": the Code review dialog from the worker's tab, read-only ticked; nothing runs until Start. */
export function reviewAgain(snapshot: AppSnapshot, review: AutoReview): void {
  const open = openSessions(snapshot, review.workspaceId)
  const source = open.find((s) => s.id === review.workerSessionId) ?? open.find((s) => !s.autoReview) ?? open[0]
  if (!source) return
  selectWorkspace(review.workspaceId)
  openHandOffDialog({ sourceId: source.id, kind: 'review', readOnly: true })
}

// ---- Repository → Actions ----

/** The opt-in row. Switching it on opens the consent dialog; nothing is on until that is approved. */
export function AutoReviewSetting({ repoId }: { repoId: string }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === repoId))
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const [asking, setAsking] = useState(false)
  if (!repo) return null
  const consent = repo.autoReview
  const detail = consent ? (
    <span className={consent.paused ? 'ar-paused' : 'faint'}>
      {consent.paused
        ? t('autoReview.setting.paused')
        : t('autoReview.setting.summary', { model: modelName(consent.reviewer), used: usedToday(workspaces, repo.id, Date.now()), perDay: consent.perDay, minutes: consent.maxMinutes })}{' '}
      <LinkButton size="sm" onClick={() => setAsking(true)}>
        {t('autoReview.setting.edit')}
      </LinkButton>
    </span>
  ) : undefined
  return (
    <>
      <Row id="auto-review" label={t('autoReview.setting.label')} help={t('autoReview.setting.help')} detail={detail}>
        <Switch
          checked={Boolean(consent)}
          label={t('autoReview.setting.label')}
          onChange={(on) => (on ? setAsking(true) : void attempt(() => api.setAutoReview(repo.id, null)))}
        />
      </Row>
      {asking && <AutoReviewDialog repoId={repo.id} onClose={() => setAsking(false)} />}
    </>
  )
}

/** The reviewers on offer: Claude Code and Codex models only (the agents Foreman can hold read-only), the current one first. */
function reviewerOptions(current: Loadout | null, available: Record<string, boolean>): Loadout[] {
  const out: Loadout[] = current ? [current] : []
  for (const agent of ['claude', 'codex'] as const) {
    if (!canReview(agent) || !available[agent]) continue
    for (const m of modelsFor(agent)) {
      if (!out.some((l) => l.agent === agent && l.model === m.id)) out.push({ agent, model: m.id, effort: m.defaultEffort, fast: false })
    }
  }
  return out
}

const loadoutKey = (l: Loadout) => `${l.agent}\n${l.model}`

/** A finding's severity as a tag tone: the shape says it as well as the colour. */
const SEVERITY_TONE: Record<'high' | 'medium' | 'low', TagTone> = { high: 'error', medium: 'warn', low: 'neutral' }

/** The consent: the reviewer, when it runs, what it skips, the budget, what it reads and that it is read-only. */
export function AutoReviewDialog({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === repoId))
  const available = useStore((s) => availableAgents(s))
  const [reviewer, setReviewer] = useState<Loadout | null>(null)
  const [exclusions, setExclusions] = useState<string | null>(null)
  const [preview, setPreview] = useState<AutoReviewShown | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()
  // What main would approve for this reviewer and these exclusions, read again whenever either changes.
  useEffect(() => {
    let live = true
    const choice = reviewer ? { reviewer, exclusions: exclusions === null ? undefined : parseExclusions(exclusions) } : undefined
    void api.autoReviewPreview(repoId, choice).then(
      (p) => {
        if (!live) return
        setPreview(p)
        if (!reviewer) setReviewer(p.reviewer)
        if (exclusions === null) setExclusions(p.exclusions.join(', '))
      },
      () => live && setPreview(null)
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, reviewer, exclusions])
  const options = useMemo(() => reviewerOptions(reviewer, available), [reviewer, available])
  if (!repo) return null
  const editing = Boolean(repo.autoReview)
  const approve = async () => {
    if (!preview || exclusions === null) return
    setBusy(true)
    const done = await attempt(() => api.setAutoReview(repoId, { ...preview, exclusions: parseExclusions(exclusions) }).then(() => true))
    setBusy(false)
    if (done) onClose()
  }
  return (
    <Dialog
      title={t(editing ? 'autoReview.dialog.editTitle' : 'autoReview.dialog.title', { repo: repo.name })}
      onClose={onClose}
      size="lg"
      className="dlg"
      footer={
        <>
          <span className="faint small dlg-start">{t('autoReview.dialog.waits')}</span>
          <Button onClick={onClose}>{t('autoReview.dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || !preview} onClick={() => void approve()}>
            {t(editing ? 'autoReview.dialog.save' : 'autoReview.dialog.confirm')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('autoReview.dialog.intro')}</p>
      {!preview || !reviewer ? (
        <p className="faint small">{t('autoReview.dialog.loading')}</p>
      ) : (
        <>
          <Field label={t('autoReview.dialog.reviewer')} description={t('autoReview.dialog.reviewerHelp')}>
            {(c) => (
              <Select
                {...c}
                value={loadoutKey(reviewer)}
                onChange={(key) => {
                  const next = options.find((l) => loadoutKey(l) === key)
                  if (next) setReviewer(next)
                }}
                options={options.map((l) => ({ value: loadoutKey(l), label: `${AGENTS[l.agent].label} · ${modelName(l)}` }))}
              />
            )}
          </Field>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-when`}>
            <span id={`${id}-when`} className="dlg-label">
              {t('autoReview.dialog.runsWhen')}
            </span>
            <ul className="consent-list">
              <li>{t('autoReview.dialog.when.idle', { count: preview.idleMinutes })}</li>
              <li>{t('autoReview.dialog.when.checks')}</li>
              <li>{t('autoReview.dialog.when.tree')}</li>
            </ul>
          </div>
          <Field label={t('autoReview.dialog.exclusions')} description={t('autoReview.dialog.exclusionsHelp')}>
            {(c) => <TextInput {...c} mono value={exclusions ?? ''} spellCheck={false} onChange={(e) => setExclusions(e.target.value)} />}
          </Field>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-budget`}>
            <span id={`${id}-budget`} className="dlg-label">
              {t('autoReview.dialog.budget')}
            </span>
            <div className="ar-budget">
              <Tag tone="outline">{t('autoReview.dialog.perDay', { count: preview.perDay, repo: repo.name })}</Tag>
              <Tag tone="outline">{t('autoReview.dialog.maxMinutes', { count: preview.maxMinutes })}</Tag>
            </div>
          </div>
          <details className="ar-prompt">
            <summary>{t('autoReview.dialog.prompt')}</summary>
            <pre className="consent-diff mono">{preview.prompt}</pre>
          </details>
          <div className="handoff-dest small">
            <div>{t('autoReview.dialog.reads')}</div>
            <div>
              <Lock size={11} /> {t(preview.readOnly === 'plan' ? 'autoReview.dialog.permissions.plan' : 'autoReview.dialog.permissions.sandbox')}
            </div>
            <div>{t('autoReview.dialog.result')}</div>
            <div className="faint">{t('autoReview.dialog.again')}</div>
          </div>
        </>
      )}
    </Dialog>
  )
}

// ---- the reviewer tab ----

/** The lock beside a reviewer tab's title. */
export function AutoReviewTabMark({ session }: { session: Session }) {
  const t = useT()
  if (!session.autoReview) return null
  return <Lock size={10} className="faint ar-tab-lock" aria-label={t('autoReview.tab.lock')} />
}

/** Above the reviewer's chat: running with its time and budget, stopped (and why), or stale with Review again…. */
export function AutoReviewBar({ workspace, session }: { workspace: Workspace; session?: Session }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const now = useNow()
  const review = session?.autoReview ? reviewOf(workspace, session.autoReview.reviewId) : undefined
  if (!review) return null
  if (review.state === 'running') {
    return (
      <div className="ar-bar running">
        <Spinner size={12} />
        <span>{t('autoReview.bar.running', { elapsed: minutesSince(review.startedAt, now), max: review.maxMinutes, n: review.n, of: review.of })}</span>
      </div>
    )
  }
  if (review.state !== 'ready') {
    return (
      <div className="ar-bar stopped" title={review.reason}>
        <TriangleAlert size={12} />
        <span>{stateText(t, review)}</span>
        <span className="spacer" />
        <Button size="sm" onClick={() => reviewAgain(snapshot, review)} title={t('autoReview.home.againTitle')}>
          {t('autoReview.bar.again')}
        </Button>
      </div>
    )
  }
  if (!review.stale) return null
  return (
    <div className="ar-bar stale">
      <span>{t('autoReview.bar.stale')}</span>
      <span className="muted">{t('autoReview.bar.staleAt', { time: formatClock(review.stale.at, t.locale) })}</span>
      <span className="spacer" />
      <Button size="sm" onClick={() => reviewAgain(snapshot, review)} title={t('autoReview.home.againTitle')}>
        {t('autoReview.bar.again')}
      </Button>
    </div>
  )
}

/** Under Foreman's message in the reviewer tab: who sent it, why, and which diff. */
export function AutoReviewReceipt({ workspace, session, item }: { workspace: Workspace; session: Session; item: ChatItem }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const review = reviewOf(workspace, session.autoReview?.reviewId)
  if (!review || item.kind !== 'user' || item.turnId !== review.turnId) return null
  const params = { tab: tabName(t, snapshot, workspace.id, review.workerSessionId), tree: review.tree.slice(0, 7), files: review.diff.files, add: review.diff.additions, del: review.diff.deletions }
  return (
    <div className="ar-receipt small">
      <Tag>
        <Bot size={11} /> {t('autoReview.receipt.sent', { n: review.n, of: review.of })}
      </Tag>
      <span className="faint">{t(review.checks === 'passed' ? 'autoReview.receipt.passed' : 'autoReview.receipt.none', params)}</span>
    </div>
  )
}

/** The findings, as review threads, right above the review turn's result line. Send to worker… only opens the dialog. */
export function AutoReviewFindings({ workspace, session, turnId }: { workspace: Workspace; session: Session; turnId: string }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const review = reviewOf(workspace, session.autoReview?.reviewId)
  const unsent = (review?.findings ?? []).filter((f) => !f.sent).map((f) => f.id)
  // Null until the user picks: every finding not sent yet starts ticked.
  const [chosen, setSelected] = useState<string[] | null>(null)
  const [sending, setSending] = useState(false)
  if (!review || review.turnId !== turnId || review.state !== 'ready') return null
  if (!review.findings) return <Callout>{t('autoReview.findings.unknown')}</Callout>
  const findings = review.findings
  const picked = (chosen ?? unsent).filter((id) => unsent.includes(id))
  return (
    <div className="ar-findings">
      <div className="review-actions">
        <Checkbox
          className="review-select"
          disabled={!unsent.length}
          checked={unsent.length > 0 && picked.length === unsent.length}
          onChange={(e) => setSelected(e.target.checked ? unsent : [])}
        >
          {t('autoReview.findings.selectAll')}
        </Checkbox>
        <span className="faint small ar-count">{t('autoReview.findings.count', { count: findings.length })}</span>
        {findings.length > 0 && (
          <Button size="sm" disabled={!picked.length} onClick={() => setSending(true)}>
            {t('autoReview.findings.send', { count: picked.length })}
          </Button>
        )}
      </div>
      {findings.map((f) => {
        const place = findingPlace(f)
        return (
          <div className="review-thread" key={f.id}>
            <div className="review-thread-head">
              <Checkbox
                aria-label={t('autoReview.findings.select', { place: place || f.title })}
                disabled={Boolean(f.sent)}
                checked={!f.sent && picked.includes(f.id)}
                onChange={(e) => setSelected(e.target.checked ? [...picked, f.id] : picked.filter((id) => id !== f.id))}
              />
              {f.severity && <Tag tone={SEVERITY_TONE[f.severity]}>{t(`autoReview.sev.${f.severity}`)}</Tag>}
              {place ? (
                <LinkButton size="sm" mono title={place} onClick={() => requestOpenFile(workspace.id, f.file!, f.line)}>
                  {place}
                </LinkButton>
              ) : (
                <span className="faint small">{t('autoReview.findings.whole')}</span>
              )}
              <span className="spacer" />
              {f.sent && <span className="ar-sent">{t('autoReview.findings.sent', { tab: tabName(t, snapshot, workspace.id, f.sent.sessionId), time: formatClock(f.sent.at, t.locale) })}</span>}
            </div>
            <div className="review-comment">
              <b>{f.title}</b>
              {f.body && ` ${f.body}`}
            </div>
          </div>
        )
      })}
      {sending && <SendFindingsDialog workspace={workspace} review={review} findingIds={picked} onClose={() => setSending(false)} onSent={() => setSelected([])} />}
    </div>
  )
}

/** Pick the worker tab and see the exact message before it goes. The only way findings reach a worker. */
function SendFindingsDialog({ workspace, review, findingIds, onClose, onSent }: { workspace: Workspace; review: AutoReview; findingIds: string[]; onClose: () => void; onSent: () => void }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const tabs = openSessions(snapshot, workspace.id)
  const workers = tabs.filter((s) => !s.autoReview)
  const [target, setTarget] = useState(workers.find((s) => s.id === review.workerSessionId)?.id ?? workers[0]?.id)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const message = findingsMessage(review, (review.findings ?? []).filter((f) => findingIds.includes(f.id)))
  const send = async () => {
    if (!target) return
    setBusy(true)
    const disposition = await attempt(() => api.sendAutoReviewFindings(workspace.id, review.id, findingIds, target))
    setBusy(false)
    if (!disposition) return
    const tab = tabName(t, snapshot, workspace.id, target)
    showToast(disposition === 'queued' ? t('autoReview.send.queued', { tab }) : t('autoReview.send.done', { tab }))
    onSent()
    onClose()
  }
  return (
    <Dialog
      title={t('autoReview.send.title')}
      onClose={onClose}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={onClose}>{t('autoReview.send.cancel')}</Button>
          <Button variant="primary" disabled={busy || !target || !findingIds.length} onClick={() => void send()}>
            {t('autoReview.send.confirm')}
          </Button>
        </>
      }
    >
      {workers.length === 0 ? (
        <p className="muted">{t('autoReview.send.noTabs')}</p>
      ) : (
        <Field label={t('autoReview.send.to')}>
          {(c) => (
            <Select
              {...c}
              value={target ?? ''}
              onChange={setTarget}
              options={workers.map((s) => ({ value: s.id, label: t('autoReview.send.tab', { n: tabs.indexOf(s) + 1, title: s.title || '—', agent: AGENTS[s.agent]?.label ?? s.agent }) }))}
            />
          )}
        </Field>
      )}
      <div className="dlg-group" role="group" aria-labelledby={`${id}-message`}>
        <span id={`${id}-message`} className="dlg-label">
          {t('autoReview.send.message')}
        </span>
        <pre className="consent-diff mono ar-message">{message}</pre>
        <small className="dlg-hint">{t('autoReview.send.note')}</small>
      </div>
    </Dialog>
  )
}

// ---- Home ----

/** Home's wording for an auto review row: its label, the line under it, and whether it's stale. Null for other rows. */
export function useAutoReviewRow(row: Triage): { label: string; sub: string; stale: boolean; review: AutoReview } | null {
  const t = useT()
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const review = row.autoReviewId ? row.ws.autoReviews?.find((r) => r.id === row.autoReviewId) : undefined
  if (!review) return null
  const model = t('autoReview.home.model', { model: modelName(review.reviewer) })
  if (review.state === 'running') {
    const now = Date.now()
    return {
      label: t('autoReview.home.reviewing'),
      sub: t('autoReview.home.running', { model: modelName(review.reviewer), elapsed: minutesSince(review.startedAt, now), max: review.maxMinutes, used: usedToday(workspaces, review.repoId, now), of: review.of }),
      stale: false,
      review
    }
  }
  if (review.state !== 'ready') return { label: t('autoReview.home.stopped'), sub: [stateText(t, review), model].join(' · '), stale: false, review }
  const findings = review.findings ? t('autoReview.home.findings', { count: review.findings.length }) : t('autoReview.home.findingsUnknown')
  const reviewed = t('autoReview.home.reviewed', { tree: review.tree.slice(0, 7), time: formatClock(review.endedAt ?? review.startedAt, t.locale) })
  return {
    label: t('autoReview.home.ready'),
    sub: [review.stale ? t('autoReview.home.staleText') : '', findings, model, reviewed].filter(Boolean).join(' · '),
    stale: Boolean(review.stale),
    review
  }
}

/** The row's extra actions: Review again… on a stale or stopped one, Dismiss otherwise. Open stays the row's own button. */
export function AutoReviewRowActions({ review }: { review: AutoReview }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  if (review.state === 'running') return null
  const again = review.stale || review.state !== 'ready'
  return (
    <>
      {again && (
        <LinkButton
          title={t('autoReview.home.againTitle')}
          onClick={(e) => {
            e.stopPropagation()
            reviewAgain(snapshot, review)
          }}
        >
          {t('autoReview.home.again')}
        </LinkButton>
      )}
      <LinkButton
        onClick={(e) => {
          e.stopPropagation()
          void attempt(() => api.dismissAutoReview(review.workspaceId, review.id))
        }}
      >
        {t('autoReview.home.dismiss')}
      </LinkButton>
    </>
  )
}

/** The stale tag beside the workspace name on Home. */
export function AutoReviewStaleTag() {
  const t = useT()
  return <Tag tone="warn" className="ar-stale">
      {t('autoReview.home.stale')}
    </Tag>
}
