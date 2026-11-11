// docs/agent-access.md §7: the tools an outside agent calls over the loopback endpoint, with the SDK's own client and a
// token from the real sign-in: the tools per level, refusals at call time, a started task's cap and who started it, what
// send_task carries, its own workers' questions only, revoking (at the next call, mid-wait, and its queued messages).
import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AGENT_ACCESS_PORT, AgentAccessService } from '../src/main/agentAccess/server'
import { outsideToolDescription, OutsideTools, READ_ONLY, SIGNED_OUT } from '../src/main/agentAccess/tools'
import { Core } from '../src/main/core'
import { ForemanActions } from '../src/main/foremanActions'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { DELEGATION_TOOLS } from '../src/shared/foremanDelegation'
import { FOREMAN_TOOLS } from '../src/shared/foremanTools'
import { OUTSIDE_TOOL_SCOPES, type AgentAccessLevel, type AgentGrant, type TurnCap } from '../src/shared/agentAccess'
import type { ApprovalRequest, PromptTemplate, QueuedMessage, Schedule, ScheduleRequest, Session, Workspace } from '../src/shared/types'
import type { FlowListing } from '../src/shared/flows'
import { ScheduleService } from '../src/main/schedules'
import { delegationRig } from './foremanDelegationHarness'
import { tempDir } from './helpers'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

const READ_TOOLS = ['list_delegation_options', 'get_task_status', 'get_turn_result', 'wait_for_turn', 'get_workspace_status', 'get_check_results', 'list_questions', 'list_schedules']
const OPERATE_TOOLS = ['start_task', 'send_task', 'cancel_turn', 'run_checks', 'answer_question', 'schedule_task']

function fakes() {
  const vault = new Map<string, string>()
  const state = { settings: { language: 'en', agentAccessEnabled: true, agentAccessPort: AGENT_ACCESS_PORT } } as unknown as Store['state']
  const store = { state, save: vi.fn() } as unknown as Store
  const secrets = {
    appSecret: (key: string) => vault.get(key),
    setAppSecret: (key: string, value: string | null) => void (value === null ? vault.delete(key) : vault.set(key, value))
  } as unknown as SecretStore
  return { store, secrets, state }
}

async function rig() {
  const d = delegationRig()
  const base = fakes()
  const approvals: ApprovalRequest[] = []
  const answerQuestion = vi.fn(async () => undefined)
  const checksStatus = vi.fn(async () => ({ configured: true, running: false, rows: [] }))
  const runChecks = vi.fn(async () => ({ started: true as const }))
  const actions = new ForemanActions({ state: () => d.state, api: { checksStatus, runChecks, openPreview: vi.fn() } as never })
  const onRevoked = vi.fn()
  const service = new AgentAccessService({ store: base.store, secrets: base.secrets, onChanged: () => undefined, onRevoked, port: 0 })
  // What a call reads as the live grant; a test may put another in its place.
  const live: { override?: AgentGrant } = {}
  // Schedules: the real service behind propose (Core.proposeSchedule adds saveSchedule's checks, tested in proposedSchedules.test.ts).
  const scheduleStore = { state: { schedules: [] as Schedule[] }, flush: vi.fn() }
  const scheduleService = new ScheduleService({ store: scheduleStore, now: () => Date.now(), inputs: () => ({ error: 'unused' }), launch: async () => undefined, stop: async () => undefined, changed: () => undefined })
  d.state.settings.promptTemplates = [{ id: 't-1', name: 'Nightly review', body: 'Review the last day of commits' }, { id: 't-2', name: 'Fix', body: 'Fix {{issue}}' }]
  const propose = vi.fn((input: ScheduleRequest, by: { grantId: string; name: string }) => scheduleService.propose(input, by))
  const listFlows = vi.fn(async (): Promise<FlowListing[]> => [])
  const tools = new OutsideTools({
    grant: (id) => live.override ?? service.grant(id),
    delegation: d.service,
    actions,
    approvals: () => approvals,
    session: (id) => d.state.sessions.find((s) => s.id === id),
    workspace: (id) => d.state.workspaces.find((w) => w.id === id),
    answerQuestion,
    flowsOn: () => Boolean(d.state.settings.flows),
    schedules: {
      snapshot: () => ({ schedules: scheduleStore.state.schedules, repos: d.state.repos, repoTemplates: { r: [{ id: 'repo:r:audit.md', name: 'Audit', body: 'Audit the dependencies', source: 'repo', repoId: 'r' } as PromptTemplate] }, settings: d.state.settings }),
      listFlows,
      claudeModel: (model) => {
        if (!model.startsWith('claude-')) throw new Error(`Claude doesn’t list a model “${model}”.`)
        return model
      },
      propose
    }
  })
  service.setMcpHandler(tools.handle)
  await service.start()
  cleanup.push(() => service.close())
  return { ...d, base, service, approvals, answerQuestion, checksStatus, runChecks, onRevoked, live, origin: service.origin, scheduleStore, propose, listFlows }
}
type Rig = Awaited<ReturnType<typeof rig>>

