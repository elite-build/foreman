import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/cli/command'
import { approvalRunners } from '../src/cli/commands/approvals'
import { renderCommandHelp } from '../src/cli/help'
import { parseCommandArgs } from '../src/cli/registry'
import { APPROVAL_METHODS, askText } from '../src/main/cli/approvals'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { COMMON_OPTIONS, commandName } from '../src/shared/cliCommands'
import { APPROVAL_COMMANDS } from '../src/shared/cliCommandsOps'
import type { ApprovalAnswerResult, ApprovalsResult, StoppedResult } from '../src/shared/cli/approvals'
import type { Api, ApprovalRequest, Repo, Session, Workspace } from '../src/shared/types'
import type { StopReviewRow } from '../src/shared/stopSafely'
import { fakeApi, stubHost } from './cliHost'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: 'x', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'running', queue: [], fastMode: false, planMode: false, ...patch }) as Session

const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: () => undefined })

const turnHost = (mayStart: boolean): Partial<CliHost> => ({
  identifyCaller: () => ({ kind: 'turn', session: tab('s1'), ws: ws(), turnId: 't', live: true }),
  agentsMayStart: () => mayStart
})

const requests: Record<string, ApprovalRequest> = {
  bash: { id: 'tool11111-aaaa', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: { command: 'npm run db:migrate' }, alternate: 'always-allow' },
  edit: { id: 'tool22222-bbbb', sessionId: 's2', kind: 'tool', toolName: 'Edit', input: { file_path: 'src/app.ts' }, alternate: 'edits-for-session' },
  plain: { id: 'tool33333-cccc', sessionId: 's1', kind: 'tool', toolName: 'WebFetch', input: { url: 'https://example.com' } },
  plan: { id: 'plan44444-dddd', sessionId: 's1', kind: 'plan', plan: '# Add dark mode\n\n1. Add a theme context\n2. Wire the toggle\n- Update the tests\n' },
  question: {
    id: 'quest5555-eeee',
    sessionId: 's1',
    kind: 'question',
    questions: [
      { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Run migrations now?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  }
}

function rig(options: { pending?: ApprovalRequest[]; stopped?: StopReviewRow[]; api?: Partial<Api>; host?: Partial<CliHost> } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const api = fakeApi({
    pendingApprovals: async () => options.pending ?? Object.values(requests),
    respondApproval: record('respondApproval') as Api['respondApproval'],
    stopReview: async () => options.stopped ?? [],
    retryStopped: record('retryStopped') as Api['retryStopped'],
    dismissStopped: record('dismissStopped') as Api['dismissStopped'],
    ...options.api
  })
  const host = stubHost({ api, state: () => ({ repos: [repo], workspaces: [ws()], sessions: [tab('s1', { title: 'Login bug' }), tab('s2', { title: 'Other' })], settings: defaultSettings() }), ...options.host })
  const call = async <T>(method: string, params: unknown, token?: string): Promise<T> => (await APPROVAL_METHODS[method].handle(host, params, ctx(token))) as T
  return { host, calls, call }
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

describe('approvals', () => {
  it('lists each request with its workspace, tab, kind and the ask', async () => {
    const { call } = rig()
    const result = await call<ApprovalsResult>('approvals', undefined)
    expect(result.approvals.map((r) => [r.id, r.workspace, r.tab, r.kind])).toEqual([
      ['tool11111-aaaa', 'lisbon', 1, 'tool'],
      ['tool22222-bbbb', 'lisbon', 2, 'tool'],
      ['tool33333-cccc', 'lisbon', 1, 'tool'],
      ['plan44444-dddd', 'lisbon', 1, 'plan'],
      ['quest5555-eeee', 'lisbon', 1, 'question']
    ])
    expect(result.approvals[0].alternate).toBe('always-allow')
    expect(result.text.split('\n')[0]).toMatch(/^ID\s+WORKSPACE\s+TAB\s+KIND\s+ASK$/)
    expect(result.text).toContain('Bash: npm run db:migrate')
  })

  it('words the ask by kind', () => {
    expect(askText(requests.bash)).toBe('Bash: npm run db:migrate')
    expect(askText(requests.edit)).toBe('Edit: src/app.ts')
    expect(askText(requests.plan)).toBe('Add dark mode (3 steps)')
    expect(askText(requests.question)).toBe('Which database? (+1 more)')
    expect(askText({ id: 'x', sessionId: 's', kind: 'tool', toolName: 'Custom', input: { a: 1 } })).toBe('Custom: {"a":1}')
  })

  it('says when nothing is waiting', async () => {
    expect((await rig({ pending: [] }).call<ApprovalsResult>('approvals', undefined)).text).toBe('Nothing is waiting for an answer.')
  })
})

describe('approve', () => {
  it('allows a tool, with a note when given', async () => {
    const { call, calls } = rig()
    await call('approve', { id: 'tool11111-aaaa' })
    await call('approve', { id: 'tool3333', message: 'go ahead' })
    expect(calls).toEqual([
      ['respondApproval', 'tool11111-aaaa', { kind: 'tool', allow: true }],
      ['respondApproval', 'tool33333-cccc', { kind: 'tool', allow: true, message: 'go ahead' }]
    ])
  })

  it('gives the alternate answer for --always and --edits only where the tool offers them', async () => {
    const { call, calls } = rig()
    await call('approve', { id: 'tool11111-aaaa', always: true })
    await call('approve', { id: 'tool22222-bbbb', edits: true })
    expect(calls).toEqual([
      ['respondApproval', 'tool11111-aaaa', { kind: 'tool', allow: true, alternate: true }],
      ['respondApproval', 'tool22222-bbbb', { kind: 'tool', allow: true, alternate: true }]
    ])
    expect((await failure(call('approve', { id: 'tool11111-aaaa', edits: true }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'tool22222-bbbb', always: true }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'tool33333-cccc', always: true }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'tool11111-aaaa', always: true, edits: true }))).code).toBe('invalid')
    expect(calls).toHaveLength(2)
  })

  it('approves a plan with feedback', async () => {
    const { call, calls } = rig()
    const result = await call<ApprovalAnswerResult>('approve', { id: 'plan4444', plan: true, feedback: 'Skip step 3' })
    await call('approve', { id: 'plan44444-dddd' })
    expect(calls).toEqual([
      ['respondApproval', 'plan44444-dddd', { kind: 'plan', approve: true, feedback: 'Skip step 3' }],
      ['respondApproval', 'plan44444-dddd', { kind: 'plan', approve: true }]
    ])
    expect(result).toMatchObject({ kind: 'plan', answer: 'approved', workspace: 'lisbon' })
  })

  it('answers a question by text, header or position, using the options’ own spelling', async () => {
    const { call, calls } = rig()
    await call('approve', { id: 'quest5555-eeee', answers: { DB: 'postgres', '2': 'no' } })
    await call('approve', { id: 'quest5555-eeee', answers: { 'Which database?': 'MySQL (my own words)', 'Run migrations': 'Yes' } })
    expect(calls).toEqual([
      ['respondApproval', 'quest5555-eeee', { kind: 'question', answers: { 'Which database?': 'Postgres', 'Run migrations now?': 'No' } }],
      ['respondApproval', 'quest5555-eeee', { kind: 'question', answers: { 'Which database?': 'MySQL (my own words)', 'Run migrations now?': 'Yes' } }]
    ])
  })

  it('refuses a question left unanswered, a bad key, and flags that do not fit the kind', async () => {
    const { call, calls } = rig()
    expect((await failure(call('approve', { id: 'quest5555-eeee' }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'quest5555-eeee', answers: { DB: 'Postgres' } }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'quest5555-eeee', answers: { Nope: 'x', '1': 'y', '2': 'z' } }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'quest5555-eeee', always: true, answers: { '1': 'a', '2': 'b' } }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'plan44444-dddd', always: true }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'plan44444-dddd', message: 'x' }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'tool11111-aaaa', plan: true }))).code).toBe('invalid')
    expect((await failure(call('approve', { id: 'tool11111-aaaa', feedback: 'x' }))).code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('finds a request by the start of its id, and says when it is unknown or ambiguous', async () => {
    const { call } = rig()
    expect((await failure(call('approve', { id: 'nothing' }))).code).toBe('not-found')
    const twins = rig({ pending: [{ ...requests.bash, id: 'abcd1111' }, { ...requests.bash, id: 'abcd2222' }] })
    expect((await failure(twins.call('approve', { id: 'abcd' }))).code).toBe('ambiguous')
    expect((await failure(call('approve', { id: 'zzzzzz' }))).code).toBe('not-found')
    expect((await failure(call('approve', { id: ' ' }))).code).toBe('invalid')
  })
})

