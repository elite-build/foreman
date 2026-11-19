// A project run's chat (docs/ai-employees.md §15), through the real SessionService with a stand-in Claude: while the run's
// turn works, a message there only goes into that turn (a queued one would run outside the run), and `steerTurn` puts the
// person's channel words into it when the agent takes them, never queueing; once the turn ended the chat is marked ended
// and takes nothing more, while the person's own chat in the same workspace works as any.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { ENDED_PROJECT_RUN, RUNNING_PROJECT_RUN } from '../src/main/sessions'
import type { EmployeeBrief } from '../src/main/employeeWork'
import type { ChatItem, Session } from '../src/shared/types'
import { fakeDriver, setupSessions, type Script } from './sessionHarness'

vi.setConfig({ testTimeout: 60_000 })
// A busy machine (the full suite) is slow to start and end a turn.
const WAIT = { timeout: 20_000, interval: 25 }

afterEach(() => registerDriver(claudeDriver))

const BRIEF: EmployeeBrief = { system: '', context: '', name: 'Ravi', definitionPath: 'bots/e-rav1.toml', memory: [], memoryWrites: { scopes: [], readOnly: false } }
const ORIGIN = { kind: 'employee' as const, orgId: 'o1', employeeId: 'e-rav1', runId: 'run-1', taskId: 't1' }

/**
 * A Claude whose turn runs until released, and takes a message mid-turn when `steers` says so; `taken` of them it has
 * taken up (answered), the rest are unanswered.
 */
function held(steers: boolean) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const steered: string[] = []
  const taken = { count: 0 }
  const script: Script = async (_req, cb, signal) => {
    await Promise.race([released, new Promise((resolve) => signal.addEventListener('abort', resolve))])
    cb.finished(signal.aborted ? { ok: false, error: 'aborted' } : { ok: true })
  }
  const driver = fakeDriver(script)
  registerDriver({ ...driver, createTurn: (req, cb) => ({ ...driver.createTurn(req, cb), steer: (text: string) => (steers ? (steered.push(text), true) : false), unansweredSteers: () => steered.length - taken.count }) })
  return { release, steered, taken }
}

async function projectRun(steers: boolean) {
  const agent = held(steers)
  const items: ChatItem[] = []
  const starting: string[] = []
  const h = await setupSessions({ events: { item: (_id, item) => void items.push(item), workStarting: (ws) => void starting.push(ws) } })
  h.sessions.employeeBrief = () => BRIEF
  const session = h.store.state.sessions.find((s) => s.id === h.session.id)!
  session.unattended = { employeeRunId: 'run-1', employeeId: 'e-rav1', orgId: 'o1', persona: { mcp: [] } }
  session.employeeRun = { orgId: 'o1', employeeId: 'e-rav1', runId: 'run-1', taskId: 't1', projectId: 'p1' }
  await h.sessions.send(h.session.id, 'Build the export.', { origin: ORIGIN })
  const tab = () => h.store.state.sessions.find((s) => s.id === h.session.id) as Session
  await vi.waitFor(() => expect(tab().status).toBe('running'), WAIT)
  return { h, tab, items, starting, ...agent }
}

describe('a project run’s chat', () => {
  it('takes only words that go into its running turn, then nothing once its turn ended', async () => {
    const { h, tab, release, starting } = await projectRun(false)
    const before = starting.length
    // Its agent can't take a message now: refused rather than queued after the run, before it touches anything.
    await expect(h.sessions.send(h.session.id, 'Create a pull request.')).rejects.toThrow(RUNNING_PROJECT_RUN)
    expect(tab().queue).toEqual([])
    expect(starting).toHaveLength(before)
    expect(h.sessions.steerTurn(h.session.id, 'use option b')).toBe(false)
    release()
    await vi.waitFor(() => expect(tab().status === 'idle' && !tab().turnId).toBe(true), WAIT)
    expect(tab().employeeRun).toMatchObject({ projectId: 'p1', endedAt: expect.any(String) })
    expect(tab().unattended).toBeUndefined()
    await expect(h.sessions.send(h.session.id, 'where are the mocks')).rejects.toThrow(ENDED_PROJECT_RUN)
    // The person's own chat in the same workspace is theirs.
    const mine = h.sessions.createSession(h.ws.id, { agent: 'claude', title: 'mine' })
    await expect(h.sessions.send(mine.id, 'hello')).resolves.toBe('started')
  })

  it('puts the person’s channel words into the running turn when its agent takes them, and says which it never took up', async () => {
    const { h, items, steered, taken, release, tab } = await projectRun(true)
    expect(h.sessions.steerTurn(h.session.id, 'The person wrote to you: use option b')).toBe(true)
    expect(steered).toEqual(['The person wrote to you: use option b'])
    expect(items.filter((i) => i.kind === 'user').at(-1)).toMatchObject({ text: 'The person wrote to you: use option b', steered: true })
    expect(h.sessions.unansweredSteers(h.session.id)).toBe(1)
    taken.count = 1
    expect(h.sessions.unansweredSteers(h.session.id)).toBe(0)
    // One more, never taken up before the turn ends: still counted once it is over.
    h.sessions.steerTurn(h.session.id, 'and keep the icons')
    release()
    await vi.waitFor(() => expect(tab().status === 'idle' && !tab().turnId).toBe(true), WAIT)
    expect(h.sessions.unansweredSteers(h.session.id)).toBe(1)
    expect(h.sessions.steerTurn(h.session.id, 'too late')).toBe(false)
  })

  it('takes nothing into a turn whose agent can’t say what it took up', async () => {
    const driver = fakeDriver(async (_req, cb, signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve))
      cb.finished({ ok: false, error: 'aborted' })
    })
    registerDriver({ ...driver, createTurn: (req, cb) => ({ ...driver.createTurn(req, cb), steer: () => true }) })
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'Work.')
    await vi.waitFor(() => expect(h.store.state.sessions.find((s) => s.id === h.session.id)?.status).toBe('running'), WAIT)
    expect(h.sessions.steerTurn(h.session.id, 'use option b')).toBe(false)
    await h.sessions.cancel(h.session.id)
  })
})
