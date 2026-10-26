// Keep agents running (O10) in the window: Home's "Reconnected to 3 running turns · 1 finished while
// Foreman was closed" line after a keep-running quit, and the chat's line where Foreman was closed.
// The Quit sheet's choice lives with the other Quit choices in StopSafely.tsx.
import { PlugZap } from 'lucide-react'
import { gapRange, type ClosedGap } from '../../../shared/agentHost'
import { useT } from '../i18n'
import { api, attempt, useStore } from '../store'
import { Button, Callout } from '../ui'
import './keepRunning.css'

/** Home, once after a keep-running quit: what Foreman reattached to and what ended meanwhile. Dismiss hides it. */
export function ReconnectedLine() {
  const t = useT()
  const record = useStore((s) => s.snapshot?.reconnected)
  if (!record) return null
  const parts = [
    record.finished ? t('keepRunning.home.finished', { count: record.finished }) : '',
    record.closedAt ? t('keepRunning.home.closed', { range: gapRange({ from: record.closedAt, to: record.at }, t.locale) }) : ''
  ].filter(Boolean)
  return (
    <Callout
      tone="info"
      role="status"
      actions={
        <Button title={t('keepRunning.home.dismissTitle')} onClick={() => void attempt(() => api.dismissReconnected())}>
          {t('keepRunning.home.dismiss')}
        </Button>
      }
    >
      <strong>{t('keepRunning.home.running', { count: record.running })}</strong>
      {parts.length > 0 && ` · ${parts.join(' · ')}`}
    </Callout>
  )
}

/** "Foreman was closed 12:10–12:52 · this turn kept running in the background · 5 steps meanwhile". */
export function ClosedGapLine({ gap }: { gap: ClosedGap }) {
  const t = useT()
  const title = gap.from ? t('keepRunning.gap.title', { range: gapRange(gap, t.locale) }) : t('keepRunning.gap.until', { time: gapRange({ to: gap.to }, t.locale) })
  return (
    <div className="closed-gap" role="note">
      <span className="closed-gap-text">
        <PlugZap size={13} />
        <span>
          <b>{title}</b> · {t(gap.ended ? 'keepRunning.gap.ended' : 'keepRunning.gap.running')}
          {gap.steps > 0 && ` · ${t('keepRunning.gap.steps', { count: gap.steps })}`}
        </span>
      </span>
    </div>
  )
}
