// The registry: each method the command line can call, the tier it sits in and the handler behind it.
// A method is added by adding a row; the server, the policy and the error codes need no change.
import type { TurnCaller } from '../../shared/agentReports'
import { templatePlaceholders, templateSlug } from '../../shared/promptTemplates'
import { qualifiedName } from '../../shared/repoTemplates'
import { readRepoTemplates } from '../repoTemplates'
import type { CancelParams, ChecksParams, ExportParams, ImportParams, ReportParams, RepoSummary, ResumeAtParams, RunParams, SendParams, TemplateSummary, WaitParams, WaitResult } from '../../cli/protocol'
import { appMethods } from './app'
import { ASK_METHODS } from './ask'
import { APPROVAL_METHODS } from './approvals'
import { CLOUD_METHODS } from './cloud'
import { GIT_METHODS } from './git'
import { REPOS_METHODS } from './repos'
import { TAB_METHODS } from './tabs'
import { statusWords, waitWords, wantsWords } from './words'
import { WORKSPACE_METHODS } from './workspaces'
import { AGENTS_METHODS } from './agents'
import { COMMANDS_METHODS } from './commands'
import { DATA_METHODS } from './data'
import { ENV_METHODS } from './env'
import { INTEGRATIONS_METHODS } from './integrations'
import { REPO_SETTINGS_METHODS } from './repoSettings'
import { SCHEDULES_METHODS } from './schedules'
import { SETTINGS_METHODS } from './settings'
import { TEMPLATES_METHODS } from './templates'
import type { CliHost } from './host'
import type { AnyCliRequest, Tier } from './policy'
import { importCommand, exportCommand } from './portability'
import { resolveRepo } from './resolve'
import { cancel, checks, report, resumeAt, run, send, status, waitForTurn } from './work'

/** What a handler gets besides its parameters. */
export interface CliContext {
  request: AnyCliRequest
  // The turn identity the call carried (attribution; the policy has already looked at it).
  caller: TurnCaller | undefined
  // Aborted when the command that asked goes away; a wait stops waiting, the turn is unaffected.
  signal: AbortSignal | undefined
  // A progress line for a long job. Only a version 2 request hears it; for version 1 it does nothing.
  progress(text: string, percent?: number): void
}

export interface CliMethod {
  tier: Tier
  handle(host: CliHost, params: unknown, ctx: CliContext): Promise<unknown>
}

export const METHODS: Record<string, CliMethod> = {
  status: { tier: 'read', handle: async (host, params) => (wantsWords(params) ? statusWords(host, status(host)) : status(host)) },
  templates: {
    tier: 'read',
    handle: async (host, params) => {
      const state = host.state()
      const personal = state.settings.promptTemplates
      const repo = await resolveRepo(state, (params as { cwd?: string } | undefined)?.cwd ?? process.cwd()).catch(() => undefined)
      const fromRepo = repo ? readRepoTemplates(repo.id, repo.rootPath) : []
      const summary = (t: (typeof personal)[number]): TemplateSummary => ({
        slug: t.source === 'repo' && qualifiedName(t, personal).startsWith('repo:') ? qualifiedName(t, personal) : templateSlug(t.name),
        name: t.name,
        placeholders: templatePlaceholders(t.body),
        ...(t.source === 'repo' ? { source: 'repo' as const } : {})
      })
      return [...personal, ...fromRepo].map(summary)
    }
  },
  repos: { tier: 'read', handle: async (host) => host.state().repos.map((r): RepoSummary => ({ name: r.name, path: r.rootPath })) },
  wait: {
    tier: 'read',
    handle: async (host, params, ctx) => {
      // From inside a live turn (a coordinator waiting on its delegate): that turn's agent slot is lent meanwhile.
      const who = host.identifyCaller(ctx.caller)
      const release = who?.kind === 'turn' && who.live ? host.lendSlot?.(who.session.id) : undefined
      let waited: WaitResult
      try {
        waited = await waitForTurn(host, params as WaitParams, { signal: ctx.signal })
      } finally {
        release?.()
      }
      // --words: the sentence beside the data (the command only asks when it prints text).
      return wantsWords(params) ? { ...waited, words: waitWords(host, waited) } : waited
    }
  },
  // A report is how an agent talks to the user; it changes nothing about Foreman's setup.
  report: { tier: 'read', handle: async (host, params, ctx) => report(host, params as ReportParams, ctx.caller) },
  // app-info, doctor, cli-status and cli-install are in app.ts.
  ...appMethods,
  run: { tier: 'act', handle: async (host, params) => run(host, params as RunParams) },
  send: { tier: 'act', handle: async (host, params) => send(host, params as SendParams) },
  'resume-at': { tier: 'act', handle: async (host, params) => resumeAt(host, params as ResumeAtParams) },
  cancel: { tier: 'act', handle: async (host, params) => cancel(host, params as CancelParams) },
  // Running checks executes the repository's commands, yet agents may call it today (it answers "busy" during
  // a turn), so it stays allowed: tier act, and no startRefusal because it starts no turn.
  checks: { tier: 'act', handle: async (host, params) => checks(host, params as ChecksParams) },
  // `foreman ask`: one assistant turn from the terminal; admin, so never from an agent turn (ask.ts).
  ...ASK_METHODS,
  export: { tier: 'admin', handle: async (host, params) => exportCommand(host, params as ExportParams) },
  import: { tier: 'admin', handle: async (host, params) => importCommand(host, params as ImportParams) },
  // Settings and automations (plan §6): each noun's handlers live in their own file and declare their tiers there.
  ...SETTINGS_METHODS,
  ...REPO_SETTINGS_METHODS,
  ...ENV_METHODS,
  ...AGENTS_METHODS,
  ...TEMPLATES_METHODS,
  ...COMMANDS_METHODS,
  ...SCHEDULES_METHODS,
  ...INTEGRATIONS_METHODS,
  ...DATA_METHODS,
  // Workspaces, chat tabs and approvals (plan §7).
  ...WORKSPACE_METHODS,
  ...TAB_METHODS,
  ...APPROVAL_METHODS,
  // Git and pull requests, repositories, remote workspaces (plan §7).
  ...GIT_METHODS,
  ...REPOS_METHODS,
  ...CLOUD_METHODS
}
