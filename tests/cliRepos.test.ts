import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestV2 } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { repoOpsRunners } from '../src/cli/commands/repoOps'
import { renderCommandHelp } from '../src/cli/help'
import { confirm } from '../src/cli/output'
import { socketPath } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { REPOS_METHODS } from '../src/main/cli/repos'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, METHODS, startCliServer, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { COMMON_OPTIONS, commandName, findCommand } from '../src/shared/cliCommands'
import { REPO_OPS_COMMANDS } from '../src/shared/cliCommandsGit'
import type { AttentionResult, RepoAccountResult, RepoAddedResult, RepoBranchesResult, RepoFilesResult, RepoRemoveResult, RepoShowResult, RepoWorktreesResult, ReposListResult } from '../src/shared/cli/repos'
import type { AttentionEvent } from '../src/shared/attention'
import type { Api, MainEvent, Repo, Session, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const repo = (patch: Partial<Repo> = {}): Repo => ({ id: 'r1', name: 'app', rootPath: '/app', defaultBranch: 'main', remote: 'origin', hasOrigin: true, remoteUrl: 'git@github.com:o/app.git', local: {}, createdAt: '2026-09-01T10:00:00.000Z', ...patch }) as Repo
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: '2026-10-01T10:00:00.000Z', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session

const ctx = (token?: string, progress: [string, number | undefined][] = []): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: (text, percent) => void progress.push([text, percent]) })

const connection = { id: 'conn1', service: 'github', name: 'Work', identity: { user: 'yatin-work' }, isDefault: true }