describe('deny', () => {
  it('denies a tool with the reason, sends a plan back with feedback, and skips a question', async () => {
    const { call, calls } = rig()
    await call('deny', { id: 'tool11111-aaaa', message: 'Use staging' })
    await call('deny', { id: 'tool22222-bbbb' })
    await call('deny', { id: 'plan44444-dddd', message: 'Split it up' })
    await call('deny', { id: 'plan44444-dddd' })
    const skipped = await call<ApprovalAnswerResult>('deny', { id: 'quest5555-eeee', message: 'ignored' })
    expect(calls).toEqual([
      ['respondApproval', 'tool11111-aaaa', { kind: 'tool', allow: false, message: 'Use staging' }],
      ['respondApproval', 'tool22222-bbbb', { kind: 'tool', allow: false }],
      ['respondApproval', 'plan44444-dddd', { kind: 'plan', approve: false, feedback: 'Split it up' }],
      ['respondApproval', 'plan44444-dddd', { kind: 'plan', approve: false }],
      ['respondApproval', 'quest5555-eeee', { kind: 'question', skipped: true }]
    ])
    expect(skipped.answer).toBe('skipped')
  })
})

describe('stopped', () => {
  const rows: StopReviewRow[] = [
    { kind: 'turn', key: 'turn-aaaa1111', workspaceId: 'ws1', workspace: 'lisbon', sessionId: 's1', title: 'Login bug', model: 'm', cause: 'quit', at: '2026-10-02T00:00:00Z', message: 'Fix the button', attachments: 0 },
    { kind: 'checks', key: 'checks:ws1', workspaceId: 'ws1', workspace: 'lisbon', cause: 'crash', at: '2026-10-02T00:00:00Z', results: [] }
  ]

  it('lists the stopped turns and check runs', async () => {
    const { call } = rig({ stopped: rows })
    const result = await call<StoppedResult>('stopped', {})
    expect(result.rows.map((r) => [r.key, r.kind, r.cause])).toEqual([['turn-aaaa1111', 'turn', 'quit'], ['checks:ws1', 'checks', 'crash']])
    expect(result.text).toContain('Fix the button')
    expect(result.text).toContain('Foreman crashed')
    expect((await rig().call<StoppedResult>('stopped', { verb: 'list' })).text).toBe('No stopped turns to review.')
  })

  it('retries a turn by the start of its key, and not a check run', async () => {
    const { call, calls } = rig({ stopped: rows })
    await call('stopped', { verb: 'retry', key: 'turn-aaaa' })
    expect(calls).toEqual([['retryStopped', 'turn-aaaa1111']])
    expect((await failure(call('stopped', { verb: 'retry', key: 'checks:ws1' }))).code).toBe('invalid')
    expect((await failure(call('stopped', { verb: 'retry', key: 'nope1' }))).code).toBe('not-found')
    expect((await failure(call('stopped', { verb: 'retry' }))).code).toBe('invalid')
  })

  it('sends the retry through the start policy', async () => {
    const closed = rig({ stopped: rows, host: turnHost(false) })
    expect((await failure(closed.call('stopped', { verb: 'retry', key: 'turn-aaaa1111' }, 'tok'))).code).toBe('refused')
    expect(closed.calls).toEqual([])
    const unknown = rig({ stopped: rows })
    expect((await failure(unknown.call('stopped', { verb: 'retry', key: 'turn-aaaa1111' }, 'tok'))).code).toBe('refused')
    expect(unknown.calls).toEqual([])
    const open = rig({ stopped: rows, host: turnHost(true) })
    await open.call('stopped', { verb: 'retry', key: 'turn-aaaa1111' }, 'tok')
    expect(open.calls).toEqual([['retryStopped', 'turn-aaaa1111']])
    // Looking and dismissing need no opt-in.
    await closed.call('stopped', { verb: 'list' }, 'tok')
    await closed.call('stopped', { verb: 'dismiss', key: 'checks:ws1' }, 'tok')
    expect(closed.calls).toEqual([['dismissStopped', 'checks:ws1']])
  })

  it('dismisses one entry, or every entry with no key', async () => {
    const { call, calls } = rig({ stopped: rows })
    await call('stopped', { verb: 'dismiss', key: 'turn-aaaa' })
    await call('stopped', { verb: 'dismiss', all: true })
    expect(calls).toEqual([['dismissStopped', 'turn-aaaa1111'], ['dismissStopped']])
    expect((await failure(call('stopped', { verb: 'dismiss' }))).code).toBe('invalid')
    expect((await failure(call('stopped', { verb: 'forget' }))).code).toBe('invalid')
  })
})

