// The Daytona provider (src/main/cloud/daytonaProvider.ts) against a stand-in for `@daytonaio/sdk`: the calls it
// makes (labels, lifecycle settings, snapshot shapes, session commands), the state mapping, the refusal of a
// stopped sandbox, and the shell scripts it sends (run through a real shell where there is one).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  type Labels = Record<string, string>
  const httpError = (statusCode: number, message = `HTTP ${statusCode}`) => Object.assign(new Error(message), { statusCode })
  const server = {
    sandboxes: new Map<string, FakeSandbox>(),
    snapshots: new Map<string, { name: string; state: string; errorReason?: string; source?: string; cpu?: number }>(),
    clients: [] as unknown[],
    createCalls: [] as { params: Record<string, unknown>; opts: unknown }[],
    snapshotCreates: [] as { params: Record<string, unknown>; opts: unknown }[],
    snapshotDeletes: [] as string[],
    refuseSnapshots: false
  }
  let ids = 0

  class FakeSandbox {
    id = `id${String(++ids).padStart(8, '0')}`
    state = 'started'
    updatedAt = new Date(Date.now() - 60_000).toISOString()
    createdAt = new Date().toISOString()
    // What the service says; refreshData copies it (a stop made elsewhere shows up there first).
    serverState = 'started'
    refreshData = vi.fn(async () => {
      if (!server.sandboxes.has(this.name)) throw httpError(404)
      this.state = this.serverState
    })
    start = vi.fn(async () => this.set('started'))
    stop = vi.fn(async () => this.set('stopped'))
    waitUntilStarted = vi.fn(async () => this.set('started'))
    waitUntilStopped = vi.fn(async () => this.set('stopped'))
    delete = vi.fn(async () => {
      server.sandboxes.delete(this.name)
    })
    resize = vi.fn(async () => undefined)
    refreshActivity = vi.fn(async () => undefined)
    createSnapshot = vi.fn(async (name: string) => {
      if (this.serverState !== 'stopped') throw httpError(400, 'sandbox must be stopped')
      server.snapshots.set(name, { name, state: 'active', source: this.id, cpu: this.cpu })
    })
    process = {
      executeCommand: vi.fn(async (_cmd: string, _cwd?: string, _env?: Record<string, string>, _timeout?: number) => ({ exitCode: 0, result: `FOREMAN-EXEC 0\n${Buffer.from('out').toString('base64')}\n${Buffer.from('err').toString('base64')}\n` })),
      createSession: vi.fn(async (_id: string) => undefined),
      executeSessionCommand: vi.fn(async (_sid: string, _req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean }) => ({ cmdId: 'c1' })),
      sendSessionCommandInput: vi.fn(async (_sid: string, _cmdId: string, _data: string) => undefined),
      getSessionCommandLogs: vi.fn(async (_sid: string, _cmdId: string, onStdout?: (c: string) => void, onStderr?: (c: string) => void) => {
        onStdout?.('hello\n')
        onStderr?.('oops\n')
      }),
      getSessionCommand: vi.fn(async (_sid: string, cmdId: string) => ({ id: cmdId, command: '', exitCode: 3 as number | undefined })),
      deleteSession: vi.fn(async (_sid: string) => undefined),
      createPty: vi.fn()
    }
    fs = {
      downloadFile: vi.fn(async (p: string): Promise<Buffer> => {
        if (p.includes('missing')) throw new Error('file not found')
        return Buffer.from(`contents of ${p}`)
      }),
      uploadFiles: vi.fn(async (_files: { source: Buffer; destination: string }[]) => undefined)
    }
    constructor(
      public name: string,
      public labels: Labels,
      public cpu: number,
      public target: string
    ) {}
    set(state: string) {
      this.state = state
      this.serverState = state
    }
  }

  class FakeImage {
    dockerfile = ''
    static base(image: string) {
      const img = new FakeImage()
      img.dockerfile = `FROM ${image}\n`
      return img
    }
    dockerfileCommands(lines: string[]) {
      this.dockerfile += `${lines.join('\n')}\n`
      return this
    }
  }

  class FakeDaytona {
    snapshot = {
      get: vi.fn(async (name: string) => {
        const s = server.snapshots.get(name)
        if (!s) throw httpError(404)
        return s
      }),
      create: vi.fn(async (params: Record<string, unknown>, opts: { onLogs?: (c: string) => void }) => {
        server.snapshotCreates.push({ params, opts })
        if (server.refuseSnapshots) throw httpError(403, 'missing write:snapshots')
        opts.onLogs?.('Step 1/9')
        const s = { name: params.name as string, state: 'active', cpu: (params.resources as { cpu: number }).cpu }
        server.snapshots.set(s.name, s)
        return s
      }),
      activate: vi.fn(async (name: string) => {
        const s = server.snapshots.get(name)!
        s.state = 'active'
        return s
      }),
      delete: vi.fn(async (name: string) => {
        server.snapshotDeletes.push(name)
        if (!server.snapshots.delete(name)) throw httpError(404)
      }),
      list: vi.fn(async (q: { sourceSandboxId?: string }) => ({ items: [...server.snapshots.values()].filter((s) => s.source === q.sourceSandboxId), total: 0, page: 1, totalPages: 1 }))
    }
    constructor(public config: Record<string, unknown>) {
      server.clients.push(config)
    }
    async create(params: Record<string, unknown>, opts: unknown) {
      server.createCalls.push({ params, opts })
      const snap = params.snapshot ? server.snapshots.get(params.snapshot as string) : undefined
      if (params.snapshot && snap?.state !== 'active') throw httpError(400, 'snapshot not active')
      const cpu = snap?.cpu ?? (params.resources as { cpu?: number } | undefined)?.cpu ?? 1
      const sb = new FakeSandbox(params.name as string, { 'code-toolbox-language': 'python', ...(params.labels as Labels) }, cpu, (params.target as string) ?? 'us')
      server.sandboxes.set(sb.name, sb)
      return sb
    }
    async get(name: string) {
      const sb = server.sandboxes.get(name)
      if (!sb) throw httpError(404, 'Sandbox not found')
      return sb
    }
    async *list(q: { labels?: Labels }) {
      for (const sb of server.sandboxes.values()) {
        if (Object.entries(q.labels ?? {}).every(([k, v]) => sb.labels[k] === v)) yield sb
      }
    }
  }

  return { server, FakeSandbox, FakeDaytona, FakeImage, httpError }
})

