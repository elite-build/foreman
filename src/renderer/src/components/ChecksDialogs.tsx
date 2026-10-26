// Dialogs for checks: approving a new or changed command before its first run,
// and "Fix in chat…" (pick the tab, confirm what is attached).
import { useState } from 'react'
import { isFailure } from '../../../shared/checks'
import type { CheckConsentItem } from '../../../shared/types'
import { activeSessionId, api, attempt, closeChecksConsent, openFixChecks, openFixCi, openResolveBase, openSessions, runChecks, selectSession, useStore } from '../store'
import { useT } from '../i18n'
import { Button, Dialog, Field, Select } from '../ui'

/** Lines of the new command, marked when they are not in the previous one, and the removed ones. */
export function commandDiff(previous: string | undefined, next: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const newLines = next.split('\n')
  if (previous === undefined) return newLines.map((text) => ({ kind: 'add' as const, text }))
  const oldLines = previous.split('\n')
  return [
    ...oldLines.filter((l) => !newLines.includes(l)).map((text) => ({ kind: 'del' as const, text })),
    ...newLines.map((text) => ({ kind: oldLines.includes(text) ? ('same' as const) : ('add' as const), text }))
  ]
}

// Also the approval for a repo's saved command (O9), which shares these approvals.
export function ConsentRow({ item }: { item: CheckConsentItem }) {
  const t = useT()
  return (
    <div className="consent-item">
      <div className="consent-head">
        <strong>{item.name}</strong>
        <span className="faint small">
          {item.previous !== undefined ? t('checksDialogs.consent.changed') : t('checksDialogs.consent.new')}
          {' · '}
          {item.source === 'shared' ? t('checksDialogs.consent.fromRepo') : t('checksDialogs.consent.fromComputer')}
        </span>
      </div>
      <pre className="consent-diff mono">
        {commandDiff(item.previous, item.command).map((line, n) => (
          <div key={n} className={`diff-${line.kind}`}>
            {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

export function ChecksConsentDialog({ workspaceId, items }: { workspaceId: string; items: CheckConsentItem[] }) {
  const [busy, setBusy] = useState(false)
  const t = useT()
  const run = async () => {
    setBusy(true)
    await runChecks(workspaceId, true)
    setBusy(false)
  }
  return (
    <Dialog
      title={t('checksDialogs.consent.title')}
      onClose={closeChecksConsent}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={closeChecksConsent}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? t('checksDialogs.starting') : t('gitPanel.check.run')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('checksDialogs.consent.body', { count: items.length })}</p>
      {items.map((item) => (
        <ConsentRow key={item.name} item={item} />
      ))}
    </Dialog>
  )
}

/** The tab the checks' output goes to: the open chats, and (when allowed) a new one. */
function TabSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  const t = useT()
  return <Field label={t('checksDialogs.sendTo')}>{(control) => <Select {...control} className="dlg-fill" value={value} onChange={onChange} options={options} />}</Field>
}

export function FixChecksDialog({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const snapshot = useStore((s) => s.snapshot!)
  const sessions = openSessions(snapshot, workspaceId)
  const initial = useStore((s) => activeSessionId(s, workspaceId))
  const [sessionId, setSessionId] = useState(initial ?? sessions[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const t = useT()
  const failing = (ws?.checks?.results ?? []).filter(isFailure)
  const close = () => openFixChecks(null)
  if (!ws) return null
  const send = async () => {
    setBusy(true)
    const sent = await attempt(async () => (await api.fixChecks(workspaceId, sessionId || undefined), true))
    setBusy(false)
    if (!sent) return
    if (sessionId) selectSession(workspaceId, sessionId)
    close()
  }
  const options = sessions.map((s, n) => ({ value: s.id, label: `${s.title || t('checksDialogs.chatN', { n: n + 1 })} · ${s.agent}` }))
  if (sessions.length === 0) options.push({ value: '', label: t('diffSel.newChat') })
  return (
    <Dialog
      title={t('checksDialogs.fix.title')}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || failing.length === 0} onClick={() => void send()}>
            {busy ? t('checksDialogs.sending') : t('checksDialogs.attachAndSend')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('checksDialogs.fix.body', { count: failing.length })}</p>
      <ul className="consent-list">
        {failing.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong> <code className="mono">{c.command.split('\n')[0]}</code>
            {c.exitCode !== undefined && <span className="faint small"> · {t('gitPanel.check.exit', { code: c.exitCode })}</span>}
          </li>
        ))}
      </ul>
      <TabSelect value={sessionId} onChange={setSessionId} options={options} />
    </Dialog>
  )
}

/** "Fix CI in…": the failing CI logs go to the last active tab, another tab, or a new one. Nothing is sent until the user confirms. */
export function FixCiDialog({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const snapshot = useStore((s) => s.snapshot!)
  const sessions = openSessions(snapshot, workspaceId)
  const active = useStore((s) => activeSessionId(s, workspaceId))
  const [target, setTarget] = useState<string>(active ?? sessions[0]?.id ?? 'new')
  const [busy, setBusy] = useState(false)
  const t = useT()
  const failure = ws?.prWatch?.ci?.failure
  const close = () => openFixCi(null)
  if (!ws) return null
  const send = async () => {
    setBusy(true)
    const used = await attempt(() => api.fixCi(workspaceId, target))
    setBusy(false)
    if (!used) return
    selectSession(workspaceId, used)
    close()
  }
  return (
    <Dialog
      title={t('checksDialogs.ci.title')}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {busy ? t('checksDialogs.sending') : t('checksDialogs.attachAndSend')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('checksDialogs.ci.body')}</p>
      {failure && (
        <ul className="consent-list">
          {failure.checks.map((name) => (
            <li key={name}>
              <strong>{name}</strong>
            </li>
          ))}
        </ul>
      )}
      <TabSelect value={target} onChange={setTarget} options={tabOptions(sessions, active, t)} />
    </Dialog>
  )
}

/** The chats that can take the work (the last active one marked), then "a new tab". */
function tabOptions(sessions: ReturnType<typeof openSessions>, active: string | undefined, t: ReturnType<typeof useT>): { value: string; label: string }[] {
  return [
    ...sessions.map((s, n) => ({
      value: s.id,
      label: `${s.id === active ? t('checksDialogs.lastActive', { tab: s.title || t('checksDialogs.chatN', { n: n + 1 }) }) : s.title || t('checksDialogs.chatN', { n: n + 1 })} · ${s.agent}`
    })),
    { value: 'new', label: t('checksDialogs.newTab') }
  ]
}

/** "Resolve in chat…" for a moved base: picks a tab, then asks it to merge the base in. Nothing is sent until the user confirms. */
export function ResolveBaseDialog({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const snapshot = useStore((s) => s.snapshot!)
  const sessions = openSessions(snapshot, workspaceId)
  const active = useStore((s) => activeSessionId(s, workspaceId))
  const [target, setTarget] = useState<string>(active ?? sessions[0]?.id ?? 'new')
  const [busy, setBusy] = useState(false)
  const t = useT()
  const close = () => openResolveBase(null)
  if (!ws) return null
  const watch = ws.baseWatch
  const send = async () => {
    setBusy(true)
    const used = await attempt(() => api.resolveBaseMoved(workspaceId, target))
    setBusy(false)
    if (!used) return
    selectSession(workspaceId, used)
    close()
  }
  return (
    <Dialog
      title={t('checksDialogs.resolve.title')}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {busy ? t('checksDialogs.sending') : t('checksDialogs.sendToChat')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('checksDialogs.resolve.body', { base: ws.baseBranch })}</p>
      {watch?.conflicts.length ? (
        <ul className="consent-list">
          {watch.conflicts.map((file) => (
            <li key={file}>
              <strong>{file}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {watch?.untested && <p className="faint">{t('checksDialogs.resolve.untested')}</p>}
      <TabSelect value={target} onChange={setTarget} options={tabOptions(sessions, active, t)} />
    </Dialog>
  )
}
