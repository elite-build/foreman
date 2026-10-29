import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliCodedError } from '../src/main/cli/host'
import { INTEGRATIONS_METHODS } from '../src/main/cli/integrations'
import type { CliContext } from '../src/main/cli/methods'
import { defaultSettings } from '../src/main/store'
import type { ConnectionImpact, ConnectionsAddResult, ConnectionsApplyResult, ConnectionsCheckResult, ConnectionsDefaultResult, ConnectionsListResult, ConnectionsRemoveResult, LinearIssuesResult, SlackActionResult, SlackDeliveriesResult, SlackPeopleResult, SlackRulesResult } from '../src/shared/cli/integrations'
import type { ConnectionView, IntegrationsView, NewConnection, SlackDelivery, SlackRule } from '../src/shared/integrations'
import type { Api, AppSnapshot, Repo } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const TOKEN = 'xoxb-1234567890-secret-token-value'

const repoA = { id: 'ra', name: 'alpha', rootPath: path.resolve('/tmp/foreman-cli-int/alpha'), defaultBranch: 'main', integrations: { services: { github: 'gh-1-aaaa-bbbb' } } } as Repo
const repoB = { id: 'rb', name: 'beta', rootPath: path.resolve('/tmp/foreman-cli-int/beta'), defaultBranch: 'main' } as Repo

const conn = (over: Partial<ConnectionView> & Pick<ConnectionView, 'id' | 'service' | 'name'>): ConnectionView =>
  ({ rev: 1, auth: { kind: 'token' }, agentAccess: 'off', createdAt: '2026-01-01T00:00:00.000Z', usedBy: 0, isDefault: false, ...over }) as ConnectionView

const github = conn({ id: 'gh-1-aaaa-bbbb', service: 'github', name: 'Work GitHub', auth: { kind: 'gh-account', login: 'yatin' }, identity: { user: 'yatin', checkedAt: '' }, usedBy: 2, isDefault: true })
const linear = conn({ id: 'lin-1-aaaa-bbbb', service: 'linear', name: 'Acme Linear', identity: { user: 'Yatin', org: 'Acme', orgId: 'org-1', checkedAt: '' }, hint: 'abcd', agentAccess: 'read', problem: 'The key was refused' })
const slack = conn({ id: 'slk-1-aaaa-bbbb', service: 'slack', name: 'Acme Slack', identity: { user: 'foreman-bot', org: 'Acme', orgId: 'T0001', checkedAt: '' }, slack: { me: { id: 'U1', name: 'yatin' }, destinations: [{ id: 'C1', name: 'reviews' }] }, isDefault: true })
const vercel = conn({ id: 'vcl-1-aaaa-bbbb', service: 'vercel', name: 'Vercel sandboxes', identity: { user: 'yatin', org: 'Team', orgId: 'team_1', checkedAt: '' }, vercel: { teamId: 'team_1', projectId: 'prj_1', plan: 'hobby' } as ConnectionView['vercel'] })

const rule = (over: Partial<SlackRule> = {}): SlackRule => ({ id: 'rule-1111-2222', connectionId: slack.id, event: 'pr-ready', repos: 'all', recipient: 'channel', channel: { id: 'C1', name: 'reviews' }, template: '{pr.title} is ready', mode: 'ask', enabled: true, ...over })

