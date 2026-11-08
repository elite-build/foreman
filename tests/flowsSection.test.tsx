// @vitest-environment jsdom
// Flows on Automations: absent (and never asked for) while Settings → Experimental → Flows is off; on, each flow is a
// card with its source and shape that opens the flow studio (tests/flowStudio.test.tsx) and a menu that renames it (or a
// copy), and New flow asks for a name and a start (blank, described, or a copy) before it opens a draft.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLANK_FLOW } from '../src/shared/flowStarters'
import type { FlowListing } from '../src/shared/flows'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

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
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Templates', 'Commands'])
  })

  it('has its own tab, beside Personas, showing only the flows and saying when a search matches none', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Templates', 'Commands', 'Flows', 'Personas'])
    expect(screen.getByRole('searchbox', { name: 'Search automations' })).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Flows' }))
    const section = await screen.findByRole('region', { name: 'Flows' })
    await waitFor(() => expect(within(section).getByText('Fix until green')).toBeTruthy())
    expect(screen.queryByRole('region', { name: 'Personas' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Templates' })).toBeNull()
    await u.type(screen.getByRole('searchbox'), 'zzz')
    expect(within(screen.getByRole('region', { name: 'Flows' })).getByText('Nothing matches “zzz”.')).toBeTruthy()
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

  it('opens a flow as its own page from its card, and New flow as a blank draft under the name it asks for', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /^Fix until green/ }))
    expect(storeModule.selectAutomation).toHaveBeenCalledWith('f:built-in:fix-until-green')

    await u.click(screen.getByRole('button', { name: /New flow/ }))
    const dialog = screen.getByRole('dialog', { name: 'New flow' })
    const create = within(dialog).getByRole('button', { name: 'Create' })
    expect(create.hasAttribute('disabled')).toBe(true)
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    // A name already used is said, not refused.
    await u.type(name, 'team flow')
    expect(within(dialog).getByText('A flow is already called this. Both will be listed, told apart by their tags.')).toBeTruthy()
    expect(create.hasAttribute('disabled')).toBe(false)
    await u.clear(name)
    await u.type(name, 'Plan, build, check')
    expect(within(dialog).queryByText(/already called this/)).toBeNull()
    expect((within(dialog).getByRole('radio', { name: /Blank/ }) as HTMLInputElement).checked).toBe(true)
    await u.click(create)
    expect(storeModule.openFlowDraft).toHaveBeenCalledWith({ toml: BLANK_FLOW.replace('name = "Untitled flow"', 'name = "Plan, build, check"') })
    expect(screen.queryByRole('dialog', { name: 'New flow' })).toBeNull()
  })

  it('New flow starts from a description for the assistant, or from a copy of a flow that reads, under the new name', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /New flow/ }))
    let dialog = screen.getByRole('dialog', { name: 'New flow' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Described')
    await u.click(within(dialog).getByRole('radio', { name: /Describe it/ }))
    await u.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(storeModule.openFlowDraft).toHaveBeenLastCalledWith({ toml: BLANK_FLOW.replace('name = "Untitled flow"', 'name = "Described"'), describe: true })

    await u.click(screen.getByRole('button', { name: /New flow/ }))
    dialog = screen.getByRole('dialog', { name: 'New flow' })
    await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Mine')
    await u.click(within(dialog).getByRole('radio', { name: /Copy a flow/ }))
    // The first flow that reads; the broken personal one isn't offered.
    expect(within(dialog).getByRole('combobox', { name: 'Flow to copy' }).textContent).toContain('Fix until green · Built-in')
    // Enter in the name creates it, as Create does.
    await u.type(within(dialog).getByRole('textbox', { name: 'Name' }), '{Enter}')
    expect(storeModule.openFlowDraft).toHaveBeenLastCalledWith({ toml: 'name = "Mine"', notes: ['A copy of Fix until green: nothing is saved until you press Save.'] })
  })

  it('a card’s menu renames a personal flow on its page, and a built-in or repository one as a copy', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeApi.listFlows = vi.fn(async () => [...LISTINGS, { id: 'flow-2', source: 'personal' as const, name: 'Mine', toml: 'name = "Mine"', summary: { steps: 1, loops: 0, gates: 0, personas: [] }, problems: [], warnings: [] }])
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: 'More for Mine' }))
    await u.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(storeModule.openFlowRename).toHaveBeenCalledWith('flow-2')
    await u.click(screen.getByRole('button', { name: 'More for Mine' }))
    await u.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(storeModule.openFlowDraft).toHaveBeenLastCalledWith({ toml: 'name = "Mine"', notes: ['A copy of Mine: nothing is saved until you press Save.'], rename: true })
    await u.click(screen.getByRole('button', { name: 'More for Fix until green' }))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    await u.click(screen.getByRole('menuitem', { name: 'Rename a copy…' }))
    expect(storeModule.openFlowDraft).toHaveBeenLastCalledWith({ toml: 'name = "Fix until green"', notes: ['A copy of Fix until green: nothing is saved until you press Save.'], rename: true })
  })

  it('Run… opens the Run a flow page on the flow, in its repository', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: 'Run Team flow…' }))
    expect(storeModule.openFlowRun).toHaveBeenCalledWith('repo:r1:.foreman/flows/team.toml', { repoId: 'r1' })
    await u.click(screen.getByRole('button', { name: 'Run Fix until green…' }))
    expect(storeModule.openFlowRun).toHaveBeenLastCalledWith('built-in:fix-until-green', { repoId: undefined })
  })

  it('each flow lists its runs: how it ended, why, and its workspace', async () => {
    setSnapshot(true)
    fakeState.snapshot = { ...fakeState.snapshot, workspaces: [{ id: 'ws-1', name: 'lisbon', state: 'ready' }], flowRuns: [
      { id: 'run', flow: { id: 'built-in:fix-until-green', name: 'Fix until green', source: 'built-in' }, repoId: 'r1', baseBranch: 'main', inputs: {}, fingerprint: {}, state: 'stopped', reason: 'Stopped by you.', startedAt: '2026-11-05T10:00:00.000Z', workspaceId: 'ws-1', steps: [], loops: {} }
    ] }
    render(<AutomationsView />)
    const runs = await screen.findByRole('list', { name: 'Runs of Fix until green' })
    expect(within(runs).getByText('Stopped')).toBeTruthy()
    expect(within(runs).getByText('Stopped by you.')).toBeTruthy()
    expect(within(runs).getByRole('button', { name: 'lisbon' })).toBeTruthy()
  })
})

