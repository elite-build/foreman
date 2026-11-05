// Flows on Automations (docs/loops-and-graphs.md), shown only while Settings → Experimental → Flows is on: the built-in,
// repository and personal flows as cards, and a dialog to read one or write a personal one with live validation.
// Run… starts a flow in a new workspace after showing what the run approves; each flow lists its recent runs. The
// Personas section (who a flow's step is) follows, with the flows that name each one.
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FLOW_STARTERS, type FlowStarter } from '../../../../shared/flowStarters'
import { parseFlow, type FlowListing } from '../../../../shared/flows'
import type { BranchInfo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, selectWorkspace, showToast, timeAgo, useStore } from '../../store'
import { ActionRow, Button, Callout, Dialog, Field, LinkButton, Select, Status, TextArea } from '../../ui'
import { FlowLensDiagram, useSettled } from '../FlowDiagram'
import { FlowApproval, FlowInputFields, flowStartReady, flowTitle, ProblemList, SourceTags, STARTER_NAME, summaryText, useFlowPreview } from './FlowStartFields'
import { RUN_STATE, RUN_TONE } from './flowRunWords'
import { PersonasSection } from './PersonasSection'

type Editing = { flow?: FlowListing; toml: string; starter?: FlowStarter['id'] }

export function FlowsSection({ query }: { query: string }) {
  const on = useStore((s) => Boolean(s.snapshot?.settings.flows))
  return on ? <FlowList query={query} /> : null
}

