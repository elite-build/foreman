// The capability record as a list (shared/agentCapabilityList.ts): groups in the record's order, three levels per line, one
// sentence per fallback, and the open-or-closed rule. Pure; the Settings page that draws it is tested in
// capabilitiesSection.test.tsx.
import { describe, expect, it } from 'vitest'
import { ability, type AgentCapabilities, type FallbackId } from '../src/shared/agentCapabilities'
import { capabilityGroups, countLevels, FALLBACK_SENTENCE, MODE_LABEL, startsOpen } from '../src/shared/agentCapabilityList'
import { AGENT_CATALOG, staticCapabilities } from '../src/shared/agentCatalog'
import { createT, type PlainKey } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'

const record = (id: string): AgentCapabilities => staticCapabilities(id)!
const groupOf = (id: string, group: string) => capabilityGroups(record(id)).find((g) => g.id === group)!
const lineOf = (id: string, line: string) => capabilityGroups(record(id)).flatMap((g) => g.lines).find((l) => l.id === line)!

describe('capabilityGroups', () => {
  it('lists the groups in the order of the record', () => {
    expect(capabilityGroups(record('claude')).map((g) => g.id)).toEqual(['sessions', 'threads', 'turns', 'planning', 'approvals', 'tools', 'subagents', 'context', 'checkpointing', 'enforcement', 'usage'])
  })

  it('gives every chat-capable agent the same lines, each with a label and a level', () => {
    const shape = capabilityGroups(record('claude')).map((g) => g.lines.map((l) => l.id))
    for (const agent of AGENT_CATALOG.filter((a) => a.level !== 'terminal')) {
      const groups = capabilityGroups(record(agent.id))
      expect(groups.map((g) => g.lines.map((l) => l.id)), agent.id).toEqual(shape)
      for (const line of groups.flatMap((g) => g.lines)) {
        expect(['native', 'fallback', 'none'], `${agent.id} ${line.id}`).toContain(line.level)
        expect(en[line.label], line.label).toBeTruthy()
      }
    }
  })

  it('says what works as Works, with no sentence of its own', () => {
    const steer = lineOf('claude', 'turns.steer')
    expect(steer.level).toBe('native')
    expect(steer.detail).toBeUndefined()
  })

  it('names the fallback sentence of a line that works by a fallback', () => {
    const fork = lineOf('cursor', 'threads.fork')
    expect(fork).toMatchObject({ level: 'fallback', detail: FALLBACK_SENTENCE['prompt-history'] })
    // Codex forks through its own thread/fork.
    expect(lineOf('codex', 'threads.fork')).toMatchObject({ level: 'native' })
    // A hand-off by text is the fallback for every agent today.
    expect(lineOf('claude', 'context.handoff')).toMatchObject({ level: 'fallback', detail: FALLBACK_SENTENCE['prompt-history'] })
  })

  it('gives the record’s own reason for a line that is not offered', () => {
    expect(lineOf('cursor', 'planning.planMode')).toMatchObject({ level: 'none', detail: 'agentCaps.why.plan' })
    expect(lineOf('cursor', 'approvals.approvalTools')).toMatchObject({ level: 'none', detail: 'agentCaps.why.approvals' })
    expect(lineOf('codex', 'subagents.children')).toMatchObject({ level: 'none', detail: 'agentCaps.why.children' })
    expect(lineOf('claude', 'subagents.stopChild')).toMatchObject({ level: 'native' })
  })

  it('reads plain facts in the same three words: restore, read-only, modes and usage', () => {
    expect(lineOf('claude', 'checkpointing.restoreFiles')).toMatchObject({ level: 'native', note: 'agentCaps.note.restoreFiles' })
    expect(lineOf('claude', 'enforcement.readOnly')).toMatchObject({ level: 'native', note: 'agentCaps.note.readOnlyPlan' })
    expect(lineOf('codex', 'enforcement.readOnly')).toMatchObject({ level: 'native', note: 'agentCaps.note.readOnlySandbox' })
    expect(lineOf('cursor', 'enforcement.readOnly')).toMatchObject({ level: 'none', detail: 'agentCaps.why.readOnly' })
    expect(lineOf('claude', 'enforcement.modes')).toMatchObject({ level: 'native', modes: ['ask', 'ask-except-edits', 'auto', 'never-ask'] })
    expect(lineOf('cursor', 'enforcement.modes')).toMatchObject({ level: 'none', detail: 'agentCaps.why.oneMode' })
    expect(lineOf('claude', 'usage.resetTime').level).toBe('native')
    expect(lineOf('codex', 'usage.resetTime').level).toBe('native')
    expect(lineOf('codex', 'usage.limitWindows').level).toBe('native')
    expect(lineOf('cursor', 'usage.resetTime')).toMatchObject({ level: 'none', detail: 'agentCaps.why.resetTime' })
    expect(lineOf('cursor', 'usage.limitWindows')).toMatchObject({ level: 'none', detail: 'agentCaps.why.limitWindows' })
  })

  it('follows a changed record: an ability the agent gained is Works, a fallback changes the sentence', () => {
    const changed: AgentCapabilities = { ...record('cursor'), turns: { steer: ability('fallback', 'interrupt-restart') }, planning: { ...record('cursor').planning, planMode: ability('native') } }
    const lines = capabilityGroups(changed).flatMap((g) => g.lines)
    expect(lines.find((l) => l.id === 'turns.steer')).toMatchObject({ level: 'fallback', detail: FALLBACK_SENTENCE['interrupt-restart'] })
    expect(lines.find((l) => l.id === 'planning.planMode')).toMatchObject({ level: 'native' })
  })

  it('shows a record that has an ability with no reason as a generic reason, never as nothing', () => {
    const odd: AgentCapabilities = { ...record('cursor'), tools: { ...record('cursor').tools, mcp: { level: 'none' } } }
    expect(capabilityGroups(odd).flatMap((g) => g.lines).find((l) => l.id === 'tools.mcp')).toMatchObject({ level: 'none', detail: 'agentCaps.why.generic' })
  })
})

