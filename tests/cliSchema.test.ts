import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOGUES } from '../src/shared/i18n'
import { cloudSettings } from '../src/shared/cloud'
import { OPEN_IN_APP_IDS } from '../src/shared/openIn'
import {
  REPO_SETTINGS_SCHEMA,
  STRUCTURED_REPO_SETTINGS,
  coerceRepoSettingValue,
  describeRepoSpec,
  findRepoSetting,
  repoSettingPatch,
  type RepoSettingSpec
} from '../src/shared/repoSettingsSchema'
import { SETTINGS } from '../src/shared/settingsRegistry'
import {
  NOT_A_SETTING,
  SETTINGS_SCHEMA,
  STRUCTURED_SETTINGS,
  coerceSettingValue,
  describeSpec,
  displayValue,
  findSetting,
  readSettingValue,
  settingDefault,
  settingPatch,
  settingsByPage,
  type SettingSpec
} from '../src/shared/settingsSchema'
import { SCRIPT_SHELLS, SHELL_CHOICES } from '../src/shared/shells'
import type { CloudSettings, RepoCloud, Settings } from '../src/shared/types'
import { defaultRepoSettings } from '../src/main/repoSettings'
import { defaultSettings } from '../src/main/store'

function spec(key: string): SettingSpec {
  const found = findSetting(key)
  if ('error' in found) throw new Error(found.error)
  return found.spec
}

function repoSpec(key: string): RepoSettingSpec {
  const found = findRepoSetting(key)
  if ('error' in found) throw new Error(found.error)
  return found.spec
}

function value(key: string, raw: string | string[], cwd?: string) {
  return coerceSettingValue(spec(key), raw, cwd)
}

