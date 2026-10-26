import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { searchNotes } from '../src/main/chatSearch'
import { hasNote, noteStanding, savedNote } from '../src/shared/note'
import { snippetParts } from '../src/shared/chatIndex'
import type { ChatItem } from '../src/shared/types'
import { tempDir, waitFor } from './helpers'
import { machine, seed } from './portabilityRig'
import { fakeDriver, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const NOW = '2026-01-01T00:00:00Z'
type User = Extract<ChatItem, { kind: 'user' }>

/** Every turn finishes at once; the prompts it was given are collected. */
function recording() {
  const prompts: string[] = []
  registerDriver(fakeDriver(async (req: TurnRequest, cb) => (prompts.push(req.prompt), cb.finished({ ok: true }))))
  return prompts
}
const idle = (h: Awaited<ReturnType<typeof setupSessions>>) => waitFor(() => {
    expect(h.session.status).toBe('idle')
    expect(h.session.turnId).toBeUndefined()
  }, { timeout: 10_000 })
const users = async (h: Awaited<ReturnType<typeof setupSessions>>) => (await h.store.readChat(h.session.id)).filter((i): i is User => i.kind === 'user')

describe('note revisions', () => {
  it('starts at r1, goes up only when the text changes, and an empty note has nothing to send', () => {
    const r1 = savedNote(undefined, 'Use fake timers', NOW)!
    expect(r1).toMatchObject({ text: 'Use fake timers', revision: 1 })
    expect(savedNote(r1, 'Use fake timers', 'later')).toBe(r1)
    const r2 = savedNote(r1, 'Use fake timers, never sleeps', NOW)!
    expect(r2.revision).toBe(2)
    const cleared = savedNote(r2, '  ', NOW)!
    expect(cleared.revision).toBe(3)
    expect(hasNote(cleared)).toBe(false)
    expect(savedNote(undefined, '   ', NOW)).toBeUndefined()
  })

  it('tells each tab where it stands', () => {
    const note = { text: 'x', revision: 3, updatedAt: NOW }
    expect(noteStanding(undefined, {})).toBe('none')
    expect(noteStanding(note, { includeNote: true })).toBe('pending')
    expect(noteStanding(note, { noteRevision: 3 })).toBe('current')
    expect(noteStanding(note, { noteRevision: 2 })).toBe('stale')
    expect(noteStanding(note, {})).toBe('stale')
  })
})

describe('delivering the note', () => {
  it('saving sends nothing and starts or queues nothing', async () => {
    const prompts = recording()
    const h = await setupSessions()
    h.sessions.setNote(h.ws.id, 'Keep the IPC types unchanged')
    h.sessions.setNote(h.ws.id, 'Keep the IPC types unchanged, use fake timers')
    expect(h.ws.note).toMatchObject({ revision: 2 })
    await new Promise((r) => setTimeout(r, 30))
    expect(prompts).toEqual([])
    expect(h.session.status).toBe('idle')
    expect(h.session.queue).toEqual([])
    expect(await h.store.readChat(h.session.id)).toEqual([])
    expect(h.session.noteRevision).toBeUndefined()
  })

  it('Include note adds the note to the first message only and records its revision', async () => {
    const prompts = recording()
    const h = await setupSessions()
    h.sessions.setNote(h.ws.id, 'Use fake timers')
    h.session.includeNote = true
    await h.sessions.send(h.session.id, 'fix the test')
    await idle(h)
    await h.sessions.send(h.session.id, 'and the other one')
    await idle(h)
    expect(prompts[0]).toContain('fix the test')
    expect(prompts[0]).toContain('workspace note (r1)')
    expect(prompts[0]).toContain('Use fake timers')
    expect(prompts[1]).not.toContain('workspace note')
    const [first, second] = await users(h)
    expect(first.noteRevision).toBe(1)
    expect(second.noteRevision).toBeUndefined()
    expect(h.session).toMatchObject({ noteRevision: 1, includeNote: undefined })
  })

  it('sends an updated note only on request, as a normal queued message, recording the revision', async () => {
    const prompts = recording()
    const h = await setupSessions()
    h.sessions.setNote(h.ws.id, 'first')
    await h.sessions.send(h.session.id, 'hello')
    await idle(h)
    h.sessions.setNote(h.ws.id, 'second')
    expect(noteStanding(h.ws.note, h.session)).toBe('stale')
    expect(prompts).toHaveLength(1)

    const receipt = await h.sessions.sendNote(h.session.id)
    expect(receipt.disposition).toBe('started')
    await idle(h)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Workspace note (r2)')
    expect(prompts[1]).toContain('second')
    const sent = (await users(h)).at(-1)!
    expect(sent.noteRevision).toBe(2)
    expect(h.session.noteRevision).toBe(2)
    expect(noteStanding(h.ws.note, h.session)).toBe('current')
  })

  it('queues the note behind a running turn, and records the revision when it goes', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const prompts: string[] = []
    registerDriver(fakeDriver(async (req, cb) => (prompts.push(req.prompt), prompts.length === 1 && (await held), cb.finished({ ok: true }))))
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'work')
    h.sessions.setNote(h.ws.id, 'be careful')
    const receipt = await h.sessions.sendNote(h.session.id)
    expect(receipt.disposition).toBe('queued')
    expect(h.session.queue[0]).toMatchObject({ noteRevision: 1 })
    expect(h.session.noteRevision).toBeUndefined()
    release()
    await waitFor(() => expect(prompts).toHaveLength(2))
    await idle(h)
    expect((await users(h)).at(-1)!.noteRevision).toBe(1)
  })
})

describe('note in search and export', () => {
  it('finds a note as its own kind of result', async () => {
    const h = await setupSessions()
    h.sessions.setNote(h.ws.id, "Don't touch the Windows CI job. Use vitest fake timers, not sleeps.")
    const [hit, ...rest] = searchNotes(h.store, 'fake TIMERS')
    expect(rest).toEqual([])
    expect(hit).toMatchObject({ workspaceId: h.ws.id, revision: 1 })
    expect(snippetParts(hit.snippet).filter((p) => p.hit).map((p) => p.text.toLowerCase())).toEqual(['fake', 'timers'])
    expect(searchNotes(h.store, 'missing')).toEqual([])
    expect(searchNotes(h.store, '')).toEqual([])
  })

  it('round-trips through export and import with its revision', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    ws.note = { text: 'Use fake timers', revision: 3, updatedAt: NOW }
    const out = path.join(await tempDir(), 'n.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const dst = await machine()
    const staged = await dst.portability.stage(out)
    if (staged.kind !== 'staged') throw new Error('expected a staged import')
    const imported = await dst.portability.importStaged(staged.preview.stageId, { repoId: dst.repo.id })
    expect(imported.note).toMatchObject({ text: 'Use fake timers', revision: 3 })
  })
})
