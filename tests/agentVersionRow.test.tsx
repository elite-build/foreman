// @vitest-environment jsdom
// Settings → Agents: the version has its word next to it (tested, untested, degraded, broken) and, where the agent has an
// update command and runs from the user's own copy, an Update button that opens a terminal for it (docs/agents.md, 4.1).
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStatusBlock, type AgentStatusState } from '../src/renderer/src/components/settings/AgentStatusCard'
import { CapabilitiesSection } from '../src/renderer/src/components/agents/CapabilityList'
import { catalogAgent, staticCapabilitiesView } from '../src/shared/agentCatalog'
import type { AgentKind, AgentStatus } from '../src/shared/types'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
// The update runs in a terminal tab; what it runs is main's business (core.ptySpawn), so the terminal is a stand-in here.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ command }: { command?: string }) => <div data-testid="terminal">{command}</div>
}))

beforeEach(() => {
  resetFake()
  fakeState.snapshot.agentCapabilities = staticCapabilitiesView()
})
afterEach(cleanup)

const block = (agent: AgentKind, status: Partial<AgentStatus>, updatable = true) => {
  const state: AgentStatusState = { status: { agent, installed: true, ready: true, ...status }, loading: false, error: null, refresh: async () => undefined }
  return render(<AgentStatusBlock agent={agent} state={state} view={{ connected: true, message: 'Connected' }} updatable={updatable} />)
}

describe('the version word', () => {
  it('says tested next to a version the fixtures were recorded with', () => {
    block('claude', { version: '2.1.301', bundled: true })
    expect(screen.getByText('2.1.301 · tested')).toBeTruthy()
  })

  it('says untested next to any other version', () => {
    block('codex', { version: '0.164.0' })
    expect(screen.getByText('0.164.0 · untested')).toBeTruthy()
  })

  it('says broken or degraded with what is wrong, when the table says', () => {
    const table = catalogAgent('codex')!.versions!
    catalogAgent('codex')!.versions = { ...table, broken: [{ range: '<0.100.0', why: 'agentCaps.why.cost' }] }
    try {
      block('codex', { version: '0.99.0' })
      expect(screen.getByText('0.99.0 · broken')).toBeTruthy()
      expect(screen.getByText('This agent doesn’t report a price for a turn.')).toBeTruthy()
    } finally {
      catalogAgent('codex')!.versions = table
    }
  })
})

describe('the Update button', () => {
  it('is offered for the user’s own copy, and runs nothing until it is pressed', async () => {
    const user = userEvent.setup()
    block('codex', { version: '0.150.0' })
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.getByText('codex update')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Update' }))
    expect(screen.getByTestId('terminal').textContent).toBe('update:codex')
  })

  it('is not offered for the copy that ships inside Foreman, which Foreman’s own update changes', () => {
    block('claude', { version: '2.1.301', bundled: true })
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })

  it('is not offered where the block is not the agent’s own page (an account), or the agent has no update command', () => {
    block('codex', { version: '0.150.0' }, false)
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    cleanup()
    block('cursor', { version: '1.0.0' })
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })
})

describe('the evidence line', () => {
  it('names the version the recordings were made with', () => {
    render(<CapabilitiesSection agent="codex" name="Codex" />)
    expect(screen.getByText('Tested against recorded traffic · Codex 0.163.0')).toBeTruthy()
  })

  it('says only that a simulation was used where nothing was recorded', () => {
    render(<CapabilitiesSection agent="cursor" name="Cursor" />)
    expect(screen.getByText('Tested against a protocol simulation')).toBeTruthy()
  })
})
