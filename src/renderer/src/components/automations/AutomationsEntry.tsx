// Top of the sidebar: opens Automations, and says what runs next or what needs a look.
import { Zap } from 'lucide-react'
import { useT } from '../../i18n'
import { closeAutomations, openAutomations, useStore } from '../../store'
import { ActionRow } from '../../ui'
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
    // The sidebar's entry rows (this and the assistant's) share the `.automations-entry` frame.
    <ActionRow
      card
      className="automations-entry"
      selected={open}
      data-tour="automations"
      onPress={() => (open ? closeAutomations() : openAutomations())}
      primaryProps={{ title: t('automations.entry.title'), 'aria-pressed': open }}
    >
      <Zap size={14} />
      <span className="automations-entry-label">{t('automations.title')}</span>
      <span className={`automations-entry-hint ${running ? 'running' : paused ? 'paused' : ''}`}>{hint}</span>
    </ActionRow>
  )
}
