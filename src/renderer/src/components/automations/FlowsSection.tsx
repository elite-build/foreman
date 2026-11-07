// Flows on Automations (docs/loops-and-graphs.md), shown only while Settings → Experimental → Flows is on: the built-in,
// repository and personal flows as cards, each opening as its own page in the flow studio (FlowStudio.tsx).
// Run… starts a flow in a new workspace after showing what the run approves; each flow lists its recent runs. The
// Personas section (who a flow's step is) follows, with the flows that name each one.
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FLOW_STARTERS } from '../../../../shared/flowStarters'
import { durationWords } from '../../../../shared/flowGraph'
import { parseFlow, type FlowListing, type FlowRun } from '../../../../shared/flows'
import type { BranchInfo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openFlowDraft, selectAutomation, selectWorkspace, showToast, timeAgo, useStore } from '../../store'
import { ActionRow, Button, Dialog, Field, LinkButton, Segmented, Select, Status } from '../../ui'
import { FlowApproval, FlowInputFields, FlowStepOutline, flowStartReady, flowTitle, SourceTags, summaryText, useFlowPreview } from './FlowStartFields'
import { RUN_STATE, RUN_TONE } from './flowRunWords'
import { PersonasSection } from './PersonasSection'

export function FlowsSection({ query }: { query: string }) {
  const on = useStore((s) => Boolean(s.snapshot?.settings.flows))
  return on ? <FlowList query={query} /> : null
}

function FlowList({ query }: { query: string }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const [flows, setFlows] = useState<FlowListing[]>([])
  const [running, setRunning] = useState<FlowListing | null>(null)
  const [view, setView] = useState<'flows' | 'runs'>('flows')
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
  const startNew = () => openFlowDraft({ toml: FLOW_STARTERS[0].toml, describe: true })
  const usedBy = (name: string) => flows.filter((f) => f.summary?.personas.some((p) => p.toLowerCase() === name.toLowerCase())).map((f) => flowTitle(f, t))

  return (
    <>
      {(!needle || shown.length > 0) && (
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
              <LinkButton size="sm" onClick={startNew}>
                <Plus size={12} aria-hidden /> {t('automations.flows.new')}
              </LinkButton>
            </span>
          </div>
          {view === 'runs' ? (
            <FlowRunsTable flows={flows} />
          ) : (
            <>
              <p className="faint small auto-side-note">{t('automations.flows.note')}</p>
              <div className="auto-cards">
                {shown.map((flow) => (
                  <div key={flow.id} className="flow-item">
                    <FlowCard flow={flow} onOpen={() => selectAutomation(`f:${flow.id}`)} onRun={() => setRunning(flow)} />
                    <FlowRuns flow={flow} />
                  </div>
                ))}
              </div>
            </>
          )}
          {running && <RunFlowDialog flow={running} onClose={() => setRunning(null)} />}
        </section>
      )}
      <PersonasSection query={query} usedBy={usedBy} onChanged={() => void load()} />
    </>
  )
}

function FlowCard({ flow, onOpen, onRun }: { flow: FlowListing; onOpen: () => void; onRun: () => void }) {
  const t = useT()
  return (
    <ActionRow
      card
      className="auto-card"
      onPress={onOpen}
      primaryProps={{ className: 'auto-card-main' }}
      actions={
        <Button size="sm" disabled={flow.problems.length > 0} onClick={onRun} aria-label={t('automations.flows.runNamed', { name: flowTitle(flow, t) })}>
          {t('automations.flows.run')}
        </Button>
      }
    >
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

/**
 * Run…: the repository (for a personal or built-in flow), the base branch, the flow's inputs, and what starting it
 * approves (FlowStartFields): the flow file and its revision, templates, personas, setup, checks, MCP servers and
 * integrations. Starting sends back the fingerprint shown here, so a run is refused when any of it changed meanwhile.
 */
export function RunFlowDialog({ flow, onClose }: { flow: FlowListing; onClose: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const fixedRepo = flow.source === 'repo' ? flow.repoId : undefined
  const [repoId, setRepoId] = useState(fixedRepo ?? repos[0]?.id ?? '')
  const repo = repos.find((r) => r.id === repoId)
  const [base, setBase] = useState(repo?.defaultBranch ?? 'main')
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { preview, error } = useFlowPreview(flow.id, repoId, base)

  useEffect(() => {
    if (!repoId) return
    let live = true
    setBranches(null)
    api
      .listBranches(repoId)
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches([]))
    return () => {
      live = false
    }
  }, [repoId])

  const ready = flowStartReady(preview, values) && Boolean(base.trim()) && !busy
  const name = flowTitle(flow, t)

  const start = async () => {
    if (!preview) return
    setBusy(true)
    const run = await attempt(() => api.startFlowRun({ flowId: flow.id, source: flow.source, repoId, baseBranch: base, inputs: values, shown: preview.fingerprint }))
    setBusy(false)
    if (!run) return
    showToast(t('flowRun.dialog.started', { name }))
    onClose()
  }

  const branchOptions = [...new Set([base, ...(branches ?? []).map((b) => b.name)])].map((b) => ({ value: b, label: b }))
  const summary = preview?.summary
  const blocked = summary && (summary.notClaude.length > 0 || summary.problems.length > 0)
  // The outline marks a step that isn't on Claude; a file it can't read leaves that to the approval's own callout.
  const outlined = useMemo(() => 'flow' in parseFlow(flow.toml, flow.source, t), [flow.toml, flow.source, t])

  return (
    <Dialog
      title={t('flowRun.dialog.title', { name })}
      onClose={onClose}
      size="xl"
      footer={
        <>
          <span className="faint small flow-run-foot-note">{blocked ? t('flowRun.dialog.blocked') : t('scheduleDialog.onlyWhileOpen')}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void start()}>
            {t('flowRun.dialog.start')}
          </Button>
        </>
      }
    >
      <div className="flow-run-columns">
        <section className="flow-dialog" aria-labelledby="flow-run-what">
          <h3 id="flow-run-what" className="flow-run-heading">
            {t('flowRun.dialog.whatToDo')}
          </h3>
          {!fixedRepo && (
            <Field label={t('flowRun.dialog.repo')}>
              {(c) => (
                <Select
                  {...c}
                  value={repoId}
                  options={repos.map((r) => ({ value: r.id, label: r.name }))}
                  onChange={(id) => {
                    setRepoId(id)
                    setBase(repos.find((r) => r.id === id)?.defaultBranch ?? 'main')
                  }}
                />
              )}
            </Field>
          )}
          <Field label={t('flowRun.dialog.base')} description={branches === null ? t('flowRun.dialog.loadingBranches') : t('flowRun.dialog.newWorkspace', { branch: base })}>
            {(c) => <Select {...c} value={base} options={branchOptions} onChange={setBase} />}
          </Field>
          <FlowInputFields preview={preview} values={values} onChange={setValues} />
        </section>
        <section className="flow-dialog" aria-labelledby="flow-run-does">
          <h3 id="flow-run-does" className="flow-run-heading">
            {t('flowRun.dialog.whatItDoes')}
          </h3>
          <FlowStepOutline flow={flow} notClaude={summary?.notClaude} />
          <FlowApproval flow={flow} summary={summary} error={error} stepsShown={outlined} />
        </section>
      </div>
    </Dialog>
  )
}
