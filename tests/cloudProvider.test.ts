// The fake sandbox provider (src/main/cloud/fakeProvider.ts) behaves the way the cloud design
// depends on Vercel Sandbox behaving: real files and git, stop and resume keeping the files,
// sessions that time out, fork as a copy, tags, delete, plan limits and detached commands.
import { describe, expect, it } from 'vitest'
import { FakeProvider, type FakeSandbox } from '../src/main/cloud/fakeProvider'
import { SandboxNotRunningError } from '../src/main/cloud/provider'
import { planLimits } from '../src/shared/cloud'
import { makeRepo, tempDir } from './helpers'
import { describeProviderConformance } from './providerConformance'

const MIN = 60_000

async function rig(limits = planLimits('hobby')) {
  let now = Date.parse('2026-10-23T10:00:00Z')
  const provider = new FakeProvider(await tempDir('foreman-fake-sb-'), { limits, clock: () => now })
  const upstream = await makeRepo({ 'README.md': 'hello\n', 'a.txt': 'a\n' })
  return { provider, upstream, advance: (ms: number) => (now += ms), now: () => now }
}

const base = (name: string, url?: string) => ({ name, vcpus: 2, region: 'iad1', timeoutMs: 45 * MIN, tags: { app: 'foreman', repo: 'r1' }, ...(url ? { source: { type: 'git' as const, url, depth: 1 } } : {}) })

