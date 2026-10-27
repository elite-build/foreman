// Git and pull-request status for a workspace, via git and the GitHub CLI.
// A cloud workspace's git and gh run in its sandbox; gh there runs as the
// repository's GitHub connection (GH_TOKEN per command), never this computer's login.
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BranchPrefixType, GithubAccount, GithubStatus, GitStatus, PrCheck, PullRequestInfo, Settings, Workspace } from '../shared/types'
import { baseStartPoint, git, revParse, type GitTarget } from './git'
import { cloudSandboxes, workspaceTarget } from './runtime'
import { wsPath } from '../shared/workspacePath'

// A personal access token from Settings → Account, used instead of gh's own login.
let token: string | undefined
let login: Promise<string | undefined> | null = null
// Logins of identity keys that aren't a gh account (see setGithubIdentities).
const logins = new Map<string, Promise<string | undefined>>()

/** Returns whether the token changed. */
export function useGithubToken(value: string | undefined): boolean {
  if (value === token) return false
  token = value
  login = null
  return true
}

// ---- accounts linked to repositories ----

type GhHost = { login: string; active: boolean; state: string }

/** Every github.com account signed in to gh (gh 2.40+ can hold several). */
export async function githubAccounts(): Promise<GithubAccount[]> {
  const out = await runGh(process.cwd(), ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], 10_000, {}, true)
  const hosts = ((JSON.parse(out) as { hosts?: Record<string, GhHost[]> }).hosts ?? {})['github.com'] ?? []
  // The same answer gh's active account comes from: keep it.
  activeGen++
  activeLookup = null
  setActive(hosts.find((a) => a.active && a.state === 'success')?.login)
  return hosts.filter((a) => a.state === 'success').map((a) => ({ login: a.login, active: a.active }))
}

// gh takes over a second to answer on some machines, and the main process must never wait for it: every
// lookup below runs gh asynchronously, once at a time, and readers that can't wait get the last answer.
// An entry whose `at` is 0 was invalidated (a sign-in or sign-out, an auth failure): readers that can't
// wait still get it while it reloads, async ones wait for the new answer. `gen` drops answers to lookups
// started before an invalidation.
const TOKEN_TTL = 10 * 60_000
// gh's active account changes outside Foreman (gh auth switch), so its answer is kept briefly: readers that can't wait
// get it for this long, then the old answer while gh is asked again. Turns, git actions and a window gaining focus ask
// gh afresh (ghActiveAccountAsync(true), refreshGhActiveAccount) rather than wait for this.
const ACTIVE_TTL = 60_000
// How long "gh has no answer" (signed out, or gh failed) is kept before asking again.
const FAILED_TTL = 30_000
const tokens = new Map<string, { value: string; at: number }>()
const tokenLoads = new Map<string, Promise<string>>()
// Accounts gh had no token for, and when it said so.
const signedOut = new Map<string, number>()
let tokenGen = 0

function notSignedIn(account: string): Error {
  return new Error(`GitHub account ${account} isn’t signed in to gh. Sign in as ${account} in Settings → Account, or pick another account in this repo’s Git settings.`)
}

/** Reads an account's token from gh's keyring, one lookup at a time per account. */
function loadAccountToken(account: string): Promise<string> {
  const pending = tokenLoads.get(account)
  if (pending) return pending
  const gen = tokenGen
  const load = runGh(process.cwd(), ['auth', 'token', '--hostname', 'github.com', '--user', account], 10_000, {}, true)
    .then((out) => out.trim(), () => '')
    .then((value) => {
      if (gen === tokenGen && value) {
        tokens.set(account, { value, at: Date.now() })
        signedOut.delete(account)
      } else if (gen === tokenGen) {
        tokens.delete(account)
        signedOut.set(account, Date.now())
      }
      if (!value) throw notSignedIn(account)
      return value
    })
  tokenLoads.set(account, load)
  void load.catch(() => undefined).finally(() => tokenLoads.get(account) === load && tokenLoads.delete(account))
  return load
}

