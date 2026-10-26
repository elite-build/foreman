import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError, request, requestV2 } from '../src/cli/client'
import { completionScript, SHELLS } from '../src/cli/completion'
import { columns, confirm, wantsJson } from '../src/cli/output'
import { ERROR_EXIT, socketPath, type CliProgressFrame } from '../src/cli/protocol'
import { execute } from '../src/cli/registry'
import { CLI_VERSION } from '../src/cli/version'
import { doctor } from '../src/main/cli/app'
import { handleRequest, startCliServer, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { visibleCommands } from '../src/shared/cliCommands'
import type { AgentStatus, Repo } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

/** A tiny server that plays back what a test scripts: it records the request line and writes `chunks` in order. */
async function scripted(chunks: string[] | ((request: Record<string, unknown>, conn: net.Socket) => void), options: { end?: boolean } = {}) {
  const dir = await tempDir()
  const socket = socketPath(dir)
  const received: Record<string, unknown>[] = []
  const server = net.createServer((conn) => {
    let buffer = ''
    conn.setEncoding('utf8')
    conn.on('error', () => undefined)
    conn.on('data', async (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const req = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Record<string, unknown>
      buffer = ''
      received.push(req)
      if (typeof chunks === 'function') return chunks(req, conn)
      for (const piece of chunks) {
        conn.write(piece)
        // Let each piece travel as its own data event.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (options.end !== false) conn.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return { socket, received, close: () => server.close() }
}

describe('requestV2', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  it('sends version 2 with the method, params, caller and token', async () => {
    const s = await scripted([`${JSON.stringify({ ok: true, result: 'fine' })}\n`])
    close = s.close
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    await expect(requestV2(s.socket, 'status', { a: 1 }, { caller, token: 'secret' })).resolves.toBe('fine')
    expect(s.received).toEqual([{ v: 2, method: 'status', params: { a: 1 }, caller, token: 'secret' }])
    // Without them the request carries neither.
    const bare = await scripted([`${JSON.stringify({ ok: true, result: 1 })}\n`])
    await requestV2(bare.socket, 'repos', undefined, { token: null })
    expect(bare.received[0]).toEqual({ v: 2, method: 'repos' })
    bare.close()
  })

  it('hands progress frames to onProgress as they arrive, then resolves with the reply', async () => {
    const frames = [JSON.stringify({ progress: { text: 'Cloning', percent: 10 } }), JSON.stringify({ progress: { text: 'Done cloning' } })]
    const reply = JSON.stringify({ ok: true, result: { id: 7 } })
    // The lines are split mid-way and coalesced: half of one frame, then the rest of it with the next frame.
    const s = await scripted([`${frames[0].slice(0, 12)}`, `${frames[0].slice(12)}\n${frames[1]}\n${reply.slice(0, 5)}`, `${reply.slice(5)}\n`])
    close = s.close
    const seen: CliProgressFrame['progress'][] = []
    await expect(requestV2(s.socket, 'repo-clone', {}, { onProgress: (p) => seen.push(p) })).resolves.toEqual({ id: 7 })
    expect(seen).toEqual([{ text: 'Cloning', percent: 10 }, { text: 'Done cloning' }])
  })

  it('takes a reply that has no trailing newline', async () => {
    const s = await scripted([JSON.stringify({ ok: true, result: 'x' })])
    close = s.close
    await expect(requestV2(s.socket, 'repos', undefined)).resolves.toBe('x')
  })

  it('turns a coded failure into a CliError with the exit code the code stands for', async () => {
    for (const code of Object.keys(ERROR_EXIT) as (keyof typeof ERROR_EXIT)[]) {
      if (code === 'unknown-method') continue
      const s = await scripted([`${JSON.stringify({ ok: false, error: `it was ${code}`, code, hint: 'try this' })}\n`])
      const error = await requestV2(s.socket, 'x', undefined).catch((err: unknown) => err)
      s.close()
      expect(error, code).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ message: `it was ${code}`, exitCode: ERROR_EXIT[code], code, hint: 'try this' })
    }
    expect(ERROR_EXIT['not-found']).toBe(8)
    expect(ERROR_EXIT.refused).toBe(7)
    expect(ERROR_EXIT['needs-confirmation']).toBe(6)
  })

  it('says the command is newer when an old app answers “Unknown request” with no code', async () => {
    const s = await scripted([`${JSON.stringify({ ok: false, error: 'Unknown request doctor' })}\n`])
    close = s.close
    const error = (await requestV2(s.socket, 'doctor', undefined).catch((err: unknown) => err)) as CliError
    expect(error.message).toBe('This foreman command is newer than the running Foreman app. Update the app (the command is part of it).')
    expect(error.code).toBe('not-supported')
    expect(error.exitCode).toBe(ERROR_EXIT['not-supported'])
  })

  it('says the same when a current app doesn’t know the method', async () => {
    const s = await scripted([`${JSON.stringify({ ok: false, error: 'Unknown request nope', code: 'unknown-method' })}\n`])
    close = s.close
    const error = (await requestV2(s.socket, 'nope', undefined).catch((err: unknown) => err)) as CliError
    expect(error.message).toContain('newer than the running Foreman app')
    expect(error.code).toBe('unknown-method')
  })

  it('doesn’t mistake an ordinary failure with no code for an old app', async () => {
    const s = await scripted([`${JSON.stringify({ ok: false, error: 'No workspace named “x”' })}\n`])
    close = s.close
    const error = (await requestV2(s.socket, 'send', undefined).catch((err: unknown) => err)) as CliError
    expect(error).toMatchObject({ message: 'No workspace named “x”', exitCode: 1, code: 'failed' })
  })

  it('exits 5 when Foreman isn’t running, with or without a wait', async () => {
    const dir = await tempDir()
    const socket = socketPath(dir)
    const plain = (await requestV2(socket, 'status', undefined).catch((err: unknown) => err)) as CliError
    expect(plain).toMatchObject({ message: 'Foreman isn’t running. Open the app and try again.', exitCode: 5, code: 'not-running' })
    const waiting = (await requestV2(socket, 'wait', {}, { waiting: true }).catch((err: unknown) => err)) as CliError
    expect(waiting.exitCode).toBe(5)
    expect(waiting.message).toContain('Foreman isn’t running')
    expect(waiting.message).toContain('`foreman wait <turn>`')
  })

  it('exits 5 when the connection ends with no reply', async () => {
    const s = await scripted([`${JSON.stringify({ progress: { text: 'working' } })}\n`])
    close = s.close
    const error = (await requestV2(s.socket, 'wait', {}, { waiting: true }).catch((err: unknown) => err)) as CliError
    expect(error.exitCode).toBe(5)
    expect(error.message).toContain('closed the connection')
    const plain = (await requestV2(s.socket, 'repos', undefined).catch((err: unknown) => err)) as CliError
    expect(plain).toMatchObject({ message: 'Foreman closed the connection without replying.', exitCode: 5 })
  })

  it('reports a reply it can’t read', async () => {
    const s = await scripted(['not json\n'])
    close = s.close
    await expect(requestV2(s.socket, 'repos', undefined)).rejects.toThrow('Foreman sent a reply this command doesn’t understand')
  })
})

describe('the version 1 request', () => {
  it('still sends one line and reads one reply, with no code', async () => {
    const s = await scripted([`${JSON.stringify({ ok: true, result: ['a'] })}\n`])
    await expect(request(s.socket, { method: 'repos' })).resolves.toEqual(['a'])
    expect(s.received).toEqual([{ method: 'repos' }])
    s.close()
    const failing = await scripted([`${JSON.stringify({ ok: false, error: 'No turn' })}\n`])
    const error = (await request(failing.socket, { method: 'cancel', params: { turn: 'x' } }).catch((err: unknown) => err)) as CliError
    expect(error).toMatchObject({ message: 'No turn', exitCode: undefined })
    failing.close()
  })
})

describe('requestV2 against the app’s server', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  async function serve(overrides: Partial<CliHost> = {}) {
    const dataDir = await tempDir()
    const host = stubHost({ appInfo: () => ({ version: '9.9.9', packaged: true, dataDir }), ...overrides })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()
    return { socket, dataDir, host }
  }

  it('gets app-info, with whether the command is installed', async () => {
    const { socket, dataDir } = await serve({ api: fakeApi({ cliStatus: async () => ({ installed: true, path: '/usr/local/bin/foreman' }) }) })
    const info = await requestV2<{ version: string; protocol: number; dataDir: string; cliInstalled?: boolean; cliPath?: string }>(socket, 'app-info', undefined)
    expect(info).toMatchObject({ version: '9.9.9', protocol: 2, dataDir, cliInstalled: true, cliPath: '/usr/local/bin/foreman' })
  })

  it('leaves the install facts out when the app can’t say', async () => {
    const { socket } = await serve()
    const info = await requestV2<Record<string, unknown>>(socket, 'app-info', undefined)
    expect(info).not.toHaveProperty('cliInstalled')
  })

  it('refuses cli-install without the launch token, and installs with it', async () => {
    const installed = { installed: true, path: '/x/foreman', note: 'Open a new terminal' }
    const { socket } = await serve({ api: fakeApi({ installCli: async () => installed }) })
    const refused = (await requestV2(socket, 'cli-install', undefined).catch((err: unknown) => err)) as CliError
    expect(refused).toMatchObject({ exitCode: 7, code: 'refused' })
    await expect(requestV2(socket, 'cli-install', undefined, { token: 'test-token' })).resolves.toEqual(installed)
  })

  it('gets cli-status without a token', async () => {
    const { socket } = await serve({ api: fakeApi({ cliStatus: async () => ({ installed: false, path: null }) }) })
    await expect(requestV2(socket, 'cli-status', undefined)).resolves.toEqual({ installed: false, path: null })
  })

  it('runs a command end to end: the context, the socket and the printing', async () => {
    const repos = [{ id: 'r1', name: 'api', rootPath: '/code/api' }, { id: 'r2', name: 'web', rootPath: '/code/web' }] as Repo[]
    const { dataDir } = await serve({ state: () => ({ repos, workspaces: [], sessions: [], settings: defaultSettings() }) })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await execute(['repos'], { env: { FOREMAN_DATA_DIR: dataDir } })
      // The listing starts each row with the name and the path, as `foreman repos` always has; more columns follow.
      const lines = (log.mock.calls.at(-1)![0] as string).split('\n')
      expect(lines[0]).toMatch(/^api\s+\/code\/api/)
      expect(lines[1]).toMatch(/^web\s+\/code\/web/)
      await execute(['--json', 'repos'], { env: { FOREMAN_DATA_DIR: dataDir } })
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject([{ name: 'api', path: '/code/api' }, { name: 'web', path: '/code/web' }])
      await execute(['repos'], { env: { FOREMAN_DATA_DIR: dataDir, FOREMAN_JSON: '1' } })
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toHaveLength(2)
      await execute(['app', 'info'], { env: { FOREMAN_DATA_DIR: dataDir } })
      expect(log.mock.calls.at(-1)![0]).toContain('version      9.9.9')
      expect(log.mock.calls.at(-1)![0]).toContain('protocol     2')
    } finally {
      log.mockRestore()
    }
  })

  it('has `foreman repos --share` fail as a usage error before it asks the app anything', async () => {
    const { dataDir } = await serve()
    await expect(execute(['repos', '--share'], { env: { FOREMAN_DATA_DIR: dataDir } })).rejects.toMatchObject({ message: 'foreman repos doesn’t take --share', exitCode: 2 })
  })

  it('exits 5 for a command when the app isn’t running', async () => {
    const dir = await tempDir()
    await expect(execute(['status'], { env: { FOREMAN_DATA_DIR: dir } })).rejects.toMatchObject({ exitCode: 5, code: 'not-running' })
  })
})

describe('doctor', () => {
  const ready = (agent: string): AgentStatus => ({ agent, installed: true, ready: true, version: '1.2.3', method: 'Claude Max account' }) as AgentStatus
  const host = async (api: Parameters<typeof fakeApi>[0], settings = defaultSettings()) => {
    const dataDir = await tempDir()
    return stubHost({ appInfo: () => ({ version: '1.0.0', packaged: false, dataDir }), state: () => ({ repos: [], workspaces: [], sessions: [], settings }), api: fakeApi(api) })
  }
  const base = {
    cliStatus: async () => ({ installed: true, path: '/usr/local/bin/foreman' }),
    baseWatchSupport: async () => ({ ok: true, version: '2.45.0' }),
    whichBinary: async () => '/usr/bin/gh',
    agentCatalog: async () => ({ detections: {}, statuses: {}, acp: {}, shellKeys: {}, shellProviderKeys: [], savedProviderKeys: [] }),
    agentStatus: async (agent: string) => ready(agent)
  }

  it('reports each part and finds no problem on a healthy setup', async () => {
    const result = await doctor(await host(base), { cliVersion: '1.0.0' }, { gitVersion: async () => 'git version 2.45.0' })
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]))
    expect(byName.app).toMatchObject({ status: 'ok', detail: 'Foreman 1.0.0, protocol 2, running from source' })
    expect(byName.command).toMatchObject({ status: 'ok', detail: 'foreman 1.0.0, installed at /usr/local/bin/foreman' })
    expect(byName.git).toMatchObject({ status: 'ok', detail: 'git version 2.45.0' })
    expect(byName.gh).toMatchObject({ status: 'ok', detail: '/usr/bin/gh' })
    // The four Full agents start enabled.
    for (const agent of ['claude', 'codex', 'cursor', 'opencode']) expect(byName[agent]).toMatchObject({ status: 'ok' })
    expect(byName['data folder']).toMatchObject({ status: 'ok' })
    expect(result.items.filter((i) => i.status === 'problem')).toEqual([])
  })

  it('calls a missing git, an agent that isn’t installed or signed in, and an unwritable data folder problems', async () => {
    const h = await host({
      ...base,
      agentStatus: async (agent: string) => (agent === 'claude' ? ({ agent, installed: false, ready: false } as AgentStatus) : agent === 'codex' ? ({ agent, installed: true, ready: false } as AgentStatus) : ready(agent))
    })
    const result = await doctor({ ...h, appInfo: () => ({ version: '1.0.0', packaged: true, dataDir: `${h.appInfo().dataDir}/missing/folder` }) }, undefined, { gitVersion: async () => null })
    const problems = Object.fromEntries(result.items.filter((i) => i.status === 'problem').map((i) => [i.name, i]))
    expect(Object.keys(problems).sort()).toEqual(['claude', 'codex', 'data folder', 'git'])
    expect(problems.claude.detail).toContain('not installed')
    expect(problems.codex.detail).toContain('not signed in')
    expect(problems.git.fix).toContain('Install git')
    expect(problems.claude.fix).toBeTruthy()
  })

  it('makes a missing command, a missing gh and an old git notes, not problems', async () => {
    const result = await doctor(await host({ ...base, cliStatus: async () => ({ installed: false, path: null }), whichBinary: async () => null, baseWatchSupport: async () => ({ ok: false, version: '2.30.0' }) }), { cliVersion: '1.0.0' }, { gitVersion: async () => 'git version 2.30.0' })
    const notes = result.items.filter((i) => i.status === 'note').map((i) => i.name)
    expect(notes).toEqual(['command', 'git merge-tree', 'gh'])
    expect(result.items.some((i) => i.status === 'problem')).toBe(false)
  })

  it('keeps going when a check itself fails', async () => {
    const result = await doctor(await host({ ...base, cliStatus: async () => Promise.reject(new Error('boom')), agentStatus: async () => Promise.reject(new Error('no status')) }), undefined, { gitVersion: async () => 'git version 2.45.0' })
    expect(result.items.find((i) => i.name === 'claude')).toMatchObject({ status: 'problem', detail: expect.stringContaining('no status') })
    expect(result.items.find((i) => i.name === 'command')?.status).toBe('note')
  })

  it('says when the command and the app differ', async () => {
    const result = await doctor(await host(base), { cliVersion: '0.9.0' }, { gitVersion: async () => 'git version 2.45.0' })
    expect(result.items.find((i) => i.name === 'command')).toMatchObject({ status: 'note', detail: expect.stringContaining('the app is 1.0.0') })
  })

  it('is a read-tier method over the socket', async () => {
    const h = await host(base)
    const reply = await handleRequest(h, { v: 2, method: 'doctor', params: { cliVersion: '1.0.0' } })
    expect(reply.ok).toBe(true)
  })
})

