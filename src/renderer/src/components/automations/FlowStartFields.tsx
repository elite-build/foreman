// What starting a flow shows wherever it starts (docs/loops-and-graphs.md, "Running a flow"): the Run dialog on
// Automations, New workspace's Start with › Flow, and a flow schedule. The flow's name and source, a picker of the
// repository's runnable flows, one field per input, its run graph, and the approval card (the flow file, templates,
// personas, setup, checks, MCP servers, integrations, what a completed run does with its workspaces) with the Claude-only
// rule and why it can't start. Feature compositions of ui/ pieces only; the caller owns the dialog and what Start does.
import { useEffect, useMemo, useState } from 'react'
import { FLOW_AFTER, parseFlow, type FlowAfter, type FlowListing, type FlowPersonaRef, type FlowRunPreview, type FlowRunSummary } from '../../../../shared/flows'
import type { FlowStarter } from '../../../../shared/flowStarters'
import type { PlainKey } from '../../../../shared/i18n'
import { useT, type RendererT } from '../../i18n'
import { api, useStore } from '../../store'
import { Callout, Card, Field, RadioCards, Tag, TextInput, type RadioCardOption } from '../../ui'
import { FlowLensDiagram } from '../FlowDiagram'

export const STARTER_NAME: Record<FlowStarter['id'], PlainKey> = {
  'fix-until-green': 'automations.flows.starter.fixUntilGreen',
  'research-then-implement': 'automations.flows.starter.researchThenImplement'
}

/** A flow's title: a built-in starter's in the app's language, otherwise the name in its file. */
export function flowTitle(flow: Pick<FlowListing, 'starter' | 'name'>, t: RendererT): string {
  const starter = flow.starter as FlowStarter['id'] | undefined
  return starter && STARTER_NAME[starter] ? t(STARTER_NAME[starter]) : flow.name
}

/** "6 steps · 2 loops · 1 gate". */
export function summaryText(flow: FlowListing, t: RendererT): string {
  if (!flow.summary) return ''
  const { steps, loops, gates } = flow.summary
  return [t('automations.flows.steps', { count: steps }), t('automations.flows.loops', { count: loops }), t('automations.flows.gates', { count: gates })].join(' · ')
}

/** Where a flow comes from, in words: built-in, personal, or the repository's file and its revision. */
function sourceText(flow: Pick<FlowListing, 'source' | 'file' | 'rev'>, t: RendererT): string {
  if (flow.source === 'built-in') return t('automations.flows.builtIn')
  if (flow.source === 'personal') return t('automations.flows.personal')
  return t('automations.flows.fileRev', { file: flow.file ?? '', rev: flow.rev?.slice(0, 7) ?? '' })
}

/** Where a flow comes from, as tags: built-in, personal, or the repository with the file and its revision. */
export function SourceTags({ flow }: { flow: FlowListing }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === flow.repoId)?.name)
  if (flow.source === 'built-in') return <Tag>{t('automations.flows.builtIn')}</Tag>
  if (flow.source === 'personal') return <Tag>{t('automations.flows.personal')}</Tag>
  return (
    <>
      <Tag>{t('automations.flows.fromRepo', { repo: repo ?? '' })}</Tag>
      <Tag mono>{t('automations.flows.fileRev', { file: flow.file ?? '', rev: flow.rev?.slice(0, 7) ?? '' })}</Tag>
    </>
  )
}

