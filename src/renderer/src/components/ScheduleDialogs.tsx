// Schedule… on a template: when it runs, on what, and what a run is allowed to do. Saving is the
// approval. Also the Home card that lists running and upcoming schedules.
import { useId, useMemo, useState } from 'react'
import { modelsFor } from '../../../shared/agents'
import { pickerModels, type HiddenModels } from '../../../shared/modelVisibility'
import type { Locale, PlainKey, TFunction } from '../../../shared/i18n'
import { dateInZone, DEFAULT_MAX_MINUTES, formatRun, MAX_DURATION_CHOICES, nextRuns, parseDate, previewRuns, specProblem, weekdayShort, weekdaysText } from '../../../shared/schedule'
import { t as storeT, useT } from '../i18n'
import { api, attempt, openScheduleDialog, selectWorkspace, timeAgo, uiLocale, useStore } from '../store'
import type { AfterRun, Occurrence, Schedule } from '../../../shared/types'
import { Button, Callout, Checkbox, ChipButton, Dialog, Field, LinkButton, RadioList, Select, Tag, TextInput } from '../ui'
import { LimitResumeRows, useLimitResumes } from './LimitResume'

const NO_HIDDEN: HiddenModels = {}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function zones(current: string): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  const all = new Set([current, ...list])
  return [...all]
}

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const REPEAT_OPTIONS: { value: Schedule['recurrence']; label: PlainKey }[] = [
  { value: 'once', label: 'scheduleDialog.repeat.once' }, { value: 'hourly', label: 'scheduleDialog.repeat.hourly' }, { value: 'daily', label: 'scheduleDialog.repeat.daily' },
  { value: 'weekly', label: 'scheduleDialog.repeat.weekly' }, { value: 'monthly', label: 'scheduleDialog.repeat.monthly' }
]

