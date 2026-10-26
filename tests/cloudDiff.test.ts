// Phase 3 of cloud workspaces: the Changes panel, commits, git status, pull
// requests, push and pull, attachments, archive and checkpoints run in the workspace's sandbox, against the fake
// provider (a real repository in a temporary folder). Nothing reads a folder here, and a read never wakes a sandbox.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteCheckpoints, restoreCheckpoint, saveCheckpoint, CHECKPOINT_REF_PREFIX } from '../src/main/checkpoints'
import { FakeProvider, type FakeSandbox } from '../src/main/cloud/fakeProvider'
import { SandboxManager } from '../src/main/cloud/sandboxes'
import { fileAtRef, refsDiff, revertFile, workspaceDiff, workspaceDiffPatch, workspaceDiffStat, workspaceDiffText } from '../src/main/diff'
import { branchCommitCount, branchCommits, sourceDiff, sourceInfo } from '../src/main/diffSources'
import { Environment } from '../src/main/environment'
import { attachFromData, attachFromPath, attachmentNote } from '../src/main/files'
import { git, gitOut } from '../src/main/git'
import { GitActions } from '../src/main/gitActions'
import { secretKey } from '../src/main/integrations'
import { PrCache } from '../src/main/prCache'
import { workspaceTarget, type WorkspaceRuntime } from '../src/main/runtime'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { checkpointDelta } from '../src/main/turnDelta'
import { ArchiveStepError, WorkspaceService } from '../src/main/workspaces'
import { CLOUD_CWD, patchCloudSettings, planLimits } from '../src/shared/cloud'
import type { Connection } from '../src/shared/integrations'
import type { Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const GH_TOKEN = 'gho_repo_token'
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
const b64 = (text: string) => Buffer.from(text).toString('base64')

/** A repository with an active cloud build, as WorkspaceService and SandboxManager run it in the app. */
async function rig() {
  const dataDir = await tempDir('foreman-cloud3-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-cloud3-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  store.state.settings.cloud = patchCloudSettings(store.state.settings, { enabled: true })
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), plain)
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  const fake = new FakeProvider(await tempDir('foreman-cloud3-sb-'))
  const limits = planLimits('hobby')
  const connection: Connection = { id: 'vc1', service: 'vercel', name: 'Vercel', rev: 1, auth: { kind: 'token' }, agentAccess: 'off', vercel: { teamId: 't', projectId: 'p', plan: 'hobby', limits }, createdAt: 'x' }
  secrets.setAppSecret(secretKey(connection.id), 'vercel_token')
  const upstream = await makeRepo({ 'README.md': 'hi\n' })
  const clone = await tempDir()
  await git(path.dirname(clone), ['clone', '-q', upstream, clone])
  const manager = new SandboxManager({
    store,
    secrets,
    connection: (service) => (service === 'vercel' ? { state: 'ready', connection, source: 'default' } : { state: 'none', source: 'default', off: false }),
    provider: () => fake,
    githubToken: () => GH_TOKEN,
    cloneUrl: async () => upstream,
    gitIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    settingsFor: (id) => service.settingsFor(id),
    changed: () => undefined,
    buildLog: () => undefined,
    turnRunning: () => false,
    terminalOpen: () => false,
    focused: () => false
  })
  service.cloud = manager
  const repo = await service.addRepo(clone)
  service.updateRepo(repo.id, { cloud: { enabled: true, installScript: 'echo installing' } })
  const build = await manager.buildBase(repo.id)
  expect(build.error).toBeUndefined()
  return { store, service, manager, fake, repo, upstream }
}

type Rig = Awaited<ReturnType<typeof rig>>

async function cloudWorkspace(r: Rig, options: Parameters<WorkspaceService['createWorkspace']>[1] = {}): Promise<Workspace> {
  const ws = await r.service.createWorkspace(r.repo.id, { location: 'cloud', ...options })
  for (let i = 0; i < 400 && ws.state === 'creating'; i++) await new Promise((res) => setTimeout(res, 50))
  expect(ws.error).toBeUndefined()
  expect(ws.state).toBe('ready')
  return ws
}

