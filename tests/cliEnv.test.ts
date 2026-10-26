import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_METHODS } from '../src/main/cli/env'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { tierCheck } from '../src/main/cli/policy'
import { Environment } from '../src/main/environment'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { defaultSettings } from '../src/main/store'
import type { AgentKeySetResult, CloudTokenStatusResult, EnvFilesResult, EnvImportResult, EnvListResult, EnvRevealResult, EnvSetResult, GithubStatusResult, GitlabConnectionResult, KeysAgentsResult, KeysListResult, KeysSetResult, TokenSavedResult } from '../src/shared/cli/env'
import type { Api, EnvView, Repo, Settings } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { token } : undefined, signal: undefined, progress: () => undefined })

const repo = { id: 'r1', name: 'app', rootPath: path.resolve('/projects/app'), defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: '' } as Repo

function rig(extra: Partial<Api> = {}, settings: Partial<Settings> = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const current: Settings = { ...defaultSettings(), ...settings }
  const emptyView: EnvView = { vars: [{ key: 'TOKEN', origin: 'saved' }, { key: 'FROM_FILE', origin: 'file', file: '.env' }], files: [{ path: '.env', resolved: '/x/.env', count: 1 }] }
  const api = fakeApi({
    envView: async () => emptyView,
    setEnvVars: record('setEnvVars') as Api['setEnvVars'],
    setEnvFiles: record('setEnvFiles') as Api['setEnvFiles'],
    revealEnvVar: record('revealEnvVar', 'hunter2-the-long-secret') as Api['revealEnvVar'],
    ...extra
  })
  const host = stubHost({ api, state: () => ({ repos: [repo], workspaces: [], sessions: [], settings: current }) })
  const call = async <T>(method: string, params: unknown, token?: string): Promise<T> => (await ENV_METHODS[method].handle(host, params, ctx(token))) as T
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

const cwd = path.resolve('/projects/app')
const SECRET = 'sk-live-9f8e7d6c5b4a3210'

describe('env list', () => {
  it('shows names and origins, never a value', async () => {
    // A real vault holding a secret, read through the real Environment.
    const dir = await tempDir('foreman-cli-env-')
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), plain)
    secrets.setMany({ kind: 'user' }, [['API_SECRET', SECRET]])
    secrets.setMany({ kind: 'repo', repoId: 'r1' }, [['REPO_SECRET', SECRET]])
    const environment = new Environment(secrets, () => ({ ...defaultSettings(), envFiles: [] }), () => ({ ...repo, rootPath: dir }))
    const { call } = rig({ envView: async (scope) => environment.view(scope) })
    const user = await call<EnvListResult>('env-list', { cwd })
    expect(user.vars).toEqual([{ key: 'API_SECRET', origin: 'saved' }])
    expect(user.text).toContain('API_SECRET')
    expect(JSON.stringify(user)).not.toContain(SECRET)
    const forRepo = await call<EnvListResult>('env-list', { repo: 'app', cwd })
    expect(forRepo.scope).toEqual({ kind: 'repo', repo: { id: 'r1', name: 'app' } })
    expect(forRepo.vars.map((v) => v.key)).toEqual(['REPO_SECRET'])
    expect(forRepo.inherited?.map((v) => v.key)).toEqual(['API_SECRET'])
    expect(forRepo.text).toContain('Environment variables for app')
    expect(JSON.stringify(forRepo)).not.toContain(SECRET)
  })

  it('is a read method, and a turn token does not stop it', () => {
    const { host } = rig()
    const request = { v: 2 as const, method: 'env-list', params: {}, caller: { token: 't' } }
    expect(tierCheck('env-list', ENV_METHODS['env-list'].tier, request, host)).toBeNull()
  })

  it('refuses an unknown repository', async () => {
    const { call } = rig()
    await expect(call('env-list', { repo: 'nope', cwd })).rejects.toThrow(/No repository named/)
  })
})

