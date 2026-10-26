// Phone pill → Network setup…: pairing, plus how the phone reaches this computer (same Wi-Fi
// address, private HTTPS through Tailscale).
import { useState } from 'react'
import type { MobileInfo } from '../../../../shared/mobile'
import { useT } from '../../i18n'
import { api, attempt, openPhoneSetup, showToast } from '../../store'
import { Button, Dialog, Select, TextInput } from '../../ui'
import { Row, Section } from '../settings/controls'
import { PairPanel } from './PairPanel'
import { useMobileInfo } from './useMobileInfo'
import '../settings/settings.css'
import './phone.css'

const SERVE_COMMAND = 'tailscale serve --bg 47632'

export function PhoneSetupDialog() {
  const t = useT()
  const [info, setInfo] = useMobileInfo(2000)
  return (
    <Dialog title={t('phone.title')} closeLabel={t('common.close')} size="lg" className="phone-setup-modal" onClose={() => openPhoneSetup(false)}>
      <p className="muted phone-setup-intro">
        {t('phone.setup.intro')}
      </p>
      <PairPanel info={info} onInfo={setInfo} />
      {info && <Connection key={info.url + info.lan.address} info={info} onInfo={setInfo} />}
    </Dialog>
  )
}

function Connection({ info, onInfo }: { info: MobileInfo; onInfo: (next: MobileInfo) => void }) {
  const t = useT()
  const [url, setUrl] = useState(info.url)
  const [lanAddress, setLanAddress] = useState(
    info.lan.candidates.find((c) => c.address === info.lan.address)?.address || info.lan.candidates[0]?.address || ''
  )
  const [busy, setBusy] = useState(false)
  const configure = async (enabled: boolean, mode: 'private' | 'lan') => {
    setBusy(true)
    const next = await attempt(() => (mode === 'private' ? api.mobileConfigure(enabled, url) : api.mobileConfigureLan(enabled, lanAddress)))
    setBusy(false)
    if (next) onInfo(next)
  }
  return (
    <Section title={t('phone.setup.connection')}>
      <Row
        label={t('phone.mode.lan')}
        help={t('phone.setup.lanHelp')}
      >
        {(control) => (
          <>
            <Select
              {...control}
              width={220}
              value={lanAddress}
              onChange={setLanAddress}
              disabled={busy || !info.lan.candidates.length}
              options={
                info.lan.candidates.length
                  ? info.lan.candidates.map((c) => ({ value: c.address, label: `${c.name} · ${c.address}` }))
                  : [{ value: '', label: t('phone.setup.noIpv4') }]
              }
            />
            {info.lan.enabled && lanAddress !== info.lan.address && (
              <Button size="sm" disabled={busy} onClick={() => void configure(true, 'lan')}>
                {t('phone.setup.updateAddress')}
              </Button>
            )}
            <Button size="sm" disabled={busy || (!info.lan.enabled && !lanAddress)} onClick={() => void configure(!info.lan.enabled, 'lan')}>
              {info.lan.enabled ? t('phone.setup.turnOff') : t('phone.setup.turnOn')}
            </Button>
          </>
        )}
      </Row>
      <Row label={t('phone.setup.private')} help={t('phone.setup.privateHelp')}>
        {(control) => (
          <>
            <TextInput {...control} width={260} value={url} placeholder="https://computer.tailnet.ts.net" onChange={(e) => setUrl(e.target.value)} />
            {info.enabled && url.trim().replace(/\/$/, '') !== info.url && (
              <Button size="sm" disabled={busy} onClick={() => void configure(true, 'private')}>
                {t('phone.setup.updateAddress')}
              </Button>
            )}
            <Button size="sm" disabled={busy || (!info.enabled && !url.trim())} onClick={() => void configure(!info.enabled, 'private')}>
              {info.enabled ? t('phone.setup.turnOff') : t('phone.setup.turnOn')}
            </Button>
          </>
        )}
      </Row>
      <Row label={t('phone.setup.publish')} help={t('phone.setup.publishHelp')}>
        <code>{SERVE_COMMAND}</code>
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(SERVE_COMMAND).then(() => showToast(t('phone.setup.copied')))}>
          {t('common.copy')}
        </Button>
      </Row>
    </Section>
  )
}
