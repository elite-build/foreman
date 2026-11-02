// A chat's next message when the last turn's agent process is slow to exit: it waits a moment for the process, then
// goes to the queue (seen, and started when the turn ends) rather than waiting on it unseen.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { LINGER_MS } from '../src/main/sessions'
import { fakeDriver, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

/** Turns that report their result at once, then keep their process up until the test lets it exit (or they are stopped). */
function lingeringTurns() {
  const prompts: string[] = []
  const exits = new Map<string, () => void>()
  const script = async (req: TurnRequest, cb: TurnCallbacks, signal: AbortSignal) => {
    prompts.push(req.prompt)
    const gone = new Promise<void>((resolve) => {
      exits.set(req.prompt, resolve)
      signal.addEventListener('abort', () => resolve())
    })
    // As from a real agent, the result comes once the process has started, never from inside run()'s first tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    cb.finished({ ok: true })
    await gone
  }
  const sent = (text: string) => prompts.some((p) => p.includes(text))
  const exit = (text: string) => {
    for (const [prompt, go] of exits) if (prompt.includes(text)) go()
  }
  return { script, sent, exit }
}

// A turn's start saves a git checkpoint first, which a loaded machine can make slow.
const until = (check: () => void) => vi.waitFor(check, { timeout: 20_000, interval: 20 })

describe('a message after a turn whose agent process is still up', () => {
  it('starts at once when the process exits within a moment', async () => {
    const turns = lingeringTurns()
    registerDriver(fakeDriver(turns.script))
    const { sessions, session, ended } = await setupSessions()
    expect(await sessions.send(session.id, 'alpha-one')).toBe('started')
    await until(() => expect(session.status).toBe('idle'))
    setTimeout(() => turns.exit('alpha-one'), 300)
    const receipt = await sessions.deliver(session.id, 'beta-two')
    expect(receipt.disposition).toBe('started')
    expect(turns.sent('beta-two')).toBe(true)
    expect(session.queue).toEqual([])
    expect(ended).toEqual(['completed'])
    turns.exit('beta-two')
    await until(() => expect(ended).toEqual(['completed', 'completed']))
  })

  it('queues the message when the process lingers, and starts it once the process has gone', async () => {
    const turns = lingeringTurns()
    registerDriver(fakeDriver(turns.script))
    const { sessions, session, ended } = await setupSessions()
    expect(await sessions.send(session.id, 'alpha-one')).toBe('started')
    await until(() => expect(session.status).toBe('idle'))
    const asked = Date.now()
    const receipt = await sessions.deliver(session.id, 'beta-two')
    expect(receipt.disposition).toBe('queued')
    expect(Date.now() - asked).toBeGreaterThanOrEqual(LINGER_MS - 100)
    // In the chat's queue, where the user sees it; not sent, as the last turn hasn't ended.
    expect(session.queue.map((m) => m.text)).toEqual(['beta-two'])
    expect(turns.sent('beta-two')).toBe(false)
    expect(ended).toEqual([])
    turns.exit('alpha-one')
    await until(() => expect(turns.sent('beta-two')).toBe(true))
    expect(session.queue).toEqual([])
    expect(ended).toEqual(['completed'])
    turns.exit('beta-two')
    await until(() => expect(ended).toEqual(['completed', 'completed']))
  })
})