export function ProblemList({ items }: { items: string[] }) {
  return (
    <ul className="flow-problems">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

/** The flows a run in this repository may start: built-in, the repository's and personal ones that read as flows. Null while loading. */
export function useRunnableFlows(repoId: string | undefined, on = true): FlowListing[] | null {
  const [flows, setFlows] = useState<FlowListing[] | null>(null)
  useEffect(() => {
    if (!repoId || !on) return
    let live = true
    setFlows(null)
    api
      .listFlows(repoId)
      .then((list) => live && setFlows(list.filter((f) => !f.problems.length)))
      .catch(() => live && setFlows([]))
    return () => {
      live = false
    }
  }, [repoId, on])
  return flows
}

/** What starting this flow here would approve, and the inputs it asks for; again whenever the flow, repository or branch changes. */
export function useFlowPreview(flowId: string | undefined, repoId: string, baseBranch: string): { preview: FlowRunPreview | null; error: string | null } {
  const [preview, setPreview] = useState<FlowRunPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setPreview(null)
    setError(null)
    if (!flowId || !repoId) return
    let live = true
    api
      .flowRunPreview({ flowId, repoId, baseBranch })
      .then((next) => live && setPreview(next))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [flowId, repoId, baseBranch])
  return { preview, error }
}

/** Whether a preview can start: nothing refuses it and every input it asks for has a value. */
export function flowStartReady(preview: FlowRunPreview | null, values: Record<string, string>): boolean {
  const summary = preview?.summary
  if (!preview || !summary || summary.notClaude.length || summary.problems.length) return false
  return preview.inputs.every((i) => values[i.name]?.trim())
}

/** One text field per input the flow asks for: its [inputs] and its templates' {{placeholders}}. */
export function FlowInputFields({ preview, values, onChange }: { preview: FlowRunPreview | null; values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
  return (
    <>
      {(preview?.inputs ?? []).map((input) => (
        <Field key={input.name} label={input.name} description={input.description || undefined}>
          {(c) => <TextInput {...c} value={values[input.name] ?? ''} onChange={(e) => onChange({ ...values, [input.name]: e.target.value })} />}
        </Field>
      ))}
    </>
  )
}

/** "6 steps · 2 loops · 1 gate · architect, developer": a flow picker card's line. */
function pickerLine(flow: FlowListing, t: RendererT): string {
  const personas = flow.summary?.personas ?? []
  return [sourceText(flow, t), summaryText(flow, t), ...(personas.length ? [personas.join(', ')] : [])].filter(Boolean).join(' · ')
}

/** The repository's runnable flows as cards: each with where it comes from, its steps, loops and gates, and its personas. */
export function FlowPicker({ flows, value, onChange, legend }: { flows: FlowListing[]; value: string | undefined; onChange: (id: string) => void; legend: string }) {
  const t = useT()
  const options: RadioCardOption<string>[] = flows.map((flow) => ({ value: flow.id, label: flowTitle(flow, t), description: pickerLine(flow, t) }))
  return <RadioCards className="flow-picker" layout="stack" legend={legend} value={value} onChange={onChange} options={options} />
}

/** The flow's run graph, read-only, as the Flows dialog draws it. */
export function FlowRunGraph({ flow }: { flow: FlowListing }) {
  const t = useT()
  const parsed = useMemo(() => parseFlow(flow.toml, flow.source, t), [flow.toml, flow.source, t])
  if (!('flow' in parsed)) return null
  return (
    <div className="flow-preview">
      <span className="small">{t('automations.flows.preview')}</span>
      <FlowLensDiagram flow={parsed.flow} lens="run" />
    </div>
  )
}

/** Where a persona a run approves comes from: built-in, personal (and when it was saved), or its file and revision. */
function personaWhere(p: FlowPersonaRef, t: RendererT): string {
  const base = p.source === 'built-in' ? t('automations.flows.builtIn') : p.source === 'personal' ? t('automations.flows.personal') : t('automations.flows.fileRev', { file: p.file ?? '', rev: p.rev?.slice(0, 7) ?? '' })
  if (p.readOnly) return `${base} · ${t('automations.personas.readOnly')}`
  return p.writes?.length ? `${base} · ${t('automations.personas.writesOnly', { globs: p.writes.join(', ') })}` : base
}

const AFTER: Record<FlowAfter, PlainKey> = {
  keep: 'flowRun.dialog.after.keep',
  archive: 'flowRun.dialog.after.archive',
  'delete-unchanged': 'flowRun.dialog.after.deleteUnchanged'
}

/**
 * What starting the flow approves, part by part, then the rules that hold for every run (Claude only, the cost bound)
 * and why it can't start. `flow` gives the source line its file and revision.
 */
export function FlowApproval({ flow, summary, error }: { flow: Pick<FlowListing, 'source' | 'file' | 'rev'>; summary: FlowRunSummary | undefined; error?: string | null }) {
  const t = useT()
  const none = t('flowRun.dialog.none')
  return (
    <>
      {error && (
        <Callout tone="error" role="status">
          {error}
        </Callout>
      )}
      {summary && (
        <Card className="flow-run-summary">
          <strong>{t('flowRun.dialog.approval')}</strong>
          <dl className="flow-run-facts">
            <dt className="faint">{t('flowRun.dialog.flow')}</dt>
            <dd>
              {sourceText(flow, t)} · {[t('automations.flows.steps', { count: summary.steps }), t('automations.flows.loops', { count: summary.loops }), t('automations.flows.gates', { count: summary.gates })].join(' · ')}
            </dd>
            <dt className="faint">{t('flowRun.dialog.templates')}</dt>
            <dd>{summary.templates.length ? summary.templates.map((x) => (x.rev ? `${x.name} @ ${x.rev.slice(0, 7)}` : x.name)).join(', ') : none}</dd>
            <dt className="faint">{t('flowRun.dialog.personas')}</dt>
            <dd>{summary.personas.length ? summary.personas.map((p) => t('flowRun.dialog.personaWhere', { name: p.name, where: personaWhere(p, t) })).join(', ') : none}</dd>
            <dt className="faint">{t('flowRun.dialog.setup')}</dt>
            <dd>{summary.setupScript.trim() ? <code>{summary.setupScript.trim().split('\n')[0]}</code> : none}</dd>
            <dt className="faint">{t('flowRun.dialog.checks')}</dt>
            <dd>{summary.checks.length ? summary.checks.map((c) => c.name).join(', ') : none}</dd>
            {summary.commands?.length ? (
              <>
                <dt className="faint">{t('flowRun.dialog.commands')}</dt>
                <dd>{summary.commands.map((c) => c.name).join(', ')}</dd>
              </>
            ) : null}
            <dt className="faint">{t('flowRun.dialog.mcp')}</dt>
            <dd>{summary.mcpServers.length ? summary.mcpServers.join(', ') : none}</dd>
            <dt className="faint">{t('flowRun.dialog.integrations')}</dt>
            <dd>{summary.integrations.length ? summary.integrations.join(', ') : none}</dd>
            {summary.after && FLOW_AFTER.includes(summary.after) && (
              <>
                <dt className="faint">{t('flowRun.dialog.after')}</dt>
                <dd>{t(AFTER[summary.after])}</dd>
              </>
            )}
          </dl>
        </Card>
      )}
      {summary && (
        <Callout tone="info" role="note">
          {t('flowRun.dialog.claudeOnly')}
        </Callout>
      )}
      {summary?.costBound && (
        <Callout tone="info" role="note">
          {t('flowRun.dialog.costBound')}
        </Callout>
      )}
      {summary && summary.attended && summary.attended.length > 0 && (
        <Callout tone="info" role="note">
          {t('flowRun.dialog.attended', { steps: summary.attended.map((n) => `${n.step} (${n.agent})`).join(', ') })}
        </Callout>
      )}
      {summary && summary.notClaude.length > 0 && (
        <Callout tone="warn" role="status">
          {t('flowRun.dialog.notClaude', { steps: summary.notClaude.map((n) => `${n.step} (${n.agent})`).join(', ') })}
        </Callout>
      )}
      {summary && summary.problems.length > 0 && (
        <Callout tone="error" role="status" title={t('flowRun.dialog.problems')}>
          <ProblemList items={summary.problems} />
        </Callout>
      )}
    </>
  )
}
