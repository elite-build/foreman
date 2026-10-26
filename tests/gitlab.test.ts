// O2: GitLab's REST answers mapped into Foreman's pull-request model, the actions,
// and MR / issue intake. Recorded JSON fixtures and a fake fetch: no network.
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyGhError } from '../src/main/github'
import {
  fetchGitlabLink,
  GitlabApi,
  gitlabPullRequest,
  mapDiscussions,
  mapMergeRequest,
  readGlabToken,
  testConnection,
  type Fetch,
  type RawDiscussion
} from '../src/main/gitlab'
import { fetchPullHead, remoteForGitlabRepo, resolveGitlabLink } from '../src/main/intake'
import { reviewThreadsMarkdown } from '../src/main/reviews'
import { gitlabProvider } from '../src/main/scm'
import { git, gitOut } from '../src/main/git'
import { intakeFile } from '../src/shared/githubLink'
import { findGitlabLink, normalizeGitlabHost } from '../src/shared/scm'
import type { PrCheck, Workspace } from '../src/shared/types'
import { commit, makeRepo, tempDir } from './helpers'

const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'gitlab', name), 'utf8')) as T
const HOST = normalizeGitlabHost('gitlab.acme.dev')
const P = '/api/v4/projects/acme%2Fledger-api'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  redirect?: string
}

type Route = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }

/** A fetch that answers from a table of "METHOD /path?query" → response, and records every call. */
function fakeFetch(routes: Record<string, Route | ((call: Call) => Route)>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const call: Call = { method: init?.method ?? 'GET', url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined, redirect: init?.redirect }
    calls.push(call)
    const key = `${call.method} ${url.replace(HOST.url, '')}`
    const found = routes[key]
    const route = typeof found === 'function' ? found(call) : found
    if (!route) return new Response(JSON.stringify({ message: '404 Not found' }), { status: 404 })
    const body = route.text ?? JSON.stringify(route.json ?? null)
    return new Response(body, { status: route.status ?? 200, headers: route.headers })
  }) as Fetch
  return { fetch, calls }
}

const MR = `${P}/merge_requests/87`
const BASE_ROUTES = {
  [`GET ${P}/merge_requests?source_branch=yatin%2Finvoice-migration&per_page=5&state=opened`]: { json: [fixture('merge-request-87.json')] },
  [`GET ${MR}`]: { json: fixture('merge-request-87.json') },
  [`GET ${MR}/approvals`]: { json: fixture('approvals-87.json') },
  [`GET ${P}/pipelines/4182/jobs?per_page=100&page=1`]: { json: fixture('pipeline-4182-jobs.json') }
}

const ws = (patch: Partial<Workspace> = {}) => ({ id: 'w1', repoId: 'r', path: '/tmp/x', branch: 'yatin/invoice-migration', baseBranch: 'main', ...patch }) as Workspace

