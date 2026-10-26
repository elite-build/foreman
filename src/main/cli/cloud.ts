// `foreman cloud status|wake|sleep|restart|reattach|continue|usage|build|preflight`: the Remote workspaces screens' buttons through the same Api calls.
import { CLOUD_PROVIDERS, repoCloud, repoProvider, type CloudProviderId } from '../../shared/cloud'
import {
  cloudRowsText,
  cloudUsageText,
  minutesSince,
  preflightText,
  type CloudActionResult,
  type CloudBuildParams,
  type CloudBuildResult,
  type CloudContinueParams,
  type CloudContinueResult,
  type CloudPreflightParams,
  type CloudPreflightResult,
  type CloudRow,
  type CloudStatusParams,
  type CloudStatusResult,
  type CloudUsageResult,
  type CloudWorkspaceParams
} from '../../shared/cli/cloud'
import { sendReceiptText } from '../../shared/tabs'
import type { Repo, Workspace, WorkspaceCloud } from '../../shared/types'
import { CliCodedError, type CliHost } from './host'
import { flagParam, invalid, numberParam, paramsObject, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { startRefusal } from './policy'
import { refused } from './refs'
import { findTab, findWorkspace } from './resolve'
import { repoOf, snapshotOf } from './repos'

/** How `cloud build --wait` looks for the end of a build: it has no way to be told, so it reads the repository's record. */
export const BUILD_WAIT = { pollMs: 500, capMs: 30 * 60_000 }

const cwdOf = (p: Record<string, unknown>): string => textParam(p, 'cwd', { optional: true }) ?? process.cwd()

const label = (id: string): string => CLOUD_PROVIDERS[id as CloudProviderId]?.label ?? id

/** A remote workspace the command names. */
function cloudWorkspace(host: CliHost, p: Record<string, unknown>): Workspace & { cloud: WorkspaceCloud } {
  const ws = findWorkspace(host.state(), textParam(p, 'workspace'), cwdOf(p))
  if (!ws.cloud) throw invalid(`${ws.name} isn’t a remote workspace; it runs on this computer.`)
  return ws as Workspace & { cloud: WorkspaceCloud }
}

/** The provider a repository's remote workspaces use: its own pick, else the first sandbox service with a default connection. */
function providerOf(host: CliHost, repo: Repo): CloudProviderId {
  const connections = snapshotOf(host)?.integrations?.connections ?? []
  return repoProvider(repo.cloud, Object.fromEntries(connections.filter((c) => c.isDefault).map((c) => [c.service, c.id])))
}

// ----- status and the sandbox's own controls -----

function rowOf(host: CliHost, ws: Workspace, cloud: WorkspaceCloud, now: number): CloudRow {
  const repo = host.state().repos.find((r) => r.id === ws.repoId)
  const idle = cloud.status === 'running' ? minutesSince(cloud.lastActivityAt, now) : undefined
  return {
    workspace: ws.name,
    id: ws.id,
    repo: repo?.name ?? ws.repoId,
    provider: label(cloud.provider),
    sandbox: cloud.id,
    status: cloud.status,
    vcpus: cloud.vcpus,
    region: cloud.region,
    ...(idle !== undefined ? { idleMinutes: idle } : {}),
    ...(repo && idle !== undefined ? { sleepsAfterMinutes: repoCloud(repo).idleMinutes } : {}),
    ...(cloud.sessionExpiresAt ? { sessionExpiresAt: cloud.sessionExpiresAt } : {}),
    ...(cloud.disconnected ? { disconnected: true } : {}),
    ...(cloud.error ? { error: cloud.error } : {})
  }
}

async function status(host: CliHost, params: unknown): Promise<CloudStatusResult> {
  const p = paramsObject(params as CloudStatusParams)
  const now = Date.now()
  if (textParam(p, 'workspace', { optional: true })) {
    const ws = cloudWorkspace(host, p)
    // Asking for one asks the provider again; a sleeping sandbox stays asleep.
    let cloud = ws.cloud
    let note = ''
    try {
      cloud = await host.api.cloudStatus(ws.id)
    } catch (err) {
      note = `\n(Couldn’t ask ${label(ws.cloud.provider)}: ${err instanceof Error ? err.message : String(err)} Showing what Foreman last knew.)`
    }
    const rows = [rowOf(host, ws, cloud, now)]
    return { workspaces: rows, text: cloudRowsText(rows) + note }
  }
  const rows = host.state().workspaces.filter((w) => w.cloud && w.state !== 'archived').map((w) => rowOf(host, w, w.cloud!, now))
  return { workspaces: rows, text: cloudRowsText(rows) }
}

const VERBS = {
  wake: (host: CliHost, id: string) => host.api.cloudWake(id),
  sleep: (host: CliHost, id: string) => host.api.cloudSleep(id),
  restart: (host: CliHost, id: string) => host.api.cloudRestart(id),
  reattach: async (host: CliHost, id: string) => {
    await host.api.cloudReattach(id)
    return undefined
  }
}

const DONE_TEXT: Record<keyof typeof VERBS, (name: string, status?: string) => string> = {
  wake: (name, status) => `Woke ${name}’s sandbox${status ? `: ${status}` : ''}.`,
  sleep: (name, status) => `Put ${name}’s sandbox to sleep${status ? `: ${status}` : ''}. Its files are kept.`,
  restart: (name, status) => `Restarted ${name}’s sandbox${status ? `: ${status}` : ''}.`,
  reattach: (name) => `Picked up again the turns ${name}’s sandbox kept running while Foreman was disconnected.`
}

function sandboxAction(verb: keyof typeof VERBS): MethodDef {
  return {
    tier: 'act',
    handle: async (host, params): Promise<CloudActionResult> => {
      const ws = cloudWorkspace(host, paramsObject(params as CloudWorkspaceParams))
      const after = await VERBS[verb](host, ws.id)
      return { workspace: { id: ws.id, name: ws.name }, verb, ...(after ? { status: after.status } : {}), text: DONE_TEXT[verb](ws.name, after?.status) }
    }
  }
}

async function continueTurn(host: CliHost, params: unknown, ctx: CliContext): Promise<CloudContinueResult> {
  const p = paramsObject(params as CloudContinueParams)
  const ws = cloudWorkspace(host, p)
  // Continue wakes the sandbox and sends the chat a message: it starts a turn.
  const refusal = startRefusal(host, ctx.caller)
  if (refusal) throw refused(refusal)
  const { tab, session } = findTab(host.state().sessions, ws, numberParam(p, 'tab'))
  const receipt = await host.api.cloudContinue(session.id)
  if (!receipt.turnId || receipt.disposition === 'handled') throw new CliCodedError('failed', 'Foreman handled that itself; no turn was started.')
  return { workspace: { id: ws.id, name: ws.name }, tab, session: session.id, turn: receipt.turnId, disposition: receipt.disposition, text: sendReceiptText(receipt.disposition, tab, session, receipt.turnId) }
}

async function usage(host: CliHost): Promise<CloudUsageResult> {
  const providers = await host.api.cloudUsage()
  return { providers, text: cloudUsageText(providers, label) }
}

// ----- base builds -----

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

/** The lines of a chunk of build output (a progress line each). */
const linesOf = (chunk: string): string[] => chunk.split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim())

