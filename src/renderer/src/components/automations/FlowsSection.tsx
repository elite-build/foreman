// Flows on Automations (docs/loops-and-graphs.md, "Finding a flow"), shown only while Settings → Experimental → Flows is
// on. It asks "I want to…" and answers with the flows that do the job picked (flowJobs.ts), each a card that says when to
// choose it, what it does, how often it stops for you and how its last run went, beside the flow drawn whole, big enough
// to read; then the latest runs of those flows. All flows lists every one, those that name no job too. Open shows a flow
// in the flow studio (FlowStudio.tsx), Run… the Run a flow page (FlowRunPage.tsx). The Personas section (who a flow's
// step is) follows on All, with the flows that name each one; the Flows and Personas tabs show one each. New flow asks
// for a name and a start first (NewFlowDialog.tsx); a card's ⋯ renames a personal flow, or a copy of a built-in or
// repository one.
import { Bug, Copy, GitPullRequest, Hammer, Hand, HeartPulse, Lightbulb, MoreHorizontal, Pencil, Plus, Users, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { durationWords } from '../../../../shared/flowGraph'
import { FLOW_JOBS, flowsForJob, JOB_TEMPLATE, type FlowJob } from '../../../../shared/flowJobs'
import { parseFlow, type Flow, type FlowListing, type FlowRun } from '../../../../shared/flows'
import type { FlowStarter } from '../../../../shared/flowStarters'
import type { PlainKey } from '../../../../shared/i18n'
import { templateName } from '../../../../shared/promptTemplates'
import { useT } from '../../i18n'
import { api, attempt, openFlowDraft, openFlowRename, openFlowRun, selectAutomation, selectWorkspace, timeAgo, useStore } from '../../store'
import { Button, Card, LinkButton, MenuButton, MenuItem, RadioCards, Segmented, Status, Tag } from '../../ui'
import { FlowPicture } from '../FlowDiagram'
import { useSettings } from '../settings/controls'
import { flowTitle } from './FlowStartFields'
import { NewFlowDialog } from './NewFlowDialog'
import { RUN_STATE, RUN_TONE } from './flowRunWords'
import { PersonasSection } from './PersonasSection'

/** Both sections (the All tab), or one for its own tab. Personas still lists the flows, to say which name each persona. */
type FlowsShow = 'both' | 'flows' | 'personas'

const JOB_NAME: Record<FlowJob, PlainKey> = {
  build: 'automations.flows.job.build',
  fix: 'automations.flows.job.fix',
  review: 'automations.flows.job.review',
  ship: 'automations.flows.job.ship',
  maintain: 'automations.flows.job.maintain',
  decide: 'automations.flows.job.decide'
}
const JOB_BLURB: Record<FlowJob, PlainKey> = {
  build: 'automations.flows.job.buildBlurb',
  fix: 'automations.flows.job.fixBlurb',
  review: 'automations.flows.job.reviewBlurb',
  ship: 'automations.flows.job.shipBlurb',
  maintain: 'automations.flows.job.maintainBlurb',
  decide: 'automations.flows.job.decideBlurb'
}
const JOB_ICON: Record<FlowJob, LucideIcon> = { build: Hammer, fix: Bug, review: Users, ship: GitPullRequest, maintain: HeartPulse, decide: Lightbulb }

/** When to choose a built-in flow over the others that do its job; another flow says it in its file (`when`). */
const STARTER_WHEN: Record<FlowStarter['id'], PlainKey> = {
  'fix-until-green': 'automations.flows.when.fixUntilGreen',
  'research-then-implement': 'automations.flows.when.researchThenImplement',
  'test-first': 'automations.flows.when.testFirst',
  'issue-to-draft-pr': 'automations.flows.when.issueToDraftPr',
  'second-opinion': 'automations.flows.when.secondOpinion',
  'two-reviewers': 'automations.flows.when.twoReviewers',
  'keep-branch-fresh': 'automations.flows.when.keepBranchFresh',
  'flaky-test-triage': 'automations.flows.when.flakyTestTriage',
  'document-what-changed': 'automations.flows.when.documentWhatChanged',
  'worth-building': 'automations.flows.when.worthBuilding',
  'idea-to-feature': 'automations.flows.when.ideaToFeature'
}

// The job last picked, kept across restarts like the panel widths.
const JOB_KEY = 'foreman.automations.flowJob'
type JobPick = FlowJob | 'all'
const isJobPick = (v: unknown): v is JobPick => v === 'all' || (FLOW_JOBS as readonly unknown[]).includes(v)

function rememberedJob(): JobPick | null {
  try {
    const saved = localStorage.getItem(JOB_KEY)
    return isJobPick(saved) ? saved : null
  } catch {
    return null
  }
}

function rememberJob(pick: JobPick): void {
  try {
    localStorage.setItem(JOB_KEY, pick)
  } catch {
    // A convenience: the page opens on a job either way.
  }
}

/** A run still going: its step is drawn in its state. */
const LIVE: ReadonlySet<FlowRun['state']> = new Set(['starting', 'running', 'waiting', 'needs-you'])

/** A listing with its flow read, for its words, jobs and picture. */
interface FlowEntry {
  listing: FlowListing
  flow?: Flow
  jobs?: Flow['jobs']
}

export function FlowsSection({ query, show = 'both' }: { query: string; show?: FlowsShow }) {
  const on = useStore((s) => Boolean(s.snapshot?.settings.flows))
  return on ? <FlowList query={query} show={show} /> : null
}

function FlowList({ query, show }: { query: string; show: FlowsShow }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const runs = useStore((s) => s.snapshot!.flowRuns)
  const [flows, setFlows] = useState<FlowListing[]>([])
  const [view, setView] = useState<'flows' | 'runs'>('flows')
  const [creating, setCreating] = useState(false)
  const [chosen, setChosen] = useState<JobPick | null>(rememberedJob)
  const load = useCallback(async () => {
    const list = await attempt(() => api.listFlows())
    if (list) setFlows(list)
  }, [])
  // Again when repositories come or go: their flow files come with them.
  useEffect(() => {
    void load()
  }, [load, repos])

  const entries = useMemo<FlowEntry[]>(
    () =>
      flows.map((listing) => {
        const parsed = listing.problems.length ? undefined : parseFlow(listing.toml, listing.source, t)
        const flow = parsed && 'flow' in parsed ? parsed.flow : undefined
        return { listing, flow, jobs: flow?.jobs }
      }),
    [flows, t]
  )
  // Nothing picked yet: the first job of the flow run last, else the first job.
  const pick: JobPick = useMemo(() => {
    if (chosen) return chosen
    const last = [...(runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    return entries.find((e) => e.listing.id === last?.flow.id)?.jobs?.[0] ?? 'build'
  }, [chosen, runs, entries])
  const choose = (next: JobPick) => {
    setChosen(next)
    rememberJob(next)
  }

  const needle = query.trim().toLowerCase()
  const found = needle ? entries.filter((e) => `${flowTitle(e.listing, t)}\n${e.listing.toml}`.toLowerCase().includes(needle)) : null
  const shown = found ?? flowsForJob(entries, pick === 'all' ? null : pick)
  const usedBy = (name: string) => flows.filter((f) => f.summary?.personas.some((p) => p.toLowerCase() === name.toLowerCase())).map((f) => flowTitle(f, t))

  return (
    <>
      {show !== 'personas' && (show === 'flows' || !needle || shown.length > 0) && (
        <section aria-label={t('automations.flows')} className="flow-jobs">
          <div className="auto-side-head">
            <span>{t('automations.flows')}</span>
            <span className="auto-side-tools">
              <Segmented<'flows' | 'runs'>
                small
                label={t('automations.flows.view')}
                value={view}
                onChange={setView}
                options={[
                  { value: 'flows', label: t('automations.flows.viewFlows') },
                  { value: 'runs', label: t('automations.flows.viewRuns') }
                ]}
              />
              <LinkButton size="sm" onClick={() => setCreating(true)}>
                <Plus size={12} aria-hidden /> {t('automations.flows.new')}
              </LinkButton>
            </span>
          </div>
          {view === 'runs' ? (
            <FlowRunsTable flows={flows} />
          ) : (
            <>
              {!found && <JobPicker entries={entries} value={pick} onChange={choose} />}
              <JobHeading pick={found ? null : pick} count={shown.length} />
              {found && !found.length && <p className="faint small auto-side-note">{t('automations.noMatches', { query: query.trim() })}</p>}
              <ul className="flow-job-list" aria-label={found ? t('automations.flows.matches') : pick === 'all' ? t('automations.flows.allFlows') : t(JOB_NAME[pick])}>
                {shown.map((entry) => (
                  <FlowJobCard key={entry.listing.id} entry={entry} runs={runs ?? []} />
                ))}
              </ul>
              {!found && pick !== 'all' && (
                <LinkButton size="sm" underline className="flow-jobs-all" onClick={() => choose('all')}>
                  {t('automations.flows.seeAll', { count: entries.length })}
                </LinkButton>
              )}
              {!found && <LatestRuns flows={flows} only={shown.map((e) => e.listing.id)} onAll={() => setView('runs')} />}
            </>
          )}
        </section>
      )}
      {creating && <NewFlowDialog flows={flows} onClose={() => setCreating(false)} />}
      {show !== 'flows' && <PersonasSection query={query} alone={show === 'personas'} usedBy={usedBy} onChanged={() => void load()} />}
    </>
  )
}

/** "I want to…": the jobs as cards, each with how many flows do it. All flows picks none of them. */
function JobPicker({ entries, value, onChange }: { entries: FlowEntry[]; value: JobPick; onChange: (pick: JobPick) => void }) {
  const t = useT()
  const options = FLOW_JOBS.map((job) => {
    const Icon = JOB_ICON[job]
    return {
      value: job as JobPick,
      label: t(JOB_NAME[job]),
      description: `${t('automations.flows.jobCount', { count: flowsForJob(entries, job).length })} · ${t(JOB_BLURB[job])}`,
      icon: <Icon size={15} />
    }
  })
  return <RadioCards<JobPick> legend={t('automations.flows.iWantTo')} value={value} options={options} onChange={onChange} columns={3} className="flow-job-picker" />
}

/** What the list below is: the job and how many flows do it, and the template that does it in one turn. */
function JobHeading({ pick, count }: { pick: JobPick | null; count: number }) {
  const t = useT()
  const templates = useSettings().promptTemplates
  const templateId = pick && pick !== 'all' ? JOB_TEMPLATE[pick] : undefined
  const template = templateId ? templates.find((x) => x.id === templateId) : undefined
  const title = pick === null ? t('automations.flows.matches') : pick === 'all' ? t('automations.flows.allFlows') : t(JOB_NAME[pick])
  return (
    <div className="flow-job-head">
      <h2 className="flow-job-title">
        {title} <span className="faint small">{t('automations.flows.jobCount', { count })}</span>
      </h2>
      {template && (
        <span className="faint small">
          {t.rich('automations.flows.onePrompt', {
            template: (
              <LinkButton key="template" size="sm" underline onClick={() => selectAutomation(`t:${template.id}`)}>
                {templateName(template, t)}
              </LinkButton>
            )
          })}
        </span>
      )}
    </div>
  )
}

/**
 * A flow as a card: when to choose it, what it does, how often it stops for you and its last run, with Run… and Open;
 * beside them (under them in a narrow window) the flow drawn whole, a run still going drawn in its state.
 */
function FlowJobCard({ entry, runs }: { entry: FlowEntry; runs: FlowRun[] }) {
  const t = useT()
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const { listing, flow } = entry
  const repoName = useStore((s) => (listing.repoId ? s.snapshot!.repos.find((r) => r.id === listing.repoId)?.name : undefined))
  const title = flowTitle(listing, t)
  const starter = listing.starter as FlowStarter['id'] | undefined
  const when = starter && STARTER_WHEN[starter] ? t(STARTER_WHEN[starter]) : flow?.when
  const mine = runs.filter((r) => r.flow.id === listing.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const last = mine[0]
  const live = mine.find((r) => LIVE.has(r.state))
  const ws = last && workspaces.find((w) => w.id === last.workspaceId && w.state !== 'archived')
  const gates = listing.summary?.gates ?? 0
  // A copy opens with its name selected, so it doesn't keep its original's.
  const copy = () => openFlowDraft({ toml: listing.toml, notes: [t('flowStudio.copyNote', { name: title })], rename: true })
  return (
    <Card as="li" className="flow-job-card">
      <div className="flow-job-words">
        <div className="flow-job-name">
          <h3 className="auto-row-title">{title}</h3>
          {listing.source === 'personal' && <Tag>{t('automations.flows.personal')}</Tag>}
          {listing.source === 'repo' && repoName && <Tag>{t('automations.flows.fromRepo', { repo: repoName })}</Tag>}
        </div>
        {when && (
          <p className="flow-job-when small">
            <strong>{t('automations.flows.chooseWhen')}</strong> {when}
          </p>
        )}
        {flow?.description && <p className="flow-job-desc faint small">{flow.description}</p>}
        <p className="flow-job-stops faint small">
          <Hand size={12} aria-hidden /> {gates ? t('automations.flows.stops', { count: gates }) : t('automations.flows.stopsNever')}
        </p>
        {(listing.problems.length > 0 || listing.warnings.length > 0) && (
          <span className="flow-job-foot">
            {listing.problems.length > 0 && <Status tone="error" label={t('automations.flows.problems', { count: listing.problems.length })} />}
            {listing.warnings.length > 0 && <Status tone="warn" label={t('automations.flows.warnings', { count: listing.warnings.length })} />}
          </span>
        )}
        <div className="flow-job-foot">
          {last ? (
            <span className="flow-job-last small">
              <Status tone={RUN_TONE[last.state]} label={t(RUN_STATE[last.state])} />
              <span className="faint">{timeAgo(last.startedAt)}</span>
              {ws && (
                <LinkButton size="sm" underline onClick={() => selectWorkspace(ws.id)}>
                  {ws.name}
                </LinkButton>
              )}
            </span>
          ) : (
            <span className="flow-job-last faint small">{t('automations.flows.notRun')}</span>
          )}
          <span className="flow-job-actions">
            <Button size="sm" disabled={listing.problems.length > 0} onClick={() => openFlowRun(listing.id, { repoId: listing.repoId })} aria-label={t('automations.flows.runNamed', { name: title })}>
              {t('automations.flows.run')}
            </Button>
            <LinkButton size="sm" underline onClick={() => selectAutomation(`f:${listing.id}`)} aria-label={t('automations.flows.openNamed', { name: title })}>
              {t('automations.flows.open')}
            </LinkButton>
            <MenuButton look="icon" label={t('flowStudio.more', { name: title })} trigger={<MoreHorizontal size={14} />}>
              {listing.source === 'personal' ? (
                <>
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => openFlowRename(listing.id)}>
                    {t('common.rename')}
                  </MenuItem>
                  <MenuItem icon={<Copy size={14} />} onSelect={copy}>
                    {t('flowStudio.duplicate')}
                  </MenuItem>
                </>
              ) : (
                <MenuItem icon={<Pencil size={14} />} onSelect={copy}>
                  {t('automations.flows.renameCopy')}
                </MenuItem>
              )}
            </MenuButton>
          </span>
        </div>
      </div>
      {flow && <FlowPicture flow={flow} run={live} label={t('automations.flows.pictureLabel', { name: title })} className="flow-job-picture" />}
    </Card>
  )
}

/** The latest runs of the flows listed, with the way to every flow's runs; nothing when none has run. */
function LatestRuns({ flows, only, onAll }: { flows: FlowListing[]; only: string[]; onAll: () => void }) {
  const t = useT()
  const runs = useStore((s) => s.snapshot!.flowRuns)
  const ids = new Set(only)
  if (!(runs ?? []).some((r) => ids.has(r.flow.id))) return null
  return (
    <section className="flow-jobs-runs" aria-label={t('automations.flows.latestRuns')}>
      <div className="auto-side-head sub">
        <span>{t('automations.flows.latestRuns')}</span>
        <LinkButton size="sm" underline onClick={onAll}>
          {t('automations.flows.allRuns')}
        </LinkButton>
      </div>
      <FlowRunsTable flows={flows} only={ids} limit={5} />
    </section>
  )
}

/**
 * Every flow's runs (or `only` those flows', the latest `limit`), newest first, as a table: which flow, how it ended or
 * where it is, its workspace, when it started, how long it took, what its Claude turns cost, and why it stopped.
 */
function FlowRunsTable({ flows, only, limit }: { flows: FlowListing[]; only?: ReadonlySet<string>; limit?: number }) {
  const t = useT()
  const runs = useStore((s) => s.snapshot!.flowRuns)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const sorted = [...(runs ?? [])].filter((r) => !only || only.has(r.flow.id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
  if (!sorted.length) return <p className="faint small auto-side-note">{t('automations.flows.noRuns')}</p>
  const money = new Intl.NumberFormat(t.locale, { style: 'currency', currency: 'USD' })
  const nameOf = (run: FlowRun) => {
    const listing = flows.find((f) => f.id === run.flow.id)
    return listing ? flowTitle(listing, t) : run.flow.starter ? flowTitle({ starter: run.flow.starter, name: run.flow.name }, t) : run.flow.name
  }
  return (
    <table className="flow-runs-table">
      <caption className="sr-only">{t('automations.flows.runsCaption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('automations.flows.col.flow')}</th>
          <th scope="col">{t('automations.flows.col.state')}</th>
          <th scope="col">{t('automations.flows.col.started')}</th>
          <th scope="col">{t('automations.flows.col.cost')}</th>
          <th scope="col">{t('automations.flows.col.where')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((run) => {
          const ws = workspaces.find((w) => w.id === run.workspaceId)
          const costs = run.steps.filter((s) => s.costUsd !== undefined)
          const took = run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined
          const where = run.reason ?? (run.current ? t('flowRun.panel.at', { step: run.current.step, iteration: run.current.iteration }) : '')
          return (
            <tr key={run.id}>
              <td>
                <span className="flow-runs-cell">
                  <span>{nameOf(run)}</span>
                  {ws && ws.state !== 'archived' ? (
                    <LinkButton size="sm" underline onClick={() => selectWorkspace(ws.id)}>
                      {ws.name}
                    </LinkButton>
                  ) : null}
                </span>
              </td>
              <td>
                <Status tone={RUN_TONE[run.state]} label={t(RUN_STATE[run.state])} />
              </td>
              <td>
                <span className="flow-runs-cell">
                  <span>{timeAgo(run.startedAt)}</span>
                  {took !== undefined && Number.isFinite(took) && <span className="faint small">{t('automations.flows.took', { duration: durationWords(took) })}</span>}
                </span>
              </td>
              <td>{costs.length ? money.format(costs.reduce((sum, s) => sum + s.costUsd!, 0)) : '—'}</td>
              <td className="small">{where || '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