const sandboxOf = (r: Rig, ws: Workspace) => r.fake.sandboxes.get(ws.cloud!.id) as FakeSandbox
const inRepo = (p: string) => `${CLOUD_CWD}/${p}`
const commitIn = async (rt: WorkspaceRuntime, file: string, text: string, message: string) => {
  await rt.writeFile(file, text)
  await git(rt, ['add', '--', file])
  await git(rt, [...IDENTITY, 'commit', '-q', '-m', message])
  return gitOut(rt, ['rev-parse', 'HEAD'])
}

describe('the Changes panel and commits in a cloud workspace', () => {
  it('reads the diff, totals, patch, sources and commits in the sandbox, and reverts files there', async () => {
    const r = await rig()
    const ws = await cloudWorkspace(r)
    const sb = sandboxOf(r, ws)
    const rt = workspaceTarget(ws) as WorkspaceRuntime
    expect(rt.kind).toBe('cloud')
    expect(ws.path).toBeUndefined()
    const c1 = await commitIn(rt, 'committed.txt', 'one\n', 'add committed')
    await commitIn(rt, 'two.txt', 'two\n', 'add two')
    const c3 = await commitIn(rt, 'three.txt', 'three\n', 'add three')
    await writeFile(sb.real(inRepo('README.md')), 'hi\nmore\n')
    await writeFile(sb.real(inRepo('new.txt')), 'new\n')

    expect(await workspaceDiffStat(ws)).toEqual({ files: 5, additions: 5, deletions: 0 })
    const all = await workspaceDiff(ws)
    expect(all.baseRef).toBe('origin/main')
    expect(all.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['added committed.txt', 'added new.txt', 'added three.txt', 'added two.txt', 'modified README.md'])
    expect(all.files.find((f) => f.path === 'new.txt')?.blobId).toMatch(/^[0-9a-f]{40}$/)
    const uncommitted = await workspaceDiff(ws, 'uncommitted')
    expect(uncommitted.files.map((f) => f.path).sort()).toEqual(['README.md', 'new.txt'])
    const patch = await workspaceDiffPatch(ws)
    expect(patch).toMatchObject({ files: 5, additions: 5, deletions: 0, cut: false })
    expect(patch.text).toContain('+more')
    expect(await workspaceDiffText(ws, 'new.txt')).toContain('+new')
    expect(await workspaceDiffText(ws, undefined, true)).toContain('three.txt')
    // The snapshot used a private index under /tmp: nothing was staged.
    expect((await git(rt, ['status', '--porcelain'])).stdout.trimEnd().split('\n').sort()).toEqual([' M README.md', '?? new.txt'])

    const commits = await branchCommits(ws)
    expect(commits.commits.map((c) => c.subject)).toEqual(['add three', 'add two', 'add committed'])
    expect(commits.uncommitted).toMatchObject({ files: 2, additions: 2 })
    expect(await branchCommitCount(ws)).toEqual({ count: 3, more: false })
    expect((await sourceDiff(ws, 'last-commit')).files.map((f) => f.path)).toEqual(['three.txt'])
    // Picked commits that aren't one run are applied in a private index in the sandbox.
    expect((await sourceDiff(ws, 'picked', [c1, c3])).files.map((f) => f.path).sort()).toEqual(['committed.txt', 'three.txt'])
    const info = await sourceInfo(ws)
    expect(info).toMatchObject({ baseRef: 'origin/main', branchCommits: 3, counts: { all: 5, uncommitted: 2 } })
    expect(await fileAtRef(rt, 'HEAD', 'committed.txt')).toEqual({ content: 'one\n', binary: false, tooLarge: false })

    await revertFile(ws, 'README.md')
    expect(await readFile(sb.real(inRepo('README.md')), 'utf8')).toBe('hi\n')
    await revertFile(ws, 'new.txt')
    expect(existsSync(sb.real(inRepo('new.txt')))).toBe(false)
    await revertFile(ws, 'three.txt')
    expect((await workspaceDiff(ws)).files.map((f) => f.path).sort()).toEqual(['committed.txt', 'two.txt'])

    // Asleep: a read says so, and doesn't wake the sandbox.
    await r.manager.sleep(ws)
    await expect(workspaceDiff(ws)).rejects.toThrow(/asleep/)
    await expect(branchCommits(ws)).rejects.toThrow(/asleep/)
    expect(sb.state).toBe('stopped')
    expect(sb.resumes).toBe(0)
  }, 180_000)
})

