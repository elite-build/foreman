// O1: switching agent mid-conversation.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentTurn, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { TurnHost } from '../src/main/sessions'
import { searchChats } from '../src/main/chatSearch'
import { staticCapabilities } from '../src/shared/agentCatalog'
import type { AgentKind } from '../src/shared/agents'
import { buildHandOff, renderHandOff } from '../src/shared/chatHandOff'
import { MAX_FORK_HISTORY_CHARS } from '../src/shared/fork'
import { chatToMarkdown } from '../src/shared/transcript'
import {
  continueBlock,
  isMixed,
  modelChoiceAction,
  otherAgentTurns,
  planControl,
  turnAuthors
} from '../src/shared/switchAgent'
import type { ChatItem, Session } from '../src/shared/types'
import { workspaceUsage } from '../src/shared/usage'
import { usageReport } from '../src/shared/usageReport'
import { tempDir } from './helpers'
import { machine, seed } from './portabilityRig'
import { fakeDriver, setupSessions } from './sessionHarness'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type User = Extract<ChatItem, { kind: 'user' }>
type Sent = TurnRequest & { agent: AgentKind }

/**
 * Claude and Codex stand-ins. Each turn answers "<agent> answer N" as its own conversation (`native-claude`,
 * `native-codex`) unless resumed; Claude reports assistant uuids and a cost, Codex neither. Requests are collected.
 * Only `h`'s turns count: a test that timed out keeps sending through whichever drivers are registered, and its
 * turns must not number or answer the next test's.
 */
function bothAgents(h: Harness) {
  const requests: Sent[] = []
  for (const agent of ['claude', 'codex', 'cursor'] as const) {
    registerDriver({
      ...fakeDriver(async (req, cb) => {
        if (req.cwd !== h.ws.path) return cb.finished({ ok: true })
        requests.push({ ...req, agent })
        const n = requests.length
        cb.sessionStarted(req.resume ?? `native-${agent}`)
        cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `${agent} answer ${n}` })
        if (agent === 'claude') cb.assistantMessage(`a${n}`)
        cb.item({ kind: 'result', id: `${req.turnId}:r`, turnId: req.turnId, ok: true, costUsd: agent === 'claude' ? 0.1 : undefined })
        cb.finished({ ok: true })
      }),
      kind: agent
    })
  }
  return requests
}

// Up to a dozen real turns a test, each with git work: give them room on a busy machine.
const TURNS_BUDGET = 90_000

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

const switches = async (h: Harness) =>
  (await h.store.readChat(h.session.id)).flatMap((i) => (i.kind === 'notice' && i.switched ? [{ ...i.switched, text: i.text }] : []))

