// Auto-archive: archive a workspace Foreman is done with (its scheduled run completed, its pull request was merged)
// once nothing runs in it, and delete auto-archived workspaces once the cleanup's window has passed. One queue per
// workspace, so a merge in Foreman and the lookup that then sees it merged never archive the same workspace twice.
// The rules (what counts as auto-archived, when the cleanup is due) are in shared/autoArchive.ts.
import { cleanupDue } from '../shared/autoArchive'
import type { ArchivedWork, ArchiveReason, Workspace } from '../shared/types'

export interface AutoArchiveRequest {
  reason: ArchiveReason
  deleteBranch: boolean
  // A scheduled run's "Delete it if the run changed nothing": no commits and no changed files deletes it for good.
  deleteIfUnchanged?: boolean
}

export type AutoArchiveOutcome = { ok: true } | { ok: false; detail: string }

export interface AutoArchiveDeps {
  workspaces: () => Workspace[]
  // Nothing runs in it: no turn, checks or setup.
  quiet: (ws: Workspace) => boolean
  // Through Stop safely, stopping running tabs when `stopTabs`. Not ok when a checkpoint or archive script failed.
  archive: (id: string, deleteBranch: boolean, reason: ArchiveReason, stopTabs: boolean) => Promise<AutoArchiveOutcome>
  // No commits since its branch point and no changed files.
  unchanged: (ws: Workspace) => Promise<boolean>
  work: (id: string) => Promise<ArchivedWork>
  // Delete an archived workspace for good.
  remove: (id: string) => Promise<void>
  cleanupDays: () => number
  now: () => number
  log: (message: string) => void
  // How soon a workspace that wasn't quiet is looked at again, besides when a turn settles.
  retryMs?: number
}

const RETRY_MS = 30_000
const CLEANUP_EVERY_MS = 60 * 60_000

export class AutoArchive {
  private pending = new Map<string, AutoArchiveRequest>()
  private busy = new Set<string>()
  private retry: ReturnType<typeof setTimeout> | null = null
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(private deps: AutoArchiveDeps) {}

  /** Archive it once it's quiet. A newer request for the same workspace replaces one still waiting. */
  request(id: string, request: AutoArchiveRequest): void {
    this.pending.set(id, request)
    void this.attempt(id)
  }

  /** Something finished (a turn, checks): try what's waiting, in that workspace or everywhere. */
  settled(id?: string): void {
    for (const waiting of id ? [id] : [...this.pending.keys()]) void this.attempt(waiting)
  }

  /** New work started in it (a message sent, a queued turn): it isn't done after all, so a waiting archive is called off. */
  cancel(id: string): void {
    this.pending.delete(id)
  }

  /** Waiting to be archived, for tests and the log. */
  waiting(id: string): boolean {
    return this.pending.has(id)
  }

  /**
   * Archive now, stopping its tabs: "Archive on merge" after a merge made in Foreman. Throws when a checkpoint or
   * archive script stopped it, so the merge action says so. Nothing happens if it's already being archived.
   */
  async now(id: string, request: AutoArchiveRequest): Promise<void> {
    this.pending.delete(id)
    if (this.busy.has(id)) return
    this.busy.add(id)
    try {
      await this.run(id, request, true)
    } finally {
      this.busy.delete(id)
    }
  }

  private async attempt(id: string): Promise<void> {
    const request = this.pending.get(id)
    if (!request) return
    const ws = this.deps.workspaces().find((w) => w.id === id)
    // Archived, deleted or broken meanwhile: nothing left to do.
    if (!ws || ws.state !== 'ready') {
      this.pending.delete(id)
      return
    }
    if (this.busy.has(id) || !this.deps.quiet(ws)) return this.later()
    this.pending.delete(id)
    this.busy.add(id)
    try {
      await this.run(id, request, false)
    } catch (err) {
      this.deps.log(`Couldn’t archive ${ws.name} on its own: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.busy.delete(id)
    }
  }

  private async run(id: string, request: AutoArchiveRequest, stopTabs: boolean): Promise<void> {
    const ws = this.deps.workspaces().find((w) => w.id === id)
    if (!ws) return
    // Asked before archiving: the worktree is gone after.
    const remove = Boolean(request.deleteIfUnchanged) && (await this.deps.unchanged(ws).catch(() => false))
    const outcome = await this.deps.archive(id, request.deleteBranch || remove, request.reason, stopTabs)
    if (!outcome.ok) throw new Error(outcome.detail)
    if (remove) await this.deps.remove(id)
  }

  private later(): void {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.settled()
    }, this.deps.retryMs ?? RETRY_MS)
    this.retry.unref?.()
  }

  /**
   * Delete auto-archived workspaces past the cleanup's window. One whose deletion would lose commits that aren't
   * pushed, or uncommitted work saved at archive time (or where git can't say), is left for the user to decide.
   */
  async cleanup(): Promise<string[]> {
    const days = this.deps.cleanupDays()
    const now = this.deps.now()
    const deleted: string[] = []
    for (const ws of this.deps.workspaces().filter((w) => cleanupDue(w, days, now))) {
      try {
        const work = await this.deps.work(ws.id)
        if (work.unpushed !== 0 || work.uncommitted) continue
        await this.deps.remove(ws.id)
        deleted.push(ws.id)
      } catch (err) {
        this.deps.log(`Couldn’t delete ${ws.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return deleted
  }

  start(): void {
    const tick = () => void this.cleanup().catch(() => undefined)
    const first = setTimeout(tick, 60_000)
    const every = setInterval(tick, CLEANUP_EVERY_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }
}