async function build(host: CliHost, params: unknown, ctx: CliContext): Promise<CloudBuildResult> {
  const p = paramsObject(params as CloudBuildParams)
  const repo = await repoOf(host, p)
  const provider = providerOf(host, repo)
  const info = CLOUD_PROVIDERS[provider]
  // No base to build: the same sentence the window gives, as `not-supported` so a script can tell.
  if (!info.capabilities.base) throw new CliCodedError('not-supported', `${info.label} keeps no base to build: each remote workspace is cloned and set up when it’s made.`, 'Skip this step; `foreman cloud preflight` says whether a remote workspace can be made now.')
  const wait = flagParam(p, 'wait')
  // The build detaches (its output arrives as events), so listen before it starts and read the record for its end.
  const off = wait
    ? host.onEvent((event) => {
        if (event.type !== 'cloud-build-log' || event.repoId !== repo.id) return
        for (const line of linesOf(event.chunk)) ctx.progress(line)
      })
    : undefined
  try {
    const started = await host.api.cloudBuildBase(repo.id)
    const ref = { id: repo.id, name: repo.name }
    if (!wait) {
      return { repo: ref, provider, build: started, outcome: 'building', text: `Started building ${repo.name}’s base on ${info.label} (build ${started.id.slice(0, 8)}). It runs in the app: \`foreman cloud preflight ${repo.name}\` says when a remote workspace can be made, or run this again with --wait to follow it.` }
    }
    const deadline = Date.now() + BUILD_WAIT.capMs
    let settled = started
    for (;;) {
      const now = host.state().repos.find((r) => r.id === repo.id)?.cloud?.build
      // Another build replacing this one (started in the window) ends this wait with what the record says now.
      if (now && (now.id !== started.id || now.status !== 'building')) {
        settled = now
        break
      }
      if (!now) throw new CliCodedError('failed', `${repo.name}’s build record is gone (the repository was removed or its remote setup was reset).`)
      if (ctx.signal?.aborted) throw new CliCodedError('failed', `Stopped waiting. The build keeps running in the app.`)
      if (Date.now() >= deadline) throw new CliCodedError('failed', `${repo.name}’s base is still building after ${Math.round(BUILD_WAIT.capMs / 60_000)} minutes. It keeps running in the app.`)
      await sleep(BUILD_WAIT.pollMs, ctx.signal)
    }
    const outcome = settled.status === 'active' ? 'active' : 'failed'
    const tail = settled.log ? `\n${linesOf(settled.log).slice(-8).join('\n')}` : ''
    const text = outcome === 'active' ? `Built ${repo.name}’s base on ${info.label}${settled.commit ? ` at ${settled.commit.slice(0, 7)}` : ''}. Remote workspaces start from it now.` : `Building ${repo.name}’s base failed: ${settled.error ?? 'no reason given'}${tail}`
    return { repo: ref, provider, build: settled, outcome, text }
  } finally {
    off?.()
  }
}

async function preflight(host: CliHost, params: unknown): Promise<CloudPreflightResult> {
  const repo = await repoOf(host, paramsObject(params as CloudPreflightParams))
  const result = await host.api.cloudPreflight(repo.id)
  return { repo: { id: repo.id, name: repo.name }, preflight: result, text: preflightText(repo.name, result) }
}

export const CLOUD_METHODS: Record<string, MethodDef> = {
  'cloud-status': { tier: 'read', handle: async (host, params) => status(host, params) },
  'cloud-wake': sandboxAction('wake'),
  'cloud-sleep': sandboxAction('sleep'),
  'cloud-restart': sandboxAction('restart'),
  'cloud-reattach': sandboxAction('reattach'),
  // Continue wakes the sandbox and sends a message to the chat: the start policy applies inside.
  'cloud-continue': { tier: 'act', handle: async (host, params, ctx) => continueTurn(host, params, ctx) },
  'cloud-usage': { tier: 'read', handle: async (host) => usage(host) },
  // A build spends the provider's compute and replaces the repository's base.
  'cloud-build': { tier: 'admin', handle: async (host, params, ctx) => build(host, params, ctx) },
  'cloud-preflight': { tier: 'read', handle: async (host, params) => preflight(host, params) }
}