vi.mock('@daytonaio/sdk', () => ({ Daytona: fake.FakeDaytona, Image: fake.FakeImage }))

import { baseSnapshotName, createDaytonaProvider, daytonaStatus, envLine, eofMarker, execScript, parseExec, sessionScript, verifyDaytona } from '../src/main/cloud/daytonaProvider'
import { daytonaSnapshotName } from '../src/main/cloud/daytonaImage'
import { connectDaytonaPty, ptyLaunch } from '../src/main/cloud/daytonaPty'
import { SandboxNotRunningError, type SandboxHandle } from '../src/main/cloud/provider'
import { CLOUD_PROVIDERS } from '../src/shared/cloud'

type Fake = InstanceType<typeof fake.FakeSandbox>
const { server } = fake

let keys = 0
// A fresh key per provider: the module keeps one client per key.
const provider = (target?: string) => createDaytonaProvider({ apiKey: `dtn_test${++keys}`, apiUrl: 'https://daytona.example/api', ...(target ? { target } : {}) }, undefined)
const createOpts = { name: 'foreman-ws-w1', vcpus: 2, region: 'us', timeoutMs: 60_000, tags: { app: 'foreman', repo: 'r1', workspace: 'w1' } }
const sandbox = (name = createOpts.name) => server.sandboxes.get(name) as Fake

