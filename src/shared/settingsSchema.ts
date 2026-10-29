// The table behind `foreman settings`: one entry per personal setting the command line can read and write,
// with its type, choices and bounds. Pure and shared (no I/O, no Electron) so the CLI server, the assistant and
// the window's search can all validate and describe a setting the same way.§6.2.
// Keys are `<page>.<id>`: the page is the Settings page the registry row sits on (settingsRegistry.ts), so it is
// derived from the registry here and never typed twice. Fields with no row there (the Devices ones, the clone
// directory) name their page themselves.
import path from 'node:path'
import { MAX_BACKGROUND_WAIT_MINUTES, MAX_RUNNING_AGENTS } from './agentSlots'
import { ARCHIVE_CLEANUP_DAYS } from './autoArchive'
import { DONE_DAYS_OPTIONS } from './board'
import { cloudSettings } from './cloud'
import { LOCALES } from './i18n'
import { BATTERY_PERCENTS } from './keepAwake'
import { OPEN_IN_APP_IDS } from './openIn'
import { SETTINGS } from './settingsRegistry'
import { SCRIPT_SHELLS, SHELL_CHOICES } from './shells'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './terminalTabs'
import type { BranchPrefixType, CloudSettings, ColorVision, HomeLayout, PaneSide, Settings, SoundSetting, TerminalPlacement, ThemeSetting, WindowLayout } from './types'

export type SettingsPage = 'general' | 'account' | 'appearance' | 'models' | 'agents' | 'git' | 'environment' | 'experimental' | 'advanced' | 'data' | 'devices' | 'cloud' | 'accessibility'

/** The pages in the order the Settings window (and `settings list`) shows them; Devices sits inside Data & devices. */
export const SETTINGS_PAGES: readonly SettingsPage[] = ['general', 'account', 'appearance', 'accessibility', 'models', 'agents', 'git', 'environment', 'experimental', 'advanced', 'data', 'devices', 'cloud']

export type SettingType = 'boolean' | 'enum' | 'integer' | 'number' | 'string' | 'path' | 'list' | 'map'

/** Which Api call writes the value: updateSettings, or the service that owns a side effect. */
export type SettingApply = 'settings' | 'mobile' | 'mobileLan' | 'handOffs' | 'envFiles'

export type SettingField = keyof Settings | `cloud.${keyof CloudSettings}`

export interface SettingSpec {
  // The full CLI key, `appearance.theme`.
  key: string
  // The part after the page, `theme`.
  id: string
  page: SettingsPage
  // The settingsRegistry.ts row it belongs to: title, description and the Windows/macOS flag come from there.
  registryId?: string
  field: SettingField
  type: SettingType
  // Enum: the spellings the command line takes.
  values?: readonly string[]
  // Enum: the CLI spelling → the stored value, where they differ ('login' → 'cli', 'auto' → '').
  labels?: Readonly<Record<string, string>>
  // Numbers: words accepted in place of a number ('content' for terminal-font-size).
  words?: readonly string[]
  // Numbers: bounds and the step from `min`, or the only values that are allowed.
  min?: number
  max?: number
  step?: number
  options?: readonly number[]
  apply: SettingApply
  // 'path' and 'command' values are flagged in list output; nothing in this table is a secret.
  sensitivity?: 'plain' | 'path' | 'command'
  // The one line printed after a change, for the settings that widen what an agent may do or delete something.
  note?: string
  platform?: 'mac' | 'windows'
}

// ---- choices that have no runtime constant elsewhere ----
// Each is a record keyed by the TypeScript union, so adding a member to the union without adding it here fails the typecheck.

function enumOf<T extends string>(all: Record<T, true>): readonly T[] {
  return Object.keys(all) as T[]
}

