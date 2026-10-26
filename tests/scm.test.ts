// O2: which provider a repository's remote belongs to, GitLab links and hosts. Pure, no network.
import { describe, expect, it } from 'vitest'
import { findGithubLink, intakeFile, intakeLine, type GithubLinkInfo } from '../src/shared/githubLink'
import {
  createMrInstructions,
  findGitlabLink,
  findScmLink,
  gitlabHosts,
  jobDuration,
  looksLikeGitlab,
  newMergeRequestUrl,
  normalizeGitlabHost,
  parseRemote,
  remoteForGitlabProject,
  scmForRemote,
  stripDraftTitle
} from '../src/shared/scm'
import { gitlabPrimary, primaryAction } from '../src/main/github'
import { ScmRouter } from '../src/main/scm'
import type { GitStatus, Repo } from '../src/shared/types'

const HOSTS = ['https://gitlab.acme.dev']

describe('choosing the provider by remote', () => {
  it('reads every remote form', () => {
    expect(parseRemote('git@gitlab.acme.dev:acme/ledger-api.git')).toEqual({ hostname: 'gitlab.acme.dev', path: 'acme/ledger-api', https: false })
    expect(parseRemote('ssh://git@gitlab.acme.dev:2222/acme/platform/ledger-api.git')).toEqual({ hostname: 'gitlab.acme.dev', path: 'acme/platform/ledger-api', https: false })
    expect(parseRemote('https://oauth2:secret@GitLab.com/acme/web.git/')).toEqual({ hostname: 'gitlab.com', path: 'acme/web', https: true })
    expect(parseRemote('/some/local/path')).toBeNull()
    expect(parseRemote('C:\\repos\\thing')).toBeNull()
    expect(parseRemote('file:///tmp/repo')).toBeNull()
  })

  it('gitlab.com is always GitLab, over https and ssh, with subgroups', () => {
    for (const url of ['https://gitlab.com/acme/platform/web.git', 'git@gitlab.com:acme/platform/web.git', 'ssh://git@gitlab.com/acme/platform/web']) {
      expect(scmForRemote(url, [])).toMatchObject({ kind: 'gitlab', host: { host: 'gitlab.com', url: 'https://gitlab.com' }, project: 'acme/platform/web' })
    }
  })

  it('a self-managed host is GitLab only once it is configured', () => {
    const url = 'git@gitlab.acme.dev:acme/ledger-api.git'
    expect(scmForRemote(url, [])).toEqual({ kind: 'github' })
    expect(scmForRemote(url, HOSTS)).toMatchObject({ kind: 'gitlab', host: { host: 'gitlab.acme.dev' }, project: 'acme/ledger-api' })
    // SSH on its own port still matches the host by name.
    expect(scmForRemote('ssh://git@gitlab.acme.dev:2222/acme/ledger-api.git', HOSTS)).toMatchObject({ kind: 'gitlab', project: 'acme/ledger-api' })
    expect(scmForRemote('https://gitlab.acme.dev/acme/ledger-api', ['gitlab.acme.dev'])).toMatchObject({ kind: 'gitlab' })
  })

  it('github.com, GitHub Enterprise, unknown hosts and no remote stay on GitHub', () => {
    for (const url of ['https://github.com/acme/web.git', 'git@github.com:acme/web.git', 'https://github.acme.dev/acme/web.git', 'git@code.example.org:acme/web.git', null, '']) {
      expect(scmForRemote(url, HOSTS)).toEqual({ kind: 'github' })
    }
  })

  it('hints at a GitLab-looking host that isn’t set up, and never guesses', () => {
    expect(looksLikeGitlab('git@gitlab.other.io:a/b.git', HOSTS)).toBe('gitlab.other.io')
    expect(looksLikeGitlab('git@gitlab.acme.dev:a/b.git', HOSTS)).toBeNull()
    expect(looksLikeGitlab('https://gitlab.com/a/b', [])).toBeNull()
    expect(looksLikeGitlab('https://github.com/a/b', [])).toBeNull()
  })

  it('finds the remote that points at a GitLab project', () => {
    const remotes = 'origin\tgit@gitlab.acme.dev:yatin/ledger-api.git (fetch)\nupstream\thttps://gitlab.acme.dev/Acme/Ledger-API.git (fetch)'
    expect(remoteForGitlabProject(remotes, 'gitlab.acme.dev', 'acme/ledger-api')).toBe('upstream')
    expect(remoteForGitlabProject(remotes, 'gitlab.com', 'acme/ledger-api')).toBeNull()
  })
})

