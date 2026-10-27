// Streaming previews as appends: after a block's first preview only its new text goes out, so the bytes sent over a
// long message grow with its length, not its square. A listener that misses an append is put right by the next whole
// preview or the finished item, and listeners that need whole items (the agent host's app side, plain `item`) get them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { CodexEventMapper } from '../src/main/agents/codex'
import { PreviewThrottle } from '../src/main/agents/previewThrottle'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentDriver, TurnCallbacks } from '../src/main/agents/types'
import { HostClient } from '../src/main/agentHost/client'
import { HostServer } from '../src/main/agentHost/server'
import { appendToItems, PreviewDecoder, PreviewEncoder, RESYNC_MS, type ChatAppend } from '../src/shared/chatAppend'
import type { ChatItem } from '../src/shared/types'
import { fakeRequest } from './agentHostFake'
import { tempDir } from './helpers'
import { fakeDriver, setupSessions } from './sessionHarness'

const preview = (text: string, id = 'a1'): ChatItem => ({ kind: 'assistant', id, turnId: 't1', text, streaming: true })
const final = (text: string, id = 'a1'): ChatItem => ({ kind: 'assistant', id, turnId: 't1', text })
// A long answer streamed in 50-character steps, as a driver's 50 ms flushes send it.
const LONG = Array.from({ length: 400 }, (_, i) => `word${i} `.padEnd(50, '.')).join('')
const steps = (text: string, size = 50) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(0, (i + 1) * size))
const bytes = (value: unknown) => JSON.stringify(value).length

afterEach(() => {
  registerDriver(claudeDriver)
  vi.useRealTimers()
})

describe('PreviewEncoder', () => {
  it('sends a long preview whole once, then appends whose bytes add up to about its length', () => {
    const encoder = new PreviewEncoder(() => 0)
    const out = steps(LONG).map((text) => encoder.encode(preview(text), true))
    expect(out[0]).toEqual({ item: preview(LONG.slice(0, 50)) })
    const appends = out.slice(1).map((o) => (o && 'append' in o ? o.append : null))
    expect(appends.every(Boolean)).toBe(true)
    expect(appends.map((a) => a!.text).join('')).toBe(LONG.slice(50))
    // Linear: the whole-each-time stream would be ~400 × 10 KB / 2 = 4 MB; this is about the text itself.
    const sent = out.reduce((n, o) => n + bytes(o), 0)
    expect(sent).toBeLessThan(LONG.length * 3)
    expect(steps(LONG).reduce((n, text) => n + bytes(preview(text)), 0)).toBeGreaterThan(LONG.length * 100)
  })

  it('sends the finished item whole and starts the next preview of that id over', () => {
    const encoder = new PreviewEncoder(() => 0)
    encoder.encode(preview('Hel'), true)
    expect(encoder.encode(final('Hello'), false)).toEqual({ item: final('Hello') })
    expect(encoder.encode(preview('Hello again'), true)).toEqual({ item: preview('Hello again') })
  })

  it('resends whole every RESYNC_MS, when the text is not a continuation, and sends nothing when it did not grow', () => {
    let now = 0
    const encoder = new PreviewEncoder(() => now)
    encoder.encode(preview('one'), true)
    expect(encoder.encode(preview('one two'), true)).toEqual({ append: { itemId: 'a1', from: 3, text: ' two' } })
    expect(encoder.encode(preview('one two'), true)).toBeNull()
    now = RESYNC_MS
    expect(encoder.encode(preview('one two three'), true)).toEqual({ item: preview('one two three') })
    expect(encoder.encode(preview('rewritten'), true)).toEqual({ item: preview('rewritten') })
    // Previews that aren't growing text (a running tool's progress) always go whole.
    const tool: ChatItem = { kind: 'tool', id: 'x', turnId: 't1', name: 'Bash', input: {}, status: 'running', output: 'a' }
    expect(encoder.encode(tool, true)).toEqual({ item: tool })
    expect(encoder.encode({ ...tool, output: 'ab' }, true)).toEqual({ item: { ...tool, output: 'ab' } })
  })
})