describe('the words', () => {
  it('has one sentence in English for every fallback, each different', () => {
    const ids: FallbackId[] = ['interrupt-restart', 'checkpoint-fresh-session', 'prompt-history', 'session-always', 'once-always', 'server-per-turn']
    expect(Object.keys(FALLBACK_SENTENCE).sort()).toEqual([...ids].sort())
    const sentences = ids.map((id) => en[FALLBACK_SENTENCE[id]])
    expect(sentences.every((s) => typeof s === 'string' && s.length > 10)).toBe(true)
    expect(new Set(sentences).size).toBe(ids.length)
  })

  it('has a reason in English for every reason a record can give', () => {
    const reasons = new Set<PlainKey>()
    for (const agent of AGENT_CATALOG.filter((a) => a.level !== 'terminal')) {
      for (const line of capabilityGroups(record(agent.id)).flatMap((g) => g.lines)) if (line.level === 'none' && line.detail) reasons.add(line.detail)
    }
    expect(reasons.size).toBeGreaterThan(5)
    for (const key of reasons) expect(en[key], key).toBeTruthy()
  })

  it('words every permission mode', () => {
    const t = createT('en')
    expect(Object.values(MODE_LABEL).map((k) => t(k))).toEqual(['Ask', 'Ask except edits', 'Auto', 'Never ask'])
  })
})

describe('counts and open groups', () => {
  it('counts the lines of each level', () => {
    expect(countLevels(groupOf('cursor', 'threads').lines)).toEqual({ native: 1, fallback: 1, none: 0 })
    expect(countLevels(groupOf('codex', 'threads').lines)).toEqual({ native: 2, fallback: 0, none: 0 })
    expect(countLevels(groupOf('cursor', 'planning').lines)).toEqual({ native: 0, fallback: 0, none: 3 })
  })

  it('starts a group closed only when everything in it works', () => {
    expect(startsOpen(groupOf('codex', 'sessions'))).toBe(false)
    expect(startsOpen(groupOf('codex', 'planning'))).toBe(false)
    expect(startsOpen(groupOf('codex', 'threads'))).toBe(false)
    expect(startsOpen(groupOf('cursor', 'threads'))).toBe(true)
    expect(startsOpen(groupOf('cursor', 'planning'))).toBe(true)
  })
})
