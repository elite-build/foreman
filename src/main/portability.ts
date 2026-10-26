// Export and import of one workspace (P-2, history mode). Export writes a `.foreman`
// file from what Foreman owns: the latest-version chat projection, attachments by hash,
// comments and variable names. Import first stages the file in quarantine (verify,
// limits, no traversal, no links; nothing runs), shows a preview, and only then creates
// a history-only workspace. Activating it (provisioning a worktree) is a separate step.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_OPEN_TABS } from '../shared/handOff'
import {
  projectItems,
  provenanceOf,
  unsafeEntryPath,
  repoReasons,
  type ExportChatInfo,
  type ExportInfo,
  type ExportManifest,
  type ExportOptions,
  type ExportSummary,
  type ExportedVariable,
  type ImportChoice,
  type ImportPreview,
  type ImportTab,
  type TabMode,
  type RepoEvidence,
  type RepoOption,
  type StageResult
} from '../shared/portable'
import { AGENTS, type AgentKind } from '../shared/agents'
import type { Attachment, ChatItem, DiffComment, Repo, Session, Workspace } from '../shared/types'
import { exportIntegrationChoices, importIntegrationChoices } from '../shared/integrations'
import { DEFAULT_LIMITS, ExportFileError, decrypt, encrypt, isEncrypted, pack, parse, type Limits, type PackEntry, type ParsedEntry } from './exportFile'
import type { TranscriptFile } from '../shared/claudeMirror'
import { bundleSummary, type WorktreeInfo, type WorktreeNote, type WorktreeResult } from '../shared/worktreeBundle'
import { wsPath } from '../shared/workspacePath'
import { otherAgentTurns } from '../shared/switchAgent'
import { CHECKPOINT_REF_PREFIX, deleteCheckpoints, restoreCheckpoint } from './checkpoints'
import { filesToCopy } from './filesToCopy'
import { git, revParse, repoEvidence } from './git'
import { pendingKey, type ClaudeMirror } from './claudeMirror'
import { captureWorktree, fetchBundle, verifyBundle } from './worktreeBundle'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'

export interface PortabilityDeps {
  store: Store
  workspaces: WorkspaceService
  // Names (never values) of the saved variables that apply to a repository, user scope included.
  variableNames(repoId: string): ExportedVariable[]
  machine?: () => string
  appVersion?: string
  limits?: Limits
  changed(): void
  // Why the workspace can't be bundled right now (an agent, check or run script is active), or null.
  busy?(workspaceId: string): string | null
  // Claude's mirrored transcripts (export reads them, import writes them for native resume).
  mirror?: ClaudeMirror
  // Test seam: runs between the checkpoint and the revalidation of a worktree capture.
  afterCheckpoint?: () => Promise<void>
}

interface Stage {
  id: string
  dir: string
  fileName: string
  manifest: ExportManifest
  workspace: WorkspaceData
  sessions: SessionData[]
  comments: DiffComment[]
  variables: ExportedVariable[]
  repo: RepoEvidence
  chats: Map<string, ChatItem[]>
  attachmentHashes: Set<string>
  // Claude session ids whose transcript the file carries (`transcript/<id>.json`).
  transcripts: Set<string>
  worktree?: WorktreeInfo
  preview: ImportPreview
}

// What the file carries about the workspace and its chats. Read through `readWorkspaceData`, which keeps only known fields.
interface WorkspaceData {
  id: string
  name: string
  branch: string
  baseBranch: string
  status?: Workspace['status']
  createdAt: string
  prInfo?: Workspace['prInfo']
  // The workspace note, with the revision it had when exported.
  note?: string
  noteRevision?: number
}
type SessionData = Pick<Session, 'id' | 'agent' | 'model' | 'fastMode' | 'planMode' | 'createdAt'> &
  Partial<Pick<Session, 'title' | 'titleSetByUser' | 'effort' | 'autoAcceptEdits' | 'outputStyle' | 'closedAt' | 'lastActivityAt' | 'lastTurn' | 'contextUsage' | 'agentSessionId' | 'lastAssistantUuid'>>

const STATUSES = new Set(['backlog', 'in-progress', 'in-review', 'done', 'canceled'])
const ITEM_KINDS = new Set(['user', 'assistant', 'thinking', 'tool', 'notice', 'result', 'turn-end'])

const str = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'attachment'
}