const recentlySignedOut = (account: string) => Date.now() - (signedOut.get(account) ?? -Infinity) < FAILED_TTL

/**
 * The token gh holds for an account, from its keyring. Cached; a stale entry is still used
 * while it refreshes in the background, so this waits for gh only when nothing usable is cached.
 */
export async function accountTokenAsync(account: string): Promise<string> {
  const hit = tokens.get(account)
  if (hit?.at) {
    if (Date.now() - hit.at >= TOKEN_TTL) void loadAccountToken(account).catch(() => undefined)
    return hit.value
  }
  if (!hit && recentlySignedOut(account)) throw notSignedIn(account)
  return loadAccountToken(account)
}

/**
 * The same for callers that can't wait (agents' and terminals' environments): never runs gh while
 * they wait. A stale or invalidated token is still used while it reloads; with none cached yet this
 * throws, having started the lookup, and callers give no GitHub credentials rather than another account's.
 */
export function accountToken(account: string): string {
  const hit = tokens.get(account)
  const signedOutNow = !hit && recentlySignedOut(account)
  if (!signedOutNow && (!hit?.at || Date.now() - hit.at >= TOKEN_TTL)) void loadAccountToken(account).catch(() => undefined)
  if (hit) return hit.value
  if (signedOutNow) throw notSignedIn(account)
  throw new Error(`GitHub account ${account}’s token is still loading from gh. Try again in a moment.`)
}

/** Forget cached answers (after a sign-in or sign-out). */
export function forgetAccountTokens(): void {
  tokenGen++
  tokenLoads.clear()
  signedOut.clear()
  for (const hit of tokens.values()) hit.at = 0
  // gh's active account may now be someone else: nobody, until gh says who, rather than the last one.
  activeGen++
  activeLookup = null
  activeAccount = undefined
}

let activeAccount: { login?: string; at: number; ttl: number } | undefined
let activeLookup: Promise<string | undefined> | null = null
let activeGen = 0

function setActive(login: string | undefined): void {
  activeAccount = { login, at: Date.now(), ttl: login ? ACTIVE_TTL : FAILED_TTL }
}

const activeFresh = () => Boolean(activeAccount?.at) && Date.now() - activeAccount!.at < activeAccount!.ttl

/** Asks gh for its active keyring account, independently of shell or repository tokens; one lookup at a time. */
function lookUpActiveAccount(): Promise<string | undefined> {
  if (activeLookup) return activeLookup
  const gen = activeGen
  const lookup = runGh(process.cwd(), ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], 10_000, {}, true)
    .then((raw) => ((JSON.parse(raw) as { hosts?: Record<string, GhHost[]> }).hosts?.['github.com'] ?? []).find((a) => a.active && a.state === 'success')?.login)
    .catch(() => undefined)
    .then((login) => {
      if (gen === activeGen) setActive(login)
      return login
    })
  activeLookup = lookup
  void lookup.finally(() => activeLookup === lookup && (activeLookup = null))
  return lookup
}

/**
 * gh's active account, for callers that can't wait: never runs gh while they wait. The last answer,
 * refreshed in the background when it's old; undefined until gh has first answered (and after a
 * sign-in or sign-out until it answers again), which callers treat as no account, never another.
 */
export function ghActiveAccount(): string | undefined {
  if (!activeFresh()) void lookUpActiveAccount()
  return activeAccount?.login
}

/** gh's active account: the cached answer while it's usable, else gh's. `fresh` always asks gh. */
export async function ghActiveAccountAsync(fresh = false): Promise<string | undefined> {
  // An old answer is used while gh is asked again in the background; an old "nobody" isn't.
  if (!fresh && activeAccount?.at && (activeFresh() || activeAccount.login)) return ghActiveAccount()
  return lookUpActiveAccount()
}

/**
 * Asks gh again for its active account in the background (a window gaining focus: the user may have run gh auth switch
 * elsewhere), unless its last answer is younger than `minAgeMs`. Never waits, and never runs gh twice at once.
 */
