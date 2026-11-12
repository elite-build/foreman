// Codex's fixtures through the real driver and its own JSON-RPC client, over a fake `codex app-server` process that plays
// the recording (docs/agents.md, 9.3). Only the process is replaced.
import { afterEach, describe, expect, it } from 'vitest'
import { codexDriver } from '../../src/main/agents/codex'
import { hasFixture } from '../../src/main/agents/fixtures/format'
import { jsonRpcProtocol } from '../../src/main/agents/fixtures/replay'
import { waitFor } from '../helpers'
import { replay, type Person, type Replayed } from './harness'

let current: Replayed | undefined
afterEach(() => current?.handle.uninstall())

async function play(scenario: string, person: Person = {}, overrides = {}) {
  current = await replay(codexDriver, 'codex', scenario, person, overrides)
  await current.done
  return current
}

/** Starts a scenario and calls `act` once the agent has begun answering (what the person did in the recording). */
async function playWith(scenario: string, act: (r: Replayed) => void) {
  current = await replay(codexDriver, 'codex', scenario)
  const r = current
  await waitFor(() => expect(r.played.items.some((i) => i.kind === 'assistant')).toBe(true))
  act(r)
  await r.done
  return r
}

/** What the driver wrote to the fake process, in order (the replay matches by method and never by content, so this is where a request is read). */
const written = (r: Replayed) => r.handle.engines.flatMap((e) => e.sent) as { method?: string; params?: any }[]
const writtenOf = (r: Replayed, method: string) => written(r).filter((m) => m.method === method)
/** The first recorded send of a method, as the fixture holds it. */
const recorded = (r: Replayed, method: string) => (r.fixture.frames.find((f) => f.dir === 'send' && (f.data as { method?: string })?.method === method)!.data as { params: any }).params
const sends = (r: Replayed, key: string) => r.fixture.frames.filter((f) => f.dir === 'send' && jsonRpcProtocol.key(f.data) === key).length
const threadOf = (r: Replayed) => {
  const reply = r.fixture.frames.find((f) => f.dir === 'recv' && (f.data as { result?: { thread?: { id: string } } })?.result?.thread)
  return (reply!.data as { result: { thread: { id: string } } }).result.thread.id
}

