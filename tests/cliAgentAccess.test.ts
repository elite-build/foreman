// `foreman agent-access` (docs/agent-access.md §9): the reads in read and everything that changes who may sign in in
// admin; status prints the address and the setup commands; approve types the code at a terminal and refuses without one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/cli/command'
import { agentAccessRunners } from '../src/cli/commands/agentAccess'
import { io } from '../src/cli/commands/input'
import { renderCommandHelp } from '../src/cli/help'
import { AGENT_ACCESS_METHODS } from '../src/main/cli/agentAccess'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { METHODS, tierCheck } from '../src/main/cliServer'
import type { AgentAccessInfo, AgentAccessLevel, AgentGrant } from '../src/shared/agentAccess'
import { commandName, findCommand } from '../src/shared/cliCommands'
import { AGENT_ACCESS_COMMANDS } from '../src/shared/cliCommandsSettings'
import type { AgentAccessApproveResult, AgentAccessPendingResult, AgentAccessRevokeResult, AgentAccessStatusResult } from '../src/shared/cli/agentAccess'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const grant = (patch: Partial<AgentGrant> = {}): AgentGrant => ({ id: 'g-1111aaaa', clientId: 'c-1', name: 'Claude Code', redirect: '127.0.0.1:53682', level: 'ask', grantedAt: '2026-11-01T09:00:00.000Z', lastSeen: '2026-11-10T08:30:00.000Z', ...patch })

