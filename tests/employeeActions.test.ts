// An AI employee's outward actions (docs/ai-employees.md §9): every class (a Slack post, a Linear change, a push, a pull
// request) under every rule (allowed sends once with its result recorded; held waits for Send, Edit then send or Skip;
// never refuses), each recorded before anything is sent; sending is idempotent (a double Send, a restart while sending);
// a missing or changed connection refuses and nothing falls back to another account; request_push and
// request_pull_request need Write access; a held push or pull request keeps its run's workspace until it is sent or
// skipped; the task's log and its next continuation say what became of each. Against a real foreman.db with stand-in
// senders (the bridge and Foreman's push and pull request code are tested on their own).
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForemanDb } from '../src/main/db'
import { Environment } from '../src/main/environment'
import { git, gitOut } from '../src/main/git'
import { GitActions } from '../src/main/gitActions'
import { PrCache } from '../src/main/prCache'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { EmployeeActionService, type ActionSenders, type BranchPreview, type ScmGate } from '../src/main/employeeActions'
import { EmployeeTools } from '../src/main/employeeTools'
import { EmployeeWorkService, type EmployeeWorkHost } from '../src/main/employeeWork'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { staticCapabilities } from '../src/shared/agentCatalog'
import { actionPolicy, applyEdits, newsText, type EmployeeAction, type SlackPostPayload } from '../src/shared/employeeActions'
import { continuationMessage, employeeActivity, type EmployeeRun } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeActionPolicy, type EmployeeDefinition, type EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { ChatItem, Repo, Session, Workspace } from '../src/shared/types'
import { commit, makeRepo, tempDir } from './helpers'

const opened: ForemanDb[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
  vi.restoreAllMocks()
})

