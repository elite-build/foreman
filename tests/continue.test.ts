import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { HandOffService } from '../src/main/handOffs'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import { continueEligibility, continueFollowUp } from '../src/shared/handOff'
import { templateAfterEdit } from '../src/shared/promptTemplates'
import type { ChatItem, HandOffRequest, MessageFollowUp, PromptTemplate, Session, TurnOutcome, Workspace } from '../src/shared/types'
import { makeRepo, tempDir, waitFor } from './helpers'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

const FOLLOW: MessageFollowUp = { templateId: 'plan', title: 'Build', prompt: 'Implement the plan above.', model: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false } }
const user = (turnId: string, text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id: `user:${turnId}:${text.length}`, turnId, text, at: 'now', ...extra })
const answer = (turnId: string, text = 'the answer'): ChatItem => ({ kind: 'assistant', id: `a:${turnId}`, turnId, text })
const ended = (turnId: string, outcome: TurnOutcome = 'completed'): ChatItem => ({ kind: 'turn-end', id: `turn-end:${turnId}`, turnId, outcome })
const idle = (extra: Partial<Pick<Session, 'status' | 'queue' | 'lastTurn'>> = {}) => ({ status: 'idle' as const, queue: [], lastTurn: undefined, ...extra })

describe('continue visibility', () => {
  const done = [user('t1', 'q'), answer('t1'), ended('t1')]

  it('is offered for an idle chat whose latest turn completed with an answer', () => {
    expect(continueEligibility(idle(), done)).toEqual({ ok: true, turnId: 't1' })
    expect(continueEligibility(idle({ lastTurn: { outcome: 'completed', endedAt: 'x' } }), done).ok).toBe(true)
  })

  it('is not offered after a stop, an error or an interruption', () => {
    for (const outcome of ['cancelled', 'error', 'interrupted'] as const) {
      expect(continueEligibility(idle(), [user('t1', 'q'), answer('t1'), ended('t1', outcome)])).toMatchObject({ ok: false })
    }
    // The session's own record counts too.
    expect(continueEligibility(idle({ lastTurn: { outcome: 'error', endedAt: 'x' } }), done).ok).toBe(false)
  })

  it('is not offered while running, with queued messages, or with a newer message', () => {
    expect(continueEligibility(idle({ status: 'running' }), done).ok).toBe(false)
    expect(continueEligibility(idle({ queue: [{ id: 'q', text: 'later', attachments: [] }] }), done).ok).toBe(false)
    expect(continueEligibility(idle(), [...done, user('t2', 'newer')]).ok).toBe(false)
  })

  it('is not offered without a finished turn or an answer, and only for the latest answer', () => {
    expect(continueEligibility(idle(), [user('t1', 'q')]).ok).toBe(false)
    expect(continueEligibility(idle(), [user('t1', 'q'), ended('t1')]).ok).toBe(false)
    // Two turns: only the second turn's answer is the latest.
    const two = [...done, user('t2', 'next'), answer('t2'), ended('t2')]
    expect(continueEligibility(idle(), two)).toEqual({ ok: true, turnId: 't2' })
  })
})

describe('template follow-up provenance', () => {
  it('belongs to the answer to that message only', () => {
    const items = [user('t1', 'plan it', { followUp: FOLLOW }), answer('t1'), ended('t1'), user('t2', 'plain'), answer('t2'), ended('t2')]
    expect(continueFollowUp(items, 't1')).toEqual(FOLLOW)
    expect(continueFollowUp(items, 't2')).toBeNull()
  })

  it('is generic when the turn was steered, or the message is missing', () => {
    expect(continueFollowUp([user('t1', 'plan it', { followUp: FOLLOW }), user('t1', 'also this', { steered: true }), answer('t1')], 't1')).toBeNull()
    expect(continueFollowUp([answer('t1')], 't1')).toBeNull()
  })

  it('survives filling in placeholders and goes only when the draft is cleared', () => {
    expect(templateAfterEdit('plan', 'Fix {{bug id}}')).toBe('plan')
    expect(templateAfterEdit('plan', 'Fix ENG-42 and then some')).toBe('plan')
    expect(templateAfterEdit('plan', '   ')).toBeUndefined()
    expect(templateAfterEdit(undefined, 'typed by hand')).toBeUndefined()
  })
})

type Script = (req: TurnRequest, cb: TurnCallbacks) => Promise<void>

