// Run a flow (docs/loops-and-graphs.md, "Entry points"): a page in Automations, opened from a flow's Run, the flow
// studio's Run and New workspace's Flow tab. The bar on top holds what every run needs (the flow, where it starts, what
// past runs cost, Start); tabs beside the flow's graph hold the rest: its inputs, the models (a tier for every step, a
// model and effort per person), every agent step's model, and what starting approves. The graph's cards say what each
// step will run on. A run carries only the models that differ from the flow (FlowRunStart.models); they are remembered
// per flow, and a personal flow can take them into its file.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { canRunUnattended, staticCapabilities } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS, effortLabel, modelInfo, modelsFor, type AgentKind, type EffortLevel } from '../../../../shared/agents'
import { canReview } from '../../../../shared/autoReview'
import { modelWords } from '../../../../shared/flowGraph'
import { choiceFor, choicesTier, chooseFor, FLOW_TIER_MODELS, flowPeople, pastRunCost, tierChoices, withoutDefaults, writeStepModels, type FlowTier } from '../../../../shared/flowModels'
import { parseFlow, type FlowListing, type FlowModelChoices, type FlowRun, type FlowStepChoice, type FlowStepModel } from '../../../../shared/flows'
import { pickerModels, type HiddenModels } from '../../../../shared/modelVisibility'
import type { BranchInfo } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, closeAutomations, showToast, useStore } from '../../store'
import { Button, Callout, Card, Field, RadioCards, Select, Status, Tab, TabList, TabPanel, Tabs, Tag, type RadioCardOption, type SelectOption } from '../../ui'
import { FlowLensDiagram } from '../FlowDiagram'
import { FlowApproval, FlowInputFields, flowStartReady, flowTitle, useFlowPreview, useRunnableFlows } from './FlowStartFields'

const NO_HIDDEN: HiddenModels = {}
const NO_RUNS: FlowRun[] = []
type PageTab = 'task' | 'models' | 'steps' | 'approves'

const REMEMBER = 'foreman.flowRun.models'

/** The models last chosen for each flow, by flow id. */
function remembered(flowId: string): FlowModelChoices {
  try {
    const all = JSON.parse(localStorage.getItem(REMEMBER) ?? '{}') as Record<string, FlowModelChoices>
    const mine = all[flowId]
    return mine && typeof mine === 'object' && !Array.isArray(mine) ? mine : {}
  } catch {
    return {}
  }
}

function remember(flowId: string, choices: FlowModelChoices): void {
  try {
    const all = JSON.parse(localStorage.getItem(REMEMBER) ?? '{}') as Record<string, FlowModelChoices>
    if (Object.keys(choices).length) all[flowId] = choices
    else delete all[flowId]
    localStorage.setItem(REMEMBER, JSON.stringify(all))
  } catch {
    // Remembering is a convenience; the run still carries what was chosen.
  }
}

/** "Opus 5.5 · High": a choice in words. */
export function choiceWords(choice: FlowStepChoice, t: RendererT): string {
  return [modelWords(choice.model), choice.effort ? effortLabel(choice.effort as EffortLevel, t) : undefined].filter(Boolean).join(' · ')
}