function definition(actions: Record<string, EmployeeActionPolicy>, repos: Record<string, 'read' | 'write'> = { site: 'write' }): EmployeeDefinition {
  const d = defaultEmployee({ id: 'e-max1', colour: 'orange', repos: [], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max', role: 'Marketing', instructions: 'Work.' } })
  return { ...d, access: { ...d.access, repos, actions: { ...d.access.actions, ...actions } }, limits: { runs_per_day: 100, minutes_per_run: 240 } }
}

const PREVIEW: BranchPreview = { branch: 'max/launch', base: 'main', head: 'abc123', ahead: 2, commits: [{ sha: 'abc123', subject: 'Write the launch post' }, { sha: 'def456', subject: 'Fix a typo' }], diffStat: { files: 1, insertions: 40, deletions: 2 } }

async function rig(options: { actions?: Record<string, EmployeeActionPolicy>; repos?: Record<string, 'read' | 'write'>; db?: ForemanDb } = {}) {
  const db = options.db ?? new ForemanDb(path.join(await tempDir('foreman-employee-actions-'), 'foreman.db'))
  opened.push(db)
  const repo = (id: string, name: string) => ({ id, name, rootPath: `/code/${name}`, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' }) as unknown as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-01T00:00:00.000Z' }
  const state = { repos: [repo('mem', 'acme-memory'), repo('site', 'site')], organizations: [org], settings: defaultSettings(), sessions: [], workspaces: [] } as unknown as PersistedState
  const def = { current: definition(options.actions ?? {}, options.repos) }
  const summary: { patch: Partial<EmployeeSummary> } = { patch: {} }
  const sessions = new Map<string, Session>()
  const chats = new Map<string, ChatItem[]>()
  const archived: string[] = []
  const launches: { message: string }[] = []
  const clock = { now: Date.parse('2026-11-13T10:00:00.000Z') }
  const host: EmployeeWorkHost = {
    state: () => state,
    db: () => db,
    employees: {
      current: async () => ({ summary: { id: 'e-max1', path: 'bots/e-max1.toml', name: 'Max', role: 'Marketing', colour: 'orange', responsibilities: [], problems: [], state: 'active', changed: false, ...summary.patch }, definition: def.current, head: 'h1' }),
      runEnded: () => undefined
    },
    memory: {
      status: async () => ({ state: 'ok', head: 'h1' }),
      read: async (_o, file) => ({ path: file, head: 'h1', blob: null, size: 0, binary: false, tooLarge: false }),
      writeRecap: async () => undefined,
      commitRun: async () => ({ commit: null }),
      stagedChanges: () => [],
      runWrittenPaths: () => new Set<string>(),
      proposals: () => [],
      keepProposal: async () => ({ ok: true as const, commit: null }),
      retireProposal: async () => undefined
    },
    report: () => 'report-1',
    capabilities: (agent) => staticCapabilities(agent),
    persona: () => undefined,
    launch: async (plan, handle) => {
      launches.push({ message: plan.message })
      handle.created(`ws-${plan.run.id}`, `s-${plan.run.id}`)
    },
    stop: async () => undefined,
    turnStart: () => undefined,
    readChat: async (sessionId) => chats.get(sessionId) ?? [],
    session: (id) => sessions.get(id),
    afterRun: (run) => void archived.push(run.workspaceId!),
    changed: () => undefined,
    now: () => clock.now
  }
  const work = new EmployeeWorkService(host)
  // Each sender checks the action was recorded on its way before it is asked: recorded before sent.
  const seen: { kind: string; state?: string }[] = []
  const stateNow = () => db.employeeActions({ states: ['approved'] }).map((a) => a.state)[0]
  const send = {
    slack: vi.fn<ActionSenders['slack']>(async () => (seen.push({ kind: 'slack', state: stateNow() }), { link: 'https://acme.slack.com/archives/C1/p12', detail: 'Posted to C1 (1.2).' })),
    linear: vi.fn<ActionSenders['linear']>(async () => (seen.push({ kind: 'linear', state: stateNow() }), { detail: 'Comment added', link: 'https://linear.app/acme/issue/ENG-1' })),
    push: vi.fn<ActionSenders['push']>(async () => (seen.push({ kind: 'push', state: stateNow() }), { detail: 'Pushed max/launch.' })),
    pullRequest: vi.fn<ActionSenders['pullRequest']>(async () => (seen.push({ kind: 'pr', state: stateNow() }), { link: 'https://github.com/acme/site/pull/7', detail: 'Opened #7 as a draft.' }))
  }
  const gate = { connection: { connectionId: 'gh-acme', name: 'Acme GitHub' } as Awaited<ReturnType<ScmGate['connection']>> }
  const scm = { connection: vi.fn<ScmGate['connection']>(async () => gate.connection), prepare: vi.fn<ScmGate['prepare']>(async () => PREVIEW) }
  const make = () =>
    new EmployeeActionService({ state: () => state, db: () => db, work, employees: host.employees, session: (id) => sessions.get(id), send, scm, now: () => clock.now })
  const actions = make()
  const tools = new EmployeeTools({ work, memory: { search: async () => [], read: async () => ({ path: '', head: 'h1', blob: null, size: 0, binary: false, tooLarge: false }), stage: async () => ({ ok: true, blob: 'b' }), propose: async () => ({ ok: true, id: 'p' }) } as never, employees: host.employees, actions })
  return { db, state, work, actions, make, tools, send, scm, gate, def, summary, sessions, chats, archived, launches, seen, clock }
}

type Rig = Awaited<ReturnType<typeof rig>>
const settle = () => new Promise((r) => setTimeout(r, 25))

/** A person asks Max; its run's turn starts (the chat marked as the run's, as sessions.ts does). */
async function begin(r: Rig): Promise<EmployeeRun> {
  const task = await r.work.ask('o1', 'e-max1', { body: 'Ship the launch post' })
  await settle()
  const run = r.db.employeeRuns({ taskId: task.id })[0]
  const turnId = `turn-${run.id}`
  r.sessions.set(run.sessionId!, { id: run.sessionId!, workspaceId: run.workspaceId!, agent: 'claude', status: 'running', turnId, unattended: { employeeRunId: run.id, employeeId: run.employeeId, orgId: run.orgId, persona: { mcp: [] } } } as unknown as Session)
  r.work.turnStarted(run.sessionId!, turnId)
  return r.db.employeeRun(run.id)!
}

async function end(r: Rig, run: EmployeeRun): Promise<void> {
  const turnId = `turn-${run.id}`
  r.chats.set(run.sessionId!, [
    { kind: 'assistant', id: `a-${turnId}`, turnId, text: 'Done.' },
    { kind: 'turn-end', id: `end-${turnId}`, turnId, outcome: 'completed' }
  ])
  await r.work.turnEnded(run.sessionId!, turnId, 'completed')
  await settle()
}

const slackCall = (run: EmployeeRun, text = 'We shipped 1.1') => ({ sessionId: run.sessionId!, repoId: 'site', service: 'slack' as const, connectionId: 'slack-acme', connectionName: 'Acme Slack', tool: 'slack_post', args: { channel: 'C1', text }, channelName: 'launches' })
const linearCall = (run: EmployeeRun) => ({ sessionId: run.sessionId!, repoId: 'site', service: 'linear' as const, connectionId: 'lin-acme', connectionName: 'Acme Linear', tool: 'save_comment', args: { issueId: 'ENG-1', body: 'Shipped in 1.1' } })
const only = (r: Rig): EmployeeAction => {
  const all = r.db.employeeActions()
  expect(all).toHaveLength(1)
  return all[0]
}
const log = (r: Rig, taskId: string) => r.db.employeeTaskTransitions(taskId).filter((t) => t.event.startsWith('action-')).map((t) => t.event)

describe('outward actions: the rule for each class', () => {
  it('reads held for a class the definition doesn’t list, and holds a pull request to the stricter push rule', () => {
    expect(actionPolicy({ access: { actions: {} } } as never, 'slack-post')).toBe('held')
    expect(actionPolicy({ access: { actions: { 'pull-request': 'allowed', push: 'never' } } } as never, 'pull-request')).toBe('never')
    expect(actionPolicy({ access: { actions: { 'pull-request': 'allowed', push: 'held' } } } as never, 'pull-request')).toBe('held')
    expect(actionPolicy({ access: { actions: { 'pull-request': 'allowed', push: 'allowed' } } } as never, 'pull-request')).toBe('allowed')
  })

  it('lets a person edit the words only, never where it goes', () => {
    const p: SlackPostPayload = { kind: 'slack-post', connectionId: 'c', connection: 'Acme', channel: 'C1', text: 'Hi' }
    expect(applyEdits(p, { text: 'Hello' })).toMatchObject({ channel: 'C1', text: 'Hello' })
    expect(() => applyEdits(p, { channel: 'C2' })).toThrow(/can’t be edited/)
    expect(() => applyEdits(p, { text: ' ' })).toThrow(/can’t be empty/)
    expect(applyEdits({ kind: 'linear', connection: 'L', tool: 'save_issue', args: { id: 'ENG-1', title: 'Old', teamId: 't' } }, { title: 'New' })).toMatchObject({ args: { id: 'ENG-1', title: 'New', teamId: 't' } })
    expect(() => applyEdits({ kind: 'linear', connection: 'L', tool: 'save_issue', args: { id: 'ENG-1', title: 'Old' } }, { id: 'ENG-2' })).toThrow(/can’t be edited/)
  })
})

describe('outward actions: Slack and Linear through the bridge', () => {
  it('allowed: recorded on its way first, sent once, the result recorded and told', async () => {
    const r = await rig({ actions: { 'slack-post': 'allowed' } })
    const run = await begin(r)
    const out = await r.actions.bridgeCall(slackCall(run))
    expect(out.isError).toBeUndefined()
    expect(out.text).toMatch(/^Sent: a Slack post to #launches: “We shipped 1.1” \(https:\/\/acme\.slack\.com\/archives\/C1\/p12\)/)
    expect(r.send.slack).toHaveBeenCalledTimes(1)
    expect(r.send.slack).toHaveBeenCalledWith({ repoId: 'site', connectionId: 'slack-acme', channel: 'C1', text: 'We shipped 1.1' })
    // The sender saw it recorded as on its way before it was asked.
    expect(r.seen).toEqual([{ kind: 'slack', state: 'approved' }])
    const a = only(r)
    expect(a).toMatchObject({ kind: 'slack-post', state: 'sent', policy: 'allowed', decidedBy: 'definition', result: { link: 'https://acme.slack.com/archives/C1/p12' }, payload: { channel: 'C1', channelName: 'launches', connectionId: 'slack-acme', text: 'We shipped 1.1' } })
    // No secret is kept: only the connection's id and name.
    expect(JSON.stringify(a)).not.toMatch(/xox[bp]-/)
    expect(log(r, run.taskId)).toEqual(['action-approved', 'action-sent'])
    // The same post again in the run finds the first; nothing is sent twice.
    expect((await r.actions.bridgeCall(slackCall(run))).text).toMatch(/Already recorded as action .* it was sent/)
    expect(r.send.slack).toHaveBeenCalledTimes(1)
    // Decided for the person (§6.6): listed with what went out without asking.
    expect(r.work.views().o1.decided?.map((x) => x.id)).toEqual([a.id])
  })

  it('held: waits in Needs you, then Send sends it once, as the person', async () => {
    const r = await rig()
    const run = await begin(r)
    const out = await r.actions.bridgeCall(slackCall(run))
    expect(out.text).toMatch(/^Held for the person: a Slack post to #launches: “We shipped 1.1” is recorded \(action .*\) and will be sent only if they approve it/)
    expect(out.isError).toBeUndefined()
    expect(r.send.slack).not.toHaveBeenCalled()
    const held = only(r)
    expect(held).toMatchObject({ state: 'held', policy: 'held' })
    const view = r.work.views().o1
    expect(view.actions?.map((x) => x.id)).toEqual([held.id])
    expect(view.decided).toEqual([])
    expect(employeeActivity(view, 'e-max1').needsYou).toBe(1)
    const sent = await r.actions.send(held.id)
    expect(sent).toMatchObject({ state: 'sent', decidedBy: 'person', result: { link: 'https://acme.slack.com/archives/C1/p12' } })
    expect(r.send.slack).toHaveBeenCalledTimes(1)
    expect(r.seen).toEqual([{ kind: 'slack', state: 'approved' }])
    expect(log(r, run.taskId)).toEqual(['action-held', 'action-approved', 'action-sent'])
    expect(r.work.views().o1.actions).toEqual([])
    // Send again on a sent one does nothing.
    await r.actions.send(held.id)
    expect(r.send.slack).toHaveBeenCalledTimes(1)
  })

  it('held: Edit then send changes the words, never the channel, and records the edit', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run))
    const held = only(r)
    await expect(r.actions.send(held.id, { edits: { channel: 'C2' } })).rejects.toThrow(/can’t be edited/)
    expect(r.send.slack).not.toHaveBeenCalled()
    const sent = await r.actions.send(held.id, { edits: { text: 'We shipped 1.1 today' } })
    expect(sent).toMatchObject({ state: 'sent', edited: true, payload: { channel: 'C1', text: 'We shipped 1.1 today' } })
    expect(r.send.slack).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', text: 'We shipped 1.1 today' }))
  })

  it('held: Skip sends nothing, and the task’s log says so', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(linearCall(run))
    const held = only(r)
    expect(held).toMatchObject({ kind: 'linear', state: 'held', payload: { tool: 'save_comment', issue: 'ENG-1', connectionId: 'lin-acme' } })
    expect(r.actions.skip(held.id)).toMatchObject({ state: 'skipped', reason: 'Skipped by you.' })
    expect(r.send.linear).not.toHaveBeenCalled()
    expect(log(r, run.taskId)).toEqual(['action-held', 'action-skipped'])
    await expect(r.actions.send(held.id)).rejects.toThrow(/skipped/)
    expect(r.send.linear).not.toHaveBeenCalled()
  })

  it('never: refused with a reason the model reads, recorded, nothing sent', async () => {
    const r = await rig({ actions: { 'slack-post': 'never', linear: 'never' } })
    const run = await begin(r)
    const slack = await r.actions.bridgeCall(slackCall(run))
    expect(slack).toEqual({ text: expect.stringMatching(/^Refused: your definition never allows Slack messages/), isError: true })
    const linear = await r.actions.bridgeCall(linearCall(run))
    expect(linear.text).toMatch(/never allows Linear changes/)
    expect(r.send.slack).not.toHaveBeenCalled()
    expect(r.send.linear).not.toHaveBeenCalled()
    expect(r.db.employeeActions().map((a) => a.state)).toEqual(['refused', 'refused'])
    expect(r.work.views().o1.actions).toEqual([])
    expect(() => r.actions.skip(r.db.employeeActions()[0].id)).toThrow(/refused/)
  })

  it('allowed Linear: sent once through the Linear sender, as the recorded connection', async () => {
    const r = await rig({ actions: { linear: 'allowed' } })
    const run = await begin(r)
    expect((await r.actions.bridgeCall(linearCall(run))).text).toMatch(/^Sent: the Linear change save_comment on ENG-1 \(https:\/\/linear\.app\/acme\/issue\/ENG-1\)/)
    expect(r.send.linear).toHaveBeenCalledWith({ repoId: 'site', connectionId: 'lin-acme', tool: 'save_comment', args: { issueId: 'ENG-1', body: 'Shipped in 1.1' } })
    expect(only(r)).toMatchObject({ state: 'sent', result: { detail: 'Comment added' } })
  })

  it('a send the service refuses (a changed connection, say) fails, recorded, and a person can send it again', async () => {
    const r = await rig({ actions: { 'slack-post': 'allowed' } })
    const run = await begin(r)
    r.send.slack.mockRejectedValueOnce(new Error('Slack changed for this repository since this was recorded, so Foreman didn’t send it with any other account.'))
    const out = await r.actions.bridgeCall(slackCall(run))
    expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/^Not sent: Slack changed for this repository/) })
    const failed = only(r)
    expect(failed.state).toBe('failed')
    expect(r.work.views().o1.actions?.map((a) => a.id)).toEqual([failed.id])
    expect(await r.actions.send(failed.id)).toMatchObject({ state: 'sent', decidedBy: 'person' })
    expect(r.send.slack).toHaveBeenCalledTimes(2)
  })

  it('refuses an employee whose definition changed since approval, recording nothing', async () => {
    const r = await rig({ actions: { 'slack-post': 'allowed' } })
    const run = await begin(r)
    r.summary.patch = { changed: true }
    expect((await r.actions.bridgeCall(slackCall(run))).text).toMatch(/definition changed since this run was approved/)
    expect(r.db.employeeActions()).toEqual([])
    expect(r.send.slack).not.toHaveBeenCalled()
  })

  it('refuses a chat whose run has ended rather than letting its call through', async () => {
    const r = await rig({ actions: { 'slack-post': 'allowed' } })
    const run = await begin(r)
    await end(r, run)
    expect(r.actions.brokers(run.sessionId!)).toBe(true)
    expect(r.actions.brokers('someone-else')).toBe(false)
    expect((await r.actions.bridgeCall(slackCall(run))).text).toMatch(/run has ended/)
    expect(r.send.slack).not.toHaveBeenCalled()
  })
})

