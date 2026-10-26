import { t } from '../i18n'

/** "45s", "3m 12s", "1h 5m", in the UI language at call time. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return t('duration.seconds', { s: total })
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return t('duration.minutes', { m: minutes, s: total % 60 })
  return t('duration.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}
