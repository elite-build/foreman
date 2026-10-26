// The Automations side panel's detail views: one template, one schedule.
import { CalendarClock, ExternalLink, Pause, Play } from 'lucide-react'
import type { PlainKey } from '../../../../shared/i18n'
import { templateName } from '../../../../shared/promptTemplates'
import { formatRun, nextRuns } from '../../../../shared/schedule'
import type { Occurrence, PromptTemplate, Schedule } from '../../../../shared/types'
import { t as tNow, useT } from '../../i18n'
import { api, attempt, getState, openNewWorkspace, openScheduleDialog, recordMilestone, selectAutomation, selectWorkspace, showToast, timeAgo, useStore } from '../../store'
import { liveRepo } from '../../triage'
import { ActionRow, Button, Callout, Card, IconButton, LinkButton, Status, type StatusTone } from '../../ui'
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

/** A run's colour class: the calendar tints its block by it, and `runStatusTone` gives the same state as a `Status`. */
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

export function TemplateDetail({ template }: { template: PromptTemplate }) {
  const t = useT()
  const templates = useSettings().promptTemplates
  const repoName = useStore((s) => s.snapshot!.repos.find((r) => r.id === template.repoId)?.name)
  const allSchedules = useStore((s) => s.snapshot!.schedules)
  const schedules = allSchedules.filter((x) => x.templateId === template.id)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const personal = template.source !== 'repo'
  const empty = !template.body.trim()
  return (
    <div className="auto-detail">
      <div className="auto-eyebrow">{personal ? t('automations.template.personal') : repoName ? t('automations.template.fromRepo', { repo: repoName }) : t('automations.template.fromSomeRepo')}</div>
      <h1>{templateName(template, t)}</h1>
      <div className="auto-detail-actions">
        <Button variant="primary" size="sm" icon={<Play size={12} />} disabled={empty} onClick={() => runTemplate(template)}>
          {t('automations.template.runNow')}
        </Button>
        <Button size="sm" icon={<CalendarClock size={12} />} disabled={empty} title={t('automations.template.scheduleTitle')} onClick={() => openScheduleDialog({ templateId: template.id })}>
          {t('automations.schedule')}
        </Button>
      </div>

      {personal ? (
        <TemplateEditor
          template={template}
          autoFocus={template.name === t('automations.newTemplateName') && empty}
          onChange={(patch) => void saveSettings({ promptTemplates: templates.map((x) => (x.id === template.id ? { ...x, ...patch } : x)) })}
          onRemove={() => {
            void saveSettings({ promptTemplates: templates.filter((x) => x.id !== template.id) })
            selectAutomation(null)
          }}
        />
      ) : (
        <div className="set-card tpl-card">
          <pre className="tpl-body faint small">{template.body}</pre>
          <p className="faint small">
            {t('automations.template.repoNote', { file: template.file ?? '', rev: template.rev?.slice(0, 7) ?? '' })}
          </p>
        </div>
      )}

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
    </div>
  )
}

function ScheduleRow({ schedule: s, occurrences }: { schedule: Schedule; occurrences: Occurrence[] }) {
  const t = useT()
  const last = [...occurrences].reverse().find((o) => o.scheduleId === s.id && o.state !== 'skipped')
  return (
    <ActionRow role="listitem" divided onPress={() => selectAutomation(`s:${s.id}`)} primaryProps={{ className: 'auto-row' }}>
      <span className="auto-row-main">
        <span className="auto-row-title">{cadenceText(s, t, t.locale)}</span>
        <span className="auto-row-sub">{s.state === 'paused' ? s.pausedReason ?? t('automations.schedule.paused') : s.state === 'finished' ? t('automations.schedule.finished') : s.nextRunAt ? t('automations.schedule.next', { time: formatRun(Date.parse(s.nextRunAt), s.timezone, t.locale) }) : ''}</span>
      </span>
      {last && <Status compact tone={runStatusTone(last)} label={t('automations.schedule.lastRun', { state: t(RUN_LABEL[last.state]) })} title={t('automations.schedule.lastRun', { state: t(RUN_LABEL[last.state]) })} />}
    </ActionRow>
  )
}

export function ScheduleDetail({ schedule: s }: { schedule: Schedule }) {
  const t = useT()
  const repo = useStore((st) => st.snapshot!.repos.find((r) => r.id === s.repoId))
  const workspaces = useStore((st) => st.snapshot!.workspaces)
  const occurrences = useStore((st) => st.snapshot!.occurrences)
  const template = useStore((st) => st.snapshot!.settings.promptTemplates.find((t) => t.id === s.templateId) ?? Object.values(st.snapshot!.repoTemplates).flat().find((t) => t.id === s.templateId))
  const runs = occurrences.filter((o) => o.scheduleId === s.id).slice(-8).reverse()
  const running = runs.find((o) => o.state === 'running' || o.state === 'starting')
  const upcoming = s.state === 'active' ? nextRuns(s, Date.now(), 4) : []
  return (
    <div className="auto-detail">
      <div className="auto-eyebrow">{t('automations.schedule.eyebrow')}</div>
      <h1>{s.templateName}</h1>
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
          {s.state === 'paused' ? t('automations.schedule.review') : s.state === 'finished' ? t('automations.schedule.again') : t('automations.schedule.edit')}
        </Button>
        {s.state !== 'active' && (
          <LinkButton danger onClick={() => void attempt(async () => (await api.deleteSchedule(s.id), selectAutomation(null), true))}>
            {t('common.delete')}
          </LinkButton>
        )}
      </div>

      {s.state === 'paused' && (
        <Callout tone="warn" role="status">
          {s.pausedReason ?? t('automations.schedule.pausedBanner')} {t('automations.schedule.reviewHint')}
        </Callout>
      )}

      <dl className="auto-facts">
        <dt>{t('automations.schedule.repository')}</dt>
        <dd>{repo?.name ?? t('automations.schedule.repoRemoved')}</dd>
        <dt>{t('automations.schedule.from')}</dt>
        <dd>{s.baseBranch}</dd>
        <dt>{t('automations.schedule.stopsAfter')}</dt>
        <dd>{t('automations.schedule.minutes', { minutes: s.maxMinutes })}</dd>
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
      {runs.length ? (
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
      ) : (
        <p className="faint small">{t('automations.schedule.noRuns')}</p>
      )}
    </div>
  )
}
