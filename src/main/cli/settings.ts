// `foreman settings …`: read and write the personal settings the Settings window has, through the same Api calls
// the window makes. Which call writes a key is the spec's `apply`; every write,
// including `reset` and `import`, goes through the one planner below so the side effects are the window's.
import { READABLE_SETTINGS, searchSettings, settingPath } from '../../shared/assistant'
import { describeRepoSpec, REPO_SETTINGS_SCHEMA } from '../../shared/repoSettingsSchema'
import type { CloudSettings, Settings } from '../../shared/types'
import type {
  SettingChange,
  SettingExportValue,
  SettingGetRow,
  SettingKeyRow,
  SettingRow,
  SettingSearchRow,
  SettingsExportResult,
  SettingsGetResult,
  SettingsImportResult,
  SettingsKeysResult,
  SettingsListResult,
  SettingsPathResult,
  SettingsResetResult,
  SettingsSearchResult,
  SettingsSetResult
} from '../../shared/cli/settings'
import {
  SETTINGS_PAGES,
  SETTINGS_SCHEMA,
  coerceSettingValue,
  describeSpec,
  displayValue,
  enumSpelling,
  findSetting,
  readSettingValue,
  registryRowOf,
  settingDefault,
  settingPatch,
  settingsByPage,
  type SettingSpec,
  type SettingsPage
} from '../../shared/settingsSchema'
import { defaultSettings } from '../store'
import { CliCodedError, type CliHost } from './host'
import { columns, flagParam, fromAgentTurn, invalid, paramsObject, sameValue, textList, textParam, pairList, type MethodDef } from './kit'
import type { CliContext } from './methods'

/** Page names as Settings shows them; the schema's own page ids are lower case. */
const PAGE_TITLES: Record<SettingsPage, string> = {
  general: 'General',
  account: 'Account',
  appearance: 'Appearance',
  accessibility: 'Accessibility',
  models: 'Models',
  agents: 'Agents',
  git: 'Git',
  environment: 'Environment',
  experimental: 'Experimental',
  advanced: 'Advanced',
  data: 'Data',
  devices: 'Data & devices',
  cloud: 'Remote workspaces'
}

const READABLE_FIELDS = new Set<string>(READABLE_SETTINGS)

/** A request from inside an agent turn may only read what the assistant may (PLAN §13 item 22). */
const visibleTo = (spec: SettingSpec, ctx: Pick<CliContext, 'caller'>): boolean => !fromAgentTurn(ctx) || READABLE_FIELDS.has(spec.field)

const OMITTED_NOTE = 'Some settings are not shown here: paths, commands, shells, keys, accounts and network addresses stay out of an agent turn.'

/** "Settings › Appearance › Theme", or the page for a key with no row in Settings. */
function pathOf(spec: SettingSpec): string {
  const entry = registryRowOf(spec)
  if (entry) return settingPath(entry).replace('Settings › cloud ›', 'Settings › Remote workspaces ›')
  return `Settings › ${PAGE_TITLES[spec.page]}`
}

const PLATFORM_NAMES = { mac: 'macOS', windows: 'Windows' } as const

/** A setting that only does something on the other platform can still be set; it says so. */
function platformNoteOf(spec: SettingSpec, platform: NodeJS.Platform): string | undefined {
  if (spec.platform === 'mac' && platform !== 'darwin') return 'no effect on this computer'
  if (spec.platform === 'windows' && platform !== 'win32') return 'no effect on this computer'
  return undefined
}

function rowOf(spec: SettingSpec, settings: Settings, defaults: Settings, platform: NodeJS.Platform): SettingRow {
  const value = readSettingValue(spec, settings)
  const fallback = settingDefault(spec, settings, defaults)
  const row: SettingRow = { key: spec.key, page: spec.page, type: spec.type, value: displayValue(spec, value), default: displayValue(spec, fallback), changed: !sameValue(value, fallback) }
  if (spec.platform) row.platform = spec.platform
  const note = platformNoteOf(spec, platform)
  if (note) row.platformNote = note
  return row
}

function specOf(key: string): SettingSpec {
  const found = findSetting(key)
  if ('error' in found) throw new CliCodedError('not-found', found.error)
  return found.spec
}

/** Every key looked up first, so a typo is reported with all the others. */
function specsOf(keys: string[]): SettingSpec[] {
  const specs: SettingSpec[] = []
  const errors: string[] = []
  for (const key of keys) {
    const found = findSetting(key)
    if ('error' in found) errors.push(found.error)
    else specs.push(found.spec)
  }
  if (errors.length) throw new CliCodedError('not-found', errors.join('\n'))
  return specs
}

