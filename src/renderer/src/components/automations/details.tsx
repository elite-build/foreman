// Automations' details: the side panel (every schedule, or one schedule) and a template's own page.
import { ArrowLeft, CalendarClock, Copy, ExternalLink, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import type { PlainKey } from '../../../../shared/i18n'
import { newTemplateId, templateName } from '../../../../shared/promptTemplates'
import { formatRun, isProposedSchedule, nextRuns, scheduleName } from '../../../../shared/schedule'
import type { Occurrence, PromptTemplate, Schedule } from '../../../../shared/types'
import { t as tNow, useT } from '../../i18n'
import { api, attempt, getState, openNewWorkspace, openScheduleDialog, recordMilestone, selectAutomation, selectWorkspace, showToast, timeAgo, useStore } from '../../store'
import { liveRepo } from '../../triage'
import { ActionRow, Button, Callout, Card, IconButton, LinkButton, MenuButton, MenuItem, Status, type StatusTone } from '../../ui'
import { cadenceText } from '../ScheduleDialogs'
import { saveSettings, useSettings } from '../settings/controls'
import { TemplateEditor } from './TemplateEditor'

export const RUN_LABEL: Record<Occurrence['state'], PlainKey> = {
  starting: 'automations.run.starting',
  running: 'automations.run.running',
  completed: 'automations.run.completed',
  failed: 'automations.run.failed',
  'needs-you': 'automations.run.needsYou',
  cancelled: 'automations.run.cancelled',
  'timed-out': 'automations.run.timedOut',
  skipped: 'automations.run.skipped',
  uncertain: 'automations.run.uncertain'
}

/** A run's state as a colour class; `runStatusTone` gives the same state as a `Status` tone. */
export function runTone(o: Occurrence): string {
  if (o.state === 'completed') return 'green'
  if (o.state === 'running' || o.state === 'starting') return 'blue'
  if (o.state === 'cancelled' || o.state === 'skipped') return ''
  return 'amber'
}

const TONE_OF: Record<string, StatusTone> = { green: 'ok', blue: 'info', amber: 'warn', '': 'off' }

/** The run's state as a Status tone (shape and colour), for the dot beside it. */
export const runStatusTone = (o: Occurrence): StatusTone => TONE_OF[runTone(o)]

/** "Run now": a New workspace dialog with the template filled in, in the repo in view. */
export function runTemplate(t: PromptTemplate): void {
  const s = getState()
  const repoId = t.repoId ?? liveRepo(s.snapshot!, s.sidebarView.repo) ?? s.snapshot!.repos[0]?.id
  if (!repoId) return showToast(tNow('automations.addRepoFirst'))
  // Get started: Run now counts as trying Automations.
  recordMilestone('automation')
  openNewWorkspace(repoId, t.body, t.id)
}

/** A template's own page, filling the Automations area: the prompt and its options on the left; the actions, schedules
 * and recent runs on the right (under it when the area is narrow). */
export function TemplatePage({ template }: { template: PromptTemplate }) {
  const t = useT()
  const templates = useSettings().promptTemplates
  const repoName = useStore((s) => s.snapshot!.repos.find((r) => r.id === template.repoId)?.name)
  const allSchedules = useStore((s) => s.snapshot!.schedules)
  const schedules = allSchedules.filter((x) => x.templateId === template.id)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const ids = new Set(schedules.map((s) => s.id))
  const runs = occurrences.filter((o) => ids.has(o.scheduleId)).slice(-8).reverse()
  const personal = template.source !== 'repo'
  const empty = !template.body.trim()
  const name = templateName(template, t)

  const duplicate = () => {
    const id = newTemplateId()
    const copy: PromptTemplate = { ...template, id, name: t('automations.page.copyName', { name }) }
    void saveSettings({ promptTemplates: [...templates, copy] }).then((ok) => ok && selectAutomation(`t:${id}`))
  }
  const remove = () => {
    void saveSettings({ promptTemplates: templates.filter((x) => x.id !== template.id) })
    selectAutomation(null)
  }

  return (
    <div className="auto-page-scroll">
      <div className="auto-page">
        <div className="auto-page-main">
          <Button variant="ghost" size="sm" className="auto-page-back" icon={<ArrowLeft size={13} />} title={t('automations.page.backTitle')} onClick={() => selectAutomation(null)}>
            {t('automations.templates')}
          </Button>
          <div className="auto-eyebrow">{personal ? t('automations.template.personal') : repoName ? t('automations.template.fromRepo', { repo: repoName }) : t('automations.template.fromSomeRepo')}</div>
          <h1 className="auto-page-title">{name}</h1>
          {personal ? (
            <TemplateEditor
              template={template}
              autoFocus={template.name === t('automations.newTemplateName') && empty}
              promptRows={14}
              onChange={(patch) => void saveSettings({ promptTemplates: templates.map((x) => (x.id === template.id ? { ...x, ...patch } : x)) })}
            />
          ) : (
            <div className="set-card tpl-card">
              <pre className="tpl-body faint small">{template.body}</pre>
              <p className="faint small">
                {t('automations.template.repoNote', { file: template.file ?? '', rev: template.rev?.slice(0, 7) ?? '' })}
              </p>
            </div>
          )}
        </div>

        <div className="auto-page-side">
          <div className="auto-detail-actions">
            <Button variant="primary" size="sm" icon={<Play size={12} />} disabled={empty} onClick={() => runTemplate(template)}>
              {t('automations.template.runNow')}
            </Button>
            <Button size="sm" icon={<CalendarClock size={12} />} disabled={empty} title={t('automations.template.scheduleTitle')} onClick={() => openScheduleDialog({ templateId: template.id })}>
              {t('automations.schedule')}
            </Button>
            {personal && (
              <MenuButton look="icon" label={t('automations.page.more', { name })} trigger={<MoreHorizontal size={14} />}>
                <MenuItem icon={<Copy size={14} />} onSelect={duplicate}>
                  {t('automations.page.duplicate')}
                </MenuItem>
                <MenuItem icon={<Trash2 size={14} />} variant="danger" onSelect={remove}>
                  {t('common.delete')}
                </MenuItem>
              </MenuButton>
            )}
          </div>

          <h2 className="auto-h2">{t('automations.template.schedules')}</h2>
          {schedules.length ? (
            <Card className="auto-list" role="list" aria-label={t('automations.template.schedules')}>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} schedule={s} occurrences={occurrences} />
              ))}
            </Card>
          ) : (
            <p className="faint small">{empty ? t('automations.template.writeFirst') : t('automations.template.notScheduled')}</p>
          )}

          {schedules.length > 0 && (
            <>
              <h2 className="auto-h2">{t('automations.schedule.recentRuns')}</h2>
              <RunList runs={runs} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** With nothing selected: every schedule, active ones soonest first, then paused, then finished. */
export function ScheduleOverview() {
  const t = useT()
  const schedules = useStore((s) => s.snapshot!.schedules)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const rank = (s: Schedule) => (s.state === 'active' ? 0 : s.state === 'paused' ? 1 : 2)
  const sorted = [...schedules].sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
  return (
    <div className="auto-detail">
      <h2 className="auto-h2">{t('automations.template.schedules')}</h2>
      {sorted.length ? (
        <Card className="auto-list" role="list" aria-label={t('automations.template.schedules')}>
          {sorted.map((s) => (
            <ScheduleRow key={s.id} schedule={s} occurrences={occurrences} named />
          ))}
        </Card>
      ) : (
        <p className="faint small">{t('automations.overview.empty')}</p>
      )}
    </div>
  )
}

/** A schedule in a list: its cadence and what's next. `named` leads with the template's name, for a list of every schedule. */
function ScheduleRow({ schedule: s, occurrences, named }: { schedule: Schedule; occurrences: Occurrence[]; named?: boolean }) {
  const t = useT()
  const last = [...occurrences].reverse().find((o) => o.scheduleId === s.id && o.state !== 'skipped')
  const cadence = cadenceText(s, t, t.locale)
  // An outside agent's proposal waits for you: it says who proposed it, with the action that reviews and approves it.
  const proposal = isProposedSchedule(s)
  const when = proposal ? t('automations.schedule.proposedBy', { name: s.proposedBy?.name ?? '' }) : s.state === 'paused' ? s.pausedReason ?? t('automations.schedule.paused') : s.state === 'finished' ? t('automations.schedule.finished') : s.nextRunAt ? t('automations.schedule.next', { time: formatRun(Date.parse(s.nextRunAt), s.timezone, t.locale) }) : ''
  return (
    <ActionRow
      role="listitem"
      divided
      onPress={() => selectAutomation(`s:${s.id}`)}
      primaryProps={{ className: 'auto-row' }}
      actions={proposal ? <Button size="sm" onClick={() => openScheduleDialog({ scheduleId: s.id })}>{t('automations.schedule.reviewProposal')}</Button> : undefined}
    >
      <span className="auto-row-main">
        <span className="auto-row-title">{named ? scheduleName(s) : cadence}</span>
        <span className="auto-row-sub">{named ? [cadence, when].filter(Boolean).join(' · ') : when}</span>
      </span>
      {last && <Status compact tone={runStatusTone(last)} label={t('automations.schedule.lastRun', { state: t(RUN_LABEL[last.state]) })} title={t('automations.schedule.lastRun', { state: t(RUN_LABEL[last.state]) })} />}
    </ActionRow>
  )
}

export function ScheduleDetail({ schedule: s }: { schedule: Schedule }) {
  const t = useT()
  const repo = useStore((st) => st.snapshot!.repos.find((r) => r.id === s.repoId))
  const occurrences = useStore((st) => st.snapshot!.occurrences)
  const template = useStore((st) => st.snapshot!.settings.promptTemplates.find((t) => t.id === s.templateId) ?? Object.values(st.snapshot!.repoTemplates).flat().find((t) => t.id === s.templateId))
  const runs = occurrences.filter((o) => o.scheduleId === s.id).slice(-8).reverse()
  const running = runs.find((o) => o.state === 'running' || o.state === 'starting')
  const upcoming = s.state === 'active' ? nextRuns(s, Date.now(), 4) : []
  const proposal = isProposedSchedule(s)
  return (
    <div className="auto-detail">
      <div className="auto-eyebrow">{t('automations.schedule.eyebrow')}</div>
      <h1>{scheduleName(s)}</h1>
      <div className="muted">{cadenceText(s, t, t.locale)}</div>
      <div className="auto-detail-actions">
        {running ? (
          <Button size="sm" onClick={() => void attempt(() => api.stopScheduledRun(running.id))}>
            {t('automations.schedule.stopRun')}
          </Button>
        ) : s.state === 'active' ? (
          <Button size="sm" icon={<Pause size={12} />} onClick={() => void attempt(() => api.pauseSchedule(s.id))}>
            {t('automations.schedule.pause')}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => openScheduleDialog({ scheduleId: s.id })}>
          {proposal ? t('automations.schedule.reviewProposal') : s.state === 'paused' ? t('automations.schedule.review') : s.state === 'finished' ? t('automations.schedule.again') : t('automations.schedule.edit')}
        </Button>
        {s.state !== 'active' && (
          <LinkButton danger onClick={() => void attempt(async () => (await api.deleteSchedule(s.id), selectAutomation(null), true))}>
            {t('common.delete')}
          </LinkButton>
        )}
      </div>

      {proposal ? (
        <Callout tone="warn" role="status">
          {t('automations.schedule.proposedBanner', { name: s.proposedBy?.name ?? '' })}
        </Callout>
      ) : s.state === 'paused' && (
        <Callout tone="warn" role="status">
          {s.pausedReason ?? t('automations.schedule.pausedBanner')} {t('automations.schedule.reviewHint')}
        </Callout>
      )}

      <dl className="auto-facts">
        <dt>{t('automations.schedule.repository')}</dt>
        <dd>{repo?.name ?? t('automations.schedule.repoRemoved')}</dd>
        <dt>{t('automations.schedule.from')}</dt>
        <dd>{s.baseBranch}</dd>
        {s.flow ? (
          <>
            <dt>{t('automations.schedule.flow')}</dt>
            <dd>{s.flow.flowName}</dd>
          </>
        ) : (
          <>
            <dt>{t('automations.schedule.stopsAfter')}</dt>
            <dd>{t('automations.schedule.minutes', { minutes: s.maxMinutes })}</dd>
          </>
        )}
        <dt>{t('automations.schedule.afterRun')}</dt>
        <dd>{t(s.afterRun === 'archive' ? 'scheduleDialog.afterRun.archive' : s.afterRun === 'delete-unchanged' ? 'scheduleDialog.afterRun.deleteUnchanged' : 'scheduleDialog.afterRun.keep')}</dd>
        <dt>{t('automations.schedule.timeZone')}</dt>
        <dd>{s.timezone}</dd>
        {template && (
          <>
            <dt>{t('automations.schedule.template')}</dt>
            <dd>
              <LinkButton onClick={() => selectAutomation(`t:${template.id}`)}>{templateName(template, t)}</LinkButton>
            </dd>
          </>
        )}
      </dl>

      {upcoming.length > 0 && (
        <>
          <h2 className="auto-h2">{t('automations.schedule.nextRuns')}</h2>
          <Card className="auto-list">
            {upcoming.map((at) => (
              <div key={at} className="auto-run">
                <Status compact tone="info" label={t('automations.cal.planned')} />
                <span>{formatRun(at, s.timezone, t.locale)}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <h2 className="auto-h2">{t('automations.schedule.recentRuns')}</h2>
      <RunList runs={runs} />
    </div>
  )
}

/** Runs, newest first: each one's state, why it ended, when, and its workspace while that's still there. */
function RunList({ runs }: { runs: Occurrence[] }) {
  const t = useT()
  const workspaces = useStore((st) => st.snapshot!.workspaces)
  if (!runs.length) return <p className="faint small">{t('automations.schedule.noRuns')}</p>
  return (
    <Card className="auto-list">
      {runs.map((o) => {
        const ws = workspaces.find((w) => w.id === o.workspaceId && w.state !== 'archived')
        return (
          <div key={o.id} className="auto-run">
            <Status compact tone={runStatusTone(o)} label={t(RUN_LABEL[o.state])} />
            <span className="auto-row-main">
              <span>{t(RUN_LABEL[o.state])}</span>
              {o.reason && <span className="auto-row-sub">{o.reason}</span>}
            </span>
            <span className="faint small">{timeAgo(o.endedAt ?? o.startedAt ?? o.plannedAt)}</span>
            {ws && (
              <IconButton label={t('automations.schedule.openWorkspace', { name: ws.name })} onClick={() => selectWorkspace(ws.id)}>
                <ExternalLink size={12} />
              </IconButton>
            )}
          </div>
        )
      })}
    </Card>
  )
}
