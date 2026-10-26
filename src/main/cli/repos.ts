// `foreman repo add|clone|init|remove|show|branches|remotes|worktrees|account|files-to-copy`, the richer `repos` list and
// `attention`. The settings sub-nouns of `repo` are
// in repoSettings.ts. Each handler calls the Api the window's Repositories screens call.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { repoCloud, repoProvider } from '../../shared/cloud'
import type { ConnectionView } from '../../shared/integrations'
import type {
  AttentionParams,
  AttentionResult,
  AttentionRow,
  AttentionVerb,
  RepoAccountParams,
  RepoAccountResult,
  RepoAddParams,
  RepoAddedResult,
  RepoBranchesParams,
  RepoBranchesResult,
  RepoCloneParams,
  RepoFilesParams,
  RepoFilesResult,
  RepoInitParams,
  RepoQuery,
  RepoRef,
  RepoRemoveParams,
  RepoRemoveResult,
  RepoRemotesResult,
  RepoRow,
  RepoShowResult,
  RepoWorktreesResult,
  ReposListResult
} from '../../shared/cli/repos'
import type { AppSnapshot, Repo, RepoSettingKey } from '../../shared/types'
import type { CliHost } from './host'
import { columns, flagParam, invalid, paramsObject, textList, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { plural } from './refs'
import { resolveRepo } from './resolve'
import { attentionWords } from './words'

const cwdOf = (p: Record<string, unknown>): string => textParam(p, 'cwd', { optional: true }) ?? process.cwd()

/** The repository the command names, else the one it runs in (`.` too). */
export async function repoOf(host: CliHost, p: Record<string, unknown>): Promise<Repo> {
  const query = textParam(p, 'repo', { optional: true })?.trim()
  return resolveRepo(host.state(), cwdOf(p), query && query !== '.' ? query : undefined)
}

const refOf = (repo: Repo): RepoRef => ({ id: repo.id, name: repo.name })

/** The snapshot, or nothing when this host can't make one (the pieces that need it are left out, never guessed). */
export function snapshotOf(host: CliHost): AppSnapshot | undefined {
  try {
    return host.snapshot()
  } catch {
    return undefined
  }
}

/** The GitHub connection a repository uses, by the account it signs in as (else the connection's name). */
function accountOf(repo: Repo, connections: ConnectionView[] | undefined): string | undefined {
  const choice = repo.integrations?.services?.github
  if (choice === 'off') return undefined
  const connection = choice && choice !== 'default' ? connections?.find((c) => c.id === choice) : connections?.find((c) => c.service === 'github' && c.isDefault)
  return connection?.identity?.user ?? connection?.name ?? repo.githubAccount
}

const rowOf = (repo: Repo, connections: ConnectionView[] | undefined): RepoRow => ({
  name: repo.name,
  id: repo.id,
  path: repo.rootPath,
  // Older records (and test fixtures) may lack a default branch; an empty cell beats a crash in the listing.
  defaultBranch: repo.defaultBranch ?? '',
  remote: repo.hasOrigin ? repo.remote : '',
  hasOrigin: repo.hasOrigin,
  ...(accountOf(repo, connections) ? { account: accountOf(repo, connections) } : {}),
  cloud: Boolean(repo.cloud?.enabled)
})

// ----- list, add, clone, init, remove -----

async function list(host: CliHost): Promise<ReposListResult> {
  const connections = snapshotOf(host)?.integrations?.connections
  const rows = host.state().repos.map((r) => rowOf(r, connections))
  const text = rows.length ? columns(rows.map((r) => [r.name, r.path, r.defaultBranch, r.remote || '(no remote)', r.account ?? '', r.cloud ? 'remote on' : ''])).join('\n') : 'No repositories. `foreman repo add <path>` or `foreman repo clone <url>` adds one.'
  return { repos: rows, text }
}

const added = (repo: Repo, verb: string): RepoAddedResult => ({ repo: { ...refOf(repo), path: repo.rootPath }, text: `${verb} ${repo.name} (${repo.rootPath}).` })

async function add(host: CliHost, params: unknown): Promise<RepoAddedResult> {
  const p = paramsObject(params as RepoAddParams)
  const folder = path.resolve(cwdOf(p), textParam(p, 'path'))
  const known = new Set(host.state().repos.map((r) => r.id))
  // Adding a folder inside a repository adds the repository, and one Foreman already has is returned as it is.
  const repo = await host.api.addRepo(folder)
  return added(repo, known.has(repo.id) ? 'Already in Foreman:' : 'Added')
}

/** Git prints `Receiving objects:  45% (1/2)`; the percent goes beside the line. */
const percentOf = (line: string): number | undefined => {
  const m = /(\d{1,3})%/.exec(line)
  return m ? Math.min(100, Number(m[1])) : undefined
}

async function clone(host: CliHost, params: unknown, ctx: CliContext): Promise<RepoAddedResult> {
  const p = paramsObject(params as RepoCloneParams)
  const url = textParam(p, 'url').trim()
  if (!url) throw invalid('Say what to clone: foreman repo clone <url>')
  const into = textParam(p, 'into', { optional: true })
  const parent = into ? path.resolve(cwdOf(p), into) : host.state().settings.cloneDirectory
  const account = textParam(p, 'account', { optional: true })?.trim() || undefined
  // The window gets git's progress as events with this id; here they are progress lines.
  const cloneId = randomUUID()
  const off = host.onEvent((event) => {
    if (event.type !== 'clone-progress' || event.cloneId !== cloneId) return
    const line = event.line.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
    if (line) ctx.progress(line, percentOf(line))
  })
  try {
    return added(await host.api.cloneRepo(url, parent, cloneId, account), 'Cloned and added')
  } finally {
    off()
  }
}

async function init(host: CliHost, params: unknown): Promise<RepoAddedResult> {
  const p = paramsObject(params as RepoInitParams)
  const name = textParam(p, 'name').trim()
  if (!name) throw invalid('Name the repository: foreman repo init <name>')
  const into = textParam(p, 'into', { optional: true })
  const parent = into ? path.resolve(cwdOf(p), into) : host.state().settings.cloneDirectory
  return added(await host.api.quickStartRepo(parent, name), 'Created and added')
}

async function remove(host: CliHost, params: unknown): Promise<RepoRemoveResult> {
  const p = paramsObject(params as RepoRemoveParams)
  if (!textParam(p, 'repo').trim()) throw invalid('Name the repository: foreman repo remove <repo>')
  const repo = await repoOf(host, p)
  const state = host.state()
  const mine = state.workspaces.filter((w) => w.repoId === repo.id)
  const running = new Set(state.sessions.filter((s) => s.status === 'running' && mine.some((w) => w.id === s.workspaceId)).map((s) => s.workspaceId))
  const workspaces = mine.map((w) => ({ name: w.name, branch: w.branch, state: w.state, ...(running.has(w.id) ? { running: true } : {}) }))
  if (!flagParam(p, 'confirmed')) {
    const live = mine.filter((w) => w.state !== 'archived')
    const archived = mine.length - live.length
    const lines = [`Removing ${repo.name} from Foreman deletes ${live.length ? plural(live.length, 'workspace') : 'no workspaces'}${archived ? ` and ${plural(archived, 'archived record')}` : ''}, with their chats and worktrees:`]
    for (const w of mine) lines.push(`  ${w.name}  ${w.branch}${w.state === 'archived' ? '  (archived)' : ''}${running.has(w.id) ? '  RUNNING: stop its agents first' : ''}`)
    lines.push(`The repository folder ${repo.rootPath} is not touched.`)
    const previewText = lines.join('\n')
    return { repo: refOf(repo), workspaces, needsConfirmation: true, previewText, text: `${previewText}\nNothing was removed. Run it again with --yes to remove it.` }
  }
  await host.api.removeRepo(repo.id)
  return { repo: refOf(repo), workspaces, removed: true, text: `Removed ${repo.name} from Foreman (${plural(mine.length, 'workspace')} deleted). The folder ${repo.rootPath} is untouched.` }
}

// ----- show and its parts -----

async function show(host: CliHost, params: unknown): Promise<RepoShowResult> {
  const p = paramsObject(params as RepoQuery)
  const repo = await repoOf(host, p)
  const state = host.state()
  const snapshot = snapshotOf(host)
  const connections = snapshot?.integrations?.connections
  const mine = state.workspaces.filter((w) => w.repoId === repo.id)
  const workspaces = { live: mine.filter((w) => w.state !== 'archived').length, archived: mine.filter((w) => w.state === 'archived').length }
  let settings: RepoShowResult['settings']
  try {
    const resolved = host.resolvedRepoSettings(repo.id)
    const sources = Object.values(resolved.sources as Partial<Record<RepoSettingKey, string>>)
    settings = {
      local: sources.filter((s) => s === 'local').length,
      shared: sources.filter((s) => s === 'shared').length,
      user: sources.filter((s) => s === 'user').length,
      ...(resolved.sharedFile ? { sharedFile: resolved.sharedFile } : {}),
      ...(resolved.sharedError ? { sharedError: resolved.sharedError } : {})
    }
  } catch {
    settings = undefined
  }
  const templates = snapshot?.repoTemplates?.[repo.id]?.length
  const cloud = repoCloud(repo)
  const defaults = Object.fromEntries((connections ?? []).filter((c) => c.isDefault).map((c) => [c.service, c.id]))
  const cloudView = { enabled: cloud.enabled, provider: repoProvider(cloud, defaults), vcpus: cloud.vcpus, region: cloud.region, idleMinutes: cloud.idleMinutes, ...(cloud.build ? { build: cloud.build.status } : {}) }
  const account = accountOf(repo, connections)
  const integrations: Record<string, string> = {}
  for (const [service, choice] of Object.entries(repo.integrations?.services ?? {})) {
    if (!choice) continue
    integrations[service] = choice === 'off' || choice === 'default' ? choice : (connections?.find((c) => c.id === choice)?.name ?? choice)
  }
  const info = { id: repo.id, name: repo.name, path: repo.rootPath, defaultBranch: repo.defaultBranch, remote: repo.remote, hasOrigin: repo.hasOrigin, ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}), ...(repo.rootCommit ? { rootCommit: repo.rootCommit } : {}), createdAt: repo.createdAt }
  const rows: string[][] = [
    ['folder', repo.rootPath],
    ['default branch', repo.defaultBranch],
    ['remote', repo.hasOrigin ? `${repo.remote}${repo.remoteUrl ? `  ${repo.remoteUrl}` : ''}` : 'none'],
    ['account', account ?? 'none (git’s own credentials)'],
    ['workspaces', `${workspaces.live} live${workspaces.archived ? `, ${workspaces.archived} archived` : ''}`]
  ]
  if (settings) rows.push(['settings', `${settings.local} set on this computer, ${settings.shared} from ${settings.sharedFile ?? 'the shared file'}, ${settings.user} from your settings${settings.sharedError ? `  (shared file error: ${settings.sharedError})` : ''}`])
  rows.push(['shared file', settings?.sharedFile ?? 'none'])
  if (templates !== undefined) rows.push(['templates', `${templates} from .foreman/templates`])
  rows.push(['remote workspaces', cloud.enabled ? `on: ${cloudView.provider}, ${cloud.vcpus} vCPU${cloud.region ? `, ${cloud.region}` : ''}, sleep after ${cloud.idleMinutes}m idle${cloud.build ? `; base ${cloud.build.status}` : ''}` : 'off'])
  const services = Object.entries(integrations)
  rows.push(['integrations', services.length ? services.map(([s, c]) => `${s}: ${c}`).join(', ') : 'all default'])
  const lines = [repo.name, ...columns(rows).map((l) => `  ${l}`)]
  return { repo: info, ...(account ? { account } : {}), workspaces, ...(settings ? { settings } : {}), ...(templates !== undefined ? { templates } : {}), cloud: cloudView, integrations, text: lines.join('\n') }
}

