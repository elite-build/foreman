// Automations: prompt templates and the schedules that run them, on a week calendar. Covers the
// workspace area like Settings, so open workspaces stay mounted.
import { CalendarClock, ChevronLeft, ChevronRight, Play, Plus, RotateCcw, Zap, ArrowLeft } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Locale } from '../../../../shared/i18n'
import { formatDate, formatDateTime } from '../../../../shared/i18n/time'
import { DEFAULT_PROMPT_TEMPLATES, newTemplateId, templateName } from '../../../../shared/promptTemplates'
import { qualifiedName } from '../../../../shared/repoTemplates'
import type { PromptTemplate } from '../../../../shared/types'
import { useT } from '../../i18n'
import { closeAutomations, openScheduleDialog, selectAutomation, useStore } from '../../store'
import { ActionRow, Button, CardButton, IconButton, LinkButton, type CardLook, type StatusTone } from '../../ui'
import { saveSettings, useSettings } from '../settings/controls'
import { DAY_MS, hourRange, minuteOfDay, startOfWeek, weekBlocks, type CalendarBlock } from './calendar'
import { RUN_LABEL, runStatusTone, runTemplate, ScheduleDetail, TemplateDetail } from './details'
import { CommandsSection } from './CommandsSection'
import '../settings/settings.css'
import './automations.css'

