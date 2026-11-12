// @vitest-environment jsdom
// Settings → Usage → Limits (docs/agents.md 7.1) and the paused chat's card (7.2): each state in words and shapes, never colour
// alone; a Meter that names its account and window; the reset as text; and the buttons a paused chat offers.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LimitsSection } from '../src/renderer/src/components/settings/LimitsSection'
import { PausedCard } from '../src/renderer/src/components/LimitResume'
import type { AccountLimits } from '../src/shared/limits'
import type { ChatItem, Session } from '../src/shared/types'
import { clockTime } from '../src/shared/usageLimit'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const NOW = Date.parse('2026-11-11T12:00:00Z')
const min = (n: number) => new Date(NOW + n * 60_000).toISOString()
const work = { id: 'ai-work', agent: 'claude', label: 'Work', auth: 'cli' }

const limits = (): AccountLimits[] => [
  { agent: 'claude', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: min(112) }, { kind: 'weekly', usedPercent: 84, state: 'warning', resetsAt: min(4 * 24 * 60) }], updatedAt: min(-1) },
  { agent: 'claude', instance: 'ai-work', windows: [{ kind: 'session', usedPercent: 22, state: 'ok', resetsAt: min(277) }], updatedAt: min(-1) },
  { agent: 'codex', windows: [{ kind: 'session', usedPercent: 54, state: 'ok', resetsAt: min(200) }, { kind: 'weekly', usedPercent: 18, state: 'ok', resetsAt: min(6 * 24 * 60) }], updatedAt: min(-3) }
]

beforeEach(() => {
  resetFake()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fakeState.snapshot.settings.agentInstances = [work]
  fakeState.snapshot.limits = limits()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const card = (name: RegExp) => screen.getByText(name).closest('.limits-item') as HTMLElement

describe('Settings → Usage → Limits', () => {
  it('is a section headed Limits that reads the accounts when it opens, and again on Refresh', async () => {
    render(<LimitsSection />)
    expect(screen.getByRole('heading', { name: 'Limits' })).toBeTruthy()
    expect(fakeApi.refreshLimits).toHaveBeenCalledTimes(1)
    const refresh = await screen.findByRole('button', { name: 'Refresh' })
    refresh.click()
    expect(fakeApi.refreshLimits).toHaveBeenCalledTimes(2)
  })

  it('pools an agent’s accounts into one sentence, tightest first, with a status in words', () => {
    render(<LimitsSection />)
    const claude = card(/^Claude Code$/)
    expect(within(claude).getByText(/1 of 2 accounts at their limit/)).toBeTruthy()
    const sentence = within(claude).getByText(/is blocked until/)
    expect(sentence.textContent).toBe(`Default account is blocked until ${clockTime(Date.parse(min(112)))}; Work has room.`)
    // Codex has room on its one account.
    expect(within(card(/^Codex$/)).getByText('Has room')).toBeTruthy()
  })

  it('shows each window with a Meter that names its account and window, a figure, a state word and the reset as text', () => {
    render(<LimitsSection />)
    const claude = card(/^Claude Code$/)
    const session = within(claude).getByRole('meter', { name: 'Default account, Session' })
    expect(session.getAttribute('aria-valuenow')).toBe('100')
    expect(session.getAttribute('aria-valuetext')).toBe(`100% used, resets ${clockTime(Date.parse(min(112)))}`)
    // The state is a word with a shape beside it, not a colour: At the limit, Close to the limit, Fine.
    expect(within(claude).getByText('At the limit')).toBeTruthy()
    expect(within(claude).getByText('Close to the limit', { selector: '.ui-status__label' })).toBeTruthy()
    expect(within(claude).getByText('Fine')).toBeTruthy()
    for (const label of claude.querySelectorAll('.limits-row .ui-status')) expect(label.querySelector('svg[data-glyph]')).toBeTruthy()
    // A clock is read, so it is text ("Resets in 1 h 52 min · 14:..."), never a Countdown.
    expect(within(claude).getByText(`Resets in 1 h 52 min · ${clockTime(Date.parse(min(112)))}`)).toBeTruthy()
    expect(within(claude).getByText(/^Resets .* · in 4 days$/)).toBeTruthy()
    expect(claude.querySelector('.ui-countdown')).toBeNull()
    expect(within(claude).getAllByText(/% used$/)).toHaveLength(3)
  })

  it('says an agent that reports no windows doesn’t report them, as a row with a status', () => {
    render(<LimitsSection />)
    const cursor = card(/^Cursor$/)
    expect(within(cursor).getByText('This agent doesn’t report its limits.')).toBeTruthy()
    expect(within(cursor).getByText('Not reported')).toBeTruthy()
    expect(within(cursor).queryByRole('meter')).toBeNull()
  })

  it('an account that hasn’t reported says so; a window whose reset has passed says nothing about now', () => {
    fakeState.snapshot.limits = [{ agent: 'claude', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: min(-5) }], updatedAt: min(-30) }]
    render(<LimitsSection />)
    const claude = card(/^Claude Code$/)
    expect(within(claude).getByText('Reset. The next reading will show its use.')).toBeTruthy()
    expect(within(claude).queryByRole('meter', { name: 'Default account, Session' })).toBeNull()
    expect(within(claude).getByText('Nothing reported yet. Windows appear after the agent’s next turn, or when you refresh.')).toBeTruthy()
    // Nothing blocked any more, and nothing reported by Work: not read yet, rather than room.
    expect(within(claude).queryByText(/blocked until/)).toBeNull()
  })
})

