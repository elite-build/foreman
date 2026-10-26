import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { contextParts, pendingComments, receiptLine } from '../src/shared/context'
import { noteBlock } from '../src/shared/note'
import { commentsBlock } from '../src/shared/prompts'
import type { ChatItem, DiffComment } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))
type User = Extract<ChatItem, { kind: 'user' }>
type Harness = Awaited<ReturnType<typeof setupSessions>>

const comment = (id: string, file: string, line: number): DiffComment => ({ id, workspaceId: 'ws', file, line, body: `fix ${id}`, author: 'user', state: 'pending', createdAt: 'now' })

async function rig() {
  const requests: TurnRequest[] = []
  registerDriver(fakeDriver(async (req, cb) => (requests.push(req), cb.finished({ ok: true }))))
  const h = await setupSessions()
  // Standing instructions: the workspace context and the repository's general preferences.
  const workspaces = (h.sessions as unknown as { workspaces: Record<string, unknown> }).workspaces
  workspaces.agentContext = () => 'You are in a worktree.'
  workspaces.settingsFor = () => ({ prompts: { general: 'Prefer small diffs.' }, sensitivePaths: [] })
  return { h, requests }
}
const settled = async (h: Harness) => {
  await vi.waitFor(() => {
    expect(h.session.turnId).toBeUndefined()
    expect(h.session.status).toBe('idle')
    // Ending a turn saves a checkpoint and diffs it, which is slow under a busy suite.
  }, { timeout: 10_000 })
}
const sentUsers = async (h: Harness) => (await h.store.readChat(h.session.id)).filter((i): i is User => i.kind === 'user')

describe('the receipt of what Foreman added', () => {
  it('records the additions that were really handed to the agent', async () => {
    const { h, requests } = await rig()
    const file = path.join(h.ws.path!, 'ci-log.txt')
    await writeFile(file, 'x'.repeat(2048))
    h.store.state.comments.push(comment('c1', 'tests/a.ts', 88), comment('c2', 'tests/a.ts', 102))
    h.sessions.setNote(h.ws.id, 'Use fake timers')
    h.session.includeNote = true
    await h.sessions.send(h.session.id, 'fix it', { attachments: [{ name: 'ci-log.txt', path: file, kind: 'text' }] })
    await settled(h)

    const [req] = requests
    const [msg] = await sentUsers(h)
    expect(receiptLine(msg.added)).toBe('Foreman added: standing instructions · note r1 · 2 review comments · 1 attachment')
    const [instructions, note, comments, attachment] = msg.added!
    // Sizes are those of the strings the agent received.
    expect(instructions.size).toBe(req.systemPromptAppend!.length)
    expect(req.systemPromptAppend).toContain('Prefer small diffs.')
    expect(note.size).toBe(noteBlock(h.ws.note!).length)
    expect(req.prompt).toContain(noteBlock(h.ws.note!))
    const sentComments = h.store.state.comments
    expect(comments.size).toBe(commentsBlock(sentComments).length)
    expect(req.prompt).toContain(commentsBlock(sentComments))
    expect(comments.detail).toBe('tests/a.ts:88, tests/a.ts:102')
    expect(attachment).toMatchObject({ unit: 'bytes', size: 2048, detail: 'ci-log.txt' })
    expect(req.prompt).toContain('ci-log.txt')
    expect(msg.noteRevision).toBe(1)
  })

  it('adds no receipt when Foreman added nothing', async () => {
    const { h, requests } = await rig()
    const workspaces = (h.sessions as unknown as { workspaces: Record<string, unknown> }).workspaces
    workspaces.agentContext = () => ''
    workspaces.settingsFor = () => ({ prompts: { general: '' }, sensitivePaths: [] })
    await h.sessions.send(h.session.id, 'hello')
    await settled(h)
    expect(requests[0].prompt).toBe('hello')
    expect((await sentUsers(h))[0].added).toBeUndefined()
  })

  it("Don't include leaves the pending comments out of that message only", async () => {
    const { h, requests } = await rig()
    h.store.state.comments.push(comment('c1', 'a.ts', 1))
    expect(pendingComments(h.store.state.comments, 'ws')).toHaveLength(1)

    await h.sessions.send(h.session.id, 'first', { skipComments: true })
    await settled(h)
    expect(requests[0].prompt).toBe('first')
    expect(h.store.state.comments[0].state).toBe('pending')
    const [first] = await sentUsers(h)
    expect(first.added?.map((p) => p.kind)).toEqual(['instructions'])

    await h.sessions.send(h.session.id, 'second')
    await settled(h)
    expect(requests[1].prompt).toContain('fix c1')
    expect(h.store.state.comments[0].state).toBe('sent')
    expect((await sentUsers(h))[1].added?.map((p) => p.kind)).toEqual(['instructions', 'comments'])
  })
})

describe('describing additions', () => {
  it('says only what was added, with the right plural', () => {
    const parts = contextParts({
      instructions: '', hasStanding: false, noteText: '', commentsText: '\n\nx', comments: [{ file: 'a.ts', line: 3 }],
      attachmentText: '\n\ny', attachments: [{ name: 'a.png' }, { name: 'b.png' }]
    })
    expect(receiptLine(parts)).toBe('Foreman added: 1 review comment · 2 attachments')
    expect(parts[1]).toMatchObject({ unit: 'chars', size: 3 })
    expect(receiptLine([])).toBeNull()
    expect(receiptLine(undefined)).toBeNull()
  })
})
