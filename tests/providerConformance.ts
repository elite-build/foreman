// The sandbox provider contract (src/main/cloud/provider.ts), as a suite any provider runs: the fake in
// tests/cloudProvider.test.ts, and each real one in tests/<provider>.integration.test.ts (skipped without
// its credentials). Each case says which part of SandboxManager depends on it. Cases that depend on a
// capability (fork, base, sessionCap, pty, snapshotOnStop) run only when the provider claims it, and check
// that the claim holds. Every sandbox the suite makes is named `<prefix>-<run>-…`, tagged app=foreman
// role=conformance run=<run>, and deleted at the end, whatever happened.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lineReader, PROTOCOL_VERSION } from '../src/main/agentHost/protocol'
import { readHostBundle } from '../src/main/agentHost/sandboxPackage'
import { SandboxNotRunningError, type PtyStart, type SandboxHandle, type SandboxProvider, type SpawnedRemote } from '../src/main/cloud/provider'
import { commandDuplex } from '../src/main/cloud/turnHost'
import { CLOUD_HOST_DIR, CLOUD_HOST_SOCKET, CLOUD_HOST_STATE_DIR, CLOUD_SANDBOX_ROOT, type CloudProviderId } from '../src/shared/cloud'

export interface ConformanceOptions {
  // Skip the whole suite (a real provider without credentials), with the reason in the test name.
  skip?: boolean | string
  // The id the provider must report.
  id?: CloudProviderId
  // Sandbox names start with this (default foreman-conf).
  prefix?: string
  // The size to ask for; default the provider's smallest vcpuOption.
  vcpus?: number
  // The region to ask for; default the provider's first region ('' without regions).
  region?: string
  // Each case's timeout (default 30 s; real providers want minutes).
  timeoutMs?: number
  // How long to wait for a status change (a stop that is still `stopping`), default 60 s.
  settleMs?: number
  // The PTY runs a real shell (the fake only echoes): `stty size` after a resize is checked.
  realPty?: boolean
  // npm, claude and codex are on the PATH (the fake has none of them). Default on.
  agentClis?: boolean
  // Upload Foreman's agent host (out/main, from `npm run build`), npm install it, and round-trip `hello` through the
  // attach bridge, as CloudTurnHost does. Default: on for real providers; skipped with a warning when out/main has no bundle.
  host?: boolean
}

const OUT = path.resolve(__dirname, '..', 'out', 'main')
const MIN = 60_000

