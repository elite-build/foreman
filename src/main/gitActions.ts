// Git and pull-request actions. Mechanical steps (push, pull, merge, rerun)
// run directly; anything needing judgement (commit messages, PR text, CI
// fixes, conflicts, reviews) is sent to the agent with instructions attached.
// In a cloud workspace git runs in its sandbox, as the repository's GitHub
// connection, and the instructions are written into the sandbox's .context.
import { randomUUID } from 'node:crypto'
import type { Attachment, CheckResult, GitActionKind, GitStatus, MessageOrigin, PrCheck, SendReceipt, Session, Workspace } from '../shared/types'
import { attachFromData, attachFromPath } from './files'
import { git, gitOut } from './git'
import { credentialHelperEnv, githubEnvAsync, GithubUnavailable, gitStatus, remoteGitEnv } from './github'
import type { PrCache } from './prCache'
import { cloudSandboxes, workspaceTarget } from './runtime'
import { githubProvider, type ScmProvider } from './scm'
import { sandboxNotRunningReason } from '../shared/cloud'
import { REVIEW_MESSAGE } from '../shared/handOff'
import { createPrInstructions, fixErrorsInstructions, resolveConflictsMessage, reviewInstructions } from '../shared/prompts'
import { createMrInstructions } from '../shared/scm'
import type { SessionService } from './sessions'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'

const toBase64 = (text: string) => Buffer.from(text).toString('base64')

/** What Fix errors (by hand, or #5 auto-fix) says in the chat; the logs and instructions are attached. */
export const FIX_CI_MESSAGE = "Fix the failing CI checks. I've attached the failure logs."

/** O2: the provider a workspace's repository is on, and what the Git panel should know about its host. */
export type ScmResolver = (ws: Workspace) => Promise<{ provider: ScmProvider; info?: GitStatus['scm'] }>

export class GitActions {
  // Cloud workspaces: the last status read while the sandbox ran, shown (with its time) while it sleeps. Memory only.
  private lastCloud = new Map<string, { status: GitStatus; at: string }>()

  constructor(
    private store: Store,
    private workspaces: WorkspaceService,
    private sessions: SessionService,
    private openExternal: (url: string) => Promise<void>,
    private prs: PrCache,
    // O2: GitHub (as the repo's linked account) unless told otherwise.
    private scm?: ScmResolver,
    // "Archive on merge" after a merge made here: stops the workspace's tabs and archives it, saying why.
    private archiveMerged?: (workspaceId: string, number: number, deleteBranch: boolean) => Promise<void>
  ) {}

  private resolve(ws: Workspace): ReturnType<ScmResolver> {
    return this.scm ? this.scm(ws) : Promise.resolve({ provider: githubProvider(this.workspaces.accountFor(ws.repoId)) })
  }

  /** `fresh` skips the shared PR cache, for actions that act on what GitHub (or GitLab) says right now. */
  async status(workspaceId: string, fresh = false): Promise<GitStatus> {
    const ws = this.workspaces.workspace(workspaceId)
    // A sleeping sandbox isn't woken to be read: the panel gets what it last said, marked with when. An action that
    // needs GitHub's answer now (`fresh`: merge, rerun, …) wakes it instead.
    if (ws.cloud && ws.cloud.status !== 'running') {
      const last = this.lastCloud.get(ws.id)
      if (!fresh && last) return { ...last.status, asOf: last.at }
      if (!fresh) throw new Error(sandboxNotRunningReason(ws.name, ws.cloud.status))
      await cloudSandboxes().ready(ws, true)
    }
    const status = await this.readStatus(ws, fresh)
    if (ws.cloud) this.lastCloud.set(ws.id, { status, at: new Date().toISOString() })
    return status
  }

