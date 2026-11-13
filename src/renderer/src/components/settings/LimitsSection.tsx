// Settings → Usage → Limits (docs/agents.md 7.1): each agent's accounts and their usage windows, as the agents report them.
// Per agent, its accounts pooled into one sentence with a Status (percentages of two accounts don't add up), then each account's
// windows as a Meter, the state in words and the reset as text ("Resets in 1 h 52 min · 14:20"; a clock is read, so no Countdown).
// Foreman shows only what the agent reports. An agent whose record has no windows says so.
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isAgentEnabled } from '../../../../shared/agentCatalog'
import { instancesFor } from '../../../../shared/agentInstances'
import { AGENT_ORDER, AGENTS, type AgentKind } from '../../../../shared/agents'
import {
  limitsOf,
  pooled,
  reportsLimitWindows,
  settleWindow,
  tightestFirst,
  type AccountLimits,
  type LimitWindow,
  type LimitWindowState,
  type PooledView
} from '../../../../shared/limits'
import { ago } from '../../../../shared/narration'
import { clockTime, dayOf } from '../../../../shared/usageLimit'
import { useClock } from '../../clock'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Meter, Status } from '../../ui'
import { AgentIcon } from '../composer/AgentPicker'
import { rowDomId } from './controls'
import './limits.css'

const NONE: AccountLimits[] = []

const STATUS_TONE = { ok: 'ok', warning: 'warn', blocked: 'error' } as const satisfies Record<LimitWindowState, 'ok' | 'warn' | 'error'>

