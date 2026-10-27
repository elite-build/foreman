// Opt-in watch on a moved base branch (W-1). Fetches the base, then asks
// `git merge-tree --write-tree` whether the committed branch still merges
// cleanly. It records both SHAs and sends one notification per base tip. It
// never rebases, merges or starts an agent.
import { mergeTreeSupported, parseGitVersion, stepBase, type BaseObservation } from '../shared/baseWatch'
import type { NotifyKind, Repo, Workspace } from '../shared/types'
import { baseStartPoint, git, gitOut, gitVersion, mergeTreeConflicts, revParse } from './git'
import { remoteGitEnv } from './github'
import { mainT } from './i18n'
import type { Store } from './store'
import { wsPath } from '../shared/workspacePath'

export interface BaseWatchDeps {
  store: Store
  enabled: (repoId: string) => boolean
  repo: (repoId: string) => Pick<Repo, 'remote' | 'hasOrigin' | 'githubAccount'>
  // Integrations: who fetches run as (a gh login or identity key). Without it, the repository's old linked account.
  githubKey?: (repoId: string) => string | undefined
  // The `git --version` line; replaceable so old git can be tested.
  version?: () => Promise<string | undefined>
  notify: (n: { workspaceId: string; title: string; body: string; kind?: NotifyKind }) => void
  changed: () => void
}

export class BaseWatcher {
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(private deps: BaseWatchDeps) {}

  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async support(): Promise<{ ok: boolean; version?: string }> {
    const line = await (this.deps.version ?? gitVersion)()
    const parsed = line ? parseGitVersion(line) : null
    return { ok: mergeTreeSupported(parsed), version: parsed?.join('.') }
  }

  /** The user dealt with the conflicts on this base tip (sent them to a chat). */
  ack(workspaceId: string): void {
    const watch = this.deps.store.state.workspaces.find((w) => w.id === workspaceId)?.baseWatch
    if (!watch?.base || watch.acked === watch.base) return
    watch.acked = watch.base
    this.deps.store.save()
    this.deps.changed()
  }

  /** Look at every workspace of opted-in repos (or one repo), once. */
  async poll(onlyRepoId?: string): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      if (!(await this.support()).ok) return
      const fetched = new Set<string>()
      for (const ws of [...this.deps.store.state.workspaces]) {
        if (onlyRepoId && ws.repoId !== onlyRepoId) continue
        if (!this.deps.enabled(ws.repoId)) {
          // Opting out takes the row away with it.
          if (ws.baseWatch) {
            delete ws.baseWatch
            this.deps.store.save()
            this.deps.changed()
          }
          continue
        }
        // TODO(cloud): watch cloud workspaces too, through workspaceTarget, only while their sandbox runs (each has its
        // own clone, so its fetch can't be shared). Until then a cloud workspace (no path) is skipped.
        if (ws.state !== 'ready' || !ws.path || ws.branch === ws.baseBranch) continue
        const changed = await this.pollOne(ws, fetched)
        if (changed) {
          this.deps.store.save()
          this.deps.changed()
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async observe(ws: Workspace, fetched: Set<string>): Promise<BaseObservation> {
    const cwd = wsPath(ws)
    const repo = this.deps.repo(ws.repoId)
    const remote = repo.remote || 'origin'
    try {
      const key = `${ws.repoId}\0${ws.baseBranch}`
      if (repo.hasOrigin && !fetched.has(key)) {
        fetched.add(key)
        await git(cwd, ['fetch', '--quiet', remote, ws.baseBranch], { allowFail: true, timeoutMs: 60_000, env: await remoteGitEnv(this.deps.githubKey ? this.deps.githubKey(ws.repoId) : repo.githubAccount) })
      }
      const baseRef = await baseStartPoint(cwd, ws.baseBranch, remote)
      const [base, head] = await Promise.all([revParse(cwd, baseRef), revParse(cwd, 'HEAD')])
      if (!base || !head) return { kind: 'error' }
      const conflicts = await mergeTreeConflicts(cwd, base, head)
      if (!conflicts) return { kind: 'error' }
      const dirty = (await gitOut(cwd, ['status', '--porcelain'], { allowFail: true })).length > 0
      return { kind: 'ok', base, head, conflicts, dirty, at: new Date().toISOString() }
    } catch {
      return { kind: 'error' }
    }
  }

  private async pollOne(ws: Workspace, fetched: Set<string>): Promise<boolean> {
    const obs = await this.observe(ws, fetched)
    // A look can outlast an opt-out or an archive.
    if (ws.state !== 'ready' || !this.deps.enabled(ws.repoId)) return false
    const prev = ws.baseWatch ?? { conflicts: [] }
    const step = stepBase(prev, obs)
    // Fresh "checked" timestamps alone are not worth a write.
    const { checkedAt: _a, ...before } = prev
    const { checkedAt: _b, ...after } = step.next
    const dirty = JSON.stringify(before) !== JSON.stringify(after)
    ws.baseWatch = step.next
    if (step.notify) {
      const t = mainT(this.deps.store.state.settings)
      this.deps.notify({
        workspaceId: ws.id,
        title: ws.name,
        body: t('baseWatch.notify.moved', { count: step.notify.conflicts.length, branch: ws.baseBranch, sha: step.notify.base.slice(0, 7) }),
        kind: 'attention'
      })
    }
    return dirty
  }
}
