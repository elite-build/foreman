import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestV2 } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { gitRunners } from '../src/cli/commands/git'
import { renderCommandHelp } from '../src/cli/help'
import { confirm } from '../src/cli/output'
import { socketPath } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { GIT_METHODS } from '../src/main/cli/git'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, METHODS, startCliServer, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { COMMON_OPTIONS, commandName, findCommand } from '../src/shared/cliCommands'
import { GIT_COMMANDS } from '../src/shared/cliCommandsGit'
import { diffStatText, parseDiffScope, type AutoFixResult, type CommentsResult, type DiffResult, type GitActionResult, type GitMergeResult, type GitRevertResult, type PrResult, type PrTabResult, type ThreadsResult } from '../src/shared/cli/git'
import type { Api, AutoFixPreview, DiffComment, DiffFile, GitStatus, Repo, ReviewThread, Session, Workspace, WorkspaceDiff } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: '2026-10-01T10:00:00.000Z', ...patch }) as Workspace
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5[1m]', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session

const ctx = (token?: string, progress: string[] = []): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { sessionId: 's', turnId: 't', token } : undefined, signal: undefined, progress: (text) => void progress.push(text) })

const status = (patch: Partial<GitStatus> = {}): GitStatus => ({ branch: 'fix-login', baseRef: 'origin/main', upstream: 'origin/fix-login', hasRemote: true, ahead: 0, behind: 0, aheadBase: 1, behindBase: 0, uncommitted: 0, conflicted: false, onBase: false, ghAvailable: true, primary: { action: null, label: 'Nothing to do' }, ...patch })

const file = (path: string, additions: number, deletions: number, patch: Partial<DiffFile> = {}): DiffFile => ({
  path,
  status: 'modified',
  binary: false,
  additions,
  deletions,
  hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ type: 'ctx', text: 'keep', oldNo: 1, newNo: 1 }, { type: 'del', text: 'old', oldNo: 2 }, { type: 'add', text: 'new', newNo: 2 }] }],
  ...patch
})

const diffOf = (files: DiffFile[], patch: Partial<WorkspaceDiff> = {}): WorkspaceDiff => ({ baseRef: 'origin/main', scope: 'all', files, truncated: false, ...patch })

const comment = (id: string, patch: Partial<DiffComment> = {}): DiffComment => ({ id, workspaceId: 'ws1', file: 'src/login.ts', line: 42, body: 'Handle empty', author: 'user', state: 'pending', createdAt: '2026-10-02T09:00:00.000Z', ...patch })

const preview = (patch: Partial<AutoFixPreview> = {}): AutoFixPreview => ({ sessionId: 's1', agent: 'claude', permissions: 'edit files and run tests', prompt: 'Fix the failing checks.', perHead: 2, perPr: 5, maxMinutes: 20, pr: 'PR #12', ...patch })