describe('switching agent in a chat', { timeout: TURNS_BUDGET }, () => {
  it('continues in the same tab: a divider, and the new agent gets the visible history as text', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    await say(h, 'first question')
    await say(h, 'second question')

    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    expect(tab(h)).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', seedHistory: 'switch', parked: { claude: { agentSessionId: 'native-claude', lastAssistantUuid: 'a2' } } })
    expect(tab(h).agentSessionId).toBeUndefined()
    // The notice says what the agent will be given, with the record the first turn writes again (docs/agents.md 5.1).
    expect(await switches(h)).toEqual([
      {
        from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history',
        text: 'Switched to Codex · GPT-6.1 Sol · 2 turns in full, 0 condensed, 0 left out',
        handOff: expect.objectContaining({ strategy: 'prompt-full', full: expect.any(Array), omitted: [], budgetTokens: 16_000 })
      }
    ])

    const sent = await say(h, 'look for edge cases')
    const req = requests.at(-1)!
    expect(req.agent).toBe('codex')
    expect(req.resume).toBeUndefined()
    expect(req.prompt).toContain('switched it to you')
    expect(req.prompt).toContain('<earlier_conversation>')
    expect(req.prompt).toContain('claude answer 2')
    expect(req.prompt).toContain('first question')
    expect(req.prompt.endsWith('look for edge cases')).toBe(true)
    // The receipt shows what it got; the message says who answered it.
    expect(sent).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', text: 'look for edge cases' })
    const history = sent.added!.find((p) => p.kind === 'history')!
    expect(history).toMatchObject({ label: 'earlier conversation', source: 'The Claude Code messages above, without tool output' })
    expect(history.size).toBe(req.prompt.length - 'look for edge cases'.length)
    expect(tab(h).seedHistory).toBeUndefined()

    // After that it is Codex's own conversation.
    await say(h, 'and then')
    expect(requests.at(-1)).toMatchObject({ agent: 'codex', resume: 'native-codex', prompt: 'and then' })
  })

  it('gives a long history within the budget: the oldest turns condensed or left out, and the receipt says so', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    h.store.state.settings.handOffTokenBudget = 1_024
    await say(h, `OLDEST${'x'.repeat(MAX_FORK_HISTORY_CHARS)}`)
    for (let n = 2; n <= 10; n++) await say(h, `question ${n} ${'y'.repeat(600)}`)
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const sent = await say(h, 'go')
    const prompt = requests.at(-1)!.prompt
    // The huge first turn never goes in whole: it is shortened or left out, and the text names what was left out.
    expect(prompt.length).toBeLessThan(1_024 * 4 + 2_000)
    expect(prompt).not.toContain('x'.repeat(500))
    expect(prompt).toContain('left out to keep this short')
    expect(sent.added!.find((p) => p.kind === 'history')!.detail).toBeDefined()
  })

  it('switching back resumes the native session with a note of what was said in between', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    await say(h, 'claude one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    await say(h, 'codex please')
    await say(h, 'codex again')

    await h.sessions.updateSession(h.session.id, { agent: 'claude', model: 'claude-opus-5-5[1m]' })
    expect(tab(h)).toMatchObject({ agentSessionId: 'native-claude', lastAssistantUuid: 'a1', parked: { codex: { agentSessionId: 'native-codex' } } })
    expect(tab(h).seedHistory).toBeUndefined()
    expect((await switches(h)).at(-1)).toMatchObject({ to: 'claude', carried: 'native', text: expect.stringContaining('Back to Claude Code · Opus 5.5 · resumed its own session') })

    const sent = await say(h, 'claude, your view?')
    const req = requests.at(-1)!
    expect(req).toMatchObject({ agent: 'claude', resume: 'native-claude' })
    expect(req.prompt).not.toContain('<earlier_conversation>')
    expect(req.prompt).toContain('<messages_in_between>')
    expect(req.prompt).toContain('**You:** codex please')
    expect(req.prompt).toContain('**Codex (GPT-6.1 Sol):** codex answer 3')
    // Claude's own turn isn't repeated to it.
    expect(req.prompt).not.toContain('claude one')
    expect(req.prompt.endsWith('claude, your view?')).toBe(true)
    expect(sent.resumeFrom).toEqual({ sessionId: 'native-claude', messageUuid: 'a1' })
    expect(sent.added!.find((p) => p.kind === 'catch-up')).toMatchObject({ label: 'messages in between', source: expect.stringContaining('Claude Code’s last turn') })
    expect(tab(h).catchUpSince).toBeUndefined()
    await say(h, 'plain')
    expect(requests.at(-1)!.prompt).toBe('plain')

    // Codex comes back to its own thread, told what Claude said meanwhile.
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await say(h, 'codex, back to you')
    expect(requests.at(-1)).toMatchObject({ agent: 'codex', resume: 'native-codex' })
    expect(requests.at(-1)!.prompt).toContain('**You:** claude, your view?')
    expect(requests.at(-1)!.prompt).not.toContain('codex please')
  })

  it('switching away and straight back adds no note, and a chat with no messages just changes agent', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    expect(await switches(h)).toEqual([])
    expect(tab(h).seedHistory).toBeUndefined()
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    await say(h, 'one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    await say(h, 'two')
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', resume: 'native-claude', prompt: 'two' })
  })

  it('attributes each turn to the agent and model that wrote it: result lines, usage, search', async () => {
    const h = await setupSessions()
    bothAgents(h)
    const first = await say(h, 'alpha question')
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    const second = await say(h, 'beta question')
    const items = await h.store.readChat(h.session.id)
    expect(isMixed(items)).toBe(true)
    const authors = turnAuthors(items, tab(h))
    expect(first).toMatchObject({ agent: 'claude', model: expect.any(String) })
    expect(authors.get(first.turnId)).toEqual({ agent: 'claude', model: first.model })
    expect(authors.get(second.turnId)).toEqual({ agent: 'codex', model: 'gpt-6.1-sol' })
    expect(otherAgentTurns(items, 'claude')).toBe(1)

    // Usage: Claude reported a cost and Codex didn't, so the tab says so and the total is partial.
    const usage = workspaceUsage([{ id: h.session.id, agent: tab(h).agent, items }])
    expect(usage.tabs[h.session.id]).toMatchObject({ turns: 2, costUsd: 0.1, costNote: 'Cost: n/a for Codex' })
    expect(usage.total.partial).toBe(true)
    // The usage report counts each turn under its own model.
    const report = usageReport({
      rows: h.store.db.usageRows('2000-01-01T00:00:00.000Z'),
      sessions: [{ id: h.session.id, workspaceId: h.ws.id, agent: tab(h).agent, model: tab(h).model, createdAt: tab(h).createdAt }],
      workspaces: [{ id: h.ws.id, repoId: 'repo', imported: false, createdAt: h.ws.createdAt }],
      days: 7,
      now: new Date(Date.now() + 1000)
    })
    expect(report.byModel.map((m) => [m.agent, m.model, m.turns])).toEqual(
      expect.arrayContaining([['claude', first.model, 1], ['codex', 'gpt-6.1-sol', 1]])
    )
    // Search names the agent that answered the hit's turn.
    const hit = searchChats(h.store, 'alpha')
    expect(hit[0]).toMatchObject({ agent: 'claude', model: first.model })
  })

  it('controls follow the active agent: Codex keeps plan mode, Cursor has none, and back on Claude it is offered again', async () => {
    const h = await setupSessions()
    bothAgents(h)
    await h.sessions.updateSession(h.session.id, { planMode: true })
    await say(h, 'plan this')
    // Codex plans through its app-server's plan collaboration mode, so the chat stays in plan mode.
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    expect(tab(h).planMode).toBe(true)
    await h.sessions.updateSession(h.session.id, { agent: 'cursor' })
    expect(tab(h).planMode).toBe(false)
    await expect(h.sessions.updateSession(h.session.id, { planMode: true })).rejects.toThrow('Plan mode is not available')
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    await h.sessions.updateSession(h.session.id, { planMode: true })
    expect(tab(h).planMode).toBe(true)
  })

  it('refuses Terminal agents, a running turn and a history-only import', async () => {
    const h = await setupSessions()
    await expect(h.sessions.updateSession(h.session.id, { agent: 'aider' as AgentKind })).rejects.toThrow('Aider is a Terminal agent')
    expect(tab(h).agent).toBe('claude')
    let release!: () => void
    registerDriver(fakeDriver(async (_req, cb) => {
      await new Promise<void>((r) => (release = r))
      cb.finished({ ok: true })
    }))
    await h.sessions.send(h.session.id, 'long one')
    await vi.waitFor(() => expect(tab(h).status).toBe('running'))
    await expect(h.sessions.updateSession(h.session.id, { agent: 'codex' })).rejects.toThrow('Wait for this turn to finish')
    release()
    await idle(h)
    tab(h).importedMode = 'history'
    await expect(h.sessions.updateSession(h.session.id, { agent: 'codex' })).rejects.toThrow('imported as history only')
  })

  it('a read-only tab stays read-only: only agents that can enforce it, and Claude is back in plan mode', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    Object.assign(tab(h), { readOnly: true, planMode: true })
    await say(h, 'review only')
    await expect(h.sessions.updateSession(h.session.id, { agent: 'cursor' })).rejects.toThrow('read-only')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    expect(tab(h).readOnly).toBe(true)
    const sent = await say(h, 'codex review')
    expect(requests.at(-1)).toMatchObject({ agent: 'codex', readOnly: true })
    expect(sent.readOnly).toBe('sandbox')
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    expect(tab(h).planMode).toBe(true)
    await say(h, 'claude again')
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', readOnly: true, planMode: true })
  })

  it('runs the new agent’s turns in the background host after a switch', async () => {
    const hosted: { agent: AgentKind; request: TurnRequest }[] = []
    const host: TurnHost = {
      keeps: (agent) => agent === 'codex',
      createTurn: (session: Session, _ws, request: TurnRequest, callbacks: TurnCallbacks) => {
        hosted.push({ agent: session.agent, request })
        const turn: AgentTurn = {
          run: async () => {
            callbacks.sessionStarted(request.resume ?? 'hosted-codex')
            callbacks.item({ kind: 'assistant', id: `${request.turnId}:a`, turnId: request.turnId, text: 'hosted answer' })
            callbacks.finished({ ok: true })
          },
          stop: async () => {},
          steer: () => false,
          setPlanMode: async () => {},
          setModel: async () => {}
        }
        return Object.assign(turn, { hosted: true })
      },
      ended: () => {}
    }
    const h = await setupSessions({ turnHost: host })
    const requests = bothAgents(h)
    await say(h, 'claude in process')
    expect(hosted).toHaveLength(0)
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await say(h, 'codex in the host')
    expect(hosted).toHaveLength(1)
    expect(hosted[0].agent).toBe('codex')
    expect(hosted[0].request.resume).toBeUndefined()
    expect(hosted[0].request.prompt).toContain('claude answer 1')
    await say(h, 'codex again')
    expect(hosted[1].request).toMatchObject({ resume: 'hosted-codex', prompt: 'codex again' })
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    await say(h, 'claude back')
    expect(hosted).toHaveLength(2)
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', resume: 'native-claude' })
    expect(requests.at(-1)!.prompt).toContain('hosted answer')
  })
})

