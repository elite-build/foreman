import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { request } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { workRunners } from '../src/cli/commands/work'
import { waitText } from '../src/cli/format'
import { EXIT_DISCONNECTED, socketPath, WAIT_EXIT, type CliRequest, type CliResponse, type WaitResult } from '../src/cli/protocol'
import { METHODS } from '../src/main/cli/methods'
import { run, startCliServer, waitForTurn } from '../src/main/cliServer'
import { SessionService } from '../src/main/sessions'
import { defaultSettings, Store } from '../src/main/store'
import type { TurnStatus, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { tempDir, waitFor } from './helpers'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const ws = { id: 'ws', name: 'lisbon' } as Workspace
const status = (state: TurnStatus['state'], extra: Partial<TurnStatus> = {}): TurnStatus => ({ workspaceId: 'ws', sessionId: 's1', turnId: 't1', state, ...extra })

describe('exit codes', () => {
  it('maps outcomes: 0 completed, 1 failed, stopped or interrupted, 2 timeout; 5 is a lost connection', () => {
    expect(WAIT_EXIT).toEqual({ completed: 0, error: 1, cancelled: 1, interrupted: 1, timeout: 2 })
    expect(EXIT_DISCONNECTED).toBe(5)
  })
})

describe('waiting for a turn', () => {
  it('answers at once when the turn ended before the waiter attached, with delta, checks and PR', async () => {
    const delta = { files: [{ path: 'a.ts', additions: 2, deletions: 1 }], additions: 2, deletions: 1 }
    const host = stubHost({
      state: () => ({ repos: [], workspaces: [{ ...ws, checks: { running: false, results: [{ name: 't', command: 'x', status: 'passed', startedAt: '', logPath: '', fingerprint: { tree: 'a', command: 'b', source: 'shared' } }] }, pullRequest: { repo: 'o/r', number: 9 } } as Workspace], sessions: [], settings: defaultSettings() }),
      turnStatus: async () => status('ended', { outcome: 'completed', durationMs: 4000, delta })
    })
    const started = Date.now()
    const result = await waitForTurn(host, { turn: 't1' })
    expect(Date.now() - started).toBeLessThan(500)
    expect(result).toEqual({
      workspace: { id: 'ws', name: 'lisbon' },
      session: 's1',
      turn: 't1',
      outcome: 'completed',
      durationMs: 4000,
      delta,
      checks: 'passed',
      pr: { number: 9, state: undefined, url: 'https://github.com/o/r/pull/9' }
    })
    expect(waitText(result)).toBe(
      ['Turn t1 completed in lisbon (4.0s)', '  changed  +2 -1 in 1 file', '  checks   passed', '  PR       #9  https://github.com/o/r/pull/9'].join('\n')
    )
  })

  it('times out without touching the turn, which keeps running', async () => {
    const host = stubHost({
      state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }),
      turnStatus: async () => status('running')
    })
    const result = await waitForTurn(host, { turn: 't1', timeoutSec: 0.05 }, { pollMs: 10 })
    expect(result).toMatchObject({ outcome: 'timeout', turn: 't1' })
    expect(WAIT_EXIT[result.outcome]).toBe(2)
    expect(waitText(result, 0.05)).toContain('keeps running')
    // The same turn, once it ends, is still answered.
    const later = stubHost({ state: host.state, turnStatus: async () => status('ended', { outcome: 'error', error: 'boom' }) })
    expect(await waitForTurn(later, { turn: 't1' })).toMatchObject({ outcome: 'error', error: 'boom' })
  })

  it('follows a queued turn through to its end, and calls a removed queued message cancelled', async () => {
    const steps = [status('queued'), status('queued'), status('running'), status('ended', { outcome: 'completed' })]
    const host = stubHost({ state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }), turnStatus: async () => steps.shift() ?? null })
    expect(await waitForTurn(host, { turn: 't1' }, { pollMs: 5 })).toMatchObject({ outcome: 'completed' })
    const gone = [status('queued'), null]
    const removed = stubHost({ state: host.state, turnStatus: async () => gone.shift() ?? null })
    expect(await waitForTurn(removed, { turn: 't1' }, { pollMs: 5 })).toMatchObject({ outcome: 'cancelled' })
  })

  it('refuses a turn id nothing knows', async () => {
    await expect(waitForTurn(stubHost(), { turn: 'nope' })).rejects.toThrow('No turn with the id “nope”')
  })

  it('stops waiting when the command goes away', async () => {
    const abort = new AbortController()
    const host = stubHost({ state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }), turnStatus: async () => status('running') })
    const pending = waitForTurn(host, { turn: 't1' }, { signal: abort.signal, pollMs: 5 })
    setTimeout(() => abort.abort(), 30)
    expect(await pending).toMatchObject({ outcome: 'timeout' })
  })
})