export function refreshGhActiveAccount(minAgeMs = 0): void {
  if (activeAccount?.at && Date.now() - activeAccount.at < minAgeMs) return
  void lookUpActiveAccount()
}

/** Settles once gh's active account is known at all (at once if it is), for readers that can wait for a first answer. */
export function ghActiveAccountReady(): Promise<void> {
  return activeAccount ? Promise.resolve() : lookUpActiveAccount().then(() => undefined)
}

/** gh or GitHub refused the credentials `account` runs as: ask gh again on the next use. */
function authFailed(account: string | undefined): void {
  const hit = account && !SPECIAL.test(account) ? tokens.get(account) : undefined
  if (hit) hit.at = 0
  if (activeAccount && (!account || account === activeAccount.login)) activeAccount.at = 0
}

/**
 * Asks gh, in the background, for what readers that can't wait will need: gh's active account
 * when a connection follows it, and the tokens of the accounts connections run as.
 */
export async function warmGithub(accounts: string[], active: boolean): Promise<void> {
  const logins = new Set(accounts)
  if (active) {
    const login = await ghActiveAccountAsync()
    if (login) logins.add(login)
  }
  await Promise.all([...logins].map((login) => accountTokenAsync(login).catch(() => undefined)))
}

/**
 * Makes git use gh's credential helper for github.com, whatever the user's
 * gitconfig says, so GH_TOKEN decides who pushes over HTTPS.
 */
export function credentialHelperEnv(): Record<string, string> {
  const key = 'credential.https://github.com.helper'
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: '!gh auth git-credential'
  }
}

// ---- identities from Integrations ----

/**
 * Integrations resolve each repository to an identity key (see Integrations.githubKey): a gh
 * login, or one of these, which only the registered resolver can turn into a token.
 *   token:<connection>  a saved personal access token
 *   env:<repo>          the repository's own GH_TOKEN (its environment layers)
 *   off:<repo>          GitHub turned off for the repository
 *   blocked:<repo>      a chosen connection that can't be used; never another account instead
 */
type Identity = { token: string } | { off: string } | { blocked: string }
let identities: ((key: string) => Identity | null) | null = null

/** Integrations changed: tokens behind keys may now be other users. */
export function forgetIdentityLogins(): void {
  logins.clear()
}

export function setGithubIdentities(resolve: ((key: string) => Identity | null) | null): void {
  identities = resolve
  logins.clear()
}

const SPECIAL = /^(token|env|off|blocked):/

/** GitHub can't be used as this key: off for the repository, or its connection is broken (`blocked`). */
export class GithubUnavailable extends Error {
  constructor(
    message: string,
    readonly blocked: boolean
  ) {
    super(message)
  }
}

function special(key: string): Identity {
  return identities?.(key) ?? { blocked: 'This repository’s GitHub connection isn’t available.' }
}

let emptyConfig: string | undefined

/**
 * An environment with no GitHub credentials: gh reads an empty config folder, and git's
 * credential helpers for github.com are cleared. For a repository whose chosen connection can't be
 * used, so nothing falls through to the user's own login.
 */
export function noGithubEnv(): Record<string, string> {
  if (!emptyConfig) {
    emptyConfig = mkdtempSync(path.join(os.tmpdir(), 'foreman-no-github-'))
  }
  return {
    GH_CONFIG_DIR: emptyConfig,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: ''
  }
}

/**
 * Extra environment that makes gh, and git through gh, act as the right account:
 * the repository's connection (a gh account or a saved token), else gh's active account.
 * Throws GithubUnavailable when the repository has GitHub off, or its connection can't be used.
 */
export function githubEnv(account?: string): Record<string, string> {
  if (account && SPECIAL.test(account)) {
    const id = special(account)
    if ('token' in id) return account.startsWith('env:') ? { GH_TOKEN: id.token } : { GH_TOKEN: id.token, ...credentialHelperEnv() }
    throw new GithubUnavailable('off' in id ? id.off : id.blocked, 'blocked' in id)
  }
  if (account) return { GH_TOKEN: accountToken(account), ...credentialHelperEnv() }
  return token ? { GH_TOKEN: token } : {}
}