describe('env set, unset, rename', () => {
  it('stores the value and prints only the last four characters', async () => {
    const { call, calls } = rig()
    const result = await call<EnvSetResult>('env-set', { key: 'API_KEY', value: SECRET, cwd })
    expect(calls).toEqual([['setEnvVars', { kind: 'user' }, [{ key: 'API_KEY', value: SECRET }]]])
    expect(result.text).toBe('Saved API_KEY for you (…3210).')
    expect(JSON.stringify(result)).not.toContain(SECRET)
    const forRepo = await call<EnvSetResult>('env-set', { key: 'API_KEY', value: 'short', repo: 'app', cwd })
    expect(calls[1]).toEqual(['setEnvVars', { kind: 'repo', repoId: 'r1' }, [{ key: 'API_KEY', value: 'short' }]])
    // A short value has no hint to give.
    expect(forRepo.text).toBe('Saved API_KEY for app.')
  })

  it('validates the name before anything is stored', async () => {
    const { call, calls } = rig()
    for (const key of ['1BAD', 'has space', 'a-b', '', 'x=y']) {
      expect((await failure(call('env-set', { key, value: 'v', cwd }))).code, key).toBe('invalid')
    }
    expect((await failure(call('env-set', { key: 'OK', cwd }))).code).toBe('invalid')
    expect(calls).toEqual([])
    await call('env-set', { key: '_ok_1', value: '', cwd })
    expect(calls).toHaveLength(1)
  })

  it('removes saved variables, and says why it can’t remove one from a file or a missing one', async () => {
    const { call, calls } = rig()
    const result = await call<{ removed: string[] }>('env-unset', { keys: ['TOKEN'], cwd })
    expect(result.removed).toEqual(['TOKEN'])
    expect(calls).toEqual([['setEnvVars', { kind: 'user' }, [{ key: 'TOKEN', value: null }]]])
    const file = await failure(call('env-unset', { keys: ['FROM_FILE'], cwd }))
    expect(file.code).toBe('invalid')
    expect(file.message).toContain('env file')
    expect((await failure(call('env-unset', { keys: ['NOPE'], cwd }))).code).toBe('not-found')
    expect(calls).toHaveLength(1)
  })

  it('renames by moving the value inside the app, with previousKey, and prints no value', async () => {
    const { call, calls } = rig()
    const result = await call<{ text: string }>('env-rename', { from: 'TOKEN', to: 'NEW_TOKEN', cwd })
    expect(calls).toEqual([
      ['revealEnvVar', { kind: 'user' }, 'TOKEN', 'own'],
      ['setEnvVars', { kind: 'user' }, [{ key: 'NEW_TOKEN', value: 'hunter2-the-long-secret', previousKey: 'TOKEN' }]]
    ])
    expect(result.text).toBe('Renamed TOKEN to NEW_TOKEN for you.')
    expect((await failure(call('env-rename', { from: 'TOKEN', to: 'FROM_FILE', cwd }))).code).toBe('invalid')
    expect((await failure(call('env-rename', { from: 'NOPE', to: 'X', cwd }))).code).toBe('not-found')
    expect((await failure(call('env-rename', { from: 'TOKEN', to: 'bad name', cwd }))).code).toBe('invalid')
  })
})

describe('env files and import', () => {
  it('lists, adds and removes env files through setEnvFiles', async () => {
    const { call, calls } = rig()
    const list = await call<EnvFilesResult>('env-files', { verb: 'list', cwd })
    expect(list.files).toEqual([{ path: '.env', resolved: '/x/.env', count: 1 }])
    await call('env-files', { verb: 'add', path: 'secrets.env', cwd })
    expect(calls[0]).toEqual(['setEnvFiles', { kind: 'user' }, ['.env', 'secrets.env']])
    await call('env-files', { verb: 'remove', path: '.env', repo: 'app', cwd })
    expect(calls[1]).toEqual(['setEnvFiles', { kind: 'repo', repoId: 'r1' }, []])
    expect((await failure(call('env-files', { verb: 'add', path: '.env', cwd }))).code).toBe('invalid')
    expect((await failure(call('env-files', { verb: 'remove', path: 'other.env', cwd }))).code).toBe('not-found')
  })

  it('imports entries, naming each as new or replacing, without values', async () => {
    const { call, calls } = rig()
    const entries = [['TOKEN', SECRET], ['BRAND_NEW', 'abc'], ['BRAND_NEW', 'last wins']]
    const dry = await call<EnvImportResult>('env-import', { entries, dryRun: true, cwd })
    expect(dry.names).toEqual([{ key: 'TOKEN', status: 'replaces' }, { key: 'BRAND_NEW', status: 'new' }])
    expect(dry.saved).toBe(false)
    expect(calls).toEqual([])
    expect(dry.text).not.toContain(SECRET)
    const done = await call<EnvImportResult>('env-import', { entries, cwd })
    expect(done.saved).toBe(true)
    expect(calls).toEqual([['setEnvVars', { kind: 'user' }, [{ key: 'TOKEN', value: SECRET }, { key: 'BRAND_NEW', value: 'last wins' }]]])
    expect(JSON.stringify(done)).not.toContain(SECRET)
    expect((await failure(call('env-import', { entries: [['bad name', 'x']], cwd }))).code).toBe('invalid')
  })
})

