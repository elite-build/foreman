// The models a flow run uses (docs/loops-and-graphs.md): what each agent step runs on, chosen for one run on the
// Run a flow page. A tier (Faster, Balanced, Best) fills every step at once, a persona's choice fills its steps, and
// any one step can be changed; a run carries only the steps that differ from the flow (FlowRunStart.models). Pure, so
// the page, main's checks and tests share it.
import { FLOW_EFFORTS, isActiveRun, type Flow, type FlowModelChoices, type FlowRun, type FlowStepChoice, type FlowStepModel } from './flows'

export const FLOW_TIERS = ['faster', 'balanced', 'best'] as const
export type FlowTier = (typeof FLOW_TIERS)[number]

/**
 * What Faster and Best put each step on; Balanced is the flow as written. `work` is a step that changes files, `check`
 * one held read-only (a review, a decide, a read-only turn). Claude, so every step can take it. Keep in step with the
 * MODELS list in agents.ts when models change.
 */
export const FLOW_TIER_MODELS: Record<Exclude<FlowTier, 'balanced'>, { work: FlowStepChoice; check: FlowStepChoice }> = {
  faster: { work: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'medium' }, check: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'medium' } },
  best: { work: { agent: 'claude', model: 'claude-fable-5-1', effort: 'high' }, check: { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high' } }
}

export const sameChoice = (a: FlowStepChoice | undefined, b: FlowStepChoice | undefined): boolean =>
  Boolean(a && b) && a!.agent === b!.agent && a!.model === b!.model && (a!.effort ?? '') === (b!.effort ?? '')

/** What a step runs on in this run: the run's choice for it, else the flow's. */
export function choiceFor(step: FlowStepModel, choices: FlowModelChoices): FlowStepChoice {
  return choices[step.step] ?? step.choice
}

/** A tier's choices for these steps; Balanced chooses nothing (the flow as written). */
export function tierChoices(tier: FlowTier, steps: FlowStepModel[]): FlowModelChoices {
  if (tier === 'balanced') return {}
  const models = FLOW_TIER_MODELS[tier]
  return withoutDefaults(Object.fromEntries(steps.map((s) => [s.step, { ...(s.readOnly ? models.check : models.work) }])), steps)
}

/** Only the choices that differ from the flow's own, for steps the run can choose: what a run carries. */
export function withoutDefaults(choices: FlowModelChoices, steps: FlowStepModel[]): FlowModelChoices {
  const out: FlowModelChoices = {}
  for (const step of steps) {
    const chosen = choices[step.step]
    if (chosen && !sameChoice(chosen, step.choice)) out[step.step] = chosen
  }
  return out
}

/** The tier these choices are, or 'custom' when they are none of them. */
export function choicesTier(choices: FlowModelChoices, steps: FlowStepModel[]): FlowTier | 'custom' {
  const mine = withoutDefaults(choices, steps)
  for (const tier of FLOW_TIERS) {
    const theirs = tierChoices(tier, steps)
    if (steps.every((s) => sameChoice(choiceFor(s, mine), choiceFor(s, theirs)))) return tier
  }
  return 'custom'
}

/** The people who work on a flow: its agent steps grouped by persona, in order; a step with none is its own group. */
export function flowPeople(steps: FlowStepModel[]): { key: string; persona?: string; steps: FlowStepModel[] }[] {
  const groups: { key: string; persona?: string; steps: FlowStepModel[] }[] = []
  for (const step of steps) {
    const key = step.persona ? `persona:${step.persona}` : `step:${step.step}`
    const group = groups.find((g) => g.key === key)
    if (group) group.steps.push(step)
    else groups.push({ key, ...(step.persona ? { persona: step.persona } : {}), steps: [step] })
  }
  return groups
}

/** `choice` for every step in `group` (a person's steps, or one step), the others' choices kept; `all` is every step. */
export function chooseFor(choices: FlowModelChoices, group: FlowStepModel[], choice: FlowStepChoice, all: FlowStepModel[]): FlowModelChoices {
  const next = { ...choices }
  for (const step of group) next[step.step] = { ...choice }
  return withoutDefaults(next, all)
}

/**
 * Why a run's choices can't be taken, in words: not an object, a step that isn't an agent step of this flow or that
 * continues another's tab, an agent or model missing, an effort that isn't one. The agent rules (turns on Claude, reviews
 * and decides also on Codex) are the flow's own, checked as if the step named them.
 */
export function flowModelProblems(flow: Flow, models: unknown): string[] {
  if (models === undefined) return []
  if (!models || typeof models !== 'object' || Array.isArray(models)) return ['The chosen models aren’t a list of steps.']
  const problems: string[] = []
  for (const [name, choice] of Object.entries(models as Record<string, unknown>)) {
    const step = flow.steps.find((s) => s.name === name)
    if (!step || (step.kind !== 'turn' && step.kind !== 'review' && step.kind !== 'decide')) {
      problems.push(`A model was chosen for “${name}”, which isn’t an agent step of this flow.`)
      continue
    }
    if (step.kind === 'turn' && step.same_tab && step.loadout === undefined && !step.agent && !step.model) {
      problems.push(`The step “${name}” continues “${step.same_tab}”’s tab, so it runs on that step’s model: choose it there.`)
      continue
    }
    const c = choice as Partial<FlowStepChoice> | null
    if (!c || typeof c !== 'object' || typeof c.agent !== 'string' || !c.agent.trim() || typeof c.model !== 'string' || !c.model.trim()) {
      problems.push(`The model chosen for “${name}” needs an agent and a model.`)
      continue
    }
    if (c.effort !== undefined && !(FLOW_EFFORTS as readonly string[]).includes(c.effort)) problems.push(`“${c.effort}” (step “${name}”) isn’t an effort level: ${FLOW_EFFORTS.join(', ')}.`)
  }
  return problems
}

/** What this flow's finished runs cost and took, on average: for the Run a flow page's estimate. */
export function pastRunCost(runs: readonly FlowRun[], flowId: string): { runs: number; costUsd?: number; minutes?: number } {
  const done = runs.filter((r) => r.flow.id === flowId && !isActiveRun(r) && r.endedAt && r.state === 'completed')
  if (!done.length) return { runs: 0 }
  const costs = done.map((r) => r.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0))
  const minutes = done.map((r) => (Date.parse(r.endedAt!) - Date.parse(r.startedAt)) / 60_000).filter((m) => Number.isFinite(m) && m >= 0)
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    runs: done.length,
    ...(costs.some((c) => c > 0) ? { costUsd: mean(costs) } : {}),
    ...(minutes.length ? { minutes: mean(minutes) } : {})
  }
}

const ASSIGN = /^\s*(loadout|agent|model|effort)\s*=/

/**
 * The flow document with each chosen step's model written into its table: `agent`, `model` and `effort` replace any
 * `loadout`, `agent`, `model` and `effort` lines there; everything else, comments included, is kept.
 */
export function writeStepModels(toml: string, choices: FlowModelChoices): string {
  const lines = toml.split(/\r?\n/)
  const eol = toml.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  let current: string | undefined
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (header) {
      const name = /^steps\.("?)([A-Za-z0-9][\w-]*)\1$/.exec(header[1].trim())?.[2]
      current = name && choices[name] ? name : undefined
      out.push(line)
      if (current) {
        const c = choices[current]
        out.push(`agent = ${JSON.stringify(c.agent)}`, `model = ${JSON.stringify(c.model)}`, ...(c.effort ? [`effort = ${JSON.stringify(c.effort)}`] : []))
      }
      continue
    }
    if (current && ASSIGN.test(line)) continue
    out.push(line)
  }
  return out.join(eol)
}