/** githubEnv for callers that can wait: a gh account's token is read from gh when it isn't cached yet. */
export async function githubEnvAsync(account?: string): Promise<Record<string, string>> {
  if (account && !SPECIAL.test(account)) return { GH_TOKEN: await accountTokenAsync(account), ...credentialHelperEnv() }
  return githubEnv(account)
}

/**
 * The same for agents, terminals and checks, which must start whatever happens: a broken
 * connection gives no GitHub credentials at all, GitHub off adds nothing, and a signed-out
 * gh account (or one whose token gh hasn't given yet) gives none rather than gh's active one.
 */
export function githubEnvOrNone(account?: string): Record<string, string> {
  try {
    return githubEnv(account)
  } catch (err) {
    if (err instanceof GithubUnavailable && !err.blocked) return {}
    return noGithubEnv()
  }
}

/** This process's environment; with keyring, minus tokens that would hide gh's own accounts. */
function ownEnv(keyring = false): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (keyring) for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[name]
  return env
}

/**
 * Environment for git talking to a repo's remote (fetch): as the linked account
 * when it's signed in, otherwise git's own credentials. Never throws.
 */
export async function remoteGitEnv(account: string | undefined): Promise<Record<string, string>> {
  if (!account) return {}
  try {
    return await githubEnvAsync(account)
  } catch (err) {
    if (err instanceof GithubUnavailable && !err.blocked) return {}
    return noGithubEnv()
  }
}

function runGh(cwd: string, args: string[], timeoutMs: number, env: Record<string, string>, keyring = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = { ...ownEnv(keyring), ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
    execFile('gh', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: full }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)
    )
  })
}

/** Runs gh, as `account` when given. */
export async function gh(cwd: string, args: string[], timeoutMs = 20_000, account?: string): Promise<string> {
  const env = await githubEnvAsync(account)
  return runGh(cwd, args, timeoutMs, env).catch((err: Error) => {
    if (classifyGhError(err.message) === 'auth-error') authFailed(account)
    throw err
  })
}

/**
 * gh for a cloud workspace, shaped like `gh`: it runs in the sandbox as the repository's connection, so the folder
 * and account arguments don't apply. A read never wakes a sleeping sandbox; `wake` is for the user's actions.
 */
export function sandboxGh(ws: Workspace, options: { wake?: boolean } = {}): typeof gh {
  return (_cwd, args, timeoutMs) => cloudSandboxes().gh(ws, args, timeoutMs, options)
}

/** A gh runner bound to an account (or the default identity when undefined). */
export function ghAs(account: string | undefined): typeof gh {
  return (cwd, args, timeoutMs, override) => gh(cwd, args, timeoutMs, override ?? account)
}

/** The signed-in GitHub username, cached until the token changes. A linked account is its own answer. */
export function githubLogin(account?: string): Promise<string | undefined> {
  if (account && SPECIAL.test(account)) {
    // A token's (or the repository's own GH_TOKEN's) user, asked once per key.
    let hit = logins.get(account)
    if (!hit) {
      hit = gh(process.cwd(), ['api', 'user', '--jq', '.login'], 10_000, account).then(
        (out) => out.trim() || undefined,
        () => undefined
      )
      logins.set(account, hit)
    }
    return hit
  }
  if (account) return Promise.resolve(account)
  login ??= gh(process.cwd(), ['api', 'user', '--jq', '.login'], 10_000).then(
    (out) => out.trim() || undefined,
    () => undefined
  )
  return login
}