function rig(options: { repos?: Repo[]; workspaces?: Workspace[]; sessions?: Session[]; api?: Partial<Api>; host?: Partial<CliHost>; snapshot?: Record<string, unknown> } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const added = repo({ id: 'r2', name: 'fresh', rootPath: '/code/fresh' })
  const api = fakeApi({
    addRepo: record('addRepo', added) as Api['addRepo'],
    cloneRepo: record('cloneRepo', added) as Api['cloneRepo'],
    quickStartRepo: record('quickStartRepo', added) as Api['quickStartRepo'],
    removeRepo: record('removeRepo') as Api['removeRepo'],
    listBranches: record('listBranches', [{ name: 'main', local: true, remote: true, isDefault: true, checkedOutAt: '/app' }, { name: 'fix-login', local: true, remote: false, isDefault: false }]) as Api['listBranches'],
    listRemotes: record('listRemotes', ['origin', 'upstream']) as Api['listRemotes'],
    listWorktrees: record('listWorktrees', [{ path: '/app', branch: 'main', head: 'abc1234def', isMain: true, dirty: 0 }, { path: '/x', branch: 'fix-login', head: 'def5678abc', isMain: false, dirty: 2, workspaceId: 'ws1' }]) as Api['listWorktrees'],
    detectRepoAccount: record('detectRepoAccount', { slug: 'o/app', account: 'yatin-work', pushers: ['yatin-work'] }) as Api['detectRepoAccount'],
    previewFilesToCopy: record('previewFilesToCopy', { files: ['.env', 'config/local.json'], fromWorktreeInclude: false, patterns: ['.env*', 'config/local.json'] }) as Api['previewFilesToCopy'],
    attentionHistory: record('attentionHistory', { events: [], seenAt: undefined }) as Api['attentionHistory'],
    markAttentionSeen: record('markAttentionSeen') as Api['markAttentionSeen'],
    ...options.api
  })
  const repos = options.repos ?? [repo({ integrations: { services: { github: 'conn1' } }, cloud: { enabled: true, provider: 'docker', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' } })]
  const host = stubHost({
    api,
    state: () => ({ repos, workspaces: options.workspaces ?? [ws()], sessions: options.sessions ?? [tab('s1')], settings: { ...defaultSettings(), cloneDirectory: '/home/me/repos' } }),
    snapshot: () => ({ integrations: { connections: [connection] }, repoTemplates: { r1: [{}, {}] }, ...options.snapshot }) as never,
    resolvedRepoSettings: () => ({ values: {}, sources: { checks: 'local', filesToCopy: 'local', archiveOnMerge: 'shared', theme: 'user' }, inherited: {}, sharedFile: '.foreman/settings.toml' }) as never,
    ...options.host
  })
  const call = async <T>(method: string, params: unknown, token?: string, progress?: [string, number | undefined][]): Promise<T> => (await REPOS_METHODS[method].handle(host, params, ctx(token, progress))) as T
  return { host, calls, call }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CliCodedError)
    return err as CliCodedError
  }
  throw new Error('expected a failure')
}

describe('the repository list', () => {
  it('has the richer rows, the old columns first', async () => {
    const { call, calls } = rig({ repos: [repo({ integrations: { services: { github: 'conn1' } }, cloud: { enabled: true, vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' } }), repo({ id: 'r3', name: 'solo', rootPath: '/solo', hasOrigin: false, defaultBranch: 'trunk' })] })
    const result = await call<ReposListResult>('repos-list', undefined)
    expect(result.repos).toEqual([
      { name: 'app', id: 'r1', path: '/app', defaultBranch: 'main', remote: 'origin', hasOrigin: true, account: 'yatin-work', cloud: true },
      { name: 'solo', id: 'r3', path: '/solo', defaultBranch: 'trunk', remote: '', hasOrigin: false, account: 'yatin-work', cloud: false }
    ])
    expect(result.text.split('\n')[0]).toMatch(/^app {3}\/app {3}main {3}origin +yatin-work {2}remote on$/)
    expect(result.text.split('\n')[1]).toContain('(no remote)')
    expect(calls).toEqual([])
  })

  it('still lists when the app can’t make a snapshot', async () => {
    const { call } = rig({ host: { snapshot: () => { throw new Error('no') } } })
    expect((await call<ReposListResult>('repos-list', undefined)).repos[0].account).toBeUndefined()
  })
})

describe('add, clone, init', () => {
  it('adds the folder, relative to where the command ran, and says when it was already there', async () => {
    const { call, calls } = rig()
    const result = await call<RepoAddedResult>('repo-add', { path: 'fresh', cwd: '/code' })
    expect(calls).toEqual([['addRepo', path.resolve('/code', 'fresh')]])
    expect(result).toMatchObject({ repo: { id: 'r2', name: 'fresh', path: '/code/fresh' } })
    expect(result.text).toBe('Added fresh (/code/fresh).')
    const again = rig({ repos: [repo({ id: 'r2', name: 'fresh' })] })
    expect((await again.call<RepoAddedResult>('repo-add', { path: '/code/fresh', cwd: '/' })).text).toContain('Already in Foreman')
  })

  it('forwards the clone’s progress events, and only its own, to the command', async () => {
    let listener: ((event: MainEvent) => void) | undefined
    const unsubscribed = vi.fn()
    const seen: [string, number | undefined][] = []
    const { call, calls } = rig({
      host: { onEvent: (l) => ((listener = l), unsubscribed) },
      api: {
        cloneRepo: (async (...args: unknown[]) => {
          calls.push(['cloneRepo', ...args])
          const cloneId = args[2] as string
          listener?.({ type: 'clone-progress', cloneId: 'someone-else', line: 'Receiving objects:  99%' })
          listener?.({ type: 'clone-progress', cloneId, line: "Cloning into 'fresh'..." })
          listener?.({ type: 'clone-progress', cloneId, line: 'Receiving objects:   45% (9/20)\rReceiving objects:  50% (10/20)\r' })
          listener?.({ type: 'state', snapshot: {} } as never)
          return repo({ id: 'r2', name: 'fresh', rootPath: '/home/me/repos/fresh' })
        }) as Api['cloneRepo']
      }
    })
    const result = await call<RepoAddedResult>('repo-clone', { url: 'https://github.com/o/fresh', cwd: '/' }, undefined, seen)
    expect(seen).toEqual([["Cloning into 'fresh'...", undefined], ['Receiving objects:  50% (10/20)', 50]])
    expect(calls[0].slice(0, 2)).toEqual(['cloneRepo', 'https://github.com/o/fresh'])
    expect(calls[0][2]).toBe('/home/me/repos')
    expect(typeof calls[0][3]).toBe('string')
    expect(calls[0][4]).toBeUndefined()
    expect(unsubscribed).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('Cloned and added fresh (/home/me/repos/fresh).')
  })

  it('clones into --into relative to the cwd, as an account, and stops listening when it fails', async () => {
    const unsubscribed = vi.fn()
    const { call, calls } = rig({ host: { onEvent: () => unsubscribed }, api: { cloneRepo: (async (...args: unknown[]) => (calls.push(['cloneRepo', ...args]), Promise.reject(new Error('fatal: repository not found')))) as Api['cloneRepo'] } })
    await expect(call('repo-clone', { url: 'u', into: 'src', account: ' work ', cwd: '/code' })).rejects.toThrow('repository not found')
    expect(calls[0][2]).toBe(path.resolve('/code', 'src'))
    expect(calls[0][4]).toBe('work')
    expect(unsubscribed).toHaveBeenCalledTimes(1)
    expect((await failure(call('repo-clone', { url: '  ', cwd: '/' }))).code).toBe('invalid')
  })

  it('creates a repository in --into or the clone folder', async () => {
    const { call, calls } = rig()
    await call('repo-init', { name: 'scratch', cwd: '/' })
    await call('repo-init', { name: 'notes', into: 'dev', cwd: '/code' })
    expect(calls).toEqual([['quickStartRepo', '/home/me/repos', 'scratch'], ['quickStartRepo', path.resolve('/code', 'dev'), 'notes']])
    expect((await failure(call('repo-init', { name: ' ' }))).code).toBe('invalid')
  })
})

describe('remove', () => {
  const two = [ws(), ws({ id: 'ws2', name: 'tokyo', branch: 'tokyo-b' }), ws({ id: 'ws3', name: 'old', branch: 'old-b', state: 'archived' }), ws({ id: 'ws9', repoId: 'other', name: 'elsewhere' })]

  it('without confirmed lists the workspaces that go with it and removes nothing', async () => {
    const { call, calls } = rig({ workspaces: two, sessions: [tab('s1', { status: 'running' })] })
    const result = await call<RepoRemoveResult>('repo-remove', { repo: 'app', cwd: '/' })
    expect(result.needsConfirmation).toBe(true)
    expect(result.workspaces.map((w) => w.name)).toEqual(['lisbon', 'tokyo', 'old'])
    expect(result.workspaces[0].running).toBe(true)
    expect(result.previewText).toContain('deletes 2 workspaces and 1 archived record')
    expect(result.previewText).toContain('lisbon  fix-login  RUNNING')
    expect(result.previewText).toContain('old  old-b  (archived)')
    expect(result.previewText).toContain('/app is not touched')
    expect(result.previewText).not.toContain('elsewhere')
    expect(calls).toEqual([])
  })

  it('removes it once confirmed, and needs the repository named', async () => {
    const { call, calls } = rig({ workspaces: two })
    const done = await call<RepoRemoveResult>('repo-remove', { repo: 'app', cwd: '/', confirmed: true })
    expect(done.removed).toBe(true)
    expect(calls).toEqual([['removeRepo', 'r1']])
    expect((await failure(call('repo-remove', { cwd: '/' }))).code).toBe('invalid')
    expect((await failure(call('repo-remove', { repo: ' ', cwd: '/' }))).code).toBe('invalid')
    await expect(call('repo-remove', { repo: 'ghost', cwd: '/' })).rejects.toThrow('No repository named')
  })
})

describe('show and its parts', () => {
  it('summarises the repository, its settings sources, templates, remote workspaces and integrations', async () => {
    const { call } = rig()
    const result = await call<RepoShowResult>('repo-show', { repo: 'app', cwd: '/' })
    expect(result.repo).toMatchObject({ id: 'r1', name: 'app', path: '/app', defaultBranch: 'main', remote: 'origin', remoteUrl: 'git@github.com:o/app.git' })
    expect(result.account).toBe('yatin-work')
    expect(result.workspaces).toEqual({ live: 1, archived: 0 })
    expect(result.settings).toEqual({ local: 2, shared: 1, user: 1, sharedFile: '.foreman/settings.toml' })
    expect(result.templates).toBe(2)
    expect(result.cloud).toMatchObject({ enabled: true, provider: 'docker', vcpus: 2, idleMinutes: 20 })
    expect(result.integrations).toEqual({ github: 'Work' })
    expect(result.text).toContain('2 set on this computer, 1 from .foreman/settings.toml, 1 from your settings')
    expect(result.text).toContain('on: docker, 2 vCPU, sleep after 20m idle')
    expect(result.text).toContain('github: Work')
  })

  it('leaves out what the app can’t say, and uses the repository it runs in without a name', async () => {
    const { call } = rig({ host: { snapshot: () => { throw new Error('no') }, resolvedRepoSettings: () => { throw new Error('no') } } })
    const result = await call<RepoShowResult>('repo-show', { cwd: '/app/sub' })
    expect(result.settings).toBeUndefined()
    expect(result.templates).toBeUndefined()
    expect(result.account).toBeUndefined()
    expect(result.text).toMatch(/shared file +none/)
  })

  it('lists branches, optionally fetching first', async () => {
    const { call, calls } = rig()
    const plain = await call<RepoBranchesResult>('repo-branches', { repo: 'app', cwd: '/' })
    await call('repo-branches', { repo: 'app', cwd: '/', fetch: true })
    expect(calls).toEqual([['listBranches', 'r1', undefined], ['listBranches', 'r1', { fetch: true }]])
    expect(plain.text).toBe(['main (default)  local + remote  checked out at /app', 'fix-login       local'].join('\n'))
  })

  it('lists remotes and worktrees', async () => {
    const { call, host } = rig()
    const remotes = await call<{ text: string }>('repo-remotes', { cwd: '/app' })
    expect(remotes.text).toBe('origin  (Foreman pushes and opens pull requests here)\nupstream')
    const trees = await call<RepoWorktreesResult>('repo-worktrees', { cwd: '/app' })
    expect(trees.text).toMatch(/^\/app {2}main +main checkout$/m)
    expect(trees.text).toContain('workspace lisbon, 2 files changed')
    expect(host.state().repos).toHaveLength(1)
  })

  it('shows the account, detects it, and saves only on request', async () => {
    const { call, calls } = rig()
    expect((await call<RepoAccountResult>('repo-account', { repo: 'app', cwd: '/' })).text).toBe('app uses the GitHub account yatin-work.')
    const detected = await call<RepoAccountResult>('repo-account', { repo: 'app', cwd: '/', detect: true })
    expect(calls).toEqual([['detectRepoAccount', 'r1', false]])
    expect(detected.text).toContain('yatin-work is the only one that can, so it is the pick.')
    expect(detected.text).toContain('Add --save')
    const saved = await call<RepoAccountResult>('repo-account', { repo: 'app', cwd: '/', detect: true, save: true })
    expect(calls.at(-1)).toEqual(['detectRepoAccount', 'r1', true])
    expect(saved).toMatchObject({ saved: true, account: 'yatin-work' })
    expect((await failure(call('repo-account', { repo: 'app', cwd: '/', save: true }))).code).toBe('invalid')
  })

  it('says why there is nothing to pick', async () => {
    const { call } = rig({ api: { detectRepoAccount: (async () => ({ slug: 'o/app', account: null, pushers: ['a', 'b'] })) as Api['detectRepoAccount'] } })
    expect((await call<RepoAccountResult>('repo-account', { repo: 'app', cwd: '/', detect: true })).text).toContain('More than one can push')
    const other = rig({ api: { detectRepoAccount: (async () => ({ slug: null, account: null, pushers: [] })) as Api['detectRepoAccount'] } })
    expect((await other.call<RepoAccountResult>('repo-account', { repo: 'app', cwd: '/', detect: true })).text).toContain('isn’t on github.com')
  })

  it('previews the files a new workspace would copy, with the patterns given', async () => {
    const { call, calls } = rig()
    const result = await call<RepoFilesResult>('repo-files-to-copy', { repo: 'app', cwd: '/', patterns: ['.env*', 'config/local.json'] })
    expect(calls).toEqual([['previewFilesToCopy', 'r1', ['.env*', 'config/local.json']]])
    expect(result.files).toEqual(['.env', 'config/local.json'])
    expect(result.text).toBe(['Patterns: .env*, config/local.json', '2 ignored files would be copied into a new workspace:', '  .env', '  config/local.json'].join('\n'))
    await call('repo-files-to-copy', { repo: 'app', cwd: '/' })
    expect(calls.at(-1)).toEqual(['previewFilesToCopy', 'r1', undefined])
  })
})

describe('attention', () => {
  const event = (id: string, at: string, patch: Partial<AttentionEvent> = {}): AttentionEvent => ({ id, kind: 'turn-ended', workspaceId: 'ws1', topic: 't', key: 'k', firstAt: at, at, count: 1, ...patch })

  it('lists newest first, names the workspace, folds repeats and marks what is newer than the last seen', async () => {
    const { call } = rig({
      api: {
        attentionHistory: (async () => ({
          events: [event('a', '2026-10-24T08:00:00.000Z', { kind: 'ci-failed', label: 'CI failed', count: 3 }), event('b', '2026-10-24T10:00:00.000Z', { kind: 'agent-report', workspaceId: 'gone', detail: 'Need a decision' })],
          seenAt: '2026-10-24T09:00:00.000Z'
        })) as Api['attentionHistory']
      }
    })
    const result = await call<AttentionResult>('attention', {})
    expect(result.events.map((e) => [e.id, e.workspace, e.unseen])).toEqual([['b', 'gone', true], ['a', 'lisbon', false]])
    expect(result.text.split('\n')).toEqual(['*  2026-10-24 10:00  agent-report  gone    Need a decision', '   2026-10-24 08:00  ci-failed     lisbon  CI failed  ×3', '* newer than the last time it was marked seen'])
  })

  it('says when there is nothing, and marks the history seen without resolving anything', async () => {
    const { call, calls } = rig()
    expect((await call<AttentionResult>('attention', { verb: 'list' })).text).toBe('Nothing has needed your attention lately.')
    const seen = await call<AttentionResult>('attention', { verb: 'seen' })
    expect(calls.map((c) => c[0])).toEqual(['attentionHistory', 'markAttentionSeen'])
    expect(seen.text).toContain('Marked the attention history as seen')
    expect((await failure(call('attention', { verb: 'shout' }))).code).toBe('invalid')
  })
})

describe('policy and the socket', () => {
  const SPEC_OF: Record<string, string> = {
    'repos-list': '',
    'repo-add': 'repo add',
    'repo-clone': 'repo clone',
    'repo-init': 'repo init',
    'repo-remove': 'repo remove',
    'repo-show': 'repo show',
    'repo-branches': 'repo branches',
    'repo-remotes': 'repo remotes',
    'repo-worktrees': 'repo worktrees',
    'repo-account': 'repo account',
    'repo-files-to-copy': 'repo files-to-copy',
    attention: 'attention'
  }

  it('gives each method the tier its command declares (repos-list backs `foreman repos`, which work.ts owns)', () => {
    expect(Object.keys(REPOS_METHODS).sort()).toEqual(Object.keys(SPEC_OF).sort())
    for (const [method, name] of Object.entries(SPEC_OF)) {
      if (!name) {
        expect(REPOS_METHODS[method].tier).toBe('read')
        continue
      }
      const spec = REPO_OPS_COMMANDS.find((c) => commandName(c) === name)
      expect(spec, name).toBeTruthy()
      expect(REPOS_METHODS[method].tier, method).toBe(spec!.tier)
    }
  })

  it('refuses add, clone, init, remove and account from any agent turn, and reads need no token', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    for (const method of ['repo-add', 'repo-clone', 'repo-init', 'repo-remove', 'repo-account']) {
      expect(tierCheck(method, REPOS_METHODS[method].tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host), method).toMatchObject({ code: 'refused' })
      expect(tierCheck(method, REPOS_METHODS[method].tier, { v: 2, method, params: {}, token: 'test-token' }, host), method).toBeNull()
    }
    for (const method of ['repos-list', 'repo-show', 'repo-branches', 'repo-remotes', 'repo-worktrees', 'repo-files-to-copy']) expect(tierCheck(method, REPOS_METHODS[method].tier, { v: 2, method, params: {}, caller }, host), method).toBeNull()
  })

  describe('over the socket', () => {
    let close: (() => void) | undefined
    afterEach(() => {
      close?.()
      for (const key of Object.keys(REPOS_METHODS)) delete METHODS[key]
    })

    it('streams the clone’s progress frames before its result, and refuses remove from a turn', async () => {
      Object.assign(METHODS, REPOS_METHODS)
      const dataDir = await tempDir()
      let listener: ((event: MainEvent) => void) | undefined
      const { host, calls } = rig({
        host: { onEvent: (l) => ((listener = l), () => undefined) },
        api: {
          cloneRepo: (async (_url: string, _dir: string, cloneId: string) => {
            listener?.({ type: 'clone-progress', cloneId, line: 'Receiving objects:  10% (1/10)' })
            return repo({ id: 'r2', name: 'fresh', rootPath: '/home/me/repos/fresh' })
          }) as Api['cloneRepo']
        }
      })
      const socket = socketPath(dataDir)
      const server = await startCliServer(socket, host)
      close = () => server.close()
      const frames: unknown[] = []
      const result = await requestV2<RepoAddedResult>(socket, 'repo-clone', { url: 'u', cwd: '/' }, { token: 'test-token', onProgress: (p) => frames.push(p) })
      expect(frames).toEqual([{ text: 'Receiving objects:  10% (1/10)', percent: 10 }])
      expect(result.repo.name).toBe('fresh')
      await expect(requestV2(socket, 'repo-remove', { repo: 'app', cwd: '/', confirmed: true }, { token: 'test-token', caller: { sessionId: 's', turnId: 't', token: 'k' } })).rejects.toMatchObject({ code: 'refused', exitCode: 7 })
      await expect(requestV2(socket, 'repo-show', { repo: 'ghost', cwd: '/' }, { token: 'test-token' })).rejects.toMatchObject({ code: 'not-found', exitCode: 8 })
      expect(calls).toEqual([])
    })
  })
})

describe('the commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
    const sent: [string, Record<string, unknown>][] = []
    const out: string[] = []
    const context: Context = {
      args,
      opts,
      json: Boolean(opts.json),
      quiet: false,
      yes: Boolean(opts.yes),
      cwd: '/work',
      send: (async (method: string, params?: unknown) => {
        sent.push([method, params as Record<string, unknown>])
        const answer = answers[method]
        return typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer
      }) as Context['send'],
      print: (value, text) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
      confirm: (question) => confirm(question, { yes: Boolean(opts.yes), interactive: false }),
      note: () => undefined,
      progress: () => undefined
    }
    return { context, sent, out }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  const plan: RepoRemoveResult = { repo: { id: 'r1', name: 'app' }, workspaces: [{ name: 'lisbon', branch: 'b', state: 'ready' }], needsConfirmation: true, previewText: 'Removing app deletes 1 workspace', text: 'Removing app deletes 1 workspace\nNothing was removed.' }

  it('repo remove without --yes and no terminal exits 6 after the preview, and removes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, sent } = fakeContext(['app'], {}, { 'repo-remove': plan })
    await expect(repoOpsRunners['repo remove'](context)).rejects.toMatchObject({ exitCode: 6, code: 'needs-confirmation' })
    expect(sent).toEqual([['repo-remove', { repo: 'app', cwd: '/work' }]])
    expect(console.error).toHaveBeenCalledWith('Removing app deletes 1 workspace')
  })

  it('repo remove --yes sends it again confirmed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, sent, out } = fakeContext(['app'], { yes: true }, { 'repo-remove': (p: Record<string, unknown>) => (p.confirmed ? { ...plan, needsConfirmation: undefined, removed: true, text: 'Removed app' } : plan) })
    await repoOpsRunners['repo remove'](context)
    expect(sent[1]).toEqual(['repo-remove', { repo: 'app', cwd: '/work', confirmed: true }])
    expect(out).toEqual(['Removed app'])
  })

  it('sends the words each command takes, and refuses what it can’t use', async () => {
    const answers = Object.fromEntries(['repo-add', 'repo-clone', 'repo-init', 'repo-show', 'repo-branches', 'repo-account', 'repo-files-to-copy', 'attention', 'repo-remotes', 'repo-worktrees'].map((m) => [m, { text: 'ok' }]))
    const run = async (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      const { context, sent } = fakeContext(args, opts, answers)
      await repoOpsRunners[name](context)
      return sent
    }
    expect(await run('repo add', ['.'])).toEqual([['repo-add', { path: '.', cwd: '/work' }]])
    expect(await run('repo clone', ['https://x/y.git'], { into: 'src', account: 'work' })).toEqual([['repo-clone', { url: 'https://x/y.git', into: 'src', account: 'work', cwd: '/work' }]])
    expect(await run('repo init', ['notes'], { into: '..' })).toEqual([['repo-init', { name: 'notes', into: '..', cwd: '/work' }]])
    expect(await run('repo show', [])).toEqual([['repo-show', { repo: undefined, cwd: '/work' }]])
    expect(await run('repo branches', ['api'], { fetch: true })).toEqual([['repo-branches', { repo: 'api', cwd: '/work', fetch: true }]])
    expect(await run('repo account', ['api'], { detect: true, save: true })).toEqual([['repo-account', { repo: 'api', cwd: '/work', detect: true, save: true }]])
    expect(await run('repo files-to-copy', [], { patterns: '.env*, config/*.json ,' })).toEqual([['repo-files-to-copy', { repo: undefined, cwd: '/work', patterns: ['.env*', 'config/*.json'] }]])
    expect(await run('attention', ['seen'])).toEqual([['attention', { verb: 'seen' }]])
    expect(await run('attention', [])).toEqual([['attention', { verb: 'list' }]])
    for (const [name, args, opts] of [
      ['repo add', [], {}],
      ['repo add', ['a', 'b'], {}],
      ['repo clone', [], {}],
      ['repo init', ['a', 'b'], {}],
      ['repo remove', [], {}],
      ['repo show', ['a', 'b'], {}],
      ['repo account', ['a'], { save: true }],
      ['repo files-to-copy', [], { patterns: ' , ' }],
      ['attention', ['shout'], {}]
    ] as [string, string[], Record<string, unknown>][]) {
      await expect(run(name, args, opts), `${name} ${args.join(' ')}`).rejects.toMatchObject({ exitCode: 2 })
    }
  })
})

describe('the command table', () => {
  it('resolves each path, with the repo settings commands left to their own table', () => {
    expect(findCommand(['repo', 'clone', 'https://x'], REPO_OPS_COMMANDS)).toMatchObject({ spec: { path: ['repo', 'clone'] }, rest: ['https://x'] })
    expect(findCommand(['repo', 'files-to-copy', '--patterns', 'a'], REPO_OPS_COMMANDS)).toMatchObject({ spec: { path: ['repo', 'files-to-copy'] } })
    expect(findCommand(['attention', 'seen'], REPO_OPS_COMMANDS)).toMatchObject({ spec: { path: ['attention'] }, rest: ['seen'] })
  })

  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of REPO_OPS_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(repoOpsRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      expect(help).toContain(spec.usage)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) {
        expect(help).toContain(example)
        expect(findCommand(example.replace(/^foreman /, '').split(' '), REPO_OPS_COMMANDS), example).toHaveProperty('spec')
      }
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, name).toBe(shorts.length)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(repoOpsRunners).sort()).toEqual(REPO_OPS_COMMANDS.map(commandName).sort())
  })

  it('keeps repo remove from the assistant, and parses the options each declares', () => {
    expect(REPO_OPS_COMMANDS.find((c) => commandName(c) === 'repo remove')?.noAssistant).toBeTruthy()
    const clone = REPO_OPS_COMMANDS.find((c) => commandName(c) === 'repo clone')!
    expect(parseCommandArgs(clone, ['https://x/y', '--into', 'src', '--account', 'work'])).toMatchObject({ positionals: ['https://x/y'], opts: { into: 'src', account: 'work' } })
    expect(() => parseCommandArgs(clone, ['https://x/y', '--fetch'])).toThrow('doesn’t take --fetch')
  })
})