describe('outward actions: idempotent sending', () => {
  it('a double Send sends once: the second finds it on its way', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run))
    const held = only(r)
    let release!: () => void
    r.send.slack.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ detail: 'Posted.' }))))
    const first = r.actions.send(held.id)
    const second = await r.actions.send(held.id)
    expect(second.state).toBe('approved')
    release()
    expect((await first).state).toBe('sent')
    expect(r.send.slack).toHaveBeenCalledTimes(1)
  })

  it('Foreman closing mid-send leaves it uncertain for a person to check, never resent by itself', async () => {
    const r = await rig({ actions: { 'pull-request': 'allowed', push: 'allowed' } })
    const run = await begin(r)
    r.send.pullRequest.mockImplementationOnce(() => new Promise(() => undefined))
    void r.tools.call(run.sessionId!, 'request_pull_request', { title: 'Launch post', body: 'Adds the post.' })
    await settle()
    expect(only(r).state).toBe('approved')
    // Foreman starts again: a new service over the same foreman.db.
    const after = r.make()
    after.recover()
    const uncertain = only(r)
    expect(uncertain).toMatchObject({ state: 'uncertain', reason: expect.stringMatching(/Foreman closed while sending this/) })
    expect(r.work.views().o1.actions?.map((a) => a.state)).toEqual(['uncertain'])
    expect(log(r, run.taskId)).toEqual(['action-approved', 'action-uncertain'])
    await expect(after.send(uncertain.id)).rejects.toThrow(/Check first/)
    expect(r.send.pullRequest).toHaveBeenCalledTimes(1)
    // The person checked: it arrived. Recorded as sent, nothing sent again.
    expect(after.confirmArrived(uncertain.id)).toMatchObject({ state: 'sent', result: { detail: 'A person checked that it arrived.' } })
    expect(r.send.pullRequest).toHaveBeenCalledTimes(1)
  })

  it('an uncertain one is sent again only once the person says it didn’t arrive', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run))
    const held = only(r)
    r.send.slack.mockRejectedValueOnce(Object.assign(new Error('Slack didn’t answer'), { uncertain: true }))
    await expect(r.actions.send(held.id)).rejects.toThrow(/may have been sent/)
    expect(only(r).state).toBe('uncertain')
    expect((await r.actions.send(held.id, { checked: true })).state).toBe('sent')
    expect(r.send.slack).toHaveBeenCalledTimes(2)
  })
})

