// Slack rules: PR observations become events (the first look is a baseline), rules make one
// delivery per recipient and occurrence (at most once, in foreman.db), messages to others wait
// for Send or Skip unless consented, and Slack's failures are retried only when nothing was sent.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ForemanDb } from '../src/main/db'
import { Environment } from '../src/main/environment'
import { Integrations } from '../src/main/integrations'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { SlackRules } from '../src/main/slackRules'
import { Store } from '../src/main/store'
import type { SlackDelivery, SlackRule } from '../src/shared/integrations'
import type { PullRequestInfo, Repo, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

type SlackMode = 'ok' | 'ratelimit-once' | 'timeout' | 'revoked'

async function rig(options: { mode?: SlackMode; me?: string; away?: boolean; onRetry?: () => void } = {}) {
  const dir = await tempDir('foreman-slack-')
  const store = new Store(dir)
  await store.load()
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), plain)
  const root = await tempDir('foreman-slack-repo-')
  store.state.repos.push({ id: 'r', name: 'web', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as Repo)
  const repo = (id: string) => {
    const r = store.state.repos.find((x) => x.id === id)
    if (!r) throw new Error('no repo')
    return r
  }
  const environment = new Environment(secrets, () => store.state.settings, repo)
  const posts: { method: string; body: Record<string, unknown> }[] = []
  let mode: SlackMode = options.mode ?? 'ok'
  let limited = false
  const fetchStub = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = url.replace('https://slack.com/api/', '').replace(/\?.*$/, '')
    if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, url: 'https://acme.slack.com/', team: 'Acme', team_id: 'T1', user: 'foreman', user_id: 'UBOT' }))
    if (mode === 'revoked') return new Response(JSON.stringify({ ok: false, error: 'token_revoked' }))
    if (mode === 'ratelimit-once' && !limited) {
      limited = true
      return new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
    }
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (mode === 'timeout' && method === 'chat.postMessage') {
      posts.push({ method, body })
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    }
    posts.push({ method, body })
    if (method === 'conversations.open') return new Response(JSON.stringify({ ok: true, channel: { id: `D-${body.users}` } }))
    if (method === 'chat.postMessage') return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: '1.2' }))
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  const integrations = new Integrations({
    store,
    secrets,
    repo,
    repoGithubToken: (id) => environment.repoGithubToken(id),
    remoteUrl: async () => null,
    githubAccounts: async () => [],
    accountToken: () => '',
    activeLogin: async () => undefined,
    changed: () => undefined,
    fetch: fetchStub,
    home: dir
  })
  const added = await integrations.addConnection({ service: 'slack', name: 'Acme Slack', auth: { kind: 'token' }, token: 'xoxb-acme' })
  if (!added.ok) throw new Error(added.error)
  const slackId = added.connection.id
  if (options.me) await integrations.updateConnection(slackId, { slackMe: { id: options.me, name: 'Yatin' } })
  const db = new ForemanDb(path.join(dir, 'foreman.db'))
  const notified: string[] = []
  const slept: number[] = []
  const deps = {
    integrations,
    db: () => db,
    repo: (id) => store.state.repos.find((r) => r.id === id),
    githubLogin: async () => 'yatin',
    away: () => options.away ?? false,
    notify: (n) => notified.push(n.title),
    changed: () => undefined,
    fetch: fetchStub,
    sleep: async (s: number) => { slept.push(s); options.onRetry?.() }
  } satisfies ConstructorParameters<typeof SlackRules>[0]
  const rules = new SlackRules(deps)
  const addRule = (patch: Partial<SlackRule>) => integrations.saveRule({ id: '', connectionId: slackId, event: 'review-requested', repos: 'all', recipient: 'reviewer', template: 'Hi {reviewer}, review {pr.title}? {pr.url}', mode: 'ask', enabled: true, ...patch })
  const consent = (rule: SlackRule) => integrations.consentRule(rule.id)
  const deliveries = () => db.readDeliveries<SlackDelivery>()
  return { store, integrations, rules, deps, db, posts, notified, slept, slackId, addRule, consent, deliveries, setMode: (m: SlackMode) => (mode = m) }
}