async function branches(host: CliHost, params: unknown): Promise<RepoBranchesResult> {
  const p = paramsObject(params as RepoBranchesParams)
  const repo = await repoOf(host, p)
  const list = await host.api.listBranches(repo.id, flagParam(p, 'fetch') ? { fetch: true } : undefined)
  const rows = list.map((b) => [b.name + (b.isDefault ? ' (default)' : ''), [b.local ? 'local' : '', b.remote ? 'remote' : ''].filter(Boolean).join(' + '), b.checkedOutAt ? `checked out at ${b.checkedOutAt}` : ''])
  return { repo: refOf(repo), branches: list, text: rows.length ? columns(rows).join('\n') : `${repo.name} has no branches yet.` }
}

async function remotes(host: CliHost, params: unknown): Promise<RepoRemotesResult> {
  const repo = await repoOf(host, paramsObject(params))
  const names = await host.api.listRemotes(repo.id)
  return { repo: refOf(repo), remotes: names, remote: repo.remote, text: names.length ? names.map((n) => `${n}${n === repo.remote ? '  (Foreman pushes and opens pull requests here)' : ''}`).join('\n') : `${repo.name} has no remotes.` }
}

async function worktrees(host: CliHost, params: unknown): Promise<RepoWorktreesResult> {
  const repo = await repoOf(host, paramsObject(params))
  const trees = await host.api.listWorktrees(repo.id)
  const rows = trees.map((t) => [t.path, t.branch ?? `(detached ${t.head.slice(0, 7)})`, [t.isMain ? 'main checkout' : '', t.workspaceId ? `workspace ${host.state().workspaces.find((w) => w.id === t.workspaceId)?.name ?? t.workspaceId}` : t.isMain ? '' : 'not a workspace', t.dirty ? `${plural(t.dirty, 'file')} changed` : ''].filter(Boolean).join(', ')])
  return { repo: refOf(repo), worktrees: trees, text: rows.length ? columns(rows).join('\n') : `${repo.name} has no worktrees.` }
}