describe('settings schema: coverage', () => {
  it('covers every Settings field, or names it as structured or not a setting', () => {
    const covered = new Set<string>(SETTINGS_SCHEMA.map((s) => s.field).filter((f) => !f.startsWith('cloud.')))
    const fields = new Set<string>([...Object.keys(defaultSettings()), 'cloud'])
    const missing: string[] = []
    for (const field of fields) {
      if (field === 'cloud') {
        // The nested object counts as covered when every one of its keys has a cloud.* spec.
        const keys = Object.keys(cloudSettings(defaultSettings())) as (keyof CloudSettings)[]
        const specs = new Set(SETTINGS_SCHEMA.map((s) => s.field))
        for (const key of keys) if (!specs.has(`cloud.${key}`)) missing.push(`cloud.${key}`)
      } else if (!covered.has(field) && !(STRUCTURED_SETTINGS as readonly string[]).includes(field) && !(field in NOT_A_SETTING)) {
        missing.push(field)
      }
    }
    expect(missing).toEqual([])
  })

  it('has no spec for a field Settings does not have, and no field both covered and structured', () => {
    const fields = new Set<string>([...Object.keys(defaultSettings()), 'cloud'])
    for (const s of SETTINGS_SCHEMA) expect(fields.has(s.field.startsWith('cloud.') ? 'cloud' : s.field), s.key).toBe(true)
    for (const name of STRUCTURED_SETTINGS) {
      expect(fields.has(name), name).toBe(true)
      expect(
        SETTINGS_SCHEMA.some((s) => s.field === name),
        name
      ).toBe(false)
    }
  })

  it('has one spec per field', () => {
    const seen = new Map<string, string>()
    for (const s of SETTINGS_SCHEMA) {
      expect(seen.get(s.field), `${s.key} repeats ${s.field}`).toBeUndefined()
      seen.set(s.field, s.key)
    }
  })

  it('points every registryId at a real row on the page the key says', () => {
    for (const s of SETTINGS_SCHEMA) {
      if (!s.registryId) {
        expect(s.page === 'devices' || s.page === 'environment', `${s.key} has no row`).toBe(true)
        continue
      }
      const row = SETTINGS.find((e) => e.id === s.registryId)
      expect(row, `${s.key} → ${s.registryId}`).toBeDefined()
      expect(row!.page.section, s.key).toBe(s.page)
      expect(s.platform, s.key).toBe(row!.windows ? 'windows' : row!.mac ? 'mac' : undefined)
    }
  })

  it('has unique, well-formed keys', () => {
    const keys = SETTINGS_SCHEMA.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of SETTINGS_SCHEMA) {
      expect(s.key, s.key).toMatch(/^[a-z]+\.[a-z0-9-]+$/)
      expect(s.key).toBe(`${s.page}.${s.id}`)
    }
  })

  it('groups every spec under a page', () => {
    expect(settingsByPage().flatMap((g) => g.specs)).toHaveLength(SETTINGS_SCHEMA.length)
  })

  it('gives each enum and number what it needs', () => {
    for (const s of SETTINGS_SCHEMA) {
      if (s.type === 'enum') expect(s.values?.length, s.key).toBeGreaterThan(0)
      if (s.type === 'integer' || s.type === 'number') expect(s.options !== undefined || (s.min !== undefined && s.max !== undefined), s.key).toBe(true)
      expect(describeSpec(s), s.key).not.toBe('')
    }
  })

  it('puts a note on the settings that widen what an agent may do', () => {
    for (const key of ['experimental.auto-permission-mode', 'account.claude-tool-approvals', 'account.codex-tool-approvals', 'agents.chrome-mode', 'account.privacy-mode', 'advanced.terminal-restore', 'data.keep-cleared-history']) {
      expect(spec(key).note, key).toBeTruthy()
    }
  })

  it('uses the page-prefixed keys the plan names', () => {
    for (const key of ['appearance.theme', 'git.branch-prefix', 'appearance.home-done-days', 'cloud.max-running', 'devices.port', 'devices.mobile-url', 'general.open-in-path', 'environment.env-files']) {
      expect(findSetting(key), key).toHaveProperty('spec')
    }
    expect(spec('devices.port')).toMatchObject({ field: 'devicePort', apply: 'handOffs', min: 1024, max: 65535 })
    expect(spec('devices.mobile')).toMatchObject({ field: 'mobileEnabled', apply: 'mobile' })
    expect(spec('devices.mobile-lan-address')).toMatchObject({ apply: 'mobileLan' })
    expect(spec('environment.env-files')).toMatchObject({ type: 'list', apply: 'envFiles' })
  })
})

