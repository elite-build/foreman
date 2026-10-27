// @vitest-environment jsdom
// The Changes panel reads the diff again when something may have changed it: a tool of one of the workspace's own
// agents that can write files (a second after, once per burst), the agent starting or finishing, and coming back
// to the window, with a slow safety read while an agent works. It no longer asks every five seconds.
import './domShims'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, MainEvent } from '../src/shared/types'
import { fakeApi, fakeState, resetFake } from './rendererStore'

const events = vi.hoisted(() => ({ listeners: new Set<(event: MainEvent) => void>() }))

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const bridge = {
    onEvent: (listener: (event: MainEvent) => void) => {
      events.listeners.add(listener)
      return () => void events.listeners.delete(listener)
    }
  }
  return new Proxy(base, { get: (target, name: string) => (name === 'bridge' ? bridge : target[name]), has: () => true })
})

import { DIFF_SAFETY_POLL_MS, DIFF_SETTLE_MS, useWorkspaceDiff } from '../src/renderer/src/components/WorkspaceView'
import type { DiffScope, WorkspaceDiff } from '../src/shared/types'

function Probe({ running, scope = 'all' }: { running: boolean; scope?: DiffScope }) {
  useWorkspaceDiff('ws1', running, true, scope)
  return null
}

const tool = (name: string, status: 'running' | 'done' | 'error' = 'done'): ChatItem => ({ kind: 'tool', id: `t-${name}-${status}`, turnId: 'turn', name, input: {}, status })
const emit = (sessionId: string, item: ChatItem) => act(() => events.listeners.forEach((l) => l({ type: 'chat-item', sessionId, item })))
const reads = () => fakeApi.getDiff.mock.calls.length
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  resetFake()
  fakeApi.getDiff = vi.fn(async () => ({ baseRef: 'main', scope: 'all', files: [], truncated: false }))
  fakeState.snapshot = { ...fakeState.snapshot, sessions: [{ id: 's1', workspaceId: 'ws1' }, { id: 's2', workspaceId: 'ws2' }] }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  events.listeners.clear()
})

describe('reading the diff again', () => {
  it('reads once when shown, and not on a five-second timer while the agent works', async () => {
    render(<Probe running />)
    await advance(0)
    expect(reads()).toBe(1)
    await advance(5000 * 4)
    expect(reads()).toBe(1)
  })

  it('reads a second after a tool that can change files finishes in one of this workspace’s tabs, once per burst', async () => {
    render(<Probe running />)
    await advance(0)
    emit('s1', tool('Edit'))
    emit('s1', tool('Bash'))
    await advance(DIFF_SETTLE_MS - 1)
    expect(reads()).toBe(1)
    await advance(1)
    expect(reads()).toBe(2)
    // A steady stream of edits still shows about once a second: later ones don't push the read back.
    emit('s1', tool('Write'))
    await advance(DIFF_SETTLE_MS / 2)
    emit('s1', tool('Write', 'error'))
    await advance(DIFF_SETTLE_MS / 2)
    expect(reads()).toBe(3)
  })

  it('ignores reading tools, tools still running, other workspaces’ tabs, and scopes the working tree doesn’t change', async () => {
    const { unmount } = render(<Probe running />)
    await advance(0)
    emit('s1', tool('Read'))
    emit('s1', tool('Grep'))
    emit('s1', tool('Edit', 'running'))
    emit('s2', tool('Edit'))
    await advance(DIFF_SETTLE_MS * 3)
    expect(reads()).toBe(1)
    unmount()
    render(<Probe running scope="commit" />)
    await advance(0)
    emit('s1', tool('Edit'))
    await advance(DIFF_SETTLE_MS * 3)
    expect(reads()).toBe(2)
  })

  it('reads when the agent starts and finishes, on coming back to the window, and every 30 s only while it works', async () => {
    const { rerender } = render(<Probe running={false} />)
    await advance(0)
    expect(reads()).toBe(1)
    await advance(DIFF_SAFETY_POLL_MS * 2)
    expect(reads()).toBe(1)
    rerender(<Probe running />)
    await advance(0)
    expect(reads()).toBe(2)
    await advance(DIFF_SAFETY_POLL_MS)
    expect(reads()).toBe(3)
    rerender(<Probe running={false} />)
    await advance(0)
    expect(reads()).toBe(4)
    act(() => void window.dispatchEvent(new Event('focus')))
    await advance(DIFF_SETTLE_MS)
    expect(reads()).toBe(5)
  })

  it('a change that arrives while a read is under way is read again after it', async () => {
    let finish: () => void = () => undefined
    fakeApi.getDiff = vi.fn(() => new Promise((resolve) => (finish = () => resolve({ baseRef: 'main', scope: 'all', files: [], truncated: false }))))
    render(<Probe running />)
    await advance(0)
    emit('s1', tool('Edit'))
    await advance(DIFF_SETTLE_MS)
    expect(reads()).toBe(1)
    await act(async () => finish())
    await advance(0)
    expect(reads()).toBe(2)
  })
  it('reads the new selection when it changes during a read, and drops what was read for the old one', async () => {
    const reading: { scope: DiffScope; commits?: string[]; resolve: (diff: WorkspaceDiff) => void }[] = []
    fakeApi.getDiff = vi.fn((_ws: string, scope: DiffScope, commits?: string[]) => new Promise<WorkspaceDiff>((resolve) => reading.push({ scope, commits, resolve })))
    const read = (scope: DiffScope, commits?: string[]): WorkspaceDiff => ({ baseRef: 'main', scope, files: [], truncated: false, commits })
    let shown: { diff: WorkspaceDiff | null; loading: boolean } = { diff: null, loading: false }
    function Picked({ scope, commits }: { scope: DiffScope; commits: string[] }) {
      const { diff, loading } = useWorkspaceDiff('ws1', false, true, scope, commits)
      shown = { diff, loading }
      return null
    }
    const { rerender } = render(<Picked scope="picked" commits={['a']} />)
    await advance(0)
    expect(reading).toHaveLength(1)
    // Another pick, then another scope, while the first read is under way: nothing new is read yet.
    rerender(<Picked scope="picked" commits={['b']} />)
    rerender(<Picked scope="commit" commits={['c']} />)
    await advance(0)
    expect(reading).toHaveLength(1)
    await act(async () => reading[0].resolve(read('picked', ['a'])))
    await advance(0)
    // The old selection's diff is never shown under the new one; the latest selection is read next.
    expect(reading.map((r) => [r.scope, r.commits])).toEqual([
      ['picked', ['a']],
      ['commit', ['c']]
    ])
    expect(shown).toEqual({ diff: null, loading: true })
    await act(async () => reading[1].resolve(read('commit', ['c'])))
    await advance(0)
    expect(shown).toEqual({ diff: read('commit', ['c']), loading: false })
    expect(reads()).toBe(2)
  })
})
