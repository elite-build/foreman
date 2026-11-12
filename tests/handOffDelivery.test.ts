// Switching agents and accounts with a recorded hand-off (docs/agents.md 5.1-5.4), through the real SessionService with
// fake drivers: the record written on the switch notice, the strategy chosen for each case, the budget setting, the
// account move, read_chat_history reading only its own chat, and the moves that are blocked before anything changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { staticCapabilities } from '../src/shared/agentCatalog'
import type { AgentInstance } from '../src/shared/agentInstances'
import type { AgentKind } from '../src/shared/agents'
import type { ChatHandOff } from '../src/shared/chatHandOff'
import { accountBlocked, cloudAccountBlocked, continueBlock } from '../src/shared/switchAgent'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

// Each test makes a real Git repository, which is slow when the whole suite is running.
vi.setConfig({ testTimeout: 90_000 })

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type User = Extract<ChatItem, { kind: 'user' }>
type Notice = Extract<ChatItem, { kind: 'notice' }>
type Sent = TurnRequest & { agent: AgentKind }

function agents() {
  const requests: Sent[] = []
  for (const agent of ['claude', 'codex'] as const) {
    registerDriver({
      ...fakeDriver(async (req, cb) => {
        requests.push({ ...req, agent })
        const n = requests.length
        cb.sessionStarted(req.resume ?? `native-${agent}`)
        cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `${agent} answer ${n}` })
        if (agent === 'claude') cb.assistantMessage(`a${n}`)
        cb.item({ kind: 'result', id: `${req.turnId}:r`, turnId: req.turnId, ok: true })
        cb.finished({ ok: true })
      }),
      kind: agent
    })
  }
  return requests
}

const tab = (h: Harness, id = h.session.id) => h.store.state.sessions.find((s) => s.id === id)!
const idle = (h: Harness, id = h.session.id) =>
  vi.waitFor(() => {
    expect(tab(h, id).status).toBe('idle')
    expect(tab(h, id).turnId).toBeUndefined()
  }, { timeout: 10_000 })
async function say(h: Harness, text: string, id = h.session.id) {
  await h.sessions.send(id, text)
  await idle(h, id)
  return (await h.store.readChat(id)).filter((i): i is User => i.kind === 'user').at(-1)!
}
const notices = async (h: Harness, id = h.session.id) => (await h.store.readChat(id)).filter((i): i is Notice => i.kind === 'notice')
const recordOf = (n: Notice): ChatHandOff | undefined => n.switched?.handOff ?? n.handOff

describe('the record on a switch notice', () => {
  it('is worked out when the tab switches, and written again with the turn that carried it', async () => {
    agents()
    const h = await setupSessions()
    const first = await say(h, 'first question')
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })

    // At the switch: who, how, how big, which turns (the notice and `foreman chat switch` show it), with no turn yet.
    const [notice] = await notices(h)
    const preview = notice.switched!.handOff!
    expect(preview).toMatchObject({ strategy: 'prompt-full', budgetTokens: 16_000, full: [first.turnId], condensed: [], omitted: [] })
    expect(preview.from).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5[1m]' })
    expect(preview.to).toEqual({ agent: 'codex', model: 'gpt-6.1-sol' })
    expect(preview.turnId).toBeUndefined()
    expect(preview.usedTokens).toBeGreaterThan(0)
    expect(preview.turns).toMatchObject([{ id: first.turnId, n: 1, agent: 'claude', request: 'first question' }])

    // The first turn that carries it writes it on the same notice, with that turn's id.
    const second = await say(h, 'second question')
    const [written] = await notices(h)
    expect(written.id).toBe(notice.id)
    expect(recordOf(written)).toEqual({ ...preview, turnId: second.turnId })
    expect(tab(h).handOffPending).toBeUndefined()
    // The chat's notice list still has one notice for the switch (the record is on it, not beside it).
    expect(await notices(h)).toHaveLength(1)
  })

  it('records a delta and resume-delta on the way back, with only what the agent missed', async () => {
    const requests = agents()
    const h = await setupSessions()
    const claudeTurn = await say(h, 'claude one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    const codexTwo = await say(h, 'codex two')
    const codexThree = await say(h, 'codex three')
    await h.sessions.updateSession(h.session.id, { agent: 'claude', model: 'claude-opus-5-5[1m]' })
    const back = await say(h, 'claude, your view?')

    const records = (await notices(h)).map(recordOf)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      strategy: 'resume-delta',
      sinceTurn: claudeTurn.turnId,
      turnId: back.turnId,
      full: [codexTwo.turnId, codexThree.turnId],
      from: { agent: 'codex' },
      to: { agent: 'claude' }
    })
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', resume: 'native-claude' })
    expect(requests.at(-1)!.prompt).toContain('### Turn 2 · Codex (GPT-6.1 Sol)')
    expect(requests.at(-1)!.prompt).not.toContain('claude one')
  })

  it('a chat with no messages just changes agent: no notice, no record', async () => {
    agents()
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    expect(await notices(h)).toEqual([])
    expect(tab(h).handOffPending).toBeUndefined()
  })

  it('writes the record even when nothing was said since the agent left (an empty delta)', async () => {
    const requests = agents()
    const h = await setupSessions()
    await say(h, 'one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    const turn = await say(h, 'two')
    const last = (await notices(h)).map(recordOf).at(-1)!
    expect(last).toMatchObject({ strategy: 'resume-delta', turnId: turn.turnId, full: [], omitted: [] })
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', resume: 'native-claude', prompt: 'two' })
  })
})

