// #11 Usage-limit resume: the limit part of a failed turn's recovery card (an unticked "Resume at 14:30"
// with the words the time came from, or "Reset time unknown"), and the armed resume's row on Home's
// Scheduled card. The rules live in main/limitResume.ts; what to show is shared/usageLimit.ts.
import { AlarmClock, Clock } from 'lucide-react'
import { AGENTS } from '../../../shared/agents'
import { formatDateTime } from '../../../shared/i18n/time'
import type { ChatItem, LimitResume, Session } from '../../../shared/types'
import { clockTime, dayOf, limitCardView, RESUME_TEXT } from '../../../shared/usageLimit'
import { useT, type RendererT } from '../i18n'
import { api, attempt, selectSession, useStore } from '../store'
import { Button, Checkbox, LinkButton, Tag } from '../ui'
import { formatDuration } from './turnResult'
import './limitResume.css'

/** "Claude", "Codex": the agent family, as the error came from it (like tabModelText). */
const family = (agent: Session['agent']) => AGENTS[agent].label.split(/\s+/)[0]

/** "Resume at 14:30", or "Resume tomorrow at 09:00". */
function resumeLabel(t: RendererT, ms: number, now: number): string {
  const time = clockTime(ms, t.locale)
  const day = dayOf(ms, now, t.locale)
  if (day === 'today') return t('usageLimit.card.resumeAt', { time })
  return t('usageLimit.card.resumeAtDay', { day: day === 'tomorrow' ? t('usageLimit.card.tomorrow') : day, time })
}

function Source({ t, agent, source, from }: { t: RendererT; agent: Session['agent']; source: string; from?: 'event' }) {
  // G4: the second source, labelled as such: no words to quote, only the limit's type.
  if (from === 'event') return <div className="resume-source">{t('usageLimit.card.sourceEvent', { agent: family(agent), type: limitTypeLabel(t, source) })}</div>
  return <div className="resume-source">{t.rich('usageLimit.card.source', { agent: family(agent), quote: <q key="q">…{source}</q> })}</div>
}

/** G4: a rate-limit event's limit type ("five_hour") in words, or as written when it's one Foreman doesn't know. */
function limitTypeLabel(t: RendererT, type: string): string {
  switch (type) {
    case 'five_hour':
      return t('usageLimit.type.fiveHour')
    case 'seven_day':
    case 'seven_day_opus':
    case 'seven_day_sonnet':
    case 'seven_day_overage_included':
      return t('usageLimit.type.weekly')
    case 'overage':
      return t('usageLimit.type.overage')
    default:
      return type.replace(/_/g, ' ')
  }
}

/** What a missed resume says: its time came while Foreman was closed or asleep, or the send failed. */
function missedText(t: RendererT, resume: LimitResume): string {
  const time = clockTime(Date.parse(resume.resetAt), t.locale)
  return resume.failed ? t('usageLimit.card.failed', { time, reason: resume.failed }) : t('usageLimit.card.missed', { time })
}

function MissedActions({ t, sessionId }: { t: RendererT; sessionId: string }) {
  return (
    <>
      <Button size="sm" onClick={() => void attempt(() => api.resumeLimitNow(sessionId))}>
        {t('usageLimit.resumeNow')}
      </Button>
      <LinkButton onClick={() => void attempt(() => api.cancelLimitResume(sessionId))}>{t('usageLimit.dismiss')}</LinkButton>
    </>
  )
}

/**
 * The limit part of a failed turn's card. `canAct`: the latest turn of an idle chat that can send;
 * only then is there a checkbox.
 */
