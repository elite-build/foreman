import { describe, expect, it, vi } from 'vitest'
import { ApiDispatcher } from '../src/main/api/dispatch'
import { perf } from '../src/main/perf'
import { ApiRefused, computerSession, eventReach, holds, METHOD_SCOPES, sentToView, SIGNAL_SCOPES, WINDOW_SESSION, type ApiSession, type Scope } from '../src/shared/api'
import { hostAccepts, hostForwards, LOCAL_METHODS, LOCAL_SIGNALS, SECRET_METHODS, UNAVAILABLE_REMOTELY } from '../src/shared/remote'
import { API_METHODS, SIGNAL_METHODS, type MainEvent } from '../src/shared/types'

// The contract of docs/server.md: every method and signal placed in a scope, the window scope equal to what paired
// computers were refused before, the stream's view filter, and the dispatcher's refusals.

const phone = (scopes: Scope[]): ApiSession => ({ id: 'p1', kind: 'phone', name: 'iPhone', scopes })

describe('scopes', () => {
  it('places every method and signal, and nothing else', () => {
    // Typecheck covers this through `satisfies`; this catches a cast that slipped past it.
    expect(Object.keys(METHOD_SCOPES).sort()).toEqual([...API_METHODS].sort())
    expect(Object.keys(SIGNAL_SCOPES).sort()).toEqual([...SIGNAL_METHODS].sort())
    for (const m of API_METHODS) expect(['read', 'operate', 'admin', 'window']).toContain(METHOD_SCOPES[m])
  })

  it('makes the window scope exactly what a paired computer was refused before', () => {
    const window = API_METHODS.filter((m) => METHOD_SCOPES[m] === 'window').sort()
    const before = [...new Set<string>([...LOCAL_METHODS, ...UNAVAILABLE_REMOTELY, ...SECRET_METHODS, 'attachFiles'])].sort()
    expect(window).toEqual(before)
    for (const m of API_METHODS) expect([m, hostAccepts(m)]).toEqual([m, !before.includes(m)])
    // The signals kept on this computer's window are the window signals.
    expect(SIGNAL_METHODS.filter((s) => SIGNAL_SCOPES[s] === 'window').sort()).toEqual([...LOCAL_SIGNALS].sort())
  })

  it('keeps what the phone server calls today within operate', () => {
    const phoneCalls = ['attentionHistory', 'getChat', 'sendMessage', 'cancelLimitResume', 'armLimitResume', 'cancel', 'respondApproval', 'getDiff', 'checksStatus', 'runChecks', 'gitStatus', 'createSession', 'archiveWorkspace', 'createWorkspace'] as const
    for (const m of phoneCalls) expect([m, holds(['read', 'operate'], METHOD_SCOPES[m])]).toEqual([m, true])
  })

  it('nests admin over operate over read, and keeps window apart', () => {
    const cases: [Scope[], Record<Scope, boolean>][] = [
      [[], { read: false, operate: false, admin: false, window: false }],
      [['read'], { read: true, operate: false, admin: false, window: false }],
      [['read', 'operate'], { read: true, operate: true, admin: false, window: false }],
      [['operate'], { read: true, operate: true, admin: false, window: false }],
      [['read', 'operate', 'admin'], { read: true, operate: true, admin: true, window: false }],
      [['admin'], { read: true, operate: true, admin: true, window: false }],
      [['window'], { read: false, operate: false, admin: false, window: true }],
      [['read', 'operate', 'admin', 'window'], { read: true, operate: true, admin: true, window: true }]
    ]
    for (const [scopes, expected] of cases) {
      for (const needed of ['read', 'operate', 'admin', 'window'] as const) expect([scopes, needed, holds(scopes, needed)]).toEqual([scopes, needed, expected[needed]])
    }
    expect(WINDOW_SESSION).toMatchObject({ kind: 'window', scopes: ['read', 'operate', 'admin', 'window'] })
    expect(computerSession('d1', 'Desk')).toMatchObject({ kind: 'computer', name: 'Desk', scopes: ['read', 'operate', 'admin'] })
  })
})

