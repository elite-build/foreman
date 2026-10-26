// @vitest-environment jsdom
// The Get started card on Home: items with their state in words, each "Show me" opening the real place, Hide, and More.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStatuses } from '../src/renderer/src/agentReadiness'
import { GetStarted } from '../src/renderer/src/components/GetStarted'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

function setSnapshot(over: { milestones?: Record<string, string>; hidden?: boolean; repos?: unknown[]; workspaces?: unknown[]; layout?: string } = {}) {
  const base = fakeState.snapshot
  fakeState.snapshot = {
    ...base,
    repos: over.repos ?? [],
    workspaces: over.workspaces ?? [],
    settings: {
      ...base.settings,
      windowLayout: over.layout ?? 'panes',
      loadouts: [{ agent: 'claude', model: 'claude-opus-5-5', effort: 'high', fast: false }],
      onboarding: { milestones: over.milestones ?? {}, checklistHidden: over.hidden ?? false }
    }
  }
  fakeState.sidebarView = { repo: null }
  fakeState.selectedWorkspaceId = null
  fakeState.assistant = { gate: { state: 'ready', agent: 'claude' } }
}

const original = fakeState.snapshot
beforeEach(() => {
  resetFake()
  resetAgentStatuses()
  fakeState.snapshot = original
  fakeApi.agentStatus = vi.fn(async (agent: string) => ({ agent, installed: true, ready: true, method: 'Claude Max account' }))
  for (const name of ['openSettingsPage', 'openNewWorkspace', 'addRepository', 'setChecklistHidden', 'showToast', 'openAutomations', 'openOverlay']) spy(name).mockClear()
  setSnapshot()
})
afterEach(cleanup)

function item(name: string): HTMLElement {
  return screen.getByRole('button', { name: `Show me: ${name}` }).closest('li') as HTMLElement
}

describe('the Get started card', () => {
  it('lists the items with their state in words and the progress', () => {
    setSnapshot({ milestones: { tiles: '2026-10-26T06:15:46.572Z' } })
    render(<GetStarted />)
    expect(screen.getByRole('heading', { name: 'Get started' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Get started checklist' })
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(9)
    expect(within(item('Try Tiles')).getByText('Done')).toBeTruthy()
    expect(within(item('Add a project')).getByText('To do')).toBeTruthy()
    expect(screen.getByText(/of \d+ done/)).toBeTruthy()
  })

  it('stays away once hidden', () => {
    setSnapshot({ hidden: true })
    const { container } = render(<GetStarted />)
    expect(container.textContent).toBe('')
  })

  it('opens Settings → Accessibility for Make Foreman comfortable', async () => {
    const u = userEvent.setup()
    render(<GetStarted />)
    await u.click(screen.getByRole('button', { name: 'Show me: Make Foreman comfortable' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'accessibility' })
  })

  it('offers a project first when Start a workspace has none to work in', async () => {
    const u = userEvent.setup()
    render(<GetStarted />)
    await u.click(screen.getByRole('button', { name: 'Show me: Start a workspace' }))
    expect(spy('addRepository')).toHaveBeenCalled()
    expect(spy('openNewWorkspace')).not.toHaveBeenCalled()
  })

  it('opens New workspace in the first project when there is one', async () => {
    const u = userEvent.setup()
    setSnapshot({ repos: [{ id: 'r1', name: 'app', path: 'C:/app' }] })
    render(<GetStarted />)
    await u.click(screen.getByRole('button', { name: 'Show me: Start a workspace' }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
  })

  it('switches to Tiles and says how to switch back', async () => {
    const u = userEvent.setup()
    fakeApi.updateSettings = vi.fn(async () => true)
    render(<GetStarted />)
    await u.click(screen.getByRole('button', { name: 'Show me: Try Tiles' }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ windowLayout: 'tiles' })
    await vi.waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith(expect.stringContaining('Switch to three panes')))
  })

  it('hides the checklist and says how to bring it back', async () => {
    const u = userEvent.setup()
    render(<GetStarted />)
    await u.click(screen.getByRole('button', { name: 'Hide checklist' }))
    expect(spy('setChecklistHidden')).toHaveBeenCalledWith(true)
    expect(spy('showToast')).toHaveBeenCalledWith(expect.stringContaining('Get started checklist'))
  })

  it('keeps More collapsed until asked, then links to the extras', async () => {
    const u = userEvent.setup()
    render(<GetStarted />)
    expect(screen.queryByRole('button', { name: 'Cloud workspaces (experimental)' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'More' }))
    await u.click(screen.getByRole('button', { name: 'Cloud workspaces (experimental)' }))
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'cloud' })
  })
})