const ws: Workspace = { id: 'w', repoId: 'r', name: 'fix-login', branch: 'yatin/fix', baseBranch: 'main', path: '/w', portBase: 50000, state: 'ready', createdAt: 'x' }
const ws2: Workspace = { ...ws, id: 'w2', name: 'fix-login-2' }

const pr = (patch: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 482,
  url: 'https://github.com/acme/web/pull/482',
  title: 'Fix login <!here>',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  baseRefName: 'main',
  checks: [],
  author: 'yatin',
  reviewRequests: [],
  ...patch
})

describe('Slack rules: PR events', () => {
  it('takes the first look as a baseline, then asks before messaging a newly requested reviewer', async () => {
    const r = await rig()
    r.addRule({})
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'arjun' }] }), 'sha1')
    expect(r.deliveries()).toEqual([])
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'arjun' }, { login: 'priya' }] }), 'sha1')
    const [d] = r.deliveries()
    expect(d).toMatchObject({ status: 'asking', unmatched: 'priya', event: 'review-requested', title: '#482 Fix login <!here>' })
    expect(d.text).toBe('Hi priya, review Fix login &lt;!here&gt;? https://github.com/acme/web/pull/482')
    expect(r.notified).toEqual(['No Slack match for priya'])
    expect(r.posts).toEqual([])
  })

  it('sends a consented rule to the matched person once, from the bot, and never twice for the same request', async () => {
    const r = await rig()
    r.integrations.linkPerson({ githubLogin: 'Priya', slackTeamId: 'T1', slackUserId: 'UPRIYA', slackName: 'Priya Sharma' })
    r.consent(r.addRule({}))
    await r.rules.prObserved(ws, pr(), 'sha1')
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'priya' }] }), 'sha1')
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'priya' }] }), 'sha2')
    // A second workspace on the same PR doesn't repeat it either.
    await r.rules.prObserved(ws2, pr({ reviewRequests: [{ login: 'priya' }] }), 'sha2')
    expect(r.posts.map((p) => p.method)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(r.posts[1].body).toMatchObject({ channel: 'D-UPRIYA', text: 'Hi Priya, review Fix login &lt;!here&gt;? https://github.com/acme/web/pull/482', unfurl_links: false })
    expect(r.posts[1].body).not.toHaveProperty('link_names')
    expect(r.deliveries()).toHaveLength(1)
    expect(r.deliveries()[0]).toMatchObject({ status: 'sent', ts: '1.2', recipientName: 'Priya Sharma' })
  })

  it('never expands a team review request', async () => {
    const r = await rig()
    r.consent(r.addRule({}))
    await r.rules.prObserved(ws, pr(), 'sha1')
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ team: 'web' }] }), 'sha1')
    expect(r.deliveries()[0]).toMatchObject({ status: 'skipped', team: true })
    expect(r.posts).toEqual([])
  })

  it('messages me once per failing push, as DMs from the bot', async () => {
    const r = await rig({ me: 'UME' })
    r.addRule({ event: 'ci-failed', recipient: 'me', template: 'CI failed on {pr.title}' })
    const failing = { checks: [{ name: 'test', state: 'failure' as const }] }
    await r.rules.prObserved(ws, pr(), 'sha1')
    await r.rules.prObserved(ws, pr(failing), 'sha2')
    await r.rules.prObserved(ws, pr(failing), 'sha2')
    await r.rules.prObserved(ws, pr(failing), 'sha3')
    expect(r.posts.filter((p) => p.method === 'chat.postMessage').map((p) => p.body.channel)).toEqual(['D-UME', 'D-UME'])
  })

  it('counts a PR opened in a workspace as an event, but not an old PR seen for the first time', async () => {
    const r = await rig({ me: 'UME' })
    r.addRule({ event: 'pr-ready', recipient: 'me', template: '{pr.title} is ready' })
    await r.rules.prObserved(ws, null)
    await r.rules.prObserved(ws, pr(), 'sha1')
    expect(r.deliveries()).toHaveLength(1)
    // First seen after an upgrade: created long ago, so a baseline.
    await r.rules.prObserved(ws2, pr({ number: 7, createdAt: '2026-01-01T00:00:00Z' }), 'x', true)
    // Made in the last few minutes, first seen for this workspace: just opened.
    await r.rules.prObserved(ws2, pr({ number: 8, createdAt: new Date(Date.now() - 60_000).toISOString() }), 'y', true)
    expect(r.deliveries().map((d) => d.occurrence).sort()).toEqual(['pr-ready:r:482:1', 'pr-ready:r:8:1'])
  })

  it('draft → ready → draft → ready is two events', async () => {
    const r = await rig({ me: 'UME' })
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    for (const isDraft of [true, false, true, false]) await r.rules.prObserved(ws, pr({ isDraft }), 's')
    expect(r.deliveries()).toHaveLength(2)
  })

  it('leaves other people’s PRs, repositories with rules off, and other Slack workspaces alone', async () => {
    const r = await rig({ me: 'UME' })
    r.addRule({ event: 'ci-failed', recipient: 'me' })
    const failing = { checks: [{ name: 'test', state: 'failure' as const }] }
    await r.rules.prObserved(ws, pr({ author: 'someone-else' }), 'a')
    await r.rules.prObserved(ws, pr({ author: 'someone-else', ...failing }), 'b')
    r.integrations.setRepoOptions('r', { rules: 'off' })
    await r.rules.prObserved(ws, pr({ number: 9 }), 'a')
    await r.rules.prObserved(ws, pr({ number: 9, ...failing }), 'b')
    r.integrations.setRepoOptions('r', { rules: 'mine' })
    r.integrations.setRepoChoice('r', 'slack', 'off')
    await r.rules.prObserved(ws, pr({ number: 10 }), 'a')
    await r.rules.prObserved(ws, pr({ number: 10, ...failing }), 'b')
    expect(r.deliveries()).toEqual([])
  })
})