function tomorrowInZone(zone: string): string {
  const today = dateInZone(Date.now(), zone)
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

const ORDINAL_KEYS = { one: 'schedule.ordinal.one', two: 'schedule.ordinal.two', few: 'schedule.ordinal.few', other: 'schedule.ordinal.other' } as const

/** "1st", "22nd": the form comes from the language's ordinal rules. */
function ordinal(day: number, t: TFunction, locale: Locale): string {
  const form = new Intl.PluralRules(locale, { type: 'ordinal' }).select(day)
  return t(form === 'one' || form === 'two' || form === 'few' ? ORDINAL_KEYS[form] : ORDINAL_KEYS.other, { day })
}

export function nextPill(at: number, zone: string, locale: Locale = uiLocale()): string {
  if (locale !== 'en') return new Intl.DateTimeFormat(locale, { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  return `${parts.day} ${parts.month} · ${parts.hour}:${parts.minute}`
}

export function ScheduleDialog(props: { templateId: string } | { scheduleId: string }) {
  const t = useT()
  const uid = useId()
  const snapshot = useStore((s) => s.snapshot!)
  const existing = 'scheduleId' in props ? snapshot.schedules.find((s) => s.id === props.scheduleId) : undefined
  const templateId = existing?.templateId ?? ('templateId' in props ? props.templateId : '')
  const template =
    snapshot.settings.promptTemplates.find((t) => t.id === templateId) ?? Object.values(snapshot.repoTemplates).flat().find((t) => t.id === templateId)
  const fixedRepo = template?.source === 'repo' ? template.repoId : undefined
  const [repoId, setRepoId] = useState(existing?.repoId ?? fixedRepo ?? snapshot.repos[0]?.id ?? '')
  const repo = snapshot.repos.find((r) => r.id === repoId)
  const [base, setBase] = useState(existing?.baseBranch ?? repo?.defaultBranch ?? 'main')
  const [timezone, setTimezone] = useState(existing?.timezone ?? localZone())
  const [startDate, setStartDate] = useState(existing?.state === 'finished' ? tomorrowInZone(timezone) : existing?.startDate ?? tomorrowInZone(timezone))
  const [recurrence, setRecurrence] = useState<Schedule['recurrence']>(existing?.recurrence ?? 'once')
  const [weekdays, setWeekdays] = useState<number[]>(existing?.weekdays ?? [new Date(`${startDate}T00:00:00Z`).getUTCDay()])
  const [dayOfMonth, setDayOfMonth] = useState(existing?.dayOfMonth ?? parseDate(startDate)?.d ?? 1)
  const [weekdaysEdited, setWeekdaysEdited] = useState(Boolean(existing))
  const [monthDayEdited, setMonthDayEdited] = useState(Boolean(existing?.dayOfMonth))
  const [time, setTime] = useState(existing?.time ?? '09:00')
  // G1 (O8): models hidden from the picker are left out here too; a schedule's saved model always stays.
  const hidden = snapshot.settings.hiddenModels ?? NO_HIDDEN
  const claude = pickerModels(modelsFor('claude'), hidden, existing?.model ? { agent: 'claude', model: existing.model } : undefined).shown
  const [model, setModel] = useState(existing?.model ?? claude.find((m) => m.id.includes('sonnet'))?.id ?? claude[0]?.id ?? '')
  const [maxMinutes, setMaxMinutes] = useState(existing?.maxMinutes ?? DEFAULT_MAX_MINUTES)
  const [afterRun, setAfterRun] = useState<AfterRun>(existing?.afterRun ?? 'keep')
  const [afterRunDeleteBranch, setAfterRunDeleteBranch] = useState(Boolean(existing?.afterRunDeleteBranch))
  const [busy, setBusy] = useState(false)
  const close = () => openScheduleDialog(null)
  const changeStartDate = (value: string) => {
    setStartDate(value)
    const date = parseDate(value)
    if (!date) return
    if (!weekdaysEdited) setWeekdays([new Date(`${value}T00:00:00Z`).getUTCDay()])
    if (!monthDayEdited) setDayOfMonth(date.d)
  }
  const spec = { recurrence, startDate, weekdays, dayOfMonth, time, timezone }
  const specError = specProblem(spec, t)
  const problem = specError ?? (recurrence === 'once' && !nextRuns(spec, Date.now(), 1).length ? t('scheduleDialog.problem.pastOnce') : null)
  const preview = useMemo(() => (problem ? [] : previewRuns(spec, Date.now(), 3, t, t.locale)), [problem, recurrence, startDate, weekdays, dayOfMonth, time, timezone, t]) // eslint-disable-line react-hooks/exhaustive-deps
  const repeatHint = t(({
    once: 'scheduleDialog.hint.once',
    hourly: 'scheduleDialog.hint.hourly',
    daily: 'scheduleDialog.hint.daily',
    weekly: 'scheduleDialog.hint.weekly',
    monthly: 'scheduleDialog.hint.monthly'
  } as const satisfies Record<Schedule['recurrence'], PlainKey>)[recurrence])
  const placeholders = template ? /\{\{[^}]+\}\}/.test(template.body) : false
  if (!template) return null

  const changed = existing?.pausedKind === 'changed' || existing?.pausedKind === 'failures'
  const ready = !problem && !placeholders && Boolean(repo) && Boolean(model) && Boolean(base.trim()) && !busy
  const save = async () => {
    setBusy(true)
    const done = await attempt(async () => {
      await api.saveSchedule({ templateId, templateName: template.name, repoId, baseBranch: base, recurrence, startDate, weekdays, dayOfMonth, time, timezone, agent: 'claude', model, maxMinutes, afterRun, afterRunDeleteBranch: afterRun !== 'keep' && afterRunDeleteBranch }, existing?.id)
      return true
    })
    setBusy(false)
    if (done) close()
  }

  const codex = pickerModels(modelsFor('codex'), hidden).shown
  const weekdayLabel = `${uid}-weekdays`
  return (
    <Dialog
      title={t('scheduleDialog.title', { name: template.name })}
      onClose={close}
      size="lg"
      className="dlg schedule-modal"
      headerExtra={<span className="faint small">{t('scheduleDialog.onlyWhileOpen')}</span>}
      footer={
        <>
          {existing && (
            <Button
              variant="danger"
              className="dlg-start"
              disabled={busy}
              onClick={() => void attempt(async () => (await api.deleteSchedule(existing.id), openScheduleDialog(null), true))}
            >
              {t('scheduleDialog.delete')}
            </Button>
          )}
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void save()}>
            {changed ? t('scheduleDialog.reapprove') : existing?.state === 'finished' ? t('scheduleDialog.scheduleAgain') : existing ? t('scheduleDialog.saveApprove') : t('scheduleDialog.approve')}
          </Button>
        </>
      }
    >
      {existing?.pausedReason && (
        <Callout tone="error" role="alert">
          {existing.pausedReason}
        </Callout>
      )}
      {placeholders && (
        <Callout tone="error" role="alert">
          {t('scheduleDialog.placeholders', { placeholders: '{{placeholders}}' })}
        </Callout>
      )}
      <div className="schedule-row">
        <Field label={t('scheduleDialog.starts')}>{(control) => <TextInput {...control} type="date" width={165} value={startDate} onChange={(e) => changeStartDate(e.target.value)} />}</Field>
        <Field label={t('scheduleDialog.time')}>{(control) => <TextInput {...control} type="time" width={115} value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        <Field label={t('scheduleDialog.timezone')} className="schedule-grow">
          {(control) => <Select {...control} className="dlg-fill" value={timezone} onChange={setTimezone} options={zones(timezone).map((z) => ({ value: z, label: z }))} />}
        </Field>
      </div>
      <Field label={t('scheduleDialog.repeat')}>
        {(control) => <Select {...control} width={165} value={recurrence} onChange={setRecurrence} options={REPEAT_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))} />}
      </Field>
      {recurrence === 'weekly' && (
        <div className="dlg-group" role="group" aria-labelledby={weekdayLabel}>
          <span id={weekdayLabel} className="dlg-label">
            {t('scheduleDialog.on')}
          </span>
          <div className="weekday-row">
            {DAY_ORDER.map((d) => (
              <ChipButton key={d} pressed={weekdays.includes(d)} onClick={() => (setWeekdaysEdited(true), setWeekdays((now) => (now.includes(d) ? now.filter((x) => x !== d) : [...now, d])))}>
                {weekdayShort(d, t.locale)}
              </ChipButton>
            ))}
          </div>
        </div>
      )}
      {recurrence === 'monthly' && (
        <Field label={t('scheduleDialog.onDay')}>
          {(control) => (
            <Select
              {...control}
              width={90}
              value={String(dayOfMonth)}
              onChange={(value) => (setMonthDayEdited(true), setDayOfMonth(Number(value)))}
              options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1, t, t.locale) }))}
            />
          )}
        </Field>
      )}
      <div className="faint small schedule-cadence-hint">{repeatHint}</div>
      <div className="dlg-group">
        <span className="dlg-label">{recurrence === 'once' ? t('scheduleDialog.nextRun') : t('scheduleDialog.nextRuns')}</span>
        {problem ? (
          <div className="faint small">{problem}</div>
        ) : (
          <div className="cron-preview">
            {preview.map((p) => (
              <span key={p.at}>
                {p.label} {p.note && <span className="faint">{p.note}</span>}
              </span>
            ))}
          </div>
        )}
        {recurrence !== 'hourly' && recurrence !== 'once' && <small className="dlg-hint">{t('scheduleDialog.dstNote')}</small>}
      </div>
      <div className="schedule-row">
        <Field label={t('scheduleDialog.repoBase')} className="schedule-grow">
          {(control) => (
            <span className="schedule-pair">
              <Select
                {...control}
                value={repoId}
                disabled={Boolean(fixedRepo)}
                onChange={(id) => (setRepoId(id), setBase(snapshot.repos.find((r) => r.id === id)?.defaultBranch ?? 'main'))}
                options={snapshot.repos.map((r) => ({ value: r.id, label: r.name }))}
              />
              <TextInput value={base} aria-label={t('scheduleDialog.baseBranch')} onChange={(e) => setBase(e.target.value)} />
            </span>
          )}
        </Field>
        <Field label={t('scheduleDialog.model')} className="schedule-grow">
          {(control) => (
            <Select
              {...control}
              className="dlg-fill"
              value={model}
              onChange={setModel}
              options={[
                ...claude.map((m) => ({ value: m.id, label: t('scheduleDialog.modelClaude', { model: m.label }) })),
                ...codex.map((m) => ({ value: m.id, label: t('scheduleDialog.modelNoApprovals', { model: m.label }), disabled: true }))
              ]}
            />
          )}
        </Field>
        <Field label={t('scheduleDialog.maxDuration')}>
          {(control) => (
            <Select
              {...control}
              value={String(maxMinutes)}
              onChange={(value) => setMaxMinutes(Number(value))}
              options={[...new Set([...MAX_DURATION_CHOICES, maxMinutes])]
                .sort((a, b) => a - b)
                .map((m) => ({ value: String(m), label: m >= 60 ? t('scheduleDialog.durationHours', { hours: m / 60 }) : t('scheduleDialog.durationMinutes', { minutes: m }) }))}
            />
          )}
        </Field>
      </div>
      <div className="schedule-after">
        <RadioList<AfterRun>
          legend={t('scheduleDialog.afterRun')}
          value={afterRun}
          onChange={setAfterRun}
          options={[
            { value: 'keep', label: t('scheduleDialog.afterRun.keep'), description: t('scheduleDialog.afterRun.keepHint') },
            { value: 'archive', label: t('scheduleDialog.afterRun.archive'), description: t('scheduleDialog.afterRun.archiveHint') },
            { value: 'delete-unchanged', label: t('scheduleDialog.afterRun.deleteUnchanged'), description: t('scheduleDialog.afterRun.deleteUnchangedHint') }
          ]}
        />
        {afterRun !== 'keep' && (
          <Checkbox checked={afterRunDeleteBranch} onChange={(e) => setAfterRunDeleteBranch(e.target.checked)}>
            {t('scheduleDialog.afterRun.deleteBranch')}
          </Checkbox>
        )}
      </div>
      <Callout>
        <div>{t.rich('scheduleDialog.rules.run', { freshWorkspace: <b>{t('scheduleDialog.rules.freshWorkspace')}</b>, auto: <b>{t('scheduleDialog.rules.auto')}</b>, stopsTheRun: <b>{t('scheduleDialog.rules.stopsTheRun')}</b> })}</div>
        <div>{t('scheduleDialog.rules.limits')}</div>
        <div>{t('scheduleDialog.rules.pauses')}</div>
      </Callout>
    </Dialog>
  )
}