describe('a GitLab merge request as Foreman’s pull request', () => {
  it('maps !87, approvals 1 of 2, why it can’t merge, and the pipeline’s jobs', async () => {
    const { fetch, calls } = fakeFetch(BASE_ROUTES)
    const result = await gitlabPullRequest(new GitlabApi(HOST, 'glpat-secret', fetch), 'acme/ledger-api', 'yatin/invoice-migration')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.headRefOid).toBe('9e1c4b7d2a0f5e31c8b6a4f0d2e9c7b1a3f5e8d0')
    expect(result.repo).toBe('gitlab.acme.dev/acme/ledger-api')
    const pr = result.pr
    expect(pr).toMatchObject({
      number: 87,
      url: 'https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87',
      title: 'Move invoices to ledger_entries',
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      baseRefName: 'main',
      autoMerge: false,
      provider: 'gitlab',
      approvals: { given: 1, required: 2, by: ['mkagame'] },
      pipeline: { id: 4182, status: 'failed', url: 'https://gitlab.acme.dev/acme/ledger-api/-/pipelines/4182' },
      mergeBlocked: ['pipeline-failed', 'approvals', 'threads']
    })
    // Failed jobs first, in pipeline order; a manual job is neither running nor failed.
    expect(pr.checks.map((c) => [c.name, c.state])).toEqual([
      ['integration', 'failure'],
      ['eslint', 'failure'],
      ['unit', 'success'],
      ['docker-image', 'success'],
      ['review-app', 'skipped']
    ])
    expect(pr.checks[0]).toEqual({ name: 'integration', state: 'failure', url: 'https://gitlab.acme.dev/acme/ledger-api/-/jobs/99101', runId: 4182, jobId: 99101, stage: 'test', duration: 372 })
    expect(pr.checks[4]).toMatchObject({ manual: true, required: false, stage: 'deploy' })
    // The token goes only to its own host, as a bearer token, and never through a redirect.
    for (const call of calls) {
      expect(call.url.startsWith('https://gitlab.acme.dev/api/v4/')).toBe(true)
      expect(call.headers.Authorization).toBe('Bearer glpat-secret')
      expect(call.redirect).toBe('error')
    }
  })

  it('falls back to the latest MR in any state, and says when there is none', async () => {
    const merged = { ...fixture<Record<string, unknown>>('merge-request-87.json'), state: 'merged', detailed_merge_status: 'not_open', head_pipeline: null }
    const { fetch } = fakeFetch({
      [`GET ${P}/merge_requests?source_branch=done&per_page=5&state=opened`]: { json: [] },
      [`GET ${P}/merge_requests?source_branch=done&per_page=5&order_by=updated_at&sort=desc`]: { json: [merged] },
      [`GET ${MR}`]: { json: merged },
      [`GET ${P}/merge_requests?source_branch=none&per_page=5&state=opened`]: { json: [] },
      [`GET ${P}/merge_requests?source_branch=none&per_page=5&order_by=updated_at&sort=desc`]: { json: [] }
    })
    const api = new GitlabApi(HOST, 't', fetch)
    const done = await gitlabPullRequest(api, 'acme/ledger-api', 'done')
    expect(done.kind === 'ok' && done.pr.state).toBe('MERGED')
    expect(done.kind === 'ok' && done.pr.mergeBlocked).toBeUndefined()
    expect(done.kind === 'ok' && done.pr.approvals).toBeUndefined()
    expect(await gitlabPullRequest(api, 'acme/ledger-api', 'none')).toEqual({ kind: 'no-pr' })
  })

  it('reads a checked-out MR by its !iid', async () => {
    const { fetch, calls } = fakeFetch(BASE_ROUTES)
    const provider = gitlabProvider(HOST, 'yatin/ledger-api', 't', fetch)
    const result = await provider.pullRequest(ws({ branch: 'mr-87', pullRequest: { repo: 'acme/ledger-api', number: 87, gitlabHost: 'gitlab.acme.dev' } }))
    expect(result.kind).toBe('ok')
    expect(calls.some((c) => c.url.includes('source_branch'))).toBe(false)
  })

  it('tells auth failures, rate limits and other failures apart, in words classifyGhError sorts the same way', async () => {
    const noToken = await gitlabPullRequest(new GitlabApi(HOST, undefined, fakeFetch({}).fetch), 'acme/ledger-api', 'b')
    expect(noToken.kind).toBe('auth-error')
    const rejected = await gitlabPullRequest(new GitlabApi(HOST, 'bad', fakeFetch({ [`GET ${P}/merge_requests?source_branch=b&per_page=5&state=opened`]: { status: 401, json: { message: '401 Unauthorized' } } }).fetch), 'acme/ledger-api', 'b')
    expect(rejected.kind).toBe('auth-error')
    expect(classifyGhError((rejected as { message: string }).message)).toBe('auth-error')
    expect(classifyGhError((noToken as { message: string }).message)).toBe('auth-error')
    const limited = await gitlabPullRequest(new GitlabApi(HOST, 't', fakeFetch({ [`GET ${P}/merge_requests?source_branch=b&per_page=5&state=opened`]: { status: 429 } }).fetch), 'acme/ledger-api', 'b')
    expect(limited).toMatchObject({ kind: 'unavailable', rateLimited: true })
    expect(classifyGhError((limited as { message: string }).message)).toBe('rate-limit')
    const missing = await gitlabPullRequest(new GitlabApi(HOST, 't', fakeFetch({}).fetch), 'acme/ledger-api', 'b')
    expect(missing.kind).toBe('unavailable')
    const offline = await gitlabPullRequest(new GitlabApi(HOST, 't', (async () => { throw new TypeError('fetch failed') }) as Fetch), 'acme/ledger-api', 'b')
    expect(offline).toMatchObject({ kind: 'unavailable', message: 'Couldn’t reach gitlab.acme.dev: fetch failed' })
  })

  it('words each merge block GitLab can report', () => {
    const mr = fixture<Parameters<typeof mapMergeRequest>[0]>('merge-request-87.json')
    const blocks = (patch: object, approvals = null) => mapMergeRequest({ ...mr, blocking_discussions_resolved: true, ...patch }, approvals, []).mergeBlocked
    expect(blocks({ detailed_merge_status: 'mergeable' })).toBeUndefined()
    expect(blocks({ detailed_merge_status: 'ci_still_running', head_pipeline: { id: 1, status: 'running' } })).toEqual(['pipeline-running'])
    expect(blocks({ detailed_merge_status: 'draft_status', draft: true })).toEqual(['draft'])
    expect(blocks({ detailed_merge_status: 'conflict', has_conflicts: true })).toEqual(['conflict'])
    expect(blocks({ detailed_merge_status: 'need_rebase' })).toEqual(['rebase'])
    expect(blocks({ detailed_merge_status: 'jira_association_missing' })).toEqual(['blocked'])
    expect(blocks({ detailed_merge_status: undefined, merge_status: 'cannot_be_merged' })).toEqual(['conflict'])
    expect(mapMergeRequest({ ...mr, detailed_merge_status: 'conflict', has_conflicts: true }, null, []).mergeable).toBe('CONFLICTING')
    expect(mapMergeRequest({ ...mr, detailed_merge_status: 'checking' }, null, []).mergeable).toBe('UNKNOWN')
    expect(mapMergeRequest({ ...mr, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true }, { approvals_required: 1, approvals_left: 0, approved_by: [{ user: { username: 'a' } }] }, [])).toMatchObject({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })
  })
})

