// Stop safely (#1) in the main process: the Quit sheet's plan and "Quit when turns
// finish", archiving a workspace whose tabs are running, and the record of turns a
// quit or crash stopped. Nothing here replays a turn: Retry is one tab, one click.
import { existsSync } from 'node:fs'
import { modelInfo } from '../shared/agents'
import { createT } from '../shared/i18n'
import { mainLocale } from './i18n'
import { keepRunningPlan } from '../shared/agentHost'
import {
  addStops,
  checksKey,
  dismissStop,
  finiteWorkDone,
  liveStops,
  quitNeedsAsking,
  quitPlan,
  reviewFromChat,
  turnRunning,
  type QuitPlan,
  type StoppedChecks,
  type StoppedTurn,
  type StopReviewRow,
  type TerminalInfo
} from '../shared/stopSafely'
import type { ArchiveOptions, ArchiveOutcome, ArchivePreview, ArchiveProgress, ChatItem } from '../shared/types'
import type { DockerRemoval } from '../shared/docker'
import { isHistoryOnly, wsPath } from '../shared/workspacePath'
import { git, type GitTarget } from './git'
import { workspaceTarget } from './runtime'
import type { SessionService } from './sessions'
import type { Store } from './store'
import { ArchiveStepError, type WorkspaceService } from './workspaces'

export interface StopSafelyDeps {
  store: Store
  sessions: SessionService
  workspaces: WorkspaceService
  // Terminal processes: shells, run scripts and snippets.
  terminals(): TerminalInfo[]
  stopChecks(workspaceId: string): Promise<void>
  killTerminals(workspaceId: string): void
  forgetTerminals(workspaceId: string): void
  stopSpotlight(workspaceId: string): Promise<void>
  // Delete the tabs' turn checkpoints once the folder is gone.
  disposeSessions(workspaceId: string, repoRoot: string): Promise<void>
  // Quit the app for real (the host skips the sheet).
  quit(): void
  // The wait to quit was cancelled: work it held back may start.
  resumed?(): void
  changed(): void
  // O10: the background agent host, for "Keep agents running in the background".
  agentHost?: { hosts(sessionId: string): boolean; detach(locale: string, notify: boolean): Promise<void> }
  // G3 · #1: an archive step started, finished or failed (the workspace service reports the rest).
  archiveProgress?(workspaceId: string, progress: ArchiveProgress): void
}

export class StopSafely {
  private draining = false
  // O10: "Keep agents running in the background" was chosen; shutdown leaves the host's turns going.
  private keep = false

  constructor(private deps: StopSafelyDeps) {}

  private locale() {
    return mainLocale(this.deps.store.state.settings)
  }

  private t() {
    return createT(this.locale())
  }

  /** O10: the app is quitting with its kept turns left running in the background host. */
  get keeping(): boolean {
    return this.keep
  }

  /** "Quit when turns finish" was chosen and hasn't been cancelled: new work waits. */
  get isDraining(): boolean {
    return this.draining
  }

  plan(): QuitPlan {
    const { workspaces, sessions } = this.deps.store.state
    const plan = quitPlan({ workspaces, sessions, approvals: this.deps.sessions.pendingApprovals(), terminals: this.deps.terminals() })
    const host = this.deps.agentHost
    const turns = [...plan.finishing, ...plan.waiting].flatMap((row) => {
      const session = row.kind === 'turn' ? sessions.find((s) => s.id === row.sessionId) : undefined
      return row.kind === 'turn' && session ? [{ sessionId: row.sessionId, workspace: row.workspace, agent: session.agent, waiting: Boolean(row.waiting) }] : []
    })
    const keep = host ? keepRunningPlan(turns, (id) => host.hosts(id), this.deps.store.state.settings.keepAgentsRunning) : undefined
    return { ...plan, ...(this.draining ? { draining: true } : {}), ...(keep ? { keep } : {}) }
  }

  /**
   * O10: "Keep agents running in the background". Foreman tells the host how to label and notify, lets go of it and
   * quits; the kept turns go on, everything else stops as Quit now would (and is listed for review next time).
   */
  async quitKeepRunning(): Promise<void> {
    const host = this.deps.agentHost
    if (!host || !this.plan().keep?.turns) throw new Error(this.t()('keepRunning.quit.none'))
    this.keep = true
    this.draining = false
    await host.detach(this.locale(), this.deps.store.state.settings.notifications)
    this.deps.quit()
  }

  /** Whether Quit shows the sheet first; with nothing running it stays instant. */
  needsAsking(): boolean {
    return quitNeedsAsking(this.plan())
  }

  /** Freeze new turns (sends, queued turns, schedules, checks after turns) and quit once the finite work has ended. */
  quitWhenFinished(): void {
    if (!this.draining) {
      this.draining = true
      this.deps.sessions.freezeAdmissions(this.t()('stop.quit.frozen'))
      this.deps.changed()
    }
    this.check()
  }

