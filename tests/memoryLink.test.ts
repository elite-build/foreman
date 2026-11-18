// An organization's memory repository linked to a remote (docs/ai-employees.md §4, "Pushing"): linking pushes it, each
// memory commit after that is pushed fast-forward, a failed push is kept on the link and a refused first push links
// nothing, and unlinking leaves the remote alone. A bare repository on disk stands in for GitHub.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Organization } from '../src/shared/organizations'
import type { Repo } from '../src/shared/types'
import { git, gitOut } from '../src/main/git'
import { MemoryLinkService } from '../src/main/memoryLink'
import type { PersistedState } from '../src/main/store'
import { commit, makeRepo, tempDir } from './helpers'

async function rig(options: { createGithub?: (name: string, account?: string) => Promise<string> } = {}) {
  const memory = await makeRepo({ 'README.md': 'memory\n' })
  const repo = { id: 'mem', name: 'acme-memory', rootPath: memory, defaultBranch: 'main', remote: 'origin', hasOrigin: false } as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-18T00:00:00.000Z' }
  const state = { repos: [repo], organizations: [org] } as unknown as PersistedState
  let changes = 0
  const service = new MemoryLinkService({
    state: () => state,
    changed: () => void changes++,
    env: async () => ({}),
    now: () => new Date('2026-11-18T10:00:00.000Z'),
    ...(options.createGithub ? { createGithub: options.createGithub } : {})
  })
  return { memory, repo, org, state, service, changes: () => changes }
}

async function bare(): Promise<string> {
  const dir = path.join(await tempDir('foreman-memory-remote-'), 'remote.git')
  await git(path.dirname(dir), ['init', '-q', '--bare', '-b', 'main', dir])
  return dir
}

const head = (dir: string, ref = 'main') => gitOut(dir, ['rev-parse', ref])

describe('linking an organization’s memory to a remote', () => {
  it('links to an empty repository, pushes the memory there, and pushes each commit after', async () => {
    const { memory, repo, org, service, changes } = await rig()
    const remote = await bare()
    const linked = await service.link('o1', { kind: 'existing', remoteUrl: remote })
    expect(linked.memoryLink).toEqual({ remoteUrl: remote, pushedAt: '2026-11-18T10:00:00.000Z' })
    expect(await head(remote)).toBe(await head(memory))
    expect(await gitOut(memory, ['remote', 'get-url', 'origin'])).toBe(remote)
    expect(repo.hasOrigin).toBe(true)
    expect(changes()).toBeGreaterThan(0)

    // A memory commit landed: pushed, one at a time, the last head winning.
    await commit(memory, 'Remember something')
    service.committed('o1')
    await commit(memory, 'Remember more')
    service.committed('o1')
    await service.pushNow('o1')
    expect(await head(remote)).toBe(await head(memory))
    expect(org.memoryLink?.error).toBeUndefined()
  })

  it('makes a private GitHub repository for it when asked, and links that', async () => {
    const remote = await bare()
    const made: [string, string | undefined][] = []
    const { service, memory } = await rig({ createGithub: async (name, account) => (made.push([name, account]), remote) })
    const linked = await service.link('o1', { kind: 'create', name: 'acme-memory', account: 'me' })
    expect(made).toEqual([['acme-memory', 'me']])
    expect(linked.memoryLink).toMatchObject({ remoteUrl: remote, account: 'me' })
    expect(await head(remote)).toBe(await head(memory))
  })

  it('links nothing when the first push is refused, and puts the remote it had back', async () => {
    const { memory, org, service } = await rig()
    // A remote with history of its own: not a fast-forward.
    const other = await makeRepo({ 'other.md': 'x\n' })
    const remote = await bare()
    await git(other, ['push', '-q', remote, 'main:main'])
    await git(memory, ['remote', 'add', 'origin', 'https://example.com/before.git'])
    await expect(service.link('o1', { kind: 'existing', remoteUrl: remote })).rejects.toThrow(/has commits the memory repository doesn’t/)
    expect(org.memoryLink).toBeUndefined()
    expect(await gitOut(memory, ['remote', 'get-url', 'origin'])).toBe('https://example.com/before.git')
  })

  it('refuses a URL with a password in it, and an organization without memory', async () => {
    const { service, org } = await rig()
    await expect(service.link('o1', { kind: 'existing', remoteUrl: 'https://me:secret@github.com/me/m.git' })).rejects.toThrow(/without an embedded username or password/)
    delete org.memoryRepoId
    await expect(service.link('o1', { kind: 'existing', remoteUrl: await bare() })).rejects.toThrow(/no memory repository/)
  })

  it('keeps a failed push on the link with why, clears it on the next that lands, and says it from Push now', async () => {
    const { memory, org, service } = await rig()
    const remote = await bare()
    await service.link('o1', { kind: 'existing', remoteUrl: remote })
    // The remote moves on without the memory: the next push can't fast-forward.
    const elsewhere = path.join(await tempDir('foreman-memory-clone-'), 'c')
    await git(path.dirname(elsewhere), ['clone', '-q', remote, elsewhere])
    await commit(elsewhere, 'Someone else')
    await git(elsewhere, ['push', '-q', 'origin', 'main'])
    await commit(memory, 'Remember something')
    await expect(service.pushNow('o1')).rejects.toThrow(/has commits the memory repository doesn’t/)
    expect(org.memoryLink).toMatchObject({ remoteUrl: remote, pushedAt: '2026-11-18T10:00:00.000Z' })
    expect(org.memoryLink?.error).toMatch(/has commits/)
    // Brought up to date by hand: the next push lands and the failure is gone.
    await git(memory, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'pull', '-q', '--rebase', 'origin', 'main'])
    await service.pushNow('o1')
    expect(org.memoryLink?.error).toBeUndefined()
    expect(await head(remote)).toBe(await head(memory))
  })

  it('unlinks: no more pushes, the remote it added is removed, and the remote repository is left as it is', async () => {
    const { memory, repo, org, service } = await rig()
    const remote = await bare()
    await service.link('o1', { kind: 'existing', remoteUrl: remote })
    const pushed = await head(remote)
    await service.unlink('o1')
    expect(org.memoryLink).toBeUndefined()
    expect(repo.hasOrigin).toBe(false)
    expect((await git(memory, ['remote'], { allowFail: true })).stdout.trim()).toBe('')
    await commit(memory, 'Remember something')
    service.committed('o1')
    await expect(service.pushNow('o1')).rejects.toThrow(/isn’t linked/)
    expect(await head(remote)).toBe(pushed)
  })
})