describe('reveal', () => {
  it('is refused with a turn token, before anything is read', async () => {
    const { call, calls } = rig({ revealProviderKey: (async () => 'secret') as Api['revealProviderKey'] })
    for (const [method, params] of [['env-reveal', { key: 'TOKEN', cwd }], ['keys-reveal', { envVar: 'OPENAI_API_KEY' }]] as const) {
      const err = await failure(call(method, params, 'turn-token'))
      expect(err.code).toBe('refused')
      expect(err.message).toBe('Secrets can’t be revealed from inside an agent turn.')
    }
    expect(calls).toEqual([])
  })

  it('is admin tier, so the policy refuses it too', () => {
    const { host } = rig()
    for (const method of ['env-reveal', 'keys-reveal']) {
      expect(ENV_METHODS[method].tier).toBe('admin')
      expect(tierCheck(method, ENV_METHODS[method].tier, { v: 2, method, params: {}, caller: { token: 't' }, token: 'test-token' }, host)).toMatchObject({ code: 'refused' })
    }
  })

  it('prints the value without a token, from the layer asked for', async () => {
    const { call, calls } = rig()
    const result = await call<EnvRevealResult>('env-reveal', { key: 'TOKEN', layer: 'inherited', repo: 'app', cwd })
    expect(result).toMatchObject({ key: 'TOKEN', value: 'hunter2-the-long-secret', text: 'hunter2-the-long-secret' })
    expect(calls).toEqual([['revealEnvVar', { kind: 'repo', repoId: 'r1' }, 'TOKEN', 'inherited']])
    expect((await failure(call('env-reveal', { key: 'TOKEN', layer: 'sideways', cwd }))).code).toBe('invalid')
    const missing = rig({ revealEnvVar: async () => null })
    expect((await failure(missing.call('env-reveal', { key: 'GONE', cwd }))).code).toBe('not-found')
  })
})

