import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { send, waitForTurn } from '../src/main/cliServer'
import type { SessionService } from '../src/main/sessions'
import type { Store } from '../src/main/store'
import { editIsStale, isAppCommand, moveQueuedMessage, queueMoveKey, shortTurnId } from '../src/shared/queueEdit'
import type { ChatItem, PromptTemplate, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { fakeDriver, gate, setupSessions, type Script } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

// The full suite runs many git-backed sessions at once; give each wait room.
const SLOW = { timeout: 10_000 }

/**
 * A driver whose first turn in this workspace stays running until released; later turns finish at once.
 * Records this workspace's prompts (an earlier test's leftover turns run in their own folder and are ignored).
 */
function firstTurnHeld(ws: Workspace) {
  const held = gate()
  const prompts: string[] = []
  const script: Script = async (req, cb, signal) => {
    if (req.cwd !== ws.path) return cb.finished({ ok: true })
    prompts.push(req.prompt)
    if (prompts.length === 1) return held.script(req, cb, signal)
    cb.finished({ ok: true })
  }
  registerDriver(fakeDriver(script))
  return { release: held.release, prompts }
}

/** The CLI's view of real sessions: `foreman send` delivers, `foreman wait` polls turn status. */
function cliHost(store: Store, sessions: SessionService) {
  return stubHost({
    state: () => store.state,
    deliver: (sessionId, text, options) => sessions.deliver(sessionId, text, options),
    turnStatus: (turnId) => sessions.turnStatus(turnId)
  })
}

async function userItem(store: Store, sessionId: string, turnId: string) {
  const items = await store.readChat(sessionId)
  return items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId)
}

