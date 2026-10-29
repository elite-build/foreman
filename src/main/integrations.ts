// Integrations: named connections for GitHub, Linear, Slack and Langfuse,
// one default per service and each repository's choice. The sandbox services of remote workspaces
// (Vercel, Docker, E2B, Daytona) are connections the same way: a key in the vault (none for Docker),
// what it points at beside it, and a repository picks one on its Remote tab. Connections live in state.json without
// their secret; the secret is in the vault under `integration:<id>` and never reaches the renderer.
// A chosen connection that can't be used stops there: a repository never falls through to
// another account.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  AGENT_TOOL_SERVICES,
  CLAUDE_AI_CONNECTORS,
  emptyIntegrations,
  INTEGRATION_SERVICES,
  ownerSuggestion,
  ownServerService,
  resolveIntegration,
  resolvedConnection,
  ruleFingerprint,
  SERVICE_LABELS,
  usedBy,
  type AddConnectionResult as AddResult,
  type AgentAccess,
  type Connection,
  type ConnectionAuth,
  type ConnectionPatch,
  type ConnectionIdentity,
  type ConnectionView,
  type IntegrationService,
  type IntegrationsState,
  type IntegrationsView,
  type NewConnection,
  type OwnMcpServer,
  type PersonLink,
  type RepoIntegrations,
  type RepoIntegrationService,
  type RepoServiceView,
  type Resolution,
  type SlackDestination,
  type SlackRule,
  type VercelConnectionInfo,
  DAYTONA_API_URL,
  isSandboxService,
  normalizeLangfuseHost,
  type DaytonaConnectionInfo,
  type LangfuseConnectionInfo,
  type DockerConnectionInfo,
  type E2bConnectionInfo,
  type SandboxConnectionInput,
  type SandboxService
} from '../shared/integrations'
import { CLOUD_PROVIDERS, parsePlan, planLimits } from '../shared/cloud'
import { verifyDaytona } from './cloud/daytonaProvider'
import { verifyDocker } from './cloud/dockerProvider'
import { verifyE2b } from './cloud/e2bProvider'
import { isSshRemote } from './github'
import type { GithubAccount, Repo } from '../shared/types'
import type { SecretStore } from './secrets'
import type { Store } from './store'
import { langfuseProject, LangfuseError } from './langfuse'
import { linearHasGithub, linearViewer, LinearError } from './linear'
import { isAuthError, slackAuthTest } from './slack'

type Fetch = typeof fetch

export interface IntegrationDeps {
  store: Store
  secrets: SecretStore
  repo: (id: string) => Repo
  // The repository's own GH_TOKEN (its env layers), and the layer it comes from.
  repoGithubToken: (repoId: string) => { value: string; from: string } | undefined
  remoteUrl: (repoId: string) => Promise<string | null>
  githubAccounts: () => Promise<GithubAccount[]>
  // The token gh holds for an account (throws, or rejects, when it's signed out).
  accountToken: (login: string) => string | Promise<string>
  // gh's active account, asked afresh (checking a connection).
  activeLogin: () => Promise<string | undefined>
  // The same without waiting: the last answer, undefined until gh has given one.
  activeAccount?: () => string | undefined
  changed: () => void
  fetch?: Fetch
  home?: string
}

export const secretKey = (id: string) => `integration:${id}`

const MIGRATION = 'integrations-1'

function hint(value: string): string {
  return value.length >= 12 ? value.slice(-4) : ''
}

function defaultName(service: IntegrationService, identity: ConnectionIdentity | undefined, auth: ConnectionAuth): string {
  if (service === 'github') {
    if (auth.kind === 'gh-account') return `GitHub · ${auth.login}`
    if (auth.kind === 'gh-active') return 'GitHub (gh’s signed-in account)'
    return identity ? `GitHub · ${identity.user}` : 'GitHub token'
  }
  if (service === 'linear') return identity?.org ? `${identity.org} Linear` : 'Linear'
  if (service === 'langfuse') return identity?.org ? `${identity.org} Langfuse` : 'Langfuse'
  if (isSandboxService(service)) {
    const label = CLOUD_PROVIDERS[service].label
    return identity?.org ? `${identity.org} ${label}` : label
  }
  return identity?.org ? `${identity.org} Slack` : 'Slack'
}

/** What a connection was checked as, with the service's own details beside the identity. */
type Verified = {
  identity: ConnectionIdentity
  linearGithub?: boolean
  vercel?: VercelConnectionInfo
  docker?: DockerConnectionInfo
  e2b?: E2bConnectionInfo
  daytona?: DaytonaConnectionInfo
  langfuse?: LangfuseConnectionInfo
  problem?: undefined
}

/** Services whose connection has settings besides its key, checked together with it: the sandbox services and Langfuse (host and public key). */
function hasSettings(service: IntegrationService): boolean {
  return isSandboxService(service) || service === 'langfuse'
}

/** What agents may do with a new or changed connection. Langfuse tools only read, so write means read there. */
function accessFor(service: IntegrationService, access: AgentAccess): AgentAccess {
  return service === 'langfuse' && access === 'write' ? 'read' : access
}

