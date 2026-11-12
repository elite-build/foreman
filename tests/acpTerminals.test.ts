// ACP agent terminals (docs/agents.md 3): piped child processes through platform.ts, plain text with a byte limit, a
// `truncated` flag and the exit status; a command is a run like a shell tool's (refused where nothing may run, asked about under
// Ask); the client advertises terminals only for a record that offers them; the output shows in the chat as a tool row.
import { afterEach, describe, expect, it } from 'vitest'
import { createAcpDriver } from '../src/main/agents/acp'
import { approvedRun, commandWords, matchesApproval } from '../src/main/agents/acp/remembered'
import { AcpTerminals, MAX_TERMINALS, protectedEnvName, type TerminalHost, type TerminalView } from '../src/main/agents/acp/terminals'
import { acpFake, inProcessAcp, type AcpScenario } from '../src/main/agents/fixtures/fakes'
import type { TurnRequest } from '../src/main/agents/types'
import { staticCapabilities } from '../src/shared/agentCatalog'
import path from 'node:path'
import { makeRepo } from './helpers'
import { callbacks, request, type Person } from './replay/harness'

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] })
const create = (t: AcpTerminals, script: string, more: Partial<Parameters<AcpTerminals['create']>[0]> = {}) => t.create({ sessionId: 's', ...node(script), ...more })

let cwd = ''
let changes: TerminalView[] = []
let host: TerminalHost
const open: AcpTerminals[] = []
function terminals(over: Partial<TerminalHost> = {}): AcpTerminals {
  const t = new AcpTerminals({ ...host, ...over })
  open.push(t)
  return t
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.disposeAll()))
})

async function setup() {
  cwd = await makeRepo()
  changes = []
  host = { cwd, env: { ...process.env } as Record<string, string>, resolveCwd: async (requested) => requested ?? cwd, authorize: async () => undefined, changed: (view) => void changes.push(view) }
}