const THEMES = enumOf<ThemeSetting>({ system: true, light: true, dark: true })
const SOUNDS = enumOf<SoundSetting>({ chime: true, bell: true, pop: true, marimba: true, none: true })
const REDUCE_MOTIONS = enumOf<Settings['reduceMotion']>({ auto: true, on: true, off: true })
const ANNOUNCE_POLICIES = enumOf<Settings['announce']>({ 'needs-me': true, 'my-chat': true, all: true })
const SPEECH_OUTPUTS = enumOf<Settings['speechOutput']>({ off: true, on: true })
const STT_PROVIDERS = enumOf<Settings['sttProvider']>({ local: true, openai: true })
const PUSH_TO_TALKS = enumOf<Settings['pushToTalk']>({ hold: true, toggle: true })
const COLOR_VISIONS = enumOf<ColorVision>({ default: true, 'protanopia-deuteranopia': true, tritanopia: true })
const WINDOW_LAYOUTS = enumOf<WindowLayout>({ panes: true, tiles: true, editor: true })
const PANE_SIDES = enumOf<PaneSide>({ left: true, right: true })
const TERMINAL_PLACEMENTS = enumOf<TerminalPlacement>({ 'panel-bottom': true, 'panel-top': true, 'below-chat': true })
const HOME_LAYOUTS = enumOf<HomeLayout>({ list: true, board: true })
const BRANCH_PREFIX_TYPES = enumOf<BranchPrefixType>({ github: true, custom: true, none: true })
const SEND_KEYS = enumOf<Settings['messageSendKey']>({ enter: true, 'mod-enter': true })
const FOLLOW_UP_MODES = enumOf<Settings['followUpMode']>({ queue: true, steer: true })
const GITHUB_AUTHS = enumOf<Settings['githubAuth']>({ cli: true, token: true })
const CODEX_APPROVALS = enumOf<Settings['codexApprovals']>({ sandboxed: true, always: true })
const PR_TARGETS = enumOf<Settings['openPrIn']>({ github: true, graphite: true })
const UPDATE_INTERVALS = enumOf<Settings['updateInterval']>({ hourly: true, 'every-4-hours': true, daily: true })
const UPDATE_MODES = enumOf<Settings['updateMode']>({ notify: true, download: true, quit: true })
const UPDATE_CHANNELS = enumOf<Settings['updateChannel']>({ stable: true, beta: true })
const CLOUD_CLAUDE_AUTHS = enumOf<CloudSettings['claudeAuth']>({ 'setup-token': true, 'api-key': true })
const LANGUAGES: readonly string[] = ['system', ...LOCALES.map((l) => l.code)]

// Claude Code and Codex store 'cli' and 'apiKey'; the command line says what the window says.
const AGENT_AUTH_VALUES = ['login', 'api-key'] as const
const AGENT_AUTH_LABELS = { login: 'cli', 'api-key': 'apiKey' } as const

// ---- the table ----

interface Draft {
  registryId?: string
  // Only for a field with no registry row.
  page?: SettingsPage
  field: SettingField
  type: SettingType
  values?: readonly string[]
  labels?: Readonly<Record<string, string>>
  words?: readonly string[]
  min?: number
  max?: number
  step?: number
  options?: readonly number[]
  apply?: SettingApply
  sensitivity?: SettingSpec['sensitivity']
  note?: string
}

/** The Settings page a registry row sits on; a row the CLI has no key for (Usage, Integrations, repository rows) is a mistake here. */
function pageOfRow(registryId: string): SettingsPage {
  const row = SETTINGS.find((e) => e.id === registryId)
  if (!row) throw new Error(`settingsSchema: no settingsRegistry row '${registryId}'`)
  const section = row.page.section
  if (section === 'integrations' || section === 'usage' || section === 'repo') throw new Error(`settingsSchema: row '${registryId}' is not on a personal settings page`)
  return section
}

function platformOfRow(registryId: string | undefined): SettingSpec['platform'] {
  const row = registryId ? SETTINGS.find((e) => e.id === registryId) : undefined
  return row?.windows ? 'windows' : row?.mac ? 'mac' : undefined
}

function def(id: string, draft: Draft): SettingSpec {
  const fromRegistry = draft.registryId ? pageOfRow(draft.registryId) : undefined
  const page = fromRegistry ?? draft.page
  if (!page) throw new Error(`settingsSchema: '${id}' needs a registry row or a page`)
  if (fromRegistry && draft.page && draft.page !== fromRegistry) throw new Error(`settingsSchema: '${id}' names page '${draft.page}' but its row is on '${fromRegistry}'`)
  const { page: _page, apply, ...rest } = draft
  const spec: SettingSpec = { key: `${page}.${id}`, id, page, ...rest, apply: apply ?? 'settings' }
  const platform = platformOfRow(draft.registryId)
  if (platform) spec.platform = platform
  return spec
}

const flag = (id: string, registryId: string, field: SettingField, extra: Partial<Draft> = {}) => def(id, { registryId, field, type: 'boolean', ...extra })
const choice = (id: string, registryId: string, field: SettingField, values: readonly string[], extra: Partial<Draft> = {}) => def(id, { registryId, field, type: 'enum', values, ...extra })

