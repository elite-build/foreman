import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandHash } from '../src/main/checks'
import { CliCodedError } from '../src/main/cli/host'
import type { CliHost } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { tierCheck } from '../src/main/cli/policy'
import { REPO_SETTINGS_METHODS } from '../src/main/cli/repoSettings'
import { patchLocal, resolveRepoSettings } from '../src/main/repoSettings'
import { defaultSettings } from '../src/main/store'
import type { ChecksApproveResult, RepoAutoReviewResult, RepoChecksResult, RepoIntegrationsResult, RepoMcpResult, RepoScriptsResult, RepoSettingsFileResult, RepoSettingsGetResult, RepoSettingsListResult, RepoSettingsSetResult, RepoSettingsUnsetResult, RepoSetupResult } from '../src/shared/cli/repoSettings'
import { REPO_SETTINGS_SCHEMA } from '../src/shared/repoSettingsSchema'
import type { Api, AutoReviewShown, Repo, RepoMcpView, Settings, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { token } : undefined, signal: undefined, progress: () => undefined })

const TOML = `
suggest_followups = false
file_include_globs = [".env*", "config/*.local"]

[scripts]
checks_after_turn = true
run_mode = "concurrent"
setup = "npm install"

[git]
delete_branch_on_archive = true

[prompts]
general = "Be brief."

[[checks]]
name = "lint"
command = "npm run lint"

[scripts.run.dev]
command = "npm run dev"
default = true
`

async function rig(options: { toml?: string | null; settings?: Partial<Settings>; api?: Partial<Api>; host?: Partial<CliHost>; local?: Repo['local'] } = {}) {
  // Repositories are found by folder here, so a plain folder will do.
  const root = await tempDir('foreman-cli-repo-')
  if (options.toml !== null) {
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), options.toml ?? TOML)
  }
  const settings: Settings = { ...defaultSettings(), ...options.settings }
  const repo = { id: 'r1', name: 'app', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: options.local ?? {}, createdAt: '' } as Repo
  const ws = { id: 'w1', repoId: 'r1', name: 'tokyo', branch: 'tokyo', path: root, state: 'ready' } as Workspace
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown, effect?: (...args: unknown[]) => void) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      effect?.(...args)
      return result
    }
  const api = fakeApi({
    // The same thing the service does with the local layer, so what a command reads back is real.
    updateRepoSettings: record('updateRepoSettings', undefined, (id, patch) => void (repo.local = patchLocal(repo.local ?? {}, patch as never))) as Api['updateRepoSettings'],
    updateRepo: record('updateRepo') as Api['updateRepo'],
    setRepoIntegration: record('setRepoIntegration') as Api['setRepoIntegration'],
    setRepoIntegrationOptions: record('setRepoIntegrationOptions') as Api['setRepoIntegrationOptions'],
    setEnvFiles: record('setEnvFiles') as Api['setEnvFiles'],
    listRemotes: async () => ['origin', 'upstream'],
    repoIntegrations: async () => [],
    ...options.api
  })
  const host = stubHost({
    api,
    platform: 'win32',
    state: () => ({ repos: [repo], workspaces: [ws], sessions: [], settings }),
    resolvedRepoSettings: () => resolveRepoSettings(repo, settings),
    snapshot: () => ({ integrations: { connections: [{ id: 'c1', service: 'github', name: 'Work', isDefault: false }, { id: 'c2', service: 'github', name: 'Home', isDefault: true }, { id: 'v1', service: 'docker', name: 'Local', isDefault: false }] } }) as never,
    ...options.host
  })
  const call = async <T>(method: string, params: Record<string, unknown>, token?: string): Promise<T> => (await REPO_SETTINGS_METHODS[method].handle(host, { cwd: root, ...params }, ctx(token))) as T
  const set = (...pairs: [string, string][]) => call<RepoSettingsSetResult>('repo-settings-set', { pairs })
  return { root, repo, ws, host, calls, call, set, settings }
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

