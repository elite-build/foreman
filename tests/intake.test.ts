import { appendFileSync } from 'node:fs'
import { stubGh } from './ghHarness'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/main/cliServer'
import { fetchGithubLink, remoteForRepo, resolveGithubLink } from '../src/main/intake'
import { pullRequest } from '../src/main/github'
import { defaultSettings, Store } from '../src/main/store'
import { Environment } from '../src/main/environment'
import { SecretStore } from '../src/main/secrets'
import { WorkspaceService } from '../src/main/workspaces'
import { git, gitOut } from '../src/main/git'
import { fillIssuePlaceholders, findGithubLink, githubSlug, intakeFile, intakeLine, isIssuePlaceholder, remoteForSlug, type GithubLinkInfo } from '../src/shared/githubLink'
import type { CreateWorkspaceOptions, Repo, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { commit, makeRepo, tempDir } from './helpers'
import { wsPath } from '../src/shared/workspacePath'

const PR_JSON = {
  number: 7,
  title: 'Fix the thing',
  body: 'Please merge.',
  url: 'https://github.com/acme/widgets/pull/7',
  state: 'OPEN',
  comments: [{ author: { login: 'bob' }, body: 'Looks fine', createdAt: '2026-01-01' }, { author: null, body: 'second' }],
  headRefName: 'feat/x',
  headRepository: { name: 'widgets' },
  headRepositoryOwner: { login: 'alex' },
  isCrossRepository: true,
  baseRefName: 'main'
}

describe('GitHub links', () => {
  it('finds the first issue or PR URL in text', () => {
    expect(findGithubLink('Review https://github.com/acme/widgets/pull/7 and fix')).toEqual({ kind: 'pr', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7' })
    expect(findGithubLink('see https://github.com/acme/widgets/issues/12#issuecomment-1.')).toMatchObject({ kind: 'issue', number: 12 })
    expect(findGithubLink('https://github.com/acme/widgets/pulls')).toBeNull()
    expect(findGithubLink('https://example.com/acme/widgets/pull/7')).toBeNull()
  })

  it('matches remote URLs in every form', () => {
    for (const url of ['https://github.com/Acme/widgets.git', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets', 'https://token@github.com/acme/widgets/']) {
      expect(githubSlug(url)?.toLowerCase()).toBe('acme/widgets')
    }
    expect(githubSlug('/some/local/path')).toBeNull()
    const remotes = 'origin\thttps://github.com/alex/widgets.git (fetch)\norigin\thttps://github.com/alex/widgets.git (push)\nupstream\tgit@github.com:acme/widgets.git (fetch)'
    expect(remoteForSlug(remotes, 'ACME/widgets')).toBe('upstream')
    expect(remoteForSlug(remotes, 'other/repo')).toBeNull()
  })

  it('fills the issue placeholder only for issues', () => {
    const issue = findGithubLink('https://github.com/acme/widgets/issues/12')!
    const pr = findGithubLink('https://github.com/acme/widgets/pull/7')!
    expect(fillIssuePlaceholders('Fix {{issue id}} and close {{ Issue }}', issue)).toBe('Fix acme/widgets#12 and close acme/widgets#12')
    expect(fillIssuePlaceholders('Fix {{issue id}}', pr)).toBe('Fix {{issue id}}')
    expect(fillIssuePlaceholders('Fix {{file}}', issue)).toBe('Fix {{file}}')
    expect(isIssuePlaceholder('issue id')).toBe(true)
    expect(isIssuePlaceholder('bug id')).toBe(false)
  })

  it('describes a PR on one line and attaches its text as untrusted', async () => {
    const info = await fetchGithubLink(findGithubLink(PR_JSON.url)!, '/', async () => JSON.stringify(PR_JSON))
    expect(intakeLine(info)).toBe('PR #7 · head alex:feat/x (fork) · base main · 2 comments')
    expect(intakeLine({ ...info, isFork: false, comments: [] })).toBe('PR #7 · head feat/x · base main')
    expect(intakeLine({ kind: 'issue', repo: 'acme/widgets', number: 12 } as GithubLinkInfo)).toBe('Issue #12 in acme/widgets')
    const file = intakeFile(info)
    expect(file.name).toBe('PR 7.md')
    expect(file.content).toMatch(/untrusted data/)
    expect(file.content).toContain('Please merge.')
    expect(file.content).toContain('### bob')
  })

  it('asks gh for the fields it needs and reports failures plainly', async () => {
    const calls: string[][] = []
    await fetchGithubLink(findGithubLink(PR_JSON.url)!, '/', async (_cwd, args) => (calls.push(args), JSON.stringify(PR_JSON)))
    expect(calls[0].slice(0, 3)).toEqual(['pr', 'view', PR_JSON.url])
    for (const field of ['headRefName', 'headRepository', 'headRepositoryOwner', 'isCrossRepository', 'baseRefName']) expect(calls[0][4]).toContain(field)
    await expect(fetchGithubLink(findGithubLink(PR_JSON.url)!, '/', async () => Promise.reject(new Error('not found')))).rejects.toThrow('Couldn’t read https://github.com/acme/widgets/pull/7: not found')
  })
})

/** A clone of a "GitHub" repo whose acme/widgets remote is a local upstream with refs/pull/7/head. */
async function forkSetup() {
  const upstream = await makeRepo({ 'a.txt': 'base\n' })
  await git(upstream, ['checkout', '-q', '-b', 'contrib'])
  await writeFile(path.join(upstream, 'a.txt'), 'from the pull request\n')
  await git(upstream, ['add', '-A'])
  await commit(upstream, 'pr work')
  await git(upstream, ['update-ref', 'refs/pull/7/head', 'HEAD'])
  await git(upstream, ['checkout', '-q', 'main'])
  await git(upstream, ['branch', '-D', 'contrib'])
  // The user's clone is of their own fork (origin); acme/widgets is a second remote.
  const fork = await makeRepo({ 'a.txt': 'base\n' })
  const clone = await tempDir()
  await git(path.dirname(clone), ['clone', '-q', fork, clone])
  await git(clone, ['remote', 'set-url', 'origin', 'https://github.com/alex/widgets.git'])
  await git(clone, ['remote', 'add', 'upstream', 'https://github.com/acme/widgets.git'])
  await git(clone, ['config', `url.${upstream}.insteadOf`, 'https://github.com/acme/widgets.git'])
  await git(clone, ['config', `url.${fork}.insteadOf`, 'https://github.com/alex/widgets.git'])
  return { upstream, clone }
}

async function service() {
  const dataDir = await tempDir('switchyard-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('switchyard-ws-')
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const svc: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, new Environment(secrets, () => store.state.settings, (id) => svc.repo(id)))
  return { store, svc }
}

async function settled(ws: Workspace) {
  for (let i = 0; i < 300 && (ws.state === 'creating' || ws.state === 'setting-up'); i++) await new Promise((r) => setTimeout(r, 50))
}

describe('a workspace from a pull request', () => {
  it('fetches refs/pull/N/head from the remote the URL names, not origin', async () => {
    const { clone } = await forkSetup()
    expect(await remoteForRepo(clone, 'acme/widgets')).toBe('upstream')
    const { svc } = await service()
    const repo = await svc.addRepo(clone)
    const ws = await svc.createWorkspace(repo.id, { pullRequest: { repo: 'acme/widgets', number: 7 }, baseBranch: 'main' })
    await settled(ws)
    expect(ws.error).toBeUndefined()
    expect(ws.state).toBe('ready')
    expect(ws.branch).toBe('pr-7')
    expect(ws.pullRequest).toEqual({ repo: 'acme/widgets', number: 7 })
    expect(ws.baseBranch).toBe('main')
    expect(await gitOut(wsPath(ws), ['branch', '--show-current'])).toBe('pr-7')
    expect(await readFile(path.join(wsPath(ws), 'a.txt'), 'utf8')).toBe('from the pull request\n')
    expect(await svc.setupLog(ws.id)).toContain('git fetch upstream refs/pull/7/head:refs/heads/pr-7')
  })

  it('checks the same PR out again on a fresh branch', async () => {
    const { clone } = await forkSetup()
    const { svc } = await service()
    const repo = await svc.addRepo(clone)
    const first = await svc.createWorkspace(repo.id, { pullRequest: { repo: 'acme/widgets', number: 7 } })
    await settled(first)
    const second = await svc.createWorkspace(repo.id, { pullRequest: { repo: 'acme/widgets', number: 7 } })
    await settled(second)
    expect(second.state).toBe('ready')
    expect(second.branch).toMatch(/^pr-7-/)
  })

  it('refuses when no remote points at the PR’s repository', async () => {
    const { svc } = await service()
    const repo = await svc.addRepo(await makeRepo())
    await expect(svc.createWorkspace(repo.id, { pullRequest: { repo: 'acme/widgets', number: 7 } })).rejects.toThrow('points at acme/widgets')
    await expect(svc.createWorkspace(repo.id, { pullRequest: { repo: 'acme/widgets', number: 7 }, branch: { kind: 'direct', name: 'main' } })).rejects.toThrow('own new branch')
  })

  it('flags a PR link the repository cannot fetch', async () => {
    const repoDir = await makeRepo()
    const info = await resolveGithubLink(repoDir, PR_JSON.url, async () => JSON.stringify(PR_JSON))
    expect(info.problem).toMatch(/acme\/widgets/)
    const { clone } = await forkSetup()
    expect((await resolveGithubLink(clone, PR_JSON.url, async () => JSON.stringify(PR_JSON))).problem).toBeUndefined()
  })
})

describe('looking a PR up by number', () => {
  it('asks gh for the stored number in the base repository, falling back to the branch', async () => {
    const bin = await tempDir('fake-gh-')
    const log = path.join(bin, 'calls.txt')
    await writeFile(log, '')
    stubGh((args) => {
      appendFileSync(log, args.join(' ') + '\n')
      return { stdout: args[0] === '--version' ? 'gh' : JSON.stringify({ number: 7, url: 'u', title: 't', state: 'OPEN', statusCheckRollup: [] }) }
    })
    const base = { path: bin, branch: 'pr-7' } as Workspace
    const found = await pullRequest({ ...base, pullRequest: { repo: 'acme/widgets', number: 7 } })
    expect(found.kind === 'ok' && found.pr.number).toBe(7)
    await pullRequest(base)
    const calls = (await readFile(log, 'utf8')).split('\n').filter((l) => l.startsWith('pr view'))
    expect(calls[0]).toMatch(/^pr view 7 --repo acme\/widgets --json/)
    expect(calls[1]).toMatch(/^pr view pr-7 --json/)
  })
})

describe('foreman run with a GitHub URL', () => {
  const template = { id: 'fix', name: 'Fix an issue', body: 'Fix issue {{issue id}} and open a PR for {{issue id}}.' }
  async function runWith(values: string[], dryRun = false) {
    const created: CreateWorkspaceOptions[] = []
    const dir = await tempDir()
    const host = stubHost({
      state: () => ({ repos: [{ id: 'r', name: 'app', rootPath: dir } as Repo], workspaces: [], sessions: [], settings: { ...defaultSettings(), promptTemplates: [template] } }),
      createWorkspace: async (_id: string, options: CreateWorkspaceOptions) => {
        created.push(options)
        return { id: 'w', name: 'n', branch: 'b', path: '/p', pullRequest: options.githubUrl?.includes('/pull/') ? { repo: 'acme/widgets', number: 7 } : undefined } as Workspace
      },
    })
    const result = await run(host, { template: 'issue', values, cwd: dir, dryRun })
    return { result, created }
  }

  it('fills {{issue id}} from an issue URL and passes the URL on for its text', async () => {
    const { result, created } = await runWith(['https://github.com/acme/widgets/issues/12'])
    expect(result.prompt).toBe('Fix issue acme/widgets#12 and open a PR for acme/widgets#12.')
    expect(created[0].githubUrl).toBe('https://github.com/acme/widgets/issues/12')
  })

  it('passes a PR URL on and reports the checkout', async () => {
    const { result, created } = await runWith(['https://github.com/acme/widgets/pull/7'])
    expect(created[0].githubUrl).toBe('https://github.com/acme/widgets/pull/7')
    expect(result.pullRequest).toEqual({ repo: 'acme/widgets', number: 7 })
  })

  it('leaves ordinary values alone and a dry run alone', async () => {
    const { created } = await runWith(['ENG-1'])
    expect(created[0].githubUrl).toBeUndefined()
    expect((await runWith(['https://github.com/acme/widgets/issues/12'], true)).created).toEqual([])
  })
})