describe('GitLab discussions as review threads', () => {
  const threads = () => mapDiscussions(fixture<RawDiscussion[]>('discussions-87.json'), 'https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87', '9e1c4b7d2a0f5e31c8b6a4f0d2e9c7b1a3f5e8d0')

  it('keeps resolvable discussions, without system notes or plain comments', () => {
    const all = threads()
    expect(all.map((t) => [t.path, t.line, t.side, t.isResolved, t.isOutdated])).toEqual([
      ['src/db/migrations/0042_ledger_entries.sql', 18, 'RIGHT', false, false],
      ['src/invoices/invoiceRepo.ts', 141, 'LEFT', false, true],
      ['', null, 'RIGHT', true, false]
    ])
    expect(all.filter((t) => !t.isResolved)).toHaveLength(2)
    expect(all[0].comments).toEqual([
      { id: '1201', author: 'mkagame', body: 'This drops `invoices.legacy_ref` before the backfill reads it. Can the drop move to 0043?', url: 'https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87#note_1201', createdAt: '2026-10-22T10:01:00.000Z', updatedAt: '2026-10-22T10:01:00.000Z', diffHunk: '' },
      expect.objectContaining({ id: '1205', author: 'yatin.chaubal', updatedAt: '2026-10-22T10:31:10.000Z' })
    ])
  })

  it('reads every page, and the review watch sees only other people’s notes and approvals', async () => {
    const pages = fixture<RawDiscussion[]>('discussions-87.json')
    const { fetch } = fakeFetch({
      [`GET ${MR}/discussions?per_page=100&page=1`]: { json: pages.slice(0, 2), headers: { 'x-next-page': '2' } },
      [`GET ${MR}/discussions?per_page=100&page=2`]: { json: pages.slice(2), headers: { 'x-next-page': '' } },
      'GET /api/v4/user': { json: { username: 'yatin.chaubal' } }
    })
    const provider = gitlabProvider(HOST, 'acme/ledger-api', 'tok-watch', fetch)
    const { pr } = (await gitlabPullRequest(new GitlabApi(HOST, 't', fakeFetch(BASE_ROUTES).fetch), 'acme/ledger-api', 'yatin/invoice-migration')) as { pr: Parameters<typeof provider.reviewThreads>[1] }
    expect(await provider.reviewThreads(ws(), pr)).toHaveLength(3)
    expect(await provider.reviewActivity(ws(), pr)).toEqual({
      comments: ['1201', '1210', '1220', '1230'],
      reviews: [{ id: 'approval:mkagame', state: 'APPROVED', body: '' }]
    })
    const md = reviewThreadsMarkdown(pr, (await provider.reviewThreads(ws(), pr)).filter((t) => !t.isResolved))
    expect(md).toContain('# Review feedback for !87: Move invoices to ledger_entries')
    expect(md).toContain('review feedback from GitLab')
    expect(md).toContain('## src/invoices/invoiceRepo.ts:141 (deleted/base side) — outdated')
  })
})