describe('resync while the text stops growing', () => {
  it('PreviewEncoder.resync gives back previews sent as appends once RESYNC_MS has passed since they went whole', () => {
    let now = 0
    const encoder = new PreviewEncoder(() => now)
    encoder.encode(preview('one'), true)
    expect(encoder.appending()).toBe(false)
    encoder.encode(preview('one two'), true)
    expect(encoder.appending()).toBe(true)
    now = RESYNC_MS - 1
    expect(encoder.resync()).toEqual([])
    now = RESYNC_MS
    expect(encoder.resync()).toEqual([preview('one two')])
    // Marked as sent whole: no second resync, and the next growth goes as an append from it.
    expect(encoder.appending()).toBe(false)
    expect(encoder.resync()).toEqual([])
    expect(encoder.encode(preview('one two three'), true)).toEqual({ append: { itemId: 'a1', from: 7, text: ' three' } })
    // A finished item is never resent.
    encoder.encode(final('one two three.'), false)
    now = RESYNC_MS * 3
    expect(encoder.resync()).toEqual([])
  })

  it('a window that missed an append is put right while the agent pauses mid-block', async () => {
    let resume!: () => void
    const paused = new Promise<void>((resolve) => (resume = resolve))
    let reached!: () => void
    const atPause = new Promise<void>((resolve) => (reached = resolve))
    registerDriver(
      fakeDriver(async (req, cb) => {
        for (const text of ['Hel', 'Hello', 'Hello wor', 'Hello world']) cb.item({ ...preview(text), turnId: req.turnId }, true)
        reached()
        await paused
        cb.item({ ...final('Hello world.'), turnId: req.turnId })
        cb.finished({ ok: true })
      })
    )
    const window: ChatItem[] = []
    let appends = 0
    const h = await setupSessions({
      events: {
        item: (_s, item) => {
          const i = window.findIndex((w) => w.id === item.id)
          if (i === -1) window.push(item)
          else window[i] = item
        },
        append: (_s, append: ChatAppend) => {
          // The window misses the second append.
          if (++appends === 2) return
          const next = appendToItems(window, append)
          if (next) window.splice(0, window.length, ...next)
        }
      }
    })
    await h.sessions.send(h.session.id, 'go')
    await atPause
    expect(window.find((i) => i.id === 'a1')).toMatchObject({ text: 'Hello' })
    await vi.waitFor(() => expect(window.find((i) => i.id === 'a1')).toMatchObject({ text: 'Hello world', streaming: true }), { timeout: RESYNC_MS * 3 })
    resume()
    await vi.waitFor(() => expect(h.session.status).toBe('idle'), { timeout: 20_000 })
    expect(window.find((i) => i.id === 'a1')).toMatchObject({ text: 'Hello world.' })
  }, 60_000)
})

describe('applying appends', () => {
  it('extends the streaming item, skips an append it cannot continue, and is repaired by the next whole item', () => {
    let items: ChatItem[] = [final('earlier', 'u0'), preview('Hel')]
    items = appendToItems(items, { itemId: 'a1', from: 3, text: 'lo' })!
    expect(items[1]).toEqual(preview('Hello'))
    expect(items[0]).toEqual(final('earlier', 'u0'))
    // A missed append: the next one doesn't start where the held text ends.
    expect(appendToItems(items, { itemId: 'a1', from: 9, text: ' world' })).toBeNull()
    // Not a streaming preview (finished), or not held at all.
    expect(appendToItems([final('Hello')], { itemId: 'a1', from: 5, text: '!' })).toBeNull()
    expect(appendToItems([], { itemId: 'a1', from: 0, text: 'x' })).toBeNull()
  })

  it('PreviewDecoder rebuilds whole previews and waits for a resend after a gap', () => {
    const decoder = new PreviewDecoder()
    decoder.item(preview('ab'), true)
    expect(decoder.append({ itemId: 'a1', from: 2, text: 'cd' })).toEqual(preview('abcd'))
    expect(decoder.append({ itemId: 'a1', from: 6, text: 'gh' })).toBeNull()
    decoder.item(preview('abcdefgh'), true)
    expect(decoder.append({ itemId: 'a1', from: 8, text: 'i' })).toEqual(preview('abcdefghi'))
    decoder.item(final('abcdefghi!'), false)
    expect(decoder.append({ itemId: 'a1', from: 9, text: 'j' })).toBeNull()
  })
})

