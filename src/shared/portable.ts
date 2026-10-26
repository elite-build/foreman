// Export and import of one workspace: the types both sides share, plus the pure
// rules (repository matching, path safety, ID remapping, per-tab modes).
import type { AgentKind } from './agents'
import { createT, type PlainKey, type TFunction } from './i18n'
import type { ChatItem, Provenance } from './types'
import type { WorktreeInfo, WorktreeResult } from './worktreeBundle'

const enT = createT('en')

export const EXPORT_FORMAT = 'foreman-export'
export const EXPORT_VERSION = 1

/** Backup: everything Foreman owns, encrypted. Share: chats you reviewed, in the clear. */
export type ExportMode = 'backup' | 'share'

export interface ExportOptions {
  mode: ExportMode
  // Backup only: encrypts the file (AES-256-GCM, scrypt key).
  passphrase?: string
  // Share only: the chats to include (default: every open chat).
  sessionIds?: string[]
  // Share only: keep what tools printed (off by default).
  includeToolOutput?: boolean
  // Share only: package attached files (on by default).
  includeAttachments?: boolean
  // Share only: include review comments (on by default).
  includeComments?: boolean
  // Move the branch and uncommitted work as a git bundle. Backup: on unless false. Share: off unless true.
  includeWorktree?: boolean
  // With the bundle: also bring ignored files that match the repo's "files to copy" list.
  includeCopyFiles?: boolean
  // Claude's own transcripts of complete mirrors, so the receiver can resume natively. Backup: always. Share: only when true
  // (a transcript holds everything the agent saw, tool output included).
  includeTranscripts?: boolean
  // Where to write the file.
  outPath: string
}

export interface ExportChatInfo {
  id: string
  title: string
  agent: AgentKind
  closed: boolean
  messages: number
  toolCalls: number
  attachments: number
}

export interface ExportInfo {
  workspace: string
  chats: ExportChatInfo[]
  // Variable names the workspace's repository and the user scope hold (never values).
  variables: number
  comments: number
  // Whether the workspace has a worktree on disk that a bundle could be made from, and why not otherwise.
  worktree: { available: boolean; reason?: string; copyFiles: number }
}

export interface ExportSummary {
  path: string
  bytes: number
  exportId: string
  mode: ExportMode
  encrypted: boolean
  chats: number
  attachments: number
  variables: number
  // What happened to the branch and uncommitted work.
  worktree?: WorktreeResult
  // Claude transcripts packaged, and chats whose mirror was incomplete (so they stay fresh/history on import).
  transcripts: number
  transcriptsSkipped: { title: string; reason: string }[]
}

/** The file's manifest: what it is and how to check it. */
export interface ExportManifest {
  format: typeof EXPORT_FORMAT
  version: number
  exportId: string
  createdAt: string
  sourceMachine: string
  appVersion?: string
  mode: ExportMode
  workspaceName: string
  // Structured tool path fields were rewritten relative to the workspace; no machine path is in the file.
  pathsRelative?: boolean
  // Files written before paths were made relative carried the source folder here. Still read, never written.
  sourceRoot?: string
  // sha256 over "path:hash" lines of every entry, so entries can't be swapped or dropped unnoticed.
  contentHash: string
}

export interface ExportedVariable {
  scope: 'user' | 'repo'
  name: string
}

export interface RepoEvidence {
  integrations?: import('./integrations').RepoIntegrations
  name: string
  remoteUrl?: string
  rootCommit?: string
  defaultBranch?: string
}

export type TabMode = 'history' | 'fresh' | 'native'

export interface ImportTab {
  sessionId: string
  title: string
  agent: AgentKind
  messages: number
  // The file carried the agent's own session id.
  hasNativeSession: boolean
  // A Claude chat whose complete transcript is in the file, so Native resume can be chosen.
  nativeResume: boolean
  // Why Native resume isn't offered (agent, no transcript...), for the dialog.
  nativeNote?: string
}

