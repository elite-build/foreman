import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { HandOffService } from '../src/main/handOffs'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import {
  assembleHandOff,
  compactModelLabel,
  defaultTask,
  lastAnswer,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_BYTES,
  MAX_OPEN_TABS,
  placeSections,
  sizeLine,
  truncateBytes,
  userTasks
} from '../src/shared/handOff'
import { permissionNote } from '../src/shared/permissions'
import type { ChatItem, HandOffPreview, HandOffRequest, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

const user = (turnId: string, text: string, steered = false): ChatItem => ({ kind: 'user', id: `user:${turnId}${steered ? ':s' : ''}`, turnId, text, at: 'now', steered })
const assistant = (turnId: string, text: string): ChatItem => ({ kind: 'assistant', id: `a:${turnId}:${text.length}`, turnId, text })

describe('hand-off context', () => {
  it('keeps small sections inline and attaches what does not fit', () => {
    const kb = (n: number) => n * 1024
    const placed = placeSections([
      { kind: 'task', bytes: kb(1) },
      { kind: 'answer', bytes: kb(30) },
      { kind: 'diff', bytes: kb(20) }
    ])
    expect(placed.map((p) => p.where)).toEqual(['inline', 'inline', 'attached'])
    expect(placed.every((p) => !p.truncated)).toBe(true)
    // Exactly the limit still fits.
    expect(placeSections([{ kind: 'diff', bytes: MAX_INLINE_BYTES }])[0].where).toBe('inline')
    // A section past the attachment cap is cut, and says so.
    const huge = placeSections([{ kind: 'diff', bytes: MAX_ATTACHMENT_BYTES + 5 }])[0]
    expect(huge).toMatchObject({ where: 'attached', truncated: true, bytes: MAX_ATTACHMENT_BYTES })
  })

  it('assembles the message, inline sections and labelled attachments', () => {
    const small = assembleHandOff('Look at this', [
      { kind: 'task', label: 'Task', text: 'fix the flake' },
      { kind: 'answer', label: 'Last answer from Opus 5.5', text: 'done' }
    ])
    expect(small.attachments).toEqual([])
    expect(small.text).toBe('Look at this\n\n## Task\n\nfix the flake\n\n## Last answer from Opus 5.5\n\ndone')

    const big = 'x'.repeat(MAX_ATTACHMENT_BYTES + 100)
    const out = assembleHandOff('Review', [
      { kind: 'task', label: 'Task', text: 'short' },
      { kind: 'diff', label: 'Diff against main', text: big }
    ])
    expect(out.text).toContain('## Task')
    expect(out.text).not.toContain(big)
    expect(out.text).toContain('Diff against main: attached as “Diff against main (truncated).md”')
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments[0]).toMatchObject({ name: 'Diff against main (truncated).md', truncated: true })
    expect(out.attachments[0].content).toContain('[Truncated:')
    expect(out.totalBytes).toBe(5 + MAX_ATTACHMENT_BYTES)
  })

  it('truncates on a character boundary', () => {
    expect(truncateBytes('héllo', 2)).toBe('h')
    expect(truncateBytes('héllo', 3)).toBe('hé')
    expect(truncateBytes('abc', 10)).toBe('abc')
  })

  it('reads the task and answer out of the chat, ignoring steered messages', () => {
    const items: ChatItem[] = [
      user('t1', 'first'),
      assistant('t1', 'a1'),
      user('t2', 'second'),
      user('t2', 'actually also this', true),
      assistant('t2', 'a2 text'),
      { kind: 'assistant', id: 'a:t2:stream', turnId: 't2', text: 'partial', streaming: true }
    ]
    const tasks = userTasks(items)
    expect(tasks.map((t) => t.text)).toEqual(['first', 'second'])
    const answer = lastAnswer(items)
    expect(answer).toMatchObject({ turnId: 't2', text: 'a2 text' })
    expect(defaultTask(tasks, answer)).toBe('t2')
    expect(defaultTask(tasks, null)).toBe('t2')
    expect(lastAnswer([user('t1', 'x')])).toBeNull()
  })

  it('describes size, destination and the target’s real permissions', () => {
    const line = sizeLine(placeSections([{ kind: 'diff', bytes: 14 * 1024 }]), 'codex')
    expect(line).toBe('~14 KB → OpenAI (Codex)')
    expect(sizeLine(placeSections([{ kind: 'diff', bytes: 50 * 1024 }]), 'claude')).toBe('~50 KB → Anthropic (Claude Code) · 1 as an attachment')
    const base = { requireToolApprovals: true, codexApprovals: 'sandboxed' as const, autoPermissionMode: false }
    expect(permissionNote('codex', base)).toContain('tools run without approval')
    expect(permissionNote('claude', base)).toBe('asks before running tools')
    expect(permissionNote('claude', { ...base, requireToolApprovals: false })).toBe('tools run without approval')
  })

  it('labels tabs with the short model name', () => {
    expect(compactModelLabel('claude', 'claude-opus-5-5[1m]')).toBe('Opus')
    expect(compactModelLabel('codex', 'gpt-6.1-sol')).toBe('GPT-6.1')
  })
})