describe('queue editing: pure pieces', () => {
  const q = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('moves a message one place either way, and refuses past either end or an unknown id', () => {
    expect(moveQueuedMessage(q, 'b', 'up')?.map((m) => m.id)).toEqual(['b', 'a', 'c'])
    expect(moveQueuedMessage(q, 'b', 'down')?.map((m) => m.id)).toEqual(['a', 'c', 'b'])
    expect(moveQueuedMessage(q, 'a', 'up')).toBeNull()
    expect(moveQueuedMessage(q, 'c', 'down')).toBeNull()
    expect(moveQueuedMessage(q, 'zz', 'up')).toBeNull()
    // The input is left as it was.
    expect(q.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('calls an edit stale only when its message changed after the editor opened', () => {
    expect(editIsStale(3, 3)).toBe(false)
    expect(editIsStale(2, 5)).toBe(false)
    expect(editIsStale(4, 3)).toBe(true)
    // Messages queued before revisions existed.
    expect(editIsStale(undefined, 0)).toBe(false)
  })

  it('shortens a turn id for the hint', () => {
    expect(shortTurnId('3f9c2a1e-7b4d-4c1e-9a55-0d1f2e3a4b5c')).toBe('3f9c2a1e…')
    expect(shortTurnId('abc')).toBe('abc')
  })

  it('reads ⌥↑/⌥↓ (Alt on Windows) and nothing else as a move', () => {
    const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
      queueMoveKey({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })
    expect(key('ArrowUp', { altKey: true })).toBe('up')
    expect(key('ArrowDown', { altKey: true })).toBe('down')
    expect(key('ArrowUp')).toBeNull()
    expect(key('ArrowUp', { altKey: true, shiftKey: true })).toBeNull()
    expect(key('ArrowUp', { altKey: true, metaKey: true })).toBeNull()
    expect(key('ArrowLeft', { altKey: true })).toBeNull()
  })

  it('knows the commands Foreman runs itself', () => {
    expect(isAppCommand(' /clear ')).toBe(true)
    expect(isAppCommand('/compact')).toBe(false)
    expect(isAppCommand('/clear the cache')).toBe(false)
  })
})

describe('editing a queued message in place', () => {
  it('keeps its turn id, so `foreman send` then `foreman wait` sees the edited message complete', async () => {
    const { sessions, session, store, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const host = cliHost(store, sessions)
    const sent = await send(host, { workspace: 'ws', args: ['commit', 'and', 'open', 'a', 'PR'], cwd: '/elsewhere' })
    expect(sent.disposition).toBe('queued')
    const before = { ...session.queue[0] }
    expect(before).toMatchObject({ turnId: sent.turn, text: 'commit and open a PR', via: 'cli' })
    const waiting = waitForTurn(host, { turn: sent.turn }, { pollMs: 10 })

    const result = sessions.editQueued(session.id, before.id, 'commit and open a draft PR', session.queueRevision!)
    expect(result).toEqual({ ok: true, revision: session.queueRevision })
    // Same message, same place, same turn: only the words (and its revision) changed.
    expect(session.queue).toEqual([{ ...before, text: 'commit and open a draft PR', revision: result.revision }])
    expect(await sessions.turnStatus(sent.turn)).toMatchObject({ state: 'queued' })

    agent.release()
    expect(await waitForTurn(host, { turn: sent.turn }, { pollMs: 10 })).toMatchObject({ turn: sent.turn, outcome: 'completed' })
    expect(await waiting).toMatchObject({ turn: sent.turn, outcome: 'completed' })
    // What ran was the edit.
    expect(agent.prompts[1]).toContain('commit and open a draft PR')
    expect((await userItem(store, session.id, sent.turn!))?.text).toBe('commit and open a draft PR')
  }, 20_000)

  it('keeps attachments and template metadata through the edit, onto the message that runs', async () => {
    const template: PromptTemplate = { id: 'repo:plan', name: 'Plan', body: '', source: 'repo', rev: 'blob1', followUp: { title: 'Build', prompt: 'Build it' } }
    const { sessions, session, store, ws } = await setupSessions({ template: (id) => (id === template.id ? template : undefined) })
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const attachment = { name: 'notes.txt', path: path.join(ws.path!, '.context', 'attachments', 'notes.txt'), kind: 'text' as const }
    const queued = await sessions.deliver(session.id, 'plan it', { mode: 'queue', templateId: template.id, attachments: [attachment] })
    const message = session.queue[0]
    expect(sessions.editQueued(session.id, message.id, 'plan it, smaller', session.queueRevision!).ok).toBe(true)
    expect(session.queue[0]).toMatchObject({ id: message.id, turnId: queued.turnId, templateId: template.id, attachments: [attachment], followUp: { title: 'Build' }, repoTemplate: { name: 'Plan', rev: 'blob1' } })

    agent.release()
    await vi.waitFor(async () => expect((await sessions.turnStatus(queued.turnId!))?.state).toBe('ended'), SLOW)
    expect(await userItem(store, session.id, queued.turnId!)).toMatchObject({
      text: 'plan it, smaller',
      attachments: [attachment],
      followUp: { title: 'Build', templateId: template.id },
      repoTemplate: { name: 'Plan', rev: 'blob1' }
    })
  }, 20_000)

  it('refuses an edit made from a stale revision, and changes nothing', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'second', { mode: 'queue' })
    const opened = session.queueRevision!
    const id = session.queue[0].id
    // Someone else (another window, the phone) saved first.
    expect(sessions.editQueued(session.id, id, 'second, from the phone', opened).ok).toBe(true)
    const after = session.queueRevision!
    expect(sessions.editQueued(session.id, id, 'second, from the desktop', opened)).toEqual({ ok: false, reason: 'stale', revision: after })
    expect(session.queue[0].text).toBe('second, from the phone')
    expect(session.queueRevision).toBe(after)
    agent.release()
  })

  it('is not made stale by other messages being queued or moved meanwhile', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'a', { mode: 'queue' })
    const opened = session.queueRevision!
    const a = session.queue[0].id
    await sessions.deliver(session.id, 'b', { mode: 'queue' })
    const b = session.queue[1].id
    expect(sessions.moveQueued(session.id, b, 'up', session.queueRevision!).ok).toBe(true)
    expect(sessions.editQueued(session.id, a, 'a, edited', opened).ok).toBe(true)
    expect(session.queue.map((m) => m.text)).toEqual(['b', 'a, edited'])
    agent.release()
  })

  it('refuses an empty message and app commands, and an unchanged save is a no-op', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'second', { mode: 'queue' })
    const { id } = session.queue[0]
    const revision = session.queueRevision!
    expect(() => sessions.editQueued(session.id, id, '   ', revision)).toThrow('can’t be empty')
    expect(() => sessions.editQueued(session.id, id, '/clear', revision)).toThrow('/commands')
    expect(sessions.editQueued(session.id, id, 'second', revision)).toEqual({ ok: true, revision })
    expect(session.queueRevision).toBe(revision)
    agent.release()
  })

  it('says "removed" for a message deleted (or cancelled with `foreman cancel`) before the save', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const queued = await sessions.deliver(session.id, 'second', { mode: 'queue' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!
    await sessions.cancelTurn(queued.turnId!)
    expect(sessions.editQueued(session.id, id, 'second, edited', opened)).toMatchObject({ ok: false, reason: 'removed' })
    expect(session.queue).toEqual([])
    agent.release()
  })
})

