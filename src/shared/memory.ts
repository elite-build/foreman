// The memory repository (docs/ai-employees.md §4): what its service answers and the rules every write is held to. Pure,
// so main, the renderer and the tests read the same rules; the service itself is src/main/memory.ts.

/** The folders Foreman reads and writes in a memory repository; everything else in it is left alone. */
export const MEMORY_ROOTS = ['memory', 'bots', 'repos'] as const

/** The largest file a write may leave behind, in bytes (UTF-8). */
export const MAX_MEMORY_FILE_BYTES = 256 * 1024

/** The most results a search returns. */
export const MEMORY_SEARCH_LIMIT = 10

/** The trailers a commit carries: who made it and for which run and task (§4), or that a person edited by hand. */
export const MEMORY_TRAILERS = {
  employee: 'Foreman-Employee',
  run: 'Foreman-Run',
  task: 'Foreman-Task',
  editedBy: 'Foreman-Edited-By',
  acceptedBy: 'Foreman-Accepted-By',
  // An employee's proposal a person kept: who proposed it, and that a person kept it.
  proposedBy: 'Foreman-Proposed-By',
  keptBy: 'Foreman-Kept-By'
} as const

/** A file in the memory repository at its head commit. */
export interface MemoryEntry {
  // Relative to the repository, `/` between folders.
  path: string
  blob: string
  size: number
}

export interface MemoryTree {
  head: string
  entries: MemoryEntry[]
}

/** One file as it is at `head` (or, inside a run, with the run's staged changes over it). */
export interface MemoryFile {
  path: string
  head: string
  // null: there is no such file.
  blob: string | null
  size: number
  // Absent when the file is binary, too large or missing.
  text?: string
  binary: boolean
  tooLarge: boolean
}

/** A commit that touched a file, newest first. */
export interface MemoryCommit {
  commit: string
  author: string
  email: string
  // ISO 8601.
  date: string
  subject: string
  // In the order the message has them; Foreman's are MEMORY_TRAILERS.
  trailers: { key: string; value: string }[]
}

export interface MemorySearchHit {
  path: string
  blob: string
  // Matches between \u0001 and \u0002 (shared/chatIndex.ts snippetParts).
  snippet: string
  // bm25: lower is better.
  rank: number
}

/** A commit in the memory repository that Foreman didn't make. */
export interface MemoryForeignCommit {
  commit: string
  author: string
  date: string
  subject: string
}

/**
 * Whether Foreman may write. `foreign`: the head isn't the service's last commit, or the folder has uncommitted changes;
 * nothing is written until a person accepts them (or puts things back). `unavailable`: the folder is missing, isn't a
 * git repository, has no commit, is on another branch than its default one, or is in the middle of a merge or rebase.
 */
export type MemoryStatus =
  | { state: 'ok'; head: string }
  | { state: 'foreign'; head: string; baseline: string; commits: MemoryForeignCommit[]; moreCommits: number; dirty: string[] }
  | { state: 'unavailable'; reason: 'missing' | 'not-git' | 'empty' | 'branch' | 'busy'; branch?: string }

/** A person's edit: committed, or refused because the file changed since it was read (both versions to compare). */
export type MemoryWriteResult =
  | { ok: true; blob: string | null; commit: string | null }
  | { ok: false; conflict: { blob: string | null; text: string | null } }

/** One change a run (or a person) makes. `expectedBlob`: the version the change was made against; null: the file must not exist; absent: no check. */
export type MemoryChange =
  | { kind: 'write'; path: string; text: string; expectedBlob?: string | null }
  | { kind: 'append'; path: string; text: string; expectedBlob?: string | null }
  | { kind: 'delete'; path: string; expectedBlob?: string | null }

/** proposed: an employee's change to a file it may only propose (docs/ai-employees.md §4), waiting for a person's Keep or Retire. */
export type MemoryMutationState = 'staged' | 'committing' | 'committed' | 'refused' | 'conflict' | 'proposed'

/**
 * An employee's proposed change to the organization's memory (§4, "Foreign changes are proposals"; §10, Needs you and the
 * Memory view): one file, kept as a person's commit or retired.
 */
export interface MemoryProposal {
  id: string
  orgId: string
  path: string
  // append: adds `text` to the end; write: replaces the file with `text` (against `expectedBlob` when given).
  kind: 'append' | 'write'
  text: string
  expectedBlob?: string | null
  employeeId: string
  runId: string
  taskId?: string
  // Why it is a proposal, in the words the employee was told.
  why?: string
  createdAt: string
}

export type MemoryPathProblem = 'empty' | 'absolute' | 'invalid' | 'parent' | 'git' | 'outside'

// Characters Windows can't put in a file name, and control characters.
// eslint-disable-next-line no-control-regex
const BAD_CHARACTERS = /[<>:"|?*\u0000-\u001f\\]/

/**
 * Why `path` can't be written in a memory repository, or null. It stays inside the repository and inside one of
 * MEMORY_ROOTS, names no `.git` file or folder (`.gitkeep` excepted), and is a name every platform can hold.
 */
export function memoryPathProblem(path: string): MemoryPathProblem | null {
  if (typeof path !== 'string' || !path) return 'empty'
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'absolute'
  const parts = path.split('/')
  for (const part of parts) {
    if (part === '.' || part === '..') return 'parent'
    if (!part || BAD_CHARACTERS.test(part) || /[. ]$/.test(part)) return 'invalid'
    if (/^\.git/i.test(part) && part.toLowerCase() !== '.gitkeep') return 'git'
  }
  if (parts.length < 2 || !(MEMORY_ROOTS as readonly string[]).includes(parts[0])) return 'outside'
  return null
}

/** What a refused path is told, in the words the model and the person read (main-process errors are English). */
export const MEMORY_PATH_REASON: Record<MemoryPathProblem, string> = {
  empty: 'Name a file.',
  absolute: 'Use a path inside the memory repository, not an absolute one.',
  invalid: 'Use a path of plain file and folder names, with / between them.',
  parent: 'Use a path that stays inside the memory repository (no . or ..).',
  git: 'Git’s own files can’t be written.',
  outside: `Only files under ${MEMORY_ROOTS.map((r) => `${r}/`).join(', ')} can be written.`
}

/** "Key: value" lines from `%(trailers:only,unfold)`. */
export function parseTrailers(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line.trim())
    if (m) out.push({ key: m[1], value: m[2].trim() })
  }
  return out
}

/** A trailer's value on one line, as git needs it: no line breaks, trimmed. */
export function trailerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** An employee id that names a folder (`memory/bots/<id>/`): lower-case letters, digits and dashes. */
export function isEmployeeId(id: string): boolean {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** The folders that hold `entries`, every level, for a tree. */
export function memoryFolders(entries: readonly { path: string }[]): string[] {
  const folders = new Set<string>()
  for (const e of entries) {
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders]
}
