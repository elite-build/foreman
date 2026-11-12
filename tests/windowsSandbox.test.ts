// Codex on Windows (docs/agents.md 8): the sandbox's readiness is a fact each account declares, and an account whose sandbox
// isn't ready is not offered read-only or scoped writes, rather than promised them. Account is the Codex home: one can be set up
// and another not.
import { describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agentCapabilitiesView, capabilitiesOf } from '../src/main/agents/capabilities'
import { parseDeclared, Store } from '../src/main/store'
import { capabilitiesFor, DEFAULT_ACCOUNT, EVERY_ACCOUNT, offers } from '../src/shared/agentCapabilities'
import { readOnlyEnforcement } from '../src/shared/permissions'
import { registerDriver } from '../src/main/agents/registry'
import { codexDriver } from '../src/main/agents/codex'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnRequest } from '../src/main/agents/types'
import { tempDir } from './helpers'
import { fakeDriver, setupSessions } from './sessionHarness'

const catalog = {}

describe('Codex’s record per account, from what each declared', () => {
  it('is the static record where nothing was declared, and loses read-only and scoped writes for the account whose sandbox is not ready', () => {
    const declared = { codex: { work: { windowsSandbox: 'not-ready' as const }, home: { windowsSandbox: 'ready' as const } } }
    const plain = capabilitiesOf('codex', catalog)!
    expect(plain.enforcement.readOnly).toBe('sandbox')
    expect(offers(plain.enforcement.scopedWrites)).toBe(true)
    expect(capabilitiesOf('codex', catalog, declared)).toEqual(plain)
    const work = capabilitiesOf('codex', catalog, declared, 'work')!
    expect(readOnlyEnforcement(work)).toBeNull()
    expect(work.enforcement.scopedWrites).toMatchObject({ level: 'none', why: 'agentCaps.why.sandboxNotReady' })
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, declared, 'home'))).toBe('sandbox')
    expect(offers(capabilitiesOf('codex', catalog, declared, 'home')!.enforcement.scopedWrites)).toBe(true)
    // What was stated for the agent holds for an account that said nothing; its own word wins.
    const every = { codex: { [EVERY_ACCOUNT]: { windowsSandbox: 'not-ready' as const }, home: { windowsSandbox: 'ready' as const } } }
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, every, 'other'))).toBeNull()
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, every, 'home'))).toBe('sandbox')
    // Readiness is per home: the default account's is its own, and no other account inherits it (or the reverse).
    const byDefault = { codex: { [DEFAULT_ACCOUNT]: { windowsSandbox: 'not-ready' as const } } }
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, byDefault))).toBeNull()
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, byDefault, 'work'))).toBe('sandbox')
    const byWork = { codex: { work: { windowsSandbox: 'not-ready' as const } } }
    expect(readOnlyEnforcement(capabilitiesOf('codex', catalog, byWork))).toBe('sandbox')
  })

  it('holds no ceiling below Never ask on an account whose sandbox is not ready: every one of Codex’s is a sandbox policy', () => {
    const declared = { codex: { work: { windowsSandbox: 'not-ready' as const } } }
    expect(capabilitiesOf('codex', catalog)!.enforcement.ceilings).toEqual(['ask', 'ask-except-edits', 'auto', 'never-ask'])
    expect(capabilitiesOf('codex', catalog, declared, 'work')!.enforcement.ceilings).toEqual(['never-ask'])
    expect(capabilitiesOf('codex', catalog, declared)!.enforcement.ceilings).toHaveLength(4)
  })

  it('never touches an agent that does not declare it', () => {
    const declared = { claude: { [EVERY_ACCOUNT]: { windowsSandbox: 'not-ready' as const } } }
    expect(readOnlyEnforcement(capabilitiesOf('claude', catalog, declared))).toBe('plan')
  })

  it('reaches the snapshot, where the composer, the second-opinion dialog and Settings read it for the account', () => {
    const view = agentCapabilitiesView(catalog, { codex: { work: { windowsSandbox: 'not-ready' } } })
    expect(view.declared.codex).toEqual({ work: { windowsSandbox: 'not-ready' } })
    expect(readOnlyEnforcement(capabilitiesFor(view, 'codex', 'work'))).toBeNull()
    expect(readOnlyEnforcement(capabilitiesFor(view, 'codex'))).toBe('sandbox')
    // An agent that declares nothing keeps nothing in the view, whatever was stored under it.
    expect(agentCapabilitiesView(catalog, { claude: { '': { windowsSandbox: 'not-ready' } } }).declared.claude).toBeUndefined()
  })
})