describe('settings schema: enums', () => {
  // The stored values of each enum field, from the TypeScript union (or the runtime constant behind it).
  const STORED: Record<string, readonly string[]> = {
    language: ['system', ...Object.keys(CATALOGUES)],
    messageSendKey: ['enter', 'mod-enter'],
    followUpMode: ['queue', 'steer'],
    sound: ['chime', 'bell', 'pop', 'marimba', 'none'],
    openInDefault: ['', 'custom', ...OPEN_IN_APP_IDS],
    updateInterval: ['hourly', 'every-4-hours', 'daily'],
    updateMode: ['notify', 'download', 'quit'],
    updateChannel: ['stable', 'beta'],
    terminalShell: SHELL_CHOICES,
    terminalScreenReader: ['auto', 'on', 'off'],
    reduceMotion: ['auto', 'on', 'off'],
    announce: ['needs-me', 'my-chat', 'all'],
    speechOutput: ['off', 'on'],
    sttProvider: ['local', 'openai'],
    pushToTalk: ['hold', 'toggle'],
    scriptShell: SCRIPT_SHELLS,
    githubAuth: ['cli', 'token'],
    codexApprovals: ['sandboxed', 'always'],
    theme: ['system', 'light', 'dark'],
    colorVision: ['default', 'protanopia-deuteranopia', 'tritanopia'],
    windowLayout: ['panes', 'tiles', 'editor'],
    sidebarSide: ['left', 'right'],
    sidePanelSide: ['left', 'right'],
    terminalPlacement: ['panel-bottom', 'panel-top', 'below-chat'],
    homeLayout: ['list', 'board'],
    branchPrefixType: ['github', 'custom', 'none'],
    openPrIn: ['github', 'graphite'],
    claudeAuth: ['cli', 'apiKey'],
    codexAuth: ['cli', 'apiKey'],
    'cloud.claudeAuth': ['setup-token', 'api-key']
  }

  it('knows the stored values of every enum', () => {
    const enums = SETTINGS_SCHEMA.filter((s) => s.type === 'enum').map((s) => s.field)
    expect(enums.sort()).toEqual(Object.keys(STORED).sort())
  })

  for (const [field, stored] of Object.entries(STORED)) {
    it(`takes every stored value of ${field} and nothing else`, () => {
      const s = SETTINGS_SCHEMA.find((x) => x.field === field)!
      for (const wanted of stored) {
        const spellings = (s.values ?? []).filter((v) => (s.labels?.[v] ?? v) === wanted)
        expect(spellings, `${s.key} has no spelling for '${wanted}'`).toHaveLength(1)
        expect(coerceSettingValue(s, spellings[0]), `${s.key} ${spellings[0]}`).toEqual({ value: wanted })
        // What is stored prints back as the same spelling.
        expect(displayValue(s, wanted)).toBe(spellings[0])
      }
      expect(s.values).toHaveLength(stored.length)
    })
  }

  it('spells the stored values that differ', () => {
    expect(value('agents.claude-auth', 'login')).toEqual({ value: 'cli' })
    expect(value('agents.claude-auth', 'API-KEY')).toEqual({ value: 'apiKey' })
    // The stored spelling is accepted too.
    expect(value('agents.codex-auth', 'apiKey')).toEqual({ value: 'apiKey' })
    expect(value('general.open-in-default', 'auto')).toEqual({ value: '' })
    expect(value('general.open-in-default', 'VSCode')).toEqual({ value: 'vscode' })
    expect(value('general.language', 'ZH-cn')).toEqual({ value: 'zh-CN' })
    expect(displayValue(spec('agents.claude-auth'), 'cli')).toBe('login')
  })
})

