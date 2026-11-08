// The workspace's Flow tab (docs/loops-and-graphs.md, "Running a flow" and "Showing a graph"): the run this workspace
// belongs to, where it is (or ended) in words and as a row of its steps, its loop bounds, Stop, the run drawn as a
// diagram through one of four lenses (Run · Context · Memory · Data) with what that lens adds in words, and its steps in
// run order with their facts. The step list is the
// diagram's accessible equivalent: each card's last line follows the lens. A step opens the chat tab, the checks or the
// workspace it stands for (a run that makes more than one workspace shows it in each).
import { Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FLOW_LENSES, LENS_WORD, flowGraph, type FlowLens } from '../../../shared/flowGraph'
import { FLOW_COMPACT_ABOVE, currentLoopBounds, flowProgress, isActiveRun, parseFlow, runForWorkspace, type Flow, type FlowRun, type FlowRunStep } from '../../../shared/flows'
import { formatCompact } from '../../../shared/i18n/time'
import type { ApprovalRequest } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { api, attempt, selectSession, selectWorkspace, showChecksPanel, timeAgo, useStore } from '../store'
import { Button, Callout, Card, CardButton, Glyph, Meter, Segmented, Status, Stepper, Tag, type GlyphName, type StepperStep, type StepperTone } from '../ui'
import { RUN_STATE, RUN_TONE, STEP_KIND, STEP_STATE, STEP_TONE } from './automations/flowRunWords'
import { FlowLensDiagram } from './FlowDiagram'
import './flowRun.css'

/** The run a workspace's Flow tab shows: its active run, else its latest; none while Flows are off. */
export function useWorkspaceFlowRun(workspaceId: string) {
  return useStore((s) => (s.snapshot?.settings.flows ? runForWorkspace(s.snapshot.flowRuns, workspaceId) : undefined))
}

/**
 * The flow a run ran, as its file says now, when that is still the revision the run started from; otherwise undefined,
 * and the diagram is drawn from the run's own records (the steps that ran and the facts they went on by).
 */
function useRunFlow(run: FlowRun | undefined): Flow | undefined {
  const key = run ? `${run.repoId}|${run.flow.id}|${run.flow.rev ?? ''}` : ''
  const [read, setRead] = useState<{ key: string; flow?: Flow }>()
  useEffect(() => {
    if (!run) return
    let live = true
    api
      .listFlows(run.repoId)
      .then((list) => {
        const listing = list?.find((f) => f.id === run.flow.id)
        const same = listing && !listing.problems.length && (!listing.rev || !run.flow.rev || listing.rev === run.flow.rev)
        const parsed = same ? parseFlow(listing.toml, listing.source) : undefined
        if (live) setRead({ key, flow: parsed && 'flow' in parsed ? parsed.flow : undefined })
      })
      .catch(() => live && setRead({ key }))
    return () => {
      live = false
    }
    // The run's flow is fixed by `key`.
  }, [key])
  return read?.key === key ? read.flow : undefined
}

const percentOf = (used: number, limit: number, t: RendererT) => new Intl.NumberFormat(t.locale, { style: 'percent', maximumFractionDigits: 0 }).format(limit > 0 ? used / limit : 0)

/** "97K of 1M (10%)". */
function usageText(usage: { used: number; limit: number }, t: RendererT): string {
  return t('flowRun.context.usage', { used: formatCompact(usage.used, t.locale), limit: formatCompact(usage.limit, t.locale), percent: percentOf(usage.used, usage.limit, t) })
}

/** "abc1234 → def5678", either side "unknown" when it wasn't read. */
function treesText(step: FlowRunStep, t: RendererT): string | undefined {
  const { start, end } = step.tree ?? {}
  if (!start && !end) return undefined
  const unknown = t('flowRun.data.unknown')
  return t('flowRun.data.trees', { start: start?.slice(0, 7) ?? unknown, end: (end ?? start)?.slice(0, 7) ?? unknown })
}

const isAgentStep = (step: FlowRunStep) => step.kind === 'turn' || step.kind === 'review' || step.kind === 'decide'