function sanitizeSession(raw: unknown): SessionData {
  if (!isObject(raw)) throw new ExportFileError('tampered', 'A chat in the file is malformed.')
  const id = str(raw.id, 100)
  const agent = str(raw.agent, 20) as AgentKind | undefined
  if (!id || !agent || !(agent in AGENTS)) throw new ExportFileError('tampered', 'A chat in the file is malformed.')
  const out: SessionData = {
    id,
    agent,
    model: str(raw.model, 200) ?? '',
    fastMode: raw.fastMode === true,
    planMode: raw.planMode === true,
    createdAt: str(raw.createdAt, 40) ?? new Date().toISOString()
  }
  const title = str(raw.title, 300)
  if (title) out.title = title
  if (raw.titleSetByUser === true) out.titleSetByUser = true
  const effort = str(raw.effort, 20)
  if (effort) out.effort = effort as Session['effort']
  if (raw.autoAcceptEdits === true) out.autoAcceptEdits = true
  const style = str(raw.outputStyle, 100)
  if (style) out.outputStyle = style
  const closedAt = str(raw.closedAt, 40)
  if (closedAt) out.closedAt = closedAt
  const last = str(raw.lastActivityAt, 40)
  if (last) out.lastActivityAt = last
  if (str(raw.agentSessionId, 200)) out.agentSessionId = raw.agentSessionId as string
  if (str(raw.lastAssistantUuid, 200)) out.lastAssistantUuid = raw.lastAssistantUuid as string
  if (isObject(raw.lastTurn) && typeof raw.lastTurn.outcome === 'string') out.lastTurn = raw.lastTurn as unknown as Session['lastTurn']
  if (isObject(raw.contextUsage) && typeof raw.contextUsage.used === 'number' && typeof raw.contextUsage.limit === 'number') out.contextUsage = { used: raw.contextUsage.used, limit: raw.contextUsage.limit }
  return out
}

function sanitizeItems(raw: unknown): ChatItem[] {
  if (!Array.isArray(raw)) throw new ExportFileError('tampered', 'A chat in the file is malformed.')
  return raw.filter((item): item is ChatItem => isObject(item) && typeof item.id === 'string' && typeof item.kind === 'string' && ITEM_KINDS.has(item.kind))
}

function sanitizeComment(raw: unknown): DiffComment | null {
  if (!isObject(raw)) return null
  const id = str(raw.id, 100)
  const file = str(raw.file, 1000)
  const body = str(raw.body, 20000)
  if (!id || !file || body === undefined || typeof raw.line !== 'number') return null
  const state = raw.state === 'resolved' || raw.state === 'open' ? raw.state : 'sent'
  return {
    id,
    workspaceId: '',
    file,
    line: raw.line,
    body,
    author: raw.author === 'agent' ? 'agent' : 'user',
    authorLabel: str(raw.authorLabel, 200),
    // A draft that was never sent must not ride along with the next message in a different place.
    state,
    createdAt: str(raw.createdAt, 40) ?? new Date().toISOString()
  }
}

/** One transcript file: Claude's session id and its entries (main transcript, then subagents). Malformed parts are refused. */
function readTranscript(entry: ParsedEntry): TranscriptFile {
  const bad = () => new ExportFileError('tampered', `${entry.path} in the file is not valid.`)
  let raw: unknown
  try {
    raw = JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw bad()
  }
  if (!isObject(raw) || typeof raw.sessionId !== 'string' || !/^[\w-]{1,200}$/.test(raw.sessionId) || !Array.isArray(raw.parts)) throw bad()
  const parts = raw.parts.map((p) => {
    if (!isObject(p) || !Array.isArray(p.entries)) throw bad()
    if (p.subpath !== undefined && (typeof p.subpath !== 'string' || !/^subagents\/[\w.-]+(\/[\w.-]+)*$/.test(p.subpath) || p.subpath.includes('..'))) throw bad()
    const entries = p.entries.filter((e): e is { [k: string]: unknown } => isObject(e) && typeof e.type === 'string')
    return { subpath: p.subpath as string | undefined, entries }
  })
  return { sessionId: raw.sessionId, parts }
}

const SHA = /^[0-9a-f]{40,64}$/
const NOTE_KINDS = new Set(['submodule', 'lfs', 'filenames', 'ignored', 'detached', 'files'])

/** The worktree the file carries, or undefined when it carries none. Anything malformed is refused. */
function readWorktree(entries: Map<string, ParsedEntry>): WorktreeInfo | undefined {
  const entry = entries.get('worktree/info.json')
  if (!entry) return undefined
  const bad = () => new ExportFileError('tampered', 'worktree/info.json in the file is not valid.')
  let raw: unknown
  try {
    raw = JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw bad()
  }
  if (!entries.has('worktree/branch.bundle')) throw bad()
  return parseWorktree(raw, (name) => entries.has(name), bad)
}

function parseWorktree(raw: unknown, has: (entry: string) => boolean, bad: () => Error): WorktreeInfo {
  if (!isObject(raw)) throw bad()
  const branch = str(raw.branch, 500)
  const head = str(raw.head, 100)
  const checkpointId = str(raw.checkpointId, 200)
  const checkpointRef = str(raw.checkpointRef, 300)
  if (!branch || !head || !SHA.test(head) || !checkpointId || !checkpointRef || checkpointRef !== CHECKPOINT_REF_PREFIX + checkpointId || !/^[\w.-]+$/.test(checkpointId)) throw bad()
  const files = (Array.isArray(raw.files) ? raw.files : []).map((f) => {
    if (!isObject(f) || typeof f.path !== 'string' || unsafeEntryPath(f.path) || typeof f.entry !== 'string' || !/^worktree\/files\/\d+$/.test(f.entry) || !has(f.entry)) throw bad()
    return { path: f.path, entry: f.entry }
  })
  const notes: WorktreeNote[] = (Array.isArray(raw.notes) ? raw.notes : [])
    .filter((n): n is Record<string, unknown> => isObject(n) && typeof n.kind === 'string' && NOTE_KINDS.has(n.kind) && typeof n.text === 'string')
    .map((n) => ({ kind: n.kind as WorktreeNote['kind'], text: (n.text as string).slice(0, 2000) }))
  const omitted = (Array.isArray(raw.omitted) ? raw.omitted : []).filter((o): o is string => typeof o === 'string' && o.length < 1000).slice(0, 200)
  return { branch, head, checkpointId, checkpointRef, omitted, omittedMore: typeof raw.omittedMore === 'number' && raw.omittedMore > 0 ? Math.floor(raw.omittedMore) : 0, files, notes }
}

