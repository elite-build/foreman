// The models a flow run uses (shared/flowModels.ts): tiers fill every step, a person's choice fills their steps, a run
// carries only what differs from the flow, its finished runs give the estimate, and choices can be written into the file.
import { describe, expect, it } from 'vitest'
import { choicesTier, chooseFor, FLOW_TIER_MODELS, flowPeople, pastRunCost, tierChoices, withoutDefaults, writeStepModels } from '../src/shared/flowModels'
import { parseFlow, type FlowRun, type FlowStepModel } from '../src/shared/flows'

const SONNET = { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'high' }
const OPUS = { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high' }
const STEPS: FlowStepModel[] = [
  { step: 'plan', kind: 'turn', persona: 'architect', readOnly: true, choice: SONNET, from: 'persona', slot: 2 },
  { step: 'build', kind: 'turn', persona: 'developer', follows: ['fix'], readOnly: false, choice: OPUS, from: 'persona', slot: 1 },
  { step: 'polish', kind: 'turn', persona: 'developer', readOnly: false, choice: OPUS, from: 'persona', slot: 1 },
  { step: 'qa', kind: 'review', readOnly: true, choice: SONNET, from: 'slot', slot: 2 }
]

describe('tiers', () => {
  it('Balanced is the flow as written; Faster and Best put work and checking steps on their models', () => {
    expect(tierChoices('balanced', STEPS)).toEqual({})
    const best = tierChoices('best', STEPS)
    expect(best).toEqual({ plan: FLOW_TIER_MODELS.best.check, build: FLOW_TIER_MODELS.best.work, polish: FLOW_TIER_MODELS.best.work, qa: FLOW_TIER_MODELS.best.check })
    expect(choicesTier(best, STEPS)).toBe('best')
    expect(choicesTier({}, STEPS)).toBe('balanced')
  })

  it('one step changed by hand makes the choices custom; changing it back makes them the tier again', () => {
    const best = tierChoices('best', STEPS)
    const changed = chooseFor(best, [STEPS[3]], { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, STEPS)
    expect(choicesTier(changed, STEPS)).toBe('custom')
    expect(choicesTier(chooseFor(changed, [STEPS[3]], FLOW_TIER_MODELS.best.check, STEPS), STEPS)).toBe('best')
  })

  it('a run carries only the steps that differ from the flow', () => {
    expect(withoutDefaults({ plan: SONNET, build: SONNET }, STEPS)).toEqual({ build: SONNET })
    expect(chooseFor({}, [STEPS[0]], SONNET, STEPS)).toEqual({})
  })
})

describe('people', () => {
  it('groups the agent steps by persona, in order; a step with none is its own', () => {
    expect(flowPeople(STEPS).map((g) => [g.key, g.steps.map((s) => s.step)])).toEqual([
      ['persona:architect', ['plan']],
      ['persona:developer', ['build', 'polish']],
      ['step:qa', ['qa']]
    ])
  })

  it('a person’s choice goes to all their steps and keeps the others’', () => {
    const developer = flowPeople(STEPS)[1].steps
    const fable = { agent: 'claude', model: 'claude-fable-5-1', effort: 'max' }
    expect(chooseFor({ qa: OPUS }, developer, fable, STEPS)).toEqual({ build: fable, polish: fable, qa: OPUS })
  })
})

describe('past runs', () => {
  const run = (over: Partial<FlowRun>): FlowRun => ({
    id: 'r',
    flow: { id: 'f', name: 'F', source: 'personal' },
    repoId: 'repo',
    baseBranch: 'main',
    inputs: {},
    fingerprint: { flow: '', templates: '', setup: '', checks: '', mcp: '', personas: '' },
    state: 'completed',
    startedAt: '2026-11-07T10:00:00Z',
    endedAt: '2026-11-07T10:30:00Z',
    steps: [],
    loops: {},
    ...over
  })

  it('averages the cost and time of this flow’s completed runs; others, and runs still going or stopped, don’t count', () => {
    const runs = [
      run({ steps: [{ name: 'a', kind: 'turn', iteration: 1, loops: {}, state: 'completed', startedAt: '', costUsd: 1 }, { name: 'b', kind: 'turn', iteration: 1, loops: {}, state: 'completed', startedAt: '', costUsd: 2 }] }),
      run({ endedAt: '2026-11-07T11:00:00Z', steps: [{ name: 'a', kind: 'turn', iteration: 1, loops: {}, state: 'completed', startedAt: '', costUsd: 1 }] }),
      run({ state: 'stopped' }),
      run({ state: 'running', endedAt: undefined }),
      run({ flow: { id: 'other', name: 'O', source: 'personal' } })
    ] as FlowRun[]
    expect(pastRunCost(runs, 'f')).toEqual({ runs: 2, costUsd: 2, minutes: 45 })
    expect(pastRunCost(runs, 'never')).toEqual({ runs: 0 })
  })
})

describe('writing choices into the flow', () => {
  const TOML = `name = "F"

[start]
step = "plan"

[steps.plan]
kind = "turn"
loadout = 2 # thinks
prompt = "Plan it."

[steps.qa]
kind = "review"
model = "old"
`

  it('replaces the chosen steps’ loadout, agent, model and effort, keeping the rest and the others', () => {
    const next = writeStepModels(TOML, { plan: { agent: 'claude', model: 'claude-fable-5-1', effort: 'max' } })
    expect(next).toContain('[steps.plan]\nagent = "claude"\nmodel = "claude-fable-5-1"\neffort = "max"\nkind = "turn"\nprompt = "Plan it."')
    expect(next).not.toContain('loadout = 2')
    expect(next).toContain('[steps.qa]\nkind = "review"\nmodel = "old"')
    const parsed = parseFlow(next, 'personal')
    expect('flow' in parsed && parsed.flow.steps[0]).toMatchObject({ agent: 'claude', model: 'claude-fable-5-1', effort: 'max' })
  })

  it('a flow reads a step’s effort and refuses one that isn’t a level', () => {
    const bad = parseFlow(TOML.replace('kind = "review"', 'kind = "review"\neffort = "loud"'), 'personal')
    expect('flow' in bad).toBe(false)
    expect('problems' in bad ? bad.problems.join(' ') : '').toContain('“loud” isn’t an effort level')
  })
})