const verifier = 'v'.repeat(43) + 'erifier-for-this-test'

/** Register, authorize, approve with the code the page shows, exchange: an access token and the grant it acts for. */
async function signIn(r: Rig, level: AgentAccessLevel = 'ask'): Promise<{ token: string; grant: AgentGrant }> {
  const reg = await fetch(`${r.origin}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:1234/cb'] }) })
  const clientId = (await reg.json() as { client_id: string }).client_id
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:5678/cb', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'xyz' })
  const html = await (await fetch(`${r.origin}/oauth/authorize?${params}`)).text()
  const shown = /class="code">(\d{3}) (\d{3})</.exec(html)!
  const status = /data-status="([^"]+)"/.exec(html)![1]
  r.service.approve(r.service.info().pending.at(-1)!.id, shown[1] + shown[2], level)
  const { location } = await (await fetch(`${r.origin}${status}`)).json() as { location: string }
  const code = new URL(location).searchParams.get('code')!
  const res = await fetch(`${r.origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:5678/cb', client_id: clientId, code_verifier: verifier }).toString() })
  const tokens = await res.json() as { access_token: string }
  return { token: tokens.access_token, grant: r.service.info().grants.at(-1)! }
}

async function connect(r: Rig, token: string): Promise<Client> {
  const client = new Client({ name: 'outside-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  cleanup.push(() => client.close())
  return client
}

async function as(r: Rig, level: AgentAccessLevel = 'ask') {
  const { token, grant } = await signIn(r, level)
  const client = await connect(r, token)
  const call = async (name: string, args: Record<string, unknown> = {}, options?: { signal?: AbortSignal }) => {
    const result = await client.callTool({ name, arguments: args }, undefined, options) as { content: { type: string; text: string }[]; isError?: boolean }
    const text = result.content.map((c) => c.text).join('')
    return { error: Boolean(result.isError), text, value: result.isError ? undefined : JSON.parse(text) as Record<string, unknown> }
  }
  const cap = (ceiling: TurnCap['ceiling']): TurnCap => ({ ceiling, grantId: grant.id, name: 'Claude Code' })
  return { client, call, grant, token, cap }
}

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort()

describe('the tools a level is offered', () => {
  it('offers a read-only client its reads only, and an operating one the rest too; never a flow start, a preview, the CLI or decide', async () => {
    const r = await rig()
    const reader = await as(r, 'read')
    expect(await names(reader.client)).toEqual([...READ_TOOLS].sort())
    const asker = await as(r, 'ask')
    expect(await names(asker.client)).toEqual([...READ_TOOLS, ...OPERATE_TOOLS].sort())
    // get_flow_status only while Flows are on, and with a runId.
    r.state.settings.flows = true
    const tools = (await asker.client.listTools()).tools
    expect(tools.map((t) => t.name)).toContain('get_flow_status')
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['start_flow']))
    for (const name of ['start_flow', 'open_preview', 'run_foreman', 'decide']) expect(tools.some((t) => t.name === name)).toBe(false)
    expect(tools.find((t) => t.name === 'get_flow_status')!.inputSchema.required).toEqual(['runId'])
    // Where the catalogue says "the caller's repository", the outside variant says repoId is required, and the schema agrees.
    const start = tools.find((t) => t.name === 'start_task')!
    expect(start.inputSchema.required).toEqual(expect.arrayContaining(['repoId', 'prompt', 'loadout']))
    expect(start.description).toContain('repoId is required')
    for (const name of ['start_task', 'list_delegation_options', 'get_flow_status'] as const) expect(outsideToolDescription(name)).not.toMatch(/caller’s repository|your own workspace/)
    expect(tools.find((t) => t.name === 'get_workspace_status')!.inputSchema.required).toEqual(['workspaceId'])
    // Annotations follow the scope.
    expect(tools.find((t) => t.name === 'wait_for_turn')!.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'start_task')!.annotations?.readOnlyHint).toBe(false)
  })

  it('scopes every offered tool, matching the catalogue’s own read-only flags', () => {
    for (const [name, scope] of Object.entries(OUTSIDE_TOOL_SCOPES)) {
      const catalogue = (DELEGATION_TOOLS as Record<string, { readOnly: boolean }>)[name] ?? (FOREMAN_TOOLS as Record<string, { readOnly: boolean }>)[name]
      if (catalogue) expect(scope, name).toBe(catalogue.readOnly ? 'read' : 'operate')
    }
    expect(OUTSIDE_TOOL_SCOPES.list_questions).toBe('read')
    expect(OUTSIDE_TOOL_SCOPES.answer_question).toBe('operate')
  })

  it('refuses a read-only client an operate tool called by name, and an operate tool when the live grant reads only', async () => {
    const r = await rig()
    const reader = await as(r, 'read')
    const refused = await reader.call('start_task', { prompt: 'Build it', loadout: 1, repoId: 'r' }).catch((err: Error) => ({ error: true, text: err.message }))
    expect(refused.error).toBe(true)
    expect(r.createWorkspace).not.toHaveBeenCalled()
    // A read-only client's list says it can't delegate.
    expect((await reader.call('list_delegation_options')).value).toMatchObject({ delegationEnabled: false })
    // Offered at Ask, refused at call time when the grant read now is read only.
    const asker = await as(r, 'ask')
    r.live.override = { ...asker.grant, level: 'read' }
    for (const [name, args] of [['start_task', { prompt: 'Build it', loadout: 1, repoId: 'r' }], ['run_checks', { workspaceId: 'w' }], ['answer_question', { approvalId: 'q', skipped: true }]] as const) {
      const result = await asker.call(name, args)
      expect(result, name).toMatchObject({ error: true, text: READ_ONLY })
    }
    expect(r.createWorkspace).not.toHaveBeenCalled()
    expect(r.runChecks).not.toHaveBeenCalled()
  })
})

describe('starting and sending', () => {
  it('starts a task that records the outside agent as who started it, its first message carrying the level’s ceiling', async () => {
    const r = await rig()
    const c = await as(r, 'ask-except-edits')
    const started = await c.call('start_task', { prompt: 'Build the importer', loadout: 1, repoId: 'r' })
    expect(started.error).toBe(false)
    expect(r.createWorkspace).toHaveBeenCalledTimes(1)
    expect(r.createWorkspace.mock.calls[0][0]).toBe('r')
    expect((r.createWorkspace.mock.calls[0] as unknown[])[2]).toEqual({ startedBy: { via: 'outside', grantId: c.grant.id, name: 'Claude Code' }, cap: c.cap('ask-except-edits') })
  })

  it('requires repoId', async () => {
    const r = await rig()
    const c = await as(r)
    const missing = await c.call('start_task', { prompt: 'Build it', loadout: 1 })
    expect(missing.error).toBe(true)
    expect(missing.text).toMatch(/repoId/)
    // The handler refuses it too, whatever schema reached it.
    const d = delegationRig()
    await expect(d.service.call('start_task', { prompt: 'x', loadout: 1 }, { readOnly: false, outside: { grantId: 'g', name: 'n' }, cap: c.cap('ask') })).rejects.toThrow('Pass repoId')
    expect(r.createWorkspace).not.toHaveBeenCalled()
  })

  it('refuses start_task and send_task for an agent that can’t be held to the ceiling, and allows them at Never ask', async () => {
    const r = await rig()
    const asker = await as(r, 'ask')
    const options = (await asker.call('list_delegation_options')).value as { loadouts: { slot: number; agent: string; heldAtLevels: string[]; usable?: boolean }[]; flows?: unknown }
    expect(options.loadouts.find((l) => l.agent === 'cursor')).toMatchObject({ heldAtLevels: ['never-ask'], usable: false })
    expect(options.loadouts.find((l) => l.agent === 'claude')).toMatchObject({ heldAtLevels: ['ask', 'ask-except-edits', 'auto', 'never-ask'], usable: true })
    const cursorSlot = options.loadouts.find((l) => l.agent === 'cursor')!.slot
    const refused = await asker.call('start_task', { prompt: 'Build it', loadout: cursorSlot, repoId: 'r' })
    expect(refused.error).toBe(true)
    expect(refused.text).toMatch(/Cursor/)
    expect(r.createWorkspace).not.toHaveBeenCalled()
    r.state.sessions.push({ ...r.session, id: 'cursor-chat', agent: 'cursor', status: 'idle', turnId: undefined })
    const sent = await asker.call('send_task', { workspaceId: 'w', sessionId: 'cursor-chat', prompt: 'Go on' })
    expect(sent.error).toBe(true)
    expect(sent.text).toMatch(/Cursor/)
    expect(r.deliver).not.toHaveBeenCalled()
    const never = await as(r, 'never-ask')
    expect((await never.call('start_task', { prompt: 'Build it', loadout: cursorSlot, repoId: 'r' })).error).toBe(false)
    expect((await never.call('send_task', { workspaceId: 'w', sessionId: 'cursor-chat', prompt: 'Go on' })).error).toBe(false)
  })

  it('sends with the outside origin and the cap', async () => {
    const r = await rig()
    const c = await as(r, 'auto')
    const sent = await c.call('send_task', { workspaceId: 'w', sessionId: 's', prompt: 'Look at the failing test' })
    expect(sent.error).toBe(false)
    expect(r.deliver).toHaveBeenCalledTimes(1)
    expect((r.deliver.mock.calls[0] as unknown[])[2]).toMatchObject({ mode: 'queue', origin: { kind: 'outside', grantId: c.grant.id, name: 'Claude Code' }, cap: c.cap('auto') })
  })

  it('lists no flows, even while Flows are on', async () => {
    const r = await rig()
    r.state.settings.flows = true
    const c = await as(r)
    expect((await c.call('list_delegation_options')).value).not.toHaveProperty('flows')
  })

  it('reads a workspace’s checks with workspaceId as an argument, and runs them only at Never ask (docs/agent-access.md §4)', async () => {
    const r = await rig()
    for (const level of ['ask', 'ask-except-edits', 'auto'] as const) {
      const c = await as(r, level)
      expect((await c.call('get_check_results', { workspaceId: 'w' })).value).toMatchObject({ configured: true })
      expect((await c.call('get_workspace_status', { workspaceId: 'w' })).value).toMatchObject({ id: 'w' })
      const refused = await c.call('run_checks', { workspaceId: 'w' })
      expect(refused.error, level).toBe(true)
      expect(refused.text).toContain('run the workspace’s code with the user’s full rights')
    }
    expect(r.runChecks).not.toHaveBeenCalled()
    const never = await as(r, 'never-ask')
    expect((await never.call('run_checks', { workspaceId: 'w' })).value).toMatchObject({ started: true, workspaceId: 'w' })
  })
})

describe('schedules', () => {
  const proposal = { repoId: 'r', templateId: 't-1', recurrence: 'weekly', startDate: '2099-03-02', time: '09:00', timezone: 'Europe/London', weekdays: [1, 3], model: 'claude-sonnet-5-5', maxMinutes: 60, afterRun: 'archive' }

  it('lets a read-only client list schedules and the templates it could schedule, but not propose one', async () => {
    const r = await rig()
    const reader = await as(r, 'read')
    const offered = (await reader.client.listTools()).tools.map((t) => t.name)
    expect(offered).toContain('list_schedules')
    expect(offered).not.toContain('schedule_task')
    const listed = (await reader.call('list_schedules')).value as { schedules: unknown[]; templates: { id: string; name: string; repoId?: string }[]; flows?: unknown }
    expect(listed.schedules).toEqual([])
    // Written-out templates only (nobody can fill in a scheduled run's placeholder); a repository's say which.
    expect(listed.templates).toEqual([{ id: 't-1', name: 'Nightly review' }, { id: 'repo:r:audit.md', name: 'Audit', repoId: 'r' }])
    expect(listed.flows).toBeUndefined()
    const refused = await reader.call('schedule_task', proposal).catch((err: Error) => ({ error: true, text: err.message }))
    expect(refused.error).toBe(true)
    expect(r.propose).not.toHaveBeenCalled()
  })

  it('refuses an Ask client’s proposal and says why, and Ask except edits too', async () => {
    const r = await rig()
    for (const level of ['ask', 'ask-except-edits'] as const) {
      const c = await as(r, level)
      const refused = await c.call('schedule_task', proposal)
      expect(refused.error, level).toBe(true)
      expect(refused.text).toMatch(/Only Auto or Never ask access may propose a schedule: a scheduled run is unattended and runs in auto mode/)
      expect(refused.text).toContain(level === 'ask' ? '(Ask)' : '(Ask except edits)')
    }
    expect(r.propose).not.toHaveBeenCalled()
    expect(r.scheduleStore.state.schedules).toEqual([])
  })

  it('saves an Auto client’s proposal paused, with nothing approved, naming who proposed it, and lists it', async () => {
    const r = await rig()
    const c = await as(r, 'auto')
    const result = await c.call('schedule_task', proposal)
    expect(result.error, result.text).toBe(false)
    expect(result.value).toMatchObject({ proposed: true, state: 'paused', pausedKind: 'proposed' })
    expect(r.propose).toHaveBeenCalledWith(
      { repoId: 'r', templateId: 't-1', templateName: 'Nightly review', baseBranch: 'main', recurrence: 'weekly', startDate: '2099-03-02', weekdays: [1, 3], dayOfMonth: 2, time: '09:00', timezone: 'Europe/London', agent: 'claude', model: 'claude-sonnet-5-5', maxMinutes: 60, afterRun: 'archive' },
      { grantId: c.grant.id, name: 'Claude Code' }
    )
    const saved = r.scheduleStore.state.schedules[0]
    expect(saved).toMatchObject({ id: result.value!.scheduleId, state: 'paused', pausedKind: 'proposed', proposedBy: { grantId: c.grant.id, name: 'Claude Code' } })
    expect(saved.approved).toBeUndefined()
    expect(saved.nextRunAt).toBeUndefined()
    const listed = (await c.call('list_schedules')).value as { schedules: Record<string, unknown>[] }
    expect(listed.schedules).toEqual([expect.objectContaining({ id: saved.id, runs: { templateId: 't-1', template: 'Nightly review' }, repoId: 'r', repo: 'Project', recurrence: 'weekly', state: 'paused', pausedKind: 'proposed', proposedBy: 'Claude Code', model: 'claude-sonnet-5-5', maxMinutes: 60, afterRun: 'archive' })])
    expect(listed.schedules[0].cadence).toBe('every Mon, Wed at 09:00 (Europe/London)')
    // Never ask may propose too.
    const never = await as(r, 'never-ask')
    expect((await never.call('schedule_task', { ...proposal, time: '10:00' })).error).toBe(false)
    // Revoking the sign-in that proposed it leaves the proposal in place, inert, still saying who proposed it.
    r.service.revoke(c.grant.id)
    expect(r.scheduleStore.state.schedules[0]).toMatchObject({ state: 'paused', pausedKind: 'proposed', proposedBy: { name: 'Claude Code' } })
    expect(((await never.call('list_schedules')).value as { schedules: unknown[] }).schedules).toHaveLength(2)
  })

  it('refuses what the Schedule dialog wouldn’t offer, saying what to pass', async () => {
    const r = await rig()
    const c = await as(r, 'auto')
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...proposal, flowId: 'built-in:x' }, /exactly one of templateId and flowId/],
      [{ ...proposal, templateId: undefined }, /exactly one of templateId and flowId/],
      [{ ...proposal, repoId: 'gone' }, /Choose a repository ID/],
      [{ ...proposal, templateId: 'nope' }, /Choose a template ID from list_schedules/],
      // Another repository's template doesn't run here.
      [{ ...proposal, repoId: 'other', templateId: 'repo:r:audit.md' }, /Choose a template ID from list_schedules/],
      [{ ...proposal, model: undefined }, /Pass model/],
      [{ ...proposal, model: 'gpt-5' }, /doesn’t list a model/],
      [{ ...proposal, timezone: 'Mars/Base' }, /isn’t a time zone/],
      [{ ...proposal, time: '25:00' }, /HH:MM/],
      [{ ...proposal, maxMinutes: 1 }, /maxMinutes/],
      [{ ...proposal, inputs: { task: 'x' } }, /inputs go with a flow/],
      [{ ...proposal, flowId: 'built-in:x', templateId: undefined, model: undefined }, /Flows are off/]
    ]
    for (const [args, message] of cases) {
      const result = await c.call('schedule_task', args)
      expect(result.error, JSON.stringify(args)).toBe(true)
      expect(result.text, JSON.stringify(args)).toMatch(message)
    }
    expect(r.propose).not.toHaveBeenCalled()
  })

  it('proposes a flow while Flows are on, which takes no model, and lists the flows with their inputs', async () => {
    const r = await rig()
    r.state.settings.flows = true
    const listing = { id: 'built-in:fix-until-green', source: 'built-in', name: 'Fix until green', toml: '', problems: [] } as unknown as FlowListing
    r.listFlows.mockResolvedValue([listing])
    const c = await as(r, 'auto')
    const listed = (await c.call('list_schedules')).value as { flows?: { id: string; name: string }[] }
    expect(listed.flows).toEqual([expect.objectContaining({ id: 'built-in:fix-until-green', name: 'Fix until green' })])
    const flowArgs = { repoId: 'r', flowId: listing.id, inputs: { task: 'the parser' }, recurrence: 'daily', startDate: '2099-03-02', time: '07:00', timezone: 'UTC' }
    expect((await c.call('schedule_task', { ...flowArgs, model: 'claude-sonnet-5-5' })).text).toMatch(/model doesn’t go with flowId/)
    const proposed = await c.call('schedule_task', flowArgs)
    expect(proposed.error, proposed.text).toBe(false)
    expect(r.propose.mock.calls[0][0]).toMatchObject({ flow: { flowId: listing.id, flowSource: 'built-in', flowName: 'Fix until green', inputs: { task: 'the parser' } }, model: '' })
  })
})

