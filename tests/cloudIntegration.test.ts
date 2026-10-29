// The Vercel connection: checked against Vercel before it is
// saved, its token in the vault like any connection's, team and project and the plan's limits
// beside it, resolved app-wide for cloud workspaces, and its token handed only to the provider.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeProvider } from '../src/main/cloud/fakeProvider'
import type { SandboxProvider } from '../src/main/cloud/provider'
import { SandboxManager } from '../src/main/cloud/sandboxes'
import { createProvider } from '../src/main/cloud/providers'
import { VercelProvider } from '../src/main/cloud/vercelProvider'
import { Integrations, secretKey, vercelTokenCheck } from '../src/main/integrations'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { planLimits } from '../src/shared/cloud'
import { INTEGRATION_SERVICES } from '../src/shared/integrations'
import type { Repo } from '../src/shared/types'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
const HOUR = 60 * 60_000

type Seen = { url: string; auth: string }

/** Vercel's API as the check sees it: a user, and teams on Hobby or Pro. */
function vercelApi(seen: Seen[], teams: Record<string, { name: string; slug: string; plan?: string }> = { team_hobby: { name: 'Yatin', slug: 'yatin' }, team_pro: { name: 'Acme', slug: 'acme', plan: 'pro' } }): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const auth = new Headers(init.headers).get('authorization') ?? ''
    seen.push({ url, auth })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (auth === 'Bearer revoked') return json({ error: { code: 'forbidden' } }, 403)
    if (url === 'https://api.vercel.com/v2/user') return json({ user: { id: 'u_1', username: 'yatin', email: 'y@acme.dev' } })
    const team = url.match(/^https:\/\/api\.vercel\.com\/v2\/teams\/([^/?]+)$/)
    if (team) {
      const t = teams[decodeURIComponent(team[1])]
      if (!t) return json({ error: { code: 'not_found' } }, 404)
      return json({ id: decodeURIComponent(team[1]), name: t.name, slug: t.slug, ...(t.plan ? { billing: { plan: t.plan } } : {}) })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
}

async function rig(api?: typeof fetch) {
  const dir = await tempDir('foreman-vercel-')
  const store = new Store(dir)
  await store.load()
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), plain)
  store.state.repos.push({ id: 'r1', name: 'app', rootPath: dir, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as Repo)
  const repo = (id: string) => {
    const found = store.state.repos.find((r) => r.id === id)
    if (!found) throw new Error('no repo')
    return found
  }
  const seen: Seen[] = []
  const integrations = new Integrations({
    store,
    secrets,
    repo,
    repoGithubToken: () => undefined,
    remoteUrl: async () => null,
    githubAccounts: async () => [],
    accountToken: (login) => `gho_${login}`,
    activeLogin: async () => undefined,
    changed: () => undefined,
    fetch: api ?? vercelApi(seen),
    home: dir
  })
  return { store, secrets, integrations, seen }
}

const add = (integrations: Integrations, token: string, teamId = 'team_hobby', projectId = 'prj_1', extra: { allowDuplicate?: boolean } = {}) =>
  integrations.addConnection({ service: 'vercel', auth: { kind: 'token' }, token, vercel: { teamId, projectId }, ...extra })

