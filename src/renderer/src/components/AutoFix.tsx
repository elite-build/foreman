// #5 Auto-fix CI in the renderer: the opt-in under the PR watch toggles, its
// consent dialog (target tab, the exact prompt, the budget, when it runs and when
// it stops), the line appended to the CI-failed reason, and the receipt on the
// message Foreman sent. Nothing here sends anything; main decides, and checks
// the consent again before every send.
import { Bot } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { AGENTS } from '../../../shared/agents'
import { autoFixLine, type AutoFixLine } from '../../../shared/autoFix'
import { openCiFailure } from '../../../shared/prWatch'
import type { AppSnapshot, AutoFixPreview, AutoFixStop, MessageOrigin, Workspace } from '../../../shared/types'
import { activeSessionId, api, attempt, openSessions, useStore } from '../store'
import { useT, type RendererT } from '../i18n'
import { formatClock } from '../../../shared/i18n/time'
import { Button, Checkbox, Dialog, Field, LinkButton, Select, Tag } from '../ui'
import './autoFix.css'

/** "Tab 2", by the tab's place among the workspace's open tabs. */
function tabName(t: RendererT, snapshot: AppSnapshot, workspaceId: string, sessionId: string): string {
  const n = openSessions(snapshot, workspaceId).findIndex((s) => s.id === sessionId)
  return t('autoFix.tabName', { n: n < 0 ? '?' : n + 1 })
}

export function stopText(t: RendererT, reason: AutoFixStop, minutes: number): string {
  switch (reason) {
    case 'failed':
      return t('autoFix.stop.failed')
    case 'stopped':
      return t('autoFix.stop.stopped')
    case 'timeout':
      return t('autoFix.stop.timeout', { minutes })
    case 'no-commit':
      return t('autoFix.stop.noCommit')
    case 'budget':
      return t('autoFix.stop.budget')
    case 'consent':
      return t('autoFix.stop.consent')
    case 'send-failed':
      return t('autoFix.stop.sendFailed')
  }
}

/** "Foreman sent a fix at 14:02 · 1 of 2 · Stopped: no new commit": never "fixed". */
export function autoFixText(t: RendererT, line: AutoFixLine, minutes: number): string {
  return [line.sent ? t('autoFix.line.sent', { time: formatClock(line.sent.at, t.locale), n: line.sent.n, of: line.sent.of }) : '', line.stopped ? stopText(t, line.stopped, minutes) : '']
    .filter(Boolean)
    .join(' · ')
}

/** The line for a workspace's open CI failure (Home's CI-failed reason), or null. */
export function useAutoFixText(ws: Workspace): string | null {
  const t = useT()
  const line = autoFixLine(ws.autoFix, openCiFailure(ws.prWatch?.ci))
  return line && ws.autoFix ? autoFixText(t, line, ws.autoFix.consent.maxMinutes) : null
}

