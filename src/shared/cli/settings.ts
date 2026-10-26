// Parameters and results of the `foreman settings` methods. Each result has a `text`
// the command prints unless --json is given; the rows are the contract for scripts.
import type { SettingType, SettingsPage } from '../settingsSchema'

export interface SettingRow {
  key: string
  page: SettingsPage
  type: SettingType
  // As the command line prints it: on/off, the CLI spelling of an enum, (automatic) for an empty path.
  value: string
  default: string
  changed: boolean
  // 'mac' or 'windows' for a setting that only does something there.
  platform?: 'mac' | 'windows'
  // Set when the setting has no effect on this computer.
  platformNote?: string
}

export interface SettingsListParams {
  page?: string
  changed?: boolean
}

export interface SettingsListResult {
  rows: SettingRow[]
  // A request from inside an agent turn only sees the settings the assistant may read; how many were left out.
  omitted?: number
  text: string
}

export interface SettingsGetParams {
  keys: string[]
}

export interface SettingGetRow extends SettingRow {
  // "Settings › Appearance › Theme" (or the page, for a key with no row in Settings).
  path: string
  // What it takes: `on | off`, the choices, the bounds.
  takes: string
}

export interface SettingsGetResult {
  rows: SettingGetRow[]
  // Keys left out because a request from inside an agent turn may not read them.
  omitted: string[]
  text: string
}

export interface SettingsSetParams {
  pairs: [string, string][]
  // The caller's folder: relative paths are resolved against it.
  cwd: string
}

export interface SettingChange {
  key: string
  value: string
  was: string
  // The one line a setting prints after a change (what it now allows, what it deletes).
  note?: string
  platformNote?: string
}

export interface SettingsSetResult {
  changes: SettingChange[]
  text: string
}

export interface SettingsResetParams {
  keys?: string[]
  all?: boolean
}

export interface SettingsResetResult {
  changes: SettingChange[]
  // Keys that already had their default.
  unchanged: string[]
  text: string
}

export interface SettingKeyRow {
  key: string
  type: SettingType
  // The choices, bounds or format.
  takes: string
  page: SettingsPage
  title: string
  description: string
  platform?: 'mac' | 'windows'
  note?: string
}

export interface SettingsKeysResult {
  keys: SettingKeyRow[]
  text: string
}

export interface SettingsSearchParams {
  query: string
}

export interface SettingSearchRow {
  id: string
  title: string
  path: string
  description: string
  // The command-line keys of the row: `settings` for personal settings, `repo settings` for repository ones. Empty: none.
  cli: { scope: 'settings' | 'repo settings'; key: string }[]
}

export interface SettingsSearchResult {
  rows: SettingSearchRow[]
  text: string
}

export interface SettingsPathParams {
  key: string
  open?: boolean
}

export interface SettingsPathResult {
  key: string
  path: string
  // Asked to reveal the row in the window.
  opened: boolean
  text: string
}

export type SettingExportValue = string | number | boolean | string[] | Record<string, string>

export interface SettingsExportResult {
  // Every plain setting by key: booleans, numbers, text, the command line's spelling of a choice, lists and maps.
  settings: Record<string, SettingExportValue>
  text: string
}

export interface SettingsImportParams {
  values: Record<string, SettingExportValue>
  cwd?: string
  dryRun?: boolean
}

export interface SettingsImportRow {
  key: string
  from: string
  to: string
}

export interface SettingsImportResult {
  rows: SettingsImportRow[]
  unchanged: number
  applied: boolean
  text: string
}