function rig(options: { workspaces?: Workspace[]; sessions?: Session[]; api?: Partial<Api>; host?: Partial<CliHost>; comments?: DiffComment[] } = {}) {
  const calls: [string, ...unknown[]][] = []
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const comments = options.comments ?? []
  const sessions = options.sessions ?? [tab('s1', { title: 'Login bug' })]
  const api = fakeApi({
    gitStatus: record('gitStatus', status()) as Api['gitStatus'],
    gitAction: record('gitAction', { disposition: 'started', turnId: 'turn-1' }) as Api['gitAction'],
    revertFile: record('revertFile') as Api['revertFile'],
    getDiff: record('getDiff', diffOf([file('src/login.ts', 12, 3), file('notes.md', 4, 0, { status: 'added' })])) as Api['getDiff'],
    refreshPullRequest: record('refreshPullRequest', 'ok') as Api['refreshPullRequest'],
    setPrWatch: record('setPrWatch') as Api['setPrWatch'],
    fixCi: record('fixCi', 's1') as Api['fixCi'],
    resolveBaseMoved: record('resolveBaseMoved', 's1') as Api['resolveBaseMoved'],
    ackCiFailure: record('ackCiFailure') as Api['ackCiFailure'],
    autoFixPreview: record('autoFixPreview', preview()) as Api['autoFixPreview'],
    setAutoFix: record('setAutoFix') as Api['setAutoFix'],
    addComment: (async (...args: unknown[]) => {
      calls.push(['addComment', ...args])
      comments.push(comment('c-new-0001', { file: args[1] as string, line: args[2] as number, body: args[3] as string }))
    }) as Api['addComment'],
    updateComment: (async (id: string, patch: { body?: string; state?: DiffComment['state'] }) => {
      calls.push(['updateComment', id, patch])
      Object.assign(comments.find((c) => c.id === id)!, patch)
    }) as Api['updateComment'],
    deleteComment: record('deleteComment') as Api['deleteComment'],
    ...options.api
  })
  const workspaces = options.workspaces ?? [ws()]
  const host = stubHost({
    api,
    state: () => ({ repos: [repo], workspaces, sessions, settings: defaultSettings() }),
    snapshot: () => ({ comments }) as never,
    resolvedRepoSettings: () => ({ values: { archiveOnMerge: false }, sources: {}, inherited: {} }) as never,
    ...options.host
  })
  const call = async <T>(method: string, params: unknown, token?: string, progress?: string[]): Promise<T> => (await GIT_METHODS[method].handle(host, params, ctx(token, progress))) as T
  return { host, calls, call, sessions, comments }
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

const names = (calls: [string, ...unknown[]][]) => calls.map((c) => c[0])

describe('git actions', () => {
  it('commit sends the message to the only tab and prints the turn id with its tab', async () => {
    const { call, calls } = rig()
    const result = await call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' })
    expect(calls).toEqual([['gitAction', 'ws1', 'commit-and-push', 's1']])
    expect(result).toMatchObject({ action: 'commit-and-push', tab: 1, session: 's1', turn: 'turn-1', disposition: 'started' })
    expect(result.text).toBe('Started turn turn-1 in tab 1: commit and push')
  })

  it('says queued when the message waits behind a running turn, and done for an action with no message', async () => {
    const queued = rig({ api: { gitAction: (async () => ({ disposition: 'queued', turnId: 'turn-2' })) as Api['gitAction'] } })
    expect((await queued.call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'fix-errors' })).text).toBe('Queued turn turn-2 in tab 1 behind the running one: fix errors')
    const plain = rig({ api: { gitAction: (async () => null) as Api['gitAction'] } })
    const done = await plain.call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'push' })
    expect(done.text).toBe('Done: push')
    expect(done.turn).toBeUndefined()
  })

  it('needs --tab when there are several tabs, and passes the chosen one', async () => {
    const { call, calls } = rig({ sessions: [tab('s1'), tab('s2', { title: 'Second' })] })
    const error = await failure(call('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' }))
    expect(error.code).toBe('ambiguous')
    expect(error.message).toContain('--tab')
    expect(calls).toEqual([])
    const result = await call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push', tab: 2 })
    expect(calls).toEqual([['gitAction', 'ws1', 'commit-and-push', 's2']])
    expect(result.tab).toBe(2)
  })

  it('lets the action open a tab when there is none', async () => {
    const { call, calls } = rig({ sessions: [] })
    await call('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' })
    expect(calls).toEqual([['gitAction', 'ws1', 'commit-and-push', undefined]])
  })

  it('review reports the new tab its first turn runs in', async () => {
    const sessions = [tab('s1')]
    const { call, calls } = rig({
      sessions,
      api: {
        gitAction: (async (...args: unknown[]) => {
          calls.push(['gitAction', ...args])
          sessions.push(tab('s9', { title: 'Code review' }))
          return { disposition: 'started', turnId: 'turn-9' }
        }) as Api['gitAction']
      }
    })
    const result = await call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'review' })
    expect(result).toMatchObject({ tab: 2, session: 's9', turn: 'turn-9' })
    expect(result.text).toBe('Started turn turn-9 in tab 2: review')
  })

  it('refuses commit from an agent turn without the repository’s opt-in, as send is refused, and nothing is sent', async () => {
    const { call, calls } = rig({ host: turnHost(false) })
    for (const action of ['commit-and-push', 'review', 'fix-errors', 'resolve-conflicts', 'create-pr', 'create-draft-pr']) {
      const error = await failure(call('git-action', { workspace: 'lisbon', cwd: '/', action }, 'k'))
      expect(error.code, action).toBe('refused')
      expect(error.message, action).toContain('queue messages')
    }
    expect(calls).toEqual([])
  })

  it('allows commit from an agent turn when the repository opted in, and from a caller with no token', async () => {
    const allowed = rig({ host: turnHost(true) })
    expect((await allowed.call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' }, 'k')).turn).toBe('turn-1')
    const person = rig({ host: turnHost(false) })
    expect((await person.call<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' })).turn).toBe('turn-1')
  })

  it('refuses a call with a token Foreman does not recognise, like send', async () => {
    const { call } = rig({ host: { identifyCaller: () => null } })
    expect((await failure(call('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' }, 'forged'))).message).toContain('doesn’t recognise')
  })

  it('lets an agent turn push, mark ready and open the PR without the opt-in: they send nothing to a chat', async () => {
    const { call, calls } = rig({ host: turnHost(false), api: { gitAction: (async (...args: unknown[]) => void calls.push(['gitAction', ...args]) as unknown as null) as Api['gitAction'] } })
    for (const action of ['push', 'ready-for-review', 'open-pr', 'create-pr-web']) await call('git-action', { workspace: 'lisbon', cwd: '/', action }, 'k')
    expect(calls.map((c) => c[2])).toEqual(['push', 'ready-for-review', 'open-pr', 'create-pr-web'])
  })

  it('pull needs the opt-in from an agent only when it would hand the merge to a chat', async () => {
    const clean = rig({ host: turnHost(false) })
    await clean.call('git-action', { workspace: 'lisbon', cwd: '/', action: 'pull' }, 'k')
    expect(names(clean.calls)).toEqual(['gitStatus', 'gitAction'])
    const dirty = rig({ host: turnHost(false), api: { gitStatus: (async () => status({ uncommitted: 3 })) as Api['gitStatus'] } })
    expect((await failure(dirty.call('git-action', { workspace: 'lisbon', cwd: '/', action: 'pull' }, 'k'))).code).toBe('refused')
    const diverged = rig({ host: turnHost(true), api: { gitStatus: (async () => status({ ahead: 1, behind: 2 })) as Api['gitStatus'] } })
    await diverged.call('git-action', { workspace: 'lisbon', cwd: '/', action: 'pull' }, 'k')
    expect(names(diverged.calls)).toEqual(['gitAction'])
  })

  it('does not take merge, automerge or archive here, or an unknown action', async () => {
    const { call, calls } = rig()
    for (const action of ['merge', 'automerge', 'archive', 'rerun-checks', 'nope']) expect((await failure(call('git-action', { workspace: 'lisbon', cwd: '/', action }))).code, action).toBe('invalid')
    expect(calls).toEqual([])
  })
})

describe('merge and revert', () => {
  const pr = { number: 12, url: 'https://github.com/o/r/pull/12', title: 'Fix login', state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE' as const, baseRefName: 'main', checks: [{ name: 'ci', state: 'success' as const }], reviewDecision: 'APPROVED' }

  it('merge shows what it would merge and does nothing until confirmed', async () => {
    const { call, calls } = rig({ api: { gitStatus: (async () => status({ pr })) as Api['gitStatus'] } })
    const plan = await call<GitMergeResult>('git-merge', { workspace: 'lisbon', cwd: '/' })
    expect(plan.needsConfirmation).toBe(true)
    expect(plan.previewText).toContain('PR #12 “Fix login” into main')
    expect(plan.previewText).toContain('passed (1 of 1)')
    expect(names(calls)).not.toContain('gitAction')
    const done = await call<GitMergeResult>('git-merge', { workspace: 'lisbon', cwd: '/', confirmed: true })
    expect(done.merged).toBe(true)
    expect(calls).toEqual([['gitAction', 'ws1', 'merge']])
  })

  it('automerge uses its own action, and says when the workspace is archived afterwards', async () => {
    const auto = rig({ api: { gitStatus: (async () => status({ pr })) as Api['gitStatus'] } })
    expect((await auto.call<GitMergeResult>('git-merge', { workspace: 'lisbon', cwd: '/', auto: true })).previewText).toContain('Merge when checks pass')
    await auto.call('git-merge', { workspace: 'lisbon', cwd: '/', auto: true, confirmed: true })
    expect(auto.calls.at(-1)).toEqual(['gitAction', 'ws1', 'automerge'])
    const archiving = rig({ api: { gitStatus: (async () => status({ pr })) as Api['gitStatus'] }, host: { resolvedRepoSettings: () => ({ values: { archiveOnMerge: true }, sources: {}, inherited: {} }) as never } })
    expect((await archiving.call<GitMergeResult>('git-merge', { workspace: 'lisbon', cwd: '/' })).previewText).toContain('is archived')
  })

  it('refuses to merge when there is no open pull request', async () => {
    const none = rig()
    expect((await failure(none.call('git-merge', { workspace: 'lisbon', cwd: '/' }))).message).toContain('no pull request')
    const merged = rig({ api: { gitStatus: (async () => status({ pr: { ...pr, state: 'MERGED' } })) as Api['gitStatus'] } })
    expect((await failure(merged.call('git-merge', { workspace: 'lisbon', cwd: '/' }))).message).toContain('already merged')
  })

  it('revert lists the files and what is lost, reverts nothing, and then reverts each on confirmation', async () => {
    const { call, calls } = rig()
    const plan = await call<GitRevertResult>('git-revert', { workspace: 'lisbon', cwd: '/', files: ['src/login.ts', './notes.md'] })
    expect(plan.needsConfirmation).toBe(true)
    expect(plan.previewText).toContain('src/login.ts  +12 -3')
    expect(plan.previewText).toContain('notes.md  new file, deleted')
    expect(names(calls)).toEqual(['getDiff'])
    const done = await call<GitRevertResult>('git-revert', { workspace: 'lisbon', cwd: '/', files: ['src/login.ts', 'notes.md'], confirmed: true })
    expect(done.reverted).toBe(true)
    expect(calls.slice(1)).toEqual([['revertFile', 'ws1', 'src/login.ts'], ['revertFile', 'ws1', 'notes.md']])
  })

  it('revert refuses a file the branch did not change, and no files', async () => {
    const { call, calls } = rig()
    const error = await failure(call('git-revert', { workspace: 'lisbon', cwd: '/', files: ['src/login.ts', 'README.md'] }))
    expect(error.code).toBe('invalid')
    expect(error.message).toContain('README.md')
    expect((await failure(call('git-revert', { workspace: 'lisbon', cwd: '/', files: [] }))).code).toBe('invalid')
    expect(names(calls)).not.toContain('revertFile')
  })
})

describe('diff and commits', () => {
  it('--stat renders per-file counts and the total from a WorkspaceDiff', async () => {
    const { call, calls } = rig({ api: { getDiff: (async () => diffOf([file('src/a.ts', 12, 3), file('src/b.ts', 0, 7, { status: 'deleted' }), file('img.png', 0, 0, { binary: true, hunks: [] }), file('new.ts', 5, 0, { status: 'renamed', oldPath: 'old.ts' })])) as Api['getDiff'] } })
    const result = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', stat: true })
    expect(result.text).toBe(['M  src/a.ts         +12 -3', 'D  src/b.ts         +0 -7', 'M  img.png          binary', 'R  old.ts → new.ts  +5 -0', '4 files changed, +17 -10'].join('\n'))
    expect(result).toMatchObject({ additions: 17, deletions: 10, files: expect.any(Array) })
    expect(result.patch).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('--files prints names only, and the plain diff is unified text', async () => {
    const { call } = rig()
    expect((await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', files: true })).text).toBe('src/login.ts\nnotes.md')
    const full = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/' })
    expect(full.text).toContain('diff --git a/src/login.ts b/src/login.ts')
    expect(full.text).toContain('--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new')
    expect(full.text).toContain('new file')
    expect(full.text).toContain('--- /dev/null')
    expect(full.patch).toBe(full.text)
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', stat: true, files: true }))).code).toBe('invalid')
  })

  it('asks for the scope it was given and says why a source is empty', async () => {
    const { call, calls } = rig({ api: { getDiff: (async (...args: unknown[]) => (calls.push(['getDiff', ...args]), diffOf([], { unavailable: 'no-pr' }))) as Api['getDiff'] } })
    const empty = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', scope: 'pr' })
    expect(empty.text).toBe('Nothing to show: there is no pull request.')
    expect(empty.unavailable).toBe('no-pr')
    await call('diff', { workspace: 'lisbon', cwd: '/', scope: 'commit:3f9a1c2' })
    await call('diff', { workspace: 'lisbon', cwd: '/', scope: 'picked:aaaa111,bbbb222' })
    await call('diff', { workspace: 'lisbon', cwd: '/', scope: 'uncommitted' })
    await call('diff', { workspace: 'lisbon', cwd: '/', scope: 'branch' })
    expect(calls.map((c) => [c[2], c[3]])).toEqual([['pr', undefined], ['commit', ['3f9a1c2']], ['picked', ['aaaa111', 'bbbb222']], ['uncommitted', undefined], ['all', undefined]])
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', scope: 'everything' }))).code).toBe('invalid')
  })

  it('parses scope words, including picked with a space', () => {
    expect(parseDiffScope(undefined)).toEqual({ scope: 'all' })
    expect(parseDiffScope('picked abc1234, def5678')).toEqual({ scope: 'picked', commits: ['abc1234', 'def5678'] })
    expect(parseDiffScope('turn:7f3a')).toEqual({ scope: 'turn', turn: '7f3a' })
    expect(parseDiffScope('commit:xyz')).toBeNull()
    expect(diffStatText([])).toBe('No changes.')
  })

  it('a turn is counts only, and only a turn of this workspace', async () => {
    const turnStatus = vi.fn(async (id: string) => (id === 'other' ? { workspaceId: 'ws2', sessionId: 's', turnId: id, state: 'ended' as const } : { workspaceId: 'ws1', sessionId: 's1', turnId: id, state: 'ended' as const, delta: { files: [{ path: 'a.ts', additions: 3, deletions: 1 }], additions: 3, deletions: 1 } }))
    const { call, calls } = rig({ host: { turnStatus } })
    const result = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', scope: 'turn:t1' })
    expect(result.text).toContain('M  a.ts  +3 -1')
    expect(result.text).toContain('Counts only')
    expect(calls).toEqual([])
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', scope: 'turn:other' }))).code).toBe('not-found')
  })

  it('lists the branch’s commits', async () => {
    const { call } = rig({
      api: {
        branchCommits: (async () => ({
          baseRef: 'origin/main',
          mergeBase: 'abc',
          commits: [{ sha: '3f9a1c2d4e', subject: 'Fix login', author: 'Yatin', you: true, at: '2026-10-02T09:30:00.000Z', files: 2, additions: 12, deletions: 3, pushed: false }],
          more: false,
          uncommitted: { files: 2, staged: 1, additions: 4, deletions: 0 }
        })) as Api['branchCommits']
      }
    })
    const result = await call<{ text: string }>('commits', { workspace: 'lisbon', cwd: '/' })
    expect(result.text).toContain('uncommitted  2 files, 1 staged  +4 -0')
    expect(result.text).toContain('3f9a1c2  Fix login  Yatin (you)  2026-10-02 09:30  +12 -3  local')
  })
})

describe('comments', () => {
  it('lists, adds, edits, resolves and deletes, through the calls the panel makes', async () => {
    const { call, calls, comments } = rig({ comments: [comment('aaaa1111-0000'), comment('bbbb2222-0000', { author: 'agent', state: 'open', file: 'src/b.ts', line: 7, body: 'Check this' }), comment('cccc3333-0000', { workspaceId: 'other' })] })
    const list = await call<CommentsResult>('comments', { workspace: 'lisbon', cwd: '/' })
    expect(list.comments.map((c) => c.id)).toEqual(['aaaa1111-0000', 'bbbb2222-0000'])
    expect(list.text).toContain('aaaa1111  src/login.ts:42')

    const added = await call<CommentsResult>('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'src/login.ts', line: 10, body: '  Handle the empty case ' })
    expect(calls.at(-1)).toEqual(['addComment', 'ws1', 'src/login.ts', 10, 'Handle the empty case'])
    expect(added.comment).toMatchObject({ file: 'src/login.ts', line: 10, body: 'Handle the empty case' })
    expect(comments).toHaveLength(4)

    await call('comments', { workspace: 'lisbon', cwd: '/', verb: 'edit', id: 'aaaa1111', body: 'Better text' })
    expect(calls.at(-1)).toEqual(['updateComment', 'aaaa1111-0000', { body: 'Better text' }])
    await call('comments', { workspace: 'lisbon', cwd: '/', verb: 'resolve', id: 'bbbb2222' })
    expect(calls.at(-1)).toEqual(['updateComment', 'bbbb2222-0000', { state: 'resolved' }])
    const gone = await call<CommentsResult>('comments', { workspace: 'lisbon', cwd: '/', verb: 'delete', id: 'aaaa1111-0000' })
    expect(calls.at(-1)).toEqual(['deleteComment', 'aaaa1111-0000'])
    expect(gone.text).toContain('Deleted')
  })

  it('refuses what the panel would not: a file with no changes, a bad line, an empty text, a sent comment edited, an unknown id', async () => {
    const { call } = rig({ comments: [comment('aaaa1111-0000', { state: 'sent' }), comment('bbbb2222-0000', { author: 'agent', state: 'open' })] })
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'untouched.ts', line: 1, body: 'x' }))).message).toContain('no changes')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'src/login.ts', line: 0, body: 'x' }))).code).toBe('invalid')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'src/login.ts', line: 3, body: '  ' }))).code).toBe('invalid')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'edit', id: 'aaaa1111', body: 'y' }))).message).toContain('hasn’t been sent')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'edit', id: 'bbbb2222', body: 'y' }))).message).toContain('agent')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'delete', id: 'zzzz9999' }))).code).toBe('not-found')
    expect((await failure(call('comments', { workspace: 'lisbon', cwd: '/', verb: 'shout' }))).code).toBe('invalid')
  })
})