export const SETTINGS_SCHEMA: readonly SettingSpec[] = [
  // General
  choice('language', 'language', 'language', LANGUAGES),
  choice('message-send-key', 'message-send-key', 'messageSendKey', SEND_KEYS),
  choice('follow-up-mode', 'follow-up-mode', 'followUpMode', FOLLOW_UP_MODES),
  flag('notifications', 'notifications', 'notifications'),
  choice('completion-sound', 'completion-sound', 'sound', SOUNDS),
  flag('dock-badge', 'dock-badge', 'dockBadge'),
  flag('tray-icon', 'tray-icon', 'trayIcon'),
  flag('auto-convert-long-text', 'auto-convert-long-text', 'autoConvertLongText'),
  flag('not-absolutely-right', 'not-absolutely-right', 'notAbsolutelyRight'),
  flag('assistant', 'assistant', 'assistantEnabled'),
  flag('welcome-tour-seen', 'welcome-tour', 'tourSeen'),
  flag('first-run-seen', 'welcome-tour', 'onboardingSeen'),
  flag('always-show-context-usage', 'always-show-context-usage', 'alwaysShowContextUsage'),
  flag('keep-awake', 'keep-awake', 'keepAwake'),
  flag('keep-awake-battery-cutoff', 'keep-awake', 'keepAwakeBatteryCutoff'),
  def('keep-awake-battery-percent', { registryId: 'keep-awake', field: 'keepAwakeBatteryPercent', type: 'integer', options: BATTERY_PERCENTS }),
  flag('keep-awake-thermal-cutoff', 'keep-awake', 'keepAwakeThermalCutoff'),
  flag('keep-awake-only-on-power', 'keep-awake', 'keepAwakeOnlyOnPower'),
  flag('check-for-updates', 'check-for-updates', 'checkForUpdates'),
  choice('update-interval', 'check-for-updates', 'updateInterval', UPDATE_INTERVALS),
  choice('update-mode', 'check-for-updates', 'updateMode', UPDATE_MODES),
  choice('update-channel', 'check-for-updates', 'updateChannel', UPDATE_CHANNELS),
  flag('expand-tool-calls', 'expand-tool-calls', 'expandToolCalls'),
  // Stored '' is Automatic; the command line says `auto`.
  choice('open-in-default', 'open-in-apps', 'openInDefault', ['auto', 'custom', ...OPEN_IN_APP_IDS], { labels: { auto: '' } }),
  def('open-in-custom-command', { registryId: 'open-in-apps', field: 'editorCommand', type: 'string', sensitivity: 'command' }),
  def('open-in-path', { registryId: 'open-in-apps', field: 'openInPaths', type: 'map', sensitivity: 'path' }),
  choice('terminal-shell', 'terminal-shell', 'terminalShell', SHELL_CHOICES),
  def('terminal-shell-custom', { registryId: 'terminal-shell', field: 'terminalShellCustom', type: 'string', sensitivity: 'command' }),

  // Account
  choice('github-auth', 'github', 'githubAuth', GITHUB_AUTHS),
  flag('privacy-mode', 'privacy-mode', 'privacyMode', { note: 'Privacy mode stops what sends data to an AI provider outside a chat (generated titles and branch names), and stops the assistant.' }),
  flag('claude-tool-approvals', 'claude-tool-approvals', 'requireToolApprovals', { note: 'Whether Claude Code has to ask before each tool call changes from its next turn on.' }),
  choice('codex-tool-approvals', 'codex-tool-approvals', 'codexApprovals', CODEX_APPROVALS, {
    note: 'Applies from the next Codex turn. Sandboxed keeps Codex inside its sandbox, where git data is read-only (no commits or pull requests).'
  }),

  // Appearance
  choice('theme', 'theme', 'theme', THEMES),
  def('zoom', { registryId: 'zoom', field: 'zoom', type: 'number', min: ZOOM_MIN, max: ZOOM_MAX, step: ZOOM_STEP }),
  flag('colored-sidebar-diffs', 'colored-sidebar-diffs', 'coloredSidebarDiffs'),
  choice('color-vision', 'color-vision', 'colorVision', COLOR_VISIONS),
  def('mono-font', { registryId: 'mono-font', field: 'monoFont', type: 'string' }),
  flag('code-ligatures', 'code-ligatures', 'codeLigatures'),
  def('terminal-font', { registryId: 'terminal-font', field: 'terminalFont', type: 'string' }),
  // The slider's range in Settings → Appearance; `content` follows the content text size (Settings → Accessibility).
  def('terminal-font-size', { registryId: 'terminal-font', field: 'terminalFontSize', type: 'integer', min: 10, max: 20, words: ['content'] }),
  choice('window-layout', 'window-layout', 'windowLayout', WINDOW_LAYOUTS),
  choice('sidebar-side', 'sidebar-side', 'sidebarSide', PANE_SIDES),
  choice('side-panel-side', 'side-panel-side', 'sidePanelSide', PANE_SIDES),
  choice('terminal-placement', 'terminal-placement', 'terminalPlacement', TERMINAL_PLACEMENTS),
  flag('home-board', 'home-board', 'homeBoard'),
  choice('home-layout', 'home-layout', 'homeLayout', HOME_LAYOUTS),
  def('home-done-days', { registryId: 'home-done-days', field: 'homeDoneDays', type: 'integer', options: DONE_DAYS_OPTIONS }),

  // Accessibility
  def('content-font-size', { registryId: 'content-font-size', field: 'contentFontSize', type: 'integer', min: 12, max: 24 }),
  choice('reduce-motion', 'reduce-motion', 'reduceMotion', REDUCE_MOTIONS),
  choice('announce', 'announce', 'announce', ANNOUNCE_POLICIES),
  flag('announce-summary', 'announce-summary', 'announceSummary'),
  flag('earcons', 'earcons', 'earcons'),
  choice('speech-output', 'speech-output', 'speechOutput', SPEECH_OUTPUTS),
  def('speech-voice', { registryId: 'speech-voice', field: 'speechVoice', type: 'string' }),
  def('speech-rate', { registryId: 'speech-rate', field: 'speechRate', type: 'number', min: 0.5, max: 2, step: 0.1 }),
  def('speech-volume', { registryId: 'speech-volume', field: 'speechVolume', type: 'number', min: 0, max: 1, step: 0.1 }),
  choice('stt-provider', 'stt-provider', 'sttProvider', STT_PROVIDERS),
  def('stt-language', { registryId: 'stt-language', field: 'sttLanguage', type: 'string' }),
  choice('push-to-talk', 'push-to-talk', 'pushToTalk', PUSH_TO_TALKS),
  // auto follows the OS's screen-reader flag (Electron's accessibilitySupportEnabled).
  choice('terminal-screen-reader', 'terminal-screen-reader', 'terminalScreenReader', ['auto', 'on', 'off']),

  // Models
  // The choices come from the catalog's output styles, which only the app knows; the server checks them.
  def('claude-output-style', { registryId: 'claude-output-style', field: 'claudeOutputStyle', type: 'string' }),
  flag('default-plan-mode', 'default-plan-mode', 'defaultPlanMode'),

  // Agents
  def('claude-auth', { registryId: 'agent-claude', field: 'claudeAuth', type: 'enum', values: AGENT_AUTH_VALUES, labels: AGENT_AUTH_LABELS }),
  def('claude-path', { registryId: 'agent-claude', field: 'claudeExecutablePath', type: 'path', sensitivity: 'path' }),
  def('codex-auth', { registryId: 'agent-codex', field: 'codexAuth', type: 'enum', values: AGENT_AUTH_VALUES, labels: AGENT_AUTH_LABELS }),
  def('codex-path', { registryId: 'agent-codex', field: 'codexExecutablePath', type: 'path', sensitivity: 'path' }),
  def('opencode-path', { registryId: 'agent-opencode', field: 'opencodeExecutablePath', type: 'path', sensitivity: 'path' }),
  def('opencode-models', { registryId: 'agent-opencode', field: 'opencodeModels', type: 'list' }),
  flag('chrome-mode', 'chrome-mode', 'chromeMode', { note: 'Claude Code can now drive Chrome through its extension (claude --chrome) in new turns.' }),

  // Git
  def('branch-prefix-type', { registryId: 'branch-prefix', field: 'branchPrefixType', type: 'enum', values: BRANCH_PREFIX_TYPES }),
  def('branch-prefix', { registryId: 'branch-prefix', field: 'branchPrefix', type: 'string' }),
  flag('auto-rename-branches', 'auto-rename-branches', 'autoRenameBranches'),
  flag('rename-workspace-with-branch', 'rename-workspace-with-branch', 'renameWorkspaceWithBranch'),
  flag('delete-branch-on-archive', 'delete-branch-on-archive', 'deleteBranchOnArchive'),
  flag('archive-on-merge', 'archive-on-merge', 'archiveOnMerge'),
  def('archive-cleanup-days', {
    registryId: 'archive-cleanup-days',
    field: 'archiveCleanupDays',
    type: 'integer',
    options: ARCHIVE_CLEANUP_DAYS,
    note: 'Workspaces Foreman archived on its own are deleted this many days later, chats and local branch included (0 never). Ones with unpushed commits are kept.'
  }),
  flag('automerge', 'automerge', 'automerge'),
  flag('optional-checks-block', 'optional-checks-block', 'optionalChecksBlock'),
  flag('push-auto-setup-remote', 'push-auto-setup-remote', 'pushAutoSetupRemote'),
  flag('stacked-prs', 'stacked-prs', 'stackedPrs'),
  choice('open-pr-in', 'open-pr-in', 'openPrIn', PR_TARGETS),

  // Environment
  def('env-files', { registryId: 'env-files', field: 'envFiles', type: 'list', apply: 'envFiles', sensitivity: 'path' }),
  // No registry row: it is the folder the last "Open GitHub project" cloned into.
  def('clone-directory', { page: 'environment', field: 'cloneDirectory', type: 'path', sensitivity: 'path' }),

  // Experimental
  flag('auto-permission-mode', 'auto-permission-mode', 'autoPermissionMode', { note: 'Agents now decide which actions need approval, from their next turn on.' }),
  flag('auto-run-after-setup', 'auto-run-after-setup', 'autoRunAfterSetup'),
  flag('fork-to-new-tab', 'fork-to-new-tab', 'forkToNewTab'),
  flag('show-resource-usage', 'show-resource-usage', 'showResourceUsage'),

  // Advanced (the Workspaces folder and the Windows script shell live here, not under Git)
  def('workspaces-folder', { registryId: 'workspaces-folder', field: 'workspacesRoot', type: 'path', sensitivity: 'path' }),
  choice('script-shell', 'script-shell', 'scriptShell', SCRIPT_SHELLS),
  // The Advanced page's own bounds.
  def('terminal-scrollback-mb', { registryId: 'terminal-scrollback', field: 'terminalScrollbackMb', type: 'integer', min: 1, max: 1000 }),
  flag('terminal-copy-on-select', 'terminal-copy-on-select', 'terminalCopyOnSelect'),
  flag('terminal-restore', 'terminal-restore', 'restoreTerminals', { note: 'Turning it off deletes the terminal output saved so far; tabs no longer come back after a restart.' }),
  flag('keep-agents-running', 'keep-agents-running', 'keepAgentsRunning'),
  // 0 is no limit, and never stop waiting.
  def('max-running-agents', { registryId: 'max-running-agents', field: 'maxRunningAgents', type: 'integer', min: 0, max: MAX_RUNNING_AGENTS }),
  def('background-wait-minutes', { registryId: 'background-wait', field: 'backgroundWaitMinutes', type: 'integer', min: 0, max: MAX_BACKGROUND_WAIT_MINUTES }),

  // Data
  flag('keep-cleared-history', 'keep-cleared-history', 'keepClearedHistory', { note: 'Turning it off scrubs the history that /clear and rewind had kept; turning it on keeps it from now on.' }),
  flag('daily-backup', 'daily-backup', 'dailyBackup'),
  def('backup-folder', { registryId: 'backup-folder', field: 'backupFolder', type: 'path', sensitivity: 'path' }),

  // Devices: no registry rows (the window sets them from the pairing dialogs), kept so "every setting" holds.
  def('accept-hand-offs', { page: 'devices', field: 'acceptHandOffs', type: 'boolean', apply: 'handOffs' }),
  def('port', { page: 'devices', field: 'devicePort', type: 'integer', min: 1024, max: 65_535, apply: 'handOffs' }),
  def('mobile', { page: 'devices', field: 'mobileEnabled', type: 'boolean', apply: 'mobile' }),
  def('mobile-url', { page: 'devices', field: 'mobileUrl', type: 'string', apply: 'mobile' }),
  def('mobile-lan', { page: 'devices', field: 'mobileLanEnabled', type: 'boolean', apply: 'mobileLan' }),
  def('mobile-lan-address', { page: 'devices', field: 'mobileLanAddress', type: 'string', apply: 'mobileLan' }),

  // Remote workspaces: the nested `cloud` object, written field by field (patchCloudSettings checks each).
  flag('workspaces', 'cloud-workspaces', 'cloud.enabled'),
  choice('claude-auth', 'cloud-claude-auth', 'cloud.claudeAuth', CLOUD_CLAUDE_AUTHS),
  flag('wake-on-open', 'cloud-wake-on-open', 'cloud.wakeOnOpen'),
  flag('stop-orphans', 'cloud-stop-orphans', 'cloud.stopOrphansOnLaunch'),
  flag('delete-snapshots', 'cloud-delete-snapshots', 'cloud.deleteSnapshotsOnForget'),
  def('max-running', { registryId: 'cloud-max-running', field: 'cloud.maxRunning', type: 'integer', min: 1, max: 10_000 })
]

