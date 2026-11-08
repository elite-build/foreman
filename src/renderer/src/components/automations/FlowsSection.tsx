// Flows on Automations (docs/loops-and-graphs.md), shown only while Settings → Experimental → Flows is on: the built-in,
// repository and personal flows as cards, each opening as its own page in the flow studio (FlowStudio.tsx).
// Run… opens the Run a flow page (FlowRunPage.tsx) on it; each flow lists its recent runs. The Personas section (who a
// flow's step is) follows on All, with the flows that name each one; the Flows and Personas tabs show one each.
// New flow asks for a name and a start first (NewFlowDialog.tsx); a card's ⋯ renames a personal flow, or a copy of
// a built-in or repository one.
import { Copy, MoreHorizontal, Pencil, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { durationWords } from '../../../../shared/flowGraph'
import { parseFlow, type FlowListing, type FlowRun } from '../../../../shared/flows'
import { useT } from '../../i18n'
import { api, attempt, openFlowDraft, openFlowRename, openFlowRun, selectAutomation, selectWorkspace, timeAgo, useStore } from '../../store'
import { ActionRow, Button, LinkButton, MenuButton, MenuItem, Segmented, Status } from '../../ui'
import { flowTitle, SourceTags, summaryText } from './FlowStartFields'
import { FlowLensDiagram } from '../FlowDiagram'
import { NewFlowDialog } from './NewFlowDialog'
import { RUN_STATE, RUN_TONE } from './flowRunWords'
import { PersonasSection } from './PersonasSection'

/** Both sections (the All tab), or one for its own tab. Personas still lists the flows, to say which name each persona. */
type FlowsShow = 'both' | 'flows' | 'personas'

export function FlowsSection({ query, show = 'both' }: { query: string; show?: FlowsShow }) {
  const on = useStore((s) => Boolean(s.snapshot?.settings.flows))
  return on ? <FlowList query={query} show={show} /> : null
}

function FlowList({ query, show }: { query: string; show: FlowsShow }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const [flows, setFlows] = useState<FlowListing[]>([])
  const [view, setView] = useState<'flows' | 'runs'>('flows')
  const [creating, setCreating] = useState(false)
  const load = useCallback(async () => {
    const list = await attempt(() => api.listFlows())
    if (list) setFlows(list)
  }, [])
  // Again when repositories come or go: their flow files come with them.
  useEffect(() => {
    void load()
  }, [load, repos])

  const needle = query.trim().toLowerCase()
  const shown = needle ? flows.filter((f) => `${flowTitle(f, t)}\n${f.toml}`.toLowerCase().includes(needle)) : flows
  const usedBy = (name: string) => flows.filter((f) => f.summary?.personas.some((p) => p.toLowerCase() === name.toLowerCase())).map((f) => flowTitle(f, t))

  return (
    <>
      {show !== 'personas' && (show === 'flows' || !needle || shown.length > 0) && (
        <section aria-label={t('automations.flows')}>
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
              <p className="faint small auto-side-note">{t('automations.flows.note')}</p>
              {needle && !shown.length && <p className="faint small auto-side-note">{t('automations.noMatches', { query: query.trim() })}</p>}
              <div className="auto-cards">
                {shown.map((flow) => (
                  <div key={flow.id} className="flow-item">
                    <FlowCard flow={flow} onOpen={() => selectAutomation(`f:${flow.id}`)} onRun={() => openFlowRun(flow.id, { repoId: flow.repoId })} />
                    <FlowRuns flow={flow} />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {creating && <NewFlowDialog flows={flows} onClose={() => setCreating(false)} />}
      {show !== 'flows' && <PersonasSection query={query} alone={show === 'personas'} usedBy={usedBy} onChanged={() => void load()} />}
    </>
  )
}

function FlowCard({ flow, onOpen, onRun }: { flow: FlowListing; onOpen: () => void; onRun: () => void }) {
  const t = useT()
  const title = flowTitle(flow, t)
  // A copy opens with its name selected, so it doesn't keep its original's.
  const copy = () => openFlowDraft({ toml: flow.toml, notes: [t('flowStudio.copyNote', { name: title })], rename: true })
  return (
    <ActionRow
      card
      className="auto-card"
      onPress={onOpen}
      primaryProps={{ className: 'auto-card-main' }}
      actions={
        <span className="flow-card-actions">
          <Button size="sm" disabled={flow.problems.length > 0} onClick={onRun} aria-label={t('automations.flows.runNamed', { name: title })}>
            {t('automations.flows.run')}
          </Button>
          <MenuButton look="icon" label={t('flowStudio.more', { name: title })} trigger={<MoreHorizontal size={14} />}>
            {flow.source === 'personal' ? (
              <>
                <MenuItem icon={<Pencil size={14} />} onSelect={() => openFlowRename(flow.id)}>
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
      }
    >
      <FlowThumbnail flow={flow} />
      <span className="auto-row-title">{flowTitle(flow, t)}</span>
      <span className="auto-card-foot flow-card-tags">
        <SourceTags flow={flow} />
      </span>
      {flow.summary && <span className="auto-card-body">{summaryText(flow, t)}</span>}
      {(flow.problems.length > 0 || flow.warnings.length > 0) && (
        <span className="auto-card-foot">
          {flow.problems.length > 0 && <Status tone="error" label={t('automations.flows.problems', { count: flow.problems.length })} />}
          {flow.warnings.length > 0 && <Status tone="warn" label={t('automations.flows.warnings', { count: flow.warnings.length })} />}
        </span>
      )}
    </ActionRow>
  )
}

/** The flow's run graph as a small picture on its card (no words: the card says what it is); nothing when it doesn't read. */
function FlowThumbnail({ flow }: { flow: FlowListing }) {
  const t = useT()
  const parsed = useMemo(() => (flow.problems.length ? undefined : parseFlow(flow.toml, flow.source, t)), [flow, t])
  if (!parsed || !('flow' in parsed)) return null
  return (
    <span className="flow-card-thumb" aria-hidden="true">
      <FlowLensDiagram flow={parsed.flow} lens="run" thumbnail className="flow-card-thumb-graph" />
    </span>
  )
}

/** A flow's latest runs, newest first: how each ended (or where it is), when, its workspace and why it stopped. */
function FlowRuns({ flow }: { flow: FlowListing }) {
  const t = useT()
  const runs = useStore((s) => s.snapshot!.flowRuns)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const mine = (runs ?? []).filter((r) => r.flow.id === flow.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5)
  if (!mine.length) return null
  return (
    <ul className="flow-runs" aria-label={t('automations.flows.runs', { name: flowTitle(flow, t) })}>
      {mine.map((run) => {
        const ws = workspaces.find((w) => w.id === run.workspaceId)
        return (
          <li key={run.id} className="flow-run-row">
            <Status tone={RUN_TONE[run.state]} label={t(RUN_STATE[run.state])} />
            <span className="faint small">{timeAgo(run.startedAt)}</span>
            {ws && ws.state !== 'archived' && (
              <LinkButton size="sm" onClick={() => selectWorkspace(ws.id)}>
                {ws.name}
              </LinkButton>
            )}
            {run.reason && <span className="faint small flow-run-reason">{run.reason}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Every flow's runs, newest first, as a table: which flow, how it ended or where it is, its workspace, when it started,
 * how long it took, what its Claude turns cost, and why it stopped.
 */
function FlowRunsTable({ flows }: { flows: FlowListing[] }) {
  const t = useT()
  const runs = useStore((s) => s.snapshot!.flowRuns)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const sorted = [...(runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
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
                    <LinkButton size="sm" onClick={() => selectWorkspace(ws.id)}>
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