/** "owner/name" for a github.com remote URL (https, ssh or scp-style), else null. */
export function githubSlug(remoteUrl: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** Whether a remote URL goes over SSH, where SSH keys, not the account, decide who pushes. */
export function isSshRemote(remoteUrl: string): boolean {
  return /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(remoteUrl.trim())
}

/**
 * The one signed-in account that can push to `slug`. An account named like the
 * owner wins a tie; otherwise a tie, or no account, is null.
 */
export async function detectAccount(
  slug: string,
  accounts: string[],
  canPush: (slug: string, account: string) => Promise<boolean> = (s, a) =>
    gh(process.cwd(), ['api', `repos/${s}`, '--jq', '.permissions.push'], 15_000, a).then((out) => out.trim() === 'true')
): Promise<{ account: string | null; pushers: string[] }> {
  const results = await Promise.all(accounts.map((a) => canPush(slug, a).catch(() => false)))
  const pushers = accounts.filter((_, i) => results[i])
  if (pushers.length === 1) return { account: pushers[0], pushers }
  const owner = slug.split('/')[0].toLowerCase()
  const named = pushers.find((a) => a.toLowerCase() === owner)
  return { account: named ?? null, pushers }
}

export async function githubStatus(method: Settings['githubAuth'], tokenSaved: boolean): Promise<GithubStatus> {
  const base = { method, tokenSaved }
  if (!(await ghAvailable())) return { ...base, installed: false, loggedIn: false, detail: 'The GitHub CLI (gh) is not installed' }
  if (method === 'token' && !token) return { ...base, installed: true, loggedIn: false, detail: 'No token saved' }
  const user = await githubLogin()
  if (user) return { ...base, installed: true, loggedIn: true, user }
  const detail = method === 'token' ? 'GitHub rejected the token' : 'Not signed in. Run gh auth login.'
  return { ...base, installed: true, loggedIn: false, detail }
}

/** Prefix for new branch names: the GitHub username, a custom string, or nothing. */
export async function branchPrefix(type: BranchPrefixType, custom: string, account?: string): Promise<string> {
  if (type === 'none') return ''
  if (type === 'custom') return custom
  const user = await githubLogin(account)
  return user ? `${user}/` : ''
}

let ghInstalled: boolean | null = null
export async function ghAvailable(): Promise<boolean> {
  if (ghInstalled === null) ghInstalled = await gh(process.cwd(), ['--version'], 5000).then(() => true, () => false)
  return ghInstalled
}

async function aheadBehind(cwd: GitTarget, range: string): Promise<{ behind: number; ahead: number } | null> {
  const r = await git(cwd, ['rev-list', '--left-right', '--count', range], { allowFail: true })
  if (r.code !== 0) return null
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number)
  return { behind: behind || 0, ahead: ahead || 0 }
}

type RollupItem = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

function checkState(item: RollupItem): PrCheck['state'] {
  if (item.__typename === 'StatusContext') {
    if (item.state === 'SUCCESS') return 'success'
    if (item.state === 'PENDING' || item.state === 'EXPECTED') return 'pending'
    return 'failure'
  }
  if (item.status && item.status !== 'COMPLETED') return 'pending'
  switch (item.conclusion) {
    case 'SUCCESS':
      return 'success'
    case 'SKIPPED':
      return 'skipped'
    case 'NEUTRAL':
      return 'neutral'
    default:
      return 'failure'
  }
}

export function parseChecks(rollup: RollupItem[] | undefined): PrCheck[] {
  return (rollup ?? []).map((item) => {
    const url = item.detailsUrl ?? item.targetUrl
    const run = url ? /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url) : null
    return {
      name: item.name ?? item.context ?? 'check',
      state: checkState(item),
      url,
      runId: run ? Number(run[1]) : undefined,
      jobId: run?.[2] ? Number(run[2]) : undefined
    }
  })
}

/** What a pull-request lookup found. Failures are told apart from "no PR" so callers can back off or say why. */
export type PrResult =
  | { kind: 'ok'; pr: PullRequestInfo; headRefOid: string; /** owner/name of the base repository. */ repo: string }
  | { kind: 'no-pr' }
  | { kind: 'auth-error'; message: string }
  | { kind: 'unavailable'; message: string; rateLimited?: boolean }