describe('GitLab hosts in Settings', () => {
  it('normalizes what the user types, https only', () => {
    expect(normalizeGitlabHost('gitlab.acme.dev')).toEqual({ url: 'https://gitlab.acme.dev', host: 'gitlab.acme.dev' })
    // G2: a pasted MR link keeps the path before /-/ as a root candidate; saving tries each shorter one (rootCandidates).
    expect(normalizeGitlabHost(' https://GitLab.Acme.dev/acme/ledger-api/-/merge_requests/87 ')).toEqual({ url: 'https://gitlab.acme.dev/acme/ledger-api', host: 'gitlab.acme.dev', root: '/acme/ledger-api' })
    expect(normalizeGitlabHost('https://gitlab.acme.dev:8443')).toEqual({ url: 'https://gitlab.acme.dev:8443', host: 'gitlab.acme.dev:8443' })
    expect(() => normalizeGitlabHost('http://gitlab.acme.dev')).toThrow(/https/)
    expect(() => normalizeGitlabHost('')).toThrow()
    expect(() => normalizeGitlabHost('intranet')).toThrow(/full host name/)
    expect(() => normalizeGitlabHost('https://me:pw@gitlab.acme.dev')).toThrow()
  })

  it('always lists gitlab.com first, then each configured host once', () => {
    expect(gitlabHosts(['gitlab.acme.dev', 'https://gitlab.acme.dev/', 'http://bad', 'gitlab.com']).map((h) => h.host)).toEqual(['gitlab.com', 'gitlab.acme.dev'])
  })
})

describe('GitLab links', () => {
  it('finds merge request and issue URLs on any host, with subgroups', () => {
    expect(findGitlabLink('see https://gitlab.acme.dev/acme/platform/ledger-api/-/merge_requests/87#note_3 please')).toEqual({
      kind: 'pr',
      repo: 'acme/platform/ledger-api',
      number: 87,
      url: 'https://gitlab.acme.dev/acme/platform/ledger-api/-/merge_requests/87',
      gitlabHost: 'gitlab.acme.dev'
    })
    expect(findGitlabLink('https://gitlab.com/acme/web/-/issues/12')).toMatchObject({ kind: 'issue', number: 12, gitlabHost: 'gitlab.com' })
    expect(findGitlabLink('https://gitlab.com/acme/web/-/work_items/5')).toMatchObject({ kind: 'issue', url: 'https://gitlab.com/acme/web/-/issues/5' })
    expect(findGitlabLink('https://gitlab.com/acme/web/-/merge_requests')).toBeNull()
    expect(findGitlabLink('https://github.com/acme/web/pull/7')).toBeNull()
  })

  it('takes whichever link comes first, and GitHub links are unchanged', () => {
    expect(findScmLink('https://github.com/acme/web/pull/7 then https://gitlab.com/a/b/-/issues/1')?.gitlabHost).toBeUndefined()
    expect(findScmLink('https://gitlab.com/a/b/-/issues/1 then https://github.com/acme/web/pull/7')?.gitlabHost).toBe('gitlab.com')
    expect(findScmLink('https://github.com/acme/web/pull/7')).toEqual(findGithubLink('https://github.com/acme/web/pull/7'))
  })

  it('says MR !87 on one line and in the attached file', () => {
    const info: GithubLinkInfo = { ...findGitlabLink('https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/87')!, title: 'Move invoices', body: 'Do it.', comments: [], headRef: 'feat/x', baseRef: 'main', isFork: false }
    expect(intakeLine(info)).toBe('MR !87 · head feat/x · base main')
    const file = intakeFile(info)
    expect(file.name).toBe('MR 87.md')
    expect(file.content.split('\n')[0]).toBe('# MR acme/ledger-api!87: Move invoices')
    expect(file.content).toContain('untrusted data')
  })
})

