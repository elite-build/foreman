// An employee's triggers (docs/ai-employees.md §5.1, §8). The Triggers tab lists each in words, with what it asks, its
// next planned time (a timed one) and its last firing on this computer ("fired for #42, 10:31", "skipped: chain guard"),
// and a switch that turns it off here (narrowing only: the definition and its approval don't change). The Edit view's
// Triggers section adds, changes and removes them in the definition, each in a dialog: a timed one with a live preview
// of the next three times, an event one with its source, events, repository, branch or memory paths, whose
// pull requests, debounce and what it asks. Saving such a change means approving the employee again, which both say.
// All composed from ui/; feature CSS is layout only.
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { CHAIN_LIMIT, CHAIN_WINDOW_MS } from '../../../../shared/employeeEvents'
import {
  AUTHORED_BY,
  DEFAULT_DEBOUNCE_SECONDS,
  EVENT_SOURCES,
  MAX_DEBOUNCE_SECONDS,
  MAX_TRIGGER_PROMPT,
  MAX_TRIGGERS,
  newTriggerId,
  nextFires,
  PULL_REQUEST_EVENTS,
  triggerKey,
  triggerTimingProblem,
  triggerZone,
  TRIGGER_FLOOR_MINUTES,
  TRIGGER_KINDS,
  WATCHES_REPO,
  type EmployeeTrigger,
  type EventSource,
  type EventTrigger,
  type TimedTrigger,
  type TriggerKind,
  type TriggerMissed,
  type TriggerOverlap
} from '../../../../shared/employeeTriggers'
import type { EmployeeDefinition, EmployeeView } from '../../../../shared/employees'
import type { PlainKey } from '../../../../shared/i18n'
import { formatRun, weekdayShort } from '../../../../shared/schedule'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Callout, Card, Checkbox, ChipButton, Dialog, Field, IconButton, RadioList, Segmented, Select, Switch, Tag, TextArea, TextInput } from '../../ui'
import { DAY_ORDER, localZone, ordinal, REPEAT_OPTIONS, tomorrowInZone, zones } from '../ScheduleDialogs'
import { AUTHORED_LABEL, EVENT_SOURCE_LABEL, PR_EVENT_NAME, triggerAsks, triggerStatus, triggerWhen } from './words'

const KIND_LABEL: Record<TriggerKind, PlainKey> = { cron: 'employees.trigger.kind.cron', interval: 'employees.trigger.kind.interval', schedule: 'employees.trigger.kind.schedule', event: 'employees.trigger.kind.event' }
const MISSED_LABEL: Record<TriggerMissed, PlainKey> = { skip: 'employees.trigger.missed.skip', 'run-once': 'employees.trigger.missed.runOnce' }
const OVERLAP_LABEL: Record<TriggerOverlap, PlainKey> = { skip: 'employees.trigger.overlap.skip', queue: 'employees.trigger.overlap.queue', coalesce: 'employees.trigger.overlap.coalesce' }

/**
 * A trigger's repository and rules, in words: "In foreman-website · missed: skip · while one is going: skip"; an event
 * trigger's debounce instead of the missed rule.
 */
function useRulesText() {
  const t = useT()
  return (trigger: EmployeeTrigger) =>
    [
      trigger.repo ? t('employees.trigger.inRepo', { repo: trigger.repo }) : t('employees.trigger.inDefaultRepo'),
      trigger.kind === 'event' ? t('employees.trigger.debounceRule', { seconds: trigger.debounce }) : t('employees.trigger.missedRule', { rule: t(MISSED_LABEL[trigger.missed]) }),
      t('employees.trigger.overlapRule', { rule: t(OVERLAP_LABEL[trigger.overlap]) })
    ].join(' · ')
}