describe('a chat streaming through SessionService', () => {
  it('sends windows appends, serves the preview to a chat opened mid-stream, and keeps whole items for listeners without appends', async () => {
    let resume!: () => void
    const halfway = new Promise<void>((resolve) => (resume = resolve))
    let reached!: () => void
    const atHalf = new Promise<void>((resolve) => (reached = resolve))
    const texts = steps(LONG)
    registerDriver(
      fakeDriver(async (req, cb) => {
        for (const [i, text] of texts.entries()) {
          cb.item({ ...preview(text), turnId: req.turnId }, true)
          if (i === 199) {
            reached()
            await halfway
          }
        }
        cb.item({ ...final(LONG), turnId: req.turnId })
        cb.finished({ ok: true })
      })
    )
    // A window: whole items and appends, applied as the renderer store does.
    const window: ChatItem[] = []
    let sent = 0
    const h = await setupSessions({
      events: {
        item: (_s, item) => {
          sent += bytes(item)
          const i = window.findIndex((w) => w.id === item.id)
          if (i === -1) window.push(item)
          else window[i] = item
        },
        append: (_s, append: ChatAppend) => {
          sent += bytes(append)
          const next = appendToItems(window, append)
          if (next) window.splice(0, window.length, ...next)
        }
      }
    })
    await h.sessions.send(h.session.id, 'go')
    await atHalf
    const streamed = window.find((i) => i.id === 'a1')
    expect(streamed).toMatchObject({ text: texts[199], streaming: true })
    // A window opening the chat now sees the preview; other readers (CLI, phone) see only what is saved.
    expect((await h.sessions.getChat(h.session.id, true)).find((i) => i.id === 'a1')).toMatchObject({ text: texts[199], streaming: true })
    expect((await h.sessions.getChat(h.session.id)).find((i) => i.id === 'a1')).toBeUndefined()
    resume()
    await vi.waitFor(() => expect(h.session.status).toBe('idle'), { timeout: 20_000 })
    expect(window.find((i) => i.id === 'a1')).toEqual({ ...final(LONG), turnId: expect.any(String) })
    // About the answer twice over (the stream, then the finished item), not the 4 MB of whole previews.
    expect(sent).toBeLessThan(LONG.length * 5)
    expect(await h.sessions.getChat(h.session.id, true)).toEqual(await h.sessions.getChat(h.session.id))
  }, 60_000)

  it('gives every preview whole to a listener without appends', async () => {
    const texts = ['He', 'Hello', 'Hello there']
    registerDriver(
      fakeDriver(async (req, cb) => {
        for (const text of texts) cb.item({ ...preview(text), turnId: req.turnId }, true)
        cb.item({ ...final('Hello there.'), turnId: req.turnId })
        cb.finished({ ok: true })
      })
    )
    const seen: ChatItem[] = []
    const h = await setupSessions({ events: { item: (_s, item) => void (item.id === 'a1' && seen.push(item)) } })
    await h.sessions.send(h.session.id, 'go')
    await vi.waitFor(() => expect(h.session.status).toBe('idle'), { timeout: 20_000 })
    expect(seen.map((i) => (i.kind === 'assistant' ? [i.text, Boolean(i.streaming)] : null))).toEqual([
      ['He', true],
      ['Hello', true],
      ['Hello there', true],
      ['Hello there.', false]
    ])
  }, 60_000)
})