describe('pull requests', () => {
  it('prints what Foreman last read of the pull request, and says when it has not read one', async () => {
    const withPr = rig({ workspaces: [ws({ prInfo: { number: 12, state: 'OPEN', url: 'https://github.com/o/r/pull/12', facts: { readAt: '2026-10-02T09:30:00.000Z', provider: 'github', checks: 'failing', checksPassed: 2, checksTotal: 3, checksFailing: 1, requiredOnly: false, review: 'approved', approvedBy: ['sam'], mergeable: 'conflicts', draft: false } } })] })
    const result = await withPr.call<PrResult>('pr', { workspace: 'lisbon', cwd: '/' })
    expect(result.url).toBe('https://github.com/o/r/pull/12')
    expect(result.text).toContain('lisbon: PR #12')
    expect(result.text).toContain('failing  2 of 3 passed, 1 failing')
    expect(result.text).toContain('approved by sam')
    expect(result.text).toContain('conflicts with the base')
    expect((await rig().call<PrResult>('pr', { workspace: 'lisbon', cwd: '/' })).text).toBe('lisbon has no pull request yet.')
    expect(names(withPr.calls)).toEqual([])
  })

  it('refreshes, and turns watching on and off', async () => {
    const { call, calls } = rig({ api: { refreshPullRequest: (async () => 'paused') as Api['refreshPullRequest'] } })
    expect((await call<{ outcome: string; text: string }>('pr-refresh', { workspace: 'lisbon', cwd: '/' })).outcome).toBe('paused')
    await call('pr-watch', { workspace: 'lisbon', cwd: '/', kind: 'ci', on: true })
    await call('pr-watch', { workspace: 'lisbon', cwd: '/', kind: 'reviews', on: false })
    expect(calls).toEqual([['setPrWatch', 'ws1', 'ci', true], ['setPrWatch', 'ws1', 'reviews', false]])
    expect((await failure(call('pr-watch', { workspace: 'lisbon', cwd: '/', kind: 'lint', on: true }))).code).toBe('invalid')
  })

  it('fix-ci and base-moved go to the only tab, a chosen tab or a new one, and need the opt-in from an agent', async () => {
    const { call, calls } = rig({ sessions: [tab('s1'), tab('s2', { queue: [{ turnId: 'turn-5' } as never] })], api: { fixCi: (async (...args: unknown[]) => (calls.push(['fixCi', ...args]), 's2')) as Api['fixCi'] } })
    expect((await failure(call('pr-fix-ci', { workspace: 'lisbon', cwd: '/' }))).code).toBe('ambiguous')
    const picked = await call<PrTabResult>('pr-fix-ci', { workspace: 'lisbon', cwd: '/', tab: 2 })
    expect(calls).toEqual([['fixCi', 'ws1', 's2']])
    expect(picked).toMatchObject({ tab: 2, session: 's2', turn: 'turn-5' })
    await call('pr-fix-ci', { workspace: 'lisbon', cwd: '/', new: true })
    expect(calls.at(-1)).toEqual(['fixCi', 'ws1', 'new'])
    expect((await failure(call('pr-fix-ci', { workspace: 'lisbon', cwd: '/', new: true, tab: 1 }))).code).toBe('invalid')
    await call('base-moved', { workspace: 'lisbon', cwd: '/', new: true })
    expect(calls.at(-1)).toEqual(['resolveBaseMoved', 'ws1', 'new'])
  })

  it('sends nothing to a chat from an agent turn that may not start work', async () => {
    const { call, calls } = rig({ host: turnHost(false) })
    for (const method of ['pr-fix-ci', 'base-moved']) expect((await failure(call(method, { workspace: 'lisbon', cwd: '/' }, 'k'))).code, method).toBe('refused')
    expect((await failure(call('pr-threads', { workspace: 'lisbon', cwd: '/', verb: 'send', ids: ['x'] }, 'k'))).code).toBe('refused')
    expect(calls).toEqual([])
  })

  const thread = (id: string, patch: Partial<ReviewThread> = {}): ReviewThread => ({ id, path: 'src/login.ts', line: 42, side: 'RIGHT', isResolved: false, isOutdated: false, comments: [{ id: 'k1', author: 'sam', body: 'Handle the empty case', url: '', createdAt: '', updatedAt: '', diffHunk: '' }], ...patch })

  it('lists review threads and sends the named ones, by the start of their ids, to a tab', async () => {
    const sent: unknown[][] = []
    const { call } = rig({
      sessions: [tab('s1'), tab('s2')],
      api: {
        reviewThreads: (async () => [thread('PRRT_aaaa1111'), thread('PRRT_bbbb2222', { isResolved: true })]) as Api['reviewThreads'],
        sendReviewThreads: (async (...args: unknown[]) => (sent.push(args), 's2')) as Api['sendReviewThreads']
      }
    })
    const list = await call<ThreadsResult>('pr-threads', { workspace: 'lisbon', cwd: '/' })
    expect(list.text).toContain('PRRT_aaaa1111  src/login.ts:42  open      sam  Handle the empty case')
    expect(list.text).toContain('resolved')
    const result = await call<ThreadsResult>('pr-threads', { workspace: 'lisbon', cwd: '/', verb: 'send', ids: ['PRRT_aaaa'], tab: 2 })
    expect(sent).toEqual([['ws1', ['PRRT_aaaa1111'], 's2']])
    expect(result).toMatchObject({ tab: 2, session: 's2' })
    expect((await failure(call('pr-threads', { workspace: 'lisbon', cwd: '/', verb: 'send', ids: ['PRRT_nope'], tab: 2 }))).code).toBe('not-found')
    expect((await failure(call('pr-threads', { workspace: 'lisbon', cwd: '/', verb: 'send', ids: [], tab: 2 }))).code).toBe('invalid')
  })

  it('acknowledges a CI failure', async () => {
    const { call, calls } = rig()
    await call('ack-ci', { workspace: 'lisbon', cwd: '/' })
    expect(calls).toEqual([['ackCiFailure', 'ws1']])
  })
})