export interface RepoOption {
  repoId: string
  name: string
  rootPath: string
  // Why Foreman suggests it: 'remote' (same remote URL) or 'root commit'.
  reasons: ('remote' | 'root commit')[]
  // The workspace's branch exists locally in this repository, so Activate can work.
  branchExists: boolean
  // The file carries a branch bundle: whether it verifies against this repository, or why not.
  bundle?: { ok: boolean; error?: string }
}

export interface ImportPreview {
  stageId: string
  fileName: string
  version: number
  exportId: string
  mode: ExportMode
  sourceMachine: string
  exportedAt: string
  workspace: { id: string; name: string; branch: string; baseBranch: string }
  repo: RepoEvidence
  // Suggestions only; the user confirms which repository this belongs to.
  suggested: RepoOption[]
  repos: RepoOption[]
  tabs: ImportTab[]
  attachments: number
  missingAttachments: string[]
  // The file carries the branch and uncommitted work.
  worktree?: Pick<WorktreeInfo, 'branch' | 'head' | 'omitted' | 'omittedMore' | 'notes'> & { files: number; summary: string }
  variables: ExportedVariable[]
  // Variables not yet set here (for the suggested repository, or all of them when none is suggested).
  variablesToSet: number
  comments: number
  // The same export, or the same workspace, is already here.
  duplicate?: { workspaceId: string; name: string; reason: 'export' | 'workspace' }
}

export type StageResult = { kind: 'needs-passphrase' } | { kind: 'staged'; preview: ImportPreview }

export interface ImportChoice {
  repoId: string
  // Mint fresh IDs for the workspace and its chats, instead of keeping them.
  asCopy?: boolean
  // Per tab; anything absent is history only.
  tabs?: Record<string, TabMode>
}

// ---- repository matching ----

/** `git@github.com:Acme/App.git`, `https://user:tok@github.com/acme/app` and `ssh://git@github.com/acme/app.git/` all become `github.com/acme/app`. */
export function normalizeRemoteUrl(url: string): string {
  let rest = url.trim()
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  rest = rest.replace(/^[^@/]*@/, '')
  // scp-like `host:owner/repo`.
  rest = rest.replace(/^([^/:]+):(?!\d+\/)/, '$1/')
  rest = rest.replace(/^([^/:]+):\d+\//, '$1/')
  rest = rest.replace(/\/+$/, '').replace(/\.git$/i, '')
  const slash = rest.indexOf('/')
  return slash < 0 ? rest.toLowerCase() : rest.slice(0, slash).toLowerCase() + rest.slice(slash).toLowerCase()
}

export function repoReasons(evidence: RepoEvidence, repo: { remoteUrl?: string; rootCommit?: string }): RepoOption['reasons'] {
  const reasons: RepoOption['reasons'] = []
  if (evidence.remoteUrl && repo.remoteUrl && normalizeRemoteUrl(evidence.remoteUrl) === normalizeRemoteUrl(repo.remoteUrl)) reasons.push('remote')
  if (evidence.rootCommit && repo.rootCommit && evidence.rootCommit === repo.rootCommit) reasons.push('root commit')
  return reasons
}

// ---- paths inside a file ----

/** Why an entry path inside an export isn't acceptable, or null when it is. */
export function unsafeEntryPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'empty path'
  if (p.length > 240) return 'path too long'
  if (p.includes('\0')) return 'NUL in path'
  if (p.includes('\\')) return 'backslash in path'
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'absolute path'
  if (p.includes(':')) return 'colon in path'
  for (const part of p.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'path traversal'
  }
  return null
}

// ---- chat projection ----

/** The id Foreman gives a turn's start checkpoint; the session id leads it (see turnDelta.ts). */
export function remapCheckpoint(checkpoint: string, from: string, to: string): string {
  return checkpoint.startsWith(from) ? to + checkpoint.slice(from.length) : checkpoint
}

/**
 * Items as they travel or arrive. `attachment` maps an item's attachment to its new
 * path (or null to leave it as is). A copy remaps checkpoint ids to the new chat id.
 * Native resume points (`resumeFrom`) never survive: there is no native resume yet,
 * and a chat that isn't a native continuation must never be labelled "Resumed".
 */
