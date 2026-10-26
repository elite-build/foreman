// Stop safely (#1): the Quit sheet, the bar while "Quit when turns finish" waits,
// Home's one line for turns a quit or crash stopped, and their review sheet.
// Nothing here retries a turn by itself: Retry shows the message, then sends it on a second click.
import { CircleDot, CirclePause, CircleStop, Cloud, Hourglass, Moon, RotateCcw, SquareTerminal, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { quitWaitEscape, stopSummary, type QuitChecks, type QuitPlan, type QuitTurn, type StopReviewChecks, type StopReviewRow, type StopReviewTurn, type WaitingOn } from '../../../shared/stopSafely'
import { useT, type RendererT } from '../i18n'
import { api, attempt, bridge, openSettingsPage, runChecks, selectSession, selectWorkspace, useStore } from '../store'
import { useLimitLabel } from './cloud/CloudBits'
import { Button, Callout, CardButton, Dialog, IconButton, LinkButton, Spinner, Tag } from '../ui'
import { toolSummary } from './ToolRow'
import { formatDuration } from './turnResult'
import './stopSafely.css'
import './keepRunning.css'

// ---- which sheet is open (local to this feature) ----

interface StopUi {
  quit: boolean
  // "Quit when turns finish" was chosen; the bar shows until it quits or is cancelled.
  draining: boolean
  review: boolean
}

let ui: StopUi = { quit: false, draining: false, review: false }
const listeners = new Set<() => void>()

function setUi(patch: Partial<StopUi>): void {
  ui = { ...ui, ...patch }
  for (const listener of listeners) listener()
}

function useUi(): StopUi {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => ui
  )
}

export function openStopReview(): void {
  setUi({ review: true })
}

/** Mounted once in App: listens for Quit and shows whichever part is open. */
export function StopSafely() {
  const { quit, draining, review } = useUi()
  useEffect(() => bridge.onEvent((event) => event.type === 'quit-requested' && setUi({ quit: true })), [])
  return (
    <>
      {quit && <QuitSheet />}
      {draining && !quit && <QuitBar />}
      {review && <StoppedReview />}
    </>
  )
}

// ---- shared bits ----

/** The current time, moving every second, for elapsed times. */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The Quit sheet's plan from main, fetched again on every state change and every few seconds (run scripts don't change state). */
function useQuitPlan(): QuitPlan | null {
  const snapshot = useStore((s) => s.snapshot)
  const approvals = useStore((s) => s.approvals)
  const [tick, setTick] = useState(0)
  const [plan, setPlan] = useState<QuitPlan | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 3000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let live = true
    void api.quitPlan().then((p) => live && setPlan(p), () => undefined)
    return () => {
      live = false
    }
  }, [snapshot, approvals, tick])
  return plan
}

function useWorkspacePath(): (workspaceId: string) => string {
  const workspaces = useStore((s) => s.snapshot?.workspaces)
  return (id) => workspaces?.find((w) => w.id === id)?.path ?? ''
}

/** "Approve Bash: npm run db:migrate", "Plan ready for review", "Has a question". */
function waitingText(t: RendererT, waiting: WaitingOn, root: string): string {
  if (waiting.kind === 'plan') return t('stop.waiting.plan')
  if (waiting.kind === 'question') return t('stop.waiting.question')
  const label = t('stop.waiting.tool', { tool: waiting.tool ?? '' })
  const detail = waiting.tool ? toolSummary(waiting.tool, waiting.input, root) : ''
  return detail ? `${label}: ${detail}` : label
}

function since(startedAt: string | undefined, now: number): string | null {
  return startedAt ? formatDuration(now - Date.parse(startedAt)) : null
}

function formatWhen(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return new Date(iso).toLocaleString()
  }
}

// ---- Quit ----