function install(script: Script, seen: TurnRequest[] = [], steer = false): void {
  const make = (base: AgentDriver): AgentDriver => ({
    ...base,
    createTurn: (req, cb) => {
      seen.push(req)
      return { run: () => script(req, cb), stop: async () => {}, steer: () => steer, setPlanMode: async () => {}, setModel: async () => {} }
    }
  })
  registerDriver(make(claudeDriver))
  registerDriver(make(codexDriver))
}

const reply = (text: string): Script => async (req, cb) => {
  cb.item({ kind: 'assistant', id: `assistant:${req.turnId}`, turnId: req.turnId, text })
  cb.finished({ ok: true })
}

async function setup(templates: PromptTemplate[] = [{ id: 'plan', name: 'Plan', body: 'Plan {{x}}', followUp: { title: 'Build', prompt: 'Implement the plan above.', model: FOLLOW.model } }]) {
  const root = await tempDir('foreman-continue-')
  const store = new Store(root)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  store.state.settings.promptTemplates = templates
  const dir = await makeRepo()
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: dir, portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
  const workspaces = { workspace: () => ws, env: () => ({}), settingsFor: () => ({ prompts: { general: '', codeReview: '', renameBranch: '' } }), agentContext: () => '' }
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, {
    changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {}
  })
  const handOffs = new HandOffService(store, sessions, workspaces as never)
  const session = sessions.createSession(ws.id, { agent: 'claude', title: 'work' })
  const chat = () => store.readChat(session.id)
  const userItems = async () => (await chat()).filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
  const finishTurn = async (n: number) => waitFor(async () => expect((await chat()).filter((i) => i.kind === 'turn-end')).toHaveLength(n))
  return { store, ws, sessions, handOffs, session, chat, userItems, finishTurn }
}

describe('follow-up carried by send()', () => {
  it('copies the template’s follow-up onto the user message when it is sent', async () => {
    install(reply('here is the plan'))
    const { sessions, session, userItems, finishTurn, store } = await setup()
    await sessions.send(session.id, 'Plan the migration', { templateId: 'plan' })
    await finishTurn(1)
    expect((await userItems())[0].followUp).toEqual(FOLLOW)
    // Editing the template afterwards leaves the sent message alone.
    store.state.settings.promptTemplates[0].followUp!.title = 'Ship'
    expect((await userItems())[0].followUp?.title).toBe('Build')
  })

  it('offers nothing for a template without a follow-up, or without a template', async () => {
    install(reply('ok'))
    const { sessions, session, userItems, finishTurn } = await setup([{ id: 'plain', name: 'Plain', body: 'x' }])
    await sessions.send(session.id, 'one', { templateId: 'plain' })
    await finishTurn(1)
    await sessions.send(session.id, 'two')
    await finishTurn(2)
    expect((await userItems()).map((i) => i.followUp)).toEqual([undefined, undefined])
  })

  it('keeps it through the queue', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    install(async (req, cb) => {
      if (calls++ === 0) await gate
      await reply('answer')(req, cb)
    })
    const { sessions, session, userItems, finishTurn } = await setup()
    const first = sessions.send(session.id, 'busy work')
    await waitFor(() => expect(session.status).toBe('running'))
    expect(await sessions.send(session.id, 'Plan the follow-up', { templateId: 'plan', mode: 'queue' })).toBe('queued')
    expect(session.queue[0]).toMatchObject({ templateId: 'plan', followUp: { title: 'Build' } })
    release()
    await first
    await finishTurn(2)
    const items = await userItems()
    expect(items.map((i) => i.followUp?.title)).toEqual([undefined, 'Build'])
  })

  it('drops it when the message is steered into a running turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const seen: TurnRequest[] = []
    install(async (req, cb) => {
      await gate
      await reply('answer')(req, cb)
    }, seen, true)
    const { sessions, session, userItems, finishTurn, chat } = await setup()
    void sessions.send(session.id, 'Plan the first part', { templateId: 'plan' })
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(await sessions.send(session.id, 'Plan it differently', { templateId: 'plan', mode: 'steer' })).toBe('steered')
    release()
    await finishTurn(1)
    const items = await userItems()
    expect(items.find((i) => i.steered)?.followUp).toBeUndefined()
    // The turn now has a steered message, so its answer gets the generic action.
    expect(items.find((i) => !i.steered)?.followUp).toBeDefined()
    expect(continueFollowUp(await chat(), items[0].turnId)).toBeNull()
  })

  it('goes away with a rewind past the message', async () => {
    install(reply('answer'))
    const { sessions, session, chat, finishTurn } = await setup()
    await sessions.send(session.id, 'first question')
    await finishTurn(1)
    await sessions.send(session.id, 'Plan the migration', { templateId: 'plan' })
    await finishTurn(2)
    let items = await chat()
    expect(continueEligibility(session, items)).toMatchObject({ ok: true })
    const second = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && Boolean(i.followUp))!
    expect(continueFollowUp(items, second.turnId)).toEqual(FOLLOW)
    await sessions.restore(session.id, second.turnId)
    items = await chat()
    expect(items.some((i) => i.kind === 'user' && i.followUp)).toBe(false)
    expect(continueFollowUp(items, second.turnId)).toBeNull()
    // What is left is the first, plain answer.
    const eligibility = continueEligibility(session, items)
    expect(eligibility).toMatchObject({ ok: true })
    expect(continueFollowUp(items, eligibility.ok ? eligibility.turnId : '')).toBeNull()
  })
})