describe('the Git panel in a cloud workspace', () => {
  it('reads ahead and behind, pushes and pulls through a remote in the sandbox, and asks gh there with the repository’s token', async () => {
    const r = await rig()
    const ws = await cloudWorkspace(r)
    const sb = sandboxOf(r, ws)
    const rt = workspaceTarget(ws) as WorkspaceRuntime
    // A bare remote inside the sandbox stands in for GitHub.
    await git(rt, ['init', '-q', '--bare', '/vercel/remote.git'])
    await git(rt, ['remote', 'set-url', 'origin', '/vercel/remote.git'])
    await git(rt, ['push', '-q', 'origin', 'refs/remotes/origin/main:refs/heads/main'])
    const ghCalls: { args: string[]; env: Record<string, string> }[] = []
    let pr: Record<string, unknown> | null = null
    r.fake.stubs.set('gh', (args, ctx) => {
      ghCalls.push({ args, env: ctx.env })
      if (args[0] === 'repo') return { stdout: JSON.stringify({ url: 'https://github.com/acme/app' }), stderr: '', code: 0 }
      return pr ? { stdout: JSON.stringify(pr), stderr: '', code: 0 } : { stdout: '', stderr: 'no pull requests found for branch', code: 1 }
    })
    const opened: string[] = []
    const actions = new GitActions(r.store, r.service, {} as never, async (url) => void opened.push(url), new PrCache())

    await commitIn(rt, 'work.txt', 'work\n', 'work')
    let status = await actions.status(ws.id, true)
    expect(status).toMatchObject({ branch: ws.branch, upstream: undefined, aheadBase: 1, uncommitted: 0, ghAvailable: true, pr: undefined })
    expect(status.primary.action).toBe('create-pr')
    // gh ran in the sandbox, as the repository's connection.
    expect(ghCalls.at(-1)).toMatchObject({ args: expect.arrayContaining(['pr', 'view', ws.branch]), env: { GH_TOKEN } })

    await actions.run(ws.id, 'push')
    const head = await gitOut(rt, ['rev-parse', 'HEAD'])
    expect(await gitOut(rt, ['--git-dir', '/vercel/remote.git', 'rev-parse', ws.branch])).toBe(head)
    expect(r.fake.callsOf('exec').find((c) => c.cmd === 'git' && c.args?.[0] === 'push' && c.args.includes('-u'))?.env).toMatchObject({ GH_TOKEN })
    status = await actions.status(ws.id, true)
    expect(status).toMatchObject({ upstream: `origin/${ws.branch}`, ahead: 0, behind: 0 })

    // Someone else pushes to the branch: behind by one, and Pull fast-forwards in the sandbox.
    await git(rt, ['clone', '-q', '--branch', ws.branch, '/vercel/remote.git', '/vercel/other'])
    await git(rt, ['-C', '/vercel/other', ...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'theirs'])
    await git(rt, ['-C', '/vercel/other', 'push', '-q', 'origin', ws.branch])
    await git(rt, ['fetch', '-q', 'origin'])
    expect(await actions.status(ws.id, true)).toMatchObject({ ahead: 0, behind: 1 })
    await actions.run(ws.id, 'pull')
    expect(await gitOut(rt, ['log', '-1', '--format=%s'])).toBe('theirs')
    await commitIn(rt, 'more.txt', 'more\n', 'more')
    expect(await actions.status(ws.id, true)).toMatchObject({ ahead: 1, behind: 0 })

    // A pull request, read through gh in the sandbox.
    pr = { number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Work', body: '', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', baseRefName: 'main', headRefOid: head, statusCheckRollup: [], reviews: [], author: { login: 'ada' }, reviewRequests: [], createdAt: '2026-10-23T10:00:00Z' }
    status = await actions.status(ws.id, true)
    expect(status.pr).toMatchObject({ number: 12, state: 'OPEN', author: 'ada' })
    expect(status.primary.action).toBe('push')

    // Create PR on GitHub: pushed from the sandbox, the compare page from gh there.
    await actions.run(ws.id, 'create-pr-web')
    expect(opened).toEqual([`https://github.com/acme/app/compare/main...${encodeURIComponent(ws.branch)}?expand=1`])
    expect(await gitOut(rt, ['--git-dir', '/vercel/remote.git', 'rev-parse', ws.branch])).toBe(await gitOut(rt, ['rev-parse', 'HEAD']))
    expect(ghCalls.every((c) => c.env.GH_TOKEN === GH_TOKEN)).toBe(true)

    // Asleep: the panel's read doesn't wake the sandbox; it gets the last status read, marked with when.
    await r.manager.sleep(ws)
    expect(await actions.status(ws.id)).toMatchObject({ pr: { number: 12 }, asOf: expect.any(String) })
    expect(sb.state).toBe('stopped')
    // An action that needs GitHub's answer now (merge, rerun, …) wakes it and reads afresh.
    const fresh = await actions.status(ws.id, true)
    expect(fresh.asOf).toBeUndefined()
    expect(sb.state).toBe('running')
  }, 180_000)
})