describe('the size setting', () => {
  it('gives the next agent no more than handOffTokenBudget, names what was left out, and says how to read it', async () => {
    const requests = agents()
    const h = await setupSessions()
    h.store.state.settings.handOffTokenBudget = 1_024
    for (let n = 1; n <= 12; n++) await say(h, `question ${n} ${'q'.repeat(700)}`)
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const sent = await say(h, 'go')
    const record = recordOf((await notices(h))[0])!
    expect(record.budgetTokens).toBe(1_024)
    expect(record.usedTokens).toBeLessThanOrEqual(1_024)
    expect(record.omitted.length).toBeGreaterThan(0)
    expect(record.turnId).toBe(sent.turnId)
    // Codex takes Foreman's tools, so it is told how to read what was left out.
    const prompt = requests.at(-1)!.prompt
    expect(prompt).toContain('left out')
    expect(prompt).toContain('read_chat_history')
    expect(prompt).toContain('### Turn 12 · Claude Code')
    // The receipt's size is the text that went.
    expect(sent.added!.find((p) => p.kind === 'history')!.detail).toBeDefined()
  })

  it('keeps the budget inside its limits when the setting holds something else', async () => {
    agents()
    const h = await setupSessions()
    h.store.state.settings.handOffTokenBudget = 5
    await say(h, 'one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    expect(recordOf((await notices(h))[0])!.budgetTokens).toBe(1_024)
  })
})

describe('moving to another account', () => {
  const work: AgentInstance = { id: 'ai-work0001', agent: 'claude', label: 'Work', home: '/accounts/claude-work', auth: 'cli' }

  it('under “as text” starts a new conversation there and records what it was given', async () => {
    const requests = agents()
    const h = await setupSessions()
    h.store.state.settings.agentInstances = [work]
    h.store.state.settings.agentPrefs = { claude: { moveChats: 'as-text' } }
    const first = await say(h, 'first question')
    await h.sessions.updateSession(h.session.id, { instanceId: work.id })
    const [notice] = await notices(h)
    expect(notice.switched).toBeUndefined()
    expect(notice.handOff).toMatchObject({ strategy: 'prompt-full', full: [first.turnId], from: { agent: 'claude' }, to: { agent: 'claude', instance: work.id } })
    expect(notice.handOff!.turnId).toBeUndefined()
    const turn = await say(h, 'go on')
    expect(requests.at(-1)!.prompt).toContain('### Turn 1 · Claude Code')
    const [written] = await notices(h)
    expect(written.handOff).toMatchObject({ turnId: turn.turnId, strategy: 'prompt-full' })
    expect(tab(h).handOffPending).toBeUndefined()
  })

  it('writes no record when the same conversation goes on (nothing is handed over)', async () => {
    agents()
    const h = await setupSessions()
    // Two accounts that share a config folder keep one conversation.
    h.store.state.settings.agentInstances = [{ ...work, home: undefined }]
    await say(h, 'first')
    await h.sessions.updateSession(h.session.id, { instanceId: work.id })
    const [notice] = await notices(h)
    expect(notice.handOff).toBeUndefined()
    expect(tab(h).handOffPending).toBeUndefined()
  })
})

describe('moves that are blocked, said before anything changes', () => {
  const session = (over: Partial<Session> = {}) => ({ agent: 'claude', agentSessionId: 'conv', status: 'idle', ...over }) as Pick<Session, 'agent' | 'instanceId' | 'agentSessionId' | 'parked' | 'status' | 'readOnly' | 'importedMode' | 'turnId'>
  const work: AgentInstance = { id: 'ai-work0001', agent: 'claude', label: 'Work', home: '/accounts/claude-work', auth: 'cli' }
  const team: AgentInstance = { id: 'ai-team0001', agent: 'codex', label: 'Team', home: '/accounts/codex-team', auth: 'cli' }

  it('account: another account of the agent, under moveChats never; a new conversation takes any account', () => {
    const never = () => 'never' as const
    expect(accountBlocked(session(), { agent: 'claude', instance: work.id }, [work], never)).toBe(true)
    // The default rule is the same as never.
    expect(accountBlocked(session(), { agent: 'claude', instance: work.id }, [work])).toBe(true)
    expect(accountBlocked(session(), { agent: 'claude', instance: work.id }, [work], () => 'as-text')).toBe(false)
    // Nothing to move yet: no conversation of its own.
    expect(accountBlocked(session({ agentSessionId: undefined }), { agent: 'claude', instance: work.id }, [work], never)).toBe(false)
    // Another agent with nothing parked starts a new conversation, on any account.
    expect(accountBlocked(session(), { agent: 'codex', instance: team.id }, [team], never)).toBe(false)
    // Coming back to a parked conversation on another account is the same question.
    const parked = session({ parked: { codex: { agentSessionId: 'codex-conv', instanceId: undefined } } })
    expect(accountBlocked(parked, { agent: 'codex', instance: team.id }, [team], never)).toBe(true)
    expect(accountBlocked(parked, { agent: 'codex', instance: team.id }, [team], () => 'as-text')).toBe(false)
    // The default account (no instance asked for) never moves a parked conversation.
    expect(accountBlocked(parked, { agent: 'codex' }, [team], never)).toBe(false)
  })

  it('cloud: a remote workspace takes only the default account', () => {
    expect(cloudAccountBlocked(true, { instance: work.id })).toBe(true)
    expect(cloudAccountBlocked(true, {})).toBe(false)
    expect(cloudAccountBlocked(false, { instance: work.id })).toBe(false)
  })

  it('continueBlock gives the reason, in order: history, running, read-only, cloud, account', () => {
    const idleSession = { status: 'idle' } as const
    const codex = staticCapabilities('codex')
    expect(continueBlock(idleSession, codex, true, true)).toBe('cloud')
    expect(continueBlock(idleSession, codex, true)).toBe('account')
    expect(continueBlock(idleSession, codex, false, true)).toBe('cloud')
    expect(continueBlock({ status: 'running' }, codex, true, true)).toBe('running')
    expect(continueBlock({ ...idleSession, readOnly: true }, staticCapabilities('cursor'), false, true)).toBe('read-only')
    expect(continueBlock({ ...idleSession, importedMode: 'history' }, codex, true, true)).toBe('history')
    expect(continueBlock(idleSession, codex)).toBeNull()
  })

  it('a remote workspace refuses a chosen account before changing the chat', async () => {
    agents()
    const h = await setupSessions()
    h.store.state.settings.agentInstances = [work]
    await say(h, 'one')
    ;(h.ws as Workspace).cloud = {} as never
    const before = { ...tab(h) }
    await expect(h.sessions.updateSession(h.session.id, { instanceId: work.id })).rejects.toThrow(/cloud workspace runs on the agent’s default account/)
    await expect(h.sessions.updateSession(h.session.id, { agent: 'codex', instanceId: work.id })).rejects.toThrow(/cloud workspace/)
    expect(tab(h)).toEqual(before)
    expect(await notices(h)).toEqual([])
  })
})

describe('read_chat_history', () => {
  it('reads turns of the calling turn’s own chat, never another one', async () => {
    agents()
    // A second chat is named by its first message, which asks the workspace for its prompts.
    const h = await setupSessions({ workspaces: { settingsFor: () => ({ prompts: { general: '', renameBranch: '' }, sensitivePaths: [] }) } })
    const other = h.sessions.createSession(h.ws.id, { agent: 'claude' })
    await say(h, 'secret of chat A')
    await say(h, 'secret of chat B', other.id)
    const mine = await h.sessions.readChatHistory(h.session.id, { turns: [1] })
    expect(mine.returned).toEqual([1])
    expect(mine.text).toContain('secret of chat A')
    expect(mine.text).not.toContain('secret of chat B')
    const theirs = await h.sessions.readChatHistory(other.id, { from: 1 })
    expect(theirs.text).toContain('secret of chat B')
    expect(theirs.text).not.toContain('secret of chat A')
    // A turn number past this chat's end is the chat's, not the next chat's.
    expect((await h.sessions.readChatHistory(h.session.id, { turns: [2] })).missing).toEqual([2])
    await expect(h.sessions.readChatHistory('no-such-chat', {})).rejects.toThrow()
  })

  it('numbers turns the way the record does, so a left-out turn is read by its number', async () => {
    agents()
    const h = await setupSessions()
    h.store.state.settings.handOffTokenBudget = 1_024
    const turns: User[] = []
    for (let n = 1; n <= 10; n++) turns.push(await say(h, `question ${n} ${'q'.repeat(700)}`))
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const record = recordOf((await notices(h))[0])!
    const omitted = record.turns.filter((t) => record.omitted.includes(t.id))
    expect(omitted.length).toBeGreaterThan(0)
    const read = await h.sessions.readChatHistory(h.session.id, { turns: omitted.map((t) => t.n) })
    expect(read.returned).toEqual(omitted.map((t) => t.n))
    expect(read.text).toContain(`question ${omitted[0].n} `)
    expect(turns[omitted[0].n - 1].text).toContain(`question ${omitted[0].n} `)
  })
})
