// @vitest-environment jsdom
// The flow studio (components/automations/FlowStudio.tsx): a flow as its own page. A built-in flow is read-only and
// copies to a personal draft; a draft is checked as it is typed and saved as a personal flow; a step selected on the
// graph opens in the inspector and its TOML block; the Assistant sends the draft with every message and its proposal is
// drawn on the graph with what it changes, applied only when the user says.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flowProposalItem } from '../src/shared/assistant'
import { diffFlows } from '../src/shared/flowDiff'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { parseFlow, type Flow, type FlowListing } from '../src/shared/flows'
import { FlowStudio } from '../src/renderer/src/components/automations/FlowStudio'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const FIX = FLOW_STARTERS.find((s) => s.id === 'fix-until-green')!.toml
const BUILT_IN: FlowListing = { id: 'built-in:fix-until-green', source: 'built-in', starter: 'fix-until-green', name: 'Fix until green', toml: FIX, summary: { steps: 6, loops: 2, gates: 1, personas: [] }, problems: [], warnings: [] }
const read = (toml: string): Flow => {
  const parsed = parseFlow(toml, 'personal')
  if (!('flow' in parsed)) throw new Error(parsed.problems.join('\n'))
  return parsed.flow
}
const original = fakeState.snapshot
const node = (title: string) => [...document.querySelectorAll<HTMLElement>('.ui-graph__node')].find((n) => n.querySelector('.ui-graph__title')?.textContent === title)

beforeEach(() => {
  resetFake()
  fakeState.snapshot = { ...original, repos: [{ id: 'r1', name: 'foreman' }], settings: { ...original.settings, flows: true, loadouts: [] } }
  fakeState.automations = { selected: null }
  fakeState.assistant = { gate: { state: 'ready', agent: 'claude', model: 'claude-opus-5-5' }, threads: [] }
  fakeState.assistantItems = {}
  fakeApi.listFlows = vi.fn(async () => [BUILT_IN])
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  fakeState.automations = null
})

