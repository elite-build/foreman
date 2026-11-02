// Which integrations a workspace's agents get, from the command line: `foreman workspace integrations`, `--with` /
// `--without` on `foreman new` (and `run`, through the same check), and `foreman connections edit`. The same rules as
// the window: only a working connection agents may use can be switched on, and switching grants nothing.
import { describe, expect, it } from 'vitest'
import { CliCodedError, type CliHost } from '../src/main/cli/host'
import { INTEGRATIONS_METHODS } from '../src/main/cli/integrations'
import type { CliContext } from '../src/main/cli/methods'
import { chosenIntegrations } from '../src/main/cli/workspaceIntegrations'
import { WORKSPACE_METHODS } from '../src/main/cli/workspaces'
import { defaultSettings } from '../src/main/store'
import type { ConnectionsEditResult } from '../src/shared/cli/integrations'
import type { NewResult, WsIntegrationsResult } from '../src/shared/cli/workspaces'
import type { ConnectionView } from '../src/shared/integrations'
import type { Api, AppSnapshot, Repo, Session, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const connection = (patch: Partial<ConnectionView> & Pick<ConnectionView, 'id' | 'service'>): ConnectionView =>
  ({ name: patch.id, rev: 1, auth: { kind: 'token' }, agentAccess: 'read', createdAt: 'x', usedBy: 1, isDefault: true, ...patch }) as ConnectionView
const linear = connection({ id: 'lin-1234567', service: 'linear', name: 'Acme Linear' })
const slack = connection({ id: 'sl-1234567', service: 'slack', name: 'Acme Slack', agentAccess: 'write', startsOff: true })

const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: () => undefined })

function rig(options: { connections?: ConnectionView[]; workspace?: Partial<Workspace>; host?: Partial<CliHost>; api?: Partial<Api> } = {}) {
  const calls: [string, ...unknown[]][] = []
  const ws = { id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/x', createdAt: 'x', ...options.workspace } as Workspace
  const connections = options.connections ?? [linear, slack]
  const api = fakeApi({
    setWorkspaceIntegration: (async (id, service, on) => {
      calls.push(['setWorkspaceIntegration', id, service, on])
      ws.integrations = { ...ws.integrations, [service]: on }
    }) as Api['setWorkspaceIntegration'],
    integrationToolCosts: async () => [{ service: 'linear', tools: 31, tokens: 9100 }],
    updateConnection: (async (id, patch) => {
      calls.push(['updateConnection', id, patch])
      const c = connections.find((x) => x.id === id)!
      return { ok: true, connection: { ...c, ...(patch.agentAccess ? { agentAccess: patch.agentAccess } : {}), ...(patch.startsOff !== undefined ? { startsOff: patch.startsOff } : {}) } }
    }) as Api['updateConnection'],
    ...options.api
  })
  const host = stubHost({
    api,
    state: () => ({ repos: [repo], workspaces: [ws], sessions: [{ id: 's1', workspaceId: 'ws1', agent: 'claude', queue: [] } as unknown as Session], settings: defaultSettings() }),
    snapshot: () => ({ integrations: { connections } }) as unknown as AppSnapshot,
    createWorkspace: async (repoId, opts) => (calls.push(['createWorkspace', repoId, opts]), ws),
    ...options.host
  })
  const call = async <T>(methods: typeof WORKSPACE_METHODS, method: string, params: unknown, token?: string): Promise<T> => (await methods[method].handle(host, params, ctx(token))) as T
  return { host, calls, ws, call }
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

const turnHost = (mayStart: boolean): Partial<CliHost> => ({
  identifyCaller: () => ({ kind: 'turn', session: { id: 's1', workspaceId: 'ws1' } as Session, ws: { id: 'ws1', repoId: 'r1' } as Workspace, turnId: 't', live: true }),
  agentsMayStart: () => mayStart
})

describe('foreman workspace integrations', () => {
  it('lists each one: on here, what new workspaces start with, the account and its cost', async () => {
    const { call } = rig()
    const result = await call<WsIntegrationsResult>(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', cwd: '/' })
    expect(result.integrations).toEqual([
      { service: 'linear', on: true, byDefault: true, connection: 'Acme Linear', access: 'read', tools: 31, tokens: 9100 },
      { service: 'slack', on: false, byDefault: false, connection: 'Acme Slack', access: 'write' }
    ])
    expect(result.text).toContain('Acme Linear (read only)')
    expect(result.text).toContain('31 tools, ~9100 tokens')
    expect(result.text).toContain('Switched on: ~9100 tokens of tool definitions.')
    expect(result.changed).toBeUndefined()
  })

  it('switches one on or off for the next message', async () => {
    const { call, calls } = rig()
    const result = await call<WsIntegrationsResult>(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', cwd: '/', on: ['Slack'], off: ['linear'] })
    expect(calls).toEqual([
      ['setWorkspaceIntegration', 'ws1', 'slack', true],
      ['setWorkspaceIntegration', 'ws1', 'linear', false]
    ])
    expect(result.changed).toEqual({ slack: true, linear: false })
    expect(result.integrations.map((r) => [r.service, r.on])).toEqual([['linear', false], ['slack', true]])
    expect(result.text).toMatch(/^Switched Slack on, Linear off in lisbon\. It applies from the next message\./)
  })

  it('refuses what it can’t switch, and says what would make it possible', async () => {
    const noAccess = rig({ connections: [{ ...linear, agentAccess: 'off' }] })
    const err = await failure(noAccess.call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['linear'] }))
    expect(err.message).toContain('Agents may do nothing with “Acme Linear”')
    expect(err.message).toContain('foreman connections edit lin-1234 --agent-access read')
    expect((await failure(rig({ connections: [] }).call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['linear'] }))).message).toContain('`foreman connections add linear`')
    expect((await failure(rig().call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['github'] }))).message).toContain('can’t be switched per workspace')
    expect((await failure(rig().call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['linear'], off: ['linear'] }))).message).toContain('both on and off')
    expect((await failure(rig({ workspace: { cloud: { provider: 'vercel' } as Workspace['cloud'] } }).call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['slack'] }))).message).toContain('cloud')
  })

  it('from an agent turn, switching one on needs the repository’s opt-in; switching off and listing don’t', async () => {
    const closed = rig({ host: turnHost(false) })
    expect((await failure(closed.call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['slack'] }, 'k'))).code).toBe('refused')
    await closed.call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', off: ['linear'] }, 'k')
    expect(closed.calls).toEqual([['setWorkspaceIntegration', 'ws1', 'linear', false]])
    const open = rig({ host: turnHost(true) })
    await open.call(WORKSPACE_METHODS, 'ws-integrations', { workspace: 'lisbon', on: ['slack'] }, 'k')
    expect(open.calls).toEqual([['setWorkspaceIntegration', 'ws1', 'slack', true]])
  })
})

