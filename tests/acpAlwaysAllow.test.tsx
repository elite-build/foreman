// @vitest-environment jsdom
// "Always allow" on an ACP agent's permission request (docs/agents.md 8), by what the record says: a Chat agent gets Foreman's own
// session-always (remembered for the agent's session, keyed on the tool's kind and the command or path, named on the card, a cap
// still asking about agent and git configuration), and OpenCode answers "once" (its card has no Always allow button and says it asks
// each time, and a stale alternate answer is still only once).
import './domShims'
import * as acp from '@agentclientprotocol/sdk/unstable'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAcpDriver } from '../src/main/agents/acp'
import { acpFake, inProcessAcp } from '../src/main/agents/fixtures/fakes'
import { ToolApprovalPanel } from '../src/renderer/src/components/ApprovalPanel'
import { staticCapabilities } from '../src/shared/agentCatalog'
import { fakeApi, fakeState, resetFake } from './rendererStore'
import type { TurnRequest } from '../src/main/agents/types'
import { callbacks, request, type Person } from './replay/harness'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

type Ask = string | { kind: 'read'; path: string }

/** An ACP agent that asks permission for each command or read it is given, offering once, always and reject, and says which it was answered with. */
function agent(asks: Ask[], sessionId = 's-1') {
  const commands = asks
  const answered: string[] = []
  const app = acp
    .agent({ name: 'asker' })
    .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'asker', version: '1.0.0' } }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      for (const [i, ask] of commands.entries()) {
        const id = `call-${i}`
        const update: acp.SessionUpdate =
          typeof ask === 'string'
            ? { sessionUpdate: 'tool_call', toolCallId: id, title: ask, kind: 'execute', status: 'pending', rawInput: { command: ask } }
            : { sessionUpdate: 'tool_call', toolCallId: id, title: `Read ${ask.path}`, kind: 'read', status: 'pending', locations: [{ path: ask.path }] }
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })
        const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: id },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
        })
        answered.push(outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome)
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } })
      }
      return { stopReason: 'end_turn' as const }
    })
  return { app: Object.assign(app, { attach: () => undefined }) as unknown as ReturnType<typeof acpFake>, answered }
}

async function run(kind: 'opencode' | 'gemini', asks: Ask[], person: Person, over: Partial<TurnRequest> = {}) {
  const fake = agent(asks)
  const driver = createAcpDriver({ kind, label: kind, command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(fake.app) })
  const { cb, played } = callbacks(person)
  await driver.createTurn(await request({ approvals: 'ask', ...over }), cb).run()
  return { ...fake, played }
}

describe('OpenCode: always allow is once', () => {
  it('has the once-always fallback in its record, the others not', () => {
    expect(staticCapabilities('opencode')!.approvals.alwaysAllow).toEqual({ level: 'fallback', fallback: 'once-always' })
  })

  it('offers no Always allow, and answers once even to a stale alternate', async () => {
    const r = await run('opencode', ['npm test', 'npm test'], { approve: () => ({ allow: true, alternate: true }) })
    expect(r.played.approvals.map((a) => a.alternate)).toEqual([undefined, undefined])
    // Asked each time, and each answer is "once", never the agent's allow_always option.
    expect(r.answered).toEqual(['once', 'once'])
  })
})

