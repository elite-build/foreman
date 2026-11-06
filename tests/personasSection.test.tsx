// @vitest-environment jsdom
// Personas on Automations, beside Flows: absent (and never asked for) while Settings → Experimental → Flows is off; on,
// each persona is a row with its source and what it is, opening an editor that shows it as settings with the
// instructions beneath. Built-in and repository personas are read-only with Copy to personal; a personal one saves as
// markdown, checked as it is edited, and says how many flows' approvals a change touches.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationsView } from '../src/renderer/src/components/automations/AutomationsView'
import type { FlowListing } from '../src/shared/flows'
import { parsePersona, type PersonaList, type PersonaListing } from '../src/shared/personas'
import { PERSONA_STARTERS } from '../src/shared/personaStarters'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot

function listing(base: Omit<PersonaListing, 'name' | 'problems' | 'warnings' | 'persona'>): PersonaListing {
  const parsed = parsePersona(base.markdown, base.source, undefined, { file: base.file, rev: base.rev })
  return { ...base, name: 'persona' in parsed ? parsed.persona.name : 'broken', ...('persona' in parsed ? { persona: parsed.persona } : {}), problems: 'problems' in parsed ? parsed.problems : [], warnings: parsed.warnings }
}

const MINE = `---
name: reviewer
read_only: true
shows: [diff]
ends_with: [findings]
---
Only find.
`

const LIST: PersonaList = {
  personas: [
    ...PERSONA_STARTERS.map((s) => listing({ id: `built-in:${s.name}`, source: 'built-in', markdown: s.markdown })),
    listing({ id: 'claude-agents:r1:.claude/agents/helper.md', source: 'claude-agents', repoId: 'r1', file: '.claude/agents/helper.md', rev: 'abcdef1234567890', markdown: '---\nname: helper\nmodel: sonnet\ntools: Read\n---\nHelp.' }),
    listing({ id: 'persona-1', source: 'personal', rev: '2026-11-05T01:00:00.000Z', markdown: MINE })
  ],
  mcpServers: ['docs', 'github']
}

const FLOWS: FlowListing[] = [
  { id: 'flow-1', source: 'personal', name: 'Review it', toml: 'name = "Review it"', summary: { steps: 1, loops: 0, gates: 0, personas: ['reviewer'] }, problems: [], warnings: [] },
  { id: 'flow-2', source: 'personal', name: 'Review again', toml: 'name = "Review again"', summary: { steps: 1, loops: 0, gates: 0, personas: ['reviewer'] }, problems: [], warnings: [] }
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
    settings: { ...original.settings, promptTemplates: [], savedCommands: [], flows, loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5[1m]', fast: false }] }
  }
  fakeState.automations = { selected: null }
}

beforeEach(() => {
  resetFake()
  fakeApi.listFlows = vi.fn(async () => FLOWS)
  fakeApi.listPersonas = vi.fn(async () => LIST)
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  fakeState.automations = null
})