  /** Esc or Cancel: stop waiting, and let held-back work start again. */
  cancelQuit(): void {
    if (!this.draining) return
    this.draining = false
    this.deps.sessions.freezeAdmissions(null)
    this.deps.resumed?.()
    this.deps.changed()
  }

  quitNow(): void {
    this.draining = false
    this.deps.quit()
  }

  /** On every state change while draining: quit once no turn, check run or waiting turn is left. */
  check(): void {
    if (!this.draining || !finiteWorkDone(this.plan())) return
    this.draining = false
    this.deps.quit()
  }

  /**
   * The app is quitting (Quit now, or nothing was running): what's still running is recorded for review after the
   * restart. Turns are then stopped by shutdown and end as Stopped; check runs end as interrupted.
   */
  recordQuit(at = new Date().toISOString()): void {
    const plan = this.plan()
    const turns: StoppedTurn[] = []
    const checks: StoppedChecks[] = []
    for (const row of [...plan.finishing, ...plan.waiting]) {
      if (row.kind === 'checks') checks.push({ workspaceId: row.workspaceId, cause: 'quit', at })
      // O10: a turn kept running in the background isn't stopped, so it isn't listed.
      else if (this.keep && this.deps.agentHost?.hosts(row.sessionId)) continue
      else if (row.turnId) turns.push({ turnId: row.turnId, sessionId: row.sessionId, workspaceId: row.workspaceId, cause: 'quit', at, startedAt: row.startedAt, waiting: row.waiting })
    }
    if (!turns.length && !checks.length) return
    this.deps.store.state.stopRecord = addStops(this.deps.store.state.stopRecord, turns, checks)
    this.deps.store.save()
  }

  /** What Home's line counts: entries whose workspace is still live. */
  record() {
    return liveStops(this.deps.store.state.stopRecord, this.deps.store.state.workspaces)
  }

  /** One row per stopped tab (its message, last step and partial changes), then interrupted check runs. */
  async review(): Promise<StopReviewRow[]> {
    const record = this.record()
    if (!record) return []
    const { sessions, workspaces } = this.deps.store.state
    const rows: StopReviewRow[] = []
    for (const stop of record.turns) {
      const session = sessions.find((s) => s.id === stop.sessionId)
      const ws = workspaces.find((w) => w.id === stop.workspaceId)
      if (!session || !ws) continue
      const items = await this.deps.store.readChat(session.id)
      rows.push({
        kind: 'turn',
        key: stop.turnId,
        workspaceId: ws.id,
        workspace: ws.name,
        sessionId: session.id,
        title: session.title,
        model: modelInfo(session.agent, session.model).label,
        cause: stop.cause,
        at: stop.at,
        waiting: stop.waiting,
        closed: session.closedAt ? true : undefined,
        ...reviewFromChat(stop.turnId, items)
      })
    }
    for (const stop of record.checks) {
      const ws = workspaces.find((w) => w.id === stop.workspaceId)
      if (!ws) continue
      rows.push({
        kind: 'checks',
        key: checksKey(ws.id),
        workspaceId: ws.id,
        workspace: ws.name,
        cause: stop.cause,
        at: stop.at,
        results: (ws.checks?.results ?? []).map((r) => ({ name: r.name, status: r.status }))
      })
    }
    return rows
  }

