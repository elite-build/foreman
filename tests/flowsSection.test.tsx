// @vitest-environment jsdom
// Flows on Automations: absent (and never asked for) while Settings → Experimental → Flows is off; on, each flow is a
// card with its source and shape, and the dialog checks a new personal flow as it is typed.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import type { FlowListing } from '../src/shared/flows'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

// The diagram renders through a stand-in for Mermaid: it records the source and answers with an SVG naming it.
const mermaid = vi.hoisted(() => ({ sources: [] as string[] }))
vi.mock('../src/renderer/src/components/mermaidRender', () => ({
  readThemeTokens: () => ({ tokens: {}, dark: false }),
  cachedRender: () => undefined,
  renderMermaid: async (source: string) => {
    mermaid.sources.push(source)
    const title = /accTitle: (.*)/.exec(source)?.[1] ?? ''
    return { ok: true, svg: `<svg><title>${title}</title><g></g></svg>` }
  },
  svgElement: (svg: string) => {
    const template = document.createElement('template')
    template.innerHTML = svg
    return template.content.querySelector('svg')
  }
}))

const original = fakeState.snapshot

const LISTINGS: FlowListing[] = [
  { id: 'built-in:fix-until-green', source: 'built-in', starter: 'fix-until-green', name: 'Fix until green', toml: 'name = "Fix until green"', summary: { steps: 6, loops: 2, gates: 1, personas: [] }, problems: [], warnings: [] },
  { id: 'repo:r1:.foreman/flows/team.toml', source: 'repo', repoId: 'r1', file: '.foreman/flows/team.toml', rev: 'abcdef1234567890', name: 'Team flow', toml: 'name = "Team flow"', summary: { steps: 1, loops: 0, gates: 0, personas: [] }, problems: [], warnings: [] },
  { id: 'flow-1', source: 'personal', name: 'broken', toml: 'name = "x"', problems: ['The flow has no steps.', 'Another'], warnings: [] }
]

function setSnapshot(flows: boolean) {
  fakeState.snapshot = {
    ...original,
    repos: [{ id: 'r1', name: 'foreman' }],
    workspaces: [],
    repoTemplates: {},
    repoCommands: {},
    schedules: [],
    occurrences: [],
    settings: { ...original.settings, promptTemplates: [], savedCommands: [], flows }
  }
  fakeState.automations = { selected: null }
}

beforeEach(() => {
  resetFake()
  fakeApi.listFlows = vi.fn(async () => LISTINGS)
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  fakeState.automations = null
})

