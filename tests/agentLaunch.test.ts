// #22: launching catalog agents. Chat agents run through the generic ACP adapter
// with their own command line (checked per agent, then end to end against a fake
// ACP agent, in process and as a real program found on PATH); Terminal agents run
// their CLI in a terminal in the worktree, with activity tracked and scratch files
// kept out of git through info/exclude.
import * as acp from '@agentclientprotocol/sdk'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogAgent, CHAT_AGENT_IDS, type TerminalAgentRun } from '../src/shared/agentCatalog'
import type { ShellLaunch } from '../src/shared/shells'
import type { Settings } from '../src/shared/types'
import { createAcpDriver, type AcpConnector } from '../src/main/agents/acp'
import { acpCommand, acpConfigFor, acpReported, catalogDriver, catalogLoginCommand, executablePathFor, type LaunchEnv } from '../src/main/agents/catalogDrivers'
import { driverFor } from '../src/main/agents/registry'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { git, gitOut } from '../src/main/git'
import { excludeInGit, TerminalAgents } from '../src/main/terminalAgents'
import type { ChatItem } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const posix = (files: string[], dirs = '/usr/local/bin:/opt/bin'): LaunchEnv => ({ path: dirs, platform: 'darwin', exists: (f) => files.includes(f) })

describe('ACP launch config per Chat agent', () => {
  it('starts each Chat agent with its ACP command, found on PATH', () => {
    const lines = Object.fromEntries(
      CHAT_AGENT_IDS.map((id) => {
        const agent = catalogAgent(id)!
        const bin = agent.acp!.binaries?.[0] ?? agent.binaries[0]
        const cmd = acpCommand(agent, undefined, posix([`/opt/bin/${bin}`]))
        return [id, [cmd.file, ...cmd.args].join(' ')]
      })
    )
    expect(lines).toEqual({
      gemini: '/opt/bin/gemini --experimental-acp',
      qwen: '/opt/bin/qwen --acp',
      kimi: '/opt/bin/kimi acp',
      droid: '/opt/bin/droid exec --output-format acp-daemon',
      copilot: '/opt/bin/copilot --acp --no-auto-update',
      goose: '/opt/bin/goose acp',
      deepseek: '/opt/bin/dsh --profile acp',
      pi: '/opt/bin/pi-acp',
      commandcode: '/opt/bin/cmd acp --skip-onboarding --no-auto-update --trust',
      omp: '/opt/bin/omp acp',
      antigravity: '/opt/bin/agy_acp_server'
    })
  })

  it('uses a configured path, except where ACP is a separate program; not found falls back to the bare name', () => {
    const gemini = catalogAgent('gemini')!
    expect(acpCommand(gemini, '/custom/gemini', posix([]))).toEqual({ file: '/custom/gemini', args: ['--experimental-acp'] })
    expect(acpCommand(catalogAgent('pi')!, '/custom/pi', posix(['/opt/bin/pi-acp'])).file).toBe('/opt/bin/pi-acp')
    expect(acpCommand(gemini, undefined, posix([]))).toEqual({ file: 'gemini', args: ['--experimental-acp'] })
  })

  it('uses Command Code’s Windows name and starts npm shims through cmd.exe', () => {
    const win: LaunchEnv = { path: 'C:\\npm', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\npm\\cmdc.cmd' }
    const cmd = acpCommand(catalogAgent('commandcode')!, undefined, win)
    expect(cmd.args).toEqual(['/d', '/c', 'C:\\npm\\cmdc.cmd', 'acp', '--skip-onboarding', '--no-auto-update', '--trust'])
  })

  it('has a driver for every Chat agent and none for Terminal agents', () => {
    for (const id of CHAT_AGENT_IDS) {
      expect(catalogDriver(id)?.kind).toBe(id)
      expect(driverFor(id).kind).toBe(id)
    }
    expect(catalogDriver('aider')).toBeUndefined()
    expect(catalogDriver('claude')).toBeUndefined()
  })

  it('reads executable paths per agent', () => {
    const s = { claudeExecutablePath: '/c', codexExecutablePath: '', opencodeExecutablePath: '/o', agentPrefs: { gemini: { path: '/g' } } } as unknown as Settings
    expect(executablePathFor(s, 'claude')).toBe('/c')
    expect(executablePathFor(s, 'codex')).toBeUndefined()
    expect(executablePathFor(s, 'gemini')).toBe('/g')
    expect(executablePathFor(s, 'cursor')).toBeUndefined()
  })

  it('builds the sign-in command from the agent’s login arguments; unconfirmed and Full agents have none here', () => {
    expect(catalogLoginCommand('kiro', undefined, posix(['/opt/bin/kiro-cli']))).toMatch(/kiro-cli["']? ["']?login["']?$/)
    expect(catalogLoginCommand('gemini', '/my/gemini', posix([]))).toMatch(/\/my\/gemini["']?$/)
    expect(() => catalogLoginCommand('kimchi', undefined, posix([]))).toThrow()
    expect(() => catalogLoginCommand('claude', undefined, posix([]))).toThrow()
    expect(() => catalogLoginCommand('aider', undefined, posix([]))).toThrow()
  })
})

// ---- end to end over ACP ----

function fakeAgent(log: { methods: string[] }) {
  return acp
    .agent({ name: 'fake-gemini' })
    .onRequest(acp.methods.agent.initialize, () => {
      log.methods.push('initialize')
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }
    })
    .onRequest(acp.methods.agent.session.new, () => {
      log.methods.push('session/new')
      return { sessionId: 'g-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi from Gemini' } } })
      return { stopReason: 'end_turn' }
    })
}

