// @vitest-environment jsdom
// State snapshots from main arrive as whole new copies. The store keeps the objects of whatever didn't change, so a
// component reading one workspace or session re-renders only when that one changed, and an identical snapshot
// notifies nobody.
import './domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`.
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

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushStore, getState, initStore, useStore } from '../src/renderer/src/store'

const at = new Date().toISOString()
const snapshot = (status: Record<string, string> = {}) => ({
  platform: 'win32',
  settings: { language: undefined, agentPrefs: {}, loadouts: [] },
  repos: [{ id: 'r1', name: 'repo', rootPath: '/r' }],
  repoSettings: {},
  workspaces: [
    { id: 'w1', repoId: 'r1', name: 'one', branch: 'one', baseBranch: 'main', path: '/w/one', state: 'ready' },
    { id: 'w2', repoId: 'r1', name: 'two', branch: 'two', baseBranch: 'main', path: '/w/two', state: 'ready' }
  ],
  sessions: ['s1', 's2'].map((id, i) => ({ id, workspaceId: `w${i + 1}`, agent: 'claude', model: 'm', status: status[id] ?? 'idle', queue: [], createdAt: at })),
  comments: [{ id: 'c1', workspaceId: 'w1', file: 'a.ts', line: 1, body: 'hi' }],
  catalog: { agents: {} },
  agentKeys: {}
})
const emit = (event: unknown) => bridge.events.handler!(event)

const renders: Record<string, number> = {}
function SessionStatus({ id }: { id: string }) {
  const session = useStore((s) => s.snapshot?.sessions.find((x) => x.id === id))
  renders[id] = (renders[id] ?? 0) + 1
  return <p data-testid={id}>{session?.status}</p>
}

beforeEach(async () => {
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot())
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  await initStore()
  for (const key of Object.keys(renders)) delete renders[key]
})
afterEach(() => {
  cleanup()
  flushStore()
})

describe('state snapshots share what did not change', () => {
  it('an identical snapshot keeps the store as it is and notifies nobody', () => {
    const before = getState()
    const listener = vi.fn()
    function Probe() {
      useStore((s) => (listener(), s.snapshot))
      return null
    }
    render(<Probe />)
    listener.mockClear()
    emit({ type: 'state', snapshot: snapshot() })
    flushStore()
    expect(getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('a changed session is a new object; its sibling, the workspaces, comments and settings keep theirs', () => {
    const prev = getState().snapshot!
    emit({ type: 'state', snapshot: snapshot({ s1: 'running' }) })
    const next = getState().snapshot!
    expect(next).not.toBe(prev)
    expect(next.sessions[0]).not.toBe(prev.sessions[0])
    expect(next.sessions[0].status).toBe('running')
    expect(next.sessions[1]).toBe(prev.sessions[1])
    expect(next.workspaces).toBe(prev.workspaces)
    expect(next.comments).toBe(prev.comments)
    expect(next.settings).toBe(prev.settings)
    expect(next.repos).toBe(prev.repos)
  })

  it('only the component reading the changed session re-renders', () => {
    const view = render(
      <>
        <SessionStatus id="s1" />
        <SessionStatus id="s2" />
      </>
    )
    expect(renders).toEqual({ s1: 1, s2: 1 })
    act(() => {
      emit({ type: 'state', snapshot: snapshot({ s1: 'running' }) })
      flushStore()
    })
    expect(view.getByTestId('s1').textContent).toBe('running')
    expect(renders).toEqual({ s1: 2, s2: 1 })
    // The same again: nobody re-renders.
    act(() => {
      emit({ type: 'state', snapshot: snapshot({ s1: 'running' }) })
      flushStore()
    })
    expect(renders).toEqual({ s1: 2, s2: 1 })
  })

  it('a removed workspace leaves the remaining one as it was', () => {
    const prev = getState().snapshot!
    const next = snapshot()
    next.workspaces = next.workspaces.filter((w) => w.id !== 'w1')
    emit({ type: 'state', snapshot: next })
    const out = getState().snapshot!
    expect(out.workspaces.map((w) => w.id)).toEqual(['w2'])
    expect(out.workspaces[0]).toBe(prev.workspaces[1])
  })
})
