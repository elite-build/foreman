import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { registerDriver } from '../src/main/agents/registry'
import { ClaudeMirror, pendingKey } from '../src/main/claudeMirror'
import { Store } from '../src/main/store'
import { expectedSubpaths, mirrorComplete, mirrorGap, mirrorLine, projectKeyFor } from '../src/shared/claudeMirror'
import { DataService } from '../src/main/dataService'
import { tempDir } from './helpers'
import { machine, seed, type Machine } from './portabilityRig'
import { fakeDriver, setupSessions } from './sessionHarness'
import path from 'node:path'

const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

afterEach(() => {
  registerDriver(claudeDriver)
  sdk.query.mockReset()
})

async function freshMirror() {
  const store = new Store(await tempDir('foreman-mirror-'))
  await store.load()
  return { store, mirror: new ClaudeMirror(() => store.db) }
}

const key = { projectKey: 'proj-a', sessionId: 'claude-1' }
const user = (uuid: string) => ({ type: 'user', uuid, message: { content: uuid } })

/** A complete mirror for the seeded Claude chat ('native-1'), as a turn would have left it. */
function fillMirror(m: Machine, agentSessionId = 'native-1') {
  void m.mirror.append({ projectKey: 'proj-src', sessionId: agentSessionId }, [user('a1'), { type: 'assistant', uuid: 'a2', message: 'hi' }, { type: 'custom-title', title: 'x' }])
}

async function stage(m: Machine, file: string, passphrase?: string) {
  const result = await m.portability.stage(file, passphrase)
  if (result.kind !== 'staged') throw new Error('staged')
  return result.preview
}

describe('the Claude session store', () => {
  it('dedupes by uuid, keeps uuid-less entries in order, and loads in append order', async () => {
    const { mirror } = await freshMirror()
    expect(await mirror.load(key)).toBeNull()
    await mirror.append(key, [user('a'), { type: 'custom-title', title: 'one' }])
    await mirror.append(key, [user('a'), user('b'), { type: 'custom-title', title: 'two' }])
    expect((await mirror.load(key))!.map((e) => e.uuid ?? e.title)).toEqual(['a', 'one', 'b', 'two'])
    // Another key (a different folder or subagent) is separate.
    await mirror.append({ ...key, subpath: 'subagents/agent-7' }, [user('s1')])
    await mirror.append({ projectKey: 'proj-b', sessionId: 'claude-2' }, [user('z')])
    expect((await mirror.load({ ...key, subpath: 'subagents/agent-7' }))!.map((e) => e.uuid)).toEqual(['s1'])
    expect(await mirror.listSubkeys(key)).toEqual(['subagents/agent-7'])
    expect(await mirror.listSessions('proj-a')).toEqual([{ sessionId: 'claude-1', mtime: 0 }])
    await mirror.delete(key)
    expect(await mirror.load(key)).toBeNull()
  })

  it('counts a session complete only without errors and with every subagent present', async () => {
    const { mirror } = await freshMirror()
    expect(mirror.isComplete('c1')).toBe(false)
    expect(mirror.gap('c1')).toBe('no mirrored transcript')
    await mirror.append({ projectKey: 'p', sessionId: 'c1' }, [user('a'), { type: 'user', uuid: 'b', toolUseResult: { agentId: 'abc123' } }])
    expect(mirror.gap('c1')).toBe('1 subagent transcript missing')
    await mirror.append({ projectKey: 'p', sessionId: 'c1', subpath: 'subagents/agent-abc123' }, [user('s')])
    expect(mirror.isComplete('c1')).toBe(true)
    mirror.recordError('c1', undefined, 'disk full')
    expect(mirror.isComplete('c1')).toBe(false)
    expect(mirror.gap('c1')).toBe('1 mirror error')
    expect(mirror.summary()).toEqual({ sessions: 1, errors: 1 })
    expect(mirrorLine(mirror.summary())).toBe('Claude transcripts: 1 session · 1 mirror error')
  })

  it('has pure rules for keys and completeness', () => {
    expect(projectKeyFor('/Users/a/ws/dakar')).toBe('-Users-a-ws-dakar')
    expect(projectKeyFor('/x'.repeat(150)).length).toBeGreaterThan(200)
    expect(expectedSubpaths([{ type: 'user', toolUseResult: { agentId: 'a1' } }, { type: 'user', x: { agentId: 'a1' } }])).toEqual(['subagents/agent-a1'])
    expect(mirrorComplete({ hasMain: true, subpaths: [], expected: [], errors: 0 })).toBe(true)
    expect(mirrorGap({ hasMain: true, subpaths: [], expected: ['subagents/agent-x'], errors: 0 })).toBe('1 subagent transcript missing')
  })

  it('shows up in Data & devices', async () => {
    const { store, mirror } = await freshMirror()
    await mirror.append(key, [user('a')])
    mirror.recordError('claude-1', undefined, 'boom')
    expect((await new DataService(store, undefined, mirror).info()).claudeTranscripts).toEqual({ sessions: 1, errors: 1 })
  })
})