describe('what state.json keeps of a declaration', () => {
  it('keeps a version and the sandbox’s readiness, and drops anything else', () => {
    expect(
      parseDeclared({
        codex: { default: { windowsSandbox: 'ready' }, work: { windowsSandbox: 'not-ready', version: '0.163.0', extra: 1 }, bad: { windowsSandbox: 'sort of' }, worse: 7 },
        opencode: { default: { version: '2.1.0' } },
        broken: 'x'
      })
    ).toEqual({ codex: { default: { windowsSandbox: 'ready' }, work: { windowsSandbox: 'not-ready', version: '0.163.0' } }, opencode: { default: { version: '2.1.0' } } })
    // What an earlier build kept for the default account under the key for every account is the default account's.
    expect(parseDeclared({ codex: { '': { windowsSandbox: 'not-ready' } } })).toEqual({ codex: { default: { windowsSandbox: 'not-ready' } } })
  })
})

describe('a flow step’s scoped writes on Codex', () => {
  it('reach the Codex turn as its write scope where the sandbox is ready, and refuse the turn on an account whose sandbox is not', async () => {
    const requests: TurnRequest[] = []
    registerDriver({ ...fakeDriver(async (req, cb) => (requests.push(req), cb.finished({ ok: true }))), kind: 'codex' })
    try {
      const h = await setupSessions()
      h.store.state.settings.agentInstances = [{ id: 'ai-work0001', agent: 'codex', label: 'Work', auth: 'cli' }]
      h.sessions.recordDeclared('codex', 'ai-work0001', { windowsSandbox: 'not-ready' })
      const persona = { name: 'pm', instructions: 'Decide what to build.', writes: ['docs/features/**'] }
      const settled = () => vi.waitFor(() => expect(h.sessions.session(codexTab.id).turnId).toBeUndefined(), { timeout: 10_000 })
      const codexTab = h.sessions.createSession(h.ws.id, { agent: 'codex', title: 'ready' })
      h.sessions.markUnattended('turn-ready', { flowRunId: 'run-1', step: 'requirements', persona })
      await h.sessions.send(codexTab.id, 'write the requirements', { turnId: 'turn-ready' })
      await settled()
      expect(requests[0].writeScope).toEqual(['docs/features/**'])
      expect(requests[0].systemPromptAppend).toContain('This step may only write files inside docs/features/**')

      // The same persona on the account whose sandbox is not ready: the turn is refused, saying why, and the agent never starts.
      const workTab = h.sessions.createSession(h.ws.id, { agent: 'codex', instanceId: 'ai-work0001', title: 'work' })
      h.sessions.markUnattended('turn-work', { flowRunId: 'run-1', step: 'requirements', persona })
      const before = requests.length
      await h.sessions.send(workTab.id, 'write the requirements', { turnId: 'turn-work' }).catch(() => undefined)
      await vi.waitFor(() => expect(h.ended.at(-1)).toBe('error'), { timeout: 10_000 })
      expect(requests).toHaveLength(before)
      expect(JSON.stringify(await h.store.readChat(workTab.id))).toContain('which Codex can’t be held to while its sandbox isn’t ready on this computer')
    } finally {
      registerDriver(codexDriver)
      registerDriver(claudeDriver)
    }
  })
})

