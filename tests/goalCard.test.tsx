// @vitest-environment jsdom
// Docs/agents.md 3 (slice 4a): the agent's goal above the composer, with Clear; the /goal command the record offers; and Settings →
// Agents → Claude Code → Compact idle chats.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalCard } from '../src/renderer/src/components/GoalCard'
import { IdleCompactRow } from '../src/renderer/src/components/settings/agentPanels'
import { builtinCommands } from '../src/shared/agents'
import { staticCapabilitiesView } from '../src/shared/agentCatalog'
import type { Session, SessionGoal } from '../src/shared/types'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  fakeState.snapshot.agentCapabilities = staticCapabilitiesView()
  fakeApi.sendMessage = vi.fn(async () => ({ disposition: 'sent' }))
  fakeApi.updateSettings = vi.fn(async () => ({}))
  fakeApi.resetSettings = vi.fn(async () => ({}))
})
afterEach(cleanup)

const goal = (patch: Partial<SessionGoal> = {}): SessionGoal => ({ objective: 'Get the sessions tests passing on Windows and macOS.', status: 'active', tokensUsed: 48_200, timeUsedSeconds: 14 * 60 + 48, ...patch })
const session = (patch: Partial<Session> = {}) => ({ id: 's1', agent: 'codex', status: 'idle', goal: goal(), ...patch }) as Session

describe('the goal card', () => {
  it('shows what the agent is working toward, its state in a word, what it has used, and Clear', () => {
    render(<GoalCard session={session()} />)
    const card = screen.getByRole('region', { name: 'Goal for this chat' })
    expect(within(card).getByText('Goal')).toBeTruthy()
    expect(within(card).getByText('Get the sessions tests passing on Windows and macOS.')).toBeTruthy()
    // State is a word with a shape (a Status), never a colour alone.
    const status = within(card).getByText('Active').closest('.ui-status')!
    expect(status.querySelector('svg[data-glyph]')).toBeTruthy()
    expect(within(card).getByText('15 min')).toBeTruthy()
    expect(within(card).getByText('48,200 tokens')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Clear goal' })).toBeTruthy()
  })

  it('says each way a goal stops in words', () => {
    for (const [status, word] of [['paused', 'Paused'], ['blocked', 'Blocked'], ['usageLimited', 'Usage limit reached'], ['budgetLimited', 'Over its token budget'], ['complete', 'Complete']] as const) {
      const { unmount } = render(<GoalCard session={session({ goal: goal({ status }) })} />)
      expect(screen.getByText(word), word).toBeTruthy()
      unmount()
    }
  })

  it('shows seconds under a minute', () => {
    render(<GoalCard session={session({ goal: goal({ timeUsedSeconds: 48 }) })} />)
    expect(screen.getByText('48 s')).toBeTruthy()
  })

  it('is not there without a goal', () => {
    const { container } = render(<GoalCard session={session({ goal: undefined })} />)
    expect(container.textContent).toBe('')
  })

  it('Clear sends /goal clear as a message: into the running turn while the goal works, as a message of its own otherwise', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GoalCard session={session({ status: 'running' })} />)
    await user.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(fakeApi.sendMessage).toHaveBeenLastCalledWith('s1', '/goal clear', { mode: 'steer' })
    rerender(<GoalCard session={session({ status: 'idle' })} />)
    await user.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(fakeApi.sendMessage).toHaveBeenLastCalledWith('s1', '/goal clear', undefined)
  })
})

describe('the /goal command', () => {
  it('is offered where the record says the agent keeps goals, and nowhere else', () => {
    expect(builtinCommands('codex').map((c) => c.name)).toContain('goal')
    for (const agent of ['claude', 'cursor', 'opencode', 'gemini'] as const) expect(builtinCommands(agent).map((c) => c.name), agent).not.toContain('goal')
    expect(builtinCommands('codex').find((c) => c.name === 'goal')?.description).toMatch(/goal/i)
  })

  it('/compact is Codex\'s now too, and still Claude Code\'s', () => {
    for (const agent of ['claude', 'codex'] as const) expect(builtinCommands(agent).map((c) => c.name), agent).toContain('compact')
  })
})

describe('Compact idle chats', () => {
  it('is off by default and says it spends usage', () => {
    fakeState.snapshot.settings.idleCompactTokens = 0
    render(<IdleCompactRow />)
    expect(screen.getByRole('combobox', { name: 'Compact idle chats' }).textContent).toContain('Off')
    expect(screen.getByText(/Spends usage to make your next message cheaper/)).toBeTruthy()
  })

  it('saves the context size it is chosen at, and Reset turns it off again', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.settings.idleCompactTokens = 0
    const { unmount } = render(<IdleCompactRow />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compact idle chats' }), 'Over 150,000 tokens')
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ idleCompactTokens: 150_000 }))
    unmount()

    fakeState.snapshot.settings.idleCompactTokens = 150_000
    render(<IdleCompactRow />)
    expect(screen.getByRole('combobox', { name: 'Compact idle chats' }).textContent).toContain('Over 150,000 tokens')
    await user.click(screen.getByRole('button', { name: 'Setting actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Reset' }))
    await waitFor(() => expect(fakeApi.resetSettings).toHaveBeenCalledWith(['idleCompactTokens']))
  })
})
