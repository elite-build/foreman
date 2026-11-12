// @vitest-environment jsdom
// "What Codex received" (docs/agents.md 5.5): the dialog that shows the record of a switch, opened from the chat's notice
// and from Lineage's switch edge; the blocked-move reason on a line of its own in the picker; the notice's words.
import '../domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { HandOffDialog, WhatReceivedLink } from '../../src/renderer/src/components/HandOffRecord'
import { MoveDivider, SwitchDivider } from '../../src/renderer/src/components/SwitchDivider'
import type { ChatHandOff } from '../../src/shared/chatHandOff'
import { ability } from '../../src/shared/agentCapabilities'
import { staticCapabilitiesView } from '../../src/shared/agentCatalog'
import { fakeState, resetFake, storeModule } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)

const record = (over: Partial<ChatHandOff> = {}): ChatHandOff => ({
  turnId: 'next',
  from: { agent: 'claude', model: 'claude-opus-5-5[1m]' },
  to: { agent: 'codex', model: 'gpt-6.1-sol' },
  strategy: 'prompt-full',
  budgetTokens: 16_000,
  usedTokens: 15_200,
  full: ['t5', 't6'],
  condensed: ['t3', 't4'],
  omitted: ['t1', 't2'],
  turns: [
    { id: 't1', n: 1, agent: 'claude', request: 'Set up the repo', tokens: 0 },
    { id: 't2', n: 2, agent: 'claude', request: 'Add a size cap', tokens: 0 },
    { id: 't3', n: 3, agent: 'claude', request: 'Fix the flaky eviction test', tokens: 90 },
    { id: 't4', n: 4, agent: 'claude', request: 'Rename the key helper', tokens: 95 },
    { id: 't5', n: 5, agent: 'claude', request: 'Run the cache tests after the change', tokens: 2_300 },
    { id: 't6', n: 6, agent: 'claude', request: 'Why does the cache key include the workspace path?', tokens: 1_900 }
  ],
  ...over
})

