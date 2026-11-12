// The capability record (docs/agents.md, 2.1 and 2.3): resolving what an agent declares into its static record, the old
// per-agent flags and facts agreeing with the record (so they can never disagree), the driver-derived features, and the
// record reaching the snapshot.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { agentCapabilitiesView, driverFeatures, recordFor } from '../src/main/agents/capabilities'
import { driverFor } from '../src/main/agents/registry'
import type { AgentDriver } from '../src/main/agents/types'
import { scheduleProblem, type ScheduleInput } from '../src/main/schedules'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { ability, capabilitiesFor, DRIVER_FEATURES, EVERY_ACCOUNT, offers, resolveCapabilities, type AgentCapabilities, type AgentCapabilitiesView } from '../src/shared/agentCapabilities'
import { CEILINGS_ENFORCED } from '../src/shared/agentAccess'
import { acpPlanMode, AGENT_CATALOG, catalogAgent, CHAT_AGENT_IDS, FULL_AGENT_IDS, repoMcpSupport, staticCapabilities, staticCapabilitiesView, TERMINAL_AGENT_IDS } from '../src/shared/agentCatalog'
import { keptRunning } from '../src/shared/agentHost'
import { hasReportTools } from '../src/shared/agentReports'
import { AGENT_ORDER, AGENTS, chatAgentKinds, type AgentKind } from '../src/shared/agents'
import { assistantAgents } from '../src/shared/assistant'
import { en } from '../src/shared/i18n/en'
import { readOnlyEnforcement } from '../src/shared/permissions'
import { repoCommands } from '../src/shared/repoCommands'
import type { AppSnapshot, MainEvent } from '../src/shared/types'
import { readsResetTime } from '../src/shared/usageLimit'
import { tempDir } from './helpers'

const chatKinds = [...FULL_AGENT_IDS, ...CHAT_AGENT_IDS] as AgentKind[]

const record = (id: string): AgentCapabilities => staticCapabilities(id)!

afterEach(() => vi.restoreAllMocks())

describe('the records', () => {
  it('exist for every agent that can hold a chat, and for no terminal agent', () => {
    for (const id of chatKinds) expect(staticCapabilities(id), id).toBeDefined()
    for (const id of TERMINAL_AGENT_IDS) expect(staticCapabilities(id), id).toBeUndefined()
    expect(staticCapabilities('nobody')).toBeUndefined()
    expect(chatAgentKinds().sort()).toEqual([...chatKinds].sort())
    expect(Object.keys(staticCapabilitiesView().agents).sort()).toEqual([...chatKinds].sort())
  })

  it('give a fallback its id and a none its reason, a real sentence in English', () => {
    const abilities = (r: AgentCapabilities) => [r.sessions.modelSwitch, r.sessions.concurrentChats, r.threads.resume, r.threads.fork, r.turns.steer, r.planning.planMode, r.planning.questions, r.approvals.tools, r.approvals.alwaysAllow, r.tools.mcp, r.subagents.children, r.subagents.stop, r.context.compact, r.checkpointing.conversationRollback, r.enforcement.scopedWrites]
    for (const id of chatKinds) {
      for (const a of abilities(record(id))) {
        if (a.level === 'fallback') expect(a.fallback, id).toBeTruthy()
        if (a.level === 'none') expect(en[a.why!], `${id}: ${a.why}`).toMatch(/\S{3,}/)
        if (a.level === 'native') expect(a.why ?? a.fallback).toBeUndefined()
      }
    }
  })

  it('claims no ability the adapters lack today', () => {
    // The ACP agents and Cursor can't steer a running turn (they are interrupted and restarted, on request); nobody forks natively, compacts on request, rewinds its own conversation
    // or keeps goals but Claude Code and Codex (the latter three: Codex's thread/fork, thread/compact/start, thread/revert and
    // thread/goal, each recorded in a fixture the proof test replays).
    const own = ['claude', 'codex']
    for (const id of chatKinds.filter((k) => !own.includes(k))) expect(record(id).turns.steer, id).toEqual(ability('fallback', 'interrupt-restart'))
    for (const id of chatKinds.filter((k) => !own.includes(k))) {
      expect(record(id).threads.fork, id).toEqual(ability('fallback', 'prompt-history'))
      expect(record(id).checkpointing.conversationRollback, id).toEqual(ability('fallback', 'checkpoint-fresh-session'))
      expect(record(id).context.compact.level, id).not.toBe('native')
      expect(record(id).planning.goals.level, id).toBe('none')
    }
    for (const id of own) {
      expect(record(id).threads.fork.level, id).toBe('native')
      expect(record(id).checkpointing.conversationRollback.level, id).toBe('native')
      expect(record(id).context.compact.level, id).toBe('native')
    }
    // A goal is Codex's: Claude Code has none.
    expect(record('codex').planning.goals.level).toBe('native')
    expect(record('claude').planning.goals.level).toBe('none')
    // Claude Code and Codex are proven against traffic recorded from them (tests/agentCapabilityProof.test.ts); nobody has
    // recorded the others.
    for (const id of chatKinds) expect(record(id).evidence, id).toBe(id === 'claude' || id === 'codex' ? 'recorded' : 'simulated')
  })
})

