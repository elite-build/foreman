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

/** A Claude whose turn runs until released, and takes a message mid-turn when `steers` says so. */
function held(steers: boolean) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const steered: string[] = []
  const script: Script = async (_req, cb, signal) => {
    await Promise.race([released, new Promise((resolve) => signal.addEventListener('abort', resolve))])
    cb.finished(signal.aborted ? { ok: false, error: 'aborted' } : { ok: true })
  }
  const driver = fakeDriver(script)
  registerDriver({ ...driver, createTurn: (req, cb) => ({ ...driver.createTurn(req, cb), steer: (text: string) => (steers ? (steered.push(text), true) : false) }) })
  return { release, steered }
}

async function projectRun(steers: boolean) {
  const agent = held(steers)
  const items: ChatItem[] = []
  const h = await setupSessions({ events: { item: (_id, item) => void items.push(item) } })
  h.sessions.employeeBrief = () => BRIEF
  const session = h.store.state.sessions.find((s) => s.id === h.session.id)!
  session.unattended = { employeeRunId: 'run-1', employeeId: 'e-rav1', orgId: 'o1', persona: { mcp: [] } }
  session.employeeRun = { orgId: 'o1', employeeId: 'e-rav1', runId: 'run-1', taskId: 't1', projectId: 'p1' }
  await h.sessions.send(h.session.id, 'Build the export.', { origin: ORIGIN })
  const tab = () => h.store.state.sessions.find((s) => s.id === h.session.id) as Session
  await vi.waitFor(() => expect(tab().status).toBe('running'), WAIT)
  return { h, tab, items, ...agent }
}

describe('a project run’s chat', () => {
  it('takes only words that go into its running turn, then nothing once its turn ended', async () => {
    const { h, tab, release } = await projectRun(false)
    // Its agent can't take a message now: refused rather than queued after the run.
    await expect(h.sessions.send(h.session.id, 'Create a pull request.')).rejects.toThrow(RUNNING_PROJECT_RUN)
    expect(tab().queue).toEqual([])
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

  it('puts the person’s channel words into the running turn when its agent takes them', async () => {
    const { h, items, steered, release, tab } = await projectRun(true)
    expect(h.sessions.steerTurn(h.session.id, 'The person wrote to you: use option b')).toBe(true)
    expect(steered).toEqual(['The person wrote to you: use option b'])
    expect(items.filter((i) => i.kind === 'user').at(-1)).toMatchObject({ text: 'The person wrote to you: use option b', steered: true })
    release()
    await vi.waitFor(() => expect(tab().status === 'idle' && !tab().turnId).toBe(true), WAIT)
    expect(h.sessions.steerTurn(h.session.id, 'too late')).toBe(false)
  })
})