export function FlowRunPage({ flowId, repoId: openRepo, baseBranch: openBase }: { flowId: string | null; repoId?: string; baseBranch?: string }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const runs = useStore((s) => s.snapshot!.flowRuns ?? NO_RUNS)
  const [repoId, setRepoId] = useState(openRepo ?? repos[0]?.id ?? '')
  const repo = repos.find((r) => r.id === repoId)
  const [base, setBase] = useState(openBase ?? repo?.defaultBranch ?? 'main')
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [reload, setReload] = useState(0)
  const flows = useRunnableFlows(repoId || undefined, true, reload)
  const [id, setId] = useState<string | null>(flowId)
  const flow = flows?.find((f) => f.id === id)
  const { preview, error } = useFlowPreview(flow?.id, repoId, base)
  const [values, setValues] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<PageTab>('task')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const steps = useMemo(() => preview?.models ?? [], [preview])
  const [choices, setChoicesState] = useState<FlowModelChoices>({})

  // The first flow listed when none was named, once the list is in.
  useEffect(() => {
    if (!id && flows?.length) setId(flows[0].id)
  }, [id, flows])

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

  // What was chosen for this flow last time, for the steps it still has.
  useEffect(() => {
    if (flow && steps.length) setChoicesState(withoutDefaults(remembered(flow.id), steps))
    else setChoicesState({})
  }, [flow, steps])

  const setChoices = useCallback(
    (next: FlowModelChoices) => {
      const kept = withoutDefaults(next, steps)
      setChoicesState(kept)
      if (flow) remember(flow.id, kept)
    },
    [flow, steps]
  )

  const parsed = useMemo(() => (flow ? parseFlow(flow.toml, flow.source, t) : undefined), [flow, t])
  const flowModel = parsed && 'flow' in parsed ? parsed.flow : undefined
  const tier = choicesTier(choices, steps)
  const past = flow ? pastRunCost(runs, flow.id) : { runs: 0 }
  const summary = preview?.summary
  // A turn chosen on an agent that can't run unattended (no one answers its approvals): the page says so where it was chosen, and Start stays off.
  const notClaude = steps.filter((s) => s.kind === 'turn' && !canRunUnattended(choiceFor(s, choices).agent))
  const refusedByFlow = (summary?.notClaude ?? []).filter((n) => !steps.some((s) => s.step === n.step && canRunUnattended(choiceFor(s, choices).agent)))
  const ready = Boolean(preview && summary && !summary.problems.length && !notClaude.length && !refusedByFlow.length && flowStartReady({ ...preview!, summary: { ...summary!, notClaude: [] } }, values) && base.trim()) && !busy

  const start = async () => {
    if (!flow || !preview || !ready) return
    setBusy(true)
    const models = withoutDefaults(choices, steps)
    const run = await attempt(() =>
      api.startFlowRun({ flowId: flow.id, source: flow.source, repoId, baseBranch: base, inputs: values, shown: preview.fingerprint, ...(Object.keys(models).length ? { models } : {}) })
    )
    setBusy(false)
    if (!run) return
    showToast(t('flowRun.dialog.started', { name: flowTitle(flow, t) }))
    closeAutomations()
  }

  const saveToFlow = async () => {
    if (!flow || flow.source !== 'personal') return
    const toml = writeStepModels(flow.toml, Object.fromEntries(steps.map((s) => [s.step, choiceFor(s, choices)]).filter(([name]) => choices[name as string])))
    const saved = await attempt(() => api.savePersonalFlow({ id: flow.id, toml }))
    if (!saved) return
    if ('problems' in saved) {
      showToast(saved.problems.join(' '))
      return
    }
    remember(flow.id, {})
    setReload((n) => n + 1)
    showToast(t('flowRunPage.saved', { name: flowTitle(flow, t) }))
  }

  const details = useMemo(() => {
    const out: Record<string, string> = {}
    for (const s of steps) {
      const words = choiceWords(choiceFor(s, choices), t)
      out[`step:${s.step}`] = words
      for (const f of s.follows ?? []) out[`step:${f}`] = t('flowRunPage.follows', { step: s.step })
    }
    return out
  }, [steps, choices, t])

  const branchOptions = [...new Set([base, ...(branches ?? []).map((b) => b.name)])].map((b) => ({ value: b, label: b }))
  const flowOptions: SelectOption<string>[] = (flows ?? []).map((f) => ({ value: f.id, label: flowTitle(f, t), group: t(SOURCE_GROUP[f.source]) }))
  const fixedRepo = flow?.source === 'repo'
  const gates = flowModel?.steps.filter((s) => s.kind === 'gate').length ?? 0

  return (
    <div className="frp">
      <div className="frp-bar" role="toolbar" aria-label={t('flowRunPage.bar')}>
        <Select<string>
          label={t('flowRunPage.flow')}
          className="frp-bar-flow"
          value={id ?? ''}
          options={flows === null ? [{ value: id ?? '', label: t('newWorkspace.flow.loading') }] : flowOptions}
          onChange={(next) => {
            setId(next)
            setValues({})
            setSelected(null)
          }}
        />
        {!fixedRepo && repos.length > 1 && (
          <Select<string>
            label={t('flowRun.dialog.repo')}
            value={repoId}
            options={repos.map((r) => ({ value: r.id, label: r.name }))}
            onChange={(next) => {
              setRepoId(next)
              setBase(repos.find((r) => r.id === next)?.defaultBranch ?? 'main')
            }}
          />
        )}
        <Select<string> label={t('flowRun.dialog.base')} value={base} options={branchOptions} onChange={setBase} />
        <span className="frp-gap" />
        <span className="faint small">{estimateText(past, t)}</span>
        <Button variant="primary" disabled={!ready} onClick={() => void start()}>
          {t('flowRun.dialog.start')}
        </Button>
      </div>
      {flows !== null && flows.length === 0 ? (
        <Status tone="off" role="status" label={t('newWorkspace.flow.none')} />
      ) : (
        <div className="frp-body">
          <div className="frp-side">
            {(notClaude.length > 0 || refusedByFlow.length > 0) && (
              <Callout tone="warn" role="status" className="frp-refused">
                {t('flowRunPage.notClaude', { steps: [...new Set([...notClaude.map((s) => s.step), ...refusedByFlow.map((n) => n.step)])].join(', ') })}
              </Callout>
            )}
            <Tabs value={tab} onChange={(v) => setTab(v as PageTab)} className="frp-tabs">
              <TabList label={t('flowRunPage.tabs')}>
                <Tab value="task">{t('flowRunPage.tab.task')}</Tab>
                <Tab value="models">
                  {t('flowRunPage.tab.models')} <Tag>{t(TIER_WORD[tier])}</Tag>
                </Tab>
                <Tab value="steps">{t('flowRunPage.tab.steps')}</Tab>
                <Tab value="approves">{t('flowRunPage.tab.approves')}</Tab>
              </TabList>
              <TabPanel value="task" className="frp-panel">
                {flowModel?.description && <p className="small">{flowModel.description}</p>}
                <FlowInputFields preview={preview} values={values} onChange={setValues} />
                {preview && preview.inputs.length === 0 && <p className="faint small">{t('flowRunPage.noInputs')}</p>}
                <p className="faint small">{t('flowRun.dialog.newWorkspace', { branch: base })}</p>
              </TabPanel>
              <TabPanel value="models" className="frp-panel">
                <TierCards tier={tier} onChange={(next) => setChoices(tierChoices(next, steps))} />
                <PeopleList steps={steps} choices={choices} onChange={setChoices} />
                {gates > 0 && <p className="small">{t('flowRunPage.youDecide', { count: gates })}</p>}
                <ModelsNote flow={flow} changed={Object.keys(choices).length > 0} onSave={() => void saveToFlow()} />
              </TabPanel>
              <TabPanel value="steps" className="frp-panel">
                <StepList steps={steps} choices={choices} onChange={setChoices} selected={selected} onSelect={setSelected} />
              </TabPanel>
              <TabPanel value="approves" className="frp-panel">
                {flow && <FlowApproval flow={flow} summary={summary} error={error} />}
              </TabPanel>
            </Tabs>
          </div>
          <div className="frp-graph">
            {flowModel && (
              <FlowLensDiagram
                flow={flowModel}
                lens="run"
                direction="TB"
                className="frp-graph-view"
                details={details}
                selected={selected ? `step:${selected}` : null}
                onSelect={(node) => {
                  const name = node?.startsWith('step:') ? node.slice(5) : null
                  const owner = name ? (steps.find((s) => s.step === name || s.follows?.includes(name))?.step ?? null) : null
                  setSelected(owner)
                  if (owner) setTab('steps')
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const SOURCE_GROUP = { 'built-in': 'automations.flows.builtIn', repo: 'flowRunPage.group.repo', personal: 'automations.flows.personal' } as const
const TIER_WORD = { faster: 'flowRunPage.tier.faster', balanced: 'flowRunPage.tier.balanced', best: 'flowRunPage.tier.best', custom: 'flowRunPage.tier.custom' } as const

function estimateText(past: { runs: number; costUsd?: number; minutes?: number }, t: RendererT): string {
  if (!past.runs) return t('flowRunPage.estimate.none')
  const parts = [past.costUsd !== undefined ? `$${past.costUsd.toFixed(2)}` : undefined, past.minutes !== undefined ? t('flowRunPage.estimate.minutes', { minutes: Math.max(1, Math.round(past.minutes)) }) : undefined].filter(Boolean)
  return t('flowRunPage.estimate.past', { count: past.runs, what: parts.join(' · ') || '—' })
}

/** Faster, Balanced, Best: what each puts the steps on, in words; Custom is shown, not picked, when the choices are none of them. */
function TierCards({ tier, onChange }: { tier: FlowTier | 'custom'; onChange: (tier: FlowTier) => void }) {
  const t = useT()
  const words = (tier: 'faster' | 'best') => ({ work: choiceWords(FLOW_TIER_MODELS[tier].work, t), check: choiceWords(FLOW_TIER_MODELS[tier].check, t) })
  const options: RadioCardOption<FlowTier | 'custom'>[] = [
    { value: 'faster', label: t('flowRunPage.tier.faster'), description: t('flowRunPage.tier.fasterNote', words('faster')) },
    { value: 'balanced', label: t('flowRunPage.tier.balanced'), description: t('flowRunPage.tier.balancedNote') },
    { value: 'best', label: t('flowRunPage.tier.best'), description: t('flowRunPage.tier.bestNote', words('best')) },
    { value: 'custom', label: t('flowRunPage.tier.custom'), ...(tier === 'custom' ? { description: t('flowRunPage.tier.customNote') } : { disabled: true, reason: t('flowRunPage.tier.customReason') }) }
  ]
  return <RadioCards<FlowTier | 'custom'> legend={t('flowRunPage.tier.legend')} layout="grid" columns={4} value={tier} options={options} onChange={(v) => v !== 'custom' && onChange(v)} />
}

/** The model and effort Selects for one choice: models the step may run on (Claude; Codex too for a review or decide). */
function ChoiceSelects({ choice, kinds, name, onChange }: { choice: FlowStepChoice; kinds: FlowStepModel['kind'][]; name: string; onChange: (choice: FlowStepChoice) => void }) {
  const t = useT()
  const hidden = useStore((s) => s.snapshot!.settings.hiddenModels) ?? NO_HIDDEN
  // A turn step runs unattended; a review or decide step is read-only by construction, so any agent Foreman can hold read-only may take it.
  const hasTurn = kinds.some((k) => k === 'turn')
  const agents: AgentKind[] = AGENT_ORDER.filter((a) => canRunUnattended(a) || (!hasTurn && canReview(staticCapabilities(a))))
  if (!agents.includes(choice.agent as AgentKind)) agents.push(choice.agent as AgentKind)
  const current = { agent: choice.agent as AgentKind, model: choice.model }
  const options: SelectOption<string>[] = agents.flatMap((agent) => {
    const listed = pickerModels(modelsFor(agent), hidden, current).shown
    const all = listed.some((m) => m.agent === current.agent && m.id === current.model) || agent !== current.agent ? listed : [modelInfo(agent, current.model), ...listed]
    return all.map((m) => ({ value: `${agent}:${m.id}`, label: m.label, group: AGENTS[agent].label }))
  })
  const efforts = modelInfo(current.agent, current.model).efforts
  return (
    <span className="frp-choice">
      <Select<string>
        label={t('flowRunPage.modelFor', { name })}
        value={`${choice.agent}:${choice.model}`}
        options={options}
        onChange={(value) => {
          const at = value.indexOf(':')
          const agent = value.slice(0, at) as AgentKind
          const model = value.slice(at + 1)
          const info = modelInfo(agent, model)
          const effort = choice.effort && info.efforts.includes(choice.effort as EffortLevel) ? choice.effort : info.defaultEffort
          onChange({ agent, model, ...(effort ? { effort } : {}) })
        }}
      />
      {efforts.length > 0 && (
        <Select<string>
          label={t('flowRunPage.effortFor', { name })}
          value={choice.effort ?? modelInfo(current.agent, current.model).defaultEffort ?? efforts[0]}
          options={efforts.map((e) => ({ value: e, label: effortLabel(e, t) }))}
          onChange={(effort) => onChange({ ...choice, effort })}
        />
      )}
    </span>
  )
}

/** Who works on the flow: a person (persona) per row with the steps they take, one model and effort for all of them. */
function PeopleList({ steps, choices, onChange }: { steps: FlowStepModel[]; choices: FlowModelChoices; onChange: (choices: FlowModelChoices) => void }) {
  const t = useT()
  const people = flowPeople(steps)
  if (!people.length) return null
  return (
    <section className="frp-people" aria-label={t('flowRunPage.people')}>
      <h3 className="flow-run-heading">{t('flowRunPage.people')}</h3>
      <ul className="frp-rows">
        {people.map((p) => {
          const first = choiceFor(p.steps[0], choices)
          const mixed = p.steps.some((s) => choiceFor(s, choices).model !== first.model || (choiceFor(s, choices).effort ?? '') !== (first.effort ?? ''))
          const changed = p.steps.some((s) => choices[s.step])
          const name = p.persona ?? p.steps[0].step
          const takes = p.steps.flatMap((s) => [s.step, ...(s.follows ?? [])]).join(', ')
          return (
            <li key={p.key}>
              <Card className="frp-row">
                <span className="frp-who">
                  <strong>{name}</strong>
                  <span className="faint small">{[takes, p.steps.every((s) => s.readOnly) ? t('automations.personas.readOnly') : undefined].filter(Boolean).join(' · ')}</span>
                  {(changed || mixed) && (
                    <span className="frp-tags">
                      {changed && <Tag>{t('flowRunPage.changed')}</Tag>}
                      {mixed && <Tag>{t('flowRunPage.mixed')}</Tag>}
                    </span>
                  )}
                </span>
                <ChoiceSelects choice={first} kinds={p.steps.map((s) => s.kind)} name={name} onChange={(c) => onChange(chooseFor(choices, p.steps, c, steps))} />
              </Card>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Every agent step a run can choose for, in the flow's order, with the steps that continue its tab. */
function StepList({ steps, choices, onChange, selected, onSelect }: { steps: FlowStepModel[]; choices: FlowModelChoices; onChange: (choices: FlowModelChoices) => void; selected: string | null; onSelect: (step: string | null) => void }) {
  const t = useT()
  if (!steps.length) return <p className="faint small">{t('flowRunPage.noAgentSteps')}</p>
  return (
    <ul className="frp-rows" aria-label={t('flowRunPage.tab.steps')}>
      {steps.map((s) => {
        const choice = choiceFor(s, choices)
        return (
          <li key={s.step}>
            <Card className="frp-row" interactive selected={selected === s.step} onFocusCapture={() => onSelect(s.step)}>
              <span className="frp-who">
                <code>{s.step}</code>
                <span className="faint small">{[s.persona, s.follows?.length ? t('flowRunPage.alsoTab', { steps: s.follows.join(', ') }) : undefined, fromWords(s, t)].filter(Boolean).join(' · ')}</span>
                {choices[s.step] && (
                  <span className="frp-tags">
                    <Tag>{t('flowRunPage.changed')}</Tag>
                  </span>
                )}
              </span>
              <ChoiceSelects choice={choice} kinds={[s.kind]} name={s.step} onChange={(c) => onChange(chooseFor(choices, [s], c, steps))} />
            </Card>
          </li>
        )
      })}
    </ul>
  )
}

/** Where the flow's own model for a step comes from, in words. */
function fromWords(step: FlowStepModel, t: RendererT): string {
  const own = choiceWords(step.choice, t)
  if (step.from === 'slot' || step.from === 'default') return t('flowRunPage.from.slot', { model: own, slot: step.slot ?? 1 })
  if (step.from === 'persona') return t('flowRunPage.from.persona', { model: own })
  return t('flowRunPage.from.step', { model: own })
}

/** Remembered for next time; a personal flow can take the choices into its file. */
function ModelsNote({ flow, changed, onSave }: { flow: FlowListing | undefined; changed: boolean; onSave: () => void }) {
  const t = useT()
  if (!flow || !changed) return null
  if (flow.source === 'personal')
    return (
      <Callout tone="info" role="note" actions={<Button size="sm" onClick={onSave}>{t('flowRunPage.saveToFlow')}</Button>}>
        {t('flowRunPage.differs', { name: flowTitle(flow, t) })}
      </Callout>
    )
  return <p className="faint small">{flow.source === 'built-in' ? t('flowRunPage.rememberedBuiltIn') : t('flowRunPage.rememberedRepo')}</p>
}