function TurnRow({ row, now, root }: { row: QuitTurn; now: number; root: string }) {
  const t = useT()
  const time = since(row.startedAt, now)
  return (
    <div className="stop-row">
      <span className={`stop-row-icon ${row.waiting ? 'waiting' : ''}`}>{row.waiting ? <CirclePause size={14} /> : <Spinner size={14} />}</span>
      <span className="stop-row-ws">{row.workspace}</span>
      <span className="stop-row-text">{row.waiting ? waitingText(t, row.waiting, root) : (row.title ?? t('stop.untitled'))}</span>
      <Tag tone="outline">{row.model}</Tag>
      {time && <span className="stop-row-time">{time}</span>}
    </div>
  )
}

function ChecksRow({ row, now }: { row: QuitChecks; now: number }) {
  const t = useT()
  const time = since(row.startedAt, now)
  const parts = [row.done.length ? t('stop.quit.checksDone', { names: row.done.join(', ') }) : '', row.running.length ? t('stop.quit.checksRunning', { names: row.running.join(', ') }) : '']
  return (
    <div className="stop-row">
      <span className="stop-row-icon"><CircleDot size={14} /></span>
      <span className="stop-row-ws">{row.workspace}</span>
      <span className="stop-row-text">{[t('stop.quit.checks'), ...parts.filter(Boolean)].join(' · ')}</span>
      <Tag tone="outline">{t('stop.quit.checkTag')}</Tag>
      {time && <span className="stop-row-time">{time}</span>}
    </div>
  )
}

function Group({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="stop-group">
      <header className="stop-group-head">
        {icon}
        {title}
        <span className="stop-group-hint">{hint}</span>
      </header>
      {children}
    </section>
  )
}