describe('outward actions: request_push and request_pull_request', () => {
  it('refuses a run without Write access, recording and sending nothing', async () => {
    const r = await rig({ repos: { site: 'read' }, actions: { push: 'allowed', 'pull-request': 'allowed' } })
    const run = await begin(r)
    expect(run.access).toBe('read')
    for (const [tool, args] of [['request_push', {}], ['request_pull_request', { title: 'T', body: '' }]] as const) {
      const out = await r.tools.call(run.sessionId!, tool, args)
      expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/has no Write access to site/) })
    }
    expect(r.scm.prepare).not.toHaveBeenCalled()
    expect(r.db.employeeActions()).toEqual([])
    expect(r.send.push).not.toHaveBeenCalled()
  })

  it('allowed push: commits what changed as the employee, pushes once, records the result', async () => {
    const r = await rig({ actions: { push: 'allowed' } })
    const run = await begin(r)
    const out = await r.tools.call(run.sessionId!, 'request_push', { commit_message: 'Write the launch post' })
    expect(out.text).toMatch(/^Sent: a push of max\/launch \(2 commits ahead of main\)/)
    expect(r.scm.prepare).toHaveBeenCalledWith(run.workspaceId, { commit: { message: 'Write the launch post', author: { name: 'Max (AI employee)', email: 'e-max1@employees.foreman.localhost' } } })
    expect(r.send.push).toHaveBeenCalledWith({ repoId: 'site', workspaceId: run.workspaceId, connectionId: 'gh-acme', branch: 'max/launch', head: 'abc123' })
    expect(r.seen).toEqual([{ kind: 'push', state: 'approved' }])
    expect(only(r)).toMatchObject({ kind: 'push', state: 'sent', payload: { branch: 'max/launch', base: 'main', ahead: 2, connection: 'Acme GitHub' } })
  })

  it('held pull request: keeps the run’s workspace until it is sent, then lets it go', async () => {
    const r = await rig()
    const run = await begin(r)
    const out = await r.tools.call(run.sessionId!, 'request_pull_request', { title: 'Launch post', body: 'Adds the post.', base: 'release' })
    expect(out.text).toMatch(/^Held for the person: the pull request “Launch post” \(main ← max\/launch\)/)
    expect(r.scm.prepare).toHaveBeenCalledWith(run.workspaceId, expect.objectContaining({ base: 'release' }))
    const held = only(r)
    expect(held.payload).toMatchObject({ kind: 'pull-request', title: 'Launch post', body: 'Adds the post.', diffStat: { files: 1, insertions: 40, deletions: 2 }, commits: PREVIEW.commits })
    await r.work.finishTask(run.sessionId!, { status: 'done', summary: 'Drafted; the PR waits for approval.' })
    await end(r, run)
    expect(r.db.employeeRun(run.id)?.state).toBe('completed')
    expect(r.archived).toEqual([])
    const sent = await r.actions.send(held.id, { edits: { title: 'Launch post for 1.1' } })
    expect(sent).toMatchObject({ state: 'sent', result: { link: 'https://github.com/acme/site/pull/7' } })
    expect(r.send.pullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: 'Launch post for 1.1', base: 'main', branch: 'max/launch', connectionId: 'gh-acme' }))
    expect(r.archived).toEqual([run.workspaceId])
  })

  it('held push skipped: nothing pushed, and the workspace goes', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.tools.call(run.sessionId!, 'request_push', {})
    await end(r, run)
    expect(r.archived).toEqual([])
    r.actions.skip(only(r).id)
    expect(r.send.push).not.toHaveBeenCalled()
    expect(r.archived).toEqual([run.workspaceId])
  })

  it('never: a pull request is refused when pushes are never allowed, before anything is committed', async () => {
    const r = await rig({ actions: { 'pull-request': 'allowed', push: 'never' } })
    const run = await begin(r)
    const out = await r.tools.call(run.sessionId!, 'request_pull_request', { title: 'Launch post', body: '' })
    expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/never allows pull requests/) })
    expect(r.scm.prepare).not.toHaveBeenCalled()
    expect(only(r).state).toBe('refused')
    expect(r.send.pullRequest).not.toHaveBeenCalled()
  })

  it('a missing connection refuses, with no fallback to another account and nothing recorded', async () => {
    const r = await rig({ actions: { push: 'allowed' } })
    const run = await begin(r)
    r.gate.connection = { refused: 'This repository’s GitHub connection “Acme GitHub” can’t be used: its token is missing.' }
    const out = await r.tools.call(run.sessionId!, 'request_push', {})
    expect(out).toMatchObject({ isError: true, text: expect.stringMatching(/token is missing\. Foreman didn’t push with any other account\./) })
    expect(r.scm.prepare).not.toHaveBeenCalled()
    expect(r.send.push).not.toHaveBeenCalled()
    expect(r.db.employeeActions()).toEqual([])
  })

  it('nothing ahead of the base: refused, nothing recorded', async () => {
    const r = await rig({ actions: { push: 'allowed' } })
    const run = await begin(r)
    r.scm.prepare.mockResolvedValueOnce({ ...PREVIEW, ahead: 0, commits: [] })
    expect((await r.tools.call(run.sessionId!, 'request_push', {})).text).toMatch(/nothing to push/)
    expect(r.db.employeeActions()).toEqual([])
  })
})

