// @vitest-environment jsdom
// The in-chat sign-in card (it says so and offers Retry once the agent is signed in) and the picker's signed-out labels.
import './domShims'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStatuses, setAgentForNewWorkspaces } from '../src/renderer/src/agentReadiness'
import { PickerAgentGroups } from '../src/renderer/src/components/agents/PickerAgents'
import { SignInNotice } from '../src/renderer/src/components/SignInNotice'
import type { ChatItem, Session } from '../src/shared/types'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const session = { id: 's1', workspaceId: 'w1', agent: 'claude' } as unknown as Session
const user = { kind: 'user', id: 'u1', turnId: 't1', text: 'fix the bug', at: '2026-01-01T00:00:00Z' } as ChatItem
const notice = { kind: 'notice', id: 't1:notice:0', turnId: 't1', level: 'error', text: 'Not logged in · Please run /login', action: 'sign-in' } as Extract<ChatItem, { kind: 'notice' }>

let claudeReady = false
beforeEach(() => {
  resetFake()
  resetAgentStatuses()
  claudeReady = false
  fakeState.settingsPage = null
  fakeApi.agentStatus = vi.fn(async (agent: string) => ({ agent, installed: true, ready: agent === 'claude' ? claudeReady : true, method: 'Claude Max account' }))
  fakeApi.sendMessage = vi.fn(async () => undefined)
  ;(storeModule.openSettingsPage as ReturnType<typeof vi.fn>).mockClear()
})
afterEach(cleanup)

function card(items: ChatItem[] = [user, notice], running = false) {
  return <SignInNotice item={notice} items={items} session={session} running={running}>{notice.text}</SignInNotice>
}

describe('the in-chat sign-in card', () => {
  it('opens Settings → Agents for that agent', async () => {
    const u = userEvent.setup()
    render(card())
    await u.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }))
    expect(storeModule.openSettingsPage).toHaveBeenCalledWith({ section: 'agents', agent: 'claude' })
    expect(screen.getByText(/Please run \/login/)).toBeTruthy()
  })

  it('says so and offers Retry for the failed message once the agent is signed in', async () => {
    const u = userEvent.setup()
    render(card())
    await u.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }))
    claudeReady = true
    await u.click(await screen.findByRole('button', { name: 'Check again' }))
    const done = await screen.findByRole('status')
    expect(done.textContent).toContain('Signed in to Claude Code')
    await u.click(screen.getByRole('button', { name: 'Retry' }))
    expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', 'fix the bug', { attachments: undefined, templateId: undefined })
  })

  it('notices a sign-in made elsewhere when the status was seen signed out first', async () => {
    render(card())
    await waitFor(() => expect(fakeApi.agentStatus).toHaveBeenCalled())
    await screen.findByRole('button', { name: 'Sign in to Claude Code' })
    claudeReady = true
    const { refreshAgentStatuses } = await import('../src/renderer/src/agentReadiness')
    await refreshAgentStatuses(true)
    expect((await screen.findByRole('status')).textContent).toContain('Signed in to Claude Code')
  })

  it('does not claim a sign-in the user never made when the status was already ready', async () => {
    claudeReady = true
    render(card())
    await waitFor(() => expect(fakeApi.agentStatus).toHaveBeenCalledWith('claude'))
    expect(await screen.findByRole('button', { name: 'Sign in to Claude Code' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers no Retry for an older message or while a turn runs', async () => {
    const u = userEvent.setup()
    const later = { kind: 'user', id: 'u2', turnId: 't2', text: 'another', at: '2026-01-01T00:01:00Z' } as ChatItem
    const { rerender } = render(card([user, notice, later]))
    await u.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }))
    claudeReady = true
    await u.click(await screen.findByRole('button', { name: 'Check again' }))
    await screen.findByRole('status')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    rerender(card([user, notice], true))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    rerender(card([user, notice], false))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('the picker', () => {
  it('labels a signed-out Claude in words, keeps it selectable and offers sign-in', async () => {
    const u = userEvent.setup()
    fakeState.snapshot.settings.agentPrefs = {}
    fakeState.opencodeInstalled = true
    const onPick = vi.fn()
    const onSetUp = vi.fn()
    render(<PickerAgentGroups current="codex" onPick={onPick} onSetUp={onSetUp} />)
    const claude = await screen.findByRole('button', { name: /Claude Code.*Not signed in/ })
    await u.click(claude)
    expect(onPick).toHaveBeenCalledWith('claude')
    await u.click(screen.getByRole('button', { name: 'Sign in to Claude Code' }))
    expect(onSetUp).toHaveBeenCalledWith('claude')
    // Codex is signed in: no visible label, no sign-in link, but the evidence is in its name.
    expect(screen.getByRole('button', { name: /Codex.*Account found/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in to Codex' })).toBeNull()
  })
})

describe('"Use for new workspaces"', () => {
  const claude = { agent: 'claude', model: 'a', fast: false }
  const codex = { agent: 'codex', model: 'c', fast: false }

  it('saves the agent’s first loadout on top through the settings update', async () => {
    fakeState.snapshot.settings.loadouts = [claude, codex]
    fakeApi.updateSettings = vi.fn(async () => ({}))
    expect(await setAgentForNewWorkspaces('codex')).toBe(true)
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ loadouts: [codex, claude] })
    expect(storeModule.showToast).toHaveBeenCalledWith('Codex is now first in your loadouts. New workspaces start with it.', 'info')
  })

  it('saves nothing when that loadout is already first', async () => {
    fakeState.snapshot.settings.loadouts = [claude, codex]
    fakeApi.updateSettings = vi.fn(async () => ({}))
    expect(await setAgentForNewWorkspaces('claude')).toBe(true)
    expect(fakeApi.updateSettings).not.toHaveBeenCalled()
  })
})