describe('output', () => {
  it('lines up columns, padding all but the last', () => {
    expect(columns([['a', 'one', 'x'], ['bbb', 'two', 'y z']])).toBe('a    one  x\nbbb  two  y z')
    expect(columns([['k', '']])).toBe('k')
  })

  it('wants JSON for --json or FOREMAN_JSON=1', () => {
    expect(wantsJson(true, {})).toBe(true)
    expect(wantsJson(undefined, { FOREMAN_JSON: '1' })).toBe(true)
    expect(wantsJson(undefined, { FOREMAN_JSON: '0' })).toBe(false)
  })

  it('confirms with --yes, asks a terminal, and refuses a script', async () => {
    expect(await confirm('Delete?', { yes: true, interactive: false })).toBe(true)
    const asked: string[] = []
    expect(await confirm('Delete?', { interactive: true, ask: async (q) => (asked.push(q), 'y') })).toBe(true)
    expect(asked).toEqual(['Delete? [y/N] '])
    expect(await confirm('Delete?', { interactive: true, ask: async () => 'n' })).toBe(false)
    expect(await confirm('Delete?', { interactive: true, ask: async () => '' })).toBe(false)
    const refused = (await confirm('Delete?', { interactive: false }).catch((err: unknown) => err)) as CliError
    expect(refused).toMatchObject({ message: 'this needs confirmation; run it in a terminal or add --yes', exitCode: 6, code: 'needs-confirmation' })
  })
})