describe('Vercel connection', () => {
  it('checks the token with the user and the team, then saves it in the vault with the team, project and limits', async () => {
    const { integrations, secrets, seen } = await rig()
    const result = await add(integrations, 'vercel_tok_hobby_1234')
    if (!result.ok) throw new Error(result.error)
    const c = result.connection
    expect(seen.map((s) => s.url)).toEqual(['https://api.vercel.com/v2/user', 'https://api.vercel.com/v2/teams/team_hobby'])
    expect(seen.every((s) => s.auth === 'Bearer vercel_tok_hobby_1234')).toBe(true)
    expect(c).toMatchObject({ service: 'vercel', name: 'Yatin Vercel', agentAccess: 'off', hint: '1234', isDefault: true })
    expect(c.identity).toMatchObject({ user: 'yatin', userId: 'u_1', org: 'Yatin', orgId: 'team_hobby', orgKey: 'yatin', url: 'https://vercel.com/yatin' })
    expect(c.vercel).toEqual({ teamId: 'team_hobby', projectId: 'prj_1', plan: 'hobby', limits: { maxSessionMs: 0.75 * HOUR, maxVcpus: 4, maxConcurrent: 10 } })
    expect(secrets.appSecret(secretKey(c.id))).toBe('vercel_tok_hobby_1234')
    // The token is in the vault only, never in state.json.
    expect(JSON.stringify(integrations.state())).not.toContain('vercel_tok_hobby_1234')
  })

  it('reads Pro limits from the team’s billing plan', async () => {
    const { integrations } = await rig()
    const result = await add(integrations, 'vercel_tok_pro', 'team_pro')
    if (!result.ok) throw new Error(result.error)
    expect(result.connection.vercel).toMatchObject({ plan: 'pro', limits: { maxSessionMs: 24 * HOUR, maxVcpus: 8, maxConcurrent: 10_000 } })
    expect(result.connection.name).toBe('Acme Vercel')
  })

  it('refuses a revoked token, an unknown team, and a missing team or project, saving nothing', async () => {
    const { integrations, secrets } = await rig()
    expect(await add(integrations, 'revoked')).toEqual({ ok: false, error: 'Vercel refused this token. It may have expired or been revoked.' })
    const unknown = await add(integrations, 'vercel_tok', 'team_nope')
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.error).toMatch(/team_nope/)
    expect(await add(integrations, 'vercel_tok', '', 'prj_1')).toEqual({ ok: false, error: 'Enter the Vercel team id and project id too.' })
    expect(integrations.state().connections).toEqual([])
    expect(secrets.appSecret(secretKey('anything'))).toBeUndefined()
  })

  it('flags the same team and project twice, but allows another project in the team', async () => {
    const { integrations } = await rig()
    await add(integrations, 'vercel_tok_a')
    const again = await add(integrations, 'vercel_tok_b')
    expect(again).toMatchObject({ ok: false, error: 'duplicate' })
    const otherProject = await add(integrations, 'vercel_tok_c', 'team_hobby', 'prj_2')
    expect(otherProject.ok).toBe(true)
  })

  it('resolves app-wide for cloud workspaces, and isn’t a per-repository service', async () => {
    const { integrations, secrets } = await rig()
    expect(integrations.vercel()).toEqual({ state: 'none', source: 'default', off: false })
    const result = await add(integrations, 'vercel_tok_hobby')
    if (!result.ok) throw new Error(result.error)
    expect(integrations.vercel()).toMatchObject({ state: 'ready', connection: { id: result.connection.id } })
    expect(INTEGRATION_SERVICES).not.toContain('vercel')
    expect((await integrations.repoView('r1')).map((v) => v.service)).toEqual(['github', 'linear', 'slack', 'langfuse'])
    expect(integrations.fingerprints('r1').some((f) => f.includes('vercel'))).toBe(false)
    // A token missing from the vault is a problem, never a silent fallback.
    secrets.setAppSecret(secretKey(result.connection.id), null)
    expect(integrations.vercel()).toMatchObject({ state: 'broken', reason: 'problem' })
  })

  it('marks the connection when Vercel refuses it later, and checks a new team before saving it', async () => {
    const seen: Seen[] = []
    let api = vercelApi(seen)
    const { integrations, secrets } = await rig(((input: string | URL | Request, init?: RequestInit) => api(input, init)) as typeof fetch)
    const result = await add(integrations, 'vercel_tok_hobby')
    if (!result.ok) throw new Error(result.error)
    const id = result.connection.id
    const moved = await integrations.updateConnection(id, { vercel: { projectId: 'prj_9' } })
    expect(moved.ok && moved.connection.vercel?.projectId).toBe('prj_9')
    const otherTeam = await integrations.updateConnection(id, { vercel: { teamId: 'team_pro' } })
    expect(otherTeam).toMatchObject({ ok: false })
    api = vercelApi(seen, {})
    secrets.setAppSecret(secretKey(id), 'revoked')
    const checked = await integrations.checkConnection(id)
    expect(checked.problem).toMatch(/refused/)
    expect(integrations.vercel().state).toBe('broken')
  })

  it('gives the sandbox manager the vault’s token, with the team, project and plan limits', async () => {
    const { integrations, store, secrets } = await rig()
    const result = await add(integrations, 'vercel_tok_pro', 'team_pro', 'prj_7')
    if (!result.ok) throw new Error(result.error)
    const made: SandboxProvider[] = []
    const fake = new FakeProvider(await tempDir('foreman-vercel-sb-'))
    const manager = new SandboxManager({
      store,
      secrets,
      connection: (service, connectionId) => integrations.sandboxConnection(service, connectionId),
      // The registry's own Vercel factory, so the credentials it is given are the ones checked; the fake does the work.
      provider: (connection, secret) => {
        made.push(createProvider(connection, secret))
        return fake
      },
      githubToken: () => undefined,
      cloneUrl: async () => null,
      gitIdentity: async () => ({}),
      settingsFor: () => ({ pushAutoSetupRemote: false }) as never,
      changed: () => undefined,
      buildLog: () => undefined,
      turnRunning: () => false,
      terminalOpen: () => false,
      focused: () => false
    })
    expect(manager.available()).toBe(true)
    manager.provider()
    expect(made).toHaveLength(1)
    expect(made[0]).toBeInstanceOf(VercelProvider)
    expect((made[0] as VercelProvider).auth()).toEqual({ token: 'vercel_tok_pro', teamId: 'team_pro', projectId: 'prj_7' })
    expect(made[0].limits()).toEqual(planLimits('pro'))
    expect(manager.limits()).toEqual(fake.limits())
  })

  it('reports Vercel being unreachable without calling it a refusal', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    await expect(vercelTokenCheck('t', { teamId: 'team_1', projectId: 'p' }, offline)).rejects.toThrow(/Couldn’t reach Vercel/)
    const err = await vercelTokenCheck('t', { teamId: 'team_1', projectId: 'p' }, offline).catch((e: unknown) => e)
    expect((err as { auth?: boolean }).auth).toBeUndefined()
  })
})
