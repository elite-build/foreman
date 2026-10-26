// #2 Agent reports and "Teach agents Foreman": turn identity, `foreman report` / `review`,
// the report lifecycle on Home and in the chat, the run/send opt-in, the instructions,
// and that none of it writes a file into the worktree.
import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentDriver, TurnRequest } from '../src/main/agents/types'
import { AgentReportService, turnToken } from '../src/main/agentReports'
import { handleRequest, type CliHost } from '../src/main/cliServer'
import { git } from '../src/main/git'
import { agentBaseEnv } from '../src/main/platform'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import {
  answerReports,
  callerFromEnv,
  closeReport,
  isReportCall,
  missingPlanTemplates,
  openReports,
  PLAN_STEP_SLUG,
  PLAN_TEMPLATE,
  recordReport,
  reportLine,
  teachText,
  TURN_ENV,
  withReviewRequest,
  type AgentReport
} from '../src/shared/agentReports'
import { contextParts } from '../src/shared/context'
import { triageAll } from '../src/shared/triage'
import type { AgentKind } from '../src/shared/agents'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import type { ReportResult } from '../src/cli/protocol'
import { stubHost } from './cliHost'
import { makeRepo, tempDir } from './helpers'

afterEach(() => {
  for (const driver of [claudeDriver]) registerDriver(driver)
})

const KEY = 'test-key'