/** Sort a gh failure by its message. Rate limits first: their text often mentions authentication too. */
export function classifyGhError(message: string): 'no-pr' | 'auth-error' | 'rate-limit' | 'unavailable' {
  if (/rate limit|http 429|abuse detection|secondary rate/i.test(message)) return 'rate-limit'
  if (/gh auth login|not logged in|authentication|bad credentials|http 401|requires authentication|must be authenticated/i.test(message)) return 'auth-error'
  if (/no pull requests? found|could not resolve to a pullrequest|no open pull requests|not a git repository|none of the git remotes|no git remotes|no default remote/i.test(message)) return 'no-pr'
  return 'unavailable'
}

/** owner/name of the base repository, from the PR's URL, else the stored one. */
export function prRepo(pr: Pick<PullRequestInfo, 'url'>, ws: Pick<Workspace, 'pullRequest'>): string {
  try {
    const match = /^\/([^/]+\/[^/]+)\/pull\/\d+/.exec(new URL(pr.url).pathname)
    if (match) return match[1]
  } catch {
    // Not a URL; fall back.
  }
  return ws.pullRequest?.repo ?? ''
}

/**
 * G2 (#21): who has approved, from `gh pr view --json reviews` (oldest first): each reviewer's latest approving,
 * change-requesting or dismissed review decides; plain comments don't change it.
 */
