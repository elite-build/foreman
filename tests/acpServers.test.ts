// OpenCode's servers (docs/agents.md 3.2): a process for each turn, whatever its version. What a turn's environment holds names the turn
// (`FOREMAN_SESSION_ID`, `FOREMAN_TURN_ID` and its token, which `foreman report` attributes by), and ACP gives a session no environment of
// its own, so a server that outlived its turn would run the next turn's commands as the first one. An in-process OpenCode that serves
// several sessions on one connection stands in for the real one (none is installed where this was built).
import * as acp from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it, vi } from 'vitest'
import { createAcpDriver, type AcpConnector } from '../src/main/agents/acp'
import { inProcessAcp, type acpFake } from '../src/main/agents/fixtures/fakes'
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
    for (const version of ['1.14.3', '2.0.0', '2.4.1', 'dev']) expect(resolveCapabilities(record, { version }).sessions.concurrentChats).toEqual(record.sessions.concurrentChats)
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

/** An OpenCode that serves any number of sessions on one connection; a prompt waits for its gate, after asking permission once. */
function opencode(version: string) {
  let sessions = 0
  const gates = new Map<string, () => void>()
  const asked: string[] = []
  const app = acp
    .agent({ name: 'opencode-fake' })
    .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, agentInfo: { name: 'opencode', version } }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `session-${++sessions}` }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: `call-${params.sessionId}`, title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: `ls ${text}` } } })
      const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: `call-${params.sessionId}` },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      })
      asked.push(`${params.sessionId}:${outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome}`)
      await new Promise<void>((resolve) => gates.set(text, resolve))
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answers ${text}` } } })
      return { stopReason: 'end_turn' as const }
    })
  return { app: Object.assign(app, { attach: () => undefined }) as unknown as ReturnType<typeof acpFake>, gates, asked }
}

/** Starts each turn's process through the driver, noting the environment it started with and when it was closed. */
async function turns(version: string) {
  const server = opencode(version)
  const launches: { env: Record<string, string>; closed: boolean }[] = []
  const base = inProcessAcp(server.app)
  const connect: AcpConnector = (launch) => {
    const seen = { env: launch.env as Record<string, string>, closed: false }
    launches.push(seen)
    const transport = base(launch)
    return { ...transport, close: async () => ((seen.closed = true), transport.close()) }
  }
  const driver = createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'unused', args: [] }), connect })
  const common = await request({ approvals: 'ask' })
  let n = 0
  /** A turn as SessionService starts one: its own session and turn in the environment (with the token attributing a report to it). */
  const start = (prompt: string, session: string) => {
    const turnId = `turn-${++n}`
    const { cb, played } = callbacks()
    const declared: unknown[] = []
    cb.declared = (facts) => void declared.push(facts)
    const env = { ...common.env, FOREMAN_WORKSPACE_ID: 'ws-1', [TURN_ENV.session]: session, [TURN_ENV.turn]: turnId, [TURN_ENV.token]: `token-of-${turnId}` }
    const turn = driver.createTurn({ ...common, turnId, prompt, env, instance: 'work' } as TurnRequest, cb)
    return { done: turn.run(), played, declared, turn, turnId }
  }
  return { server, launches, start }
}

const said = (played: ReturnType<typeof callbacks>['played']) => played.find('assistant').map((a) => a.text).join(' ')

describe.each(['1.14.3', '2.1.0'])('OpenCode %s, with the environment a real turn has', (version) => {
  it('starts a server for each turn, carrying that turn’s own environment, and closes it when the turn ends', async () => {
    const { server, launches, start } = await turns(version)
    // Two turns of one chat one after the other, and a turn of another chat of the same account and workspace at the same time as the second.
    const first = start('one', 'chat-a')
    await vi.waitFor(() => expect(server.asked).toHaveLength(1))
    server.gates.get('one')!()
    await first.done
    expect(launches[0].closed).toBe(true)

    const second = start('two', 'chat-a')
    const other = start('three', 'chat-b')
    await vi.waitFor(() => expect(server.asked).toHaveLength(3))
    expect(launches).toHaveLength(3)
    // Each carries its own turn: a report from its commands is attributed to that turn, not the one before.
    expect(launches.map((l) => l.env[TURN_ENV.turn])).toEqual([first.turnId, second.turnId, other.turnId])
    expect(launches.map((l) => l.env[TURN_ENV.session])).toEqual(['chat-a', 'chat-a', 'chat-b'])
    expect(launches.map((l) => l.env[TURN_ENV.token])).toEqual([`token-of-${first.turnId}`, `token-of-${second.turnId}`, `token-of-${other.turnId}`])
    // One ending leaves the other alone.
    server.gates.get('three')!()
    await other.done
    expect(launches.map((l) => l.closed)).toEqual([true, false, true])
    server.gates.get('two')!()
    await second.done
    expect(launches.every((l) => l.closed)).toBe(true)
    expect(said(second.played)).toContain('answers two')
    expect(said(other.played)).toContain('answers three')
    // The version is the account's fact whichever it is.
    expect(first.declared).toEqual([{ version }])
    expect(second.played.results).toEqual([{ ok: true }])
  })

  it('stopping a turn closes its server, not another turn’s', async () => {
    const { server, launches, start } = await turns(version)
    const a = start('a', 'chat-a')
    const b = start('b', 'chat-b')
    await vi.waitFor(() => expect(server.asked).toHaveLength(2))
    await a.turn.stop()
    await a.done.catch(() => undefined)
    expect(launches.map((l) => l.closed)).toEqual([true, false])
    server.gates.get('b')!()
    await b.done
    expect(b.played.results).toEqual([{ ok: true }])
    expect(launches[1].closed).toBe(true)
  })
})
