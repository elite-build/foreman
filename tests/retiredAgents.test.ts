// Gemini CLI was dropped (Google stopped serving it for personal accounts): what was saved for it moves to Antigravity.
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOADOUTS, type Loadout } from '../src/shared/agents'
import { historyAgentLabel, movedLoadout, moveRetiredSession, moveRetiredSettings, retiredSuccessor } from '../src/shared/retiredAgents'
import type { ChatItem, PromptTemplate, Session, Settings, Workspace } from '../src/shared/types'
import path from 'node:path'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (text) => Buffer.from(text, 'utf8'), decrypt: (data) => data.toString('utf8') }

const gemini = (extra: Partial<Loadout> = {}): Loadout => ({ agent: 'gemini' as never, model: 'gemini-3-pro', effort: 'high', fast: true, instance: 'ai-x', ...extra })

const session = (id: string, extra: Partial<Session> & { agent?: string } = {}): Session =>
  ({ id, workspaceId: 'w1', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-01-01T00:00:00Z', ...extra }) as unknown as Session

describe('retired agents', () => {
  it('names Gemini CLI’s successor, and nothing for an agent Foreman still runs', () => {
    expect(retiredSuccessor('gemini')).toBe('antigravity')
    expect(retiredSuccessor('antigravity')).toBeUndefined()
    expect(retiredSuccessor('toString')).toBeUndefined()
    expect(retiredSuccessor(undefined)).toBeUndefined()
    expect(historyAgentLabel('gemini')).toBe('Gemini CLI')
    expect(historyAgentLabel('claude')).toBe('Claude Code')
    expect(historyAgentLabel('nope')).toBe('nope')
  })

  it('moves a model choice to Antigravity’s default model, without the old effort, fast mode or account', () => {
    expect(movedLoadout(gemini())).toEqual({ agent: 'antigravity', model: '', fast: false })
    expect(movedLoadout({ agent: 'gemini' as never, model: 'x', effort: 'low' })).toEqual({ agent: 'antigravity', model: '' })
    const claude = DEFAULT_LOADOUTS[0]
    expect(movedLoadout(claude)).toBe(claude)
    expect(movedLoadout(undefined)).toBeUndefined()
  })

  it('moves default models, the review model, templates’ models and Settings choices', () => {
    const template: PromptTemplate = { id: 't', name: 'T', body: 'b', startModel: { agent: 'gemini' as never, model: 'g' }, followUp: { title: 'F', prompt: 'p', model: gemini() } }
    const plain: PromptTemplate = { id: 'p', name: 'P', body: 'b' }
    const settings = {
      loadouts: [DEFAULT_LOADOUTS[0], gemini()],
      reviewModel: gemini({ fast: false }),
      promptTemplates: [template, plain],
      agentPrefs: { gemini: { enabled: true, auth: 'apiKey', path: '/old/gemini' } }
    } as unknown as Settings
    expect(moveRetiredSettings(settings)).toBe(true)
    expect(settings.loadouts).toEqual([DEFAULT_LOADOUTS[0], { agent: 'antigravity', model: '', fast: false }])
    expect(settings.reviewModel).toEqual({ agent: 'antigravity', model: '', fast: false })
    expect(settings.promptTemplates[0].startModel).toEqual({ agent: 'antigravity', model: '' })
    expect(settings.promptTemplates[0].followUp).toEqual({ title: 'F', prompt: 'p', model: { agent: 'antigravity', model: '', fast: false } })
    expect(settings.promptTemplates[1]).toBe(plain)
    // On and sign-in mode carry over; the path was Gemini CLI's program.
    expect(settings.agentPrefs).toEqual({ antigravity: { enabled: true, auth: 'apiKey' } })
    expect(moveRetiredSettings(settings)).toBe(false)
  })

  it('keeps Antigravity’s own Settings choices over Gemini CLI’s', () => {
    const settings = { loadouts: [], agentPrefs: { gemini: { enabled: true, auth: 'apiKey' }, antigravity: { enabled: false } } } as unknown as Settings
    moveRetiredSettings(settings)
    expect(settings.agentPrefs).toEqual({ antigravity: { enabled: false } })
  })

  it('continues a Gemini CLI chat on Antigravity as a new conversation that gets the chat so far', () => {
    const s = session('s1', {
      agent: 'gemini',
      model: 'gemini-3-pro',
      effort: 'high',
      planMode: true,
      autoAcceptEdits: true,
      agentSessionId: 'g-123',
      lastAssistantUuid: 'u',
      conversationKey: 'k',
      contextUsage: { used: 1, limit: 2 }
    } as never)
    expect(moveRetiredSession(s, true)).toBe(true)
    expect(s).toMatchObject({ agent: 'antigravity', model: '', fastMode: false, planMode: false, autoAcceptEdits: true, seedHistory: 'switch' })
    for (const gone of ['effort', 'agentSessionId', 'lastAssistantUuid', 'conversationKey', 'contextUsage']) expect(s[gone as keyof Session]).toBeUndefined()
    const empty = session('s2', { agent: 'gemini' } as never)
    expect(moveRetiredSession(empty, false)).toBe(true)
    expect(empty.seedHistory).toBeUndefined()
  })

  it('drops what another chat parked for Gemini CLI, and a pending hand-off naming it', () => {
    const party = (agent: string) => ({ agent, model: '' }) as never
    const s = session('s1', {
      parked: { gemini: { agentSessionId: 'g' }, codex: { agentSessionId: 'c' } } as never,
      handOffPending: { noticeId: 'n', from: party('gemini'), to: party('claude'), resumed: false },
      queue: [{ id: 'q', text: 'x', attachments: [], followUp: { templateId: 't', title: 'F', prompt: 'p', model: gemini() } }] as never
    })
    expect(moveRetiredSession(s, true)).toBe(false)
    expect(Object.keys(s.parked ?? {})).toEqual(['codex'])
    expect(s.handOffPending).toBeUndefined()
    expect(s.queue[0].followUp?.model).toEqual({ agent: 'antigravity', model: '', fast: false })
    expect(s.agent).toBe('claude')
  })

  it('moves saved Gemini CLI chats and choices once, as the store loads, and says so in each chat', async () => {
    const dir = await tempDir('foreman-retired-')
    const first = new Store(dir)
    await first.load()
    first.state.workspaces.push({
      id: 'w1',
      repoId: 'r1',
      name: 'w1',
      createdAt: '2026-01-01T00:00:00Z',
      autoFix: { consent: { sessionId: 's1', agent: 'gemini', permissions: '', prompt: '' }, attempts: [], consumed: [] }
    } as unknown as Workspace)
    first.state.sessions.push(session('s1', { agent: 'gemini', model: 'gemini-3-pro', agentSessionId: 'g-1' } as never), session('s2', { agent: 'gemini' } as never), session('s3'))
    first.state.settings.language = 'en'
    first.state.settings.loadouts = [gemini()]
    first.state.catalog.agents = { gemini: { models: [] } } as never
    await first.appendChat('s1', { kind: 'user', id: 'u1', turnId: 't1', text: 'hi', at: '2026-01-01T00:00:00Z' } as ChatItem)
    first.close()

    const next = new Store(dir)
    await next.load()
    const byId = (id: string) => next.state.sessions.find((s) => s.id === id)!
    expect(byId('s1')).toMatchObject({ agent: 'antigravity', model: '', seedHistory: 'switch' })
    expect(byId('s1').agentSessionId).toBeUndefined()
    expect(byId('s2')).toMatchObject({ agent: 'antigravity' })
    expect(byId('s2').seedHistory).toBeUndefined()
    expect(byId('s3').agent).toBe('claude')
    expect(next.state.settings.loadouts).toEqual([{ agent: 'antigravity', model: '', fast: false }])
    expect(next.state.catalog.agents).not.toHaveProperty('gemini')
    expect(next.state.workspaces[0].autoFix).toBeUndefined()
    const notices = (await next.readChat('s1')).filter((i) => i.kind === 'notice')
    expect(notices).toEqual([expect.objectContaining({ id: 'retired:gemini', level: 'info', text: expect.stringContaining('Gemini CLI is no longer supported, so this chat continues on Antigravity. Your next message') })])
    expect((await next.readChat('s2')).filter((i) => i.kind === 'notice')).toEqual([expect.objectContaining({ text: 'Gemini CLI is no longer supported, so this chat continues on Antigravity.' })])
    expect((await next.readChat('s3')).length).toBe(0)
    next.close()

    // Saved: the next load finds nothing to move and adds no second notice.
    const third = new Store(dir)
    await third.load()
    expect(third.state.sessions.find((s) => s.id === 's1')).toMatchObject({ agent: 'antigravity', seedHistory: 'switch' })
    expect((await third.readChat('s1')).filter((i) => i.kind === 'notice')).toHaveLength(1)
    third.close()
  })

  it('gives Antigravity the Gemini API key saved for Gemini CLI, unless it has its own', async () => {
    const dir = await tempDir('foreman-retired-keys-')
    const file = path.join(dir, 'secrets.bin')
    const before = new SecretStore(file, plain)
    before.load()
    before.setAgentKey('gemini', 'GEMINI_API_KEY', 'AIza-old')
    const after = new SecretStore(file, plain)
    after.load()
    expect(after.agentKey('antigravity', 'GEMINI_API_KEY')).toBe('AIza-old')
    expect(after.agentKeys('gemini')).toEqual({})
    // Saved: a third load reads the moved key from the file.
    const third = new SecretStore(file, plain)
    third.load()
    expect(third.agentKey('antigravity', 'GEMINI_API_KEY')).toBe('AIza-old')

    const own = path.join(dir, 'own.bin')
    const both = new SecretStore(own, plain)
    both.load()
    both.setAgentKey('gemini', 'GEMINI_API_KEY', 'AIza-old')
    both.setAgentKey('antigravity', 'GEMINI_API_KEY', 'AIza-new')
    const kept = new SecretStore(own, plain)
    kept.load()
    expect(kept.agentKey('antigravity', 'GEMINI_API_KEY')).toBe('AIza-new')
    expect(kept.agentKeys('gemini')).toEqual({})
  })
})