describe('turn status from real sessions', () => {
  it('a turn that completed before anyone waited is read from its persisted turn-end', async () => {
    const { sessions, session } = await setupSessions()
    registerDriver(fakeDriver(async (_req, cb) => cb.finished({ ok: true })))
    const receipt = await sessions.deliver(session.id, 'go')
    await waitFor(() => expect(session.lastTurn).toBeDefined())
    // Whatever the session remembers is gone; only the chat file is left.
    session.lastTurn = undefined
    expect(await sessions.turnStatus(receipt.turnId!)).toMatchObject({ state: 'ended', outcome: 'completed', sessionId: session.id })
    expect(await sessions.turnStatus('unknown')).toBeNull()
  })

  it('reports queued, then running, then ended for a turn that waited its turn', async () => {
    const { sessions, session } = await setupSessions()
    const first = gate()
    registerDriver(fakeDriver(first.script))
    const a = await sessions.deliver(session.id, 'first')
    expect(await sessions.turnStatus(a.turnId!)).toMatchObject({ state: 'running' })
    const b = await sessions.deliver(session.id, 'second', { mode: 'queue' })
    expect(b.disposition).toBe('queued')
    expect(await sessions.turnStatus(b.turnId!)).toMatchObject({ state: 'queued' })
    first.release()
    await waitFor(async () => expect(await sessions.turnStatus(a.turnId!)).toMatchObject({ state: 'ended', outcome: 'completed' }))
    // The queued message kept its id when it started.
    expect((await sessions.turnStatus(b.turnId!))?.state).not.toBe('queued')
    expect(await sessions.turnStatus(b.turnId!)).not.toBeNull()
  })

  it('after a restart, a turn the app was closed during reads as interrupted', async () => {
    const harness = await setupSessions({ saveState: true })
    const hung = gate()
    registerDriver(fakeDriver(hung.script))
    const receipt = await harness.sessions.deliver(harness.session.id, 'go')
    harness.store.flush()
    // A fresh process reads the same folder.
    const reopened = new Store(harness.root)
    await reopened.load()
    const sessions = new SessionService(reopened, {} as never, { workspace: () => harness.ws } as never, { changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {} })
    expect(await sessions.turnStatus(receipt.turnId!)).toMatchObject({ state: 'ended', outcome: 'interrupted', error: expect.stringContaining('closed') })
    hung.release()
  })
})

describe('foreman run --wait ids', () => {
  it('returns the chat and turn the first message started', async () => {
    const host = stubHost({
      state: () => ({ repos: [{ id: 'r', name: 'app', rootPath: '/app' } as never], workspaces: [], sessions: [], settings: { ...defaultSettings(), promptTemplates: [{ id: 't', name: 'Go', body: 'go' }] } }),
      createWorkspace: async () => ({ id: 'w1', name: 'lisbon', branch: 'b', path: '/p' }) as Workspace,
      firstTurn: async () => ({ session: 's1', turn: 't1' })
    })
    expect(await run(host, { template: 'go', values: [], cwd: '/app' })).toMatchObject({ workspace: { id: 'w1' }, session: 's1', turn: 't1' })
    // Held setup starts nothing, so there are no ids.
    const held = stubHost({ ...host, setupOutcome: async () => ({ failed: true, held: true, logTail: 'x' }), firstTurn: async () => ({ session: 'no', turn: 'no' }) })
    const result = await run(held, { template: 'go', values: [], cwd: '/app' })
    expect(result.held).toBeDefined()
    expect(result.turn).toBeUndefined()
  })
})