function inProcess(app: acp.AgentApp): AcpConnector {
  return () => {
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const conn = app.connect({ readable: toAgent.readable, writable: toClient.writable })
    return { stream: { readable: toClient.readable, writable: toAgent.writable }, failure: () => ({ stderr: '' }), close: async () => conn.close() }
  }
}

function request(cwd: string, env: Record<string, string> = {}): TurnRequest {
  return { turnId: 't1', prompt: 'hello', cwd, env, model: '', fastMode: false, planMode: false, approvals: 'ask', systemPromptAppend: '' }
}

function recorder() {
  const items: ChatItem[] = []
  const results: unknown[] = []
  const cb: TurnCallbacks = {
    item: (item, transient) => void (!transient && items.push(item)),
    sessionStarted: () => {},
    assistantMessage: () => {},
    approveTool: async () => ({ kind: 'tool', allow: true }),
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => ({ kind: 'question', skipped: true }),
    planModeChanged: () => {},
    autoAcceptEdits: () => {},
    usage: () => {},
    finished: (r) => void results.push(r)
  }
  const text = () => items.filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant').map((i) => i.text)
  return { cb, items, results, text }
}

describe('Chat agents over the generic ACP adapter', () => {
  it('runs a turn with the agent’s own config and remembers what it declared', async () => {
    const log = { methods: [] as string[] }
    const driver = createAcpDriver(acpConfigFor(catalogAgent('gemini')!, { connect: inProcess(fakeAgent(log)) }))
    const rec = recorder()
    await driver.createTurn(request(await tempDir()), rec.cb).run()
    expect(rec.text()).toEqual(['Hi from Gemini'])
    expect(rec.results).toEqual([{ ok: true }])
    expect(log.methods).toEqual(['initialize', 'session/new'])
    expect(acpReported().gemini).toMatchObject({ loadSession: true, images: true, modes: ['default', 'plan'] })
  })

  it('finds a real agent program on PATH and starts it with its ACP flag', async () => {
    const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@agentclientprotocol/sdk')).href
    const dir = await tempDir('foreman-gemini-bin-')
    const script = path.join(dir, 'agent.mjs')
    await writeFile(
      script,
      `import * as acp from ${JSON.stringify(sdk)}
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)))
acp.agent({ name: 'script' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 's' }))
  .onRequest('session/prompt', async ({ params, client }) => {
    await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'key=' + (process.env.GEMINI_API_KEY ?? 'none') } } })
    return { stopReason: 'end_turn' }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`
    )
    const win = process.platform === 'win32'
    const bin = path.join(dir, win ? 'gemini.cmd' : 'gemini')
    await writeFile(bin, win ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    if (!win) await chmod(bin, 0o755)
    const launchEnv: LaunchEnv = { path: dir, platform: process.platform, pathExt: process.env.PATHEXT, exists: existsSync }
    const driver = createAcpDriver(acpConfigFor(catalogAgent('gemini')!, { launchEnv }))
    const cwd = await tempDir('foreman-gemini-cwd-')
    const rec = recorder()
    await driver.createTurn(request(cwd, { ...(process.env as Record<string, string>), GEMINI_API_KEY: 'scoped' }), rec.cb).run()
    expect(rec.items.filter((i) => i.kind === "notice"), JSON.stringify(rec.items)).toEqual([])
    expect(rec.text()).toEqual(["key=scoped"])
    expect(JSON.parse(await readFile(path.join(cwd, 'argv.json'), 'utf8'))).toEqual(['--experimental-acp'])
  }, 20_000)
})

// ---- Terminal agents ----

function terminalHost(over: { files?: string[]; now?: () => number } = {}) {
  const spawned: { workspaceId: string; cwd: string; env: Record<string, string>; launch: ShellLaunch & { notice?: string } }[] = []
  const excluded: { worktree: string; patterns: string[] }[] = []
  const files = over.files ?? ['/usr/local/bin/aider', '/usr/local/bin/amp']
  const host = new TerminalAgents({
    spawn: (workspaceId, cwd, env, _cols, _rows, launch) => {
      spawned.push({ workspaceId, cwd, env, launch })
      return `pty-${spawned.length}`
    },
    worktree: (id) => {
      if (id === 'frozen') throw new Error('This workspace is frozen')
      return { path: `/work/${id}`, repoId: 'r1' }
    },
    env: (agent) => ({ AGENT: agent }),
    executablePath: () => undefined,
    path: () => '/usr/local/bin',
    platform: 'darwin',
    exists: (f) => files.includes(f),
    exclude: async (worktree, patterns) => void excluded.push({ worktree, patterns }),
    now: over.now
  })
  return { host, spawned, excluded }
}

describe('Terminal agents', () => {
  it('starts the agent’s CLI directly in the worktree with that agent’s environment, and excludes its scratch files', async () => {
    const { host, spawned, excluded } = terminalHost()
    const id = await host.start('ws1', 'aider', 80, 24)
    expect(id).toBe('pty-1')
    expect(spawned[0]).toMatchObject({ workspaceId: 'ws1', cwd: '/work/ws1', env: { AGENT: 'aider' }, launch: { file: '/usr/local/bin/aider', args: [], notice: '$ aider' } })
    expect(excluded).toEqual([{ worktree: '/work/ws1', patterns: ['.aider*'] }])
  })

  it('tracks output and exit from the process only', async () => {
    let now = 1_000
    const { host } = terminalHost({ now: () => now })
    const id = await host.start('ws1', 'amp', 80, 24)
    expect(host.runs()).toEqual<TerminalAgentRun[]>([{ ptyId: id, workspaceId: 'ws1', agent: 'amp', startedAt: 1_000, lastOutputAt: 1_000 }])
    now = 5_000
    host.output(id)
    host.output('some-other-terminal')
    expect(host.runs()[0].lastOutputAt).toBe(5_000)
    host.exited(id, 0)
    now = 9_000
    host.output(id)
    expect(host.runs()[0]).toMatchObject({ exitCode: 0, lastOutputAt: 5_000 })
    host.forget(id)
    expect(host.runs()).toEqual([])
  })

  it('refuses agents that aren’t installed, aren’t Terminal agents, or a workspace that can’t run them', async () => {
    const { host, spawned } = terminalHost({ files: [] })
    await expect(host.start('ws1', 'aider', 80, 24)).rejects.toThrow(/isn’t installed[\s\S]*aider\.chat/)
    await expect(host.start('ws1', 'gemini', 80, 24)).rejects.toThrow('Unknown terminal agent')
    await expect(terminalHost().host.start('frozen', 'aider', 80, 24)).rejects.toThrow('frozen')
    expect(spawned).toEqual([])
  })

  it('writes scratch patterns to the repository’s info/exclude, not to any tracked file, once', async () => {
    const repo = await makeRepo()
    const worktree = path.join(await tempDir('foreman-wt-'), 'kigali')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree])
    await excludeInGit(worktree, ['.aider*'])
    await excludeInGit(worktree, ['.aider*'])
    const common = path.resolve(worktree, await gitOut(worktree, ['rev-parse', '--git-common-dir']))
    const exclude = await readFile(path.join(common, 'info', 'exclude'), 'utf8')
    expect(exclude.split(/\r?\n/).filter((l) => l === '.aider*')).toHaveLength(1)
    await writeFile(path.join(worktree, '.aider.chat.history.md'), 'scratch')
    expect(await gitOut(worktree, ['status', '--porcelain'])).toBe('')
    expect(existsSync(path.join(worktree, '.gitignore'))).toBe(false)
  })
})