function readJson(entries: Map<string, ParsedEntry>, name: string): unknown {
  const entry = entries.get(name)
  if (!entry) throw new ExportFileError('tampered', `The file has no ${name}.`)
  try {
    return JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw new ExportFileError('tampered', `${name} in the file is not valid.`)
  }
}

export class PortabilityService {
  private stages = new Map<string, Stage>()
  private ready: Promise<void>

  constructor(private deps: PortabilityDeps) {
    // A stage only lives within one run of the app; whatever a crash left behind is not wanted.
    this.ready = rm(this.quarantineRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  private get limits(): Limits {
    return this.deps.limits ?? DEFAULT_LIMITS
  }

  private get quarantineRoot(): string {
    return path.join(this.deps.store.dir, 'quarantine')
  }

  /** Where an imported workspace's attachments live; it has no worktree to hold them. */
  importedDir(workspaceId: string): string {
    return path.join(this.deps.store.dir, 'imported', workspaceId)
  }

  private machine(): string {
    return (this.deps.machine?.() ?? os.hostname()).replace(/\.local$/, '')
  }

  // ---- export ----

  async exportInfo(workspaceId: string): Promise<ExportInfo> {
    const ws = this.deps.workspaces.workspace(workspaceId)
    const chats: ExportChatInfo[] = []
    for (const session of this.deps.store.state.sessions.filter((s) => s.workspaceId === ws.id)) {
      const items = await this.deps.store.readChat(session.id)
      chats.push({
        id: session.id,
        title: session.title || 'New chat',
        agent: session.agent,
        closed: Boolean(session.closedAt),
        messages: items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length,
        toolCalls: items.filter((i) => i.kind === 'tool').length,
        attachments: items.reduce((n, i) => n + (i.kind === 'user' ? (i.attachments?.length ?? 0) : 0), 0)
      })
    }
    let worktree: ExportInfo['worktree'] = { available: false, reason: 'This workspace has no worktree on this machine.', copyFiles: 0 }
    if (ws.path && ws.state !== 'history' && existsSync(ws.path)) {
      const { patterns } = await this.deps.workspaces.previewFilesToCopy(ws.repoId)
      worktree = { available: true, copyFiles: (await filesToCopy(ws.path, patterns).catch(() => [])).length }
    }
    return {
      workspace: ws.name,
      chats,
      variables: this.deps.variableNames(ws.repoId).length,
      comments: this.deps.store.state.comments.filter((c) => c.workspaceId === ws.id).length,
      worktree
    }
  }

  async exportWorkspace(workspaceId: string, options: ExportOptions): Promise<ExportSummary> {
    const { store } = this.deps
    const ws = this.deps.workspaces.workspace(workspaceId)
    const repo = this.deps.workspaces.repo(ws.repoId)
    const share = options.mode === 'share'
    if (!share && !options.passphrase) throw new Error('A backup is encrypted: choose a passphrase.')
    if (!options.outPath) throw new Error('Choose where to save the file.')
    const all = store.state.sessions.filter((s) => s.workspaceId === ws.id)
    const chosen = share ? all.filter((s) => (options.sessionIds ? options.sessionIds.includes(s.id) : !s.closedAt)) : all
    if (!chosen.length) throw new Error('Choose at least one chat to export.')

    const entries: PackEntry[] = []
    const json = (name: string, value: unknown) => entries.push({ path: name, data: Buffer.from(JSON.stringify(value)) })
    // Attachments travel by content hash: a file's absolute path on this Mac means nothing elsewhere.
    const blobs = new Map<string, Buffer>()
    const hashes = new Map<string, string>()
    const wantAttachments = !share || options.includeAttachments !== false
    const pack1 = async (file: string) => {
      if (!wantAttachments || hashes.has(file)) return
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size > this.limits.entryBytes) return
        const data = await readFile(file)
        const hash = createHash('sha256').update(data).digest('hex')
        blobs.set(hash, data)
        hashes.set(file, hash)
      } catch {
        // Gone from this machine: it travels as "missing" and stays visible.
      }
    }

    // O1: chats where other agents answered turns that Claude's own session never saw.
    const mixed = new Set<string>()
    for (const session of chosen) {
      // The latest version of each message, as the app shows it; never the raw log.
      const items = await store.readChat(session.id)
      if (session.agent === 'claude' && otherAgentTurns(items, 'claude') > 0) mixed.add(session.id)
      for (const item of items) if (item.kind === 'user') for (const a of item.attachments ?? []) await pack1(a.path)
      json(
        `chat/${session.id}.json`,
        projectItems(items, {
          dropResume: share,
          dropToolOutput: share && !options.includeToolOutput,
          relativeTo: ws.path,
          attachment: (a) => (hashes.has(a.path) ? `sha256:${hashes.get(a.path)}` : `missing:${a.name}`)
        })
      )
    }

    // Claude's own transcript, only for chats whose mirror is complete; a share needs the box ticked.
    const transcripts = new Set<string>()
    const skipped: ExportSummary['transcriptsSkipped'] = []
    if (this.deps.mirror && (!share || options.includeTranscripts === true)) {
      for (const s of chosen) {
        if (s.agent !== 'claude' || !s.agentSessionId || transcripts.has(s.agentSessionId)) continue
        // O1: the transcript misses the turns other agents answered here, so it isn't the whole chat and doesn't travel.
        const gap = mixed.has(s.id) ? 'other agents answered part of this chat, so Claude’s own transcript doesn’t hold all of it' : this.deps.mirror.gap(s.agentSessionId)
        const file = gap ? null : this.deps.mirror.read(s.agentSessionId)
        const data = file ? Buffer.from(JSON.stringify(file)) : null
        if (!data || data.length > this.limits.entryBytes) skipped.push({ title: s.title || 'New chat', reason: gap ?? 'the transcript is too large for an export file' })
        else {
          transcripts.add(s.agentSessionId)
          entries.push({ path: `transcript/${s.agentSessionId}.json`, data })
        }
      }
    }
    const sessions = chosen.map((s) => {
      const { queue, status, turnId, turnStartedAt, workspaceId: _ws, provenance, ...rest } = s
      void [queue, status, turnId, turnStartedAt, _ws, provenance]
      // Import-only flags describe this machine's continuation, not the conversation.
      delete rest.forkOnResume
      delete rest.nativeFork
      // O1: parked conversations stay on this machine (their transcripts don't travel).
      delete rest.parked
      delete rest.catchUpSince
      if (share && !(rest.agentSessionId && transcripts.has(rest.agentSessionId))) {
        delete rest.agentSessionId
        delete rest.lastAssistantUuid
        delete rest.resumeAt
      }
      return rest
    })
    const variables = this.deps.variableNames(ws.repoId)
    const evidence = await repoEvidence(repo.rootPath, repo.remote || 'origin')
    json('workspace.json', { workspace: this.workspaceData(ws), repo: { name: repo.name, defaultBranch: repo.defaultBranch, ...evidence, integrations: exportIntegrationChoices(store.state.integrations, repo) } })
    json('sessions.json', sessions)
    json('comments.json', !share || options.includeComments !== false ? store.state.comments.filter((c) => c.workspaceId === ws.id) : [])
    json('variables.json', variables)
    for (const [hash, data] of blobs) entries.push({ path: `attachments/${hash}`, data })

    const exportId = randomUUID()
    const worktree = await this.captureInto(ws, repo, options, exportId, entries)
    let file = pack(
      { exportId, createdAt: new Date().toISOString(), sourceMachine: this.machine(), appVersion: this.deps.appVersion, mode: options.mode, workspaceName: ws.name, pathsRelative: true },
      entries
    )
    if (!share) file = await encrypt(file, options.passphrase!)
    await mkdir(path.dirname(options.outPath), { recursive: true })
    await writeFile(options.outPath, file)
    return { path: options.outPath, bytes: file.length, exportId, mode: options.mode, encrypted: !share, chats: chosen.length, attachments: blobs.size, variables: variables.length, worktree, transcripts: transcripts.size, transcriptsSkipped: skipped }
  }