/** Settings with their own commands (`foreman loadouts`, `models`, `agents`, `templates`, `commands`, `keys`, `gitlab`): validated field by field there, never set as JSON. `onboarding` (the Get started checklist's milestones and whether it is hidden) has none: the app records it as the person goes, and it is not a preference to script. */
export const STRUCTURED_SETTINGS: readonly (keyof Settings)[] = ['loadouts', 'reviewModel', 'promptTemplates', 'savedCommands', 'hiddenModels', 'agentPrefs', 'providerKeyAgents', 'gitlabHosts', 'onboarding', 'views']

/** What is deliberately not a CLI setting, with the reason (PLAN §13 item 21). None of these is a `Settings` field: they are the window's own state or system facts. */
export const NOT_A_SETTING: Record<string, string> = {
  paneSizes: 'Lives in the window’s localStorage; reset from Settings → Appearance.',
  panelAndTabLayout: 'The window’s panel and tab layout lives in the window’s localStorage.',
  fullDiskAccess: 'A read-only system fact (shown by `foreman doctor`), not a stored setting.',
  openInApps: 'Which apps Open in found on this computer is a read-only system fact (shown by `foreman doctor`).'
}

// ---- lookups ----

const BY_KEY = new Map(SETTINGS_SCHEMA.map((spec) => [spec.key, spec]))

