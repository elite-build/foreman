// @vitest-environment jsdom
// The composer's context ring: when it shows, and what its popover says for an agent that breaks its context down
// (Claude) and for one that reports a total only (Codex, OpenCode, Cursor).
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextUsage } from '../src/shared/types'
import { ContextWheel } from '../src/renderer/src/components/composer/ContextWheel'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const claude: ContextUsage = {
  used: 150_000,
  limit: 200_000,
  breakdown: {
    categories: [
      { name: 'Messages', tokens: 120_000, kind: 'used' },
      { name: 'System prompt', tokens: 30_000, kind: 'used' },
      { name: 'Free space', tokens: 17_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
      { name: 'MCP tools (deferred)', tokens: 9000, kind: 'deferred' }
    ],
    mcpServers: [
      { name: 'linear', tools: 2, tokens: 3000, deferred: false },
      { name: 'rea', tools: 3, tokens: 9000, deferred: true }
    ],
    memoryFiles: [{ path: '/work/lisbon/AGENTS.md', tokens: 10_200 }],
    skills: []
  }
}

beforeEach(() => {
  resetFake()
  fakeState.snapshot.settings.alwaysShowContextUsage = false
})
afterEach(cleanup)

describe('the context ring', () => {
  it('shows above 70%, or always when the setting asks', () => {
    const { rerender } = render(<ContextWheel usage={{ used: 50_000, limit: 200_000 }} agent="codex" />)
    expect(screen.queryByRole('button')).toBeNull()
    fakeState.snapshot.settings.alwaysShowContextUsage = true
    rerender(<ContextWheel usage={{ used: 50_000, limit: 200_000 }} agent="codex" />)
    expect(screen.getByRole('button', { name: /^Context: 50K of 200K tokens \(25%\)/ })).toBeTruthy()
  })

  it('opens what fills the window when the agent says, by category, MCP server and memory file', async () => {
    const user = userEvent.setup()
    render(<ContextWheel usage={claude} agent="claude" root="/work/lisbon" />)
    await user.click(screen.getByRole('button', { name: /^Context: 150K of 200K tokens \(75%\)/ }))
    const pop = screen.getByRole('dialog', { name: 'Context' })
    expect(within(pop).getByRole('img', { name: '75% of the context window used' })).toBeTruthy()
    // The legend: what fills the window and what's kept for compaction, each named with its size.
    const legend = within(pop).getByRole('list')
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Messages120K', 'System prompt30K', 'Autocompact buffer33K'])
    // Skills has no rows, so no tab.
    expect(within(pop).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'MCP', 'Memory'])
    expect(within(pop).getByRole('row', { name: /MCP tools \(deferred\) 9K —/ })).toBeTruthy()
    await user.click(within(pop).getByRole('tab', { name: 'MCP' }))
    expect(within(pop).getByRole('row', { name: 'rea · 3 tools On demand —' })).toBeTruthy()
    expect(within(pop).getByRole('row', { name: 'linear · 2 tools 3K 1.5%' })).toBeTruthy()
    await user.click(within(pop).getByRole('tab', { name: 'Memory' }))
    expect(within(pop).getByRole('row', { name: 'AGENTS.md 10.2K 5.1%' })).toBeTruthy()
  })

  it('says when the agent reports a total only', async () => {
    const user = userEvent.setup()
    render(<ContextWheel usage={{ used: 190_000, limit: 200_000 }} agent="codex" />)
    await user.click(screen.getByRole('button', { name: /^Context: 190K of 200K tokens \(95%\)/ }))
    const pop = screen.getByRole('dialog', { name: 'Context' })
    expect(within(pop).getByText('Codex reports how full its context is, but not what fills it.')).toBeTruthy()
    expect(within(pop).queryByRole('tablist')).toBeNull()
    expect(within(pop).queryByRole('button', { name: 'Compact now' })).toBeNull()
  })

  it('puts /compact in the draft and closes, for an agent that has it', async () => {
    const user = userEvent.setup()
    const onCompact = vi.fn()
    render(<ContextWheel usage={claude} agent="claude" onCompact={onCompact} />)
    await user.click(screen.getByRole('button', { name: /^Context:/ }))
    await user.click(screen.getByRole('button', { name: 'Compact now' }))
    expect(onCompact).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
