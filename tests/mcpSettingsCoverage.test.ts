import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/store'
import { defaultRepoSettings } from '../src/main/repoSettings'
import { cloudSettings } from '../src/shared/cloud'
import { SETTINGS_SCHEMA, STRUCTURED_SETTINGS, NOT_A_SETTING } from '../src/shared/settingsSchema'
import { REPO_SETTINGS_SCHEMA, STRUCTURED_REPO_SETTINGS } from '../src/shared/repoSettingsSchema'
import { FOREMAN_TOOLS } from '../src/shared/foremanTools'
import { DELEGATION_TOOLS } from '../src/shared/foremanDelegation'
import { CLI_DEDICATED_TOOLS, FOREMAN_CLI_TOOL, MCP_CLI_READ_COMMANDS } from '../src/shared/foremanCli'
import { READABLE_SETTINGS } from '../src/shared/assistant'
import { COMMANDS, COMMON_OPTIONS, commandName } from '../src/shared/cliCommands'

// This is a review gate, not a claim that the current MCP implements settings.
// Keep the reviewed contract in source control: a new/changed CLI setting must
// trigger an MCP decision even while settings adapters are not implemented.
// See docs/mcp-settings-coverage.md before updating the snapshots.
const unavailable = 'No dedicated settings read/write tool. CLI fallback does not count as dedicated coverage.'

function contract(value: unknown): string {
  // Only built-in defaults are inspected, never the user's saved settings.
  // Normalize home-relative defaults so Windows and Unix review the same data.
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string' && item.startsWith(os.homedir())) return `~${item.slice(os.homedir().length).replaceAll('\\', '/')}`
    return item
  })
}

describe('MCP settings coverage review', () => {
  it('accounts for every personal CLI setting and its complete schema', () => {
    expect(SETTINGS_SCHEMA.map((schema) => contract({ schema, dedicated: unavailable,
      workspaceFallback: { metadata: true, read: (READABLE_SETTINGS as readonly string[]).includes(schema.field), write: false },
      assistantFallback: 'Existing run_foreman, subject to command policy and user confirmation.'
    })).sort()).toMatchSnapshot()
  })

  it('accounts for every repository CLI setting and its complete schema', () => {
    expect(REPO_SETTINGS_SCHEMA.map((schema) => contract({ schema, dedicated: unavailable,
      workspaceFallback: { read: false, write: false },
      assistantFallback: 'Existing run_foreman, subject to command policy and user confirmation.'
    })).sort()).toMatchSnapshot()
  })

  it('requires review when defaults, structured settings or exclusions change', () => {
    const settings = defaultSettings()
    expect({
      personalDefaults: Object.entries({ ...settings, cloud: cloudSettings(settings) }).sort(([a], [b]) => a.localeCompare(b)).map(([field, value]) => contract({ field, value })),
      repositoryDefaults: Object.entries(defaultRepoSettings()).sort(([a], [b]) => a.localeCompare(b)).map(([field, value]) => contract({ field, value })),
      structuredPersonal: STRUCTURED_SETTINGS.map((field) => ({ field, mcp: field === 'loadouts'
        ? 'Partial read: list_delegation_options returns slot, agent, model and effort. No settings write adapter.'
        : unavailable })),
      structuredRepository: STRUCTURED_REPO_SETTINGS.map((field) => ({ field, mcp: unavailable })),
      notSettings: NOT_A_SETTING
    }).toMatchSnapshot()
  })

  it('requires a settings coverage review when the MCP tool inventory changes', () => {
    // New settings tools must replace the exclusions above with supported routes
    // and handler/transport tests; updating a snapshot alone does not add support.
    expect(Object.entries({ ...FOREMAN_TOOLS, ...DELEGATION_TOOLS, [FOREMAN_CLI_TOOL.name]: FOREMAN_CLI_TOOL })
      .map(([name, tool]) => ({ name, readOnly: tool.readOnly, description: tool.description }))
      .sort((a, b) => a.name.localeCompare(b.name))).toMatchSnapshot()
  })

  it('keeps fallback policy separate from real dedicated tools', () => {
    const dedicated = { ...FOREMAN_TOOLS, ...DELEGATION_TOOLS }
    expect(dedicated).not.toHaveProperty(FOREMAN_CLI_TOOL.name)
    for (const names of Object.values(CLI_DEDICATED_TOOLS)) {
      for (const name of names) expect(dedicated).toHaveProperty(name)
    }
    expect({ commands: MCP_CLI_READ_COMMANDS, redirects: CLI_DEDICATED_TOOLS }).toMatchSnapshot()
  })

  it('requires review when an allowed CLI command gains options or changes its contract', () => {
    const commands = COMMANDS.filter((spec) => Object.hasOwn(MCP_CLI_READ_COMMANDS, commandName(spec)))
    expect(commands.map(commandName).sort()).toEqual(Object.keys(MCP_CLI_READ_COMMANDS).sort())
    for (const spec of commands) expect(spec.tier, commandName(spec)).toBe('read')
    expect({ commonOptions: COMMON_OPTIONS, commands: commands.map(contract).sort() }).toMatchSnapshot()
  })
})