function kebab(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** The keys that look like what was typed: the same id on another page, a field name, or a part of a key. */
function closeKeys(typed: string): string[] {
  const wanted = kebab(typed.trim())
  const dot = wanted.indexOf('.')
  const id = dot >= 0 ? wanted.slice(dot + 1) : wanted
  const field = (s: SettingSpec) => kebab(s.field.replace(/^cloud\./, ''))
  const same = SETTINGS_SCHEMA.filter((s) => s.id === id || field(s) === id)
  const loose = SETTINGS_SCHEMA.filter((s) => !same.includes(s) && id.length >= 3 && (s.key.includes(id) || id.includes(s.id)))
  return [...same, ...loose].slice(0, 6).map((s) => s.key)
}

/** The setting with exactly this key (`appearance.theme`). A bare `theme` is not accepted (no aliases); the error says which key was meant. */
export function findSetting(key: string): { spec: SettingSpec } | { error: string } {
  const spec = BY_KEY.get(key.trim().toLowerCase())
  if (spec) return { spec }
  const close = closeKeys(key)
  if (close.length) return { error: `No setting called '${key}'. Did you mean ${close.map((k) => `'${k}'`).join(', ')}?` }
  return { error: `No setting called '${key}'. List the keys with: foreman settings keys` }
}

/** The specs grouped by Settings page, in the window's order; pages with no setting are left out. */
export function settingsByPage(): { page: SettingsPage; specs: SettingSpec[] }[] {
  return SETTINGS_PAGES.map((page) => ({ page, specs: SETTINGS_SCHEMA.filter((s) => s.page === page) })).filter((g) => g.specs.length > 0)
}

/** The settingsRegistry.ts row a spec points at (title, description), when it has one. */
export function registryRowOf(spec: SettingSpec) {
  return spec.registryId ? SETTINGS.find((e) => e.id === spec.registryId) : undefined
}

// ---- reading ----

function cloudKey(spec: SettingSpec): keyof CloudSettings | undefined {
  return spec.field.startsWith('cloud.') ? (spec.field.slice('cloud.'.length) as keyof CloudSettings) : undefined
}

/** The current value of a setting: cloud.* come with the defaults filled in, as the window shows them. */
export function readSettingValue(spec: SettingSpec, settings: Settings): unknown {
  const nested = cloudKey(spec)
  return nested ? cloudSettings(settings)[nested] : settings[spec.field as keyof Settings]
}

/**
 * The value `settings reset` puts back. cloud.* defaults come from cloudSettings (the Claude sign-in default follows
 * `claudeAuth`), everything else from `defaults`, which callers pass from the main process's defaultSettings().
 */
export function settingDefault(spec: SettingSpec, settings: Settings, defaults: Settings): unknown {
  const nested = cloudKey(spec)
  return nested ? cloudSettings({ claudeAuth: settings.claudeAuth, cloud: undefined })[nested] : defaults[spec.field as keyof Settings]
}

/**
 * The patch that writes one value: `{ cloud: { [key]: value } }` for cloud.* (updateSettings merges and checks it
 * through patchCloudSettings, so the partial object is fine there), `{ [field]: value }` otherwise.
 * A map setting merges into the current map: pass `current`, and an empty path removes the entry.
 */
export function settingPatch(spec: SettingSpec, value: unknown, current?: Settings): Partial<Settings> {
  const nested = cloudKey(spec)
  if (nested) return { cloud: { [nested]: value } as unknown as CloudSettings }
  if (spec.type === 'map') {
    const next: Record<string, string> = { ...(current?.[spec.field as keyof Settings] as Record<string, string> | undefined) }
    for (const [name, text] of Object.entries(value as Record<string, string>)) {
      if (text === '') delete next[name]
      else next[name] = text
    }
    return { [spec.field]: next } as Partial<Settings>
  }
  return { [spec.field]: value } as Partial<Settings>
}

// ---- text to value ----

const TRUE_WORDS = ['on', 'true', 'yes', '1']
const FALSE_WORDS = ['off', 'false', 'no', '0']

/** The stored value for a CLI spelling (or for the stored value itself), case-insensitively; undefined when it is neither. */
export function enumStored(spec: Pick<SettingSpec, 'values' | 'labels'>, raw: string): string | undefined {
  const wanted = raw.trim().toLowerCase()
  const spelling = spec.values?.find((v) => v.toLowerCase() === wanted)
  if (spelling !== undefined) return spec.labels?.[spelling] ?? spelling
  // The stored spelling ('apiKey') is accepted too; an empty one can't be typed, so `auto` is its only spelling.
  return Object.values(spec.labels ?? {}).find((v) => v !== '' && v.toLowerCase() === wanted)
}

/** The CLI spelling of a stored enum value ('cli' → 'login', '' → 'auto'). */
export function enumSpelling(spec: Pick<SettingSpec, 'values' | 'labels'>, stored: unknown): string {
  const hit = Object.entries(spec.labels ?? {}).find(([, v]) => v === stored)
  return hit ? hit[0] : String(stored)
}

function numberProblem(spec: SettingSpec, value: number): string | undefined {
  if (spec.options && !spec.options.includes(value)) return `${spec.key} must be one of ${spec.options.join(', ')}.`
  const range = spec.min !== undefined && spec.max !== undefined ? ` (between ${spec.min} and ${spec.max})` : ''
  if (spec.min !== undefined && value < spec.min) return `${spec.key} must be at least ${spec.min}${range}.`
  if (spec.max !== undefined && value > spec.max) return `${spec.key} must be at most ${spec.max}${range}.`
  if (spec.step !== undefined) {
    const from = spec.min ?? 0
    const steps = (value - from) / spec.step
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      const near = Math.round((Math.round(steps) * spec.step + from) * 1e6) / 1e6
      return `${spec.key} goes in steps of ${spec.step} (${spec.min ?? 0}, ${Math.round((from + spec.step) * 1e6) / 1e6}, …); the nearest is ${near}.`
    }
  }
  return undefined
}

