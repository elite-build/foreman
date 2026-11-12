// Claude Code's fixtures through the real driver and the real Agent SDK, over a fake CLI process that plays the recording
// (docs/agents.md, 9.3). Only the CLI's stdio is replaced; everything above it is the code that ships.
import { afterEach, describe, expect, it } from 'vitest'
import { claudeDriver } from '../../src/main/agents/claude'
import { hasFixture } from '../../src/main/agents/fixtures/format'
import { claudeProtocol } from '../../src/main/agents/fixtures/replay'
import { waitFor } from '../helpers'
import { replay, type Person, type Replayed } from './harness'

let current: Replayed | undefined
afterEach(() => current?.handle.uninstall())

async function play(scenario: string, person: Person = {}, overrides = {}) {
  current = await replay(claudeDriver, 'claude', scenario, person, overrides)
  await current.done
  return current
}

/** Starts a scenario and calls `act` once the agent has begun answering (what the person did in the recording). */
async function playWith(scenario: string, act: (r: Replayed) => void) {
  current = await replay(claudeDriver, 'claude', scenario)
  const r = current
  await waitFor(() => expect(r.played.items.some((i) => i.kind === 'assistant')).toBe(true))
  act(r)
  await r.done
  return r
}

const sends = (r: Replayed, key: string) => r.fixture.frames.filter((f) => f.dir === 'send' && claudeProtocol.key(f.data) === key).length