describe('a conversation parked for an agent that can’t resume it', { timeout: TURNS_BUDGET }, () => {
  it('stays parked: switching to the agent starts a new conversation, and nothing replaced the old one', async () => {
    const h = await setupSessions()
    bothAgents(h)
    await say(h, 'claude one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await say(h, 'codex two')
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    expect(tab(h).parked).toMatchObject({ codex: { agentSessionId: 'native-codex' } })
    const codex = staticCapabilities('codex')!
    const resume = codex.threads.resume
    codex.threads.resume = { level: 'none', why: 'agentCaps.why.resume' } as never
    try {
      await h.sessions.updateSession(h.session.id, { agent: 'codex' })
      // A fresh conversation for Codex, with the chat as text; its old one is still kept, as Claude's now is.
      expect(tab(h).agentSessionId).toBeUndefined()
      expect(tab(h).seedHistory).toBe('switch')
      expect(tab(h).parked).toMatchObject({ codex: { agentSessionId: 'native-codex' }, claude: { agentSessionId: 'native-claude' } })
    } finally {
      codex.threads.resume = resume
    }
  })
})

describe('bookkeeping in a chat that switched agents', { timeout: TURNS_BUDGET }, () => {
  it('Restore goes back to the agent that message went to, and drops conversations that saw later turns', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    await say(h, 'claude one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const codexTurn = await say(h, 'codex two')
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    const claudeTurn = await say(h, 'claude three')

    // Rewinding Claude's turn: Claude resumes where it stood, and is told again what Codex said.
    await h.sessions.restore(h.session.id, claudeTurn.turnId)
    expect(tab(h)).toMatchObject({ agent: 'claude', agentSessionId: 'native-claude', resumeAt: 'a1', parked: { codex: { agentSessionId: 'native-codex' } } })
    await say(h, 'claude three again')
    expect(requests.at(-1)!.prompt).toContain('**You:** codex two')

    // Rewinding Codex's turn: the tab is Codex's again, with nothing to resume, so it carries the history again.
    await h.sessions.restore(h.session.id, codexTurn.turnId)
    expect(tab(h).agent).toBe('codex')
    expect(tab(h).agentSessionId).toBeUndefined()
    expect(tab(h).seedHistory).toBe('switch')
    // Both agents' conversations went on past the cut, so neither is kept to resume.
    expect(tab(h).parked).toBeUndefined()
    await say(h, 'codex two again')
    const req = requests.at(-1)!
    expect(req).toMatchObject({ agent: 'codex' })
    expect(req.resume).toBeUndefined()
    expect(req.prompt).toContain('claude one')
    expect(req.prompt).not.toContain('claude three')
  })

  it('a fork of a chat other agents answered carries the history as text instead of branching Claude', async () => {
    const h = await setupSessions()
    const requests = bothAgents(h)
    await say(h, 'claude one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await say(h, 'codex two')
    await h.sessions.updateSession(h.session.id, { agent: 'claude' })
    await say(h, 'claude three')
    const fork = await h.sessions.forkSession(h.session.id)
    expect(fork).toMatchObject({ agent: 'claude', seedHistory: true })
    expect(fork.agentSessionId).toBeUndefined()
    expect(fork.parked).toBeUndefined()
    await say(h, 'in the fork', fork.id)
    expect(requests.at(-1)!.resume).toBeUndefined()
    expect(requests.at(-1)!.prompt).toContain('codex answer 2')
  })

  it('/clear forgets parked conversations', async () => {
    const h = await setupSessions()
    bothAgents(h)
    await say(h, 'one')
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    await h.sessions.send(h.session.id, '/clear')
    expect(tab(h).parked).toBeUndefined()
    expect(tab(h).seedHistory).toBeUndefined()
  })

  it('an export leaves out a Claude transcript that misses other agents’ turns, and parked conversations', async () => {
    const src = await machine()
    const { ws, s1 } = await seed(src)
    void src.mirror.append({ projectKey: 'proj-src', sessionId: 'native-1' }, [{ type: 'user', uuid: 'a1', message: { content: 'a1' } }])
    s1.parked = { codex: { agentSessionId: 'thread-9', lastTurnId: 't2' } }
    await src.store.appendChat(s1.id, { kind: 'notice', id: 'switch:1', level: 'info', text: 'Switched to Codex', switched: { from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history' } })
    await src.store.appendChat(s1.id, { kind: 'user', id: 'u2', turnId: 't2', text: 'codex turn', at: ws.createdAt, agent: 'codex', model: 'gpt-6.1-sol' })
    await src.store.appendChat(s1.id, { kind: 'notice', id: 'switch:2', level: 'info', text: 'Back to Claude', switched: { from: 'codex', to: 'claude', model: 'm', carried: 'native' } })
    const out = path.join(await tempDir(), 'mixed.foreman')
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'password1', includeWorktree: false, outPath: out })
    expect(summary.transcripts).toBe(0)
    expect(summary.transcriptsSkipped).toEqual([{ title: 'Fix login', reason: expect.stringContaining('other agents answered part of this chat') }])
    const staged = await (await machine()).portability.stage(out, 'password1')
    if (staged.kind !== 'staged') throw new Error('staged')
    expect(staged.preview.tabs.find((t) => t.title === 'Fix login')).toMatchObject({ nativeResume: false })
  })
})

describe('switching: the pure parts', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', turnId: 't1', text: 'old message', at: '' },
    { kind: 'assistant', id: 'a1', turnId: 't1', text: 'claude said' },
    { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' },
    { kind: 'notice', id: 's1', level: 'info', text: '', switched: { from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history' } },
    { kind: 'user', id: 'u2', turnId: 't2', text: 'to codex', at: '', agent: 'codex', model: 'gpt-6.1-sol' },
    { kind: 'tool', id: 'x', turnId: 't2', name: 'Bash', input: { command: 'secret-cmd' }, status: 'done', output: 'out' },
    { kind: 'assistant', id: 'a2', turnId: 't2', text: 'codex part one' },
    { kind: 'assistant', id: 'a3', turnId: 't2', text: 'codex part two' },
    { kind: 'user', id: 'u2s', turnId: 't2', text: 'also this', at: '', steered: true },
    { kind: 'turn-end', id: 'e2', turnId: 't2', outcome: 'completed' }
  ]

  it('a copied or carried transcript marks where the chat switched agents', () => {
    const md = chatToMarkdown([{ ...items[0] }, { ...items[1] }, { ...items[3], text: 'Switched to Codex · GPT-6.1 Sol' } as ChatItem, { ...items[6] }], { toolOutput: false })
    expect(md).toContain('_Switched to Codex · GPT-6.1 Sol_')
    expect(md.indexOf('_Switched')).toBeLessThan(md.indexOf('codex part one'))
  })

  it('older messages are attributed to the agent the first switch left, with the model unknown', () => {
    const authors = turnAuthors(items, { agent: 'codex' })
    expect(authors.get('t1')).toEqual({ agent: 'claude', model: undefined })
    expect(authors.get('t2')).toEqual({ agent: 'codex', model: 'gpt-6.1-sol' })
    expect(turnAuthors(items.slice(0, 3), { agent: 'claude' }).get('t1')).toEqual({ agent: 'claude', model: undefined })
  })

  it('the delta a returning agent gets: messages only, answers joined and labelled, newest kept', () => {
    const note = renderHandOff(buildHandOff(items, { agent: 'claude' }, 't1', 16_000), { reason: 'return', canRead: true })
    expect(note).toContain('**You:** to codex')
    expect(note).toContain('**Codex (GPT-6.1 Sol):** codex part one\n\ncodex part two')
    expect(note).toContain('(while it worked) also this')
    expect(note).not.toContain('secret-cmd')
    expect(note).not.toContain('old message')
    expect(renderHandOff(buildHandOff(items, { agent: 'claude' }, 't2', 16_000), { reason: 'return', canRead: true })).toBe('')
    const long: ChatItem[] = [...items, ...Array.from({ length: 40 }, (_, n): ChatItem => ({ kind: 'user', id: `l${n}`, turnId: `l${n}`, text: `${n === 39 ? 'NEWEST' : 'filler'} ${'y'.repeat(700)}`, at: '' }))]
    const build = buildHandOff(long, { agent: 'claude' }, 't1', 4_000)
    const cut = renderHandOff(build, { reason: 'return', canRead: true })
    expect(build.omitted.length).toBeGreaterThan(0)
    expect(cut).toContain('NEWEST')
    expect(cut).not.toContain('to codex')
    expect(cut).toContain('read_chat_history')
    expect(build.usedTokens).toBeLessThanOrEqual(4_000)
  })

  it('the picker asks only when the agent changes in a chat with messages, and says when it can’t continue', () => {
    const session = { agent: 'claude' as const, status: 'idle' as const }
    expect(modelChoiceAction(session, true, { agent: 'codex' })).toBe('ask')
    expect(modelChoiceAction(session, false, { agent: 'codex' })).toBe('apply')
    expect(modelChoiceAction(session, true, { agent: 'claude' })).toBe('apply')
    expect(continueBlock(session, staticCapabilities('codex'))).toBeNull()
    expect(continueBlock({ ...session, status: 'running' }, staticCapabilities('codex'))).toBe('running')
    expect(continueBlock({ ...session, readOnly: true }, staticCapabilities('cursor'))).toBe('read-only')
    expect(continueBlock({ ...session, readOnly: true }, staticCapabilities('codex'))).toBeNull()
    expect(continueBlock({ ...session, importedMode: 'history' }, staticCapabilities('codex'))).toBe('history')
  })

  it('the Plan control: disabled with its reason for an agent without plan mode, locked when read-only, absent only without a record', () => {
    expect(planControl(staticCapabilities('cursor'), { planMode: false })).toBe('unavailable')
    expect(planControl(undefined, { planMode: false })).toBe('hidden')
    // Codex plans through the app-server's plan collaboration mode.
    expect(planControl(staticCapabilities('codex'), { planMode: false })).toBe('off')
    expect(planControl(staticCapabilities('codex'), { planMode: true })).toBe('on')
    expect(planControl(staticCapabilities('claude'), { planMode: true })).toBe('on')
    expect(planControl(staticCapabilities('claude'), { planMode: false })).toBe('off')
    expect(planControl(staticCapabilities('claude'), { planMode: true, readOnly: true })).toBe('locked')
  })
})

describe('what a flow step’s loadout changes in the tab it continues', () => {
  const loadout = { agent: 'codex' as AgentKind, model: 'gpt-6.1-sol', fast: false }
  it('a switch of agent, an account move on the same agent, or nothing', async () => {
    const { stepTabPatch } = await import('../src/shared/switchAgent')
    expect(stepTabPatch({ agent: 'claude' }, loadout)).toEqual({ agent: 'codex', model: 'gpt-6.1-sol', effort: undefined, fastMode: false })
    expect(stepTabPatch({ agent: 'claude' }, { ...loadout, instance: 'ai-work' })).toMatchObject({ agent: 'codex', instanceId: 'ai-work' })
    // The same agent on the account the step names: a move of the chat to that account, and nothing else.
    expect(stepTabPatch({ agent: 'codex' }, { ...loadout, instance: 'ai-work' })).toEqual({ instanceId: 'ai-work' })
    expect(stepTabPatch({ agent: 'codex', instanceId: 'ai-home' }, { ...loadout, instance: 'ai-work' })).toEqual({ instanceId: 'ai-work' })
    // Already there, or the step names no account: it leaves the tab's account alone.
    expect(stepTabPatch({ agent: 'codex', instanceId: 'ai-work' }, { ...loadout, instance: 'ai-work' })).toBeUndefined()
    expect(stepTabPatch({ agent: 'codex', instanceId: 'ai-work' }, loadout)).toBeUndefined()
    expect(stepTabPatch({ agent: 'codex' }, loadout)).toBeUndefined()
  })
})
