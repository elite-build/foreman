// The E2B provider (src/main/cloud/e2bProvider.ts) against a mocked `e2b` SDK: how Foreman's names and tags
// map to metadata, states to statuses, the refusal on a paused sandbox (and that nothing but a woken exec
// calls Sandbox.connect on one), extendTimeout's arithmetic, exec's pass-through, the PTY launch, spawn's
// replayable logs, the template build, and verifyE2b. tests/e2b.integration.test.ts checks a real account.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const e2b = vi.hoisted(() => {
  class NamedError extends Error {
    constructor(message: string, name: string, extra: Record<string, unknown> = {}) {
      super(message)
      this.name = name
      Object.assign(this, extra)
    }
  }
  const state = {
    infos: new Map<string, { sandboxId: string; state: 'running' | 'paused'; startedAt: Date; endAt: Date; metadata: Record<string, string>; cpuCount: number }>(),
    instance: null as unknown as ReturnType<typeof makeInstance>
  }
  function makeInstance(sandboxId: string) {
    return {
      sandboxId,
      commands: { run: vi.fn(), sendStdin: vi.fn(async () => undefined), closeStdin: vi.fn(async () => undefined), kill: vi.fn(async () => true), connect: vi.fn() },
      files: { read: vi.fn(), write: vi.fn(async () => []), makeDir: vi.fn(async () => true), exists: vi.fn(async () => true) },
      pty: { create: vi.fn(), sendInput: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), kill: vi.fn(async () => true) }
    }
  }
  const Sandbox = {
    create: vi.fn(async (_template: string, opts: { metadata: Record<string, string>; timeoutMs: number }) => {
      state.infos.set('sbx_1', { sandboxId: 'sbx_1', state: 'running', startedAt: new Date(), endAt: new Date(Date.now() + opts.timeoutMs), metadata: opts.metadata, cpuCount: 2 })
      state.instance = makeInstance('sbx_1')
      return state.instance
    }),
    connect: vi.fn(async (id: string) => {
      const info = state.infos.get(id)!
      info.state = 'running'
      state.instance = makeInstance(id)
      return state.instance
    }),
    getInfo: vi.fn(async (id: string) => {
      const info = state.infos.get(id)
      if (!info) throw new NamedError('not found', 'SandboxNotFoundError')
      return { ...info }
    }),
    list: vi.fn((opts: { query: { metadata: Record<string, string> } }) => {
      let done = false
      return {
        get hasNext() {
          return !done
        },
        nextItems: async () => {
          done = true
          return [...state.infos.values()].filter((i) => Object.entries(opts.query.metadata).every(([k, v]) => i.metadata[k] === v))
        }
      }
    }),
    pause: vi.fn(async (id: string) => {
      state.infos.get(id)!.state = 'paused'
      return true
    }),
    setTimeout: vi.fn(async () => undefined),
    kill: vi.fn(async (id: string) => state.infos.delete(id))
  }
  const Template = Object.assign(
    vi.fn(() => ({ fromDockerfile: vi.fn((content: string) => ({ dockerfile: content })) })),
    { exists: vi.fn(async () => true), build: vi.fn(async () => ({})) }
  )
  return { state, Sandbox, Template, NamedError, makeInstance }
})

vi.mock('e2b', () => ({ Sandbox: e2b.Sandbox, Template: e2b.Template }))

import { commandLine, createE2bProvider, LogBuffer, verifyE2b } from '../src/main/cloud/e2bProvider'
import { ptyLaunch } from '../src/main/cloud/e2bPty'
import { e2bSize, e2bTemplateName, E2B_DOCKERFILE } from '../src/main/cloud/e2bTemplate'
import { SandboxNotRunningError } from '../src/main/cloud/provider'
import { CLOUD_PROVIDERS } from '../src/shared/cloud'

const creds = { apiKey: 'e2b_test_key_1234' }
const provider = () => createE2bProvider(creds, undefined)
const tags = { app: 'foreman', repo: 'r1', workspace: 'w1' }