describe('settings schema: coerce', () => {
  it('reads every spelling of a boolean', () => {
    for (const word of ['on', 'ON', 'true', 'True', 'yes', 'YES', '1']) expect(value('general.notifications', word)).toEqual({ value: true })
    for (const word of ['off', 'OFF', 'false', 'False', 'no', 'No', '0']) expect(value('general.notifications', word)).toEqual({ value: false })
    expect(value('general.notifications', 'maybe')).toHaveProperty('error')
    expect(value('general.notifications', '')).toHaveProperty('error')
  })

  it('refuses an unknown choice and lists the choices', () => {
    const result = value('general.completion-sound', 'ding')
    expect(result).toHaveProperty('error')
    const error = (result as { error: string }).error
    expect(error).toContain('ding')
    for (const sound of ['chime', 'bell', 'pop', 'marimba', 'none']) expect(error).toContain(sound)
    expect(value('general.completion-sound', 'Marimba')).toEqual({ value: 'marimba' })
  })

  it("bounds Foreman's voice: rate 0.5 to 2 and volume 0 to 1, in steps of a tenth", () => {
    expect(value('accessibility.speech-rate', '1.5')).toEqual({ value: 1.5 })
    expect(value('accessibility.speech-rate', '0.5')).toEqual({ value: 0.5 })
    expect(value('accessibility.speech-rate', '2')).toEqual({ value: 2 })
    for (const bad of ['0.4', '2.1', '1.55', 'fast']) expect(value('accessibility.speech-rate', bad), bad).toHaveProperty('error')
    expect(value('accessibility.speech-volume', '0')).toEqual({ value: 0 })
    expect(value('accessibility.speech-volume', '0.7')).toEqual({ value: 0.7 })
    expect(value('accessibility.speech-volume', '1')).toEqual({ value: 1 })
    for (const bad of ['-0.1', '1.1', '0.55', 'loud']) expect(value('accessibility.speech-volume', bad), bad).toHaveProperty('error')
    expect(value('accessibility.speech-output', 'on')).toEqual({ value: 'on' })
    expect(value('accessibility.speech-output', 'maybe')).toHaveProperty('error')
    expect(value('accessibility.speech-voice', '  urn:voice:anna ')).toEqual({ value: 'urn:voice:anna' })
  })

  it('keeps zoom on its step', () => {
    expect(value('appearance.zoom', '2.05')).toHaveProperty('error')
    expect(value('appearance.zoom', '1.5')).toEqual({ value: 1.5 })
    expect(value('appearance.zoom', '0.5')).toEqual({ value: 0.5 })
    expect(value('appearance.zoom', '2')).toEqual({ value: 2 })
    expect(value('appearance.zoom', '0.4')).toHaveProperty('error')
    expect(value('appearance.zoom', '2.1')).toHaveProperty('error')
    expect(value('appearance.zoom', 'big')).toHaveProperty('error')
  })

  it('takes only the Done lane windows Home offers', () => {
    expect(value('appearance.home-done-days', '5')).toHaveProperty('error')
    expect(value('appearance.home-done-days', '7')).toEqual({ value: 7 })
    expect(value('appearance.home-done-days', '30')).toEqual({ value: 30 })
    expect(value('appearance.home-done-days', '7.5')).toHaveProperty('error')
  })

  it('takes only the battery percents the picker offers', () => {
    expect(value('general.keep-awake-battery-percent', '20')).toEqual({ value: 20 })
    expect(value('general.keep-awake-battery-percent', '22')).toHaveProperty('error')
  })

  it('applies the corrected bounds', () => {
    expect(value('advanced.terminal-scrollback-mb', '1000')).toEqual({ value: 1000 })
    expect(value('advanced.terminal-scrollback-mb', '1001')).toHaveProperty('error')
    expect(value('advanced.terminal-scrollback-mb', '0')).toHaveProperty('error')
    expect(value('appearance.terminal-font-size', '10')).toEqual({ value: 10 })
    expect(value('appearance.terminal-font-size', '21')).toHaveProperty('error')
    expect(value('cloud.max-running', '10000')).toEqual({ value: 10000 })
    expect(value('cloud.max-running', '0')).toHaveProperty('error')
    expect(value('devices.port', '80')).toHaveProperty('error')
    expect(value('devices.port', '47631')).toEqual({ value: 47631 })
    expect(value('devices.port', '65536')).toHaveProperty('error')
  })

  it('keeps an empty path empty and resolves the rest', () => {
    expect(value('agents.claude-path', '')).toEqual({ value: '' })
    expect(displayValue(spec('agents.claude-path'), '')).toBe('(automatic)')
    const cwd = path.resolve('some', 'folder')
    expect(value('advanced.workspaces-folder', 'work', cwd)).toEqual({ value: path.join(cwd, 'work') })
    expect(value('advanced.workspaces-folder', '../elsewhere', cwd)).toEqual({ value: path.resolve(cwd, '..', 'elsewhere') })
    const absolute = path.resolve('abs', 'dir')
    expect(value('advanced.workspaces-folder', absolute, cwd)).toEqual({ value: absolute })
    expect(coerceSettingValue(spec('advanced.workspaces-folder'), '~/code', cwd, path.resolve('home'))).toEqual({ value: path.resolve('home', 'code') })
  })

  it('splits lists on commas, or takes an array', () => {
    expect(value('environment.env-files', '.env, .env.local ,,')).toEqual({ value: ['.env', '.env.local'] })
    expect(value('environment.env-files', ['a', ' b '])).toEqual({ value: ['a', 'b'] })
    expect(value('environment.env-files', '')).toEqual({ value: [] })
    expect(displayValue(spec('environment.env-files'), [])).toBe('(none)')
  })

  it('reads app=path for the open-in paths and merges it', () => {
    const cwd = path.resolve('here')
    const parsed = value('general.open-in-path', 'zed=bin/zed', cwd)
    expect(parsed).toEqual({ value: { zed: path.join(cwd, 'bin', 'zed') } })
    expect(value('general.open-in-path', 'zed')).toHaveProperty('error')
    expect(value('general.open-in-path', 'notepad=x')).toHaveProperty('error')
    const settings = { ...defaultSettings(), openInPaths: { cursor: 'C:\\c', zed: 'C:\\z' } }
    const s = spec('general.open-in-path')
    expect(settingPatch(s, { zed: 'D:\\z' }, settings)).toEqual({ openInPaths: { cursor: 'C:\\c', zed: 'D:\\z' } })
    expect(settingPatch(s, { zed: '' }, settings)).toEqual({ openInPaths: { cursor: 'C:\\c' } })
  })

  it('takes one line of text', () => {
    expect(value('appearance.mono-font', ' Fira Code ')).toEqual({ value: 'Fira Code' })
    expect(value('appearance.mono-font', 'a\nb')).toHaveProperty('error')
  })
})

