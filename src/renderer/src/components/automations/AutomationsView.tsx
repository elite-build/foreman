// Automations: a library of prompt templates and saved commands (and flows and personas, each with its own tab, while
// Settings → Experimental → Flows is on). Each template card says when it runs and how its last
// run went; the side panel lists the schedules, or the selected schedule. A template opens as its own page in place of
// the library, with breadcrumbs back. Covers the workspace area like Settings, so open workspaces stay mounted.
import { ArrowLeft, CalendarClock, ChevronRight, Play, Plus, RotateCcw, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_PROMPT_TEMPLATES, newTemplateId, templateName } from '../../../../shared/promptTemplates'
import { qualifiedName } from '../../../../shared/repoTemplates'
import type { Occurrence, PromptTemplate, Schedule } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { closeAutomations, openScheduleDialog, selectAutomation, useStore } from '../../store'
import { ActionRow, Button, IconButton, LinkButton, Status, Tab, TabList, TabPanel, Tabs, TextInput, type StatusTone } from '../../ui'
import { cadenceText, nextPill } from '../ScheduleDialogs'
import { saveSettings, useSettings } from '../settings/controls'
import { CommandsSection } from './CommandsSection'
import { FlowsSection } from './FlowsSection'
import { FlowRunPage } from './FlowRunPage'
import { FlowStudio } from './FlowStudio'
import { RUN_LABEL, runStatusTone, runTemplate, ScheduleDetail, ScheduleOverview, TemplatePage } from './details'
import '../settings/settings.css'
import './automations.css'

type Shelf = 'all' | 'templates' | 'commands' | 'flows' | 'personas'