const ACTIVE = ['starting', 'running']

function runningFor(schedule: Schedule, occurrences: Occurrence[]): Occurrence | undefined {
  return occurrences.find((o) => o.scheduleId === schedule.id && ACTIVE.includes(o.state))
}

/** The newest finished run that still needs a look: stopped for you, timed out, uncertain, or failed. */
function attentionFor(schedule: Schedule, occurrences: Occurrence[]): Occurrence | undefined {
  const last = [...occurrences].reverse().find((o) => o.scheduleId === schedule.id && o.state !== 'skipped')
  return last && ['needs-you', 'uncertain', 'failed', 'timed-out'].includes(last.state) && last.workspaceId ? last : undefined
}

const STATE_LABEL: Partial<Record<Occurrence['state'], PlainKey>> = { 'needs-you': 'scheduledCard.state.needsYou', uncertain: 'scheduledCard.state.uncertain', failed: 'scheduledCard.state.failed', 'timed-out': 'scheduledCard.state.timedOut' }

/** "Every day at 09:00"; components pass useT()'s t and t.locale. */
export function cadenceText(s: Schedule, t: TFunction = storeT, locale: Locale = uiLocale()): string {
  switch (s.recurrence) {
    case 'once': return t('schedule.cadence.once', { date: s.startDate, time: s.time })
    case 'hourly': return t('schedule.cadence.hourly', { minute: s.time.slice(3) })
    case 'daily': return t('schedule.cadence.daily', { time: s.time })
    case 'weekly': {
      if (s.weekdays.length === 7) return t('schedule.cadence.daily', { time: s.time })
      if (s.weekdays.length === 5 && s.weekdays.every((d) => d >= 1 && d <= 5)) return t('schedule.cadence.weekdays', { time: s.time })
      return t('schedule.cadence.weekly', { days: weekdaysText(s.weekdays, t, locale), time: s.time })
    }
    case 'monthly': return t((s.dayOfMonth ?? 1) > 28 ? 'schedule.cadence.monthlyLate' : 'schedule.cadence.monthly', { day: ordinal(s.dayOfMonth ?? 1, t, locale), time: s.time })
  }
}