describe('a terminal is a piped process', () => {
  it('runs a command, hands back its id at once and gives the output as plain text with its exit status', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, "process.stdout.write('one\\n'); process.stderr.write('two\\n')")
    expect(terminalId).toBe('term-1')
    expect(await t.waitForExit({ sessionId: 's', terminalId })).toEqual({ exitCode: 0, signal: null })
    const out = t.output({ sessionId: 's', terminalId })
    // Both streams, in the order they arrived, with no terminal behind them.
    expect(out.output.split('\n').filter(Boolean).sort()).toEqual(['one', 'two'])
    expect(out).toMatchObject({ truncated: false, exitStatus: { exitCode: 0, signal: null } })
  })

  it('reports a failing exit code and runs in the directory and environment it was given', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, "process.stdout.write(process.cwd() + '|' + process.env.FROM_AGENT); process.exit(3)", { env: [{ name: 'FROM_AGENT', value: 'hello' }], cwd })
    expect(await t.waitForExit({ sessionId: 's', terminalId })).toEqual({ exitCode: 3, signal: null })
    const out = t.output({ sessionId: 's', terminalId }).output
    expect(out.endsWith('|hello')).toBe(true)
    expect(out.toLowerCase()).toContain(cwd.replace(/\\/g, '/').split('/').pop()!.toLowerCase())
  })

  it('strips what a program writes for a terminal that is not there', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, "process.stdout.write('\\x1b[31mred\\x1b[0m \\x1b]0;title\\x07plain\\r\\n')")
    await t.waitForExit({ sessionId: 's', terminalId })
    expect(t.output({ sessionId: 's', terminalId }).output).toBe('red plain\n')
  })

  it('keeps the end of the output within the byte limit, cutting at a character boundary, and says it truncated', async () => {
    await setup()
    const t = terminals()
    // 3-byte characters: a limit that falls inside one must not leave half of it.
    const { terminalId } = await create(t, "process.stdout.write('€'.repeat(1000) + 'END')", { outputByteLimit: 100 })
    await t.waitForExit({ sessionId: 's', terminalId })
    const out = t.output({ sessionId: 's', terminalId })
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.output)).toBeLessThanOrEqual(100)
    expect(out.output.endsWith('END')).toBe(true)
    expect(out.output).not.toContain('�')
  })

  it('kill stops it but keeps the terminal readable; release stops it too and forgets the id', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, "process.stdout.write('started'); setInterval(() => {}, 1000)")
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(t.output({ sessionId: 's', terminalId }).exitStatus).toBeUndefined()
    await t.kill({ sessionId: 's', terminalId })
    const status = await t.waitForExit({ sessionId: 's', terminalId })
    expect(status.exitCode === 0 && !status.signal).toBe(false)
    expect(t.output({ sessionId: 's', terminalId }).output).toContain('started')
    await t.release({ sessionId: 's', terminalId })
    expect(() => t.output({ sessionId: 's', terminalId })).toThrow(/No terminal/)
  })

  it('release stops a command that still runs', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, 'setInterval(() => {}, 1000)')
    await t.release({ sessionId: 's', terminalId })
    // Gone for the agent; the chat still shows what it last held.
    expect(() => t.output({ sessionId: 's', terminalId })).toThrow(/No terminal/)
    expect(t.viewOf(terminalId)).toMatchObject({ running: false })
    expect(t.viewOf('never-made')).toBeUndefined()
  })

  it('a command that is not there is a terminal that already exited, saying so', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await t.create({ sessionId: 's', command: 'definitely-not-a-program-foreman', args: ['x'] })
    expect(await t.waitForExit({ sessionId: 's', terminalId })).toEqual({ exitCode: 127, signal: null })
    expect(t.output({ sessionId: 's', terminalId }).output).toMatch(/command not found|ENOENT/)
  })

  it('refuses an unknown id and more than the allowed number at once', async () => {
    await setup()
    const t = terminals()
    expect(() => t.output({ sessionId: 's', terminalId: 'nope' })).toThrow(/No terminal nope/)
    for (let i = 0; i < MAX_TERMINALS; i++) await create(t, 'setInterval(() => {}, 1000)')
    await expect(create(t, '1')).rejects.toThrow(/Too many terminals/)
  })

  it('does not start a command that authorize refuses, and never made a terminal for it', async () => {
    await setup()
    const refused: string[] = []
    const t = terminals({ authorize: async (command) => (refused.push(command), Promise.reject(new Error('no'))) })
    await expect(create(t, '1')).rejects.toThrow('no')
    expect(refused).toHaveLength(1)
    expect(t.viewOf('term-1')).toBeUndefined()
  })

  it('tells the chat when output arrives and when it ends', async () => {
    await setup()
    const t = terminals()
    const { terminalId } = await create(t, "process.stdout.write('x')")
    await t.waitForExit({ sessionId: 's', terminalId })
    expect(changes.at(-1)).toMatchObject({ id: terminalId, running: false, output: 'x', exitStatus: { exitCode: 0 } })
  })
})

