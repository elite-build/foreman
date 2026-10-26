import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestV2 } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { workspaceRunners } from '../src/cli/commands/workspace'
import { renderCommandHelp } from '../src/cli/help'
import { socketPath } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { CliCodedError, METHODS, startCliServer, tierCheck, type CliHost } from '../src/main/cliServer'
import { WORKSPACE_METHODS } from '../src/main/cli/workspaces'
import type { CliContext } from '../src/main/cli/methods'
import { defaultSettings } from '../src/main/store'
import { COMMON_OPTIONS, commandName, findCommand } from '../src/shared/cliCommands'
import { WORKSPACE_COMMANDS } from '../src/shared/cliCommandsOps'
import type { NewResult, WsArchiveResult, WsListResult, WsNoteResult, WsPathResult, WsShowResult } from '../src/shared/cli/workspaces'
import type { Api, ArchivePreview, MainEvent, Repo, Session, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: '2026-10-01T10:00:00.000Z', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session

const ctx = (token?: string, progress: string[] = []): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: (text) => void progress.push(text) })

const preview = (patch: Partial<ArchivePreview> = {}): ArchivePreview => ({ kind: 'worktree', running: [], checksRunning: false, folder: '/x', branch: 'fix-login', uncommitted: 3, unpushed: { count: 2, against: 'origin/main' }, terminals: 1, hasArchiveScript: false, ...patch })

