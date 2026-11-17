// An icon in the sidebar's top row, beside the Assistant's: opens Automations. Its name and tooltip say what runs next; a
// running automation, or paused schedules, show as a mark on its corner.
import { Zap } from 'lucide-react'
import { useT } from '../../i18n'
import { closeAutomations, openAutomations, useStore } from '../../store'
import { IconButton, Status } from '../../ui'
import { nextPill } from '../ScheduleDialogs'

/** `className`: its place where it is drawn (the top row, or a tile on the folded rail). */
export function AutomationsEntry({ className }: { className?: string }) {
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
    // The icon and the Assistant's share the `.automations-entry` frame (automations.css).
    <IconButton
      className={['automations-entry', className].filter(Boolean).join(' ')}
      label={`${t('automations.title')} · ${hint}`}
      pressed={open}
      aria-current={open ? 'true' : undefined}
      data-tour="automations"
      onClick={() => (open ? closeAutomations() : openAutomations())}
    >
      <Zap size={15} />
      {/* What needs a look, as a mark on the corner; the hint itself is in the name. */}
      {(running || paused > 0) && (
        <span className="automations-entry-mark">
          <Status compact tone={running ? 'info' : 'warn'} label={hint} />
        </span>
      )}
    </IconButton>
  )
}