export function approversFrom(reviews: unknown): string[] {
  if (!Array.isArray(reviews)) return []
  const latest = new Map<string, string>()
  for (const r of reviews as { author?: { login?: string } | null; state?: string }[]) {
    const login = r?.author?.login
    if (!login || !r.state || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue
    latest.delete(login)
    latest.set(login, r.state)
  }
  return [...latest].filter(([, state]) => state === 'APPROVED').map(([login]) => login)
}

/** Who is asked to review now, from `gh pr view --json reviewRequests`: people by login, teams by slug. */
export function reviewRequestsFrom(raw: unknown): { login?: string; team?: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { login?: string; team?: string }[] = []
  for (const r of raw as { __typename?: string; login?: string; slug?: string; name?: string }[]) {
    if (r?.login) out.push({ login: String(r.login) })
    else if (r?.slug || r?.name) out.push({ team: String(r.slug ?? r.name) })
  }
  return out
}

/** Each reviewer's latest approving or change-requesting review, with its id (an occurrence for Slack rules). */
export function latestReviews(raw: unknown): { id: string; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' }[] {
  if (!Array.isArray(raw)) return []
  const latest = new Map<string, { id: string; author: string; state: string }>()
  for (const r of raw as { id?: string; author?: { login?: string } | null; state?: string }[]) {
    const login = r?.author?.login
    if (!login || !r.state || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue
    latest.set(login, { id: String(r.id ?? `${login}:${r.state}`), author: login, state: r.state })
  }
  return [...latest.values()].filter((r): r is { id: string; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' } => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
}

export async function pullRequest(ws: Workspace, request: typeof gh = gh): Promise<PrResult> {
  // gh is in a cloud sandbox's image; this computer's gh doesn't matter there.
  const cloud = ws.cloud ? sandboxGh(ws) : null
  if (!cloud && !(await ghAvailable())) return { kind: 'unavailable', message: 'The GitHub CLI (gh) is not installed' }
  const ask = (args: string[]) => (cloud ? cloud('', args) : request(wsPath(ws), args))
  const repoArgs = ws.pullRequest ? ['--repo', ws.pullRequest.repo] : []
  try {
    // A checked-out PR is found by its number in the base repository, which also works for fork PRs.
    const target = ws.pullRequest ? ['pr', 'view', String(ws.pullRequest.number), ...repoArgs] : ['pr', 'view', ws.branch]
    const raw = await ask([
      ...target, '--json',
      'number,url,title,body,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,statusCheckRollup,autoMergeRequest,reviews,author,reviewRequests,createdAt,mergedAt'
    ])
    const pr = JSON.parse(raw)
    const checks = parseChecks(pr.statusCheckRollup)
    // Only worth asking which checks are required when something failed.
    if (checks.some((c) => c.state === 'failure')) {
      const required = await ask(['pr', 'checks', String(pr.number), ...repoArgs, '--required', '--json', 'name'])
        .then((out) => new Set((JSON.parse(out) as { name: string }[]).map((c) => c.name)))
        .catch(() => null)
      if (required) for (const check of checks) check.required = required.has(check.name)
    }
    const info: PullRequestInfo = {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision || undefined,
      baseRefName: pr.baseRefName,
      checks,
      autoMerge: Boolean(pr.autoMergeRequest)
    }
    const approvedBy = approversFrom(pr.reviews)
    if (approvedBy.length) info.approvedBy = approvedBy
    if (pr.author?.login) info.author = String(pr.author.login)
    if (pr.createdAt) info.createdAt = String(pr.createdAt)
    if (pr.mergedAt) info.mergedAt = String(pr.mergedAt)
    info.reviewRequests = reviewRequestsFrom(pr.reviewRequests)
    const reviews = latestReviews(pr.reviews)
    if (reviews.length) info.reviews = reviews
    return { kind: 'ok', pr: info, headRefOid: String(pr.headRefOid ?? ''), repo: prRepo(info, ws) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    switch (classifyGhError(message)) {
      case 'no-pr':
        return { kind: 'no-pr' }
      case 'auth-error':
        return { kind: 'auth-error', message }
      case 'rate-limit':
        return { kind: 'unavailable', message, rateLimited: true }
      default:
        return { kind: 'unavailable', message }
    }
  }
}

/** Rules for selecting the next GitHub action. */
export interface MergeRules {
  // Failed optional checks hide Merge too.
  optionalChecksBlock: boolean
  // Offer "merge when checks pass" while checks run.
  automerge: boolean
}

export function primaryAction(s: Omit<GitStatus, 'primary'>, rules: MergeRules = { optionalChecksBlock: true, automerge: false }): GitStatus['primary'] {
  const pr = s.pr
  if (pr?.state === 'MERGED') return { action: 'archive', label: 'Merged', tone: 'purple' }
  if (pr?.state === 'CLOSED') return { action: null, label: 'Pull request closed' }
  if (!pr && s.uncommitted === 0 && s.aheadBase === 0) return { action: null, label: 'No changes' }
  if (!pr && s.hasRemote && !s.onBase) return { action: 'create-pr', label: 'Create PR' }
  if (s.uncommitted > 0) return { action: 'commit-and-push', label: s.hasRemote ? 'Commit and push' : 'Commit changes' }
  if (s.behind > 0) return { action: 'pull', label: `${s.behind} behind remote` }
  if (s.ahead > 0 || (pr && !s.upstream)) return { action: 'push', label: 'Unpushed commits' }
  if (!pr) return { action: null, label: 'Committed' }
  if (pr.mergeable === 'CONFLICTING') return { action: 'resolve-conflicts', label: 'Merge conflicts', tone: 'red' }
  if (pr.isDraft) return { action: 'ready-for-review', label: 'Draft PR' }
  const failed = pr.checks.filter((c) => c.state === 'failure' && (rules.optionalChecksBlock || c.required !== false))
  if (failed.length) return { action: 'fix-errors', label: 'Checks failed', tone: 'red' }
  if (pr.checks.some((c) => c.state === 'pending')) {
    if (pr.autoMerge) return { action: null, label: 'Merging when checks pass', tone: 'amber' }
    if (rules.automerge) return { action: 'automerge', label: 'Merge when ready', tone: 'amber' }
    return { action: null, label: 'Checks running…', tone: 'amber' }
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { action: null, label: 'Changes requested', tone: 'red' }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return { action: null, label: 'Review required', tone: 'amber' }
  if (pr.mergeStateStatus === 'BLOCKED') return { action: null, label: 'Blocked from merging', tone: 'amber' }
  return { action: 'merge', label: 'Ready to merge', tone: 'green' }
}

// O2: the header's label in GitLab's words for a GitLab repo.
const GITLAB_LABELS: Record<string, string> = {
  'Create PR': 'Create MR',
  'Draft PR': 'Draft MR',
  'Pull request closed': 'Merge request closed',
  'Checks failed': 'Pipeline failed',
  'Checks running…': 'Pipeline running…',
  'Merging when checks pass': 'Merging when the pipeline succeeds',
  'Review required': 'Approval required'
}

export function gitlabPrimary(primary: GitStatus['primary']): GitStatus['primary'] {
  return { ...primary, label: GITLAB_LABELS[primary.label] ?? primary.label }
}

export async function gitStatus(
  ws: Workspace,
  hasRemote: boolean,
  rules?: MergeRules,
  remoteName = 'origin',
  lookup: (ws: Workspace) => Promise<PrResult> = pullRequest,
  // O2: whether the host's reader is there (gh by default), and which host this is when it isn't GitHub.
  options: { available?: () => Promise<boolean>; scm?: GitStatus['scm'] } = {}
): Promise<GitStatus> {
  const at = workspaceTarget(ws)
  const upstreamRef = await git(at, ['rev-parse', '--abbrev-ref', '@{upstream}'], { allowFail: true })
  const upstream = upstreamRef.code === 0 ? upstreamRef.stdout.trim() : undefined
  const remote = upstream ? await aheadBehind(at, '@{upstream}...HEAD') : null
  const base = await baseStartPoint(at, ws.baseBranch, remoteName)
  const vsBase = (await revParse(at, base)) ? await aheadBehind(at, `${base}...HEAD`) : null
  const porcelain = await git(at, ['status', '--porcelain=v1', '-z'], { allowFail: true })
  const entries = porcelain.stdout.split('\0').filter(Boolean)
  const conflicted = entries.some((e) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(e))
  // On the base branch itself there's no pull request to look for.
  const onBase = ws.branch === ws.baseBranch
  const found: PrResult | undefined = hasRemote && !onBase ? await lookup(ws) : undefined
  const installed = await (options.available ?? ghAvailable)()
  const pr = found?.kind === 'ok' ? found.pr : undefined
  // gh missing has its own row; anything else that failed is worth saying.
  const prProblem = installed && (found?.kind === 'auth-error' || found?.kind === 'unavailable') ? { kind: found.kind, message: found.message } : undefined
  const status = {
    branch: ws.branch,
    baseRef: base,
    upstream,
    hasRemote,
    ahead: remote?.ahead ?? 0,
    behind: remote?.behind ?? 0,
    aheadBase: vsBase?.ahead ?? 0,
    behindBase: vsBase?.behind ?? 0,
    uncommitted: entries.length,
    conflicted,
    onBase,
    ghAvailable: installed,
    pr,
    ...(prProblem ? { prProblem } : {}),
    ...(options.scm ? { scm: options.scm } : {})
  }
  const primary = primaryAction(status, rules)
  return { ...status, primary: options.scm?.kind === 'gitlab' ? gitlabPrimary(primary) : primary }
}

/** Merge method the repository allows, preferring squash. */
export async function mergeMethod(cwd: string, repoSlug?: string, account?: string, request: typeof gh = gh): Promise<'squash' | 'merge' | 'rebase'> {
  try {
    const repo = JSON.parse(await request(cwd, ['repo', 'view', ...(repoSlug ? [repoSlug] : []), '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], 20_000, account))
    if (repo.squashMergeAllowed) return 'squash'
    if (repo.mergeCommitAllowed) return 'merge'
    if (repo.rebaseMergeAllowed) return 'rebase'
  } catch {
    // Fall back to squash.
  }
  return 'squash'
}

/** The last lines of a failed GitHub Actions job's log. */
export async function jobLog(cwd: string, jobId: number, maxLines = 1000, repoSlug?: string, account?: string, request: typeof gh = gh): Promise<string> {
  const log = await request(cwd, ['api', `repos/${repoSlug ?? '{owner}/{repo}'}/actions/jobs/${jobId}/logs`], 60_000, account)
  const lines = log.split('\n')
  return lines.slice(-maxLines).join('\n')
}