describe('settings schema: patches, defaults and lookups', () => {
  it('builds { field: value } for plain settings', () => {
    expect(settingPatch(spec('appearance.theme'), 'dark')).toEqual({ theme: 'dark' })
    expect(settingPatch(spec('devices.port'), 4000)).toEqual({ devicePort: 4000 })
  })

  it('builds a nested cloud patch', () => {
    expect(settingPatch(spec('cloud.max-running'), 12)).toEqual({ cloud: { maxRunning: 12 } })
    expect(settingPatch(spec('cloud.workspaces'), true)).toEqual({ cloud: { enabled: true } })
  })

  it('reads cloud values with their defaults, and defaults from cloudSettings', () => {
    const defaults = defaultSettings()
    const apiKey: Settings = { ...defaults, claudeAuth: 'apiKey' }
    expect(readSettingValue(spec('cloud.max-running'), defaults)).toBe(8)
    expect(readSettingValue(spec('cloud.max-running'), { ...defaults, cloud: { ...cloudSettings(defaults), maxRunning: 3 } })).toBe(3)
    // The Claude sign-in default follows claudeAuth; a stored cloud value is not the default.
    expect(settingDefault(spec('cloud.claude-auth'), apiKey, defaults)).toBe('api-key')
    expect(settingDefault(spec('cloud.claude-auth'), defaults, defaults)).toBe('setup-token')
    expect(settingDefault(spec('cloud.max-running'), { ...defaults, cloud: { ...cloudSettings(defaults), maxRunning: 3 } }, defaults)).toBe(8)
    expect(settingDefault(spec('appearance.zoom'), { ...defaults, zoom: 1.4 }, defaults)).toBe(1)
    expect(readSettingValue(spec('appearance.zoom'), { ...defaults, zoom: 1.4 })).toBe(1.4)
  })

  it('has a default the spec accepts, for every key', () => {
    const defaults = defaultSettings()
    for (const s of SETTINGS_SCHEMA) {
      const fallback = settingDefault(s, defaults, defaults)
      if (s.type === 'enum') expect((s.values ?? []).map((v) => s.labels?.[v] ?? v), s.key).toContain(fallback)
      if (s.options) expect(s.options, s.key).toContain(fallback)
      if (s.type === 'integer' || s.type === 'number') {
        if (s.min !== undefined) expect(fallback as number, s.key).toBeGreaterThanOrEqual(s.min)
        if (s.max !== undefined) expect(fallback as number, s.key).toBeLessThanOrEqual(s.max)
      }
    }
  })

  it('finds only exact keys, and suggests the page-prefixed one', () => {
    expect(findSetting('appearance.theme')).toHaveProperty('spec')
    const bare = findSetting('theme') as { error: string }
    expect(bare.error).toContain('appearance.theme')
    const camel = findSetting('terminalFontSize') as { error: string }
    expect(camel.error).toContain('appearance.terminal-font-size')
    // The right id on the wrong page still names the right page.
    expect((findSetting('general.theme') as { error: string }).error).toContain('appearance.theme')
    expect(findSetting('nonsense-xyz')).toHaveProperty('error')
  })
})

