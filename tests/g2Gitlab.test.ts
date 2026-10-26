// G2 backlog, GitLab: a relative URL root, trigger (bridge) jobs, glab in the agent's prompt, and
// "MR !N" wherever Foreman names a merge request. A fake fetch and a fake glab: no network.
import { describe, expect, it } from 'vitest'
import { GitlabApi, GlabLogins, gitlabAgentContext, mapBridge, mapJobs, mapMergeRequest, mergeRequestInfo, probeGitlab, type Fetch, type RawMergeRequest } from '../src/main/gitlab'
import { gitlabProvider } from '../src/main/scm'
import { finishedFacts } from '../src/shared/triage'
import { gitlabHostFor, isGitlabRepo, isGitlabWorkspace, normalizeGitlabHost, prRefText, projectOnHost, remoteForGitlabProject, rootCandidates, scmForRemote } from '../src/shared/scm'
import type { Workspace } from '../src/shared/types'

/** Answers "GET https://host/path" from a table; records the URLs asked for. */
function fakeFetch(routes: Record<string, unknown>): { fetch: Fetch; urls: string[] } {
  const urls: string[] = []
  const fetch = (async (input: string | URL) => {
    const url = String(input)
    urls.push(url)
    const key = url.replace(/[?&]per_page=100&page=1$/, '')
    if (!(key in routes)) return new Response(JSON.stringify({ message: '404 Not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as Fetch
  return { fetch, urls }
}

describe('GitLab under a relative URL root', () => {
  it('keeps the sub-path as the root, and still means the host for API and MR links', () => {
    expect(normalizeGitlabHost('acme.dev/gitlab')).toEqual({ url: 'https://acme.dev/gitlab', host: 'acme.dev', root: '/gitlab' })
    expect(normalizeGitlabHost('https://acme.dev/gitlab/')).toEqual({ url: 'https://acme.dev/gitlab', host: 'acme.dev', root: '/gitlab' })
    expect(normalizeGitlabHost('https://acme.dev/gitlab/api/v4/projects')).toEqual({ url: 'https://acme.dev/gitlab', host: 'acme.dev', root: '/gitlab' })
    expect(normalizeGitlabHost('https://gitlab.acme.dev/api/v4')).toEqual({ url: 'https://gitlab.acme.dev', host: 'gitlab.acme.dev' })
    expect(normalizeGitlabHost('https://acme.dev/a/../b')).toMatchObject({ url: 'https://acme.dev/b' })
  })

  it('tries the typed path first, then each shorter one, then the bare host', () => {
    expect(rootCandidates(normalizeGitlabHost('https://acme.dev/gitlab/team/app/-/merge_requests/3')).map((h) => h.url)).toEqual([
      'https://acme.dev/gitlab/team/app',
      'https://acme.dev/gitlab/team',
      'https://acme.dev/gitlab',
      'https://acme.dev'
    ])
    expect(rootCandidates(normalizeGitlabHost('gitlab.com'))).toEqual([{ url: 'https://gitlab.com', host: 'gitlab.com' }])
  })

  it('takes the root off https remotes and links, never off ssh paths', () => {
    const hosts = ['https://acme.dev/gitlab']
    expect(scmForRemote('https://acme.dev/gitlab/team/app.git', hosts)).toMatchObject({ kind: 'gitlab', host: { root: '/gitlab' }, project: 'team/app' })
    expect(scmForRemote('git@acme.dev:team/app.git', hosts)).toMatchObject({ kind: 'gitlab', project: 'team/app' })
    // A group that happens to be called "gitlab" over ssh stays as it is.
    expect(scmForRemote('git@acme.dev:gitlab/app.git', hosts)).toMatchObject({ project: 'gitlab/app' })
    expect(projectOnHost('gitlab/team/app', { root: '/gitlab' })).toBe('team/app')
    expect(projectOnHost('team/app', {})).toBe('team/app')
    expect(gitlabHostFor('ACME.dev', hosts)).toMatchObject({ root: '/gitlab' })
    const remotes = 'origin\tgit@acme.dev:me/app.git (fetch)\nupstream\thttps://acme.dev/gitlab/Team/App.git (fetch)'
    expect(remoteForGitlabProject(remotes, 'acme.dev', 'team/app', '/gitlab')).toBe('upstream')
    expect(remoteForGitlabProject(remotes, 'acme.dev', 'team/app')).toBeNull()
  })

  it('calls the API under the root', async () => {
    const host = normalizeGitlabHost('acme.dev/gitlab')
    const { fetch, urls } = fakeFetch({ 'https://acme.dev/gitlab/api/v4/projects/team%2Fapp': { web_url: 'https://acme.dev/gitlab/team/app' } })
    const provider = gitlabProvider(host, 'team/app', 't', fetch)
    expect(await provider.newPullRequestUrl({ branch: 'b', baseBranch: 'main' } as Workspace)).toMatch(/^https:\/\/acme\.dev\/gitlab\/team\/app\/-\/merge_requests\/new\?/)
    expect(urls).toEqual(['https://acme.dev/gitlab/api/v4/projects/team%2Fapp'])
  })

  it('finds the root by probing a pasted project link, and only on that host', async () => {
    const { fetch, urls } = fakeFetch({
      'https://acme.dev/gitlab/api/v4/version': { version: '18.4.1-ee' },
      'https://acme.dev/gitlab/api/v4/user': { username: 'yatin' }
    })
    const found = await probeGitlab(normalizeGitlabHost('https://acme.dev/gitlab/team/app/-/issues/4'), 'glpat', fetch)
    expect(found.host).toEqual({ url: 'https://acme.dev/gitlab', host: 'acme.dev', root: '/gitlab' })
    expect(found.result).toEqual({ ok: true, version: '18.4', user: 'yatin' })
    expect(urls.every((u) => u.startsWith('https://acme.dev/'))).toBe(true)
    // Nothing answers: the first error comes back and the host is as typed.
    const none = await probeGitlab(normalizeGitlabHost('https://acme.dev/nope'), 'glpat', fakeFetch({}).fetch)
    expect(none.result.ok).toBe(false)
    expect(none.host.root).toBe('/nope')
  })
})

describe('trigger (bridge) jobs', () => {
  const bridge = { id: 30, name: 'deploy-docs', stage: 'deploy', status: 'failed', web_url: 'https://g/-/jobs/30', downstream_pipeline: { id: 99, status: 'failed', web_url: 'https://g/-/pipelines/99' } }

  it('is a check row linking to its downstream pipeline, with no log of its own', () => {
    expect(mapBridge(bridge, 7)).toEqual({ name: 'deploy-docs', state: 'failure', url: 'https://g/-/pipelines/99', runId: 7, stage: 'deploy', trigger: true, downstream: { id: 99, status: 'failed' } })
    expect(mapBridge({ id: 31, name: 'child', status: 'running' }, 7)).toMatchObject({ state: 'pending', trigger: true })
    expect(mapBridge({ id: 31, name: 'child', status: 'running' }, 7).downstream).toBeUndefined()
  })

  it('sits among the jobs in pipeline order, failures first', () => {
    const rows = mapJobs([{ id: 10, name: 'lint', status: 'success' }, { id: 40, name: 'e2e', status: 'success' }], 7, [{ ...bridge, status: 'success', id: 20 }])
    expect(rows.map((r) => r.name)).toEqual(['lint', 'deploy-docs', 'e2e'])
    expect(mapJobs([{ id: 10, name: 'lint', status: 'success' }], 7, [bridge]).map((r) => r.name)).toEqual(['deploy-docs', 'lint'])
  })

  it('is read from the pipeline’s /bridges list with the jobs', async () => {
    const mr: RawMergeRequest = { iid: 5, title: 't', state: 'opened', web_url: 'https://gitlab.com/a/b/-/merge_requests/5', source_branch: 's', target_branch: 'main', head_pipeline: { id: 7, status: 'failed' } }
    const base = 'https://gitlab.com/api/v4/projects/a%2Fb'
    const { fetch } = fakeFetch({ [`${base}/merge_requests/5`]: mr, [`${base}/pipelines/7/jobs`]: [{ id: 10, name: 'lint', status: 'success' }], [`${base}/pipelines/7/bridges`]: [bridge] })
    const { pr } = await mergeRequestInfo(new GitlabApi(normalizeGitlabHost('gitlab.com'), 't', fetch), 'a/b', 5)
    expect(pr.checks.map((c) => [c.name, c.trigger ?? false])).toEqual([
      ['deploy-docs', true],
      ['lint', false]
    ])
    // A failed trigger job can be retried with the pipeline (its runId), but has no trace to read.
    expect(pr.checks[0]).toMatchObject({ runId: 7 })
    expect(pr.checks[0].jobId).toBeUndefined()
    expect(mapMergeRequest(mr, null, []).checks).toEqual([])
  })
})

describe('glab in the agent’s system prompt', () => {
  it('names the host always, and glab only once it is known to be signed in', () => {
    const host = normalizeGitlabHost('acme.dev/gitlab')
    expect(gitlabAgentContext(host, undefined)).toHaveLength(1)
    expect(gitlabAgentContext(host, undefined)[0]).toContain('https://acme.dev/gitlab')
    expect(gitlabAgentContext(host, false)).toHaveLength(1)
    expect(gitlabAgentContext(host, true)[1]).toMatch(/`glab` is installed and signed in/)
  })

  it('asks glab once per host, answers from memory until it is old, and never waits', async () => {
    let now = 0
    const asked: string[] = []
    const logins = new GlabLogins(
      async (h) => {
        asked.push(h)
        return h === 'gitlab.com'
      },
      () => now,
      1000
    )
    expect(logins.signedIn('gitlab.com')).toBeUndefined()
    expect(logins.signedIn('gitlab.com')).toBeUndefined()
    await logins.refresh('gitlab.com')
    expect(asked).toEqual(['gitlab.com'])
    expect(logins.signedIn('gitlab.com')).toBe(true)
    expect(asked).toEqual(['gitlab.com'])
    now = 2000
    expect(logins.signedIn('gitlab.com')).toBe(true)
    await logins.refresh('gitlab.com')
    expect(asked).toEqual(['gitlab.com', 'gitlab.com'])
    // A failing check is "not signed in", not an error.
    const broken = new GlabLogins(async () => {
      throw new Error('no glab')
    })
    expect(await broken.refresh('acme.dev')).toBe(false)
  })
})

describe('MR !N for GitLab', () => {
  const hosts = ['https://acme.dev/gitlab']
  it('knows a GitLab workspace from its MR, its last read, or its repo’s remote', () => {
    expect(isGitlabWorkspace({ pullRequest: { gitlabHost: 'acme.dev' } })).toBe(true)
    expect(isGitlabWorkspace({ prInfo: { facts: { provider: 'gitlab' } } })).toBe(true)
    expect(isGitlabWorkspace({ prInfo: { facts: { provider: 'github' } } }, { remote: 'origin', remoteUrl: 'https://gitlab.com/a/b' })).toBe(false)
    expect(isGitlabWorkspace({}, { remote: 'origin', remoteUrl: 'git@acme.dev:a/b.git' }, hosts)).toBe(true)
    expect(isGitlabWorkspace({}, { remote: 'origin', remoteUrl: 'git@github.com:a/b.git' }, hosts)).toBe(false)
    // Another remote's URL isn't known without git: not GitLab, rather than a guess.
    expect(isGitlabRepo({ remote: 'upstream', remoteUrl: 'https://gitlab.com/a/b' })).toBe(false)
  })

  it('words Home’s facts and refs', () => {
    expect(prRefText(87, true)).toBe('MR !87')
    expect(prRefText(87, false)).toBe('PR #87')
    expect(finishedFacts(1, { outcome: 'completed', endedAt: '' }, 42, 'MERGED', true)).toContain('MR !42 merged')
    expect(finishedFacts(1, { outcome: 'completed', endedAt: '' }, 42, 'OPEN')).toContain('PR #42')
  })
})