describe('resolving what an agent declared', () => {
  it('turns an ACP agent’s plan mode on when it declared one, and leaves every other agent alone', () => {
    const gemini = record('gemini')
    expect(gemini.planning.planMode.level).toBe('none')
    expect(resolveCapabilities(gemini, { planMode: true }).planning.planMode).toEqual(ability('native'))
    expect(resolveCapabilities(gemini, { planMode: false }).planning.planMode.level).toBe('none')
    // OpenCode is ACP too; Cursor and Claude Code don't declare one.
    expect(resolveCapabilities(record('opencode'), { planMode: true }).planning.planMode.level).toBe('native')
    expect(resolveCapabilities(record('cursor'), { planMode: true }).planning.planMode.level).toBe('none')
    expect(resolveCapabilities(record('claude'), { planMode: false }).planning.planMode.level).toBe('native')
    // The base is not changed, and nothing declared hands back the same object.
    expect(gemini.planning.planMode.level).toBe('none')
    expect(resolveCapabilities(gemini)).toBe(gemini)
    expect(resolveCapabilities(gemini, {})).toBe(gemini)
  })

  it('a declared plan mode turns Plan on only for the agents whose record says they declare one', () => {
    for (const id of chatKinds) {
      const declares = record(id).declares.includes('planMode')
      expect(offers(resolveCapabilities(record(id), { planMode: true }).planning.planMode), id).toBe(declares || offers(record(id).planning.planMode))
    }
    expect(chatKinds.filter((id) => record(id).declares.includes('planMode')).length).toBeGreaterThan(0)
  })

  it('accepts a version, and takes enforcement away when the sandbox isn’t ready, only for an agent that declares them', () => {
    const declaring: AgentCapabilities = { ...record('codex'), declares: ['version', 'windowsSandbox'] }
    expect(resolveCapabilities(declaring, { version: '0.163.0' }).version).toBe('0.163.0')
    const unready = resolveCapabilities(declaring, { windowsSandbox: 'not-ready' })
    expect(unready.enforcement.readOnly).toBeNull()
    expect(unready.enforcement.scopedWrites.level).toBe('none')
    expect(resolveCapabilities(declaring, { windowsSandbox: 'ready' }).enforcement.readOnly).toBe('sandbox')
    // Codex declares its Windows sandbox and not a version: the sandbox takes its enforcement away, the version changes nothing.
    expect(record('codex').declares).toEqual(['windowsSandbox'])
    expect(resolveCapabilities(record('codex'), { version: '0.163.0' })).toBe(record('codex'))
    expect(resolveCapabilities(record('codex'), { windowsSandbox: 'not-ready' }).enforcement).toMatchObject({ by: 'agent', readOnly: null, scopedWrites: { level: 'none', why: 'agentCaps.why.sandboxNotReady' } })
    expect(resolveCapabilities(record('codex'), { windowsSandbox: 'ready' })).toEqual(record('codex'))
    // An agent that doesn't declare it (Claude) can't have its enforcement taken away by the same fact.
    expect(resolveCapabilities(record('claude'), { windowsSandbox: 'not-ready' })).toBe(record('claude'))
  })

  it('lets an account’s own declaration win over what every account of the agent declared', () => {
    const view: AgentCapabilitiesView = {
      agents: { gemini: record('gemini'), codex: { ...record('codex'), declares: ['version'] } },
      declared: {
        gemini: { [EVERY_ACCOUNT]: { planMode: true }, work: { planMode: false } },
        codex: { [EVERY_ACCOUNT]: { version: '0.160.0' }, work: { version: '0.163.0' } }
      }
    }
    expect(capabilitiesFor(view, 'gemini')?.planning.planMode.level).toBe('native')
    expect(capabilitiesFor(view, 'gemini', 'home')?.planning.planMode.level).toBe('native')
    expect(capabilitiesFor(view, 'gemini', 'work')?.planning.planMode.level).toBe('none')
    expect(capabilitiesFor(view, 'codex')?.version).toBe('0.160.0')
    expect(capabilitiesFor(view, 'codex', 'work')?.version).toBe('0.163.0')
    expect(capabilitiesFor(view, 'aider')).toBeUndefined()
  })

  it('reads the static record where nothing was declared', () => {
    expect(capabilitiesFor(staticCapabilitiesView(), 'claude')).toBe(record('claude'))
    expect(capabilitiesFor(staticCapabilitiesView(), 'gemini', 'work')).toBe(record('gemini'))
  })
})