async function until<T>(what: string, ms: number, poll: () => T | undefined | Promise<T | undefined>, everyMs = 100): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() - started > ms) throw new Error(`Timed out after ${ms} ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

async function collect(cmd: SpawnedRemote): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  for await (const line of cmd.logs()) {
    if (line.stream === 'stdout') stdout += line.data
    else stderr += line.data
  }
  return { stdout, stderr }
}

/** The host's `{"ready":true}` line on stdout, or its stderr when it exits first. */
async function hostReady(cmd: SpawnedRemote): Promise<string> {
  let out = ''
  let err = ''
  for await (const line of cmd.logs()) {
    if (line.stream === 'stderr') err += line.data
    else out += line.data
    if (out.split('\n').some((l) => l.includes('"ready":true'))) return out
  }
  throw new Error(`the host exited before it was ready: ${err.trim() || out.trim() || 'no output'}`)
}

// A node script that echoes each line of stdin back as "got:<line>" and exits 0 when stdin closes.
const ECHO = 'require("readline").createInterface({input:process.stdin}).on("line",(l)=>process.stdout.write("got:"+l+"\\n")).on("close",()=>process.exit(0))'

/**
 * The contract, against the provider `makeProvider` returns. Cases run in order and share one sandbox (`main`), as a
 * workspace's life does: made, used, stopped, woken, deleted.
 */
export function describeProviderConformance(name: string, makeProvider: () => SandboxProvider | Promise<SandboxProvider>, opts: ConformanceOptions = {}): void {
  const skip = Boolean(opts.skip)
  const title = typeof opts.skip === 'string' ? `${name} provider conformance (skipped: ${opts.skip})` : `${name} provider conformance`
  const timeout = opts.timeoutMs ?? 30_000
  const settle = opts.settleMs ?? 60_000

  describe.skipIf(skip)(title, () => {
    const run = randomBytes(4).toString('hex')
    const prefix = `${opts.prefix ?? 'foreman-conf'}-${run}`
    const tags = { app: 'foreman', role: 'conformance', run }
    const made = new Set<string>()
    let provider: SandboxProvider
    let main: SandboxHandle
    let createOpts: { vcpus: number; region: string; timeoutMs: number }

    const create = async (suffix: string): Promise<SandboxHandle> => {
      const sandboxName = `${prefix}-${suffix}`
      made.add(sandboxName)
      return provider.create({ name: sandboxName, ...createOpts, tags: { ...tags, sandbox: suffix } })
    }
    const stopped = (handle: SandboxHandle) => until(`${handle.name} to report stopped`, settle, async () => ((await handle.status()) === 'stopped' ? true : undefined), 500)

    beforeAll(async () => {
      provider = await makeProvider()
      const caps = provider.capabilities()
      createOpts = { vcpus: opts.vcpus ?? caps.vcpuOptions[0] ?? 2, region: opts.region ?? caps.regions[0] ?? '', timeoutMs: 20 * MIN }
    }, timeout)

    afterAll(async () => {
      // Whatever happened: nothing the suite made is left behind (bases' snapshots too).
      for (const sandboxName of made) {
        const handle = await provider?.get(sandboxName).catch(() => null)
        if (handle) await handle.delete({ snapshots: true }).catch((err: unknown) => console.warn(`[conformance] couldn't delete ${sandboxName}; delete it by hand.`, err))
      }
    }, Math.max(timeout, 5 * MIN))

    it('reports its id, capabilities and limits without touching the network (the manager reads them for the window)', () => {
      if (opts.id) expect(provider.id).toBe(opts.id)
      const caps = provider.capabilities()
      for (const key of ['fork', 'base', 'snapshotOnStop', 'sessionCap', 'pty', 'billed'] as const) expect(typeof caps[key], `capabilities().${key}`).toBe('boolean')
      expect(Array.isArray(caps.regions)).toBe(true)
      expect(caps.vcpuOptions.length, 'capabilities().vcpuOptions offers at least one size').toBeGreaterThan(0)
      expect(caps.vcpuOptions.every((v) => Number.isInteger(v) && v > 0)).toBe(true)
      // fork without base would leave the manager nothing to start a workspace from.
      if (caps.fork) expect(caps.base, 'a provider that forks keeps bases too (createFromBase may be the fork)').toBe(true)
      if (caps.base) expect(typeof provider.createFromBase, 'capabilities().base needs createFromBase').toBe('function')
      if (caps.fork) expect(typeof provider.fork, 'capabilities().fork needs fork').toBe('function')
      const limits = provider.limits()
      expect(limits.maxSessionMs).toBeGreaterThan(0)
      expect(limits.maxVcpus).toBeGreaterThan(0)
      expect(limits.maxConcurrent).toBeGreaterThan(0)
      // Plain data: it crosses IPC to the window.
      expect(JSON.parse(JSON.stringify({ caps, limits }))).toEqual({ caps, limits })
    })

    it('creates a named, tagged sandbox that is running and can be fetched and listed by one tag (create, get, list)', async () => {
      main = await create('main')
      expect(main.name).toBe(`${prefix}-main`)
      expect(await main.status()).toMatch(/^(pending|running)$/)
      await until('the new sandbox to be running', settle, async () => ((await main.status()) === 'running' ? true : undefined), 500)
      const fetched = await provider.get(main.name)
      expect(fetched?.name).toBe(main.name)
      expect(await provider.get(`${prefix}-never-made`)).toBeNull()
      const listed = await provider.list({ run })
      const mine = listed.find((s) => s.name === main.name)
      expect(mine, 'list({ run }) finds the sandbox by one of its tags').toBeDefined()
      expect(mine?.tags).toMatchObject(tags)
      expect(await provider.list({ run: `not-${run}` })).toEqual([])
    }, timeout)

    it('has the layout and tools Foreman uses: /vercel/sandbox writable, bash, git and node (CLONE_REPO, the host, setup steps)', async () => {
      expect(await main.exists(CLOUD_SANDBOX_ROOT), `${CLOUD_SANDBOX_ROOT} exists`).toBe(true)
      await main.mkdir(`${CLOUD_HOST_DIR}/conformance`)
      expect(await main.exists(`${CLOUD_HOST_DIR}/conformance`), `${CLOUD_HOST_DIR} can be made`).toBe(true)
      for (const [cmd, args] of [
        ['git', ['--version']],
        ['node', ['--version']],
        ['bash', ['-lc', 'echo ok']]
      ] as const) {
        const r = await main.exec(cmd, [...args])
        expect(r.code, `${cmd} ${args.join(' ')} exits 0 (stderr: ${r.stderr})`).toBe(0)
      }
      // The agents the host drives (claude, codex) and npm for the host's packages: in the image, or installed by create().
      if (opts.agentClis !== false) {
        for (const cmd of ['npm', 'claude', 'codex']) {
          const r = await main.exec(cmd, ['--version'])
          expect(r.code, `${cmd} --version exits 0: the sandbox's image must ship it (stderr: ${r.stderr})`).toBe(0)
        }
      }
    }, timeout)

    it('exec runs to the end with cwd, env, stdout, stderr, the exit code and streamed output (git, scripts)', async () => {
      const chunks: string[] = []
      const r = await main.exec('bash', ['-lc', 'echo "$FOREMAN_CONF" > cwd-probe.txt; echo "out:$FOREMAN_CONF"; echo err >&2; exit 3'], { cwd: CLOUD_SANDBOX_ROOT, env: { FOREMAN_CONF: 'bar' }, onOutput: (c) => chunks.push(c) })
      expect(r.code).toBe(3)
      expect(r.stdout).toContain('out:bar')
      expect(r.stderr).toContain('err')
      expect(chunks.join(''), 'onOutput gets stdout and stderr as they come').toMatch(/out:bar[\s\S]*err|err[\s\S]*out:bar/)
      // The relative path landed in cwd.
      expect((await main.readFile(`${CLOUD_SANDBOX_ROOT}/cwd-probe.txt`))?.toString('utf8')).toBe('bar\n')
      const quiet = await main.exec('node', ['-e', 'process.stdout.write(process.env.FOREMAN_CONF || "unset")'])
      expect(quiet.stdout, 'env goes to one command only').toBe('unset')
    }, timeout)

    it('exec stops a command when its signal aborts (stopping a script, archive steps)', async () => {
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 500)
      const r = await main.exec('bash', ['-lc', 'sleep 60'], { signal: controller.signal })
      expect(r.code).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(30_000)
    }, timeout)

    it('spawn keeps stdin open, streams logs, waits, re-attaches by cmdId and kills (the host and its attach bridge)', async () => {
      const cmd = await main.spawn('node', ['-e', ECHO], { stdin: true })
      expect(cmd.cmdId).toBeTruthy()
      await cmd.write('one\n')
      await cmd.write(new TextEncoder().encode('two\n'))
      await cmd.closeStdin()
      expect(await cmd.wait()).toEqual({ code: 0 })
      expect((await collect(cmd)).stdout).toBe('got:one\ngot:two\n')
      const again = await main.attachCommand(cmd.cmdId)
      expect(again.cmdId).toBe(cmd.cmdId)
      expect((await again.wait()).code).toBe(0)
      expect((await collect(again)).stdout, 'a re-attach replays the command’s logs').toBe('got:one\ngot:two\n')

      const forever = await main.spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdin: true })
      await forever.kill()
      const ended = await Promise.race([forever.wait(), new Promise<null>((r) => setTimeout(() => r(null), 20_000))])
      expect(ended, 'wait() settles after kill()').not.toBeNull()
    }, timeout)

    it('reads and writes files: parents made, missing is null, batches, modes, bytes (attachments, the host upload)', async () => {
      const file = '/tmp/foreman-conf/dir/hello.txt'
      await main.writeFile(file, 'hello from Foreman\n')
      expect((await main.readFile(file))?.toString('utf8')).toBe('hello from Foreman\n')
      expect(await main.exists(file)).toBe(true)
      expect(await main.readFile('/tmp/foreman-conf/missing.txt'), 'a missing file reads as null, not an error').toBeNull()
      expect(await main.exists('/tmp/foreman-conf/missing.txt')).toBe(false)
      await main.mkdir(`${CLOUD_SANDBOX_ROOT}/conformance/a/b`)
      expect(await main.exists(`${CLOUD_SANDBOX_ROOT}/conformance/a/b`)).toBe(true)
      const bytes = Buffer.from([0, 1, 2, 250, 255, 10])
      await main.writeFiles([
        { path: `${CLOUD_SANDBOX_ROOT}/conformance/batch/one.txt`, data: 'one' },
        { path: `${CLOUD_SANDBOX_ROOT}/conformance/batch/deep/bin.dat`, data: bytes },
        { path: `${CLOUD_SANDBOX_ROOT}/conformance/batch/run.sh`, data: '#!/bin/sh\necho ran\n', mode: 0o755 }
      ])
      expect((await main.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/batch/one.txt`))?.toString('utf8')).toBe('one')
      expect(Buffer.compare((await main.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/batch/deep/bin.dat`))!, bytes), 'bytes round-trip').toBe(0)
      const ran = await main.exec('bash', ['-lc', `test -x ${CLOUD_SANDBOX_ROOT}/conformance/batch/run.sh && ${CLOUD_SANDBOX_ROOT}/conformance/batch/run.sh`])
      expect(ran.stdout.trim(), 'a file’s mode is kept').toBe('ran')
      // Kept across a stop, checked after the wake below.
      await main.writeFile(`${CLOUD_SANDBOX_ROOT}/conformance/kept.txt`, 'kept\n')
    }, timeout)

    it('opens a PTY: output, input, resize, exit code, and no exit after close (remote terminals)', async () => {
      if (!provider.capabilities().pty) return
      const start: PtyStart = { command: 'bash', args: ['--norc', '-i'], cwd: CLOUD_SANDBOX_ROOT, env: { PS1: '$ ' }, cols: 80, rows: 24 }
      let output = ''
      let exited: number | null | undefined
      const pty = await main.openPty(start, { data: (d) => (output += d), exit: (code) => (exited = code) })
      pty.write('echo conformance-ok\r')
      await until('the PTY to echo', 20_000, () => (output.includes('conformance-ok') ? true : undefined))
      pty.resize(100, 30)
      if (opts.realPty !== false) {
        pty.write('stty size\r')
        await until('the shell to see 30 rows and 100 columns after resize', 20_000, () => (/30 100/.test(output) ? true : undefined))
      }
      pty.close()
      await new Promise((r) => setTimeout(r, 300))
      expect(exited, 'closing the PTY ourselves reports no exit').toBeUndefined()

      let code: number | null | undefined
      const second = await main.openPty(start, { data: () => undefined, exit: (c) => (code = c) })
      second.write('exit 3\r')
      expect(await until('the shell’s exit code', 20_000, () => code)).toBe(3)
    }, timeout)

    it('reports the running session in one fetch: status, and its end when sessions are capped (session budget, status polls)', async () => {
      const session = await main.session()
      expect(session.status).toBe('running')
      if (session.startedAt) expect(session.startedAt.getTime()).toBeLessThanOrEqual(Date.now() + MIN)
      if (provider.capabilities().sessionCap) {
        expect(session.expiresAt, 'a capped session says when it ends').toBeInstanceOf(Date)
        expect(session.expiresAt!.getTime()).toBeGreaterThan(Date.now())
      }
    }, timeout)

    it('extends a capped session (extendWhileActive), only when it claims a session cap', async () => {
      if (!provider.capabilities().sessionCap) return
      const before = (await main.session()).expiresAt!.getTime()
      await main.extendTimeout(60_000)
      const after = (await main.session()).expiresAt!.getTime()
      expect(after).toBeGreaterThanOrEqual(before + 55_000)
    }, timeout)

    it('stops: a receipt, stopped status, and every read refuses without resuming it (sleep, idle sleep, archive)', async () => {
      const receipt = await main.stop()
      expect(typeof receipt).toBe('object')
      if (receipt.activeCpuMs !== undefined) expect(receipt.activeCpuMs).toBeGreaterThanOrEqual(0)
      if (receipt.durationMs !== undefined) expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
      await stopped(main)
      expect((await main.session()).status).toBe('stopped')
      expect((await main.session()).expiresAt).toBeUndefined()
      const refusals: [string, () => Promise<unknown>][] = [
        ['exec', () => main.exec('true', [])],
        ['spawn', () => main.spawn('node', ['-e', ECHO], { stdin: true })],
        ['readFile', () => main.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/kept.txt`)],
        ['writeFile', () => main.writeFile('/tmp/foreman-conf/x.txt', 'x')],
        ['writeFiles', () => main.writeFiles([{ path: '/tmp/foreman-conf/y.txt', data: 'y' }])],
        ['mkdir', () => main.mkdir('/tmp/foreman-conf/z')],
        ['exists', () => main.exists(CLOUD_SANDBOX_ROOT)]
      ]
      if (provider.capabilities().pty) refusals.push(['openPty', () => main.openPty({ command: 'bash', args: [], cwd: CLOUD_SANDBOX_ROOT, env: {}, cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined })])
      for (const [op, call] of refusals) await expect(call(), `${op} on a stopped sandbox refuses with SandboxNotRunningError`).rejects.toBeInstanceOf(SandboxNotRunningError)
      if (provider.capabilities().sessionCap) await expect(main.extendTimeout(60_000), 'a stopped session isn’t extended into a new one').rejects.toThrow()
      expect(await main.status(), 'nothing above resumed it').toBe('stopped')
      expect(await main.stop(), 'stopping a stopped sandbox is a no-op').toBeDefined()
    }, timeout)

    it('wakes on an exec that asks to, with its files when stopping keeps them (wake)', async () => {
      const r = await main.exec('true', [], { wake: true })
      expect(r.code).toBe(0)
      await until('the woken sandbox to be running', settle, async () => ((await main.status()) === 'running' ? true : undefined), 500)
      if (provider.capabilities().snapshotOnStop) expect((await main.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/kept.txt`))?.toString('utf8')).toBe('kept\n')
      if (provider.capabilities().sessionCap) expect((await main.session()).expiresAt).toBeInstanceOf(Date)
    }, timeout)

    it('runs Foreman’s agent host and answers hello through the attach bridge (CloudTurnHost)', async () => {
      if (opts.host === false) return
      const bundle = existsSync(path.join(OUT, 'sandboxHost.js')) ? readHostBundle(OUT, 'conformance') : null
      if (!bundle) {
        console.warn(`[conformance] ${name}: out/main has no sandboxHost.js/sandboxAttach.js; run \`npm run build\` to include the host step. Skipping it.`)
        return
      }
      await main.mkdir(CLOUD_HOST_DIR)
      await main.writeFiles([...bundle.files.map((f) => ({ path: `${CLOUD_HOST_DIR}/${f.path}`, data: f.data })), { path: `${CLOUD_HOST_DIR}/package.json`, data: bundle.packageJson }])
      const install = await main.exec('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: CLOUD_HOST_DIR, timeoutMs: 10 * MIN })
      expect(install.code, `npm install of the host's pinned SDKs (stderr: ${install.stderr.slice(-800)})`).toBe(0)
      const host = await main.spawn('node', [`${CLOUD_HOST_DIR}/sandboxHost.js`, '--dir', CLOUD_HOST_STATE_DIR, '--socket', CLOUD_HOST_SOCKET], { cwd: CLOUD_HOST_DIR, stdin: true })
      await expect(hostReady(host)).resolves.toMatch(/ready/)
      const hostToken = (await main.readFile(`${CLOUD_HOST_STATE_DIR}/token`))?.toString('utf8').trim()
      expect(hostToken, 'the host writes its token in the state folder').toBeTruthy()
      const attach = await main.spawn('node', [`${CLOUD_HOST_DIR}/sandboxAttach.js`, '--socket', CLOUD_HOST_SOCKET], { cwd: CLOUD_HOST_DIR, stdin: true })
      const stream = commandDuplex(attach)
      const replies = new Map<number, { result?: unknown; error?: string }>()
      stream.on(
        'data',
        lineReader((m) => {
          const msg = m as { id?: number; result?: unknown; error?: string }
          if (typeof msg.id === 'number') replies.set(msg.id, msg)
        })
      )
      const call = async (id: number, method: string, params: unknown) => {
        stream.write(`${JSON.stringify({ id, method, params })}\n`)
        return until(`the host's answer to ${method}`, 60_000, () => replies.get(id))
      }
      expect((await call(1, 'hello', { token: hostToken, version: PROTOCOL_VERSION })).result).toEqual({ turns: [] })
      expect((await call(2, 'ping', {})).result).toEqual({ ok: true })
      // Destroying a duplex whose command still runs errors with an AbortError: expected here, not a failure.
      stream.on('error', () => undefined)
      stream.destroy()
      await host.kill().catch(() => undefined)
    }, Math.max(timeout, 15 * MIN))

    it('starts a sandbox from a stopped base with its files (createFromBase), when it keeps bases', async () => {
      const caps = provider.capabilities()
      if (!caps.base) return
      const base = await create('base')
      await base.writeFile(`${CLOUD_SANDBOX_ROOT}/conformance/base.txt`, 'from the base\n')
      await base.stop()
      await stopped(base)
      const wsName = `${prefix}-from-base`
      made.add(wsName)
      const ws = await provider.createFromBase!(base.name, { name: wsName, vcpus: createOpts.vcpus, region: createOpts.region || undefined, timeoutMs: 20 * MIN, tags: { ...tags, sandbox: 'from-base' } })
      expect(ws.name).toBe(wsName)
      await until('the new sandbox to be running', settle, async () => ((await ws.status()) === 'running' ? true : undefined), 500)
      expect((await ws.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/base.txt`))?.toString('utf8')).toBe('from the base\n')
      await ws.writeFile(`${CLOUD_SANDBOX_ROOT}/conformance/only-ws.txt`, 'x')
      expect((await provider.list({ sandbox: 'from-base' })).map((s) => s.name)).toContain(wsName)
      if (caps.fork) {
        const forkName = `${prefix}-fork`
        made.add(forkName)
        const fork = await provider.fork!(ws.name, { name: forkName, timeoutMs: 20 * MIN, tags: { ...tags, sandbox: 'fork' } })
        await until('the fork to be running', settle, async () => ((await fork.status()) === 'running' ? true : undefined), 500)
        expect((await fork.readFile(`${CLOUD_SANDBOX_ROOT}/conformance/only-ws.txt`))?.toString('utf8'), 'a fork copies the sandbox as it is').toBe('x')
      }
    }, Math.max(timeout, 10 * MIN))

    it('deletes: get is null and list no longer has it (forget, a rebuild)', async () => {
      await main.delete({ snapshots: true })
      made.delete(main.name)
      expect(await provider.get(main.name)).toBeNull()
      expect((await provider.list({ run })).map((s) => s.name)).not.toContain(main.name)
    }, timeout)
  })
}