describe('attachments, archive and checkpoints in a cloud workspace', () => {
  it('writes attachments and git actions’ instructions into the sandbox’s .context, kept out of git', async () => {
    const r = await rig()
    const ws = await cloudWorkspace(r)
    const sb = sandboxOf(r, ws)
    const at = workspaceTarget(ws, { wake: true })
    const data = await attachFromData(at, 'notes.md', b64('hello\n'))
    expect(data.path.startsWith(`${CLOUD_CWD}/.context/attachments/`)).toBe(true)
    expect(await readFile(sb.real(data.path), 'utf8')).toBe('hello\n')
    const local = path.join(await tempDir(), 'build.log')
    await writeFile(local, 'log line\n')
    const copied = await attachFromPath(at, local)
    expect(await readFile(sb.real(copied.path), 'utf8')).toBe('log line\n')
    expect(await readFile(sb.real(inRepo('.git/info/exclude')), 'utf8')).toContain('.context/')
    expect(await gitOut(workspaceTarget(ws), ['status', '--porcelain'])).toBe('')
    const note = attachmentNote(at, [data, copied])
    expect(note).toContain(`- ${path.posix.relative(CLOUD_CWD, data.path)} (text)`)
    expect(note).toMatch(/- \.context\/attachments\/\w+\/build\.log \(text\)/)

    // Create PR: the agent gets its instructions as a file in the sandbox.
    const sent: { text: string; attachments: { path: string }[] }[] = []
    r.store.state.sessions.push({ id: 's1', workspaceId: ws.id } as never)
    const sessions = {
      deliver: async (_id: string, text: string, opts: { attachments: { path: string }[] }) => {
        sent.push({ text, attachments: opts.attachments })
        return { disposition: 'started' as const, turnId: 'turn-1' }
      }
    }
    const actions = new GitActions(r.store, r.service, sessions as never, async () => undefined, new PrCache())
    // The receipt of the message it sent comes back, so the command line can follow the turn.
    expect(await actions.run(ws.id, 'create-pr')).toEqual({ disposition: 'started', turnId: 'turn-1' })
    expect(sent[0].text).toBe('Create a pull request.')
    expect(sent[0].attachments[0].path.startsWith(`${CLOUD_CWD}/.context/attachments/`)).toBe(true)
    expect(await readFile(sb.real(sent[0].attachments[0].path), 'utf8')).toContain('main')

    // An attachment is the user's doing: it wakes a sleeping sandbox.
    await r.manager.sleep(ws)
    await attachFromData(workspaceTarget(ws, { wake: true }), 'later.md', b64('later\n'))
    expect(ws.cloud!.status).toBe('running')
    expect(sb.state).toBe('running')
  }, 180_000)

  it('archives with the diff kept and the archive steps run in the sandbox; a failed step stops nothing', async () => {
    const r = await rig()
    const ws = await cloudWorkspace(r)
    const sb = sandboxOf(r, ws)
    await writeFile(sb.real(inRepo('README.md')), 'hi\nchanged\n')
    r.service.updateRepoSettings(r.repo.id, { archiveScript: 'exit 3' })
    const failed = await r.service.archiveWorkspace(ws.id, false).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(ArchiveStepError)
    expect(ws.state).toBe('ready')
    expect(sb.state).toBe('running')

    r.service.updateRepoSettings(r.repo.id, { archiveScript: 'echo bye > /vercel/archived.txt' })
    await r.service.archiveWorkspace(ws.id, false)
    expect(ws.state).toBe('archived')
    expect(await readFile(sb.real('/vercel/archived.txt'), 'utf8')).toBe('bye\n')
    expect(sb.state).toBe('stopped')
    expect(ws.archiveDiff).toMatchObject({ files: 1, additions: 1, deletions: 0 })
    const kept = await r.service.archivedDiff(ws.id)
    expect(kept?.files.map((f) => f.path)).toEqual(['README.md'])
    // Restored: the kept diff belongs to the archived state.
    await r.service.unarchiveWorkspace(ws.id)
    expect(ws.archiveDiff).toBeUndefined()
  }, 180_000)

  it('saves, compares and restores checkpoints in the sandbox', async () => {
    const r = await rig()
    const ws = await cloudWorkspace(r)
    const sb = sandboxOf(r, ws)
    const rt = workspaceTarget(ws) as WorkspaceRuntime
    await writeFile(sb.real(inRepo('draft.txt')), 'draft\n')
    const head = await gitOut(rt, ['rev-parse', 'HEAD'])
    const start = await saveCheckpoint(rt, 'cp-start')
    expect(start).toMatchObject({ ok: true, ref: `${CHECKPOINT_REF_PREFIX}cp-start`, tree: expect.stringMatching(/^[0-9a-f]{40}$/) })

    await commitIn(rt, 'agent.txt', 'agent\n', 'agent commit')
    await writeFile(sb.real(inRepo('README.md')), 'hi\nedited\n')
    await writeFile(sb.real(inRepo('stray.txt')), 'stray\n')
    expect(await saveCheckpoint(rt, 'cp-end')).toMatchObject({ ok: true })
    const delta = await checkpointDelta(rt, 'cp-start', 'cp-end')
    expect(delta !== 'unavailable' && delta.files.map((f) => f.path).sort()).toEqual(['README.md', 'agent.txt', 'stray.txt'])
    const diff = await refsDiff(rt, `${CHECKPOINT_REF_PREFIX}cp-start`, `${CHECKPOINT_REF_PREFIX}cp-end`, ['README.md'])
    expect(diff.files[0]).toMatchObject({ path: 'README.md', additions: 1 })
    expect((await fileAtRef(rt, `${CHECKPOINT_REF_PREFIX}cp-end`, 'README.md')).content).toBe('hi\nedited\n')

    await restoreCheckpoint(rt, 'cp-start')
    expect(await gitOut(rt, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await readFile(sb.real(inRepo('README.md')), 'utf8')).toBe('hi\n')
    expect(await readFile(sb.real(inRepo('draft.txt')), 'utf8')).toBe('draft\n')
    expect(existsSync(sb.real(inRepo('stray.txt')))).toBe(false)
    expect(existsSync(sb.real(inRepo('agent.txt')))).toBe(false)

    // Mid-merge there is no checkpoint, and it says why.
    await writeFile(sb.real(inRepo('.git/MERGE_HEAD')), `${head}\n`)
    expect(await saveCheckpoint(rt, 'cp-busy')).toEqual({ ok: false, reason: 'merge in progress' })
    await git(rt, ['merge', '--abort'], { allowFail: true })

    await deleteCheckpoints(rt, 'cp-')
    expect(await gitOut(rt, ['for-each-ref', CHECKPOINT_REF_PREFIX])).toBe('')
  }, 180_000)

  it('checks a pull request out into a new cloud workspace from the clone’s remote', async () => {
    const r = await rig()
    await git(r.upstream, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(r.upstream, 'feature.txt'), 'feature\n')
    await git(r.upstream, ['add', '-A'])
    await git(r.upstream, [...IDENTITY, 'commit', '-q', '-m', 'feature'])
    const sha = await gitOut(r.upstream, ['rev-parse', 'HEAD'])
    await git(r.upstream, ['update-ref', 'refs/pull/7/head', sha])
    await git(r.upstream, ['checkout', '-q', 'main'])
    r.service.remoteUrl = async () => 'https://github.com/acme/app.git'
    await expect(r.service.createWorkspace(r.repo.id, { location: 'cloud', pullRequest: { repo: 'someone/else', number: 7 } })).rejects.toThrow(/isn’t someone\/else/)

    const ws = await cloudWorkspace(r, { pullRequest: { repo: 'acme/app', number: 7 } })
    expect(ws.branch).toBe('pr-7')
    expect(ws.pullRequest).toEqual({ repo: 'acme/app', number: 7 })
    const rt = workspaceTarget(ws) as WorkspaceRuntime
    expect(await gitOut(rt, ['rev-parse', 'HEAD'])).toBe(sha)
    expect(await gitOut(rt, ['branch', '--show-current'])).toBe('pr-7')
  }, 180_000)
})