describe('repo settings list and get', () => {
  it('shows each value with the layer it comes from, from a real resolve over a committed file', async () => {
    const { call } = await rig({ settings: { pushAutoSetupRemote: false } })
    const list = await call<RepoSettingsListResult>('repo-settings-list', {})
    const row = (key: string) => list.rows.find((r) => r.key === key)!
    expect(row('scripts.checks-after-turn')).toMatchObject({ value: 'on', source: 'shared' })
    expect(row('scripts.run-mode')).toMatchObject({ value: 'concurrent', source: 'shared' })
    expect(row('git.delete-branch-on-archive')).toMatchObject({ value: 'on', source: 'shared' })
    // The committed file doesn't set it: the user's own setting does, and the row says which key.
    expect(row('git.push-auto-setup-remote')).toMatchObject({ value: 'off', source: 'user', userKey: 'git.push-auto-setup-remote' })
    expect(row('git.work-in-repo-folder')).toMatchObject({ value: 'off', source: 'default' })
    expect(row('actions.suggest-followups')).toMatchObject({ value: 'off', source: 'shared' })
    expect(row('actions.prompt-general')).toMatchObject({ value: 'Be brief.', source: 'shared' })
    // Fields of the repository itself.
    expect(row('git.base-branch')).toMatchObject({ value: 'main', source: 'repo' })
    expect(row('cloud.provider')).toMatchObject({ value: 'vercel', source: 'default' })
    expect(list.rows.map((r) => r.key)).toEqual(REPO_SETTINGS_SCHEMA.map((s) => s.key))
    expect(list.file).toEqual({ path: '.foreman/settings.toml', exists: true })
    expect(list.text).toMatch(/^Scripts$/m)
    expect(list.text).toMatch(/scripts\.checks-after-turn\s+on\s+\.foreman\/settings\.toml/)
    expect(list.text).toMatch(/git\.push-auto-setup-remote\s+off\s+your settings \(git\.push-auto-setup-remote\)/)
  })

  it('says what this computer overrides', async () => {
    const { call } = await rig({ local: { checksAfterTurn: false, runMode: 'exclusive' } })
    const list = await call<RepoSettingsListResult>('repo-settings-list', {})
    const row = list.rows.find((r) => r.key === 'scripts.checks-after-turn')!
    expect(row).toMatchObject({ value: 'off', source: 'local', inherited: { source: 'shared', value: 'on' } })
    expect(list.text).toMatch(/scripts\.checks-after-turn\s+off\s+this computer \(overrides \.foreman\/settings\.toml: on\)/)
  })

  it('lists only what the committed file sets with shared, or says there is no file', async () => {
    const shared = await (await rig()).call<RepoSettingsListResult>('repo-settings-list', { shared: true })
    expect(shared.rows.map((r) => r.key).sort()).toEqual(['actions.prompt-general', 'actions.suggest-followups', 'git.delete-branch-on-archive', 'repo.files-to-copy', 'scripts.checks-after-turn', 'scripts.run-mode'].sort())
    expect(shared.rows.every((r) => r.source === 'shared')).toBe(true)
    expect(shared.rows.find((r) => r.key === 'repo.files-to-copy')?.value).toBe('.env*, config/*.local')
    expect(shared.text).toContain('Committed settings for app: .foreman/settings.toml')
    const none = await (await rig({ toml: null })).call<RepoSettingsListResult>('repo-settings-list', { shared: true })
    expect(none.rows).toEqual([])
    expect(none.file.exists).toBe(false)
    expect(none.text).toContain('has no committed settings file')
    const broken = await (await rig({ toml: 'this is = = not toml' })).call<RepoSettingsListResult>('repo-settings-list', { shared: true })
    expect(broken.file.error).toMatch(/Could not read/)
  })

  it('gets several keys, and names the key it thinks was meant', async () => {
    const { call } = await rig()
    const got = await call<RepoSettingsGetResult>('repo-settings-get', { keys: ['scripts.run-mode', 'git.remote'] })
    expect(got.rows.map((r) => [r.key, r.value, r.source])).toEqual([['scripts.run-mode', 'concurrent', 'shared'], ['git.remote', 'origin', 'repo']])
    const err = await failure(call('repo-settings-get', { keys: ['run-mode'] }))
    expect(err.code).toBe('not-found')
    expect(err.message).toContain("'scripts.run-mode'")
  })

  it('finds the repository by name, or `.`, and refuses an unknown one', async () => {
    const { call, root } = await rig()
    expect((await call<RepoSettingsGetResult>('repo-settings-get', { keys: ['git.remote'], repo: 'app', cwd: path.dirname(root) })).repo.name).toBe('app')
    expect((await call<RepoSettingsGetResult>('repo-settings-get', { keys: ['git.remote'], repo: '.' })).repo.name).toBe('app')
    await expect(call('repo-settings-get', { keys: ['git.remote'], repo: 'nope' })).rejects.toThrow(/No repository named/)
  })
})

