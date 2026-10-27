// @vitest-environment jsdom
// A minimized or hidden window re-renders nothing (store.ts, `held`), yet an agent that finishes or needs you meanwhile
// still gets its sound cue and its words, once, as it happens; showing the window again plays nothing stale. While the
// window is shown, the cues come with the render as before.
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

vi.mock('../src/renderer/src/sound', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/renderer/src/sound')>()), playEventEarcon: vi.fn() }))
vi.mock('../src/renderer/src/announce', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/renderer/src/announce')>()), announce: vi.fn() }))

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce } from '../src/renderer/src/announce'
import { Announcer } from '../src/renderer/src/components/Announcer'
import { playEventEarcon } from '../src/renderer/src/sound'
import { flushStore, initStore } from '../src/renderer/src/store'

const at = new Date().toISOString()
const running = { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', status: 'running', queue: [], createdAt: at }
const finished = { ...running, status: 'idle', lastTurn: { outcome: 'completed' } }
const snapshot = (session: object) => ({
  platform: 'win32',
  settings: { language: 'en', agentPrefs: {}, loadouts: [], sound: 'chime', earcons: true, announce: 'all' },
  repos: [],
  repoSettings: {},
  workspaces: [{ id: 'w1', repoId: 'r1', name: 'one', branch: 'one', baseBranch: 'main', path: '/w/one', state: 'ready' }],
  sessions: [session],
  catalog: { agents: {} },
  agentKeys: {}
})
const emit = (event: unknown) => act(() => bridge.events.handler!(event))
const visibility = (visible: boolean) => emit({ type: 'window-visibility', visible })
const state = (session: object) => emit({ type: 'state', snapshot: snapshot(session) })

const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const runFrame = () =>
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const frame of due) frame(performance.now())
  })

const cues = () => vi.mocked(playEventEarcon).mock.calls.map(([, cue]) => cue)
const said = () => vi.mocked(announce).mock.calls

beforeEach(async () => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++frameId, cb), frameId))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot(running))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  await initStore()
  render(<Announcer />)
  vi.mocked(playEventEarcon).mockClear()
  vi.mocked(announce).mockClear()
})
afterEach(() => {
  cleanup()
  bridge.events.handler?.({ type: 'window-visibility', visible: true })
  flushStore()
  vi.unstubAllGlobals()
})

describe('agent status cues', () => {
  it('play and are said once while the window is hidden, and not again when it is shown', async () => {
    visibility(false)
    state(finished)
    expect(cues()).toEqual(['finished'])
    expect(said()).toEqual([['Claude Code finished', 'status:s1']])
    // More changes that don't touch the chat's status say nothing more; nor does a frame, or showing the window.
    state({ ...finished, title: 'Renamed' })
    await runFrame()
    visibility(true)
    await runFrame()
    expect(cues()).toEqual(['finished'])
    expect(said()).toHaveLength(1)
  })

  it('catch a turn that starts and ends, and a request that comes and goes, all while hidden', () => {
    state(finished)
    act(() => flushStore())
    vi.mocked(playEventEarcon).mockClear()
    visibility(false)
    state(running)
    emit({ type: 'approval', request: { id: 'a1', sessionId: 's1', kind: 'tool' } })
    emit({ type: 'approval-resolved', id: 'a1' })
    state(finished)
    expect(cues()).toEqual(['started', 'needs-me', 'finished'])
    visibility(true)
    expect(cues()).toEqual(['started', 'needs-me', 'finished'])
  })

  it('come with the render while the window is shown, once', async () => {
    state(finished)
    // Events from main are told to components on the next frame; the cue comes with that render, as before.
    expect(cues()).toEqual([])
    await runFrame()
    expect(cues()).toEqual(['finished'])
    expect(said()).toEqual([['Claude Code finished', 'status:s1']])
    await runFrame()
    expect(cues()).toEqual(['finished'])
  })
})
