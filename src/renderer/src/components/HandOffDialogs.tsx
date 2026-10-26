// Hand off to another Mac (P-4): pairing, the hand-off dialog with its progress list, the
// Reconcile dialog, and Home's "Hand-off pending" rows.
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { HAND_OFF_WARNING, pendingText, pendingTransfers, sourceSteps, transferHeadline, type Transfer } from '../../../shared/transfer'
import { useT } from '../i18n'
import { api, attempt, openHandOffTo, openPairDialog, openReconcile, selectWorkspace, timeWaited, useStore } from '../store'
import { Button, Callout, Dialog, CardButton, Field, LinkButton, Select, Spinner, Tag, TextInput } from '../ui'

/** Settings → Data & devices → Pair a Mac. One Mac shows a code, the other types it. */
export function PairDialog({ kind }: { kind: 'show' | 'enter' }) {
  const close = () => {
    if (kind === 'show') void api.cancelPairingCode().catch(() => undefined)
    openPairDialog(null)
  }
  return kind === 'show' ? <ShowCode onClose={close} /> : <EnterCode onClose={close} />
}

function ShowCode({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.devicesInfo>> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.showPairingCode().then((i) => live && setInfo(i), (e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [])
  // The code goes away once it is used; then the new Mac shows in the list behind.
  useEffect(() => {
    if (!info) return
    const timer = setInterval(() => {
      void api.devicesInfo().then((next) => {
        if (!next.pairing || next.paired.length > info.paired.length) {
          clearInterval(timer)
          onClose()
        } else setInfo(next)
      })
    }, 1500)
    return () => clearInterval(timer)
  }, [info?.pairing?.code]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog title={t('pairDialog.show.title')} onClose={onClose} className="dlg pair-modal" footer={<Button onClick={onClose}>{t('common.cancel')}</Button>}>
      {error ? (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      ) : !info?.pairing ? (
        <p className="muted">{t('pairDialog.starting')}</p>
      ) : (
        <>
          <p className="small muted">{t.rich('pairDialog.show.how', { enterCode: <b>{t('pairDialog.enter.title')}</b> })}</p>
          <div className="pair-code" role="group" aria-label={t('pairDialog.show.code')}>
            {info.pairing.code.slice(0, 3)} {info.pairing.code.slice(3)}
          </div>
          <p className="small muted">
            {t.rich('pairDialog.show.address', { address: <code>{info.addresses.length ? info.addresses.map((a) => `${a}:${info.port}`).join(t('pairDialog.show.or')) : t('pairDialog.show.port', { port: info.port })}</code> })}
          </p>
          <p className="small faint">{t('pairDialog.show.direct')}</p>
        </>
      )}
    </Dialog>
  )
}

function EnterCode({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = /^(.+?)(?::(\d{2,5}))?$/.exec(address.trim())
  const ready = Boolean(parsed) && /^\d{6}$/.test(code.replace(/\s/g, '')) && !busy
  const go = async () => {
    if (!parsed) return
    setBusy(true)
    const done = await attempt(() => api.pairWith(parsed[1], parsed[2] ? Number(parsed[2]) : 47631, code.replace(/\s/g, '')))
    setBusy(false)
    if (done) onClose()
  }
  return (
    <Dialog
      title={t('pairDialog.enter.title')}
      onClose={onClose}
      className="dlg pair-modal"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void go()}>
            {busy ? t('pairDialog.enter.pairing') : t('pairDialog.enter.pair')}
          </Button>
        </>
      }
    >
      <p className="small muted">{t.rich('pairDialog.enter.how', { showCode: <b>{t('pairDialog.enter.showCode')}</b> })}</p>
      <Field label={t('pairDialog.enter.address')}>
        {(control) => <TextInput {...control} className="dlg-fill" autoFocus placeholder="192.168.1.20:47631" value={address} onChange={(e) => setAddress(e.target.value)} />}
      </Field>
      <Field label={t('pairDialog.enter.code')}>
        {(control) => (
          <TextInput
            {...control}
            className="dlg-fill"
            inputMode="numeric"
            placeholder="000 000"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && void go()}
          />
        )}
      </Field>
    </Dialog>
  )
}