/** A background CommandHandle that ends with `code` after emitting `out`. */
function handle(pid: number, code: number, opts: { onStdout?: (d: string) => void; onStderr?: (d: string) => void }, out: { stdout?: string; stderr?: string } = {}) {
  let finish!: () => void
  const ended = new Promise<void>((r) => (finish = r))
  queueMicrotask(() => {
    if (out.stdout) opts.onStdout?.(out.stdout)
    if (out.stderr) opts.onStderr?.(out.stderr)
    finish()
  })
  return {
    pid,
    kill: vi.fn(async () => true),
    wait: async () => {
      await ended
      if (code !== 0) throw new e2b.NamedError('exit', 'CommandExitError', { exitCode: code, stdout: out.stdout ?? '', stderr: out.stderr ?? '' })
      return { exitCode: 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
    }
  }
}

async function created() {
  const p = provider()
  const h = await p.create({ name: 'foreman-ws-w1', vcpus: 2, region: '', timeoutMs: 20 * 60_000, tags })
  return { p, h, sb: e2b.state.instance }
}

beforeEach(() => {
  e2b.state.infos.clear()
  vi.clearAllMocks()
  e2b.Template.exists.mockResolvedValue(true)
})

describe('E2B provider', () => {
  it('claims what E2B can do and makes no network call to say so', () => {
    const p = provider()
    expect(p.id).toBe('e2b')
    expect(p.capabilities()).toEqual(CLOUD_PROVIDERS.e2b.capabilities)
    expect(p.capabilities()).toMatchObject({ base: false, fork: false, snapshotOnStop: true, sessionCap: true, pty: true, regions: [] })
    expect(p.limits()).toEqual({ maxSessionMs: 60 * 60_000, maxVcpus: 8, maxConcurrent: 20 })
    expect(CLOUD_PROVIDERS.e2b.implemented).toBe(true)
    expect(e2b.Sandbox.list).not.toHaveBeenCalled()
  })

  it('creates from the size’s template with the name and tags in metadata, pausing at its timeout, credentials explicit', async () => {
    const { h } = await created()
    expect(h.name).toBe('foreman-ws-w1')
    const [template, opts] = e2b.Sandbox.create.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(template).toBe(e2bTemplateName(2))
    expect(opts).toMatchObject({
      apiKey: creds.apiKey,
      domain: 'e2b.app',
      debug: false,
      timeoutMs: 20 * 60_000,
      metadata: { ...tags, 'foreman.name': 'foreman-ws-w1', 'foreman.timeoutMs': String(20 * 60_000) },
      lifecycle: { onTimeout: 'pause', autoResume: false }
    })
  })

  it('caps a session at the plan’s length and refuses a clone at creation', async () => {
    const p = provider()
    await p.create({ name: 'x', vcpus: 2, region: '', timeoutMs: 5 * 60 * 60_000, tags })
    expect((e2b.Sandbox.create.mock.calls[0] as unknown as [string, { timeoutMs: number }])[1].timeoutMs).toBe(60 * 60_000)
    await expect(p.create({ name: 'y', vcpus: 2, region: '', timeoutMs: 60_000, tags, source: { type: 'git', url: 'https://github.com/a/b' } })).rejects.toThrow(/clone/)
  })

  it('builds a missing template once with its size’s CPU and memory, logging the build', async () => {
    e2b.Template.exists.mockResolvedValue(false)
    const p = createE2bProvider({ apiKey: 'other_key', domain: 'e2b.example.com' }, undefined) as unknown as { ensureTemplate(v: number, log: (l: string) => void): Promise<string> }
    const lines: string[] = []
    const [a, b] = await Promise.all([p.ensureTemplate(4, (l) => lines.push(l)), p.ensureTemplate(4, () => undefined)])
    expect(a).toBe(e2bTemplateName(4))
    expect(b).toBe(a)
    expect(e2b.Template.build).toHaveBeenCalledTimes(1)
    expect(e2b.Template.build.mock.calls[0]).toEqual([{ dockerfile: E2B_DOCKERFILE }, e2bTemplateName(4), expect.objectContaining({ apiKey: 'other_key', domain: 'e2b.example.com', cpuCount: 4, memoryMB: 8192 })])
    expect(lines.join('')).toMatch(/once per size/)
    expect(e2bSize(1)).toBe(2)
    expect(e2bSize(6)).toBe(4)
    expect(e2bTemplateName(16)).toBe(e2bTemplateName(8))
  })

  it('gets and lists by metadata, running and paused, mapping paused to stopped and keeping only the tags', async () => {
    await created()
    const p = provider()
    const got = await p.get('foreman-ws-w1')
    expect(got?.name).toBe('foreman-ws-w1')
    expect(e2b.Sandbox.list.mock.calls[0][0]).toMatchObject({ apiKey: creds.apiKey, query: { metadata: { 'foreman.name': 'foreman-ws-w1' }, state: ['running', 'paused'] } })
    expect(await p.get('foreman-ws-never')).toBeNull()
    const [running] = await p.list({ workspace: 'w1' })
    expect(running).toMatchObject({ name: 'foreman-ws-w1', status: 'running', tags })
    expect(running.expiresAt).toBeInstanceOf(Date)
    e2b.state.infos.get('sbx_1')!.state = 'paused'
    const [paused] = await p.list({ workspace: 'w1' })
    expect(paused.status).toBe('stopped')
    expect(paused.expiresAt).toBeUndefined()
    expect(await got!.status()).toBe('stopped')
    expect(await got!.session()).toEqual({ status: 'stopped' })
  })

  it('refuses every call on a paused sandbox without connecting (which would resume it); only a woken exec connects', async () => {
    await created()
    e2b.state.infos.get('sbx_1')!.state = 'paused'
    const h = (await provider().get('foreman-ws-w1'))!
    for (const call of [
      () => h.exec('true', []),
      () => h.spawn('node', [], { stdin: true }),
      () => h.readFile('/x'),
      () => h.writeFiles([{ path: '/x', data: 'x' }]),
      () => h.mkdir('/x'),
      () => h.exists('/x'),
      () => h.openPty({ command: 'bash', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined }),
      () => h.extendTimeout(60_000)
    ])
      await expect(call()).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(e2b.Sandbox.connect).not.toHaveBeenCalled()
    expect(await h.stop()).toEqual({})
    expect(e2b.Sandbox.pause).not.toHaveBeenCalled()

    e2b.Sandbox.connect.mockImplementationOnce(async (id: string) => {
      e2b.state.infos.get(id)!.state = 'running'
      e2b.state.instance = e2b.makeInstance(id)
      e2b.state.instance.commands.run.mockImplementation(async (_l: string, o: object) => handle(7, 0, o))
      return e2b.state.instance
    })
    expect((await h.exec('true', [], { wake: true })).code).toBe(0)
    // Resumed with the session length it was made with.
    expect(e2b.Sandbox.connect).toHaveBeenCalledWith('sbx_1', expect.objectContaining({ apiKey: creds.apiKey, timeoutMs: 20 * 60_000 }))
    expect(await h.status()).toBe('running')
  })

  it('maps the SDK’s “sandbox not running” under a call to the refusal', async () => {
    const { h, sb } = await created()
    sb.files.exists.mockRejectedValue(new e2b.NamedError('paused', 'SandboxNotRunningError'))
    await expect(h.exists('/x')).rejects.toBeInstanceOf(SandboxNotRunningError)
    // Known paused now: the next call refuses without a request.
    await expect(h.mkdir('/y')).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(sb.files.makeDir).not.toHaveBeenCalled()
  })

  it('pauses on stop with a receipt, and extends a session by setting the time left plus the extension', async () => {
    const { h } = await created()
    const endAt = e2b.state.infos.get('sbx_1')!.endAt.getTime()
    const before = Date.now()
    await h.extendTimeout(60_000)
    const [id, ms, auth] = e2b.Sandbox.setTimeout.mock.calls[0] as unknown as [string, number, { apiKey: string }]
    expect(id).toBe('sbx_1')
    expect(ms).toBeGreaterThanOrEqual(endAt - before + 60_000 - 1000)
    expect(ms).toBeLessThanOrEqual(endAt - before + 60_000)
    expect(auth.apiKey).toBe(creds.apiKey)
    const receipt = await h.stop()
    expect(e2b.Sandbox.pause).toHaveBeenCalledWith('sbx_1', expect.objectContaining({ apiKey: creds.apiKey }))
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
    expect(receipt.vcpus).toBe(2)
    expect(await h.status()).toBe('stopped')
    await h.delete({ snapshots: true })
    expect(e2b.Sandbox.kill).toHaveBeenCalledWith('sbx_1', expect.objectContaining({ apiKey: creds.apiKey }))
  })

  it('exec quotes the command line and passes cwd, env (one command’s only), sudo and no timeout; a non-zero exit is a result', async () => {
    const { h, sb } = await created()
    sb.commands.run.mockImplementation(async (_line: string, o: { onStdout?: (d: string) => void; onStderr?: (d: string) => void }) => handle(9, 3, o, { stdout: 'out', stderr: 'err' }))
    const chunks: string[] = []
    const r = await h.exec('bash', ['-lc', "echo 'hi' $X"], { cwd: '/vercel/sandbox', env: { X: '1', DROP: undefined }, sudo: true, onOutput: (c) => chunks.push(c) })
    expect(r).toEqual({ stdout: 'out', stderr: 'err', code: 3 })
    expect(chunks.join('')).toBe('outerr')
    const [line, opts] = sb.commands.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(line).toBe(`bash -lc 'echo '\\''hi'\\'' $X'`)
    expect(opts).toMatchObject({ background: true, cwd: '/vercel/sandbox', envs: { X: '1' }, user: 'root', timeoutMs: 0 })
    expect(commandLine('git', ['commit', '-m', 'a b'])).toBe(`git commit -m 'a b'`)
  })

  it('reads a missing file as null and sets modes after a batch upload', async () => {
    const { h, sb } = await created()
    sb.files.read.mockRejectedValueOnce(new e2b.NamedError('missing', 'FileNotFoundError'))
    expect(await h.readFile('/nope')).toBeNull()
    sb.files.read.mockResolvedValueOnce(new Uint8Array([104, 105]))
    expect((await h.readFile('/yes'))?.toString('utf8')).toBe('hi')
    sb.commands.run.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await h.writeFiles([
      { path: '/a/one.txt', data: 'one' },
      { path: '/a/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }
    ])
    const [entries] = sb.files.write.mock.calls[0] as unknown as [{ path: string; data: unknown }[]]
    expect(entries.map((e) => e.path)).toEqual(['/a/one.txt', '/a/run.sh'])
    expect(Buffer.from(entries[1].data as ArrayBuffer).toString()).toBe('#!/bin/sh\n')
    expect(sb.commands.run.mock.calls[0][0]).toBe('chmod 755 /a/run.sh')
  })

  it('spawns with stdin and no timeout, and a re-attach replays the logs from the start', async () => {
    const { h, sb } = await created()
    sb.commands.run.mockImplementation(async (_l: string, o: object) => handle(42, 0, o, { stdout: 'got:one\n' }))
    const cmd = await h.spawn('node', ['-e', 'x'], { cwd: '/vercel/foreman', env: { A: 'b' }, stdin: true })
    expect(sb.commands.run.mock.calls[0][1]).toMatchObject({ background: true, stdin: true, timeoutMs: 0, cwd: '/vercel/foreman', envs: { A: 'b' } })
    expect(cmd.cmdId).toBe('42')
    await cmd.write('one\n')
    expect(sb.commands.sendStdin).toHaveBeenCalledWith(42, 'one\n')
    expect(await cmd.wait()).toEqual({ code: 0 })
    const again = await h.attachCommand('42')
    let out = ''
    for await (const line of again.logs()) out += line.data
    expect(out).toBe('got:one\n')
    expect(sb.commands.connect).not.toHaveBeenCalled()
  })

  it('opens a PTY that becomes the command through PROMPT_COMMAND and reports its exit, but not after close', async () => {
    const { h, sb } = await created()
    let onData!: (d: Uint8Array) => void
    let exit!: (code: number) => void
    sb.pty.create.mockImplementation(async (o: { onData: (d: Uint8Array) => void }) => {
      onData = o.onData
      return { pid: 5, disconnect: vi.fn(async () => undefined), wait: () => new Promise((_r, reject) => (exit = (code) => reject(new e2b.NamedError('exit', 'CommandExitError', { exitCode: code })))) }
    })
    let output = ''
    let code: number | null | undefined
    const pty = await h.openPty({ command: 'bash', args: ['--norc', '-i'], cwd: '/vercel/sandbox', env: { PS1: '$ ' }, cols: 80, rows: 24 }, { data: (d) => (output += d), exit: (c) => (code = c) })
    expect(sb.pty.create.mock.calls[0][0]).toMatchObject({ cols: 80, rows: 24, cwd: '/vercel/sandbox', timeoutMs: 0, envs: { PS1: '$ ', TERM: 'xterm-256color', PROMPT_COMMAND: 'unset PROMPT_COMMAND; exec bash --norc -i' } })
    onData(new TextEncoder().encode('$ '))
    pty.write('exit 3\r')
    pty.resize(100, 30)
    await new Promise((r) => setTimeout(r, 0))
    expect(sb.pty.sendInput).toHaveBeenCalledWith(5, new TextEncoder().encode('exit 3\r'))
    expect(sb.pty.resize).toHaveBeenCalledWith(5, { cols: 100, rows: 30 })
    exit(3)
    await new Promise((r) => setTimeout(r, 0))
    expect(output).toBe('$ ')
    expect(code).toBe(3)
    expect(ptyLaunch({ command: 'claude', args: ["it's"] })).toBe(`unset PROMPT_COMMAND; exec claude 'it'\\''s'`)
  })

  it('keeps logs replayable within a cap', async () => {
    const logs = new LogBuffer()
    logs.push('stdout', 'a')
    logs.push('stderr', 'b')
    logs.end()
    const seen: string[] = []
    for await (const l of logs.read()) seen.push(`${l.stream}:${l.data}`)
    expect(seen).toEqual(['stdout:a', 'stderr:b'])
  })
})

describe('verifyE2b', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('checks the key by listing sandboxes, names the team from its templates’ namespace, and records Hobby’s limits', async () => {
    const calls: { url: string; key: string | null }[] = []
    const doFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, key: init?.headers?.['X-API-Key'] ?? null })
      return url.endsWith('/templates') ? ok([{ names: ['e2b/base'], isDefault: true }, { names: ['acme/foreman-sandbox-1'] }]) : ok([])
    }) as unknown as typeof fetch
    const r = await verifyE2b('e2b_abcd1234', { domain: 'https://e2b.example.com/' }, doFetch)
    expect(calls[0]).toEqual({ url: 'https://api.e2b.example.com/v2/sandboxes?limit=1', key: 'e2b_abcd1234' })
    expect(r.identity).toMatchObject({ user: 'acme', org: 'acme', orgId: 'e2b.example.com/acme' })
    expect(r.e2b).toEqual({ domain: 'e2b.example.com', limits: CLOUD_PROVIDERS.e2b.limits })
  })

  it('falls back to the key as the identity when the team has no templates', async () => {
    const doFetch = (async () => ok([])) as unknown as typeof fetch
    const r = await verifyE2b('e2b_abcd1234', {}, doFetch)
    expect(r.identity.user).toBe('API key …1234')
    expect(r.identity.orgId).toMatch(/^e2b\.app\/key-[0-9a-f]{12}$/)
    expect(r.e2b.domain).toBeUndefined()
  })

  it('marks a refused key as an auth problem and an unreachable E2B as a plain error', async () => {
    await expect(verifyE2b('bad', {}, (async () => new Response('', { status: 401 })) as unknown as typeof fetch)).rejects.toMatchObject({ auth: true })
    const offline = verifyE2b('k', {}, (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch)
    await expect(offline).rejects.toThrow(/Couldn’t reach E2B/)
    await expect(offline).rejects.not.toHaveProperty('auth')
  })
})