type Script = (req: TurnRequest, cb: TurnCallbacks) => Promise<void>

/** Stand-ins for Claude and Codex that run the script instead of an agent. */
function fakeDriver(script: Script, seen: TurnRequest[] = []): AgentDriver {
  for (const base of [codexDriver]) registerDriver(driver(base, script, seen))
  return driver(claudeDriver, script, seen)
}

function driver(base: AgentDriver, script: Script, seen: TurnRequest[]): AgentDriver {
  return {
    ...base,
    createTurn: (req, cb) => {
      seen.push(req)
      return { run: () => script(req, cb), stop: async () => {}, steer: () => false, setPlanMode: async () => {}, setModel: async () => {} }
    }
  }
}

async function setup() {
  const root = await tempDir('foreman-handoff-')
  const store = new Store(root)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const dir = await makeRepo()
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: dir, portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
  const workspaces = {
    workspace: () => ws,
    env: () => ({}),
    settingsFor: () => ({ prompts: { general: '', codeReview: '', renameBranch: '' } }),
    agentContext: () => ''
  }
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, {
    changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {}
  })
  const handOffs = new HandOffService(store, sessions, workspaces as never)
  const source = sessions.createSession(ws.id, { agent: 'claude', title: 'work' })
  await store.appendChat(source.id, user('t1', 'Fix the flaky test'))
  await store.appendChat(source.id, assistant('t1', 'I fixed it by awaiting the fixture.'))
  await writeFile(path.join(dir, 'change.txt'), 'one\ntwo\n')
  const open = () => store.state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const request = async (kind: HandOffRequest['kind'] = 'second-opinion', edit: (p: HandOffPreview) => Partial<HandOffRequest> = () => ({})): Promise<HandOffRequest> => {
    const preview = await handOffs.prepare(source.id, kind)
    return {
      kind,
      model: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false },
      message: preview.message,
      taskTurnId: preview.defaultTaskTurnId,
      answer: true,
      diff: true,
      expect: { task: preview.tasks.find((t) => t.turnId === preview.defaultTaskTurnId)?.hash, answer: preview.answer?.hash, diff: preview.diff?.hash },
      ...edit(preview)
    }
  }
  return { store, ws, sessions, handOffs, source, open, request, dir }
}