function rig(options: { workspaces?: Workspace[]; sessions?: Session[]; api?: Partial<Api>; host?: Partial<CliHost> } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const api = fakeApi({
    updateWorkspace: record('updateWorkspace') as Api['updateWorkspace'],
    archivePreview: record('archivePreview', preview()) as Api['archivePreview'],
    archiveWorkspace: record('archiveWorkspace', { ok: true }) as Api['archiveWorkspace'],
    unarchiveWorkspace: record('unarchiveWorkspace') as Api['unarchiveWorkspace'],
    forgetWorkspace: record('forgetWorkspace') as Api['forgetWorkspace'],
    activateWorkspace: record('activateWorkspace') as Api['activateWorkspace'],
    adoptWorktree: record('adoptWorktree', ws({ id: 'ws9', name: 'api-hotfix', branch: 'hotfix', path: '/trees/api-hotfix' })) as Api['adoptWorktree'],
    sendNote: record('sendNote', { disposition: 'queued', turnId: 'turn-9' }) as Api['sendNote'],
    saveNote: record('saveNote') as Api['saveNote'],
    closeAgentReport: record('closeAgentReport') as Api['closeAgentReport'],
    ...options.api
  })
  const workspaces = options.workspaces ?? [ws()]
  const host = stubHost({
    api,
    state: () => ({ repos: [repo], workspaces, sessions: options.sessions ?? [tab('s1', { title: 'Login bug' })], settings: defaultSettings() }),
    ...options.host
  })
  const call = async <T>(method: string, params: unknown, token?: string, progress?: string[]): Promise<T> => (await WORKSPACE_METHODS[method].handle(host, params, ctx(token, progress))) as T
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

/** A caller the app recognises as a live turn in `app`; `mayStart` is the repository's opt-in. */
const turnHost = (mayStart: boolean): Partial<CliHost> => ({
  identifyCaller: () => ({ kind: 'turn', session: tab('s1'), ws: ws(), turnId: 't', live: true }),
  agentsMayStart: () => mayStart
})

describe('workspace list and show', () => {
  it('lists live workspaces as the sidebar does, filtered by repository', async () => {
    const { call } = rig({ workspaces: [ws(), ws({ id: 'ws2', repoId: 'r2', name: 'tokyo' })] })
    const all = await call<WsListResult>('ws-list', {})
    expect(all.workspaces.map((r) => r.workspace).sort()).toEqual(['lisbon', 'tokyo'])
    const some = await call<WsListResult>('ws-list', { repo: 'app', cwd: '/' })
    expect(some.workspaces.map((r) => r.workspace)).toEqual(['lisbon'])
    expect(some.text).toContain('lisbon')
  })

  it('lists archived workspaces with when and what they changed', async () => {
    const { call } = rig({ workspaces: [ws(), ws({ id: 'ws3', name: 'gone', state: 'archived', archivedAt: '2026-10-20T08:00:00.000Z', archiveDiff: { at: 'x', files: 4, additions: 30, deletions: 2 } })] })
    const result = await call<WsListResult>('ws-list', { archived: true })
    expect(result.workspaces).toEqual([])
    expect(result.archived).toEqual([{ workspace: 'gone', id: 'ws3', repo: 'app', branch: 'fix-login', archivedAt: '2026-10-20T08:00:00.000Z', diff: { files: 4, additions: 30, deletions: 2 } }])
    expect(result.text).toContain('2026-10-20')
    expect(result.text).toContain('+30 -2 in 4 files')
  })

  it('shows state, branch, base, path, tabs, pull request, checks, reports, note and setup', async () => {
    const w = ws({
      pinned: true,
      status: 'in-review',
      prInfo: { number: 42, state: 'OPEN' as never, url: 'https://github.com/o/r/pull/42' },
      note: { text: 'be careful', revision: 3, updatedAt: 'x' },
      agentReports: [{ id: 'a1', kind: 'needs-input', text: 'which db?', at: '2026-10-02T00:00:00Z', workspaceId: 'ws1', via: 'cli' }],
      setupRun: { id: 'run1', startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z', steps: [{ name: 'install', command: 'npm i', status: 'done' }, { name: 'seed', command: 'x', status: 'failed' }] }
    })
    const { call } = rig({ workspaces: [w], sessions: [tab('s1', { title: 'Login bug' })] })
    const result = await call<WsShowResult>('ws-show', { workspace: 'lisbon', cwd: '/' })
    expect(result.workspace).toMatchObject({ id: 'ws1', name: 'lisbon', repo: 'app', branch: 'fix-login', base: 'main', path: '/x', kind: 'worktree', pinned: true, status: 'in-review' })
    expect(result.tabs).toHaveLength(1)
    expect(result.pr).toMatchObject({ number: 42, url: 'https://github.com/o/r/pull/42' })
    expect(result.openReports).toEqual([{ id: 'a1', kind: 'needs-input', text: 'which db?' }])
    expect(result.note).toEqual({ revision: 3, chars: 10 })
    expect(result.setup?.steps).toHaveLength(2)
    for (const word of ['fix-login', '(base main)', '/x', 'Login bug', '#42', 'needs-input', 'r3', '2 steps', 'pinned']) expect(result.text, word).toContain(word)
  })

  it('prints just the folder for ws-path, and says why when there is none', async () => {
    const { call } = rig({ workspaces: [ws(), ws({ id: 'ws2', name: 'old', state: 'history', path: undefined })] })
    const result = await call<WsPathResult>('ws-path', { workspace: 'lisbon', cwd: '/' })
    expect(result).toEqual({ path: '/x', text: '/x' })
    await expect(call('ws-path', { workspace: 'old', cwd: '/' })).rejects.toThrow('history only')
  })
})

describe('the workspace’s own fields', () => {
  it('renames, pins and unpins through updateWorkspace', async () => {
    const { call, calls } = rig()
    await call('ws-rename', { workspace: 'lisbon', cwd: '/', name: ' Login fix ' })
    await call('ws-pin', { workspace: 'lisbon', cwd: '/' })
    await call('ws-unpin', { workspace: 'lisbon', cwd: '/' })
    expect(calls).toEqual([['updateWorkspace', 'ws1', { name: 'Login fix' }], ['updateWorkspace', 'ws1', { pinned: true }], ['updateWorkspace', 'ws1', { pinned: false }]])
    expect((await failure(call('ws-rename', { workspace: 'lisbon', cwd: '/', name: '  ' }))).code).toBe('invalid')
  })

  it('sets a board status, and none clears it with null', async () => {
    const { call, calls } = rig()
    await call('ws-status', { workspace: 'lisbon', cwd: '/', status: 'none' })
    await call('ws-status', { workspace: 'lisbon', cwd: '/', status: 'In-Review' })
    expect(calls).toEqual([['updateWorkspace', 'ws1', { status: null }], ['updateWorkspace', 'ws1', { status: 'in-review' }]])
    const err = await failure(call('ws-status', { workspace: 'lisbon', cwd: '/', status: 'later' }))
    expect(err.code).toBe('invalid')
    expect(calls).toHaveLength(2)
  })
})

describe('archive', () => {
  it('returns the preview without archiving anything until it is confirmed', async () => {
    const { call, calls } = rig()
    const result = await call<WsArchiveResult>('ws-archive', { workspace: 'lisbon', cwd: '/', deleteBranch: true })
    expect(calls).toEqual([['archivePreview', 'ws1']])
    expect(result.needsConfirmation).toBe(true)
    expect(result.preview?.uncommitted).toBe(3)
    expect(result.text).toContain('3 files')
    expect(result.text).toContain('2 commits not on origin/main')
    expect(result.text).toContain('will be deleted')
    expect(result.text).toContain('Nothing was archived')
    expect(calls.some(([name]) => name === 'archiveWorkspace')).toBe(false)
  })

  it('archives once confirmed, with the branch and stopped tabs, and streams the steps as progress', async () => {
    let listener: ((event: MainEvent) => void) | undefined
    let unsubscribed = false
    const { call, calls } = rig({
      host: {
        onEvent: (l) => {
          listener = l
          return () => {
            unsubscribed = true
          }
        }
      },
      api: {
        archiveWorkspace: (async (...args: unknown[]) => {
          calls.push(['archiveWorkspace', ...args])
          listener?.({ type: 'archive-progress', workspaceId: 'other', progress: { step: 'stop', status: 'running' } })
          listener?.({ type: 'archive-progress', workspaceId: 'ws1', progress: { step: 'checkpoint', status: 'running' } })
          listener?.({ type: 'archive-progress', workspaceId: 'ws1', progress: { step: 'remove', status: 'done', detail: '/x' } })
          return { ok: true }
        }) as Api['archiveWorkspace']
      }
    })
    const progress: string[] = []
    const result = await call<WsArchiveResult>('ws-archive', { workspace: 'lisbon', cwd: '/', deleteBranch: true, stop: true, confirmed: true }, undefined, progress)
    expect(calls).toEqual([['archiveWorkspace', 'ws1', true, { stopTabs: true }]])
    expect(progress).toEqual(['checkpoint: running', 'remove: done (/x)'])
    expect(unsubscribed).toBe(true)
    expect(result.archived).toBe(true)
    expect(result.text).toContain('Archived lisbon')
  })

  it('reports a failed step as data and unsubscribes', async () => {
    let unsubscribed = false
    const { call } = rig({ host: { onEvent: () => () => void (unsubscribed = true) }, api: { archiveWorkspace: async () => ({ ok: false, step: 'script', detail: 'exit 1' }) } })
    const result = await call<WsArchiveResult>('ws-archive', { workspace: 'lisbon', cwd: '/', confirmed: true })
    expect(result.archived).toBe(false)
    expect(result.failed).toEqual({ step: 'script', detail: 'exit 1' })
    expect(result.text).toContain('Nothing was deleted')
    expect(unsubscribed).toBe(true)
  })

  it('unarchives and forgets only archived workspaces', async () => {
    const { call, calls } = rig({ workspaces: [ws(), ws({ id: 'ws3', name: 'gone', branch: 'gone-b', state: 'archived' })] })
    await call('ws-unarchive', { workspace: 'gone', cwd: '/' })
    await call('ws-forget', { workspace: 'gone-b', cwd: '/' })
    expect(calls).toEqual([['unarchiveWorkspace', 'ws3'], ['forgetWorkspace', 'ws3']])
    expect((await failure(call('ws-forget', { workspace: 'lisbon', cwd: '/' }))).code).toBe('not-found')
    expect(calls).toHaveLength(2)
  })

  it('activates a history-only workspace and refuses one that is not', async () => {
    const { call, calls } = rig({ workspaces: [ws({ state: 'history', path: undefined }), ws({ id: 'ws2', name: 'tokyo' })] })
    await call('ws-activate', { workspace: 'lisbon', cwd: '/' })
    expect(calls).toEqual([['activateWorkspace', 'ws1']])
    expect((await failure(call('ws-activate', { workspace: 'tokyo', cwd: '/' }))).code).toBe('invalid')
  })
})

describe('adopt, note, reports', () => {
  it('adopts a worktree with setup and a prompt, resolving the folder against cwd', async () => {
    const { call, calls } = rig()
    const result = await call<{ workspace: { name: string } }>('ws-adopt', { path: '../trees/api-hotfix', cwd: path.resolve('/app/sub'), setup: true, prompt: 'Pick up the hotfix', repo: 'app' })
    expect(calls).toEqual([['adoptWorktree', 'r1', path.resolve('/app/trees/api-hotfix'), { runSetup: true, prompt: 'Pick up the hotfix' }]])
    expect(result.workspace.name).toBe('api-hotfix')
  })

  it('refuses adopt with a prompt from an agent turn without the opt-in, but not adopt without one', async () => {
    const { call, calls } = rig({ host: turnHost(false) })
    const err = await failure(call('ws-adopt', { path: '/trees/a', cwd: '/', prompt: 'go', repo: 'app' }, 'tok'))
    expect(err.code).toBe('refused')
    expect(calls).toEqual([])
    await call('ws-adopt', { path: '/trees/a', cwd: '/', repo: 'app' }, 'tok')
    expect(calls).toHaveLength(1)
    const allowed = rig({ host: turnHost(true) })
    await allowed.call('ws-adopt', { path: '/trees/a', cwd: '/', prompt: 'go', repo: 'app' }, 'tok')
    expect(allowed.calls).toHaveLength(1)
  })

  it('reads, saves and sends the note, printing the receipt like send', async () => {
    const w = ws({ note: { text: 'be careful', revision: 2, updatedAt: 'x' } })
    const { call, calls } = rig({ workspaces: [w], sessions: [tab('s1', { title: 'A' }), tab('s2', { title: 'B' })] })
    expect((await call<WsNoteResult>('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'get' })).text).toBe('be careful')
    await call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'set', text: 'new note' })
    const sent = await call<WsNoteResult>('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'send', tab: 2 })
    expect(calls).toEqual([['saveNote', 'ws1', 'new note'], ['sendNote', 's2']])
    expect(sent.text).toBe('Queued to tab 2 (Claude · Opus 5.5) as turn turn-9')
    expect(sent.sent).toMatchObject({ tab: 2, session: 's2', turn: 'turn-9', disposition: 'queued' })
    // Two tabs and no --tab: it asks which.
    expect((await failure(call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'send' }))).code).toBe('ambiguous')
  })

  it('refuses note send without the opt-in and note set from any agent turn', async () => {
    const w = ws({ note: { text: 'be careful', revision: 2, updatedAt: 'x' } })
    const closed = rig({ workspaces: [w], host: turnHost(false) })
    expect((await failure(closed.call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'send' }, 'tok'))).code).toBe('refused')
    const open = rig({ workspaces: [w], host: turnHost(true) })
    await open.call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'send' }, 'tok')
    expect(open.calls).toEqual([['sendNote', 's1']])
    expect((await failure(open.call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'set', text: 'x' }, 'tok'))).code).toBe('refused')
    expect(open.calls).toHaveLength(1)
  })

  it('closes an open report by the start of its id and not a closed one', async () => {
    const reports = [
      { id: 'aaaa1111', kind: 'needs-input' as const, text: 'which db?', at: '2026-10-02T00:00:00Z', workspaceId: 'ws1', via: 'cli' as const },
      { id: 'bbbb2222', kind: 'stuck' as const, text: 'old', at: '2026-10-01T00:00:00Z', workspaceId: 'ws1', via: 'cli' as const, closed: { how: 'dismissed' as const, at: 'x' } }
    ]
    const { call, calls } = rig({ workspaces: [ws({ agentReports: reports })] })
    await call('ws-reports', { workspace: 'lisbon', cwd: '/', verb: 'close', id: 'aaaa' })
    expect(calls).toEqual([['closeAgentReport', 'ws1', 'aaaa1111', 'dismissed']])
    expect((await failure(call('ws-reports', { workspace: 'lisbon', cwd: '/', verb: 'close', id: 'bbbb2222' }))).code).toBe('not-found')
  })
})

