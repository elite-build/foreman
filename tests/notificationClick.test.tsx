// @vitest-environment jsdom
// A click on one of the window's notifications brings Foreman forward. The page's own focus() can't on Windows (it
// neither restores a minimized window nor raises it over other apps), so the click asks main to show the window, then
// goes where the notification points.
import './domShims'

const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const listeners: ((event: unknown) => void)[] = []
  const send = { setUnread: vi.fn(), showWindow: vi.fn() }
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => undefined
    },
    send,
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke, listeners, send }
})

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushStore, getState, initStore } from '../src/renderer/src/store'

const shown: { title: string; onclick: (() => void) | null }[] = []
class FakeNotification {
  onclick: (() => void) | null = null
  constructor(public title: string) {
    shown.push(this)
  }
}

const at = new Date().toISOString()
const workspace = (id: string, name: string) => ({ id, repoId: 'r1', name, branch: name, baseBranch: 'main', path: `/w/${name}`, state: 'ready' })

beforeAll(async () => {
  vi.stubGlobal('Notification', FakeNotification)
  bridge.invoke.getSnapshot = vi.fn(async () => ({
    platform: 'win32',
    settings: { language: undefined, agentPrefs: {}, loadouts: [], notifications: true, sound: 'none', earcons: false },
    repos: [],
    repoSettings: {},
    workspaces: [workspace('w1', 'one'), workspace('w2', 'two')],
    sessions: [{ id: 's2', workspaceId: 'w2', agent: 'claude', model: 'm', status: 'idle', queue: [], createdAt: at }],
    catalog: { agents: {} },
    agentKeys: {},
    projects: { acme: [{ id: 'p1', orgId: 'acme', slug: 'new-sidebar', waits: [], steps: [] }] }
  }))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  await initStore()
})

afterEach(() => {
  shown.length = 0
  bridge.send.showWindow.mockClear()
})

const emit = (event: unknown) => {
  for (const listener of bridge.listeners) listener(event)
  flushStore()
}

describe('clicking a notification', () => {
  it('asks main to show the window, then opens the chat it is about', () => {
    emit({ type: 'notify', workspaceId: 'w2', sessionId: 's2', title: 'two', body: 'Done', kind: 'info' })
    expect(shown).toHaveLength(1)
    expect(bridge.send.showWindow).not.toHaveBeenCalled()
    shown[0].onclick?.()
    flushStore()
    expect(bridge.send.showWindow).toHaveBeenCalledTimes(1)
    expect(getState().selectedWorkspaceId).toBe('w2')
  })

  it('opens the channel of what a project waits on (docs/ai-employees.md §15)', () => {
    emit({ type: 'notify', workspaceId: '', sessionId: '', title: '#new-sidebar', body: 'Priya has questions for you', kind: 'attention', project: { orgId: 'acme', id: 'p1' } })
    expect(shown).toHaveLength(1)
    shown[0].onclick?.()
    flushStore()
    expect(bridge.send.showWindow).toHaveBeenCalledTimes(1)
    expect(getState().employeesView).toEqual({ orgId: 'acme', page: 'project', id: 'p1' })
    // Its channel on screen: nothing more is shown for it.
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    emit({ type: 'notify', workspaceId: '', sessionId: '', title: '#new-sidebar', body: 'The plan waits', kind: 'attention', project: { orgId: 'acme', id: 'p1' } })
    expect(shown).toHaveLength(1)
    focus.mockRestore()
  })

  it('opens a project’s channel from the tray, and Home for one that is gone', () => {
    emit({ type: 'navigate', project: { orgId: 'acme', id: 'p1' } })
    expect(getState().employeesView).toEqual({ orgId: 'acme', page: 'project', id: 'p1' })
    emit({ type: 'navigate', project: { orgId: 'acme', id: 'gone' } })
    expect(getState().employeesView).toBeNull()
    expect(getState().selectedWorkspaceId).toBeNull()
  })

  it('shows the window for a notice from another computer too', () => {
    emit({ type: 'computer-notify', computerId: 'c1', computerName: 'Laptop', workspaceId: 'w1', sessionId: '', title: 'one', body: 'Needs you' })
    expect(shown).toHaveLength(1)
    shown[0].onclick?.()
    expect(bridge.send.showWindow).toHaveBeenCalledTimes(1)
  })
})