describe('attention --words', () => {
  const event = (id: string, at: string, patch: Partial<AttentionEvent> = {}): AttentionEvent => ({ id, kind: 'turn-ended', workspaceId: 'ws1', topic: 't', key: 'k', firstAt: at, at, count: 1, ...patch })
  const NOW = Date.parse('2026-10-24T12:00:00.000Z')
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
  const withEvents = (events: AttentionEvent[], seenAt?: string, host: Partial<CliHost> = {}) =>
    rig({ api: { attentionHistory: (async () => ({ events, seenAt })) as Api['attentionHistory'] }, host })

  it('says a finished turn, a request still waiting and anything else with its recorded words', async () => {
    const { call } = withEvents(
      [
        event('a', at(180), { kind: 'ci-failed', label: 'CI failed', count: 3 }),
        event('b', at(2), { sessionId: 's1', outcome: 'completed' }),
        event('c', at(30), { kind: 'reason', reasonId: 'approvals', sessionId: 's1', label: 'Approve Bash' }),
        event('d', at(60), { kind: 'agent-report', workspaceId: 'gone', label: 'needs-input', detail: 'Need a decision' }),
        event('e', at(90), { sessionId: 's1', outcome: 'error' })
      ],
      at(100),
      { approvals: () => [{ id: 'x', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: { command: 'npm test' } }] }
    )
    const { text } = await call<AttentionResult>('attention', { words: true })
    // Times are read against the real clock, so check the sentences and the order, not the ages.
    const sentences = text.split('\n').map((line) => line.replace(/^[^:]+: /, ''))
    expect(sentences).toEqual([
      'Claude Code finished in lisbon. (new)',
      'Claude Code in lisbon wants to run Bash: npm test (new)',
      'gone, needs-input: Need a decision (new)',
      'Claude Code failed in lisbon. (new)',
      'lisbon, CI failed (3 times)'
    ])
    expect(text.split('\n')[0]).toMatch(/^(just now|\d+ (minute|hour|day)s? ago): /)
  })

  it('names what a request is once it is answered, from what was recorded, and says nothing happened lately', async () => {
    const answered = withEvents([event('c', at(30), { kind: 'reason', reasonId: 'approvals', sessionId: 's1', label: 'Approve Bash', detail: 'Login bug' })], at(0))
    expect((await answered.call<AttentionResult>('attention', { words: true })).text).toMatch(/: lisbon, Approve Bash: Login bug$/)
    const none = withEvents([])
    expect((await none.call<AttentionResult>('attention', { words: true })).text).toBe('Nothing has needed your attention lately.')
  })

  it('leaves the table and the data alone without the flag, and marking seen is unchanged', async () => {
    const { call } = withEvents([event('b', at(2), { sessionId: 's1', outcome: 'completed' })])
    const plain = await call<AttentionResult>('attention', {})
    expect(plain.text).toContain('turn-ended')
    const spoken = await call<AttentionResult>('attention', { words: true })
    expect(spoken.events).toEqual(plain.events)
    expect((await call<AttentionResult>('attention', { verb: 'seen', words: true })).text).toContain('Marked the attention history as seen')
    expect((await failure(call('attention', { words: 'yes' }))).code).toBe('invalid')
  })

  describe('the command', () => {
    const run = async (opts: Record<string, unknown>) => {
      const sent: [string, Record<string, unknown>][] = []
      const context = {
        args: [],
        opts,
        json: Boolean(opts.json),
        quiet: false,
        yes: false,
        cwd: '/work',
        send: (async (method: string, params?: unknown) => (sent.push([method, params as Record<string, unknown>]), { text: 'ok' })) as Context['send'],
        print: () => undefined,
        confirm: async () => false,
        note: () => undefined,
        progress: () => undefined
      } as Context
      await repoOpsRunners.attention(context)
      return sent
    }

    it('asks for words with --words, not with --json', async () => {
      expect(await run({ words: true })).toEqual([['attention', { verb: 'list', words: true }]])
      expect(await run({ words: true, json: true })).toEqual([['attention', { verb: 'list' }]])
      expect(await run({})).toEqual([['attention', { verb: 'list' }]])
    })

    it('is a declared option', () => {
      const spec = REPO_OPS_COMMANDS.find((c) => commandName(c) === 'attention')!
      expect(spec.options.words).toMatchObject({ type: 'boolean' })
      expect(parseCommandArgs(spec, ['--words']).opts.words).toBe(true)
    })
  })
})
