// The Docker provider (src/main/cloud/dockerProvider.ts) without a daemon: a stubbed docker CLI records
// every call, so these check the arguments and environment each operation sends (context vs host, labels,
// resources, exec's -w/-e/-u, stdin), status mapping, the refusal on a stopped container, the tar
// writeFiles sends and the image tag. tests/docker.integration.test.ts runs the same provider for real.
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DockerProvider,
  execArgs,
  remoteEndpoint,
  resetDockerImageCache,
  sandboxImageTag,
  SANDBOX_DOCKERFILE,
  snapshotRef,
  statusOf,
  tarFiles,
  tagsOf,
  verifyDocker,
  dockerEnv,
  type ContainerInspect,
  type DockerCallOptions,
  type DockerChild,
  type DockerCli,
  type DockerOutput
} from '../src/main/cloud/dockerProvider'
import { openDockerPty, type DockerPtyProcess } from '../src/main/cloud/dockerPty'
import { SandboxNotRunningError } from '../src/main/cloud/provider'
import { CLOUD_PROVIDERS } from '../src/shared/cloud'

interface Call {
  args: string[]
  env: Record<string, string | undefined>
  input?: Buffer | string
}

const out = (stdout: string | Buffer = '', code = 0, stderr = ''): DockerOutput => ({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr })

function container(name: string, state: Partial<ContainerInspect['State']> = {}, labels: Record<string, string> = {}): ContainerInspect {
  return {
    Id: `id-${name}`,
    Name: `/${name}`,
    Created: '2026-10-24T10:00:00Z',
    State: { Status: 'running', Running: true, StartedAt: '2026-10-24T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ...state },
    Config: { Labels: { 'foreman.name': name, ...labels } },
    HostConfig: { NanoCpus: 2e9 }
  }
}

/** A docker CLI that answers from `answer` (by the arguments after any --context) and records each call. */
function stubCli(answer: (args: string[], o: DockerCallOptions) => DockerOutput | undefined = () => undefined) {
  const calls: Call[] = []
  const started: Call[] = []
  const cli: DockerCli = {
    async run(args, o = {}) {
      calls.push({ args, env: o.env ?? {}, input: o.input })
      const rest = args[0] === '--context' ? args.slice(2) : args
      return answer(rest, o) ?? out()
    },
    start(args, o = {}) {
      started.push({ args, env: o.env ?? {} })
      const child: DockerChild = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exited: new Promise(() => undefined), kill: () => undefined }
      return child
    },
    async pty() {
      throw new Error('no pty in this stub')
    }
  }
  return { cli, calls, started }
}

/** A stub where `name` exists in `state` (inspect answers it). */
function daemon(states: Record<string, ContainerInspect>, extra?: (args: string[], o: DockerCallOptions) => DockerOutput | undefined) {
  return stubCli((args, o) => {
    if (args[0] === 'container' && args[1] === 'inspect') {
      const found = args.slice(2).map((n) => states[n]).filter(Boolean)
      return found.length ? out(JSON.stringify(found)) : out('[]', 1, `Error response from daemon: No such container: ${args[2]}`)
    }
    return extra?.(args, o)
  })
}

const provider = (cli: DockerCli, target = {}) => new DockerProvider(target, undefined, cli, 'FROM scratch\n')

beforeEach(() => resetDockerImageCache())