  /** The branch and uncommitted work, when asked for (Backup: unless turned off; Share: only when turned on). */
  private async captureInto(ws: Workspace, repo: Repo, options: ExportOptions, exportId: string, entries: PackEntry[]): Promise<WorktreeResult | undefined> {
    const wanted = options.mode === 'share' ? options.includeWorktree === true : options.includeWorktree !== false
    if (!wanted) return undefined
    const skipped = (reason: WorktreeResult['reason'], message: string): WorktreeResult => ({ status: 'skipped', reason, message, notes: [] })
    if (!ws.path || ws.state === 'history' || !existsSync(ws.path)) return skipped('no-folder', 'This workspace has no worktree on this machine, so there is no branch or uncommitted work to bundle.')
    // Quiesce: nothing may be writing to the tree while it is captured.
    const busy = this.deps.busy?.(ws.id)
    if (busy) throw new Error(`Can’t bundle ${ws.name} while ${busy}. Stop it or wait for it to finish, then export again.`)
    let copyPatterns: string[] | null = null
    if (options.includeCopyFiles) copyPatterns = (await this.deps.workspaces.previewFilesToCopy(repo.id)).patterns
    const capture = await captureWorktree({
      dir: wsPath(ws),
      branch: ws.branch,
      baseBranch: ws.baseBranch,
      id: exportId,
      copyPatterns,
      maxFileBytes: Math.min(this.limits.entryBytes, 32 * 1024 * 1024),
      maxTotalBytes: Math.min(this.limits.totalBytes / 4, 128 * 1024 * 1024),
      afterCheckpoint: this.deps.afterCheckpoint
    })
    if (!capture.ok) {
      if (capture.reason === 'unborn' || capture.reason === 'merge') return skipped(capture.reason, capture.message)
      throw new Error(capture.message)
    }
    if (capture.bundle.length > this.limits.entryBytes) throw new Error('The branch bundle is larger than an export file may hold.')
    entries.push({ path: 'worktree/info.json', data: Buffer.from(JSON.stringify(capture.info)) })
    entries.push({ path: 'worktree/branch.bundle', data: capture.bundle })
    for (const f of capture.files) entries.push({ path: f.entry, data: f.data })
    return { status: 'included', message: `Included ${bundleSummary(capture.info)}.`, notes: capture.info.notes }
  }