describe('new', () => {
  const created = ws({ id: 'ws7', name: 'dark-mode', branch: 'dark-mode', path: '/trees/dark-mode' })
  function newRig(host: Partial<CliHost> = {}) {
    const calls: [string, ...unknown[]][] = []
    const rigged = rig({
      host: {
        createWorkspace: async (repoId, options) => (calls.push(['createWorkspace', repoId, options]), created),
        firstTurn: async () => ({ session: 's7', turn: 'turn-7' }),
        ...host
      }
    })
    return { ...rigged, calls }
  }
  const base = { prompt: 'Add a dark mode toggle', cwd: '/', repo: 'app' }

  it('starts a workspace from the prompt, waits for setup and reports the first turn', async () => {
    const { call, calls } = newRig()
    const result = await call<NewResult>('new', base)
    expect(calls).toEqual([['createWorkspace', 'r1', { prompt: 'Add a dark mode toggle', baseBranch: undefined, branch: { kind: 'new', name: undefined } }]])
    expect(result).toMatchObject({ repo: 'app', workspace: { id: 'ws7', branch: 'dark-mode', path: '/trees/dark-mode' }, session: 's7', turn: 'turn-7' })
    expect(result.text).toContain('turn       turn-7')
  })

  it('passes branch, base, loadout, attachments and cloud through', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'notes.md'), 'hi')
    const { call, calls } = newRig()
    await call('new', { ...base, cwd: dir, existing: 'feature/search', base: 'develop', loadout: 1, attach: ['notes.md'], cloud: true, noWait: true })
    const options = calls[0][2] as Record<string, unknown>
    expect(options).toMatchObject({ prompt: base.prompt, baseBranch: 'develop', branch: { kind: 'existing', name: 'feature/search' }, attachments: [path.join(dir, 'notes.md')], location: 'cloud' })
    expect(options.loadout).toEqual(defaultSettings().loadouts[0])
    await call('new', { ...base, direct: 'main' })
    expect((calls[1][2] as Record<string, unknown>).branch).toEqual({ kind: 'direct', name: 'main' })
    await call('new', { ...base, branch: 'my-branch' })
    expect((calls[2][2] as Record<string, unknown>).branch).toEqual({ kind: 'new', name: 'my-branch' })
  })

  it('refuses contradictory words, a missing attachment and a missing loadout before creating anything', async () => {
    const { call, calls } = newRig()
    expect((await failure(call('new', { ...base, existing: 'a', direct: 'b' }))).code).toBe('invalid')
    expect((await failure(call('new', { ...base, direct: 'b', cloud: true }))).code).toBe('invalid')
    expect((await failure(call('new', { ...base, attach: ['/definitely/not/here.md'] }))).code).toBe('invalid')
    expect((await failure(call('new', { ...base, loadout: 99 }))).code).toBe('invalid')
    expect((await failure(call('new', { ...base, prompt: '  ' }))).code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('holds the first message when setup fails, unless started anyway', async () => {
    const started: string[] = []
    const { call } = newRig({ setupOutcome: async () => ({ failed: true, held: true, logTail: 'npm ERR!' }), startHeldMessage: async (id) => void started.push(id) })
    const held = await call<NewResult>('new', base)
    expect(held.held).toEqual({ logTail: 'npm ERR!' })
    expect(held.turn).toBeUndefined()
    const anyway = await call<NewResult>('new', { ...base, startAnyway: true })
    expect(anyway.startedAnyway).toBe(true)
    expect(started).toEqual(['ws7'])
    expect(anyway.turn).toBe('turn-7')
  })

  it('is refused with a turn token and no opt-in, like run', async () => {
    const closed = newRig(turnHost(false))
    expect((await failure(closed.call('new', base, 'tok'))).code).toBe('refused')
    expect(closed.calls).toEqual([])
    // A token Foreman doesn’t recognise can’t start work either.
    const unknown = newRig()
    expect((await failure(unknown.call('new', base, 'tok'))).code).toBe('refused')
    expect(unknown.calls).toEqual([])
    const open = newRig(turnHost(true))
    await open.call('new', base, 'tok')
    expect(open.calls).toHaveLength(1)
  })
})

describe('policy and the socket', () => {
  const SPEC_OF: Record<string, string> = {
    new: 'new',
    'ws-list': 'workspace list',
    'ws-show': 'workspace show',
    'ws-path': 'workspace path',
    'ws-open': 'workspace open',
    'ws-rename': 'workspace rename',
    'ws-pin': 'workspace pin',
    'ws-unpin': 'workspace unpin',
    'ws-status': 'workspace status',
    'ws-archive': 'workspace archive',
    'ws-unarchive': 'workspace unarchive',
    'ws-forget': 'workspace forget',
    'ws-activate': 'workspace activate',
    'ws-adopt': 'workspace adopt',
    'ws-setup': 'workspace setup',
    'ws-note': 'workspace note',
    'ws-usage': 'workspace usage',
    'ws-spotlight': 'workspace spotlight',
    'ws-docker': 'workspace docker',
    'ws-alerts': 'workspace alerts',
    'ws-reports': 'workspace reports'
  }

  it('gives each method the tier its command declares, and every command a method', () => {
    expect(Object.keys(WORKSPACE_METHODS).sort()).toEqual(Object.keys(SPEC_OF).sort())
    for (const [method, name] of Object.entries(SPEC_OF)) {
      const spec = WORKSPACE_COMMANDS.find((c) => commandName(c) === name)
      expect(spec, name).toBeTruthy()
      expect(WORKSPACE_METHODS[method].tier, method).toBe(spec!.tier)
    }
    expect(WORKSPACE_COMMANDS).toHaveLength(Object.keys(SPEC_OF).length)
  })

  it('refuses archive and forget from any agent turn, and reads need no token', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    for (const method of ['ws-archive', 'ws-forget']) {
      const refusal = tierCheck(method, WORKSPACE_METHODS[method].tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host)
      expect(refusal, method).toMatchObject({ code: 'refused' })
    }
    expect(tierCheck('ws-list', 'read', { v: 2, method: 'ws-list', params: {}, caller }, host)).toBeNull()
    expect(tierCheck('ws-archive', 'admin', { v: 2, method: 'ws-archive', params: {}, token: 'test-token' }, host)).toBeNull()
  })

  describe('over the socket', () => {
    let close: (() => void) | undefined
    afterEach(() => {
      close?.()
      for (const key of Object.keys(WORKSPACE_METHODS)) delete METHODS[key]
    })

    it('serves the workspace methods through the registry with codes and tiers', async () => {
      Object.assign(METHODS, WORKSPACE_METHODS)
      const dataDir = await tempDir()
      const { host, calls } = rig()
      const server = await startCliServer(socketPath(dataDir), host)
      close = () => server.close()
      const socket = socketPath(dataDir)
      const ask = <T>(method: string, params: unknown, options: Parameters<typeof requestV2>[3] = {}) => requestV2<T>(socket, method, params, { token: 'test-token', ...options })
      expect((await ask<WsPathResult>('ws-path', { workspace: 'lisbon', cwd: '/' })).path).toBe('/x')
      const plan = await ask<WsArchiveResult>('ws-archive', { workspace: 'lisbon', cwd: '/' })
      expect(plan.needsConfirmation).toBe(true)
      expect(calls).toEqual([['archivePreview', 'ws1']])
      await expect(ask('ws-path', { workspace: 'ghost', cwd: '/' })).rejects.toMatchObject({ code: 'not-found', exitCode: 8 })
      await expect(ask('ws-archive', { workspace: 'lisbon', cwd: '/' }, { caller: { sessionId: 's', turnId: 't', token: 'k' } })).rejects.toMatchObject({ code: 'refused', exitCode: 7 })
      await expect(ask('new', { prompt: 'x', cwd: '/' }, { caller: { sessionId: 's', turnId: 't', token: 'k' } })).rejects.toMatchObject({ code: 'refused' })
    })
  })
})