describe('Codex replay', () => {
  it('has the scenarios a Codex record is proved by', () => {
    for (const scenario of ['plain', 'approval', 'question', 'plan', 'steer', 'interrupt', 'crash', 'resume', 'limit', 'fork', 'revert', 'compact', 'goal', 'goalclear', 'sandbox', 'scoped']) expect(hasFixture('codex', scenario), scenario).toBe(true)
  })

  it('plain: an answer, the result and the thread', async () => {
    const r = await play('plain')
    expect(r.fixture.header).toMatchObject({ agent: 'codex', scenario: 'plain', evidence: 'recorded', model: 'gpt-5.6-luna' })
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.played.sessions).toEqual([threadOf(r)])
    expect(r.played.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(r.handle.warnings()).toEqual([])
  })

  it('sandbox: a Windows app-server’s start-up reads the sandbox’s readiness, and the account declares it', async () => {
    const r = await play('sandbox')
    expect(r.fixture.header).toMatchObject({ agent: 'codex', scenario: 'sandbox', evidence: 'recorded' })
    // Recorded in a new CODEX_HOME, where the sandbox was never set up: the real answer is "notConfigured".
    const reply = r.fixture.frames.find((f) => f.dir === 'recv' && (f.data as { result?: { status?: string } })?.result?.status)
    expect((reply!.data as { result: { status: string } }).result.status).toBe('notConfigured')
    expect(writtenOf(r, 'windowsSandbox/readiness')).toHaveLength(1)
    // After initialize and before the thread: what a turn that needs read-only has to know first.
    const order = written(r).map((m) => m.method).filter(Boolean)
    expect(order.indexOf('windowsSandbox/readiness')).toBeGreaterThan(order.indexOf('initialize'))
    expect(order.indexOf('windowsSandbox/readiness')).toBeLessThan(order.indexOf('thread/start'))
    expect(r.played.declared).toEqual([{ windowsSandbox: 'not-ready' }])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('sandbox: a read-only turn on that recording does not start, and says the sandbox is not set up', async () => {
    const r = await play('sandbox', {}, { readOnly: true })
    expect(r.played.results).toHaveLength(1)
    expect(r.played.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('Windows sandbox isn’t set up') })
    expect(writtenOf(r, 'thread/start')).toEqual([])
    expect(r.played.declared).toEqual([{ windowsSandbox: 'not-ready' }])
  })

  it('scoped: the read-only sandbox with on-request approvals; a write inside the globs is accepted, one outside declined with words the agent reads', async () => {
    const r = await play('scoped')
    expect(r.fixture.header).toMatchObject({ agent: 'codex', scenario: 'scoped', evidence: 'recorded' })
    // What the adapter asked of Codex: the sandbox and policy of scoped writes, set on the thread and on the turn, as in the recording.
    expect(recorded(r, 'thread/start')).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(writtenOf(r, 'thread/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(writtenOf(r, 'turn/start')[0].params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } })
    // Ready on this recording's Codex home (set to the unelevated sandbox): the account declares so and the turn goes ahead.
    expect(r.played.declared).toEqual([{ windowsSandbox: 'ready' }])
    // Codex asked about two file changes: the first named a file outside the globs, so all of it was declined; the second, inside, accepted.
    const asked = r.fixture.frames.filter((f) => f.dir === 'recv' && (f.data as { method?: string })?.method === 'item/fileChange/requestApproval')
    expect(asked).toHaveLength(2)
    const decisions = written(r).filter((m) => (m as { result?: { decision?: string } }).result?.decision).map((m) => (m as unknown as { result: { decision: string } }).result.decision)
    expect(decisions).toEqual(['decline', 'accept'])
    // Nobody was asked.
    expect(r.played.approvals).toEqual([])
    // The refusal is words the agent reads: a message into the running turn that names the file and the area, and the agent carried on from it.
    const steer = writtenOf(r, 'turn/steer')
    expect(steer).toHaveLength(1)
    const said = steer[0].params.input[0].text as string
    expect(said).toContain('writing “other/no.txt” is outside the folders this step may write in')
    expect(said).toContain('allowed only inside allowed/**')
    expect(said).toContain('Carry on.')
    // The chat: the first change shown declined, the second written, and the turn ends well.
    const tools = r.played.find('tool')
    expect(tools.some((t) => t.status === 'error' && t.output === 'Declined.')).toBe(true)
    expect(tools.some((t) => t.name === 'Write' && t.status === 'done')).toBe(true)
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('scoped: the same turn on an account whose sandbox is not ready does not start', async () => {
    const r = await play('sandbox', {}, { writeScope: ['allowed/**'] })
    expect(r.played.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('hold this step to the folders it may write in') })
    expect(writtenOf(r, 'thread/start')).toEqual([])
  })

  it('a turn capped below Never ask on an account whose sandbox is not ready does not start: every protection of the ceiling is a sandbox policy', async () => {
    const r = await play('sandbox', {}, { capped: { ceiling: 'ask' } })
    expect(r.played.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('hold this turn to the access it was granted') })
    expect(writtenOf(r, 'thread/start')).toEqual([])
  })

  it('a recording made without the readiness exchange replays with no surprise: the adapter asks, the engine answers it is not in the recording, and nothing is declared', async () => {
    const r = await play('plain')
    expect(writtenOf(r, 'windowsSandbox/readiness')).toHaveLength(1)
    expect(r.played.declared).toEqual([])
    expect(r.handle.warnings()).toEqual([])
  })

  it('approval: each command and file change is asked about, then carried out', async () => {
    const { played, handle } = await play('approval')
    expect(played.approvals.length).toBeGreaterThanOrEqual(1)
    expect(played.approvals.map((a) => a.toolName)).toContain('Write')
    expect(played.find('tool').filter((t) => t.status === 'done').length).toBeGreaterThanOrEqual(1)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('approval: answering no is the same kind of message, so the recording still plays', async () => {
    const { played, handle } = await play('approval', { approve: () => ({ allow: false }) })
    expect(played.approvals.length).toBeGreaterThanOrEqual(1)
    expect(played.results).toHaveLength(1)
    expect(handle.warnings()).toEqual([])
  })

  it('question: Codex asks in plan mode, and the answer goes back', async () => {
    const { played, handle } = await play('question')
    expect(played.questions).toHaveLength(1)
    expect(played.questions[0][0].options.length).toBeGreaterThanOrEqual(2)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('plan: the plan is put to the person, and approving it carries on', async () => {
    const { played, handle } = await play('plan')
    expect(played.plans).toHaveLength(1)
    expect(played.plans[0].length).toBeGreaterThan(20)
    expect(played.results).toEqual([{ ok: true }])
    expect(handle.warnings()).toEqual([])
  })

  it('steer: a message sent while it answers goes into the running turn', async () => {
    const r = await playWith('steer', ({ turn }) => expect(turn.steer('Actually, stop at 10.')).toBe(true))
    expect(sends(r, 'request:turn/steer')).toBe(1)
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('interrupt: stopping interrupts the turn, and it ends as stopped', async () => {
    const r = await playWith('interrupt', ({ turn }) => void turn.stop())
    expect(sends(r, 'request:turn/interrupt')).toBe(1)
    expect(r.played.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('crash: a process that dies mid-answer fails the turn', async () => {
    const { played } = await play('crash')
    expect(played.results).toHaveLength(1)
    expect(played.results[0]).toMatchObject({ ok: false })
    expect(played.find('notice').some((n) => n.level === 'error')).toBe(true)
  })

  it('resume: the next turn continues the same thread', async () => {
    const probe = await replay(codexDriver, 'codex', 'resume')
    probe.handle.uninstall()
    void probe.turn.stop()
    const id = threadOf(probe)
    const r = await play('resume', {}, { resume: id })
    expect(sends(r, 'request:thread/resume')).toBe(1)
    expect(r.played.sessions).toEqual([id])
    expect(r.played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('fork: the thread is forked through the turn the conversation stood at, and the fork is the chat\'s thread from then on', async () => {
    const r = await play('fork', {}, { resume: 'old-thread', resumeAt: 'turn-1' })
    expect(r.fixture.header).toMatchObject({ scenario: 'fork', evidence: 'recorded' })
    expect(writtenOf(r, 'thread/fork')).toHaveLength(1)
    expect(writtenOf(r, 'thread/fork')[0].params).toMatchObject({ threadId: 'old-thread', lastTurnId: 'turn-1', excludeTurns: true })
    // Not resumed, not started: the old thread is left as it is and the new one carries on.
    expect(writtenOf(r, 'thread/resume')).toHaveLength(0)
    expect(writtenOf(r, 'thread/start')).toHaveLength(0)
    expect(r.played.sessions).toEqual([threadOf(r)])
    expect(r.played.sessions[0]).not.toBe('old-thread')
    // The fork's history stops at the first of the two recorded turns: it remembers that turn's word, not the second's.
    expect(r.played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])
    expect(r.played.points).toHaveLength(1)
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('revert: Restore resumes the thread, cuts its history back to the turn kept, and carries on in the same thread', async () => {
    const probe = await replay(codexDriver, 'codex', 'revert')
    probe.handle.uninstall()
    void probe.turn.stop()
    const { threadId } = recorded(probe, 'thread/resume')
    // The turns the thread held, newest first: the fixture cut it back to before the first of them in the list.
    const list = probe.fixture.frames.map((f) => f.data as { result?: { data?: { id: string }[] } }).find((d) => d?.result?.data)!.result!.data!
    const [newest, kept] = list.map((t) => t.id)
    const r = await play('revert', {}, { resume: threadId, resumeAt: kept, rewind: true })
    expect(writtenOf(r, 'thread/resume')).toHaveLength(1)
    expect(writtenOf(r, 'thread/fork')).toHaveLength(0)
    expect(writtenOf(r, 'thread/revert')).toHaveLength(1)
    // History only: the turn after the one kept is where it is cut.
    expect(writtenOf(r, 'thread/revert')[0].params).toEqual({ threadId, beforeTurnId: newest })
    expect(r.played.sessions).toEqual([threadId])
    expect(r.played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('compact: /compact goes to thread/compact/start, and the chat shows the compaction, with no answer from the model', async () => {
    const r = await play('compact', {}, { resume: 'a-thread' })
    expect(r.fixture.header).toMatchObject({ scenario: 'compact', evidence: 'recorded' })
    expect(writtenOf(r, 'thread/compact/start')).toHaveLength(1)
    expect(writtenOf(r, 'thread/compact/start')[0].params).toEqual({ threadId: expect.any(String) })
    // The command is not a prompt: no turn is started with its text.
    expect(writtenOf(r, 'turn/start')).toHaveLength(0)
    expect(r.played.find('assistant')).toEqual([])
    expect(r.played.find('notice').map((n) => n.divider)).toEqual([{ kind: 'compact' }])
    expect(r.played.points).toHaveLength(1)
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('goal: /goal sets it, Codex works at it by itself, and the card follows until it is complete', async () => {
    const r = await play('goal')
    expect(r.fixture.header).toMatchObject({ scenario: 'goal', evidence: 'recorded' })
    expect(writtenOf(r, 'thread/goal/set')).toHaveLength(1)
    expect(writtenOf(r, 'thread/goal/set')[0].params).toMatchObject({ objective: expect.stringContaining('Reply with the single word: done'), origin: 'user' })
    // The turn that did the work was Codex's own: Foreman never asked for one.
    expect(writtenOf(r, 'turn/start')).toHaveLength(0)
    expect(r.played.goals.map((g) => g?.status)).toEqual(['active', 'active', 'complete'])
    expect(r.played.goals.at(-1)).toMatchObject({ objective: expect.stringContaining('done'), tokensUsed: expect.any(Number) })
    expect(r.played.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['done'])
    expect(r.played.results).toEqual([{ ok: true }])
    // Complete: nothing is left to pause.
    expect(writtenOf(r, 'thread/goal/set')).toHaveLength(1)
    expect(r.handle.warnings()).toEqual([])
  })

  it('goalclear: /goal clear asks Codex to clear it, and the card goes', async () => {
    const r = await play('goalclear', {}, { resume: 'a-thread' })
    expect(writtenOf(r, 'thread/goal/clear')).toHaveLength(1)
    expect(writtenOf(r, 'thread/goal/clear')[0].params).toMatchObject({ origin: 'user' })
    expect(r.played.goals.at(-1)).toBeNull()
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('limit (edited from plain): the turn fails with the usage-limit error', async () => {
    const r = await play('limit')
    expect(r.fixture.header.evidence).toBe('edited')
    expect(r.played.results).toHaveLength(1)
    expect(r.played.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('usage limit') })
    expect(r.handle.warnings()).toEqual([])
  })

})