/** The Triggers tab: each trigger in words, its next time and last firing here, and its switch on this computer. */
export function TriggersTab({ orgId, employee }: { orgId: string; employee: EmployeeView }) {
  const t = useT()
  const states = useStore((s) => s.snapshot!.employeeTriggers ?? [])
  const rules = useRulesText()
  const name = employee.name || employee.id
  const triggers = employee.definition?.triggers ?? []
  if (!triggers.length) return <p className="employee-faint">{t('employees.triggers.none', { name })}</p>
  const held =
    employee.state === 'retired'
      ? t('employees.triggers.heldRetired', { name })
      : employee.state === 'draft'
        ? t('employees.triggers.heldDraft', { name })
        : employee.changed
          ? t('employees.triggers.heldChanged', { name })
          : employee.state === 'paused'
            ? t('employees.triggers.heldPaused', { name })
            : null
  return (
    <div className="employee-triggers">
      {held && (
        <Callout tone="info" role="status">
          {held}
        </Callout>
      )}
      <ul className="employee-trigger-list" aria-label={t('employees.triggers.label', { name })}>
        {triggers.map((trigger) => {
          const id = triggerKey(trigger)
          const state = states.find((s) => s.orgId === orgId && s.employeeId === employee.id && s.triggerId === id)
          const status = triggerStatus(trigger, state, name, t)
          const when = triggerWhen(trigger, t)
          const off = !trigger.enabled ? t('employees.triggers.offInDefinition') : state?.off ? t('employees.triggers.offHere') : undefined
          return (
            <Card as="li" key={id} className="employee-trigger">
              <span className="employee-trigger-text">
                <span className="employee-trigger-when">{when}</span>
                <span>{[triggerAsks(trigger, t), off ?? status.next, status.last].filter(Boolean).join(' · ')}</span>
                <span className="employee-faint">{rules(trigger)}</span>
              </span>
              <Switch
                checked={trigger.enabled && !state?.off}
                disabled={!trigger.enabled || employee.state === 'retired'}
                label={t('employees.triggers.switch', { when })}
                title={trigger.enabled ? t('employees.triggers.switchHint') : t('employees.triggers.offInDefinition')}
                onChange={(on) => void attempt(() => api.setEmployeeTriggerOff(orgId, employee.id, id, !on))}
              />
            </Card>
          )
        })}
      </ul>
      <p className="employee-faint">{t('employees.triggers.switchHint')}</p>
    </div>
  )
}

/** A new trigger: Mondays at 09:00 here, its repository the default, missed and overlapping firings skipped. */
function freshTrigger(taken: string[]): EmployeeTrigger {
  return { id: newTriggerId(taken), kind: 'cron', cron: '0 9 * * 1', timezone: localZone(), missed: 'skip', overlap: 'skip', enabled: true }
}

/**
 * The same trigger as another kind: its prompt, repository and overlap rule kept, the new kind's timing at its usual
 * start; an event trigger starts on a pull request merging in its repository (the first it may use), a minute's debounce.
 */
function asKind(trigger: EmployeeTrigger, kind: TriggerKind, repos: string[]): EmployeeTrigger {
  const { id, prompt, repo, overlap, enabled } = trigger
  const base = { ...(id ? { id } : {}), ...(prompt ? { prompt } : {}), ...(repo ? { repo } : {}), overlap, enabled }
  if (kind === 'event') return { kind, source: 'pull-request', on: ['merged'], debounce: DEFAULT_DEBOUNCE_SECONDS, ...base, ...(repo || repos[0] ? { repo: repo || repos[0] } : {}) }
  const common = { ...base, missed: trigger.kind === 'event' ? ('skip' as const) : trigger.missed }
  const zone = trigger.kind === 'event' ? localZone() : triggerZone(trigger)
  if (kind === 'cron') return { kind, cron: '0 9 * * 1', timezone: zone, ...common }
  if (kind === 'interval') return { kind, every: '2h', timezone: zone, ...common }
  return { kind, recurrence: 'weekly', start_date: tomorrowInZone(zone), time: '09:00', timezone: zone, weekdays: [1], ...common }
}