beforeEach(() => {
  server.sandboxes.clear()
  server.snapshots.clear()
  server.clients.length = 0
  server.createCalls.length = 0
  server.snapshotCreates.length = 0
  server.snapshotDeletes.length = 0
  server.refuseSnapshots = false
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('Daytona provider', () => {
  it('makes no client until a call needs one, and claims bases but no fork or session cap', () => {
    const p = createDaytonaProvider({ apiKey: 'dtn_x', apiUrl: 'https://app.daytona.io/api' }, { apiUrl: 'https://app.daytona.io/api', limits: { maxSessionMs: 1, maxVcpus: 2, maxConcurrent: 3 } })
    expect(server.clients).toEqual([])
    expect(p.capabilities()).toMatchObject({ fork: false, base: true, snapshotOnStop: true, sessionCap: false, pty: true, regions: ['us', 'eu'] })
    expect(p.limits()).toEqual({ maxSessionMs: 1, maxVcpus: 2, maxConcurrent: 3 })
    expect(createDaytonaProvider({ apiKey: 'k', apiUrl: 'u' }, undefined).limits()).toEqual(CLOUD_PROVIDERS.daytona.limits)
    expect(typeof p.createFromBase).toBe('function')
    expect(CLOUD_PROVIDERS.daytona.implemented).toBe(true)
  })

  it('creates from the Foreman snapshot for the size and region, built once, with labels and auto-stop off', async () => {
    const p = provider()
    const handle = await p.create(createOpts)
    expect(handle.name).toBe('foreman-ws-w1')
    expect(server.clients).toEqual([{ apiKey: expect.stringMatching(/^dtn_test/), apiUrl: 'https://daytona.example/api', useDeprecatedPolling: true }])
    const snapshot = daytonaSnapshotName(2, 'us')
    expect(snapshot).toMatch(/^foreman-sandbox-[0-9a-f]{8}-us-2c$/)
    expect(server.snapshotCreates).toHaveLength(1)
    const made = server.snapshotCreates[0].params
    expect(made).toMatchObject({ name: snapshot, resources: { cpu: 2, memory: 4, disk: 10 }, regionId: 'us' })
    expect((made.image as { dockerfile: string }).dockerfile).toMatch(/^FROM ubuntu:24\.04\n[\s\S]*USER ubuntu[\s\S]*claude --version/)
    expect(server.createCalls[0].params).toEqual({
      name: 'foreman-ws-w1',
      snapshot,
      labels: { app: 'foreman', repo: 'r1', workspace: 'w1', 'foreman.app': 'foreman', 'foreman.name': 'foreman-ws-w1' },
      autoStopInterval: 0,
      autoDeleteInterval: -1,
      public: false,
      target: 'us'
    })
    // The second sandbox of that size starts from the same snapshot.
    await p.create({ ...createOpts, name: 'foreman-ws-w2' })
    expect(server.snapshotCreates).toHaveLength(1)
    expect(server.createCalls[1].params.snapshot).toBe(snapshot)
  })

  it('activates an inactive snapshot, and builds the image per sandbox when snapshots are refused', async () => {
    const p = provider()
    server.snapshots.set(daytonaSnapshotName(2, 'us'), { name: daytonaSnapshotName(2, 'us'), state: 'inactive', cpu: 2 })
    await p.create(createOpts)
    expect(server.snapshotCreates).toHaveLength(0)
    expect(server.createCalls[0].params.snapshot).toBe(daytonaSnapshotName(2, 'us'))

    server.refuseSnapshots = true
    await p.create({ ...createOpts, name: 'foreman-ws-w3', vcpus: 4, region: 'eu' })
    const call = server.createCalls[1]
    expect(call.params.snapshot).toBeUndefined()
    expect(call.params).toMatchObject({ resources: { cpu: 4, memory: 8, disk: 10 }, target: 'eu', autoStopInterval: 0 })
    expect((call.params.image as { dockerfile: string }).dockerfile).toContain('FROM ubuntu:24.04')
    expect(call.opts).toMatchObject({ timeout: 0, onSnapshotCreateLogs: expect.any(Function) })
  })

  it('gets by name (null when missing or being deleted) and lists by one label, hiding its own', async () => {
    const p = provider()
    await p.create(createOpts)
    await p.create({ ...createOpts, name: 'foreman-ws-w2', tags: { app: 'foreman', repo: 'r2' } })
    expect((await p.get('foreman-ws-w1'))?.name).toBe('foreman-ws-w1')
    expect(await p.get('foreman-ws-nope')).toBeNull()
    sandbox('foreman-ws-w2').state = 'destroying'
    expect(await p.get('foreman-ws-w2')).toBeNull()
    sandbox('foreman-ws-w1').state = 'archived'
    expect(await p.list({ repo: 'r1' })).toEqual([{ name: 'foreman-ws-w1', status: 'stopped', tags: { app: 'foreman', repo: 'r1', workspace: 'w1' }, createdAt: expect.any(Date) }])
    expect(await p.list({ repo: 'r2' })).toEqual([])
  })

  it('maps Daytona states to Foreman statuses', () => {
    const table: [string | undefined, string][] = [
      ['started', 'running'],
      ['creating', 'pending'],
      ['starting', 'pending'],
      ['restoring', 'pending'],
      ['pulling_snapshot', 'pending'],
      ['stopping', 'stopping'],
      ['stopped', 'stopped'],
      ['archived', 'stopped'],
      ['archiving', 'stopped'],
      ['paused', 'stopped'],
      ['snapshotting', 'snapshotting'],
      ['error', 'failed'],
      ['build_failed', 'failed'],
      ['destroyed', 'aborted'],
      [undefined, 'pending']
    ]
    for (const [state, status] of table) expect(daytonaStatus(state), String(state)).toBe(status)
  })

  it('refuses every call on a stopped sandbox without starting it; exec with wake starts it first', async () => {
    const p = provider()
    const handle = await p.create(createOpts)
    const sb = sandbox()
    sb.set('stopped')
    const calls: [string, () => Promise<unknown>][] = [
      ['exec', () => handle.exec('true', [])],
      ['spawn', () => handle.spawn('node', [], { stdin: true })],
      ['readFile', () => handle.readFile('/x')],
      ['writeFiles', () => handle.writeFiles([{ path: '/tmp/a', data: 'a' }])],
      ['mkdir', () => handle.mkdir('/tmp/b')],
      ['exists', () => handle.exists('/tmp')],
      ['openPty', () => handle.openPty({ command: 'bash', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined })],
      ['extendTimeout', () => handle.extendTimeout(1000)]
    ]
    for (const [op, call] of calls) await expect(call(), op).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(sb.start).not.toHaveBeenCalled()
    expect(sb.process.executeCommand).not.toHaveBeenCalled()
    expect(await handle.status()).toBe('stopped')
    expect(await handle.session()).toEqual({ status: 'stopped' })

    const r = await handle.exec('true', [], { wake: true })
    expect(sb.start).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ stdout: 'out', stderr: 'err', code: 0 })
  })

  it('refuses when the sandbox stopped behind its back and the call fails', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    sb.serverState = 'stopped'
    sb.fs.downloadFile.mockRejectedValueOnce(fake.httpError(502, 'bad gateway'))
    await expect(handle.readFile('/x')).rejects.toBeInstanceOf(SandboxNotRunningError)
    // A failure from a running sandbox is the failure.
    sb.serverState = 'started'
    sb.fs.downloadFile.mockRejectedValueOnce(fake.httpError(500, 'disk on fire'))
    await expect(handle.readFile('/x')).rejects.toThrow('disk on fire')
  })

  it('execs in one request with cwd, env and timeout, decoding both streams; a failed start is 127', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    sb.process.executeCommand.mockResolvedValueOnce({ exitCode: 0, result: `FOREMAN-EXEC 2\n${Buffer.from('a\nb').toString('base64')}\n${Buffer.from('é').toString('base64')}\n` })
    const r = await handle.exec('git', ['commit', '-m', "it's"], { cwd: '/vercel/sandbox/repo', env: { GH_TOKEN: 'secret', DROP: undefined }, timeoutMs: 1500 })
    expect(r).toEqual({ stdout: 'a\nb', stderr: 'é', code: 2 })
    const [script, cwd, env, timeout] = sb.process.executeCommand.mock.calls[0]
    expect(script).toContain(`'git' 'commit' '-m' 'it'\\''s' </dev/null`)
    expect(script).not.toContain('secret')
    expect([cwd, env, timeout]).toEqual(['/vercel/sandbox/repo', { GH_TOKEN: 'secret' }, 2])
    await handle.exec('apt-get', ['update'], { sudo: true })
    expect(sb.process.executeCommand.mock.calls[1][0]).toContain(`sudo -E -- 'apt-get' 'update'`)

    sb.process.executeCommand.mockResolvedValueOnce({ exitCode: -1, result: 'chdir /nope: no such file or directory' })
    expect(await handle.exec('ls', [], { cwd: '/nope' })).toEqual({ stdout: '', stderr: 'chdir /nope: no such file or directory', code: 127 })
    sb.process.executeCommand.mockRejectedValueOnce(fake.httpError(408, 'command execution timeout'))
    expect(await handle.exec('sleep', ['9'], { timeoutMs: 1000 })).toMatchObject({ code: 124 })
  })

  it('streams through a session command: env on stdin, never in the command; output, exit code, session deleted', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    const chunks: string[] = []
    const r = await handle.exec('bash', ['-lc', 'make'], { cwd: '/w', env: { GH_TOKEN: 'secret' }, onOutput: (c) => chunks.push(c) })
    expect(r).toEqual({ stdout: 'hello\n', stderr: 'oops\n', code: 3 })
    expect(chunks).toEqual(['hello\n', 'oops\n'])
    const [sid, req] = sb.process.executeSessionCommand.mock.calls[0]
    expect(sid).toMatch(/^foreman-exec-/)
    expect(req).toMatchObject({ runAsync: true, suppressInputEcho: true })
    expect(req.command).not.toContain('secret')
    expect(req.command).toContain(`cd -- '/w' || exit 1`)
    expect(sb.process.sendSessionCommandInput).toHaveBeenCalledWith(sid, 'c1', envLine({ GH_TOKEN: 'secret' }))
    expect(Buffer.from(envLine({ GH_TOKEN: 'secret' }).trim(), 'base64').toString()).toBe(`export GH_TOKEN='secret'`)
    expect(sb.process.deleteSession).toHaveBeenCalledWith(sid)
    expect(() => envLine({ 'bad name': 'x' })).toThrow(/environment variable name/)
  })

  it('kills a streamed command by deleting its session when the signal aborts', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    let endLogs: () => void = () => undefined
    sb.process.getSessionCommandLogs.mockImplementationOnce(() => new Promise<void>((resolve) => (endLogs = resolve)))
    sb.process.deleteSession.mockImplementationOnce(async () => {
      endLogs()
      return undefined
    })
    const controller = new AbortController()
    const running = handle.exec('sleep', ['60'], { signal: controller.signal })
    await vi.waitFor(() => expect(sb.process.getSessionCommandLogs).toHaveBeenCalled())
    controller.abort()
    expect(await running).toMatchObject({ code: 130 })
    expect(sb.process.deleteSession).toHaveBeenCalledTimes(1)
  })

  it('spawns in its own session with stdin sent as whole lines and closed by its marker; re-attaches by cmdId', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    const cmd = await handle.spawn('node', ['host.js'], { cwd: '/vercel/foreman', env: { K: 'v' }, stdin: true })
    const [sid, req] = sb.process.executeSessionCommand.mock.calls[0]
    expect(sid).toMatch(/^foreman-cmd-[0-9a-f]{16}$/)
    expect(cmd.cmdId).toBe(`${sid}:c1`)
    expect(req.command).toContain(sh(eofMarker(sid)))
    expect(req.command).toContain(sh(`'node' 'host.js'`))
    const input = sb.process.sendSessionCommandInput
    expect(input).toHaveBeenLastCalledWith(sid, 'c1', envLine({ K: 'v' }))
    await cmd.write('par')
    expect(input).toHaveBeenCalledTimes(1)
    await cmd.write(new TextEncoder().encode('tial\nnext'))
    expect(input).toHaveBeenLastCalledWith(sid, 'c1', 'partial\n')
    await cmd.closeStdin()
    expect(input.mock.calls.slice(-2).map((c) => c[2])).toEqual(['next', `${eofMarker(sid)}\n`])
    expect(await cmd.wait()).toEqual({ code: 3 })
    const lines = []
    for await (const line of cmd.logs()) lines.push(line)
    expect(lines).toEqual([
      { stream: 'stdout', data: 'hello\n' },
      { stream: 'stderr', data: 'oops\n' }
    ])
    const again = await handle.attachCommand(cmd.cmdId)
    expect(again.cmdId).toBe(cmd.cmdId)
    await again.kill()
    expect(sb.process.deleteSession).toHaveBeenCalledWith(sid)
    // A killed command's session is gone: it ended.
    sb.process.getSessionCommand.mockRejectedValue(fake.httpError(404))
    sb.process.getSessionCommandLogs.mockRejectedValue(fake.httpError(404))
    expect(await again.wait()).toEqual({ code: 137 })
  })

  it('reads (missing is null) and writes files: folders made, one upload, modes after', async () => {
    const handle = await provider().create(createOpts)
    const sb = sandbox()
    expect((await handle.readFile('/a.txt'))?.toString()).toBe('contents of /a.txt')
    expect(await handle.readFile('/missing.txt')).toBeNull()
    await handle.writeFiles([
      { path: '/d/one.txt', data: 'one' },
      { path: '/d/e/run.sh', data: Buffer.from('#!/bin/sh'), mode: 0o755 }
    ])
    const scripts = sb.process.executeCommand.mock.calls.map((c) => c[0])
    expect(scripts[0]).toContain(`mkdir -p -- '/d' '/d/e'`)
    expect(sb.fs.uploadFiles).toHaveBeenCalledWith([
      { source: Buffer.from('one'), destination: '/d/one.txt' },
      { source: Buffer.from('#!/bin/sh'), destination: '/d/e/run.sh' }
    ])
    expect(scripts[1]).toContain(`chmod 755 -- '/d/e/run.sh'`)
  })

  it('stops with a receipt (a stopped one is a no-op), snapshotting a Foreman base as it stops', async () => {
    const p = provider()
    const handle = await p.create(createOpts)
    const receipt = await handle.stop()
    expect(receipt.vcpus).toBe(2)
    expect(receipt.durationMs).toBeGreaterThanOrEqual(59_000)
    expect(await handle.stop()).toEqual({})
    expect(sandbox().stop).toHaveBeenCalledTimes(1)

    const base = await p.create({ ...createOpts, name: 'foreman-base-r1', tags: { app: 'foreman', repo: 'r1', role: 'base' } })
    const r = await base.stop()
    expect(r.snapshotId).toBe(baseSnapshotName(sandbox('foreman-base-r1')))
    expect(sandbox('foreman-base-r1').createSnapshot).toHaveBeenCalledWith(r.snapshotId, expect.any(Number))
  })

  it('starts a workspace from the stopped base’s cold snapshot, in the base’s region', async () => {
    const p = provider()
    const base = await p.create({ ...createOpts, name: 'foreman-conf-base', region: 'eu', tags: { app: 'foreman' } })
    await expect(p.createFromBase!('foreman-conf-base', { name: 'ws', timeoutMs: 1, tags: {} }), 'a running base can’t be cold-snapshotted').rejects.toThrow(/must be stopped/)
    await base.stop()
    const ws = await p.createFromBase!('foreman-conf-base', { name: 'foreman-ws-w9', vcpus: 4, region: 'us', timeoutMs: 1, tags: { workspace: 'w9' } })
    const snap = baseSnapshotName(sandbox('foreman-conf-base'))
    expect(sandbox('foreman-conf-base').createSnapshot).toHaveBeenCalledTimes(1)
    expect(server.createCalls.at(-1)?.params).toMatchObject({ name: 'foreman-ws-w9', snapshot: snap, target: 'eu', autoStopInterval: 0, labels: { workspace: 'w9', 'foreman.name': 'foreman-ws-w9' } })
    // Bigger than the base: asked for by a resize.
    expect(sandbox('foreman-ws-w9').resize).toHaveBeenCalledWith({ cpu: 4, memory: 8 })
    expect(ws.name).toBe('foreman-ws-w9')
    await expect(p.createFromBase!('foreman-base-gone', { name: 'x', timeoutMs: 1, tags: {} })).rejects.toThrow(/no longer exists/)

    // Deleting the base with its snapshots takes the cold snapshot too.
    const fetched = (await p.get('foreman-conf-base')) as SandboxHandle
    await fetched.delete({ snapshots: true })
    expect(server.snapshotDeletes).toContain(snap)
    expect(await p.get('foreman-conf-base')).toBeNull()
  })

  it('opens a PTY whose output starts after its marker', () => {
    const { line, marker } = ptyLaunch({ command: 'bash', args: ['-lc', "echo 'hi'"], cwd: '/', env: {}, cols: 80, rows: 24 }, 'abc')
    expect(line).toBe(`printf '\\036%s\\036' FOREMAN_PTY_abc; exec 'bash' '-lc' 'echo '\\''hi'\\'''\n`)
    expect(marker).toBe('\x1eFOREMAN_PTY_abc\x1e')
    // The echoed line never contains the marker itself.
    expect(line.includes(marker)).toBe(false)
  })

  it('drops the shell’s prompt and echo, passes the command’s output, reports its exit, and none after close', async () => {
    const make = () => {
      let onData: (d: Uint8Array) => void = () => undefined
      let exit: (r: { exitCode?: number }) => void = () => undefined
      const sent: string[] = []
      const handle = {
        sendInput: vi.fn(async (d: string | Uint8Array) => void sent.push(String(d))),
        resize: vi.fn(async () => ({})),
        wait: () => new Promise<{ exitCode?: number }>((resolve) => (exit = resolve)),
        kill: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined)
      }
      const proc = {
        createPty: vi.fn(async (o: { onData: (d: Uint8Array) => void; envs?: Record<string, string>; cwd?: string }) => {
          onData = o.onData
          return handle
        })
      }
      return { proc, handle, sent, emit: (s: string) => onData(new TextEncoder().encode(s)), exit: (code?: number) => exit({ exitCode: code }) }
    }
    const pty = make()
    let output = ''
    let exited: number | null | undefined
    const transport = await connectDaytonaPty(pty.proc, { command: 'bash', args: ['-i'], cwd: '/w', env: { A: '1' }, cols: 80, rows: 24 }, { data: (d) => (output += d), exit: (c) => (exited = c) })
    expect(pty.proc.createPty.mock.calls[0][0]).toMatchObject({ cwd: '/w', envs: { TERM: 'xterm-256color', A: '1' }, cols: 80, rows: 24 })
    const token = /FOREMAN_PTY_([0-9a-f]+)/.exec(pty.sent[0])![1]
    pty.emit(`$ ${pty.sent[0]}\x1eFOREMAN_PTY_`)
    pty.emit(`${token}\x1e$ `)
    transport.write('ls\r')
    transport.resize(100, 30)
    expect(output).toBe('$ ')
    expect(pty.handle.sendInput).toHaveBeenLastCalledWith('ls\r')
    expect(pty.handle.resize).toHaveBeenCalledWith(100, 30)
    pty.exit(3)
    await vi.waitFor(() => expect(exited).toBe(3))

    const second = make()
    let late: number | null | undefined
    const t2 = await connectDaytonaPty(second.proc, { command: 'bash', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }, { data: () => undefined, exit: (c) => (late = c) })
    t2.close()
    second.exit(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(late).toBeUndefined()
    expect(second.handle.kill).toHaveBeenCalled()
  })
})