const HOUR_PX = 40
// A run's block takes the edge of its state; a planned one (no run yet) takes a neutral edge.
const RUN_STRIPE: Record<StatusTone, CardLook['stripe']> = { ok: 'ok', info: 'info', warn: 'warn', error: 'warn', off: 'muted' }
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const hhmm = (at: number, locale: Locale) => formatDateTime(at, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function AutomationsView() {
  const t = useT()
  const selected = useStore((s) => s.automations?.selected ?? null)
  const schedules = useStore((s) => s.snapshot!.schedules)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const [week, setWeek] = useState(0)
  // Re-render each minute so the now line and planned runs move on.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.modal, input, textarea, select')) return
      e.preventDefault()
      if (selected) selectAutomation(null)
      else closeAutomations()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const weekStart = startOfWeek(now, week)
  const blocks = useMemo(() => weekBlocks(schedules, occurrences, weekStart, now), [schedules, occurrences, weekStart, now])
  const selectedSchedule = selected?.startsWith('s:') ? selected.slice(2) : null

  return (
    <div className="automations-view">
      <header className="titlebar drag auto-head">
        <span className="auto-title" role="heading" aria-level={1}>
          <Zap size={15} /> {t('automations.title')}
        </span>
        <div className="auto-week-nav">
          <IconButton label={t('automations.week.previous')} onClick={() => setWeek(week - 1)}>
            <ChevronLeft size={14} />
          </IconButton>
          <Button size="sm" disabled={week === 0} onClick={() => setWeek(0)}>
            {t('automations.week.this')}
          </Button>
          <IconButton label={t('automations.week.next')} onClick={() => setWeek(week + 1)}>
            <ChevronRight size={14} />
          </IconButton>
          <span className="muted">{t('automations.week.of', { date: formatDate(weekStart, t.locale, { month: 'long', day: 'numeric' }) })}</span>
        </div>
        <span className="faint small auto-head-hint">{t('automations.week.hint', { zone: ZONE })}</span>
      </header>
      <div className="auto-body">
        <WeekCalendar blocks={blocks} weekStart={weekStart} now={now} selectedSchedule={selectedSchedule} empty={!schedules.length} />
        <aside className="auto-side" aria-label={t('automations.side.label')}>{selected ? <SelectedDetail selected={selected} /> : <TemplateList />}</aside>
      </div>
    </div>
  )
}

function WeekCalendar({ blocks, weekStart, now, selectedSchedule, empty }: { blocks: CalendarBlock[]; weekStart: number; now: number; selectedSchedule: string | null; empty: boolean }) {
  const t = useT()
  const schedules = useStore((s) => s.snapshot!.schedules)
  const names = useMemo(() => new Map(schedules.map((s) => [s.id, s.templateName])), [schedules])
  const scroller = useRef<HTMLDivElement>(null)
  const { first, last } = hourRange(blocks)
  const hours = Array.from({ length: last - first }, (_, i) => first + i)
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart + i * DAY_MS + DAY_MS / 2))
  const today = now >= weekStart && now < startOfWeek(weekStart, 1) ? new Date(now).getDay() : -1
  const top = (at: number) => ((minuteOfDay(at) - first * 60) * HOUR_PX) / 60

  // Open on the first run of the week, or 08:00.
  useLayoutEffect(() => {
    const earliest = Math.min(8 * 60, ...blocks.map((b) => minuteOfDay(b.start)))
    scroller.current?.scrollTo({ top: Math.max(0, ((earliest - first * 60) * HOUR_PX) / 60 - HOUR_PX / 2) })
    // Only when the week changes, not on every snapshot.
  }, [weekStart])

  return (
    <div className="auto-cal">
      <div className="auto-days">
        <span />
        {days.map((d) => (
          <span key={d.getTime()} className={d.getDay() === today ? 'today' : ''}>
            {formatDate(d, t.locale, { weekday: 'short' })} <strong>{d.getDate()}</strong>
          </span>
        ))}
      </div>
      <div className="auto-grid-scroll" ref={scroller}>
        <div className="auto-grid" style={{ height: hours.length * HOUR_PX }}>
          <div className="auto-hours">
            {hours.map((h) => (
              <span key={h} style={{ top: (h - first) * HOUR_PX }}>
                {String(h).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((d, i) => (
            <div key={d.getTime()} className={`auto-col ${d.getDay() === today ? 'today' : ''}`} style={{ backgroundSize: `100% ${HOUR_PX}px` }}>
              {d.getDay() === today && top(now) >= 0 && <div className="auto-now" style={{ top: top(now) }} />}
              {blocks
                .filter((b) => b.day === i)
                .map((b) => {
                  const o = b.occurrence
                  const name = names.get(b.scheduleId) ?? t('automations.cal.deletedSchedule')
                  const status = o ? `${t(RUN_LABEL[o.state])}${o.reason ? ` · ${o.reason}` : ''}` : t('automations.cal.planned')
                  return (
                    <CardButton
                      key={b.id}
                      size="sm"
                      className="auto-block"
                      stripe={o ? RUN_STRIPE[runStatusTone(o)] : 'neutral'}
                      selected={selectedSchedule === b.scheduleId}
                      aria-current={selectedSchedule === b.scheduleId ? 'true' : undefined}
                      style={{
                        top: top(b.start),
                        height: Math.max(20, (b.minutes * HOUR_PX) / 60 - 2),
                        left: `calc(${(b.lane / b.lanes) * 100}% + 3px)`,
                        width: `calc(${100 / b.lanes}% - 6px)`
                      }}
                      title={`${name} · ${hhmm(b.start, t.locale)} · ${status}`}
                      onClick={() => selectAutomation(`s:${b.scheduleId}`)}
                    >
                      <span className="auto-block-name">{name}</span>
                      <span className="auto-block-time">{hhmm(b.start, t.locale)}</span>
                    </CardButton>
                  )
                })}
            </div>
          ))}
        </div>
      </div>
      {empty && (
        <div className="auto-cal-empty">
          <CalendarClock size={20} />
          <strong>{t('automations.cal.emptyTitle')}</strong>
          <span className="muted small">{t('automations.cal.emptyHint')}</span>
        </div>
      )}
    </div>
  )
}

function SelectedDetail({ selected }: { selected: string }) {
  const t = useT()
  const id = selected.slice(2)
  const schedule = useStore((s) => (selected.startsWith('s:') ? s.snapshot!.schedules.find((x) => x.id === id) : undefined))
  const template = useStore((s) =>
    selected.startsWith('t:') ? (s.snapshot!.settings.promptTemplates.find((t) => t.id === id) ?? Object.values(s.snapshot!.repoTemplates).flat().find((t) => t.id === id)) : undefined
  )
  // Deleted elsewhere: back to the list.
  useEffect(() => {
    if (!schedule && !template) selectAutomation(null)
  }, [schedule, template])
  return (
    <>
      <Button size="sm" className="set-back auto-back" icon={<ArrowLeft size={13} />} onClick={() => selectAutomation(null)}>
        {t('automations.templates')}
      </Button>
      {schedule && <ScheduleDetail key={schedule.id} schedule={schedule} />}
      {template && <TemplateDetail key={template.id} template={template} />}
    </>
  )
}

function TemplateList() {
  const t = useT()
  const templates = useSettings().promptTemplates
  const byRepo = useStore((s) => s.snapshot!.repoTemplates)
  const repos = useStore((s) => s.snapshot!.repos)
  const schedules = useStore((s) => s.snapshot!.schedules)
  const missingDefaults = DEFAULT_PROMPT_TEMPLATES.filter((d) => !templates.some((t) => t.id === d.id))
  const count = (id: string) => schedules.filter((s) => s.templateId === id && s.state !== 'finished').length

  const add = () => {
    const id = newTemplateId()
    void saveSettings({ promptTemplates: [...templates, { id, name: t('automations.newTemplateName'), body: '' }] }).then((ok) => ok && selectAutomation(`t:${id}`))
  }

  return (
    <>
      <div className="auto-side-head">
        <span>{t('automations.templates')}</span>
        <span className="auto-side-tools">
          {missingDefaults.length > 0 && (
            <IconButton label={t('automations.restoreDefaults', { names: missingDefaults.map((d) => templateName(d, t)).join(', ') })} onClick={() => void saveSettings({ promptTemplates: [...templates, ...missingDefaults] })}>
              <RotateCcw size={13} />
            </IconButton>
          )}
          <LinkButton size="sm" onClick={add}>
            <Plus size={12} aria-hidden /> {t('automations.newTemplate')}
          </LinkButton>
        </span>
      </div>
      <p className="faint small auto-side-note">
        {t.rich('automations.templatesNote', { placeholder: <code key="placeholder">{'{{placeholder}}'}</code> })}
      </p>
      {templates.length === 0 && <p className="faint small auto-side-note">{t('automations.noTemplates')}</p>}
      {templates.map((x) => (
        <TemplateRow key={x.id} template={x} sub={count(x.id) ? t('automations.scheduleCount', { count: count(x.id) }) : x.body.trim() ? x.body : t('automations.emptyTemplate')} />
      ))}
      {repos
        .filter((r) => byRepo[r.id]?.length)
        .map((r) => (
          <div key={r.id}>
            <div className="auto-side-head sub">{t('automations.fromRepo', { repo: r.name })}</div>
            {byRepo[r.id].map((x) => (
              <TemplateRow key={x.id} template={x} title={qualifiedName(x, templates)} sub={count(x.id) ? t('automations.scheduleCount', { count: count(x.id) }) : x.file ?? ''} />
            ))}
          </div>
        ))}
      <CommandsSection />
    </>
  )
}

function TemplateRow({ template: tpl, title, sub }: { template: PromptTemplate; title?: string; sub: string }) {
  const t = useT()
  const empty = !tpl.body.trim()
  return (
    <ActionRow
      onPress={() => selectAutomation(`t:${tpl.id}`)}
      primaryProps={{ className: 'auto-tpl-main' }}
      actions={
        <>
          <IconButton label={t('automations.schedule')} disabled={empty} onClick={() => openScheduleDialog({ templateId: tpl.id })}>
            <CalendarClock size={13} />
          </IconButton>
          <IconButton label={t('automations.runNowNew')} disabled={empty} onClick={() => runTemplate(tpl)}>
            <Play size={13} />
          </IconButton>
        </>
      }
    >
      <span className="auto-row-title">{title ?? templateName(tpl, t)}</span>
      <span className="auto-row-sub">{sub}</span>
    </ActionRow>
  )
}