function FlowList({ query }: { query: string }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const [flows, setFlows] = useState<FlowListing[]>([])
  const [open, setOpen] = useState<Editing | null>(null)
  const [running, setRunning] = useState<FlowListing | null>(null)
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
  const startNew = () => setOpen({ toml: FLOW_STARTERS[0].toml, starter: FLOW_STARTERS[0].id })
  const usedBy = (name: string) => flows.filter((f) => f.summary?.personas.some((p) => p.toLowerCase() === name.toLowerCase())).map((f) => flowTitle(f, t))

  return (
    <>
      {(!needle || shown.length > 0) && (
        <section aria-label={t('automations.flows')}>
          <div className="auto-side-head">
            <span>{t('automations.flows')}</span>
            <span className="auto-side-tools">
              <LinkButton size="sm" onClick={startNew}>
                <Plus size={12} aria-hidden /> {t('automations.flows.new')}
              </LinkButton>
            </span>
          </div>
          <p className="faint small auto-side-note">{t('automations.flows.note')}</p>
          <div className="auto-cards">
            {shown.map((flow) => (
              <div key={flow.id} className="flow-item">
                <FlowCard flow={flow} onOpen={() => setOpen({ flow, toml: flow.toml })} onRun={() => setRunning(flow)} />
                <FlowRuns flow={flow} />
              </div>
            ))}
          </div>
          {running && <RunFlowDialog flow={running} onClose={() => setRunning(null)} />}
          {open && (
            <FlowDialog
              editing={open}
              onCopy={(toml) => setOpen({ toml })}
              onClose={() => setOpen(null)}
              onSaved={() => {
                setOpen(null)
                void load()
              }}
            />
          )}
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

/**
 * A new personal flow (from a starter), a personal one to edit, or a built-in or repository one to read. The document
 * is checked as it is typed, with the same rules main applies when saving.
 */
function FlowDialog({ editing, onCopy, onClose, onSaved }: { editing: Editing; onCopy: (toml: string) => void; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const { flow } = editing
  const editable = !flow || flow.source === 'personal'
  const [toml, setToml] = useState(editing.toml)
  const [starter, setStarter] = useState<FlowStarter['id'] | undefined>(editing.starter)
  const [refused, setRefused] = useState<string[] | null>(null)
  const parsed = useMemo(() => parseFlow(toml, editable ? 'personal' : flow.source, t), [toml, editable, flow, t])
  const problems = refused ?? ('problems' in parsed ? parsed.problems : [])
  const { warnings } = parsed
  // The run graph as a read-only picture of the document, drawn once typing pauses (a file to read is drawn at once).
  const settled = useSettled(toml, editable ? 400 : 0)
  const preview = useMemo(() => {
    const read = settled === toml ? parsed : parseFlow(settled, editable ? 'personal' : flow.source, t)
    return 'flow' in read ? read.flow : undefined
  }, [settled, toml, parsed, editable, flow, t])

  // A different document (Copy to personal) starts over.
  useEffect(() => {
    setToml(editing.toml)
    setStarter(editing.starter)
    setRefused(null)
  }, [editing])

  const save = async () => {
    const result = await attempt(() => api.savePersonalFlow({ id: flow?.id, toml }))
    if (!result) return
    if ('problems' in result) setRefused(result.problems)
    else onSaved()
  }
  const remove = async () => {
    if (!flow) return
    if ((await attempt(async () => (await api.deletePersonalFlow(flow.id), true))) === true) onSaved()
  }

  const title = !flow ? t('automations.flows.new') : editable ? t('automations.flows.edit') : flowTitle(flow, t)
  const footer = editable ? (
    <>
      {flow && (
        <LinkButton danger onClick={() => void remove()}>
          {t('common.delete')}
        </LinkButton>
      )}
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={problems.length > 0} onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => onCopy(flow.toml)}>{t('automations.flows.copy')}</Button>
      <Button variant="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  )

  return (
    <Dialog title={title} onClose={onClose} closeOnBackdrop={!editable} size="lg" footer={footer}>
      <div className="flow-dialog">
        {editing.starter && (
          <Field label={t('automations.flows.startFrom')}>
            {(c) => (
              <Select
                {...c}
                value={starter ?? FLOW_STARTERS[0].id}
                options={FLOW_STARTERS.map((s) => ({ value: s.id, label: t(STARTER_NAME[s.id]) }))}
                onChange={(id) => {
                  setStarter(id)
                  setToml(FLOW_STARTERS.find((s) => s.id === id)!.toml)
                  setRefused(null)
                }}
              />
            )}
          </Field>
        )}
        {!editable && (
          <Callout tone="info" role="note">
            {t('automations.flows.readOnly')}
          </Callout>
        )}
        {preview && (
          <div className="flow-preview">
            <span className="small">{t('automations.flows.preview')}</span>
            <FlowLensDiagram flow={preview} lens="run" />
          </div>
        )}
        <Field label={t('automations.flows.toml')} description={editable ? t('automations.flows.tomlHelp') : undefined}>
          {(c) => (
            <TextArea
              {...c}
              mono
              rows={18}
              spellCheck={false}
              readOnly={!editable}
              value={toml}
              onChange={(e) => {
                setToml(e.target.value)
                setRefused(null)
              }}
            />
          )}
        </Field>
        {problems.length > 0 ? (
          <Callout tone="error" role="status" title={t('automations.flows.problemsTitle')}>
            <ProblemList items={problems} />
          </Callout>
        ) : (
          editable && (
            <Callout tone="ok" role="status">
              {t('automations.flows.valid')}
            </Callout>
          )
        )}
        {warnings.length > 0 && (
          <Callout tone="warn" role="status" title={t('automations.flows.warningsTitle')}>
            <ProblemList items={warnings} />
          </Callout>
        )}
      </div>
    </Dialog>
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
 * Run…: the repository (for a personal or built-in flow), the base branch, the flow's inputs, and what starting it
 * approves (FlowStartFields): the flow file and its revision, templates, personas, setup, checks, MCP servers and
 * integrations. Starting sends back the fingerprint shown here, so a run is refused when any of it changed meanwhile.
 */
function RunFlowDialog({ flow, onClose }: { flow: FlowListing; onClose: () => void }) {
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

  return (
    <Dialog
      title={t('flowRun.dialog.title', { name })}
      onClose={onClose}
      size="lg"
      headerExtra={<span className="faint small">{t('scheduleDialog.onlyWhileOpen')}</span>}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void start()}>
            {t('flowRun.dialog.start')}
          </Button>
        </>
      }
    >
      <div className="flow-dialog">
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
        <Field label={t('flowRun.dialog.base')} description={branches === null ? t('flowRun.dialog.loadingBranches') : undefined}>
          {(c) => <Select {...c} value={base} options={branchOptions} onChange={setBase} />}
        </Field>
        <FlowInputFields preview={preview} values={values} onChange={setValues} />
        <FlowApproval flow={flow} summary={preview?.summary} error={error} />
      </div>
    </Dialog>
  )
}