describe('auto-fix', () => {
  it('on returns the dialog’s text first and changes nothing, then turns on with exactly what was shown', async () => {
    const { call, calls } = rig()
    const plan = await call<AutoFixResult>('pr-auto-fix', { workspace: 'lisbon', cwd: '/', verb: 'on', tab: 1 })
    expect(plan).toMatchObject({ needsConfirmation: true, enabled: false })
    expect(plan.previewText).toContain('PR #12')
    expect(plan.previewText).toContain('edit files and run tests')
    expect(plan.previewText).toContain('Fix the failing checks.')
    expect(plan.previewText).toContain('2 tries per commit, 5 per pull request, 20 minutes')
    expect(calls).toEqual([['autoFixPreview', 'ws1', 's1']])
    const shown = { sessionId: 's1', agent: 'claude', permissions: 'edit files and run tests', prompt: 'Fix the failing checks.' }
    const done = await call<AutoFixResult>('pr-auto-fix', { workspace: 'lisbon', cwd: '/', verb: 'on', tab: 1, shown })
    expect(done.enabled).toBe(true)
    expect(calls.at(-1)).toEqual(['setAutoFix', 'ws1', shown])
  })

  it('off clears the consent, and status reads it from the workspace', async () => {
    const off = rig()
    await off.call('pr-auto-fix', { workspace: 'lisbon', cwd: '/', verb: 'off' })
    expect(off.calls).toEqual([['setAutoFix', 'ws1', null]])
    const on = rig({ workspaces: [ws({ autoFix: { consent: { sessionId: 's1', agent: 'claude', permissions: 'p', prompt: 'q', perHead: 2, perPr: 5, maxMinutes: 20, at: '2026-10-02T09:30:00.000Z' }, pr: 'o/r#12', attempts: [], consumed: [], stopped: { reason: 'budget', at: '2026-10-02T10:00:00.000Z' } } })] })
    const status = await on.call<AutoFixResult>('pr-auto-fix', { workspace: 'lisbon', cwd: '/', verb: 'status' })
    expect(status.enabled).toBe(true)
    expect(status.text).toContain('in tab 1')
    expect(status.text).toContain('stopped budget')
    expect((await rig().call<AutoFixResult>('pr-auto-fix', { workspace: 'lisbon', cwd: '/', verb: 'status' })).text).toBe('Auto-fix CI is off for lisbon.')
    expect(on.calls).toEqual([])
  })
})

