// Outside agents' registrations, sign-ins and tokens (docs/agent-access.md §6). Registrations and sign-ins are in
// state.json (`agentAccess`); a refresh token's SHA-256, current and previous with its retirement time, is in the vault
// (`agent-access:<grantId>`); access tokens and authorization codes live only in memory, so a restart ends them and the
// client refreshes.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentAccessLevel, AgentAccessRecords, AgentClient, AgentGrant } from '../../shared/agentAccess'
import type { SecretStore } from '../secrets'
import type { Store } from '../store'

export const ACCESS_TOKEN_MS = 60 * 60_000
export const CODE_MS = 60_000
// Several processes of one client share a stored credential and may refresh at once.
export const REFRESH_GRACE_MS = 60_000
export const MAX_CLIENTS = 50
export const UNUSED_CLIENT_MS = 24 * 60 * 60_000
// How long a used code is remembered, so presenting it again revokes what it was exchanged for.
const USED_CODE_MS = 10 * 60_000
const LAST_SEEN_MS = 60_000
const NAME_MAX = 50
// What a client that gives no name is listed as.
const UNNAMED = 'MCP client'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const randomToken = (): string => randomBytes(32).toString('base64url')
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url')
export const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** An OAuth error answer: the status and the RFC 6749 `error` code, with a description for the person reading the log. */
export class OAuthError extends Error {
  constructor(readonly status: number, readonly error: string, description: string) { super(description) }
}

/** What a client calls itself: at most 50 characters, without control or formatting characters (bidi overrides). */
export function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim() : ''
  return [...text].slice(0, NAME_MAX).join('').trim() || UNNAMED
}

/** A redirect a client may register: `http` on a loopback host, without credentials or a fragment. Null when it isn't. */
export function loopbackRedirect(raw: string): URL | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || raw.includes('#')) return null
  return url
}

/** Whether a requested redirect is one the client registered, the port ignored (RFC 8252 §7.3: a native client picks a free port each time). */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  const asked = loopbackRedirect(requested)
  if (!asked) return false
  return registered.some((uri) => {
    const known = loopbackRedirect(uri)
    return Boolean(known) && known!.hostname === asked.hostname && known!.pathname === asked.pathname && known!.search === asked.search
  })
}

/** The host and port a redirect returns to, for the list: "127.0.0.1:53682". */
export function redirectHost(uri: string): string {
  return new URL(uri).host
}

/** A PKCE challenge Foreman takes: S256's 43 base64url characters. */
export const validChallenge = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value)
const validVerifier = (value: string): boolean => /^[A-Za-z0-9._~-]{43,128}$/.test(value)

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: AgentAccessLevel
}

interface CodeRecord { clientId: string; redirectUri: string; challenge: string; level: AgentAccessLevel; expiresAt: number }
interface Pair { accessToken: string; refreshToken: string; expiresAt: number; level: AgentAccessLevel }
// The vault entry: the current refresh token's hash, and the one it replaced with when.
interface Saved { current: string; previous?: string; retiredAt?: number }

export interface RecordsDeps {
  store: Store
  secrets: SecretStore
  now: () => number
  // A sign-in was created or revoked here (a reused code or refresh token).
  onChanged(): void
  // A sign-in ended, however (revoked in Foreman, by its own refresh token, or for a reused code or refresh token): what
  // its tree queued goes (docs/agent-access.md §4, "Revoking").
  onRevoked?(grantId: string): void
}

export class SignInRecords {
  private access = new Map<string, { grantId: string; expiresAt: number }>()
  private codes = new Map<string, CodeRecord>()
  private usedCodes = new Map<string, { grantId?: string; until: number }>()
  // Within the grace window, the retired refresh token answers the pair it was exchanged for.
  private grace = new Map<string, { previous: string; pair: Pair; until: number }>()

  constructor(private deps: RecordsDeps) {}

