// Settings → Devices: paired computers (hand-offs, control from another computer, pairing; and whether Foreman keeps
// running with no window, which is what lets them reach it), then agents on this computer (docs/agent-access.md §9).
import { useEffect, useState } from 'react'
import type { DevicesInfo } from '../../../../shared/transfer'
import { timeAgo } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, attempt, openPairDialog, useStore } from '../../store'
import { Button, LinkButton, TextInput } from '../../ui'
import { AgentAccessSection } from './AgentAccessSection'
import { CONTROL_WIDTH, Page, Part, resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

export function DevicesPage() {
  const t = useT()
  return (
    <Page title={t('settings.data.devices')}>
      {/* Asks for the paired computers only while they are shown. */}
      <Part id="computers">
        <DevicesSection />
      </Part>
      <Part id="agents" lead>
        <AgentAccessSection />
      </Part>
    </Page>
  )
}

/**
 * Paired computers: who this one can hand work to, whether it listens for hand-offs, and whether paired computers may
 * control it. First, whether Foreman runs on with no window, which is what lets them (and phones) reach it then.
 */
function DevicesSection() {
  const t = useT()
  const settings = useSettings()
  const [info, setInfo] = useState<DevicesInfo | null>(null)
  const [online, setOnline] = useState<Record<string, boolean | 'checking'>>({})
  const [port, setPort] = useState('')
  // The paired list changes with snapshots (pairing finishes in the main process).
  const paired = useStore((s) => s.snapshot!.pairedDevices)
  const refresh = () => void api.devicesInfo().then((i) => (setInfo(i), setPort(String(i.port))), () => undefined)
  useEffect(refresh, [paired])
  const check = async (id: string) => {
    setOnline((o) => ({ ...o, [id]: 'checking' }))
    const up = await api.pingDevice(id).catch(() => false)
    setOnline((o) => ({ ...o, [id]: up }))
    refresh()
  }
  return (
    <Section part="computers" title={t('settings.data.devices')} description={t('settings.data.devices.desc')}>
      <ToggleRow
        id="keep-running"
        label={t('settings.data.keepRunning')}
        help={t('settings.data.keepRunning.help')}
        checked={settings.keepRunning}
        onChange={(keepRunning) => void saveSettings({ keepRunning })}
        onReset={settings.keepRunning ? () => void resetSettings(['keepRunning']) : undefined}
      />
      <ToggleRow
        id="accept-hand-offs"
        label={t('settings.data.devices.accept')}
        help={info ? (info.accepting ? `${t('settings.data.devices.listening', { port: info.port })} ${t('settings.data.devices.reachAt', { addresses: info.addresses.map((a) => `${a}:${info.port}`).join(t('settings.data.devices.or')) || t('pairDialog.show.port', { port: info.port }) })}` : t('settings.data.devices.off')) : t('settings.usage.reading')}
        detail={t('settings.data.devices.acceptDetail')}
        checked={Boolean(info?.accepting)}
        onChange={(on) => void attempt(() => api.setAcceptHandOffs(on, Number(port) || undefined)).then((i) => i && setInfo(i))}
      />
      <ToggleRow
        id="remote-control"
        label={t('settings.data.devices.remote')}
        help={t('settings.data.devices.remoteHelp')}
        checked={Boolean(info?.remoteControl)}
        onChange={(on) => info && void attempt(() => api.setRemoteControl(on, info.remoteControlAsk)).then((i) => i && setInfo(i))}
      />
      <ToggleRow
        id="remote-control-ask"
        label={t('settings.data.devices.remoteAsk')}
        help={t('settings.data.devices.remoteAskHelp')}
        disabled={!info?.remoteControl}
        detail={info && !info.remoteControl ? t('settings.data.devices.remoteAskOff') : undefined}
        checked={info ? info.remoteControlAsk : true}
        onChange={(on) => info && void attempt(() => api.setRemoteControl(info.remoteControl, on)).then((i) => i && setInfo(i))}
      />
      <Row id="device-port" label={t('settings.data.devices.port')} help={t('settings.data.devices.portHelp')}>
        {(control) => (
          <TextInput
            {...control}
            width={CONTROL_WIDTH}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => info && Number(port) !== info.port && void attempt(() => api.setAcceptHandOffs(info.accepting, Number(port))).then((i) => i && setInfo(i))}
          />
        )}
      </Row>
      {info?.paired.map((d) => (
        <Row
          key={d.id}
          label={
            <>
              {d.name} <span className="faint small">{t('settings.data.devices.paired')}</span>
            </>
          }
          help={[
            online[d.id] === true ? t('settings.data.devices.online') : online[d.id] === false ? t('settings.data.devices.unreachable') : '',
            d.lastSeen ? t('settings.data.devices.lastSeen', { when: timeAgo(d.lastSeen, t.locale) }) : t('settings.data.devices.neverSeen'),
            d.host ? `${d.host}${d.port ? `:${d.port}` : ''}` : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <LinkButton disabled={online[d.id] === 'checking'} onClick={() => void check(d.id)}>
            {online[d.id] === 'checking' ? t('gitlab.accounts.checking') : t('settings.data.devices.check')}
          </LinkButton>
          <LinkButton onClick={() => window.confirm(t('settings.data.devices.unpairConfirm', { name: d.name })) && void attempt(() => api.unpairDevice(d.id)).then(refresh)}>
            {t('settings.data.devices.unpair')}
          </LinkButton>
        </Row>
      ))}
      <Row id="pair-mac" label={t('pairDialog.show.title')} help={t('settings.data.devices.pairHelp')}>
        <Button size="sm" onClick={() => openPairDialog('show')}>
          {t('pairDialog.enter.showCode')}
        </Button>
        <Button size="sm" onClick={() => openPairDialog('enter')}>
          {t('pairDialog.enter.title')}
        </Button>
      </Row>
    </Section>
  )
}