describe('policy and the socket', () => {
  const SPEC_OF: Record<string, string> = {
    'git-status': 'git status',
    'git-action': 'git commit',
    'git-merge': 'git pr merge',
    'git-revert': 'git revert',
    diff: 'diff',
    commits: 'commits',
    comments: 'comments',
    pr: 'git pr',
    'pr-refresh': 'git pr refresh',
    'pr-watch': 'git pr watch',
    'pr-fix-ci': 'git pr fix-ci',
    'pr-threads': 'git pr threads',
    'pr-auto-fix': 'git pr auto-fix',
    'base-moved': 'base-moved',
    'ack-ci': 'ack-ci'
  }

  it('gives each method the tier its command declares', () => {
    expect(Object.keys(GIT_METHODS).sort()).toEqual(Object.keys(SPEC_OF).sort())
    for (const [method, name] of Object.entries(SPEC_OF)) {
      const spec = GIT_COMMANDS.find((c) => commandName(c) === name)
      expect(spec, name).toBeTruthy()
      expect(GIT_METHODS[method].tier, method).toBe(spec!.tier)
    }
  })

  it('refuses merge, revert and auto-fix from any agent turn, and a script without the launch token', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'k' }
    for (const method of ['git-merge', 'git-revert', 'pr-auto-fix']) {
      expect(tierCheck(method, GIT_METHODS[method].tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host), method).toMatchObject({ code: 'refused' })
      expect(tierCheck(method, GIT_METHODS[method].tier, { v: 2, method, params: {} }, host), method).toMatchObject({ code: 'refused' })
      expect(tierCheck(method, GIT_METHODS[method].tier, { v: 2, method, params: {}, token: 'test-token' }, host), method).toBeNull()
    }
    for (const method of ['git-status', 'diff', 'commits', 'pr']) expect(tierCheck(method, GIT_METHODS[method].tier, { v: 2, method, params: {}, caller }, host), method).toBeNull()
  })

  describe('over the socket', () => {
    let close: (() => void) | undefined
    afterEach(() => {
      close?.()
      for (const key of Object.keys(GIT_METHODS)) delete METHODS[key]
    })

    it('serves the git methods with codes, tiers and the start policy', async () => {
      Object.assign(METHODS, GIT_METHODS)
      const dataDir = await tempDir()
      const { host, calls } = rig({ host: turnHost(false) })
      const socket = socketPath(dataDir)
      const server = await startCliServer(socket, host)
      close = () => server.close()
      const ask = <T>(method: string, params: unknown, options: Parameters<typeof requestV2>[3] = {}) => requestV2<T>(socket, method, params, { token: 'test-token', ...options })
      const caller = { sessionId: 's', turnId: 't', token: 'k' }
      expect((await ask<GitActionResult>('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' })).turn).toBe('turn-1')
      await expect(ask('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push' }, { caller })).rejects.toMatchObject({ code: 'refused', exitCode: 7 })
      await ask('git-action', { workspace: 'lisbon', cwd: '/', action: 'push' }, { caller })
      await expect(ask('git-merge', { workspace: 'lisbon', cwd: '/' }, { caller })).rejects.toMatchObject({ code: 'refused', exitCode: 7 })
      await expect(ask('git-status', { workspace: 'ghost', cwd: '/' })).rejects.toMatchObject({ code: 'not-found', exitCode: 8 })
      expect(calls.map((c) => c[2])).toEqual(['commit-and-push', 'push'])
    })
  })
})

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
      // The real question, as it behaves with no terminal: --yes answers, otherwise exit code 6.
      confirm: (question) => confirm(question, { yes: Boolean(opts.yes), interactive: false }),
      note: () => undefined,
      progress: () => undefined,
      ...extra
    }
    return { context, sent, out }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  const mergePlan: GitMergeResult = { workspace: { id: 'ws1', name: 'lisbon' }, auto: false, needsConfirmation: true, previewText: 'Merge PR #12', text: 'Merge PR #12\nNothing was merged.' }
  const merged: GitMergeResult = { workspace: { id: 'ws1', name: 'lisbon' }, auto: false, merged: true, text: 'Merged the pull request of lisbon.' }

  it('pr merge without --yes and no terminal exits 6 after printing the preview, and merges nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, sent } = fakeContext(['lisbon'], {}, { 'git-merge': mergePlan })
    await expect(gitRunners['git pr merge'](context)).rejects.toMatchObject({ exitCode: 6, code: 'needs-confirmation' })
    expect(sent).toEqual([['git-merge', { workspace: 'lisbon', cwd: '/work', auto: false }]])
    expect(console.error).toHaveBeenCalledWith('Merge PR #12')
  })

  it('pr merge --json with no way to ask still gets the preview as data, then exits 6', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, out } = fakeContext(['lisbon'], { json: true }, { 'git-merge': mergePlan })
    await expect(gitRunners['git pr merge'](context)).rejects.toMatchObject({ exitCode: 6 })
    expect(JSON.parse(out[0])).toMatchObject({ needsConfirmation: true })
  })

  it('pr merge --yes asks the app again with confirmed, and --auto says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { context, sent, out } = fakeContext(['lisbon'], { yes: true, auto: true }, { 'git-merge': (p: Record<string, unknown>) => (p.confirmed ? merged : mergePlan) })
    await gitRunners['git pr merge'](context)
    expect(sent.map(([, p]) => p)).toEqual([{ workspace: 'lisbon', cwd: '/work', auto: true }, { workspace: 'lisbon', cwd: '/work', auto: true, confirmed: true }])
    expect(out).toEqual(['Merged the pull request of lisbon.'])
  })

  it('git revert without --yes and no terminal exits 6 and reverts nothing; --yes reverts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const plan: GitRevertResult = { workspace: { id: 'ws1', name: 'lisbon' }, files: ['a.ts'], needsConfirmation: true, previewText: 'Put 1 file back', text: 'Put 1 file back\nNothing was reverted.' }
    const refused = fakeContext(['lisbon', 'a.ts'], {}, { 'git-revert': plan })
    await expect(gitRunners['git revert'](refused.context)).rejects.toMatchObject({ exitCode: 6 })
    expect(refused.sent).toHaveLength(1)
    const yes = fakeContext(['lisbon', 'a.ts', 'b.ts'], { yes: true }, { 'git-revert': (p: Record<string, unknown>) => (p.confirmed ? { ...plan, reverted: true, needsConfirmation: undefined, text: 'Put 2 files back' } : plan) })
    await gitRunners['git revert'](yes.context)
    expect(yes.sent[1][1]).toMatchObject({ files: ['a.ts', 'b.ts'], confirmed: true })
    expect(yes.out).toEqual(['Put 2 files back'])
    await expect(gitRunners['git revert'](fakeContext(['lisbon']).context)).rejects.toMatchObject({ exitCode: 2 })
  })

  it('pr auto-fix on previews, asks, then sends back exactly what the preview showed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const shown = preview()
    const plan: AutoFixResult = { workspace: { id: 'ws1', name: 'lisbon' }, verb: 'on', enabled: false, needsConfirmation: true, preview: shown, previewText: 'Turn on auto-fix', text: 'Turn on auto-fix' }
    const { context, sent, out } = fakeContext(['lisbon', 'on'], { yes: true, tab: '1' }, { 'pr-auto-fix': (p: Record<string, unknown>) => (p.shown ? { ...plan, enabled: true, needsConfirmation: undefined, text: 'Auto-fix CI is on' } : plan) })
    await gitRunners['git pr auto-fix'](context)
    expect(sent[0][1]).toMatchObject({ verb: 'on', tab: 1 })
    expect(sent[0][1].shown).toBeUndefined()
    expect(sent[1][1].shown).toEqual({ sessionId: 's1', agent: 'claude', permissions: 'edit files and run tests', prompt: 'Fix the failing checks.' })
    expect(out).toEqual(['Auto-fix CI is on'])
    const refused = fakeContext(['lisbon', 'on'], { tab: '1' }, { 'pr-auto-fix': plan })
    await expect(gitRunners['git pr auto-fix'](refused.context)).rejects.toMatchObject({ exitCode: 6 })
    expect(refused.sent).toHaveLength(1)
  })

  it('git commit prints the receipt, and --wait blocks for that turn and exits with its outcome', async () => {
    const action: GitActionResult = { workspace: { id: 'ws1', name: 'lisbon' }, action: 'commit-and-push', tab: 2, session: 's2', turn: 'turn-7', disposition: 'started', text: 'Started turn turn-7 in tab 2: commit and push' }
    const waited = { workspace: { id: 'ws1', name: 'lisbon' }, session: 's2', turn: 'turn-7', outcome: 'error', error: 'boom', checks: 'none' }
    const plain = fakeContext(['lisbon'], { tab: '2' }, { 'git-action': action })
    await gitRunners['git commit'](plain.context)
    expect(plain.sent).toEqual([['git-action', { workspace: 'lisbon', cwd: '/work', action: 'commit-and-push', tab: 2 }]])
    expect(plain.out).toEqual([action.text])

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const waiting = fakeContext(['lisbon'], { wait: true, timeout: '60' }, { 'git-action': action, wait: waited })
    await gitRunners['git commit'](waiting.context)
    expect(waiting.sent[1]).toEqual(['wait', { turn: 'turn-7', timeoutSec: 60 }])
    expect(waiting.out).toEqual([action.text])
    expect(String(log.mock.calls[0][0])).toContain('Turn turn-7 failed in lisbon')
    expect(process.exitCode).toBe(1)
  })

  it('pr create picks the action from --draft and --web, and refuses contradictions', async () => {
    const result: GitActionResult = { workspace: { id: 'ws1', name: 'lisbon' }, action: 'create-pr', text: 'x' }
    const draft = fakeContext(['lisbon'], { draft: true, tab: '1' }, { 'git-action': result })
    await gitRunners['git pr create'](draft.context)
    expect(draft.sent[0][1]).toMatchObject({ action: 'create-draft-pr', tab: 1 })
    const web = fakeContext(['lisbon'], { web: true }, { 'git-action': result })
    await gitRunners['git pr create'](web.context)
    expect(web.sent[0][1]).toMatchObject({ action: 'create-pr-web' })
    await expect(gitRunners['git pr create'](fakeContext(['lisbon'], { draft: true, web: true }).context)).rejects.toMatchObject({ exitCode: 2 })
    await expect(gitRunners['git pr create'](fakeContext(['lisbon'], { web: true, wait: true }).context)).rejects.toMatchObject({ exitCode: 2 })
    await expect(gitRunners['git commit'](fakeContext(['lisbon'], { wait: true }, { 'git-action': { ...result, text: 'Done: x' } }).context)).rejects.toThrow('nothing to wait for')
  })

  it('sends the words each command takes, and refuses what it can’t use', async () => {
    const answers = { comments: { text: 'ok' }, diff: { text: 'ok' }, 'pr-watch': { text: 'ok' }, 'pr-threads': { text: 'ok' }, 'git-status': { text: 'ok' }, 'pr-fix-ci': { text: 'ok' } }
    const run = async (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      const { context, sent } = fakeContext(args, opts, answers)
      await gitRunners[name](context)
      return sent
    }
    expect(await run('comments', ['lisbon', 'add', 'src/a.ts', '12', 'Handle', 'empty'])).toEqual([['comments', { workspace: 'lisbon', cwd: '/work', verb: 'add', file: 'src/a.ts', line: 12, body: 'Handle empty' }]])
    expect(await run('comments', ['lisbon', 'edit', 'aaaa', 'New', 'text'])).toEqual([['comments', { workspace: 'lisbon', cwd: '/work', verb: 'edit', id: 'aaaa', body: 'New text' }]])
    expect(await run('comments', ['lisbon'])).toEqual([['comments', { workspace: 'lisbon', cwd: '/work', verb: 'list' }]])
    expect(await run('diff', ['lisbon'], { scope: 'commit:abc1234', stat: true })).toEqual([['diff', { workspace: 'lisbon', cwd: '/work', scope: 'commit:abc1234', stat: true, files: undefined }]])
    expect(await run('git pr watch', ['lisbon', 'ci', 'on'])).toEqual([['pr-watch', { workspace: 'lisbon', cwd: '/work', kind: 'ci', on: true }]])
    expect(await run('git pr threads', ['lisbon', 'send', 'T1', 'T2'], { tab: '2' })).toEqual([['pr-threads', { workspace: 'lisbon', cwd: '/work', verb: 'send', ids: ['T1', 'T2'], tab: 2 }]])
    expect(await run('git status', ['.'], { fresh: true })).toEqual([['git-status', { workspace: '.', cwd: '/work', fresh: true }]])
    expect(await run('git pr fix-ci', ['lisbon'], { new: true })).toEqual([['pr-fix-ci', { workspace: 'lisbon', cwd: '/work', tab: undefined, new: true }]])
    for (const [name, args, opts] of [
      ['comments', ['lisbon', 'add', 'src/a.ts', 'x', 'text'], {}],
      ['comments', ['lisbon', 'resolve'], {}],
      ['comments', ['lisbon', 'shout'], {}],
      ['git pr watch', ['lisbon', 'lint', 'on'], {}],
      ['git pr watch', ['lisbon', 'ci'], {}],
      ['git pr threads', ['lisbon', 'send'], {}],
      ['git pr fix-ci', ['lisbon'], { new: true, tab: '1' }],
      ['git status', [], {}],
      ['git commit', ['lisbon'], { tab: '0' }]
    ] as [string, string[], Record<string, unknown>][]) {
      await expect(run(name, args, opts), `${name} ${args.join(' ')}`).rejects.toMatchObject({ exitCode: 2 })
    }
  })
})