// ---- list, get ----

export async function settingsList(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<SettingsListResult> {
  const p = paramsObject(params)
  const page = textParam(p, 'page', { optional: true })
  if (page !== undefined && !(SETTINGS_PAGES as readonly string[]).includes(page)) throw invalid(`There is no settings page '${page}'. Pages: ${SETTINGS_PAGES.join(', ')}.`)
  const changedOnly = flagParam(p, 'changed')
  const settings = host.state().settings
  const defaults = defaultSettings()
  let omitted = 0
  const rows: SettingRow[] = []
  const lines: string[] = []
  for (const group of settingsByPage()) {
    if (page && group.page !== page) continue
    const cells: string[][] = []
    for (const spec of group.specs) {
      if (!visibleTo(spec, ctx)) {
        omitted++
        continue
      }
      const row = rowOf(spec, settings, defaults, host.platform)
      if (changedOnly && !row.changed) continue
      rows.push(row)
      const extra = [row.changed ? `(default ${row.default})` : '', spec.platform ? `[${PLATFORM_NAMES[spec.platform]} only${row.platformNote ? ', no effect on this computer' : ''}]` : ''].filter(Boolean).join(' ')
      cells.push([`${row.changed ? '*' : ' '} ${row.key}`, row.value, extra])
    }
    if (!cells.length) continue
    if (lines.length) lines.push('')
    lines.push(PAGE_TITLES[group.page], ...columns(cells).map((l) => `  ${l}`))
  }
  if (!rows.length) lines.push(changedOnly ? 'Every setting has its default.' : 'No settings to show.')
  else if (rows.some((r) => r.changed)) lines.push('', '* differs from the default')
  if (omitted) lines.push('', OMITTED_NOTE)
  return { rows, ...(omitted ? { omitted } : {}), text: lines.join('\n') }
}

export async function settingsGet(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<SettingsGetResult> {
  const keys = textList(paramsObject(params), 'keys')
  if (!keys.length) throw invalid('Name at least one setting. `foreman settings keys` lists them.')
  const specs = specsOf(keys)
  const settings = host.state().settings
  const defaults = defaultSettings()
  const rows: SettingGetRow[] = []
  const omitted: string[] = []
  const lines: string[] = []
  for (const spec of specs) {
    if (!visibleTo(spec, ctx)) {
      omitted.push(spec.key)
      continue
    }
    const row: SettingGetRow = { ...rowOf(spec, settings, defaults, host.platform), path: pathOf(spec), takes: describeSpec(spec) }
    rows.push(row)
    lines.push(`${row.key}  ${row.value}${row.changed ? `  (default ${row.default})` : '  (the default)'}`)
    const where = [row.path, row.takes, row.platform ? `${PLATFORM_NAMES[row.platform]} only${row.platformNote ? `, ${row.platformNote}` : ''}` : ''].filter(Boolean)
    lines.push(`  ${where.join(' · ')}`)
  }
  if (omitted.length) lines.push(`Not shown from inside an agent turn: ${omitted.join(', ')}.`)
  return { rows, omitted, text: lines.join('\n') }
}

// ---- writing ----

interface Planned {
  spec: SettingSpec
  value: unknown
  // A map setting normally merges the entries it is given; a reset replaces the whole map.
  replace?: boolean
}

interface Writes {
  // One updateSettings patch for every key that has no owner of its own.
  patch: Partial<Settings>
  mobile?: { enabled: boolean; url: string }
  mobileLan?: { enabled: boolean; address: string }
  handOffs?: { on: boolean; port?: number }
  envFiles?: string[]
  // The settings as they will be once everything is written (what the result reads back).
  after: Settings
}

/** What each owner is called with, from the keys being written and the values that stay as they are. */
function planWrites(current: Settings, planned: Planned[]): Writes {
  let after: Settings = { ...current }
  const patch: Partial<Settings> = {}
  const touched = { mobile: false, mobileLan: false, handOffs: false }
  let envFiles: string[] | undefined
  let port: number | undefined
  for (const { spec, value, replace } of planned) {
    if (spec.apply === 'settings') {
      const { cloud, ...rest } = spec.type === 'map' && replace ? ({ [spec.field]: value } as Partial<Settings>) : settingPatch(spec, value, after)
      Object.assign(patch, rest)
      if (cloud) patch.cloud = { ...patch.cloud, ...cloud } as CloudSettings
      after = { ...after, ...rest, ...(cloud ? { cloud: { ...after.cloud, ...cloud } as CloudSettings } : {}) }
      continue
    }
    after = { ...after, [spec.field]: value }
    if (spec.apply === 'mobile') touched.mobile = true
    else if (spec.apply === 'mobileLan') touched.mobileLan = true
    else if (spec.apply === 'handOffs') {
      touched.handOffs = true
      if (spec.field === 'devicePort') port = value as number
    } else if (spec.apply === 'envFiles') envFiles = value as string[]
  }
  return {
    patch,
    ...(touched.mobile ? { mobile: { enabled: after.mobileEnabled === true, url: after.mobileUrl ?? '' } } : {}),
    ...(touched.mobileLan ? { mobileLan: { enabled: after.mobileLanEnabled === true, address: after.mobileLanAddress ?? '' } } : {}),
    ...(touched.handOffs ? { handOffs: { on: after.acceptHandOffs === true, ...(port !== undefined ? { port } : {}) } } : {}),
    ...(envFiles ? { envFiles } : {}),
    after
  }
}

async function applyWrites(host: CliHost, writes: Writes): Promise<void> {
  if (Object.keys(writes.patch).length) await host.api.updateSettings(writes.patch)
  if (writes.mobile) await host.api.mobileConfigure(writes.mobile.enabled, writes.mobile.url)
  if (writes.mobileLan) await host.api.mobileConfigureLan(writes.mobileLan.enabled, writes.mobileLan.address)
  if (writes.handOffs) await host.api.setAcceptHandOffs(writes.handOffs.on, writes.handOffs.port)
  if (writes.envFiles) await host.api.setEnvFiles({ kind: 'user' }, writes.envFiles)
}

/** Writes the planned values and reports each as key, new value, previous value and the notes that go with it. */
async function writePlanned(host: CliHost, planned: Planned[]): Promise<SettingChange[]> {
  // The last value given for a key wins (map settings merge their entries instead, in planWrites).
  const current = host.state().settings
  const writes = planWrites(current, planned)
  await applyWrites(host, writes)
  const seen = new Set<string>()
  const changes: SettingChange[] = []
  for (const { spec } of planned) {
    if (seen.has(spec.key)) continue
    seen.add(spec.key)
    const change: SettingChange = { key: spec.key, value: displayValue(spec, readSettingValue(spec, writes.after)), was: displayValue(spec, readSettingValue(spec, current)) }
    if (spec.note) change.note = spec.note
    const platformNote = platformNoteOf(spec, host.platform)
    if (platformNote) change.platformNote = platformNote
    changes.push(change)
  }
  return changes
}

function changesText(changes: SettingChange[], verb?: string): string {
  const lines = columns(changes.map((c) => [c.key, c.value, c.value === c.was ? '(unchanged)' : `(was ${c.was})`]))
  const notes = [...new Set(changes.flatMap((c) => [c.note, c.platformNote ? `${c.key}: ${c.platformNote}.` : undefined]).filter((n): n is string => Boolean(n)))]
  return [...(verb ? [verb] : []), ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n')
}

/** Text to values, every key checked first: nothing is written unless all of them are valid. */
function planFromPairs(pairs: [string, string][], cwd: string | undefined): Planned[] {
  const specs = specsOf(pairs.map(([key]) => key))
  const planned: Planned[] = []
  const errors: string[] = []
  pairs.forEach(([, raw], i) => {
    const coerced = coerceSettingValue(specs[i], raw, cwd)
    if ('error' in coerced) errors.push(coerced.error)
    else planned.push({ spec: specs[i], value: coerced.value })
  })
  if (errors.length) throw invalid(errors.join('\n'))
  return planned
}

export async function settingsSet(host: CliHost, params: unknown): Promise<SettingsSetResult> {
  const p = paramsObject(params)
  const pairs = pairList(p, 'pairs')
  if (!pairs.length) throw invalid('Say what to set: foreman settings set <key> <value>.')
  const planned = planFromPairs(pairs, textParam(p, 'cwd', { optional: true }))
  const changes = await writePlanned(host, planned)
  return { changes, text: changesText(changes) }
}

export async function settingsReset(host: CliHost, params: unknown): Promise<SettingsResetResult> {
  const p = paramsObject(params)
  const keys = textList(p, 'keys', { optional: true }) ?? []
  const all = flagParam(p, 'all')
  if (all && keys.length) throw invalid('Name the keys to reset, or pass --all, not both.')
  if (!all && !keys.length) throw invalid('Name the keys to reset, or pass --all --yes to reset every setting.')
  const current = host.state().settings
  const defaults = defaultSettings()
  const specs = all ? [...SETTINGS_SCHEMA] : specsOf(keys)
  const planned: Planned[] = []
  const unchanged: string[] = []
  for (const spec of specs) {
    const value = settingDefault(spec, current, defaults)
    if (sameValue(readSettingValue(spec, current), value)) unchanged.push(spec.key)
    else planned.push({ spec, value, replace: true })
  }
  const changes = planned.length ? await writePlanned(host, planned) : []
  const lines = changes.length ? [changesText(changes, 'Back to the default:')] : []
  if (unchanged.length && !all) lines.push(`Already the default: ${unchanged.join(', ')}.`)
  if (!changes.length) lines.push(all ? 'Every setting already has its default.' : '')
  return { changes, unchanged, text: lines.filter(Boolean).join('\n') }
}

// ---- keys, search, path ----

export async function settingsKeys(): Promise<SettingsKeysResult> {
  const keys: SettingKeyRow[] = SETTINGS_SCHEMA.map((spec) => {
    const entry = registryRowOf(spec)
    const row: SettingKeyRow = { key: spec.key, type: spec.type, takes: describeSpec(spec), page: spec.page, title: entry?.title ?? spec.id.replace(/-/g, ' '), description: entry?.description ?? '' }
    if (spec.platform) row.platform = spec.platform
    if (spec.note) row.note = spec.note
    return row
  })
  const lines: string[] = []
  for (const group of settingsByPage()) {
    if (lines.length) lines.push('')
    lines.push(PAGE_TITLES[group.page])
    lines.push(...columns(keys.filter((k) => k.page === group.page).map((k) => [`  ${k.key}`, k.takes, k.title])))
  }
  return { keys, text: lines.join('\n') }
}

export async function settingsSearch(host: CliHost, params: unknown): Promise<SettingsSearchResult> {
  const query = textParam(paramsObject(params), 'query').trim()
  if (!query) throw invalid('Say what to look for: foreman settings search "dark mode".')
  const rows: SettingSearchRow[] = searchSettings(query, host.platform).map((entry) => ({
    id: entry.id,
    title: entry.title,
    path: settingPath(entry).replace('Settings › cloud ›', 'Settings › Remote workspaces ›'),
    description: entry.description ?? '',
    cli: [
      ...SETTINGS_SCHEMA.filter((s) => s.registryId === entry.id).map((s) => ({ scope: 'settings' as const, key: s.key })),
      ...REPO_SETTINGS_SCHEMA.filter((s) => s.registryId === entry.id).map((s) => ({ scope: 'repo settings' as const, key: s.key }))
    ]
  }))
  if (!rows.length) return { rows, text: `Nothing in Settings matches “${query}”.` }
  const lines: string[] = []
  for (const row of rows) {
    if (lines.length) lines.push('')
    lines.push(row.path)
    if (row.description) lines.push(`  ${row.description}`)
    if (!row.cli.length) lines.push('  cli: none')
    for (const c of row.cli) {
      const spec = c.scope === 'settings' ? SETTINGS_SCHEMA.find((s) => s.key === c.key)! : REPO_SETTINGS_SCHEMA.find((s) => s.key === c.key)!
      const takes = 'tab' in spec ? describeRepoSpec(spec) : describeSpec(spec)
      lines.push(`  cli: foreman ${c.scope} set ${c.key} <${takes.split('. ')[0]}>${c.scope === 'repo settings' ? ' --repo <name>' : ''}`)
    }
  }
  return { rows, text: lines.join('\n') }
}

export async function settingsPath(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<SettingsPathResult> {
  const p = paramsObject(params)
  const spec = specOf(textParam(p, 'key'))
  const where = pathOf(spec)
  let opened = false
  if (flagParam(p, 'open')) {
    if (fromAgentTurn(ctx)) throw new CliCodedError('refused', 'Settings can’t be opened from inside an agent turn.')
    if (!spec.registryId) throw new CliCodedError('not-supported', `${spec.key} has no row in Settings to open (${where}).`)
    host.showSetting(spec.registryId)
    opened = true
  }
  return { key: spec.key, path: where, opened, text: opened ? `${where}\nShowing it in Foreman.` : where }
}

// ---- export, import ----

function exportValue(spec: SettingSpec, value: unknown): SettingExportValue {
  switch (spec.type) {
    case 'boolean':
      return value === true
    case 'enum':
      return enumSpelling(spec, value)
    case 'integer':
    case 'number':
      return Number(value)
    case 'list':
      return Array.isArray(value) ? (value as string[]) : []
    case 'map':
      return { ...((value as Record<string, string> | undefined) ?? {}) }
    default:
      return typeof value === 'string' ? value : ''
  }
}

export async function settingsExport(host: CliHost, _params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<SettingsExportResult> {
  const settings = host.state().settings
  const out: Record<string, SettingExportValue> = {}
  for (const spec of SETTINGS_SCHEMA) if (visibleTo(spec, ctx)) out[spec.key] = exportValue(spec, readSettingValue(spec, settings))
  return { settings: out, text: JSON.stringify(out, null, 2) }
}

/** The text a value stands for in `coerceSettingValue`; a map becomes one `app=path` item per entry. */
function importRaw(key: string, value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [(value as string[]).join(',')]
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')) return Object.entries(value as Record<string, string>).map(([app, where]) => `${app}=${where}`)
  throw invalid(`${key}: that isn’t a value a setting can have.`)
}

export async function settingsImport(host: CliHost, params: unknown): Promise<SettingsImportResult> {
  const p = paramsObject(params)
  const values = p.values
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid('values must be an object of key: value.')
  const entries = Object.entries(values as Record<string, unknown>)
  if (!entries.length) throw invalid('There is nothing to import.')
  const cwd = textParam(p, 'cwd', { optional: true })
  const specs = specsOf(entries.map(([key]) => key))
  const planned: Planned[] = []
  const errors: string[] = []
  entries.forEach(([key, value], i) => {
    const spec = specs[i]
    try {
      const parts = importRaw(key, value)
      if (spec.type === 'map') {
        const merged: Record<string, string> = {}
        for (const part of parts) {
          const c = coerceSettingValue(spec, part, cwd)
          if ('error' in c) errors.push(c.error)
          else Object.assign(merged, c.value)
        }
        planned.push({ spec, value: merged })
      } else {
        const c = coerceSettingValue(spec, spec.type === 'list' ? parts[0] : parts.join(','), cwd)
        if ('error' in c) errors.push(c.error)
        else planned.push({ spec, value: c.value })
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  })
  if (errors.length) throw invalid(errors.join('\n'))
  const current = host.state().settings
  const after = planWrites(current, planned).after
  const changing = planned.filter(({ spec }) => !sameValue(readSettingValue(spec, current), readSettingValue(spec, after)))
  const rows = changing.map(({ spec }) => ({ key: spec.key, from: displayValue(spec, readSettingValue(spec, current)), to: displayValue(spec, readSettingValue(spec, after)) }))
  const unchanged = planned.length - changing.length
  const dryRun = flagParam(p, 'dryRun')
  if (!dryRun && changing.length) await writePlanned(host, changing)
  const head = !rows.length ? 'Nothing to change: every value already matches.' : dryRun ? `Would change ${rows.length} setting${rows.length === 1 ? '' : 's'}:` : `Changed ${rows.length} setting${rows.length === 1 ? '' : 's'}:`
  const lines = [head, ...columns(rows.map((r) => [`  ${r.key}`, r.from, `→ ${r.to}`]))]
  return { rows, unchanged, applied: !dryRun && rows.length > 0, text: lines.join('\n') }
}

/** The registry rows for `foreman settings …`; read for everything that only looks, admin for what changes a value. */
export const SETTINGS_METHODS: Record<string, MethodDef> = {
  'settings-list': { tier: 'read', handle: async (host, params, ctx) => settingsList(host, params, ctx) },
  'settings-get': { tier: 'read', handle: async (host, params, ctx) => settingsGet(host, params, ctx) },
  'settings-keys': { tier: 'read', handle: async () => settingsKeys() },
  'settings-search': { tier: 'read', handle: async (host, params) => settingsSearch(host, params) },
  'settings-path': { tier: 'read', handle: async (host, params, ctx) => settingsPath(host, params, ctx) },
  'settings-export': { tier: 'read', handle: async (host, params, ctx) => settingsExport(host, params, ctx) },
  'settings-set': { tier: 'admin', handle: async (host, params) => settingsSet(host, params) },
  'settings-reset': { tier: 'admin', handle: async (host, params) => settingsReset(host, params) },
  'settings-import': { tier: 'admin', handle: async (host, params) => settingsImport(host, params) }
}