describe('through the adapter', () => {
  const driver = () => createAcpDriver({ kind: 'gemini', label: 'Gemini', command: () => ({ file: 'unused', args: [] }) })
  async function run(scenario: AcpScenario, req: Partial<TurnRequest> = {}, person: Person = {}, kind: 'gemini' | 'cursor' = 'gemini') {
    const d = createAcpDriver({ kind, label: kind, command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(acpFake(scenario)) })
    const { cb, played } = callbacks(person)
    const turn = d.createTurn(await request(req), cb)
    await turn.run()
    return played
  }
  const says = (p: Awaited<ReturnType<typeof run>>) => p.find('assistant').map((a) => a.text).join(' ')

  it('advertises terminals only for a record that offers them', () => {
    expect(staticCapabilities('gemini')!.tools.terminals.level).toBe('native')
    expect(staticCapabilities('opencode')!.tools.terminals.level).toBe('native')
    for (const agent of ['claude', 'codex', 'cursor']) expect(staticCapabilities(agent)!.tools.terminals.level, agent).toBe('none')
  })

  it('an agent whose record has none sees no terminal in initialize, so it does not ask', async () => {
    void driver
    const p = await run('terminal', {}, {}, 'cursor')
    expect(says(p)).toBe('I have no terminal, so I did not run it.')
    expect(p.approvals).toEqual([])
  })

  it('under Ask, a command the agent did not ask about is asked about once, as a shell tool, and runs when allowed', async () => {
    const p = await run('terminal-direct', { approvals: 'ask' })
    expect(p.approvals).toHaveLength(1)
    expect(p.approvals[0]).toMatchObject({ kind: 'tool', toolName: 'Bash' })
    expect(String((p.approvals[0] as { input?: Record<string, unknown> }).input?.command)).toContain('console.log(40 + 2)')
    expect(says(p)).toBe('ran: 42 (exit 0)')
    // The agent named no tool call for it, so the output is a tool row of Foreman's own.
    const rows = p.find('tool')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Bash', status: 'done', output: '42\n' })
  })

  it('declining is a refusal the agent reads, and nothing ran', async () => {
    const p = await run('terminal-direct', { approvals: 'ask' }, { approve: () => ({ allow: false }) })
    expect(says(p)).toMatch(/refused: .*declined to run this command/)
    expect(p.find('tool')).toEqual([])
  })

  it('under Never ask it runs without asking', async () => {
    const p = await run('terminal-direct', { approvals: 'never-ask' })
    expect(p.approvals).toEqual([])
    expect(says(p)).toBe('ran: 42 (exit 0)')
  })

  it('is refused where nothing may run: a read-only chat, and a turn held below Never ask', async () => {
    const readOnly = await run('terminal-direct', { approvals: 'never-ask', readOnly: true })
    expect(says(readOnly)).toMatch(/refused: .*read-only/)
    expect(readOnly.approvals).toEqual([])
    const capped = await run('terminal-direct', { approvals: 'never-ask', capped: { ceiling: 'ask' } })
    expect(says(capped)).toMatch(/refused: .*held to “ask”/)
  })

  it('an approval covers the command it showed, once: any other terminal is asked about on its own, and so is a second run', async () => {
    // The person allows the first card (the execute tool call) and declines every other.
    const asked: string[] = []
    const p = await run('terminal-swap', { approvals: 'ask' }, { approve: (r) => (asked.push(String((r.input as { command?: string }).command)), { allow: asked.length === 1 }) })
    // The approved command's own card, then `40 + 2` (declined), then the approved command's second run (declined: its approval was used by the first).
    expect(asked).toHaveLength(3)
    expect(asked[0]).toContain('console.log(1 + 1)')
    expect(asked[1]).toContain('console.log(40 + 2)')
    expect(asked[2]).toContain('console.log(1 + 1)')
    expect(says(p)).toBe('refused console.log(40 + 2); ran console.log(1 + 1); refused console.log(1 + 1)')
  })

  it('shows the folder and the names of the variables the agent sets, asks again for what the tool call never showed, and refuses the variables that change how commands start', async () => {
    const { mkdirSync } = await import('node:fs')
    const asked: { input: Record<string, unknown>; alternate?: string; alwaysScope?: string }[] = []
    const cwd = await makeRepo()
    mkdirSync(path.join(cwd, 'sub'))
    const d = createAcpDriver({ kind: 'gemini', label: 'gemini', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(acpFake('terminal-env')) })
    const { cb, played } = callbacks({ approve: (r) => (asked.push({ input: r.input as Record<string, unknown>, alternate: r.alternate, alwaysScope: r.alwaysScope }), { allow: true, alternate: Boolean(r.input.env) }) })
    await d.createTurn(await request({ approvals: 'ask', cwd }), cb).run()
    const said = played.find('assistant').map((a) => a.text).join(' ').split('|')
    // The tool call's own card, then each terminal that is not exactly what it showed: FOO (remembered), BAR, and the folder `sub`. The
    // second FOO is remembered; the plain one is covered by the tool call's approval, once.
    expect(asked.map((a) => a.input)).toEqual([
      { command: 'node -e "console.log(1 + 1)"' },
      { command: 'node -e console.log(1 + 1)', env: ['FOO'] },
      { command: 'node -e console.log(1 + 1)', env: ['BAR'] },
      { command: 'node -e console.log(1 + 1)', cwd: 'sub' }
    ])
    // What is remembered names where and with what: the card says so.
    expect(asked[1].alwaysScope).toBe('node -e console.log(1 + 1) (sets FOO)')
    expect(asked[3].alwaysScope).toBe('node -e console.log(1 + 1) (in sub)')
    expect(said.slice(0, 5)).toEqual(['ran FOO', 'ran FOO', 'ran BAR', 'ran sub', 'ran plain'])
    // None of these is asked about: they are refused, with the name.
    for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'FOREMAN_TURN_ID', 'SWITCHYARD_PORT']) expect(said.find((s) => s.startsWith(`refused ${name}:`)), name).toContain(`may not set ${name}`)
    expect(said).toHaveLength(12)
  })

  it('knows the variables an agent may not set, with the case of the platform', () => {
    for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'GIT_SSH_COMMAND', 'FOREMAN_TURN_TOKEN', 'SWITCHYARD_PORT']) expect(protectedEnvName(name, false), name).toBe(true)
    for (const name of ['FOO', 'NODE_ENV', 'CI', 'MYGIT_DIR']) expect(protectedEnvName(name, false), name).toBe(false)
    // Windows names are not case-sensitive: `Path` is PATH, and `git_dir` is GIT_DIR. Elsewhere they are different variables.
    expect(protectedEnvName('Path', true)).toBe(true)
    expect(protectedEnvName('git_dir', true)).toBe(true)
    expect(protectedEnvName('Path', false)).toBe(false)
  })

  it('a command the agent already got an approval for (its execute tool call) is not asked about twice', async () => {
    const p = await run('terminal', { approvals: 'ask' })
    expect(p.approvals).toHaveLength(1)
    expect(says(p)).toBe('It printed 2 (exit 0).')
    // The agent's own tool call carries the output (the row it named), and Foreman added no row of its own.
    const rows = p.find('tool')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: expect.stringContaining('call-1'), status: 'done', output: '2\n' })
  })
})