describe('Slack rules: answering and sending', () => {
  it('rechecks consent when a rate-limited automatic message retries', async () => {
    let revoke = () => {}
    const r = await rig({ mode: 'ratelimit-once', onRetry: () => revoke() })
    r.integrations.linkPerson({ githubLogin: 'priya', slackTeamId: 'T1', slackUserId: 'UPRIYA', slackName: 'Priya' })
    const rule = r.consent(r.addRule({}))
    revoke = () => { r.integrations.saveRule({ ...rule, mode: 'ask' }) }
    await r.rules.prObserved(ws, pr(), 's')
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'priya' }] }), 's')
    expect(r.posts).toEqual([])
    expect(r.deliveries()[0].status).toBe('asking')
  })

  it('keeps ready-event occurrence numbers across a restart', async () => {
    const r = await rig({ me: 'UME' })
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    for (const isDraft of [true, false, true, false]) await r.rules.prObserved(ws, pr({ isDraft }), 's')
    const restarted = new SlackRules(r.deps)
    for (const isDraft of [false, true, false]) await restarted.prObserved(ws, pr({ isDraft }), 's')
    expect(r.deliveries()).toHaveLength(3)
    expect(r.deliveries().map((d) => d.occurrence).sort()).toEqual(['pr-ready:r:482:1', 'pr-ready:r:482:2', 'pr-ready:r:482:3'])
  })
  async function asked(r: Awaited<ReturnType<typeof rig>>) {
    r.integrations.linkPerson({ githubLogin: 'priya', slackTeamId: 'T1', slackUserId: 'UPRIYA', slackName: 'Priya Sharma' })
    r.addRule({})
    await r.rules.prObserved(ws, pr(), 's')
    await r.rules.prObserved(ws, pr({ reviewRequests: [{ login: 'priya' }] }), 's')
    return r.deliveries()[0]
  }

  it('Send posts the edited text; Skip sends nothing', async () => {
    const r = await rig()
    const d = await asked(r)
    expect(r.rules.asks().map((x) => x.id)).toEqual([d.id])
    await r.rules.answer(d.id, 'send', 'Could you look at #482 today?')
    expect(r.posts.at(-1)!.body.text).toBe('Could you look at #482 today?')
    expect(r.rules.asks()).toEqual([])

    const r2 = await rig()
    const d2 = await asked(r2)
    await r2.rules.answer(d2.id, 'skip')
    expect(r2.posts).toEqual([])
    expect(r2.deliveries()[0].status).toBe('skipped')
  })

  it('checks again before sending: a reviewer no longer requested gets nothing', async () => {
    const r = await rig()
    const d = await asked(r)
    await r.rules.prObserved(ws, pr({ reviewRequests: [] }), 's')
    await expect(r.rules.answer(d.id, 'send')).rejects.toThrow(/no longer asked/)
    expect(r.posts).toEqual([])
  })

  it('reports uncertainty to an explicit Send or Send again without claiming success', async () => {
    const r = await rig({ mode: 'timeout' })
    const d = await asked(r)
    await expect(r.rules.answer(d.id, 'send')).rejects.toThrow('may have arrived')
    expect(r.deliveries()[0].status).toBe('uncertain')
    await expect(r.rules.resend(d.id)).rejects.toThrow('may have arrived')
    expect(r.deliveries()[0].status).toBe('uncertain')
    expect(r.posts.filter((p) => p.method === 'chat.postMessage')).toHaveLength(2)
  })

  it('retries after Slack asks it to slow down', async () => {
    const r = await rig({ me: 'UME', mode: 'ratelimit-once' })
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    await r.rules.prObserved(ws, null)
    await r.rules.prObserved(ws, pr(), 's')
    expect(r.slept).toEqual([1])
    expect(r.deliveries()[0].status).toBe('sent')
  })

  it('calls a timeout after sending uncertain and never resends it by itself; Send again does', async () => {
    const r = await rig({ me: 'UME', mode: 'timeout' })
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    await r.rules.prObserved(ws, null)
    await r.rules.prObserved(ws, pr(), 's')
    const [d] = r.deliveries()
    expect(d.status).toBe('uncertain')
    expect(r.posts.filter((p) => p.method === 'chat.postMessage')).toHaveLength(1)
    r.setMode('ok')
    await r.rules.resend(d.id)
    expect(r.deliveries()[0].status).toBe('sent')
  })

  it('a revoked token marks the connection and fails the message; nothing goes elsewhere', async () => {
    const r = await rig({ me: 'UME', mode: 'revoked' })
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    await r.rules.prObserved(ws, null)
    await r.rules.prObserved(ws, pr(), 's')
    expect(r.deliveries()[0]).toMatchObject({ status: 'failed' })
    expect(r.integrations.connection(r.slackId)!.problem).toMatch(/revoked|refused/i)
  })

  it('says why a rule to me can’t send before I pick who I am', async () => {
    const r = await rig()
    r.addRule({ event: 'pr-ready', recipient: 'me' })
    await r.rules.prObserved(ws, null)
    await r.rules.prObserved(ws, pr(), 's')
    expect(r.deliveries()[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Pick who you are/) })
  })

  it('marks messages that were being sent at a crash as uncertain', async () => {
    const r = await rig()
    r.db.addDelivery({ id: 'x', ruleId: 'rule', occurrence: 'o', recipientId: 'U', at: '2026-10-23T00:00:00Z', status: 'queued' } as unknown as SlackDelivery)
    r.rules.recover()
    expect(r.deliveries()[0].status).toBe('uncertain')
  })
})

describe('Slack rules: agents', () => {
  it('messages me when an agent needs me only while I’m away, if the rule says so', async () => {
    const here = await rig({ me: 'UME', away: false })
    here.addRule({ event: 'agent-needs-me', recipient: 'me', template: '{agent} in {workspace}: {reason}', awayOnly: true })
    await here.rules.agentEvent('agent-needs-me', ws, { turnId: 't1', agent: 'Claude Code', reason: 'wants to run a migration' })
    expect(here.posts).toEqual([])

    const away = await rig({ me: 'UME', away: true })
    away.addRule({ event: 'agent-needs-me', recipient: 'me', template: '{agent} in {workspace}: {reason}', awayOnly: true })
    await away.rules.agentEvent('agent-needs-me', ws, { turnId: 't1', agent: 'Claude Code', reason: 'wants to run a migration' })
    await away.rules.agentEvent('agent-needs-me', ws, { turnId: 't1', agent: 'Claude Code', reason: 'wants to run a migration' })
    expect(away.posts.filter((p) => p.method === 'chat.postMessage').map((p) => p.body.text)).toEqual(['Claude Code in fix-login: wants to run a migration'])
  })
})