/** An AgentAccessService stand-in over one AgentAccessInfo, recording what was asked. Its code is 123456. */
function service(start: Partial<AgentAccessInfo> = {}) {
  const info: AgentAccessInfo = { enabled: true, port: 47634, url: 'http://127.0.0.1:47634/mcp', pending: [], grants: [], ...start }
  const calls: [string, ...unknown[]][] = []
  const copy = (): AgentAccessInfo => structuredClone(info)
  const api = fakeApi({
    agentAccessInfo: async () => copy(),
    agentAccessApprove: async (id: string, code: string, level: AgentAccessLevel) => {
      calls.push(['agentAccessApprove', id, code, level])
      if (code.replace(/\s+/g, '') !== '123456') throw new Error('That code doesn’t match the one the sign-in page shows. 2 tries left.')
      info.pending = info.pending.filter((p) => p.id !== id)
      return copy()
    },
    agentAccessDeny: async (id: string) => {
      calls.push(['agentAccessDeny', id])
      info.pending = info.pending.filter((p) => p.id !== id)
      return copy()
    },
    agentAccessRevoke: async (id: string) => {
      calls.push(['agentAccessRevoke', id])
      info.grants = info.grants.filter((g) => g.id !== id)
      return copy()
    }
  })
  const host = stubHost({ api })
  const call = <T>(method: string, params?: unknown) => AGENT_ACCESS_METHODS[method].handle(host, params, ctx) as Promise<T>
  const asks = (id = 'p-1111aaaa', name = 'Claude Code') => void info.pending.push({ id, name, redirect: '127.0.0.1:53682', expiresAt: Date.now() + 240_000 })
  return { info, calls, call, asks }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the agent-access methods', () => {
  it('reads in read and changes who may sign in only in admin, the same as the command table says', () => {
    const tiers = { 'agent-access-status': 'read', 'agent-access-pending': 'read', 'agent-access-approve': 'admin', 'agent-access-deny': 'admin', 'agent-access-revoke': 'admin' }
    expect(Object.fromEntries(Object.entries(AGENT_ACCESS_METHODS).map(([m, d]) => [m, d.tier]))).toEqual(tiers)
    expect(Object.fromEntries(AGENT_ACCESS_COMMANDS.map((c) => [commandName(c), c.tier]))).toEqual({
      'agent-access': 'read', 'agent-access status': 'read', 'agent-access pending': 'read', 'agent-access approve': 'admin', 'agent-access deny': 'admin', 'agent-access revoke': 'admin'
    })
    for (const [m, tier] of Object.entries(tiers)) expect(METHODS[m]?.tier, m).toBe(tier)
  })

  it('refuses every admin one from inside an agent turn, and serves the reads there', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'turn-token' }
    for (const [method, def] of Object.entries(AGENT_ACCESS_METHODS)) {
      const refusal = tierCheck(method, def.tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host)
      if (def.tier === 'admin') expect(refusal, method).toMatchObject({ code: 'refused', error: expect.stringContaining('inside an agent turn') })
      else expect(refusal, method).toBeNull()
    }
  })

  it('status prints the address, both setup commands, the signed-in agents and who is asking', async () => {
    const s = service({ grants: [grant(), grant({ id: 'g-2222bbbb', name: 'Codex', level: 'read', lastSeen: undefined })] })
    s.asks()
    const result = await s.call<AgentAccessStatusResult>('agent-access-status')
    expect(result.setup).toEqual({ claude: 'claude mcp add --scope user --transport http foreman http://127.0.0.1:47634/mcp', codex: 'codex mcp add foreman --url http://127.0.0.1:47634/mcp' })
    expect(result.text).toContain('Agents on this computer: on, at http://127.0.0.1:47634/mcp')
    expect(result.text).toContain('  claude mcp add --scope user --transport http foreman http://127.0.0.1:47634/mcp')
    expect(result.text).toContain('  codex mcp add foreman --url http://127.0.0.1:47634/mcp')
    expect(result.text).toMatch(/Claude Code\s+Ask\s+2026-11-01 09:00 UTC\s+2026-11-10 08:30 UTC\s+g-1111aaaa/)
    expect(result.text).toMatch(/Codex\s+Read only\s+2026-11-01 09:00 UTC\s+never\s+g-2222bbbb/)
    expect(result.text).toMatch(/Claude Code\s+127\.0\.0\.1:53682\s+expires in \d+m/)
    expect(result.text).toContain('not what it can do with its own shell and files')
    expect(result.grants.map((g) => g.id)).toEqual(['g-1111aaaa', 'g-2222bbbb'])
  })

  it('status says how to turn it on when it is off, and why it is off when the port was taken', async () => {
    const off = await service({ enabled: false }).call<AgentAccessStatusResult>('agent-access-status')
    expect(off.text).toContain('off (port 47634)')
    expect(off.text).toContain('foreman settings set devices.agent-access on')
    expect(off.text).not.toContain('claude mcp add')
    expect(off.text).toContain('No agents are signed in.')
    const taken = await service({ enabled: false, error: 'Foreman couldn’t listen for agents on 127.0.0.1:47634 (another program is using it).' }).call<AgentAccessStatusResult>('agent-access-status')
    expect(taken.error).toContain('another program')
    expect(taken.text).toContain('another program is using it')
  })

  it('pending lists what each calls itself, where it returns and when it expires, never a code', async () => {
    const s = service()
    expect(await s.call<AgentAccessPendingResult>('agent-access-pending')).toEqual({ pending: [], text: 'No sign-in is waiting.' })
    s.asks()
    const result = await s.call<AgentAccessPendingResult>('agent-access-pending')
    expect(result.pending).toEqual([{ id: 'p-1111aaaa', name: 'Claude Code', redirect: '127.0.0.1:53682', expiresAt: expect.any(Number) }])
    expect(result.text).toMatch(/NAME\s+RETURNS TO\s+EXPIRES\s+ID/)
    expect(result.text).not.toContain('123456')
  })

  it('approve passes the typed code and the level, Ask by default, to the only sign-in waiting', async () => {
    const s = service()
    s.asks()
    const result = await s.call<AgentAccessApproveResult>('agent-access-approve', { code: '123 456' })
    expect(s.calls).toEqual([['agentAccessApprove', 'p-1111aaaa', '123456', 'ask']])
    expect(result.text).toContain('Approved “Claude Code” at Ask')
    const read = service()
    read.asks()
    await read.call('agent-access-approve', { code: '123456', level: 'read' })
    expect(read.calls).toEqual([['agentAccessApprove', 'p-1111aaaa', '123456', 'read']])
  })

  it('approve finds a named sign-in among several, and refuses when it names none', async () => {
    const s = service()
    s.asks('p-1111aaaa', 'Claude Code')
    s.asks('p-2222bbbb', 'Codex')
    const several = await failure(s.call('agent-access-approve', { code: '123456' }))
    expect(several.code).toBe('ambiguous')
    expect(several.message).toContain('p-2222bbbb')
    await s.call('agent-access-approve', { id: 'codex', code: '123456' })
    await s.call('agent-access-approve', { id: 'p-1111', code: '123456' })
    expect(s.calls).toEqual([['agentAccessApprove', 'p-2222bbbb', '123456', 'ask'], ['agentAccessApprove', 'p-1111aaaa', '123456', 'ask']])
  })

  it('approve refuses a wrong code with the tries left, a code that isn’t six digits, a level it doesn’t know, and when nothing waits', async () => {
    const s = service()
    expect((await failure(s.call('agent-access-approve', { code: '123456' }))).code).toBe('not-found')
    s.asks()
    const wrong = await failure(s.call('agent-access-approve', { code: '654321' }))
    expect(wrong.code).toBe('refused')
    expect(wrong.message).toContain('2 tries left')
    expect((await failure(s.call('agent-access-approve', { code: '1234' }))).code).toBe('invalid')
    expect((await failure(s.call('agent-access-approve', { code: '123456', level: 'admin' }))).code).toBe('invalid')
    expect(s.calls).toEqual([['agentAccessApprove', 'p-1111aaaa', '654321', 'ask']])
  })

  it('deny refuses the one waiting, or the one named', async () => {
    const s = service()
    expect((await failure(s.call('agent-access-deny'))).code).toBe('not-found')
    s.asks()
    expect((await s.call<{ text: string }>('agent-access-deny')).text).toBe('Denied the sign-in from “Claude Code”.')
    s.asks('p-3333cccc', 'Codex')
    s.asks('p-4444dddd', 'Other')
    await s.call('agent-access-deny', { id: 'p-4444dddd' })
    expect(s.calls).toEqual([['agentAccessDeny', 'p-1111aaaa'], ['agentAccessDeny', 'p-4444dddd']])
  })

  it('revoke finds a signed-in agent by id, the start of one or a name only it has', async () => {
    const s = service({ grants: [grant(), grant({ id: 'g-2222bbbb', name: 'Codex' })] })
    const result = await s.call<AgentAccessRevokeResult>('agent-access-revoke', { grant: 'codex' })
    expect(result.revoked).toMatchObject({ id: 'g-2222bbbb', name: 'Codex' })
    expect(result.text).toContain('Revoked “Codex”.')
    await s.call('agent-access-revoke', { grant: 'g-1111' })
    expect(s.calls).toEqual([['agentAccessRevoke', 'g-2222bbbb'], ['agentAccessRevoke', 'g-1111aaaa']])
    expect((await failure(s.call('agent-access-revoke', { grant: 'Cursor' }))).code).toBe('not-found')
  })
})