describe('the session service', () => {
  it('keeps each account’s declaration, saving only a change, and holds a read-only chat to the account’s own record', async () => {
    const h = await setupSessions()
    const saved = vi.spyOn(h.store, 'save')
    const saves = () => saved.mock.calls.length
    h.sessions.recordDeclared('codex', 'work', { windowsSandbox: 'not-ready' })
    const first = saves()
    expect(first).toBeGreaterThan(0)
    // Said again, it changes nothing and saves nothing.
    h.sessions.recordDeclared('codex', 'work', { windowsSandbox: 'not-ready' })
    expect(saves()).toBe(first)
    h.sessions.recordDeclared('codex', undefined, { windowsSandbox: 'ready' })
    expect(saves()).toBeGreaterThan(first)
    expect(h.store.state.declared).toEqual({ codex: { work: { windowsSandbox: 'not-ready' }, [DEFAULT_ACCOUNT]: { windowsSandbox: 'ready' } } })
    // A version arriving later is added to what the account said, not instead of it.
    h.sessions.recordDeclared('codex', 'work', { version: '0.163.0' })
    expect(h.store.state.declared?.codex.work).toEqual({ windowsSandbox: 'not-ready', version: '0.163.0' })
    const after = saves()
    h.sessions.recordDeclared('codex', 'work', {})
    expect(saves()).toBe(after)

    const readOnly = (instanceId?: string) => {
      const session = h.sessions.createSession(h.ws.id, { agent: 'codex' })
      session.readOnly = true
      session.instanceId = instanceId
      return (h.sessions as unknown as { readOnly(s: unknown): unknown }).readOnly(session)
    }
    expect(readOnly()).toBe('sandbox')
    expect(() => readOnly('work')).toThrow(/Codex can’t enforce while its sandbox isn’t ready on this computer/)
  })

  it('refuses a capped turn on the account whose sandbox is not ready, and runs it on one that is (the turn’s account, not the agent’s)', async () => {
    const h = await setupSessions()
    h.sessions.recordDeclared('codex', 'work', { windowsSandbox: 'not-ready' })
    h.sessions.recordDeclared('codex', undefined, { windowsSandbox: 'ready' })
    const policy = (instanceId: string | undefined, ceiling: 'ask' | 'never-ask') => {
      const session = h.sessions.createSession(h.ws.id, { agent: 'codex' })
      session.instanceId = instanceId
      session.turnCap = { ceiling, grantId: 'g', name: 'Claude Code' }
      return (h.sessions as unknown as { resolvePolicy(s: unknown): { policy: string } }).resolvePolicy(session).policy
    }
    expect(policy(undefined, 'ask')).toBe('ask')
    expect(() => policy('work', 'ask')).toThrow()
    // A ceiling of Never ask holds nothing below it, so it is no ceiling to hold.
    expect(() => policy('work', 'never-ask')).not.toThrow()
  })
})

describe('settings read back from state.json', () => {
  async function load(settings: Record<string, unknown>) {
    const dir = await tempDir('foreman-settings-')
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos: [], settings }))
    const store = new Store(dir)
    await store.load()
    const { idleCompactTokens, replayTraffic } = store.state.settings
    store.close()
    return { idleCompactTokens, replayTraffic }
  }

  it('keeps an idle-compaction threshold and a replay switch that are valid, and resets the ones that are not', async () => {
    expect(await load({ idleCompactTokens: 150_000, replayTraffic: true })).toEqual({ idleCompactTokens: 150_000, replayTraffic: true })
    expect(await load({})).toEqual({ idleCompactTokens: 0, replayTraffic: false })
    for (const bad of [-1, 1.5, '150000', null, Number.NaN, 10_000_001, {}]) expect((await load({ idleCompactTokens: bad })).idleCompactTokens, String(bad)).toBe(0)
    for (const odd of ['true', 1, 'yes', {}]) expect((await load({ replayTraffic: odd })).replayTraffic, String(odd)).toBe(false)
  })
})
