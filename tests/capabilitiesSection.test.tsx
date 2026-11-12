// @vitest-environment jsdom
// Settings → Agents → an agent → Capabilities (docs/agents.md, 2.6): the record as groups of lines, each a shape and a word,
// with who enforces the rules and what the record was tested against.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilitiesSection } from '../src/renderer/src/components/agents/CapabilityList'
import { staticCapabilities, staticCapabilitiesView } from '../src/shared/agentCatalog'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const section = (agent: string, name: string) => render(<CapabilitiesSection agent={agent} name={name} />)
/** A group's Disclosure button: its name is the group and its count, so a screen reader reads both. */
const groupButton = (name: RegExp) => screen.getByRole('button', { name })
/** The lines of a group; the panel of a closed group is hidden, so it is asked for as hidden. */
const linesOf = (group: string) => within(screen.getByRole('list', { name: group, hidden: true })).getAllByRole('listitem', { hidden: true })

beforeEach(() => {
  resetFake()
  fakeState.snapshot.agentCapabilities = staticCapabilitiesView()
})
afterEach(cleanup)

describe('the Capabilities section', () => {
  it('is a section headed Capabilities that says what Foreman can do with this agent', () => {
    section('codex', 'Codex')
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeTruthy()
    expect(screen.getByText(/What Foreman can do with Codex\./)).toBeTruthy()
  })

  it('lists the groups of the record, each a button that names the group and its count', () => {
    section('codex', 'Codex')
    for (const name of ['Sessions', 'Threads', 'Turns', 'Planning', 'Approvals', 'Tools', 'Subagents', 'Context', 'Checkpointing', 'Enforcement', 'Usage']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) }), name).toBeTruthy()
    }
    expect(groupButton(/^Sessions/).textContent).toContain('2 work')
    // Codex forks its own thread now (thread/fork); Cursor still carries the history as text.
    expect(groupButton(/^Threads/).textContent).toContain('2 work')
  })

  it('counts a fallback beside what works, for an agent that has one', () => {
    section('cursor', 'Cursor')
    expect(groupButton(/^Threads/).textContent).toContain('1 works')
    expect(groupButton(/^Threads/).textContent).toContain('1 with a fallback')
  })

  it('starts a group closed when everything in it works, open when something has a fallback or a gap', () => {
    section('codex', 'Codex')
    expect(groupButton(/^Sessions/).getAttribute('aria-expanded')).toBe('false')
    expect(groupButton(/^Planning/).getAttribute('aria-expanded')).toBe('false')
    expect(groupButton(/^Threads/).getAttribute('aria-expanded')).toBe('false')
    expect(groupButton(/^Subagents/).getAttribute('aria-expanded')).toBe('true')
  })

  it('opens and closes a group from the keyboard', async () => {
    const user = userEvent.setup()
    section('codex', 'Codex')
    const sessions = groupButton(/^Sessions/)
    sessions.focus()
    await user.keyboard('{Enter}')
    expect(sessions.getAttribute('aria-expanded')).toBe('true')
    expect(sessions.getAttribute('aria-controls')).toBeTruthy()
    await user.keyboard(' ')
    expect(sessions.getAttribute('aria-expanded')).toBe('false')
  })

  it('says each line in a word, never only in colour: Works, Works with a fallback or Not offered', () => {
    section('codex', 'Codex')
    const sessions = linesOf('Sessions')
    expect(sessions.map((li) => li.textContent)).toEqual(['Several chats at onceWorks', 'Change the model mid-chatWorks'])
    // Every line carries one of the three words, and a shape beside it (a Status draws one; it is hidden from assistive tech).
    for (const li of screen.getAllByRole('listitem', { hidden: true })) {
      expect(li.textContent).toMatch(/Works with a fallback|Works|Not offered/)
      expect(li.querySelector('svg[data-glyph]')).toBeTruthy()
    }
  })

  it('gives the fallback sentence beside a fallback line', () => {
    section('cursor', 'Cursor')
    const fork = linesOf('Threads').find((li) => li.textContent?.startsWith('Fork a chat'))!
    expect(within(fork).getByText('Works with a fallback')).toBeTruthy()
    expect(within(fork).getByText('The earlier turns go in as attributed text at the start of the first turn.')).toBeTruthy()
    expect(fork.querySelector('svg[data-glyph="info"]')).toBeTruthy()
  })

  it('gives the reason beside a line that is not offered', () => {
    section('codex', 'Codex')
    const children = linesOf('Subagents')[0]
    expect(within(children).getByText('Not offered')).toBeTruthy()
    expect(within(children).getByText('Foreman doesn’t show this agent’s subagents as rows of their own yet.')).toBeTruthy()
    expect(children.querySelector('svg[data-glyph="off"]')).toBeTruthy()
  })

  it('names who enforces the rules: the agent for Codex, Foreman for Cursor', () => {
    section('codex', 'Codex')
    expect(screen.getByText('Enforced by: the agent')).toBeTruthy()
    expect(screen.getByText('Codex’s own modes and sandbox hold the rules.')).toBeTruthy()
    cleanup()
    section('cursor', 'Cursor')
    expect(screen.getByText('Enforced by: Foreman')).toBeTruthy()
    expect(screen.queryByText('Enforced by: the agent')).toBeNull()
  })

  it('says what the record was tested against', () => {
    section('cursor', 'Cursor')
    expect(screen.getByText('Tested against a protocol simulation')).toBeTruthy()
    expect(screen.getByText('Simulated')).toBeTruthy()
  })

  it('says recorded traffic, and the version it was recorded with, when the record is proven by recordings', () => {
    const view = staticCapabilitiesView()
    fakeState.snapshot.agentCapabilities = { ...view, agents: { ...view.agents, codex: { ...staticCapabilities('codex')!, evidence: 'recorded' } } }
    section('codex', 'Codex')
    expect(screen.getByText('Tested against recorded traffic · Codex 0.163.0')).toBeTruthy()
    expect(screen.getByText('Recorded')).toBeTruthy()
  })

  it('names Cursor’s gaps with their reasons, and its permission modes as one mode', () => {
    section('cursor', 'Cursor')
    const planning = linesOf('Planning')
    expect(planning.map((li) => li.textContent)).toEqual([
      'Plan modeNot offeredThis agent hasn’t offered a plan mode.',
      'Questions from the agentNot offeredThis agent can’t ask you a question in the middle of a turn.',
      'Goals it works toward by itselfNot offeredThis agent has no goal of its own for Foreman to show.'
    ])
    const modes = linesOf('Enforcement').find((li) => li.textContent?.startsWith('Permission modes'))!
    expect(within(modes).getByText('This agent runs in one mode: it never asks, so there is nothing to choose.')).toBeTruthy()
  })

  it('lists the modes an agent can run at where it has several', () => {
    section('codex', 'Codex')
    const modes = linesOf('Enforcement').find((li) => li.textContent?.startsWith('Permission modes'))!
    expect(within(modes).getByText('runs at: Ask, Ask except edits, Auto, Never ask')).toBeTruthy()
  })

  it('folds in what an ACP agent declared: Plan mode is Works once it listed a plan session mode', () => {
    section('gemini', 'Gemini CLI')
    expect(linesOf('Planning')[0].textContent).toContain('Not offered')
    cleanup()
    fakeState.snapshot.agentCapabilities = { ...staticCapabilitiesView(), declared: { gemini: { '': { planMode: true } } } }
    section('gemini', 'Gemini CLI')
    expect(linesOf('Planning')[0].textContent).toBe('Plan modeWorks')
  })

  it('names each group’s list, so a screen reader announces which group a line is in', () => {
    section('cursor', 'Cursor')
    expect(screen.getAllByRole('list', { hidden: true }).map((l) => l.getAttribute('aria-label'))).toEqual([
      'Sessions', 'Threads', 'Turns', 'Planning', 'Approvals', 'Tools', 'Subagents', 'Context', 'Checkpointing', 'Enforcement', 'Usage'
    ])
  })

  it('draws nothing for an agent with no record (a Terminal agent)', () => {
    const { container } = section('aider', 'Aider')
    expect(container.textContent).toBe('')
  })

  it('takes children after the groups (what a Chat agent reported when it last ran)', () => {
    render(
      <CapabilitiesSection agent="gemini" name="Gemini CLI">
        <p>It said it can resume.</p>
      </CapabilitiesSection>
    )
    expect(screen.getByText('It said it can resume.')).toBeTruthy()
  })
})