describe('Flows on Automations', () => {
  it('is absent while the switch is off, and the flows are never asked for', () => {
    setSnapshot(false)
    render(<AutomationsView />)
    expect(screen.queryByRole('region', { name: 'Flows' })).toBeNull()
    expect(screen.queryByText('New flow')).toBeNull()
    expect(fakeApi.listFlows).not.toHaveBeenCalled()
  })

  it('lists each flow with its source, its shape and its problems when the switch is on', async () => {
    setSnapshot(true)
    render(<AutomationsView />)
    const section = await screen.findByRole('region', { name: 'Flows' })
    await waitFor(() => expect(within(section).getByText('Fix until green')).toBeTruthy())
    expect(within(section).getByText('Built-in')).toBeTruthy()
    expect(within(section).getByText('6 steps · 2 loops · 1 gate')).toBeTruthy()
    expect(within(section).getByText('From foreman')).toBeTruthy()
    expect(within(section).getByText('.foreman/flows/team.toml @ abcdef1')).toBeTruthy()
    expect(within(section).getByText('1 step · 0 loops · 0 gates')).toBeTruthy()
    expect(within(section).getByText('Personal')).toBeTruthy()
    expect(within(section).getByText('2 problems')).toBeTruthy()
    // Above the templates.
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions.indexOf('Flows')).toBeLessThan(regions.indexOf('Templates'))
  })

  it('opens a new flow from a starter, checks it as it is typed, and saves it as personal', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeApi.savePersonalFlow = vi.fn(async () => ({ flow: LISTINGS[2] }))
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /New flow/ }))
    const dialog = screen.getByRole('dialog', { name: 'New flow' })
    const editor = within(dialog).getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement
    expect(editor.value).toContain('name = "Fix until green"')
    expect(within(dialog).getByText('No problems found.')).toBeTruthy()
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Start from' }), 'research-then-implement')
    expect(editor.value).toContain('name = "Research then implement"')

    await u.clear(editor)
    await u.type(editor, 'name = "x"')
    expect(within(dialog).getByText('This flow can’t be saved yet')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Start from' }), 'fix-until-green')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(fakeApi.savePersonalFlow).toHaveBeenCalledWith({ id: undefined, toml: expect.stringContaining('Fix until green') })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows a built-in flow read-only, with Copy to personal opening an editable copy', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /^Fix until green/ }))
    const dialog = screen.getByRole('dialog', { name: 'Fix until green' })
    expect((within(dialog).getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).readOnly).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
    await u.click(within(dialog).getByRole('button', { name: 'Copy to personal' }))
    const copy = screen.getByRole('dialog', { name: 'New flow' })
    expect((within(copy).getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).readOnly).toBe(false)
    expect((within(copy).getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).value).toBe('name = "Fix until green"')
  })

  it('Run… shows what starting the flow approves, asks for its inputs, and starts it with the fingerprint shown', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    const fingerprint = { flow: 'f', templates: 't', setup: 's', checks: 'c', mcp: 'm', personas: 'p' }
    fakeApi.listBranches = vi.fn(async () => [{ name: 'main', local: true, remote: true, isDefault: true }, { name: 'dev', local: true, remote: false, isDefault: false }])
    fakeApi.flowRunPreview = vi.fn(async () => ({
      fingerprint,
      inputs: [{ name: 'task', description: 'What to build' }],
      summary: {
        flowName: 'Team flow', flowSource: 'repo', flowFile: '.foreman/flows/team.toml', flowRev: 'abcdef1234567890', repoName: 'foreman', baseBranch: 'main',
        steps: 3, loops: 1, gates: 1, personas: [{ name: 'developer', source: 'repo', file: '.foreman/personas/developer.md', rev: '1234567abcdef' }, { name: 'qa-engineer', source: 'built-in', readOnly: true }], templates: [], setupScript: 'npm ci', checks: [{ name: 'Tests', command: 'npm test' }],
        mcpServers: [], integrations: [], notClaude: [], problems: []
      }
    }))
    fakeApi.startFlowRun = vi.fn(async () => ({ id: 'run' }))
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: 'Run Team flow…' }))
    const dialog = screen.getByRole('dialog', { name: 'Run Team flow' })
    await waitFor(() => expect(within(dialog).getByText('What starting it approves')).toBeTruthy())
    expect(fakeApi.flowRunPreview).toHaveBeenCalledWith({ flowId: 'repo:r1:.foreman/flows/team.toml', repoId: 'r1', baseBranch: 'main' })
    // A repository's flow runs in its repository, so there is no repository to pick.
    expect(within(dialog).queryByRole('combobox', { name: 'Repository' })).toBeNull()
    // Each persona with where it comes from and its revision: what the run approves.
    expect(within(dialog).getByText('developer (.foreman/personas/developer.md @ 1234567), qa-engineer (Built-in · read-only)')).toBeTruthy()
    expect(within(dialog).getByText('Tests')).toBeTruthy()
    expect(within(dialog).getByText(/Unattended turns are Claude only/)).toBeTruthy()
    const start = within(dialog).getByRole('button', { name: 'Start flow' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await u.type(within(dialog).getByRole('textbox', { name: 'task' }), 'add a button')
    await u.click(start)
    expect(fakeApi.startFlowRun).toHaveBeenCalledWith({ flowId: 'repo:r1:.foreman/flows/team.toml', source: 'repo', repoId: 'r1', baseBranch: 'main', inputs: { task: 'add a button' }, shown: fingerprint })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a flow that can’t run says why, and Start stays off; a cost bound says it counts Claude turns only; each flow lists its runs', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeState.snapshot = { ...fakeState.snapshot, workspaces: [{ id: 'ws-1', name: 'lisbon', state: 'ready' }], flowRuns: [
      { id: 'run', flow: { id: 'built-in:fix-until-green', name: 'Fix until green', source: 'built-in' }, repoId: 'r1', baseBranch: 'main', inputs: {}, fingerprint: {}, state: 'stopped', reason: 'Stopped by you.', startedAt: '2026-11-05T10:00:00.000Z', workspaceId: 'ws-1', steps: [], loops: {} }
    ] }
    fakeApi.listBranches = vi.fn(async () => [])
    fakeApi.flowRunPreview = vi.fn(async () => ({
      fingerprint: {},
      inputs: [],
      summary: { flowName: 'Fix until green', flowSource: 'built-in', repoName: 'foreman', baseBranch: 'main', steps: 6, loops: 2, gates: 1, personas: [], templates: [], setupScript: '', checks: [], mcpServers: [], integrations: [], notClaude: [{ step: 'review', agent: 'Cursor' }], problems: [], costBound: true }
    }))
    render(<AutomationsView />)
    const runs = await screen.findByRole('list', { name: 'Runs of Fix until green' })
    expect(within(runs).getByText('Stopped')).toBeTruthy()
    expect(within(runs).getByText('Stopped by you.')).toBeTruthy()
    expect(within(runs).getByRole('button', { name: 'lisbon' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Run Fix until green…' }))
    const dialog = screen.getByRole('dialog', { name: 'Run Fix until green' })
    await waitFor(() => expect(within(dialog).getByText('These turn steps aren’t on Claude, so the flow can’t run unattended: review (Cursor)')).toBeTruthy())
    expect(within(dialog).getByText('The cost bound applies to Claude turns only: other agents don’t say what a turn cost.')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Start flow' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a flow’s run graph in its dialog', () => {
  it('shows a built-in flow’s run graph, read-only, above its TOML; a file that isn’t a flow has none', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    mermaid.sources.length = 0
    fakeApi.listFlows = vi.fn(async () => [{ ...LISTINGS[0], toml: FLOW_STARTERS[0].toml }, LISTINGS[2]])
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /^Fix until green/ }))
    const dialog = screen.getByRole('dialog', { name: 'Fix until green' })
    expect(within(dialog).getByText('Run graph')).toBeTruthy()
    const picture = await within(dialog).findByRole('img', { name: 'Fix until green · Run' })
    // Above the document.
    const editor = within(dialog).getByRole('textbox', { name: 'Flow (TOML)' })
    expect(picture.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The wide Flows dialog keeps the run graph left to right.
    expect(mermaid.sources.at(-1)).toContain('flowchart LR')
    expect(mermaid.sources.at(-1)).toContain('subgraph')
    // Nothing in a run's state: a flow on its own has no run.
    expect(mermaid.sources.at(-1)).not.toContain('not yet')
    await u.click(within(dialog).getByRole('button', { name: 'Close' }))

    await u.click(screen.getByRole('button', { name: /^broken/ }))
    const broken = screen.getByRole('dialog', { name: 'Edit flow' })
    expect(within(broken).queryByText('Run graph')).toBeNull()
    expect(within(broken).queryByRole('img')).toBeNull()
  })
})