describe('reconnecting', () => {
  let servers: net.Server[] = []
  afterEach(() => {
    for (const s of servers) s.close()
    servers = []
  })

  it('a dropped connection is exit 5, and a later `wait` reads the outcome', async () => {
    const dataDir = await tempDir()
    const socket = socketPath(dataDir)
    // First app: takes the request, then dies without answering.
    const dying = net.createServer((conn) => conn.on('data', () => conn.destroy()))
    await new Promise<void>((resolve) => dying.listen(socket, resolve))
    const wait: CliRequest = { method: 'wait', params: { turn: 't1' } }
    await expect(request(socket, wait, { waiting: true })).rejects.toMatchObject({ exitCode: EXIT_DISCONNECTED })
    await new Promise<void>((resolve) => dying.close(() => resolve()))
    // Nothing listening: also a lost connection for a waiter.
    await expect(request(socket, wait, { waiting: true })).rejects.toMatchObject({ exitCode: EXIT_DISCONNECTED, message: expect.stringContaining('isn’t running') })
    // Not for other commands.
    await expect(request(socket, { method: 'repos' })).rejects.toMatchObject({ message: expect.stringContaining('isn’t running') })

    // The app is back, and the turn ended while it was away.
    const host = stubHost({
      state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }),
      turnStatus: async () => status('ended', { outcome: 'interrupted', error: 'Foreman closed while this turn was running.' })
    })
    const server = await startCliServer(socket, host)
    servers.push(server)
    const result = await request<WaitResult>(socket, wait, { waiting: true })
    expect(result).toMatchObject({ outcome: 'interrupted', turn: 't1' })
    expect(WAIT_EXIT[result.outcome]).toBe(1)
  })

  it('answers over the socket, and a command that hangs up does not disturb the turn', async () => {
    const dataDir = await tempDir()
    const socket = socketPath(dataDir)
    let polls = 0
    const host = stubHost({
      state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }),
      turnStatus: async () => (++polls < 3 ? status('running') : status('ended', { outcome: 'completed' }))
    })
    servers.push(await startCliServer(socket, host))
    const response = await new Promise<CliResponse>((resolve, reject) => {
      const conn = net.createConnection(socket, () => conn.write(`${JSON.stringify({ method: 'wait', params: { turn: 't1' } } satisfies CliRequest)}\n`))
      let out = ''
      conn.setEncoding('utf8')
      conn.on('data', (chunk: string) => (out += chunk))
      conn.on('end', () => resolve(JSON.parse(out) as CliResponse))
      conn.on('error', reject)
    })
    expect(response).toMatchObject({ ok: true, result: { outcome: 'completed' } })
  })
})

