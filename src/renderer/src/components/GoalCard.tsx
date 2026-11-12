// The agent's goal for this chat, pinned above the composer (docs/agents.md 3, Codex): what it is working toward by itself,
// whether it still is, what it has used, and Clear. Codex sets it from `/goal` and keeps working at it turn after turn, so
// the person sees it without scrolling for the message that set it.
import { Target } from 'lucide-react'
import { formatNumber } from '../../../shared/i18n/time'
import type { Session, SessionGoal } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { api, attempt } from '../store'
import { Button, Card, Status, type StatusTone } from '../ui'
import './goalCard.css'

// The state in a shape and a word: working is info, done is ok, and each way it stopped short is a warning or off.
const TONE: Record<SessionGoal['status'], StatusTone> = { active: 'info', paused: 'off', blocked: 'warn', usageLimited: 'warn', budgetLimited: 'warn', complete: 'ok' }

const STATUS_WORD = {
  active: 'goal.status.active',
  paused: 'goal.status.paused',
  blocked: 'goal.status.blocked',
  usageLimited: 'goal.status.usageLimited',
  budgetLimited: 'goal.status.budgetLimited',
  complete: 'goal.status.complete'
} as const satisfies Record<SessionGoal['status'], string>

/** "48 s", "14 min": how long the goal has run. */
export function goalTime(t: RendererT, seconds: number): string {
  return seconds < 60 ? t('goal.card.seconds', { count: Math.max(0, Math.round(seconds)) }) : t('goal.card.minutes', { count: Math.round(seconds / 60) })
}

export function GoalCard({ session }: { session: Session }) {
  const t = useT()
  const goal = session.goal
  if (!goal) return null
  // "/goal clear" is a message like any other: Codex answers it (goes into a running turn when one is going).
  const clear = () => void attempt(() => api.sendMessage(session.id, '/goal clear', session.status === 'running' ? { mode: 'steer' } : undefined))
  return (
    <Card size="sm" as="section" aria-label={t('goal.card.aria')} className="goal-card">
      <Target size={14} aria-hidden className="goal-card-icon" />
      <div className="goal-card-text">
        <span className="faint small">{t('goal.card.label')}</span>
        <span className="goal-card-objective">{goal.objective}</span>
        <span className="goal-card-meta">
          <Status tone={TONE[goal.status]} label={t(STATUS_WORD[goal.status])} />
          <span className="faint small">{goalTime(t, goal.timeUsedSeconds)}</span>
          <span className="faint small">{t('goal.card.tokens', { count: formatNumber(goal.tokensUsed, t.locale) })}</span>
        </span>
      </div>
      <Button size="sm" onClick={clear} aria-label={t('goal.card.clearAria')}>
        {t('goal.card.clear')}
      </Button>
    </Card>
  )
}