/** Chats with a real report service, a git worktree and a fake agent per test. */
async function rig(options: { teach?: boolean; mayStart?: boolean; cli?: boolean } = {}) {
  const root = await tempDir('foreman-reports-')
  const store = new Store(root)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'lisbon', branch: 'b', baseBranch: 'main', path: await makeRepo(), portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
  store.state.workspaces.push(ws)
  store.state.repos.push({ id: 'repo', name: 'ledger-api', rootPath: ws.path!, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' })
  const settings = { teachAgents: options.teach ?? false, agentsMayStart: options.mayStart ?? false, checksAfterTurn: false }
  const items: { sessionId: string; item: ChatItem }[] = []
  const reports = new AgentReportService({
    state: () => store.state,
    emit: (sessionId, item) => void items.push({ sessionId, item }),
    changed: () => undefined,
    settingsFor: () => settings,
    key: () => KEY,
    cliInstalled: () => options.cli ?? true
  })
  const workspaces = {
    workspace: () => ws,
    env: () => ({ FOREMAN_WORKSPACE_ID: ws.id }),
    settingsFor: () => ({ prompts: { general: '', renameBranch: '' }, sensitivePaths: [], ...settings }),
    agentContext: () => 'context',
    template: () => undefined
  }
  const sessions = new SessionService(
    store,
    { forAgent: (_agent: AgentKind, _repo: string, extra: Record<string, string>) => ({ ...extra }) } as never,
    workspaces as never,
    { changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {} },
    undefined,
    undefined,
    undefined,
    reports
  )
  const host: CliHost = stubHost({
    state: () => store.state,
    identifyCaller: (caller) => reports.identify(caller),
    recordReport: (input) => reports.record(input),
    agentsMayStart: (repoId) => reports.mayStart(repoId),
    deliver: (sessionId, text, options) => sessions.deliver(sessionId, text, options)
  })
  return { root, store, ws, sessions, reports, host, items, settings }
}

/** A fake agent of `kind` that records each turn's request and runs `script` before finishing. */
function agent(kind: AgentKind, script: (req: TurnRequest) => Promise<void> | void = () => undefined) {
  const requests: TurnRequest[] = []
  const driver: AgentDriver = {
    ...claudeDriver,
    kind,
    createTurn: (req, cb) => ({
      run: async () => {
        requests.push(req)
        await script(req)
        cb.finished({ ok: true })
      },
      stop: async () => undefined,
      steer: () => false,
      setPlanMode: async () => {},
      setModel: async () => {}
    })
  }
  registerDriver(driver)
  return { requests, restore: () => registerDriver(claudeDriver) }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const idle = (s: Session) => () => s.status === 'idle' && !s.turnId
const report = (patch: Partial<AgentReport>): AgentReport => ({ id: Math.random().toString(36).slice(2), kind: 'needs-input', text: 'Default to EUR?', at: '2026-10-22T10:00:00.000Z', workspaceId: 'ws', sessionId: 's1', turnId: 't1', via: 'cli', ...patch })
const triage = (store: Store) => triageAll({ snapshot: { workspaces: store.state.workspaces, sessions: store.state.sessions } as never, approvals: [], unread: {}, unreadSessions: {} }, null)[0]

describe('turn identity', () => {
  it.each(['claude', 'codex', 'cursor', 'opencode'] as AgentKind[])('every %s turn gets FOREMAN_SESSION_ID, FOREMAN_TURN_ID and a token made from them', async (kind) => {
    const r = await rig()
    const fake = agent(kind)
    const session = r.sessions.createSession(r.ws.id, { agent: kind })
    const receipt = await r.sessions.deliver(session.id, 'go')
    await until(idle(session))
    fake.restore()
    const env = fake.requests[0].env
    expect(env[TURN_ENV.session]).toBe(session.id)
    expect(env[TURN_ENV.turn]).toBe(receipt.turnId)
    expect(env[TURN_ENV.token]).toBe(turnToken(KEY, session.id, receipt.turnId!))
    // The workspace's own variables are still there.
    expect(env.FOREMAN_WORKSPACE_ID).toBe('ws')
  })

  it('a new turn gets a new token; a token only checks for its own session and turn', async () => {
    const r = await rig()
    const a = turnToken(KEY, 's1', 't1')
    expect(turnToken(KEY, 's1', 't2')).not.toBe(a)
    expect(turnToken('other-key', 's1', 't1')).not.toBe(a)
    expect(r.reports.identify({ sessionId: 's1', turnId: 't2', token: a })).toEqual({ kind: 'bad-token' })
    expect(r.reports.identify(undefined)).toBeNull()
    expect(r.reports.identify({ sessionId: 's1', turnId: 't1' })).toBeNull()
  })

  it('terminals and the snippet runner carry no turn token, even when Foreman was started from an agent shell', () => {
    const saved = { ...process.env }
    Object.assign(process.env, { FOREMAN_SESSION_ID: 'parent', FOREMAN_TURN_ID: 'parent-turn', FOREMAN_TURN_TOKEN: 'parent-token' })
    try {
      const env = agentBaseEnv()
      expect(env.FOREMAN_TURN_TOKEN).toBeUndefined()
      expect(env.FOREMAN_SESSION_ID).toBeUndefined()
      expect(env.FOREMAN_TURN_ID).toBeUndefined()
    } finally {
      for (const name of Object.values(TURN_ENV)) delete process.env[name]
      Object.assign(process.env, saved)
    }
  })

  it('the CLI reads its caller from the environment, and only with a token', () => {
    expect(callerFromEnv({ FOREMAN_SESSION_ID: 's', FOREMAN_TURN_ID: 't', FOREMAN_TURN_TOKEN: 'k' })).toEqual({ sessionId: 's', turnId: 't', token: 'k' })
    expect(callerFromEnv({ FOREMAN_SESSION_ID: 's', FOREMAN_TURN_ID: 't' })).toBeUndefined()
  })
})

describe('foreman report: attribution', () => {
  it('with a valid token it lands on the tab and turn, and a quiet marker goes in that chat', async () => {
    const r = await rig()
    let answer: unknown
    const fake = agent('codex', async (req) => {
      answer = await handleRequest(r.host, { method: 'report', params: { kind: 'checkpoint', text: 'migrated 3 of 5 tables', cwd: '/nowhere' }, caller: callerFromEnv(req.env) })
    })
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    const { turnId } = await r.sessions.deliver(session.id, 'go')
    await until(idle(session))
    fake.restore()
    expect(answer).toMatchObject({ ok: true, result: { attribution: 'turn', tab: 1, session: session.id, turn: turnId, workspace: { name: 'lisbon' } } })
    expect(r.ws.agentReports).toMatchObject([{ kind: 'checkpoint', sessionId: session.id, turnId, via: 'cli' }])
    expect(r.items).toMatchObject([{ sessionId: session.id, item: { kind: 'notice', turnId, text: 'agent says: checkpoint — migrated 3 of 5 tables', report: { kind: 'checkpoint' } } }])
    // A checkpoint is only a marker: Home doesn't change.
    expect(triage(r.store).bucket).not.toBe('attention')
  })

  it('without a token it counts for the workspace the command runs in, and says so', async () => {
    const r = await rig()
    const answer = await handleRequest(r.host, { method: 'report', params: { kind: 'stuck', text: 'Playwright browsers are missing', cwd: r.ws.path! } })
    expect(answer).toMatchObject({ ok: true, result: { attribution: 'workspace' } })
    const result = (answer as { result: ReportResult }).result
    expect(result.tab).toBeUndefined()
    expect(result.message).toContain('lisbon only')
    expect(result.message).toContain('no turn token')
    expect(r.ws.agentReports).toMatchObject([{ kind: 'stuck', via: 'cli' }])
    expect(r.ws.agentReports![0].sessionId).toBeUndefined()
    // No tab, so no chat to mark; Home still shows it, labelled.
    expect(r.items).toEqual([])
    expect(triage(r.store)).toMatchObject({ label: 'Stuck', tone: 'red', detail: 'agent says · workspace', says: true })
  })

  it('a token that doesn’t check is treated as no token, and labelled', async () => {
    const r = await rig()
    const answer = await handleRequest(r.host, { method: 'report', params: { kind: 'needs-input', text: 'Which region?', cwd: r.ws.path! }, caller: { sessionId: 'x', turnId: 'y', token: 'forged' } })
    expect(answer).toMatchObject({ ok: true, result: { attribution: 'workspace', message: expect.stringContaining('wasn’t recognised') } })
    expect(r.ws.agentReports![0]).toMatchObject({ badToken: true })
  })

  it('a report from a turn that has ended is history: "from an earlier turn", and it opens nothing', async () => {
    const r = await rig()
    const fake = agent('codex')
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    const { turnId } = await r.sessions.deliver(session.id, 'go')
    await until(idle(session))
    fake.restore()
    const caller = { sessionId: session.id, turnId, token: turnToken(KEY, session.id, turnId!) }
    const answer = await handleRequest(r.host, { method: 'report', params: { kind: 'needs-input', text: 'Still there?', cwd: '/' }, caller })
    expect(answer).toMatchObject({ ok: true, result: { attribution: 'turn', late: true, message: expect.stringContaining('earlier turn') } })
    expect(r.items.at(-1)!.item).toMatchObject({ text: 'agent says: needs input — Still there? (from an earlier turn)', report: { late: true } })
    expect(openReports(r.ws.agentReports)).toEqual([])
    expect(triage(r.store).label).not.toBe('Needs input')
  })

  it('refuses a made-up kind', async () => {
    const r = await rig()
    expect(await handleRequest(r.host, { method: 'report', params: { kind: 'panic' as never, text: 'x', cwd: r.ws.path! } })).toMatchObject({ ok: false, error: expect.stringContaining('isn’t a report') })
  })
})

describe('report lifecycle', () => {
  it('the same words from the same turn are a duplicate', () => {
    const first = recordReport([], report({}))
    const again = recordReport(first.list, report({}))
    expect(again.added).toBe(false)
    expect(again.list).toHaveLength(1)
    // A different turn may say the same thing.
    expect(recordReport(first.list, report({ turnId: 't2' })).added).toBe(true)
  })

  it('a later needs-input, stuck or done from the same tab supersedes; a checkpoint never clears a blocker', () => {
    let list = recordReport([], report({ kind: 'needs-input', text: 'EUR?' })).list
    list = recordReport(list, report({ kind: 'checkpoint', text: 'tables 4 of 5' })).list
    expect(openReports(list).map((r) => r.text)).toEqual(['EUR?'])
    list = recordReport(list, report({ kind: 'stuck', text: 'no credentials' })).list
    expect(openReports(list).map((r) => r.text)).toEqual(['no credentials'])
    expect(list.find((r) => r.text === 'EUR?')!.closed).toMatchObject({ how: 'superseded' })
    list = recordReport(list, report({ kind: 'done', text: 'finished' })).list
    expect(openReports(list)).toEqual([])
    // Another tab's blocker is its own.
    list = recordReport(list, report({ sessionId: 's2', text: 'other tab' })).list
    list = recordReport(list, report({ kind: 'done', text: 'first tab done again' })).list
    expect(openReports(list).map((r) => r.sessionId)).toEqual(['s2'])
  })

  it('a late report neither opens nor supersedes', () => {
    const list = recordReport([], report({ text: 'open one' })).list
    const late = recordReport(list, report({ kind: 'done', text: 'old news', late: true }))
    expect(openReports(late.list).map((r) => r.text)).toEqual(['open one'])
  })

  it('a reply in the tab answers its blockers (and those sent without a tab); dismissing goes to history', () => {
    let list = recordReport([], report({ text: 'tab one' })).list
    list = recordReport(list, report({ sessionId: undefined, turnId: undefined, kind: 'stuck', text: 'no tab' })).list
    list = recordReport(list, report({ sessionId: 's2', text: 'tab two' })).list
    const answered = answerReports(list, 's1', 'now')
    expect(answered.changed).toBe(true)
    expect(openReports(answered.list).map((r) => r.text)).toEqual(['tab two'])
    const dismissed = closeReport(answered.list, answered.list.find((r) => r.text === 'tab two')!.id, 'dismissed', 'now')
    expect(openReports(dismissed.list)).toEqual([])
    expect(dismissed.list).toHaveLength(3)
  })

  it('needs-input stays on Home after its turn ends, until the user replies in that tab', async () => {
    const r = await rig({ teach: true })
    const fake = agent('claude', (req) => {
      // Claude reports through Foreman's MCP tool (offered because the chat started with "Teach agents Foreman").
      expect(req.hostTools?.report).toBeTypeOf('function')
      if (req.prompt.startsWith('migrate')) req.hostTools!.report!('needs-input', 'Pre-2021 invoices have no currency. Default them to EUR?')
    })
    const session = r.sessions.createSession(r.ws.id, { agent: 'claude' })
    await r.sessions.deliver(session.id, 'migrate the money columns')
    await until(idle(session))
    expect(session.status).toBe('idle')
    const row = triage(r.store)
    expect(row).toMatchObject({ bucket: 'attention', label: 'Needs input', tone: 'amber', detail: 'agent says · Tab 1', says: true, sessionId: session.id })
    expect(row.summary).toBe('Tab 1: “Pre-2021 invoices have no currency. Default them to EUR?”')
    expect(row.facts?.[0]).toMatch(/^turn ended \d+m ago$/)
    expect(r.items.at(-1)!.item).toMatchObject({ report: { kind: 'needs-input', via: 'mcp' } })

    // Opening the tab or another turn's checkpoint doesn't clear it; the user's reply does.
    await r.sessions.deliver(session.id, 'Yes, EUR.')
    await until(idle(session))
    fake.restore()
    expect(openReports(r.ws.agentReports)).toEqual([])
    expect(r.ws.agentReports![0].closed).toMatchObject({ how: 'replied' })
    expect(triage(r.store).label).not.toBe('Needs input')
  })

  it('a `foreman send` from a script is not a reply', async () => {
    const r = await rig()
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    r.reports.record({ workspaceId: 'ws', sessionId: session.id, kind: 'stuck', text: 'blocked', via: 'cli' })
    r.reports.replied(session.id)
    expect(openReports(r.ws.agentReports)).toEqual([])
    r.reports.record({ workspaceId: 'ws', sessionId: session.id, kind: 'stuck', text: 'blocked again', via: 'cli' })
    const fake = agent('codex')
    await r.sessions.deliver(session.id, 'scripted', { via: 'cli' })
    await until(idle(session))
    fake.restore()
    expect(openReports(r.ws.agentReports).map((x) => x.text)).toEqual(['blocked again'])
  })
})

describe('foreman review', () => {
  it('adds a Home row "Worker asks for a review · Open…" and starts nothing', async () => {
    const r = await rig()
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    const deliver = vi.spyOn(r.sessions, 'deliver')
    const caller = { sessionId: session.id, turnId: 'old', token: turnToken(KEY, session.id, 'old') }
    session.turnId = 'old'
    const answer = await handleRequest(r.host, { method: 'report', params: { kind: 'review', text: 'Check the new retry timeout.', cwd: '/' }, caller })
    session.turnId = undefined
    expect(answer).toMatchObject({ ok: true, result: { message: expect.stringContaining('Nothing starts until they open it') } })
    expect(deliver).not.toHaveBeenCalled()
    expect(r.store.state.sessions).toHaveLength(1)
    const row = triage(r.store)
    expect(row).toMatchObject({ bucket: 'attention', label: 'Review requested', tone: 'accent', detail: 'Tab 1', action: { kind: 'open-review', label: 'Open…' }, reportText: 'Check the new retry timeout.', sessionId: session.id })
    expect(row.summary).toBe('Worker asks for a review: “Check the new retry timeout.”')
    // Open… fills in the Code review dialog with the request; once that review starts, the row goes to history.
    expect(withReviewRequest('Review the diff.', row.reportText)).toBe('Review the diff.\n\nThe agent that did this work asked for a review and says to check: Check the new retry timeout.')
    r.reports.close('ws', row.reportId!, 'opened')
    expect(triage(r.store).label).not.toBe('Review requested')
  })
})

describe('run and send from inside a turn', () => {
  async function tokened() {
    const r = await rig()
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    session.turnId = 't1'
    return { ...r, session, caller: { sessionId: session.id, turnId: 't1', token: turnToken(KEY, session.id, 't1') } }
  }

  it('are refused for calls carrying a turn token unless the repo opted in; the refusal names the setting', async () => {
    const r = await tokened()
    const run = await handleRequest(r.host, { method: 'run', params: { template: 'x', values: [], cwd: r.ws.path! }, caller: r.caller })
    expect(run).toMatchObject({ ok: false, error: expect.stringContaining('Let agents start workspaces and queue messages') })
    const send = await handleRequest(r.host, { method: 'send', params: { workspace: 'lisbon', args: ['hi'], cwd: '/' }, caller: r.caller })
    expect(send).toMatchObject({ ok: false, error: expect.stringContaining('Let agents start workspaces and queue messages') })
    // A made-up token is refused too.
    expect(await handleRequest(r.host, { method: 'send', params: { workspace: 'lisbon', args: ['hi'], cwd: '/' }, caller: { ...r.caller, token: 'nope' } })).toMatchObject({ ok: false })
  })

  it('go through once the repo allows it, and for calls without a token (cooperative, not a boundary)', async () => {
    const r = await tokened()
    const deliver = vi.fn(async () => ({ disposition: 'queued' as const, turnId: 'q1' }))
    const host = { ...r.host, deliver }
    expect(await handleRequest(host, { method: 'send', params: { workspace: 'lisbon', args: ['hi'], cwd: '/' } })).toMatchObject({ ok: true })
    r.settings.agentsMayStart = true
    expect(await handleRequest(host, { method: 'send', params: { workspace: 'lisbon', args: ['hi'], cwd: '/' }, caller: r.caller })).toMatchObject({ ok: true })
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('a dry run creates nothing, so it is allowed; a turn can’t wait for itself', async () => {
    const r = await tokened()
    const dry = await handleRequest(r.host, { method: 'run', params: { template: 'nope', values: [], cwd: r.ws.path!, dryRun: true }, caller: r.caller })
    expect(dry).toMatchObject({ ok: false, error: expect.not.stringContaining('Let agents') })
    expect(await handleRequest(r.host, { method: 'wait', params: { turn: 't1' }, caller: r.caller })).toMatchObject({ ok: false, error: expect.stringContaining('wait for itself') })
  })
})

describe('Teach agents Foreman: the instructions', () => {
  const caps = { cli: true, mayStart: false, checksAfterTurn: false }

  it('Claude gets the MCP tools; the others the CLI; only what works is listed', () => {
    const claude = teachText({ agent: 'claude', ...caps })
    expect(claude.via).toBe('tools')
    expect(claude.text).toContain('`report` tool')
    expect(claude.text).toContain('request_review')
    expect(claude.text).not.toContain('foreman report')
    const codex = teachText({ agent: 'codex', ...caps })
    expect(codex.via).toBe('cli')
    expect(codex.text).toContain('foreman report needs-input')
    expect(codex.text).toContain('foreman review')
    expect(codex.commands).toEqual(['report', 'review'])
    // run and send are left out, not marked "not allowed".
    for (const t of [claude, codex]) {
      expect(t.text).not.toContain('foreman run')
      expect(t.text).not.toContain('foreman send')
      expect(t.text).not.toMatch(/not allowed/i)
    }
  })

  it('run and send appear only with the opt-in and the command installed', () => {
    expect(teachText({ agent: 'codex', ...caps, mayStart: true }).commands).toEqual(['report', 'review', 'run', 'send'])
    expect(teachText({ agent: 'codex', ...caps, mayStart: true }).text).toContain('foreman run <template> "<task>" --base <branch>')
    expect(teachText({ agent: 'claude', ...caps, cli: false, mayStart: true }).commands).toEqual(['report', 'review'])
  })

  it('says checks run after the turn, never to call foreman checks mid-turn', () => {
    expect(teachText({ agent: 'opencode', ...caps, checksAfterTurn: true }).text).toContain('Foreman runs this repository\'s checks after your turn ends. Don\'t run `foreman checks` during your turn')
    expect(teachText({ agent: 'opencode', ...caps }).text).toContain('Don\'t run `foreman checks` during your turn')
    // Without the command there is nothing about it.
    expect(teachText({ agent: 'claude', ...caps, cli: false }).text).not.toContain('foreman checks')
  })

  it('an agent without Foreman tools gets nothing when the command isn’t installed', () => {
    expect(teachText({ agent: 'codex', ...caps, cli: false })).toEqual({ text: '', commands: [], via: 'none' })
  })

  it('goes into the system prompt and the receipt, only for chats started with it on', async () => {
    const r = await rig({ teach: true })
    const fake = agent('codex')
    const session = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    await r.sessions.deliver(session.id, 'go')
    await until(idle(session))
    expect(session.foremanTaught).toBe(true)
    expect(fake.requests[0].systemPromptAppend).toContain('# Working in Foreman')
    expect(fake.requests[0].systemPromptAppend.startsWith('context')).toBe(true)
    // Turning it off later doesn't change a running chat; a new chat starts without it.
    r.settings.teachAgents = false
    await r.sessions.deliver(session.id, 'more')
    await until(() => fake.requests.length === 2 && idle(session)())
    expect(fake.requests[1].systemPromptAppend).toContain('# Working in Foreman')
    const fresh = r.sessions.createSession(r.ws.id, { agent: 'codex' })
    await r.sessions.deliver(fresh.id, 'go')
    await until(() => fake.requests.length === 3 && idle(fresh)())
    fake.restore()
    expect(fake.requests[2].systemPromptAppend).not.toContain('Working in Foreman')
    // Claude's MCP tools come with it, and only with it.
    expect(fake.requests[2].hostTools?.report).toBeUndefined()
  })

  it('the receipt names the instructions, their size and what they list', () => {
    const text = teachText({ agent: 'codex', ...caps }).text
    const parts = contextParts({ instructions: 'context', hasStanding: false, noteText: '', commentsText: '', comments: [], attachmentText: '', attachments: [], foremanText: text, foremanCommands: ['report', 'review'] })
    expect(parts.find((p) => p.kind === 'foreman')).toMatchObject({ label: 'Foreman instructions', unit: 'bytes', size: Buffer.byteLength(text), source: 'Repository setting “Teach agents Foreman”', detail: 'report, review' })
  })

  it('"Plan the work" ends with runnable foreman run … --base … snippets and adds its step template once', () => {
    expect(PLAN_TEMPLATE.body).toContain('```sh')
    expect(PLAN_TEMPLATE.body).toMatch(new RegExp(`foreman run ${PLAN_STEP_SLUG} ".*" --base `))
    expect(PLAN_TEMPLATE.body).toContain('Don\'t run these commands yourself')
    expect(missingPlanTemplates([]).map((t) => t.name)).toEqual(['Plan the work', 'Work on a task'])
    expect(missingPlanTemplates(missingPlanTemplates([]))).toEqual([])
  })
})

describe('in the chat', () => {
  it('report lines read as the agent’s words', () => {
    expect(reportLine({ kind: 'checkpoint', text: 'migrated 3 of 5 tables' })).toBe('agent says: checkpoint — migrated 3 of 5 tables')
    expect(reportLine({ kind: 'review', text: 'retry timeout' })).toBe('agent says: asks for a review — retry timeout')
  })

  it('folds the call that made a report into its marker, but not a failed or compound one', () => {
    expect(isReportCall({ name: 'mcp__foreman__report', input: {}, status: 'done' })).toBe(true)
    expect(isReportCall({ name: 'Bash', input: { command: 'foreman report checkpoint "3 of 5"' }, status: 'done' })).toBe(true)
    expect(isReportCall({ name: 'Bash', input: { command: 'foreman report done "x" && rm -rf build' }, status: 'done' })).toBe(false)
    expect(isReportCall({ name: 'Bash', input: { command: 'foreman report stuck "x"' }, status: 'error' })).toBe(false)
  })
})

describe('nothing is written into the repository', () => {
  it('a taught chat that reports, asks for a review and is answered leaves the worktree exactly as it was', async () => {
    const r = await rig({ teach: true })
    const before = (await readdir(r.ws.path!)).sort()
    const fake = agent('claude', async (req) => {
      req.hostTools!.report!('needs-input', 'EUR?')
      req.hostTools!.report!('review', 'retry timeout')
      await handleRequest(r.host, { method: 'report', params: { kind: 'checkpoint', text: 'half way', cwd: req.cwd }, caller: callerFromEnv(req.env) })
    })
    const session = r.sessions.createSession(r.ws.id, { agent: 'claude' })
    await r.sessions.deliver(session.id, 'go')
    await until(idle(session))
    await r.sessions.deliver(session.id, 'EUR, yes')
    await until(idle(session))
    fake.restore()
    expect(r.ws.agentReports!.length).toBeGreaterThanOrEqual(3)
    expect((await readdir(r.ws.path!)).sort()).toEqual(before)
    const status = await git(r.ws.path!, ['status', '--porcelain', '--untracked-files=all', '--ignored'])
    expect(status.stdout.trim()).toBe('')
  })
})