describe('export and import of a transcript', () => {
  it('makes native resume available for a complete Claude chat, and writes it for the new folder', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    fillMirror(src)
    const out = path.join(await tempDir(), 'native.foreman')
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'password1', includeWorktree: false, outPath: out })
    expect(summary).toMatchObject({ transcripts: 1, transcriptsSkipped: [] })

    const dst = await machine({ name: 'Studio' })
    const staged = await dst.portability.stage(out, 'password1')
    if (staged.kind !== 'staged') throw new Error('staged')
    const [claudeTab, codexTab] = staged.preview.tabs
    expect(claudeTab).toMatchObject({ agent: 'claude', nativeResume: true })
    expect(codexTab).toMatchObject({ agent: 'codex', nativeResume: false })
    expect(codexTab.nativeNote).toMatch(/keeps its conversation on the machine/)
    await expect(dst.portability.importStaged(staged.preview.stageId, { repoId: dst.repo.id, tabs: { 'sess-2': 'native' } })).rejects.toThrow(/no complete transcript/)

    const imported = await dst.portability.importStaged(staged.preview.stageId, { repoId: dst.repo.id, tabs: { 'sess-1': 'native' } })
    const [a] = dst.store.state.sessions.filter((s) => s.workspaceId === imported.id)
    expect(a).toMatchObject({ importedMode: 'native', agentSessionId: 'native-1', lastAssistantUuid: 'u9' })
    expect(a.nativeLineage).toBeUndefined()
    expect(a.forkOnResume).toBeUndefined()
    // Waiting under a key no folder owns, then moved to the new worktree's key.
    expect((await dst.mirror.load({ projectKey: pendingKey(imported.id), sessionId: 'native-1' }))!.map((e) => e.uuid)).toEqual(['a1', 'a2', undefined])
    dst.mirror.adopt(pendingKey(imported.id), '/Users/b/ws/dakar', ['native-1'])
    const adopted = await dst.mirror.load({ projectKey: projectKeyFor('/Users/b/ws/dakar'), sessionId: 'native-1' })
    expect(adopted).toHaveLength(3)
    expect(dst.store.db.db.prepare('SELECT COUNT(*) AS n FROM claude_transcripts WHERE project_key = ?').get(pendingKey(imported.id))).toEqual({ n: 0 })
    expect(dst.mirror.isComplete('native-1')).toBe(true)
  })

  it('keeps the Claude id on a hand-off and forks on a copy', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    fillMirror(src)
    const out = path.join(await tempDir(), 'native.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'password1', includeWorktree: false, outPath: out })
    const dst = await machine({ name: 'Studio' })
    const preview = ((await dst.portability.stage(out, 'password1')) as { preview: Awaited<ReturnType<typeof stage>> }).preview
    const copy = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id, asCopy: true, tabs: { 'sess-1': 'native' } })
    const [s] = dst.store.state.sessions.filter((x) => x.workspaceId === copy.id)
    expect(s.id).not.toBe('sess-1')
    expect(s).toMatchObject({ importedMode: 'native', agentSessionId: 'native-1', forkOnResume: true })
  })

  it('leaves out an incomplete mirror and says why; a share carries a transcript only when asked', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    fillMirror(src)
    src.mirror.recordError('native-1', undefined, 'disk full')
    const out = path.join(await tempDir(), 'a.foreman')
    const bad = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'password1', includeWorktree: false, outPath: out })
    expect(bad).toMatchObject({ transcripts: 0, transcriptsSkipped: [{ title: 'Fix login', reason: '1 mirror error' }] })
    const dst = await machine()
    const staged = await dst.portability.stage(out, 'password1')
    if (staged.kind !== 'staged') throw new Error('staged')
    expect(staged.preview.tabs[0]).toMatchObject({ nativeResume: false, nativeNote: 'the file has no complete transcript for it' })

    const clean = await machine()
    const seeded = await seed(clean)
    fillMirror(clean)
    const share = await clean.portability.exportWorkspace(seeded.ws.id, { mode: 'share', outPath: path.join(await tempDir(), 's.foreman') })
    expect(share.transcripts).toBe(0)
    const withIt = await clean.portability.exportWorkspace(seeded.ws.id, { mode: 'share', includeTranscripts: true, outPath: path.join(await tempDir(), 't.foreman') })
    expect(withIt.transcripts).toBe(1)
    const preview = await stage(await machine(), withIt.path)
    expect(preview.tabs[0].nativeResume).toBe(true)
  })
})

