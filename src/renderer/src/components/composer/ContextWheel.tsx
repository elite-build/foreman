import type { ContextUsage } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'

function short(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** A ring showing how full the context window is: shown above 70%, or always if the setting asks. */
export function ContextWheel({ usage }: { usage: ContextUsage }) {
  const t = useT()
  const always = useStore((s) => s.snapshot?.settings.alwaysShowContextUsage ?? false)
  if (!(usage.limit > 0)) return null
  const ratio = Math.min(Math.max(usage.used / usage.limit, 0), 1)
  if (!always && ratio <= 0.7) return null
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const tone = ratio >= 0.9 ? 'red' : ratio >= 0.7 ? 'amber' : ''
  return (
    <span className={`context-wheel ${tone}`} title={t('contextWheel.title', { used: short(usage.used), limit: short(usage.limit), percent: Math.round(ratio * 100) })}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} className="track" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          className="fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="small">{Math.round(ratio * 100)}%</span>
    </span>
  )
}
