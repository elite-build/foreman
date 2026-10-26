// `foreman env|keys|github|gitlab|cloud token|agents key`: environment variables and the vault's secrets, through the
// Api calls Settings → Environment and the account pages make. Values go in and are
// never printed; a list shows names, origins and at most four characters. Revealing one is refused from inside an
// agent turn, whatever the tier says.
import { AGENT_CATALOG, keyAgents, takesSharedKeys, toggleKeyAgent } from '../../shared/agentCatalog'
import { providerInfo } from '../../shared/providers'
import type {
  AgentKeySetResult,
  CloudTokenStatusResult,
  EnvFilesResult,
  EnvImportResult,
  EnvListResult,
  EnvRenameResult,
  EnvRevealResult,
  EnvScopeInfo,
  EnvSetResult,
  EnvUnsetResult,
  GithubAccountsResult,
  GithubStatusResult,
  GitlabConnectionResult,
  GitlabListResult,
  KeyRow,
  KeysAgentsResult,
  KeysListResult,
  KeysSetResult,
  TokenSavedResult
} from '../../shared/cli/env'
import type { EnvScope, EnvVarRow, GitlabConnection } from '../../shared/types'
import { CliCodedError, type CliHost } from './host'
import { columns, flagParam, fromAgentTurn, hintOf, invalid, paramsObject, pairList, textList, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { resolveRepo } from './resolve'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const REVEAL_REFUSED = 'Secrets can’t be revealed from inside an agent turn.'

function checkName(key: string): string {
  if (!ENV_NAME.test(key)) throw invalid(`'${key}' isn’t a valid variable name (letters, digits and underscores, not starting with a digit).`)
  return key
}

function refuseReveal(ctx: Pick<CliContext, 'caller'>): void {
  if (fromAgentTurn(ctx)) throw new CliCodedError('refused', REVEAL_REFUSED)
}

// ---- scope ----

interface Scope {
  scope: EnvScope
  info: EnvScopeInfo
  // "you" or the repository's name, for sentences.
  who: string
}

async function scopeOf(host: CliHost, p: Record<string, unknown>): Promise<Scope> {
  const query = textParam(p, 'repo', { optional: true })?.trim()
  if (!query) return { scope: { kind: 'user' }, info: { kind: 'user' }, who: 'you' }
  const repo = await resolveRepo(host.state(), textParam(p, 'cwd'), query === '.' ? undefined : query)
  return { scope: { kind: 'repo', repoId: repo.id }, info: { kind: 'repo', repo: { id: repo.id, name: repo.name } }, who: repo.name }
}

// ---- variables ----

function rowText(r: EnvVarRow): string[] {
  const where = r.origin === 'saved' ? 'saved in Foreman' : r.origin === 'file' ? `from ${r.file ?? 'an env file'}` : `from ${r.file ?? 'the committed settings file'}`
  return [`  ${r.key}`, `${where}${r.overridden ? ' (overridden here)' : ''}`]
}

export async function envList(host: CliHost, params: unknown): Promise<EnvListResult> {
  const p = paramsObject(params)
  const { scope, info, who } = await scopeOf(host, p)
  const view = await host.api.envView(scope)
  const lines: string[] = [`Environment variables for ${who}:`]
  lines.push(...(view.vars.length ? columns(view.vars.map(rowText)) : ['  none']))
  if (view.files.length) lines.push('', 'Env files:', ...columns(view.files.map((f) => [`  ${f.path}`, f.error ? f.error : `${f.count} variable${f.count === 1 ? '' : 's'}`])))
  if (view.shared?.length) lines.push('', 'From the committed settings file:', ...columns(view.shared.map(rowText)))
  if (view.inherited?.length) lines.push('', 'From your own variables:', ...columns(view.inherited.map(rowText)))
  lines.push('', 'Values are never shown here.')
  return { scope: info, vars: view.vars, files: view.files, ...(view.shared ? { shared: view.shared } : {}), ...(view.inherited ? { inherited: view.inherited } : {}), text: lines.join('\n') }
}

export async function envSet(host: CliHost, params: unknown): Promise<EnvSetResult> {
  const p = paramsObject(params)
  const key = checkName(textParam(p, 'key'))
  const value = textParam(p, 'value')
  const { scope, info, who } = await scopeOf(host, p)
  await host.api.setEnvVars(scope, [{ key, value }])
  const hint = hintOf(value)
  return { scope: info, key, ...(hint ? { hint } : {}), text: `Saved ${key} for ${who}${hint ? ` (…${hint})` : ''}.` }
}

export async function envUnset(host: CliHost, params: unknown): Promise<EnvUnsetResult> {
  const p = paramsObject(params)
  const keys = textList(p, 'keys').map(checkName)
  if (!keys.length) throw invalid('Name the variables to remove.')
  const { scope, info, who } = await scopeOf(host, p)
  const view = await host.api.envView(scope)
  const missing = keys.filter((k) => !view.vars.some((v) => v.key === k && v.origin === 'saved'))
  if (missing.length) {
    const fromFile = missing.filter((k) => view.vars.some((v) => v.key === k))
    if (fromFile.length === missing.length) throw invalid(`${fromFile.join(', ')} comes from an env file, not from Foreman; remove it from the file.`)
    throw new CliCodedError('not-found', `${who === 'you' ? 'You have' : `${who} has`} no saved variable called ${missing.map((k) => `'${k}'`).join(', ')}.`)
  }
  await host.api.setEnvVars(scope, keys.map((key) => ({ key, value: null })))
  return { scope: info, removed: keys, text: `Removed ${keys.join(', ')} for ${who}.` }
}

export async function envRename(host: CliHost, params: unknown): Promise<EnvRenameResult> {
  const p = paramsObject(params)
  const from = checkName(textParam(p, 'from'))
  const to = checkName(textParam(p, 'to'))
  if (from === to) throw invalid('The new name is the same as the old one.')
  const { scope, info, who } = await scopeOf(host, p)
  const view = await host.api.envView(scope)
  if (!view.vars.some((v) => v.key === from && v.origin === 'saved')) throw new CliCodedError('not-found', `${who === 'you' ? 'You have' : `${who} has`} no saved variable called '${from}'.`)
  if (view.vars.some((v) => v.key === to)) throw invalid(`${to} already exists for ${who}; remove it first.`)
  // The value moves inside the app; it is not part of the answer.
  const value = await host.api.revealEnvVar(scope, from, 'own')
  if (value === null) throw new CliCodedError('not-found', `${from} has no value to move.`)
  await host.api.setEnvVars(scope, [{ key: to, value, previousKey: from }])
  return { scope: info, from, to, text: `Renamed ${from} to ${to} for ${who}.` }
}

export async function envFiles(host: CliHost, params: unknown): Promise<EnvFilesResult> {
  const p = paramsObject(params)
  const verb = textParam(p, 'verb')
  const { scope, info, who } = await scopeOf(host, p)
  const view = await host.api.envView(scope)
  const current = view.files.map((f) => f.path)
  const show = (heading: string, files: EnvFilesResult['files']): EnvFilesResult => ({
    scope: info,
    files,
    text: [heading, ...(files.length ? columns(files.map((f) => [`  ${f.path}`, f.error ? f.error : f.count !== undefined ? `${f.count} variable${f.count === 1 ? '' : 's'}` : ''])) : ['  none'])].join('\n')
  })
  if (verb === 'list') return show(`Env files for ${who}:`, view.files.map((f) => ({ path: f.path, resolved: f.resolved, count: f.count, ...(f.error ? { error: f.error } : {}) })))
  const file = textParam(p, 'path').trim()
  if (!file) throw invalid('Give the path of an env file.')
  if (verb === 'add') {
    if (current.includes(file)) throw invalid(`${file} is already an env file for ${who}.`)
    const next = [...current, file]
    await host.api.setEnvFiles(scope, next)
    return show(`Added ${file}. Env files for ${who}:`, next.map((path) => ({ path })))
  }
  if (verb === 'remove') {
    if (!current.includes(file)) throw new CliCodedError('not-found', `${file} isn’t one of ${who === 'you' ? 'your' : `${who}’s`} env files. They are: ${current.join(', ') || 'none'}.`)
    const next = current.filter((f) => f !== file)
    await host.api.setEnvFiles(scope, next)
    return show(`Removed ${file}. Env files for ${who}:`, next.map((path) => ({ path })))
  }
  throw invalid('verb is list, add or remove.')
}

export async function envImport(host: CliHost, params: unknown): Promise<EnvImportResult> {
  const p = paramsObject(params)
  const entries = pairList(p, 'entries')
  if (!entries.length) throw invalid('There is nothing to import.')
  const bad = entries.map(([key]) => key).filter((key) => !ENV_NAME.test(key))
  if (bad.length) throw invalid(`Not valid variable names: ${bad.join(', ')}.`)
  const { scope, info, who } = await scopeOf(host, p)
  const view = await host.api.envView(scope)
  const saved = new Set(view.vars.filter((v) => v.origin === 'saved').map((v) => v.key))
  // A name given twice keeps its last value, as a .env file does.
  const last = new Map(entries)
  const names = [...last.keys()].map((key) => ({ key, status: saved.has(key) ? ('replaces' as const) : ('new' as const) }))
  const dryRun = flagParam(p, 'dryRun')
  if (!dryRun) await host.api.setEnvVars(scope, [...last].map(([key, value]) => ({ key, value })))
  const list = columns(names.map((n) => [`  ${n.key}`, n.status === 'new' ? 'new' : 'replaces the saved value']))
  const head = dryRun ? `Would save ${names.length} variable${names.length === 1 ? '' : 's'} for ${who}:` : `Saved ${names.length} variable${names.length === 1 ? '' : 's'} for ${who}:`
  return { scope: info, names, saved: !dryRun, text: [head, ...list].join('\n') }
}

export async function envReveal(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<EnvRevealResult> {
  refuseReveal(ctx)
  const p = paramsObject(params)
  const key = checkName(textParam(p, 'key'))
  const layer = textParam(p, 'layer', { optional: true }) ?? 'own'
  if (layer !== 'own' && layer !== 'shared' && layer !== 'inherited') throw invalid('layer is own, shared or inherited.')
  const { scope, who } = await scopeOf(host, p)
  const value = await host.api.revealEnvVar(scope, key, layer)
  if (value === null) throw new CliCodedError('not-found', `${who === 'you' ? 'You have' : `${who} has`} no value for '${key}'${layer === 'own' ? '' : ` in the ${layer} layer`}.`)
  return { key, value, text: value }
}

// ---- provider keys ----

export async function keysList(host: CliHost, _params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<KeysListResult> {
  const view = await host.api.agentCatalog(false)
  const allow = host.state().settings.providerKeyAgents
  const names = [...new Set([...view.savedProviderKeys, ...view.shellProviderKeys])].sort()
  const showHints = !fromAgentTurn(ctx)
  const keys: KeyRow[] = names.map((envVar) => {
    const saved = view.savedProviderKeys.includes(envVar)
    const hint = view.providerKeyHints?.[envVar]
    return { envVar, label: providerInfo(envVar).label, saved, inShell: view.shellProviderKeys.includes(envVar), ...(showHints && saved && hint ? { hint } : {}), agents: keyAgents(envVar, allow) }
  })
  if (!keys.length) return { keys, text: 'No provider keys are saved, and none is set in the shell Foreman started from.' }
  const cells = keys.map((k) => [k.envVar, k.saved ? `saved${k.hint ? ` (…${k.hint})` : ''}` : 'in the shell only', k.agents.join(', ')])
  return { keys, text: ['Provider keys (and the agents that get each):', ...columns(cells.map((c) => [`  ${c[0]}`, c[1], c[2]]))].join('\n') }
}

export async function keysSet(host: CliHost, params: unknown): Promise<KeysSetResult> {
  const p = paramsObject(params)
  const envVar = checkName(textParam(p, 'envVar'))
  const fromShell = flagParam(p, 'fromShell')
  const value = textParam(p, 'value', { optional: true })
  if (fromShell === (value !== undefined)) throw invalid('Give the key’s value, or ask for it to be copied from the shell, not both.')
  if (fromShell) {
    if (!(await host.api.importProviderKey(envVar))) throw new CliCodedError('not-found', `${envVar} isn’t set in the shell Foreman started from, or a key is already saved.`)
    return { envVar, text: `Imported ${envVar} from the shell.` }
  }
  const secret = value!.trim()
  if (!secret) throw invalid('The key is empty.')
  await host.api.setProviderKey(envVar, secret)
  const hint = hintOf(secret)
  return { envVar, ...(hint ? { hint } : {}), text: `Saved ${envVar}${hint ? ` (…${hint})` : ''}.` }
}

export async function keysRemove(host: CliHost, params: unknown): Promise<KeysSetResult> {
  const envVar = checkName(textParam(paramsObject(params), 'envVar'))
  await host.api.setProviderKey(envVar, null)
  return { envVar, text: `Removed ${envVar}.` }
}

/** Ticks (allow) or unticks (deny) agents for a provider key, checked against the catalog as the window's list is. */
async function keysAgents(host: CliHost, params: unknown, on: boolean): Promise<KeysAgentsResult> {
  const p = paramsObject(params)
  const envVar = checkName(textParam(p, 'envVar'))
  const agents = textList(p, 'agents')
  if (!agents.length) throw invalid('Name the agents.')
  const eligible = AGENT_CATALOG.filter((a) => a.id !== 'opencode' && takesSharedKeys(a.id)).map((a) => a.id)
  const unknown = agents.filter((id) => !AGENT_CATALOG.some((a) => a.id === id))
  if (unknown.length) throw new CliCodedError('not-found', `No agent called ${unknown.map((id) => `'${id}'`).join(', ')}. Agents that take shared provider keys: ${eligible.join(', ')}.`)
  if (agents.includes('opencode')) throw invalid('OpenCode always gets every provider key; that can’t be changed.')
  const refused = agents.filter((id) => !takesSharedKeys(id))
  if (refused.length) throw invalid(`${refused.join(', ')} ${refused.length === 1 ? 'doesn’t' : 'don’t'} take shared provider keys. Agents that do: ${eligible.join(', ')}.`)
  let next = host.state().settings.providerKeyAgents
  for (const id of agents) next = toggleKeyAgent(next, envVar, id, on)
  await host.api.updateSettings({ providerKeyAgents: next })
  const now = keyAgents(envVar, next)
  return { envVar, agents: now, text: `${envVar} now goes to ${now.join(', ')}.` }
}

export async function keysReveal(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<EnvRevealResult> {
  refuseReveal(ctx)
  const envVar = checkName(textParam(paramsObject(params), 'envVar'))
  const value = await host.api.revealProviderKey(envVar)
  if (value === null) throw new CliCodedError('not-found', `No saved key called '${envVar}'.`)
  return { key: envVar, value, text: value }
}

export async function agentsKeySet(host: CliHost, params: unknown): Promise<AgentKeySetResult> {
  const p = paramsObject(params)
  const agent = textParam(p, 'agent')
  const entry = AGENT_CATALOG.find((a) => a.id === agent)
  if (!entry) throw new CliCodedError('not-found', `No agent called '${agent}'. \`foreman agents\` lists them.`)
  if (!entry.auth.apiKey) throw invalid(`${entry.name} has no API key of its own to set.${takesSharedKeys(entry.id) ? ' It uses the shared provider keys: foreman keys.' : ''}`)
  const remove = flagParam(p, 'remove')
  const fromShell = flagParam(p, 'fromShell')
  const value = textParam(p, 'value', { optional: true })
  if ([remove, fromShell, value !== undefined].filter(Boolean).length !== 1) throw invalid('Give the key’s value, or --from-shell, or --remove: exactly one.')
  if (remove) {
    await host.api.setAgentKey(agent, null)
    return { agent, text: `Removed ${entry.name}’s API key.` }
  }
  if (fromShell) {
    if (!(await host.api.importAgentKey(agent))) throw new CliCodedError('not-found', `${entry.auth.apiKey.envVar} isn’t set in the shell Foreman started from, or ${entry.name} already has a key.`)
    return { agent, text: `Imported ${entry.name}’s API key from the shell.` }
  }
  const secret = value!.trim()
  if (!secret) throw invalid('The key is empty.')
  await host.api.setAgentKey(agent, secret)
  const hint = hintOf(secret)
  return { agent, ...(hint ? { hint } : {}), text: `Saved ${entry.name}’s API key${hint ? ` (…${hint})` : ''}.` }
}

// ---- GitHub ----

export async function githubStatus(host: CliHost): Promise<GithubStatusResult> {
  const s = await host.api.githubStatus()
  const how = s.method === 'token' ? 'a saved token' : 'the gh command'
  const lines = [
    s.loggedIn ? `GitHub: signed in${s.user ? ` as ${s.user}` : ''}, using ${how}.` : `GitHub: not signed in (Foreman is set to use ${how}).`,
    s.method === 'cli' && !s.installed ? 'The gh command isn’t installed.' : '',
    s.tokenSaved ? `A personal access token is saved${s.method === 'token' ? '' : ' (not used while Foreman uses gh)'}.` : '',
    s.detail ?? ''
  ].filter(Boolean)
  return { installed: s.installed, loggedIn: s.loggedIn, ...(s.user ? { user: s.user } : {}), method: s.method, tokenSaved: s.tokenSaved, ...(s.detail ? { detail: s.detail } : {}), text: lines.join('\n') }
}

export async function githubTokenSet(host: CliHost, params: unknown): Promise<TokenSavedResult> {
  const token = textParam(paramsObject(params), 'token').trim()
  if (!token) throw invalid('The token is empty.')
  if (/\s/.test(token)) throw invalid('That doesn’t look like a token: it has spaces in it.')
  await host.api.setGithubToken(token)
  const hint = hintOf(token)
  return { saved: true, ...(hint ? { hint } : {}), text: `Saved the GitHub token${hint ? ` (…${hint})` : ''}.` }
}

export async function githubTokenClear(host: CliHost): Promise<TokenSavedResult> {
  await host.api.setGithubToken(null)
  return { saved: false, text: 'Removed the saved GitHub token.' }
}

export async function githubAccounts(host: CliHost): Promise<GithubAccountsResult> {
  const accounts = await host.api.githubAccounts()
  const text = accounts.length ? ['GitHub accounts signed in to gh:', ...accounts.map((a) => `  ${a.login}${a.active ? ' (active)' : ''}`)].join('\n') : 'No account is signed in to gh.'
  return { accounts, text }
}

// ---- GitLab ----

export async function gitlabList(host: CliHost): Promise<GitlabListResult> {
  const { hosts, glab } = await host.api.gitlabHosts()
  const rows = hosts.map((h) => ({ host: h.host, url: h.url, selfManaged: h.selfManaged, tokenSaved: h.tokenSaved, repos: h.repos }))
  const cells = hosts.map((h) => [`  ${h.host}`, h.tokenSaved ? 'token saved' : 'no token', [h.selfManaged ? 'self-managed' : 'built in', h.repos.length ? `${h.repos.length} repositor${h.repos.length === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(', ')])
  const lines = ['GitLab hosts:', ...columns(cells), glab ? '' : 'The glab command isn’t installed, so --from-glab isn’t available.'].filter(Boolean)
  return { hosts: rows, glab, text: lines.join('\n') }
}

function connectionResult(result: GitlabConnection, did: string): GitlabConnectionResult {
  if (result.ok) return { ok: true, version: result.version, user: result.user, text: `${did}: signed in as ${result.user} (GitLab ${result.version}).` }
  return { ok: false, error: result.error, text: `${did}: ${result.error}` }
}

export async function gitlabAdd(host: CliHost, params: unknown): Promise<GitlabConnectionResult> {
  const p = paramsObject(params)
  const url = textParam(p, 'url').trim()
  if (!url) throw invalid('Give the GitLab address.')
  const fromGlab = flagParam(p, 'fromGlab')
  const token = textParam(p, 'token', { optional: true })?.trim()
  if (fromGlab === Boolean(token)) throw invalid('Give a token, or ask for the one glab has, not both.')
  // Saving tests the token first and keeps it only when GitLab accepts it.
  const result = fromGlab ? await host.api.useGlabToken(url) : await host.api.saveGitlabToken(url, token!)
  if (!result) throw new CliCodedError('failed', 'GitLab didn’t answer.')
  if (!result.ok) throw new CliCodedError('failed', `GitLab refused it: ${result.error}`)
  return connectionResult(result, `Saved the token for ${url}`)
}

export async function gitlabRemove(host: CliHost, params: unknown): Promise<GitlabListResult> {
  const hostName = textParam(paramsObject(params), 'host').trim()
  const known = (await host.api.gitlabHosts()).hosts
  if (!known.some((h) => h.host === hostName || h.url === hostName)) throw new CliCodedError('not-found', `No GitLab host called '${hostName}'. Hosts: ${known.map((h) => h.host).join(', ') || 'none'}.`)
  await host.api.removeGitlabHost(hostName)
  const after = await gitlabList(host)
  return { ...after, text: `Removed ${hostName} and its token.\n${after.text}` }
}

export async function gitlabTest(host: CliHost, params: unknown): Promise<GitlabConnectionResult> {
  const p = paramsObject(params)
  const url = textParam(p, 'url').trim()
  if (!url) throw invalid('Give the GitLab address.')
  const result = await host.api.testGitlabHost(url, textParam(p, 'token', { optional: true })?.trim() || undefined)
  return connectionResult(result, url)
}

// ---- the cloud setup token ----

export async function cloudTokenStatus(host: CliHost, _params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<CloudTokenStatusResult> {
  const saved = await host.api.cloudClaudeToken()
  if (!saved) return { saved: false, text: 'No Claude setup token is saved for remote workspaces.' }
  const hint = fromAgentTurn(ctx) ? '' : saved.hint
  const since = saved.savedAt ? ` on ${saved.savedAt.slice(0, 10)}` : ''
  return { saved: true, ...(hint ? { hint } : {}), ...(saved.savedAt ? { savedAt: saved.savedAt } : {}), text: `A Claude setup token is saved${hint ? ` (…${hint})` : ''}${since}.` }
}

export async function cloudTokenSet(host: CliHost, params: unknown): Promise<TokenSavedResult> {
  const token = textParam(paramsObject(params), 'token').trim()
  if (!token) throw invalid('The token is empty.')
  await host.api.cloudSetClaudeToken(token)
  const hint = hintOf(token)
  return { saved: true, ...(hint ? { hint } : {}), text: `Saved the Claude setup token${hint ? ` (…${hint})` : ''}.` }
}

export async function cloudTokenClear(host: CliHost): Promise<TokenSavedResult> {
  await host.api.cloudSetClaudeToken(null)
  return { saved: false, text: 'Removed the Claude setup token.' }
}

/**
 * Looking is read; saving, removing and revealing a secret is admin. Names and origins are what the window shows
 * without a click; a request from inside an agent turn also gets no key hints.
 */
export const ENV_METHODS: Record<string, MethodDef> = {
  'env-list': { tier: 'read', handle: async (host, params) => envList(host, params) },
  'keys-list': { tier: 'read', handle: async (host, params, ctx) => keysList(host, params, ctx) },
  'github-status': { tier: 'read', handle: async (host) => githubStatus(host) },
  'github-accounts': { tier: 'read', handle: async (host) => githubAccounts(host) },
  'gitlab-list': { tier: 'read', handle: async (host) => gitlabList(host) },
  'cloud-token-status': { tier: 'read', handle: async (host, params, ctx) => cloudTokenStatus(host, params, ctx) },
  'env-set': { tier: 'admin', handle: async (host, params) => envSet(host, params) },
  'env-unset': { tier: 'admin', handle: async (host, params) => envUnset(host, params) },
  'env-rename': { tier: 'admin', handle: async (host, params) => envRename(host, params) },
  'env-files': { tier: 'admin', handle: async (host, params) => envFiles(host, params) },
  'env-import': { tier: 'admin', handle: async (host, params) => envImport(host, params) },
  'env-reveal': { tier: 'admin', handle: async (host, params, ctx) => envReveal(host, params, ctx) },
  'keys-set': { tier: 'admin', handle: async (host, params) => keysSet(host, params) },
  'keys-remove': { tier: 'admin', handle: async (host, params) => keysRemove(host, params) },
  'keys-allow': { tier: 'admin', handle: async (host, params) => keysAgents(host, params, true) },
  'keys-deny': { tier: 'admin', handle: async (host, params) => keysAgents(host, params, false) },
  'keys-reveal': { tier: 'admin', handle: async (host, params, ctx) => keysReveal(host, params, ctx) },
  'github-token-set': { tier: 'admin', handle: async (host, params) => githubTokenSet(host, params) },
  'github-token-clear': { tier: 'admin', handle: async (host) => githubTokenClear(host) },
  'gitlab-add': { tier: 'admin', handle: async (host, params) => gitlabAdd(host, params) },
  'gitlab-remove': { tier: 'admin', handle: async (host, params) => gitlabRemove(host, params) },
  'gitlab-test': { tier: 'admin', handle: async (host, params) => gitlabTest(host, params) },
  'cloud-token-set': { tier: 'admin', handle: async (host, params) => cloudTokenSet(host, params) },
  'cloud-token-clear': { tier: 'admin', handle: async (host) => cloudTokenClear(host) },
  'agents-key-set': { tier: 'admin', handle: async (host, params) => agentsKeySet(host, params) }
}