describe('the old flags and facts agree with the records', () => {
  it('the old per-agent flags are gone from AGENTS: the record is the one place that says', () => {
    for (const id of chatKinds) {
      expect(Object.keys(AGENTS[id]).sort(), id).toEqual(['builtinCommands', 'effortLabel', 'kind', 'label'])
    }
  })

  it('the catalog’s chips are read from the record, approvals included: Cursor, which never asks, has none', () => {
    for (const id of chatKinds) {
      const r = record(id)
      expect(catalogAgent(id)!.capabilities, id).toEqual({
        approvals: r.enforcement.permissionModes.length > 1,
        plan: offers(r.planning.planMode),
        steer: r.turns.steer.level === 'native',
        rewind: r.checkpointing.restoreFiles,
        mcp: offers(r.tools.mcp),
        cost: r.usage.cost
      })
    }
  })

  it('read-only enforcement, repo MCP and the approval ceilings say what the records say', () => {
    for (const id of chatKinds) {
      const r = record(id)
      expect(readOnlyEnforcement(r), id).toBe(r.enforcement.readOnly)
      expect(repoMcpSupport(id).supported, id).toBe(offers(r.tools.mcp))
      expect([...CEILINGS_ENFORCED[id]], id).toEqual([...r.enforcement.ceilings])
    }
  })

  // Each of these was an id list or an `agent === 'claude'` rule before the records decided it. The features are pinned
  // here to what they were, and the helpers that read them (keptRunning, assistantAgents, repoCommands, scheduleProblem,
  // hasReportTools, readsResetTime) must say the same.
  it('the static features are what the lists and rules they replaced said', () => {
    const unattended = (id: AgentKind) => !scheduleProblem({ ...SCHEDULE, agent: id })?.includes('Claude only')
    const commands = [{ name: 'review', description: '', kind: 'command' as const }]
    const having = (pick: (f: AgentCapabilities['features']) => boolean) => chatKinds.filter((id) => pick(record(id).features))
    expect(having((f) => f.keptRunning)).toEqual([...FULL_AGENT_IDS])
    expect(having((f) => f.assistant)).toEqual(['claude'])
    expect(having((f) => f.cloud)).toEqual(chatKinds.filter((id) => id !== 'cursor'))
    expect(having((f) => f.reportTools)).toEqual(['claude', 'cursor'])
    expect(having((f) => f.unattended)).toEqual(['claude'])
    expect(having((f) => f.repoCommands)).toEqual(['claude'])
    // Claude from its error text and rate_limit_event, Codex from its rate-limit windows (docs/agents.md 7).
    expect(chatKinds.filter((id) => record(id).usage.resetTime)).toEqual(['claude', 'codex'])
    expect(chatKinds.filter((id) => record(id).usage.limitWindows)).toEqual(['claude', 'codex'])
    expect(assistantAgents()).toEqual(['claude'])
    expect(AGENT_ORDER.filter((id) => keptRunning(id))).toEqual([...FULL_AGENT_IDS])
    for (const id of chatKinds) {
      const f = record(id).features
      expect(keptRunning(id), `${id} keptRunning`).toBe(f.keptRunning)
      expect(hasReportTools(id), `${id} reportTools`).toBe(f.reportTools)
      expect(unattended(id), `${id} unattended`).toBe(f.unattended)
      expect(repoCommands(record(id), commands).length > 0, `${id} repoCommands`).toBe(f.repoCommands)
      expect(readsResetTime(id), `${id} resetTime`).toBe(record(id).usage.resetTime)
    }
  })

  it('every catalog agent with chats is covered, and the terminal agents are not', () => {
    expect(AGENT_CATALOG.filter((a) => a.level !== 'terminal').map((a) => a.id).sort()).toEqual([...chatKinds].sort())
  })
})