  /** Only what describes the work. Folders, ports, checks, alerts and watches belong to this machine. */
  private workspaceData(ws: Workspace): WorkspaceData {
    const data: WorkspaceData = { id: ws.id, name: ws.name, branch: ws.branch, baseBranch: ws.baseBranch, status: ws.status, createdAt: ws.createdAt, prInfo: ws.prInfo }
    if (ws.note?.text.trim()) {
      data.note = ws.note.text
      data.noteRevision = ws.note.revision
    }
    return data
  }

  // ---- import: stage ----

  /** Verify and extract into quarantine, then describe it. Nothing in the file runs or reaches a repository. */
  async stage(file: string, passphrase?: string): Promise<StageResult> {
    await this.ready
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new Error(`${file} isn’t a file`)
    if (info.size > this.limits.fileBytes) throw new ExportFileError('too-large', 'This file is larger than Foreman will open.')
    let bytes: Buffer = await readFile(file)
    if (isEncrypted(bytes)) {
      if (!passphrase) return { kind: 'needs-passphrase' }
      bytes = await decrypt(bytes, passphrase, this.limits)
    }
    const { manifest, entries } = parse(bytes, this.limits)
    const byPath = new Map(entries.map((e) => [e.path, e]))

    const wsRaw = readJson(byPath, 'workspace.json')
    if (!isObject(wsRaw) || !isObject(wsRaw.workspace) || !isObject(wsRaw.repo)) throw new ExportFileError('tampered', 'workspace.json in the file is not valid.')
    const w = wsRaw.workspace
    const workspace: WorkspaceData = {
      id: str(w.id, 100) ?? '',
      name: str(w.name, 200) ?? '',
      branch: str(w.branch, 500) ?? '',
      baseBranch: str(w.baseBranch, 500) ?? '',
      createdAt: str(w.createdAt, 40) ?? new Date().toISOString()
    }
    if (!workspace.id || !workspace.name || !workspace.branch) throw new ExportFileError('tampered', 'workspace.json in the file is not valid.')
    if (typeof w.status === 'string' && STATUSES.has(w.status)) workspace.status = w.status as Workspace['status']
    if (isObject(w.prInfo) && typeof w.prInfo.number === 'number' && typeof w.prInfo.state === 'string') workspace.prInfo = { number: w.prInfo.number, state: w.prInfo.state as never, url: str(w.prInfo.url, 500) }
    if (str(w.note, 100_000)?.trim()) {
      workspace.note = w.note as string
      workspace.noteRevision = typeof w.noteRevision === 'number' && Number.isInteger(w.noteRevision) && w.noteRevision > 0 ? w.noteRevision : 1
    }
    const r = wsRaw.repo
    const repo: RepoEvidence = { name: str(r.name, 200) ?? workspace.name, remoteUrl: str(r.remoteUrl, 500), rootCommit: str(r.rootCommit, 100), defaultBranch: str(r.defaultBranch, 200) }
    repo.integrations = importIntegrationChoices(r.integrations)

    const sessionsRaw = readJson(byPath, 'sessions.json')
    if (!Array.isArray(sessionsRaw)) throw new ExportFileError('tampered', 'sessions.json in the file is not valid.')
    const sessions = sessionsRaw.map(sanitizeSession)
    if (new Set(sessions.map((s) => s.id)).size !== sessions.length) throw new ExportFileError('tampered', 'The file lists a chat twice.')
    const chats = new Map<string, ChatItem[]>()
    for (const s of sessions) chats.set(s.id, sanitizeItems(readJson(byPath, `chat/${s.id}.json`)))

    const commentsRaw = readJson(byPath, 'comments.json')
    const comments = (Array.isArray(commentsRaw) ? commentsRaw : []).map(sanitizeComment).filter((c): c is DiffComment => c !== null)
    const varsRaw = readJson(byPath, 'variables.json')
    const variables = (Array.isArray(varsRaw) ? varsRaw : [])
      .filter((v): v is ExportedVariable => isObject(v) && (v.scope === 'user' || v.scope === 'repo') && typeof v.name === 'string' && v.name.length <= 200)
      .map((v) => ({ scope: v.scope, name: v.name }))

    // Quarantine: every entry lands under one folder that nothing else reads until the user confirms.
    const id = randomUUID()
    const dir = path.join(this.quarantineRoot, id)
    for (const entry of entries) {
      const target = path.resolve(dir, entry.path)
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new ExportFileError('unsafe', `“${entry.path}” would land outside the quarantine folder.`)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, entry.data, { flag: 'wx' })
    }