function QuitSheet() {
  const t = useT()
  const plan = useQuitPlan()
  const now = useNow()
  const root = useWorkspacePath()
  // The shortest session cap among the remote workspaces whose turns go on; none on providers without one.
  const capMs = useStore((s) => {
    const ids = new Set((plan?.cloud ?? []).map((r) => r.workspaceId))
    const caps = (s.snapshot?.workspaces ?? []).flatMap((w) => (ids.has(w.id) && w.cloud?.maxSessionMs ? [w.cloud.maxSessionMs] : []))
    return caps.length ? Math.min(...caps) : undefined
  })
  const limit = useLimitLabel(capMs)
  const close = () => {
    setUi({ quit: false, draining: false })
    void attempt(() => api.cancelQuit())
  }
  if (!plan) return null
  const turns = [...plan.finishing, ...plan.waiting].filter((r) => r.kind === 'turn').length
  const checkRuns = plan.finishing.filter((r) => r.kind === 'checks').length
  const workspaces = new Set([...plan.finishing, ...plan.waiting, ...plan.scripts].map((r) => r.workspaceId)).size
  const finite = plan.finishing.length + plan.waiting.length
  const whenFinished = () => {
    setUi({ quit: false, draining: true })
    void attempt(() => api.quitWhenFinished())
  }
  return (
    <Dialog
      title={t('stop.quit.title')}
      onClose={close}
      size="lg"
      className="stop-modal"
      footer={quitActions(plan, { close, whenFinished })
        .filter((a) => a.style !== 'card')
        .map((a) => (
          <Button key={a.id} className={a.style === 'left' ? 'stop-left' : undefined} variant={a.style === 'danger' || a.style === 'primary' ? a.style : 'default'} autoFocus={a.style === 'primary'} onClick={a.run}>
            {t(a.label)}
          </Button>
        ))}
    >
      <p className="muted stop-lede">
        {t('stop.quit.lede', { count: Math.max(1, workspaces) })}
        {plan.waiting.length > 0 && ` ${t('stop.quit.ledeWaiting', { count: plan.waiting.length })}`}
      </p>
      {plan.finishing.length > 0 && (
        <Group
          icon={<Hourglass size={13} />}
          title={t('stop.quit.finishing')}
          hint={[turns - plan.waiting.length ? t('stop.quit.turns', { count: turns - plan.waiting.length }) : '', checkRuns ? t('stop.quit.checkRuns', { count: checkRuns }) : ''].filter(Boolean).join(' · ')}
        >
          {plan.finishing.map((row) =>
            row.kind === 'turn' ? <TurnRow key={row.sessionId} row={row} now={now} root={root(row.workspaceId)} /> : <ChecksRow key={`checks:${row.workspaceId}`} row={row} now={now} />
          )}
        </Group>
      )}
      {plan.waiting.length > 0 && (
        <Group icon={<CirclePause size={13} />} title={t('stop.quit.waiting')} hint={t('stop.quit.waitingHint')}>
          {plan.waiting.map((row) => (
            <TurnRow key={row.sessionId} row={row} now={now} root={root(row.workspaceId)} />
          ))}
        </Group>
      )}
      {(plan.scripts.length > 0 || plan.terminals.count > 0) && (
        <Group icon={<CircleStop size={13} />} title={t('stop.quit.stopped')} hint={t('stop.quit.stoppedHint')}>
          {plan.scripts.map((row, i) => (
            <div className="stop-row" key={`${row.workspaceId}:${i}`}>
              <span className="stop-row-icon"><SquareTerminal size={14} /></span>
              <span className="stop-row-ws">{row.workspace}</span>
              <span className="stop-row-text">
                {t('stop.quit.runScript')} {row.command && <code>{row.command}</code>}
              </span>
              {since(row.startedAt, now) && <span className="stop-row-time">{since(row.startedAt, now)}</span>}
            </div>
          ))}
          {plan.terminals.count > 0 && (
            <div className="stop-row">
              <span className="stop-row-icon"><SquareTerminal size={14} /></span>
              <span className="stop-row-text">{t('stop.quit.terminals', { count: plan.terminals.count, workspaces: plan.terminals.workspaces.join(', ') })}</span>
            </div>
          )}
        </Group>
      )}
      {/* Cloud turns aren't this computer's to stop: they go on in their sandboxes whichever button is chosen. */}
      {plan.cloud && plan.cloud.length > 0 && (
        <Group icon={<Cloud size={13} />} title={t('cloud.quit.title')} hint={t('cloud.quit.hint')}>
          {plan.cloud.map((row) => (
            <TurnRow key={row.sessionId} row={row} now={now} root="" />
          ))}
        </Group>
      )}
      {quitActions(plan, { close, whenFinished })
        .filter((a) => a.style === 'card')
        .map((a) => (
          <KeepRunningChoice key={a.id} plan={plan} onChoose={a.run} />
        ))}
      {plan.keep && !plan.keep.enabled && plan.keep.notKept.some((n) => n.reason === 'started-before') && <KeepRunningOff />}
      <p className="faint small stop-note">
        {t('stop.quit.note', { count: turns })}
        {plan.waiting.length > 0 && ` ${t('stop.quit.noteWaiting')}`}
        {finite > 0 && ` ${t('stop.quit.noteFreeze')}`}
        {plan.cloud && plan.cloud.length > 0 && ` ${limit ? t('cloud.quit.note', { limit }) : t('cloud.quit.noteNoLimit')}`}
      </p>
    </Dialog>
  )
}

interface QuitAction {
  id: string
  label: 'stop.quit.cancel' | 'stop.quit.now' | 'stop.quit.whenFinished' | 'keepRunning.quit.title'
  // left: pushed to the start of the row; primary: the default (focused) choice; card: its own block above the row (O10).
  style: 'left' | 'danger' | 'primary' | 'card' | ''
  run(): void
}

/**
 * The Quit sheet's buttons, in order. A later choice (keep turns running in the background, O10) slots in here
 * with its own condition; the sheet itself doesn't change.
 */
