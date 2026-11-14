// The memory service (docs/ai-employees.md §4): the only automatic writer of an organization's memory repository. It
// reads the repository at its default branch's head, stages a run's changes and commits them as one commit with the
// run's trailers, commits a person's edit at once, and keeps a search index over the repository in foreman.db.
//
// Every commit is an intent first: a memory_mutations row is written before git is touched, the commit is built in a
// temporary index against the expected head, the branch moves only if it is still at that head, the folder is brought
// up to the new commit, and then the row is finalised. A row left `committing` (Foreman closed in between) is settled
// from git on the next start. Before each commit the head must be the service's own last commit and the folder clean;
// otherwise the organization's memory is `foreign` and nothing is written until a person accepts. Nothing here resets,
// reverts or deletes anything it didn't write, and one organization's writes go one at a time.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ftsQuery } from '../shared/chatIndex'
import {
  isEmployeeId,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_PATH_REASON,
  MEMORY_ROOTS,
  MEMORY_SEARCH_LIMIT,
  MEMORY_TRAILERS,
  memoryPathProblem,
  parseTrailers,
  trailerValue,
  type MemoryChange,
  type MemoryCommit,
  type MemoryEntry,
  type MemoryFile,
  type MemoryForeignCommit,
  type MemoryProposal,
  type MemorySearchHit,
  type MemoryStatus,
  type MemoryTree,
  type MemoryWriteResult
} from '../shared/memory'
import { MEMORY_MANIFEST, type Organization } from '../shared/organizations'
import { secretLines } from '../shared/reportProblem'
import { sensitiveMatches } from '../shared/sensitive'
import type { Repo } from '../shared/types'
import type { ForemanDb, MemoryMutationDetail, MemoryMutationRow } from './db'
import { busyOperation, git, gitBlob, revParse } from './git'
import type { PersistedState } from './store'

/** Who Foreman's own commits (and, unless a run names its employee, a run's) are by. */
export const FOREMAN_IDENTITY = { name: 'Foreman', email: 'foreman@localhost' }

// At most this many foreign commits are listed; the rest are counted.
const FOREIGN_LISTED = 20

export type MemoryRefusalReason = 'no-memory' | 'path' | 'size' | 'binary' | 'secret' | 'sensitive' | 'foreign' | 'unavailable' | 'identity' | 'invalid'

/** A write or read the service won't do, with why in words the person (or the model) reads. */
export class MemoryRefused extends Error {
  constructor(
    message: string,
    readonly reason: MemoryRefusalReason
  ) {
    super(message)
  }
}

export interface MemoryHost {
  state(): PersistedState
  db(): ForemanDb
  // The memory repository's sensitive paths (its settings' `sensitive_paths`); a write to one is refused.
  sensitivePaths(repo: Repo): string[]
  // Something the window shows changed (a status).
  changed(): void
  // A commit Foreman made landed on the memory repository's branch: the paths it changed and its trailers (AI employees'
  // memory events, main/employeeEvents.ts). Told once, after the branch moved; never for a commit Foreman didn't make.
  committed?(commit: MemoryCommitted): void
  // Tests only: a point in a commit where Foreman could close. Throwing here leaves the intent `committing`.
  fault?(step: 'after-ref'): void
}

interface Target {
  org: Organization
  repo: Repo
  root: string
  branch: string
}

type Snapshot = { blob: string | null; text: string | null }

/** A commit the service made, as its host is told (MemoryHost.committed). */
export interface MemoryCommitted {
  orgId: string
  commit: string
  paths: string[]
  subject: string
  trailers: { key: string; value: string }[]
}

type CommitOutcome = { kind: 'committed'; commit: string | null; blobs: Map<string, string | null> } | { kind: 'conflict'; path: string; current: Snapshot }

export interface RunCommitMeta {
  // The commit's author; absent: Foreman.
  author?: { name: string; email: string }
  trailers?: { employee?: string; task?: string }
  subject?: string
}

const isRoot = (p: string) => (MEMORY_ROOTS as readonly string[]).includes(p.split('/')[0])

/** The text after a change, from the text before it (null: no file). */
function applied(before: string | null, change: MemoryChange): string | null {
  if (change.kind === 'delete') return null
  if (change.kind === 'write') return change.text
  if (!before) return change.text.replace(/^\n+/, '')
  return (before.endsWith('\n') ? before : `${before}\n`) + change.text
}

const foreignMessage = 'The memory repository has changes Foreman didn’t make. Accept them in its Memory view to let Foreman write again.'

function unavailableMessage(status: Extract<MemoryStatus, { state: 'unavailable' }>): string {
  switch (status.reason) {
    case 'missing':
      return 'The memory repository’s folder is missing.'
    case 'not-git':
      return 'The memory repository’s folder isn’t a git repository.'
    case 'empty':
      return 'The memory repository has no commit yet.'
    case 'branch':
      return `The memory repository isn’t on its default branch. Check out ${status.branch ?? 'it'} there first.`
    case 'busy':
      return 'The memory repository is in the middle of a merge, rebase or similar. Finish it first.'
  }
}

export class MemoryService {
  // One writer at a time per organization: each operation waits for the one before it.
  private queues = new Map<string, Promise<unknown>>()
  // Organizations whose unfinished intents were settled since this process started.
  private reconciled = new Set<string>()
  // The last status worked out per organization, for the snapshot.
  private statusCache = new Map<string, MemoryStatus>()
  // Object format per folder (sha1 or sha256), for blob ids worked out without git.
  private formats = new Map<string, string>()

  constructor(private host: MemoryHost) {}

  private get db(): ForemanDb {
    return this.host.db()
  }

  // ---- organizations and their folders ----