describe('GitLab actions', () => {
  const pr = mapMergeRequest(fixture('merge-request-87.json'), fixture('approvals-87.json'), fixture('pipeline-4182-jobs.json'))

  it('merges at the head Foreman saw, or once the pipeline succeeds', async () => {
    const { fetch, calls } = fakeFetch({ [`PUT ${MR}/merge`]: { json: { state: 'merged' } } })
    const provider = gitlabProvider(HOST, 'acme/ledger-api', 't', fetch)
    await provider.merge(ws(), pr, 'abc123')
    await provider.autoMerge(ws(), pr)
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['PUT', { sha: 'abc123' }],
      ['PUT', { merge_when_pipeline_succeeds: true }]
    ])
  })

  it('says why GitLab refused a merge', async () => {
    const { fetch } = fakeFetch({ [`PUT ${MR}/merge`]: { status: 405, json: { message: '405 Method Not Allowed' } } })
    await expect(gitlabProvider(HOST, 'acme/ledger-api', 't', fetch).merge(ws(), pr, 'abc')).rejects.toThrow('GitLab answered HTTP 405: 405 Method Not Allowed')
  })

  it('marks ready by taking the draft prefix off the title, and leaves a ready MR alone', async () => {
    const { fetch, calls } = fakeFetch({ [`PUT ${MR}`]: { json: {} } })
    const provider = gitlabProvider(HOST, 'acme/ledger-api', 't', fetch)
    await provider.markReady(ws(), { ...pr, title: 'Draft: Move invoices', isDraft: true })
    await provider.markReady(ws(), pr)
    expect(calls.map((c) => c.body)).toEqual([{ title: 'Move invoices' }])
  })

  it('retries the pipeline once (GitLab reruns only its failed jobs), and reads a failed job’s log', async () => {
    const log = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')
    const { fetch, calls } = fakeFetch({ [`POST ${P}/pipelines/4182/retry`]: { json: {} }, [`GET ${P}/jobs/99101/trace`]: { text: log } })
    const provider = gitlabProvider(HOST, 'acme/ledger-api', 't', fetch)
    await provider.rerunFailed(ws(), pr)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    const tail = await provider.failureLog(ws(), pr.checks[0])
    expect(tail.split('\n')).toHaveLength(1000)
    expect(tail.endsWith('line 1499')).toBe(true)
    // No log to read: says where the job is.
    const eslint = { ...pr.checks[1], jobId: undefined } as PrCheck
    expect(await provider.failureLog(ws(), eslint)).toBe('eslint failed. Details: https://gitlab.acme.dev/acme/ledger-api/-/jobs/99102')
    await expect(provider.rerunFailed(ws(), { ...pr, checks: [] })).rejects.toThrow('No failed GitLab jobs to retry')
  })

  it('opens GitLab’s new merge request page for the branch', async () => {
    const { fetch } = fakeFetch({ [`GET ${P}`]: { json: { web_url: 'https://gitlab.acme.dev/acme/ledger-api' } } })
    expect(await gitlabProvider(HOST, 'acme/ledger-api', 't', fetch).newPullRequestUrl(ws())).toBe(
      'https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/new?merge_request%5Bsource_branch%5D=yatin%2Finvoice-migration&merge_request%5Btarget_branch%5D=main'
    )
  })
})