  private async readStatus(ws: Workspace, fresh: boolean): Promise<GitStatus> {
    const repo = this.workspaces.repo(ws.repoId)
    const { settings } = this.store.state
    const { provider, info } = await this.resolve(ws)
    return gitStatus(ws, repo.hasOrigin, { optionalChecksBlock: settings.optionalChecksBlock, automerge: settings.automerge }, repo.remote, (w) => this.prs.get(w, { fresh }), {
      // gh is in a cloud sandbox's image, whatever this computer has.
      available: () => (ws.cloud && provider.kind === 'github' ? Promise.resolve(true) : provider.available()),
      scm: info
    })
  }

  /** The chat that receives agent-driven actions: the given one, else the first open chat. */
  private targetSession(ws: Workspace, sessionId?: string): Session {
    const open = this.store.state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
    const session = open.find((s) => s.id === sessionId) ?? open[0] ?? this.sessions.createSession(ws.id)
    return session
  }

  /** Sends to the chosen chat and says which turn carries it (a new one, or the one it queued behind). */
  private async ask(ws: Workspace, sessionId: string | undefined, text: string, attachments: Attachment[] = []): Promise<SendReceipt> {
    const session = this.targetSession(ws, sessionId)
    // Queue behind any running turn rather than steering mid-task.
    return this.sessions.deliver(session.id, text, { attachments, mode: 'queue' })
  }

  /** "Fix in chat…": the failing checks' logs go to the chosen chat, queued behind any running turn. */
  async fixChecks(workspaceId: string, failing: CheckResult[], sessionId?: string): Promise<void> {
    if (!failing.length) throw new Error('No failing checks found')
    const ws = this.workspaces.workspace(workspaceId)
    const prompts = this.workspaces.settingsFor(ws.repoId).prompts
    const attachments: Attachment[] = []
    for (const check of failing.slice(0, 6)) {
      const log = await attachFromPath(this.attachTo(ws), check.logPath)
      attachments.push({ ...log, name: `Check ${check.name.replace(/[^\w.-]+/g, '-')}.log` })
    }
    attachments.push(await attachFromData(this.attachTo(ws), 'Fix errors instructions.md', toBase64(fixErrorsInstructions(prompts.fixErrors))))
    const commands = failing.slice(0, 6).map((c) => `- ${c.name}: \`${c.command.split('\n')[0]}\`${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`)
    await this.ask(ws, sessionId, `Fix the failing checks. These commands failed, and I've attached their full logs:\n${commands.join('\n')}`, attachments)
  }

  /** Where an action's attachments go: the workspace's .context here, or in its sandbox (woken: a message follows). */
  private attachTo(ws: Workspace) {
    return workspaceTarget(ws, { wake: true })
  }

  /** The receipt of the message the action sent to a chat (its turn id), or null when it sent none. */
  async run(workspaceId: string, action: GitActionKind, sessionId?: string): Promise<SendReceipt | null> {
    try {
      return (await this.runAction(workspaceId, action, sessionId)) ?? null
    } finally {
      // Most actions change the PR; the panel's next look must not read the old answer.
      this.prs.invalidate(workspaceId)
    }
  }