    const attachmentHashes = new Set(entries.filter((e) => e.path.startsWith('attachments/')).map((e) => e.path.slice('attachments/'.length)))
    const missing = new Set<string>()
    for (const items of chats.values()) {
      for (const item of items) {
        if (item.kind !== 'user') continue
        for (const a of item.attachments ?? []) {
          if (a.path.startsWith('sha256:') && attachmentHashes.has(a.path.slice(7))) continue
          missing.add(a.name)
        }
      }
    }

    const transcripts = new Map<string, TranscriptFile>()
    for (const e of entries) {
      if (!/^transcript\/[^/]+\.json$/.test(e.path)) continue
      const file = readTranscript(e)
      // Only a transcript of a Claude chat in the file can be used; the name must match the contents.
      if (e.path === `transcript/${file.sessionId}.json` && sessions.some((x) => x.agent === 'claude' && x.agentSessionId === file.sessionId)) transcripts.set(file.sessionId, file)
    }
    const worktree = readWorktree(byPath)
    const repos = await this.repoOptions(workspace.branch, repo, worktree ? path.join(dir, 'worktree', 'branch.bundle') : undefined)
    const suggested = repos.filter((o) => o.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length)
    const local = new Set(suggested[0] ? this.deps.variableNames(suggested[0].repoId).map((v) => v.name) : [])
    const dup = this.findDuplicate(manifest.exportId, workspace.id, sessions.map((s) => s.id))
    const tabs: ImportTab[] = sessions
      .filter((s) => !s.closedAt)
      .map((s) => ({
        sessionId: s.id,
        title: s.title || 'New chat',
        agent: s.agent,
        messages: (chats.get(s.id) ?? []).filter((i) => i.kind === 'user' || i.kind === 'assistant').length,
        hasNativeSession: Boolean(s.agentSessionId),
        nativeResume: s.agent === 'claude' && Boolean(s.agentSessionId && transcripts.has(s.agentSessionId)),
        nativeNote: s.agent !== 'claude' ? `${AGENTS[s.agent].label} keeps its conversation on the machine it ran on` : !s.agentSessionId ? 'this chat never started a conversation' : transcripts.has(s.agentSessionId) ? undefined : 'the file has no complete transcript for it'
      }))
    const preview: ImportPreview = {
      stageId: id,
      fileName: path.basename(file),
      version: manifest.version,
      exportId: manifest.exportId,
      mode: manifest.mode,
      sourceMachine: str(manifest.sourceMachine, 200) ?? 'another machine',
      exportedAt: manifest.createdAt,
      workspace: { id: workspace.id, name: workspace.name, branch: workspace.branch, baseBranch: workspace.baseBranch },
      repo,
      suggested,
      repos,
      tabs,
      attachments: attachmentHashes.size,
      missingAttachments: [...missing],
      worktree: worktree ? { branch: worktree.branch, head: worktree.head, omitted: worktree.omitted, omittedMore: worktree.omittedMore, notes: worktree.notes, files: worktree.files.length, summary: bundleSummary(worktree) } : undefined,
      variables,
      variablesToSet: variables.filter((v) => !local.has(v.name)).length,
      comments: comments.length,
      duplicate: dup
    }
    this.stages.set(id, { id, dir, fileName: preview.fileName, manifest, workspace, sessions, comments, variables, repo, attachmentHashes, transcripts: new Set(transcripts.keys()), preview, chats, worktree })
    return { kind: 'staged', preview }
  }

  private async repoOptions(branch: string, evidence: RepoEvidence, bundleFile?: string): Promise<RepoOption[]> {
    const out: RepoOption[] = []
    for (const repo of this.deps.store.state.repos) {
      await this.ensureEvidence(repo)
      const verified = bundleFile ? await verifyBundle(repo.rootPath, bundleFile) : undefined
      out.push({
        bundle: verified ? (verified.ok ? { ok: true } : { ok: false, error: verified.error }) : undefined,
        repoId: repo.id,
        name: repo.name,
        rootPath: repo.rootPath,
        reasons: repoReasons(evidence, repo),
        branchExists: Boolean(await revParse(repo.rootPath, `refs/heads/${branch}`).catch(() => null))
      })
    }
    return out
  }

  /** Repositories added before evidence was recorded get it the first time it is needed. */
  private async ensureEvidence(repo: Repo): Promise<void> {
    if (repo.remoteUrl && repo.rootCommit) return
    const found = await repoEvidence(repo.rootPath, repo.remote || 'origin').catch(() => ({}) as { remoteUrl?: string; rootCommit?: string })
    if (found.remoteUrl && !repo.remoteUrl) repo.remoteUrl = found.remoteUrl
    if (found.rootCommit && !repo.rootCommit) repo.rootCommit = found.rootCommit
  }

  private findDuplicate(exportId: string, workspaceId: string, sessionIds: string[]): ImportPreview['duplicate'] {
    const { workspaces, sessions } = this.deps.store.state
    const byExport = workspaces.find((w) => w.provenance?.exportId === exportId)
    if (byExport) return { workspaceId: byExport.id, name: byExport.name, reason: 'export' }
    const same = workspaces.find((w) => w.id === workspaceId)
    if (same) return { workspaceId: same.id, name: same.name, reason: 'workspace' }
    const clash = sessions.find((s) => sessionIds.includes(s.id))
    const owner = clash && workspaces.find((w) => w.id === clash.workspaceId)
    return owner ? { workspaceId: owner.id, name: owner.name, reason: 'workspace' } : undefined
  }

  async discard(stageId: string): Promise<void> {
    const stage = this.stages.get(stageId)
    this.stages.delete(stageId)
    if (stage) await rm(stage.dir, { recursive: true, force: true })
  }

  // ---- import: commit ----

  /** Create a history-only workspace from a staged file, in the repository the user chose. */
  async importStaged(stageId: string, choice: ImportChoice): Promise<Workspace> {
    const stage = this.stages.get(stageId)
    if (!stage) throw new Error('This import is no longer staged. Choose the file again.')
    const { store } = this.deps
    const repo = this.deps.workspaces.repo(choice.repoId)
    const importedChoices = importIntegrationChoices(stage.repo.integrations)
    const dup = this.findDuplicate(stage.manifest.exportId, stage.workspace.id, stage.sessions.map((s) => s.id))
    if (dup && !choice.asCopy) throw new Error(`This is already here as “${dup.name}”. Open it, or import as a copy.`)

    // Kept IDs are the identity; a copy gets new ones and every reference follows.
    const fresh = Boolean(choice.asCopy)
    const wsId = fresh ? randomUUID() : stage.workspace.id
    const sessionIds = new Map(stage.sessions.map((s) => [s.id, fresh ? randomUUID() : s.id]))
    const importedAt = new Date().toISOString()
    const provenance = provenanceOf(stage.manifest.exportId, stage.preview.sourceMachine, importedAt, typeof stage.manifest.sourceRoot === 'string' && stage.manifest.sourceRoot.length <= 1000 ? stage.manifest.sourceRoot : undefined)
    const root = this.importedDir(wsId)

    const placed = new Map<string, string>()
    const rebind = (a: { name: string; path: string }): string => {
      if (a.path.startsWith('sha256:')) {
        const hash = a.path.slice(7)
        if (stage.attachmentHashes.has(hash)) return path.join(root, 'attachments', hash, safeName(a.name))
      }
      return path.join(root, 'missing', safeName(a.name))
    }
    for (const hash of stage.attachmentHashes) {
      // Names come from the chats that use the file; the blob itself has no name.
      for (const items of stage.chats.values()) {
        for (const item of items) {
          if (item.kind !== 'user') continue
          for (const a of item.attachments ?? []) {
            if (a.path !== `sha256:${hash}`) continue
            const target = rebind(a)
            if (placed.has(target)) continue
            placed.set(target, hash)
            await mkdir(path.dirname(target), { recursive: true })
            await copyFile(path.join(stage.dir, 'attachments', hash), target)
          }
        }
      }
    }

    for (const data of stage.sessions) {
      if (choice.tabs?.[data.id] === 'native' && !(data.agentSessionId && stage.transcripts.has(data.agentSessionId))) {
        throw new Error(`“${data.title || 'New chat'}” has no complete transcript in this file, so it can’t be resumed natively.`)
      }
    }
    const sessions: Session[] = []
    for (const data of stage.sessions) {
      const id = sessionIds.get(data.id)!
      const mode: TabMode = choice.tabs?.[data.id] ?? 'history'
      const items = projectItems(stage.chats.get(data.id) ?? [], { sessionIdFrom: data.id, sessionIdTo: id, dropResume: true, attachment: rebind })
      await store.replaceChat(id, items)
      // Only Native resume keeps the agent's own conversation; the other modes clear its handles, so nothing says "Resumed".
      const { agentSessionId, lastAssistantUuid, ...rest } = data
      const native = mode === 'native'
      if (native && !(agentSessionId && stage.transcripts.has(agentSessionId))) throw new Error(`“${data.title || 'New chat'}” has no complete transcript in this file, so it can’t be resumed natively.`)
      const base: Session = {
        ...rest,
        id,
        workspaceId: wsId,
        status: 'idle',
        queue: [],
        nativeLineage: native ? undefined : 'foreign',
        importedMode: mode,
        provenance
      }
      if (native) {
        const transcript = readTranscript({ path: `transcript/${agentSessionId}.json`, data: await readFile(path.join(stage.dir, 'transcript', `${agentSessionId}.json`)) } as ParsedEntry)
        // Waits under a key no folder owns until the worktree exists; the first turn moves it under that folder's key.
        this.deps.mirror?.write(transcript, pendingKey(wsId))
        base.agentSessionId = agentSessionId
        if (lastAssistantUuid) base.lastAssistantUuid = lastAssistantUuid
        // An import made as a copy continues as a new Claude session instead of sharing the original's id.
        if (fresh) base.forkOnResume = true
      }
      sessions.push(base)
    }
    // Over the open-tab limit: the rest stay as closed (restorable) tabs.
    let open = 0
    for (const s of sessions) {
      if (s.closedAt) continue
      if (++open > MAX_OPEN_TABS) s.closedAt = importedAt
    }

    const known = new Set(store.state.comments.map((c) => c.id))
    const comments = stage.comments.map((c) => ({ ...c, id: fresh || known.has(c.id) ? randomUUID() : c.id, workspaceId: wsId }))
    const names = new Set(store.state.workspaces.filter((w) => w.state !== 'archived').map((w) => w.name))
    const baseName = fresh ? `${stage.workspace.name} (copy)` : stage.workspace.name
    let name = baseName
    for (let n = 2; names.has(name); n++) name = `${baseName} ${n}`
    const local = new Set(this.deps.variableNames(repo.id).map((v) => v.name))
    const toSet = [...new Set(stage.variables.map((v) => v.name))].filter((n) => !local.has(n))

    const ws: Workspace = {
      id: wsId,
      repoId: repo.id,
      name,
      branch: stage.workspace.branch,
      baseBranch: stage.workspace.baseBranch || repo.defaultBranch,
      status: stage.workspace.status,
      prInfo: stage.workspace.prInfo,
      portBase: 0,
      state: 'history',
      provenance,
      variablesToSet: toSet.length ? toSet : undefined,
      createdAt: stage.workspace.createdAt
    }
    if (stage.workspace.note) ws.note = { text: stage.workspace.note, revision: stage.workspace.noteRevision ?? 1, updatedAt: new Date().toISOString() }
    if (stage.worktree) {
      // The bundle waits next to the (history-only) workspace until Activate.
      const dir = path.join(root, 'worktree')
      await mkdir(path.join(dir, 'files'), { recursive: true })
      await copyFile(path.join(stage.dir, 'worktree', 'branch.bundle'), path.join(dir, 'branch.bundle'))
      for (const f of stage.worktree.files) await copyFile(path.join(stage.dir, f.entry), path.join(dir, 'files', f.entry.split('/').pop()!))
      await writeFile(path.join(dir, 'info.json'), JSON.stringify(stage.worktree))
      ws.carried = { branch: stage.worktree.branch, head: stage.worktree.head, checkpointRef: stage.worktree.checkpointRef, files: stage.worktree.files.length, omitted: stage.worktree.omitted.length + stage.worktree.omittedMore }
    }
    await this.deps.workspaces.addImported(ws)
    if (importedChoices) repo.integrations = importedChoices
    store.state.sessions.push(...sessions)
    store.state.comments.push(...comments)
    store.save()
    this.deps.changed()
    await this.discard(stageId)
    return ws
  }

  // ---- activate ----

  private restores = new Map<string, Promise<void>>()

  /** Resolves when the worktree of an activation that carried a bundle has been restored (or failed). */
  restored(workspaceId: string): Promise<void> {
    return this.restores.get(workspaceId) ?? Promise.resolve()
  }

  /**
   * Give a history-only workspace its worktree. Without a carried bundle that needs the branch to exist here.
   * With one: verify it against this repository, fetch it under new names (never over a branch), create a new
   * worktree with hooks off, restore the checkpoint (the uncommitted work), then run setup as usual.
   */
  async activate(workspaceId: string): Promise<Workspace> {
    const ws = this.deps.workspaces.workspace(workspaceId)
    if (!ws.carried) return this.deps.workspaces.activateWorkspace(workspaceId)
    if (ws.state !== 'history') throw new Error(`${ws.name} already has a worktree`)
    const repo = this.deps.workspaces.repo(ws.repoId)
    const dir = path.join(this.importedDir(ws.id), 'worktree')
    const bundleFile = path.join(dir, 'branch.bundle')
    const info = parseWorktree(JSON.parse(await readFile(path.join(dir, 'info.json'), 'utf8')), () => true, () => new Error('The carried worktree’s description is damaged.'))
    const fetched = await fetchBundle(repo.rootPath, bundleFile, info, ws.id)
    const undo = async () => {
      await git(repo.rootPath, ['update-ref', '-d', CHECKPOINT_REF_PREFIX + fetched.checkpointId], { allowFail: true })
      if (fetched.branch !== info.branch || !(await revParse(repo.rootPath, `refs/heads/${info.branch}`))) await git(repo.rootPath, ['branch', '-D', fetched.branch], { allowFail: true })
    }
    try {
      await this.deps.workspaces.activateWorkspace(workspaceId, { branch: fetched.branch, deferSetup: true, noHooks: true })
    } catch (err) {
      await undo()
      throw err
    }
    const run = this.restoreInto(ws, info, fetched.checkpointId, dir, repo.rootPath).finally(() => this.restores.delete(workspaceId))
    this.restores.set(workspaceId, run)
    return ws
  }

  private async restoreInto(ws: Workspace, info: WorktreeInfo, checkpointId: string, dir: string, repoRoot: string): Promise<void> {
    const { workspaces } = this.deps
    try {
      await workspaces.worktreePrepared(ws.id)
      await restoreCheckpoint(wsPath(ws), checkpointId)
      for (const f of info.files) {
        const target = path.join(wsPath(ws), f.path)
        // Never over a file this machine already has (the repository's own copy of the same file).
        if (existsSync(target)) continue
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(path.join(dir, 'files', f.entry.split('/').pop()!), target)
      }
      delete ws.carried
      await rm(dir, { recursive: true, force: true })
      workspaces.continueSetup(ws.id)
    } catch (err) {
      workspaces.continueSetup(ws.id, `Couldn’t restore the uncommitted work: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await deleteCheckpoints(repoRoot, checkpointId).catch(() => undefined)
    }
  }
}