describe('foreman wait --words', () => {
  const delta = { files: [{ path: 'a.ts', additions: 18, deletions: 4 }, { path: 'b.ts', additions: 0, deletions: 0 }], additions: 18, deletions: 4 }
  const checks = { running: false, results: [{ name: 't', command: 'x', status: 'passed', startedAt: '', logPath: '', fingerprint: { tree: 'a', command: 'b', source: 'shared' } }] }
  const hostFor = (outcome: TurnStatus['outcome'], extra: Partial<TurnStatus> = {}, workspace: Partial<Workspace> = {}) =>
    stubHost({
      state: () => ({
        repos: [],
        workspaces: [{ ...ws, ...workspace } as Workspace],
        sessions: [{ id: 's1', workspaceId: 'ws', agent: 'claude' } as never],
        settings: defaultSettings()
      }),
      turnStatus: async () => status('ended', { outcome, ...extra })
    })
  const ctx = { request: { method: 'wait' } as never, caller: undefined, signal: undefined, progress: () => undefined }

  it('says the finished turn as the narrator does: this turn’s change and the checks as recorded', async () => {
    const host = hostFor('completed', { delta }, { checks: checks as never })
    const result = (await METHODS.wait.handle(host, { turn: 't1', words: true }, ctx)) as WaitResult & { words: string }
    expect(result.words).toBe('Claude Code finished in lisbon: this turn 2 files, +18 -4. Checks: 1 passed.')
    // Everything else in the answer is what it always was.
    const { words: _words, ...data } = result
    expect(data).toEqual(await waitForTurn(host, { turn: 't1' }))
  })

  it('adds no words unless asked, and only for a literal true', async () => {
    const host = hostFor('completed', { delta })
    expect(await METHODS.wait.handle(host, { turn: 't1' }, ctx)).not.toHaveProperty('words')
    expect(await METHODS.wait.handle(host, { turn: 't1', words: 1 }, ctx)).not.toHaveProperty('words')
  })

  it('says the workspace’s figure, labelled, when the turn has none; stale checks as stale; failures with their reason', async () => {
    const host = hostFor('error', { error: 'boom' }, { diffStat: { files: 5, additions: 40, deletions: 2 }, checks: { ...checks, stale: true } as never })
    const result = (await METHODS.wait.handle(host, { turn: 't1', words: true }, ctx)) as WaitResult & { words: string }
    expect(result.words).toBe('Claude Code failed in lisbon: workspace 5 files, +40 -2. Checks: 1 passed, stale.\nError: boom')
    expect(((await METHODS.wait.handle(hostFor('cancelled'), { turn: 't1', words: true }, ctx)) as { words: string }).words).toBe('Claude Code stopped in lisbon.')
    expect(((await METHODS.wait.handle(hostFor('interrupted'), { turn: 't1', words: true }, ctx)) as { words: string }).words).toBe('Claude Code was interrupted in lisbon.')
  })

  it('says a turn that is still going when the wait gives up', async () => {
    const host = stubHost({ state: () => ({ repos: [], workspaces: [ws], sessions: [{ id: 's1', workspaceId: 'ws', agent: 'codex' } as never], settings: defaultSettings() }), turnStatus: async () => status('running') })
    const result = (await METHODS.wait.handle(host, { turn: 't1', timeoutSec: 0.05, words: true }, ctx)) as WaitResult & { words: string }
    expect(result.outcome).toBe('timeout')
    expect(result.words).toBe('Codex is still working in lisbon.')
  })

  describe('the command', () => {
    const run = async (opts: Record<string, unknown>, answer: unknown) => {
      const sent: [string, unknown][] = []
      const out: string[] = []
      const context = {
        args: ['t1'],
        opts,
        json: Boolean(opts.json),
        quiet: false,
        yes: false,
        cwd: '/work',
        send: (async (method: string, params?: unknown) => (sent.push([method, params]), answer)) as Context['send'],
        print: (value: unknown, text: string | (() => string)) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
        confirm: async () => false,
        note: () => undefined,
        progress: () => undefined
      } as Context
      await workRunners.wait(context)
      process.exitCode = undefined
      return { sent, out }
    }
    const done: WaitResult = { workspace: { id: 'ws', name: 'lisbon' }, session: 's1', turn: 't1', outcome: 'completed', checks: 'passed' }

    it('prints the sentence for --words, and the usual text and JSON otherwise', async () => {
      const spoken = await run({ words: true }, { ...done, words: 'Claude Code finished in lisbon.' })
      expect(spoken.sent[0]).toEqual(['wait', { turn: 't1', timeoutSec: undefined, words: true }])
      expect(spoken.out).toEqual(['Claude Code finished in lisbon.'])
      const plain = await run({}, done)
      expect(plain.sent[0]).toEqual(['wait', { turn: 't1', timeoutSec: undefined }])
      expect(plain.out[0]).toBe('Turn t1 completed in lisbon\n  checks   passed')
      const json = await run({ words: true, json: true }, done)
      expect(json.sent[0]).toEqual(['wait', { turn: 't1', timeoutSec: undefined }])
      expect(JSON.parse(json.out[0])).toEqual(done)
    })
  })
})
