// @vitest-environment jsdom
// The composer's context trigger: room left before compaction, measured against the usable window, when it shows and
// warns, and what its popover says for an agent that breaks its context down (Claude) and for one that reports a total
// only (Codex, OpenCode, Cursor).
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

describe('the context trigger', () => {
  it('shows from 70% of the usable window (the window less what is kept for compacting), or always when the setting asks', () => {
    // 120K of 200K is 60% of the window, but 72% of the 167K usable once Claude keeps 33K for compacting.
    const { rerender } = render(<ContextWheel usage={{ used: 120_000, limit: 200_000 }} agent="codex" />)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<ContextWheel usage={{ ...claude, used: 120_000 }} agent="claude" />)
    expect(screen.getByRole('button', { name: '120K of 200K tokens used. Auto-compacts in about 47K.' }).textContent).toBe('47K left')
    fakeState.snapshot.settings.alwaysShowContextUsage = true
    rerender(<ContextWheel usage={{ used: 50_000, limit: 200_000 }} agent="codex" />)
    expect(screen.getByRole('button', { name: '50K of 200K tokens used, 150K left.' }).textContent).toBe('150K left')
  })

  it('says how much is left, and warns with a glyph from 90% of the usable window', () => {
    const { rerender } = render(<ContextWheel usage={claude} agent="claude" />)
    // 150K of 167K usable: 89.8%, so neutral (a small ring, no warning glyph).
    let trigger = screen.getByRole('button', { name: /^150K of 200K tokens used/ })
    expect(trigger.textContent).toBe('17K left')
    expect(trigger.querySelector('[data-glyph="warn"]')).toBeNull()
    expect(trigger.querySelector('.context-ring')).toBeTruthy()
    // 152K of 167K: 91%, though only 76% of the whole window.
    rerender(<ContextWheel usage={{ ...claude, used: 152_000 }} agent="claude" />)
    trigger = screen.getByRole('button', { name: '152K of 200K tokens used. Auto-compacts in about 15K.' })
    expect(trigger.textContent).toBe('15K left')
    expect(trigger.querySelector('[data-glyph="warn"]')).toBeTruthy()
  })
})

describe('the context popover', () => {
  it('leads with when compaction comes, draws one bar with the kept buffer hatched apart from free space, and one legend', async () => {
    const user = userEvent.setup()
    render(<ContextWheel usage={claude} agent="claude" root="/work/lisbon" />)
    await user.click(screen.getByRole('button', { name: /^150K of 200K tokens used/ }))
    const pop = screen.getByRole('dialog', { name: 'Context' })
    expect(within(pop).getByText('Auto-compacts in about 17K tokens')).toBeTruthy()
    expect(within(pop).getByText('150K of 200K used. Claude Code keeps 33K free for compacting, so 167K is usable and 90% of it is used.')).toBeTruthy()
    const bar = within(pop).getByRole('img', { name: '150K used, 17K free, then 33K kept for compacting' })
    // The buffer is its own hatched block with a tick where compaction starts, never the free space's look.
    const buffer = bar.querySelector('rect.buffer')!
    const free = bar.querySelector('rect.free')!
    const fill = buffer.getAttribute('fill') ?? ''
    expect(fill).toMatch(/^url\(#.+\)$/)
    expect(bar.querySelector(`pattern[id="${fill.slice(5, -1)}"]`)).toBeTruthy()
    expect(free.getAttribute('fill')).toBeNull()
    expect(bar.querySelector('line.tick')).toBeTruthy()
    expect(bar.textContent).toContain('auto-compacts at 167K')
    // The legend: what fills the window, what's free, what's kept, what loads on demand; each named with its size.
    const legend = within(pop).getByRole('list', { name: 'Where the tokens go' })
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Messages120K', 'System prompt30K', 'Free space17K', 'Autocompact buffer33K', 'MCP tools (deferred)9K on demand'])
    // No "All" table repeating the legend: MCP servers and memory files sit behind a disclosure, with no tab for skills.
    const more = within(pop).getByRole('button', { name: 'MCP servers, memory files and skills' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await user.click(more)
    expect(within(pop).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['MCP', 'Memory'])
    expect(within(pop).getByRole('row', { name: 'rea · 3 tools On demand —' })).toBeTruthy()
    expect(within(pop).getByRole('row', { name: 'linear · 2 tools 3K 1.5%' })).toBeTruthy()
    await user.click(within(pop).getByRole('tab', { name: 'Memory' }))
    expect(within(pop).getByRole('row', { name: 'AGENTS.md 10.2K 5.1%' })).toBeTruthy()
  })

  it('says when the agent reports a total only', async () => {
    const user = userEvent.setup()
    render(<ContextWheel usage={{ used: 190_000, limit: 200_000 }} agent="codex" />)
    await user.click(screen.getByRole('button', { name: '190K of 200K tokens used, 10K left.' }))
    const pop = screen.getByRole('dialog', { name: 'Context' })
    expect(within(pop).getByText('10K left of 200K')).toBeTruthy()
    expect(within(pop).getByRole('img', { name: '190K used, 10K free' })).toBeTruthy()
    expect(within(pop).getByText('Codex reports how full its context is, but not what fills it.')).toBeTruthy()
    expect(within(pop).queryByRole('tablist')).toBeNull()
    expect(within(pop).queryByRole('button', { name: 'Compact now' })).toBeNull()
  })

  it('Compact now compacts and closes, and says what it does', async () => {
    const user = userEvent.setup()
    const onCompact = vi.fn()
    const { rerender } = render(<ContextWheel usage={claude} agent="claude" onCompact={onCompact} />)
    await user.click(screen.getByRole('button', { name: /^150K of 200K/ }))
    expect(screen.getByText('Sends /compact: Claude Code sums up the chat so far and carries on.')).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Compact now' }))
    expect(onCompact).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    // While a turn runs it waits for it; with a draft in the box, it says the draft stays.
    rerender(<ContextWheel usage={claude} agent="claude" onCompact={onCompact} running draft />)
    await user.click(screen.getByRole('button', { name: /^150K of 200K/ }))
    expect(screen.getByText('Queues /compact: when this turn ends, Claude Code sums up the chat so far and carries on.')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe('Your draft stays in the box. It isn’t sent with /compact.')
  })
})