describe('repo settings set and unset', () => {
  it('writes this computer’s layer and says what it overrides', async () => {
    const { set, calls } = await rig()
    const result = await set(['scripts.checks-after-turn', 'off'])
    expect(calls).toEqual([['updateRepoSettings', 'r1', { checksAfterTurn: false }]])
    expect(result.changes[0]).toMatchObject({ key: 'scripts.checks-after-turn', value: 'off', was: 'on', wasSource: 'shared', overrides: { source: 'shared', value: 'on' } })
    expect(result.text).toBe('scripts.checks-after-turn  off  (was on, from .foreman/settings.toml; this computer now overrides it)')
  })

  it('writes several keys in one call, prompts included, and reads a value that came from the user’s settings', async () => {
    const { set, calls } = await rig({ settings: { archiveOnMerge: true } })
    const result = await set(['actions.prompt-general', 'Think first.\nThen act.'], ['actions.prompt-create-pr', 'Draft it.'], ['git.archive-on-merge', 'off'], ['git.sensitive-paths', '.env, secrets/**'])
    expect(calls).toEqual([['updateRepoSettings', 'r1', { prompts: { general: 'Think first.\nThen act.', createPr: 'Draft it.' }, archiveOnMerge: false, sensitivePaths: ['.env', 'secrets/**'] }]])
    expect(result.changes.find((c) => c.key === 'git.archive-on-merge')).toMatchObject({ was: 'on', wasSource: 'user', overrides: { source: 'user', value: 'on' } })
    expect(result.text).toContain('from your settings (git.archive-on-merge); this computer now overrides it')
  })

  it('mentions an earlier local value and what it hides', async () => {
    const { set } = await rig({ local: { runMode: 'exclusive' } })
    const result = await set(['scripts.run-mode', 'concurrent'])
    expect(result.text).toBe('scripts.run-mode  concurrent  (was exclusive; this computer overrides .foreman/settings.toml, which says concurrent)')
  })

  it('prints the consequence for the two settings that widen what agents may do, when switched on', async () => {
    const { set } = await rig()
    const on = await set(['actions.teach-agents', 'on'], ['actions.agents-may-start', 'yes'])
    expect(on.text).toContain('`foreman report`')
    expect(on.text).toContain('`foreman run`')
    const off = await set(['actions.teach-agents', 'off'])
    expect(off.changes[0].note).toBeUndefined()
  })

  it('writes nothing unless every key and value is valid', async () => {
    const { set, calls } = await rig()
    const err = await failure(set(['scripts.run-mode', 'sideways'], ['git.archive-on-merge', 'on'], ['scripts.setup-retry', 'perhaps']))
    expect(err.code).toBe('invalid')
    expect(err.message).toContain('sideways')
    expect(err.message).toContain('perhaps')
    expect((await failure(set(['scripts.nope', 'on']))).code).toBe('not-found')
    expect(calls).toEqual([])
  })

  it('sends the repository’s own fields to updateRepo', async () => {
    const { set, calls } = await rig()
    await set(['git.base-branch', 'develop'], ['git.remote', 'upstream'], ['repo.name', 'Renamed'], ['repo.icon', 'emoji:🚀'])
    expect(calls).toEqual([['updateRepo', 'r1', { defaultBranch: 'develop', remote: 'upstream', name: 'Renamed', icon: { kind: 'emoji', value: '🚀' } }]])
    const single = await rig()
    await single.set(['git.base-branch', 'develop'])
    expect(single.calls).toEqual([['updateRepo', 'r1', { defaultBranch: 'develop' }]])
  })

  it('checks the remote against the repository’s remotes', async () => {
    const { set, calls } = await rig()
    const err = await failure(set(['git.remote', 'nowhere']))
    expect(err.code).toBe('invalid')
    expect(err.message).toContain('Remotes: origin, upstream')
    expect(calls).toEqual([])
  })

  it('checks cloud sizes and regions against the provider', async () => {
    const { set, calls } = await rig()
    // Vercel (the default) offers 2, 4 and 8 vCPUs.
    const bad = await failure(set(['cloud.vcpus', '3']))
    expect(bad.code).toBe('invalid')
    expect(bad.message).toContain('vercel offers 2, 4, 8 vCPUs')
    expect((await failure(set(['cloud.region', 'mars1']))).message).toContain('vercel regions are')
    expect(calls).toEqual([])
    await set(['cloud.vcpus', '4'], ['cloud.region', 'fra1'], ['cloud.enabled', 'on'], ['cloud.max-running', '3'])
    expect(calls).toEqual([['updateRepo', 'r1', { cloud: { vcpus: 4, region: 'fra1', enabled: true, maxRunning: 3 } }]])
    // The provider chosen in the same call decides: Docker has 1 vCPU and no regions.
    const docker = await rig()
    await docker.set(['cloud.provider', 'docker'], ['cloud.vcpus', '1'], ['cloud.region', ''])
    expect(docker.calls).toEqual([['updateRepo', 'r1', { cloud: { provider: 'docker', vcpus: 1, region: '' } }]])
    expect((await failure((await rig()).set(['cloud.provider', 'docker'], ['cloud.region', 'iad1']))).message).toContain('docker has no regions')
    // A repository whose own provider is E2B is checked against E2B.
    const e2b = await rig()
    e2b.repo.cloud = { enabled: true, provider: 'e2b', vcpus: 2, region: '', idleMinutes: 20, autoContinue: true, installScript: '' }
    expect((await failure(e2b.set(['cloud.vcpus', '1']))).message).toContain('e2b offers')
    expect((await failure(e2b.set(['cloud.idle-minutes', '0']))).code).toBe('invalid')
  })

  it('chooses an integration connection by name or id, and `default` or `off`', async () => {
    const { set, calls } = await rig()
    await set(['integrations.github-account', 'work'])
    await set(['integrations.github-account', 'c2'], ['integrations.slack', 'off'])
    await set(['integrations.github-account', 'DEFAULT'])
    expect(calls).toEqual([
      ['setRepoIntegration', 'r1', 'github', 'c1'],
      ['setRepoIntegration', 'r1', 'github', 'c2'],
      ['setRepoIntegration', 'r1', 'slack', 'off'],
      ['setRepoIntegration', 'r1', 'github', 'default']
    ])
    const err = await failure(set(['integrations.github-account', 'Nobody']))
    expect(err.code).toBe('invalid')
    expect(err.message).toContain("'Work'")
    expect(err.message).not.toContain("'Local'")
  })

  it('sends Slack rules and the allowed own MCP services to setRepoIntegrationOptions', async () => {
    const { set, calls } = await rig()
    await set(['integrations.slack-rules', 'off'], ['integrations.allow-own-mcp', 'linear, SLACK'])
    expect(calls).toEqual([['setRepoIntegrationOptions', 'r1', { rules: 'off', allowOwnMcp: ['linear', 'slack'] }]])
    expect((await failure(set(['integrations.allow-own-mcp', 'jira']))).code).toBe('invalid')
  })

  it('sends env files to setEnvFiles for the repository', async () => {
    const { set, calls } = await rig()
    await set(['repo.env-files', '.env.local, config/dev.env'])
    expect(calls).toEqual([['setEnvFiles', { kind: 'repo', repoId: 'r1' }, ['.env.local', 'config/dev.env']]])
  })

  it('unsets by patching null, and says what the key inherits again', async () => {
    const { call, calls } = await rig({ local: { checksAfterTurn: false, prompts: { general: 'mine' }, archiveOnMerge: true }, settings: { archiveOnMerge: false } })
    const result = await call<RepoSettingsUnsetResult>('repo-settings-unset', { keys: ['scripts.checks-after-turn', 'actions.prompt-general', 'git.archive-on-merge'] })
    expect(calls).toEqual([['updateRepoSettings', 'r1', { checksAfterTurn: null, prompts: { general: null }, archiveOnMerge: null }]])
    expect(result.changes).toEqual([
      { key: 'scripts.checks-after-turn', value: 'on', inherits: 'shared', hadLocalValue: true },
      { key: 'actions.prompt-general', value: 'Be brief.', inherits: 'shared', hadLocalValue: true },
      { key: 'git.archive-on-merge', value: 'off', inherits: 'user', hadLocalValue: true }
    ])
    expect(result.text).toMatch(/scripts\.checks-after-turn\s+on\s+\(inherits \.foreman\/settings\.toml again\)/)
    expect(result.text).toContain('(inherits your settings (git.archive-on-merge) again)')
  })

  it('has nothing to do for a key this computer doesn’t set', async () => {
    const { call, calls } = await rig()
    const result = await call<RepoSettingsUnsetResult>('repo-settings-unset', { keys: ['scripts.checks-after-turn'] })
    expect(calls).toEqual([])
    expect(result.changes[0]).toMatchObject({ hadLocalValue: false, value: 'on' })
    expect(result.text).toContain('nothing was set on this computer')
  })

  it('refuses to unset what has no layer under it', async () => {
    const { call, calls } = await rig()
    for (const key of ['git.base-branch', 'cloud.vcpus', 'integrations.github-account', 'repo.env-files', 'repo.name']) {
      const err = await failure(call('repo-settings-unset', { keys: [key] }))
      expect(err.code, key).toBe('invalid')
      expect(err.message, key).toContain('can’t be unset; set a value instead')
    }
    expect(calls).toEqual([])
  })

  it('has the changing methods in the admin tier, and a turn token is refused', async () => {
    const { host } = await rig()
    for (const method of ['repo-settings-set', 'repo-settings-unset', 'repo-setup', 'repo-scripts', 'repo-checks', 'checks-approve', 'repo-mcp-proposals', 'repo-auto-review']) {
      expect(REPO_SETTINGS_METHODS[method].tier, method).toBe('admin')
      expect(tierCheck(method, 'admin', { v: 2, method, params: {}, caller: { token: 't' }, token: 'test-token' }, host), method).toMatchObject({ code: 'refused' })
    }
    for (const method of ['repo-settings-list', 'repo-settings-get', 'repo-settings-file', 'repo-integrations', 'repo-setup-list', 'repo-scripts-list', 'repo-checks-list', 'checks-list', 'repo-mcp-list', 'repo-auto-review-status']) {
      expect(REPO_SETTINGS_METHODS[method].tier, method).toBe('read')
    }
  })
})