  private async runAction(workspaceId: string, action: GitActionKind, sessionId?: string): Promise<SendReceipt | undefined> {
    const ws = this.workspaces.workspace(workspaceId)
    const repo = this.workspaces.repo(ws.repoId)
    const repoSettings = this.workspaces.settingsFor(repo.id)
    const prompts = repoSettings.prompts
    const remote = repo.remote || 'origin'
    // GitHub work runs as the repository's connection (gh's active account when unset). Here gh is asked afresh who
    // that is, so a gh auth switch run outside Foreman counts for this push; the provider below then reads the same answer.
    const account = ws.cloud ? this.workspaces.accountFor(repo.id) : await this.workspaces.accountForFresh(repo.id)
    // GitHub off here: git's own credentials, as without Foreman. A connection that can't be used refuses.
    // A cloud workspace's git pushes as the repository's connection, the token only in that command's environment.
    const pushEnv = async () => {
      if (ws.cloud) {
        const env = cloudSandboxes().githubEnv(ws)
        return env.GH_TOKEN ? { ...env, ...credentialHelperEnv() } : undefined
      }
      try {
        return account ? await githubEnvAsync(account) : undefined
      } catch (err) {
        if (err instanceof GithubUnavailable && !err.blocked) return undefined
        throw err
      }
    }
    // O2: the host's own calls (gh for GitHub, the REST API for GitLab).
    const { provider } = await this.resolve(ws)
    const gitlab = provider.kind === 'gitlab'

    switch (action) {
      case 'commit-and-push':
        return this.ask(ws, sessionId, repo.hasOrigin ? 'Commit and push all changes.' : 'Commit all changes.')

      case 'create-pr':
      case 'create-draft-pr': {
        const draft = action === 'create-draft-pr'
        if (gitlab) {
          const instructions = createMrInstructions({ base: ws.baseBranch, draft, customPrompt: prompts.createPr, hasDiffTool: true, remote })
          const file = await attachFromData(this.attachTo(ws), 'MR instructions.md', toBase64(instructions))
          return this.ask(ws, sessionId, draft ? 'Create a draft merge request.' : 'Create a merge request.', [file])
        }
        const instructions = createPrInstructions({ base: ws.baseBranch, draft, customPrompt: prompts.createPr, hasDiffTool: true })
        const file = await attachFromData(this.attachTo(ws), 'PR instructions.md', toBase64(instructions))
        return this.ask(ws, sessionId, draft ? 'Create a draft pull request.' : 'Create a pull request.', [file])
      }

      case 'create-pr-web': {
        // Open GitHub's compare page (GitLab's new merge request page); it offers to create the PR from there.
        await git(workspaceTarget(ws, { wake: true }), ['push', '-u', remote, 'HEAD'], { env: gitlab ? undefined : await pushEnv() })
        await this.openExternal(await provider.newPullRequestUrl(ws))
        return
      }

      case 'push': {
        const at = workspaceTarget(ws, { wake: true })
        const hasUpstream = (await git(at, ['rev-parse', '--abbrev-ref', '@{upstream}'], { allowFail: true })).code === 0
        await git(at, hasUpstream ? ['push'] : ['push', '-u', remote, 'HEAD'], { timeoutMs: 120_000, env: gitlab ? undefined : await pushEnv() })
        return
      }

      case 'pull': {
        const at = workspaceTarget(ws, { wake: true })
        if (repo.hasOrigin) await git(at, ['fetch', remote], { allowFail: true, timeoutMs: 120_000, env: ws.cloud ? cloudSandboxes().githubEnv(ws) : await remoteGitEnv(account) })
        const status = await this.status(workspaceId)
        const diverged = (status.ahead > 0 && status.behind > 0) || (status.aheadBase > 0 && status.behindBase > 0)
        if (status.uncommitted > 0 || diverged) {
          return this.ask(ws, sessionId, `Bring this branch up to date: commit any uncommitted work, merge ${status.baseRef} into it, resolve conflicts if any, then push.`)
        }
        if (status.behind > 0) await git(at, ['merge', '--ff-only', '@{upstream}'])
        else if (status.behindBase > 0) await git(at, ['merge', '--ff-only', status.baseRef])
        return
      }

      case 'merge': {
        const status = await this.status(workspaceId, true)
        if (!status.pr) throw new Error('There is no pull request to merge')
        const head = await gitOut(workspaceTarget(ws, { wake: true }), ['rev-parse', 'HEAD'])
        await provider.merge(ws, status.pr, head)
        if (repoSettings.archiveOnMerge) await this.archiveMerged?.(ws.id, status.pr.number, repoSettings.deleteBranchOnArchive)
        return
      }

      case 'automerge': {
        const status = await this.status(workspaceId, true)
        if (!status.pr) throw new Error('There is no pull request to merge')
        await provider.autoMerge(ws, status.pr)
        return
      }

      case 'ready-for-review': {
        const status = await this.status(workspaceId, true)
        if (status.pr) await provider.markReady(ws, status.pr)
        return
      }

      case 'rerun-checks': {
        const status = await this.status(workspaceId, true)
        if (!status.pr) throw new Error(gitlab ? 'No failed GitLab jobs to retry' : 'No failed GitHub Actions runs to rerun')
        await provider.rerunFailed(ws, status.pr)
        return
      }

      case 'fix-errors': {
        const status = await this.status(workspaceId, true)
        const failing = (status.pr?.checks ?? []).filter((c) => c.state === 'failure')
        if (!failing.length) throw new Error('No failing checks found')
        return this.ask(ws, sessionId, FIX_CI_MESSAGE, await this.ciFailureAttachments(ws, provider, failing, prompts.fixErrors))
      }

      case 'resolve-conflicts':
        return this.ask(ws, sessionId, resolveConflictsMessage(ws.baseBranch, prompts.resolveConflicts))

      case 'review': {
        // The app asks which model first (HandOffService); this is the straight path with the review model.
        const review = this.store.state.settings.reviewModel
        const instructions = reviewInstructions({ base: ws.baseBranch, customPrompt: prompts.codeReview, hasDiffTool: review.agent === 'claude' })
        const file = await attachFromData(this.attachTo(ws), 'Review request.md', toBase64(instructions))
        // The review opens in a new chat; its first turn gets an id up front so the caller can follow it.
        const turnId = randomUUID()
        await this.sessions.handOff(this.targetSession(ws, sessionId).id, {
          model: review,
          text: REVIEW_MESSAGE,
          attachments: [file],
          title: 'Code review',
          turnId
        })
        return { disposition: 'started', turnId }
      }

      case 'open-pr': {
        const status = await this.status(workspaceId)
        if (status.pr) await this.openExternal(this.store.state.settings.openPrIn === 'graphite' ? graphiteUrl(status.pr.url) : status.pr.url)
        return
      }

      case 'archive':
        // The renderer opens the archive dialog for this one.
        return
    }
  }

