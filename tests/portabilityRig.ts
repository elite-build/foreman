import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ClaudeMirror } from '../src/main/claudeMirror'
import { Environment } from '../src/main/environment'
import { DEFAULT_LIMITS } from '../src/main/exportFile'
import { git } from '../src/main/git'
import { PortabilityService } from '../src/main/portability'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

const REMOTE = 'https://example.com/acme/app.git'

// Every machine clones one repository, like two Macs cloning the same remote, so
// root commits match. Separate `git init`s only match when both land in the same second.
let upstream: Promise<string> | undefined
async function cloneUpstream(): Promise<string> {
  upstream ??= makeRepo()
  const dir = await tempDir()
  await git(dir, ['clone', '-q', await upstream, '.'])
  await git(dir, ['remote', 'set-url', 'origin', REMOTE])
  return dir
}

/** One "machine": its own data folder, repository and services. */
export async function machine(options: { repoDir?: string; name?: string; limits?: typeof DEFAULT_LIMITS } = {}) {
  const dataDir = await tempDir('foreman-port-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-port-ws-')
  store.state.settings.branchPrefixType = 'none'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const environment = new Environment(secrets, () => store.state.settings, (id) => workspaces.repo(id))
  const workspaces: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  const repoDir = options.repoDir ?? (await cloneUpstream())
  await git(repoDir, ['remote', 'add', 'origin', REMOTE], { allowFail: true })
  const repo = await workspaces.addRepo(repoDir)
  let vars: { scope: 'user' | 'repo'; name: string }[] = []
  // Test seams for the worktree capture: what is "busy", and a step between checkpoint and revalidation.
  const seams: { busy: string | null; afterCheckpoint?: () => Promise<void> } = { busy: null }
  const mirror = new ClaudeMirror(() => store.db)
  const portability = new PortabilityService({
    store,
    mirror,
    workspaces,
    variableNames: () => vars,
    machine: () => options.name ?? 'MacBook Air.local',
    limits: options.limits,
    changed() {},
    busy: () => seams.busy,
    afterCheckpoint: () => seams.afterCheckpoint?.() ?? Promise.resolve()
  })
  return { dataDir, store, workspaces, repo, repoDir, portability, mirror, seams, setVars: (v: typeof vars) => (vars = v) }
}

export type Machine = Awaited<ReturnType<typeof machine>>

/** A workspace with two chats, an attachment, a comment and a checkpoint reference. */
export async function seed(m: Machine, options: { attachment?: boolean } = {}) {
  const attachmentPath = path.join(m.dataDir, 'notes.txt')
  await writeFile(attachmentPath, 'attached text\n')
  const ws: Workspace = {
    id: 'ws-1', repoId: m.repo.id, name: 'dakar', branch: 'feat/dakar', baseBranch: 'main', path: path.join(m.dataDir, 'tree'), portBase: 50000, state: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z', checks: { running: false, results: [] } as never, adopted: true
  }
  const s1: Session = { id: 'sess-1', workspaceId: ws.id, title: 'Fix login', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], agentSessionId: 'native-1', lastAssistantUuid: 'u9', createdAt: ws.createdAt }
  const s2: Session = { id: 'sess-2', workspaceId: ws.id, title: 'Tests', agent: 'codex', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ws.createdAt }
  const items1: ChatItem[] = [
    {
      kind: 'user', id: 'u1', turnId: 't1', text: 'please fix', at: ws.createdAt, checkpoint: 'sess-1-t1-start', resumeFrom: { sessionId: 'native-1', messageUuid: 'u0' },
      attachments: options.attachment === false ? [] : [{ name: 'notes.txt', path: attachmentPath, kind: 'text' }]
    },
    { kind: 'tool', id: 'x1', turnId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'done', output: 'SECRET-OUTPUT' },
    // An earlier version of the same item is superseded by the later line.
    { kind: 'assistant', id: 'a1', turnId: 't1', text: 'draft' },
    { kind: 'turn-end', id: 'turn-end:t1', turnId: 't1', outcome: 'completed' }
  ]
  m.store.state.workspaces.push(ws)
  m.store.state.sessions.push(s1, s2)
  m.store.state.comments.push({ id: 'c1', workspaceId: ws.id, file: 'a.ts', line: 3, body: 'nit', author: 'user', state: 'pending', createdAt: ws.createdAt })
  for (const item of items1) await m.store.appendChat(s1.id, item)
  await m.store.appendChat(s1.id, { kind: 'assistant', id: 'a1', turnId: 't1', text: 'final answer' })
  await m.store.appendChat(s2.id, { kind: 'user', id: 'u1', turnId: 't2', text: 'add tests', at: ws.createdAt })
  return { ws, s1, s2, attachmentPath }
}


/** A real worktree (created by the workspace service) with one idle chat, ready for a bundle export. */
export async function liveWorkspace(m: Machine): Promise<Workspace> {
  const ws = await m.workspaces.createWorkspace(m.repo.id, { branch: { kind: 'new', name: 'feat/live' } })
  for (let i = 0; i < 200 && ws.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
  if (ws.state !== 'ready') throw new Error(`workspace did not become ready: ${ws.state} ${ws.error ?? ''}`)
  m.store.state.sessions.push({ id: 'live-1', workspaceId: ws.id, title: 'Live', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ws.createdAt })
  await m.store.appendChat('live-1', { kind: 'user', id: 'u1', turnId: 't1', text: 'hello', at: ws.createdAt })
  return ws
}
