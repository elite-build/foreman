// #12 (G4): the "sent as it was before your edit" tag after a race, and attachments added or removed while
// editing a queued message.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { Store } from '../src/main/store'
import type { Attachment, ChatItem, Workspace } from '../src/shared/types'
import { createT } from '../src/shared/i18n'
import { fakeDriver, gate, setupSessions, type Script } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))
const SLOW = { timeout: 10_000 }

function firstTurnHeld(ws: Workspace) {
  const held = gate()
  const requests: { prompt: string }[] = []
  const script: Script = async (req, cb, signal) => {
    if (req.cwd !== ws.path) return cb.finished({ ok: true })
    requests.push(req)
    if (requests.length === 1) return held.script(req, cb, signal)
    cb.finished({ ok: true })
  }
  registerDriver(fakeDriver(script))
  return { release: held.release, requests }
}

async function userItem(store: Store, sessionId: string, turnId: string) {
  const items = await store.readChat(sessionId)
  return items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId)
}

const file = (name: string): Attachment => ({ name, path: `/ws/.context/attachments/${name}`, kind: 'text' })

describe('attachments while editing a queued message', () => {
  it('adds and removes files with the text, keeping its id, place and turn id', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'second', { mode: 'queue', attachments: [file('a.txt')] })
    const message = session.queue[0]
    const opened = session.queueRevision!

    const result = sessions.editQueued(session.id, message.id, 'second, with logs', opened, [file('b.txt'), file('c.txt')])
    expect(result.ok).toBe(true)
    expect(session.queue[0]).toMatchObject({ id: message.id, turnId: queued.turnId, text: 'second, with logs', attachments: [file('b.txt'), file('c.txt')] })

    // Only the files changed: still an edit.
    const before = session.queue[0].revision
    expect(sessions.editQueued(session.id, message.id, 'second, with logs', session.queueRevision!, [file('c.txt')]).ok).toBe(true)
    expect(session.queue[0].attachments).toEqual([file('c.txt')])
    expect(session.queue[0].revision).not.toBe(before)
    // Unchanged text and files: nothing to save.
    const same = session.queue[0].revision
    sessions.editQueued(session.id, message.id, 'second, with logs', session.queueRevision!, [file('c.txt')])
    expect(session.queue[0].revision).toBe(same)
    agent.release()
  })

  it('a message emptied of text and files is refused; files alone are fine; malformed entries are dropped', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'look at this', { mode: 'queue', attachments: [file('a.txt')] })
    const { id } = session.queue[0]
    expect(() => sessions.editQueued(session.id, id, ' ', session.queueRevision!, [])).toThrow('can’t be empty')
    expect(sessions.editQueued(session.id, id, '', session.queueRevision!, [file('a.txt'), { name: 1, path: 'x' } as unknown as Attachment]).ok).toBe(true)
    expect(session.queue[0].attachments).toEqual([file('a.txt')])
    agent.release()
  })

  it('without attachments (an older caller), the files stay as they were', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'second', { mode: 'queue', attachments: [file('a.txt')] })
    sessions.editQueued(session.id, session.queue[0].id, 'second!', session.queueRevision!)
    expect(session.queue[0].attachments).toEqual([file('a.txt')])
    agent.release()
  })

  it('the edited files go with the turn that runs', async () => {
    const { sessions, session, ws, store } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'second', { mode: 'queue' })
    sessions.editQueued(session.id, session.queue[0].id, 'second', session.queueRevision!, [file('log.txt')])
    agent.release()
    await vi.waitFor(async () => expect((await userItem(store, session.id, queued.turnId!))?.attachments).toEqual([file('log.txt')]), SLOW)
  })
})

describe('"Sent as it was before your edit"', () => {
  it('dispatch wins: the message that ran is tagged; queuing the kept draft is a new message', async () => {
    const { sessions, session, ws, store } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'open a draft PR', { mode: 'queue' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!
    agent.release()
    await vi.waitFor(() => expect(session.queue).toEqual([]), SLOW)
    await vi.waitFor(async () => expect(await userItem(store, session.id, queued.turnId!)).toBeTruthy(), SLOW)
    expect(sessions.editQueued(session.id, id, 'open a draft PR, skip search', opened)).toMatchObject({ ok: false, reason: 'started' })
    await vi.waitFor(async () => expect((await userItem(store, session.id, queued.turnId!))?.editRaced).toBe(true), SLOW)
    expect((await userItem(store, session.id, queued.turnId!))?.text).toBe('open a draft PR')
  }, 20_000)

  it('an unchanged save after the race says nothing', async () => {
    const { sessions, session, ws, store } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'same', { mode: 'queue' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!
    agent.release()
    await vi.waitFor(async () => expect(await userItem(store, session.id, queued.turnId!)).toBeTruthy(), SLOW)
    sessions.editQueued(session.id, id, 'same', opened)
    await new Promise((r) => setTimeout(r, 50))
    expect((await userItem(store, session.id, queued.turnId!))?.editRaced).toBeUndefined()
  }, 20_000)

  it('a deleted message is "removed", not tagged', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'gone soon', { mode: 'queue' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!
    sessions.removeQueued(session.id, id)
    expect(sessions.editQueued(session.id, id, 'edited', opened)).toMatchObject({ ok: false, reason: 'removed' })
    agent.release()
  })

  it('has Spanish strings', () => {
    expect(createT('es')('queue.sentBeforeEdit')).toBe('Enviado tal como era antes de tu edición')
  })
})
