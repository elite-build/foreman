// Top of the sidebar, beside the Assistant: opens Automations. What runs next is in its tooltip; a running automation, or
// paused schedules, show as a mark at its end.
import { Zap } from 'lucide-react'
import { useT } from '../../i18n'
import { closeAutomations, openAutomations, useStore } from '../../store'
import { ActionRow, Status } from '../../ui'
import { nextPill } from '../ScheduleDialogs'

export function AutomationsEntry() {
  const t = useT()
  const open = useStore((s) => Boolean(s.automations))
  const schedules = useStore((s) => s.snapshot!.schedules)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const running = occurrences.some((o) => o.state === 'running' || o.state === 'starting')
  const paused = schedules.filter((s) => s.state === 'paused').length
  const next = schedules
    .filter((s) => s.state === 'active' && s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0]
  const hint = running ? t('automations.entry.running') : paused ? t('automations.entry.paused', { count: paused }) : next ? t('automations.entry.next', { time: nextPill(Date.parse(next.nextRunAt!), next.timezone, t.locale) }) : t('automations.entry.idle')
  return (
    // The sidebar's entry rows (this, the assistant's and the Team row) share the `.automations-entry` frame.
    <ActionRow
      card
      className="automations-entry"
      selected={open}
      data-tour="automations"
      onPress={() => (open ? closeAutomations() : openAutomations())}
      primaryProps={{ title: `${t('automations.entry.title')} · ${hint}`, 'aria-pressed': open }}
    >
      <Zap size={14} />
      <span className="automations-entry-label">{t('automations.title')}</span>
      {/* Half a row wide: the hint is in the tooltip, and only what needs a look stays, as a mark with its word. */}
      {(running || paused > 0) && <Status className="automations-entry-mark" compact tone={running ? 'info' : 'warn'} label={hint} />}
    </ActionRow>
  )
}