  /** Retry, after the row showed the message: send it again, word for word, in the same tab. */
  async retry(turnId: string): Promise<void> {
    const t = this.t()
    const stop = this.deps.store.state.stopRecord?.turns.find((x) => x.turnId === turnId)
    const session = stop && this.deps.store.state.sessions.find((s) => s.id === stop.sessionId)
    if (!stop || !session) throw new Error(t('stop.review.gone'))
    const user = (await this.deps.store.readChat(session.id)).find(
      (i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId && !i.steered
    )
    if (!user) throw new Error(t('stop.review.noMessage'))
    if (session.closedAt) this.deps.sessions.reopenSession(session.workspaceId, session.id)
    await this.deps.sessions.send(session.id, user.text, { attachments: user.attachments })
    this.dismiss(turnId)
  }

  dismiss(key?: string): void {
    const next = dismissStop(this.deps.store.state.stopRecord, key)
    if (next) this.deps.store.state.stopRecord = next
    else delete this.deps.store.state.stopRecord
    this.deps.store.save()
    this.deps.changed()
  }

  // ---- archive ----

  /** What archiving stops, keeps and deletes, for the dialog. */
  async archivePreview(id: string): Promise<ArchivePreview> {
    const { workspaces, store } = this.deps
    const ws = workspaces.workspace(id)
    const repo = workspaces.repo(ws.repoId)
    const kind = isHistoryOnly(ws) ? 'history' : ws.direct ? 'direct' : ws.adopted ? 'adopted' : 'worktree'
    const running = await Promise.all(
      store.state.sessions
        .filter((s) => s.workspaceId === id && turnRunning(s))
        .map(async (s) => {
          const items = s.turnId ? await store.readChat(s.id) : []
          const last = items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.turnId === s.turnId).at(-1)
          return { sessionId: s.id, title: s.title, model: modelInfo(s.agent, s.model).label, startedAt: s.turnStartedAt, lastStep: last ? { name: last.name, input: last.input } : undefined }
        })
    )
    // A cloud workspace's worktree is read in its sandbox while it runs (a sleeping one isn't woken for this).
    const cloud = ws.cloud
    const dir: GitTarget = cloud ? workspaceTarget(ws) : wsPath(ws)
    const onDisk = cloud ? cloud.status === 'running' : kind !== 'history' && existsSync(dir as string)
    return {
      kind,
      running,
      checksRunning: Boolean(ws.checks?.running),
      folder: kind === 'history' ? '' : cloud ? cloud.cwd : (dir as string),
      branch: ws.branch,
      uncommitted: onDisk ? await uncommittedFiles(dir) : null,
      unpushed: onDisk ? await unpushedCommits(dir, ws.branch, ws.baseBranch, repo.hasOrigin ? repo.remote || 'origin' : null) : null,
      terminals: this.deps.terminals().filter((t) => t.workspaceId === id).length,
      hasArchiveScript: kind === 'worktree' && Boolean(workspaces.settingsFor(repo.id).archiveScript.trim()),
      // G3 · O19: named steps when there's more than one.
      ...(kind === 'worktree' && workspaces.settingsFor(repo.id).archiveSteps.length > 1
        ? { archiveSteps: workspaces.settingsFor(repo.id).archiveSteps.map((s) => ({ name: s.name, ...(s.parallel ? { parallel: true } : {}) })) }
        : {}),
      // O18: asked from docker ps when the dialog opens; Docker missing or stopped is a status, never an error.
      docker: kind === 'worktree' && !cloud && workspaces.settingsFor(repo.id).removeDockerContainers ? { enabled: true, ...(await workspaces.dockerContainers(id)) } : { enabled: false }
    }
  }

  /**
   * Archive in order: stop the running tabs (they end as Stopped), checks, run scripts and terminals; save the
   * uncommitted changes as a checkpoint; run the archive script; remove labelled Docker containers (O18, when on,
   * never blocking); remove the folder. A failed checkpoint or script
   * stops there, before anything is deleted, and says which step failed so the dialog can retry just that one.
   */
  async archive(id: string, deleteBranch: boolean, options: ArchiveOptions = {}): Promise<ArchiveOutcome> {
    const { store, sessions, workspaces } = this.deps
    const ws = workspaces.workspace(id)
    const repo = workspaces.repo(ws.repoId)
    if (!options.from) {
      const running = store.state.sessions.filter((s) => s.workspaceId === id && turnRunning(s))
      if (running.length && !options.stopTabs) throw new Error('Stop the agents in this workspace before archiving it')
      this.deps.archiveProgress?.(id, { step: 'stop', status: 'running' })
      // Stop every running tab at once: a cancel waits for the agent to wind down, so doing them one
      // after another made archiving several tabs take the sum of their stops.
      await Promise.all(running.map((s) => (s.turnId ? sessions.cancelTurn(s.turnId) : sessions.cancel(s.id))))
      await this.deps.stopChecks(id)
      this.deps.killTerminals(id)
      await this.deps.stopSpotlight(id)
      this.deps.archiveProgress?.(id, { step: 'stop', status: 'done' })
    }
    // O18: the Docker step's result; reported, never blocking.
    const step: { docker?: DockerRemoval } = {}
    try {
      await workspaces.archiveWorkspace(id, deleteBranch, { from: options.from, anyway: options.anyway, onDocker: (r) => (step.docker = r) })
    } catch (err) {
      if (err instanceof ArchiveStepError) return { ok: false, step: err.step, detail: err.detail }
      throw err
    }
    this.deps.forgetTerminals(id)
    await this.deps.disposeSessions(id, repo.rootPath)
    return step.docker ? { ok: true, docker: step.docker } : { ok: true }
  }
}

/** Files with uncommitted changes (untracked included), or null when git can't say. */
async function uncommittedFiles(dir: GitTarget): Promise<number | null> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { allowFail: true })
  return out.code === 0 ? out.stdout.split('\0').filter(Boolean).length : null
}

/** Commits on HEAD that aren't on the pushed branch, else the base branch, as "2 commits not on origin/main". */
async function unpushedCommits(dir: GitTarget, branch: string, base: string, remote: string | null): Promise<{ count: number; against: string } | null> {
  const candidates = remote ? [`${remote}/${branch}`, `${remote}/${base}`] : [base]
  for (const against of candidates) {
    const out = await git(dir, ['rev-list', '--count', `${against}..HEAD`], { allowFail: true })
    if (out.code === 0) return { count: Number(out.stdout.trim()) || 0, against }
  }
  return null
}