describe('the flow studio', () => {
  it('shows a built-in flow read-only, drawn as a graph, and copies it to a personal draft', async () => {
    const u = userEvent.setup()
    render(<FlowStudio id="built-in:fix-until-green" />)
    expect(await screen.findByRole('heading', { name: 'Fix until green' })).toBeTruthy()
    expect(screen.getByText('Built-in flows and flows from a repository are read-only here. Copy one to personal to change it.')).toBeTruthy()
    // Selectable: a group of buttons, the outline's equivalent being the inspector and the TOML.
    expect(screen.getByRole('group', { name: 'Fix until green · Run' })).toBeTruthy()
    expect(node('implement')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await u.click(screen.getByRole('tab', { name: 'Flow (TOML)' }))
    expect((screen.getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).readOnly).toBe(true)
    await u.click(screen.getByRole('button', { name: 'Copy to personal' }))
    expect(storeModule.openFlowDraft).toHaveBeenCalledWith({ toml: FIX, notes: ['A copy of Fix until green: nothing is saved until you press Save.'] })
  })

  it('checks a draft as it is typed, keeps the last good graph while it doesn’t read, and saves it as a personal flow', async () => {
    const u = userEvent.setup()
    fakeApi.savePersonalFlow = vi.fn(async () => ({ flow: { ...BUILT_IN, id: 'flow-9', source: 'personal' as const, starter: undefined } }))
    render(<FlowStudio id="new" draft={{ toml: FIX }} />)
    expect(screen.getByText('Draft · not saved')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run…' }).hasAttribute('disabled')).toBe(true)
    await u.click(screen.getByRole('tab', { name: 'Flow (TOML)' }))
    const editor = screen.getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement
    await u.clear(editor)
    await u.type(editor, 'name = "x"')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Problems \([1-9]/ })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(screen.getByText('The document doesn’t read as a flow right now; the graph shows the last version that did.')).toBeTruthy())
    expect(node('implement')).toBeTruthy()

    await u.clear(editor)
    await u.paste(FIX.replace('name = "Fix until green"', 'name = "Mine"'))
    expect(await screen.findByRole('heading', { name: 'Mine' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Save' }))
    expect(fakeApi.savePersonalFlow).toHaveBeenCalledWith({ toml: FIX.replace('name = "Fix until green"', 'name = "Mine"') })
    await waitFor(() => expect(storeModule.selectAutomation).toHaveBeenCalledWith('f:flow-9'))
  })

  it('opens a step selected on the graph in the inspector, with its exits and a way to its TOML', async () => {
    const u = userEvent.setup()
    render(<FlowStudio id="new" draft={{ toml: FIX }} />)
    const checks = screen.getByRole('button', { name: /^checks/ })
    await u.click(checks)
    const inspector = screen.getByRole('complementary', { name: 'Selected on the graph' })
    expect(within(inspector).getByText('Step checks')).toBeTruthy()
    expect(within(inspector).getByText('passed')).toBeTruthy()
    expect(within(inspector).getByRole('button', { name: 'review' })).toBeTruthy()
    await u.click(within(inspector).getByRole('button', { name: 'Show in TOML' }))
    expect(screen.getByRole('tab', { name: 'Flow (TOML)' }).getAttribute('aria-selected')).toBe('true')
    await u.click(within(inspector).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary', { name: 'Selected on the graph' })).toBeNull()
  })

  it('sends the draft with every message, draws a proposal on the graph, and applies it only when asked', async () => {
    const u = userEvent.setup()
    const longer = FIX.replace('at_most = { iterations = 2 }', 'at_most = { iterations = 3 }').replace('[steps.address]', '[steps.security]\nkind = "review"\npersona = "qa-engineer"\n\n[steps.address]').replace('review = { clean = "ship-check", findings = "address" }', 'review = { clean = "security", findings = "address" }\nsecurity = { clean = "ship-check", findings = "address" }')
    fakeApi.assistantSend = vi.fn(async () => ({ threadId: 'th-1' }))
    const view = render(<FlowStudio id="new" draft={{ toml: FIX }} />)
    await u.type(screen.getByRole('textbox', { name: 'Ask about the flow, or say what to change…' }), 'Add a security review{Enter}')
    expect(fakeApi.assistantSend).toHaveBeenCalledWith(null, 'Add a security review', false, { flow: { toml: FIX, source: 'personal' } })

    const proposal = { proposalId: 'p1', toml: longer, base: FIX, summary: 'A security pass after review', changes: diffFlows(read(FIX), read(longer)) }
    fakeState.assistantItems = { 'th-1': [{ kind: 'user', id: 'u1', turnId: 't1', text: 'Add a security review', at: '2026-11-07T10:00:00.000Z' }, flowProposalItem('t1', proposal)] }
    view.rerender(<FlowStudio id="new" draft={{ toml: FIX }} />)
    expect(await screen.findByText('A security pass after review')).toBeTruthy()
    // On the graph, with its words.
    await waitFor(() => expect(node('security')?.dataset.mark).toBe('added'))
    expect(screen.getByText('The graph shows the assistant’s proposal: what it adds, changes and removes.')).toBeTruthy()
    // Nothing applied yet: the document is as it was.
    await u.click(screen.getByRole('tab', { name: 'Flow (TOML)' }))
    expect((screen.getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).value).toBe(FIX)
    await u.click(screen.getByRole('tab', { name: /Assistant/ }))

    await u.click(screen.getAllByRole('button', { name: 'Apply' })[0])
    expect(storeModule.showToast).toHaveBeenCalledWith('Applied to the draft. Save to keep it.')
    // Drawn at once as the draft, its marks gone.
    expect(node('security')).toBeTruthy()
    expect(node('security')!.dataset.mark).toBeUndefined()
    expect(screen.getByText('Applied')).toBeTruthy()
    await u.click(screen.getByRole('tab', { name: 'Flow (TOML)' }))
    expect((screen.getByRole('textbox', { name: 'Flow (TOML)' }) as HTMLTextAreaElement).value).toBe(longer)
  })
})

describe('the flow studio’s Steps tab', () => {
  it('lists the graph’s steps with their exits, and choosing one selects it as on the graph', async () => {
    const u = userEvent.setup()
    render(<FlowStudio id="new" draft={{ toml: FIX }} />)
    await u.click(screen.getByRole('tab', { name: 'Steps' }))
    const outline = screen.getByRole('list', { name: 'Steps' })
    const checks = within(outline).getByRole('button', { name: /^checks/ })
    expect(checks.textContent).toContain('Exits: passed → review, failed → fix')
    await u.click(checks)
    expect(checks.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Selected on the graph' })).toBeTruthy()
  })
})
