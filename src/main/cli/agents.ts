// `foreman loadouts | review-model | models | agents`: Settings → Default models and Settings → Agents from the command line.
// Each handler is the same change the window makes, through the same `updateSettings`; the agent and model ids are checked
// against the agent catalog and the model catalog the snapshot carries (what the picker lists).
import { AGENT_ORDER, AGENTS, chatAgentKinds, modelInfo, type AgentKind, type EffortLevel, type Loadout, type ModelInfo } from '../../shared/agents'
import { agentAuthMode, AGENT_CATALOG, catalogAgent, isAgentEnabled, signInMethods, type AgentPrefs } from '../../shared/agentCatalog'
import { modelUses, setModelHidden, type HiddenModels } from '../../shared/modelVisibility'
import type { AgentEnabledResult, AgentIdParams, AgentModels, AgentRow, AgentsAuthParams, AgentsAuthResult, AgentsListResult, AgentsPathParams, AgentsPathResult, AgentsStatusResult, LoadoutParams, LoadoutRow, LoadoutsMoveParams, LoadoutsRemoveParams, LoadoutsResult, LoadoutsSetParams, ModelRow, ModelsListParams, ModelsListResult, ModelsRefreshParams, ModelsRefreshResult, ModelsVisibilityResult, ReviewModelResult } from '../../shared/cli/agents'
import { EFFORT_LEVELS, MAX_LOADOUT_SLOTS } from '../../shared/cli/agents'
import type { AppSnapshot, Settings } from '../../shared/types'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliHost } from './host'
import { columns, flagParam, invalid, numberParam, paramsObject, textList, textParam, type MethodDef } from './kit'
import { firstLine, tokensText } from './refs'

// ---- checking what was typed ----

/** The agent a loadout, review model or model list may name: the Full agents and the Chat agents (the ones with chats). */
export function agentKindOf(id: string): AgentKind {
  const kinds = chatAgentKinds()
  if ((kinds as string[]).includes(id)) return id as AgentKind
  const entry = catalogAgent(id)
  if (entry) throw invalid(`${entry.name} is a ${entry.level} agent: it runs in a terminal tab, so it has no chats and no models to choose.`)
  throw invalid(`Unknown agent “${id}”. Agents with chats: ${kinds.join(', ')}.`, '`foreman agents` lists every agent.')
}

/** Any agent in the catalog (enabled or not), for the commands that turn it on and off or point at its program. */
function catalogAgentOf(id: string) {
  const entry = catalogAgent(id)
  if (!entry) throw invalid(`Unknown agent “${id}”. Agents: ${AGENT_CATALOG.map((a) => a.id).join(', ')}.`, '`foreman agents` lists them.')
  return entry
}

/** The models an agent last reported, as the snapshot carries them (empty until it has been asked). */
function listedModels(host: CliHost, agent: AgentKind): ModelInfo[] {
  return host.snapshot().catalog.agents[agent]?.models ?? []
}

const sameModel = (m: ModelInfo, id: string): boolean => m.id === id || Boolean(m.aliases?.includes(id))

function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => sameModel(m, id)) ?? models.find((m) => sameModel({ ...m, id: m.id.toLowerCase(), aliases: m.aliases?.map((a) => a.toLowerCase()) }, id.toLowerCase()))
}

function effortOf(value: unknown): EffortLevel | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !(EFFORT_LEVELS as string[]).includes(value)) throw invalid(`Unknown effort “${String(value)}”. Efforts: ${EFFORT_LEVELS.join(', ')}.`)
  return value as EffortLevel
}

function loadoutParams(p: Record<string, unknown>): LoadoutParams {
  const fast = p.fast
  if (fast !== undefined && fast !== null && typeof fast !== 'boolean') throw invalid('fast must be true or false.')
  return { agent: textParam(p, 'agent'), model: textParam(p, 'model'), effort: effortOf(p.effort), ...(typeof fast === 'boolean' ? { fast } : {}) }
}

