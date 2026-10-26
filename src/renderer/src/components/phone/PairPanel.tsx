// Pair a phone: choose how it reaches this computer, scan the QR code, confirm the code.
import { Globe, QrCode, Smartphone, Wifi } from 'lucide-react'
import { useState } from 'react'
import { timeAgo } from '../../../../shared/i18n/time'
import type { MobileInfo } from '../../../../shared/mobile'
import { useT } from '../../i18n'
import { api, attempt, openPhoneSetup } from '../../store'
import { Button, LinkButton, RadioCards, Spinner } from '../../ui'
import { phoneStatus } from './status'

type Mode = 'lan' | 'private'

export function PairPanel({ info, onInfo, compact }: { info: MobileInfo | null; onInfo: (next: MobileInfo) => void; compact?: boolean }) {
  const t = useT()
  const [mode, setMode] = useState<Mode>(() => (info?.enabled && !info.lan.enabled ? 'private' : 'lan'))
  const [busy, setBusy] = useState(false)
  const lanAddress = info?.lan.address || info?.lan.candidates[0]?.address || ''
  // Private access needs its Tailscale address first, which the setup dialog asks for.
  const needsSetup = mode === 'private' && !info?.enabled

  const showQr = async () => {
    if (!info) return
    setBusy(true)
    const next = await attempt(async () => {
      if (mode === 'lan' && !info.lan.enabled) await api.mobileConfigureLan(true, lanAddress)
      return api.mobileStartPairing(mode)
    })
    setBusy(false)
    if (next) onInfo(next)
  }
  const approve = async (allow: boolean) => {
    const next = await attempt(() => api.mobileApprovePairing(info!.pending!.id, allow))
    if (next) onInfo(next)
  }
  const revoke = async (id: string) => {
    const next = await attempt(() => api.mobileRevokeDevice(id))
    if (next) onInfo(next)
  }
  const qrSize = compact ? 148 : 180

  return (
    <div className={`phone-pair ${compact ? 'compact' : ''}`}>
      <RadioCards<Mode>
        legend={t('phone.modes')}
        hideLegend
        layout={compact ? 'stack' : 'grid'}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'lan', icon: <Wifi size={15} />, label: t('phone.mode.lan'), description: compact ? undefined : t('phone.mode.lanDesc') },
          { value: 'private', icon: <Globe size={15} />, label: t('phone.mode.private'), description: compact ? undefined : t('phone.mode.privateDesc') }
        ]}
      />

      <div className="phone-qr-box">
        {info?.pairing && info.pairing.mode === mode ? (
          <img src={info.pairing.qr} width={qrSize} height={qrSize} alt={t('phone.qrAlt')} />
        ) : (
          <div className="phone-qr-placeholder" style={{ width: qrSize, height: qrSize }} aria-hidden>
            <QrCode size={compact ? 40 : 52} strokeWidth={1.2} />
          </div>
        )}
        <div className="phone-qr-side">
          {info?.pending ? (
            <>
              <div className="phone-code">{info.pending.code}</div>
              <p className="muted small">{t('phone.checkCode', { device: info.pending.name })}</p>
              <div className="phone-actions">
                <Button size="sm" onClick={() => void approve(false)}>
                  {t('phone.deny')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void approve(true)}>
                  {t('phone.pairPhone')}
                </Button>
              </div>
            </>
          ) : info?.pairing && info.pairing.mode === mode ? (
            <>
              <strong>{t('phone.scan')}</strong>
              <p className="muted small">{t('phone.expires')}</p>
            </>
          ) : needsSetup ? (
            <>
              <strong>{t('phone.setupPrivate')}</strong>
              <p className="muted small">{t('phone.setupPrivateHelp')}</p>
              <Button size="sm" onClick={() => openPhoneSetup(true)}>
                {t('phone.setUp')}
              </Button>
            </>
          ) : (
            <>
              <strong>{phoneStatus(info) === 'paired' ? t('phone.addAnother') : t('phone.pairQuick')}</strong>
              {!compact && <p className="muted small">{t('phone.pairPitch')}</p>}
              <Button size="sm" variant="primary" icon={busy ? <Spinner size={13} /> : <QrCode size={13} />} disabled={busy || !info || (mode === 'lan' && !lanAddress)} onClick={() => void showQr()}>
                {t('phone.showQr')}
              </Button>
              {mode === 'lan' && info && !lanAddress && <p className="faint small">{t('phone.noLan')}</p>}
              {mode === 'lan' && !compact && <p className="faint small">{t('phone.lanNote')}</p>}
            </>
          )}
        </div>
      </div>

      {info && info.devices.length > 0 && (
        <div className="phone-devices" role="list" aria-label={t('phone.devices')}>
          {info.devices.map((d) => (
            <div key={d.id} className="phone-device" role="listitem">
              <Smartphone size={14} aria-hidden />
              <span className="phone-device-name">{d.name}</span>
              <span className="faint small">
                {(d.transport ?? 'private') === 'lan' ? t('phone.device.lan') : t('phone.device.private')} · {d.lastSeen ? t('phone.device.seen', { when: timeAgo(d.lastSeen, t.locale) }) : t('phone.device.notSeen')}
              </span>
              <LinkButton aria-label={t('phone.device.revokeNamed', { name: d.name })} onClick={() => void revoke(d.id)}>
                {t('phone.device.revoke')}
              </LinkButton>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