/** A sandbox (or Langfuse) connection's settings to check: what's saved, with a patch over it. */
function sandboxInput(c: Pick<Connection, 'vercel' | 'docker' | 'e2b' | 'daytona' | 'langfuse'> | undefined, patch: Pick<ConnectionPatch, 'vercel' | 'docker' | 'e2b' | 'daytona' | 'langfuse'> = {}): SandboxConnectionInput {
  return {
    langfuse: { host: patch.langfuse?.host ?? c?.langfuse?.host, publicKey: (patch.langfuse?.publicKey ?? c?.langfuse?.publicKey ?? '').trim() },
    vercel: { teamId: patch.vercel?.teamId ?? c?.vercel?.teamId ?? '', projectId: patch.vercel?.projectId ?? c?.vercel?.projectId ?? '' },
    docker: { context: patch.docker?.context ?? c?.docker?.context, host: patch.docker?.host ?? c?.docker?.host },
    e2b: { domain: patch.e2b?.domain ?? c?.e2b?.domain },
    daytona: { apiUrl: patch.daytona?.apiUrl || c?.daytona?.apiUrl || DAYTONA_API_URL, target: patch.daytona?.target ?? c?.daytona?.target }
  }
}

/** The service's details from a check, to keep on the connection. */
function checkedInfo(checked: Verified): Pick<Connection, 'vercel' | 'docker' | 'e2b' | 'daytona' | 'langfuse'> {
  return {
    ...(checked.langfuse ? { langfuse: checked.langfuse } : {}),
    ...(checked.vercel ? { vercel: checked.vercel } : {}),
    ...(checked.docker ? { docker: checked.docker } : {}),
    ...(checked.e2b ? { e2b: checked.e2b } : {}),
    ...(checked.daytona ? { daytona: checked.daytona } : {})
  }
}

const VERCEL_API = 'https://api.vercel.com'