describe('second opinion', () => {
  it('previews the task, answer and diff with the answer’s task selected', async () => {
    const { handOffs, source } = await setup()
    const preview = await handOffs.prepare(source.id, 'second-opinion')
    expect(preview.tasks.map((t) => t.label)).toEqual(['Fix the flaky test'])
    expect(preview.defaultTaskTurnId).toBe('t1')
    expect(preview.answer?.bytes).toBeGreaterThan(0)
    expect(preview.diff).toMatchObject({ files: 1, additions: 2, stat: false })
    expect(preview.model).toEqual(handOffs['store'].state.settings.reviewModel)
  })

  it('opens a new tab on the chosen model with the context in the first message, and never forks', async () => {
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true }), seen))
    const { handOffs, source, open, request, store } = await setup()
    const result = await handOffs.start(source.id, await request())
    expect('session' in result).toBe(true)
    if (!('session' in result)) return
    expect(open()).toHaveLength(2)
    expect(result.session).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', title: 'Second opinion', planMode: false })
    expect(result.session.agentSessionId).toBeUndefined()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].resume).toBeUndefined()
    expect(seen[0].prompt).toContain('## Task\n\nFix the flaky test')
    expect(seen[0].prompt).toContain('I fixed it by awaiting the fixture.')
    expect(seen[0].prompt).toContain('+two')
    const chat = await store.readChat(result.session.id)
    const first = chat.find((i) => i.kind === 'user')
    expect(first && first.kind === 'user' && first.resumeFrom).toBeUndefined()
  })

  it('attaches context over the inline limit', async () => {
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true }), seen))
    const { handOffs, source, request, dir } = await setup()
    await writeFile(path.join(dir, 'big.txt'), 'line of text\n'.repeat(6000))
    const result = await handOffs.start(source.id, await request())
    expect('session' in result).toBe(true)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].prompt).toContain('Too long to include here')
    expect(seen[0].prompt).toContain('Diff against main')
    expect(seen[0].prompt).toContain('The user attached these files')
    expect(seen[0].prompt.length).toBeLessThan(MAX_INLINE_BYTES + 2000)
  })

  it('starts one chat however many times Start is pressed', async () => {
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true })))
    const { handOffs, source, open, request } = await setup()
    const req = await request()
    const [a, b, c] = await Promise.all([handOffs.start(source.id, req), handOffs.start(source.id, req), handOffs.start(source.id, req)])
    expect(open()).toHaveLength(2)
    expect(a).toBe(b)
    expect(b).toBe(c)
    // Once it has finished, starting again is a new request.
    await handOffs.start(source.id, await request())
    expect(open()).toHaveLength(3)
  })

  it('refuses at the tab limit without creating anything', async () => {
    const { handOffs, sessions, source, open, request, ws } = await setup()
    const req = await request()
    while (open().length < MAX_OPEN_TABS) sessions.createSession(ws.id)
    await expect(handOffs.start(source.id, req)).rejects.toThrow(/Maximum of 10 chats/)
    expect(open()).toHaveLength(MAX_OPEN_TABS)
  })

  it('says stale, and starts nothing, when the source was rewound since the preview', async () => {
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true })))
    const { handOffs, source, open, request, store } = await setup()
    const req = await request()
    await store.replaceChat(source.id, [user('t1', 'Fix the flaky test')])
    const gone = await handOffs.start(source.id, req)
    expect(gone).toMatchObject({ stale: expect.stringContaining('last answer') })
    // A different answer is just as stale.
    await store.replaceChat(source.id, [user('t1', 'Fix the flaky test'), assistant('t1', 'a different answer')])
    expect(await handOffs.start(source.id, req)).toMatchObject({ stale: expect.any(String) })
    // So is a task that was rewound away.
    await store.replaceChat(source.id, [])
    expect(await handOffs.start(source.id, req)).toMatchObject({ stale: expect.stringContaining('rewound') })
    expect(open()).toHaveLength(1)
  })

  it('says stale when the files changed since the preview', async () => {
    const { handOffs, source, open, request, dir } = await setup()
    const req = await request()
    await writeFile(path.join(dir, 'change.txt'), 'edited since\n')
    expect(await handOffs.start(source.id, req)).toMatchObject({ stale: expect.stringContaining('files') })
    expect(open()).toHaveLength(1)
  })

  it('leaves no orphan tab when the send fails', async () => {
    const { handOffs, source, open, request, ws } = await setup()
    const req = await request()
    ws.state = 'creating'
    await expect(handOffs.start(source.id, req)).rejects.toThrow(/not ready/)
    expect(open()).toHaveLength(1)
    // The failed attempt doesn't block the next one.
    ws.state = 'ready'
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true })))
    expect('session' in (await handOffs.start(source.id, req))).toBe(true)
    expect(open()).toHaveLength(2)
  })

  it('review keeps its instructions attached and needs no ticked context', async () => {
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true }), seen))
    const { handOffs, source, request } = await setup()
    const req = await request('review', () => ({ taskTurnId: undefined, answer: false, diff: false, expect: {} }))
    const result = await handOffs.start(source.id, req)
    expect('session' in result && result.session.title).toBe('Code review')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].prompt).toContain('Please review the changes in this workspace.')
    expect(seen[0].prompt).toContain('Review request.md')
  })
})

describe('plan hand-off', () => {
  it('still works while the source waits on the plan, through the same path', async () => {
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (_r, cb) => cb.finished({ ok: true }), seen))
    const { sessions, source, open } = await setup()
    // The source is mid-turn, waiting for the plan to be approved.
    source.status = 'running'
    const waiting = (sessions as unknown as { requestApproval(id: string, request: object, signal: AbortSignal): Promise<unknown> }).requestApproval(
      source.id,
      { kind: 'plan', plan: '# The plan' },
      new AbortController().signal
    )
    const [request] = sessions.pendingApprovals()
    await sessions.respondApproval(request.id, { kind: 'plan', approve: false, handOff: true })
    await waiting
    expect(open()).toHaveLength(2)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].prompt).toContain('Implement the attached plan.')
    expect(seen[0].prompt).toContain('plan.md')
    expect(seen[0].resume).toBeUndefined()
  })
})