async function account(host: CliHost, params: unknown): Promise<RepoAccountResult> {
  const p = paramsObject(params as RepoAccountParams)
  const repo = await repoOf(host, p)
  const detect = flagParam(p, 'detect')
  const save = flagParam(p, 'save')
  if (save && !detect) throw invalid('--save goes with --detect: it links the repository to the account detection finds.')
  const current = accountOf(repo, snapshotOf(host)?.integrations?.connections)
  if (!detect) return { repo: refOf(repo), ...(current ? { account: current } : {}), text: `${repo.name} uses ${current ? `the GitHub account ${current}` : 'git’s own credentials (no GitHub account is linked)'}.` }
  const detection = await host.api.detectRepoAccount(repo.id, save)
  const lines = [detection.slug ? `${repo.name}’s remote is ${detection.slug} on github.com.` : `${repo.name}’s remote isn’t on github.com, so no account applies.`]
  if (detection.slug) {
    lines.push(detection.pushers.length ? `Signed-in accounts that can push there: ${detection.pushers.join(', ')}.` : 'No signed-in account can push there.')
    lines.push(detection.account ? `${detection.account} is the only one that can, so it is the pick${save ? ' and is now linked' : ''}.` : detection.pushers.length > 1 ? 'More than one can push, so there is no automatic pick: choose one in Repository settings → Integrations.' : 'There is nothing to pick.')
  }
  if (!save && detection.account) lines.push('Add --save to link the repository to it.')
  return { repo: refOf(repo), ...(detection.account ? { account: detection.account } : current ? { account: current } : {}), detection, ...(save ? { saved: true } : {}), text: lines.join('\n') }
}