describe('pointing the CLI at the daemon', () => {
  it('passes --context first for a context, and keeps a DOCKER_HOST from Foreman’s environment out', async () => {
    const { cli, calls } = daemon({ ws: container('ws') })
    await provider(cli, { context: 'lan-box' }).get('ws')
    expect(calls[0].args.slice(0, 2)).toEqual(['--context', 'lan-box'])
    expect(calls[0].env).toMatchObject({ DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined })
    expect('DOCKER_HOST' in calls[0].env).toBe(true)
  })

  it('sets DOCKER_HOST in the one call’s environment for a host, never in argv', async () => {
    const { cli, calls } = daemon({ ws: container('ws') })
    await provider(cli, { host: 'ssh://me@box' }).get('ws')
    expect(calls[0].args).not.toContain('--context')
    expect(calls[0].args.join(' ')).not.toContain('ssh://')
    expect(calls[0].env.DOCKER_HOST).toBe('ssh://me@box')
    expect(process.env.DOCKER_HOST).not.toBe('ssh://me@box')
  })

  it('leaves the environment alone for the current context', async () => {
    const { cli, calls } = daemon({ ws: container('ws') })
    await provider(cli).get('ws')
    expect(calls[0].args[0]).toBe('container')
    expect(calls[0].env).toEqual({})
  })

  it('merges the CLI’s environment case-insensitively on Windows', () => {
    expect(dockerEnv({ PATH: 'x' }, { Path: 'C:\\Windows', Other: '1' }, true)).toEqual({ Other: '1', PATH: 'x' })
    expect(dockerEnv({ DOCKER_HOST: undefined }, { DOCKER_HOST: 'tcp://x', A: 'b' }, false)).toEqual({ A: 'b' })
  })
})

describe('create, get and list', () => {
  it('runs the container with its labels, CPUs, memory, init and the image built from the Dockerfile', async () => {
    const { cli, calls } = stubCli((args) => (args[0] === 'image' && args[1] === 'inspect' ? out('', 1, 'No such image') : undefined))
    const p = provider(cli)
    const chunks: string[] = []
    const handle = await p.create({ name: 'foreman-ws-1', vcpus: 4, region: '', timeoutMs: 1, tags: { app: 'foreman', workspace: '1' }, onOutput: (c) => chunks.push(c) })
    expect(handle.name).toBe('foreman-ws-1')
    const build = calls.find((c) => c.args[0] === 'build')!
    expect(build.args).toEqual(['build', '--progress=plain', '-t', sandboxImageTag('FROM scratch\n'), '-'])
    expect(build.input).toBe('FROM scratch\n')
    expect(chunks.join('')).toContain('Building Foreman’s sandbox image')
    const run = calls.find((c) => c.args[0] === 'run')!.args
    expect(run.slice(0, 4)).toEqual(['run', '-d', '--name', 'foreman-ws-1'])
    expect(run).toEqual(expect.arrayContaining(['--label', 'foreman.name=foreman-ws-1', 'foreman.tag.app=foreman', 'foreman.tag.workspace=1', 'foreman.vcpus=4']))
    expect(run[run.indexOf('--cpus') + 1]).toBe('4')
    expect(run[run.indexOf('--memory') + 1]).toBe('8g')
    expect(run).toContain('--init')
    expect(run.slice(-3)).toEqual([sandboxImageTag('FROM scratch\n'), 'sleep', 'infinity'])
  })

  it('builds the image once per daemon, and not at all when it is there', async () => {
    const { cli, calls } = stubCli()
    const p = provider(cli)
    await p.create({ name: 'a', vcpus: 1, region: '', timeoutMs: 1, tags: {} })
    await p.create({ name: 'b', vcpus: 1, region: '', timeoutMs: 1, tags: {} })
    expect(calls.filter((c) => c.args[0] === 'build')).toHaveLength(0)
    expect(calls.filter((c) => c.args[0] === 'image' && c.args[1] === 'inspect')).toHaveLength(1)
  })

  it('caps the size at the daemon’s CPUs and refuses a source', async () => {
    const { cli, calls } = stubCli()
    const p = new DockerProvider({}, { limits: { maxVcpus: 2, maxConcurrent: 10, maxSessionMs: 1 } }, cli, 'FROM scratch\n')
    await p.create({ name: 'a', vcpus: 8, region: '', timeoutMs: 1, tags: {} })
    const run = calls.find((c) => c.args[0] === 'run')!.args
    expect(run[run.indexOf('--cpus') + 1]).toBe('2')
    await expect(p.create({ name: 'b', vcpus: 1, region: '', timeoutMs: 1, tags: {}, source: { type: 'git', url: 'https://x' } })).rejects.toThrow(/clones/)
  })

  it('get is null for a missing container; list filters on one tag and reads the labels from inspect', async () => {
    const ws = container('foreman-ws-1', {}, { 'foreman.tag.run': 'r1', 'foreman.tag.role': '' })
    const { cli, calls } = daemon({ 'foreman-ws-1': ws }, (args) => (args[0] === 'ps' ? out('foreman-ws-1\n') : undefined))
    const p = provider(cli)
    expect(await p.get('nope')).toBeNull()
    const listed = await p.list({ run: 'r1' })
    expect(calls.find((c) => c.args[0] === 'ps')!.args).toEqual(['ps', '-a', '-q', '--no-trunc', '--filter', 'label=foreman.tag.run=r1'])
    expect(listed).toEqual([{ name: 'foreman-ws-1', status: 'running', tags: { run: 'r1' }, createdAt: new Date('2026-10-24T10:00:00Z') }])
  })

  it('maps container states to statuses', () => {
    expect(statusOf({ Status: 'running', Running: true })).toBe('running')
    expect(statusOf({ Status: 'exited', Running: false })).toBe('stopped')
    expect(statusOf({ Status: 'created', Running: false })).toBe('pending')
    expect(statusOf({ Status: 'restarting', Running: true })).toBe('running')
    expect(statusOf({ Status: 'paused', Running: true, Paused: true })).toBe('stopped')
    expect(statusOf({ Status: 'dead', Running: false })).toBe('failed')
    expect(statusOf({ Status: 'removing', Running: false })).toBe('stopping')
  })

  it('reads tags back without Foreman’s own labels or blanked ones', () => {
    expect(tagsOf({ 'foreman.name': 'x', 'foreman.tag.a': '1', 'foreman.tag.b': '', other: 'y' })).toEqual({ a: '1' })
  })
})