/** "42 min", "1 h 52 min", "4 days". */
function inWords(t: RendererT, ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return t('limits.in.minutes', { count: minutes })
  if (minutes < 48 * 60) return t('limits.in.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return t('limits.in.days', { count: Math.round(minutes / (24 * 60)) })
}

/** "14:20" today, else "Mon 09:00". */
function whenText(t: RendererT, ms: number, now: number): string {
  const day = dayOf(ms, now, t.locale)
  const clock = clockTime(ms, t.locale)
  return day === 'today' ? clock : `${day === 'tomorrow' ? t('usageLimit.card.tomorrow') : day} ${clock}`
}

function windowName(t: RendererT, w: LimitWindow): string {
  switch (w.kind) {
    case 'session':
      return t('limits.window.session')
    case 'weekly':
      return t('limits.window.weekly')
    case 'model-weekly':
      return t('limits.window.modelWeekly', { model: w.label ?? '' })
    default:
      return w.label === 'overage' ? t('limits.window.overage') : (w.label ?? t('limits.window.other'))
  }
}

function resetText(t: RendererT, w: LimitWindow, now: number): string {
  if (!w.resetsAt) return t('limits.window.noReset')
  const at = Date.parse(w.resetsAt)
  const left = at - now
  return left < 24 * 3_600_000 ? t('limits.window.resetsIn', { duration: inWords(t, left), time: clockTime(at, t.locale) }) : t('limits.window.resetsOn', { when: whenText(t, at, now), duration: inWords(t, left) })
}

const WORD = {
  ok: 'limits.window.stateOk',
  warning: 'limits.window.stateWarning',
  blocked: 'limits.window.stateBlocked'
} as const

function WindowRow({ t, account, window, now }: { t: RendererT; account: string; window: LimitWindow; now: number }) {
  const name = windowName(t, window)
  // A window whose reset time passed says nothing about now: no figure, until the agent reports again.
  const settled = settleWindow(window, now)
  const reset = window.resetsAt && Date.parse(window.resetsAt) <= now ? t('limits.window.passed') : resetText(t, window, now)
  const used = settled.usedPercent
  return (
    <div className="limits-row">
      <span className="limits-name">{name}</span>
      {used !== undefined ? (
        <>
          <Meter
            className="limits-meter"
            label={t('limits.window.meterLabel', { account, window: name })}
            value={used}
            tone={settled.state === 'blocked' ? 'error' : settled.state === 'warning' ? 'warn' : 'ok'}
            valueText={window.resetsAt ? t('limits.window.valueText', { percent: used, time: whenText(t, Date.parse(window.resetsAt), now) }) : t('limits.window.valueTextNoReset', { percent: used })}
          />
          <span className="limits-figure mono">{t('limits.window.used', { percent: used })}</span>
          <Status tone={STATUS_TONE[settled.state]} label={t(WORD[settled.state])} />
        </>
      ) : (
        <span className="limits-passed">{reset}</span>
      )}
      {used !== undefined && <span className="limits-reset">{reset}</span>}
    </div>
  )
}

function poolSentence(t: RendererT, view: PooledView, now: number): string {
  const parts = view.accounts.map((a) => {
    switch (a.state) {
      case 'ok':
        return t('limits.pool.room', { account: a.label })
      case 'warning':
        return t('limits.pool.close', { account: a.label })
      case 'blocked':
        return a.until ? t('limits.pool.blocked', { account: a.label, time: whenText(t, a.until, now) }) : t('limits.pool.atLimit', { account: a.label })
      default:
        return t('limits.pool.unknown', { account: a.label })
    }
  })
  return t('limits.pool.sentence', { parts: parts.join('; ') })
}

function poolStatus(t: RendererT, view: PooledView): { tone: 'ok' | 'warn' | 'error' | 'off'; label: string } {
  const total = view.accounts.length
  if (view.tone === 'error') return { tone: 'error', label: total === 1 ? t('limits.status.single') : t('limits.status.blocked', { blocked: view.blocked, count: total }) }
  if (view.tone === 'warn') return { tone: 'warn', label: t('limits.status.close') }
  if (view.tone === 'off') return { tone: 'off', label: t('limits.status.unknown') }
  return { tone: 'ok', label: total === 1 ? t('limits.status.room') : t('limits.status.roomAll') }
}

function AgentCard({ agent, limits, now }: { agent: AgentKind; limits: AccountLimits[]; now: number }) {
  const t = useT()
  // The selector returns what the snapshot holds: one that built a new array each time would never settle.
  const allInstances = useStore((s) => s.snapshot!.settings.agentInstances)
  const instances = instancesFor(allInstances, agent)
  const name = AGENTS[agent].label
  if (!reportsLimitWindows(agent)) {
    return (
      <div className="limits-none">
        <AgentIcon agent={agent} />
        <b>{name}</b>
        <span className="limits-none-text set-help">{t('limits.notReported')}</span>
        <Status tone="off" label={t('limits.notReportedStatus')} />
      </div>
    )
  }
  const accounts = [{ label: t('agentAccounts.default'), instance: undefined as string | undefined }, ...instances.map((i) => ({ label: i.label, instance: i.id }))].map((a) => ({ ...a, limits: limitsOf(limits, agent, a.instance) }))
  const view = pooled(accounts, now)
  const status = poolStatus(t, view)
  return (
    <div className="limits-agent">
      <div className="limits-head">
        <AgentIcon agent={agent} />
        <b>{name}</b>
        <span className="set-help">{t('limits.accounts', { count: accounts.length })}</span>
        <span className="limits-grow" />
        <Status tone={status.tone} label={status.label} />
      </div>
      <p className="set-help limits-pool">{poolSentence(t, view, now)}</p>
      {accounts.map((a) => {
        const windows = tightestFirst(a.limits?.windows ?? [])
        return (
          <div key={a.instance ?? 'default'} className="limits-account">
            <div className="limits-account-head">
              <b>{a.label}</b>
              {a.limits && <span className="set-help limits-updated">{t('limits.account.updated', { ago: ago(t, a.limits.updatedAt, now) })}</span>}
            </div>
            {windows.length ? windows.map((w) => <WindowRow key={`${w.kind}:${w.label ?? ''}`} t={t} account={a.label} window={w} now={now} />) : <p className="set-help">{t('limits.noneYet')}</p>}
          </div>
        )
      })}
    </div>
  )
}

/** The Limits section of Settings → Usage. */
export function LimitsSection() {
  const t = useT()
  const limits = useStore((s) => s.snapshot!.limits) ?? NONE
  const prefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  const now = useClock(30_000)
  const [reading, setReading] = useState(false)
  const read = async () => {
    setReading(true)
    await attempt(() => api.refreshLimits())
    setReading(false)
  }
  useEffect(() => {
    void read()
    // Once, when the page opens: the read itself is throttled in main.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const agents = AGENT_ORDER.filter((a) => isAgentEnabled(a, prefs))
  return (
    <section id={rowDomId('usage-limits')} className="set-section" aria-labelledby="usage-limits-title">
      <div className="limits-section-head">
        <h2 id="usage-limits-title">{t('limits.section.title')}</h2>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={reading} onClick={() => void read()}>
          {reading ? t('limits.refreshing') : t('limits.refresh')}
        </Button>
      </div>
      <p className="set-section-desc">{t('limits.section.desc')}</p>
      <div className="set-card limits-card">
        {agents.map((agent) => (
          <div key={agent} className="limits-item">
            <AgentCard agent={agent} limits={limits} now={now} />
          </div>
        ))}
      </div>
    </section>
  )
}