export function FlowRunPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const run = useWorkspaceFlowRun(workspaceId)
  const [lens, setLens] = useState<FlowLens>('run')
  const flow = useRunFlow(run)
  const workspaces = useStore((s) => s.snapshot?.workspaces)
  const names = useMemo(() => Object.fromEntries((workspaces ?? []).map((w) => [w.id, w.name])), [workspaces])
  if (!run) return null
  const active = isActiveRun(run)
  const bounds = active ? currentLoopBounds(run) : []
  const last = run.steps.at(-1)
  return (
    <div className="flow-run">
      <div className="flow-run-head">
        <div className="flow-run-title">
          <strong>{run.flow.name}</strong>
          <Status tone={RUN_TONE[run.state]} label={t(RUN_STATE[run.state])} />
        </div>
        {active && run.current && <span className="small">{t('flowRun.panel.at', { step: run.current.step, iteration: run.current.iteration })}</span>}
        {!active && run.state !== 'completed' && last && <span className="small">{t('flowRun.panel.endedAt', { step: last.name, iteration: last.iteration, when: timeAgo(run.endedAt ?? last.endedAt ?? last.startedAt) })}</span>}
        {run.state === 'completed' && run.endedAt && <span className="small">{t('flowRun.panel.finished', { when: timeAgo(run.endedAt) })}</span>}
        {bounds.map((b) => (
          <span key={b.loop} className="faint small">
            {[
              b.maxIterations ? t('flowRun.panel.loopIterationsMax', { loop: b.loop, iteration: b.iteration, max: b.maxIterations }) : t('flowRun.panel.loopIterations', { loop: b.loop, iteration: b.iteration }),
              b.maxMinutes ? t('flowRun.panel.loopMinutes', { minutes: b.minutes, max: b.maxMinutes }) : null,
              b.maxCost !== undefined ? t('flowRun.panel.loopCost', { cost: (b.cost ?? 0).toFixed(2), max: b.maxCost.toFixed(2) }) : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ))}
        {run.reason && (active || run.state === 'completed') && <span className="small">{run.reason}</span>}
        <span className="faint small">{t('flowRun.panel.started', { when: timeAgo(run.startedAt) })}</span>
        {active && (
          <span>
            <Button size="sm" onClick={() => void attempt(() => api.stopFlowRun(run.id))}>
              <Square size={12} aria-hidden /> {t('flowRun.panel.stop')}
            </Button>
          </span>
        )}
      </div>
      <Progress flow={flow} run={run} />
      <GateCard runId={run.id} />
      {!active && run.state !== 'completed' && run.reason && <StoppedCard workspaceId={workspaceId} run={run} />}
      <Segmented<FlowLens> small label={t('flowRun.lens.label')} value={lens} onChange={setLens} options={FLOW_LENSES.map((l) => ({ value: l, label: t(LENS_WORD[l]) }))} />
      <FlowLensDiagram flow={flow} run={run} lens={lens} workspaceNames={names} direction="TB" onSelect={(id) => id && openStep(workspaceId, run, id)} />
      {lens === 'context' && <ContextRows run={run} />}
      {lens === 'memory' && <MemoryRows run={run} flow={flow} />}
      {lens === 'data' && <DataRows run={run} />}
      {run.steps.length ? (
        <ol className="flow-run-steps" aria-label={t('flowRun.panel.steps')}>
          {run.steps.map((step, n) => (
            <li key={n}>
              <StepCard workspaceId={workspaceId} step={step} lens={lens} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint small">{t('flowRun.panel.empty')}</p>
      )}
    </div>
  )
}

/** A step selected on the graph opens what it stands for, as its card does: its latest turn, the checks, its workspace. */
function openStep(workspaceId: string, run: FlowRun, nodeId: string): void {
  const name = nodeId.replace(/^step:/, '')
  const step = [...run.steps].reverse().find((s) => s.name === name)
  if (!step) return
  const where = step.workspaceId ?? workspaceId
  if (step.kind === 'checks') showChecksPanel(where)
  else if (step.kind === 'workspace' && step.workspaceId) selectWorkspace(step.workspaceId)
  else if (step.sessionId) selectSession(where, step.sessionId)
}

/**
 * The gate this run waits at, answered here as on the approval panel: Continue, Send back (the panel takes a note) or
 * Stop. Nothing when it waits for nothing.
 */
function GateCard({ runId }: { runId: string }) {
  const t = useT()
  const gate = useStore((s) => s.approvals.find((a): a is Extract<ApprovalRequest, { kind: 'gate' }> => a.kind === 'gate' && a.flowRunId === runId))
  if (!gate) return null
  const answer = (choice: 'continued' | 'sent-back' | 'stopped') => void attempt(() => api.respondApproval(gate.id, { kind: 'gate', answer: choice }))
  return (
    <Callout
      tone="warn"
      role="status"
      title={t('flowRun.gate.heading', { flow: gate.flowName, step: gate.step })}
      actions={
        <>
          <Button size="sm" variant="primary" onClick={() => answer('continued')}>
            {t('flowRun.gate.continue')}
          </Button>
          <Button size="sm" onClick={() => answer('sent-back')}>
            {t('flowRun.gate.sendBack')}
          </Button>
          <Button size="sm" onClick={() => answer('stopped')}>
            {t('flowRun.gate.stop')}
          </Button>
        </>
      }
    >
      {gate.ask}
    </Callout>
  )
}

const PROGRESS_TONE: Partial<Record<FlowRunStep['state'], StepperTone>> = { completed: 'ok', running: 'info', waiting: 'warn', failed: 'error' }
const PROGRESS_GLYPH: Partial<Record<FlowRunStep['state'], GlyphName>> = { waiting: 'warn', failed: 'error', stopped: 'off' }

/**
 * Where the run is, at a glance: the steps it ran, the one it is at (or ended at), then the ones it hasn't reached. A
 * state other than done carries its glyph and, where the run is, its word, so it isn't colour alone.
 */
function Progress({ flow, run }: { flow?: Flow; run: FlowRun }) {
  const t = useT()
  const steps = flowProgress(flow, run)
  if (!steps.length) return null
  return (
    <Stepper
      label={t('flowRun.panel.progress')}
      statusText={{ done: t('flowRun.panel.progressDone'), upcoming: t('flowRun.panel.progressNotYet') }}
      steps={steps.map((s): StepperStep => {
        const name = s.runs > 1 ? `${s.name} ×${s.runs}` : s.name
        const ran = s.state !== 'not-yet' ? s.state : undefined
        const tone = ran && PROGRESS_TONE[ran]
        const glyph = ran && PROGRESS_GLYPH[ran]
        return {
          id: s.name,
          label: (
            <span title={name}>
              {name}
              {s.at && ran && <span className="sr-only">, {t(STEP_STATE[ran])}</span>}
            </span>
          ),
          status: s.at ? 'current' : ran ? 'done' : 'upcoming',
          ...(tone ? { tone } : {}),
          ...(glyph ? { icon: <Glyph name={glyph} /> } : {})
        }
      })}
    />
  )
}

/** Why a run stopped short, with the way to what stopped it: the checks, or the chat of the step it stopped at. */
function StoppedCard({ workspaceId, run }: { workspaceId: string; run: FlowRun }) {
  const t = useT()
  const last = run.steps.at(-1)
  const where = last?.workspaceId ?? workspaceId
  return (
    <Callout
      tone={run.state === 'failed' ? 'error' : 'warn'}
      role="status"
      title={t('flowRun.panel.stoppedTitle')}
      actions={
        last?.kind === 'checks' ? (
          <Button size="sm" onClick={() => showChecksPanel(where)}>
            {t('flowRun.panel.openChecks')}
          </Button>
        ) : last?.sessionId ? (
          <Button size="sm" onClick={() => selectSession(where, last.sessionId!)}>
            {t('flowRun.panel.openTab')}
          </Button>
        ) : undefined
      }
    >
      {run.reason}
    </Callout>
  )
}

/** Context: per agent step, what it was shown (its latest turn) and how full its window was, per pass for a loop. */
function ContextRows({ run }: { run: FlowRun }) {
  const t = useT()
  const steps = [...new Set(run.steps.filter(isAgentStep).map((s) => s.name))]
  if (!steps.length) return null
  return (
    <ul className="flow-lens-rows" aria-label={t('flowRun.context.title')}>
      {steps.map((name) => {
        const mine = run.steps.filter((s) => s.name === name)
        const shown = mine.at(-1)?.shown ?? []
        const usages = mine.filter((s) => s.usage).map((s) => s.usage!)
        const usage = usages.at(-1)
        const share = usage && usage.limit > 0 ? (usage.used / usage.limit) * 100 : 0
        return (
          <li key={name} className="flow-lens-row">
            <strong>{name}</strong>
            <span className="flow-lens-tags">
              {shown.length ? (
                shown.map((ref) => (
                  <Tag key={ref} mono>
                    {ref}
                  </Tag>
                ))
              ) : (
                <span className="faint small">{t('flowRun.context.nothingShown')}</span>
              )}
            </span>
            {usage ? (
              <span className="flow-lens-usage">
                <Meter className="flow-lens-meter" value={usage.used} max={usage.limit} label={t('flowRun.context.usageLabel', { step: name })} valueText={usageText(usage, t)} tone={share >= 90 ? 'error' : share >= FLOW_COMPACT_ABOVE ? 'warn' : 'ok'} />
                <span className="small">{usageText(usage, t)}</span>
              </span>
            ) : (
              <span className="faint small">{t('flowRun.context.noUsage')}</span>
            )}
            {usages.length > 1 && usage && <span className="faint small">{t('flowRun.context.series', { series: usages.map((u) => formatCompact(u.used, t.locale)).join(' → '), limit: formatCompact(usage.limit, t.locale) })}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** Memory: the run ledger (a line per step and iteration), then what outlives a step with how often it was read and written. */
function MemoryRows({ run, flow }: { run: FlowRun; flow?: Flow }) {
  const t = useT()
  const graph = useMemo(() => flowGraph(flow, run, 'memory', { t, locale: t.locale }), [flow, run, t])
  const none = '—'
  const memory = graph.nodes.filter((n) => n.kind === 'memory')
  return (
    <div className="flow-lens-rows">
      {run.steps.length > 0 && (
        <table className="flow-ledger">
          <caption className="small">{t('flowRun.memory.ledger')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('flowRun.memory.step')}</th>
              <th scope="col">{t('flowRun.memory.iteration')}</th>
              <th scope="col">{t('flowRun.memory.fact')}</th>
              <th scope="col">{t('flowRun.memory.shown')}</th>
              <th scope="col">{t('flowRun.memory.delta')}</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((s, i) => (
              <tr key={i}>
                <td>{s.name}</td>
                <td>{s.iteration}</td>
                <td>{s.fact ?? none}</td>
                <td>{s.shown?.length ? s.shown.join(', ') : none}</td>
                <td>{s.delta ? t('flowRun.panel.delta', { count: s.delta.files, additions: s.delta.additions, deletions: s.delta.deletions }) : none}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {memory.length > 0 && (
        <ul className="flow-lens-rows" aria-label={t('flowRun.memory.nodes')}>
          {memory.map((n) => {
            const reads = graph.edges.filter((e) => e.from === n.id && e.kind === 'read' && e.taken).length
            const writes = graph.edges.filter((e) => e.to === n.id && e.kind === 'write' && e.taken).length
            return (
              <li key={n.id} className="flow-lens-row">
                <strong>{n.label}</strong>
                <span className="faint small">{t('flowRun.memory.counts', { reads, writes })}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Data: each step's start → end tree, with "Moved" where its start wasn't where the step before it ended. */
function DataRows({ run }: { run: FlowRun }) {
  const t = useT()
  if (!run.steps.length) return null
  return (
    <ul className="flow-lens-rows" aria-label={t('flowRun.data.title')}>
      {run.steps.map((s, i) => (
        <li key={i} className="flow-lens-row">
          <strong>{s.name}</strong>
          <span className="faint small">{t('flowRun.panel.kindRun', { kind: t(STEP_KIND[s.kind]), n: s.iteration })}</span>
          <span className="small">{treesText(s, t) ?? t('flowRun.data.noTrees')}</span>
          {s.moved && <Status tone="warn" label={t('flowRun.data.moved')} />}
        </li>
      ))}
    </ul>
  )
}

/** The card's lens line: the window for Context, the memory files written for Memory, the trees for Data. */
function LensLine({ step, lens }: { step: FlowRunStep; lens: FlowLens }) {
  const t = useT()
  if (lens === 'context') return step.usage ? <span className="faint small">{usageText(step.usage, t)}</span> : null
  if (lens === 'memory') {
    if (step.memoryWrites?.length) return <span className="small">{t('flowRun.memory.wrote', { files: step.memoryWrites.join(', ') })}</span>
    return isAgentStep(step) && step.endedAt ? <span className="faint small">{t('flowRun.memory.noWrites')}</span> : null
  }
  if (lens === 'data') {
    const trees = treesText(step, t)
    if (!trees && !step.moved) return null
    return (
      <span className="flow-step-head">
        {trees && <span className="faint small">{trees}</span>}
        {step.moved && <Status tone="warn" label={t('flowRun.data.moved')} />}
      </span>
    )
  }
  return null
}

/** One execution of a step; a button when there is a tab or check run to open for it. */
function StepCard({ workspaceId, step, lens }: { workspaceId: string; step: FlowRunStep; lens: FlowLens }) {
  const t = useT()
  const kind = t(STEP_KIND[step.kind])
  const elsewhere = useStore((s) => (step.workspaceId && step.workspaceId !== workspaceId ? (s.snapshot?.workspaces.find((w) => w.id === step.workspaceId)?.name ?? step.workspaceId) : undefined))
  const loops = Object.entries(step.loops ?? {})
  const body = (
    <>
      <span className="flow-step-head">
        <Status tone={STEP_TONE[step.state]} label={t(STEP_STATE[step.state])} />
        <strong>{step.name}</strong>
        <span className="faint small">{t('flowRun.panel.kindRun', { kind, n: step.iteration })}</span>
      </span>
      {step.persona && <span className="small">{t(step.readOnly ? 'flowRun.panel.personaReadOnly' : 'flowRun.panel.persona', { persona: step.persona })}</span>}
      {loops.length > 0 && <span className="faint small">{t('flowRun.panel.inLoops', { loops: loops.map(([name, i]) => t('flowRun.panel.loopAt', { loop: name, iteration: i })).join(', ') })}</span>}
      {step.detail && <span className="small">{step.detail}</span>}
      {step.delta && <span className="faint small">{t('flowRun.panel.delta', { count: step.delta.files, additions: step.delta.additions, deletions: step.delta.deletions })}</span>}
      {step.shown && step.shown.length > 0 && <span className="faint small">{t('flowRun.panel.shown', { sections: step.shown.join(', ') })}</span>}
      {step.costUsd !== undefined && <span className="faint small">{t('flowRun.panel.cost', { cost: step.costUsd.toFixed(2) })}</span>}
      {elsewhere && <span className="faint small">{t('flowRun.panel.inWorkspace', { workspace: elsewhere })}</span>}
      {step.fact && <span className="faint small">{t('flowRun.panel.fact', { fact: step.fact })}</span>}
      <LensLine step={step} lens={lens} />
    </>
  )
  const where = step.workspaceId ?? workspaceId
  const open =
    step.kind === 'checks' || step.kind === 'script'
      ? step.kind === 'checks'
        ? () => showChecksPanel(where)
        : undefined
      : step.kind === 'workspace' && step.workspaceId
        ? () => selectWorkspace(step.workspaceId!)
        : step.sessionId
          ? () => selectSession(where, step.sessionId!)
          : undefined
  if (!open) return <Card className="flow-step">{body}</Card>
  return (
    <CardButton className="flow-step" onClick={open} title={t(step.kind === 'checks' ? 'flowRun.panel.openChecks' : step.kind === 'workspace' ? 'flowRun.panel.openWorkspace' : 'flowRun.panel.openTab')}>
      {body}
    </CardButton>
  )
}