  /** The organization's memory repository, or a refusal: no such organization, or no memory repository. */
  private target(orgId: string): Target {
    const state = this.host.state()
    const org = (state.organizations ?? []).find((o) => o.id === orgId)
    if (!org) throw new MemoryRefused('Organization not found', 'no-memory')
    const repo = org.memoryRepoId ? state.repos.find((r) => r.id === org.memoryRepoId) : undefined
    if (!repo) throw new MemoryRefused(`${org.name} has no memory repository. Choose one in Settings → Spaces.`, 'no-memory')
    return { org, repo, root: repo.rootPath, branch: repo.defaultBranch || 'main' }
  }

  private exclusive<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.queues.get(orgId) ?? Promise.resolve()
    const run = before.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(orgId, settled)
    void settled.then(() => {
      if (this.queues.get(orgId) === settled) this.queues.delete(orgId)
    })
    return run
  }

  private async blobId(root: string, text: string): Promise<string> {
    let format = this.formats.get(root)
    if (!format) {
      const out = await git(root, ['rev-parse', '--show-object-format'], { allowFail: true })
      format = out.code === 0 && out.stdout.trim() === 'sha256' ? 'sha256' : 'sha1'
      this.formats.set(root, format)
    }
    const bytes = Buffer.from(text, 'utf8')
    return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  }

  private head(t: Target): Promise<string | null> {
    return revParse(t.root, `refs/heads/${t.branch}`)
  }

  // ---- status and foreign changes ----

  /** Uncommitted changes in the folder (ignored files aren't). */
  private async dirtyPaths(root: string): Promise<string[]> {
    const out = await git(root, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const parts = out.stdout.split('\0')
    const paths: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]
      if (entry.length < 4) continue
      paths.push(entry.slice(3))
      // A rename or copy names where it came from next.
      if (entry[0] === 'R' || entry[0] === 'C') i++
    }
    return paths
  }

  /** Where the memory repository stands against the service's own last commit. The first look adopts the head. */
  private async inspect(t: Target): Promise<MemoryStatus> {
    if (!existsSync(t.root)) return { state: 'unavailable', reason: 'missing' }
    if ((await git(t.root, ['rev-parse', '--git-dir'], { allowFail: true })).code !== 0) return { state: 'unavailable', reason: 'not-git' }
    const head = await this.head(t)
    if (!head) return { state: 'unavailable', reason: 'empty', branch: t.branch }
    const current = (await git(t.root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim()
    if (current !== `refs/heads/${t.branch}`) return { state: 'unavailable', reason: 'branch', branch: t.branch }
    if (await busyOperation(t.root)) return { state: 'unavailable', reason: 'busy' }
    let baseline = this.db.memoryBaseline(t.org.id)
    if (!baseline) {
      // Made by Foreman, or picked by the person: either way what is there now is where Foreman starts.
      baseline = head
      this.db.setMemoryBaseline(t.org.id, head)
    }
    const dirty = await this.dirtyPaths(t.root)
    if (head === baseline && !dirty.length) return { state: 'ok', head }
    let commits: MemoryForeignCommit[] = []
    if (head !== baseline) {
      const known = (await git(t.root, ['cat-file', '-e', `${baseline}^{commit}`], { allowFail: true })).code === 0
      const out = await git(t.root, ['log', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', ...(known ? [`${baseline}..${head}`] : ['-1', head])], { allowFail: true })
      commits = out.stdout
        .split('\x1e')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [commit, author, date, subject] = r.split('\x1f')
          return { commit, author, date, subject: subject ?? '' }
        })
    }
    return { state: 'foreign', head, baseline, commits: commits.slice(0, FOREIGN_LISTED), moreCommits: Math.max(0, commits.length - FOREIGN_LISTED), dirty }
  }

  private remember(orgId: string, status: MemoryStatus): MemoryStatus {
    const before = this.statusCache.get(orgId)
    this.statusCache.set(orgId, status)
    if (JSON.stringify(before) !== JSON.stringify(status)) this.host.changed()
    return status
  }

  /** Look again, settle unfinished intents first. */
  async status(orgId: string): Promise<MemoryStatus> {
    const t = this.target(orgId)
    return this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      return this.remember(orgId, await this.inspect(t))
    })
  }

  /** The last status of each organization with a memory repository, for the snapshot (while AI employees are on). */
  statuses(): Record<string, MemoryStatus> {
    const state = this.host.state()
    const out: Record<string, MemoryStatus> = {}
    for (const org of state.organizations ?? []) {
      const status = org.memoryRepoId ? this.statusCache.get(org.id) : undefined
      if (status) out[org.id] = status
    }
    return out
  }

  /**
   * The person accepts what Foreman didn't make: uncommitted changes are committed as theirs (git's configured user,
   * `Foreman-Accepted-By: person`), and the head becomes the service's baseline. Nothing is reset or reverted.
   */
  async acceptForeign(orgId: string): Promise<MemoryStatus> {
    const t = this.target(orgId)
    const status = await this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      const status = await this.inspect(t)
      if (status.state === 'unavailable') throw new MemoryRefused(unavailableMessage(status), 'unavailable')
      if (status.state === 'ok') return this.remember(orgId, status)
      let head = status.head
      if (status.dirty.length) {
        await git(t.root, ['add', '-A'])
        const tree = (await git(t.root, ['write-tree'])).stdout.trim()
        const headTree = (await git(t.root, ['rev-parse', `${head}^{tree}`])).stdout.trim()
        if (tree !== headTree) {
          const commit = await this.commitTree(t, tree, head, `Accept changes made outside Foreman\n\n${MEMORY_TRAILERS.acceptedBy}: person\n`, undefined)
          const moved = await git(t.root, ['update-ref', '-m', 'Foreman memory: accept', `refs/heads/${t.branch}`, commit, head], { allowFail: true })
          if (moved.code !== 0) throw new MemoryRefused('The memory repository changed while Foreman was accepting. Look again.', 'foreign')
          head = commit
        }
      }
      this.db.setMemoryBaseline(t.org.id, head)
      return this.remember(orgId, await this.inspect(t))
    })
    if (status.state === 'ok') {
      await this.syncIndex(t)
      await this.syncManifest(orgId)
    }
    return this.statusCache.get(orgId) ?? status
  }

  // ---- reading ----

  /** A path at a commit: its blob and text (null when there is no such file, or it's a folder). */
  private async readAt(t: Target, commit: string, file: string): Promise<Snapshot & { size: number; binary: boolean; tooLarge: boolean }> {
    const out = await git(t.root, ['--literal-pathspecs', 'ls-tree', '-z', '-l', commit, '--', file])
    const entry = out.stdout.split('\0').find((e) => e.endsWith(`\t${file}`))
    const m = entry ? /^\d+ (\w+) ([0-9a-f]+)\s+(-|\d+)\t/.exec(entry) : null
    if (!m || m[1] !== 'blob') return { blob: null, text: null, size: 0, binary: false, tooLarge: false }
    const size = Number(m[3]) || 0
    if (size > MAX_MEMORY_FILE_BYTES) return { blob: m[2], text: null, size, binary: false, tooLarge: true }
    const bytes = await gitBlob(t.root, m[2])
    if (bytes.subarray(0, 8000).includes(0)) return { blob: m[2], text: null, size, binary: true, tooLarge: false }
    return { blob: m[2], text: bytes.toString('utf8'), size, binary: false, tooLarge: false }
  }

  /** The files under memory/, bots/ and repos/ at the head. */
  async tree(orgId: string): Promise<MemoryTree> {
    const t = this.target(orgId)
    const head = await this.head(t)
    if (!head) throw new MemoryRefused('The memory repository has no commit yet.', 'unavailable')
    const out = await git(t.root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', head, '--', ...MEMORY_ROOTS])
    const entries: MemoryEntry[] = []
    for (const line of out.stdout.split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s.exec(line)
      if (m && isRoot(m[3])) entries.push({ path: m[3], blob: m[1], size: Number(m[2]) || 0 })
    }
    return { head, entries }
  }

  /** A file at the head; inside a run (`runId`), with that run's staged changes over it. */
  async read(orgId: string, file: string, options: { runId?: string } = {}): Promise<MemoryFile> {
    const t = this.target(orgId)
    const problem = memoryPathProblem(file)
    if (problem) throw new MemoryRefused(`${file}: ${MEMORY_PATH_REASON[problem]}`, 'path')
    // A run never reads what it may not write: the repository's sensitive paths.
    if (options.runId && sensitiveMatches([file], this.host.sensitivePaths(t.repo)).length) {
      throw new MemoryRefused(`${file} matches the memory repository’s sensitive paths, so Foreman won’t read it to an employee.`, 'sensitive')
    }
    const head = await this.head(t)
    if (!head) throw new MemoryRefused('The memory repository has no commit yet.', 'unavailable')
    const at = await this.readAt(t, head, file)
    const staged = options.runId ? this.stagedRow(orgId, options.runId)?.detail.changes.filter((c) => c.path === file) ?? [] : []
    if (!staged.length) {
      return { path: file, head, blob: at.blob, size: at.size, binary: at.binary, tooLarge: at.tooLarge, ...(at.text !== null ? { text: at.text } : {}) }
    }
    let text = at.text
    for (const change of staged) text = applied(text, change)
    return { path: file, head, blob: text === null ? null : await this.blobId(t.root, text), size: text === null ? 0 : Buffer.byteLength(text), binary: false, tooLarge: false, ...(text !== null ? { text } : {}) }
  }

  /** The commits that touched a file, newest first, with their trailers. */
  async history(orgId: string, file: string, limit = 100): Promise<MemoryCommit[]> {
    const t = this.target(orgId)
    const problem = memoryPathProblem(file)
    if (problem) throw new MemoryRefused(`${file}: ${MEMORY_PATH_REASON[problem]}`, 'path')
    const head = await this.head(t)
    if (!head) return []
    const out = await git(t.root, ['--literal-pathspecs', 'log', `-n${Math.max(1, Math.min(500, limit))}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%(trailers:only,unfold)%x1e', head, '--', file])
    return out.stdout
      .split('\x1e')
      .map((r) => r.replace(/^\n+/, ''))
      .filter((r) => r.trim())
      .map((r) => {
        const [commit, author, email, date, subject, trailers] = r.split('\x1f')
        return { commit, author, email, date, subject: subject ?? '', trailers: parseTrailers(trailers ?? '') }
      })
  }

  // ---- the search index ----

  /**
   * Bring the index up to the head: files whose blob changed are read again, files gone are dropped. Text files under
   * the memory folders only, up to the size cap, never the repository's sensitive paths (search shows nothing a run's
   * read would refuse). A cache: an empty or missing index is simply built again.
   */
  private async syncIndex(t: Target): Promise<void> {
    const head = await this.head(t)
    if (!head) return
    const out = await git(t.root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', head, '--', ...MEMORY_ROOTS])
    const sensitive = this.host.sensitivePaths(t.repo)
    const want = new Map<string, { blob: string; size: number }>()
    for (const line of out.stdout.split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s.exec(line)
      if (!m || !isRoot(m[3]) || m[3].endsWith('/.gitkeep')) continue
      if (sensitive.length && sensitiveMatches([m[3]], sensitive).length) continue
      const size = Number(m[2]) || 0
      if (size <= MAX_MEMORY_FILE_BYTES) want.set(m[3], { blob: m[1], size })
    }
    const have = this.db.memoryDocs(t.org.id)
    const read: { path: string; blob: string; text: string | null }[] = []
    for (const [file, { blob }] of want) {
      if (have.get(file) === blob) continue
      const bytes = await gitBlob(t.root, blob)
      read.push({ path: file, blob, text: bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8') })
    }
    const gone = [...have.keys()].filter((file) => !want.has(file))
    if (!read.length && !gone.length) return
    this.db.transaction(() => {
      for (const file of gone) this.db.deleteMemoryDoc(t.org.id, file)
      for (const doc of read) {
        if (doc.text === null) this.db.deleteMemoryDoc(t.org.id, doc.path)
        else this.db.putMemoryDoc(t.org.id, doc.path, doc.blob, doc.text)
      }
    })
  }

  /** At most 10 files matching every word (the last may be a prefix), best first. */
  async search(orgId: string, query: string, limit = MEMORY_SEARCH_LIMIT): Promise<MemorySearchHit[]> {
    const t = this.target(orgId)
    const match = typeof query === 'string' ? ftsQuery(query) : null
    if (!match) return []
    await this.syncIndex(t)
    return this.db.searchMemory(orgId, match, Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.floor(limit) || MEMORY_SEARCH_LIMIT)))
  }

  // ---- what a write must pass ----

  /** Path rules, the size cap, secret-shaped values and the repository's sensitive paths. Throws with the reason. */
  private check(t: Target, change: MemoryChange): void {
    if (!change || typeof change !== 'object' || !['write', 'append', 'delete'].includes(change.kind)) throw new MemoryRefused('Invalid memory change', 'invalid')
    if (change.expectedBlob !== undefined && change.expectedBlob !== null && typeof change.expectedBlob !== 'string') throw new MemoryRefused('Invalid memory change', 'invalid')
    const problem = memoryPathProblem(change.path)
    if (problem) throw new MemoryRefused(`${change.path}: ${MEMORY_PATH_REASON[problem]}`, 'path')
    if (sensitiveMatches([change.path], this.host.sensitivePaths(t.repo)).length) {
      throw new MemoryRefused(`${change.path} matches the memory repository’s sensitive paths, so Foreman won’t write it.`, 'sensitive')
    }
    if (change.kind === 'delete') return
    if (typeof change.text !== 'string') throw new MemoryRefused('Invalid memory change', 'invalid')
    this.checkSize(change.path, change.text)
    // A private key's armour too, which the token rules (made for one-line tokens) don't cover.
    const keys = change.text.split('\n').flatMap((line, i) => (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line) ? [i + 1] : []))
    const lines = [...new Set([...secretLines(change.text), ...keys])].sort((a, b) => a - b)
    if (lines.length) {
      throw new MemoryRefused(`${change.path}: line ${lines.join(', ')} looks like a key or token. Secrets never go in memory; keep them in Foreman’s environment settings.`, 'secret')
    }
  }

  private checkSize(file: string, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_MEMORY_FILE_BYTES) throw new MemoryRefused(`${file} would be ${Math.ceil(bytes / 1024)} KB; a memory file holds at most ${MAX_MEMORY_FILE_BYTES / 1024} KB.`, 'size')
  }

  // ---- intents ----

  private newRow(orgId: string, runId: string | null, changes: MemoryChange[], detail: Omit<MemoryMutationDetail, 'changes'>): MemoryMutationRow {
    const now = new Date().toISOString()
    return { id: randomUUID(), orgId, runId, state: 'staged', expectedHead: null, commitId: null, paths: [...new Set(changes.map((c) => c.path))], detail: { ...detail, changes }, createdAt: now, updatedAt: now }
  }

  private put(row: MemoryMutationRow, patch: Partial<MemoryMutationRow> = {}): MemoryMutationRow {
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() }
    this.db.putMemoryMutation(next)
    return next
  }

  private stagedRow(orgId: string, runId: string): MemoryMutationRow | undefined {
    return this.db.memoryMutations(orgId, ['staged']).find((r) => r.runId === runId)
  }

  /** Every intent of a run, oldest first: staged, committed, refused (a discarded run's changes stay here) or conflicted. */
  runMutations(orgId: string, runId: string): MemoryMutationRow[] {
    return this.db.memoryMutations(orgId).filter((r) => r.runId === runId)
  }

  private async reconcileOnce(t: Target): Promise<void> {
    if (this.reconciled.has(t.org.id)) return
    this.reconciled.add(t.org.id)
    await this.reconcile(t)
  }

  /**
   * Settle intents left `committing`: the commit is on the branch → committed (and the folder brought up to it if the
   * move stopped short); it isn't → a run's changes are staged again, a person's edit is refused as interrupted.
   */
  private async reconcile(t: Target): Promise<void> {
    const open = this.db.memoryMutations(t.org.id, ['committing'])
    if (!open.length) return
    const head = await this.head(t)
    // A repository git can't read now settles nothing (a commit that landed would be made again): it is tried again later.
    if (!head) {
      this.reconciled.delete(t.org.id)
      return
    }
    for (const row of open) {
      const landed = Boolean(row.commitId) && (head === row.commitId || (await git(t.root, ['merge-base', '--is-ancestor', row.commitId!, head], { allowFail: true })).code === 0)
      if (landed) {
        if (head === row.commitId && row.expectedHead) await this.finishFolder(t, row.expectedHead, row.commitId!)
        this.db.transaction(() => {
          this.put(row, { state: 'committed' })
          if (this.db.memoryBaseline(t.org.id) === row.expectedHead) this.db.setMemoryBaseline(t.org.id, row.commitId!)
        })
      } else if (row.detail.proposal) {
        // A proposal being kept: it waits for Keep or Retire again.
        this.put(row, { state: 'proposed', expectedHead: null, commitId: null })
      } else {
        this.put(row, { state: row.runId ? 'staged' : 'refused', expectedHead: null, commitId: null, detail: { ...row.detail, ...(row.runId ? {} : { reason: 'interrupted' }) } })
      }
    }
  }

  /**
   * A commit attempt failed. An intent whose commit was made may have landed: it stays `committing` and is settled from
   * git by the next operation. Otherwise a run's changes are staged again and anything else is refused, with why.
   */
  private failed(t: Target, rowId: string, err: unknown, fallback: 'staged' | 'refused' | 'proposed'): void {
    const current = this.db.memoryMutation(rowId)
    if (!current || (current.state !== 'committing' && current.state !== 'staged')) return
    if (current.state === 'committing' && current.commitId) {
      this.reconciled.delete(t.org.id)
      return
    }
    const reason = err instanceof Error ? err.message : String(err)
    this.put(current, { state: fallback, expectedHead: null, commitId: null, detail: fallback === 'refused' ? { ...current.detail, reason } : current.detail })
  }

  /** The branch moved from `from` to `to`; bring the index and files along if they are still exactly at `from`. */
  private async finishFolder(t: Target, from: string, to: string): Promise<void> {
    const index = await git(t.root, ['write-tree'], { allowFail: true })
    const fromTree = (await git(t.root, ['rev-parse', `${from}^{tree}`], { allowFail: true })).stdout.trim()
    if (index.code !== 0 || index.stdout.trim() !== fromTree) return
    const moved = await git(t.root, ['read-tree', '-m', '-u', from, to], { allowFail: true })
    if (moved.code !== 0) console.error(`Memory: could not bring ${t.root} up to ${to}: ${moved.stderr.trim()}`)
  }

  // ---- committing ----

  private async commitTree(t: Target, tree: string, parent: string, message: string, author: { name: string; email: string } | undefined): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-memory-msg-'))
    try {
      const file = path.join(dir, 'message')
      await writeFile(file, message)
      // A person's commit is theirs (git's configured user); Foreman's and a run's name their author and Foreman commits.
      const env = author
        ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: FOREMAN_IDENTITY.name, GIT_COMMITTER_EMAIL: FOREMAN_IDENTITY.email }
        : undefined
      const out = await git(t.root, ['commit-tree', tree, '-p', parent, '-F', file], { allowFail: true, ...(env ? { env } : {}) })
      if (out.code !== 0) {
        if (/user\.(name|email)|identity|Please tell me who you are/i.test(out.stderr)) {
          throw new MemoryRefused('Git needs your name and email first: run git config --global user.name "Your Name" and git config --global user.email you@example.com', 'identity')
        }
        throw new Error(out.stderr.trim() || 'git commit-tree failed')
      }
      return out.stdout.trim()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * The intent → commit → finalise sequence for `changes` (the lock held). Refuses unless the memory is `ok`; a
   * compare-and-set failure marks the intent `conflict` and returns the file as it is now.
   */
  private async commitChanges(t: Target, row: MemoryMutationRow, options: { author?: { name: string; email: string } } = {}): Promise<CommitOutcome> {
    const status = this.remember(t.org.id, await this.inspect(t))
    if (status.state === 'unavailable') throw new MemoryRefused(unavailableMessage(status), 'unavailable')
    if (status.state === 'foreign') throw new MemoryRefused(foreignMessage, 'foreign')
    const head = status.head
    row = this.put(row, { state: 'committing', expectedHead: head, commitId: null })
    const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-memory-'))
    try {
      // Built in a temporary index, so the folder and its real index are untouched until the branch has moved.
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
      await git(t.root, ['read-tree', head], { env })
      const files = new Map<string, Snapshot>()
      const atHead = new Map<string, Snapshot>()
      for (const change of row.detail.changes) {
        if (!atHead.has(change.path)) {
          const at = await this.readAt(t, head, change.path)
          if (at.binary || at.tooLarge) throw new MemoryRefused(`${change.path} is ${at.binary ? 'binary' : 'too large'}; Foreman only writes text files in memory.`, at.binary ? 'binary' : 'size')
          atHead.set(change.path, { blob: at.blob, text: at.text })
        }
        const now = files.get(change.path) ?? atHead.get(change.path)!
        if (change.expectedBlob !== undefined && change.expectedBlob !== now.blob) {
          this.put(row, { state: 'conflict', detail: { ...row.detail, reason: 'changed', conflictPath: change.path } })
          return { kind: 'conflict', path: change.path, current: now }
        }
        const text = applied(now.text, change)
        if (text !== null) this.checkSize(change.path, text)
        files.set(change.path, { blob: text === null ? null : await this.blobId(t.root, text), text })
      }
      for (const [file, next] of files) {
        if (next.blob === atHead.get(file)?.blob) continue
        if (next.text === null) {
          await git(t.root, ['update-index', '--force-remove', '--', file], { env })
          continue
        }
        const content = path.join(dir, 'blob')
        await writeFile(content, next.text)
        const oid = (await git(t.root, ['hash-object', '-w', '--no-filters', '--', content])).stdout.trim()
        await git(t.root, ['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], { env })
      }
      const tree = (await git(t.root, ['write-tree'], { env })).stdout.trim()
      const headTree = (await git(t.root, ['rev-parse', `${head}^{tree}`])).stdout.trim()
      const blobs = new Map([...files].map(([file, next]) => [file, next.blob]))
      if (tree === headTree) {
        this.put(row, { state: 'committed' })
        return { kind: 'committed', commit: null, blobs }
      }
      const trailers = row.detail.trailers?.length ? `\n\n${row.detail.trailers.map((tr) => `${tr.key}: ${trailerValue(tr.value)}`).join('\n')}` : ''
      const commit = await this.commitTree(t, tree, head, `${trailerValue(row.detail.subject ?? 'Update memory')}${trailers}\n`, options.author)
      // Recorded before the branch moves, so a start after a crash can tell whether it landed.
      row = this.put(row, { commitId: commit })
      const moved = await git(t.root, ['update-ref', '-m', 'Foreman memory', `refs/heads/${t.branch}`, commit, head], { allowFail: true })
      if (moved.code !== 0) throw new MemoryRefused('The memory repository changed while Foreman was writing. Look again.', 'foreign')
      this.host.fault?.('after-ref')
      await this.finishFolder(t, head, commit)
      this.db.transaction(() => {
        this.put(row, { state: 'committed' })
        this.db.setMemoryBaseline(t.org.id, commit)
      })
      this.remember(t.org.id, { state: 'ok', head: commit })
      const changed = [...files].filter(([file, next]) => next.blob !== atHead.get(file)?.blob).map(([file]) => file)
      try {
        this.host.committed?.({ orgId: t.org.id, commit, paths: changed, subject: row.detail.subject ?? 'Update memory', trailers: row.detail.trailers ?? [] })
      } catch (err) {
        console.error('Memory commit listener:', err)
      }
      return { kind: 'committed', commit, blobs }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** After a commit: the index catches up (outside the lock is fine: it only reads git). */
  private async afterCommit(t: Target): Promise<void> {
    try {
      await this.syncIndex(t)
    } catch (err) {
      console.error('Memory index:', err)
    }
  }

  // ---- a person's edit ----

  /**
   * A person's edit in the Memory view: one commit at once, by git's configured user, with `Foreman-Edited-By: person`.
   * `expectedBlob` is the version they opened (null: a new file); a different one now is a conflict, with both versions.
   */
  async writeAsPerson(orgId: string, file: string, text: string, expectedBlob: string | null): Promise<MemoryWriteResult> {
    if (typeof text !== 'string' || (expectedBlob !== null && typeof expectedBlob !== 'string')) {
      this.target(orgId)
      throw new MemoryRefused('Invalid memory write', 'invalid')
    }
    const out = await this.commitAsPerson(orgId, [{ kind: 'write', path: file, text, expectedBlob }], { subject: `Edit ${file}` })
    return out.ok ? { ok: true, blob: out.blobs[file] ?? null, commit: out.commit } : { ok: false, conflict: out.conflict }
  }

  /**
   * Several files a person changed at once (an AI employee's definition and its memory folder, say), as one commit by
   * git's configured user with `Foreman-Edited-By: person`, each change checked as an edit is. A change whose
   * `expectedBlob` no longer matches stops the whole commit and says which file and how it is now.
   */
  async commitAsPerson(
    orgId: string,
    changes: MemoryChange[],
    { subject }: { subject: string }
  ): Promise<{ ok: true; commit: string | null; blobs: Record<string, string | null> } | { ok: false; path: string; conflict: { blob: string | null; text: string | null } }> {
    const t = this.target(orgId)
    if (!Array.isArray(changes) || !changes.length) throw new MemoryRefused('Invalid memory write', 'invalid')
    for (const change of changes) this.check(t, change)
    const result = await this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      const row = this.newRow(orgId, null, changes, { subject, trailers: [{ key: MEMORY_TRAILERS.editedBy, value: 'person' }] })
      this.put(row)
      try {
        const out = await this.commitChanges(t, row)
        if (out.kind === 'conflict') return { ok: false as const, path: out.path, conflict: out.current }
        return { ok: true as const, commit: out.commit, blobs: Object.fromEntries(out.blobs) }
      } catch (err) {
        this.failed(t, row.id, err, 'refused')
        throw err
      }
    })
    if (result.ok) await this.afterCommit(t)
    return result
  }

  /** A blob's text (an earlier version of a file, by the id its history or an approval recorded), or null if it is gone or not text. */
  async readBlob(orgId: string, blob: string): Promise<string | null> {
    const t = this.target(orgId)
    if (typeof blob !== 'string' || !/^[0-9a-f]{40,64}$/.test(blob)) return null
    if ((await git(t.root, ['cat-file', '-e', `${blob}^{blob}`], { allowFail: true })).code !== 0) return null
    const bytes = await gitBlob(t.root, blob)
    if (bytes.length > MAX_MEMORY_FILE_BYTES || bytes.subarray(0, 8000).includes(0)) return null
    return bytes.toString('utf8')
  }

  // ---- a run's staged changes ----

  /**
   * Stage a change for a run (an employee's memory tools). Checked now: the path, the size, secrets, sensitive
   * paths, and `expectedBlob` against the file as the run sees it (the head with its earlier staged changes over it).
   * Returns the version the run now sees, to compare against next time.
   */
  async stage(orgId: string, runId: string, change: MemoryChange): Promise<MemoryWriteResult> {
    const t = this.target(orgId)
    if (typeof runId !== 'string' || !runId) throw new MemoryRefused('A staged change needs its run', 'invalid')
    this.check(t, change)
    return this.exclusive(orgId, async (): Promise<MemoryWriteResult> => {
      await this.reconcileOnce(t)
      const seen = await this.read(orgId, change.path, { runId })
      if (seen.binary || seen.tooLarge) throw new MemoryRefused(`${change.path} is ${seen.binary ? 'binary' : 'too large'}; Foreman only writes text files in memory.`, seen.binary ? 'binary' : 'size')
      if (change.expectedBlob !== undefined && change.expectedBlob !== seen.blob) return { ok: false, conflict: { blob: seen.blob, text: seen.text ?? null } }
      const text = applied(seen.text ?? null, change)
      if (text !== null) this.checkSize(change.path, text)
      const row = this.stagedRow(orgId, runId)
      const changes = [...(row?.detail.changes ?? []), change]
      if (row) this.put(row, { paths: [...new Set(changes.map((c) => c.path))], detail: { ...row.detail, changes } })
      else this.put(this.newRow(orgId, runId, changes, {}))
      return { ok: true, blob: text === null ? null : await this.blobId(t.root, text), commit: null }
    })
  }

  /** A run's staged changes, in order (empty when nothing is staged). */
  stagedChanges(orgId: string, runId: string): MemoryChange[] {
    return this.stagedRow(orgId, runId)?.detail.changes ?? []
  }

  /**
   * The run ends, parks or checkpoints: its staged changes become one commit with `Foreman-Employee`, `Foreman-Run` and
   * `Foreman-Task`. Refused while the memory is foreign (the changes stay staged); a conflict keeps them on the intent.
   */
  async commitRun(orgId: string, runId: string, meta: RunCommitMeta = {}): Promise<{ commit: string | null; conflict?: { path: string; blob: string | null; text: string | null } }> {
    const t = this.target(orgId)
    const result = await this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      const staged = this.stagedRow(orgId, runId)
      if (!staged) return { commit: null }
      const trailers = [
        ...(meta.trailers?.employee ? [{ key: MEMORY_TRAILERS.employee, value: meta.trailers.employee }] : []),
        { key: MEMORY_TRAILERS.run, value: runId },
        ...(meta.trailers?.task ? [{ key: MEMORY_TRAILERS.task, value: meta.trailers.task }] : [])
      ]
      const author = meta.author ?? FOREMAN_IDENTITY
      const row = this.put(staged, { detail: { ...staged.detail, author, subject: meta.subject ?? `Memory from run ${runId}`, trailers } })
      try {
        const out = await this.commitChanges(t, row, { author })
        if (out.kind === 'conflict') return { commit: null, conflict: { path: out.path, ...out.current } }
        return { commit: out.commit }
      } catch (err) {
        // Not committed: the changes stay staged for the next try.
        this.failed(t, row.id, err, 'staged')
        throw err
      }
    })
    if (result.commit) await this.afterCommit(t)
    return result
  }

  /** Every path a run wrote (staged, or already committed by a checkpoint), not counting its proposals. */
  runWrittenPaths(orgId: string, runId: string): Set<string> {
    const rows = this.runMutations(orgId, runId).filter((r) => !r.detail.proposal && ['staged', 'committing', 'committed'].includes(r.state))
    return new Set(rows.flatMap((r) => r.paths))
  }

  // ---- an employee's proposals (docs/ai-employees.md §4: PROJECT.md, decisions.md and instructions.md are proposal-only) ----

  /**
   * File an employee's change as a proposal: checked now as any write is (path, size, secrets, sensitive paths), and
   * against `expectedBlob` at the head when given. Nothing is written until a person keeps it.
   */
  async propose(orgId: string, runId: string, change: Extract<MemoryChange, { kind: 'write' | 'append' }>, meta: { employeeId: string; taskId?: string; why?: string }): Promise<{ ok: true; id: string } | { ok: false; conflict: { blob: string | null; text: string | null } }> {
    const t = this.target(orgId)
    if (typeof runId !== 'string' || !runId || !isEmployeeId(meta?.employeeId)) throw new MemoryRefused('A proposal needs its run and employee', 'invalid')
    if (change.kind !== 'write' && change.kind !== 'append') throw new MemoryRefused('Invalid memory change', 'invalid')
    this.check(t, change)
    return this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      const seen = await this.read(orgId, change.path)
      if (seen.binary || seen.tooLarge) throw new MemoryRefused(`${change.path} is ${seen.binary ? 'binary' : 'too large'}; Foreman only writes text files in memory.`, seen.binary ? 'binary' : 'size')
      if (change.expectedBlob !== undefined && change.expectedBlob !== seen.blob) return { ok: false as const, conflict: { blob: seen.blob, text: seen.text ?? null } }
      const text = applied(seen.text ?? null, change)
      if (text !== null) this.checkSize(change.path, text)
      const row = this.newRow(orgId, runId, [change], { proposal: { employeeId: meta.employeeId, ...(meta.taskId ? { taskId: meta.taskId } : {}), ...(meta.why ? { why: meta.why } : {}) } })
      this.put({ ...row, state: 'proposed' })
      return { ok: true as const, id: row.id }
    })
  }

  /** The organization's proposals waiting for Keep or Retire, oldest first. */
  proposals(orgId: string): MemoryProposal[] {
    return this.db.memoryMutations(orgId, ['proposed']).flatMap((row) => {
      const change = row.detail.changes[0]
      const p = row.detail.proposal
      if (!p || !row.runId || !change || change.kind === 'delete') return []
      return [
        {
          id: row.id,
          orgId: row.orgId,
          path: change.path,
          kind: change.kind,
          text: change.text,
          ...(change.expectedBlob !== undefined ? { expectedBlob: change.expectedBlob } : {}),
          employeeId: p.employeeId,
          runId: row.runId,
          ...(p.taskId ? { taskId: p.taskId } : {}),
          ...(p.why ? { why: p.why } : {}),
          createdAt: row.createdAt
        }
      ]
    })
  }

  private proposalRow(orgId: string, id: string): MemoryMutationRow {
    const row = typeof id === 'string' ? this.db.memoryMutation(id) : undefined
    if (!row || row.orgId !== orgId || !row.detail.proposal) throw new MemoryRefused('Proposal not found', 'invalid')
    if (row.state !== 'proposed') throw new MemoryRefused(row.state === 'committed' ? 'This proposal was already kept.' : 'This proposal was already retired.', 'invalid')
    return row
  }

  /**
   * Keep a proposal: one commit by the person (git's configured user) with `Foreman-Proposed-By`, its run and task, and
   * `Foreman-Kept-By: person`. A file changed since the proposal (a write's version) stops it, and it stays proposed.
   */
  async keepProposal(orgId: string, id: string): Promise<{ ok: true; commit: string | null } | { ok: false; path: string; conflict: { blob: string | null; text: string | null } }> {
    const t = this.target(orgId)
    const result = await this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      let row = this.proposalRow(orgId, id)
      const p = row.detail.proposal!
      const change = row.detail.changes[0]
      const trailers = [
        { key: MEMORY_TRAILERS.proposedBy, value: p.employeeId },
        ...(row.runId ? [{ key: MEMORY_TRAILERS.run, value: row.runId }] : []),
        ...(p.taskId ? [{ key: MEMORY_TRAILERS.task, value: p.taskId }] : []),
        { key: MEMORY_TRAILERS.keptBy, value: 'person' }
      ]
      row = this.put(row, { detail: { ...row.detail, subject: `Keep ${p.employeeId}’s proposal for ${change.path}`, trailers } })
      try {
        const out = await this.commitChanges(t, row)
        if (out.kind === 'conflict') {
          // Kept as it was: the person retires it, or edits the file themselves.
          this.put(this.db.memoryMutation(row.id) ?? row, { state: 'proposed', detail: row.detail })
          return { ok: false as const, path: out.path, conflict: out.current }
        }
        return { ok: true as const, commit: out.commit }
      } catch (err) {
        this.failed(t, row.id, err, 'proposed')
        throw err
      }
    })
    if (result.ok) await this.afterCommit(t)
    return result
  }

  /** Retire a proposal: nothing is written; it stays on its intent (refused, retired) to be read back. */
  async retireProposal(orgId: string, id: string): Promise<void> {
    this.target(orgId)
    await this.exclusive(orgId, async () => {
      const row = this.proposalRow(orgId, id)
      this.put(row, { state: 'refused', detail: { ...row.detail, reason: 'retired' } })
    })
  }

  /** Drop a run's staged changes: nothing is committed; they stay on the intent (refused, discarded) to be read back. */
  async discardRun(orgId: string, runId: string): Promise<MemoryMutationRow | undefined> {
    this.target(orgId)
    return this.exclusive(orgId, async () => {
      const row = this.stagedRow(orgId, runId)
      return row && this.put(row, { state: 'refused', detail: { ...row.detail, reason: 'discarded' } })
    })
  }

  /**
   * A run's recap: `memory/bots/<id>/RECAP.md` replaced and an entry added to its `journal.md`, both staged. `parts`
   * leaves out what the employee already wrote itself in the run.
   */
  async writeRecap(orgId: string, employeeId: string, runId: string, text: string, at = new Date(), parts: { recap?: boolean; journal?: boolean } = {}): Promise<void> {
    if (!isEmployeeId(employeeId)) throw new MemoryRefused('Invalid employee id', 'invalid')
    if (typeof text !== 'string' || !text.trim()) throw new MemoryRefused('A recap needs text', 'invalid')
    const folder = `memory/bots/${employeeId}`
    const body = text.trim()
    if (parts.recap !== false) await this.stage(orgId, runId, { kind: 'write', path: `${folder}/RECAP.md`, text: `${body}\n` })
    if (parts.journal === false) return
    const journal = await this.read(orgId, `${folder}/journal.md`, { runId })
    const entry = `\n## ${at.toISOString().slice(0, 16).replace('T', ' ')} · ${trailerValue(runId)}\n\n${body}\n`
    await this.stage(orgId, runId, { kind: 'append', path: `${folder}/journal.md`, text: journal.blob === null ? `# Journal\n${entry}` : entry })
  }

  // ---- the manifest ----

  /**
   * `.foreman-memory.json` names the organization; after a rename (or a memory repository picked that has none) Foreman
   * writes it again, as its own commit. Skipped while the memory is foreign or unavailable; accepting writes it.
   */
  async syncManifest(orgId: string): Promise<string | null> {
    const t = this.target(orgId)
    const commit = await this.exclusive(orgId, async () => {
      await this.reconcileOnce(t)
      const status = this.remember(orgId, await this.inspect(t))
      if (status.state !== 'ok') return null
      const at = await this.readAt(t, status.head, MEMORY_MANIFEST)
      let manifest: Record<string, unknown> = {}
      try {
        const parsed: unknown = at.text ? JSON.parse(at.text) : {}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>
      } catch {
        // Unreadable: written again whole.
      }
      if (manifest.organization === t.org.name && at.text !== null) return null
      const text = `${JSON.stringify({ ...manifest, schema: typeof manifest.schema === 'number' ? manifest.schema : 1, organization: t.org.name }, null, 2)}\n`
      const row = this.newRow(orgId, null, [{ kind: 'write', path: MEMORY_MANIFEST, text, expectedBlob: at.blob }], { subject: `Name the organization ${t.org.name} in ${MEMORY_MANIFEST}`, author: FOREMAN_IDENTITY })
      this.put(row)
      try {
        const out = await this.commitChanges(t, row, { author: FOREMAN_IDENTITY })
        return out.kind === 'committed' ? out.commit : null
      } catch (err) {
        this.failed(t, row.id, err, 'refused')
        throw err
      }
    })
    if (commit) await this.afterCommit(t)
    return commit
  }

  /** An organization was renamed, created or given a memory repository: its manifest follows, in the background. */
  organizationChanged(orgId: string): void {
    const state = this.host.state()
    const org = (state.organizations ?? []).find((o) => o.id === orgId)
    if (!org?.memoryRepoId) return
    void this.syncManifest(orgId).catch((err: unknown) => console.error('Memory manifest:', err))
  }

  // ---- start ----

  /** At launch: settle intents, look at each memory repository, catch the index up. */
  async start(): Promise<void> {
    const state = this.host.state()
    for (const org of state.organizations ?? []) {
      if (!org.memoryRepoId) continue
      try {
        const t = this.target(org.id)
        const status = await this.status(org.id)
        if (status.state === 'unavailable') continue
        await this.syncIndex(t)
        if (status.state === 'ok') await this.syncManifest(org.id)
      } catch (err) {
        console.error(`Memory (${org.name}):`, err)
      }
    }
  }
}
