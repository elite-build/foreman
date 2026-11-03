// The device chip in the sidebar title bar: which computer this window shows (shared/remote.ts), the paired computers it
// can show instead, and Foreman on your phone, in one menu. Its label says the most pressing of: a phone pairing to
// confirm, a switch under way, the computer shown, or the phone's state when no computer is paired.
import { ChevronDown, Laptop, Monitor, Plus, Settings, Smartphone } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ComputerRow, ComputerSummary } from '../../../../shared/remote'
import { othersNeedYou } from '../../../../shared/remote'
import { useT, type RendererT } from '../../i18n'
import { openPairDialog, openPhoneSetup, openSettingsPage, useStore, viewComputer } from '../../store'
import { Glyph, MenuButton, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Spinner, Status, type StatusTone } from '../../ui'
import { phoneLabel, phoneStatus, type PhoneStatus } from '../phone/status'
import { useMobileInfo } from '../phone/useMobileInfo'
import './computers.css'

// The phone's state in shape and words, as the phone pill had it.
const PHONE_TONE: Record<PhoneStatus, StatusTone> = { loading: 'off', off: 'off', ready: 'info', pending: 'warn', paired: 'ok' }

export const ComputerIcon = ({ platform, size = 12 }: { platform?: string; size?: number }) =>
  platform === 'darwin' ? <Laptop size={size} aria-hidden /> : <Monitor size={size} aria-hidden />

/** "2 running · 1 needs you", or nothing to say. */
export function summaryText(summary: ComputerSummary | undefined, t: RendererT): string {
  if (!summary) return ''
  return [summary.running ? t('computers.summary.running', { count: summary.running }) : '', summary.needsYou ? t('computers.summary.needsYou', { count: summary.needsYou }) : ''].filter(Boolean).join(' · ')
}

/** A paired computer's second line: whether it can be shown now, and what's happening there. */
export function rowText(c: ComputerRow, t: RendererT): string {
  switch (c.status) {
    case 'online':
      return [t('computers.status.online'), summaryText(c.summary, t)].filter(Boolean).join(' · ')
    case 'mismatch':
      return c.version ? t('computers.status.mismatch', { version: c.version }) : t('computers.status.mismatchUnknown')
    default:
      return t(`computers.status.${c.status}`)
  }
}

export function DeviceChip() {
  const t = useT()
  const view = useStore((s) => s.computers)
  // As often as the phone pill asked; the phone dialog asks faster while it is open.
  const [info] = useMobileInfo(8000)
  const phone = phoneStatus(info)
  const viewing = view?.viewing ?? null
  const joining = view?.joining ?? null
  const computers = view?.computers ?? []
  const hasComputers = computers.length > 0 || Boolean(viewing)
  const others = othersNeedYou(view)
  const shown = viewing ? computers.find((c) => c.id === viewing.id) : undefined

  // The label: the most pressing thing first.
  let label: ReactNode
  let title: string
  if (phone === 'pending') {
    label = (
      <>
        <Smartphone size={12} aria-hidden />
        <Status tone="warn" label={phoneLabel(info, t)} className="device-chip-name" />
      </>
    )
    title = t('phone.title')
  } else if (joining) {
    label = (
      <>
        <Spinner size={11} />
        <span className="device-chip-name">{joining.name}</span>
      </>
    )
    title = t(joining.waiting ? 'computers.joining.waiting' : 'computers.joining.connecting', { name: joining.name })
  } else if (hasComputers && view) {
    label = (
      <>
        <ComputerIcon platform={viewing ? shown?.platform : view.self.platform} />
        <span className="device-chip-name">{viewing ? viewing.name : t('computers.thisComputer')}</span>
      </>
    )
    title = t('computers.chip.title', { name: viewing ? viewing.name : view.self.name })
  } else {
    label = (
      <>
        <Smartphone size={12} aria-hidden />
        <Status tone={PHONE_TONE[phone]} label={phoneLabel(info, t)} className="device-chip-name" />
      </>
    )
    title = phone === 'paired' ? t('phone.pill.connected') : t('phone.pill.use')
  }

  return (
    <MenuButton
      look="chip"
      pill
      tone={others || phone === 'pending' ? 'warn' : 'neutral'}
      placement="bottom-start"
      label={t('settings.data.devices')}
      className="device-chip-wrap"
      triggerClassName="device-chip"
      title={title}
      trigger={
        <>
          {label}
          {others > 0 && (
            <span className="device-chip-count" aria-label={t('computers.othersNeedYou', { count: others })}>
              <Glyph name="warn" />
              {others}
            </span>
          )}
          <ChevronDown size={12} aria-hidden />
        </>
      }
    >
      {hasComputers && view && (
        <>
          <MenuLabel>{t('computers.menu.title')}</MenuLabel>
          <MenuRadioItem
            checked={!viewing}
            icon={<ComputerIcon platform={view.self.platform} size={14} />}
            description={[t('computers.thisComputer'), summaryText(view.self.summary, t)].filter(Boolean).join(' · ')}
            onSelect={() => void viewComputer(null)}
          >
            {view.self.name}
          </MenuRadioItem>
          {computers.map((c) => (
            <MenuRadioItem
              key={c.id}
              checked={viewing?.id === c.id}
              disabled={c.status !== 'online' && viewing?.id !== c.id}
              icon={<ComputerIcon platform={c.platform} size={14} />}
              description={rowText(c, t)}
              onSelect={() => void viewComputer(c.id)}
            >
              {c.name}
            </MenuRadioItem>
          ))}
        </>
      )}
      {/* Pairing and Settings act on the computer the window shows, so they're offered only for this one. */}
      {!viewing && (
        <MenuItem icon={<Plus size={14} />} onSelect={() => openPairDialog('show')}>
          {t('computers.menu.pair')}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuLabel>{t('computers.menu.phone')}</MenuLabel>
      <MenuItem
        icon={<Smartphone size={14} />}
        description={phone === 'paired' ? t('phone.pill.connected') : phone === 'pending' ? undefined : t('phone.pill.use')}
        onSelect={() => openPhoneSetup(true)}
      >
        {phoneLabel(info, t)}
      </MenuItem>
      {!viewing && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Settings size={14} />} onSelect={() => openSettingsPage({ section: 'data', scrollTo: 'remote-control' })}>
            {t('computers.menu.settings')}
          </MenuItem>
        </>
      )}
    </MenuButton>
  )
}