/**
 * What a slot or the review model becomes. The agent must have chats; the model must be one the agent lists (when it has
 * listed any), with an effort and fast mode it supports. Without an effort the model's default is used, as the picker does;
 * changing only the effort or fast mode of a slot that already has this model keeps the rest.
 */
export function resolveLoadout(host: CliHost, p: LoadoutParams, current?: Loadout): { loadout: Loadout; note?: string } {
  const agent = agentKindOf(p.agent)
  if (!p.model.trim()) throw invalid('Name a model.', `\`foreman models ${agent}\` lists them.`)
  const models = listedModels(host, agent)
  const notes: string[] = []
  const label = AGENTS[agent].label
  let model = p.model.trim()
  let info: ModelInfo | undefined
  if (models.length) {
    info = findModel(models, model)
    if (!info) {
      const ids = models.filter((m) => !m.hidden).map((m) => m.id)
      throw invalid(`${label} doesn’t list a model “${model}”. It lists: ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? `, … (${ids.length} in all)` : ''}.`, `\`foreman models ${agent} --all\` prints them with their sizes.`)
    }
    model = info.id
  } else notes.push(`Foreman hasn’t listed ${label}’s models yet, so “${model}” wasn’t checked. \`foreman models refresh ${agent}\` fetches them.`)
  const same = current && current.agent === agent && current.model === model
  let effort = p.effort
  if (info && effort !== undefined) {
    if (!info.efforts.length) throw invalid(`${info.label} has no adjustable effort.`)
    if (!info.efforts.includes(effort)) throw invalid(`${info.label} takes these efforts: ${info.efforts.join(', ')}.`)
  }
  if (effort === undefined) effort = same ? current.effort : info?.efforts.length ? info.defaultEffort : undefined
  if (p.fast && info && !info.supportsFast) throw invalid(`${info.label} has no fast mode.`)
  const fast = p.fast ?? (same ? current.fast : false)
  if (!isAgentEnabled(agent, host.state().settings.agentPrefs)) notes.push(`${label} is turned off, so new chats can’t use this until you turn it on (\`foreman agents enable ${agent}\`).`)
  return { loadout: { agent, model, ...(effort ? { effort } : {}), fast }, ...(notes.length ? { note: notes.join(' ') } : {}) }
}

function slotOf(p: Record<string, unknown>, name: string, count: number): number {
  const n = numberParam(p, name)
  if (n === undefined) throw invalid(`Missing ${name}.`)
  if (!Number.isInteger(n) || n < 1 || n > count) throw invalid(`There is no slot ${n}. Slots run from 1 to ${count}.`, '`foreman loadouts` lists them.')
  return n
}

// ---- loadouts and the review model ----

type Catalog = AppSnapshot['catalog']['agents']

/** What each agent last listed, read once so a table of slots asks the snapshot once. */
const catalogOf = (host: CliHost): Catalog => host.snapshot().catalog.agents

function loadoutRow(catalog: Catalog, l: Loadout, slot: number): LoadoutRow {
  const label = (catalog[l.agent]?.models ?? []).find((m) => sameModel(m, l.model))?.label ?? modelInfo(l.agent, l.model).label
  return { slot, agent: l.agent, agentName: AGENTS[l.agent]?.label ?? l.agent, model: l.model, modelLabel: label, ...(l.effort ? { effort: l.effort } : {}), fast: l.fast }
}

function loadoutsText(rows: LoadoutRow[]): string {
  const lines = columns([['SLOT', 'AGENT', 'MODEL', 'EFFORT', 'FAST'], ...rows.map((r) => [String(r.slot), r.agent, `${r.model}${r.modelLabel && r.modelLabel !== r.model ? ` (${r.modelLabel})` : ''}`, r.effort ?? '', r.fast ? 'fast' : ''])])
  return `${lines.join('\n')}\nSlot 1 is the default for new chats.`
}