describe('Personas on Automations', () => {
  it('is absent while Flows are off, and the personas are never asked for', () => {
    setSnapshot(false)
    render(<AutomationsView />)
    expect(screen.queryByRole('region', { name: 'Personas' })).toBeNull()
    expect(fakeApi.listPersonas).not.toHaveBeenCalled()
  })

  it('lists each persona with its source and what it is, after the flows', async () => {
    setSnapshot(true)
    render(<AutomationsView />)
    const section = await screen.findByRole('region', { name: 'Personas' })
    await waitFor(() => expect(within(section).getByText('architect')).toBeTruthy())
    expect(within(section).getByText('read-only · ends with plan')).toBeTruthy()
    expect(within(section).getByText('edits · ends with done')).toBeTruthy()
    expect(within(section).getByText('read-only · ends with review, done · loadout 3')).toBeTruthy()
    expect(within(section).getByText('Claude subagent · foreman')).toBeTruthy()
    expect(within(section).getByText('.claude/agents/helper.md @ abcdef1')).toBeTruthy()
    expect(within(section).getByText('edits · Claude steps only')).toBeTruthy()
    expect(within(section).getAllByText('Built-in')).toHaveLength(PERSONA_STARTERS.length)
    expect(within(section).getAllByText('writes only docs/features/** · ends with done · loadout 2')).toHaveLength(2)
    expect(within(section).getByText('Personal')).toBeTruthy()
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions.indexOf('Flows')).toBeLessThan(regions.indexOf('Personas'))
  })

  it('opens a built-in persona read-only as its settings, and Copy to personal opens an editable copy', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: 'Open architect' }))
    const dialog = screen.getByRole('dialog', { name: 'architect' })
    expect(within(dialog).getByText(/read-only here/)).toBeTruthy()
    expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly).toBe(true)
    expect(within(dialog).getByRole('switch', { name: 'Read-only' }).getAttribute('aria-checked')).toBe('true')
    expect((within(dialog).getByRole('switch', { name: 'Read-only' }) as HTMLButtonElement).disabled).toBe(true)
    const shows = within(dialog).getByRole('group', { name: 'Shows' })
    expect((within(shows).getByRole('checkbox', { name: 'The task' }) as HTMLInputElement).checked).toBe(true)
    expect((within(shows).getByRole('checkbox', { name: 'The diff' }) as HTMLInputElement).checked).toBe(false)
    expect((within(dialog).getByRole('textbox', { name: 'Instructions' }) as HTMLTextAreaElement).value).toContain('You are the architect')
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()

    await u.click(within(dialog).getByRole('button', { name: 'Copy to personal' }))
    const copy = screen.getByRole('dialog', { name: 'New persona' })
    expect((within(copy).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('architect')
    expect((within(copy).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).readOnly).toBe(false)
    expect(within(copy).getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('writes a new persona as markdown, checks it as it is edited, and saves it as personal', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeApi.savePersonalPersona = vi.fn(async () => ({ persona: LIST.personas.at(-1)! }))
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: /New persona/ }))
    const dialog = screen.getByRole('dialog', { name: 'New persona' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await u.clear(name)
    await u.type(name, 'bad name')
    expect(within(dialog).getByText('This persona can’t be saved yet')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    await u.clear(name)
    await u.type(name, 'designer-2')
    await u.click(within(dialog).getByRole('checkbox', { name: 'Check results' }))
    await u.click(within(dialog).getByRole('switch', { name: 'Read-only' }))
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Default loadout' }), '1')
    // Keep only some MCP servers: all of the repositories' to start with, then one taken off.
    await u.click(within(dialog).getByRole('switch', { name: 'Keep only some MCP servers' }))
    await u.click(within(within(dialog).getByRole('group', { name: 'MCP servers' })).getByRole('checkbox', { name: 'github' }))
    // It edits (read-only is off), so it may be scoped to some paths.
    await u.type(within(dialog).getByRole('textbox', { name: 'Writes only to' }), 'docs/features/**, notes/*.md')
    await u.type(within(dialog).getByRole('textbox', { name: 'Instructions' }), 'Look at the screens.')
    // The document it saves, shown under Source.
    const source = within(dialog).getByRole('textbox', { name: 'Persona (markdown)', hidden: true }) as HTMLTextAreaElement
    expect(source.value).toBe('---\nname: designer-2\nloadout: 1\nshows: [task, diff, checks.results]\nends_with: [findings]\nmcp: [docs]\nwrites: ["docs/features/**", "notes/*.md"]\n---\nLook at the screens.\n')
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(fakeApi.savePersonalPersona).toHaveBeenCalledWith({ id: undefined, markdown: source.value })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a personal persona names the flows that use it, and says a change touches their approval', async () => {
    const u = userEvent.setup()
    setSnapshot(true)
    fakeApi.savePersonalPersona = vi.fn(async () => ({ problems: ['You already have a personal persona named “reviewer”.'] }))
    render(<AutomationsView />)
    await u.click(await screen.findByRole('button', { name: 'Open reviewer' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit persona' })
    expect(within(dialog).getByText('Review it, Review again')).toBeTruthy()
    expect(within(dialog).getByText('Changing this changes the fingerprint of 2 flows: they pause and ask again.')).toBeTruthy()
    await u.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(fakeApi.savePersonalPersona).toHaveBeenCalledWith({ id: 'persona-1', markdown: expect.stringContaining('name: reviewer') })
    // What main refused is shown, and nothing closes.
    expect(within(dialog).getByText('You already have a personal persona named “reviewer”.')).toBeTruthy()
  })
})