describe('Test connection', () => {
  it('reports the GitLab version and who the token is', async () => {
    const { fetch } = fakeFetch({ 'GET /api/v4/version': { json: { version: '18.4.1-ee', revision: 'abc' } }, 'GET /api/v4/user': { json: { username: 'yatin' } } })
    expect(await testConnection(new GitlabApi(HOST, 't', fetch))).toEqual({ ok: true, version: '18.4', user: 'yatin' })
  })

  it('says so when the host isn’t GitLab or the token is wrong', async () => {
    expect(await testConnection(new GitlabApi(HOST, 't', fakeFetch({}).fetch))).toEqual({ ok: false, error: 'gitlab.acme.dev didn’t answer as GitLab (no /api/v4)' })
    expect(await testConnection(new GitlabApi(HOST, 't', fakeFetch({ 'GET /api/v4/version': { text: '<html>hi</html>' } }).fetch))).toEqual({ ok: false, error: 'gitlab.acme.dev didn’t answer as GitLab (not JSON)' })
    const bad = await testConnection(new GitlabApi(HOST, 't', fakeFetch({ 'GET /api/v4/version': { status: 401 } }).fetch))
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toContain('HTTP 401')
  })
})

describe('glab’s login', () => {
  it('reads the token from glab’s config, else from auth status', async () => {
    const seen: string[][] = []
    expect(await readGlabToken('gitlab.acme.dev', async (args) => (seen.push(args), { stdout: 'glpat-fromconfig\n', stderr: '' }))).toBe('glpat-fromconfig')
    expect(seen[0]).toEqual(['config', 'get', 'token', '--host', 'gitlab.acme.dev'])
    const status = async (args: string[]) => (args[0] === 'config' ? { stdout: '', stderr: '' } : { stdout: '', stderr: 'gitlab.acme.dev\n  ✓ Logged in as yatin\n  ✓ Token: glpat-abcdef123456\n' })
    expect(await readGlabToken('gitlab.acme.dev', status)).toBe('glpat-abcdef123456')
    await expect(readGlabToken('gitlab.acme.dev', async () => ({ stdout: '', stderr: 'x Token: **************' }))).rejects.toThrow(/glab auth login --hostname gitlab.acme.dev/)
  })
})

