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

describe('a flow step’s persona', () => {
  it('joins the system prompt for that turn only, is receipted, and holds the turn read-only', async () => {
    const { h, requests } = await rig()
    h.sessions.markUnattended('turn-qa', { flowRunId: 'run-1', step: 'qa', persona: { name: 'qa-engineer', instructions: 'You find; you don’t fix.', readOnly: true } })
    await h.sessions.send(h.session.id, 'review it', { turnId: 'turn-qa' })
    await settled(h)

    const [req] = requests
    expect(req.systemPromptAppend).toContain('Prefer small diffs.')
    expect(req.systemPromptAppend).toContain('run as the persona “qa-engineer”. Its instructions:\nYou find; you don’t fix.')
    // Read-only for this turn, the way a read-only chat is: plan mode Claude can't leave.
    expect(req.readOnly).toBe(true)
    expect(req.planMode).toBe(true)
    const [msg] = await sentUsers(h)
    expect(msg.readOnly).toBe('plan')
    const part = msg.added!.find((p) => p.kind === 'persona')!
    expect(part).toMatchObject({ label: 'persona: qa-engineer', unit: 'chars', source: 'The persona this flow step runs as', detail: 'read-only for this turn' })
    // Its size is that of the text the agent was given.
    const given = 'This turn is a step of a Foreman flow, run as the persona “qa-engineer”. Its instructions:\nYou find; you don’t fix.'
    expect(req.systemPromptAppend!.endsWith(given)).toBe(true)
    expect(part.size).toBe(given.length)
    expect(receiptLine(msg.added)).toBe('Foreman added: standing instructions · persona: qa-engineer')
    // The chat itself isn't read-only, and the next turn carries no persona.
    expect(h.session.readOnly).toBeFalsy()
    await h.sessions.send(h.session.id, 'and now?')
    await settled(h)
    expect(requests[1].systemPromptAppend).not.toContain('qa-engineer')
    expect(requests[1].readOnly).toBeUndefined()
    expect((await sentUsers(h))[1].added?.map((p) => p.kind)).toEqual(['instructions'])
  })
})

describe('a flow step’s scoped writes', () => {
  it('reach the turn as its write scope, told to the agent, and never on a read-only turn', async () => {
    const { h, requests } = await rig()
    h.sessions.markUnattended('turn-pm', { flowRunId: 'run-1', step: 'requirements', persona: { name: 'product-manager', instructions: 'Decide what to build.', writes: ['docs/features/**'] } })
    await h.sessions.send(h.session.id, 'write the requirements', { turnId: 'turn-pm' })
    await settled(h)
    expect(requests[0].writeScope).toEqual(['docs/features/**'])
    expect(requests[0].readOnly).toBeUndefined()
    expect(requests[0].systemPromptAppend).toContain('This step may only write files inside docs/features/** (relative to the workspace root).')

    h.sessions.markUnattended('turn-ro', { flowRunId: 'run-1', step: 'look', persona: { name: 'looker', instructions: 'Look.', readOnly: true, writes: ['docs/**'] } })
    await h.sessions.send(h.session.id, 'look', { turnId: 'turn-ro' })
    await settled(h)
    expect(requests[1].writeScope).toBeUndefined()
    expect(requests[1].readOnly).toBe(true)
  })
})

describe('an attended flow step (read-only on Codex)', () => {
  it('waits for a person at an approval instead of being denied, and says so to the flow', async () => {
    const waiting: boolean[] = []
    const approvals: { id: string }[] = []
    const stopped: string[] = []
    let answer: unknown
    registerDriver(
      fakeDriver(async (_req, cb, signal) => {
        answer = await cb.approveTool({ kind: 'tool', toolName: 'Bash', input: { command: 'ls' } }, signal)
        cb.finished({ ok: true })
      })
    )
    const h = await setupSessions({
      events: { attendedApproval: (_s, w) => void waiting.push(w), approval: (r) => void approvals.push(r), unattendedStopped: (_s, what) => void stopped.push(what) }
    })
    h.sessions.markUnattended('turn-review', { flowRunId: 'run-1', step: 'review', attended: true })
    await h.sessions.send(h.session.id, 'review it', { turnId: 'turn-review' })
    await vi.waitFor(() => expect(approvals).toHaveLength(1))
    expect(waiting).toEqual([true])
    expect(stopped).toEqual([])
    await h.sessions.respondApproval(approvals[0].id, { kind: 'tool', allow: true })
    await settled(h)
    expect(answer).toMatchObject({ allow: true })
    expect(waiting).toEqual([true, false])
  })
})