describe('verifyDaytona', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('names the key’s organization and its limits', async () => {
    const seen: string[] = []
    const doFetch = (async (url: string, init?: RequestInit) => {
      seen.push(url)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer dtn_k')
      if (url.endsWith('/sandbox?limit=1')) return json({ items: [] })
      if (url.endsWith('/api-keys/current')) return json({ name: 'foreman', userId: 'u1', organizationId: 'o1' })
      if (url.endsWith('/organizations/o1')) return json({ id: 'o1', name: 'Acme', maxCpuPerSandbox: 4 })
      if (url.endsWith('/organizations/o1/usage')) return json({ regionUsage: [{ regionId: 'eu', totalCpuQuota: 10, maxCpuPerSandbox: 2 }] })
      return json({}, 404)
    }) as typeof fetch
    const r = await verifyDaytona('dtn_k', { apiUrl: 'https://app.daytona.io/api/', target: 'eu' }, doFetch)
    expect(r.identity).toMatchObject({ user: 'foreman', userId: 'u1', org: 'Acme', orgId: 'o1', url: 'https://app.daytona.io/api' })
    expect(r.daytona).toEqual({ apiUrl: 'https://app.daytona.io/api', target: 'eu', limits: { maxSessionMs: CLOUD_PROVIDERS.daytona.limits.maxSessionMs, maxVcpus: 2, maxConcurrent: 5 } })
    expect(seen[0]).toBe('https://app.daytona.io/api/sandbox?limit=1')
  })

  it('works with only the sandbox list (a self-hosted Daytona), refuses a bad key with auth, and reports being offline plainly', async () => {
    const listOnly = (async (url: string) => (url.includes('/sandbox') ? json({ items: [] }) : json({}, 404))) as typeof fetch
    expect((await verifyDaytona('k', {}, listOnly)).daytona).toEqual({ apiUrl: 'https://app.daytona.io/api', limits: CLOUD_PROVIDERS.daytona.limits })
    const refused = (async () => json({ message: 'Unauthorized' }, 401)) as typeof fetch
    await expect(verifyDaytona('k', {}, refused)).rejects.toMatchObject({ auth: true })
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const err = (await verifyDaytona('k', {}, offline).then(
      () => null,
      (e: unknown) => e
    )) as Error & { auth?: boolean }
    expect(err.message).toMatch(/Couldn’t reach Daytona/)
    expect(err.auth).toBeUndefined()
  })
})