/** Home's Scheduled card: what is running, what is next, and what is paused and why. */
export function ScheduledCard({ repoId }: { repoId?: string }) {
  const t = useT()
  const { schedules, occurrences, workspaces, repos } = useStore((s) => s.snapshot!)
  const repoNames = useMemo(() => new Map(repos.map((r) => [r.id, r.name])), [repos])
  const mine = schedules.filter((s) => !repoId || s.repoId === repoId)
  // #11: armed usage-limit resumes are listed here too, first.
  const resumes = useLimitResumes(repoId)
  if (!mine.length && !resumes.length) return null
  return (
    <section className="home-card">
      <header className="home-card-head">
        <span className="home-card-title">{t('scheduledCard.title')}</span>
        <span className="home-card-hint">{t('scheduledCard.hint')}</span>
      </header>
      <LimitResumeRows sessions={resumes} />
      {mine.map((s) => {
        const run = runningFor(s, occurrences)
        const attention = attentionFor(s, occurrences)
        const last = [...occurrences].reverse().find((o) => o.scheduleId === s.id)
        const ageOccurrence = attention ?? (s.state === 'finished' ? last : undefined)
        const ws = workspaces.find((w) => w.id === (run ?? attention)?.workspaceId)
        const nextAt = s.nextRunAt ? Date.parse(s.nextRunAt) : undefined
        const next = nextAt === undefined ? s.state === 'finished' ? t('scheduledCard.finished') : t('scheduledCard.paused') : nextPill(nextAt, s.timezone, t.locale)
        const lastLabel = STATE_LABEL[last?.state ?? 'completed']
        const finishedStatus = last?.state === 'skipped' ? t('scheduledCard.state.missed') : last?.state === 'completed' ? t('scheduledCard.state.completed') : last?.state === 'cancelled' ? t('scheduledCard.state.stopped') : lastLabel ? t(lastLabel) : t('scheduledCard.state.finished')
        const sub = [repoNames.get(s.repoId), cadenceText(s, t, t.locale), s.timezone, t('scheduledCard.upTo', { minutes: s.maxMinutes })].filter(Boolean).join(' · ')
        const attentionLabel = attention ? STATE_LABEL[attention.state] : undefined
        return (
          <div key={s.id} className="home-row">
            <Tag
              className="card-row-tag"
              tone={run ? 'info' : attention || (s.state === 'finished' && last?.state === 'skipped') ? 'warn' : 'neutral'}
              title={nextAt === undefined || run || attention ? undefined : formatRun(nextAt, s.timezone, t.locale)}
            >
              {run ? t('scheduledCard.state.running') : attention ? attentionLabel && t(attentionLabel) : s.state === 'finished' ? finishedStatus : next}
            </Tag>
            <div className="home-row-main">
              <div className="home-row-title">
                <span className="home-row-name">{s.templateName}</span>
                {ws && <span className="home-row-branch">{ws.name}</span>}
              </div>
              <div className="home-row-sub">
                {run
                  ? t('scheduledCard.runningFor', { minutes: Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt ?? run.plannedAt)) / 60_000)), max: s.maxMinutes })
                  : attention
                    ? attention.reason
                    : s.state === 'paused'
                      ? s.pausedReason
                      : s.state === 'finished'
                        ? `${last?.reason ?? finishedStatus} · ${sub}`
                      : sub}
              </div>
            </div>
            <span className="home-row-age">{run ? t('scheduledCard.now') : s.state === 'paused' ? t('scheduledCard.paused') : ageOccurrence?.endedAt ? timeAgo(ageOccurrence.endedAt) : ''}</span>
            <div className="home-row-actions">
              {run ? (
                <Button size="sm" onClick={() => void attempt(() => api.stopScheduledRun(run.id))}>
                  {t('common.stop')}
                </Button>
              ) : (
                <>
                  {attention?.workspaceId && (
                    <Button size="sm" onClick={() => selectWorkspace(attention.workspaceId!)}>
                      {t('scheduledCard.review')}
                    </Button>
                  )}
                  {s.state === 'paused' ? (
                    <Button size="sm" onClick={() => openScheduleDialog({ scheduleId: s.id })}>
                      {t('scheduledCard.reviewEllipsis')}
                    </Button>
                  ) : (
                    <>
                      <LinkButton size="sm" onClick={() => openScheduleDialog({ scheduleId: s.id })}>
                        {s.state === 'finished' ? t('scheduleDialog.scheduleAgain') : t('common.edit')}
                      </LinkButton>
                      {s.state === 'finished' ? (
                        <LinkButton size="sm" onClick={() => void attempt(() => api.deleteSchedule(s.id))}>
                          {t('common.delete')}
                        </LinkButton>
                      ) : (
                        <LinkButton size="sm" onClick={() => void attempt(() => api.pauseSchedule(s.id))}>
                          {t('scheduledCard.pause')}
                        </LinkButton>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}