describe('every flow’s runs', () => {
  it('switches the section to a table of runs, newest first, with their state, workspace, cost and where they stopped', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeState.snapshot = {
      ...fakeState.snapshot,
      workspaces: [{ id: 'ws-1', name: 'lisbon', state: 'ready' }],
      flowRuns: [
        { id: 'old', flow: { id: 'built-in:fix-until-green', name: 'Fix until green', source: 'built-in', starter: 'fix-until-green' }, repoId: 'r1', baseBranch: 'main', inputs: {}, fingerprint: {}, state: 'stopped', reason: 'Stopped by you.', startedAt: '2026-11-05T10:00:00.000Z', endedAt: '2026-11-05T10:12:00.000Z', workspaceId: 'ws-1', steps: [{ name: 'implement', kind: 'turn', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:00:00.000Z', costUsd: 0.5 }, { name: 'fix', kind: 'turn', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:05:00.000Z', costUsd: 0.25 }], loops: {} },
        { id: 'new', flow: { id: 'repo:r1:.foreman/flows/team.toml', name: 'Team flow', source: 'repo' }, repoId: 'r1', baseBranch: 'main', inputs: {}, fingerprint: {}, state: 'running', startedAt: '2026-11-06T10:00:00.000Z', current: { step: 'checks', iteration: 2 }, steps: [], loops: {} }
      ]
    }
    render(<AutomationsView />)
    await screen.findByRole('button', { name: 'Run Fix until green…' })
    await u.click(screen.getByRole('radio', { name: 'Runs' }))
    const table = screen.getByRole('table', { name: 'Every flow’s runs, newest first' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Team flow')).toBeTruthy()
    expect(within(rows[0]).getByText('Running')).toBeTruthy()
    expect(within(rows[1]).getByText('Fix until green')).toBeTruthy()
    expect(within(rows[1]).getByText('Stopped by you.')).toBeTruthy()
    expect(within(rows[1]).getByText('$0.75')).toBeTruthy()
    expect(within(rows[1]).getByText('took 12m 00s')).toBeTruthy()
    expect(within(rows[1]).getByRole('button', { name: 'lisbon' })).toBeTruthy()
  })
})
