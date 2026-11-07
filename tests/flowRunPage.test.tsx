// @vitest-environment jsdom
// Run a flow (FlowRunPage.tsx): the bar with the flow, base branch, estimate and Start over tabs beside the graph.
// Task asks for the flow's inputs; Models sets a tier and a model and effort per person; Steps sets one step; a run
// carries only what differs from the flow, with the fingerprint shown. A personal flow takes the choices into its file.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowListing, FlowRunPreview } from '../src/shared/flows'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot

const TOML = `name = "Team flow"

[inputs]
task = "What to build"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build {{task}}"
persona = "developer"

[steps.review]
kind = "review"
loadout = 2

[steps.fix]
kind = "turn"
same_tab = "build"
context = ["review.findings"]

[edges]
build = "review"
review = { clean = "done", findings = "fix" }
fix = "review"

[loops.until-clean]
over = ["review", "fix"]
at_most = { iterations = 2 }
`

const FLOW: FlowListing = { id: 'flow-1', source: 'personal', name: 'Team flow', toml: TOML, summary: { steps: 3, loops: 1, gates: 0, personas: ['developer'] }, problems: [], warnings: [] }
const FINGERPRINT = { flow: 'f', templates: 't', setup: 's', checks: 'c', mcp: 'm', personas: 'p' }
const OPUS = { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high' }
const SONNET = { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'high' }
const PREVIEW: FlowRunPreview = {
  fingerprint: FINGERPRINT,
  inputs: [{ name: 'task', description: 'What to build' }],
  summary: { flowName: 'Team flow', flowSource: 'personal', repoName: 'foreman', baseBranch: 'main', steps: 3, loops: 1, gates: 0, personas: [], templates: [], setupScript: '', checks: [], mcpServers: [], integrations: [], notClaude: [], problems: [] },
  models: [
    { step: 'build', kind: 'turn', persona: 'developer', follows: ['fix'], readOnly: false, choice: OPUS, from: 'persona', slot: 1 },
    { step: 'review', kind: 'review', readOnly: true, choice: SONNET, from: 'slot', slot: 2 }
  ]
}

function open(flowRuns: unknown[] = []) {
  fakeState.snapshot = {
    ...original,
    repos: [{ id: 'r1', name: 'foreman', defaultBranch: 'main' }],
    workspaces: [],
    repoTemplates: {},
    repoCommands: {},
    schedules: [],
    occurrences: [],
    flowRuns,
    settings: { ...original.settings, promptTemplates: [], savedCommands: [], flows: true }
  }
  fakeState.automations = { selected: 'r:flow-1', flowRun: { repoId: 'r1', baseBranch: 'main' } }
  return render(<AutomationsView />)
}

beforeEach(() => {
  resetFake()
  localStorage.clear()
  fakeApi.listFlows = vi.fn(async () => [FLOW])
  fakeApi.listBranches = vi.fn(async () => [{ name: 'main', local: true, remote: true, isDefault: true }])
  fakeApi.flowRunPreview = vi.fn(async () => PREVIEW)
  fakeApi.startFlowRun = vi.fn(async () => ({ id: 'run' }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  fakeState.automations = null
})

const startButton = () => screen.getByRole('button', { name: 'Start flow' }) as HTMLButtonElement

describe('Run a flow', () => {
  it('asks for the flow’s inputs and starts it as the flow says: no models, the fingerprint shown', async () => {
    const u = userEvent.setup()
    open()
    expect(screen.getByRole('navigation', { name: /where/i }).textContent).toContain('Run a flow')
    const task = await screen.findByRole('textbox', { name: 'task' })
    expect(fakeApi.flowRunPreview).toHaveBeenCalledWith({ flowId: 'flow-1', repoId: 'r1', baseBranch: 'main' })
    expect(startButton().disabled).toBe(true)
    expect(screen.getByText('Never run here: no estimate yet')).toBeTruthy()
    await u.type(task, 'a button')
    await u.click(startButton())
    expect(fakeApi.startFlowRun).toHaveBeenCalledWith({ flowId: 'flow-1', source: 'personal', repoId: 'r1', baseBranch: 'main', inputs: { task: 'a button' }, shown: FINGERPRINT })
    await waitFor(() => expect(storeModule.closeAutomations).toHaveBeenCalled())
  })

  it('a tier sets every step: Best puts work on Fable and checking on Opus, and the run carries those', async () => {
    const u = userEvent.setup()
    open()
    await u.type(await screen.findByRole('textbox', { name: 'task' }), 'a button')
    await u.click(screen.getByRole('tab', { name: /Models/ }))
    expect((screen.getByRole('radio', { name: /^Balanced/ }) as HTMLInputElement).checked).toBe(true)
    await u.click(screen.getByRole('radio', { name: /^Best/ }))
    expect((screen.getByRole('combobox', { name: 'Model for developer' }) as HTMLSelectElement).value).toBe('claude:claude-fable-5-1')
    expect((screen.getByRole('combobox', { name: 'Model for review' }) as HTMLSelectElement).value).toBe('claude:claude-opus-5-5[1m]')
    // The graph's cards say it too; the step continuing the build's tab follows it.
    expect(screen.getAllByText('Fable 5.1 · High').length).toBeGreaterThan(0)
    expect(screen.getAllByText('as build').length).toBeGreaterThan(0)
    await u.click(startButton())
    expect(fakeApi.startFlowRun).toHaveBeenCalledWith(expect.objectContaining({ models: { build: { agent: 'claude', model: 'claude-fable-5-1', effort: 'high' }, review: { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high' } } }))
  })

  it('one step changed by hand makes the mix Custom; a review may run on Codex, a turn may not', async () => {
    const u = userEvent.setup()
    open()
    await screen.findByRole('textbox', { name: 'task' })
    await u.click(screen.getByRole('tab', { name: /Steps/ }))
    const review = screen.getByRole('combobox', { name: 'Model for review' }) as HTMLSelectElement
    const build = screen.getByRole('combobox', { name: 'Model for build' }) as HTMLSelectElement
    expect(within(review).getByRole('option', { name: 'GPT-6.1 Sol' })).toBeTruthy()
    expect(within(build).queryByRole('option', { name: 'GPT-6.1 Sol' })).toBeNull()
    await u.selectOptions(review, 'codex:gpt-6.1-sol')
    await u.selectOptions(screen.getByRole('combobox', { name: 'Effort for review' }), 'medium')
    expect(screen.getByText('Changed')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Models/ }).textContent).toContain('Custom')
    // Remembered for this flow next time.
    expect(JSON.parse(localStorage.getItem('foreman.flowRun.models') ?? '{}')).toEqual({ 'flow-1': { review: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } } })
  })

  it('a personal flow takes the chosen models into its file', async () => {
    const u = userEvent.setup()
    fakeApi.savePersonalFlow = vi.fn(async (input: { id?: string; toml: string }) => ({ flow: { ...FLOW, toml: input.toml } }))
    open()
    await screen.findByRole('textbox', { name: 'task' })
    await u.click(screen.getByRole('tab', { name: /Models/ }))
    await u.selectOptions(screen.getByRole('combobox', { name: 'Effort for developer' }), 'max')
    await u.click(screen.getByRole('button', { name: 'Save to the flow' }))
    const saved = (fakeApi.savePersonalFlow as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string; toml: string }
    expect(saved.id).toBe('flow-1')
    expect(saved.toml).toContain('[steps.build]\nagent = "claude"\nmodel = "claude-opus-5-5[1m]"\neffort = "max"\nkind = "turn"')
    expect(saved.toml).toContain('[steps.review]\nkind = "review"\nloadout = 2')
  })

  it('a turn the flow puts on another agent keeps Start off, saying so, until a Claude model is chosen for it', async () => {
    const u = userEvent.setup()
    const cursor = { agent: 'cursor', model: 'auto' }
    fakeApi.flowRunPreview = vi.fn(async () => ({
      ...PREVIEW,
      summary: { ...PREVIEW.summary, notClaude: [{ step: 'build', agent: 'Cursor' }] },
      models: [{ ...PREVIEW.models![0], choice: cursor, from: 'step' as const }, PREVIEW.models![1]]
    }))
    open()
    await u.type(await screen.findByRole('textbox', { name: 'task' }), 'a button')
    expect(await screen.findByText(/Agent turns run on Claude only.*: build\./)).toBeTruthy()
    expect(startButton().disabled).toBe(true)
    await u.click(screen.getByRole('tab', { name: /Steps/ }))
    await u.selectOptions(screen.getByRole('combobox', { name: 'Model for build' }), 'claude:claude-sonnet-5-5[1m]')
    expect(screen.queryByText(/Agent turns run on Claude only/)).toBeNull()
    expect(startButton().disabled).toBe(false)
  })

  it('says what the flow’s finished runs cost and took, on average', async () => {
    open([
      { id: 'a', flow: { id: 'flow-1', name: 'Team flow', source: 'personal' }, repoId: 'r1', baseBranch: 'main', inputs: {}, fingerprint: FINGERPRINT, state: 'completed', startedAt: '2026-11-07T10:00:00Z', endedAt: '2026-11-07T10:40:00Z', steps: [{ name: 'build', kind: 'turn', iteration: 1, loops: {}, state: 'completed', startedAt: '', costUsd: 2.4 }], loops: {} }
    ])
    expect(await screen.findByText('Last run: $2.40 · 40 min')).toBeTruthy()
  })
})
