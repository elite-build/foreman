// The permission mode a turn really runs in (docs/agents.md 3, "Permission modes"): with a #170 cap, as before (a refusal for an agent
// that can't hold the ceiling); without one, the stored mode where the agent's record lists it, else the nearest it does run in, said
// once in the chat with who holds it, and never a refusal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { POLICY_ORDER, type TurnCap } from '../src/shared/agentAccess'
import { FULL_AGENT_IDS, CHAT_AGENT_IDS, staticCapabilities } from '../src/shared/agentCatalog'
import { offeredModes, effectivePolicy } from '../src/shared/permissionModes'
import { approvalPolicyFor, permissionNote, type ApprovalPolicy } from '../src/shared/permissions'
import type { ChatItem } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

vi.setConfig({ testTimeout: 90_000 })

afterEach(() => registerDriver(claudeDriver))

const record = (agent: string) => staticCapabilities(agent)!
const cap = (ceiling: ApprovalPolicy): TurnCap => ({ ceiling, grantId: 'g', name: 'Claude Code' })

describe('effectivePolicy without a cap', () => {
  it('is the stored mode wherever the record lists it', () => {
    for (const mode of POLICY_ORDER) expect(effectivePolicy(record('claude'), mode)).toEqual({ refused: false, policy: mode })
    for (const mode of ['ask', 'ask-except-edits', 'never-ask'] as const) expect(effectivePolicy(record('gemini'), mode)).toEqual({ refused: false, policy: mode })
  })

  it('runs an agent with no Auto as Ask, and says who holds that', () => {
    expect(effectivePolicy(record('gemini'), 'auto')).toEqual({ refused: false, policy: 'ask', changed: { stored: 'auto', by: 'foreman' } })
    expect(effectivePolicy(record('opencode'), 'auto')).toMatchObject({ policy: 'ask', changed: { by: 'foreman' } })
  })

  it('runs Cursor, which never asks, in its one mode for any stored one', () => {
    expect(effectivePolicy(record('cursor'), 'never-ask')).toEqual({ refused: false, policy: 'never-ask' })
    for (const stored of ['ask', 'ask-except-edits', 'auto'] as const) {
      expect(effectivePolicy(record('cursor'), stored)).toEqual({ refused: false, policy: 'never-ask', changed: { stored, by: 'foreman' } })
    }
  })

  it('never refuses: every agent, every stored mode', () => {
    for (const agent of [...FULL_AGENT_IDS, ...CHAT_AGENT_IDS]) {
      for (const stored of POLICY_ORDER) {
        const result = effectivePolicy(record(agent), stored)
        expect(result.refused, `${agent} ${stored}`).toBe(false)
        // And what it runs in is one of the modes its record lists.
        if (!result.refused) expect(record(agent).enforcement.permissionModes).toContain(result.policy)
      }
    }
  })
})

describe('effectivePolicy under a cap', () => {
  it('holds the lower of the stored mode and the ceiling, as before', () => {
    expect(effectivePolicy(record('claude'), 'never-ask', cap('ask'))).toEqual({ refused: false, policy: 'ask' })
    expect(effectivePolicy(record('claude'), 'ask', cap('auto'))).toEqual({ refused: false, policy: 'ask' })
    expect(effectivePolicy(record('codex'), 'ask-except-edits', cap('auto'))).toEqual({ refused: false, policy: 'ask-except-edits' })
  })

  it('refuses an agent that can’t hold the ceiling, and only then', () => {
    expect(effectivePolicy(record('cursor'), 'ask', cap('ask'))).toEqual({ refused: true })
    expect(effectivePolicy(record('gemini'), 'never-ask', cap('auto'))).toEqual({ refused: true })
    // A ceiling it can hold is no refusal and no change of mode.
    expect(effectivePolicy(record('cursor'), 'ask', cap('never-ask'))).toEqual({ refused: false, policy: 'ask' })
  })
})

