// @vitest-environment jsdom
// Show resource usage in the sidebar footer: Foreman's own line, plus what workspaces run, opening a breakdown by workspace
// (agents, terminals, scripts and the programs under them) as text a screen reader reads. It polls only while the setting is
// on and the window can be seen.
import './domShims'

const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const events: { handler?: (event: unknown) => void } = {}
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (handler: (event: unknown) => void) => {
      events.handler = handler
      return () => undefined
    },
    send: { setUnread: vi.fn() },
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke, events }
})

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOURCE_POLL_MS, ResourceUsage } from '../src/renderer/src/components/ResourceUsage'
import { initStore } from '../src/renderer/src/store'
import type { ResourceUsage as Usage } from '../src/shared/types'

const MB = 1024 * 1024
const snapshot = (showResourceUsage: boolean) => ({
  platform: 'win32',
  settings: { language: 'en', agentPrefs: {}, loadouts: [], showResourceUsage },
  repos: [],
  repoSettings: {},
  workspaces: [
    { id: 'w1', repoId: 'r1', name: 'kite-login', branch: 'kite-login', baseBranch: 'main', path: '/w/one', state: 'ready' },
    { id: 'w2', repoId: 'r1', name: 'docs-pass', branch: 'docs-pass', baseBranch: 'main', path: '/w/two', state: 'ready' }
  ],
  sessions: [],
  catalog: { agents: {} },
  agentKeys: {}
})
const usage: Usage = {
  cpuPercent: 7.4,
  memoryMb: 900,
  workspaces: [
    {
      workspaceId: 'w2',
      processes: 1,
      memoryBytes: 90 * MB,
      cpuPercent: 0,
      top: [{ name: 'pwsh', count: 1, memoryBytes: 90 * MB }],
      kinds: [{ kind: 'terminal', processes: 1, memoryBytes: 90 * MB }]
    },
    {
      workspaceId: 'w1',
      processes: 6,
      memoryBytes: 1536 * MB,
      cpuPercent: 12.6,
      top: [
        { name: 'claude', count: 1, memoryBytes: 600 * MB },
        { name: 'node', count: 4, memoryBytes: 300 * MB }
      ],
      kinds: [{ kind: 'agent', processes: 6, memoryBytes: 1536 * MB }]
    },
    // A workspace this window doesn't know (archived meanwhile) isn't listed.
    { workspaceId: 'gone', processes: 2, memoryBytes: 10 * MB, cpuPercent: 0, top: [], kinds: [] }
  ]
}
const emit = (event: unknown) => act(() => bridge.events.handler!(event))

async function start(on: boolean) {
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot(on))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  bridge.invoke.resourceUsage = vi.fn(async () => usage)
  await initStore()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  cleanup()
  bridge.events.handler?.({ type: 'window-visibility', visible: true })
  vi.useRealTimers()
})

describe('resource usage in the sidebar', () => {
  it('shows Foreman’s own usage and what workspaces run, and opens a breakdown by workspace', async () => {
    await start(true)
    render(<ResourceUsage />)
    const trigger = await screen.findByRole('button', { name: 'CPU 7% · 900 MB · 1.6 GB in workspaces' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')

    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Resource usage by workspace' })
    const items = [...panel.querySelectorAll('li')].map((li) => [...li.children].map((c) => c.textContent))
    // Heaviest first; the unknown workspace is left out.
    expect(items).toEqual([
      ['kite-login', '1.5 GB · CPU 13% · 6 processes', 'Agents 1.5 GB', 'claude ×1 (600 MB) · node ×4 (300 MB)'],
      ['docs-pass', '90 MB · CPU 0% · 1 process', 'Terminals 90 MB', 'pwsh ×1 (90 MB)']
    ])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('is just Foreman’s own line while no workspace runs anything', async () => {
    await start(true)
    bridge.invoke.resourceUsage = vi.fn(async () => ({ cpuPercent: 3, memoryMb: 2048, workspaces: [] }))
    render(<ResourceUsage />)
    expect(await screen.findByText('CPU 3% · 2 GB')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('polls every few seconds while on, not at all while the setting is off', async () => {
    await start(true)
    render(<ResourceUsage />)
    await screen.findByRole('button')
    expect(bridge.invoke.resourceUsage).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(RESOURCE_POLL_MS))
    expect(bridge.invoke.resourceUsage).toHaveBeenCalledTimes(2)
    cleanup()

    await start(false)
    const view = render(<ResourceUsage />)
    await act(async () => vi.advanceTimersByTime(RESOURCE_POLL_MS * 3))
    expect(bridge.invoke.resourceUsage).not.toHaveBeenCalled()
    expect(view.container.textContent).toBe('')
  })

  it('stops polling while the window is hidden, and starts again when it is shown', async () => {
    await start(true)
    render(<ResourceUsage />)
    await screen.findByRole('button')
    emit({ type: 'window-visibility', visible: false })
    const calls = bridge.invoke.resourceUsage.mock.calls.length
    await act(async () => vi.advanceTimersByTime(RESOURCE_POLL_MS * 5))
    expect(bridge.invoke.resourceUsage).toHaveBeenCalledTimes(calls)
    emit({ type: 'window-visibility', visible: true })
    expect(bridge.invoke.resourceUsage).toHaveBeenCalledTimes(calls + 1)
  })
})