function quitActions(plan: QuitPlan, handlers: { close(): void; whenFinished(): void }): QuitAction[] {
  const finite = plan.finishing.length + plan.waiting.length > 0
  return [
    { id: 'cancel', label: 'stop.quit.cancel', style: 'left', run: handlers.close },
    { id: 'now', label: 'stop.quit.now', style: 'danger', run: () => void attempt(() => api.quitNow()) },
    ...(finite ? [{ id: 'when-finished', label: 'stop.quit.whenFinished' as const, style: 'primary' as const, run: handlers.whenFinished }] : []),
    // O10: only with turns running in the background host. Not the default: the owner wants it proven first.
    ...(plan.keep?.enabled && plan.keep.turns > 0
      ? [{ id: 'keep-running', label: 'keepRunning.quit.title' as const, style: 'card' as const, run: () => void attempt(() => api.quitKeepRunning()) }]
      : [])
  ]
}

/** O10: "Keep agents running in the background · 3 turns keep going; Foreman reconnects when you open it", and what still stops. */
function KeepRunningChoice({ plan, onChoose }: { plan: QuitPlan; onChoose(): void }) {
  const t = useT()
  const keep = plan.keep!
  const notKept = keep.notKept.map((n) => `${n.workspace} (${n.agent}${n.reason === 'started-before' ? `, ${t('keepRunning.quit.startedBefore')}` : ''})`)
  const limits = [
    keep.waiting.length ? t('keepRunning.quit.limitWaiting', { workspaces: keep.waiting.join(', ') }) : '',
    notKept.length ? t('keepRunning.quit.notKept', { list: notKept.join(', ') }) : '',
    t('keepRunning.quit.limits')
  ].filter(Boolean)
  return (
    <CardButton selected className="keep-choice" onClick={onChoose}>
      <span className="keep-choice-icon"><Moon size={15} aria-hidden /></span>
      <span className="keep-choice-text">
        <span className="keep-choice-title">{t('keepRunning.quit.title')}</span>
        <span className="keep-choice-sub">{t('keepRunning.quit.sub', { count: keep.turns })}</span>
        <span className="keep-choice-limits">{limits.join(' · ')}</span>
      </span>
    </CardButton>
  )
}

/** O10: Keep agents running is off, and Claude Code or Codex turns are running: say where to turn it on. */
function KeepRunningOff() {
  const t = useT()
  return (
    <p className="faint small stop-note">
      {t('keepRunning.quit.off')}{' '}
      <LinkButton size="sm" onClick={() => openSettingsPage({ section: 'advanced', scrollTo: 'keep-agents-running' })}>
        {t('keepRunning.quit.openSettings')}
      </LinkButton>
    </p>
  )
}