describe('continue in another chat', () => {
  async function ready() {
    const seen: TurnRequest[] = []
    install(reply('here is the plan'), seen)
    const ctx = await setup()
    await ctx.sessions.send(ctx.session.id, 'Plan the migration', { templateId: 'plan' })
    await ctx.finishTurn(1)
    const request = async (edit: Partial<HandOffRequest> = {}): Promise<HandOffRequest> => {
      const preview = await ctx.handOffs.prepare(ctx.session.id, 'continue')
      return {
        kind: 'continue',
        model: preview.model,
        message: preview.message,
        answer: true,
        diff: false,
        expect: { answer: preview.answer?.hash },
        ...edit
      }
    }
    return { ...ctx, seen, request }
  }

  it('previews the labelled follow-up with its prompt and model, and the answer as context', async () => {
    const { handOffs, session } = await ready()
    const preview = await handOffs.prepare(session.id, 'continue')
    expect(preview.blocked).toBeUndefined()
    expect(preview.followUp).toMatchObject({ title: 'Build', prompt: 'Implement the plan above.' })
    expect(preview.message).toBe('Implement the plan above.')
    expect(preview.model).toEqual(FOLLOW.model)
    expect(preview.answer?.bytes).toBeGreaterThan(0)
  })

  it('uses the generic prompt and this chat’s model without a follow-up', async () => {
    install(reply('done'))
    const { sessions, session, finishTurn, handOffs } = await setup()
    await sessions.send(session.id, 'just a question')
    await finishTurn(1)
    const preview = await handOffs.prepare(session.id, 'continue')
    expect(preview.followUp).toBeUndefined()
    expect(preview.message).toBe('Continue from this context:')
    expect(preview.model).toMatchObject({ agent: 'claude', model: session.model })
  })

  it('starts a new chat with the answer, and runs nothing until then', async () => {
    const { handOffs, session, request, open, seen } = await (async () => {
      const r = await ready()
      return { ...r, open: () => r.store.state.sessions.filter((s) => !s.closedAt) }
    })()
    expect(seen).toHaveLength(1)
    expect(open()).toHaveLength(1)
    const result = await handOffs.start(session.id, await request())
    expect('session' in result).toBe(true)
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1].prompt).toContain('Implement the plan above.')
    expect(seen[1].prompt).toContain('## Last answer from')
    expect(seen[1].resume).toBeUndefined()
    expect(open()).toHaveLength(2)
  })

  it('is blocked, and refused at Start, once the source is no longer eligible', async () => {
    const { handOffs, session, request, open, store, chat } = await (async () => {
      const r = await ready()
      return { ...r, open: () => r.store.state.sessions.filter((s) => !s.closedAt) }
    })()
    const req = await request()
    // A message queued since the preview.
    session.queue.push({ id: 'q', text: 'later', attachments: [] })
    expect(await handOffs.start(session.id, req)).toMatchObject({ stale: expect.stringContaining('queued') })
    expect((await handOffs.prepare(session.id, 'continue')).blocked).toContain('queued')
    session.queue = []
    // The turn is running again.
    session.status = 'running'
    expect(await handOffs.start(session.id, req)).toMatchObject({ stale: expect.stringContaining('working') })
    session.status = 'idle'
    // A later turn was cancelled.
    await store.appendChat(session.id, user('t9', 'again'))
    await store.appendChat(session.id, ended('t9', 'cancelled'))
    expect(await handOffs.start(session.id, req)).toMatchObject({ stale: expect.any(String) })
    expect((await chat()).length).toBeGreaterThan(0)
    expect(open()).toHaveLength(1)
  })
})