describe('what the SDK is asked to do', () => {
  const callbacks = () =>
    ({ item: vi.fn(), sessionStarted: vi.fn(), assistantMessage: vi.fn(), approveTool: vi.fn(), reviewPlan: vi.fn(), ask: vi.fn(), planModeChanged: vi.fn(), autoAcceptEdits: vi.fn(), usage: vi.fn(), mirrorError: vi.fn(), finished: vi.fn() }) satisfies TurnCallbacks
  const request: TurnRequest = { turnId: 't', prompt: 'hi', cwd: '/repo', env: {}, model: 'claude-opus-5-5', fastMode: false, planMode: false, approvals: 'never-ask', systemPromptAppend: '' }

  function fakeQuery(messages: Partial<SDKMessage>[]) {
    sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void (async () => {
        for await (const _m of prompt) void _m
      })()
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m
        },
        interrupt: vi.fn(async () => undefined),
        getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 2 })),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined)
      }
    })
  }
  const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1, result: 'ok', uuid: 'u', session_id: 's' } as unknown as Partial<SDKMessage>

  it('passes the store with resume, forks when asked, and surfaces mirror errors', async () => {
    const { mirror } = await freshMirror()
    fakeQuery([
      { type: 'system', subtype: 'mirror_error', error: 'disk full', key: { projectKey: 'p', sessionId: 'native-1', subpath: 'subagents/agent-1' }, uuid: 'e', session_id: 'native-1' } as unknown as Partial<SDKMessage>,
      result
    ])
    const cb = callbacks()
    await claudeDriver.createTurn({ ...request, resume: 'native-1', sessionStore: mirror, forkOnResume: true }, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    expect(options).toMatchObject({ resume: 'native-1', forkSession: true, sessionStore: mirror })
    expect(cb.mirrorError).toHaveBeenCalledWith('native-1', 'subagents/agent-1', 'disk full')
    // Without them nothing is mirrored or forked.
    fakeQuery([result])
    await claudeDriver.createTurn(request, callbacks()).run()
    expect(sdk.query.mock.calls[1][0].options).toMatchObject({ sessionStore: undefined, forkSession: undefined })
  })

  it('mirrors a new chat, resumes from the store only when the mirror is complete, and never after a rewind', async () => {
    const { mirror } = await freshMirror()
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (req, cb) => void (seen.push(req), cb.finished({ ok: true }))))
    const { sessions, session } = await setupSessions({ mirror })
    await sessions.deliver(session.id, 'first')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].sessionStore).toBe(mirror)
    expect(seen[0].resume).toBeUndefined()

    // A resumed chat whose mirror is missing or incomplete resumes from the local file.
    session.agentSessionId = 'old-session'
    await vi.waitFor(() => expect(session.status).toBe('idle'))
    await sessions.deliver(session.id, 'second')
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toMatchObject({ resume: 'old-session', sessionStore: undefined })

    // Complete: the store goes along.
    await mirror.append({ projectKey: 'p', sessionId: 'old-session' }, [user('a')])
    await vi.waitFor(() => expect(session.status).toBe('idle'))
    await sessions.deliver(session.id, 'third')
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen[2].sessionStore).toBe(mirror)

    // After a rewind (fork) the mirror is not trusted.
    session.resumeAt = 'some-uuid'
    await vi.waitFor(() => expect(session.status).toBe('idle'))
    await sessions.deliver(session.id, 'fourth')
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    expect(seen[3].sessionStore).toBeUndefined()
  })

  it('forks an imported copy once and then stops trusting its mirror', async () => {
    const { mirror } = await freshMirror()
    const seen: TurnRequest[] = []
    registerDriver(fakeDriver(async (req, cb) => void (seen.push(req), cb.sessionStarted('forked-session'), cb.finished({ ok: true }))))
    const { sessions, session } = await setupSessions({ mirror })
    await mirror.append({ projectKey: pendingKey('ws'), sessionId: 'native-1' }, [user('a')])
    Object.assign(session, { agentSessionId: 'native-1', importedMode: 'native', forkOnResume: true })
    await sessions.deliver(session.id, 'go')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ resume: 'native-1', forkOnResume: true, sessionStore: mirror })
    await vi.waitFor(() => expect(session.nativeFork).toBe(true))
    expect(session).toMatchObject({ agentSessionId: 'forked-session', forkOnResume: undefined })
    await vi.waitFor(() => expect(session.status).toBe('idle'))
    await sessions.deliver(session.id, 'again')
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toMatchObject({ resume: 'forked-session', sessionStore: undefined, forkOnResume: undefined })
  })
})