describe('the agent-access commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, replies: Record<string, unknown> = {}, confirmed = true) {
    const sent: [string, unknown][] = []
    const out: string[] = []
    const notes: string[] = []
    const context: Context = {
      args,
      opts,
      json: false,
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string, params?: unknown) => {
        sent.push([method, params])
        return replies[method] ?? { text: `${method} ok` }
      }) as Context['send'],
      print: (_value, text) => void out.push(typeof text === 'function' ? text() : text),
      confirm: async () => confirmed,
      note: (text) => void notes.push(text),
      progress: () => undefined
    }
    return { context, sent, out, notes }
  }

  const waiting = (...names: string[]) => ({
    'agent-access-pending': { pending: names.map((name, i) => ({ id: `p-${i + 1}`, name, redirect: `127.0.0.1:5368${i}`, expiresAt: Date.now() + 240_000 })), text: '' }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('sends the words each read and change takes', async () => {
    const run = async (name: string, args: string[]) => {
      const { context, sent } = fakeContext(args)
      await agentAccessRunners[name](context)
      return sent
    }
    expect(await run('agent-access', [])).toEqual([['agent-access-status', undefined]])
    expect(await run('agent-access', ['status'])).toEqual([['agent-access-status', undefined]])
    expect(await run('agent-access status', [])).toEqual([['agent-access-status', undefined]])
    expect(await run('agent-access pending', [])).toEqual([['agent-access-pending', undefined]])
    expect(await run('agent-access deny', [])).toEqual([['agent-access-deny', undefined]])
    expect(await run('agent-access deny', ['p-1'])).toEqual([['agent-access-deny', { id: 'p-1' }]])
    expect(await run('agent-access revoke', ['Codex'])).toEqual([['agent-access-revoke', { grant: 'Codex' }]])
  })

  it('approve refuses without a terminal, before asking the app anything', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    const prompt = vi.spyOn(io, 'promptLine')
    const { context, sent } = fakeContext([], {}, waiting('Claude Code'))
    await expect(agentAccessRunners['agent-access approve'](context)).rejects.toMatchObject({ exitCode: 6, message: expect.stringContaining('asks for the code at a terminal') })
    expect(sent).toEqual([])
    expect(prompt).not.toHaveBeenCalled()
  })

  it('approve asks for the code at the terminal and sends it with the level', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(true)
    const prompt = vi.spyOn(io, 'promptLine').mockResolvedValue('123 456')
    const { context, sent, notes } = fakeContext([], { level: 'auto' }, waiting('Claude Code'))
    await agentAccessRunners['agent-access approve'](context)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toContain('code its browser page shows')
    expect(notes).toEqual(['Approving “Claude Code”, returning to 127.0.0.1:53680.'])
    expect(sent).toEqual([['agent-access-pending', undefined], ['agent-access-approve', { id: 'p-1', code: '123 456', level: 'auto' }]])
  })

  it('approve asks which when several wait, then for the code', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(true)
    const prompt = vi.spyOn(io, 'promptLine').mockResolvedValueOnce('2').mockResolvedValueOnce('123456')
    const { context, sent } = fakeContext([], {}, waiting('Claude Code', 'Codex'))
    await agentAccessRunners['agent-access approve'](context)
    expect(prompt.mock.calls[0][0]).toMatch(/1\. “Claude Code”[\s\S]*2\. “Codex”[\s\S]*Which one\? \[1-2\]/)
    expect(sent.at(-1)).toEqual(['agent-access-approve', { id: 'p-2', code: '123456', level: undefined }])
  })

  it('approve takes a named sign-in, and refuses a bad level, a bad choice, no code and nothing waiting', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(true)
    vi.spyOn(io, 'promptLine').mockResolvedValue('123456')
    const named = fakeContext(['codex'], {}, waiting('Claude Code', 'Codex'))
    await agentAccessRunners['agent-access approve'](named.context)
    expect(named.sent.at(-1)).toEqual(['agent-access-approve', { id: 'codex', code: '123456', level: undefined }])

    const level = fakeContext([], { level: 'admin' }, waiting('Claude Code'))
    await expect(agentAccessRunners['agent-access approve'](level.context)).rejects.toMatchObject({ exitCode: 2 })
    expect(level.sent).toEqual([])

    const none = fakeContext([], {}, waiting())
    await expect(agentAccessRunners['agent-access approve'](none.context)).rejects.toMatchObject({ exitCode: 8 })

    vi.spyOn(io, 'promptLine').mockResolvedValue('7')
    const choice = fakeContext([], {}, waiting('Claude Code', 'Codex'))
    await expect(agentAccessRunners['agent-access approve'](choice.context)).rejects.toMatchObject({ exitCode: 2 })
    expect(choice.sent).toEqual([['agent-access-pending', undefined]])

    vi.spyOn(io, 'promptLine').mockResolvedValue('  ')
    const empty = fakeContext([], {}, waiting('Claude Code'))
    await expect(agentAccessRunners['agent-access approve'](empty.context)).rejects.toMatchObject({ exitCode: 2 })
    expect(empty.sent).toEqual([['agent-access-pending', undefined]])
  })

  it('takes no --code and no --yes for approve', () => {
    const spec = AGENT_ACCESS_COMMANDS.find((c) => commandName(c) === 'agent-access approve')!
    expect(Object.keys(spec.options)).toEqual(['level'])
    expect(spec.noAssistant).toBeTruthy()
  })

  it('refuses words it can’t use before sending anything', async () => {
    for (const [name, args] of [
      ['agent-access', ['everything']],
      ['agent-access pending', ['x']],
      ['agent-access deny', ['a', 'b']],
      ['agent-access revoke', []]
    ] as [string, string[]][]) {
      const { context, sent } = fakeContext(args)
      await expect(agentAccessRunners[name](context), `${name} ${args.join(' ')}`).rejects.toMatchObject({ exitCode: 2 })
      expect(sent).toEqual([])
    }
  })

  it('revoke asks first, and a no revokes nothing', async () => {
    const { context, sent, notes } = fakeContext(['Codex'], {}, {}, false)
    await agentAccessRunners['agent-access revoke'](context)
    expect(sent).toEqual([])
    expect(notes).toEqual(['Nothing revoked.'])
    expect(process.exitCode).toBe(1)
  })

  it('has a runner, an example and a help page for every command, and resolves each path', () => {
    expect(Object.keys(agentAccessRunners).sort()).toEqual(AGENT_ACCESS_COMMANDS.map(commandName).sort())
    for (const spec of AGENT_ACCESS_COMMANDS) {
      expect(renderCommandHelp(spec)).toContain(spec.usage)
      for (const example of spec.examples ?? []) {
        const words = example.replace(/^foreman /, '').match(/"[^"]*"|\S+/g)!.map((w) => w.replace(/^"|"$/g, ''))
        expect(findCommand(words), example).toMatchObject({ spec: { path: spec.path } })
      }
    }
  })
})
