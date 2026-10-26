// G1: chat-side pieces of the agents backlog. O1 dividers (model changes within one agent, compaction), the
// Claude-mirror count treating switched chats as incomplete, /mcp-status for agents that report no MCP status,
// plan mode from an ACP agent's declared modes, and catalog agents in model visibility and model search.
import { describe, expect, it, vi } from 'vitest'
import { allModels, AGENTS, setModelCatalog } from '../src/shared/agents'
import { mirrorLine } from '../src/shared/claudeMirror'
import { parseHiddenModels, pickerModels } from '../src/shared/modelVisibility'
import { modelDivider } from '../src/shared/switchAgent'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { registerDriver } from '../src/main/agents/registry'
import type { McpLaunch } from '../src/main/agents/types'
import { DataService } from '../src/main/dataService'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import { makeRepo, tempDir } from './helpers'

const user = (turnId: string): ChatItem => ({ kind: 'user', id: `user:${turnId}`, turnId, text: 'hi', at: '2026-10-22T10:00:00Z', attachments: [] })

describe('G1 · O1 dividers', () => {
  it('marks a model change within one agent once there are messages, merging changes made with no turn between', () => {
    expect(modelDivider([], 'claude', 'a', 'b')).toBeNull()
    expect(modelDivider([user('t1')], 'claude', 'a', 'a')).toBeNull()
    expect(modelDivider([user('t1')], 'claude', 'a', 'b')).toEqual({ divider: { kind: 'model', agent: 'claude', from: 'a', to: 'b' } })
    const first: ChatItem = { kind: 'notice', id: 'model:1', level: 'info', text: '', divider: { kind: 'model', agent: 'claude', from: 'a', to: 'b' } }
    expect(modelDivider([user('t1'), first], 'claude', 'b', 'c')).toEqual({ divider: { kind: 'model', agent: 'claude', from: 'a', to: 'c' }, replace: 'model:1' })
    // Straight back to where it was: the line says so instead of adding another.
    expect(modelDivider([user('t1'), first], 'claude', 'b', 'a')).toEqual({ divider: { kind: 'model', agent: 'claude', from: 'a', to: 'a' }, replace: 'model:1' })
  })
})

const EVENTS = { changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {} }

async function rig(origins: { name: string; approved: boolean; command: string }[] = [], servers: Record<string, McpLaunch> = {}) {
  const store = new Store(await tempDir('foreman-g1-chat-'))
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: await makeRepo(), portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
  store.state.workspaces.push(ws)
  const workspaces = { workspace: () => ws, env: () => ({}), settingsFor: () => ({ prompts: { general: '' }, sensitivePaths: [] }), agentContext: () => '' }
  const repoMcp = { launchable: () => servers, origins: () => origins }
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, EVENTS, repoMcp as never)
  return { store, ws, sessions }
}