/** The same event trigger listening to another source: what that source takes, with its usual start. */
function asSource(trigger: EventTrigger, source: EventSource, repos: string[]): EventTrigger {
  const { id, prompt, repo, overlap, enabled, debounce } = trigger
  const base = { ...(id ? { id } : {}), ...(prompt ? { prompt } : {}), overlap, enabled, debounce }
  const watched = repo || repos[0]
  if (source === 'pull-request') return { kind: 'event', source, on: ['merged'], ...base, ...(watched ? { repo: watched } : {}) }
  if (source === 'base-moved') return { kind: 'event', source, ...base, ...(watched ? { repo: watched } : {}) }
  if (source === 'memory') return { kind: 'event', source, paths: ['memory/org/docs/**'], ...base, ...(repo ? { repo } : {}) }
  return { kind: 'event', source, on: ['assigned'], ...base, ...(repo ? { repo } : {}) }
}

/** The Edit view's Triggers section: each trigger in words with Change and Remove, and Add a trigger. */
export function TriggersField({ value, onChange, approved }: { value: EmployeeDefinition; onChange: (next: EmployeeDefinition) => void; approved: boolean }) {
  const t = useT()
  const [editing, setEditing] = useState<{ index: number | null; trigger: EmployeeTrigger } | null>(null)
  const triggers = value.triggers ?? []
  const name = value.name || value.id
  const set = (next: EmployeeTrigger[]) => {
    const { triggers: _old, ...rest } = value
    onChange(next.length ? { ...rest, triggers: next } : rest)
  }
  return (
    <div className="employee-triggers">
      <p className="employee-faint">{approved ? t('employees.triggers.editApproved', { name }) : t('employees.triggers.editHint')}</p>
      {triggers.length > 0 ? (
        <ul className="employee-trigger-list" aria-label={t('employees.triggers.label', { name })}>
          {triggers.map((trigger, i) => {
            const when = triggerWhen(trigger, t)
            return (
              <li key={`${triggerKey(trigger)}-${i}`} className="employee-trigger-row">
                <span className="employee-trigger-text">
                  <span className="employee-trigger-when">{when}</span>
                  <span className="employee-faint">{triggerAsks(trigger, t)}</span>
                </span>
                {!trigger.enabled && <Tag tone="outline">{t('employees.trigger.off')}</Tag>}
                <IconButton label={t('employees.triggers.change', { when })} onClick={() => setEditing({ index: i, trigger })}>
                  <Pencil size={13} />
                </IconButton>
                <IconButton label={t('employees.triggers.remove', { when })} tone="danger" onClick={() => set(triggers.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="employee-faint">{t('employees.triggers.noneEdit')}</p>
      )}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} disabled={triggers.length >= MAX_TRIGGERS} onClick={() => setEditing({ index: null, trigger: freshTrigger(triggers.map(triggerKey)) })}>
          {t('employees.triggers.add')}
        </Button>
      </div>
      {editing && (
        <TriggerDialog
          trigger={editing.trigger}
          repos={Object.entries(value.access.repos)
            .filter(([, access]) => access !== 'none')
            .map(([repo]) => repo)}
          name={name}
          adding={editing.index === null}
          onClose={() => setEditing(null)}
          onDone={(trigger) => {
            set(editing.index === null ? [...triggers, trigger] : triggers.map((x, j) => (j === editing.index ? trigger : x)))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function TriggerDialog({ trigger, repos, name, adding, onDone, onClose }: { trigger: EmployeeTrigger; repos: string[]; name: string; adding: boolean; onDone: (t: EmployeeTrigger) => void; onClose: () => void }) {
  const t = useT()
  const [draft, setDraft] = useState(trigger)
  const problem = triggerTimingProblem(draft, t)
  const repoGone = Boolean(draft.repo && !repos.includes(draft.repo))
  return (
    <Dialog
      title={adding ? t('employees.triggers.addTitle', { name }) : t('employees.triggers.changeTitle', { name })}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={Boolean(problem) || repoGone} onClick={() => onDone(draft)}>
            {t('employees.access.done')}
          </Button>
        </>
      }
    >
      <TriggerForm value={draft} onChange={setDraft} repos={repos} name={name} problem={problem} />
    </Dialog>
  )
}

/** One trigger's fields: its kind, then a timed one's timing or an event one's source and filters, what it asks and its rules. */
export function TriggerForm({ value, onChange, repos, name, problem }: { value: EmployeeTrigger; onChange: (next: EmployeeTrigger) => void; repos: string[]; name: string; problem: string | null }) {
  const t = useT()
  const setCommon = (patch: Partial<Pick<EmployeeTrigger, 'prompt' | 'repo' | 'overlap' | 'enabled'>>) => {
    const next = { ...value, ...patch } as EmployeeTrigger
    for (const key of ['prompt', 'repo'] as const) if (!next[key]) delete next[key]
    onChange(next)
  }
  // A pull-request or base-moved trigger watches its repository, so it names one: no "its first repository" choice.
  const watches = value.kind === 'event' && WATCHES_REPO.includes(value.source)
  return (
    <div className="employee-trigger-form">
      <Segmented<TriggerKind> label={t('employees.trigger.kind')} value={value.kind} onChange={(kind) => kind !== value.kind && onChange(asKind(value, kind, repos))} options={TRIGGER_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))} />
      {value.kind === 'event' ? <EventFields value={value} onChange={onChange} repos={repos} problem={problem} /> : <TimedFields value={value} onChange={onChange} problem={problem} />}
      <Field label={t('employees.trigger.prompt')} description={t('employees.trigger.promptHint')}>
        {(c) => <TextArea {...c} rows={3} value={value.prompt ?? ''} maxLength={MAX_TRIGGER_PROMPT} onChange={(e) => setCommon({ prompt: e.target.value })} />}
      </Field>
      <Field
        label={t('employees.trigger.repo')}
        description={watches ? t('employees.trigger.repoWatched') : undefined}
        error={value.repo && !repos.includes(value.repo) ? t('employees.trigger.repoGone', { repo: value.repo, name }) : undefined}
      >
        {(c) => (
          <Select<string>
            {...c}
            value={value.repo ?? ''}
            onChange={(repo) => setCommon({ repo })}
            options={[...(watches && value.repo ? [] : [{ value: '', label: watches ? t('employees.trigger.repoChoose') : t('employees.trigger.repoDefault') }]), ...[...new Set([...repos, ...(value.repo ? [value.repo] : [])])].map((r) => ({ value: r, label: r }))]}
          />
        )}
      </Field>
      {value.kind !== 'event' && (
        <RadioList
          legend={t('employees.trigger.missed')}
          value={value.missed}
          onChange={(missed) => onChange({ ...value, missed })}
          options={[
            { value: 'skip', label: t('employees.trigger.missed.skip'), description: t('employees.trigger.missed.skipHint', { name }) },
            { value: 'run-once', label: t('employees.trigger.missed.runOnce'), description: t('employees.trigger.missed.runOnceHint', { name }) }
          ]}
        />
      )}
      <RadioList
        legend={t('employees.trigger.overlap')}
        value={value.overlap}
        onChange={(overlap) => setCommon({ overlap })}
        options={[
          { value: 'skip', label: t('employees.trigger.overlap.skip'), description: t('employees.trigger.overlap.skipHint') },
          { value: 'queue', label: t('employees.trigger.overlap.queue'), description: t('employees.trigger.overlap.queueHint') },
          { value: 'coalesce', label: t('employees.trigger.overlap.coalesce'), description: value.kind === 'event' ? t('employees.trigger.overlap.coalesceEventHint') : t('employees.trigger.overlap.coalesceHint') }
        ]}
      />
      <Checkbox checked={value.enabled} onChange={(e) => setCommon({ enabled: e.target.checked })}>
        {t('employees.trigger.enabled')}
      </Checkbox>
    </div>
  )
}

/** An event trigger's own fields: its source, its events, its filters and its debounce, and its guards in words. */
function EventFields({ value, onChange, repos, problem }: { value: EventTrigger; onChange: (next: EmployeeTrigger) => void; repos: string[]; problem: string | null }) {
  const t = useT()
  const eventsLabel = useId()
  const set = (patch: Partial<EventTrigger>) => {
    const next = { ...value, ...patch }
    for (const key of ['branch', 'authored_by', 'team', 'label'] as const) if (!next[key]) delete next[key]
    onChange(next)
  }
  const on = value.on ?? []
  return (
    <>
      <Field label={t('employees.trigger.source')}>
        {(c) => <Select<EventSource> {...c} value={value.source} onChange={(source) => source !== value.source && onChange(asSource(value, source, repos))} options={EVENT_SOURCES.map((s) => ({ value: s, label: t(EVENT_SOURCE_LABEL[s]) }))} />}
      </Field>
      {value.source === 'pull-request' && (
        <>
          <div className="employee-group" role="group" aria-labelledby={eventsLabel}>
            <span id={eventsLabel} className="employee-subheading">
              {t('employees.trigger.on')}
            </span>
            <div className="employee-trigger-when-fields">
              {PULL_REQUEST_EVENTS.map((e) => (
                <Checkbox key={e} checked={on.includes(e)} onChange={(x) => set({ on: x.target.checked ? PULL_REQUEST_EVENTS.filter((y) => y === e || on.includes(y)) : on.filter((y) => y !== e) })}>
                  {t(PR_EVENT_NAME[e])}
                </Checkbox>
              ))}
            </div>
          </div>
          <Field label={t('employees.trigger.branch')} description={t('employees.trigger.branchHint')}>
            {(c) => <TextInput {...c} mono spellCheck={false} value={value.branch ?? ''} onChange={(e) => set({ branch: e.target.value })} />}
          </Field>
          <RadioList
            legend={t('employees.trigger.authoredBy')}
            value={value.authored_by ?? 'anyone'}
            onChange={(authored) => set({ authored_by: authored === 'anyone' ? undefined : authored })}
            options={AUTHORED_BY.map((a) => ({ value: a, label: t(AUTHORED_LABEL[a]) }))}
          />
        </>
      )}
      {value.source === 'memory' && (
        <Field label={t('employees.trigger.paths')} description={t('employees.trigger.pathsHint')}>
          {(c) => <TextArea {...c} rows={3} spellCheck={false} value={(value.paths ?? []).join('\n')} onChange={(e) => set({ paths: e.target.value.split(/\r?\n/) })} />}
        </Field>
      )}
      {value.source === 'linear' && (
        <>
          <p className="employee-faint">{t('employees.trigger.linearHint')}</p>
          <div className="employee-row2">
            <Field label={t('employees.trigger.team')}>{(c) => <TextInput {...c} value={value.team ?? ''} onChange={(e) => set({ team: e.target.value })} />}</Field>
            <Field label={t('employees.trigger.label')}>{(c) => <TextInput {...c} value={value.label ?? ''} onChange={(e) => set({ label: e.target.value })} />}</Field>
          </div>
        </>
      )}
      <Field label={t('employees.trigger.debounce')} description={t('employees.trigger.debounceHint')}>
        {(c) => <TextInput {...c} type="number" width={110} min={0} max={MAX_DEBOUNCE_SECONDS} value={Number.isNaN(value.debounce) ? '' : String(value.debounce)} onChange={(e) => set({ debounce: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />}
      </Field>
      {problem && (
        <p className="employee-faint" role="alert">
          {problem}
        </p>
      )}
      <p className="employee-faint">{t('employees.trigger.eventGuards', { runs: CHAIN_LIMIT, minutes: CHAIN_WINDOW_MS / 60_000 })}</p>
    </>
  )
}

/** A timed trigger's fields: its timing, the next three times or what is wrong, and its time zone. */
function TimedFields({ value, onChange, problem }: { value: TimedTrigger; onChange: (next: EmployeeTrigger) => void; problem: string | null }) {
  const t = useT()
  const weekdayLabel = useId()
  const zone = triggerZone(value)
  const preview = useMemo(() => (problem ? [] : nextFires(value, Date.now(), 3)), [value, problem])
  const every = value.kind === 'interval' ? /^(\d*)\s*([mhd]?)$/.exec(value.every) : null
  const amount = every?.[1] ?? ''
  const unit = every?.[2] || 'm'
  return (
    <>
      {value.kind === 'cron' && (
        <Field label={t('employees.trigger.cron')} description={t('employees.trigger.cronHint')} error={problem ?? undefined}>
          {(c) => <TextInput {...c} mono value={value.cron} spellCheck={false} onChange={(e) => onChange({ ...value, cron: e.target.value })} />}
        </Field>
      )}
      {value.kind === 'interval' && (
        <div className="employee-row2">
          <Field label={t('employees.trigger.every')} error={problem ?? undefined} description={t('employees.trigger.everyHint')}>
            {(c) => <TextInput {...c} type="number" width={110} min={1} value={amount} onChange={(e) => onChange({ ...value, every: `${e.target.value}${unit}` })} />}
          </Field>
          <Field label={t('employees.trigger.unit')}>
            {(c) => (
              <Select<string>
                {...c}
                value={unit}
                onChange={(u) => onChange({ ...value, every: `${amount}${u}` })}
                options={[
                  { value: 'm', label: t('employees.trigger.unit.minutes') },
                  { value: 'h', label: t('employees.trigger.unit.hours') },
                  { value: 'd', label: t('employees.trigger.unit.days') }
                ]}
              />
            )}
          </Field>
        </div>
      )}
      {value.kind === 'schedule' && (
        <>
          <div className="employee-trigger-when-fields">
            <Field label={t('scheduleDialog.repeat')}>
              {(c) => (
                <Select
                  {...c}
                  width={165}
                  value={value.recurrence}
                  onChange={(recurrence) => onChange({ ...value, recurrence, ...(recurrence === 'weekly' && !value.weekdays?.length ? { weekdays: [1] } : {}), ...(recurrence === 'monthly' && value.day_of_month === undefined ? { day_of_month: 1 } : {}) })}
                  options={REPEAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
                />
              )}
            </Field>
            <Field label={t('scheduleDialog.starts')}>{(c) => <TextInput {...c} type="date" width={165} value={value.start_date} onChange={(e) => onChange({ ...value, start_date: e.target.value })} />}</Field>
            <Field label={t('scheduleDialog.time')}>{(c) => <TextInput {...c} type="time" width={115} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />}</Field>
          </div>
          {value.recurrence === 'weekly' && (
            <div className="employee-group" role="group" aria-labelledby={weekdayLabel}>
              <span id={weekdayLabel} className="employee-subheading">
                {t('scheduleDialog.on')}
              </span>
              <div className="employee-trigger-days">
                {DAY_ORDER.map((d) => {
                  const days = value.weekdays ?? []
                  return (
                    <ChipButton key={d} pressed={days.includes(d)} onClick={() => onChange({ ...value, weekdays: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] })}>
                      {weekdayShort(d, t.locale)}
                    </ChipButton>
                  )
                })}
              </div>
            </div>
          )}
          {value.recurrence === 'monthly' && (
            <Field label={t('scheduleDialog.onDay')}>
              {(c) => (
                <Select
                  {...c}
                  width={90}
                  value={String(value.day_of_month ?? 1)}
                  onChange={(day) => onChange({ ...value, day_of_month: Number(day) })}
                  options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: ordinal(i + 1, t, t.locale) }))}
                />
              )}
            </Field>
          )}
        </>
      )}
      <Field label={t('scheduleDialog.timezone')}>
        {(c) => <Select {...c} value={zone} onChange={(timezone) => onChange({ ...value, timezone } as EmployeeTrigger)} options={zones(zone).map((z) => ({ value: z, label: z }))} />}
      </Field>
      <div className="employee-group" role="group" aria-label={t('employees.trigger.preview')}>
        <span className="employee-subheading">{t('employees.trigger.preview')}</span>
        {problem ? (
          value.kind === 'schedule' ? (
            <p className="employee-faint" role="alert">
              {problem}
            </p>
          ) : (
            <p className="employee-faint">{t('employees.trigger.previewNone')}</p>
          )
        ) : preview.length ? (
          <ol className="employee-trigger-preview">
            {preview.map((at) => (
              <li key={at}>{formatRun(at, zone, t.locale)}</li>
            ))}
          </ol>
        ) : (
          <p className="employee-faint">{t('employees.trigger.previewNever')}</p>
        )}
        <p className="employee-faint">{t('employees.trigger.floor', { minutes: TRIGGER_FLOOR_MINUTES })}</p>
      </div>
    </>
  )
}
