// @vitest-environment jsdom
// Flows on Automations: absent (and never asked for) while Settings → Experimental → Flows is off; on, each flow is a
// card with its source and shape, and the dialog checks a new personal flow as it is typed.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowListing } from '../src/shared/flows'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

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
})