describe('its own workers’ questions', () => {
  const question = (id: string, sessionId: string): ApprovalRequest => ({ id, sessionId, kind: 'question', questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }, { question: 'Add migrations?', options: [{ label: 'Yes' }, { label: 'No' }] }] })

  async function questionsRig() {
    const r = await rig()
    const c = await as(r, 'ask')
    // Its worker: a running turn under this sign-in's cap. Another tree's worker and the user's own chat beside it.
    r.session.turnCap = c.cap('ask')
    r.state.sessions.push({ ...r.session, id: 'theirs', turnCap: { ceiling: 'ask', grantId: 'someone-else', name: 'Codex' } }, { ...r.session, id: 'users', turnCap: undefined })
    r.approvals.push(question('q-own', 's'), question('q-theirs', 'theirs'), question('q-users', 'users'), { id: 't-own', sessionId: 's', kind: 'tool', toolName: 'Bash', input: { command: 'rm -rf /' } })
    return { r, c }
  }

  it('lists only the questions from turns in its tree', async () => {
    const { c } = await questionsRig()
    const listed = (await c.call('list_questions')).value as { questions: { approvalId: string; workspaceId: string; sessionId: string; questions: { question: string }[] }[]; contentIsData: boolean }
    expect(listed.questions.map((q) => q.approvalId)).toEqual(['q-own'])
    expect(listed.questions[0]).toMatchObject({ workspaceId: 'w', sessionId: 's', questions: [{ question: 'Which database?' }, { question: 'Add migrations?' }] })
    expect(listed.contentIsData).toBe(true)
  })

  it('answers its own worker’s question, the keys checked and the answers cut, via outside with its name', async () => {
    const { r, c } = await questionsRig()
    const unknown = await c.call('answer_question', { approvalId: 'q-own', answers: { 'Drop the tables?': 'Yes' } })
    expect(unknown).toMatchObject({ error: true })
    expect(unknown.text).toMatch(/aren’t questions/)
    const answered = await c.call('answer_question', { approvalId: 'q-own', answers: { 'Which database?': 'x'.repeat(3000) } })
    expect(answered.value).toMatchObject({ answered: true, approvalId: 'q-own' })
    expect(r.answerQuestion).toHaveBeenCalledWith('q-own', { kind: 'question', answers: { 'Which database?': 'x'.repeat(2000), 'Add migrations?': '(no answer)' } }, 'Claude Code')
    await c.call('answer_question', { approvalId: 'q-own', skipped: true })
    expect(r.answerQuestion).toHaveBeenLastCalledWith('q-own', { kind: 'question', skipped: true }, 'Claude Code')
  })

  it('refuses another tree’s question, the user’s, and any other kind in its own tree', async () => {
    const { r, c } = await questionsRig()
    for (const approvalId of ['q-theirs', 'q-users', 't-own']) {
      const result = await c.call('answer_question', { approvalId, answers: { 'Which database?': 'SQLite' } })
      expect(result.error, approvalId).toBe(true)
      expect(result.text).toMatch(/only a question asked by a turn you started/)
    }
    expect((await c.call('answer_question', { approvalId: 'gone', skipped: true })).text).toMatch(/isn’t waiting any more/)
    expect(r.answerQuestion).not.toHaveBeenCalled()
  })
})