describe('the command table', () => {
  it('resolves the pr alias to the git pr commands, and the plain nouns', () => {
    expect(findCommand(['pr', 'merge', 'api', '--yes'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['git', 'pr', 'merge'] }, rest: ['api', '--yes'] })
    expect(findCommand(['pr', 'api'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['git', 'pr'] }, rest: ['api'] })
    expect(findCommand(['pr', 'auto-fix', 'api', 'on'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['git', 'pr', 'auto-fix'] } })
    expect(findCommand(['git', 'revert', 'api', 'a.ts'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['git', 'revert'] } })
    expect(findCommand(['diff', 'api'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['diff'] } })
    expect(findCommand(['base-moved', 'api'], GIT_COMMANDS)).toMatchObject({ spec: { path: ['base-moved'] } })
  })

  it('has a summary, a usage line, an example and a runner for every command, and renders its help', () => {
    for (const spec of GIT_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).not.toBe('')
      expect(spec.usage.startsWith(`foreman ${name}`), spec.usage).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      expect(gitRunners[name], name).toBeTypeOf('function')
      const help = renderCommandHelp(spec)
      expect(help).toContain(spec.usage)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) expect(help).toContain(example)
      for (const example of spec.examples ?? []) expect(findCommand(example.replace(/^foreman /, '').split(' '), GIT_COMMANDS), example).toHaveProperty('spec')
      const shorts = Object.values(spec.options).map((o) => o.short).filter(Boolean)
      expect(new Set(shorts).size, name).toBe(shorts.length)
      for (const s of shorts) expect(Object.values(COMMON_OPTIONS).some((o) => o.short === s), `${name} -${s}`).toBe(false)
    }
    expect(Object.keys(gitRunners).sort()).toEqual(GIT_COMMANDS.map(commandName).sort())
  })

  it('marks what changes things as admin, and parses the options each declares', () => {
    const tier = (name: string) => GIT_COMMANDS.find((c) => commandName(c) === name)?.tier
    expect(['git revert', 'git pr merge', 'git pr auto-fix'].map(tier)).toEqual(['admin', 'admin', 'admin'])
    expect(['git commit', 'git review', 'git pr create', 'git pr fix-ci', 'base-moved'].map(tier)).toEqual(['act', 'act', 'act', 'act', 'act'])
    const create = GIT_COMMANDS.find((c) => commandName(c) === 'git pr create')!
    expect(parseCommandArgs(create, ['api', '--draft', '--tab', '2', '--wait', '--timeout', '30'])).toMatchObject({ positionals: ['api'], opts: { draft: true, tab: '2', wait: true, timeout: '30' } })
    expect(() => parseCommandArgs(GIT_COMMANDS.find((c) => commandName(c) === 'git push')!, ['api', '--tab', '2'])).toThrow('doesn’t take --tab')
    const merge = GIT_COMMANDS.find((c) => commandName(c) === 'git pr merge')!
    expect(parseCommandArgs(merge, ['api', '--auto', '-y']).opts).toMatchObject({ auto: true, yes: true })
  })
})