describe('provider keys', () => {
  const catalog = (async () => ({ detections: {}, statuses: {}, acp: {}, shellKeys: {}, shellProviderKeys: ['MISTRAL_API_KEY'], savedProviderKeys: ['OPENAI_API_KEY'], providerKeyHints: { OPENAI_API_KEY: 'abcd' } })) as unknown as Api['agentCatalog']

  it('lists names, hints and the agents that get each key', async () => {
    const { call } = rig({ agentCatalog: catalog }, { providerKeyAgents: { OPENAI_API_KEY: ['qwen'] } })
    const result = await call<KeysListResult>('keys-list', {})
    expect(result.keys).toEqual([
      { envVar: 'MISTRAL_API_KEY', label: expect.any(String), saved: false, inShell: true, agents: ['opencode'] },
      { envVar: 'OPENAI_API_KEY', label: expect.any(String), saved: true, inShell: false, hint: 'abcd', agents: ['opencode', 'qwen'] }
    ])
    expect(result.text).toMatch(/OPENAI_API_KEY\s+saved \(…abcd\)\s+opencode, qwen/)
    expect(result.text).toMatch(/MISTRAL_API_KEY\s+in the shell only/)
  })

  it('leaves the hints out of a request from an agent turn', async () => {
    const { call } = rig({ agentCatalog: catalog })
    const result = await call<KeysListResult>('keys-list', {}, 'turn-token')
    expect(result.keys.every((k) => k.hint === undefined)).toBe(true)
    expect(result.text).not.toContain('abcd')
  })

  it('saves a key, or copies it from the shell, never both', async () => {
    const { call, calls } = rig({ setProviderKey: (async (...a: unknown[]) => void calls.push(['setProviderKey', ...a])) as Api['setProviderKey'], importProviderKey: (async (name: string) => (calls.push(['importProviderKey', name]), name === 'MISTRAL_API_KEY')) as Api['importProviderKey'] })
    const saved = await call<KeysSetResult>('keys-set', { envVar: 'OPENAI_API_KEY', value: `  ${SECRET}\n` })
    expect(calls[0]).toEqual(['setProviderKey', 'OPENAI_API_KEY', SECRET])
    expect(saved.text).toBe('Saved OPENAI_API_KEY (…3210).')
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect((await call<KeysSetResult>('keys-set', { envVar: 'MISTRAL_API_KEY', fromShell: true })).text).toContain('Imported')
    expect((await failure(call('keys-set', { envVar: 'OPENAI_API_KEY', fromShell: true }))).code).toBe('not-found')
    expect((await failure(call('keys-set', { envVar: 'OPENAI_API_KEY', value: 'x', fromShell: true }))).code).toBe('invalid')
    expect((await failure(call('keys-set', { envVar: 'OPENAI_API_KEY' }))).code).toBe('invalid')
    expect((await failure(call('keys-set', { envVar: 'bad-name', value: 'x' }))).code).toBe('invalid')
    await call('keys-remove', { envVar: 'OPENAI_API_KEY' })
    expect(calls.at(-1)).toEqual(['setProviderKey', 'OPENAI_API_KEY', null])
  })

  it('allows and denies agents, checking each id against the catalog', async () => {
    const { call, calls } = rig({ updateSettings: (async (patch: unknown) => void calls.push(['updateSettings', patch])) as unknown as Api['updateSettings'] }, { providerKeyAgents: { OPENAI_API_KEY: ['goose'] } })
    const allowed = await call<KeysAgentsResult>('keys-allow', { envVar: 'OPENAI_API_KEY', agents: ['qwen'] })
    expect(calls).toEqual([['updateSettings', { providerKeyAgents: { OPENAI_API_KEY: ['goose', 'qwen'] } }]])
    expect(allowed.agents).toEqual(['opencode', 'goose', 'qwen'])
    await call('keys-deny', { envVar: 'OPENAI_API_KEY', agents: ['goose'] })
    expect(calls[1]).toEqual(['updateSettings', { providerKeyAgents: {} }])
    // An agent the catalog doesn't have, one that takes no shared keys, and OpenCode, which always has them.
    const unknown = await failure(call('keys-allow', { envVar: 'OPENAI_API_KEY', agents: ['qwen', 'skynet'] }))
    expect(unknown.code).toBe('not-found')
    expect(unknown.message).toContain("'skynet'")
    expect((await failure(call('keys-allow', { envVar: 'OPENAI_API_KEY', agents: ['claude'] }))).code).toBe('invalid')
    expect((await failure(call('keys-deny', { envVar: 'OPENAI_API_KEY', agents: ['opencode'] }))).code).toBe('invalid')
    expect((await failure(call('keys-allow', { envVar: 'OPENAI_API_KEY', agents: [] }))).code).toBe('invalid')
    expect(calls).toHaveLength(2)
  })

  it('sets an agent’s own key by catalog id', async () => {
    const calls: unknown[][] = []
    const { call } = rig({
      setAgentKey: (async (...a: unknown[]) => void calls.push(['setAgentKey', ...a])) as Api['setAgentKey'],
      importAgentKey: (async (a: string) => (calls.push(['importAgentKey', a]), true)) as Api['importAgentKey']
    })
    const saved = await call<AgentKeySetResult>('agents-key-set', { agent: 'cursor', value: SECRET })
    expect(calls).toEqual([['setAgentKey', 'cursor', SECRET]])
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    await call('agents-key-set', { agent: 'claude', fromShell: true })
    await call('agents-key-set', { agent: 'claude', remove: true })
    expect(calls.slice(1)).toEqual([['importAgentKey', 'claude'], ['setAgentKey', 'claude', null]])
    expect((await failure(call('agents-key-set', { agent: 'nobody', value: 'x' }))).code).toBe('not-found')
    // OpenCode has no key of its own: it takes the shared provider keys.
    expect((await failure(call('agents-key-set', { agent: 'opencode', value: 'x' }))).message).toContain('foreman keys')
    expect((await failure(call('agents-key-set', { agent: 'claude' }))).code).toBe('invalid')
  })
})