function setup(over: { integrations?: Partial<IntegrationsView>; api?: Partial<Api>; repos?: Repo[]; slackAsks?: SlackDelivery[] } = {}) {
  const repos = over.repos ?? [repoA, repoB]
  const integrations: IntegrationsView = { connections: [github, linear, slack, vercel], rules: [], people: [], suggestions: {}, ...over.integrations }
  const snapshot = { repos, workspaces: [], sessions: [], settings: defaultSettings(), integrations, slackAsks: over.slackAsks ?? [] } as unknown as AppSnapshot
  const host = stubHost({ state: () => ({ repos, workspaces: [], sessions: [], settings: defaultSettings() }), snapshot: () => snapshot, api: fakeApi(over.api) })
  const call = <T>(method: string, params?: unknown) => INTEGRATIONS_METHODS[method].handle(host, params, ctx) as Promise<T>
  return { call }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the integration methods', () => {
  it('puts only the connection list in the read tier: everything else changes setup or reads Slack and Linear data', () => {
    const tiers = Object.fromEntries(Object.entries(INTEGRATIONS_METHODS).map(([k, m]) => [k, m.tier]))
    expect(tiers).toEqual({
      'connections-list': 'read',
      'connections-add': 'admin',
      'connections-check': 'admin',
      'connections-remove': 'admin',
      'connections-default': 'admin',
      'connections-edit': 'admin',
      'connections-apply': 'admin',
      'slack-rules': 'admin',
      'slack-people': 'admin',
      'slack-deliveries': 'admin',
      'slack-answer': 'admin',
      'slack-resend': 'admin',
      'linear-issues': 'admin'
    })
  })

  describe('connections', () => {
    it('lists them with who they are signed in as, the default and any problem, and shows at most a token’s last four characters', async () => {
      const { call } = setup()
      const result = await call<ConnectionsListResult>('connections-list')
      expect(result.connections.map((c) => [c.service, c.name, c.identity, c.default])).toEqual([
        ['github', 'Work GitHub', 'yatin', true],
        ['linear', 'Acme Linear', 'Yatin @ Acme', false],
        ['slack', 'Acme Slack', 'foreman-bot @ Acme', true],
        ['vercel', 'Vercel sandboxes', 'yatin @ Team', false]
      ])
      expect(result.connections[1]).toMatchObject({ problem: 'The key was refused', hint: 'abcd', agentAccess: 'read' })
      expect(result.connections[3].details).toEqual({ teamId: 'team_1', projectId: 'prj_1', plan: 'hobby' })
      expect(result.text).toContain('The key was refused')
    })

    it('add vercel without a team or project is invalid, and adds nothing', async () => {
      const addConnection = vi.fn()
      const { call } = setup({ api: { addConnection } })
      const err = await failure(call('connections-add', { service: 'vercel', token: TOKEN }))
      expect(err.code).toBe('invalid')
      expect(err.message).toContain('--team-id and --project-id')
      expect((await failure(call('connections-add', { service: 'vercel', token: TOKEN, vercel: { teamId: 'team_1' } }))).message).toContain('--project-id')
      expect(addConnection).not.toHaveBeenCalled()
    })

    it('add vercel with its fields checks the key through addConnection and can make it the default', async () => {
      const added = conn({ id: 'new-1111', service: 'vercel', name: 'Mine', identity: { user: 'yatin', checkedAt: '' }, vercel: { teamId: 'team_1', projectId: 'prj_1' } as ConnectionView['vercel'] })
      const addConnection = vi.fn(async (_input: NewConnection) => ({ ok: true as const, connection: added }))
      const setIntegrationDefault = vi.fn(async () => undefined)
      const { call } = setup({ api: { addConnection, setIntegrationDefault } })
      const result = await call<ConnectionsAddResult>('connections-add', { service: 'vercel', name: 'Mine', token: TOKEN, vercel: { teamId: 'team_1', projectId: 'prj_1' }, setDefault: true })
      expect(addConnection).toHaveBeenCalledWith({ service: 'vercel', name: 'Mine', auth: { kind: 'token' }, token: TOKEN, vercel: { teamId: 'team_1', projectId: 'prj_1' } })
      expect(setIntegrationDefault).toHaveBeenCalledWith('vercel', 'new-1111')
      expect(result.connection).toMatchObject({ id: 'new-1111', default: true })
      // The token never comes back.
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    })

    it('add github takes exactly one way to sign in', async () => {
      const addConnection = vi.fn(async (_input: NewConnection) => ({ ok: true as const, connection: github }))
      const { call } = setup({ api: { addConnection } })
      await call('connections-add', { service: 'github', ghAccount: 'yatin' })
      expect(addConnection).toHaveBeenLastCalledWith({ service: 'github', auth: { kind: 'gh-account', login: 'yatin' } })
      await call('connections-add', { service: 'github', ghActive: true, name: 'Active' })
      expect(addConnection).toHaveBeenLastCalledWith({ service: 'github', name: 'Active', auth: { kind: 'gh-active' } })
      await call('connections-add', { service: 'github', token: TOKEN })
      expect(addConnection).toHaveBeenLastCalledWith({ service: 'github', auth: { kind: 'token' }, token: TOKEN })
      expect((await failure(call('connections-add', { service: 'github' }))).message).toMatch(/Choose how GitHub signs in/)
      expect((await failure(call('connections-add', { service: 'github', ghAccount: 'a', ghActive: true }))).code).toBe('invalid')
    })

    it('add needs a token for a token service, none for Docker, and a known access for Linear only', async () => {
      const addConnection = vi.fn(async (_input: NewConnection) => ({ ok: true as const, connection: linear }))
      const { call } = setup({ api: { addConnection } })
      expect((await failure(call('connections-add', { service: 'linear' }))).message).toMatch(/Linear API key is needed/)
      expect((await failure(call('connections-add', { service: 'docker', token: TOKEN }))).message).toMatch(/Docker has no token/)
      expect((await failure(call('connections-add', { service: 'nope', token: TOKEN }))).message).toMatch(/Unknown service/)
      expect((await failure(call('connections-add', { service: 'slack', token: TOKEN, agentAccess: 'write' }))).message).toMatch(/Only Linear/)
      expect((await failure(call('connections-add', { service: 'linear', token: TOKEN, agentAccess: 'everything' }))).message).toMatch(/Agent access is off, read, write/)
      await call('connections-add', { service: 'linear', token: TOKEN, agentAccess: 'write' })
      expect(addConnection).toHaveBeenLastCalledWith({ service: 'linear', auth: { kind: 'token' }, token: TOKEN, agentAccess: 'write' })
      const docker = vi.fn(async (_input: NewConnection) => ({ ok: true as const, connection: conn({ id: 'dk', service: 'docker', name: 'Docker', auth: { kind: 'docker-context' } }) }))
      await setup({ api: { addConnection: docker } }).call('connections-add', { service: 'docker', docker: { host: 'ssh://me@box' } })
      expect(docker).toHaveBeenCalledWith({ service: 'docker', auth: { kind: 'docker-context' }, docker: { host: 'ssh://me@box' } })
    })

    it('add reports a duplicate with the way past it, and scrubs the token from a service error', async () => {
      const duplicate = setup({ api: { addConnection: async () => ({ ok: false as const, error: 'duplicate', duplicateOf: 'Acme Linear', identity: { user: 'Yatin', org: 'Acme', checkedAt: '' } }) } })
      const err = await failure(duplicate.call('connections-add', { service: 'linear', token: TOKEN }))
      expect(err.message).toContain('“Acme Linear”')
      expect(err.hint).toContain('--allow-duplicate')
      const leaking = setup({ api: { addConnection: async () => ({ ok: false as const, error: `Linear refused ${TOKEN}` }) } })
      const refused = await leaking.call('connections-add', { service: 'linear', token: TOKEN }).catch((e: Error) => e)
      expect((refused as Error).message).toBe('Linear refused [token]')
      const withDuplicate = vi.fn(async (_input: NewConnection) => ({ ok: true as const, connection: linear }))
      await setup({ api: { addConnection: withDuplicate } }).call('connections-add', { service: 'linear', token: TOKEN, allowDuplicate: true })
      expect(withDuplicate.mock.calls[0][0]).toMatchObject({ allowDuplicate: true })
    })

    it('check reports whether it works', async () => {
      const checkConnection = vi.fn(async () => ({ ...linear, problem: undefined }))
      const { call } = setup({ api: { checkConnection } })
      const ok = await call<ConnectionsCheckResult>('connections-check', { id: 'Acme Linear' })
      expect(checkConnection).toHaveBeenCalledWith(linear.id)
      expect(ok).toMatchObject({ ok: true })
      const bad = await setup({ api: { checkConnection: async () => linear } }).call<ConnectionsCheckResult>('connections-check', { id: 'lin-1' })
      expect(bad.ok).toBe(false)
      expect(bad.text).toContain('The key was refused')
      expect((await failure(call('connections-check', { id: 'ghost' }))).code).toBe('not-found')
    })

    it('remove without confirmation returns what it affects and removes nothing; with it, removes', async () => {
      const impact: ConnectionImpact = { repos: ['alpha', 'beta'], isDefault: true, rules: 2 }
      const removeConnection = vi.fn(async () => undefined)
      const connectionRemovalImpact = vi.fn(async () => impact)
      const { call } = setup({ api: { removeConnection, connectionRemovalImpact } })
      const preview = await call<ConnectionsRemoveResult>('connections-remove', { id: 'Work GitHub' })
      expect(preview).toMatchObject({ removed: false, needsConfirmation: true, impact })
      expect(preview.text).toContain('2 repositories use it now (alpha, beta)')
      expect(preview.text).toContain('is the default github connection')
      expect(preview.text).toContain('2 Slack rules')
      expect(removeConnection).not.toHaveBeenCalled()

      const done = await call<ConnectionsRemoveResult>('connections-remove', { id: github.id, confirmed: true })
      expect(removeConnection).toHaveBeenCalledWith(github.id)
      expect(done.removed).toBe(true)
    })

    it('default sets or clears a service’s default', async () => {
      const setIntegrationDefault = vi.fn(async () => undefined)
      const { call } = setup({ api: { setIntegrationDefault } })
      const set = await call<ConnectionsDefaultResult>('connections-default', { service: 'linear', id: 'Acme Linear' })
      expect(setIntegrationDefault).toHaveBeenLastCalledWith('linear', linear.id)
      expect(set.connection).toMatchObject({ id: linear.id, default: true })
      await call('connections-default', { service: 'github', id: 'none' })
      expect(setIntegrationDefault).toHaveBeenLastCalledWith('github', null)
      // A connection of another service is not found among this service's.
      expect((await failure(call('connections-default', { service: 'github', id: 'Acme Linear' }))).code).toBe('not-found')
    })

    it('apply resolves repository names and keeps the ones that already chose it unless asked to replace', async () => {
      const applyConnectionToRepos = vi.fn(async () => undefined)
      const { call } = setup({ api: { applyConnectionToRepos } })
      const added = await call<ConnectionsApplyResult>('connections-apply', { id: 'Work GitHub', repos: ['beta'], cwd: '/' })
      expect(applyConnectionToRepos).toHaveBeenLastCalledWith(github.id, ['ra', 'rb'])
      expect(added.repos).toEqual(['alpha', 'beta'])
      await call('connections-apply', { id: 'Work GitHub', repos: ['beta'], cwd: '/', replace: true })
      expect(applyConnectionToRepos).toHaveBeenLastCalledWith(github.id, ['rb'])
      await expect(call('connections-apply', { id: 'Work GitHub', repos: ['ghost'], cwd: '/' })).rejects.toThrow(/No repository named “ghost”/)
      expect((await failure(call('connections-apply', { id: 'Vercel sandboxes', repos: ['beta'], cwd: '/' }))).message).toMatch(/isn’t chosen per repository/)
    })
  })

  describe('Slack rules', () => {
    it('lists rules with who gets them and whether they ask first', async () => {
      const { call } = setup({ integrations: { rules: [rule(), rule({ id: 'rule-3333', recipient: 'me', channel: undefined, event: 'agent-finished', repos: ['ra'] })] } })
      const result = await call<SlackRulesResult>('slack-rules', { verb: 'list' })
      expect(result.rules.map((r) => [r.event, r.recipient, r.repos, r.sendsWithoutAsking])).toEqual([['pr-ready', 'channel', 'all', false], ['agent-finished', 'me', ['alpha'], true]])
      expect(result.text).toContain('asks first')
    })

    it('add builds the rule saveSlackRule needs, with the event’s default message, and ask-first until consent', async () => {
      const saveSlackRule = vi.fn(async (r: SlackRule) => ({ ...r, id: 'new-rule-0001' }))
      const { call } = setup({ api: { saveSlackRule } })
      const result = await call<SlackRulesResult>('slack-rules', { verb: 'add', event: 'pr-ready', recipient: 'channel', channel: '#reviews', repos: ['alpha'], cwd: '/' })
      expect(saveSlackRule).toHaveBeenCalledWith({ id: '', connectionId: slack.id, event: 'pr-ready', repos: ['ra'], recipient: 'channel', channel: { id: 'C1', name: 'reviews' }, template: '{pr.title} ({repo}#{pr.number}) is ready for review. {pr.url}', mode: 'ask', enabled: true })
      expect(result.text).toContain('foreman slack rules consent new-rule')
    })

    it('add refuses an unknown event, a recipient the event does not allow, an unknown channel and away-only on a PR event', async () => {
      const saveSlackRule = vi.fn()
      const { call } = setup({ api: { saveSlackRule } })
      const bad = async (changes: Record<string, unknown>) => (await failure(call('slack-rules', { verb: 'add', event: 'pr-ready', recipient: 'channel', channel: 'reviews', ...changes }))).message
      expect(await bad({ event: 'nonsense' })).toMatch(/Unknown event/)
      expect(await bad({ event: 'agent-finished', recipient: 'channel' })).toMatch(/can go to: me/)
      expect(await bad({ channel: 'random' })).toMatch(/isn’t a channel this connection may post to/)
      expect(await bad({ channel: undefined })).toMatch(/Name the channel/)
      expect(await bad({ awayOnly: true })).toMatch(/Only agent events/)
      expect(await bad({ recipient: 'me', channel: 'reviews' })).toMatch(/only for a rule that posts to a channel/)
      expect(saveSlackRule).not.toHaveBeenCalled()
    })

    it('remove deletes a rule by the start of its id', async () => {
      const deleteSlackRule = vi.fn(async () => undefined)
      const { call } = setup({ integrations: { rules: [rule()] }, api: { deleteSlackRule } })
      await call('slack-rules', { verb: 'remove', id: 'rule-1111' })
      expect(deleteSlackRule).toHaveBeenCalledWith('rule-1111-2222')
      expect((await failure(call('slack-rules', { verb: 'remove', id: 'ghost' }))).code).toBe('not-found')
    })

    it('consent shows what will be sent without asking and consents only when confirmed', async () => {
      const consentSlackRule = vi.fn(async (id: string) => ({ ...rule(), id, mode: 'auto' as const }))
      const { call } = setup({ integrations: { rules: [rule(), rule({ id: 'rule-mine', recipient: 'me', channel: undefined })] }, api: { consentSlackRule } })
      const preview = await call<SlackRulesResult>('slack-rules', { verb: 'consent', id: 'rule-1111' })
      expect(preview.needsConfirmation).toBe(true)
      expect(preview.text).toContain('{pr.title} is ready')
      expect(consentSlackRule).not.toHaveBeenCalled()
      await call('slack-rules', { verb: 'consent', id: 'rule-1111', confirmed: true })
      expect(consentSlackRule).toHaveBeenCalledWith('rule-1111-2222')
      // Messages to yourself never ask.
      const mine = await call<SlackRulesResult>('slack-rules', { verb: 'consent', id: 'rule-mine' })
      expect(mine.changed).toBe(false)
    })

    it('refuses an unknown verb', async () => {
      const { call } = setup()
      expect((await failure(call('slack-rules', { verb: 'explode' }))).code).toBe('invalid')
    })
  })

  describe('Slack people, deliveries and asks', () => {
    it('lists, links and unlinks people, defaulting to the only connected Slack workspace', async () => {
      const linkPerson = vi.fn(async () => undefined)
      const unlinkPerson = vi.fn(async () => undefined)
      const person = { githubLogin: 'octo', slackTeamId: 'T0001', slackUserId: 'U9', slackName: 'Octo' }
      const { call } = setup({ integrations: { people: [person] }, api: { linkPerson, unlinkPerson } })
      expect((await call<SlackPeopleResult>('slack-people', { verb: 'list' })).people).toEqual([person])
      await call('slack-people', { verb: 'link', githubLogin: '@hubot', slackId: 'U7', name: 'Hubot' })
      expect(linkPerson).toHaveBeenCalledWith({ githubLogin: 'hubot', slackTeamId: 'T0001', slackUserId: 'U7', slackName: 'Hubot' })
      await call('slack-people', { verb: 'unlink', githubLogin: 'OCTO' })
      expect(unlinkPerson).toHaveBeenCalledWith('OCTO', 'T0001')
      expect((await failure(call('slack-people', { verb: 'link', githubLogin: 'x', slackId: 'U1', teamId: 'T9' }))).message).toMatch(/isn’t a connected Slack workspace/)
      expect((await failure(call('slack-people', { verb: 'unlink', githubLogin: 'ghost' }))).message).toMatch(/isn’t linked/)
    })

    it('lists deliveries, optionally for one connection', async () => {
      const delivery = { id: 'del-1111-2222', ruleId: 'r', occurrence: 'o', connectionId: slack.id, event: 'pr-ready', recipientId: 'U1', recipientName: 'yatin', text: 'hi', status: 'failed', error: 'channel_not_found', title: 'Add billing', at: '2026-10-24T10:00:00.000Z' } as SlackDelivery
      const slackDeliveries = vi.fn(async (_id?: string) => [delivery])
      const { call } = setup({ api: { slackDeliveries } })
      const result = await call<SlackDeliveriesResult>('slack-deliveries', { connection: 'Acme Slack' })
      expect(slackDeliveries).toHaveBeenCalledWith(slack.id)
      expect(result.deliveries[0]).toMatchObject({ id: 'del-1111-2222', status: 'failed', recipient: 'yatin', error: 'channel_not_found' })
      expect(result.text).toContain('channel_not_found')
    })

    it('answers an ask by the start of its id, and resends a delivery', async () => {
      const answerSlackAsk = vi.fn(async () => undefined)
      const resendSlackDelivery = vi.fn(async () => undefined)
      const ask = { id: 'ask-aaaa-bbbb' } as SlackDelivery
      const { call } = setup({ slackAsks: [ask], api: { answerSlackAsk, resendSlackDelivery, slackDeliveries: async () => [{ id: 'del-aaaa-bbbb' } as SlackDelivery] } })
      const sent = await call<SlackActionResult>('slack-answer', { id: 'ask-aaaa', action: 'send', text: 'edited' })
      expect(answerSlackAsk).toHaveBeenCalledWith('ask-aaaa-bbbb', 'send', 'edited')
      expect(sent.text).toBe('Sent.')
      await call('slack-answer', { id: 'ask-aaaa-bbbb', action: 'skip' })
      expect(answerSlackAsk).toHaveBeenLastCalledWith('ask-aaaa-bbbb', 'skip', undefined)
      expect((await failure(call('slack-answer', { id: 'x', action: 'later' }))).code).toBe('invalid')
      expect((await failure(call('slack-answer', { id: 'x', action: 'skip', text: 'no' }))).code).toBe('invalid')
      await call('slack-resend', { id: 'del-aaaa' })
      expect(resendSlackDelivery).toHaveBeenCalledWith('del-aaaa-bbbb')
    })
  })

  describe('Linear', () => {
    it('lists my issues for the repository the command ran in', async () => {
      const linearMyIssues = vi.fn(async (_repoId: string) => ({
        connection: 'Acme',
        issues: [{ identifier: 'ENG-1', title: 'Fix the thing', url: 'https://linear.app/x/ENG-1', branchName: 'eng-1-fix', state: { name: 'In Progress', type: 'started' }, priorityLabel: 'High', team: { key: 'ENG', name: 'Eng' }, assignee: { name: 'Yatin' } }]
      }))
      const { call } = setup({ repos: [repoA], api: { linearMyIssues } })
      const result = await call<LinearIssuesResult>('linear-issues', { cwd: repoA.rootPath })
      expect(linearMyIssues).toHaveBeenCalledWith('ra')
      expect(result.issues[0]).toEqual({ identifier: 'ENG-1', title: 'Fix the thing', state: 'In Progress', team: 'ENG', priority: 'High', assignee: 'Yatin', branch: 'eng-1-fix', url: 'https://linear.app/x/ENG-1' })
      expect(result.text).toContain('ENG-1')
    })

    it('turns the service’s error into a failure', async () => {
      const { call } = setup({ repos: [repoA], api: { linearMyIssues: async () => ({ error: 'No Linear connection for this repository.' }) } })
      await expect(call('linear-issues', { cwd: repoA.rootPath })).rejects.toThrow('No Linear connection')
    })
  })
})
