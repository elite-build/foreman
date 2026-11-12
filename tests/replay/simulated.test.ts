// The `simulated` fixtures (OpenCode, the shared ACP folder, Cursor), recorded from the protocol fakes (fixtures/fakes.ts)
// and played through the real adapters (docs/agents.md, 9.4). They prove how the adapter handles the protocol, not
// what the real agent says; their records stay `simulated`.
import { afterEach, describe, expect, it } from 'vitest'
import { driverFor } from '../../src/main/agents/registry'
import { cursorProcessDriver } from '../../src/main/agents/cursor/process'
import { opencodeDriver } from '../../src/main/agents/opencode'
import { hasFixture } from '../../src/main/agents/fixtures/format'
import type { AgentDriver } from '../../src/main/agents/types'
import { waitFor } from '../helpers'
import { replay, type Person, type Replayed } from './harness'

let current: Replayed | undefined
afterEach(() => {
  current?.handle.uninstall()
})

const play = async (driver: AgentDriver, agent: string, scenario: string, person: Person = {}, overrides = {}) => {
  current = await replay(driver, agent, scenario, person, overrides)
  await current.done
  return current
}

async function playWith(driver: AgentDriver, agent: string, scenario: string, act: (r: Replayed) => void) {
  current = await replay(driver, agent, scenario)
  const r = current
  await waitFor(() => expect(r.played.items.some((i) => i.kind === 'assistant')).toBe(true))
  act(r)
  await r.done
  return r
}

// OpenCode has its own folder; the other ACP chat agents share `acp`, and run through their own catalog driver.
describe.each([
  ['opencode', opencodeDriver],
  ['acp', driverFor('gemini')]
] as const)('ACP fixtures: %s', (agent, driver) => {
  it('has its scenarios, marked simulated', () => {
    for (const scenario of ['plain', 'approval', 'question', 'terminal', 'interrupt', 'crash', 'resume']) expect(hasFixture(agent, scenario), scenario).toBe(true)
  })

  it('plain: the answer, the cost and the usage', async () => {
    const r = await play(driver, agent, 'plain')
    expect(r.fixture.header.evidence).toBe('simulated')
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.played.sessions).toEqual(['sess-1'])
    expect(r.played.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(r.played.find('result')[0]).toMatchObject({ ok: true, costUsd: 0.05 })
    expect(r.played.usage).toEqual([{ used: 1200, limit: 200_000 }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('approval: the permission request reaches the person, and the answer goes back', async () => {
    const r = await play(driver, agent, 'approval')
    expect(r.played.approvals).toHaveLength(1)
    expect(r.played.approvals[0]).toMatchObject({ kind: 'tool', toolName: 'Bash' })
    expect(r.played.find('tool')[0]).toMatchObject({ name: 'Bash', status: 'done', output: '12 passed' })
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('approval: a refusal is the same kind of message, so the recording still plays', async () => {
    const r = await play(driver, agent, 'approval', { approve: () => ({ allow: false }) })
    expect(r.played.approvals).toHaveLength(1)
    expect(r.played.results).toEqual([{ ok: true }])
  })

  it('interrupt: stopping sends session/cancel and the turn ends as stopped', async () => {
    const r = await playWith(driver, agent, 'interrupt', ({ turn }) => void turn.stop())
    expect(r.fixture.frames.some((f) => f.dir === 'send' && (f.data as { method?: string }).method === 'session/cancel')).toBe(true)
    expect(r.played.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('crash: an agent that goes away mid-turn fails the turn', async () => {
    const r = await play(driver, agent, 'crash')
    expect(r.played.results).toEqual([{ ok: false, error: 'The agent exited unexpectedly.' }])
  })

  it('resume: the earlier conversation is loaded, then the new answer', async () => {
    const r = await play(driver, agent, 'resume', {}, { resume: 'sess-1' })
    expect(r.fixture.frames.some((f) => f.dir === 'send' && (f.data as { method?: string }).method === 'session/load')).toBe(true)
    expect(r.played.sessions).toEqual(['sess-1'])
    expect(r.played.find('assistant').map((a) => a.text)).toContain('pineapple')
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })
})

describe('OpenCode versions', () => {
  it('has a fixture for each, marked simulated', () => {
    for (const scenario of ['version1', 'version2']) expect(hasFixture('opencode', scenario), scenario).toBe(true)
  })

  it('1.x: the version is declared', async () => {
    const r = await play(opencodeDriver, 'opencode', 'version1')
    expect(r.fixture.header.evidence).toBe('simulated')
    expect(r.played.declared).toEqual([{ version: '1.14.3' }])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('2.x: the version is declared, and the turn runs the same way (a server of its own)', async () => {
    const r = await play(opencodeDriver, 'opencode', 'version2')
    expect(r.played.declared).toEqual([{ version: '2.1.0' }])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })
})

describe('Cursor fixtures', () => {
  it('has its scenarios, marked simulated', () => {
    for (const scenario of ['plain', 'interrupt', 'resume']) expect(hasFixture('cursor', scenario), scenario).toBe(true)
  })

  it('plain: the worker\'s events become the chat', async () => {
    const r = await play(cursorProcessDriver, 'cursor', 'plain')
    expect(r.fixture.header.evidence).toBe('simulated')
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.played.sessions).toEqual(['agent-1'])
    expect(r.played.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(r.played.usage).toEqual([{ used: 1204, limit: 200_000 }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('interrupt: stopping cancels the run, and the turn ends as stopped', async () => {
    const r = await playWith(cursorProcessDriver, 'cursor', 'interrupt', ({ turn }) => void turn.stop())
    expect(r.fixture.frames.some((f) => f.dir === 'send' && (f.data as { type?: string }).type === 'stop')).toBe(true)
    expect(r.played.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('resume: the second turn resumes the same agent', async () => {
    const r = await play(cursorProcessDriver, 'cursor', 'resume', {}, { resume: 'agent-1' })
    expect(r.played.sessions).toEqual(['agent-1'])
    expect(r.played.find('assistant').map((a) => a.text)).toEqual(['pineapple'])
    expect(r.played.results).toEqual([{ ok: true }])
  })
})