describe('GitLab wording and helpers', () => {
  it('shows job run times as GitLab does', () => {
    expect([jobDuration(48), jobDuration(372), jobDuration(3780), jobDuration(undefined)]).toEqual(['48s', '6m 12s', '1h 03m', ''])
  })

  it('takes every draft prefix off a title', () => {
    expect(stripDraftTitle('Draft: Move invoices')).toBe('Move invoices')
    expect(stripDraftTitle('[Draft] (draft) Move invoices')).toBe('Move invoices')
    expect(stripDraftTitle('Drafting rules')).toBe('Drafting rules')
  })

  it('names the header’s next step in GitLab’s words', () => {
    const base: Omit<GitStatus, 'primary'> = { branch: 'b', baseRef: 'origin/main', hasRemote: true, ahead: 0, behind: 0, aheadBase: 1, behindBase: 0, uncommitted: 0, conflicted: false, onBase: false, ghAvailable: true, upstream: 'origin/b' }
    expect(gitlabPrimary(primaryAction(base))).toEqual({ action: 'create-pr', label: 'Create MR' })
    const pr = { number: 87, url: 'u', title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'main', checks: [{ name: 'eslint', state: 'failure' }] } as const
    expect(gitlabPrimary(primaryAction({ ...base, pr: { ...pr, checks: [...pr.checks] } }))).toMatchObject({ action: 'fix-errors', label: 'Pipeline failed' })
    // GitHub's labels stay as they were.
    expect(primaryAction({ ...base, pr: { ...pr, checks: [...pr.checks] } }).label).toBe('Checks failed')
  })

  it('links the new merge request page and tells the agent to use push options', () => {
    expect(newMergeRequestUrl('https://gitlab.acme.dev/acme/ledger-api', 'yatin/x', 'main')).toBe(
      'https://gitlab.acme.dev/acme/ledger-api/-/merge_requests/new?merge_request%5Bsource_branch%5D=yatin%2Fx&merge_request%5Btarget_branch%5D=main'
    )
    const text = createMrInstructions({ base: 'main', draft: true, customPrompt: '', hasDiffTool: false, remote: 'origin' })
    expect(text).toContain('-o merge_request.create -o merge_request.target=main')
    expect(text).toContain('-o merge_request.draft')
    expect(text).not.toContain('gh pr create')
  })
})

describe('the router', () => {
  const repo = (patch: Partial<Repo>): Repo => ({ id: 'r', name: 'ledger-api', rootPath: '/r', defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: '', ...patch })

  it('gives GitHub repos the gh provider as their linked account, and GitLab repos their host’s token', async () => {
    let url: string | null = 'https://github.com/acme/web.git'
    let hosts: string[] = []
    const tokens: string[] = []
    const router = new ScmRouter({
      repo: () => repo({ githubAccount: 'work' }),
      remoteUrl: async () => url,
      gitlabHosts: () => hosts,
      gitlabToken: (h) => (tokens.push(h), 'glpat-x')
    })
    const github = await router.forRepo('r')
    expect(github.kind).toBe('github')
    expect(github.identity).toBe('work')
    expect(router.identity('r')).toBe('work')

    url = 'git@gitlab.acme.dev:acme/ledger-api.git'
    hosts = HOSTS
    router.forget()
    const gitlab = await router.forRepo('r')
    expect(gitlab.kind).toBe('gitlab')
    expect(gitlab.identity).toBe('gitlab:gitlab.acme.dev')
    expect(router.identity('r')).toBe('gitlab:gitlab.acme.dev')
    expect(await gitlab.available()).toBe(true)
    expect(tokens).toEqual(['gitlab.acme.dev'])
  })

  it('remembers remote URLs for a while, and looks again when the remote changes', async () => {
    let now = 0
    let calls = 0
    let r = repo({ remoteUrl: 'https://gitlab.com/acme/web.git' })
    const router = new ScmRouter({ repo: () => r, remoteUrl: async () => (calls++, 'https://gitlab.com/acme/web.git'), gitlabHosts: () => [], gitlabToken: () => undefined, now: () => now })
    // Before any look, the URL recorded when the repo was added answers.
    expect(router.cachedTarget('r').kind).toBe('gitlab')
    await router.target('r')
    await router.target('r')
    expect(calls).toBe(1)
    now = 61_000
    await router.target('r')
    expect(calls).toBe(2)
    r = { ...r, remote: 'upstream' }
    await router.target('r')
    expect(calls).toBe(3)
    // No token: the provider says so instead of asking.
    expect(await (await router.forRepo('r')).available()).toBe(false)
  })
})