describe('policy', () => {
  it('declares approve and deny admin, and refuses them with any turn token', () => {
    expect(Object.fromEntries(Object.entries(APPROVAL_METHODS).map(([m, d]) => [m, d.tier]))).toEqual({ approvals: 'read', approve: 'admin', deny: 'admin', stopped: 'act' })
    expect(Object.fromEntries(APPROVAL_COMMANDS.map((c) => [commandName(c), c.tier]))).toEqual({ approvals: 'read', approve: 'admin', deny: 'admin', stopped: 'act' })
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    for (const method of ['approve', 'deny']) {
      expect(tierCheck(method, 'admin', { v: 2, method, params: {}, caller, token: 'test-token' }, stubHost()), method).toMatchObject({ code: 'refused', error: 'Settings can’t be changed from inside an agent turn.' })
    }
    expect(tierCheck('approvals', 'read', { v: 2, method: 'approvals', caller }, stubHost())).toBeNull()
  })
})

describe('the commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, extra: Partial<Context> = {}) {
    const sent: [string, Record<string, unknown>][] = []
    const context: Context = {
      args,
      opts,
      json: false,
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string, params?: unknown) => (sent.push([method, params as Record<string, unknown>]), { text: 'ok' })) as Context['send'],
      print: () => undefined,
      confirm: async () => true,
      note: () => undefined,
      progress: () => undefined,
      ...extra
    }
    return { context, sent }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('approve sends the flags and splits each --answer at its last =', async () => {
    const run = fakeContext(['3f9a'], { always: true, message: 'ok', feedback: 'f', plan: true, answer: ['Which database?=Postgres', '2=a=b'] })
    await approvalRunners.approve(run.context)
    expect(run.sent[0]).toEqual(['approve', { id: '3f9a', always: true, edits: undefined, message: 'ok', plan: true, feedback: 'f', answers: { 'Which database?': 'Postgres', '2': 'a=b' } }])
    await expect(approvalRunners.approve(fakeContext(['x'], { answer: ['nonsense'] }).context)).rejects.toThrow('question=choice')
    await expect(approvalRunners.approve(fakeContext([], {}).context)).rejects.toThrow('Name a request')
  })

  it('deny and approvals send what they were given', async () => {
    const deny = fakeContext(['3f9a'], { message: 'no' })
    await approvalRunners.deny(deny.context)
    expect(deny.sent[0]).toEqual(['deny', { id: '3f9a', message: 'no' }])
    const list = fakeContext(['list'])
    await approvalRunners.approvals(list.context)
    expect(list.sent[0][0]).toBe('approvals')
    await expect(approvalRunners.approvals(fakeContext(['everything']).context)).rejects.toThrow('takes no words')
  })

  it('stopped checks its words and asks before dismissing everything', async () => {
    const retry = fakeContext(['retry', '7f3a'])
    await approvalRunners.stopped(retry.context)
    expect(retry.sent[0]).toEqual(['stopped', { verb: 'retry', key: '7f3a', all: false }])
    const list = fakeContext([])
    await approvalRunners.stopped(list.context)
    expect(list.sent[0][1]).toMatchObject({ verb: 'list' })
    await expect(approvalRunners.stopped(fakeContext(['retry']).context)).rejects.toThrow('Name the turn')
    await expect(approvalRunners.stopped(fakeContext(['dismiss']).context)).rejects.toThrow('--all')
    await expect(approvalRunners.stopped(fakeContext(['list'], { all: true }).context)).rejects.toThrow('only goes with')
    const all = fakeContext(['dismiss'], { all: true })
    await approvalRunners.stopped(all.context)
    expect(all.sent[0]).toEqual(['stopped', { verb: 'dismiss', key: undefined, all: true }])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const no = fakeContext(['dismiss'], { all: true }, { confirm: async () => false })
    await approvalRunners.stopped(no.context)
    expect(no.sent).toEqual([])
    expect(process.exitCode).toBe(1)
  })
})

describe('the command table', () => {
  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of APPROVAL_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(approvalRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(approvalRunners).sort()).toEqual(APPROVAL_COMMANDS.map(commandName).sort())
  })

  it('parses repeated --answer options', () => {
    const approve = APPROVAL_COMMANDS.find((c) => commandName(c) === 'approve')!
    expect(parseCommandArgs(approve, ['3f9a', '--answer', 'a=b', '--answer', 'c=d', '--always']).opts).toMatchObject({ answer: ['a=b', 'c=d'], always: true })
  })
})