describe('fake sandbox provider', () => {
  it('clones a git source into /vercel/sandbox and runs real git there, in sandbox paths', async () => {
    const { provider, upstream } = await rig()
    const sb = await provider.create(base('foreman-base-r1', upstream))
    expect((await sb.readFile('/vercel/sandbox/README.md'))?.toString()).toBe('hello\n')
    const top = await sb.exec('git', ['rev-parse', '--show-toplevel'], { cwd: '/vercel/sandbox' })
    expect(top.code).toBe(0)
    // Output speaks of the sandbox's paths, never this computer's.
    expect(top.stdout.trim()).toBe('/vercel/sandbox')
    expect(await sb.exists('/vercel/sandbox/a.txt')).toBe(true)
    expect(await sb.readFile('/vercel/sandbox/nope.txt')).toBeNull()
  })

  it('stops keeping the files, refuses commands while stopped, and a command that asks to wake it resumes a fresh session', async () => {
    const { provider, upstream } = await rig()
    const sb = (await provider.create(base('ws', upstream))) as FakeSandbox
    await sb.writeFile('/vercel/sandbox/work.txt', 'uncommitted\n')
    const receipt = await sb.stop()
    expect(receipt.snapshotId).toMatch(/^snap_ws_/)
    expect(receipt.activeCpuMs).toBe(1000)
    expect(await sb.status()).toBe('stopped')
    expect(await sb.session()).toEqual({ status: 'stopped' })
    // Stopping again is a no-op with no receipt.
    expect(await sb.stop()).toEqual({})
    // Nothing but a woken exec resumes it (a read must never start a billed session).
    await expect(sb.exec('git', ['status'], { cwd: '/vercel/sandbox' })).rejects.toBeInstanceOf(SandboxNotRunningError)
    await expect(sb.readFile('/vercel/sandbox/work.txt')).rejects.toBeInstanceOf(SandboxNotRunningError)
    await expect(sb.writeFiles([{ path: '/vercel/x', data: 'x' }])).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(sb.resumes).toBe(0)
    const r = await sb.exec('git', ['status', '--porcelain'], { cwd: '/vercel/sandbox', wake: true })
    expect(r.stdout).toContain('work.txt')
    expect(sb.resumes).toBe(1)
    expect(await sb.status()).toBe('running')
    expect(provider.callsOf('resume')).toHaveLength(1)
  })

  it('times a session out at its end, and extends it on request', async () => {
    const { provider, advance, now } = await rig()
    const sb = (await provider.create(base('ws'))) as FakeSandbox
    expect((await sb.session()).expiresAt?.getTime()).toBe(now() + 45 * MIN)
    await sb.extendTimeout(10 * MIN)
    expect((await sb.session()).expiresAt?.getTime()).toBe(now() + 55 * MIN)
    advance(56 * MIN)
    expect(await sb.status()).toBe('stopped')
    expect(sb.timeouts).toBe(1)
    await expect(sb.extendTimeout(MIN)).rejects.toThrow(/isn’t running/)
    // A woken command brings it back, with a full session again; one fetch says when it started and ends.
    await sb.exec('true', [], { wake: true })
    expect(await sb.session()).toEqual({ status: 'running', expiresAt: new Date(now() + 45 * MIN), startedAt: new Date(now()) })
  })

  it('forks by copying, lists by tag, deletes, and reports the limits it was given', async () => {
    const { provider, upstream } = await rig(planLimits('pro'))
    const source = await provider.create(base('foreman-base-r1', upstream))
    await source.writeFile('/vercel/sandbox/built.txt', 'yes\n')
    const fork = await provider.fork('foreman-base-r1', { name: 'foreman-ws-1', timeoutMs: 2 * 60 * MIN, tags: { app: 'foreman', workspace: '1' } })
    expect((await fork.readFile('/vercel/sandbox/built.txt'))?.toString()).toBe('yes\n')
    await fork.writeFile('/vercel/sandbox/only-fork.txt', 'x')
    expect(await source.exists('/vercel/sandbox/only-fork.txt')).toBe(false)
    expect((await provider.list({ app: 'foreman' })).map((s) => s.name).sort()).toEqual(['foreman-base-r1', 'foreman-ws-1'])
    expect((await provider.list({ workspace: '1' })).map((s) => s.name)).toEqual(['foreman-ws-1'])
    await fork.delete({ snapshots: true })
    expect(await provider.get('foreman-ws-1')).toBeNull()
    expect(provider.callsOf('delete')[0].detail).toEqual({ snapshots: true })
    await expect(fork.exec('true', [])).rejects.toThrow(/no longer exists/)
    expect(provider.limits()).toEqual({ maxSessionMs: 24 * 60 * MIN, maxVcpus: 8, maxConcurrent: 10_000 })
    provider.planLimits = planLimits('hobby')
    expect(provider.limits().maxVcpus).toBe(4)
  })

  it('stubs gh, refuses other unknown commands, and can fail the next call', async () => {
    const { provider } = await rig()
    const sb = await provider.create(base('ws'))
    expect((await sb.exec('gh', ['auth', 'setup-git'], { env: { GH_TOKEN: 'gho_x' } })).code).toBe(0)
    expect(provider.callsOf('exec').find((c) => c.cmd === 'gh')?.env).toEqual({ GH_TOKEN: 'gho_x' })
    expect((await sb.exec('docker', ['ps'])).code).toBe(127)
    provider.failNext('exec', new Error('network down'))
    await expect(sb.exec('true', [])).rejects.toThrow('network down')
    expect((await sb.exec('true', [])).code).toBe(0)
  })

  it('runs bash with sandbox paths mapped, streaming output', async () => {
    const { provider } = await rig()
    const sb = await provider.create(base('ws'))
    await sb.mkdir('/vercel/sandbox/repo')
    const chunks: string[] = []
    const r = await sb.exec('bash', ['-lc', 'set -euo pipefail\necho "in $PWD"\necho made > /vercel/sandbox/repo/out.txt\nexit 3'], { cwd: '/vercel/sandbox/repo', onOutput: (c) => chunks.push(c) })
    expect(r.code).toBe(3)
    expect(chunks.join('')).toContain('in ')
    expect((await sb.readFile('/vercel/sandbox/repo/out.txt'))?.toString().trim()).toBe('made')
  })

  it('keeps a detached command with stdin open, and replays its logs to a re-attach', async () => {
    const { provider } = await rig()
    const sb = await provider.create(base('ws'))
    const echo = 'process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>process.stdout.write("got:"+d));process.stdin.on("end",()=>process.exit(0))'
    const cmd = await sb.spawn('node', ['-e', echo], { stdin: true })
    await cmd.write('one\n')
    await cmd.closeStdin()
    expect(await cmd.wait()).toEqual({ code: 0 })
    const again = await sb.attachCommand(cmd.cmdId)
    let out = ''
    for await (const line of again.logs()) out += line.data
    expect(out).toBe('got:one\n')
  })
})

// The provider contract (tests/providerConformance.ts) against the fake, as Vercel (fork, base, session cap), as a
// provider with bases but no fork or cap (Docker's shape), and as one with neither (E2B's and Daytona's defaults).
describeProviderConformance('Fake (Vercel’s capabilities)', async () => new FakeProvider(await tempDir('foreman-conf-')), { id: 'vercel', realPty: false, host: false, agentClis: false })
describeProviderConformance('Fake (a base, no fork, no session cap)', async () => new FakeProvider(await tempDir('foreman-conf-'), { capabilities: { fork: false, base: true, sessionCap: false, regions: [], vcpuOptions: [1, 2, 4] } }), { realPty: false, host: false, agentClis: false })
describeProviderConformance('Fake (no base, no fork)', async () => new FakeProvider(await tempDir('foreman-conf-'), { capabilities: { fork: false, base: false, sessionCap: true } }), { realPty: false, host: false, agentClis: false })