async function saveLoadouts(host: CliHost, next: Loadout[], note: string | undefined, verb: string): Promise<LoadoutsResult> {
  const saved = await host.api.updateSettings({ loadouts: next })
  const catalog = catalogOf(host)
  const final = saved?.loadouts ?? next
  const rows = final.map((l, i) => loadoutRow(catalog, l, i + 1))
  return { loadouts: rows, ...(note ? { note } : {}), text: `${verb}\n${loadoutsText(rows)}${note ? `\n${note}` : ''}` }
}

const loadoutsList: MethodDef = {
  tier: 'read',
  async handle(host): Promise<LoadoutsResult> {
    const catalog = catalogOf(host)
    const rows = host.state().settings.loadouts.map((l, i) => loadoutRow(catalog, l, i + 1))
    return { loadouts: rows, text: loadoutsText(rows) }
  }
}

const loadoutsSet: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<LoadoutsResult> {
    const p = paramsObject(params)
    const current = host.state().settings.loadouts
    const slot = slotOf(p, 'slot', current.length)
    const { loadout, note } = resolveLoadout(host, loadoutParams(p), current[slot - 1])
    return saveLoadouts(host, current.map((l, i) => (i === slot - 1 ? loadout : l)), note, `Slot ${slot} is now ${loadout.agent} ${loadout.model}.`)
  }
}

const loadoutsAdd: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<LoadoutsResult> {
    const p = paramsObject(params)
    const current = host.state().settings.loadouts
    if (current.length >= MAX_LOADOUT_SLOTS) throw invalid(`All ${MAX_LOADOUT_SLOTS} slots are in use.`, 'Remove one first (`foreman loadouts remove <n>`) or change one (`foreman loadouts set <n> …`).')
    const { loadout, note } = resolveLoadout(host, loadoutParams(p))
    return saveLoadouts(host, [...current, loadout], note, `Added ${loadout.agent} ${loadout.model} as slot ${current.length + 1}.`)
  }
}

const loadoutsRemove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<LoadoutsResult> {
    const p = paramsObject(params) as unknown as Partial<LoadoutsRemoveParams>
    const current = host.state().settings.loadouts
    if (current.length <= 1) throw invalid('That is the only slot; there has to be at least one loadout.', 'Change it instead: `foreman loadouts set 1 <agent> <model>`.')
    const slot = slotOf(p as Record<string, unknown>, 'slot', current.length)
    return saveLoadouts(host, current.filter((_, i) => i !== slot - 1), undefined, `Removed slot ${slot} (${current[slot - 1].agent} ${current[slot - 1].model}).`)
  }
}

const loadoutsMove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<LoadoutsResult> {
    const p = paramsObject(params) as Record<string, unknown> & Partial<LoadoutsMoveParams>
    const current = host.state().settings.loadouts
    const from = slotOf(p, 'from', current.length)
    const to = slotOf(p, 'to', current.length)
    if (from === to) return { loadouts: current.map((l, i) => loadoutRow(catalogOf(host), l, i + 1)), text: `Slot ${from} is already there.` }
    const next = current.slice()
    const [moved] = next.splice(from - 1, 1)
    next.splice(to - 1, 0, moved)
    return saveLoadouts(host, next, undefined, `Moved slot ${from} (${moved.agent} ${moved.model}) to ${to}.`)
  }
}

function reviewResult(host: CliHost, l: Loadout, note?: string, verb = ''): ReviewModelResult {
  const { slot: _slot, ...row } = loadoutRow(catalogOf(host), l, 0)
  const text = `${verb}${verb ? '\n' : ''}Review model: ${row.agent} ${row.model}${row.modelLabel !== row.model ? ` (${row.modelLabel})` : ''}${row.effort ? `, effort ${row.effort}` : ''}${row.fast ? ', fast' : ''}`
  return { reviewModel: row, ...(note ? { note } : {}), text: `${text}${note ? `\n${note}` : ''}` }
}

const reviewModelGet: MethodDef = {
  tier: 'read',
  async handle(host): Promise<ReviewModelResult> {
    return reviewResult(host, host.state().settings.reviewModel)
  }
}