describe('repository settings schema: coverage', () => {
  it('covers every RepoSettings field, or names it as structured', () => {
    const covered = new Set<string>(REPO_SETTINGS_SCHEMA.map((s) => s.field))
    const defaults = defaultRepoSettings()
    const missing: string[] = []
    for (const field of Object.keys(defaults)) {
      if (field === 'prompts') {
        for (const prompt of Object.keys(defaults.prompts)) if (!covered.has(`prompts.${prompt}`)) missing.push(`prompts.${prompt}`)
      } else if (!covered.has(field) && !STRUCTURED_REPO_SETTINGS.includes(field)) {
        missing.push(field)
      }
    }
    expect(missing).toEqual([])
  })

  it('covers the Repo fields and every RepoCloud key', () => {
    const covered = new Set<string>(REPO_SETTINGS_SCHEMA.map((s) => s.field))
    for (const field of ['name', 'defaultBranch', 'remote', 'icon']) expect(covered.has(field), field).toBe(true)
    const cloud: (keyof Omit<RepoCloud, 'build'>)[] = ['enabled', 'provider', 'connectionId', 'vcpus', 'region', 'idleMinutes', 'autoContinue', 'installScript', 'maxRunning']
    for (const key of cloud) expect(covered.has(`cloud.${key}`), key).toBe(true)
    for (const field of ['integrations.github', 'integrations.linear', 'integrations.slack', 'integrations.rules', 'integrations.allowOwnMcp']) expect(covered.has(field), field).toBe(true)
  })

  it('has no spec for a RepoSettings field that does not exist, and none for the structured ones', () => {
    const defaults = defaultRepoSettings() as unknown as Record<string, unknown>
    for (const s of REPO_SETTINGS_SCHEMA) {
      if (s.target === 'local' || s.target === 'envFiles') {
        const top = s.field.startsWith('prompts.') ? 'prompts' : s.field
        expect(top in defaults, s.key).toBe(true)
      }
    }
    for (const name of STRUCTURED_REPO_SETTINGS.filter((n) => n !== 'autoReview')) {
      expect(name in defaults, name).toBe(true)
      expect(
        REPO_SETTINGS_SCHEMA.some((s) => s.field === name),
        name
      ).toBe(false)
    }
  })

  it('has unique, well-formed keys on the tabs the plan names', () => {
    const keys = REPO_SETTINGS_SCHEMA.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of REPO_SETTINGS_SCHEMA) {
      expect(s.key, s.key).toMatch(/^[a-z]+\.[a-z0-9-]+$/)
      expect(['git', 'scripts', 'actions', 'repo', 'integrations', 'cloud']).toContain(s.tab)
      expect(s.key).toBe(`${s.tab}.${s.id}`)
      expect(describeRepoSpec(s), s.key).not.toBe('')
    }
  })

  it('points every registryId at a repository row', () => {
    const tabs: Record<string, string> = { misc: 'repo', environment: 'repo' }
    for (const s of REPO_SETTINGS_SCHEMA) {
      if (!s.registryId) continue
      const row = SETTINGS.find((e) => e.id === s.registryId)
      expect(row, `${s.key} → ${s.registryId}`).toBeDefined()
      expect(row!.page.section, s.key).toBe('repo')
      const tab = (row!.page as { tab: string }).tab
      expect(tabs[tab] ?? tab, s.key).toBe(s.tab)
    }
  })

  it('marks as shared exactly the keys settings.toml can also set', () => {
    for (const s of REPO_SETTINGS_SCHEMA) {
      const localOnly = ['teachAgents', 'agentsMayStart'].includes(s.field)
      const fromRepoSettings = s.target === 'local' || s.target === 'envFiles'
      expect(Boolean(s.shared), s.key).toBe(fromRepoSettings && !localOnly)
    }
    expect(repoSpec('actions.teach-agents').shared).toBeUndefined()
    expect(repoSpec('actions.agents-may-start').shared).toBeUndefined()
    expect(repoSpec('scripts.run-mode').shared).toBe(true)
    expect(repoSpec('git.base-branch').shared).toBeUndefined()
    expect(repoSpec('cloud.enabled').shared).toBeUndefined()
  })

  it('puts a note on the settings that let agents act', () => {
    expect(repoSpec('actions.teach-agents').note).toBeTruthy()
    expect(repoSpec('actions.agents-may-start').note).toBeTruthy()
  })
})