/** Vercel's answer for a token and team: who it is, the team, and the team's plan and its sandbox limits. */
export async function vercelTokenCheck(token: string, ids: { teamId: string; projectId: string }, doFetch: Fetch = fetch): Promise<{ identity: ConnectionIdentity; vercel: VercelConnectionInfo }> {
  const teamId = ids.teamId.trim()
  const projectId = ids.projectId.trim()
  if (!teamId || !projectId) throw new Error('Enter the Vercel team id and project id too.')
  const get = async (url: string): Promise<Response> => {
    try {
      return await doFetch(url, { redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Foreman' }, signal: AbortSignal.timeout(15_000) })
    } catch (err) {
      throw new Error(`Couldn’t reach Vercel: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const userRes = await get(`${VERCEL_API}/v2/user`)
  if (userRes.status === 401 || userRes.status === 403) throw Object.assign(new Error('Vercel refused this token. It may have expired or been revoked.'), { auth: true })
  if (!userRes.ok) throw new Error(`Vercel answered ${userRes.status}`)
  const { user } = (await userRes.json()) as { user: { id?: string; uid?: string; username?: string; name?: string | null; email?: string | null } }
  const teamRes = await get(`${VERCEL_API}/v2/teams/${encodeURIComponent(teamId)}`)
  if (teamRes.status === 401 || teamRes.status === 403 || teamRes.status === 404) throw Object.assign(new Error(`Vercel refused this token for the team ${teamId}: the token may not belong to it.`), { auth: true })
  if (!teamRes.ok) throw new Error(`Vercel answered ${teamRes.status}`)
  const team = (await teamRes.json()) as { id?: string; slug?: string; name?: string; billing?: { plan?: string } | null }
  const plan = parsePlan(team.billing?.plan)
  return {
    identity: {
      user: user.username || user.name || user.email || 'Vercel user',
      userId: user.id ?? user.uid,
      email: user.email ?? undefined,
      org: team.name || team.slug,
      orgId: team.id ?? teamId,
      orgKey: team.slug,
      url: team.slug ? `https://vercel.com/${team.slug}` : 'https://vercel.com',
      checkedAt: new Date().toISOString()
    },
    vercel: { teamId: team.id ?? teamId, projectId, plan, limits: planLimits(plan) }
  }
}

/** GitHub's own answer for a token: login and id. */
export async function githubTokenUser(token: string, doFetch: Fetch = fetch): Promise<ConnectionIdentity> {
  let res: Response
  try {
    res = await doFetch('https://api.github.com/user', {
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Foreman' },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (err) {
    throw new Error(`Couldn’t reach GitHub: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 401) throw Object.assign(new Error('GitHub refused this token. It may have expired or been revoked.'), { auth: true })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const user = (await res.json()) as { login: string; id: number; name?: string | null; email?: string | null }
  return { user: user.login, userId: String(user.id), email: user.email ?? undefined, url: `https://github.com/${user.login}`, checkedAt: new Date().toISOString() }
}

export class Integrations {
  private ownCache = new Map<string, { mtimeMs: number; servers: OwnMcpServer[] }>()

  constructor(private deps: IntegrationDeps) {}

  private get fetch(): Fetch {
    return this.deps.fetch ?? fetch
  }

  state(): IntegrationsState {
    const s = this.deps.store.state
    s.integrations ??= emptyIntegrations()
    return s.integrations
  }

  private save(): void {
    this.deps.store.save()
    this.deps.changed()
  }

  connection(id: string): Connection | undefined {
    return this.state().connections.find((c) => c.id === id)
  }

  private mustConnection(id: string): Connection {
    const c = this.connection(id)
    if (!c) throw new Error('That connection no longer exists')
    return c
  }

  /** The connection's token, for the main process only. */
  secret(id: string): string | undefined {
    return this.deps.secrets.appSecret(secretKey(id))
  }

  // ---- resolution ----

  resolve(repoId: string, service: IntegrationService): Resolution {
    let repo: Repo | undefined
    try {
      repo = this.deps.repo(repoId)
    } catch {
      repo = undefined
    }
    // The repository's own GH_TOKEN conflicts with a chosen connection, unless it is that connection's token ("Make it a connection").
    const env = service === 'github' && repo ? this.deps.repoGithubToken(repoId) : undefined
    const choice = repo?.integrations?.services?.github ?? this.state().defaults.github
    const envToken = Boolean(env) && !(choice && choice !== 'off' && this.secret(choice) === env!.value)
    const resolved = resolveIntegration(this.state(), repo, service, { envToken })
    if (resolved.state === 'ready' && resolved.connection.auth.kind === 'token' && !this.secret(resolved.connection.id)) {
      return { state: 'broken', source: resolved.source, reason: 'problem', connectionId: resolved.connection.id, connection: { ...resolved.connection, problem: 'The saved key is missing on this Mac. Replace it in Settings → Integrations.' } }
    }
    return resolved
  }

  /**
   * The connection a sandbox service's remote workspaces use: the one a repository chose (`connectionId`), else the
   * service's default. Its key stays in the vault; only the sandbox manager reads it.
   */
  sandboxConnection(service: SandboxService, connectionId?: string): Resolution {
    const repo = connectionId ? { integrations: { services: { [service]: connectionId } } } : undefined
    const resolved = resolveIntegration(this.state(), repo, service)
    if (resolved.state !== 'ready') return resolved
    const c = resolved.connection
    const broken = (problem: string): Resolution => ({ state: 'broken', source: resolved.source, reason: 'problem', connectionId: c.id, connection: { ...c, problem } })
    if (c.auth.kind === 'token' && !this.secret(c.id)) return broken('The saved token is missing on this Mac. Replace it in Settings → Integrations.')
    if (service === 'vercel' && (!c.vercel?.teamId || !c.vercel.projectId)) return broken('This Vercel connection has no team or project. Edit it in Settings → Integrations.')
    return resolved
  }

  /** The default Vercel connection (sandboxConnection('vercel')). */
  vercel(): Resolution {
    return this.sandboxConnection('vercel')
  }

  /**
   * The key github.ts runs gh and git as for a repository: undefined (gh's active account, or the
   * old global token), a gh login, `token:<connection>`, `env:<repo>` (the repo's own GH_TOKEN),
   * `off:<repo>` (turned off here) or `blocked:<repo>` (a chosen connection that can't be used).
   */
  githubKey(repoId: string): string | undefined {
    const r = this.resolve(repoId, 'github')
    if (r.state === 'env') return `env:${repoId}`
    if (r.state === 'none') return r.off ? `off:${repoId}` : undefined
    if (r.state === 'broken') return `blocked:${repoId}`
    const auth = r.connection.auth
    if (auth.kind === 'gh-account') return auth.login
    if (auth.kind === 'gh-active') return (this.deps.activeAccount ? this.deps.activeAccount() : r.connection.identity?.user) ?? `blocked:${repoId}`
    return `token:${r.connection.id}`
  }

  /**
   * githubKey for callers that can wait (a turn's environment, a git action): a connection following gh's active
   * account asks gh afresh first, so gh auth switch run outside Foreman counts now rather than when the cached answer
   * gets old. gh failing to answer is nobody (`blocked:`), never the last or another account.
   */
  async githubKeyFresh(repoId: string): Promise<string | undefined> {
    const r = this.resolve(repoId, 'github')
    if (r.state === 'ready' && r.connection.auth.kind === 'gh-active' && this.deps.activeAccount) await this.deps.activeLogin().catch(() => undefined)
    return this.githubKey(repoId)
  }

  /** The gh accounts GitHub connections run as, and whether one follows gh's active account: what github.ts should have ready. */
  ghAccountsInUse(): { accounts: string[]; active: boolean } {
    const github = this.state().connections.filter((c) => c.service === 'github')
    const accounts = github.flatMap((c) => (c.auth.kind === 'gh-account' ? [c.auth.login] : []))
    return { accounts: [...new Set(accounts)], active: github.some((c) => c.auth.kind === 'gh-active') }
  }

  /** The identities and permissions a scheduled run must be approved against. */
  fingerprints(repoId: string): string[] {
    const out = INTEGRATION_SERVICES.flatMap((service) => {
      const r = this.resolve(repoId, service)
      if (r.state === 'broken') return [`integration:${service}:broken:${r.connectionId}`]
      if (r.state !== 'ready') return []
      const identity = service === 'github' ? `:${this.githubKey(repoId) ?? ''}` : ''
      return [`integration:${service}:${r.connection.id}:${r.connection.rev}:${r.connection.agentAccess}${identity}`]
    })
    const own = this.repoChoices(repoId)?.allowOwnMcp
    if (own?.length) out.push(`integration:own:${[...own].sort().join(',')}`)
    return out
  }

  /** What github.ts's identity keys stand for. */
  githubIdentity(key: string): { token: string } | { off: string } | { blocked: string } | null {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (kind === 'token') {
      const token = this.secret(id)
      return token ? { token } : { blocked: 'The GitHub connection’s token is missing. Replace it in Settings → Integrations.' }
    }
    if (kind === 'env') {
      const token = this.deps.repoGithubToken(id)?.value
      return token ? { token } : null
    }
    if (kind === 'off') return { off: 'GitHub is off for this repository (Repository settings → Integrations).' }
    if (kind === 'blocked') return { blocked: this.brokenText(id, 'github') }
    return null
  }

  /** Why a service can't be used in a repository, in a sentence for errors and agents. */
  brokenText(repoId: string, service: IntegrationService): string {
    const label = SERVICE_LABELS[service]
    const r = this.resolve(repoId, service)
    if (r.state !== 'broken') return `${label} isn’t available in this repository.`
    if (r.reason === 'env-conflict') {
      const from = this.deps.repoGithubToken(repoId)?.from ?? 'the repository’s environment'
      return `GitHub is off in this repository until you choose an account: GH_TOKEN in ${from} is a different identity from the connection it uses (Repository settings → Integrations).`
    }
    if (r.reason === 'missing') return `${label} is off in this repository: the connection it uses was removed. Choose another in Repository settings → Integrations.`
    return `${label} is off in this repository: “${r.connection?.name}” needs attention (${r.connection?.problem}). Foreman won’t use another account instead.`
  }

  // ---- views ----

  view(): IntegrationsView {
    const state = this.state()
    const repos = this.deps.store.state.repos
    const connections: ConnectionView[] = state.connections.map((c) => ({ ...c, usedBy: usedBy(state, repos, c), isDefault: state.defaults[c.service] === c.id }))
    const suggestions: IntegrationsView['suggestions'] = {}
    for (const repo of repos) {
      if (!repo.integrations?.suggest) continue
      const s = ownerSuggestion(state, repos, repo)
      if (s) suggestions[repo.id] = s
    }
    return { connections, rules: state.rules, people: state.people, suggestions }
  }

  async repoView(repoId: string, cwd?: string): Promise<RepoServiceView[]> {
    const repo = this.deps.repo(repoId)
    const url = await this.deps.remoteUrl(repoId).catch(() => null)
    const own = this.ownServers(cwd ?? repo.rootPath)
    return INTEGRATION_SERVICES.map((service) => {
      const choice = repo.integrations?.services?.[service] ?? 'default'
      const resolution = this.resolve(repoId, service)
      const env = service === 'github' ? this.deps.repoGithubToken(repoId) : undefined
      return {
        service,
        choice,
        resolution,
        ...(env ? { envToken: env.from } : {}),
        ...(service === 'github' && url && isSshRemote(url) ? { sshRemote: true } : {}),
        ownServers: own.filter((s) => s.service === service),
        ownAllowed: Boolean(repo.integrations?.allowOwnMcp?.includes(service))
      }
    })
  }

  // ---- connections ----

  private async verify(service: IntegrationService, auth: ConnectionAuth, token?: string, sandbox: SandboxConnectionInput = {}): Promise<Verified> {
    if (service === 'vercel') return vercelTokenCheck(token!, sandbox.vercel ?? { teamId: '', projectId: '' }, this.fetch)
    // The provider modules check their own (src/main/cloud/*Provider.ts).
    if (service === 'docker') return verifyDocker(sandbox.docker ?? {})
    if (service === 'e2b') return verifyE2b(token!, sandbox.e2b ?? {}, this.fetch)
    if (service === 'daytona') return verifyDaytona(token!, { apiUrl: sandbox.daytona?.apiUrl || DAYTONA_API_URL, target: sandbox.daytona?.target }, this.fetch)
    if (service === 'github') {
      if (auth.kind === 'gh-account') return { identity: await githubTokenUser(await this.deps.accountToken(auth.login), this.fetch) }
      if (auth.kind === 'gh-active') {
        const login = await this.deps.activeLogin()
        if (!login) throw new Error('gh isn’t signed in to github.com. Run gh auth login, or add a token instead.')
        return { identity: { user: login, url: `https://github.com/${login}`, checkedAt: new Date().toISOString() } }
      }
      return { identity: await githubTokenUser(token!, this.fetch) }
    }
    if (service === 'langfuse') {
      const host = normalizeLangfuseHost(sandbox.langfuse?.host)
      if ('error' in host) throw new Error(host.error)
      const publicKey = sandbox.langfuse?.publicKey.trim() ?? ''
      return { identity: await langfuseProject({ host: host.host, publicKey, secretKey: token! }, this.fetch), langfuse: { host: host.host, publicKey } }
    }
    if (service === 'linear') {
      const identity = await linearViewer(token!, this.fetch)
      const github = await linearHasGithub(token!, this.fetch)
      return { identity, ...(github === null ? {} : { linearGithub: github }) }
    }
    const { botUserId: _bot, ...identity } = await slackAuthTest(token!, this.fetch)
    return { identity }
  }

  async addConnection(input: NewConnection): Promise<AddResult> {
    const token = 'token' in input ? input.token.trim() : undefined
    if (input.auth.kind === 'token' && !token) return { ok: false, error: 'Paste a token first' }
    let checked: Verified
    try {
      checked = await this.verify(input.service, input.auth, token, sandboxInput(undefined, input as SandboxConnectionInput))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const state = this.state()
    // The same account twice is usually a pasted-the-wrong-key mistake (Personal vs Acme). Vercel: the same project.
    const same = state.connections.find(
      (c) =>
        c.service === input.service &&
        c.identity &&
        (input.service === 'github' ? c.identity.user === checked.identity.user : c.identity.orgId === checked.identity.orgId) &&
        (input.service !== 'vercel' || c.vercel?.projectId === checked.vercel?.projectId)
    )
    if (same && !('allowDuplicate' in input && input.allowDuplicate)) return { ok: false, error: 'duplicate', duplicateOf: same.name, identity: checked.identity }
    const id = randomUUID()
    if (token) this.deps.secrets.setAppSecret(secretKey(id), token)
    const connection: Connection = {
      id,
      service: input.service,
      name: input.name?.trim() || defaultName(input.service, checked.identity, input.auth),
      rev: 1,
      auth: input.auth,
      identity: checked.identity,
      ...(token ? { hint: hint(token) } : {}),
      agentAccess: input.service === 'linear' || input.service === 'langfuse' ? accessFor(input.service, ('agentAccess' in input && input.agentAccess) || 'read') : 'off',
      ...(input.service === 'slack' ? { slack: { destinations: [] } } : {}),
      ...(checked.linearGithub !== undefined ? { linearGithub: checked.linearGithub } : {}),
      ...checkedInfo(checked),
      createdAt: new Date().toISOString()
    }
    state.connections.push(connection)
    // The first connection of a service becomes its default.
    if (!state.defaults[input.service]) state.defaults[input.service] = id
    this.save()
    return { ok: true, connection: this.view().connections.find((c) => c.id === id)! }
  }

  async updateConnection(id: string, patch: ConnectionPatch): Promise<AddResult> {
    const c = this.mustConnection(id)
    // A sandbox service's other settings (Vercel's team or project, a Docker context, an API URL), or Langfuse's host and public key, are checked with the key they'll be used with.
    const sandbox = hasSettings(c.service) ? sandboxInput(c, patch) : undefined
    const sandboxPatched = (isSandboxService(c.service) || c.service === 'langfuse') && patch[c.service] !== undefined
    if (sandbox && sandboxPatched && patch.token === undefined) {
      let checked: Verified
      try {
        checked = await this.verify(c.service, c.auth, c.auth.kind === 'token' ? this.secret(id) ?? '' : undefined, sandbox)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Another Docker daemon is fine (it's where the connection points); another team or account is a new connection.
      if (c.service !== 'docker' && c.identity && checked.identity.orgId !== c.identity.orgId) return { ok: false, error: `That team is ${checked.identity.org ?? checked.identity.orgId}, not ${c.identity.org ?? c.identity.orgId}. Add it as a new connection instead.`, identity: checked.identity }
      c.identity = checked.identity
      Object.assign(c, checkedInfo(checked))
      delete c.problem
      c.rev++
    }
    if (patch.token !== undefined) {
      const token = patch.token.trim()
      if (!token) return { ok: false, error: 'Paste a token first' }
      let checked: Verified
      try {
        checked = await this.verify(c.service, c.auth, token, sandbox)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      // A replacement key must be the same account: a different one is a new connection.
      const sameAccount = c.service === 'github' ? checked.identity.user === c.identity?.user : checked.identity.orgId === c.identity?.orgId
      if (c.identity && !sameAccount) return { ok: false, error: `That token is for ${checked.identity.org ?? checked.identity.user}, not ${c.identity.org ?? c.identity.user}. Add it as a new connection instead.`, identity: checked.identity }
      this.deps.secrets.setAppSecret(secretKey(id), token)
      c.hint = hint(token)
      c.identity = checked.identity
      if (checked.linearGithub !== undefined) c.linearGithub = checked.linearGithub
      Object.assign(c, checkedInfo(checked))
      delete c.problem
      c.rev++
    }
    if (patch.name !== undefined && patch.name.trim()) c.name = patch.name.trim()
    if (patch.agentAccess !== undefined && accessFor(c.service, patch.agentAccess) !== c.agentAccess) {
      c.agentAccess = accessFor(c.service, patch.agentAccess)
      c.rev++
    }
    // Only what new workspaces start with: it grants nothing, so the revision stays.
    if (patch.startsOff !== undefined) {
      if (patch.startsOff) c.startsOff = true
      else delete c.startsOff
    }
    if (patch.slackMe !== undefined || patch.destinations !== undefined) {
      c.rev++
      c.slack ??= { destinations: [] }
      if (patch.slackMe !== undefined) {
        if (patch.slackMe) c.slack.me = patch.slackMe
        else delete c.slack.me
      }
      if (patch.destinations) c.slack.destinations = patch.destinations
    }
    this.save()
    return { ok: true, connection: this.view().connections.find((x) => x.id === id)! }
  }

  /** Check a connection again; a refusal marks it as needing attention (never silently replaced). */
  async checkConnection(id: string): Promise<ConnectionView> {
    const c = this.mustConnection(id)
    try {
      const checked = await this.verify(c.service, c.auth, c.auth.kind === 'token' ? this.secret(id) ?? '' : undefined, hasSettings(c.service) ? sandboxInput(c) : undefined)
      c.identity = checked.identity
      if (checked.linearGithub !== undefined) c.linearGithub = checked.linearGithub
      Object.assign(c, checkedInfo(checked))
      if (c.problem) {
        delete c.problem
        c.rev++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Only an answer that says the credential is bad marks it; being offline doesn't.
      const refused = (err as { auth?: boolean }).auth || (err instanceof LinearError && err.auth) || (err instanceof LangfuseError && err.auth) || isAuthError(err) || /isn’t signed in|refused/i.test(message)
      if (refused) this.markProblem(id, message)
      else throw err
    }
    this.save()
    return this.view().connections.find((x) => x.id === id)!
  }

  /** A service refused the credential while in use: the connection needs attention. */
  markProblem(id: string, problem: string): void {
    const c = this.connection(id)
    if (!c || c.problem === problem) return
    c.problem = problem
    c.rev++
    this.save()
  }

  /** Checks every connection, quietly (at startup and now and then). */
  async checkAll(): Promise<void> {
    for (const c of [...this.state().connections]) await this.checkConnection(c.id).catch(() => undefined)
  }

  /** What removing a connection affects, for the confirmation. */
  removalImpact(id: string): { repos: string[]; isDefault: boolean; rules: number } {
    const state = this.state()
    const c = this.mustConnection(id)
    const repos = this.deps.store.state.repos.filter((r) => resolvedConnection(resolveIntegration(state, r, c.service))?.id === id).map((r) => r.name)
    return { repos, isDefault: state.defaults[c.service] === id, rules: state.rules.filter((r) => r.connectionId === id).length }
  }

  removeConnection(id: string): void {
    const state = this.state()
    const c = this.mustConnection(id)
    state.connections = state.connections.filter((x) => x.id !== id)
    // Keep a removed default unresolved, so GitHub cannot fall through to gh's active account.
    state.rules = state.rules.filter((r) => r.connectionId !== id)
    if (c.service === 'slack' && c.identity?.orgId) state.people = state.people.filter((p) => p.slackTeamId !== c.identity!.orgId || state.connections.some((x) => x.identity?.orgId === p.slackTeamId))
    // Repositories that chose it keep the choice, so they show it as removed rather than quietly using the default.
    this.deps.secrets.setAppSecret(secretKey(id), null)
    this.save()
  }

  setDefault(service: IntegrationService, id: string | null): void {
    const state = this.state()
    if (id) {
      const c = this.mustConnection(id)
      if (c.service !== service) throw new Error('That connection is for another service')
      state.defaults[service] = id
    } else delete state.defaults[service]
    this.save()
  }

  // ---- repositories ----

  private repoIntegrations(repoId: string): RepoIntegrations {
    const repo = this.deps.repo(repoId)
    repo.integrations ??= {}
    return repo.integrations
  }

  /** A repository's stored choices (undefined for an unknown repository). */
  repoChoices(repoId: string): RepoIntegrations | undefined {
    try {
      return this.deps.repo(repoId).integrations
    } catch {
      return undefined
    }
  }

  /** A repository's choice for a service: 'default', 'off' or a connection id. */
  setRepoChoice(repoId: string, service: IntegrationService, choice: string): void {
    const ri = this.repoIntegrations(repoId)
    if (choice !== 'default' && choice !== 'off') {
      const c = this.mustConnection(choice)
      if (c.service !== service) throw new Error('That connection is for another service')
    }
    ri.services ??= {}
    if (choice === 'default') delete ri.services[service]
    else ri.services[service] = choice
    if (service === 'github') delete ri.githubDetected
    if (service === 'github') delete ri.githubSuggestion
    delete ri.suggest
    this.save()
  }

  setRepoOptions(repoId: string, options: { rules?: 'mine' | 'off'; allowOwnMcp?: IntegrationService[]; dismissSuggestion?: boolean; starts?: Partial<Record<RepoIntegrationService, 'on' | 'off' | 'default'>> }): void {
    const ri = this.repoIntegrations(repoId)
    if (options.rules) ri.rules = options.rules
    if (options.allowOwnMcp) ri.allowOwnMcp = options.allowOwnMcp.filter((s) => (INTEGRATION_SERVICES as IntegrationService[]).includes(s))
    if (options.dismissSuggestion) delete ri.suggest
    for (const service of AGENT_TOOL_SERVICES) {
      const v = options.starts?.[service]
      if (v === 'on' || v === 'off') ri.starts = { ...ri.starts, [service]: v }
      else if (v === 'default' && ri.starts) delete ri.starts[service]
    }
    if (ri.starts && !Object.keys(ri.starts).length) delete ri.starts
    this.save()
  }

  /** "Use in repositories…": the ticked repositories choose this connection explicitly; unticked ones that chose it go back to the default. */
  applyToRepos(connectionId: string, repoIds: string[]): void {
    const c = this.mustConnection(connectionId)
    const ticked = new Set(repoIds)
    for (const repo of this.deps.store.state.repos) {
      const ri = (repo.integrations ??= {})
      ri.services ??= {}
      if (ticked.has(repo.id)) {
        ri.services[c.service] = connectionId
        if (c.service === 'github') delete ri.githubDetected
      } else if (ri.services[c.service] === connectionId) delete ri.services[c.service]
    }
    this.save()
  }

  /** "Use the same" on an added repository's suggestion. */
  acceptSuggestion(repoId: string): void {
    const repo = this.deps.repo(repoId)
    const s = ownerSuggestion(this.state(), this.deps.store.state.repos, repo)
    const ri = this.repoIntegrations(repoId)
    if (s) ri.services = { ...ri.services, ...s.services }
    delete ri.suggest
    this.save()
  }

  /** A repository was added: offer its siblings' choices once. */
  repoAdded(repoId: string): void {
    const repo = this.deps.repo(repoId)
    if (ownerSuggestion(this.state(), this.deps.store.state.repos, repo)) {
      this.repoIntegrations(repoId).suggest = true
      this.save()
    }
  }

  /** Foreman found the one signed-in gh account that can push (several are signed in): link it, marked as Foreman's pick. */
  detectedGithubAccount(repoId: string, login: string | null, explicit = false): void {
    const repo = this.deps.repo(repoId)
    const ri = (repo.integrations ??= {})
    if (explicit && login) {
      ri.services = { ...ri.services, github: this.ghAccountConnection(login).id }
      delete ri.githubDetected
      this.save()
      return
    }
    if (ri.services?.github && !ri.githubDetected) return
    if (!login) {
      delete ri.githubSuggestion
      this.save()
      return
    }
    const c = this.ghAccountConnection(login)
    ri.githubSuggestion = c.id
    if (ri.githubDetected) delete ri.services?.github
    delete ri.githubDetected
    this.save()
  }

  /** The connection for a gh account, made (unchecked) when there isn't one yet. */
  private ghAccountConnection(login: string): Connection {
    const state = this.state()
    const found = state.connections.find((c) => c.service === 'github' && c.auth.kind === 'gh-account' && c.auth.login === login)
    if (found) return found
    const c: Connection = { id: randomUUID(), service: 'github', name: `GitHub · ${login}`, rev: 1, auth: { kind: 'gh-account', login }, identity: { user: login, url: `https://github.com/${login}`, checkedAt: new Date().toISOString() }, agentAccess: 'off', createdAt: new Date().toISOString() }
    state.connections.push(c)
    return c
  }

  // ---- Slack rules and people ----

  saveRule(rule: SlackRule): SlackRule {
    const state = this.state()
    const c = this.mustConnection(rule.connectionId)
    if (c.service !== 'slack') throw new Error('Rules need a Slack connection')
    const existing = state.rules.find((r) => r.id === rule.id)
    const next: SlackRule = { ...rule, id: rule.id || randomUUID(), template: rule.template.slice(0, 1000) }
    // Consent covers the rule as agreed to; anything else goes back to asking first.
    if (next.consent && next.consent.fingerprint !== ruleFingerprint(next)) {
      delete next.consent
      next.mode = 'ask'
    }
    if (next.mode === 'auto' && next.recipient !== 'me' && !next.consent) next.mode = 'ask'
    if (next.recipient === 'channel' && (!next.channel || !c.slack?.destinations.some((d) => d.id === next.channel!.id))) throw new Error('Choose a channel allowed by this Slack connection.')
    if (existing) state.rules = state.rules.map((r) => (r.id === existing.id ? next : r))
    else state.rules.push(next)
    this.save()
    return next
  }

  /** The user agreed, in the consent sheet, to send this rule's messages without asking. */
  consentRule(id: string): SlackRule {
    const rule = this.state().rules.find((r) => r.id === id)
    if (!rule) throw new Error('That rule no longer exists')
    rule.mode = 'auto'
    rule.consent = { at: new Date().toISOString(), fingerprint: ruleFingerprint(rule) }
    this.save()
    return rule
  }

  deleteRule(id: string): void {
    const state = this.state()
    state.rules = state.rules.filter((r) => r.id !== id)
    this.save()
  }

  linkPerson(link: PersonLink): void {
    const state = this.state()
    state.people = [...state.people.filter((p) => !(p.githubLogin.toLowerCase() === link.githubLogin.toLowerCase() && p.slackTeamId === link.slackTeamId)), link]
    this.save()
  }

  unlinkPerson(githubLogin: string, slackTeamId: string): void {
    const state = this.state()
    state.people = state.people.filter((p) => !(p.githubLogin.toLowerCase() === githubLogin.toLowerCase() && p.slackTeamId === slackTeamId))
    this.save()
  }

  // ---- the user's own MCP servers ----

  /**
   * Linear, GitHub, Slack and Langfuse servers the user set up in Claude Code (~/.claude.json, the worktree's
   * .mcp.json) or Codex (~/.codex/config.toml), plus the claude.ai connectors Claude Code may add.
   * Read only; Foreman never edits these files.
   */
  ownServers(cwd?: string): OwnMcpServer[] {
    const home = this.deps.home ?? os.homedir()
    const out: OwnMcpServer[] = []
    const add = (list: OwnMcpServer[]) => {
      for (const s of list) if (!out.some((o) => o.name === s.name && o.from === s.from)) out.push(s)
    }
    add(this.cached(path.join(home, '.claude.json'), (text) => claudeServers(JSON.parse(text) as Record<string, unknown>)))
    if (cwd) add(this.cached(path.join(cwd, '.mcp.json'), (text) => claudeServers(JSON.parse(text) as Record<string, unknown>)))
    add(this.cached(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), (text) => codexServers(parseToml(text) as Record<string, unknown>)))
    for (const service of INTEGRATION_SERVICES) {
      const name = CLAUDE_AI_CONNECTORS[service]
      if (name) add([{ name, from: 'claude.ai', service }])
    }
    return out
  }

  private cached(file: string, read: (text: string) => OwnMcpServer[]): OwnMcpServer[] {
    try {
      if (!existsSync(file)) return []
      const { mtimeMs } = statSync(file)
      const hit = this.ownCache.get(file)
      if (hit && hit.mtimeMs === mtimeMs) return hit.servers
      const servers = read(readFileSync(file, 'utf8'))
      this.ownCache.set(file, { mtimeMs, servers })
      return servers
    } catch {
      return []
    }
  }

  // ---- one-time migration from the single GitHub token and per-repo gh accounts ----

  /**
   * Idempotent and restart-safe: the old token stays in the vault until the next launch after the
   * new references were saved, and nothing here changes who GitHub work runs as.
   */
  migrate(): void {
    const s = this.deps.store.state
    s.migrations ??= []
    if (s.migrations.includes(MIGRATION)) {
      // Done on an earlier launch, whose state was saved: the old token can go now.
      if (s.migrations.includes(`${MIGRATION}:cleanup`) || !this.deps.secrets.appSecret('GH_TOKEN')) return
      if (this.state().connections.some((c) => c.auth.kind === 'token' && c.service === 'github' && this.secret(c.id))) this.deps.secrets.setAppSecret('GH_TOKEN', null)
      s.migrations.push(`${MIGRATION}:cleanup`)
      this.deps.store.save()
      return
    }
    const state = this.state()
    const now = new Date().toISOString()
    const pat = this.deps.secrets.appSecret('GH_TOKEN')
    if (pat) {
      const id = randomUUID()
      this.deps.secrets.setAppSecret(secretKey(id), pat)
      state.connections.push({ id, service: 'github', name: 'GitHub token', rev: 1, auth: { kind: 'token' }, hint: hint(pat), agentAccess: 'off', createdAt: now })
      if (s.settings.githubAuth === 'token') state.defaults.github = id
    }
    if (!state.defaults.github) {
      const id = randomUUID()
      state.connections.push({ id, service: 'github', name: 'GitHub (gh’s signed-in account)', rev: 1, auth: { kind: 'gh-active' }, agentAccess: 'off', createdAt: now })
      state.defaults.github = id
    }
    for (const repo of s.repos) {
      if (!repo.githubAccount) continue
      const c = this.ghAccountConnection(repo.githubAccount)
      repo.integrations = repo.githubAccountDetected
        ? { ...repo.integrations, githubSuggestion: c.id }
        : { ...repo.integrations, services: { ...repo.integrations?.services, github: c.id } }
      delete repo.githubAccount
      delete repo.githubAccountDetected
    }
    // The token now belongs to its connection; the old switch goes back to gh so nothing reads it twice.
    s.settings.githubAuth = 'cli'
    s.migrations.push(MIGRATION)
    this.deps.store.save()
  }
}

function claudeServers(json: Record<string, unknown>): OwnMcpServer[] {
  const out: OwnMcpServer[] = []
  const scan = (servers: unknown) => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, config] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
      const service = ownServerService(name, config ?? {})
      if (service) out.push({ name, from: 'claude', service })
    }
  }
  scan(json.mcpServers)
  // Local-scope servers live per project folder.
  if (json.projects && typeof json.projects === 'object') for (const p of Object.values(json.projects as Record<string, Record<string, unknown>>)) scan(p?.mcpServers)
  return out
}

function codexServers(toml: Record<string, unknown>): OwnMcpServer[] {
  const out: OwnMcpServer[] = []
  const servers = toml.mcp_servers
  if (!servers || typeof servers !== 'object') return out
  for (const [name, config] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
    const service = ownServerService(name, config ?? {})
    if (service) out.push({ name, from: 'codex', service })
  }
  return out
}