const reviewModelSet: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ReviewModelResult> {
    const p = loadoutParams(paramsObject(params))
    const { loadout, note } = resolveLoadout(host, p, host.state().settings.reviewModel)
    const saved = await host.api.updateSettings({ reviewModel: loadout })
    return reviewResult(host, saved?.reviewModel ?? loadout, note, 'Saved.')
  }
}

// ---- models ----

const isHiddenIn = (hidden: HiddenModels, agent: AgentKind, m: ModelInfo): boolean => (hidden[agent] ?? []).some((h) => sameModel(m, h))

function modelRows(settings: Settings, agent: AgentKind, models: ModelInfo[]): ModelRow[] {
  const chosen = agent === 'opencode' ? settings.opencodeModels : undefined
  return models.map((m) => {
    const hidden = isHiddenIn(settings.hiddenModels ?? {}, agent, m)
    return {
      id: m.id,
      label: m.label,
      contextWindow: m.contextWindow,
      efforts: m.efforts,
      supportsFast: m.supportsFast,
      isDefault: Boolean(m.isDefault),
      hidden,
      inPicker: !hidden && !m.hidden && (!chosen || chosen.includes(m.id))
    }
  })
}

const modelsList: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<ModelsListResult> {
    const p = paramsObject(params)
    const all = flagParam(p, 'all')
    const asked = textParam(p, 'agent', { optional: true })
    const settings = host.state().settings
    const catalog = host.snapshot().catalog
    const known = Object.keys(catalog.agents) as AgentKind[]
    const agents = asked ? [agentKindOf(asked)] : [...AGENT_ORDER, ...known.filter((a) => !AGENT_ORDER.includes(a))].filter((a, i, list) => list.indexOf(a) === i)
    const out: AgentModels[] = agents.map((agent) => {
      const entry = catalog.agents[agent]
      const rows = modelRows(settings, agent, entry?.models ?? [])
      const shown = all ? rows : rows.filter((r) => r.inPicker)
      return { agent, agentName: AGENTS[agent].label, models: shown, omitted: rows.length - shown.length, ...(entry?.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}), ...(entry?.error ? { error: entry.error } : {}), ...(entry?.loading ? { loading: true } : {}) }
    })
    const sections = out.map((a) => {
      const head = `${a.agentName} (${a.agent})`
      if (!a.models.length) return `${head}\n  ${a.loading ? 'Asking it for its models…' : a.error ? `Couldn’t list its models: ${firstLine(a.error, 120)}` : a.omitted ? `${a.omitted} hidden; --all shows them.` : `No models listed yet; \`foreman models refresh ${a.agent}\` asks it.`}`
      const lines = columns(a.models.map((m) => [m.id, m.label, tokensText(m.contextWindow), m.efforts.join('/'), [m.isDefault ? 'default' : '', m.supportsFast ? 'fast' : '', m.hidden ? 'hidden' : '', !m.inPicker && !m.hidden ? 'not in picker' : ''].filter(Boolean).join(', ')]))
      return `${head}\n${lines.map((l) => `  ${l}`).join('\n')}${a.omitted ? `\n  (${a.omitted} hidden; --all shows them)` : ''}`
    })
    return { agents: out, text: sections.join('\n\n') }
  }
}

function modelVisibility(hide: boolean): MethodDef {
  return {
    tier: 'admin',
    async handle(host, params): Promise<ModelsVisibilityResult> {
      const p = paramsObject(params)
      const agent = agentKindOf(textParam(p, 'agent'))
      const names = textList(p, 'models')
      if (!names.length) throw invalid('Name at least one model.', `\`foreman models ${agent}\` lists them.`)
      const settings = host.state().settings
      const hidden = settings.hiddenModels ?? {}
      const models = listedModels(host, agent)
      let next: HiddenModels = hidden
      const ids: string[] = []
      for (const name of names) {
        const info = models.length ? findModel(models, name) : undefined
        // A stale id the agent no longer lists can still be shown again.
        const stale = !hide && (hidden[agent] ?? []).includes(name)
        if (models.length && !info && !stale) throw invalid(`${AGENTS[agent].label} doesn’t list a model “${name}”.`, `\`foreman models ${agent} --all\` prints them.`)
        const id = info?.id ?? name
        ids.push(id)
        next = setModelHidden(next, agent, id, hide)
      }
      const stillUsed = hide ? ids.flatMap((id) => { const uses = modelUses(agent, id, settings.loadouts, settings.promptTemplates); return [...uses.loadouts.map((n) => `${id} (loadout ${n})`), ...(uses.template ? [`${id} (a template’s start model)`] : [])] }) : []
      if (JSON.stringify(next[agent] ?? []) !== JSON.stringify(hidden[agent] ?? [])) await host.api.updateSettings({ hiddenModels: next })
      const now = next[agent] ?? []
      return {
        agent,
        hidden: now,
        stillUsed,
        text: `${hide ? 'Hid' : 'Showing'} ${ids.join(', ')} ${hide ? 'from' : 'in'} the ${AGENTS[agent].label} model picker. ${now.length ? `Hidden now: ${now.join(', ')}.` : 'Nothing is hidden now.'}${stillUsed.length ? ` Still used: ${stillUsed.join(', ')} (hiding only shortens the picker).` : ''}`
      }
    }
  }
}