describe('repository settings schema: values and patches', () => {
  it('takes the run modes', () => {
    expect(repoSpec('scripts.run-mode').values).toEqual(['exclusive', 'concurrent'])
    expect(coerceRepoSettingValue(repoSpec('scripts.run-mode'), 'Concurrent')).toEqual({ value: 'concurrent' })
    expect(coerceRepoSettingValue(repoSpec('scripts.run-mode'), 'parallel')).toHaveProperty('error')
  })

  it('takes the cloud providers', () => {
    expect(repoSpec('cloud.provider').values).toEqual(['vercel', 'docker', 'e2b', 'daytona'])
    expect(coerceRepoSettingValue(repoSpec('cloud.idle-minutes'), '0')).toHaveProperty('error')
    expect(coerceRepoSettingValue(repoSpec('cloud.idle-minutes'), '1440')).toEqual({ value: 1440 })
    expect(coerceRepoSettingValue(repoSpec('cloud.idle-minutes'), '1441')).toHaveProperty('error')
    expect(coerceRepoSettingValue(repoSpec('cloud.max-running'), '10000')).toEqual({ value: 10000 })
    expect(coerceRepoSettingValue(repoSpec('cloud.max-running'), '10001')).toHaveProperty('error')
    // The vCPU sizes belong to the provider, so the schema only wants a whole number.
    expect(coerceRepoSettingValue(repoSpec('cloud.vcpus'), '4')).toEqual({ value: 4 })
    expect(coerceRepoSettingValue(repoSpec('cloud.vcpus'), 'four')).toHaveProperty('error')
  })

  it('writes a prompt into prompts', () => {
    const s = repoSpec('actions.prompt-general')
    expect(s.field).toBe('prompts.general')
    expect(coerceRepoSettingValue(s, 'Be brief.\nUse tabs.')).toEqual({ value: 'Be brief.\nUse tabs.' })
    expect(repoSettingPatch(s, 'Be brief.')).toEqual({ kind: 'local', patch: { prompts: { general: 'Be brief.' } } })
    expect(repoSettingPatch(repoSpec('actions.prompt-create-pr'), null)).toEqual({ kind: 'local', patch: { prompts: { createPr: null } } })
  })

  it('unsets a local setting by patching null', () => {
    expect(repoSettingPatch(repoSpec('scripts.run-mode'), null)).toEqual({ kind: 'local', patch: { runMode: null } })
    expect(repoSettingPatch(repoSpec('scripts.docker-cleanup'), true)).toEqual({ kind: 'local', patch: { removeDockerContainers: true } })
  })

  it('refuses to unset what does not inherit', () => {
    for (const key of ['repo.name', 'git.base-branch', 'cloud.enabled', 'integrations.linear', 'repo.env-files']) {
      expect(repoSettingPatch(repoSpec(key), null), key).toHaveProperty('error')
    }
    expect((repoSettingPatch(repoSpec('repo.name'), null) as { error: string }).error).toContain('repo.name')
  })

  it('writes Repo fields as a RepoPatch', () => {
    expect(repoSettingPatch(repoSpec('git.base-branch'), 'develop')).toEqual({ kind: 'repo', patch: { defaultBranch: 'develop' } })
    expect(repoSettingPatch(repoSpec('repo.name'), 'Foreman')).toEqual({ kind: 'repo', patch: { name: 'Foreman' } })
    expect(repoSettingPatch(repoSpec('git.remote'), 'upstream')).toEqual({ kind: 'repo', patch: { remote: 'upstream' } })
    expect(repoSettingPatch(repoSpec('cloud.idle-minutes'), 30)).toEqual({ kind: 'repo', patch: { cloud: { idleMinutes: 30 } } })
    expect(repoSettingPatch(repoSpec('cloud.connection'), '')).toEqual({ kind: 'repo', patch: { cloud: { connectionId: '' } } })
    expect(repoSettingPatch(repoSpec('cloud.continue'), false)).toEqual({ kind: 'repo', patch: { cloud: { autoContinue: false } } })
  })

  it('reads icons', () => {
    const s = repoSpec('repo.icon')
    expect(coerceRepoSettingValue(s, 'emoji:🚀')).toEqual({ value: { kind: 'emoji', value: '🚀' } })
    expect(coerceRepoSettingValue(s, 'lucide:rocket')).toEqual({ value: { kind: 'lucide', name: 'rocket' } })
    expect(coerceRepoSettingValue(s, 'rocket')).toHaveProperty('error')
    expect(repoSettingPatch(s, { kind: 'lucide', name: 'rocket' })).toEqual({ kind: 'repo', patch: { icon: { kind: 'lucide', name: 'rocket' } } })
  })

  it('refuses a blank name or base branch', () => {
    expect(coerceRepoSettingValue(repoSpec('repo.name'), '  ')).toHaveProperty('error')
    expect(coerceRepoSettingValue(repoSpec('git.base-branch'), '')).toHaveProperty('error')
    expect(coerceRepoSettingValue(repoSpec('git.base-branch'), ' main ')).toEqual({ value: 'main' })
  })

  it('reads preview urls, with and without a name', () => {
    const s = repoSpec('repo.preview-urls')
    expect(coerceRepoSettingValue(s, 'web=http://localhost:$FOREMAN_PORT, http://localhost:3000/?a=b')).toEqual({
      value: [
        { name: 'web', url: 'http://localhost:$FOREMAN_PORT' },
        { name: '', url: 'http://localhost:3000/?a=b' }
      ]
    })
  })

  it('writes integrations through their own calls', () => {
    expect(repoSettingPatch(repoSpec('integrations.linear'), 'off')).toEqual({ kind: 'integration', service: 'linear', choice: 'off' })
    expect(repoSettingPatch(repoSpec('integrations.github-account'), 'default')).toEqual({ kind: 'integration', service: 'github', choice: 'default' })
    expect(repoSettingPatch(repoSpec('integrations.slack-rules'), 'mine')).toEqual({ kind: 'integrationOptions', options: { rules: 'mine' } })
    expect(coerceRepoSettingValue(repoSpec('integrations.allow-own-mcp'), 'linear, Slack')).toEqual({ value: ['linear', 'slack'] })
    expect(coerceRepoSettingValue(repoSpec('integrations.allow-own-mcp'), 'jira')).toHaveProperty('error')
    expect(repoSettingPatch(repoSpec('integrations.allow-own-mcp'), ['slack'])).toEqual({ kind: 'integrationOptions', options: { allowOwnMcp: ['slack'] } })
  })

  it('writes env files through setEnvFiles', () => {
    expect(repoSettingPatch(repoSpec('repo.env-files'), ['.env'])).toEqual({ kind: 'envFiles', files: ['.env'] })
    expect(coerceRepoSettingValue(repoSpec('repo.env-files'), '.env,.env.local')).toEqual({ value: ['.env', '.env.local'] })
  })

  it('finds exact keys and suggests near ones', () => {
    expect(findRepoSetting('scripts.run-mode')).toHaveProperty('spec')
    expect((findRepoSetting('run-mode') as { error: string }).error).toContain('scripts.run-mode')
    expect((findRepoSetting('git.run-mode') as { error: string }).error).toContain('scripts.run-mode')
  })
})
