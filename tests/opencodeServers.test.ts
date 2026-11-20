// OpenCode's servers (docs/agents.md 3.2, 3.3): a server for each turn. What a turn's environment holds names the turn
// (`FOREMAN_SESSION_ID`, `FOREMAN_TURN_ID` and its token, which `foreman report` attributes by), and OpenCode's server has no
// environment per session, so a server that outlived its turn would run the next turn's commands as the first one. The
// servers here are replays of OpenCode's recorded fixtures.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeDriver } from '../src/main/agents/opencode'
import type { OpencodeLauncher } from '../src/main/agents/opencode/server'
import { OPENCODE_PLANS } from '../src/main/agents/opencode/record'
import { readFixture, type Fixture } from '../src/main/agents/fixtures/format'
import { replayTransport, type ReplayHandle } from '../src/main/agents/fixtures/replayTransports'
import { transportOverride } from '../src/main/agents/transport'
import type { TurnRequest } from '../src/main/agents/types'
import { TURN_ENV } from '../src/shared/agentReports'
import { capabilitiesFor, isFallback, resolveCapabilities, type AgentCapabilitiesView } from '../src/shared/agentCapabilities'
import { staticCapabilities, staticCapabilitiesView } from '../src/shared/agentCatalog'
import { callbacks, request } from './replay/harness'

describe('the record', () => {
  const record = staticCapabilities('opencode')!

  it('says a server for each turn, and no version of the agent changes that', () => {
    expect(isFallback(record.sessions.concurrentChats, 'server-per-turn')).toBe(true)
    expect(record.sessions).not.toHaveProperty('pooledServerFrom')
    for (const version of ['1.14.3', '1.19.6', '2.4.1', 'dev']) expect(resolveCapabilities(record, { version }).sessions.concurrentChats).toEqual(record.sessions.concurrentChats)
    // The version is still the account's fact, for Settings.
    expect(resolveCapabilities(record, { version: '2.4.1' }).version).toBe('2.4.1')
    const view: AgentCapabilitiesView = { ...staticCapabilitiesView(), declared: { opencode: { work: { version: '2.1.0' } } } }
    expect(isFallback(capabilitiesFor(view, 'opencode', 'work')!.sessions.concurrentChats, 'server-per-turn')).toBe(true)
  })

  it('leaves every other agent as it was', () => {
    const gemini = staticCapabilities('gemini')!
    expect(resolveCapabilities(gemini, { version: '9.0.0' }).sessions.concurrentChats).toEqual(gemini.sessions.concurrentChats)
  })
})

let handle: ReplayHandle | undefined
afterEach(() => handle?.uninstall())

/**
 * Starts each turn's server through the driver as a replay of the fixture named for that turn, noting the environment it
 * started with and when it was closed.
 */
async function turns(fixtures: Record<string, Fixture>) {
  handle = replayTransport('opencode', (req) => fixtures[req.turnId])
  const replayed = transportOverride('opencode')!
  const launches: { env: Record<string, string>; closed: boolean }[] = []
  const launch: OpencodeLauncher = async (options) => {
    const seen = { env: options.env, closed: false }
    launches.push(seen)
    const server = await replayed({ turnId: options.env[TURN_ENV.turn], cwd: options.cwd } as TurnRequest)!(options)
    return { ...server, close: async () => ((seen.closed = true), server.close()) }
  }
  const driver = createOpencodeDriver(launch)
  const common = await request({ approvals: 'never-ask', model: 'opencode/big-pickle' })
  /** A turn as SessionService starts one: its own session and turn in the environment (with the token attributing a report to it). */
  const start = (turnId: string, scenario: keyof typeof OPENCODE_PLANS, session: string) => {
    const { cb, played } = callbacks()
    const env = { ...common.env, FOREMAN_WORKSPACE_ID: 'ws-1', [TURN_ENV.session]: session, [TURN_ENV.turn]: turnId, [TURN_ENV.token]: `token-of-${turnId}` }
    const turn = driver.createTurn({ ...common, turnId, prompt: OPENCODE_PLANS[scenario]!.prompt, env, instance: 'work' }, cb)
    return { done: turn.run(), played, turn, turnId }
  }
  return { launches, start }
}

describe('OpenCode, with the environment a real turn has', () => {
  it('starts a server for each turn, carrying that turn’s own environment, and closes it when the turn ends', async () => {
    const plain = readFixture('opencode', 'plain')
    const { launches, start } = await turns({ 'turn-1': plain, 'turn-2': plain, 'turn-3': plain })
    const first = start('turn-1', 'plain', 'chat-a')
    await first.done
    expect(launches[0].closed).toBe(true)
    // A second turn of the chat, and a turn of another chat of the same account and workspace at the same time.
    const second = start('turn-2', 'plain', 'chat-a')
    const other = start('turn-3', 'plain', 'chat-b')
    await Promise.all([second.done, other.done])
    expect(launches).toHaveLength(3)
    // Each carries its own turn: a report from its commands is attributed to that turn, not the one before.
    expect(launches.map((l) => l.env[TURN_ENV.turn])).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(launches.map((l) => l.env[TURN_ENV.session])).toEqual(['chat-a', 'chat-a', 'chat-b'])
    expect(launches.map((l) => l.env[TURN_ENV.token])).toEqual(['token-of-turn-1', 'token-of-turn-2', 'token-of-turn-3'])
    // And the config Foreman gives the server, laid over the turn's own.
    expect(launches.every((l) => typeof l.env.OPENCODE_CONFIG_CONTENT === 'string')).toBe(true)
    expect(launches.every((l) => l.closed)).toBe(true)
    for (const t of [first, second, other]) expect(t.played.results).toEqual([{ ok: true }])
    expect(first.played.declared).toEqual([{ version: '1.19.6' }])
  })

  it('stopping a turn closes its server, not another turn’s', async () => {
    const { launches, start } = await turns({ long: readFixture('opencode', 'interrupt'), short: readFixture('opencode', 'plain') })
    const long = start('long', 'interrupt', 'chat-a')
    // The long one is running its command; the short one starts, answers and ends beside it.
    await vi.waitFor(() => expect(long.played.items.some((i) => i.kind === 'tool')).toBe(true))
    const short = start('short', 'plain', 'chat-b')
    await short.done
    expect(launches.map((l) => l.closed)).toEqual([false, true])
    await long.turn.stop()
    await long.done
    expect(long.played.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(launches.map((l) => l.closed)).toEqual([true, true])
  })
})