async function filesToCopy(host: CliHost, params: unknown): Promise<RepoFilesResult> {
  const p = paramsObject(params as RepoFilesParams)
  const repo = await repoOf(host, p)
  const patterns = textList(p, 'patterns', { optional: true })
  const result = await host.api.previewFilesToCopy(repo.id, patterns?.length ? patterns : undefined)
  const shown = result.files.slice(0, 200)
  const lines = [`Patterns${result.fromWorktreeInclude ? ' (from .worktreeinclude)' : ''}: ${result.patterns.length ? result.patterns.join(', ') : 'none'}`, result.files.length ? `${plural(result.files.length, 'ignored file')} would be copied into a new workspace:` : 'No ignored files match, so nothing would be copied.', ...shown.map((f) => `  ${f}`)]
  if (result.files.length > shown.length) lines.push(`  … and ${result.files.length - shown.length} more`)
  return { repo: refOf(repo), files: result.files, patterns: result.patterns, fromWorktreeInclude: result.fromWorktreeInclude, text: lines.join('\n') }
}

// ----- attention -----

async function attention(host: CliHost, params: unknown): Promise<AttentionResult> {
  const p = paramsObject(params as AttentionParams)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as AttentionVerb
  if (verb !== 'list' && verb !== 'seen') throw invalid(`“${verb}” isn’t an attention command. Use list or seen.`)
  if (verb === 'seen') {
    await host.api.markAttentionSeen()
    return { verb, events: [], text: 'Marked the attention history as seen. Nothing waiting for you changed.' }
  }
  const { events, seenAt } = await host.api.attentionHistory()
  const names = new Map(host.state().workspaces.map((w) => [w.id, w.name]))
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at))
  const rows: AttentionRow[] = sorted
    .map((e) => ({
      id: e.id,
      at: e.at,
      firstAt: e.firstAt,
      kind: e.kind,
      workspace: names.get(e.workspaceId) ?? e.workspaceId,
      workspaceId: e.workspaceId,
      ...(e.label ? { label: e.label } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
      count: e.count,
      unseen: !seenAt || e.at > seenAt
    }))
  // --words: sentences instead of the table (the command only asks when it prints text).
  const words = flagParam(p as Record<string, unknown>, 'words')
  const text = words
    ? attentionWords(host, sorted, seenAt)
    : rows.length
    ? columns(rows.map((r) => [r.unseen ? '*' : ' ', r.at.slice(0, 16).replace('T', ' '), r.kind, r.workspace, [r.label ?? '', r.detail ?? ''].filter(Boolean).join(': ') + (r.count > 1 ? `  ×${r.count}` : '')])).join('\n') + (rows.some((r) => r.unseen) ? '\n* newer than the last time it was marked seen' : '')
    : 'Nothing has needed your attention lately.'
  return { verb, events: rows, ...(seenAt ? { seenAt } : {}), text }
}