describe('a workspace from a GitLab MR or issue URL', () => {
  const routes = {
    [`GET ${MR}`]: { json: fixture('merge-request-87.json') },
    [`GET ${MR}/notes?sort=asc&order_by=created_at&per_page=100&page=1`]: {
      json: [
        { id: 1, body: 'Please also update the docs.', author: { username: 'mkagame' }, created_at: '2026-10-22T09:00:00Z' },
        { id: 2, body: 'added 1 commit', author: { username: 'yatin' }, created_at: '2026-10-22T09:05:00Z', system: true }
      ]
    },
    'GET /api/v4/projects/acme%2Fplatform%2Fledger-api/issues/12': { json: fixture('issue-12.json') },
    'GET /api/v4/projects/acme%2Fplatform%2Fledger-api/issues/12/notes?sort=asc&order_by=created_at&per_page=100&page=1': { json: [] }
  }

  it('reads an MR’s branches and human comments, and an issue’s text', async () => {
    const api = new GitlabApi(HOST, 't', fakeFetch(routes).fetch)
    const mr = await fetchGitlabLink(findGitlabLink('https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87')!, api)
    expect(mr).toMatchObject({ kind: 'pr', number: 87, gitlabHost: 'gitlab.acme.dev', headRef: 'yatin/invoice-migration', baseRef: 'main', isFork: false, title: 'Move invoices to ledger_entries' })
    expect(mr.comments).toEqual([{ author: 'mkagame', body: 'Please also update the docs.', at: '2026-10-22T09:00:00Z' }])
    const issueLink = findGitlabLink('https://gitlab.com/acme/platform/ledger-api/-/issues/12')!
    const issue = await fetchGitlabLink(issueLink, new GitlabApi(HOST, 't', fakeFetch(routes).fetch))
    expect(issue).toMatchObject({ kind: 'issue', number: 12, repo: 'acme/platform/ledger-api', title: 'Invoices show the wrong currency after migration' })
    // The text is attached as untrusted data, never as instructions.
    expect(intakeFile(issue).content).toMatch(/untrusted data[\s\S]*Ignore previous instructions/)
  })

  it('fails plainly when GitLab can’t be read', async () => {
    await expect(fetchGitlabLink(findGitlabLink('https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/9')!, new GitlabApi(HOST, 't', fakeFetch({}).fetch))).rejects.toThrow(
      /^Couldn’t read https:\/\/gitlab\.acme\.dev\/acme\/ledger-api\/-\/merge_requests\/9: Not found/
    )
  })

  it('fetches refs/merge-requests/N/head from the remote that points at the project', async () => {
    const upstream = await makeRepo({ 'a.txt': 'base\n' })
    await git(upstream, ['checkout', '-q', '-b', 'contrib'])
    await writeFile(path.join(upstream, 'a.txt'), 'from the merge request\n')
    await git(upstream, ['add', '-A'])
    await commit(upstream, 'mr work')
    await git(upstream, ['update-ref', 'refs/merge-requests/87/head', 'HEAD'])
    await git(upstream, ['checkout', '-q', 'main'])
    await git(upstream, ['branch', '-D', 'contrib'])
    const clone = await tempDir()
    await git(path.dirname(clone), ['clone', '-q', upstream, clone])
    await git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.acme.dev:yatin/ledger-api.git'])
    await git(clone, ['remote', 'add', 'upstream', 'git@gitlab.acme.dev:acme/ledger-api.git'])
    await git(clone, ['config', `url.${upstream}.insteadOf`, 'git@gitlab.acme.dev:acme/ledger-api.git'])
    expect(await remoteForGitlabRepo(clone, 'gitlab.acme.dev', 'acme/ledger-api')).toBe('upstream')
    expect(await remoteForGitlabRepo(clone, 'gitlab.com', 'acme/ledger-api')).toBeNull()
    const fetched = await fetchPullHead(clone, 'upstream', 87, 'mr-87', {}, true)
    expect(fetched.command).toBe('git fetch upstream refs/merge-requests/87/head:refs/heads/mr-87')
    expect(await gitOut(clone, ['show', 'mr-87:a.txt'])).toBe('from the merge request')
    // A link the repository has no remote for is flagged, not fetched.
    const api = new GitlabApi(HOST, 't', fakeFetch({ ...routes, 'GET /api/v4/projects/someone%2Felse/merge_requests/87': routes[`GET ${MR}`], 'GET /api/v4/projects/someone%2Felse/merge_requests/87/notes?sort=asc&order_by=created_at&per_page=100&page=1': { json: [] } }).fetch)
    const other = await resolveGitlabLink(clone, findGitlabLink('https://gitlab.acme.dev/someone/else/-/merge_requests/87')!, api)
    expect(other.problem).toBe('None of this repository’s remotes points at gitlab.acme.dev/someone/else, so its merge requests can’t be fetched.')
    const ok = await resolveGitlabLink(clone, findGitlabLink('https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87')!, api)
    expect(ok.problem).toBeUndefined()
  })
})
