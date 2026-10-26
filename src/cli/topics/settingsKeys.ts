// `foreman help settings-keys`: every settings key and every repository settings key, with what it takes and the
// title Settings shows, grouped by page and tab. Rendered from the two schemas so it can't drift from what `set` accepts.
import { describeRepoSpec, repoRegistryRowOf, repoSettingsByTab, STRUCTURED_REPO_SETTINGS, type RepoTab } from '../../shared/repoSettingsSchema'
import { describeSpec, registryRowOf, settingsByPage, type SettingsPage } from '../../shared/settingsSchema'
import { registerTopic } from '../help'
import { columns } from '../output'

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

const TAB_TITLES: Record<RepoTab, string> = {
  git: 'Git',
  scripts: 'Scripts',
  actions: 'Actions',
  repo: 'Repository',
  integrations: 'Integrations',
  cloud: 'Remote workspaces'
}

/** The text of the topic. */
export function renderSettingsKeys(): string {
  const lines: string[] = [
    'Settings keys',
    '',
    'foreman settings get <key>...        foreman settings set <key> <value>...        foreman settings reset <key>...',
    'foreman repo settings get <key>...   foreman repo settings set <key> <value>...   foreman repo settings unset <key>...',
    '',
    'Keys are <page>.<id>: the Settings page (or Repository settings tab) and the row. Booleans take on or off (also',
    'true/false, yes/no, 1/0). Lists take a,b,c, or --add / --remove, or --stdin (one item per line).',
    '',
    'Personal settings (Settings window), by page',
    ''
  ]
  for (const group of settingsByPage()) {
    lines.push(PAGE_TITLES[group.page])
    lines.push(
      columns(
        group.specs.map((spec) => {
          const title = registryRowOf(spec)?.title ?? spec.id.replace(/-/g, ' ')
          const only = spec.platform ? ` (${spec.platform === 'mac' ? 'macOS' : 'Windows'} only)` : ''
          return [`  ${spec.key}`, describeSpec(spec) + only, title]
        })
      )
    )
    lines.push('')
  }
  lines.push('Repository settings (Repository settings window; --repo <name|path>), by tab', '')
  for (const group of repoSettingsByTab()) {
    lines.push(TAB_TITLES[group.tab])
    lines.push(
      columns(
        group.specs.map((spec) => {
          const title = repoRegistryRowOf(spec)?.title ?? spec.id.replace(/-/g, ' ')
          return [`  ${spec.key}`, describeRepoSpec(spec), title]
        })
      )
    )
    lines.push('')
  }
  lines.push(
    'Settings with their own commands',
    `  repo setup, repo archive-steps, repo scripts, repo checks, repo auto-review  (${STRUCTURED_REPO_SETTINGS.join(', ')})`,
    '  env, keys, github, gitlab, cloud token                                       (variables, provider keys and tokens)',
    '',
    'foreman settings keys prints the personal table as the running app has it.'
  )
  return lines.join('\n')
}

/** Replace the placeholder help.ts registers: `foreman help settings-keys` prints the table. */
export function registerSettingsKeysTopic(): void {
  registerTopic('settings-keys', renderSettingsKeys)
}

registerSettingsKeysTopic()