describe('repo settings file', () => {
  it('names the committed file, or where a new one would go, and opens it on request', async () => {
    const { call, calls } = await rig({ api: { openRepoSettingsFile: (async (id: string) => void 0) as Api['openRepoSettingsFile'] } })
    const here = await call<RepoSettingsFileResult>('repo-settings-file', {})
    expect(here).toMatchObject({ path: '.foreman/settings.toml', exists: true, opened: false })
    const opened = await call<RepoSettingsFileResult>('repo-settings-file', { open: true })
    expect(opened.opened).toBe(true)
    expect(calls).toEqual([])
    const none = await (await rig({ toml: null })).call<RepoSettingsFileResult>('repo-settings-file', {})
    expect(none).toMatchObject({ path: '.foreman/settings.toml', exists: false })
    expect(none.text).toContain('not there yet')
  })

  it('opens through the service, and never for an agent turn', async () => {
    const opened: string[] = []
    const { call } = await rig({ api: { openRepoSettingsFile: (async (id: string) => void opened.push(id)) as Api['openRepoSettingsFile'] } })
    await call('repo-settings-file', { open: true })
    expect(opened).toEqual(['r1'])
    expect((await failure(call('repo-settings-file', { open: true }, 'turn-token'))).code).toBe('refused')
    expect(opened).toEqual(['r1'])
    // Looking is fine from a turn.
    expect((await call<RepoSettingsFileResult>('repo-settings-file', {}, 'turn-token')).path).toBe('.foreman/settings.toml')
  })
})