function homeOf(): string | undefined {
  return typeof process === 'undefined' ? undefined : (process.env.HOME ?? process.env.USERPROFILE)
}

/** A path as typed: '' stays '' (automatic); `~` is the home folder; a relative path is relative to the caller's folder. */
export function resolveTypedPath(raw: string, cwd?: string, home: string | undefined = homeOf()): string {
  const text = raw.trim()
  if (text === '') return ''
  if (home && (text === '~' || text.startsWith('~/') || text.startsWith('~\\'))) return path.resolve(home, text.slice(2))
  return cwd ? path.resolve(cwd, text) : path.resolve(text)
}

function splitList(raw: string | readonly string[]): string[] {
  const parts = typeof raw === 'string' ? raw.split(',') : raw
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Text from the command line as the value to store, or the reason it can't be. Lists take `a,b,c` or an array;
 * a map takes `app=path` (an empty path clears that app's entry). `home` is for tests; it defaults to the user's.
 */
export function coerceSettingValue(spec: SettingSpec, raw: string | readonly string[], cwd?: string, home?: string): { value: unknown } | { error: string } {
  if (spec.type === 'list') return { value: splitList(raw) }
  const text = typeof raw === 'string' ? raw : raw.join(',')
  switch (spec.type) {
    case 'boolean': {
      const word = text.trim().toLowerCase()
      if (TRUE_WORDS.includes(word)) return { value: true }
      if (FALSE_WORDS.includes(word)) return { value: false }
      return { error: `${spec.key} is on or off (also true/false, yes/no, 1/0), not '${text}'.` }
    }
    case 'enum': {
      const stored = enumStored(spec, text)
      if (stored !== undefined) return { value: stored }
      return { error: `'${text}' is not a choice for ${spec.key}. Choose one of: ${spec.values?.join(', ')}.` }
    }
    case 'integer':
    case 'number': {
      const word = text.trim()
      const keyword = spec.words?.find((w) => w === word.toLowerCase())
      if (keyword !== undefined) return { value: keyword }
      const pattern = spec.type === 'integer' ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/
      if (!pattern.test(word)) return { error: `${spec.key} is ${spec.type === 'integer' ? 'a whole number' : 'a number'}, not '${text}'.` }
      const value = Math.round(Number(word) * 1e6) / 1e6
      const problem = numberProblem(spec, value)
      return problem ? { error: problem } : { value }
    }
    case 'path':
      return { value: resolveTypedPath(text, cwd, home) }
    case 'map': {
      const at = text.indexOf('=')
      const app = (at < 0 ? text : text.slice(0, at)).trim().toLowerCase()
      if (at < 0 || !app) return { error: `${spec.key} is written app=path, for example vscode=C:\\Tools\\code.cmd (an empty path clears it).` }
      if (!(OPEN_IN_APP_IDS as readonly string[]).includes(app)) return { error: `'${app}' is not an app Foreman opens. Choose one of: ${OPEN_IN_APP_IDS.join(', ')}.` }
      return { value: { [app]: resolveTypedPath(text.slice(at + 1), cwd, home) } }
    }
    case 'string': {
      if (/[\r\n]/.test(text)) return { error: `${spec.key} is one line of text.` }
      return { value: text.trim() }
    }
  }
}

// ---- value to text ----

/** A value as the command line prints it: `on`/`off`, the CLI spelling of an enum, `(automatic)` for an empty path. */
export function displayValue(spec: SettingSpec, value: unknown): string {
  switch (spec.type) {
    case 'boolean':
      return value ? 'on' : 'off'
    case 'enum':
      return enumSpelling(spec, value)
    case 'path':
      return value === '' || value === undefined ? '(automatic)' : String(value)
    case 'string':
      return value === '' || value === undefined ? '(empty)' : String(value)
    case 'list': {
      const items = Array.isArray(value) ? (value as unknown[]) : []
      return items.length ? items.join(', ') : '(none)'
    }
    case 'map': {
      const entries = Object.entries((value ?? {}) as Record<string, string>)
      return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'
    }
    default:
      return String(value)
  }
}

/** What a key takes, for `settings keys` and help: its type and the choices or bounds. */
export function describeSpec(spec: SettingSpec): string {
  switch (spec.type) {
    case 'boolean':
      return 'on | off'
    case 'enum':
      return spec.values?.join(' | ') ?? 'choice'
    case 'integer':
    case 'number': {
      const kind = spec.type === 'integer' ? 'integer' : 'number'
      const words = spec.words?.length ? ` | ${spec.words.join(' | ')}` : ''
      if (spec.options) return `${kind}, one of ${spec.options.join(', ')}${words}`
      const range = spec.min !== undefined && spec.max !== undefined ? ` ${spec.min}-${spec.max}` : spec.min !== undefined ? ` from ${spec.min}` : spec.max !== undefined ? ` up to ${spec.max}` : ''
      return `${kind}${range}${spec.step !== undefined ? ` in steps of ${spec.step}` : ''}${words}`
    }
    case 'path':
      return 'path (empty: automatic)'
    case 'list':
      return 'list (a,b,c)'
    case 'map':
      return 'app=path (empty path clears)'
    default:
      return spec.sensitivity === 'command' ? 'command line' : 'text'
  }
}
