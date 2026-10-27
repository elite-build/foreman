import { appendFileSync } from 'node:fs'
import { stubGh } from './ghHarness'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { classifyGhError, pullRequest, type PrResult } from '../src/main/github'
import { GitActions } from '../src/main/gitActions'
import { PrCache } from '../src/main/prCache'
import type { PullRequestInfo, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const ws = (patch: Partial<Workspace> = {}) => ({ id: 'w1', path: tmpdir(), branch: 'feat', ...patch }) as Workspace
const pr = { number: 3, url: 'https://github.com/acme/web/pull/3', state: 'OPEN', checks: [] } as unknown as PullRequestInfo
const ok: PrResult = { kind: 'ok', pr, headRefOid: 'abc', repo: 'acme/web' }

describe('typed pull request lookup', () => {
  async function withGh(stdout = '', stderr = ''): Promise<string> {
    const bin = await tempDir('fake-gh-')
    await writeFile(path.join(bin, 'calls.txt'), '')
    stubGh((args) => {
      appendFileSync(path.join(bin, 'calls.txt'), args.join(' ') + '\n')
      return args[0] === '--version' ? { stdout: 'gh' } : { stdout, stderr, code: stderr ? 1 : 0 }
    })
    return bin
  }

  it('returns the head SHA and a repo-qualified identity', async () => {
    await withGh('{"number":7,"url":"https://github.com/acme/widgets/pull/7","title":"t","state":"OPEN","headRefOid":"deadbeef","statusCheckRollup":[]}')
    const result = await pullRequest(ws({ pullRequest: { repo: 'acme/widgets', number: 7 } }))
    expect(result).toMatchObject({ kind: 'ok', headRefOid: 'deadbeef', repo: 'acme/widgets' })
  })

  it('tells no PR, auth failures, rate limits and other failures apart', async () => {
    await withGh('', 'no pull requests found for branch "feat"')
    expect(await pullRequest(ws())).toEqual({ kind: 'no-pr' })
    await withGh('', 'To get started with GitHub CLI, please run:  gh auth login')
    expect(await pullRequest(ws())).toMatchObject({ kind: 'auth-error' })
    await withGh('', 'GraphQL: API rate limit exceeded for user')
    expect(await pullRequest(ws())).toMatchObject({ kind: 'unavailable', rateLimited: true })
    await withGh('', 'dial tcp: lookup api.github.com: no such host')
    expect(await pullRequest(ws())).toMatchObject({ kind: 'unavailable' })
    expect(classifyGhError('HTTP 401: Bad credentials')).toBe('auth-error')
    expect(classifyGhError('rate limit: authenticated requests get a higher limit')).toBe('rate-limit')
  })

  it('asks for the head SHA', async () => {
    const bin = await withGh('{"number":1,"url":"u","title":"t","state":"OPEN","statusCheckRollup":[]}')
    await pullRequest(ws())
    expect(await readFile(path.join(bin, 'calls.txt'), 'utf8')).toContain('headRefOid')
  })
})

describe('shared PR cache', () => {
  it('does not share an in-flight request or publish an old response after the account changes', async () => {
    let identity = 'personal'
    let release!: (result: PrResult) => void
    const fetch = vi.fn<() => Promise<PrResult>>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockResolvedValue(ok)
    const seen = vi.fn()
    const cache = new PrCache({ fetch, identity: () => identity, onResult: seen })
    const old = cache.get(ws())
    identity = 'work'
    expect(await cache.get(ws())).toBe(ok)
    release({ kind: 'auth-error', message: 'personal token revoked' })
    await old
    expect(await cache.get(ws())).toBe(ok)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('serves readers from one lookup within the TTL, then looks again', async () => {
    let now = 0
    const fetch = vi.fn(async () => ok)
    const cache = new PrCache({ fetch, now: () => now, ttlMs: 10_000 })
    await Promise.all([cache.get(ws()), cache.get(ws())])
    await cache.get(ws())
    expect(fetch).toHaveBeenCalledTimes(1)
    now = 10_001
    await cache.get(ws())
    expect(fetch).toHaveBeenCalledTimes(2)
    await cache.get(ws(), { fresh: true })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('waits for identities to be known before the first lookup, then not again', async () => {
    let identity = 'blocked:r1'
    let known!: () => void
    let ready = new Promise<void>((resolve) => { known = resolve })
    const fetch = vi.fn(async (_w: Workspace) => ok)
    const seen: string[] = []
    const cache = new PrCache({ fetch: async (w) => (seen.push(identity), fetch(w)), identity: () => identity, ready: () => ready })
    const first = cache.get(ws())
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    identity = 'work'
    known()
    expect(await first).toBe(ok)
    expect(seen).toEqual(['work'])
    // A failed readiness check doesn't stop lookups.
    ready = Promise.reject(new Error('gh missing'))
    expect(await cache.get(ws(), { fresh: true })).toBe(ok)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('looks again after an invalidation or when the branch changes', async () => {
    const fetch = vi.fn(async () => ok)
    const cache = new PrCache({ fetch, now: () => 0 })
    await cache.get(ws())
    cache.invalidate('w1')
    await cache.get(ws())
    await cache.get(ws({ branch: 'other' }))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('backs off after an auth failure and resumes when told', async () => {
    let now = 0
    const fetch = vi.fn<() => Promise<PrResult>>(async () => ({ kind: 'auth-error', message: 'gh auth login' }))
    const cache = new PrCache({ fetch, now: () => now, authBackoffMs: 60_000 })
    expect((await cache.get(ws())).kind).toBe('auth-error')
    now = 30_000
    expect((await cache.get(ws({ id: 'w2' }))).kind).toBe('auth-error')
    expect(fetch).toHaveBeenCalledTimes(1)
    cache.resume()
    fetch.mockResolvedValueOnce(ok)
    expect((await cache.get(ws())).kind).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('backs off on rate limits, then retries once the pause is over', async () => {
    let now = 0
    const fetch = vi.fn<() => Promise<PrResult>>(async () => ({ kind: 'unavailable', message: 'rate limit', rateLimited: true }))
    const cache = new PrCache({ fetch, now: () => now, rateBackoffMs: 1000 })
    await cache.get(ws())
    await cache.get(ws())
    expect(fetch).toHaveBeenCalledTimes(1)
    now = 1001
    fetch.mockResolvedValueOnce(ok)
    expect((await cache.get(ws())).kind).toBe('ok')
  })

  it('does not pause for an ordinary failure, and reports each answer', async () => {
    const seen: string[] = []
    const fetch = vi.fn<() => Promise<PrResult>>().mockResolvedValueOnce({ kind: 'unavailable', message: 'offline' }).mockResolvedValueOnce(ok)
    const cache = new PrCache({ fetch, onResult: (_w, r) => seen.push(r.kind) })
    expect((await cache.get(ws())).kind).toBe('unavailable')
    expect((await cache.get(ws(), { fresh: true })).kind).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(['unavailable', 'ok'])
  })
})

describe('merge and ready for a checked-out PR', () => {
  it('pass --repo so fork PRs reach the base repository', async () => {
    const repoDir = await makeRepo()
    const bin = await tempDir('fake-gh-')
    await writeFile(path.join(bin, 'calls.txt'), '')
    stubGh((args) => {
      appendFileSync(path.join(bin, 'calls.txt'), args.join(' ') + '\n')
      return { stdout: args[0] === 'repo' ? '{"squashMergeAllowed":true}' : 'gh' }
    })
    const workspace = { id: 'w1', repoId: 'r', path: repoDir, branch: 'pr-3', baseBranch: 'main', pullRequest: { repo: 'acme/web', number: 3 } } as Workspace
    const prs = new PrCache({ fetch: async () => ({ kind: 'ok', pr: { ...pr, isDraft: false }, headRefOid: 'x', repo: 'acme/web' }) })
    const actions = new GitActions(
      { state: { settings: { optionalChecksBlock: true, automerge: false }, sessions: [] } } as never,
      { workspace: () => workspace, repo: () => ({ id: 'r', hasOrigin: true, remote: 'origin' }), accountFor: () => undefined, accountForFresh: async () => undefined, settingsFor: () => ({ prompts: {}, archiveOnMerge: false }) } as never,
      {} as never,
      async () => undefined,
      prs
    )
    await actions.run('w1', 'merge')
    await actions.run('w1', 'ready-for-review')
    const calls = (await readFile(path.join(bin, 'calls.txt'), 'utf8')).split('\n')
    expect(calls.find((c) => c.startsWith('pr merge'))).toMatch(/^pr merge 3 --repo acme\/web --squash --match-head-commit /)
    expect(calls).toContain('repo view acme/web --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed')
    expect(calls).toContain('pr ready 3 --repo acme/web')
  })
})