describe('the background agent host relays appends', () => {
  const started: { server?: HostServer; client?: HostClient } = {}
  afterEach(() => {
    started.client?.close()
    started.server?.close()
  })

  it('sends appends over the socket and hands the chat whole previews', async () => {
    const texts = steps(LONG.slice(0, 2000))
    const streaming: AgentDriver = {
      kind: 'claude',
      status: async () => ({ agent: 'claude', installed: true, ready: true }),
      createTurn: (req, cb) => ({
        run: async () => {
          for (const text of texts) cb.item({ ...preview(text), turnId: req.turnId }, true)
          cb.item({ ...final(texts.at(-1)!), turnId: req.turnId })
          cb.finished({ ok: true })
        },
        stop: async () => undefined,
        steer: () => false,
        setPlanMode: async () => undefined,
        setModel: async () => undefined
      })
    }
    const dir = await tempDir('foreman-host-append-')
    const server = (started.server = new HostServer({ dir, driver: () => streaming, idleMs: 60_000, exit: () => undefined }))
    expect(await server.listen()).toBe(true)
    const pushes: { type: string }[] = []
    const push = (server as unknown as { push: (p: { type: string }) => void }).push.bind(server)
    ;(server as unknown as { push: (p: { type: string }) => void }).push = (p) => {
      pushes.push(p)
      push(p)
    }
    const client = (started.client = new HostClient({ dir }))
    const previews: ChatItem[] = []
    const saved: ChatItem[] = []
    const cb = {
      item: (item: ChatItem, transient?: boolean) => void (transient ? previews : saved).push(item),
      sessionStarted: () => undefined,
      assistantMessage: () => undefined,
      approveTool: async () => ({ kind: 'tool', allow: true }),
      reviewPlan: async () => ({ kind: 'plan', approve: true }),
      ask: async () => ({ kind: 'question', skipped: true }),
      planModeChanged: () => undefined,
      autoAcceptEdits: () => undefined,
      usage: () => undefined,
      finished: () => undefined
    } as unknown as TurnCallbacks
    await client.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', 'go'), label: { workspace: 'w' } }, {}, cb).run()
    expect(pushes.filter((p) => p.type === 'transient')).toHaveLength(1)
    expect(pushes.filter((p) => p.type === 'transient-append')).toHaveLength(texts.length - 1)
    // The app side rebuilt every preview whole, in order, and the finished item came as saved.
    expect(previews.map((p) => (p.kind === 'assistant' ? p.text : ''))).toEqual(texts)
    expect(saved.find((i) => i.id === 'a1')).toEqual({ ...final(texts.at(-1)!), turnId: 't1' })
  }, 30_000)
})

describe('previews that are not appends are throttled to one per item every 50 ms', () => {
  it('PreviewThrottle sends the first at once and the latest of the rest when the window ends', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let state = 0
    const throttle = new PreviewThrottle((id) => sent.push(`${id}:${state}`))
    for (state = 1; state <= 20; state++) throttle.mark('x')
    throttle.mark('y')
    expect(sent).toEqual(['x:1', 'y:21'])
    state = 99
    vi.advanceTimersByTime(50)
    expect(sent).toEqual(['x:1', 'y:21', 'x:99'])
    vi.advanceTimersByTime(500)
    expect(sent).toHaveLength(3)
    throttle.mark('x')
    throttle.mark('x')
    throttle.cancel()
    vi.advanceTimersByTime(500)
    expect(sent).toEqual(['x:1', 'y:21', 'x:99', 'x:99'])
  })

  it('Codex previews and command progress go out at most once a window, never after the saved item', () => {
    vi.useFakeTimers()
    const log: { item: ChatItem; transient: boolean }[] = []
    const cb = { item: (item: ChatItem, transient = false) => void log.push({ item: structuredClone(item), transient }), sessionStarted: () => undefined, usage: () => undefined, finished: () => undefined }
    const mapper = new CodexEventMapper('t1', '/repo', 400_000, cb)
    for (let i = 1; i <= 30; i++) mapper.handle({ type: 'item.updated', item: { id: 'm', type: 'agent_message', text: 'x'.repeat(i) } })
    mapper.handle({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } })
    for (let i = 1; i <= 30; i++) mapper.handle({ type: 'item.updated', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: `${i}\n`, status: 'in_progress' } })
    const transient = () => log.filter((l) => l.transient).map((l) => (l.item.kind === 'tool' ? l.item.output : l.item.kind === 'assistant' ? l.item.text.length : null))
    expect(transient()).toEqual([1, '1\n'])
    vi.advanceTimersByTime(50)
    expect(transient()).toEqual([1, '1\n', 30, '30\n'])
    // Finished before the next window ends: the pending preview is dropped, the saved items stand.
    mapper.handle({ type: 'item.updated', item: { id: 'm', type: 'agent_message', text: 'x'.repeat(31) } })
    mapper.handle({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'x'.repeat(32) } })
    mapper.handle({ type: 'item.updated', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'late\n', status: 'in_progress' } })
    mapper.handle({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'done\n', status: 'completed', exit_code: 0 } })
    vi.advanceTimersByTime(500)
    expect(transient()).toEqual([1, '1\n', 30, '30\n'])
    expect(log.at(-1)).toMatchObject({ transient: false, item: { id: 't1:c', status: 'done', output: 'done\n' } })
    expect(log.at(-2)).toMatchObject({ transient: false, item: { id: 't1:m', text: 'x'.repeat(32) } })
  })
})