  private get records(): AgentAccessRecords {
    const state = this.deps.store.state
    state.agentAccess ??= { clients: [], grants: [] }
    state.agentAccess.clients ??= []
    state.agentAccess.grants ??= []
    return state.agentAccess
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  client(id: string): AgentClient | undefined {
    return this.records.clients.find((c) => c.id === id)
  }

  grant(id: string): AgentGrant | undefined {
    return this.records.grants.find((g) => g.id === id)
  }

  grants(): AgentGrant[] {
    return this.records.grants.map((g) => ({ ...g }))
  }

  /** A client used for a sign-in just now. */
  touch(client: AgentClient): void {
    client.lastUsedAt = this.iso()
    this.deps.store.save()
  }

  /** A registration that has never had a sign-in is dropped after a day; `busy` (clients with a sign-in waiting) never are. */
  prune(busy: ReadonlySet<string>): void {
    const now = this.deps.now()
    const records = this.records
    const kept = records.clients.filter((c) => c.everSignedIn || busy.has(c.id) || now - Date.parse(c.createdAt) < UNUSED_CLIENT_MS)
    if (kept.length === records.clients.length) return
    records.clients = kept
    this.deps.store.save()
  }

  /**
   * RFC 7591: keeps a new public client. When the list is full, the oldest registration that never signed in goes first,
   * then the least recently used one with no current sign-in; a client with a current sign-in is never dropped.
   */
  register(name: string, redirectUris: string[], busy: ReadonlySet<string>): AgentClient {
    this.prune(busy)
    const records = this.records
    if (records.clients.length >= MAX_CLIENTS) {
      const live = new Set(records.grants.map((g) => g.clientId))
      const used = (c: AgentClient) => c.lastUsedAt ?? c.createdAt
      const drop = records.clients
        .filter((c) => !busy.has(c.id) && !live.has(c.id))
        .sort((a, b) => Number(Boolean(a.everSignedIn)) - Number(Boolean(b.everSignedIn)) || used(a).localeCompare(used(b)))[0]
      if (!drop) throw new OAuthError(400, 'invalid_client_metadata', `Foreman keeps at most ${MAX_CLIENTS} registered clients, and each has a current sign-in. Revoke one in Foreman first.`)
      records.clients = records.clients.filter((c) => c !== drop)
    }
    const client: AgentClient = { id: randomUUID(), name, redirectUris, createdAt: this.iso() }
    records.clients.push(client)
    this.deps.store.save()
    return client
  }

  /** An approved sign-in's one-time code: good for 60 seconds, bound to the client, the exact redirect, the challenge and the level. */
  issueCode(record: Omit<CodeRecord, 'expiresAt'>): string {
    this.sweep()
    const code = randomToken()
    this.codes.set(sha256(code), { ...record, expiresAt: this.deps.now() + CODE_MS })
    return code
  }

  /** `grant_type=authorization_code`: creates the sign-in. A code used twice revokes what it was exchanged for. */
  exchangeCode(code: string, clientId: string, redirectUri: string, verifier: string): TokenResponse {
    this.sweep()
    const key = sha256(code)
    const used = this.usedCodes.get(key)
    if (used) {
      this.usedCodes.delete(key)
      if (used.grantId && this.revokeGrant(used.grantId)) this.deps.onChanged()
      throw new OAuthError(400, 'invalid_grant', 'This code was already used, so the sign-in it was exchanged for is revoked.')
    }
    const record = this.codes.get(key)
    if (!record) throw new OAuthError(400, 'invalid_grant', 'This code is unknown or has expired.')
    // Single use, whatever the outcome.
    this.codes.delete(key)
    this.usedCodes.set(key, { until: this.deps.now() + USED_CODE_MS })
    if (record.expiresAt <= this.deps.now()) throw new OAuthError(400, 'invalid_grant', 'This code has expired.')
    if (record.clientId !== clientId) throw new OAuthError(400, 'invalid_grant', 'This code was issued to another client.')
    if (record.redirectUri !== redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri isn’t the one the code was issued for.')
    if (!validVerifier(verifier) || !same(sha256(verifier), record.challenge)) throw new OAuthError(400, 'invalid_grant', 'code_verifier doesn’t match the code_challenge.')
    const client = this.client(clientId)
    if (!client) throw new OAuthError(400, 'invalid_grant', 'This client is no longer registered.')
    const grant: AgentGrant = { id: randomUUID(), clientId, name: client.name, redirect: redirectHost(redirectUri), level: record.level, grantedAt: this.iso() }
    this.records.grants.push(grant)
    client.everSignedIn = true
    client.lastUsedAt = grant.grantedAt
    this.usedCodes.set(key, { grantId: grant.id, until: this.deps.now() + USED_CODE_MS })
    const pair = this.issue(grant)
    this.save(grant.id, { current: sha256(pair.refreshToken) })
    this.deps.store.save()
    this.deps.onChanged()
    return this.response(pair)
  }

  /**
   * `grant_type=refresh_token`: a new pair, and the old refresh token retired. For 60 seconds the retired token answers
   * the same new pair again; after that, presenting it revokes the sign-in, since someone copied it.
   */
  refresh(token: string, clientId: string): TokenResponse {
    this.sweep()
    const grant = this.grant(token.split('.')[0] ?? '')
    const saved = grant && this.saved(grant.id)
    if (!grant || !saved || grant.clientId !== clientId) throw new OAuthError(400, 'invalid_grant', 'This refresh token is unknown or revoked.')
    const hash = sha256(token)
    if (same(hash, saved.current)) {
      const pair = this.issue(grant)
      this.save(grant.id, { current: sha256(pair.refreshToken), previous: hash, retiredAt: this.deps.now() })
      this.grace.set(grant.id, { previous: hash, pair, until: this.deps.now() + REFRESH_GRACE_MS })
      return this.response(pair)
    }
    if (saved.previous && same(hash, saved.previous)) {
      if (this.deps.now() - (saved.retiredAt ?? 0) <= REFRESH_GRACE_MS) {
        const cached = this.grace.get(grant.id)
        if (cached && same(cached.previous, hash)) return this.response(cached.pair)
        // Retired just before Foreman restarted: the pair it was exchanged for is gone from memory, but not stolen.
        throw new OAuthError(400, 'invalid_grant', 'This refresh token was just replaced. Use the newer one.')
      }
      this.revokeGrant(grant.id)
      this.deps.onChanged()
      throw new OAuthError(400, 'invalid_grant', 'This refresh token was already used, so the sign-in is revoked.')
    }
    throw new OAuthError(400, 'invalid_grant', 'This refresh token is unknown or revoked.')
  }

  /** The sign-in an access token belongs to, or null when it is unknown, expired or revoked. */
  authenticate(token: string): AgentGrant | null {
    const key = sha256(token)
    const found = this.access.get(key)
    if (!found) return null
    const grant = found.expiresAt > this.deps.now() ? this.grant(found.grantId) : undefined
    if (!grant) {
      this.access.delete(key)
      return null
    }
    if (!grant.lastSeen || this.deps.now() - Date.parse(grant.lastSeen) > LAST_SEEN_MS) {
      grant.lastSeen = this.iso()
      this.deps.store.save()
    }
    return grant
  }

  /**
   * RFC 7009. An access token ends alone; a refresh token (current or retired) ends the sign-in. A token this server
   * doesn't know, or one issued to another client, changes nothing, and the answer is the same.
   */
  revokeToken(token: string, clientId: string | undefined): boolean {
    const access = this.access.get(sha256(token))
    if (access) {
      const grant = this.grant(access.grantId)
      if (!clientId || !grant || grant.clientId === clientId) this.access.delete(sha256(token))
      return false
    }
    const grant = this.grant(token.split('.')[0] ?? '')
    const saved = grant && this.saved(grant.id)
    if (!grant || !saved || (clientId && grant.clientId !== clientId)) return false
    const hash = sha256(token)
    if (!same(hash, saved.current) && !(saved.previous && same(hash, saved.previous))) return false
    return this.revokeGrant(grant.id)
  }

  /** Deletes the record and the vault entry and ends its access tokens at once. */
  revokeGrant(id: string): boolean {
    const records = this.records
    const before = records.grants.length
    records.grants = records.grants.filter((g) => g.id !== id)
    this.deps.secrets.setAppSecret(`agent-access:${id}`, null)
    for (const [key, value] of this.access) if (value.grantId === id) this.access.delete(key)
    this.grace.delete(id)
    this.deps.store.save()
    const removed = records.grants.length !== before
    if (removed) this.deps.onRevoked?.(id)
    return removed
  }

  /** The listener closed: its codes, access tokens and grace pairs go; the sign-ins stay and refresh when it is back. */
  forgetLive(): void {
    this.access.clear()
    this.codes.clear()
    this.usedCodes.clear()
    this.grace.clear()
  }

  private issue(grant: AgentGrant): Pair {
    const accessToken = randomToken()
    const refreshToken = `${grant.id}.${randomToken()}`
    const expiresAt = this.deps.now() + ACCESS_TOKEN_MS
    this.access.set(sha256(accessToken), { grantId: grant.id, expiresAt })
    return { accessToken, refreshToken, expiresAt, level: grant.level }
  }

  private response(pair: Pair): TokenResponse {
    return {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.round((pair.expiresAt - this.deps.now()) / 1000)),
      refresh_token: pair.refreshToken,
      scope: pair.level
    }
  }

  private saved(grantId: string): Saved | undefined {
    const raw = this.deps.secrets.appSecret(`agent-access:${grantId}`)
    if (!raw) return undefined
    try {
      const value = JSON.parse(raw) as Partial<Saved>
      return typeof value.current === 'string' ? (value as Saved) : undefined
    } catch {
      return undefined
    }
  }

  private save(grantId: string, value: Saved): void {
    this.deps.secrets.setAppSecret(`agent-access:${grantId}`, JSON.stringify(value))
  }

  private sweep(): void {
    const now = this.deps.now()
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key)
    for (const [key, value] of this.usedCodes) if (value.until <= now) this.usedCodes.delete(key)
    for (const [key, value] of this.grace) if (value.until <= now) this.grace.delete(key)
    for (const [key, value] of this.access) if (value.expiresAt <= now) this.access.delete(key)
  }
}