/** While "Quit when turns finish" waits: what's left, and Quit now / Cancel. Esc cancels when nothing else wants it. */
function QuitBar() {
  const t = useT()
  const plan = useQuitPlan()
  const cancel = () => {
    setUi({ draining: false })
    void attempt(() => api.cancelQuit())
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target instanceof Element ? e.target : null
      // Esc in another text field, a terminal or a dialog belongs to them. G3: in the composer it cancels, unless the
      // composer used it (it stops that composer's running turn or closes its menu, and marks the key handled).
      const go = quitWaitEscape({
        defaultPrevented: e.defaultPrevented,
        inComposer: Boolean(target?.closest('.composer')),
        inOtherField: Boolean(target?.closest('input, textarea, select, [contenteditable="true"], .xterm')),
        dialogOpen: Boolean(document.querySelector('[role="dialog"]'))
      })
      if (go) cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // Cancelled elsewhere (another window, or main stopped waiting).
  useEffect(() => {
    if (plan && !plan.draining) setUi({ draining: false })
  }, [plan])
  if (!plan) return null
  const left = plan.finishing.length
  return (
    <div className="stop-bar" role="status">
      <Spinner size={14} />
      <span className="stop-bar-text">
        <strong>{t('stop.bar.title')}</strong>
        {left > 0 && ` · ${t('stop.bar.left', { count: left })}`}
        {plan.waiting.length > 0 && ` · ${t('stop.bar.waiting', { count: plan.waiting.length })} (${plan.waiting.map((w) => w.workspace).join(', ')})`}
        {` · ${t('stop.bar.hint')}`}
      </span>
      <Button size="sm" variant="danger" onClick={() => void attempt(() => api.quitNow())}>
        {t('stop.quit.now')}
      </Button>
      <Button size="sm" onClick={cancel}>
        {t('stop.quit.cancel')}
      </Button>
    </div>
  )
}

// ---- after a restart ----

const HOME_LINE = { quit: 'stop.home.quit', crash: 'stop.home.crash', mixed: 'stop.home.mixed' } as const
const REVIEW_TITLE = { quit: 'stop.review.title.quit', crash: 'stop.review.title.crash', mixed: 'stop.review.title.mixed' } as const

/** Home: "4 turns stopped when Foreman quit · Review and retry…", one line until each is retried or dismissed. */
export function StoppedLine() {
  const t = useT()
  const record = useStore((s) => s.snapshot?.stopRecord)
  const summary = stopSummary(record)
  if (!summary) return null
  const text = summary.turns ? t(HOME_LINE[summary.cause], { count: summary.turns }) : t('stop.home.checksOnly', { count: summary.checks })
  return (
    <Callout
      tone="warn"
      role="status"
      actions={
        <Button onClick={openStopReview}>
          {t('stop.home.review')}
        </Button>
      }
    >
      <strong>{text}</strong> · {formatWhen(summary.at, t.locale)} · {t('stop.home.nothingRetried')}
    </Callout>
  )
}

function ChangesFact({ row }: { row: StopReviewTurn }) {
  const t = useT()
  if (!row.delta) return <>{t('stop.review.changesUnknown')}</>
  if (!row.delta.files.length) return <>{t('stop.review.noChanges')}</>
  return (
    <>
      {t.rich('stop.review.changed', {
        delta: (
          <span key="d">
            <span className="add">+{row.delta.additions}</span> <span className="del">−{row.delta.deletions}</span>
          </span>
        ),
        files: t('stop.review.files', { count: row.delta.files.length })
      })}
    </>
  )
}

function ReviewTurnRow({ row, root, confirming, onConfirm, onClose }: { row: StopReviewTurn; root: string; confirming: boolean; onConfirm: (on: boolean) => void; onClose: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const tab = row.title ?? t('stop.untitled')
  const facts: ReactNode[] = []
  if (row.durationMs !== undefined) facts.push(t('stop.review.ran', { duration: formatDuration(row.durationMs) }))
  if (row.lastStep) facts.push(t('stop.review.lastStep', { step: `${row.lastStep.name} ${toolSummary(row.lastStep.name, row.lastStep.input, root)}`.trim() }))
  if (!row.waiting) facts.push(<ChangesFact key="c" row={row} />)
  if (row.closed) facts.push(t('stop.review.closed'))
  const open = () => {
    selectWorkspace(row.workspaceId)
    selectSession(row.workspaceId, row.sessionId)
    onClose()
  }
  const send = async () => {
    setBusy(true)
    const sent = await attempt(async () => (await api.retryStopped(row.key), true))
    setBusy(false)
    if (sent) onConfirm(false)
  }
  return (
    <div className="stop-review-row">
      <div className="stop-review-main">
        <div className="stop-review-head">
          <strong>{row.workspace}</strong>
          <span>{tab}</span>
          <Tag tone="outline">{row.model}</Tag>
        </div>
        {row.message !== undefined && <div className="stop-review-msg">“{row.message}”</div>}
        <div className="stop-review-facts">
          {row.waiting && (
            <>
              <span className="waiting">{t('stop.review.waitingFor', { what: waitingText(t, row.waiting, root) })}</span>
              {' · '}
              {t('stop.review.retryAsks')}
              {facts.length > 0 && ' · '}
            </>
          )}
          {facts.map((f, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {f}
            </span>
          ))}
        </div>
        {confirming && row.message !== undefined && (
          <div className="stop-confirm">
            <p>{t('stop.review.confirm', { tab })}</p>
            <pre className="stop-confirm-msg">{row.message}</pre>
            {row.attachments > 0 && <p className="faint">{t('stop.review.attachments', { count: row.attachments })}</p>}
            <div className="notice-actions">
              <Button size="sm" onClick={() => onConfirm(false)}>
                {t('stop.review.back')}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void send()}>
                {t('stop.review.send')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="stop-review-actions">
        <LinkButton onClick={open}>
          {t('stop.review.open')}
        </LinkButton>
        <Button size="sm" icon={<RotateCcw size={12} />} disabled={row.message === undefined || confirming} onClick={() => onConfirm(true)}>
          {t('stop.review.retry')}
        </Button>
        <IconButton label={t('stop.review.dismiss')} onClick={() => void attempt(() => api.dismissStopped(row.key))}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  )
}

function ReviewChecksRow({ row }: { row: StopReviewChecks }) {
  const t = useT()
  const results = row.results.map((r) => t(`stop.review.checkStatus.${r.status}`, { name: r.name }))
  return (
    <div className="stop-review-row">
      <div className="stop-review-main">
        <div className="stop-review-head">
          <CircleDot size={13} className="faint" />
          <strong>{row.workspace}</strong>
          <span>{t('stop.review.checks')}</span>
          <Tag tone="outline">{t('stop.quit.checkTag')}</Tag>
        </div>
        <div className="stop-review-facts">{results.length ? results.join(' · ') : t('stop.review.checksNone')}</div>
      </div>
      <div className="stop-review-actions">
        <Button
          size="sm"
          onClick={() => {
            void runChecks(row.workspaceId)
            void attempt(() => api.dismissStopped(row.key))
          }}
        >
          {t('stop.review.runChecks')}
        </Button>
        <IconButton label={t('stop.review.dismiss')} onClick={() => void attempt(() => api.dismissStopped(row.key))}>
          <X size={13} />
        </IconButton>
      </div>
    </div>
  )
}

/** One row per stopped tab: its message, last step and partial changes, with Open and Retry. Nothing replays by itself. */
function StoppedReview() {
  const t = useT()
  const record = useStore((s) => s.snapshot?.stopRecord)
  const root = useWorkspacePath()
  const [rows, setRows] = useState<StopReviewRow[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void api.stopReview().then((r) => live && setRows(r), () => live && setRows([]))
    return () => {
      live = false
    }
  }, [record])
  const close = () => setUi({ review: false })
  const summary = stopSummary(record)
  const cause = summary?.cause ?? 'quit'
  const when = summary ? formatWhen(summary.at, t.locale) : ''
  return (
    <Dialog
      title={t(REVIEW_TITLE[cause])}
      onClose={close}
      size="lg"
      className="stop-modal"
      footer={
        <>
          {rows && rows.length > 0 && (
            <Button
              className="stop-left"
              onClick={() => {
                void attempt(() => api.dismissStopped())
                close()
              }}
            >
              {t('stop.review.dismissAll')}
            </Button>
          )}
          <Button onClick={close}>{t('stop.review.close')}</Button>
        </>
      }
    >
      <p className="muted stop-lede">{cause === 'mixed' ? t('stop.review.lede.mixed') : t(cause === 'quit' ? 'stop.review.lede.quit' : 'stop.review.lede.crash', { when })}</p>
      {rows && rows.length > 0 ? (
        <div className="stop-review-list">
          {rows.map((row) =>
            row.kind === 'turn' ? (
              <ReviewTurnRow
                key={row.key}
                row={row}
                root={root(row.workspaceId)}
                confirming={confirming === row.key}
                onConfirm={(on) => setConfirming(on ? row.key : null)}
                onClose={close}
              />
            ) : (
              <ReviewChecksRow key={row.key} row={row} />
            )
          )}
        </div>
      ) : (
        rows && <p className="faint">{t('stop.review.empty')}</p>
      )}
    </Dialog>
  )
}