describe('--with and --without on a new workspace', () => {
  it('passes only what was asked for; the app records the rest of the defaults', async () => {
    const { host } = rig()
    expect(chosenIntegrations(host, repo)).toBeUndefined()
    expect(chosenIntegrations(host, repo, ['slack'], ['linear'])).toEqual({ slack: true, linear: false })
    // Switching off one that isn't offered here changes nothing.
    expect(chosenIntegrations(rig({ connections: [linear] }).host, repo, [], ['slack'])).toEqual({})
    expect(() => chosenIntegrations(rig({ connections: [linear] }).host, repo, ['slack'])).toThrow('has no Slack connection')
  })

  it('foreman new sends them with the workspace, and refuses them for a cloud sandbox', async () => {
    const { call, calls } = rig({ host: { firstTurn: async () => undefined } })
    await call<NewResult>(WORKSPACE_METHODS, 'new', { prompt: 'Why did the evals drop?', cwd: '/', repo: 'app', with: ['slack'], noWait: true })
    expect(calls[0][2]).toMatchObject({ prompt: 'Why did the evals drop?', integrations: { slack: true } })
    const cloud = rig()
    expect((await failure(cloud.call(WORKSPACE_METHODS, 'new', { prompt: 'x', cwd: '/', repo: 'app', with: ['slack'], cloud: true, noWait: true }))).message).toContain('cloud sandbox')
    expect(cloud.calls).toEqual([])
  })
})

describe('foreman connections edit', () => {
  const edit = (r: ReturnType<typeof rig>, params: Record<string, unknown>) => r.call<ConnectionsEditResult>(INTEGRATIONS_METHODS, 'connections-edit', params)

  it('sets whether new workspaces start with it, without touching what agents may do', async () => {
    const r = rig()
    const result = await edit(r, { id: 'Acme Linear', newWorkspaces: 'off' })
    expect(r.calls).toEqual([['updateConnection', 'lin-1234567', { startsOff: true }]])
    expect(result.connection).toMatchObject({ name: 'Acme Linear', newWorkspaces: 'off', agentAccess: 'read' })
    expect(result.text).toContain('new workspaces start with it off')
    expect(result.text).toContain('foreman workspace integrations <workspace> --on linear')
  })

  it('changes what agents may do, within what each service allows', async () => {
    const r = rig()
    await edit(r, { id: 'lin-1234', agentAccess: 'write', newWorkspaces: 'on' })
    expect(r.calls).toEqual([['updateConnection', 'lin-1234567', { agentAccess: 'write', startsOff: false }]])
    expect((await failure(edit(rig(), { id: 'Acme Slack', agentAccess: 'read' }))).message).toContain('off, write')
    const gh = rig({ connections: [connection({ id: 'gh-1', service: 'github', name: 'Work' })] })
    expect((await failure(edit(gh, { id: 'Work', newWorkspaces: 'off' }))).message).toContain('Only linear, slack, langfuse tools')
    expect((await failure(edit(gh, { id: 'Work', agentAccess: 'read' }))).message).toContain('no agent-access setting')
    expect((await failure(edit(rig(), { id: 'lin-1234' }))).message).toContain('Say what to change')
  })
})