const modelsRefresh: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<ModelsRefreshResult> {
    const p = paramsObject(params) as Record<string, unknown> & ModelsRefreshParams
    const asked = textParam(p, 'agent', { optional: true })
    const agent = asked ? agentKindOf(asked) : undefined
    await host.api.refreshModels(agent)
    const catalog = host.snapshot().catalog.agents
    const refreshed = agent ? [agent] : AGENT_ORDER
    const agents = refreshed.map((a) => ({ agent: a, models: catalog[a]?.models.length ?? 0, ...(catalog[a]?.error ? { error: catalog[a]!.error } : {}) }))
    return { agents, text: agents.map((a) => (a.error ? `${AGENTS[a.agent].label}: couldn’t list its models (${firstLine(a.error, 120)}).` : `${AGENTS[a.agent].label}: ${a.models} model${a.models === 1 ? '' : 's'}.`)).join('\n') }
  }
}

// ---- agents ----

function authOf(id: string, settings: Settings): AgentRow['auth'] {
  const entry = catalogAgent(id)
  if (!entry) return undefined
  const methods = signInMethods(entry)
  const mode = agentAuthMode(id, settings)
  if (mode === 'apiKey' && methods.includes('apiKey')) return 'api-key'
  if (methods.includes('login')) return 'login'
  return methods.includes('apiKey') ? 'api-key' : undefined
}

const agentsList: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<AgentsListResult> {
    const p = paramsObject(params)
    const view = await host.api.agentCatalog(flagParam(p, 'refresh'))
    const settings = host.state().settings
    const rows = AGENT_CATALOG.map((a): AgentRow => {
      const detection = view.detections?.[a.id]
      const status = view.statuses?.[a.id]
      const version = status?.version ?? detection?.version
      const found = detection?.path
      const auth = authOf(a.id, settings)
      return {
        id: a.id,
        name: a.name,
        level: a.level,
        enabled: isAgentEnabled(a.id, settings.agentPrefs),
        installed: detection?.installed ?? status?.installed ?? false,
        ...(version ? { version } : {}),
        ...(found ? { path: found } : {}),
        ...(auth ? { auth } : {}),
        ...(status ? { ready: status.ready, ...(status.method ? { method: status.method } : {}), ...(status.account ? { account: status.account } : {}) } : {})
      }
    })
    const lines = columns([['ID', 'NAME', 'LEVEL', 'ENABLED', 'INSTALLED', 'SIGN-IN', 'READY'], ...rows.map((r) => [r.id, r.name, r.level, r.enabled ? 'on' : 'off', r.installed ? r.version ?? 'yes' : 'no', r.auth ?? '', r.ready === undefined ? '' : r.ready ? `ready${r.method ? ` (${r.method})` : ''}` : 'not ready'])])
    return { agents: rows, text: lines.join('\n') }
  }
}

