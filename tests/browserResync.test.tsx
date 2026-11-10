// @vitest-environment jsdom
// The renderer store when a browser comes back after a drop (docs/server.md, "A browser"): the fresh snapshot applies as
// a `state` event does, keeping what didn't change; the approvals waiting replace the list; loaded chats are read again.
// And what only the computer's window can do is said plainly, not as an error to report.
import './domShims'

const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: () => () => undefined,
    send: { setUnread: vi.fn() },
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke }
})

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiRefused } from '../src/shared/api'
import { clientKind, endTour, flushStore, getState, initStore, loadChat, resyncStore, showError } from '../src/renderer/src/store'

const at = new Date().toISOString()
const workspace = (id: string, name: string) => ({ id, repoId: 'r1', name, branch: name, baseBranch: 'main', path: `/w/${name}`, state: 'ready' })
const snapshot = (workspaces: unknown[]) => ({
  platform: 'win32',
  settings: { language: undefined, agentPrefs: {}, loadouts: [] },
  repos: [],
  repoSettings: {},
  workspaces,
  sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', status: 'idle', queue: [], createdAt: at }],
  catalog: { agents: {} },
  agentKeys: {}
})
const before = snapshot([workspace('w1', 'one'), workspace('w2', 'two')])

beforeAll(async () => {
  bridge.invoke.getSnapshot = vi.fn(async () => before)
  bridge.invoke.pendingApprovals = vi.fn(async () => [{ id: 'a-old', sessionId: 's1', kind: 'tool', toolName: 'Edit', input: {} }])
  bridge.invoke.getChat = vi.fn(async () => [{ kind: 'user', id: 'u1', text: 'before' }])
  await initStore()
})

describe('a browser resyncing the store', () => {
  it('is the window here, with no browser state', () => {
    expect(clientKind).toBe('window')
    expect(getState().client).toBeNull()
  })

  it('applies the fresh snapshot like a state event, replaces the approvals and reads loaded chats again', async () => {
    await loadChat('s1')
    const kept = getState().snapshot!.workspaces[0]
    bridge.invoke.getChat = vi.fn(async () => [{ kind: 'user', id: 'u1', text: 'before' }, { kind: 'assistant', id: 'a1', text: 'missed while away' }])
    resyncStore(snapshot([workspace('w1', 'one'), workspace('w2', 'renamed')]) as never, [{ id: 'a-new', sessionId: 's1', kind: 'plan', plan: 'p' }] as never)
    flushStore()
    const state = getState()
    expect(state.snapshot!.workspaces[1].name).toBe('renamed')
    // Unchanged objects are kept, as for any state event, so only what changed re-renders.
    expect(state.snapshot!.workspaces[0]).toBe(kept)
    expect(state.approvals.map((a) => a.id)).toEqual(['a-new'])
    await vi.waitFor(() => expect(getState().chats.s1?.map((i) => i.id)).toEqual(['u1', 'a1']))
    expect(bridge.invoke.getChat).toHaveBeenCalledWith('s1', true)
  })

  it('keeps the snapshot it has when the resync brings none (a newer state came first), and still takes the approvals', () => {
    const had = getState().snapshot
    resyncStore(null, [])
    flushStore()
    expect(getState().snapshot).toBe(had)
    expect(getState().approvals).toEqual([])
  })

  it('closes the tour quietly when marking it seen is refused, and says any other failure', async () => {
    bridge.invoke.updateSettings = vi.fn(async () => {
      throw new ApiRefused('refused', 'This browser can operate but not change how Foreman is set up.')
    })
    endTour()
    await vi.waitFor(() => expect(bridge.invoke.updateSettings).toHaveBeenCalledWith({ tourSeen: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushStore()
    expect(getState().toast?.text ?? '').not.toContain('not change how Foreman is set up')
    bridge.invoke.updateSettings = vi.fn(async () => {
      throw new Error('Disk full')
    })
    endTour()
    await vi.waitFor(() => {
      flushStore()
      expect(getState().toast).toMatchObject({ text: 'Disk full', kind: 'error' })
    })
  })

  it('shows a refusal for want of the window as information, without the Report link', () => {
    showError(new ApiRefused('unavailable', 'Not available in a browser.'))
    flushStore()
    expect(getState().toast).toMatchObject({ text: 'Not available in a browser.', kind: 'info' })
    expect(getState().toast?.actions).toBeUndefined()
  })
})