describe('exec', () => {
  it('sends cwd as -w and env as -e NAME with the value only in the CLI’s environment', async () => {
    const { cli, calls } = daemon({ ws: container('ws') }, (args) => (args[0] === 'exec' ? out('hi\n') : undefined))
    const handle = (await provider(cli).get('ws'))!
    const r = await handle.exec('git', ['status'], { cwd: '/vercel/sandbox/repo', env: { GH_TOKEN: 'secret', HOME: '/vercel' } })
    expect(r).toEqual({ stdout: 'hi\n', stderr: '', code: 0 })
    const exec = calls.find((c) => c.args[0] === 'exec')!
    expect(exec.args).toEqual(['exec', '-w', '/vercel/sandbox/repo', '-e', 'GH_TOKEN', '-e', 'HOME=/vercel', 'ws', 'git', 'status'])
    expect(exec.args.join(' ')).not.toContain('secret')
    expect(exec.env.GH_TOKEN).toBe('secret')
  })

  it('runs sudo commands as root', () => {
    expect(execArgs('ws', 'apt-get', ['update'], { sudo: true }).args).toEqual(['exec', '-u', 'root', 'ws', 'apt-get', 'update'])
    expect(execArgs('ws', 'bash', [], { interactive: true, tty: true }).args).toEqual(['exec', '-i', '-t', 'ws', 'bash'])
  })

  it('wraps a stoppable command so its process group can be killed in the container', async () => {
    const { cli, calls } = daemon({ ws: container('ws') }, (args) => (args[0] === 'exec' ? out('', 143) : undefined))
    const handle = (await provider(cli).get('ws'))!
    const controller = new AbortController()
    controller.abort()
    const r = await handle.exec('sleep', ['60'], { signal: controller.signal })
    expect(r.code).toBe(143)
    const exec = calls.find((c) => c.args[0] === 'exec' && c.args.includes('sh'))!.args
    expect(exec.slice(0, 4)).toEqual(['exec', 'ws', 'sh', '-c'])
    expect(exec.slice(-2)).toEqual(['sleep', '60'])
    const pidFile = exec[exec.indexOf('-c') + 2]
    await new Promise((r) => setTimeout(r, 10))
    const kill = calls.find((c) => c.args.includes('-u') && c.args.includes(pidFile))!.args
    expect(kill.slice(0, 4)).toEqual(['exec', '-u', 'root', 'ws'])
    expect(kill.slice(-2)).toEqual([pidFile, 'TERM'])
  })

  it('refuses on a stopped container without starting it, and wake starts it', async () => {
    const states = { ws: container('ws', { Status: 'exited', Running: false }) }
    const { cli, calls } = daemon(states, (args) => {
      if (args[0] === 'start') {
        states.ws = container('ws')
        return out('ws\n')
      }
      return undefined
    })
    const handle = (await provider(cli).get('ws'))!
    for (const call of [() => handle.exec('true', []), () => handle.readFile('/x'), () => handle.writeFile('/x', 'x'), () => handle.mkdir('/x'), () => handle.exists('/x'), () => handle.spawn('node', [], { stdin: true })])
      await expect(call()).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(calls.some((c) => c.args[0] === 'start' || c.args[0] === 'exec')).toBe(false)
    expect((await handle.exec('true', [], { wake: true })).code).toBe(0)
    expect(calls.filter((c) => c.args[0] === 'start')).toHaveLength(1)
  })

  it('turns the daemon’s “is not running” into the refusal', async () => {
    const { cli } = daemon({ ws: container('ws') }, (args) => (args[0] === 'exec' ? out('', 1, 'Error response from daemon: container abc is not running') : undefined))
    const handle = (await provider(cli).get('ws'))!
    await expect(handle.exec('true', [])).rejects.toBeInstanceOf(SandboxNotRunningError)
  })
})