/** The Git panel's line under the Checks header: what was sent, the tab, and whether it's still running. */
export function AutoFixStatus({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const ws = snapshot.workspaces.find((w) => w.id === workspaceId)
  const line = ws && autoFixLine(ws.autoFix, ws.prWatch?.ci?.failure)
  if (!ws?.autoFix || !line) return null
  return (
    <div className={`autofix-line ${line.stopped ? 'stopped' : ''}`}>
      <Bot size={12} />
      <span>{autoFixText(t, line, ws.autoFix.consent.maxMinutes)}</span>
      {line.sent?.running && <span className="faint">{t('autoFix.line.running', { tab: tabName(t, snapshot, workspaceId, line.sent.sessionId) })}</span>}
    </div>
  )
}

/** The opt-in under "Notify me when CI fails". Turning it on opens the consent dialog; nothing is on until that is approved. */
export function AutoFixToggle({ workspaceId, gitlab }: { workspaceId: string; gitlab?: boolean }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const ws = snapshot.workspaces.find((w) => w.id === workspaceId)
  const [asking, setAsking] = useState(false)
  if (!ws) return null
  const autoFix = ws.autoFix
  const on = Boolean(autoFix && !autoFix.stopped)
  const used = autoFix ? autoFix.attempts.length : 0
  return (
    <>
      <div className="autofix-toggle">
        <Checkbox className="review-select" checked={on} onChange={(e) => (e.target.checked ? setAsking(true) : void attempt(() => api.setAutoFix(workspaceId, null)))}>
          {t('autoFix.toggle')}
        </Checkbox>
        {autoFix && on && (
          <span className="faint small">
            {' · '}
            {t('autoFix.toggle.summary', { tab: tabName(t, snapshot, workspaceId, autoFix.consent.sessionId), used, of: autoFix.consent.perPr, pr: gitlab ? 'MR' : 'PR' })}{' '}
            <LinkButton size="sm" onClick={() => setAsking(true)}>
              {t('autoFix.toggle.edit')}
            </LinkButton>
          </span>
        )}
      </div>
      {autoFix?.stopped && (
        <div className="autofix-stopped faint small" title={autoFix.stopped.detail}>
          {stopText(t, autoFix.stopped.reason, autoFix.consent.maxMinutes)}. {t('autoFix.stop.again')}
        </div>
      )}
      {asking && <AutoFixDialog workspaceId={workspaceId} onClose={() => setAsking(false)} />}
    </>
  )
}

/** The consent: exactly what will be sent, where, how often and when it stops. Main refuses it if any of it changed meanwhile. */
export function AutoFixDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const ws = snapshot.workspaces.find((w) => w.id === workspaceId)
  const tabs = openSessions(snapshot, workspaceId)
  const active = useStore((s) => activeSessionId(s, workspaceId))
  const [target, setTarget] = useState<string | undefined>(ws?.autoFix?.consent.sessionId ?? active ?? tabs[0]?.id)
  const [preview, setPreview] = useState<AutoFixPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()
  useEffect(() => {
    setPreview(null)
    if (!target) return
    let live = true
    void api.autoFixPreview(workspaceId, target).then(
      (p) => live && setPreview(p),
      () => live && setPreview(null)
    )
    return () => {
      live = false
    }
  }, [workspaceId, target])
  if (!ws) return null
  const approve = async () => {
    if (!preview) return
    setBusy(true)
    const done = await attempt(() => api.setAutoFix(workspaceId, { sessionId: preview.sessionId, agent: preview.agent, permissions: preview.permissions, prompt: preview.prompt }).then(() => true))
    setBusy(false)
    if (done) onClose()
  }
  return (
    <Dialog
      title={t('autoFix.dialog.title', { workspace: ws.name })}
      onClose={onClose}
      size="lg"
      className="dlg"
      footer={
        <>
          {!ws.prWatch?.ci && <span className="faint small dlg-start">{t('autoFix.dialog.alsoWatch')}</span>}
          <Button onClick={onClose}>{t('autoFix.dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || !preview} onClick={() => void approve()}>
            {t('autoFix.dialog.confirm')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('autoFix.dialog.intro', { pr: preview?.pr ?? t('autoFix.dialog.thePr') })}</p>
      {tabs.length === 0 ? (
        <p className="muted">{t('autoFix.dialog.noTabs')}</p>
      ) : (
        <Field label={t('autoFix.dialog.sendTo')}>
          {(c) => (
            <Select
              {...c}
              value={target ?? ''}
              onChange={setTarget}
              options={tabs.map((s, n) => ({ value: s.id, label: t('autoFix.dialog.tab', { n: n + 1, title: s.title || '—', agent: AGENTS[s.agent]?.label ?? s.agent }) }))}
            />
          )}
        </Field>
      )}
      {target && !preview && <p className="faint small">{t('autoFix.dialog.loading')}</p>}
      {preview && (
        <>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-prompt`}>
            <div id={`${id}-prompt`} className="dlg-label">
              {t('autoFix.dialog.prompt')}
            </div>
            <pre className="consent-diff mono autofix-prompt">{preview.prompt}</pre>
            <div className="dlg-hint">{t('autoFix.dialog.promptFrom')}</div>
          </div>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-budget`}>
            <div id={`${id}-budget`} className="dlg-label">
              {t('autoFix.dialog.budget')}
            </div>
            <div className="autofix-budget">
              <Tag tone="outline">{t('autoFix.dialog.perHead', { count: preview.perHead })}</Tag>
              <Tag tone="outline">{t('autoFix.dialog.perPr', { count: preview.perPr })}</Tag>
              <Tag tone="outline">{t('autoFix.dialog.maxMinutes', { count: preview.maxMinutes })}</Tag>
            </div>
          </div>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-when`}>
            <div id={`${id}-when`} className="dlg-label">
              {t('autoFix.dialog.onlyWhen')}
            </div>
            <ul className="consent-list">
              <li>{t('autoFix.dialog.idle')}</li>
              <li>{t('autoFix.dialog.untried')}</li>
            </ul>
          </div>
          <div className="dlg-group" role="group" aria-labelledby={`${id}-stops`}>
            <div id={`${id}-stops`} className="dlg-label">
              {t('autoFix.dialog.stops')}
            </div>
            <ul className="consent-list">
              <li>{t('autoFix.dialog.stopFailed', { minutes: preview.maxMinutes })}</li>
              <li>{t('autoFix.dialog.stopNoCommit')}</li>
              <li>{t('autoFix.dialog.stopBudget')}</li>
            </ul>
          </div>
          <p className="dlg-hint">{t('autoFix.dialog.permissions', { agent: AGENTS[preview.agent]?.label ?? preview.agent, note: preview.permissions })}</p>
          <p className="dlg-hint">{t('autoFix.dialog.never')}</p>
        </>
      )}
    </Dialog>
  )
}

/** Under a message Foreman sent itself: who sent it and why. */
export function AutoFixReceipt({ origin }: { origin: MessageOrigin }) {
  const t = useT()
  const checks = origin.checks.length > 2 ? `${origin.checks.slice(0, 2).join(', ')} +${origin.checks.length - 2}` : origin.checks.join(', ')
  return (
    <div className="autofix-receipt faint small">
      <Tag>{t('autoFix.receipt.badge', { n: origin.n, of: origin.of })}</Tag>
      <span>{t('autoFix.receipt.why', { sha: origin.sha.slice(0, 7), checks })}</span>
    </div>
  )
}