describe('G1 · O1 dividers in a chat', () => {
  it('leaves "Model changed" in a chat with messages, and none in an empty one or on an agent switch', async () => {
    const { store, ws, sessions } = await rig()
    const s = sessions.createSession(ws.id, { agent: 'claude', model: 'claude-opus-5-5[1m]' })
    await sessions.updateSession(s.id, { model: 'claude-sonnet-5-5[1m]' })
    expect(await store.readChat(s.id)).toEqual([])
    await store.appendChat(s.id, user('t1'))
    await sessions.updateSession(s.id, { model: 'claude-opus-5-5[1m]' })
    const chat = await store.readChat(s.id)
    expect(chat.at(-1)).toMatchObject({ kind: 'notice', divider: { kind: 'model', agent: 'claude', from: 'claude-sonnet-5-5[1m]', to: 'claude-opus-5-5[1m]' } })
    await sessions.updateSession(s.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    const after = await store.readChat(s.id)
    expect(after.filter((i) => i.kind === 'notice' && i.divider)).toHaveLength(1)
    expect(after.at(-1)).toMatchObject({ kind: 'notice', switched: { to: 'codex' } })
  })
})

describe('G1 · the Claude-mirror count', () => {
  it('counts chats other agents answered part of as incomplete', async () => {
    expect(mirrorLine({ sessions: 3, errors: 0 })).toBe('Claude transcripts: 3 sessions · 0 mirror errors')
    expect(mirrorLine({ sessions: 3, errors: 1, partial: 1 })).toContain('1 incomplete (other agents answered part of that chat)')
    const { store, ws, sessions } = await rig()
    const plain = sessions.createSession(ws.id, { agent: 'claude' })
    const switched = sessions.createSession(ws.id, { agent: 'claude' })
    for (const s of [plain, switched]) {
      ;(s as Session).agentSessionId = `claude-${s.id}`
      await store.appendChat(s.id, user(`${s.id}-1`))
    }
    await store.appendChat(switched.id, { kind: 'notice', id: 'sw', level: 'info', text: '', switched: { from: 'claude', to: 'codex', model: 'gpt-6.1-sol', carried: 'history' } })
    await store.appendChat(switched.id, { ...user(`${switched.id}-2`), agent: 'codex' } as ChatItem)
    await store.appendChat(switched.id, { kind: 'notice', id: 'sw2', level: 'info', text: '', switched: { from: 'codex', to: 'claude', model: 'claude-opus-5-5[1m]', carried: 'native' } })
    const mirror = { summary: () => ({ sessions: 2, errors: 0 }) }
    const info = await new DataService(store, undefined, mirror as never).info()
    expect(info.claudeTranscripts).toEqual({ sessions: 2, errors: 0, partial: 1 })
  })
})

describe('G1 · /mcp-status for agents that report no MCP status', () => {
  it('lists the repo’s servers for a Codex or Chat-agent tab: approved ones as passed, the rest as not started', async () => {
    const origins = [
      { name: 'echo', approved: true, command: 'node echo.mjs' },
      { name: 'db', approved: false, command: 'npx db-mcp' }
    ]
    const { store, ws, sessions } = await rig(origins)
    for (const agent of ['codex', 'gemini'] as const) {
      expect(AGENTS[agent].builtinCommands.some((c) => c.name === 'mcp-status')).toBe(true)
      const s = sessions.createSession(ws.id, { agent })
      const result = await sessions.mcpStatus(s.id)
      expect(result).toMatchObject({ supported: true, live: false, repoOnly: { agent: AGENTS[agent].label } })
      expect(result.servers.map((x) => [x.name, x.status])).toEqual([
        ['echo', 'passed'],
        ['db', 'disabled']
      ])
      // Not passed yet: this tab hasn't run a turn since it was approved.
      expect(result.servers[0].error).toMatch(/next turn/)
      ;(store.state.sessions.find((x) => x.id === s.id) as Session).repoMcp = { servers: ['echo'], at: '2026-10-22T10:00:00Z' }
      const later = await sessions.mcpStatus(s.id)
      expect(later.repoOnly?.passedAt).toBe('2026-10-22T10:00:00Z')
      expect(later.servers[0].error).toBeUndefined()
    }
  })
})

describe('G1 · plan mode for an ACP agent that declared one', () => {
  it('lets a Gemini tab turn Plan on once Gemini declared a plan mode, and passes it to the turn', async () => {
    const { store, ws, sessions } = await rig()
    const s = sessions.createSession(ws.id, { agent: 'gemini', title: 'plan' })
    await expect(sessions.updateSession(s.id, { planMode: true })).rejects.toThrow(/not available/)
    store.state.catalog.agents.gemini = { models: [], modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] }
    await sessions.updateSession(s.id, { planMode: true })
    expect(store.state.sessions.find((x) => x.id === s.id)?.planMode).toBe(true)
    const seen: boolean[] = []
    registerDriver({
      kind: 'gemini',
      status: async () => ({ agent: 'gemini', installed: true, ready: true }),
      createTurn: (req, cb) => ({ run: async () => (seen.push(req.planMode), cb.finished({ ok: true })), stop: async () => {}, steer: () => false, setPlanMode: async () => {}, setModel: async () => {} })
    })
    const { turnId } = await sessions.deliver(s.id, 'plan it')
    await vi.waitFor(async () => expect((await sessions.turnStatus(turnId!))?.state).toBe('ended'), { timeout: 20_000 })
    expect(seen).toEqual([true])
  }, 30_000)
})

describe('G1 · catalog agents in model visibility and search', () => {
  it('keeps a Chat agent’s hidden models and searches its models', () => {
    expect(parseHiddenModels({ gemini: ['gemini-3-pro'], aider: ['x'], nope: ['y'] })).toEqual({ gemini: ['gemini-3-pro'] })
    setModelCatalog({ gemini: [{ id: 'gemini-3-pro', agent: 'gemini', label: 'Gemini 3 Pro', efforts: [], supportsFast: false, contextWindow: 1 }] })
    try {
      expect(allModels().some((m) => m.agent === 'gemini' && m.id === 'gemini-3-pro')).toBe(true)
      const models = allModels().filter((m) => m.agent === 'gemini')
      expect(pickerModels(models, { gemini: ['gemini-3-pro'] }).shown).toEqual([])
      expect(pickerModels(models, { gemini: ['gemini-3-pro'] }, { agent: 'gemini', model: 'gemini-3-pro' }).shown).toHaveLength(1)
    } finally {
      setModelCatalog({})
    }
  })
})