const session = (patch: Partial<Session> = {}): Session =>
  ({ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: min(-100), lastTurn: { outcome: 'limit', turnId: 't1', endedAt: min(-1), resetAt: min(112) }, ...patch }) as Session
const end = (patch: Partial<Extract<ChatItem, { kind: 'turn-end' }>> = {}): Extract<ChatItem, { kind: 'turn-end' }> =>
  ({ kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'error', limit: { resetAt: min(112), source: 'five_hour', from: 'event' }, ...patch })
const resume = { turnId: 't1', resetAt: min(112), at: min(113), source: 'five_hour', from: 'event' as const, text: 'Continue where you left off.', armedAt: min(-1), auto: true as const }

describe('the paused chat’s card', () => {

  it('says when the chat resumes by itself, and offers Resume now, Continue on the account with room, and Dismiss', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<PausedCard item={end()} session={session({ limitResume: resume })} canAct />)
    expect(screen.getByText(`Paused: limit · resets ${clockTime(Date.parse(min(112)))}`)).toBeTruthy()
    expect(screen.getByText(/Foreman sends “Continue where you left off.” in this tab at/)).toBeTruthy()
    expect(screen.getByText(/Account Work has room\. Foreman never moves a chat on its own\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Resume now' }))
    expect(fakeApi.resumeLimitNow).toHaveBeenCalledWith('s1')
    // Never automatic: it moves only on the click, to the account named.
    expect(fakeApi.continueOnAccount).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Continue on account Work' }))
    expect(fakeApi.continueOnAccount).toHaveBeenCalledWith('s1', 'ai-work')
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(fakeApi.cancelLimitResume).toHaveBeenCalledWith('s1')
  })

  it('offers no account that is at its limit too, and none for a turn that belongs to a run', () => {
    fakeState.snapshot.limits = [limits()[0], { agent: 'claude', instance: 'ai-work', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: min(300) }], updatedAt: min(-1) }]
    const { unmount } = render(<PausedCard item={end()} session={session({ limitResume: resume })} canAct />)
    expect(screen.queryByRole('button', { name: /Continue on account/ })).toBeNull()
    unmount()
    fakeState.snapshot.limits = limits()
    render(<PausedCard item={end()} session={session({ limitResume: { ...resume, unattended: { occurrenceId: 'o1' } } })} canAct />)
    expect(screen.queryByRole('button', { name: /Continue on account/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeTruthy()
  })

  it('an unknown reset time says so, offers the time as it always has, and sends nothing by itself', () => {
    render(<PausedCard item={end({ limit: {} })} session={session({ lastTurn: { outcome: 'limit', turnId: 't1', endedAt: min(-1) } })} canAct />)
    expect(screen.getByText('Paused: limit · reset time unknown')).toBeTruthy()
    expect(screen.getByText(/didn’t say when the limit resets|doesn’t tell Foreman when/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeTruthy()
  })

  it('has no buttons when the chat can’t act (an older turn, a running chat)', () => {
    render(<PausedCard item={end()} session={session({ limitResume: resume })} canAct={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()
  })
})