describe('setup and archive steps', () => {
  it('lists the steps with the layer they come from', async () => {
    const { call } = await rig()
    const result = await call<RepoSetupResult>('repo-setup', { verb: 'list', target: 'setup' })
    expect(result.steps).toEqual([{ position: 1, name: 'Setup', command: 'npm install' }])
    expect(result.source).toBe('shared')
    expect(result.text).toContain('Setup steps for app (the committed settings file)')
    const archive = await call<RepoSetupResult>('repo-setup', { verb: 'list', target: 'archive' })
    expect(archive.steps).toEqual([])
    expect(archive.text).toContain('has no archive steps')
  })

  it('copies the committed steps to this computer before adding one, and says so', async () => {
    const { call, calls, repo } = await rig()
    const result = await call<RepoSetupResult>('repo-setup', { verb: 'add', target: 'setup', name: 'Seed', command: 'npm run seed', timeoutSec: 120, parallel: true })
    expect(calls).toEqual([['updateRepoSettings', 'r1', { setupSteps: [{ name: 'Setup', command: 'npm install' }, { name: 'Seed', command: 'npm run seed', timeoutSec: 120, parallel: true }], setupScript: null }]])
    expect(result.text).toContain('Added setup step \'Seed\'.')
    expect(result.text).toContain('Copied the 1 setup step from .foreman/settings.toml to this computer first.')
    expect(result.source).toBe('local')
    expect(result.steps.map((s) => s.name)).toEqual(['Setup', 'Seed'])
    expect(repo.local?.setupSteps).toHaveLength(2)
  })

  it('adds at a position, removes by name or number, moves, clears and inherits', async () => {
    const { call, calls, repo } = await rig({ toml: null, local: { setupSteps: [{ name: 'a', command: 'echo a' }, { name: 'b', command: 'echo b' }] } })
    await call('repo-setup', { verb: 'add', target: 'setup', name: 'first', command: 'echo 0', at: 1 })
    expect(repo.local?.setupSteps?.map((s) => s.name)).toEqual(['first', 'a', 'b'])
    await call('repo-setup', { verb: 'move', target: 'setup', from: 3, to: 1 })
    expect(repo.local?.setupSteps?.map((s) => s.name)).toEqual(['b', 'first', 'a'])
    await call('repo-setup', { verb: 'remove', target: 'setup', name: '2' })
    expect(repo.local?.setupSteps?.map((s) => s.name)).toEqual(['b', 'a'])
    await call('repo-setup', { verb: 'remove', target: 'setup', name: 'A' })
    expect(repo.local?.setupSteps?.map((s) => s.name)).toEqual(['b'])
    // One step called Setup with no limit is stored as the plain script, as the window does.
    await call('repo-setup', { verb: 'clear', target: 'setup' })
    expect(calls.at(-1)).toEqual(['updateRepoSettings', 'r1', { setupScript: '', setupSteps: null }])
    await call('repo-setup', { verb: 'inherit', target: 'setup' })
    expect(calls.at(-1)).toEqual(['updateRepoSettings', 'r1', { setupScript: null, setupSteps: null }])
    expect(repo.local?.setupSteps).toBeUndefined()
  })

  it('checks the arguments', async () => {
    const { call, calls } = await rig({ toml: null, local: { setupSteps: [{ name: 'a', command: 'echo a' }] } })
    const bad = (params: Record<string, unknown>) => failure(call('repo-setup', { target: 'setup', ...params }))
    expect((await bad({ verb: 'add', name: 'a', command: 'x' })).message).toContain('already a setup step called')
    expect((await bad({ verb: 'add', name: '', command: 'x' })).code).toBe('invalid')
    expect((await bad({ verb: 'add', name: 'b' })).code).toBe('invalid')
    expect((await bad({ verb: 'add', name: 'b', command: 'x', timeoutSec: -3 })).code).toBe('invalid')
    expect((await bad({ verb: 'add', name: 'b', command: 'x', at: 5 })).code).toBe('invalid')
    expect((await bad({ verb: 'remove', name: 'zzz' })).code).toBe('not-found')
    expect((await bad({ verb: 'move', from: 1, to: 4 })).code).toBe('invalid')
    expect((await bad({ verb: 'frobnicate' })).code).toBe('invalid')
    expect((await failure(call('repo-setup', { verb: 'list', target: 'teardown' }))).code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('works on the archive steps the same way', async () => {
    const { call, repo } = await rig({ toml: null })
    await call('repo-setup', { verb: 'add', target: 'archive', name: 'Backup', command: 'tar czf x', timeoutSec: 30 })
    expect(repo.local?.archiveSteps).toEqual([{ name: 'Backup', command: 'tar czf x', timeoutSec: 30 }])
    expect(repo.local?.setupSteps).toBeUndefined()
  })

  it('has a read twin that lists', async () => {
    const { call, calls } = await rig()
    const result = await call<RepoSetupResult>('repo-setup-list', { target: 'setup', verb: 'clear' })
    expect(result.steps).toHaveLength(1)
    expect(calls).toEqual([])
  })
})

describe('run scripts and checks', () => {
  it('adds, defaults and removes run scripts on this computer, and won’t touch a committed one', async () => {
    const { call, repo } = await rig()
    const list = await call<RepoScriptsResult>('repo-scripts', { verb: 'list' })
    expect(list.scripts).toEqual([{ name: 'dev', command: 'npm run dev', icon: 'play', default: true, hidden: false, source: 'shared' }])
    await call('repo-scripts', { verb: 'add', name: 'docs', command: 'npm run docs', icon: 'book', previewUrl: 'http://localhost:$FOREMAN_PORT' })
    expect(repo.local?.runScripts).toEqual([{ name: 'docs', command: 'npm run docs', icon: 'book', previewUrl: 'http://localhost:$FOREMAN_PORT' }])
    const made = await call<RepoScriptsResult>('repo-scripts', { verb: 'set-default', name: 'docs' })
    expect(made.scripts.find((s) => s.name === 'docs')).toMatchObject({ default: true, source: 'local' })
    expect(made.scripts.find((s) => s.name === 'dev')?.default).toBe(false)
    // Making a committed script the default copies it here.
    await call('repo-scripts', { verb: 'set-default', name: 'dev' })
    expect(repo.local?.runScripts?.map((s) => [s.name, Boolean(s.default)])).toEqual([['docs', false], ['dev', true]])
    const shared = await failure(call('repo-scripts', { verb: 'remove', name: 'zzz' }))
    expect(shared.code).toBe('not-found')
    await call('repo-scripts', { verb: 'remove', name: 'docs' })
    expect(repo.local?.runScripts?.map((s) => s.name)).toEqual(['dev'])
    await call('repo-scripts', { verb: 'remove', name: 'dev' })
    const committed = await failure(call('repo-scripts', { verb: 'remove', name: 'dev' }))
    expect(committed.code).toBe('invalid')
    expect(committed.message).toContain('committed settings file')
    expect((await failure(call('repo-scripts', { verb: 'add', name: 'x' }))).code).toBe('invalid')
  })

  it('adds and removes checks, and says they need approval', async () => {
    const { call, repo } = await rig()
    const list = await call<RepoChecksResult>('repo-checks', { verb: 'list' })
    expect(list.checks).toEqual([{ name: 'lint', command: 'npm run lint', source: 'shared' }])
    const added = await call<RepoChecksResult>('repo-checks', { verb: 'add', name: 'test', command: 'npm test' })
    expect(repo.local?.checks).toEqual([{ name: 'test', command: 'npm test' }])
    expect(added.text).toContain('needs approval before it first runs: foreman checks approve')
    expect(added.checks.map((c) => c.name)).toEqual(['lint', 'test'])
    expect((await failure(call('repo-checks', { verb: 'add', name: 'test', command: 'x' }))).code).toBe('invalid')
    expect((await failure(call('repo-checks', { verb: 'remove', name: 'lint' }))).message).toContain('committed settings file')
    await call('repo-checks', { verb: 'remove', name: 'test' })
    expect(repo.local?.checks).toEqual([])
  })
})

describe('checks approve', () => {
  const consent = (names: string[]) => (_id: string) => names.map((name) => ({ name, command: '', source: 'shared' as const }))

  it('lists the commands with their hashes and which are approved', async () => {
    const { call, calls } = await rig({ host: { checkConsent: consent(['lint']) } })
    const result = await call<ChecksApproveResult>('checks-approve', {})
    expect(result.items).toEqual([{ name: 'lint', command: 'npm run lint', hash: commandHash('npm run lint'), source: 'shared', approved: false }])
    expect(result.text).toContain('needs approval')
    expect(result.text).toContain(commandHash('npm run lint').slice(0, 12))
    expect(result.text).toContain('npm run lint')
    expect(calls).toEqual([])
    const approved = await (await rig({ host: { checkConsent: consent([]) } })).call<ChecksApproveResult>('checks-approve', {})
    expect(approved.items[0].approved).toBe(true)
    // Without the host's answer nothing claims to be approved.
    const unknown = await (await rig()).call<ChecksApproveResult>('checks-approve', {})
    expect(unknown.items[0].approved).toBeUndefined()
  })

  it('approves by the hashes it was shown and starts the checks', async () => {
    const runs: unknown[][] = []
    const { call } = await rig({ api: { runChecks: (async (...a: unknown[]) => (runs.push(a), { started: true })) as Api['runChecks'] } })
    const hash = commandHash('npm run lint')
    const result = await call<ChecksApproveResult>('checks-approve', { hashes: [hash] })
    expect(runs).toEqual([['w1', [hash]]])
    expect(result).toMatchObject({ started: true })
    expect(result.text).toBe('Approved 1 command and started the checks in tokyo.')
  })

  it('refuses hashes of a command that is no longer configured, and runs nothing', async () => {
    const runs: unknown[][] = []
    const { call } = await rig({ api: { runChecks: (async (...a: unknown[]) => (runs.push(a), { started: true })) as Api['runChecks'] } })
    const err = await failure(call('checks-approve', { hashes: [commandHash('npm run lint --fix')] }))
    expect(err.code).toBe('needs-consent')
    expect((await failure(call('checks-approve', { hashes: [] }))).code).toBe('invalid')
    expect(runs).toEqual([])
  })

  it('reports what still needs approval when the service didn’t start', async () => {
    const { call } = await rig({ api: { runChecks: (async () => ({ started: false, consent: [{ name: 'other', command: 'x', source: 'local' }] })) as Api['runChecks'] } })
    const result = await call<ChecksApproveResult>('checks-approve', { hashes: [commandHash('npm run lint')] })
    expect(result).toMatchObject({ started: false })
    expect(result.text).toContain('still waiting for approval of other')
  })

  it('has nothing to approve without checks', async () => {
    const { call } = await rig({ toml: 'suggest_followups = true\n' })
    expect((await failure(call('checks-approve', {}))).code).toBe('not-found')
  })

  it('has a read twin that only lists, even when hashes are sent', async () => {
    const { call } = await rig({ host: { checkConsent: consent(['lint']) } })
    const result = await call<ChecksApproveResult>('checks-list', { hashes: [commandHash('npm run lint')] })
    expect(result.started).toBeUndefined()
    expect(result.items).toHaveLength(1)
  })
})

describe('repo mcp proposals', () => {
  const view: RepoMcpView = {
    proposals: [
      { server: { name: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: ['SENTRY_TOKEN'], scopes: ['repo'] }, fingerprint: 'aaaaaaaaaaaaaaaaaaaa', scripts: [], state: 'new', missingEnv: ['SENTRY_TOKEN'] },
      { server: { name: 'db', command: './scripts/mcp-db.sh', args: [], env: [], scopes: ['repo'] }, fingerprint: 'bbbbbbbbbbbbbbbbbbbb', scripts: [{ path: 'scripts/mcp-db.sh', hash: 'h' }], state: 'changed', missingEnv: [] }
    ],
    unseen: true,
    file: '.foreman/settings.toml'
  }

  it('lists the proposals with fingerprints', async () => {
    const { call } = await rig({ api: { repoMcp: (async () => view) as Api['repoMcp'] } })
    const result = await call<RepoMcpResult>('repo-mcp-proposals', {})
    expect(result.proposals.map((p) => [p.name, p.state, p.fingerprint])).toEqual([['sentry', 'new', 'aaaaaaaaaaaaaaaaaaaa'], ['db', 'changed', 'bbbbbbbbbbbbbbbbbbbb']])
    expect(result.text).toContain('sentry  new  (fingerprint aaaaaaaaaaaa)')
    expect(result.text).toContain('db  changed since approved')
    expect(result.text).toContain('no value for SENTRY_TOKEN')
    expect(result.text).toContain('runs repository files: scripts/mcp-db.sh')
  })

  it('approves the named servers with the fingerprints shown, and says the others lose theirs', async () => {
    const approvals: unknown[][] = []
    const { call } = await rig({ api: { repoMcp: (async () => view) as Api['repoMcp'], approveRepoMcp: (async (...a: unknown[]) => void approvals.push(a)) as Api['approveRepoMcp'] } })
    const result = await call<RepoMcpResult>('repo-mcp-proposals', { approve: ['sentry'], shown: { sentry: 'aaaaaaaaaaaaaaaaaaaa', db: 'bbbbbbbbbbbbbbbbbbbb' } })
    expect(approvals).toEqual([['w1', ['sentry'], { sentry: 'aaaaaaaaaaaaaaaaaaaa', db: 'bbbbbbbbbbbbbbbbbbbb' }]])
    expect(result.text).toContain('Approved: sentry.')
    expect(result.text).toContain('Not approved now: db (an earlier approval of these is withdrawn).')
  })

  it('wants what the user saw, and a name that is proposed', async () => {
    const approvals: unknown[][] = []
    const { call } = await rig({ api: { repoMcp: (async () => view) as Api['repoMcp'], approveRepoMcp: (async (...a: unknown[]) => void approvals.push(a)) as Api['approveRepoMcp'] } })
    const unshown = await failure(call('repo-mcp-proposals', { approve: ['sentry'] }))
    expect(unshown.code).toBe('needs-confirmation')
    expect(unshown.message).toContain('fingerprint aaaaaaaaaaaa')
    expect((await failure(call('repo-mcp-proposals', { approve: ['nope'], shown: {} }))).code).toBe('not-found')
    expect(approvals).toEqual([])
    // Approving none withdraws every approval; it needs nothing shown.
    await call('repo-mcp-proposals', { approve: [] })
    expect(approvals).toEqual([['w1', [], {}]])
  })

  it('passes the service’s refusal on', async () => {
    const { call } = await rig({
      api: {
        repoMcp: (async () => view) as Api['repoMcp'],
        approveRepoMcp: (async () => {
          throw new Error('The MCP server “sentry” isn’t what you were shown')
        }) as Api['approveRepoMcp']
      }
    })
    await expect(call('repo-mcp-proposals', { approve: ['sentry'], shown: { sentry: 'old' } })).rejects.toThrow(/isn’t what you were shown/)
  })

  it('has a read twin that never approves', async () => {
    const { call } = await rig({ api: { repoMcp: (async () => view) as Api['repoMcp'] } })
    const result = await call<RepoMcpResult>('repo-mcp-list', { approve: ['sentry'], shown: { sentry: 'x' } })
    expect(result.approved).toBeUndefined()
  })
})

describe('repo auto review', () => {
  const shown: AutoReviewShown = {
    reviewer: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', fast: false },
    exclusions: ['*.md'],
    perDay: 6,
    maxMinutes: 10,
    idleMinutes: 5,
    readOnly: 'plan',
    prompt: 'Review the diff.\nBe kind.'
  }

  it('turns on only with what was previewed: the preview first, the consent second', async () => {
    const previews: unknown[][] = []
    const sets: unknown[][] = []
    const { call } = await rig({ api: { autoReviewPreview: (async (...a: unknown[]) => (previews.push(a), shown)) as Api['autoReviewPreview'], setAutoReview: (async (...a: unknown[]) => void sets.push(a)) as Api['setAutoReview'] } })
    const preview = await call<RepoAutoReviewResult>('repo-auto-review', { verb: 'on', reviewer: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, exclusions: ['*.md'] })
    expect(preview).toMatchObject({ needsConfirmation: true, enabled: false, preview: shown })
    expect(previews).toEqual([['r1', { reviewer: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', fast: false }, exclusions: ['*.md'] }]])
    expect(sets).toEqual([])
    expect(preview.text).toContain('Auto review for app would:')
    expect(preview.text).toMatch(/Review with\s+claude · claude-opus-5-5 · high/)
    expect(preview.text).toMatch(/Skip when only these change\s+\*\.md/)
    expect(preview.text).toMatch(/Budget\s+6 reviews a day, 10 minutes each/)
    expect(preview.text).toContain('    Review the diff.')
    const done = await call<RepoAutoReviewResult>('repo-auto-review', { verb: 'on', shown })
    expect(sets).toEqual([['r1', shown]])
    expect(done).toMatchObject({ enabled: true })
    expect(previews).toHaveLength(1)
  })

  it('previews the defaults when no reviewer is named, and turns off', async () => {
    const previews: unknown[][] = []
    const sets: unknown[][] = []
    const { call } = await rig({ api: { autoReviewPreview: (async (...a: unknown[]) => (previews.push(a), shown)) as Api['autoReviewPreview'], setAutoReview: (async (...a: unknown[]) => void sets.push(a)) as Api['setAutoReview'] } })
    await call('repo-auto-review', { verb: 'on' })
    expect(previews).toEqual([['r1', {}]])
    const off = await call<RepoAutoReviewResult>('repo-auto-review', { verb: 'off' })
    expect(sets).toEqual([['r1', null]])
    expect(off.enabled).toBe(false)
    expect((await failure(call('repo-auto-review', { verb: 'on', reviewer: { agent: 'claude' } }))).code).toBe('invalid')
    expect((await failure(call('repo-auto-review', { verb: 'maybe' }))).code).toBe('invalid')
  })

  it('reports the status from the repository', async () => {
    const off = await rig()
    expect((await off.call<RepoAutoReviewResult>('repo-auto-review-status', {})).text).toBe('Auto review is off for app.')
    const on = await rig()
    on.repo.autoReview = { ...shown, at: 'now' }
    const status = await on.call<RepoAutoReviewResult>('repo-auto-review-status', { verb: 'on' })
    expect(status).toMatchObject({ enabled: true, current: { exclusions: ['*.md'] } })
    expect(status.text).toContain('Auto review is on for app: claude · claude-opus-5-5 · high.')
    on.repo.autoReview = { ...shown, at: 'now', paused: { reason: 'What auto review covers changed.', at: 'now' } }
    const paused = await on.call<RepoAutoReviewResult>('repo-auto-review', { verb: 'status' })
    expect(paused.enabled).toBe(false)
    expect(paused.text).toContain('paused')
  })
})

describe('repo integrations', () => {
  it('lists each service with the connection it uses', async () => {
    const connection = { id: 'c2', service: 'github', name: 'Home' }
    const { call } = await rig({
      api: {
        repoIntegrations: (async () => [
          { service: 'github', choice: 'default', resolution: { state: 'ready', connection, source: 'default' }, ownServers: [], ownAllowed: false },
          { service: 'linear', choice: 'off', resolution: { state: 'none', source: 'repo', off: true }, ownServers: [], ownAllowed: false },
          { service: 'slack', choice: 'c9', resolution: { state: 'broken', source: 'repo', reason: 'missing', connectionId: 'c9' }, ownServers: [], ownAllowed: false }
        ]) as Api['repoIntegrations']
      }
    })
    const result = await call<RepoIntegrationsResult>('repo-integrations', {})
    expect(result.rows).toEqual([
      { service: 'github', choice: 'default', using: 'Home (the default)' },
      { service: 'linear', choice: 'off', using: 'off for this repository' },
      { service: 'slack', choice: 'c9', using: 'c9', problem: 'the chosen connection is gone' }
    ])
    expect(result.text).toContain('Integrations for app:')
  })
})