function StepList({ transfer }: { transfer: Transfer }) {
  const t = useT()
  return (
    <div className="steps-v">
      {sourceSteps(transfer, t).map((s) => (
        <div key={s.label} className={`s ${s.status}`}>
          <span className="ic">{s.status === 'done' ? <Check size={12} /> : s.status === 'current' ? <Spinner size={12} /> : s.status === 'failed' ? <X size={12} /> : null}</span>
          <span>{s.label}</span>
          {s.detail && <span className="faint small">{s.detail}</span>}
        </div>
      ))}
    </div>
  )
}

/** Workspace → Hand off to…: choose a Mac, then watch the six steps. */
export function HandOffToDialog({ workspaceId, transferId: initial }: { workspaceId: string; transferId?: string }) {
  const t = useT()
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const transfers = useStore((s) => s.snapshot!.transfers)
  const [deviceId, setDeviceId] = useState('')
  const [transferId, setTransferId] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<{ id: string; name: string }[]>([])
  const close = () => openHandOffTo(null)
  const transfer = transfers.find((x) => x.id === transferId)
  useEffect(() => {
    void api.devicesInfo().then((i) => setList(i.paired.map((d) => ({ id: d.id, name: d.name }))))
  }, [])
  if (!ws) return null
  const chosen = deviceId || list[0]?.id || ''

  const start = async () => {
    setBusy(true)
    const id = await attempt(() => api.startHandOffTo(workspaceId, chosen))
    setBusy(false)
    if (id) setTransferId(id)
  }
  const cancellable = transfer && ['validating', 'frozen', 'exporting'].includes(transfer.state) && transfer.live
  return (
    <Dialog
      title={t('handOffTo.title', { name: ws.name })}
      onClose={close}
      size="lg"
      className="dlg"
      footer={
        <>
          {cancellable && <Button onClick={() => void attempt(() => api.cancelHandOff(transfer.id))}>{t('handOffTo.cancelHandOff')}</Button>}
          {transfer?.state === 'awaiting-ack' && <Button onClick={() => (close(), openReconcile(transfer.id))}>{t('handOffTo.reconcile')}</Button>}
          {!transfer ? (
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!chosen || busy} onClick={() => void start()}>
                {busy ? t('pairDialog.starting') : t('handOffTo.handOff')}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          )}
        </>
      }
    >
      {!transfer ? (
        <>
          <Field label={t('handOffTo.to')}>
            {(control) => <Select {...control} className="dlg-fill" value={chosen} onChange={setDeviceId} options={list.map((d) => ({ value: d.id, label: t('handOffTo.paired', { name: d.name }) }))} />}
          </Field>
          {!list.length && <p className="small muted">{t('handOffTo.noPaired')}</p>}
          <Callout>
            <div>{t.rich('handOffTo.how', { frozen: <b>{t('handOffTo.how.frozen')}</b>, inactive: <b>{t('handOffTo.how.inactive')}</b> })}</div>
            <div>{t.rich('handOffTo.lostAck', { bothFrozen: <b>{t('handOffTo.bothFrozen')}</b>, reconcile: <b>{t('handOffTo.reconcile')}</b> })}</div>
            <div>{t(HAND_OFF_WARNING)}</div>
          </Callout>
        </>
      ) : (
        <>
          <StepList transfer={transfer} />
          <p className={`small ${transfer.state === 'cancelled' || transfer.state === 'diverged' ? 'error-text' : 'muted'}`}>{transferHeadline(transfer, t)}</p>
          {transfer.state === 'awaiting-ack' && !transfer.live && <p className="small muted">{transfer.error}</p>}
          <Callout>
            <div>{t.rich('handOffTo.lostAckShort', { bothFrozen: <b>{t('handOffTo.bothFrozen')}</b>, reconcile: <b>{t('handOffTo.reconcile')}</b> })}</div>
            <div>{t(HAND_OFF_WARNING)}</div>
          </Callout>
        </>
      )}
    </Dialog>
  )
}