describe('features derived from the driver', () => {
  it('each follows from what the registered driver implements', () => {
    const bare = { kind: 'claude', createTurn: () => { throw new Error('unused') }, status: async () => ({ agent: 'claude', installed: false, ready: false }) } as unknown as AgentDriver
    expect(driverFeatures(bare)).toEqual({ titles: false, diffTool: false, followups: false, reportTools: false, transcriptMirror: false })
    expect(driverFeatures({ ...bare, oneShot: async () => '' }).titles).toBe(true)
    expect(driverFeatures({ ...bare, accepts: { reportTools: true } })).toMatchObject({ reportTools: true, diffTool: false })
  })

  it('match the static record for every agent, so the record can’t drift from the adapter', () => {
    for (const id of chatKinds) {
      const derived = driverFeatures(driverFor(id))
      const fromRecord = Object.fromEntries(DRIVER_FEATURES.map((f) => [f, record(id).features[f]]))
      expect(derived, id).toEqual(fromRecord)
    }
    expect(recordFor('claude')!.features.titles).toBe(true)
    expect(recordFor('gemini')!.features.reportTools).toBe(false)
    expect(recordFor('aider' as AgentKind)).toBeUndefined()
  })
})

describe('the snapshot', () => {
  const SNAPSHOT_AGENTS = [...chatKinds].sort()

  it('carries every record, with the plan mode an ACP agent declared', async () => {
    const dir = await tempDir('foreman-capabilities-')
    const store = new Store(dir)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const events: MainEvent[] = []
    const core = new Core(store, secrets, {
      broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => '', screenReader: () => false
    })
    core.attention.stop()
    const before: AppSnapshot = core.snapshot()
    expect(Object.keys(before.agentCapabilities.agents).sort()).toEqual(SNAPSHOT_AGENTS)
    expect(before.agentCapabilities.declared).toEqual({})
    expect(capabilitiesFor(before.agentCapabilities, 'claude')?.features.titles).toBe(true)
    expect(capabilitiesFor(before.agentCapabilities, 'gemini')?.planning.planMode.level).toBe('none')

    // OpenCode and Gemini declare a plan session mode; Codex declares nothing, so what it lists changes nothing.
    store.state.catalog.agents.gemini = { models: [], modes: [{ id: 'plan', name: 'Plan' }, { id: 'default', name: 'Default' }] }
    store.state.catalog.agents.opencode = { models: [], modes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] }
    store.state.catalog.agents.codex = { models: [], modes: [{ id: 'plan', name: 'Plan' }] }
    const after = core.snapshot().agentCapabilities
    expect(Object.keys(after.declared).sort()).toEqual(['gemini', 'opencode'])
    expect(capabilitiesFor(after, 'gemini')?.planning.planMode.level).toBe('native')
    expect(capabilitiesFor(after, 'opencode', 'any-account')?.planning.planMode.level).toBe('native')
    expect(capabilitiesFor(after, 'codex')?.planning.planMode.level).toBe('native')
    expect(capabilitiesFor(after, 'qwen')?.planning.planMode.level).toBe('none')
    // Declared modes only matter where the record says the agent declares them.
    for (const id of chatKinds) expect(offers(capabilitiesFor(after, id)!.planning.planMode), id).toBe(offers(record(id).planning.planMode) || (record(id).declares.includes('planMode') && Boolean(acpPlanMode(store.state.catalog.agents[id]?.modes))))
    // The view builder is what the snapshot holds.
    expect(agentCapabilitiesView(store.state.catalog.agents)).toEqual(after)
  })
})

const SCHEDULE: ScheduleInput = { templateId: 't1', templateName: 'Dependency audit', repoId: 'r1', baseBranch: 'main', recurrence: 'weekly', startDate: '2026-10-20', weekdays: [1], time: '09:00', timezone: 'America/Los_Angeles', agent: 'claude', model: 'claude-sonnet-5-5', maxMinutes: 30 }
