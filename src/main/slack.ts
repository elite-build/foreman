// Slack's Web API with a bot token: who the bot is, finding people and channels, and
// posting. The token goes only to slack.com. Messages never parse names (no link_names),
// so text can't ping @here or @channel.
import type { ConnectionIdentity, SlackDestination } from '../shared/integrations'

export type Fetch = typeof fetch

export class SlackError extends Error {
  constructor(
    message: string,
    readonly code: string,
    // Seconds Slack asked to wait (429).
    readonly retryAfter?: number,
    // The request may have reached Slack before it failed (a timeout after sending).
    readonly uncertain = false
  ) {
    super(message)
  }
}

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'token_expired'])

async function call<T>(token: string, method: string, params: Record<string, unknown>, doFetch: Fetch = fetch, post = false): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`)
  let init: RequestInit = { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }
  if (post) init = { ...init, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) }
  else for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
  let res: Response
  try {
    res = await doFetch(url, init)
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    // A reset or dropped response can also happen after Slack accepted a message.
    throw new SlackError(`Couldn’t reach Slack: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 'timeout' : 'network', undefined, method === 'chat.postMessage')
  }
  if (res.status === 429) throw new SlackError('Slack asked Foreman to slow down', 'ratelimited', Number(res.headers.get('retry-after')) || 30)
  const body = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null
  if (!body) throw new SlackError(`Slack answered ${res.status}`, 'bad_response', undefined, post)
  if (!body.ok) {
    const code = body.error ?? 'unknown_error'
    throw new SlackError(AUTH_ERRORS.has(code) ? 'Slack refused this token. It may have been revoked, or the app uninstalled.' : `Slack: ${code}`, code)
  }
  return body
}

export function isAuthError(err: unknown): boolean {
  return err instanceof SlackError && AUTH_ERRORS.has(err.code)
}

/** The bot and workspace a token belongs to. */
export async function slackAuthTest(token: string, doFetch?: Fetch): Promise<ConnectionIdentity & { botUserId: string }> {
  if (!/^xoxb-/.test(token.trim())) throw new SlackError('Paste the Bot User OAuth Token, which starts with xoxb-.', 'not_a_token')
  const r = await call<{ url: string; team: string; team_id: string; user: string; user_id: string }>(token, 'auth.test', {}, doFetch)
  return { user: r.user, userId: r.user_id, botUserId: r.user_id, org: r.team, orgId: r.team_id, url: r.url, checkedAt: new Date().toISOString() }
}

export interface SlackPerson {
  id: string
  name: string
  handle: string
  email?: string
}

interface RawUser {
  id: string
  name: string
  deleted?: boolean
  is_bot?: boolean
  real_name?: string
  profile?: { real_name?: string; display_name?: string; email?: string }
}

const person = (u: RawUser): SlackPerson => ({ id: u.id, name: u.profile?.real_name || u.real_name || u.name, handle: u.profile?.display_name || u.name, email: u.profile?.email })

/** The workspace member with this email, or null. */
export async function slackUserByEmail(token: string, email: string, doFetch?: Fetch): Promise<SlackPerson | null> {
  try {
    const r = await call<{ user: RawUser }>(token, 'users.lookupByEmail', { email }, doFetch)
    return person(r.user)
  } catch (err) {
    if (err instanceof SlackError && err.code === 'users_not_found') return null
    throw err
  }
}

/** Everyone in the workspace (people, not bots), up to a few thousand. */
export async function slackPeople(token: string, doFetch?: Fetch): Promise<SlackPerson[]> {
  const out: SlackPerson[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const r = await call<{ members: RawUser[]; response_metadata?: { next_cursor?: string } }>(token, 'users.list', { limit: 200, cursor }, doFetch)
    for (const u of r.members) if (!u.deleted && !u.is_bot && u.id !== 'USLACKBOT') out.push(person(u))
    cursor = r.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  return out
}

/** Channels the bot can post to: public ones, and private ones it was invited to. */
export async function slackChannels(token: string, doFetch?: Fetch): Promise<(SlackDestination & { member: boolean; private: boolean })[]> {
  const out: (SlackDestination & { member: boolean; private: boolean })[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const r = await call<{ channels: { id: string; name: string; is_member?: boolean; is_private?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
      token,
      'conversations.list',
      { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor },
      doFetch
    )
    for (const c of r.channels) out.push({ id: c.id, name: c.name, member: Boolean(c.is_member), private: Boolean(c.is_private) })
    cursor = r.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Post a message: to a channel id, or to a person (a DM from the bot). Returns where it went and its ts. */
export async function slackPost(token: string, to: string, text: string, doFetch?: Fetch): Promise<{ channel: string; ts: string }> {
  let channel = to
  // A user id: open (or find) the bot's DM with them first.
  if (/^[UW]/.test(to)) channel = (await call<{ channel: { id: string } }>(token, 'conversations.open', { users: to }, doFetch, true)).channel.id
  const r = await call<{ channel: string; ts: string }>(token, 'chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false }, doFetch, true)
  return { channel: r.channel, ts: r.ts }
}

/** The app manifest Foreman's Create Slack app button opens Slack with. */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: { name: 'Foreman', description: 'Messages from Foreman about your pull requests and agents.', background_color: '#1f1b18' },
    features: { bot_user: { display_name: 'Foreman', always_online: false } },
    oauth_config: { scopes: { bot: ['chat:write', 'im:write', 'users:read', 'users:read.email', 'channels:read', 'groups:read'] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false }
  }
}

export function slackManifestUrl(): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest()))}`
}
