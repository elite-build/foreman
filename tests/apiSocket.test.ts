import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { ApiDispatcher } from '../src/main/api/dispatch'
import { ApiSocketServer, COALESCE_BYTES, DRAIN_MS, DROP_BYTES, HELLO_MS, MAX_INBOUND_BYTES, PING_MS } from '../src/main/api/socket'
import { perf } from '../src/main/perf'
import { API_PROTOCOL, type ApiSession, type Scope } from '../src/shared/api'
import type { MainEvent } from '../src/shared/types'

// The phone and browser socket of docs/server.md on a real `ws` pair over loopback: the hello, calls through the
// dispatcher with the session's scopes, the view filter, backpressure, pings and the goodbyes. Timers are injected, so
// nothing here waits for 5 or 20 seconds; what is queued for a socket is injected too, as loopback drains too fast to fill.

type Frame = Record<string, unknown> & { t: string }
type FakeTimer = { fn: () => void; ms: number; cancelled: boolean }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const session = (id: string, scopes: Scope[]): ApiSession => ({ id, kind: 'phone', name: `Phone ${id}`, scopes })

async function harness() {
  const listeners = new Set<(event: MainEvent) => void>()
  const emit = (event: MainEvent) => { for (const l of listeners) l(event) }
  const api = {
    getSnapshot: vi.fn(async () => ({ workspaces: [] })),
    sendMessage: vi.fn(async () => 'queued'),
    cancel: vi.fn(async () => undefined),
    pickDirectory: vi.fn(async () => null),
    gitStatus: vi.fn(async () => { throw new Error('No such workspace') }),
    getDiff: vi.fn(async () => 'x'.repeat(17 * 1024 * 1024))
  }
  const signals = { ptyWrite: vi.fn() }
  const timers: FakeTimer[] = []
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return { cancel: () => { t.cancelled = true } }
  }
  /** Runs every pending timer of that length, as if it came due. */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) {
      t.cancelled = true
      t.fn()
    }
  }
  let queued = 0
  const server = new ApiSocketServer({
    dispatcher: new ApiDispatcher({ api, signals }),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    version: '1.2.3',
    platform: 'test',
    name: () => 'Desk',
    setTimer,
    buffered: () => queued
  })
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES })
  // The test names the session in the URL; mobile.ts takes it from the device's credential.
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const scopes = (url.searchParams.get('scopes') ?? 'read,operate').split(',') as Scope[]
    wss.handleUpgrade(req, socket, head, (ws) => server.attach(ws, session(url.searchParams.get('id') ?? 'p1', scopes)))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close('shutdown')
    http.closeAllConnections()
    http.close(() => resolve())
  }))

  const connect = async (query = '', options: { autoPong?: boolean } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws${query}`, options)
    const frames: Frame[] = []
    const waiters: ((frame: Frame) => void)[] = []
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else frames.push(frame)
    })
    ws.on('error', () => undefined)
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    cleanups.push(() => ws.terminate())
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = {
      ws,
      closed,
      send: (frame: unknown) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
      next: () => new Promise<Frame>((resolve) => {
        const frame = frames.shift()
        if (frame) resolve(frame)
        else waiters.push(resolve)
      }),
      /** Sends a JSON ping and returns every frame that came before its pong: what the server sent up to now. */
      drain: async () => {
        client.send({ t: 'ping' })
        const before: Frame[] = []
        for (let f = await client.next(); f.t !== 'pong'; f = await client.next()) before.push(f)
        return before
      },
      hello: async (extra: Record<string, unknown> = {}) => {
        client.send({ t: 'hello', protocol: API_PROTOCOL, version: '1.2.3', client: { kind: 'phone', name: 'iPhone' }, ...extra })
        return client.next()
      },
      call: async (id: number, method: string, args: unknown[] = []) => {
        client.send({ t: 'call', id, method, args })
        return client.next()
      }
    }
    return client
  }

  return { server, api, signals, emit, fire, connect, listeners, setQueued: (n: number) => { queued = n } }
}

const append = (sessionId: string): MainEvent => ({ type: 'chat-append', sessionId, itemId: 'i', from: 0, text: 'hi' })
const state = (n: number): MainEvent => ({ type: 'state', snapshot: { n } as never })
const types = (frames: Frame[]) => frames.map((f) => (f.t === 'event' ? `${(f.event as MainEvent).type}${'sessionId' in (f.event as object) ? `:${(f.event as { sessionId: string }).sessionId}` : ''}` : f.t))

describe('the hello', () => {
  it('welcomes a client with its session, the server and the last broadcast number, whatever its app version', async () => {
    const h = await harness()
    h.emit(state(1))
    h.emit(state(2))
    const client = await h.connect('?id=p9&scopes=read')
    expect(h.server.connections).toBe(1)
    expect(await client.hello({ version: '0.0.1' })).toEqual({
      t: 'welcome', ok: true, session: { id: 'p9', kind: 'phone', name: 'Phone p9', scopes: ['read'] }, version: '1.2.3', platform: 'test', name: 'Desk', seq: 2
    })
    // Events after it carry the next numbers.
    h.emit(state(3))
    expect(await client.next()).toMatchObject({ t: 'event', seq: 3, event: { type: 'state' } })
  })

  it('refuses another protocol and closes', async () => {
    const h = await harness()
    const client = await h.connect()
    expect(await client.hello({ protocol: API_PROTOCOL + 1 })).toEqual({ t: 'welcome', ok: false, refused: 'protocol' })
    expect(await client.closed).toBe(1002)
  })

  it('closes a socket that sends no hello in time, or something else first', async () => {
    const h = await harness()
    const silent = await h.connect()
    h.fire(HELLO_MS)
    expect(await silent.closed).toBe(1002)
    const rude = await h.connect()
    rude.send({ t: 'call', id: 1, method: 'getSnapshot', args: [] })
    expect(await rude.closed).toBe(1002)
    expect(h.api.getSnapshot).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(h.server.connections).toBe(0))
  })

  it('counts each connection', async () => {
    const count = vi.spyOn(perf, 'count')
    const h = await harness()
    await h.connect()
    expect(count).toHaveBeenCalledWith('ws.connect')
  })
})

describe('calls and signals', () => {
  it('replies with the value, null for nothing, and the dispatcher’s refusals with their codes', async () => {
    const h = await harness()
    const operator = await h.connect('?scopes=read,operate')
    await operator.hello()
    expect(await operator.call(1, 'getSnapshot')).toEqual({ t: 'reply', id: 1, ok: true, value: { workspaces: [] } })
    expect(await operator.call(2, 'cancel', ['s1'])).toEqual({ t: 'reply', id: 2, ok: true, value: null })
    expect(h.api.cancel).toHaveBeenCalledWith('s1')
    // The computer's own window only.
    expect(await operator.call(3, 'pickDirectory')).toMatchObject({ t: 'reply', id: 3, ok: false, code: 'unavailable' })
    expect(h.api.pickDirectory).not.toHaveBeenCalled()
    expect(await operator.call(4, 'notAMethod')).toEqual({ t: 'reply', id: 4, ok: false, error: 'Unknown API method', code: 'failed' })
    expect(await operator.call(5, 'gitStatus', ['w'])).toEqual({ t: 'reply', id: 5, ok: false, error: 'No such workspace', code: 'failed' })

    const watcher = await h.connect('?id=p2&scopes=read')
    await watcher.hello()
    const refused = await watcher.call(1, 'sendMessage', ['s1', 'hi'])
    expect(refused).toMatchObject({ t: 'reply', id: 1, ok: false, code: 'refused' })
    expect(refused.error).toMatch(/This phone can watch but not operate/)
    expect(h.api.sendMessage).not.toHaveBeenCalled()
  })

  it('replaces a reply over 16 MB with an error', async () => {
    const h = await harness()
    const client = await h.connect()
    await client.hello()
    expect(await client.call(1, 'getDiff', ['w', 'all'])).toEqual({ t: 'reply', id: 1, ok: false, error: 'That answer is too large to send.', code: 'failed' })
  })

  it('passes signals the session may send, and drops the rest', async () => {
    const h = await harness()
    const watcher = await h.connect('?id=p2&scopes=read')
    await watcher.hello()
    watcher.send({ t: 'signal', method: 'ptyWrite', args: ['t1', 'ls\n'] })
    await watcher.drain()
    expect(h.signals.ptyWrite).not.toHaveBeenCalled()
    const operator = await h.connect('?scopes=read,operate')
    await operator.hello()
    operator.send({ t: 'signal', method: 'ptyWrite', args: ['t1', 'ls\n'] })
    await operator.drain()
    expect(h.signals.ptyWrite).toHaveBeenCalledWith('t1', 'ls\n')
  })

  it('closes a socket that sends a frame over 1 MB', async () => {
    const h = await harness()
    const client = await h.connect()
    await client.hello()
    client.send(JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_INBOUND_BYTES) }))
    expect(await client.closed).toBe(1009)
  })
})

describe('the view', () => {
  it('sends always-events to everyone, a chat’s events to its viewers, terminals to operators viewing all, and window events never', async () => {
    const h = await harness()
    const watcher = await h.connect('?id=p2&scopes=read')
    await watcher.hello({ view: { sessionId: 's1' } })
    const operator = await h.connect('?id=p3&scopes=read,operate')
    await operator.hello()
    const pty: MainEvent = { type: 'pty-data', ptyId: 't1', data: 'out' }
    const round = () => {
      h.emit(append('s2'))
      h.emit(append('s1'))
      h.emit(pty)
      h.emit({ type: 'browser-open', workspaceId: 'w', url: 'https://example.test' })
      h.emit(state(1))
    }
    round()
    expect(types(await watcher.drain())).toEqual(['chat-append:s1', 'state'])
    // No view yet: nothing per chat.
    expect(types(await operator.drain())).toEqual(['state'])

    // A watcher may view everything, and gets every chat, but still no terminal output.
    watcher.send({ t: 'view', view: { all: true } })
    operator.send({ t: 'view', view: { all: true } })
    // A round trip each, so the server has read the views before the events go out.
    await watcher.drain()
    await operator.drain()
    round()
    expect(types(await watcher.drain())).toEqual(['chat-append:s2', 'chat-append:s1', 'state'])
    expect(types(await operator.drain())).toEqual(['chat-append:s2', 'chat-append:s1', 'pty-data', 'state'])

    // Something that is not a view leaves the view as it was.
    operator.send({ t: 'view', view: { sessionId: 7 } })
    await operator.drain()
    h.emit(pty)
    expect(types(await operator.drain())).toEqual(['pty-data'])
  })

  it('answers a JSON ping with a pong', async () => {
    const h = await harness()
    const client = await h.connect()
    await client.hello()
    client.send({ t: 'ping' })
    expect(await client.next()).toEqual({ t: 'pong' })
  })
})

describe('backpressure', () => {
  it('pins the budgets', () => {
    expect(COALESCE_BYTES).toBe(4 * 1024 * 1024)
    expect(DROP_BYTES).toBe(16 * 1024 * 1024)
  })

  it('keeps only the newest state and drops streamed text and terminal output while the buffer is full, then catches up', async () => {
    const count = vi.spyOn(perf, 'count')
    const h = await harness()
    const client = await h.connect()
    const welcome = await client.hello({ view: { all: true } })
    const seq = welcome.seq as number
    h.setQueued(COALESCE_BYTES + 1)
    h.emit(state(1))
    h.emit(state(2))
    h.emit({ type: 'pty-data', ptyId: 't1', data: 'out' })
    h.emit(append('s1'))
    h.emit({ type: 'chat-item', sessionId: 's1', item: { id: 'i' } as never })
    // Only the chat item went; the state waits.
    expect(types(await client.drain())).toEqual(['chat-item:s1'])
    expect(count.mock.calls.filter(([name]) => name === 'ws.dropped')).toHaveLength(3)
    // Still full: still waiting.
    h.fire(DRAIN_MS)
    expect(await client.drain()).toEqual([])
    h.setQueued(0)
    h.fire(DRAIN_MS)
    const caught = await client.drain()
    expect(caught).toEqual([{ t: 'event', seq: seq + 2, event: { type: 'state', snapshot: { n: 2 } } }])
    h.emit(append('s1'))
    expect(types(await client.drain())).toEqual(['chat-append:s1'])
  })

  it('says bye slow and closes a connection over the hard limit', async () => {
    const count = vi.spyOn(perf, 'count')
    const h = await harness()
    const client = await h.connect()
    await client.hello()
    h.setQueued(DROP_BYTES + 1)
    h.emit(state(1))
    expect(await client.next()).toEqual({ t: 'bye', reason: 'slow' })
    expect(await client.closed).toBe(1013)
    expect(count).toHaveBeenCalledWith('ws.slow')
  })
})

describe('pings and goodbyes', () => {
  it('pings every interval and closes after two unanswered', async () => {
    const h = await harness()
    const answering = await h.connect('?id=a')
    await answering.hello()
    const silent = await h.connect('?id=b', { autoPong: false })
    await silent.hello()
    let pinged = 0
    silent.ws.on('ping', () => pinged++)
    for (let i = 0; i < 2; i++) {
      const ping = new Promise((resolve) => answering.ws.once('ping', resolve))
      h.fire(PING_MS)
      await ping
      // The pong went before this ping's frame, so the server has it by the pong to it.
      await answering.drain()
    }
    await vi.waitFor(() => expect(pinged).toBe(2))
    h.fire(PING_MS)
    expect(await silent.closed).toBe(1006)
    // The one that answered is still here.
    await answering.drain()
    expect(h.server.connections).toBe(1)
  })

  it('says bye revoked to a revoked session’s connections only', async () => {
    const h = await harness()
    const revoked = await h.connect('?id=gone')
    await revoked.hello()
    const other = await h.connect('?id=kept')
    await other.hello()
    h.server.closeSession('gone', 'revoked')
    expect(await revoked.next()).toEqual({ t: 'bye', reason: 'revoked' })
    expect(await revoked.closed).toBe(1000)
    expect(await other.drain()).toEqual([])
  })

  it('says bye shutdown to everyone and stops listening on quit', async () => {
    const h = await harness()
    const a = await h.connect('?id=a')
    await a.hello()
    const b = await h.connect('?id=b')
    h.server.close('shutdown')
    expect(await a.next()).toEqual({ t: 'bye', reason: 'shutdown' })
    expect(await b.next()).toEqual({ t: 'bye', reason: 'shutdown' })
    expect(await a.closed).toBe(1000)
    expect(await b.closed).toBe(1000)
    expect(h.listeners.size).toBe(0)
  })
})