// ----- the command side -----

describe('the commands', () => {
  function fakeContext(args: string[], opts: Record<string, unknown> = {}, answers: Record<string, unknown> = {}, extra: Partial<Context> = {}) {
    const sent: [string, Record<string, unknown>][] = []
    const out: string[] = []
    const context: Context = {
      args,
      opts,
      json: Boolean(opts.json),
      quiet: false,
      yes: Boolean(opts.yes),
      cwd: '/work',
      send: (async (method: string, params?: unknown) => {
        sent.push([method, params as Record<string, unknown>])
        const answer = answers[method]
        return typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer
      }) as Context['send'],
      print: (value, text) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
      confirm: async () => true,
      note: () => undefined,
      progress: () => undefined,
      ...extra
    }
    return { context, sent, out }
  }

  const planAnswer: WsArchiveResult = { workspace: { id: 'ws1', name: 'lisbon' }, needsConfirmation: true, previewText: 'Archiving lisbon:\n  folder  /x', text: 'Archiving lisbon:\n  folder  /x\nNothing was archived. Run it again with --yes to archive.' }
  const doneAnswer: WsArchiveResult = { workspace: { id: 'ws1', name: 'lisbon' }, archived: true, text: 'Archived lisbon.' }

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('archive: asks for the preview, confirms, then calls again with confirmed', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const asked: string[] = []
    const { context, sent, out } = fakeContext(['lisbon'], { 'delete-branch': true, stop: true }, { 'ws-archive': (p: Record<string, unknown>) => (p.confirmed ? doneAnswer : planAnswer) }, { confirm: async (q) => (asked.push(q), true) })
    await workspaceRunners['workspace archive'](context)
    expect(sent.map(([method, params]) => [method, params.confirmed])).toEqual([['ws-archive', undefined], ['ws-archive', true]])
    expect(sent[1][1]).toMatchObject({ workspace: 'lisbon', deleteBranch: true, stop: true, cwd: '/work' })
    expect(shown).toHaveBeenCalledWith('Archiving lisbon:\n  folder  /x')
    expect(asked).toEqual(['Archive lisbon?'])
    expect(out).toEqual(['Archived lisbon.'])
  })

  it('archive: a no archives nothing and fails; a failed step sets the exit code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const declined = fakeContext(['lisbon'], {}, { 'ws-archive': planAnswer }, { confirm: async () => false })
    await workspaceRunners['workspace archive'](declined.context)
    expect(declined.sent).toHaveLength(1)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    const failed = fakeContext(['lisbon'], {}, { 'ws-archive': (p: Record<string, unknown>) => (p.confirmed ? { ...doneAnswer, archived: false, failed: { step: 'script', detail: 'exit 1' }, text: 'stopped' } : planAnswer) })
    await workspaceRunners['workspace archive'](failed.context)
    expect(process.exitCode).toBe(1)
  })

  it('archive: when it cannot ask, nothing is archived, and --json still gets the preview', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cannot = new Error('this needs confirmation')
    const { context, sent, out } = fakeContext(['lisbon'], { json: true }, { 'ws-archive': planAnswer }, {
      confirm: async () => {
        throw cannot
      }
    })
    await expect(workspaceRunners['workspace archive'](context)).rejects.toBe(cannot)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(out[0])).toMatchObject({ needsConfirmation: true })
  })

  it('forget asks first and does nothing on no', async () => {
    const yes = fakeContext(['gone'], { yes: true }, { 'ws-forget': { text: 'Forgot gone.' } })
    await workspaceRunners['workspace forget'](yes.context)
    expect(yes.sent).toEqual([['ws-forget', { workspace: 'gone', cwd: '/work' }]])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const no = fakeContext(['gone'], {}, {}, { confirm: async () => false })
    await workspaceRunners['workspace forget'](no.context)
    expect(no.sent).toEqual([])
  })

  it('note set takes words, a file or stdin, but only one of them', async () => {
    const answers = { 'ws-note': { text: 'ok' } }
    const words = fakeContext(['set', 'lisbon', 'use', 'v2'], {}, answers)
    await workspaceRunners['workspace note'](words.context)
    expect(words.sent[0][1]).toMatchObject({ workspace: 'lisbon', verb: 'set', text: 'use v2' })
    const dir = await tempDir()
    await writeFile(path.join(dir, 'n.md'), 'from file')
    const file = fakeContext(['set', 'lisbon'], { file: 'n.md' }, answers, { cwd: dir })
    await workspaceRunners['workspace note'](file.context)
    expect(file.sent[0][1]).toMatchObject({ verb: 'set', text: 'from file' })
    await expect(workspaceRunners['workspace note'](fakeContext(['set', 'lisbon', 'x'], { file: 'n.md' }, answers, { cwd: dir }).context)).rejects.toThrow('one way')
    await expect(workspaceRunners['workspace note'](fakeContext(['set', 'lisbon'], {}, answers).context)).rejects.toThrow('Give the note')
    const get = fakeContext(['lisbon'], {}, answers)
    await workspaceRunners['workspace note'](get.context)
    expect(get.sent[0][1]).toMatchObject({ verb: 'get' })
  })

  it('setup, docker, alerts and reports take the verb where the plan puts it', async () => {
    const answers = { 'ws-setup': { text: '' }, 'ws-docker': { text: '' }, 'ws-alerts': { text: '' }, 'ws-reports': { text: '' } }
    const a = fakeContext(['rerun', 'lisbon'], {}, answers)
    await workspaceRunners['workspace setup'](a.context)
    expect(a.sent[0][1]).toMatchObject({ workspace: 'lisbon', verb: 'rerun' })
    const b = fakeContext(['lisbon'], { tail: '20' }, answers)
    await workspaceRunners['workspace setup'](b.context)
    expect(b.sent[0][1]).toMatchObject({ workspace: 'lisbon', verb: 'log', tail: 20 })
    const c = fakeContext(['lisbon', 'remove'], {}, answers)
    await workspaceRunners['workspace docker'](c.context)
    expect(c.sent[0][1]).toMatchObject({ verb: 'remove' })
    const d = fakeContext(['lisbon', 'dismiss', '3f9a'], {}, answers)
    await workspaceRunners['workspace alerts'](d.context)
    expect(d.sent[0]).toEqual(['ws-alerts', { workspace: 'lisbon', cwd: '/work', verb: 'dismiss', id: '3f9a' }])
    await expect(workspaceRunners['workspace reports'](fakeContext(['lisbon', 'drop'], {}, answers).context)).rejects.toThrow('isn’t a reports command')
  })

  it('new sends the prompt and its options, and without --wait prints the result', async () => {
    const result: NewResult = { repo: 'app', prompt: 'x', workspace: { id: 'ws7', name: 'dark-mode', branch: 'dark-mode' }, turn: 'turn-7', text: 'Started dark-mode in app' }
    const { context, sent, out } = fakeContext(['Add', 'a', 'toggle'], { repo: 'app', loadout: '2', attach: ['a.md', 'b.md'], 'no-wait': true, cloud: true }, { new: result })
    await workspaceRunners.new(context)
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toMatchObject({ prompt: 'Add a toggle', repo: 'app', loadout: 2, attach: ['a.md', 'b.md'], noWait: true, cloud: true, cwd: '/work' })
    expect(out).toEqual(['Started dark-mode in app'])
  })

  it('new --wait waits for the first turn and exits with its outcome', async () => {
    const result: NewResult = { repo: 'app', prompt: 'x', workspace: { id: 'ws7', name: 'dark-mode', branch: 'dark-mode' }, session: 's7', turn: 'turn-7', text: 'Started dark-mode in app' }
    const waited = { workspace: { id: 'ws7', name: 'dark-mode' }, session: 's7', turn: 'turn-7', outcome: 'error', checks: 'none' }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { context, sent } = fakeContext(['Fix it'], { wait: true, timeout: '60' }, { new: result, wait: waited })
    await workspaceRunners.new(context)
    expect(sent.map(([m]) => m)).toEqual(['new', 'wait'])
    expect(sent[1][1]).toEqual({ turn: 'turn-7', timeoutSec: 60 })
    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join('\n')).toContain('Turn turn-7 failed')
  })

  it('new needs words and refuses --wait with --no-wait', async () => {
    await expect(workspaceRunners.new(fakeContext([], {}).context)).rejects.toThrow('Say what to work on')
    await expect(workspaceRunners.new(fakeContext(['x'], { wait: true, 'no-wait': true }).context)).rejects.toThrow('can’t be used together')
  })
})