export function LimitResumePart({ item, session, canAct }: { item: Extract<ChatItem, { kind: 'turn-end' }>; session: Session; canAct: boolean }) {
  const t = useT()
  const now = Date.now()
  const view = limitCardView(item, session, canAct, now)
  const agent = family(session.agent)
  switch (view.kind) {
    case 'none':
      return null
    case 'unknown':
      return (
        <div className="resume">
          <div className="resume-unknown">
            <Clock size={14} /> {t('usageLimit.card.unknown')}
          </div>
          <div className="resume-preview">{view.stated ? t('usageLimit.card.unknownStated', { agent }) : t('usageLimit.card.unknownAgent', { agent })}</div>
        </div>
      )
    case 'offer':
      return (
        <div className="resume">
          <Checkbox
            className="resume-check"
            title={view.armed ? t('usageLimit.card.armedTitle') : undefined}
            checked={view.armed}
            onChange={(e) => void attempt(() => (e.target.checked ? api.armLimitResume(session.id, item.turnId) : api.cancelLimitResume(session.id)))}
          >
            <span className="resume-check-text">{resumeLabel(t, view.resetAt, now)}</span>
          </Checkbox>
          <Source t={t} agent={session.agent} source={view.source} from={view.from} />
          <div className="resume-preview">{t('usageLimit.card.preview', { text: session.limitResume?.text ?? RESUME_TEXT })}</div>
        </div>
      )
    case 'source':
      return (
        <div className="resume resume-flat">
          {view.passed && canAct && <div className="resume-unknown"><Clock size={14} /> {t('usageLimit.card.passed', { time: clockTime(view.resetAt, t.locale) })}</div>}
          <Source t={t} agent={session.agent} source={view.source} from={view.from} />
        </div>
      )
    case 'missed':
      return (
        <div className="resume resume-flat">
          <div className="resume-unknown">
            <AlarmClock size={14} /> {missedText(t, view.resume)}
          </div>
          <Source t={t} agent={session.agent} source={view.resume.source} from={view.resume.from} />
          <div className="notice-actions">
            <MissedActions t={t} sessionId={session.id} />
          </div>
        </div>
      )
  }
}

/** The tabs with an armed or missed resume, for Home's Scheduled card (one row each, never more than one per tab). */
export function useLimitResumes(repoId?: string): Session[] {
  const { sessions, workspaces } = useStore((s) => s.snapshot!)
  return sessions.filter((s) => s.limitResume && !s.closedAt && (!repoId || workspaces.find((w) => w.id === s.workspaceId)?.repoId === repoId))
}

/** The armed resumes' rows on Home's Scheduled card: when, what it sends, where the time came from, and Cancel. */
export function LimitResumeRows({ sessions }: { sessions: Session[] }) {
  const t = useT()
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const now = Date.now()
  return (
    <>
      {sessions.map((session) => {
        const resume = session.limitResume!
        const resetAt = Date.parse(resume.resetAt)
        const ws = workspaces.find((w) => w.id === session.workspaceId)
        const time = clockTime(resetAt, t.locale)
        const day = dayOf(resetAt, now, t.locale)
        const dayWord = day === 'today' ? t('usageLimit.home.today') : day === 'tomorrow' ? t('usageLimit.home.tomorrow') : day
        const tab = session.title ?? t('usageLimit.home.untitled')
        return (
          <div key={session.id} className="home-row resume-row">
            <Tag tone={resume.missed ? 'warn' : 'info'} className="home-pill" title={formatDateTime(resetAt, t.locale)}>
              <AlarmClock size={11} />
              {resume.missed ? t('usageLimit.home.missed', { time }) : `${dayWord} · ${time}`}
            </Tag>
            <div className="home-row-main">
              <div className="home-row-title">
                <span className="home-row-name">{t('usageLimit.home.title')}</span>
                {ws && <span className="home-row-branch">{ws.name}</span>}
              </div>
              <div className="home-row-sub">
                {resume.failed ? `${tab} · ${missedText(t, resume)}` : resume.missed ? t('usageLimit.home.missedSub', { tab, time }) : t('usageLimit.home.sends', { tab, text: resume.text })}
              </div>
              <div className="home-row-sub resume-src">
                {resume.from === 'event'
                  ? t('usageLimit.card.sourceEvent', { agent: family(session.agent), type: limitTypeLabel(t, resume.source) })
                  : t('usageLimit.home.source', { agent: family(session.agent), source: resume.source })}
              </div>
            </div>
            <span className="home-row-age">{resume.missed ? '' : t('usageLimit.home.in', { duration: formatDuration(Math.max(0, resetAt - now)) })}</span>
            <div className="home-row-actions">
              {resume.missed ? (
                <MissedActions t={t} sessionId={session.id} />
              ) : (
                <>
                  <LinkButton onClick={() => selectSession(session.workspaceId, session.id)}>{t('usageLimit.home.open')}</LinkButton>
                  <LinkButton onClick={() => void attempt(() => api.cancelLimitResume(session.id))}>{t('usageLimit.home.cancel')}</LinkButton>
                </>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