/** Which Mac keeps the workspace, when the acknowledgement was lost. */
export function ReconcileDialog({ transferId }: { transferId: string }) {
  const t = useT()
  const transfer = useStore((s) => s.snapshot!.transfers.find((x) => x.id === transferId))
  const [busy, setBusy] = useState(false)
  const close = () => openReconcile(null)
  if (!transfer) return null
  const source = transfer.role === 'source'
  const names = { workspace: transfer.workspaceName, peer: transfer.peerName }
  const choose = async (choice: 'keep-here' | 'other-keeps') => {
    setBusy(true)
    const done = await attempt(async () => (await api.reconcileHandOff(transfer.id, choice), true))
    setBusy(false)
    if (done) close()
  }
  return (
    <Dialog title={t('reconcile.title', { name: transfer.workspaceName })} onClose={close} size="lg" className="dlg" footer={<Button onClick={close}>{t('reconcile.notNow')}</Button>}>
      <p className="muted small">{source ? t('reconcile.lede.source', names) : t('reconcile.lede.destination', names)}</p>
      {transfer.error && <p className="small faint">{transfer.error}</p>}
      <div className="reconcile-options">
        <CardButton size="sm" className="reconcile-option" disabled={busy} onClick={() => void choose('keep-here')}>
          <b>{source ? t('reconcile.takeBack') : t('reconcile.keepHere')}</b>
          <span className="small muted">{source ? t('reconcile.takeBack.hint', names) : t('reconcile.keepHere.hint', names)}</span>
        </CardButton>
        <CardButton size="sm" className="reconcile-option" disabled={busy} onClick={() => void choose('other-keeps')}>
          <b>{t('reconcile.otherKeeps', names)}</b>
          <span className="small muted">{source ? t('reconcile.otherKeeps.hintSource', names) : t('reconcile.otherKeeps.hintDestination', names)}</span>
        </CardButton>
      </div>
      <Callout>
        <div>{t(HAND_OFF_WARNING)}</div>
      </Callout>
    </Dialog>
  )
}

/** Home: hand-offs nobody has settled. */
export function PendingHandOffs({ repoId }: { repoId?: string }) {
  const t = useT()
  const transfers = useStore((s) => s.snapshot!.transfers)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const rows = pendingTransfers(transfers).filter((x) => !repoId || workspaces.find((w) => w.id === x.workspaceId)?.repoId === repoId)
  if (!rows.length) return null
  return (
    <section className="home-card">
      <header className="home-card-head">
        <span className="home-card-title">{t('pendingHandOffs.title')}</span>
        <span className="home-card-hint">{t('pendingHandOffs.hint')}</span>
      </header>
      {rows.map((row) => (
        <div key={row.id} className="home-row">
          <Tag tone="error" className="card-row-tag">
            {t('pendingHandOffs.pill')}
          </Tag>
          <div className="home-row-main">
            <div className="home-row-title">
              <span className="home-row-name">{row.workspaceName}</span>
              <span className="home-row-branch">{row.role === 'source' ? `→ ${row.peerName}` : `← ${row.peerName}`}</span>
            </div>
            <div className="home-row-sub">{pendingText(row, t)}</div>
          </div>
          <span className="home-row-age">{timeWaited(row.updatedAt)}</span>
          <div className="home-row-actions">
            <Button size="sm" onClick={() => openReconcile(row.id)}>
              {t('handOffTo.reconcile')}
            </Button>
            {workspaces.some((w) => w.id === row.workspaceId) && (
              <LinkButton size="sm" onClick={() => selectWorkspace(row.workspaceId)}>
                {t('common.open')}
              </LinkButton>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}

/** A line under the workspace header while it is locked by a hand-off. */
export function TransferBanner({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  const transfer = useStore((s) => s.snapshot!.transfers.find((x) => x.id === ws?.transfer?.id))
  const tr = ws?.transfer
  if (!tr) return null
  const text =
    tr.state === 'frozen'
      ? t('transferBanner.frozen', { peer: tr.peerName })
      : tr.state === 'handed-off'
        ? t('transferBanner.handedOff', { peer: tr.peerName })
        : tr.state === 'staged'
          ? t('transferBanner.staged', { peer: tr.peerName })
          : t('transferBanner.diverged', { peer: tr.peerName })
  return (
    <Callout
      banner
      role="status"
      actions={
        transfer && ['awaiting-ack', 'staged'].includes(transfer.state) && !transfer.live ? (
          <Button size="sm" onClick={() => openReconcile(transfer.id)}>
            {t('handOffTo.reconcile')}
          </Button>
        ) : undefined
      }
    >
      <strong>{t('transferBanner.label')}</strong> · {text}
    </Callout>
  )
}