describe('edit against dispatch', () => {
  it('when dispatch takes the message first, the original runs under its turn id and the edit is refused as "started"', async () => {
    const { sessions, session, store, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    const host = cliHost(store, sessions)
    const sent = await send(host, { workspace: 'ws', args: ['open a draft PR'], cwd: '/elsewhere' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!

    // The running turn ends while the user is still typing; the queue sends the original.
    agent.release()
    await vi.waitFor(() => expect(session.queue).toEqual([]), SLOW)
    const result = sessions.editQueued(session.id, id, 'open a draft PR, and leave search out', opened)
    expect(result).toEqual({ ok: false, reason: 'started', revision: session.queueRevision })

    // `foreman wait` follows the turn that actually ran, with the text that was sent.
    expect(await waitForTurn(host, { turn: sent.turn }, { pollMs: 10 })).toMatchObject({ outcome: 'completed' })
    expect((await userItem(store, session.id, sent.turn!))?.text).toBe('open a draft PR')
    expect(agent.prompts[1]).toContain('open a draft PR')
    expect(agent.prompts[1]).not.toContain('leave search out')

    // Queuing the kept draft is a new message with a new turn; the original turn is left alone.
    const again = await sessions.deliver(session.id, 'open a draft PR, and leave search out', { mode: 'queue' })
    expect(again.turnId).not.toBe(sent.turn)
    await vi.waitFor(async () => expect((await sessions.turnStatus(again.turnId!))?.state).toBe('ended'), SLOW)
    expect((await userItem(store, session.id, sent.turn!))?.text).toBe('open a draft PR')
  }, 20_000)

  it('Send now also counts as started', async () => {
    const { sessions, session, ws } = await setupSessions()
    const agent = firstTurnHeld(ws)
    await sessions.deliver(session.id, 'first')
    await sessions.deliver(session.id, 'second', { mode: 'queue' })
    const { id } = session.queue[0]
    const opened = session.queueRevision!
    await sessions.steerQueued(session.id, id)
    expect(sessions.editQueued(session.id, id, 'second, edited', opened)).toMatchObject({ ok: false, reason: 'started' })
    agent.release()
  })
})

describe('reordering the queue', () => {
  async function threeQueued() {
    const harness = await setupSessions()
    const agent = firstTurnHeld(harness.ws)
    await harness.sessions.deliver(harness.session.id, 'first')
    const turns: string[] = []
    for (const text of ['a', 'b', 'c']) turns.push((await harness.sessions.deliver(harness.session.id, text, { mode: 'queue' })).turnId!)
    return { ...harness, agent, turns }
  }

  it('moves by stable id, keeping each message’s turn id, and the queue runs in the new order', async () => {
    const { sessions, session, store, agent, turns } = await threeQueued()
    const [a, b, c] = session.queue.map((m) => m.id)
    expect(sessions.moveQueued(session.id, c, 'up', session.queueRevision!).ok).toBe(true)
    expect(sessions.moveQueued(session.id, a, 'down', session.queueRevision!).ok).toBe(true)
    expect(session.queue.map((m) => [m.id, m.text, m.turnId])).toEqual([
      [c, 'c', turns[2]],
      [a, 'a', turns[0]],
      [b, 'b', turns[1]]
    ])
    // Already at the front: nothing changes, not even the revision.
    const revision = session.queueRevision!
    expect(sessions.moveQueued(session.id, c, 'up', revision)).toEqual({ ok: true, revision })

    agent.release()
    // Three turns run back to back here, so give them longer than one turn under a loaded suite.
    await vi.waitFor(async () => expect((await sessions.turnStatus(turns[1]))?.state).toBe('ended'), { timeout: 30_000 })
    const order = (await store.readChat(session.id)).flatMap((i) => (i.kind === 'user' ? [i.text] : []))
    expect(order).toEqual(['first', 'c', 'a', 'b'])
  }, 45_000)

  it('refuses a move from a stale revision, so an order changed elsewhere is not overwritten', async () => {
    const { sessions, session, agent } = await threeQueued()
    const [a, b] = session.queue.map((m) => m.id)
    const seen = session.queueRevision!
    expect(sessions.moveQueued(session.id, b, 'up', seen).ok).toBe(true)
    const now = session.queueRevision!
    expect(sessions.moveQueued(session.id, a, 'down', seen)).toEqual({ ok: false, reason: 'stale', revision: now })
    expect(session.queue.map((m) => m.text)).toEqual(['b', 'a', 'c'])
    // A message queued, edited or removed also moves the revision on.
    await sessions.deliver(session.id, 'd', { mode: 'queue' })
    expect(sessions.moveQueued(session.id, a, 'down', now)).toMatchObject({ ok: false, reason: 'stale' })
    agent.release()
  })

  it('refuses a move of a message that already started', async () => {
    const { sessions, session, agent } = await threeQueued()
    const front = session.queue[0].id
    const seen = session.queueRevision!
    agent.release()
    await vi.waitFor(() => expect(session.queue.some((m) => m.id === front)).toBe(false), SLOW)
    expect(sessions.moveQueued(session.id, front, 'down', seen)).toMatchObject({ ok: false, reason: 'started' })
  })
})