describe('the command table', () => {
  it('resolves the ws alias to the workspace commands', () => {
    const found = findCommand(['ws', 'archive', 'api', '--yes'], WORKSPACE_COMMANDS)
    expect(found).toMatchObject({ spec: { path: ['workspace', 'archive'] }, rest: ['api', '--yes'] })
    expect(findCommand(['workspace', 'list'], WORKSPACE_COMMANDS)).toMatchObject({ spec: { path: ['workspace', 'list'] } })
    expect(findCommand(['new', 'do it'], WORKSPACE_COMMANDS)).toMatchObject({ spec: { path: ['new'] }, rest: ['do it'] })
  })

  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of WORKSPACE_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(workspaceRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      expect(help).toContain(spec.usage)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) expect(help).toContain(example)
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, name).toBe(shorts.length)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(workspaceRunners).sort()).toEqual(WORKSPACE_COMMANDS.map(commandName).sort())
  })

  it('marks forget as something the assistant only shows, and parses the options it declares', () => {
    expect(WORKSPACE_COMMANDS.find((c) => commandName(c) === 'workspace forget')?.noAssistant).toBeTruthy()
    const archive = WORKSPACE_COMMANDS.find((c) => commandName(c) === 'workspace archive')!
    expect(parseCommandArgs(archive, ['api', '--delete-branch', '--stop', '--yes'])).toMatchObject({ positionals: ['api'], opts: { 'delete-branch': true, stop: true, yes: true } })
    expect(() => parseCommandArgs(archive, ['api', '--tab', '2'])).toThrow('doesn’t take --tab')
    const created = WORKSPACE_COMMANDS.find((c) => commandName(c) === 'new')!
    expect(parseCommandArgs(created, ['Do it', '--attach', 'a.md', '--attach', 'b.md', '-l', '2', '-o']).opts).toMatchObject({ attach: ['a.md', 'b.md'], loadout: '2', open: true })
  })
})