describe('completion scripts', () => {
  const tops = [...new Set(visibleCommands().map((c) => c.path[0]))]

  it('mention every top-level command, and not the hidden bridge', () => {
    expect(tops).toContain('run')
    expect(tops).toContain('cli')
    for (const shell of SHELLS) {
      const script = completionScript(shell)!
      for (const top of tops) expect(script, `${shell} ${top}`).toContain(top)
      expect(script, shell).not.toContain('mcp-bridge')
    }
    expect(completionScript('tcsh')).toBeUndefined()
  })

  it('mention each command’s options and the subcommands of a noun', () => {
    for (const shell of SHELLS) {
      const script = completionScript(shell)!
      // fish spells a long option `-l name`; the others spell it out.
      for (const flag of ['--repo', '--loadout', '--dry-run', '--timeout', '--tool-output', '--json', '--help']) expect(script, `${shell} ${flag}`).toContain(shell === 'fish' ? flag.replace('--', '-l ') : flag)
      for (const word of ['install', 'bash', 'zsh', 'fish', 'pwsh', 'exit-codes', 'needs-input']) expect(script, `${shell} ${word}`).toContain(word)
    }
  })

  it('names the shell’s own mechanism', () => {
    expect(completionScript('bash')).toContain('complete -F _foreman foreman')
    expect(completionScript('zsh')).toContain('compdef _foreman foreman')
    expect(completionScript('fish')).toContain('complete -c foreman')
    expect(completionScript('pwsh')).toContain('Register-ArgumentCompleter -Native -CommandName foreman')
  })

  it('is valid bash, when bash is here to check', () => {
    const checked = spawnSync('bash', ['-n'], { input: completionScript('bash'), encoding: 'utf8' })
    if (checked.error) return
    expect(checked.stderr).toBe('')
    expect(checked.status).toBe(0)
  })
})

describe('the version', () => {
  it('is the package’s', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(CLI_VERSION).toBe(pkg.version)
  })
})