describe('files', () => {
  it('reads a missing file as null and a present one as bytes', async () => {
    const bytes = Buffer.from([0, 255, 10])
    const { cli } = daemon({ ws: container('ws') }, (args) => (args[0] === 'exec' ? (args.at(-1) === '/missing' ? out('', 44) : out(bytes)) : undefined))
    const handle = (await provider(cli).get('ws'))!
    expect(await handle.readFile('/missing')).toBeNull()
    expect(Buffer.compare((await handle.readFile('/there'))!, bytes)).toBe(0)
  })

  it('pipes writeFile and writeFiles as one tar into tar -x at /', async () => {
    const { cli, calls } = daemon({ ws: container('ws') })
    const handle = (await provider(cli).get('ws'))!
    await handle.writeFile('/vercel/foreman/run.sh', '#!/bin/sh\n', 0o755)
    const write = calls.find((c) => c.args[0] === 'exec')!
    expect(write.args).toEqual(['exec', '-i', 'ws', 'tar', '-x', '-p', '--no-same-owner', '-C', '/', '-f', '-'])
    const tar = write.input as Buffer
    expect(tar.subarray(0, 22).toString()).toBe('vercel/foreman/run.sh\0')
    expect(tar.subarray(100, 107).toString()).toBe('0000755')
    expect(tar.subarray(512, 522).toString()).toBe('#!/bin/sh\n')
  })

  it('makes a valid tar: checksums, padding, pax headers for long paths', () => {
    const long = `/vercel/${'d/'.repeat(80)}file.txt`
    const tar = tarFiles([{ path: '/a.txt', data: 'a' }, { path: long, data: Buffer.from([1, 2]) }], 0)
    expect(tar.length % 512).toBe(0)
    const sum = (h: Buffer) => [...h.subarray(0, 148), ...Buffer.from('        '), ...h.subarray(156, 512)].reduce((a, b) => a + b, 0)
    expect(parseInt(tar.subarray(148, 154).toString(), 8)).toBe(sum(tar.subarray(0, 512)))
    const pax = tar.subarray(1024, 1536)
    expect(pax[156]).toBe('x'.charCodeAt(0))
    const record = tar.subarray(1536, 1536 + parseInt(pax.subarray(124, 135).toString(), 8)).toString()
    expect(record).toBe(`${record.length} path=${long.slice(1)}\n`)
    expect(() => tarFiles([{ path: '/x/../../etc/passwd', data: '' }])).not.toThrow()
    expect(() => tarFiles([{ path: '/', data: '' }])).toThrow()
  })
})