describe('a Chat agent: Foreman remembers an always-allow for the session', () => {
  const always: Person = { approve: () => ({ allow: true, alternate: true }) }

  it('has the session-always fallback in its record', () => {
    expect(staticCapabilities('gemini')!.approvals.alwaysAllow).toEqual({ level: 'fallback', fallback: 'session-always' })
  })

  it('offers it for a command with the command as its scope, and answers the agent once', async () => {
    const r = await run('gemini', ['npm   test'], always)
    expect(r.played.approvals[0]).toMatchObject({ alternate: 'always-allow', alwaysScope: 'npm test' })
    expect(r.answered).toEqual(['once'])
  })

  it('lets the same request through afterwards, in this session, and asks about anything else', async () => {
    const r = await run('gemini', ['npm test', 'npm  test', 'npm test --watch', { kind: 'read', path: 'npm test' }], always)
    // The first was asked (and remembered); the same command spelled differently was not; a different command and another kind of tool were.
    expect(r.played.approvals).toHaveLength(3)
    expect(r.played.approvals.map((a) => a.toolName)).toEqual(['Bash', 'Bash', 'Read'])
    expect(r.answered).toEqual(['once', 'once', 'once', 'once'])
  })

  it('remembers across the session’s turns, and forgets with the session', async () => {
    const fake = agent(['npm test'], 's-9')
    const driver = createAcpDriver({ kind: 'gemini', label: 'Gemini', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(fake.app) })
    const base = await request({ approvals: 'ask' })
    const first = callbacks(always)
    await driver.createTurn({ ...base, turnId: 't1', resume: 's-9' }, first.cb).run()
    expect(first.played.approvals).toHaveLength(1)
    // The next turn of the same agent session: not asked.
    const second = callbacks(always)
    await driver.createTurn({ ...base, turnId: 't2', resume: 's-9' }, second.cb).run()
    expect(second.played.approvals).toHaveLength(0)
    // A new conversation (another session) starts with nothing remembered.
    const other = agent(['npm test'], 's-10')
    const driver2 = createAcpDriver({ kind: 'gemini', label: 'Gemini', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(other.app) })
    const third = callbacks(always)
    await driver2.createTurn({ ...base, turnId: 't3' }, third.cb).run()
    expect(third.played.approvals).toHaveLength(1)
  })

  it('keeps asking about agent and git configuration under a cap, every time, with no Always allow for it', async () => {
    const capped = { capped: { ceiling: 'never-ask' as const } }
    const protectedRead = { kind: 'read' as const, path: '.claude/settings.json' }
    const ordinary = { kind: 'read' as const, path: 'README.md' }
    const r = await run('gemini', [protectedRead, protectedRead, ordinary, ordinary], always, capped)
    expect(r.played.approvals.map((a) => [String(a.input.file_path).split(/[\\/]/).pop(), a.alternate])).toEqual([
      ['settings.json', undefined],
      ['settings.json', undefined],
      ['README.md', 'always-allow']
    ])
    // The ordinary path was remembered and went ahead the second time; the configuration one was asked both times.
    expect(r.answered).toEqual(['once', 'once', 'once', 'once'])
  })

  it('a terminal command is remembered the same way', async () => {
    const driver = createAcpDriver({ kind: 'gemini', label: 'Gemini', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(acpFake('terminal-direct')) })
    const { cb, played } = callbacks(always)
    await driver.createTurn(await request({ approvals: 'ask' }), cb).run()
    expect(played.approvals[0]).toMatchObject({ toolName: 'Bash', alternate: 'always-allow' })
    expect(String(played.approvals[0].alwaysScope)).toContain('console.log(40 + 2)')
  })
})

describe('the approval card', () => {
  beforeEach(() => {
    resetFake()
    fakeApi.respondApproval = vi.fn(async () => undefined)
  })
  afterEach(cleanup)
  const card = (agentId: string) => {
    fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', agent: agentId } as never]
    render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' } } as never} workspacePath="/w" />)
  }

  it('says OpenCode asks each time, and has only Yes and No', () => {
    card('opencode')
    expect(screen.getByText('OpenCode can’t remember an always-allow; it asks each time.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /always/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^Yes/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^No/ })).toBeTruthy()
  })

  it('says nothing of the kind for an agent that can remember one', () => {
    card('claude')
    expect(screen.queryByText(/asks each time/)).toBeNull()
  })

  it('names what Always allow will let through, where Foreman remembers it for the session', () => {
    fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', agent: 'gemini' } as never]
    render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' }, alternate: 'always-allow', alwaysScope: 'npm test' } as never} workspacePath="/w" />)
    const button = screen.getByRole('button', { name: /always allow npm test in this session/i })
    expect(button.textContent).toContain('npm test')
    expect(screen.queryByText(/asks each time/)).toBeNull()
  })
})