describe('sentToView', () => {
  const all = { all: true } as const
  const chat = { sessionId: 's1' }
  const everything: Scope[] = ['read', 'operate', 'admin']

  it('sends state and the other always-events to every session', () => {
    const events: MainEvent[] = [
      { type: 'state', snapshot: {} as never },
      { type: 'approval', request: {} as never },
      { type: 'approval-resolved', id: 'a' },
      { type: 'notify', workspaceId: 'w', sessionId: 's2', title: 't', body: 'b' },
      { type: 'attention-history', events: [] },
      { type: 'archive-progress', workspaceId: 'w', progress: {} as never },
      { type: 'assistant-threads', threads: [] },
      // Keyed on a thread, not a chat: no view can name it, so every session gets it.
      { type: 'assistant-item', threadId: 't', item: {} as never }
    ]
    for (const event of events) for (const view of [all, chat, {}]) expect([event.type, sentToView(event, view, ['read'])]).toEqual([event.type, true])
  })

  it('sends a chat event only to a view of that chat, or of everything', () => {
    const append: MainEvent = { type: 'chat-append', sessionId: 's1', itemId: 'i', from: 0, text: 'hi' }
    expect(sentToView(append, chat, ['read'])).toBe(true)
    expect(sentToView(append, { sessionId: 's2' }, everything)).toBe(false)
    expect(sentToView(append, {}, everything)).toBe(false)
    expect(sentToView(append, { workspaceId: 'w' }, everything)).toBe(false)
    expect(sentToView(append, all, ['read'])).toBe(true)
    expect(sentToView({ type: 'chat-item', sessionId: 's1', item: {} as never }, chat, ['read'])).toBe(true)
    expect(sentToView({ type: 'chat-reset', sessionId: 's2', items: [] }, chat, ['read'])).toBe(false)
  })

  it('sends terminal output and logs only to a view of everything that can operate', () => {
    const data: MainEvent = { type: 'pty-data', ptyId: 'p', data: 'x' }
    expect(sentToView(data, all, ['read', 'operate'])).toBe(true)
    expect(sentToView(data, all, ['read'])).toBe(false)
    expect(sentToView(data, chat, everything)).toBe(false)
    expect(sentToView({ type: 'setup-log', workspaceId: 'w', chunk: 'x' }, { workspaceId: 'w' }, everything)).toBe(false)
    expect(sentToView({ type: 'clone-progress', cloneId: 'c', line: 'x' }, all, ['admin'])).toBe(true)
  })

  it('never sends a window event, and agrees with what a host forwards', () => {
    expect(sentToView({ type: 'browser-open', workspaceId: 'w', url: 'https://example.com' }, all, WINDOW_SESSION.scopes)).toBe(false)
    expect(sentToView({ type: 'tour' }, all, WINDOW_SESSION.scopes)).toBe(false)
    expect(sentToView({ type: 'computers', view: {} as never }, all, WINDOW_SESSION.scopes)).toBe(false)
    const types: MainEvent['type'][] = [
      'browser-open', 'browser-state', 'browser-shortcut', 'state', 'chat-item', 'chat-append', 'chat-reset', 'approval', 'approval-resolved',
      'setup-log', 'cloud-build-log', 'pty-data', 'pty-exit', 'pty-state', 'notify', 'auto-run', 'clone-progress', 'show-workspace',
      'show-setting', 'report-problem', 'tour', 'launch-folders', 'quit-requested', 'open-link', 'navigate', 'attention-history',
      'archive-progress', 'assistant-item', 'assistant-threads', 'stt-partial', 'stt-error', 'stt-model', 'window-visibility', 'computers',
      'computer-notify', 'computer-left'
    ]
    for (const type of types) expect([type, eventReach(type) === 'window']).toEqual([type, !hostForwards({ type } as MainEvent)])
  })
})