function usesOf(settings: Settings, id: string): string[] {
  return [...settings.loadouts.flatMap((l, i) => (l.agent === id ? [`loadout ${i + 1}`] : [])), ...(settings.reviewModel.agent === id ? ['the review model'] : [])]
}

function setEnabled(enabled: boolean): MethodDef {
  return {
    tier: 'admin',
    async handle(host, params): Promise<AgentEnabledResult> {
      const p = paramsObject(params) as Record<string, unknown> & Partial<AgentIdParams>
      const entry = catalogAgentOf(textParam(p, 'id'))
      const settings = host.state().settings
      if (!enabled) {
        const uses = usesOf(settings, entry.id)
        if (uses.length) throw invalid(`${entry.name} is used by ${uses.length > 1 ? `${uses.slice(0, -1).join(', ')} and ${uses.at(-1)}` : uses[0]}. Change that first.`, uses[0].startsWith('loadout') ? `\`foreman loadouts set ${uses[0].slice(8)} <agent> <model>\`` : '`foreman review-model set <agent> <model>`')
      }
      if (isAgentEnabled(entry.id, settings.agentPrefs) === enabled) return { id: entry.id, enabled, text: `${entry.name} is already ${enabled ? 'on' : 'off'}.` }
      const prefs: AgentPrefs = { ...settings.agentPrefs, [entry.id]: { ...settings.agentPrefs?.[entry.id], enabled } }
      await host.api.updateSettings({ agentPrefs: prefs })
      return { id: entry.id, enabled, text: `${entry.name} is now ${enabled ? 'on' : 'off'}.` }
    }
  }
}