describe('outward actions: a held push and the repository’s remote now', () => {
  /**
   * Foreman's own push (GitActions, as Core sends a push) for a real repository registered while it had no remote, and
   * the run's workspace as a worktree on its branch with a commit to push. `remote` adds a bare origin afterwards.
   */
  async function local(r: Rig, run: EmployeeRun, options: { remote: boolean }) {
    const dataDir = await tempDir('foreman-employee-push-data-')
    const store = new Store(dataDir)
    await store.load()
    stores.push(store)
    const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const environment = new Environment(secrets, () => store.state.settings, (id) => workspaces.repo(id))
    const changed = vi.fn()
    const workspaces: WorkspaceService = new WorkspaceService(store, { changed, setupLog() {} }, environment)
    const root = await makeRepo()
    const repo = await workspaces.addRepo(root)
    expect(repo.hasOrigin).toBe(false)
    const dir = path.join(await tempDir('foreman-employee-push-ws-'), 'launch')
    await git(root, ['worktree', 'add', '-q', '-b', 'max/launch', dir])
    await commit(dir, 'Write the launch post')
    const ws: Workspace = { id: run.workspaceId!, repoId: repo.id, name: 'launch', branch: 'max/launch', baseBranch: 'main', path: dir, portBase: 50000, state: 'ready', createdAt: '2026-11-13T10:00:00.000Z' }
    store.state.workspaces.push(ws)
    let bare: string | undefined
    if (options.remote) {
      bare = await tempDir('foreman-employee-push-remote-')
      await git(bare, ['init', '-q', '--bare', '-b', 'main'])
      await git(root, ['remote', 'add', 'origin', bare])
    }
    const actions = new GitActions(store, workspaces, {} as never, async () => undefined, new PrCache())
    r.send.push.mockImplementation(async ({ workspaceId, branch }) => {
      await actions.pushBranch(workspaceId)
      return { detail: `Pushed ${branch}.` }
    })
    return { store, workspaces, repo, bare, changed }
  }

  it('sends a held push when a remote was added after the repository, and records that the repository has one', async () => {
    const r = await rig()
    const run = await begin(r)
    const m = await local(r, run, { remote: true })
    await r.tools.call(run.sessionId!, 'request_push', {})
    const held = only(r)
    expect(held.state).toBe('held')
    // The record still says no remote; the push asks git, finds origin and goes ahead.
    expect(m.store.state.repos[0].hasOrigin).toBe(false)
    expect(await r.actions.send(held.id)).toMatchObject({ state: 'sent', decidedBy: 'person', result: { detail: 'Pushed max/launch.' } })
    expect((await gitOut(m.bare!, ['log', '-1', '--format=%s', 'max/launch'])).trim()).toBe('Write the launch post')
    // Saved for the rest of the app (the Git panel, the PR watch), and the window told.
    expect(m.workspaces.repo(m.repo.id).hasOrigin).toBe(true)
    expect(m.changed).toHaveBeenCalled()
  })

  it('refuses a held push as before when there still is no remote', async () => {
    const r = await rig()
    const run = await begin(r)
    const m = await local(r, run, { remote: false })
    await r.tools.call(run.sessionId!, 'request_push', {})
    await expect(r.actions.send(only(r).id)).rejects.toThrow('Not sent: This repository has no remote, so there is nowhere to push.')
    expect(only(r).state).toBe('failed')
    expect(m.workspaces.repo(m.repo.id).hasOrigin).toBe(false)
  })

  it('opens no pull request when there is no remote, with the same wording as before', async () => {
    const r = await rig()
    const run = await begin(r)
    const m = await local(r, run, { remote: false })
    const actions = new GitActions(m.store, m.workspaces, {} as never, async () => undefined, new PrCache())
    await expect(actions.openPullRequest(run.workspaceId!, { draft: true })).rejects.toThrow('This repository has no remote, so there is nowhere to open a pull request.')
  })
})