describe('ApiDispatcher', () => {
  const make = () => {
    const calls: { method: string; args: unknown[] }[] = []
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(`${method}:ok`)
    }
    const api = Object.fromEntries(['pickDirectory', 'sendMessage', 'getChat', 'archiveWorkspace', 'revealEnvVar', 'updateSettings'].map((m) => [m, record(m)]))
    const signals = Object.fromEntries(['ptyWrite', 'setUnread'].map((m) => [m, (...args: unknown[]) => void calls.push({ method: m, args })]))
    return { calls, dispatcher: new ApiDispatcher({ api, signals }) }
  }

  it('lets the window call a window method, timed as ipc', async () => {
    const { calls, dispatcher } = make()
    const timed = vi.spyOn(perf, 'timed')
    try {
      await expect(dispatcher.invoke(WINDOW_SESSION, 'pickDirectory', [])).resolves.toBe('pickDirectory:ok')
      expect(timed).toHaveBeenCalledWith('ipc.pickDirectory', expect.any(Function))
    } finally {
      timed.mockRestore()
    }
    expect(calls).toEqual([{ method: 'pickDirectory', args: [] }])
  })

  it('refuses a watching phone what it may not do, and the window scope to any phone', async () => {
    const { calls, dispatcher } = make()
    const watch = phone(['read'])
    await expect(dispatcher.invoke(watch, 'getChat', ['s1'])).resolves.toBe('getChat:ok')
    const refused = dispatcher.invoke(watch, 'sendMessage', ['s1', 'hi'])
    await expect(refused).rejects.toBeInstanceOf(ApiRefused)
    await expect(refused).rejects.toMatchObject({ code: 'refused', message: 'This phone can watch but not operate. Approve it again with more access.' })
    await expect(dispatcher.invoke(phone(['read', 'operate']), 'updateSettings', [{}])).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('can operate but not change how Foreman is set up') })
    await expect(dispatcher.invoke(phone(['read']), 'pickDirectory', [])).rejects.toMatchObject({ code: 'unavailable' })
    await expect(dispatcher.invoke(phone(['read', 'operate', 'admin']), 'pickDirectory', [])).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls.map((c) => c.method)).toEqual(['getChat'])
  })

  it('throws on a method the Api does not have', async () => {
    const { dispatcher } = make()
    await expect(dispatcher.invoke(WINDOW_SESSION, 'notAMethod', [])).rejects.toThrow('Unknown API method')
    await expect(dispatcher.invoke(WINDOW_SESSION, 'toString', [])).rejects.toThrow('Unknown API method')
    // In the Api, but not in this core.
    await expect(dispatcher.invoke(WINDOW_SESSION, 'gitStatus', ['w'])).rejects.toThrow('Unknown method gitStatus')
  })

  it('lets a paired computer archive a workspace but not read a secret back, timed as remote', async () => {
    const { calls, dispatcher } = make()
    const timed = vi.spyOn(perf, 'timed')
    const desk = computerSession('d1', 'Desk')
    try {
      await expect(dispatcher.invoke(desk, 'archiveWorkspace', ['w', false])).resolves.toBe('archiveWorkspace:ok')
      expect(timed).toHaveBeenCalledWith('remote.archiveWorkspace', expect.any(Function))
    } finally {
      timed.mockRestore()
    }
    await expect(dispatcher.invoke(desk, 'revealEnvVar', [{ kind: 'global' }, 'KEY'])).rejects.toMatchObject({ code: 'unavailable', message: 'That needs the computer’s own window.' })
    expect(calls).toEqual([{ method: 'archiveWorkspace', args: ['w', false] }])
  })

  it('tells a session without admin who is paired but no pairing link or code, and leaves the window untimed when asked', async () => {
    const mobile = { devices: [{ id: 'd1' }], pairing: { mode: 'lan', url: 'http://x/?pair=SECRET', qr: 'data:', expiresAt: 1 }, pending: { id: 'p', code: '123456' } }
    const devices = { paired: [{ id: 'c1' }], pairing: { code: '654321', expiresAt: '' } }
    const timed = vi.spyOn(perf, 'timed')
    const dispatcher = new ApiDispatcher({ api: { mobileInfo: async () => mobile, devicesInfo: async () => devices }, signals: {}, perfPrefix: (s) => (s.kind === 'window' ? null : 'ws') })
    try {
      for (const scopes of [['read'], ['read', 'operate']] as Scope[][]) {
        expect(await dispatcher.invoke(phone(scopes), 'mobileInfo', [])).toEqual({ devices: [{ id: 'd1' }] })
        expect(await dispatcher.invoke(phone(scopes), 'devicesInfo', [])).toEqual({ paired: [{ id: 'c1' }] })
      }
      expect(await dispatcher.invoke(phone(['read', 'operate', 'admin']), 'mobileInfo', [])).toEqual(mobile)
      expect(await dispatcher.invoke(computerSession('c1', 'Desk'), 'devicesInfo', [])).toEqual(devices)
      expect(timed.mock.calls.map((c) => c[0])).toEqual(['ws.mobileInfo', 'ws.devicesInfo', 'ws.mobileInfo', 'ws.devicesInfo', 'ws.mobileInfo', 'ws.devicesInfo'])
      // The window's IPC handler times its own calls, so its dispatcher doesn't.
      expect(await dispatcher.invoke(WINDOW_SESSION, 'mobileInfo', [])).toEqual(mobile)
      expect(timed).toHaveBeenCalledTimes(6)
    } finally {
      timed.mockRestore()
    }
    // What the core returned is left as it was.
    expect(mobile.pending.code).toBe('123456')
  })

  it('drops signals that are unknown or out of scope, without a word', () => {
    const { calls, dispatcher } = make()
    dispatcher.signal(WINDOW_SESSION, 'ptyWrite', ['p', 'a'])
    dispatcher.signal(WINDOW_SESSION, 'setUnread', [[], []])
    dispatcher.signal(computerSession('d1', 'Desk'), 'setUnread', [[], []])
    dispatcher.signal(phone(['read']), 'ptyWrite', ['p', 'b'])
    dispatcher.signal(WINDOW_SESSION, 'notASignal', [])
    expect(calls).toEqual([{ method: 'ptyWrite', args: ['p', 'a'] }, { method: 'setUnread', args: [[], []] }])
  })
})