describe('stop, bases and delete', () => {
  it('stops with a receipt, and stopping a stopped container is a no-op', async () => {
    const states = { ws: container('ws', { StartedAt: new Date(Date.now() - 60_000).toISOString() }) }
    const { cli, calls } = daemon(states, (args) => {
      if (args[0] === 'stop') states.ws = container('ws', { Status: 'exited', Running: false })
      return undefined
    })
    const handle = (await provider(cli).get('ws'))!
    const receipt = await handle.stop()
    expect(calls.find((c) => c.args[0] === 'stop')!.args).toEqual(['stop', '-t', '10', 'ws'])
    expect(receipt.vcpus).toBe(2)
    expect(receipt.durationMs).toBeGreaterThanOrEqual(59_000)
    expect(await handle.stop()).toEqual({})
    expect(await handle.session()).toEqual({ status: 'stopped' })
  })

  it('commits a base when it stops, blanking its labels, and starts workspaces from that image', async () => {
    const finished = '2026-10-24T11:00:00Z'
    const states: Record<string, ContainerInspect> = { 'foreman-base-r': container('foreman-base-r', {}, { 'foreman.tag.role': 'base', 'foreman.tag.repo': 'r' }) }
    let committed: Record<string, string> | null = null
    const { cli, calls } = daemon(states, (args) => {
      if (args[0] === 'stop') states['foreman-base-r'] = container('foreman-base-r', { Status: 'exited', Running: false, FinishedAt: finished }, { 'foreman.tag.role': 'base', 'foreman.tag.repo': 'r' })
      if (args[0] === 'commit') {
        committed = { 'foreman.finishedAt': finished }
        return out('sha256:new\n')
      }
      if (args[0] === 'image' && args[1] === 'inspect') return committed ? out(args[2] === '--format' && args[3] === '{{.Id}}' ? 'sha256:new\n' : JSON.stringify({ Id: 'sha256:new', Config: { Labels: committed } })) : out('', 1, 'No such image')
      return undefined
    })
    const p = provider(cli)
    const base = (await p.get('foreman-base-r'))!
    expect((await base.stop()).snapshotId).toBe('sha256:new')
    const commit = calls.find((c) => c.args[0] === 'commit')!.args
    expect(commit[2]).toBe('LABEL foreman.name="" foreman.tag.role="" foreman.tag.repo="" foreman.snapshotOf="foreman-base-r" foreman.finishedAt="2026-10-24T11:00:00Z"')
    expect(commit.slice(-2)).toEqual(['foreman-base-r', snapshotRef('foreman-base-r')])
    await p.createFromBase('foreman-base-r', { name: 'foreman-ws-1', timeoutMs: 1, tags: { workspace: '1' } })
    // Already saved at that stop: no second commit.
    expect(calls.filter((c) => c.args[0] === 'commit')).toHaveLength(1)
    expect(calls.find((c) => c.args[0] === 'run')!.args.slice(-3)).toEqual([snapshotRef('foreman-base-r'), 'sleep', 'infinity'])
  })

  it('delete removes the container, and with snapshots its committed images', async () => {
    const { cli, calls } = daemon({ b: container('b') }, (args) => (args[0] === 'image' && args[1] === 'ls' ? out('sha256:1\n') : undefined))
    await (await provider(cli).get('b'))!.delete({ snapshots: true })
    expect(calls.map((c) => c.args.join(' '))).toEqual(expect.arrayContaining(['rm -f b', 'image ls -q --no-trunc --filter label=foreman.snapshotOf=b', 'image rm sha256:1']))
  })

  it('the last workspace of a deleted base takes the base’s image with it', async () => {
    const ws = { ...container('ws', {}, { 'foreman.snapshotOf': 'gone-base' }), Image: 'sha256:img' }
    const { cli, calls } = daemon({ ws })
    await (await provider(cli).get('ws'))!.delete()
    expect(calls.map((c) => c.args.join(' '))).toContain('image rm sha256:img')
    const kept = daemon({ ws, 'gone-base': container('gone-base') })
    await (await provider(kept.cli).get('ws'))!.delete()
    expect(kept.calls.map((c) => c.args.join(' '))).not.toContain('image rm sha256:img')
  })
})