describe('what an approval of an execute tool call covers', () => {
  const covers = (approved: string, command: string, args: string[] = []) => matchesApproval(approvedRun(approved), command, args)

  it('the same command however it is spaced or quoted, and nothing else', () => {
    expect(covers('npm test', 'npm', ['test'])).toBe(true)
    expect(covers('npm  test', 'npm test')).toBe(true)
    expect(covers('node -e "console.log(1 + 1)"', 'node', ['-e', 'console.log(1 + 1)'])).toBe(true)
    expect(covers('node -e "console.log(1 + 1)"', 'node -e "console.log(1 + 1)"')).toBe(true)
    expect(covers('npm test', 'npm', ['run', 'deploy'])).toBe(false)
    expect(covers('npm test', 'npm', ['test', '--', '--watch'])).toBe(false)
    expect(covers('node -e "a"', 'node', ['-e', 'a b'])).toBe(false)
  })

  it('a line that chains commands covers only itself, spelt the same', () => {
    expect(commandWords('npm test && rm -rf .')).toBeUndefined()
    expect(covers('npm test && rm -rf .', 'npm', ['test'])).toBe(false)
    expect(covers('npm test && rm -rf .', 'npm test && rm -rf .')).toBe(true)
    expect(commandWords('echo "unclosed')).toBeUndefined()
  })
})

describe('the approval card for a terminal', () => {
  it('says where the command runs and which variables it sets, as part of its summary', async () => {
    const { toolSummary } = await import('../src/shared/toolSummary')
    const t = ((key: string) => key) as never
    const root = { path: '/work' } as never
    expect(toolSummary('Bash', { command: 'npm test' }, root, t)).toBe('npm test')
    expect(toolSummary('Bash', { command: 'npm test', cwd: 'sub', env: ['FOO', 'BAR'] }, root, t)).toBe('npm test (cwd: sub; env: FOO, BAR)')
    expect(toolSummary('Bash', { command: 'npm test', env: ['FOO'] }, root, t)).toBe('npm test (env: FOO)')
  })
})