  /** Fix errors' attachments: up to six failing checks' logs, then the instructions. */
  private async ciFailureAttachments(ws: Workspace, provider: ScmProvider, failing: PrCheck[], customPrompt: string): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    for (const check of failing.slice(0, 6)) {
      const log = await provider.failureLog(ws, check)
      attachments.push(await attachFromData(this.attachTo(ws), `CI ${check.name.replace(/[^\w.-]+/g, '-')}.log`, toBase64(log)))
    }
    attachments.push(await attachFromData(this.attachTo(ws), 'Fix errors instructions.md', toBase64(fixErrorsInstructions(customPrompt))))
    return attachments
  }

  /**
   * #5 auto-fix's send: Fix errors for exactly this failure, into the approved tab, as a turn with this id. The PR is
   * read again first; 'stale' (nothing sent) when its head or failing checks have moved on. GitHub and GitLab alike.
   */
  async sendCiFix(workspaceId: string, sessionId: string, failure: { sha: string; checks: string[] }, options: { turnId: string; origin: MessageOrigin }): Promise<'sent' | 'stale'> {
    const ws = this.workspaces.workspace(workspaceId)
    try {
      const result = await this.prs.get(ws, { fresh: true })
      if (result.kind !== 'ok') throw new Error(result.kind === 'no-pr' ? 'The pull request is gone' : result.message)
      const failing = result.pr.checks.filter((c) => c.state === 'failure' && failure.checks.includes(c.name))
      if (result.pr.state !== 'OPEN' || result.headRefOid !== failure.sha || !failing.length) return 'stale'
      const { provider } = await this.resolve(ws)
      const attachments = await this.ciFailureAttachments(ws, provider, failing, this.workspaces.settingsFor(ws.repoId).prompts.fixErrors)
      await this.sessions.send(sessionId, FIX_CI_MESSAGE, { attachments, mode: 'queue', turnId: options.turnId, origin: options.origin })
      return 'sent'
    } finally {
      this.prs.invalidate(workspaceId)
    }
  }
}

/** github.com/owner/repo/pull/12 → Graphite's page for the same PR. */
export function graphiteUrl(prUrl: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl)
  return m ? `https://app.graphite.dev/github/pr/${m[1]}/${m[2]}/${m[3]}` : prUrl
}