export const REPOS_METHODS: Record<string, MethodDef> = {
  // The richer list `foreman repos` can use (name, path, default branch, remote, account, remote workspaces).
  'repos-list': { tier: 'read', handle: async (host) => list(host) },
  'repo-add': { tier: 'admin', handle: async (host, params) => add(host, params) },
  'repo-clone': { tier: 'admin', handle: async (host, params, ctx) => clone(host, params, ctx) },
  'repo-init': { tier: 'admin', handle: async (host, params) => init(host, params) },
  'repo-remove': { tier: 'admin', handle: async (host, params) => remove(host, params) },
  'repo-show': { tier: 'read', handle: async (host, params) => show(host, params) },
  'repo-branches': { tier: 'read', handle: async (host, params) => branches(host, params) },
  'repo-remotes': { tier: 'read', handle: async (host, params) => remotes(host, params) },
  'repo-worktrees': { tier: 'read', handle: async (host, params) => worktrees(host, params) },
  // --save links the repository to a GitHub account, so the method as a whole is admin.
  'repo-account': { tier: 'admin', handle: async (host, params) => account(host, params) },
  'repo-files-to-copy': { tier: 'read', handle: async (host, params) => filesToCopy(host, params) },
  // `seen` moves only the history's marker; no reason Foreman is showing is resolved by it.
  attention: { tier: 'act', handle: async (host, params) => attention(host, params) }
}
