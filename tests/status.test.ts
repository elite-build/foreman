import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '../src/cli/command'
import { workRunners } from '../src/cli/commands/work'
import { socketPath, type CliRequest, type CliResponse } from '../src/cli/protocol'
import type { CliHost } from '../src/main/cli/host'
import { METHODS } from '../src/main/cli/methods'
import { startCliServer } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { checksState, pullRequestUrl, statusRows, statusTable, type StatusRow } from '../src/shared/status'
import type { ApprovalRequest, CheckResult, Repo, Session, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { tempDir } from './helpers'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const ws = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'ws', repoId: 'r', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: ago(100), ...patch }) as Workspace
const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ago(90), ...patch }) as Session
const result = (status: CheckResult['status']): CheckResult => ({ name: 'test', command: 'x', status, startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' } })
const rows = (workspaces: Workspace[], sessions: Session[], approvals: ApprovalRequest[] = [], prs?: Record<string, number>) =>
  statusRows({ snapshot: { workspaces, sessions }, approvals, unread: {}, unreadSessions: {}, now: NOW, prs }, { r: 'app' })

describe('checks state', () => {
  it('reads none, running, stale, failed, passed and never calls a stopped run passed', () => {
    expect(checksState(undefined)).toBe('none')
    expect(checksState({ running: false, results: [] })).toBe('none')
    expect(checksState({ running: true, results: [result('passed')] })).toBe('running')
    expect(checksState({ running: false, stale: true, results: [result('failed')] })).toBe('stale')
    expect(checksState({ running: false, results: [result('failed')] })).toBe('failed')
    expect(checksState({ running: false, results: [result('timeout')] })).toBe('failed')
    expect(checksState({ running: false, results: [result('interrupted')] })).toBe('incomplete')
    expect(checksState({ running: false, results: [result('passed')] })).toBe('passed')
  })
})

describe('status rows', () => {
  it('reports bucket, latest turn, delta, checks and PR for a workspace', () => {
    const s = session('s1', { lastTurn: { outcome: 'completed', turnId: 't1', endedAt: ago(5), additions: 12, deletions: 3 } })
    const [row] = rows([ws({ checks: { running: false, results: [result('passed')] }, prInfo: { number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42' } })], [s])
    expect(row).toEqual({
      workspace: 'lisbon',
      id: 'ws',
      repo: 'app',
      branch: 'fix-login',
      bucket: 'idle',
      label: undefined,
      turn: { id: 't1', tab: 1, outcome: 'completed', endedAt: ago(5) },
      checks: 'passed',
      delta: { additions: 12, deletions: 3 },
      pr: { number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42' }
    })
  })

  it('shows a running turn without a delta, and counts the tab among open ones only', () => {
    const closed = session('s0', { closedAt: ago(50) })
    const running = session('s2', { status: 'running', turnId: 't2', turnStartedAt: ago(2), lastTurn: undefined })
    const [row] = rows([ws()], [closed, session('s1'), running])
    expect(row).toMatchObject({ bucket: 'working', turn: { id: 't2', tab: 2, outcome: 'running' } })
    expect(row.delta).toBeUndefined()
  })

  it('orders rows needing you first and names the reason', () => {
    const a = ws({ id: 'a', name: 'idle-one' })
    const b = ws({ id: 'b', name: 'broken', checks: { running: false, results: [result('failed')] } })
    const out = rows([a, b], [])
    expect(out.map((r) => [r.workspace, r.bucket, r.label])).toEqual([['broken', 'attention', 'Checks failed'], ['idle-one', 'idle', undefined]])
  })

  it('uses the PR a workspace checked out when no lookup has run', () => {
    const w = ws({ pullRequest: { repo: 'o/r', number: 7 } })
    expect(pullRequestUrl(w)).toBe('https://github.com/o/r/pull/7')
    expect(rows([w], [])[0].pr).toEqual({ number: 7, state: undefined, url: 'https://github.com/o/r/pull/7' })
    expect(rows([ws()], [])[0].pr).toBeUndefined()
  })

  it('prints a table with a header, and says so when there is nothing', () => {
    const s = session('s1', { lastTurn: { outcome: 'error', endedAt: ago(5), additions: 1, deletions: 0 } })
    const text = statusTable(rows([ws({ prInfo: { number: 9, state: 'MERGED' } })], [s]))
    const [head, line] = text.split('\n')
    expect(head).toMatch(/^WORKSPACE\s+STATE\s+LAST TURN\s+CHECKS\s+DELTA\s+PR$/)
    expect(line).toMatch(/^lisbon\s+needs you: Turn failed\s+tab 1 failed\s+none\s+\+1 -0\s+#9 merged$/)
    expect(statusTable([])).toBe('No workspaces.')
  })
})

describe('foreman status over the socket', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  it('is read-only and answers with the rows', async () => {
    const dataDir = await tempDir()
    const s = session('s1', { lastTurn: { outcome: 'completed', endedAt: ago(5) } })
    const repo = { id: 'r', name: 'app', rootPath: '/app' } as Repo
    const host = stubHost({ state: () => ({ repos: [repo], workspaces: [ws()], sessions: [s], settings: defaultSettings() }) })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()
    const response = await new Promise<CliResponse>((resolve, reject) => {
      const conn = net.createConnection(socket, () => conn.write(`${JSON.stringify({ method: 'status' } satisfies CliRequest)}\n`))
      let out = ''
      conn.setEncoding('utf8')
      conn.on('data', (chunk: string) => (out += chunk))
      conn.on('end', () => resolve(JSON.parse(out) as CliResponse))
      conn.on('error', reject)
    })
    expect(response).toMatchObject({ ok: true, result: [{ workspace: 'lisbon', repo: 'app', bucket: 'idle', checks: 'none', turn: { tab: 1, outcome: 'completed' } }] })
  })
})

describe('foreman status --words', () => {
  const approvalFor = (sessionId: string, input: Record<string, unknown>): ApprovalRequest => ({ id: 'a1', sessionId, kind: 'tool', toolName: 'Bash', input })
  const hostWith = (workspaces: Workspace[], sessions: Session[], approvals: ApprovalRequest[] = [], overrides: Partial<CliHost> = {}) =>
    stubHost({ state: () => ({ repos: [{ id: 'r', name: 'app', rootPath: '/app' } as Repo], workspaces, sessions, settings: defaultSettings() }), approvals: () => approvals, ...overrides })
  const words = async (host: CliHost, params?: unknown) => (await METHODS.status.handle(host, params, { request: { method: 'status' } as never, caller: undefined, signal: undefined, progress: () => undefined })) as { rows: StatusRow[]; text: string } | StatusRow[]

  it('says how many things need you, then a sentence per workspace', async () => {
    const lisbon = ws({ checks: { running: false, results: [result('passed'), result('passed')] }, prInfo: { number: 51, state: 'OPEN' } })
    const other = ws({ id: 'ws2', name: 'login-redesign' })
    const done = session('s1', { lastTurn: { outcome: 'completed', turnId: 't1', endedAt: new Date(Date.now() - 2 * 60_000).toISOString(), additions: 120, deletions: 14 } })
    const waiting = session('s2', { workspaceId: 'ws2' })
    const host = hostWith([lisbon, other], [done, waiting], [approvalFor('s2', { command: 'npm test' })], {
      turnStatus: async () => ({ workspaceId: 'ws', sessionId: 's1', turnId: 't1', state: 'ended', outcome: 'completed', delta: { files: [{ path: 'a', additions: 1, deletions: 0 }, { path: 'b', additions: 1, deletions: 0 }, { path: 'c', additions: 1, deletions: 0 }], additions: 120, deletions: 14 } })
    })
    const said = (await words(host, { words: true })) as { rows: StatusRow[]; text: string }
    expect(said.text.split('\n')).toEqual([
      '1 thing needs you',
      'login-redesign: Claude Code wants to run Bash: npm test.',
      'lisbon: Claude Code finished 2 minutes ago, this turn 3 files +120 -14, checks 2 passed, PR #51 open.'
    ])
    // The rows are what the plain call answers, untouched.
    expect(said.rows).toEqual(await words(host))
  })

  it('leaves the data alone without the flag, says nothing needs you, and keeps "No workspaces."', async () => {
    const host = hostWith([ws()], [session('s1')])
    expect(Array.isArray(await words(host))).toBe(true)
    expect(Array.isArray(await words(host, { words: 'yes' }))).toBe(true)
    expect(((await words(host, { words: true })) as { text: string }).text).toBe('Nothing needs you\nlisbon: idle.')
    expect(((await words(hostWith([], []), { words: true })) as { text: string }).text).toBe('No workspaces.')
  })

  it('falls back to lines only when the turn’s record can’t be read, and says a stale check as stale', async () => {
    const s = session('s1', { lastTurn: { outcome: 'error', turnId: 't1', endedAt: new Date(Date.now() - 5 * 60_000).toISOString(), additions: 1, deletions: 2 } })
    const host = hostWith([ws({ checks: { running: false, stale: true, results: [result('passed')] } })], [s], [], {
      turnStatus: async () => {
        throw new Error('unreadable')
      }
    })
    expect(((await words(host, { words: true })) as { text: string }).text).toBe('Nothing needs you\nlisbon: Claude Code failed 5 minutes ago, this turn +1 -2, needs you: Turn failed, checks 1 passed, stale.')
  })

  describe('the command', () => {
    const run = async (opts: Record<string, unknown>, answer: unknown) => {
      const sent: [string, unknown][] = []
      const out: string[] = []
      const context = {
        args: [],
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
      await workRunners.status(context)
      return { sent, out }
    }

    it('asks for words and prints them; with --json it asks for nothing and prints the rows', async () => {
      const table = rows([ws()], [session('s1')])
      const spoken = await run({ words: true }, { rows, text: 'Nothing needs you\nlisbon: idle.' })
      expect(spoken.sent).toEqual([['status', { words: true }]])
      expect(spoken.out).toEqual(['Nothing needs you\nlisbon: idle.'])
      const json = await run({ words: true, json: true }, table)
      expect(json.sent).toEqual([['status', undefined]])
      expect(JSON.parse(json.out[0])).toEqual(JSON.parse(JSON.stringify(table)))
      expect((await run({}, table)).out[0]).toMatch(/^WORKSPACE/)
    })
  })
})