// The scripts as the daemon runs them, in real POSIX shells (not on Windows, where `bash` may be WSL's). The sandbox
// is Ubuntu (GNU tools), but the scripts keep to POSIX tools and options, so macOS (BSD base64, its own pipes and
// fifos) runs them the same way and checks them too.
const SHELLS = (process.platform === 'win32' ? [process.env.FOREMAN_TEST_BASH] : [process.env.FOREMAN_TEST_BASH ?? 'bash', 'sh']).filter(
  (s): s is string => Boolean(s && spawnSync(s, ['-c', 'command -v base64 mktemp tr node >/dev/null']).status === 0)
)

describe.skipIf(!SHELLS.length)('Daytona scripts in a real shell', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'foreman-daytona-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const posix = (p: string) => p.replace(/\\/g, '/')
  const node = (code: string, ...args: string[]) => ['node', '-e', code, ...args].map(sh).join(' ')
  let scripts = 0

  // Like the daemon: the script sourced by a shell whose stdin stays open after the input unless `end`. A script that
  // hasn't ended in 10 s fails with what it printed, instead of waiting out the test's timeout.
  async function session(shell: string, script: string, input: string, o: { end?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const file = path.join(dir, `cmd${++scripts}.sh`)
    writeFileSync(file, script)
    const child = spawn(shell, ['-c', `. ${sh(posix(file))}`], { stdio: ['pipe', 'pipe', 'pipe'], env: o.env ?? process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.stdin.on('error', () => undefined)
    child.stdin.write(input)
    if (o.end) child.stdin.end()
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the script didn’t end; stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(err)}`)), 10_000)
        child.on('close', (c) => {
          clearTimeout(timer)
          resolve(c)
        })
      })
      return { code, out, err }
    } finally {
      child.kill('SIGKILL')
      child.stdin.destroy()
    }
  }

  // What the command saw: its stdin (to EOF), K and its working directory.
  const report = node('let s="";process.stdin.setEncoding("utf8").on("data",(d)=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify({s,k:process.env.K,cwd:process.cwd()}));process.exit(5)})')

  describe.each(SHELLS)('%s', (shell) => {
    it('execScript returns both streams exactly and the exit code, with stdin closed', () => {
      const cmdline = node('process.stdout.write("no newline");process.stderr.write("e\\u0000rr");process.stdin.on("data",()=>process.exit(9)).on("end",()=>process.exit(4))')
      const r = spawnSync(shell, [], { input: execScript(cmdline), encoding: 'utf8' })
      expect(parseExec(r.stdout, r.status ?? undefined), r.stderr).toEqual({ stdout: 'no newline', stderr: 'e\0rr', code: 4 })
    })

    it('execScript keeps output longer than a base64 line exact, and an empty stream empty', () => {
      const big = Array.from({ length: 2000 }, (_, i) => `${i}\tü\0\n`).join('')
      const cmdline = node('process.stdout.write(Array.from({length:2000},(_,i)=>i+"\\tü\\u0000\\n").join(""))')
      const r = spawnSync(shell, [], { input: execScript(cmdline), encoding: 'utf8' })
      expect(parseExec(r.stdout, r.status ?? undefined), r.stderr).toEqual({ stdout: big, stderr: '', code: 0 })
    })

    it('needs only the base64 options BSD base64 has: no -w, no file operand', async () => {
      // A base64 that refuses what macOS's never had, in front of the real one.
      const real = spawnSync(shell, ['-c', 'command -v base64'], { encoding: 'utf8' }).stdout.trim()
      const bin = path.join(dir, `bsd-${shell.replace(/\W/g, '')}`)
      mkdirSync(bin, { recursive: true })
      writeFileSync(path.join(bin, 'base64'), `#!/bin/sh\nfor a in "$@"; do case $a in -d|-D|--decode) ;; *) echo "base64: invalid option $a" >&2; exit 64 ;; esac; done\nexec ${sh(real)} "$@"\n`, { mode: 0o755 })
      const env = { ...process.env, PATH: `${posix(bin)}${path.delimiter}${process.env.PATH ?? ''}` }
      const r = spawnSync(shell, [], { input: execScript(node('process.stdout.write("o");process.stderr.write("e")')), encoding: 'utf8', env })
      expect(parseExec(r.stdout, r.status ?? undefined), r.stderr).toEqual({ stdout: 'o', stderr: 'e', code: 0 })
      const s = await session(shell, sessionScript(report, { env: true, stdin: 'EOF_MARK' }), `${envLine({ K: 'v' })}x\nEOF_MARK\n`, { env })
      expect(JSON.parse(s.out), s.err).toMatchObject({ s: 'x\n', k: 'v' })
    })

    it('sessionScript reads env from stdin, runs in cwd, and ends stdin at the marker though the pipe stays open', async () => {
      const cwd = path.join(dir, "it's a dir")
      mkdirSync(cwd, { recursive: true })
      const value = "it's $HOME `x`\n\"é\" \\"
      const r = await session(shell, sessionScript(report, { cwd: posix(cwd), env: true, stdin: 'EOF_MARK' }), `${envLine({ K: value })}one\ntwo\nEOF_MARK\nafter\n`)
      expect(r.code, r.err).toBe(5)
      // Only the lines before the marker; the command's own output byte for byte.
      expect(JSON.parse(r.out)).toEqual({ s: 'one\ntwo\n', k: value, cwd: realpathSync(cwd) })
    })

    it('sessionScript passes a last line without a newline when its stdin ends before any marker', async () => {
      const r = await session(shell, sessionScript(report, { stdin: 'EOF_MARK' }), 'a\nb', { end: true })
      expect(r.code, r.err).toBe(5)
      expect(JSON.parse(r.out)).toMatchObject({ s: 'a\nb' })
    })

    it('sessionScript ends with the command’s exit code, or 128+n for a signal, before any marker arrives', async () => {
      const exits = await session(shell, sessionScript(node('process.stdout.write("bye");process.exit(7)'), { stdin: 'EOF_MARK' }), 'unread\n')
      expect(exits).toMatchObject({ code: 7, out: 'bye' })
      const killed = await session(shell, sessionScript(['sh', '-c', 'kill -TERM $$'].map(sh).join(' '), { stdin: 'EOF_MARK' }), '')
      expect(killed.code, killed.err).toBe(143)
      // Without stdin, the command gets /dev/null and the env line is still read first.
      const plain = await session(shell, sessionScript(report, { env: true }), `${envLine({ K: 'k' })}never read\n`)
      expect(JSON.parse(plain.out)).toMatchObject({ s: '', k: 'k' })
    })
  })
})

function sh(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