const agentsAuth: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<AgentsAuthResult> {
    const p = paramsObject(params) as Record<string, unknown> & Partial<AgentsAuthParams>
    const entry = catalogAgentOf(textParam(p, 'id'))
    const mode = textParam(p, 'mode')
    if (mode !== 'login' && mode !== 'api-key') throw invalid('Sign-in is `login` or `api-key`.')
    const settings = host.state().settings
    const stored = mode === 'login' ? 'cli' : 'apiKey'
    if (entry.id === 'claude') await host.api.updateSettings({ claudeAuth: stored })
    else if (entry.id === 'codex') await host.api.updateSettings({ codexAuth: stored })
    else {
      const methods = signInMethods(entry)
      if (!methods.includes('login') || !methods.includes('apiKey')) {
        throw invalid(`${entry.name} ${methods.length ? `signs in only with ${methods.includes('login') ? 'login' : methods.includes('apiKey') ? 'an API key' : 'shared provider keys'}` : 'has no confirmed sign-in method yet'}, so there is nothing to switch.`)
      }
      await host.api.updateSettings({ agentPrefs: { ...settings.agentPrefs, [entry.id]: { ...settings.agentPrefs?.[entry.id], auth: stored } } })
    }
    return { id: entry.id, auth: mode, text: `${entry.name} now signs in with ${mode === 'login' ? 'its own login' : 'an API key'}.${mode === 'api-key' ? ` Save the key with \`foreman agents key ${entry.id} --stdin\` if you haven’t.` : ''}` }
  }
}

const EXECUTABLE_SETTINGS: Record<string, 'claudeExecutablePath' | 'codexExecutablePath' | 'opencodeExecutablePath'> = {
  claude: 'claudeExecutablePath',
  codex: 'codexExecutablePath',
  opencode: 'opencodeExecutablePath'
}

/** A command name stays as it is; anything with a folder in it is made absolute from where the command ran. */
function programPath(value: string, cwd: string | undefined): string {
  const v = value.trim()
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) return path.join(os.homedir(), v.slice(1))
  return /[\\/]/.test(v) || v.startsWith('.') ? path.resolve(cwd ?? process.cwd(), v) : v
}

const agentsPath: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<AgentsPathResult> {
    const p = paramsObject(params) as Record<string, unknown> & Partial<AgentsPathParams>
    const entry = catalogAgentOf(textParam(p, 'id'))
    const given = textParam(p, 'path', { optional: true })
    const clear = flagParam(p, 'clear')
    if (clear === (given !== undefined)) throw invalid('Give a path (or a command name), or --clear to use the one on PATH.')
    if (given !== undefined && !given.trim()) throw invalid('The path is empty; use --clear to go back to the one on PATH.')
    const value = clear ? '' : programPath(given!, textParam(p, 'cwd', { optional: true }))
    const settings = host.state().settings
    const field = EXECUTABLE_SETTINGS[entry.id]
    if (field) await host.api.updateSettings({ [field]: value })
    else {
      const { path: _old, ...rest } = settings.agentPrefs?.[entry.id] ?? {}
      const pref = value ? { ...rest, path: value } : rest
      const prefs: AgentPrefs = { ...settings.agentPrefs }
      if (Object.keys(pref).length) prefs[entry.id] = pref
      else delete prefs[entry.id]
      await host.api.updateSettings({ agentPrefs: prefs })
    }
    const missing = value && (/[\\/]/.test(value) ? !existsSync(value) : false)
    return { id: entry.id, path: value, text: value ? `${entry.name} now runs ${value}.${missing ? ` Nothing is there yet: check the path.` : ''}` : `${entry.name} runs the one found on PATH.` }
  }
}

const agentsStatus: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<AgentsStatusResult> {
    const p = paramsObject(params) as Record<string, unknown> & Partial<AgentIdParams>
    const entry = catalogAgentOf(textParam(p, 'id'))
    const status = entry.level === 'full' ? await host.api.agentStatus(entry.id as AgentKind) : undefined
    const signIn = await host.api.agentSignInStatus(entry.id).catch(() => null)
    const lines = [`${entry.name} (${entry.id}, ${entry.level})`]
    if (status) {
      lines.push(`  ${status.installed ? `installed${status.version ? ` ${status.version}` : ''}` : 'not installed'}; ${status.ready ? 'ready' : 'not ready'}${status.method ? ` (${status.method})` : ''}${status.account ? `, ${status.account}` : ''}`)
      if (status.detail) lines.push(`  ${firstLine(status.detail, 200)}`)
    }
    if (signIn) lines.push(`  sign-in: ${signIn.signedIn ? 'signed in' : 'not signed in'}${signIn.account ? ` as ${signIn.account}` : ''}${signIn.source ? ` (${signIn.source})` : ''}`)
    else lines.push('  sign-in: unknown (this agent can’t report it)')
    return {
      id: entry.id,
      name: entry.name,
      level: entry.level,
      ...(status ? { status: { installed: status.installed, ready: status.ready, ...(status.version ? { version: status.version } : {}), ...(status.method ? { method: status.method } : {}), ...(status.account ? { account: status.account } : {}), ...(status.detail ? { detail: status.detail } : {}) } } : {}),
      ...(signIn ? { signIn: { signedIn: signIn.signedIn, ...(signIn.account ? { account: signIn.account } : {}), ...(signIn.source ? { source: signIn.source } : {}), output: signIn.output } } : {}),
      text: lines.join('\n')
    }
  }
}

export const AGENTS_METHODS: Record<string, MethodDef> = {
  'loadouts-list': loadoutsList,
  'loadouts-set': loadoutsSet,
  'loadouts-add': loadoutsAdd,
  'loadouts-remove': loadoutsRemove,
  'loadouts-move': loadoutsMove,
  'review-model-get': reviewModelGet,
  'review-model-set': reviewModelSet,
  'models-list': modelsList,
  'models-hide': modelVisibility(true),
  'models-show': modelVisibility(false),
  'models-refresh': modelsRefresh,
  'agents-list': agentsList,
  'agents-enable': setEnabled(true),
  'agents-disable': setEnabled(false),
  'agents-auth': agentsAuth,
  'agents-path': agentsPath,
  'agents-status': agentsStatus
}