describe('tokens and hosts', () => {
  it('saves the GitHub token and shows at most four characters', async () => {
    const calls: unknown[][] = []
    const { call } = rig({ setGithubToken: (async (t: string | null) => void calls.push(['setGithubToken', t])) as Api['setGithubToken'] })
    const saved = await call<TokenSavedResult>('github-token-set', { token: ` ${SECRET} ` })
    expect(calls).toEqual([['setGithubToken', SECRET]])
    expect(saved.text).toBe('Saved the GitHub token (…3210).')
    await call('github-token-clear', {})
    expect(calls[1]).toEqual(['setGithubToken', null])
    expect((await failure(call('github-token-set', { token: '' }))).code).toBe('invalid')
    expect((await failure(call('github-token-set', { token: 'two words' }))).code).toBe('invalid')
  })

  it('reports GitHub’s status and accounts', async () => {
    const { call } = rig({
      githubStatus: async () => ({ installed: true, loggedIn: true, user: 'yatin', method: 'cli', tokenSaved: true }),
      githubAccounts: async () => [{ login: 'yatin', active: true }, { login: 'work', active: false }]
    })
    const status = await call<GithubStatusResult>('github-status', {})
    expect(status.text).toContain('signed in as yatin, using the gh command')
    expect(status.text).toContain('A personal access token is saved')
    expect((await call<{ text: string }>('github-accounts', {})).text).toContain('yatin (active)')
  })

  it('adds a GitLab host with a token or glab’s, and removes only a known one', async () => {
    const calls: unknown[][] = []
    const hosts = [{ host: 'gitlab.example.com', url: 'https://gitlab.example.com', selfManaged: true, tokenSaved: true, repos: ['app'] }]
    const { call } = rig({
      saveGitlabToken: (async (url: string, token: string) => (calls.push(['saveGitlabToken', url, token]), token === 'bad' ? { ok: false, error: '401 Unauthorized' } : { ok: true, version: '17.1', user: 'yatin' })) as Api['saveGitlabToken'],
      useGlabToken: (async (url: string) => (calls.push(['useGlabToken', url]), { ok: true, version: '17.1', user: 'yatin' })) as Api['useGlabToken'],
      gitlabHosts: async () => ({ hosts, glab: true }),
      removeGitlabHost: (async (h: string) => void calls.push(['removeGitlabHost', h])) as Api['removeGitlabHost'],
      testGitlabHost: (async (url: string, token?: string) => (calls.push(['testGitlabHost', url, token]), { ok: true, version: '17.1', user: 'yatin' })) as Api['testGitlabHost']
    })
    const added = await call<GitlabConnectionResult>('gitlab-add', { url: 'https://gitlab.example.com', token: SECRET })
    expect(added.text).toContain('signed in as yatin')
    expect(JSON.stringify(added)).not.toContain(SECRET)
    await call('gitlab-add', { url: 'https://gitlab.example.com', fromGlab: true })
    expect(calls).toEqual([['saveGitlabToken', 'https://gitlab.example.com', SECRET], ['useGlabToken', 'https://gitlab.example.com']])
    const refused = await failure(call('gitlab-add', { url: 'https://gitlab.example.com', token: 'bad' }))
    expect(refused.code).toBe('failed')
    expect(refused.message).toContain('401 Unauthorized')
    expect((await failure(call('gitlab-add', { url: 'https://gitlab.example.com' }))).code).toBe('invalid')
    expect((await call<{ text: string }>('gitlab-list', {})).text).toMatch(/gitlab\.example\.com\s+token saved\s+self-managed, 1 repository/)
    await call('gitlab-remove', { host: 'gitlab.example.com' })
    expect(calls.at(-1)).toEqual(['removeGitlabHost', 'gitlab.example.com'])
    expect((await failure(call('gitlab-remove', { host: 'other.example.com' }))).code).toBe('not-found')
    await call('gitlab-test', { url: 'https://gitlab.example.com' })
    expect(calls.at(-1)).toEqual(['testGitlabHost', 'https://gitlab.example.com', undefined])
  })

  it('keeps the cloud setup token’s hint from an agent turn', async () => {
    const calls: unknown[][] = []
    const { call } = rig({
      cloudClaudeToken: async () => ({ hint: 'wxyz', savedAt: '2026-10-01T10:00:00Z' }),
      cloudSetClaudeToken: (async (t: string | null) => void calls.push(['cloudSetClaudeToken', t])) as Api['cloudSetClaudeToken']
    })
    expect((await call<CloudTokenStatusResult>('cloud-token-status', {})).text).toBe('A Claude setup token is saved (…wxyz) on 2026-10-01.')
    const agent = await call<CloudTokenStatusResult>('cloud-token-status', {}, 'turn-token')
    expect(agent.hint).toBeUndefined()
    expect(agent.text).toBe('A Claude setup token is saved on 2026-10-01.')
    await call('cloud-token-set', { token: SECRET })
    await call('cloud-token-clear', {})
    expect(calls).toEqual([['cloudSetClaudeToken', SECRET], ['cloudSetClaudeToken', null]])
    expect((await failure(call('cloud-token-set', { token: '  ' }))).code).toBe('invalid')
  })

  it('puts every method that stores, removes or reveals a secret in the admin tier', () => {
    const reads = ['env-list', 'keys-list', 'github-status', 'github-accounts', 'gitlab-list', 'cloud-token-status']
    for (const [name, def] of Object.entries(ENV_METHODS)) expect(def.tier, name).toBe(reads.includes(name) ? 'read' : 'admin')
  })
})