const original = fakeState.snapshot
beforeEach(() => {
  resetFake()
  ;(storeModule.openSettingsPage as Mock).mockClear()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the notice in the chat', () => {
  it('says what the agent was given and links to the record, by the agent’s name', async () => {
    const user = userEvent.setup()
    render(<SwitchDivider switched={{ from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history', handOff: record() }} />)
    expect(screen.getByText(/Switched to/).textContent).toContain('2 turns in full, 2 condensed, 2 left out · 15,200 of 16,000 tokens')
    // The line holds a link, so it isn’t a separator (whose children would be presentational).
    expect(screen.queryByRole('separator')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'What Codex received' }))
    expect(screen.getByRole('dialog', { name: 'What Codex received' })).toBeTruthy()
  })

  it('for an agent back on its own conversation says how many turns it missed', () => {
    render(<SwitchDivider switched={{ from: 'codex', to: 'claude', model: 'claude-opus-5-5[1m]', carried: 'native', handOff: record({ strategy: 'resume-delta', to: { agent: 'claude', model: 'claude-opus-5-5[1m]' }, full: ['t5', 't6'], condensed: [], omitted: [], usedTokens: 4_100 }) }} />)
    expect(screen.getByText(/Back to/).textContent).toContain('resumed its own session')
    expect(screen.getByText(/Back to/).textContent).toContain('2 turns since you left · 4,100 of 16,000 tokens')
    expect(screen.getByRole('button', { name: 'What Claude Code received' })).toBeTruthy()
  })

  it('keeps the old line, a separator, for a switch from before the record existed', () => {
    render(<SwitchDivider switched={{ from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history' }} />)
    expect(screen.getByRole('separator').textContent).toContain('Switched to Codex · GPT-6.1 Sol')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('an account move shows its own words and the same link', () => {
    render(<MoveDivider text="Moved to the account Work · earlier messages passed to Claude Code as text" handOff={record({ to: { agent: 'claude', instance: 'work', model: 'claude-opus-5-5[1m]' } })} />)
    expect(screen.getByText(/Moved to the account Work/).textContent).toContain('2 turns in full')
    expect(screen.getByRole('button', { name: 'What Claude Code received' })).toBeTruthy()
  })
})

describe('the record dialog', () => {
  it('is named for the agent that received it, says how, how big, and lists the turns by how they were given', async () => {
    render(<HandOffDialog handOff={record()} onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog', { name: 'What Codex received' })
    // From and To, with the model.
    expect(within(dialog).getByText('Claude Code · Opus 5.5')).toBeTruthy()
    expect(within(dialog).getByText('Codex · GPT-6.1 Sol')).toBeTruthy()
    // How: in words, and the strategy id as a tag.
    expect(within(dialog).getByText('Sent as text at the start of Codex’s first turn.')).toBeTruthy()
    expect(within(dialog).getByText('prompt-full')).toBeTruthy()
    // Size: a meter with a name and the figures in words, and the estimate is labelled as one.
    const size = within(dialog).getByRole('meter', { name: 'Size' })
    expect(size.getAttribute('aria-valuetext')).toBe('15,200 of 16,000')
    expect(size.getAttribute('aria-valuemax')).toBe('16000')
    expect(within(dialog).getByText(/An estimate \(characters ÷ 4\)/)).toBeTruthy()
    // The three groups, each with its turns by number.
    // A group's title is its heading; the line beside it says how many turns and why they are in it.
    const heading = (name: string) => within(dialog).getByRole('heading', { name: new RegExp(`^${name}`) }).closest('.hor-head') as HTMLElement
    expect(heading('In full').textContent).toContain('2 turns · newest first, up to 60% of the size')
    expect(heading('Condensed').textContent).toContain('2 turns · the request and the final answer, 400 characters each')
    expect(heading('Left out').textContent).toContain('2 turns · #1–2')
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows[0]).toContain('#5')
    expect(rows[0]).toContain('Run the cache tests after the change')
    expect(rows.join('|')).toContain('#1')
    // What the agent was told about the gap: it has the tool.
    expect(within(dialog).getByText('Codex was told these were left out, and that it can read them with the read_chat_history tool.')).toBeTruthy()
    // The word the app keeps for other things is not in the dialog.
    expect(dialog.textContent).not.toMatch(/hand[- ]?off/i)
  })

  it('shows only the groups that have turns, a delta as such, and a record not sent yet as pending', () => {
    render(
      <HandOffDialog
        handOff={record({ strategy: 'resume-delta', turnId: undefined, sinceTurn: 't4', full: ['t5', 't6'], condensed: [], omitted: [] })}
        onClose={() => undefined}
      />
    )
    expect(screen.queryByRole('heading', { name: /^Condensed/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Left out/ })).toBeNull()
    expect(screen.getByText('Only the turns after turn 4, which Codex had already seen, were sent.')).toBeTruthy()
    expect(screen.getByText('Not sent yet: it goes with the next message.')).toBeTruthy()
    expect(screen.getByText('resume-delta')).toBeTruthy()
  })

  it('names the agent in the dialog title, and its Close button and the key close it, giving focus back to the link', async () => {
    const user = userEvent.setup()
    render(<WhatReceivedLink handOff={record({ to: { agent: 'claude', model: 'claude-opus-5-5[1m]' }, from: { agent: 'codex', model: 'gpt-6.1-sol' } })} />)
    const link = screen.getByRole('button', { name: 'What Claude Code received' })
    await user.click(link)
    expect(screen.getByRole('dialog', { name: 'What Claude Code received' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(link)
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Change opens Settings on the Default models page and closes the dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<HandOffDialog handOff={record()} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(onClose).toHaveBeenCalled()
    expect(storeModule.openSettingsPage).toHaveBeenCalledWith({ section: 'models' })
  })

  it('does not promise a tool to an agent that has none', () => {
    // A chat agent whose record has no MCP is told only that turns were left out.
    const view = staticCapabilitiesView()
    fakeState.snapshot = { ...fakeState.snapshot, agentCapabilities: { ...view, agents: { ...view.agents, cursor: { ...view.agents.cursor, tools: { ...view.agents.cursor.tools, mcp: ability('none', 'agentCaps.why.compact') } } } } }
    render(<HandOffDialog handOff={record({ to: { agent: 'cursor', model: 'composer-2' } })} onClose={() => undefined} />)
    expect(screen.queryByText(/read_chat_history/)).toBeNull()
    expect(screen.getByText('Cursor was told these were left out. It has no tool to read them.')).toBeTruthy()
  })
})