describe('spawn', () => {
  it('runs the command through the wrapper with stdin open and replays its logs on re-attach', async () => {
    const { cli, started } = daemon({ ws: container('ws') })
    const handle = (await provider(cli).get('ws'))!
    const cmd = await handle.spawn('node', ['host.js'], { cwd: '/vercel/foreman', env: { TOKEN: 't' }, stdin: true })
    expect(started[0].args.slice(0, 9)).toEqual(['exec', '-i', '-w', '/vercel/foreman', '-e', 'TOKEN', 'ws', 'bash', '-c'])
    expect(started[0].args.slice(-3)).toEqual([`/tmp/foreman-cmd/${cmd.cmdId}`, 'node', 'host.js'])
    expect(started[0].env.TOKEN).toBe('t')
    const again = await handle.attachCommand(cmd.cmdId)
    expect(again.cmdId).toBe(cmd.cmdId)
  })
})

describe('the image and verify', () => {
  it('tags the image by the Dockerfile’s hash', () => {
    expect(sandboxImageTag('a')).toMatch(/^foreman-sandbox:[0-9a-f]{12}$/)
    expect(sandboxImageTag('a')).not.toBe(sandboxImageTag('b'))
    expect(SANDBOX_DOCKERFILE).toContain('FROM ubuntu')
    expect(SANDBOX_DOCKERFILE).not.toContain('\r')
  })

  it('verify reads version and info, and lists contexts', async () => {
    const { cli } = stubCli((args) => {
      if (args[0] === 'version') return out(JSON.stringify({ Client: { Context: 'desktop-linux' }, Server: { Version: '29.1.3', Os: 'linux', Arch: 'amd64' } }))
      if (args[0] === 'info') return out(JSON.stringify({ NCPU: 12, OperatingSystem: 'Docker Desktop' }))
      if (args[0] === 'context') return out(`${JSON.stringify({ Name: 'desktop-linux', Current: true, DockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine' })}\n${JSON.stringify({ Name: 'box', Current: false, DockerEndpoint: 'ssh://me@box' })}\n`)
      return undefined
    })
    const checked = await verifyDocker({}, cli)
    expect(checked.identity).toMatchObject({ user: 'desktop-linux', org: 'Docker', orgId: 'default' })
    expect(checked.docker).toMatchObject({ serverVersion: '29.1.3', os: 'Docker Desktop (linux/amd64)', remote: false, limits: { maxVcpus: 12 } })
    expect(checked.contexts.map((c) => c.name)).toEqual(['desktop-linux', 'box'])
    expect((await verifyDocker({ context: 'box' }, cli)).docker).toMatchObject({ context: 'box', remote: true })
  })

  it('verify: a daemon that isn’t running is a plain error; a refused socket is an auth one', async () => {
    const down = stubCli(() => out('{"Client":{},"Server":null}', 1, 'error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'))
    const err = (await verifyDocker({}, down.cli).catch((e: unknown) => e)) as Error & { auth?: boolean }
    expect(err.message).toMatch(/isn’t running/)
    expect(err.auth).toBeUndefined()
    const denied = stubCli(() => out('', 1, 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'))
    expect(await verifyDocker({}, denied.cli).catch((e: unknown) => (e as { auth?: boolean }).auth)).toBe(true)
  })

  it('tells a remote endpoint from this computer’s', () => {
    expect(remoteEndpoint('ssh://me@box')).toBe(true)
    expect(remoteEndpoint('tcp://10.0.0.5:2376')).toBe(true)
    expect(remoteEndpoint('tcp://127.0.0.1:2375')).toBe(false)
    expect(remoteEndpoint('unix:///var/run/docker.sock')).toBe(false)
    expect(remoteEndpoint('npipe:////./pipe/docker_engine')).toBe(false)
  })

  it('claims the capabilities in CLOUD_PROVIDERS without touching the daemon', () => {
    const { cli, calls } = stubCli()
    const p = provider(cli)
    expect(p.capabilities()).toEqual(CLOUD_PROVIDERS.docker.capabilities)
    expect(p.limits()).toEqual(CLOUD_PROVIDERS.docker.limits)
    expect(calls).toHaveLength(0)
  })
})

describe('the PTY', () => {
  function fakePty() {
    let onData: (d: string) => void = () => undefined
    let onExit: (e: { exitCode: number }) => void = () => undefined
    const proc: DockerPtyProcess & { written: string[]; sizes: number[][]; killed: boolean } = {
      written: [],
      sizes: [],
      killed: false,
      onData: (l) => (onData = l),
      onExit: (l) => (onExit = l),
      write(d) {
        this.written.push(d)
      },
      resize(c, r) {
        this.sizes.push([c, r])
      },
      kill() {
        this.killed = true
      }
    }
    return { proc, data: (d: string) => onData(d), exit: (code: number) => onExit({ exitCode: code }) }
  }

  it('reports the exit code while the container runs, and null when it stopped', async () => {
    for (const [running, expected] of [
      [true, 3],
      [false, null]
    ] as const) {
      const f = fakePty()
      let got: number | null | undefined
      let seen = ''
      openDockerPty(f.proc, { data: (d) => (seen += d), exit: (c) => (got = c) }, { stillRunning: async () => running, killInContainer: async () => undefined })
      f.data('hi')
      f.exit(3)
      await new Promise((r) => setTimeout(r, 0))
      expect(seen).toBe('hi')
      expect(got).toBe(expected)
    }
  })

  it('close hangs the process up in the container, kills a client that outlasts it, and reports no exit', async () => {
    vi.useFakeTimers()
    const f = fakePty()
    let killed = false
    let got: number | null | undefined
    const pty = openDockerPty(f.proc, { data: () => undefined, exit: (c) => (got = c) }, { stillRunning: async () => true, killInContainer: async () => void (killed = true) })
    pty.write('ls\r')
    pty.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(killed).toBe(true)
    expect(f.proc.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1100)
    expect(f.proc.killed).toBe(true)
    f.exit(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.proc.written).toEqual(['ls\r'])
    expect(got).toBeUndefined()
  })

  it('on Windows, sizes the tty in the container too, holding keystrokes until it is done', async () => {
    const f = fakePty()
    const sized: number[][] = []
    let done: () => void = () => undefined
    const pty = openDockerPty(f.proc, { data: () => undefined, exit: () => undefined }, {
      stillRunning: async () => true,
      killInContainer: async () => undefined,
      resizeInContainer: (c, r) => new Promise<void>((resolve) => ((done = resolve), sized.push([c, r])))
    })
    pty.resize(100, 30)
    pty.resize(120, 40)
    pty.write('stty size\r')
    expect(f.proc.sizes).toEqual([
      [100, 30],
      [120, 40]
    ])
    expect(f.proc.written).toEqual([])
    done()
    await new Promise((r) => setTimeout(r, 0))
    done()
    await new Promise((r) => setTimeout(r, 0))
    // The first in flight, then only the latest.
    expect(sized).toEqual([
      [100, 30],
      [120, 40]
    ])
    expect(f.proc.written).toEqual(['stty size\r'])
  })
})

afterEach(() => {
  vi.useRealTimers()
})