describe('Claude Code replay', () => {
  it('has the scenarios a Claude Code record is proved by', () => {
    for (const scenario of ['plain', 'approval', 'question', 'plan', 'steer', 'interrupt', 'crash', 'resume', 'limit', 'fork', 'revert', 'compact', 'subagents']) expect(hasFixture('claude', scenario), scenario).toBe(true)
  })

  it('plain: an answer, the result and the session', async () => {
    const { played, handle, fixture } = await play('plain')
    expect(fixture.header).toMatchObject({ agent: 'claude', scenario: 'plain', evidence: 'recorded', model: 'claude-haiku-5-5' })
    expect(played.results).toEqual([{ ok: true }])
    expect(played.sessions).toHaveLength(1)
    expect(played.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(played.find('result')[0]).toMatchObject({ ok: true })
    expect(played.find('result')[0].costUsd).toBeGreaterThan(0)
    expect(handle.warnings()).toEqual([])
  })

  it('approval: the write is asked about, with its input, and carried out', async () => {
    const { played, handle } = await play('approval')
    expect(played.approvals).toHaveLength(1)
    expect(played.approvals[0]).toMatchObject({ kind: 'tool', toolName: 'Write' })
    expect(JSON.stringify(played.approvals[0].input)).toContain('hello.txt')
    expect(played.find('tool').find((t) => t.name === 'Write')).toMatchObject({ status: 'done' })
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('approval: answering no is the same kind of message, so the recording still plays', async () => {
    const { played, handle } = await play('approval', { approve: () => ({ allow: false, message: 'No.' }) })
    expect(played.approvals).toHaveLength(1)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('question: the choice reaches the person, and the answer goes back', async () => {
    const { played, handle } = await play('question')
    expect(played.questions).toHaveLength(1)
    expect(played.questions[0][0].options.map((o) => o.label)).toEqual(['Tabs', 'Spaces'])
    expect(played.find('tool').some((t) => t.name.endsWith('AskUserQuestion'))).toBe(true)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('plan: the plan is put to the person before anything is written', async () => {
    const { played, handle } = await play('plan')
    expect(played.plans).toHaveLength(1)
    expect(played.plans[0].length).toBeGreaterThan(20)
    expect(played.find('tool').some((t) => t.name === 'ExitPlanMode')).toBe(true)
    expect(played.planModes).toEqual([false])
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('steer: a message sent while it answers goes into the running turn', async () => {
    const r = await playWith('steer', ({ turn }) => expect(turn.steer('Actually, stop at 10.')).toBe(true))
    expect(sends(r, 'user')).toBe(2)
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('interrupt: stopping asks Claude Code to interrupt, and the turn ends', async () => {
    const r = await playWith('interrupt', ({ turn }) => void turn.stop())
    expect(sends(r, 'control_request:interrupt')).toBe(1)
    expect(r.played.results).toHaveLength(1)
    expect(r.handle.warnings()).toEqual([])
  })

  it('crash: a process that dies mid-answer fails the turn and says why', async () => {
    const { played } = await play('crash')
    expect(played.results).toHaveLength(1)
    expect(played.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('exited') })
    expect(played.find('notice').some((n) => n.level === 'error')).toBe(true)
  })

  it('resume: the next turn continues the same session', async () => {
    const { played, fixture, handle } = await play('resume', {}, { resume: 'the-first-session' })
    const recorded = (fixture.frames.find((f) => (f.data as { subtype?: string })?.subtype === 'init')!.data as { session_id: string }).session_id
    expect(played.sessions).toEqual([recorded])
    expect(played.find('assistant').map((a) => a.text)).toEqual(['pineapple'])
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('fork: a turn that continues the session through an earlier message answers from there', async () => {
    const { played, handle, fixture } = await play('fork', {}, { resume: 'old-session', resumeAt: 'message-1' })
    expect(fixture.header).toMatchObject({ scenario: 'fork', evidence: 'recorded' })
    expect(played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('revert: Restore sends the same request as a fork, and rewind changes nothing for Claude Code', async () => {
    const { played, handle } = await play('revert', {}, { resume: 'old-session', resumeAt: 'message-1', rewind: true })
    expect(played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('compact: /compact makes a compact_boundary, shown as a divider that says what the context held before and after', async () => {
    const { played, handle, fixture } = await play('compact', {}, { resume: 'old-session' })
    expect(fixture.header).toMatchObject({ scenario: 'compact', evidence: 'recorded' })
    const dividers = played.find('notice').flatMap((n) => (n.divider ? [n.divider] : []))
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({ kind: 'compact', before: expect.any(Number), after: expect.any(Number) })
    expect((dividers[0] as { before: number; after: number }).after).toBeLessThan((dividers[0] as { before: number }).before)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('subagents: the subagent is one Task row with a task id, and what it did is kept as items under it', async () => {
    const { played, handle, fixture } = await play('subagents')
    expect(fixture.header).toMatchObject({ scenario: 'subagents', evidence: 'recorded' })
    const task = played.find('tool').find((t) => t.name === 'Task' || t.name === 'Agent')
    expect(task, 'the Task call').toBeDefined()
    const taskStarted = fixture.frames.map((f) => f.data as { subtype?: string; task_id?: string }).find((d) => d?.subtype === 'task_started')!
    expect(task!.childId).toBe(taskStarted.task_id)
    expect(task!.parentToolUseId).toBeUndefined()
    const children = played.items.filter((i) => 'parentToolUseId' in i && i.parentToolUseId === task!.id)
    expect(children.length, "the subagent's own items").toBeGreaterThan(0)
    expect(children.some((c) => c.kind === 'tool')).toBe(true)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('plain: the turn says which prompt cache it left (what idle compaction waits on), read from its usage', async () => {
    const { played } = await play('plain')
    // The recording wrote its cache with the one-hour time-to-live, and the request touched the cache.
    expect(played.caches).toEqual([{ ttl: '1h', warm: true }])
  })

  it('limit (edited from plain): the turn fails as a usage limit that says when it resets', async () => {
    const { played, fixture, handle } = await play('limit')
    expect(fixture.header.evidence).toBe('edited')
    const [result] = played.results
    expect(result).toMatchObject({ ok: false, limit: { resetAt: expect.any(String) } })
    const ahead = Date.parse((result as { limit: { resetAt: string } }).limit.resetAt) - Date.now()
    expect(ahead).toBeGreaterThan(60 * 60 * 1000)
    expect(ahead).toBeLessThan(3 * 60 * 60 * 1000)
    expect(handle.warnings()).toEqual([])
  })
})
