// The computer chip in the sidebar title bar (shared/remote.ts): which computer this window shows, the paired computers
// it can show instead, and whether one of them needs you. Only there once a computer is paired.
import { ChevronDown, Laptop, Monitor, Plus, Settings } from 'lucide-react'
import type { ComputerRow, ComputerSummary } from '../../../../shared/remote'
import { othersNeedYou } from '../../../../shared/remote'
import { useT, type RendererT } from '../../i18n'
import { openPairDialog, openSettingsPage, useStore, viewComputer } from '../../store'
import { Glyph, MenuButton, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Spinner } from '../../ui'
import './computers.css'

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

export function ComputerChip() {
  const t = useT()
  const view = useStore((s) => s.computers)
  if (!view || (!view.computers.length && !view.viewing)) return null
  const { viewing, joining, self } = view
  const others = othersNeedYou(view)
  const shown = viewing ? view.computers.find((c) => c.id === viewing.id) : undefined
  const name = joining ? joining.name : viewing ? viewing.name : t('computers.thisComputer')
  return (
    <MenuButton
      look="chip"
      pill
      tone={others ? 'warn' : 'neutral'}
      placement="bottom-start"
      label={t('computers.menu.title')}
      className="computer-chip-wrap"
      triggerClassName="computer-chip"
      title={joining ? t(joining.waiting ? 'computers.joining.waiting' : 'computers.joining.connecting', { name: joining.name }) : t('computers.chip.title', { name: viewing ? viewing.name : self.name })}
      trigger={
        <>
          {joining ? <Spinner size={11} /> : <ComputerIcon platform={viewing ? shown?.platform : self.platform} />}
          <span className="computer-chip-name">{name}</span>
          {others > 0 && (
            <span className="computer-chip-count" aria-label={t('computers.othersNeedYou', { count: others })}>
              <Glyph name="warn" />
              {others}
            </span>
          )}
          <ChevronDown size={12} aria-hidden />
        </>
      }
    >
      <MenuLabel>{t('computers.menu.title')}</MenuLabel>
      <MenuRadioItem
        checked={!viewing}
        icon={<ComputerIcon platform={self.platform} size={14} />}
        description={[t('computers.thisComputer'), summaryText(self.summary, t)].filter(Boolean).join(' · ')}
        onSelect={() => void viewComputer(null)}
      >
        {self.name}
      </MenuRadioItem>
      {view.computers.map((c) => (
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
      {/* Pairing and Settings act on the computer the window shows, so they're offered only for this one. */}
      {!viewing && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Plus size={14} />} onSelect={() => openPairDialog('show')}>
            {t('computers.menu.pair')}
          </MenuItem>
          <MenuItem icon={<Settings size={14} />} onSelect={() => openSettingsPage({ section: 'data', scrollTo: 'remote-control' })}>
            {t('computers.menu.settings')}
          </MenuItem>
        </>
      )}
    </MenuButton>
  )
}