export function projectItems(
  items: ChatItem[],
  options: { sessionIdFrom?: string; sessionIdTo?: string; dropResume?: boolean; dropToolOutput?: boolean; relativeTo?: string; attachment?: (a: { name: string; path: string; kind: string }) => string }
): ChatItem[] {
  return items.map((item) => {
    if (item.kind === 'tool') {
      let next = item
      if (options.dropToolOutput) {
        const { output: _output, ...rest } = item
        void _output
        next = rest
      }
      return options.relativeTo ? { ...next, input: relativizeToolInput(next.input, options.relativeTo) } : next
    }
    if (item.kind !== 'user') return item
    const next = { ...item }
    if (options.dropResume) delete next.resumeFrom
    if (next.checkpoint && options.sessionIdFrom && options.sessionIdTo && options.sessionIdFrom !== options.sessionIdTo) {
      next.checkpoint = remapCheckpoint(next.checkpoint, options.sessionIdFrom, options.sessionIdTo)
    }
    if (next.attachments && options.attachment) {
      const rewrite = options.attachment
      next.attachments = next.attachments.map((a) => ({ ...a, path: rewrite(a) }))
    }
    return next
  })
}

/** Structured fields of a tool call that hold a file or folder (never free text such as a command). */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path', 'filePath', 'file', 'cwd', 'directory', 'dir'])

/** A tool input with its structured path fields made relative to the workspace folder. */
export function relativizeToolInput(input: unknown, root: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const key of Object.keys(out)) {
    const v = out[key]
    if (!PATH_FIELDS.has(key) || typeof v !== 'string') continue
    if (v === root) out[key] = '.'
    else {
      const rel = relativeToRoots(v, root)
      // Outside the workspace there is no relative form; keep only the name.
      out[key] = rel !== v || !/^([/\\]|[a-zA-Z]:)/.test(v) ? rel : `(outside workspace)/${v.split(/[/\\]/).pop()}`
    }
  }
  return out
}

export function provenanceOf(exportId: string, sourceMachine: string, importedAt: string, sourceRoot?: string): Provenance {
  return { exportId, sourceMachine, importedAt, ...(sourceRoot ? { sourceRoot } : {}) }
}

/** Keys: show them with t(TAB_MODE_LABEL[mode]). */
export const TAB_MODE_LABEL: Record<TabMode | 'native', PlainKey> = {
  history: 'portable.tabMode.history',
  fresh: 'portable.tabMode.fresh',
  native: 'portable.tabMode.native'
}

export const NATIVE_RESUME_NOTE: PlainKey = 'portable.nativeResumeNote'

/** Roots a tool path may be shown relative to: this workspace's folder, then the folder an import came from. */
export function toolRoots(ws: { path?: string; provenance?: { sourceRoot?: string } }): string[] {
  return [ws.path, ws.provenance?.sourceRoot].filter((r): r is string => Boolean(r))
}

/** The import dialog's confirm label, from the per-tab choices. */
export function importLabel(modes: TabMode[], t: TFunction = enT): string {
  const fresh = modes.filter((m) => m === 'fresh').length
  const native = modes.filter((m) => m === 'native').length
  const history = modes.length - fresh - native
  const parts = [native ? t('portable.import.native', { count: native }) : '', fresh ? t('portable.import.fresh', { count: fresh }) : '', history ? t('portable.import.history', { count: history }) : ''].filter(Boolean)
  return parts.length ? t('portable.import.withCounts', { counts: parts.join(', ') }) : t('portable.import.go')
}

/** A tool path relative to the first root it sits under; the text of the transcript is never touched. */
export function relativeToRoots(file: unknown, root: string | string[]): string {
  const p = String(file ?? '')
  for (const r of Array.isArray(root) ? root : [root]) {
    if (!r) continue
    const sep = r.includes('\\') ? '\\' : '/'
    if (p.startsWith(r + sep)) {
      const relative = p.slice(r.length + 1)
      // Exported structured paths must also work when imported on another OS.
      return sep === '\\' ? relative.replaceAll('\\', '/') : relative
    }
  }
  return p
}