describe('revoking', () => {
  it('refuses the next call, which is told to sign in again', async () => {
    const r = await rig()
    const c = await as(r)
    expect((await c.call('list_delegation_options')).error).toBe(false)
    r.service.revoke(c.grant.id)
    expect(r.onRevoked).toHaveBeenCalledWith(c.grant.id)
    await expect(c.call('list_delegation_options')).rejects.toThrow()
    // A call that was authenticated just before is refused by the live grant.
    const again = await as(r)
    r.live.override = undefined
    const grant = vi.spyOn(r.service, 'grant')
    grant.mockReturnValue(undefined)
    expect(await again.call('get_task_status', { workspaceId: 'w' })).toMatchObject({ error: true, text: SIGNED_OUT })
  })

  it('ends a wait_for_turn in flight with the sign-in-again message', async () => {
    const r = await rig()
    r.turns.set('busy', { workspaceId: 'w', sessionId: 's', turnId: 'busy', state: 'running' })
    const c = await as(r)
    const waiting = c.call('wait_for_turn', { turnId: 'busy', timeoutSeconds: 20 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    r.service.revoke(c.grant.id)
    expect(await waiting).toMatchObject({ error: true, text: SIGNED_OUT })
  })

  it('stops a wait_for_turn whose HTTP request closed', async () => {
    const r = await rig()
    r.turns.set('busy', { workspaceId: 'w', sessionId: 's', turnId: 'busy', state: 'running' })
    let polls = 0
    const turnStatus = r.host.turnStatus
    r.host.turnStatus = async (id) => (polls++, turnStatus(id))
    const { token } = await signIn(r)
    // The SDK's client cancels a call with a notification and leaves its request open; a client that goes away closes it.
    const controller = new AbortController()
    const waiting = fetch(`${r.origin}/mcp`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_turn', arguments: { turnId: 'busy', timeoutSeconds: 20 } } })
    }).catch(() => 'aborted')
    await vi.waitFor(() => expect(polls).toBeGreaterThan(1))
    controller.abort()
    expect(await waiting).toBe('aborted')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = polls
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(polls).toBe(after)
  })
})

describe('in the core', () => {
  async function setup(state: Workspace['state'] = 'ready') {
    const dir = await tempDir('foreman-outside-core-')
    const store = new Store(dir)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: await tempDir('foreman-outside-ws-'), portBase: 50050, state, createdAt: new Date().toISOString() }
    store.state.workspaces.push(ws)
    const internals = core as unknown as { startChat(...args: unknown[]): string }
    return { core, store, ws, internals }
  }
  const cap = (grantId: string): TurnCap => ({ ceiling: 'ask', grantId, name: 'Claude Code' })

  it('gives a workspace an outside agent started a first message that says so, with its cap', async () => {
    const { core, internals } = await setup()
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
    internals.startChat('ws', 'Build the importer', undefined, undefined, undefined, { startedBy: { via: 'outside', grantId: 'g1', name: 'Claude Code' }, cap: cap('g1') })
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][2]).toEqual({ origin: { kind: 'outside', grantId: 'g1', name: 'Claude Code' }, cap: cap('g1') })
  })

  it('drops what a revoked sign-in’s tree queued or held, in every chat, and nothing else', async () => {
    const { core, store, ws } = await setup('setup-failed')
    const message = (id: string, grantId?: string): QueuedMessage => ({ id, turnId: `turn-${id}`, text: id, attachments: [], ...(grantId ? { cap: cap(grantId) } : {}) })
    const chat = (id: string, queue: QueuedMessage[]) => ({ id, workspaceId: 'ws', agent: 'claude', model: 'm', status: 'running', fastMode: false, planMode: false, queue, createdAt: '' }) as Session
    store.state.sessions.push(chat('a', [message('a1', 'g1'), message('a2'), message('a3', 'g2')]), chat('b', [message('b1', 'g1')]))
    ws.heldMessage = { sessionId: 'a', text: 'held', at: '', cap: cap('g1') }
    core.agentGrantRevoked('g1')
    expect(store.state.sessions.find((s) => s.id === 'a')!.queue.map((m) => m.id)).toEqual(['a2', 'a3'])
    expect(store.state.sessions.find((s) => s.id === 'b')!.queue).toEqual([])
    expect(ws.heldMessage).toBeUndefined()
    // Another sign-in's held message stays.
    ws.heldMessage = { sessionId: 'a', text: 'held', at: '', cap: cap('g2') }
    core.agentGrantRevoked('g1')
    expect(ws.heldMessage?.text).toBe('held')
  })

  it('clears a revoked sign-in’s armed usage-limit resume, and refuses its cap at createWorkspace and at send', async () => {
    const { core, store, ws } = await setup()
    const resume = { turnId: 't', resetAt: '', at: new Date(Date.now() + 60_000).toISOString(), source: 's', text: 'Continue', armedAt: '', cap: cap('g1') }
    store.state.sessions.push({ id: 'a', workspaceId: 'ws', agent: 'claude', model: 'm', status: 'idle', fastMode: false, planMode: false, queue: [], createdAt: '', limitResume: resume } as Session)
    core.agentGrantRevoked('g1')
    expect(store.state.sessions.find((s) => s.id === 'a')!.limitResume).toBeUndefined()

    // With the access service bound, a cap whose sign-in is gone starts nothing.
    core.bindAgentAccess({ grant: (id: string) => (id === 'g2' ? { id } : undefined) } as never)
    const internals = core as unknown as { createFromOptions(...args: unknown[]): Promise<Workspace> }
    const created = vi.spyOn(core.workspaces, 'createWorkspace')
    await expect(internals.createFromOptions('repo', { prompt: 'Build it' }, { cap: cap('g1') })).rejects.toThrow('revoked or has ended')
    expect(created).not.toHaveBeenCalled()
    await expect(core.sessions.send('a', 'go', { cap: cap('g1') })).rejects.toThrow('revoked or has ended')
    expect(ws.state).toBe('ready')
  })

  it('records an outside agent’s answer in the history with its name', async () => {
    const { core, store } = await setup()
    store.state.sessions.push({ id: 's1', workspaceId: 'ws', agent: 'claude', queue: [] } as unknown as Session)
    vi.spyOn(core.sessions, 'pendingApprovals').mockReturnValue([{ id: 'q', sessionId: 's1', kind: 'question', questions: [] }])
    vi.spyOn(core.sessions, 'respondApproval').mockResolvedValue()
    const record = vi.spyOn(core.attention, 'record').mockImplementation(() => undefined as never)
    await core.answerAsOutside('q', { kind: 'question', answers: {} }, 'Claude Code')
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval-answered', via: 'outside', by: 'Claude Code' }))
    await core.api.respondApproval('q', { kind: 'question', answers: {} }, 'phone')
    expect(record.mock.calls.at(-1)![0]).toMatchObject({ via: 'phone' })
    expect(record.mock.calls.at(-1)![0]).not.toHaveProperty('by')
  })

  it('never records an Api caller as an outside agent, whatever it claims', async () => {
    const { core, store } = await setup()
    store.state.sessions.push({ id: 's1', workspaceId: 'ws', agent: 'claude', queue: [] } as unknown as Session)
    vi.spyOn(core.sessions, 'pendingApprovals').mockReturnValue([{ id: 'q', sessionId: 's1', kind: 'question', questions: [] }])
    vi.spyOn(core.sessions, 'respondApproval').mockResolvedValue()
    const record = vi.spyOn(core.attention, 'record').mockImplementation(() => undefined as never)
    // As a phone, a browser or the renderer could send it over the Api.
    const respond = core.api.respondApproval as (...args: unknown[]) => Promise<void>
    await respond('q', { kind: 'question', answers: {} }, 'outside', 'Claude Code')
    expect(record.mock.calls.at(-1)![0]).toMatchObject({ via: 'window' })
    expect(record.mock.calls.at(-1)![0]).not.toHaveProperty('by')
  })
})