describe('diff --words', () => {
  const api = file('src/api.ts', 2, 1, {
    hunks: [
      { header: '@@ -10,3 +10,4 @@ import x', lines: [{ type: 'ctx', text: 'keep', oldNo: 10, newNo: 10 }, { type: 'add', text: "import { sleep } from './sleep'", newNo: 11 }, { type: 'ctx', text: 'keep', oldNo: 11, newNo: 12 }] },
      {
        header: '@@ -40,5 +41,6 @@ export async function handleLogin(',
        lines: [{ type: 'del', text: '  const bp = 768', oldNo: 42 }, { type: 'add', text: '  const bp = 640', newNo: 42 }, { type: 'add', text: '  retry(bp)', newNo: 43 }]
      }
    ]
  })
  const diffWith = (...files: DiffFile[]) => ({ api: { getDiff: (async () => diffOf(files)) as Api['getDiff'] } })

  it('says the lead, each file, then each hunk with what was added and removed', async () => {
    const { call } = rig(diffWith(api, file('notes.md', 4, 0, { status: 'added', hunks: [] })))
    const result = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', words: true })
    expect(result.text.split('\n')).toEqual([
      '2 files changed, +6 -1',
      'src/api.ts, modified, 2 added, 1 removed',
      "src/api.ts, hunk 1 of 2, lines 10 to 13, near: import x: added: import { sleep } from './sleep'",
      'src/api.ts, hunk 2 of 2, lines 41 to 46, near: export async function handleLogin(: added: const bp = 640 / retry(bp); removed: const bp = 768',
      'notes.md, added, 4 added, 0 removed'
    ])
    // The data is what it always was, and the patch isn't sent twice.
    expect(result).toMatchObject({ additions: 6, deletions: 1, files: [{ path: 'src/api.ts' }, { path: 'notes.md' }] })
    expect(result.patch).toBeUndefined()
  })

  it('leaves the patch alone without the flag, and refuses it beside --stat or --files', async () => {
    const { call } = rig(diffWith(api))
    const plain = await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/' })
    expect(plain.text).toContain('diff --git a/src/api.ts b/src/api.ts')
    expect(plain.patch).toBe(plain.text)
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', words: true, stat: true }))).code).toBe('invalid')
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', words: true, files: true }))).code).toBe('invalid')
    expect((await failure(call('diff', { workspace: 'lisbon', cwd: '/', words: 'yes' }))).code).toBe('invalid')
  })

  it('keeps the reason a source is empty, and a hunk that only removes says which lines went', async () => {
    const empty = rig({ api: { getDiff: (async () => diffOf([], { unavailable: 'no-pr' })) as Api['getDiff'] } })
    expect((await empty.call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', scope: 'pr', words: true })).text).toBe('Nothing to show: there is no pull request.')
    const none = rig({ api: { getDiff: (async () => diffOf([])) as Api['getDiff'] } })
    expect((await none.call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', words: true })).text).toBe('No changes.')
    const removal = file('gone.ts', 0, 2, { hunks: [{ header: '@@ -5,2 +4,0 @@', lines: [{ type: 'del', text: 'a', oldNo: 5 }, { type: 'del', text: 'b', oldNo: 6 }] }] })
    const { call } = rig(diffWith(removal))
    expect((await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', words: true })).text.split('\n')).toEqual(['1 file changed, +0 -2', 'gone.ts, modified, 0 added, 2 removed', 'gone.ts, hunk 1 of 1, removed lines 5 to 6: removed: a / b'])
  })

  it('notes a truncated diff, and says a turn as counts per file', async () => {
    const cut = rig({ api: { getDiff: (async () => diffOf([api], { truncated: true })) as Api['getDiff'] } })
    expect((await cut.call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', words: true })).text).toContain('… the diff was cut at 4 MB')
    const turnStatus = vi.fn(async (id: string) => ({ workspaceId: 'ws1', sessionId: 's1', turnId: id, state: 'ended' as const, delta: { files: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.ts', additions: 2, deletions: 0 }], additions: 5, deletions: 1 } }))
    const { call } = rig({ host: { turnStatus } })
    expect((await call<DiffResult>('diff', { workspace: 'lisbon', cwd: '/', scope: 'turn:t1', words: true })).text.split('\n')).toEqual([
      '2 files changed, +5 -1',
      'a.ts, modified, 3 added, 1 removed',
      'b.ts, modified, 2 added, 0 removed',
      '(Counts only: Foreman keeps what a turn changed per file, not the patch.)'
    ])
  })

  describe('the command', () => {
    const run = async (opts: Record<string, unknown>) => {
      const sent: [string, Record<string, unknown>][] = []
      const context = {
        args: ['lisbon'],
        opts,
        json: Boolean(opts.json),
        quiet: false,
        yes: false,
        cwd: '/work',
        send: (async (method: string, params?: unknown) => (sent.push([method, params as Record<string, unknown>]), { text: 'ok' })) as Context['send'],
        print: () => undefined,
        confirm: async () => false,
        note: () => undefined,
        progress: () => undefined
      } as Context
      await gitRunners.diff(context)
      return sent
    }

    it('asks for words with --words, and not with --json (the JSON is the same)', async () => {
      expect(await run({ words: true })).toEqual([['diff', { workspace: 'lisbon', cwd: '/work', words: true }]])
      expect((await run({ words: true, json: true }))[0][1].words).toBeUndefined()
      expect((await run({}))[0][1].words).toBeUndefined()
    })

    it('is a declared option, so the parser takes it and the help lists it', () => {
      const spec = GIT_COMMANDS.find((c) => commandName(c) === 'diff')!
      expect(spec.options.words).toMatchObject({ type: 'boolean' })
      expect(spec.usage).toContain('--words')
      expect(parseCommandArgs(spec, ['api', '--words']).opts.words).toBe(true)
      expect(renderCommandHelp(spec)).toContain('--words')
    })
  })
})
