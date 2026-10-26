// Spotlight testing: mirror a workspace's files into the repository's main
// folder so projects that only run from the root can be tested there.
//
// The root's own state (HEAD, index, uncommitted files) is checkpointed
// first and restored on stop. Its branch is detached while syncing, so the
// checked-out branch ref is never moved to the workspace's commits.
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Repo, Workspace } from '../shared/types'
import { deleteCheckpoints, restoreCheckpoint, saveCheckpoint, snapshotWorkingTree } from './checkpoints'
import { busyOperation, git, gitOut } from './git'
import { wsPath } from '../shared/workspacePath'

const IGNORED = /(^|[\\/])(\.git|\.context|node_modules)([\\/]|$)/

interface Active {
  workspaceId: string
  repoRoot: string
  branch: string | null
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  lastTree: string
  syncing: Promise<void>
}

export interface SpotlightEvents {
  log(workspaceId: string, line: string): void
  changed(): void
}

export class Spotlight {
  // Keyed by repository: one spotlight per repo root at a time.
  private active = new Map<string, Active>()

  constructor(private events: SpotlightEvents) {}

  workspaceFor(repoId: string): string | undefined {
    return this.active.get(repoId)?.workspaceId
  }

  isActive(workspaceId: string): boolean {
    return [...this.active.values()].some((a) => a.workspaceId === workspaceId)
  }

  async start(repo: Repo, ws: Workspace): Promise<void> {
    const current = this.active.get(repo.id)
    if (current?.workspaceId === ws.id) return
    if (current) await this.stop(repo)
    const root = repo.rootPath
    if (await busyOperation(root)) throw new Error('Finish the merge or rebase in the main folder first')
    const symbolic = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })
    if (symbolic.code !== 0) throw new Error('The main folder is on a detached HEAD; check out a branch first')

    const saved = await saveCheckpoint(root, `spotlight-pre-${repo.id}`)
    if (!saved.ok) throw new Error(`Could not save the main folder's state: ${saved.reason}`)
    // Detach so restoring workspace snapshots moves HEAD, not the branch.
    await git(root, ['checkout', '-q', '--detach'])

    const entry: Active = {
      workspaceId: ws.id,
      repoRoot: root,
      branch: symbolic.stdout.trim(),
      watcher: watch(wsPath(ws), { recursive: true }, (_event, file) => {
        if (file && IGNORED.test(file.toString())) return
        this.schedule(repo.id, ws)
      }),
      timer: null,
      lastTree: '',
      syncing: Promise.resolve()
    }
    this.active.set(repo.id, entry)
    this.events.log(ws.id, `Spotlight on: syncing ${ws.name} into ${root}`)
    this.events.changed()
    await this.sync(repo.id, ws)
  }

  private schedule(repoId: string, ws: Workspace): void {
    const entry = this.active.get(repoId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void this.sync(repoId, ws), 400)
  }

  private sync(repoId: string, ws: Workspace): Promise<void> {
    const entry = this.active.get(repoId)
    if (!entry) return Promise.resolve()
    // Syncs run one at a time; a burst of changes collapses into the next one.
    entry.syncing = entry.syncing.then(async () => {
      if (this.active.get(repoId) !== entry) return
      try {
        const tree = await snapshotWorkingTree(wsPath(ws))
        if (tree === entry.lastTree) return
        const saved = await saveCheckpoint(wsPath(ws), `spotlight-${ws.id}`)
        if (!saved.ok) {
          this.events.log(ws.id, `Skipped sync: ${saved.reason}`)
          return
        }
        await restoreCheckpoint(entry.repoRoot, `spotlight-${ws.id}`)
        entry.lastTree = tree
        this.events.log(ws.id, `Synced at ${new Date().toLocaleTimeString()}`)
      } catch (err) {
        this.events.log(ws.id, `Sync failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    return entry.syncing
  }

  async stop(repo: Repo): Promise<void> {
    const entry = this.active.get(repo.id)
    if (!entry) return
    this.active.delete(repo.id)
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
    await entry.syncing
    const root = entry.repoRoot
    await restoreCheckpoint(root, `spotlight-pre-${repo.id}`)
    // Files already match the branch tip, so this only re-attaches HEAD.
    if (entry.branch) await git(root, ['checkout', '-q', entry.branch], { allowFail: true })
    await deleteCheckpoints(root, `spotlight-pre-${repo.id}`)
    await deleteCheckpoints(root, `spotlight-${entry.workspaceId}`)
    this.events.log(entry.workspaceId, `Spotlight off: restored ${path.basename(root)} (${entry.branch ?? (await gitOut(root, ['rev-parse', '--short', 'HEAD']))})`)
    this.events.changed()
  }

  async stopAll(repos: Repo[]): Promise<void> {
    for (const repo of repos) await this.stop(repo).catch(() => undefined)
  }
}
