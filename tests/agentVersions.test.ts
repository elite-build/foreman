// Version tables (docs/agents.md, 4.1): the pure functions, and what the catalog files claim held against what is on disk.
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureFolder, readFixture } from '../src/main/agents/fixtures/format'
import { AGENT_CATALOG, catalogAgent, FULL_AGENT_IDS } from '../src/shared/agentCatalog'
import { brokenReason, compareVersions, degradedReason, inRange, modelMinimum, olderThan, parseVersion, statusOf, testedVersion, updateArgs, versionStatus, type VersionTable } from '../src/shared/agentVersions'
import { en } from '../src/shared/i18n/en'

describe('reading versions', () => {
  it('finds x.y.z in what the CLIs print', () => {
    expect(parseVersion('2.1.301 (Claude Code)')).toEqual([2, 1, 301])
    expect(parseVersion('codex-cli 0.163.0')).toEqual([0, 163, 0])
    expect(parseVersion('v1.2.3-beta.1')).toEqual([1, 2, 3])
    expect(parseVersion('dev')).toBeUndefined()
    expect(parseVersion(undefined)).toBeUndefined()
  })

  it('compares numerically, not as text', () => {
    expect(compareVersions('0.163.0', '0.20.0')).toBeGreaterThan(0)
    expect(compareVersions('2.1.301', '2.1.301')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('dev', '1.0.0')).toBeUndefined()
    expect(olderThan('0.9.0', '0.10.0')).toBe(true)
    expect(olderThan('dev', '0.10.0')).toBe(false)
  })

  it('reads ranges: comparators that must all hold, or one exact version', () => {
    expect(inRange('1.3.0', '>=1.2.0 <1.4.0')).toBe(true)
    expect(inRange('1.4.0', '>=1.2.0 <1.4.0')).toBe(false)
    expect(inRange('1.2.0', '<=1.2.0')).toBe(true)
    expect(inRange('1.2.1', '>1.2.0')).toBe(true)
    expect(inRange('1.2.3', '1.2.3')).toBe(true)
    expect(inRange('1.2.4', '1.2.3')).toBe(false)
    expect(inRange('dev', '<9.0.0')).toBe(false)
  })
})

describe('the status of a version', () => {
  const table: VersionTable = {
    tested: ['1.5.0'],
    minimum: '1.0.0',
    degraded: [{ below: '1.4.0', why: 'agentCaps.why.plan' }, { range: '>=1.6.0 <1.6.2', why: 'agentCaps.why.cost' }],
    broken: [{ range: '1.3.1', why: 'agentCaps.why.steer' }]
  }

  it('is tested for a version the fixtures were recorded with', () => {
    expect(statusOf(table, '1.5.0')).toBe('tested')
  })

  it('is untested for anything else, and for what cannot be read, and for an agent with no table', () => {
    expect(statusOf(table, '1.5.1')).toBe('untested')
    expect(statusOf(table, 'dev')).toBe('untested')
    expect(statusOf(undefined, '1.5.0')).toBe('untested')
    expect(versionStatus('gemini', '1.0.0')).toBe('untested')
  })

  it('is degraded inside a degraded range or below its bound, with the reason', () => {
    expect(statusOf(table, '1.3.9')).toBe('degraded')
    expect(degradedReason(table, '1.3.9')).toBe('agentCaps.why.plan')
    expect(statusOf(table, '1.6.1')).toBe('degraded')
    expect(degradedReason(table, '1.6.1')).toBe('agentCaps.why.cost')
    expect(statusOf(table, '1.6.2')).toBe('untested')
  })

  it('is broken in a broken range or below the minimum, and that beats degraded and tested', () => {
    expect(statusOf(table, '1.3.1')).toBe('broken')
    expect(brokenReason(table, '1.3.1')).toEqual({ why: 'agentCaps.why.steer' })
    expect(statusOf(table, '0.9.9')).toBe('broken')
    expect(brokenReason(table, '0.9.9')).toEqual({ below: '1.0.0' })
    expect(statusOf({ ...table, tested: ['1.3.1'] }, '1.3.1')).toBe('broken')
  })

  it('reads the catalog: Claude 2.1.301 and Codex 0.163.0 are tested, other versions are not', () => {
    expect(versionStatus('claude', '2.1.301')).toBe('tested')
    expect(versionStatus('claude', '2.1.319')).toBe('untested')
    expect(versionStatus('codex', '0.163.0')).toBe('tested')
    expect(versionStatus('codex', '0.164.0')).toBe('untested')
    // OpenCode and Cursor have only simulated fixtures: nothing is tested.
    expect(versionStatus('opencode', '1.0.0')).toBe('untested')
    expect(testedVersion('codex')).toBe('0.163.0')
    expect(testedVersion('cursor')).toBeUndefined()
  })
})

describe('what the catalog files claim', () => {
  const fixtureVersions = (agent: string): string[] => {
    const folder = fixtureFolder(agent)
    const root = new URL(`../src/main/agents/${folder}/fixtures/`, import.meta.url)
    return [
      ...new Set(
        readdirSync(root)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => readFixture(folder, f.replace(/\.jsonl$/, '')).header)
          .filter((h) => h.evidence === 'recorded' || h.evidence === 'edited')
          .map((h) => h.version)
      )
    ].sort()
  }

  it.each(['claude', 'codex'])('%s: its tested versions are the versions its fixtures were recorded with', (agent) => {
    expect(fixtureVersions(agent)).toEqual([...catalogAgent(agent)!.versions!.tested].sort())
  })

  it('every Full agent has a table, and an agent with only simulated fixtures claims no tested version', () => {
    for (const id of FULL_AGENT_IDS) expect(catalogAgent(id)!.versions, id).toBeDefined()
    expect(catalogAgent('cursor')!.versions!.tested).toEqual([])
    expect(catalogAgent('opencode')!.versions!.tested).toEqual([])
  })

  it('sets no minimum it cannot back: Claude and Codex have none (see agentCatalog/claude.ts, codex.ts)', () => {
    expect(catalogAgent('claude')!.versions!.minimum).toBeUndefined()
    expect(catalogAgent('codex')!.versions!.minimum).toBeUndefined()
  })

  it('has an update command only where the agent’s own --help shows one: claude update, codex update', () => {
    expect(updateArgs('claude')).toEqual(['update'])
    expect(updateArgs('codex')).toEqual(['update'])
    for (const agent of AGENT_CATALOG) if (agent.id !== 'claude' && agent.id !== 'codex') expect(agent.versions?.update, agent.id).toBeUndefined()
  })

  it('names, in every table, only messages that exist', () => {
    for (const agent of AGENT_CATALOG) {
      for (const d of agent.versions?.degraded ?? []) expect(en, `${agent.id}: ${d.why}`).toHaveProperty([d.why])
      for (const b of agent.versions?.broken ?? []) expect(en, `${agent.id}: ${b.why}`).toHaveProperty([b.why])
    }
  })

  it('has no model minimum for a model the agent has not said it needs (Codex’s model/list upgrade fields name a newer model, not a newer CLI)', () => {
    expect(modelMinimum('codex', 'gpt-6.1-sol')).toBeUndefined()
  })
})