describe('outward actions: what the employee is told', () => {
  it('tells a waiting task’s next continuation what became of its held actions, once', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run))
    await r.tools.call(run.sessionId!, 'request_push', {})
    await r.work.askPerson(run.sessionId!, { question: 'Which version?' })
    await end(r, run)
    const [post, push] = r.db.employeeActions()
    await r.actions.send(post.id, { edits: { text: 'We shipped 1.1!' } })
    r.actions.skip(push.id)
    const task = r.db.employeeTask(run.taskId)!
    expect(task.actionNews?.map((n) => n.state)).toEqual(['sent', 'skipped'])
    await r.work.answerQuestion(task.id, task.question!.id, '1.1')
    await settle()
    const message = r.launches.at(-1)!.message
    expect(message).toMatch(/^This continues a task you already started\. Outward actions you asked for, decided while your task waited:/)
    expect(message).toContain('- A Slack post to #launches: “We shipped 1.1!”: sent, after the person edited its words (https://acme.slack.com/archives/C1/p12).')
    expect(message).toContain('- A push of max/launch (2 commits ahead of main): skipped by the person, so it was not sent. Don’t send it another way.')
    expect(message).toContain('You asked: Which version?')
    expect(r.db.employeeTask(run.taskId)?.actionNews).toBeUndefined()
    expect(r.db.employeeTaskTransitions(run.taskId).map((t) => t.event)).toContain('actions-told')
  })

  it('leaves a closed task’s outcome on its log, and skips a canceled task’s held actions', async () => {
    const r = await rig()
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run, 'one'))
    await r.actions.bridgeCall(slackCall(run, 'two'))
    await r.work.finishTask(run.sessionId!, { status: 'done', summary: 'Drafted.' })
    const [first] = r.db.employeeActions()
    await r.actions.send(first.id)
    expect(r.db.employeeTask(run.taskId)?.actionNews).toBeUndefined()
    expect(log(r, run.taskId)).toEqual(['action-held', 'action-held', 'action-approved', 'action-sent'])
    // A second task, canceled with a held post: the post goes too.
    const r2 = await rig()
    const run2 = await begin(r2)
    await r2.actions.bridgeCall(slackCall(run2))
    await r2.work.cancel(run2.taskId)
    expect(only(r2)).toMatchObject({ state: 'skipped', reason: expect.stringMatching(/^Canceled with its task/) })
    expect(r2.send.slack).not.toHaveBeenCalled()
  })

  it('words the news and continuation plainly', () => {
    expect(newsText([])).toBe('')
    const news = [{ actionId: 'a', kind: 'pull-request' as const, summary: 'the pull request “X” (main ← b)', state: 'failed' as const, detail: 'no remote', at: 'x' }]
    expect(continuationMessage({ title: 'T', body: 'T', from: 'person' }, [], [], news)).toBe(
      'This continues a task you already started. Outward actions you asked for, decided while your task waited:\n- The pull request “X” (main ← b): not sent, it failed (no remote).\n\nThe task:\n\nT'
    )
  })

  it('reads an action back from foreman.db as it was written', async () => {
    const r = await rig({ actions: { 'slack-post': 'allowed' } })
    const run = await begin(r)
    await r.actions.bridgeCall(slackCall(run))
    const a = only(r)
    expect(r.db.employeeAction(a.id)).toEqual(a)
    expect(r.db.employeeActionByKey(a.key)).toEqual(a)
    expect(r.db.addEmployeeAction({ ...a, id: 'other' })).toBe(false)
    expect(r.db.employeeActions({ taskId: run.taskId, states: ['sent'] })).toEqual([a])
  })
})
