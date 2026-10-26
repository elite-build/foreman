// The runtime seam: git, scripts and setup steps run the same
// through a cloud runtime (against the fake sandbox) as in a folder here.
import { describe, expect, it } from 'vitest'
import { FakeProvider } from '../src/main/cloud/fakeProvider'
import { git, GitError, gitOut, revParse, baseStartPoint } from '../src/main/git'
import { cloudRuntime, runtimeFor } from '../src/main/runtime'
import { runScript } from '../src/main/scripts'
import { runSetupSteps } from '../src/main/setupSteps'
import type { Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

async function rig() {
  const provider = new FakeProvider(await tempDir('foreman-fake-rt-'))
  const upstream = await makeRepo({ 'README.md': 'hello\n', 'a.txt': 'one\n' })
  const sb = await provider.create({ name: 'foreman-ws-1', vcpus: 2, region: 'iad1', timeoutMs: 45 * 60_000, tags: { app: 'foreman' }, source: { type: 'git', url: upstream } })
  const rt = cloudRuntime(async () => sb, '/vercel/sandbox')
  return { provider, sb, rt, upstream }
}

describe('cloud runtime', () => {
  it('reads and writes files relative to the sandbox worktree', async () => {
    const { rt, sb } = await rig()
    expect(rt.kind).toBe('cloud')
    expect((await rt.readFile('a.txt'))?.toString()).toBe('one\n')
    await rt.writeFile('dir/new.txt', 'made\n')
    expect((await sb.readFile('/vercel/sandbox/dir/new.txt'))?.toString()).toBe('made\n')
    expect(await rt.exists('dir')).toBe(true)
    await rt.mkdir('empty/deeper')
    expect(await rt.exists('/vercel/sandbox/empty/deeper')).toBe(true)
    expect(await rt.readFile('missing.txt')).toBeNull()
  })

  it('runs git status and diff through the runtime', async () => {
    const { rt } = await rig()
    await rt.writeFile('a.txt', 'one\ntwo\n')
    await rt.writeFile('b.txt', 'new\n')
    expect((await git(rt, ['status', '--porcelain'])).stdout.trimEnd().split('\n').sort()).toEqual([' M a.txt', '?? b.txt'])
    const diff = await gitOut(rt, ['diff', '--', 'a.txt'])
    expect(diff).toContain('+two')
    await git(rt, ['add', '-A'])
    await git(rt, [...IDENTITY, 'commit', '-q', '-m', 'work'])
    expect(await gitOut(rt, ['log', '--format=%s', '-1'])).toBe('work')
    expect(await revParse(rt, 'HEAD')).toMatch(/^[0-9a-f]{40}$/)
    expect(await revParse(rt, 'refs/heads/nope')).toBeNull()
    expect(await baseStartPoint(rt, 'main')).toBe('origin/main')
  })

  it('fails like local git: GitError unless allowFail', async () => {
    const { rt } = await rig()
    const soft = await git(rt, ['rev-parse', '--verify', 'nope'], { allowFail: true })
    expect(soft.code).not.toBe(0)
    const err = await git(rt, ['checkout', 'no-such-branch']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).message).toMatch(/^git checkout failed: /)
    expect((err as GitError).args).toEqual(['checkout', 'no-such-branch'])
  })

  it('sends GIT_TERMINAL_PROMPT=0 and the caller’s env as one command’s environment only', async () => {
    const { rt, provider } = await rig()
    await git(rt, ['status'], { env: { GH_TOKEN: 'gho_secret' } })
    const call = provider.callsOf('exec').at(-1)!
    expect(call.env).toEqual({ GIT_TERMINAL_PROMPT: '0', GH_TOKEN: 'gho_secret' })
    await git(rt, ['status'])
    expect(provider.callsOf('exec').at(-1)!.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
  })

  it('runs scripts with bash in the sandbox, streaming output and the exit code', async () => {
    const { rt, provider } = await rig()
    const chunks: string[] = []
    const run = runScript('echo "hi $WHO"; exit 4', rt, { WHO: 'there' }, (c) => chunks.push(c))
    expect(run.child).toBeNull()
    expect(await run.done).toBe(4)
    expect(chunks.join('')).toContain('hi there')
    const call = provider.callsOf('exec').at(-1)!
    expect(call.cmd).toBe('bash')
    expect(call.args?.[0]).toBe('-lc')
  })

  it('runs setup steps through the runtime, stopping at the first that fails', async () => {
    const { rt } = await rig()
    const outputs: string[] = []
    const run = runSetupSteps({
      steps: [
        { name: 'Write', command: 'echo ok > setup.txt' },
        { name: 'Fail', command: 'exit 2' },
        { name: 'Never', command: 'echo never > never.txt' }
      ],
      cwd: rt,
      env: {},
      onOutput: (_i, chunk) => outputs.push(chunk),
      onChange: () => undefined
    })
    expect(await run.done).toBe('failed')
    expect(run.results.map((r) => r.status)).toEqual(['done', 'failed', 'skipped'])
    expect(run.results[1].exitCode).toBe(2)
    expect((await rt.readFile('setup.txt'))?.toString().trim()).toBe('ok')
    expect(await rt.exists('never.txt')).toBe(false)
  })

  it('stops a running setup step in the sandbox', async () => {
    const { rt } = await rig()
    const run = runSetupSteps({ steps: [{ name: 'Slow', command: 'sleep 20' }], cwd: rt, env: {}, onOutput: () => undefined, onChange: () => undefined })
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    await run.kill()
    expect(await run.done).toBe('stopped')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('runtimeFor', () => {
  it('is the sandbox for a cloud workspace, looked up on first use; a local workspace has none (its folder is the target)', async () => {
    const { sb } = await rig()
    const asked: string[] = []
    const deps = { sandbox: async (ws: Workspace) => (asked.push(ws.id), sb) }
    const cloud = { id: 'c1', path: undefined, cloud: { provider: 'vercel', id: 'foreman-ws-1', status: 'running', region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox' } } as unknown as Workspace
    const rt = runtimeFor(cloud, deps)
    expect(rt.kind).toBe('cloud')
    // Nothing is looked up until it's used.
    expect(asked).toEqual([])
    expect((await rt.readFile('README.md'))?.toString()).toBe('hello\n')
    expect(asked).toEqual(['c1'])
    const dir = await tempDir()
    expect(() => runtimeFor({ id: 'l1', name: 'oslo', path: dir } as Workspace, deps)).toThrow(/isn’t a cloud workspace/)
  })
})