describe('what the pickers offer', () => {
  it('is the record’s modes, most restrictive first', () => {
    expect(offeredModes(record('claude'))).toEqual(['ask', 'ask-except-edits', 'auto', 'never-ask'])
    expect(offeredModes(record('gemini'))).toEqual(['ask', 'ask-except-edits', 'never-ask'])
    expect(offeredModes(record('cursor'))).toEqual(['never-ask'])
    expect(offeredModes(undefined)).toEqual(['ask', 'ask-except-edits', 'auto', 'never-ask'])
  })

  it('describes a chat before it starts as what it will really do', () => {
    const base = { requireToolApprovals: true, codexApprovals: 'sandboxed' as const, autoPermissionMode: false }
    expect(permissionNote('claude', base)).toBe('asks before running tools')
    // Cursor can't ask, whatever the setting says.
    expect(permissionNote('cursor', base)).toBe('tools run without approval')
    expect(approvalPolicyFor('cursor', base)).toBe('ask')
    // An agent with no Auto runs it as Ask.
    expect(permissionNote('gemini', { ...base, autoPermissionMode: true })).toBe('asks before running tools')
  })
})

type Notice = Extract<ChatItem, { kind: 'notice' }>

describe('in a chat', () => {
  async function on(agent: 'cursor' | 'gemini', settings: Record<string, unknown> = {}) {
    const requests: TurnRequest[] = []
    registerDriver({ ...fakeDriver(async (req, cb) => (requests.push(req), cb.sessionStarted('s'), cb.finished({ ok: true }))), kind: agent })
    const h = await setupSessions()
    Object.assign(h.store.state.settings, { requireToolApprovals: true, ...settings })
    await h.sessions.updateSession(h.session.id, { agent, model: agent === 'cursor' ? 'auto' : '' })
    const say = async (text: string) => {
      await h.sessions.send(h.session.id, text)
      await vi.waitFor(() => expect(h.store.state.sessions.find((s) => s.id === h.session.id)!.status).toBe('idle'), { timeout: 10_000 })
    }
    const notices = async () => (await h.store.readChat(h.session.id)).filter((i): i is Notice => i.kind === 'notice' && i.id.endsWith(':mode'))
    return { h, requests, say, notices }
  }

  it('Cursor with approvals on runs as Never ask, and the chat says so once, naming who holds it', async () => {
    const { requests, say, notices } = await on('cursor')
    await say('one')
    await say('two')
    expect(requests.map((r) => r.approvals)).toEqual(['never-ask', 'never-ask'])
    const said = await notices()
    expect(said).toHaveLength(1)
    expect(said[0].text).toBe('Cursor doesn’t ask before running tools; Foreman can’t make it. Enforced by: Foreman’s review.')
  })

  it('says it again when the stored mode changes what the agent runs as', async () => {
    const { h, say, notices } = await on('gemini', { autoPermissionMode: true })
    await say('one')
    expect((await notices()).map((n) => n.text)).toEqual(['Gemini CLI can’t run in “Auto”, so this chat runs as “Ask”. Enforced by: Foreman’s review.'])
    await say('two')
    expect(await notices()).toHaveLength(1)
    // The person stops using Auto: the agent honours what is stored, and there is nothing to say.
    h.store.state.settings.autoPermissionMode = false
    await say('three')
    expect(await notices()).toHaveLength(1)
    h.store.state.settings.autoPermissionMode = true
    await say('four')
    expect(await notices()).toHaveLength(2)
  })

  it('says nothing for an agent that honours the stored mode', async () => {
    const { requests, say, notices } = await on('gemini')
    await say('one')
    expect(requests[0].approvals).toBe('ask')
    expect(await notices()).toEqual([])
  })

  it('runs a Cursor chat with approvals on: its turn is never refused for its mode', async () => {
    const { requests, say, ended } = await withEnded()
    await say('go')
    expect(ended).toEqual(['completed'])
    expect(requests).toHaveLength(1)
  })

  async function withEnded() {
    const requests: TurnRequest[] = []
    registerDriver({ ...fakeDriver(async (req, cb) => (requests.push(req), cb.sessionStarted('s'), cb.finished({ ok: true }))), kind: 'cursor' })
    const h = await setupSessions()
    h.store.state.settings.requireToolApprovals = true
    await h.sessions.updateSession(h.session.id, { agent: 'cursor', model: 'auto' })
    return {
      requests,
      ended: h.ended,
      say: async (text: string) => {
        await h.sessions.send(h.session.id, text)
        await vi.waitFor(() => expect(h.ended.length).toBeGreaterThan(0), { timeout: 10_000 })
      }
    }
  }
})