export function AutomationsView() {
  const t = useT()
  const selected = useStore((s) => s.automations?.selected ?? null)
  const toCommands = useStore((s) => s.automations?.scrollTo === 'commands')
  const [shelf, setShelf] = useState<Shelf>('all')
  const [query, setQuery] = useState('')
  const flowsOn = useStore((s) => Boolean(s.snapshot?.settings.flows))
  // A template opens as its own page over the library; a schedule still opens in the side panel.
  const template = useSelectedTemplate(selected)
  const flowId = selected?.startsWith('f:') ? selected.slice(2) : null
  const flowDraft = useStore((s) => s.automations?.flowDraft)
  // Run a flow: "r:<flow id>", or "r:" for the repository's first flow.
  const running = selected?.startsWith('r:') ? selected.slice(2) : null
  const runAt = useStore((s) => s.automations?.flowRun)
  const page = Boolean(template || flowId || running !== null)
  const scheduleId = selected?.startsWith('s:') ? selected.slice(2) : null
  const search = flowsOn ? t('automations.searchWithFlows') : t('automations.search')

  // A template deleted elsewhere (or a stale id): back to the library.
  useEffect(() => {
    if (selected?.startsWith('t:') && !template) selectAutomation(null)
  }, [selected, template])

  // Edit commands… (terminal panel, ⌘K) lands on Commands: CommandsSection scrolls to itself once it's shown.
  useEffect(() => {
    if (toCommands && shelf !== 'all' && shelf !== 'commands') setShelf('commands')
  }, [toCommands, shelf])

  // Flows turned off in Settings while their tab (or Personas) was open: back to All.
  useEffect(() => {
    if (!flowsOn && (shelf === 'flows' || shelf === 'personas')) setShelf('all')
  }, [flowsOn, shelf])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // In a field (the Rich prompt too), Escape belongs to the field, not to going back.
      if ((e.target as Element | null)?.closest?.('.modal, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
      if (selected) selectAutomation(null)
      else closeAutomations()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  return (
    <div className="automations-view">
      <header className="titlebar drag auto-head">
        {running !== null ? (
          <nav className="auto-crumbs" aria-label={t('automations.page.where')}>
            <span className="auto-title">
              <Zap size={15} />
            </span>
            <LinkButton onClick={() => selectAutomation(null)}>{t('automations.title')}</LinkButton>
            <ChevronRight size={12} aria-hidden />
            <span>{t('automations.flows')}</span>
            <ChevronRight size={12} aria-hidden />
            <span className="auto-crumb-here" aria-current="page">
              {t('flowRunPage.title')}
            </span>
          </nav>
        ) : flowId ? (
          <nav className="auto-crumbs" aria-label={t('automations.page.where')}>
            <span className="auto-title">
              <Zap size={15} />
            </span>
            <LinkButton onClick={() => selectAutomation(null)}>{t('automations.title')}</LinkButton>
            <ChevronRight size={12} aria-hidden />
            <span className="auto-crumb-here" aria-current="page">
              {t('automations.flows')}
            </span>
          </nav>
        ) : template ? (
          <nav className="auto-crumbs" aria-label={t('automations.page.where')}>
            <span className="auto-title">
              <Zap size={15} />
            </span>
            <LinkButton onClick={() => selectAutomation(null)}>{t('automations.title')}</LinkButton>
            <ChevronRight size={12} aria-hidden />
            <LinkButton
              onClick={() => {
                setShelf('templates')
                selectAutomation(null)
              }}
            >
              {t('automations.templates')}
            </LinkButton>
            <ChevronRight size={12} aria-hidden />
            <span className="auto-crumb-here" aria-current="page">
              {templateName(template, t)}
            </span>
          </nav>
        ) : (
          <span className="auto-title" role="heading" aria-level={1}>
            <Zap size={15} /> {t('automations.title')}
          </span>
        )}
        <span className="faint small auto-head-hint">{t('automations.openHint')}</span>
      </header>
      {template && (
        <div className="auto-body">
          <TemplatePage key={template.id} template={template} />
        </div>
      )}
      {running !== null && (
        <div className="auto-body">
          <FlowRunPage key={selected ?? ''} flowId={running || null} repoId={runAt?.repoId} baseBranch={runAt?.baseBranch} />
        </div>
      )}
      {flowId && (
        <div className="auto-body">
          <FlowStudio key={flowId === 'new' ? `new:${flowDraft?.toml.length ?? 0}:${flowDraft?.notes?.length ?? 0}` : flowId} id={flowId} draft={flowId === 'new' ? flowDraft : undefined} />
        </div>
      )}
      {/* Hidden, not unmounted, under a template's page: Back finds the library scrolled where it was. */}
      <div className="auto-body" hidden={page}>
        <Tabs value={shelf} onChange={(v) => setShelf(v as Shelf)} className="auto-lib">
          <div className="auto-lib-bar">
            <TabList label={t('automations.show')}>
              <Tab value="all">{t('automations.all')}</Tab>
              <Tab value="templates">{t('automations.templates')}</Tab>
              <Tab value="commands">{t('commands.section')}</Tab>
              {flowsOn && <Tab value="flows">{t('automations.flows')}</Tab>}
              {flowsOn && <Tab value="personas">{t('automations.personas')}</Tab>}
            </TabList>
            <TextInput type="search" className="auto-search" aria-label={search} placeholder={search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <TabPanel value="all" className="auto-lib-scroll">
            <FlowsSection query={query} />
            <TemplateShelf query={query} />
            <CommandsSection query={query} />
          </TabPanel>
          <TabPanel value="templates" className="auto-lib-scroll">
            <TemplateShelf query={query} />
          </TabPanel>
          <TabPanel value="commands" className="auto-lib-scroll">
            <CommandsSection query={query} />
          </TabPanel>
          {flowsOn && (
            <TabPanel value="flows" className="auto-lib-scroll">
              <FlowsSection query={query} show="flows" />
            </TabPanel>
          )}
          {flowsOn && (
            <TabPanel value="personas" className="auto-lib-scroll">
              <FlowsSection query={query} show="personas" />
            </TabPanel>
          )}
        </Tabs>
        <aside className="auto-side" aria-label={t('automations.side.label')}>{scheduleId ? <SelectedSchedule id={scheduleId} /> : <ScheduleOverview />}</aside>
      </div>
    </div>
  )
}

/** The template "t:<id>" names, personal or from a repository; undefined for a schedule, nothing, or one deleted elsewhere. */
function useSelectedTemplate(selected: string | null): PromptTemplate | undefined {
  const id = selected?.startsWith('t:') ? selected.slice(2) : null
  return useStore((s) => (id ? (s.snapshot!.settings.promptTemplates.find((x) => x.id === id) ?? Object.values(s.snapshot!.repoTemplates).flat().find((x) => x.id === id)) : undefined))
}

function SelectedSchedule({ id }: { id: string }) {
  const t = useT()
  const schedule = useStore((s) => s.snapshot!.schedules.find((x) => x.id === id))
  // Deleted elsewhere: back to the schedules.
  useEffect(() => {
    if (!schedule) selectAutomation(null)
  }, [schedule])
  return (
    <>
      <Button size="sm" className="set-back auto-back" icon={<ArrowLeft size={13} />} onClick={() => selectAutomation(null)}>
        {t('automations.template.schedules')}
      </Button>
      {schedule && <ScheduleDetail key={schedule.id} schedule={schedule} />}
    </>
  )
}

/** Personal templates, then each repository's, as cards; `query` keeps those whose name or prompt contains it. */
function TemplateShelf({ query }: { query: string }) {
  const t = useT()
  const templates = useSettings().promptTemplates
  const byRepo = useStore((s) => s.snapshot!.repoTemplates)
  const repos = useStore((s) => s.snapshot!.repos)
  const missingDefaults = DEFAULT_PROMPT_TEMPLATES.filter((d) => !templates.some((t) => t.id === d.id))
  const needle = query.trim().toLowerCase()
  const hit = (tpl: PromptTemplate, title: string) => !needle || `${title}\n${tpl.body}`.toLowerCase().includes(needle)
  const mine = templates.filter((x) => hit(x, templateName(x, t)))
  const shared = repos.map((r) => ({ repo: r, list: (byRepo[r.id] ?? []).filter((x) => hit(x, qualifiedName(x, templates))) })).filter((g) => g.list.length)

  const add = () => {
    const id = newTemplateId()
    void saveSettings({ promptTemplates: [...templates, { id, name: t('automations.newTemplateName'), body: '' }] }).then((ok) => ok && selectAutomation(`t:${id}`))
  }

  return (
    <section aria-label={t('automations.templates')}>
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
      {!needle && templates.length === 0 && <p className="faint small auto-side-note">{t('automations.noTemplates')}</p>}
      {needle && !mine.length && !shared.length && <p className="faint small auto-side-note">{t('automations.noMatches', { query: query.trim() })}</p>}
      {mine.length > 0 && (
        <div className="auto-cards">
          {mine.map((x) => (
            <TemplateCard key={x.id} template={x} title={templateName(x, t)} />
          ))}
        </div>
      )}
      {shared.map(({ repo, list }) => (
        <div key={repo.id}>
          <div className="auto-side-head sub">{t('automations.fromRepo', { repo: repo.name })}</div>
          <div className="auto-cards">
            {list.map((x) => (
              <TemplateCard key={x.id} template={x} title={qualifiedName(x, templates)} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

/** A template as a card: its name, the start of its prompt, when it runs, and the state of its runs. */
function TemplateCard({ template: tpl, title }: { template: PromptTemplate; title: string }) {
  const t = useT()
  const selected = useStore((s) => s.automations?.selected === `t:${tpl.id}`)
  const allSchedules = useStore((s) => s.snapshot!.schedules)
  const occurrences = useStore((s) => s.snapshot!.occurrences)
  const schedules = allSchedules.filter((x) => x.templateId === tpl.id && x.state !== 'finished')
  const status = runsStatus(schedules, occurrences, t)
  const empty = !tpl.body.trim()
  return (
    <ActionRow
      card
      className="auto-card"
      selected={selected}
      onPress={() => selectAutomation(`t:${tpl.id}`)}
      primaryProps={{ className: 'auto-card-main' }}
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
      <span className="auto-row-title">{title}</span>
      <span className="auto-card-body">{empty ? t('automations.emptyTemplate') : tpl.body}</span>
      <span className="auto-card-foot">
        <span className="auto-card-when">{whenText(schedules, t)}</span>
        {status && <Status tone={status.tone} label={status.label} />}
      </span>
    </ActionRow>
  )
}

/** "On demand", one schedule's cadence ("Weekdays at 09:00"), or how many schedules and the soonest run. */
function whenText(schedules: Schedule[], t: RendererT): string {
  if (!schedules.length) return t('automations.onDemand')
  if (schedules.length === 1) return cadenceText(schedules[0], t, t.locale)
  const count = t('automations.scheduleCount', { count: schedules.length })
  const next = schedules.filter((s) => s.state === 'active' && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0]
  return next ? `${count} · ${t('automations.schedule.next', { time: nextPill(Date.parse(next.nextRunAt!), next.timezone, t.locale) })}` : count
}

/** What a template's schedules are doing: a run in progress, a pause, or how the latest run ended. None for on-demand. */
function runsStatus(schedules: Schedule[], occurrences: Occurrence[], t: RendererT): { tone: StatusTone; label: string } | null {
  const ids = new Set(schedules.map((s) => s.id))
  const runs = occurrences.filter((o) => ids.has(o.scheduleId) && o.state !== 'skipped')
  const live = runs.find((o) => o.state === 'running' || o.state === 'starting')
  if (live) return { tone: runStatusTone(live), label: t(RUN_LABEL[live.state]) }
  if (schedules.some((s) => s.state === 'paused')) return { tone: 'warn', label: t('automations.schedule.paused') }
  const last = runs[runs.length - 1]
  return last ? { tone: runStatusTone(last), label: t('automations.schedule.lastRun', { state: t(RUN_LABEL[last.state]) }) } : null
}
