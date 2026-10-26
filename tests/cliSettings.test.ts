import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliCodedError } from '../src/main/cli/host'
import type { CliHost } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { tierCheck } from '../src/main/cli/policy'
import { SETTINGS_METHODS } from '../src/main/cli/settings'
import { defaultSettings } from '../src/main/store'
import type { SettingsExportResult, SettingsGetResult, SettingsImportResult, SettingsKeysResult, SettingsListResult, SettingsPathResult, SettingsResetResult, SettingsSearchResult, SettingsSetResult } from '../src/shared/cli/settings'
import { SETTINGS_SCHEMA } from '../src/shared/settingsSchema'
import type { Api, Settings } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

// The handlers are called the way server.ts does: through the exported map, with a context.
const ctx = (token?: string): CliContext => ({ request: { method: 'x' } as CliContext['request'], caller: token ? { token } : undefined, signal: undefined, progress: () => undefined })

function rig(settings: Partial<Settings> = {}, extra: Partial<Api> = {}, hostExtra: Partial<CliHost> = {}) {
  const calls: [string, ...unknown[]][] = []
  const current: Settings = { ...defaultSettings(), ...settings }
  const record =
    <K extends keyof Api>(name: K, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return result
    }
  const api = fakeApi({
    updateSettings: record('updateSettings', current) as Api['updateSettings'],
    mobileConfigure: record('mobileConfigure') as Api['mobileConfigure'],
    mobileConfigureLan: record('mobileConfigureLan') as Api['mobileConfigureLan'],
    setAcceptHandOffs: record('setAcceptHandOffs') as Api['setAcceptHandOffs'],
    setEnvFiles: record('setEnvFiles') as Api['setEnvFiles'],
    ...extra
  })
  const host = stubHost({ api, state: () => ({ repos: [], workspaces: [], sessions: [], settings: current }), ...hostExtra })
  const call = async <T>(method: string, params: unknown, token?: string): Promise<T> => (await SETTINGS_METHODS[method].handle(host, params, ctx(token))) as T
  const set = (...pairs: [string, string][]) => call<SettingsSetResult>('settings-set', { pairs, cwd: process.cwd() })
  return { host, calls, call, set, current }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CliCodedError)
    return err as CliCodedError
  }
  throw new Error('expected a failure')
}

describe('settings set', () => {
  it('takes every spelling of a boolean', async () => {
    for (const [word, value] of [['on', true], ['true', true], ['yes', true], ['1', true], ['off', false], ['false', false], ['no', false], ['0', false], ['ON', true], ['Off', false]] as const) {
      const { calls, set } = rig({ codeLigatures: !value })
      const result = await set(['appearance.code-ligatures', word])
      expect(calls).toEqual([['updateSettings', { codeLigatures: value }]])
      expect(result.changes[0]).toMatchObject({ key: 'appearance.code-ligatures', value: value ? 'on' : 'off', was: value ? 'off' : 'on' })
    }
  })

  it('refuses a word that is no boolean', async () => {
    const { calls, set } = rig()
    const err = await failure(set(['appearance.code-ligatures', 'maybe']))
    expect(err.code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('takes an enum by its label and stores the stored value', async () => {
    const { calls, set } = rig()
    const result = await set(['agents.claude-auth', 'api-key'])
    expect(calls).toEqual([['updateSettings', { claudeAuth: 'apiKey' }]])
    expect(result.changes[0]).toMatchObject({ value: 'api-key', was: 'login' })
    // The stored spelling and another case also work; a stranger doesn't.
    expect((await rig().set(['agents.claude-auth', 'APIKEY'])).changes[0].value).toBe('api-key')
    expect((await failure(rig().set(['agents.claude-auth', 'password']))).code).toBe('invalid')
  })

  it('keeps zoom on its steps', async () => {
    const bad = rig()
    expect((await failure(bad.set(['appearance.zoom', '2.05']))).code).toBe('invalid')
    const off = await failure(bad.set(['appearance.zoom', '1.55']))
    expect(off.code).toBe('invalid')
    expect(off.message).toMatch(/steps of 0\.1/)
    expect(bad.calls).toEqual([])
    const ok = rig()
    await ok.set(['appearance.zoom', '1.5'])
    expect(ok.calls).toEqual([['updateSettings', { zoom: 1.5 }]])
  })

  it('round-trips the content text size (12 to 24) and the terminal size word content', async () => {
    const size = rig()
    const result = await size.set(['accessibility.content-font-size', '18'])
    expect(size.calls).toEqual([['updateSettings', { contentFontSize: 18 }]])
    expect(result.changes[0]).toMatchObject({ key: 'accessibility.content-font-size', value: '18', was: '13' })
    for (const bad of ['11', '25', '14.5', 'big']) expect((await failure(rig().set(['accessibility.content-font-size', bad]))).code, bad).toBe('invalid')

    const terminal = rig()
    const word = await terminal.set(['appearance.terminal-font-size', 'Content'])
    expect(terminal.calls).toEqual([['updateSettings', { terminalFontSize: 'content' }]])
    expect(word.changes[0]).toMatchObject({ key: 'appearance.terminal-font-size', value: 'content', was: '12' })
    // A number still works, within its own range, and reads back from either form.
    const number = rig({ terminalFontSize: 'content' })
    expect((await number.set(['appearance.terminal-font-size', '16'])).changes[0]).toMatchObject({ value: '16', was: 'content' })
    expect((await failure(rig().set(['appearance.terminal-font-size', '21']))).code).toBe('invalid')
    const read = await rig({ terminalFontSize: 'content', contentFontSize: 18 }).call<SettingsGetResult>('settings-get', { keys: ['appearance.terminal-font-size', 'accessibility.content-font-size'] })
    expect(read.rows.map((r) => r.value)).toEqual(['content', '18'])
  })

  it('takes reduce-motion as auto, on or off', async () => {
    const { calls, set } = rig()
    expect((await set(['accessibility.reduce-motion', 'on'])).changes[0]).toMatchObject({ value: 'on', was: 'auto' })
    expect(calls).toEqual([['updateSettings', { reduceMotion: 'on' }]])
    expect((await failure(set(['accessibility.reduce-motion', 'sometimes']))).code).toBe('invalid')
  })

  it('takes the announcement policy, the end-of-turn summary and sound cues', async () => {
    const policy = rig()
    expect((await policy.set(['accessibility.announce', 'needs-me'])).changes[0]).toMatchObject({ key: 'accessibility.announce', value: 'needs-me', was: 'my-chat' })
    expect(policy.calls).toEqual([['updateSettings', { announce: 'needs-me' }]])
    expect((await failure(rig().set(['accessibility.announce', 'loud']))).code).toBe('invalid')

    const summary = rig()
    expect((await summary.set(['accessibility.announce-summary', 'off'])).changes[0]).toMatchObject({ value: 'off', was: 'on' })
    expect(summary.calls).toEqual([['updateSettings', { announceSummary: false }]])

    const cues = rig()
    expect((await cues.set(['accessibility.earcons', 'on'])).changes[0]).toMatchObject({ value: 'on', was: 'off' })
    expect(cues.calls).toEqual([['updateSettings', { earcons: true }]])
    const read = await rig({ announce: 'all', announceSummary: false, earcons: true }).call<SettingsGetResult>('settings-get', { keys: ['accessibility.announce', 'accessibility.announce-summary', 'accessibility.earcons'] })
    expect(read.rows.map((r) => r.value)).toEqual(['all', 'off', 'on'])
  })

  it("takes Foreman's voice: on or off, a voice, the rate and the volume", async () => {
    const output = rig()
    expect((await output.set(['accessibility.speech-output', 'on'])).changes[0]).toMatchObject({ key: 'accessibility.speech-output', value: 'on', was: 'off' })
    expect(output.calls).toEqual([['updateSettings', { speechOutput: 'on' }]])
    expect((await failure(rig().set(['accessibility.speech-output', 'loud']))).code).toBe('invalid')

    const voice = rig()
    expect((await voice.set(['accessibility.speech-voice', 'urn:voice:anna'])).changes[0]).toMatchObject({ value: 'urn:voice:anna', was: '(empty)' })
    expect(voice.calls).toEqual([['updateSettings', { speechVoice: 'urn:voice:anna' }]])

    const rate = rig()
    expect((await rate.set(['accessibility.speech-rate', '1.5'])).changes[0]).toMatchObject({ value: '1.5', was: '1' })
    expect(rate.calls).toEqual([['updateSettings', { speechRate: 1.5 }]])
    for (const bad of ['0.4', '2.5', 'fast']) expect((await failure(rig().set(['accessibility.speech-rate', bad]))).code, bad).toBe('invalid')

    const volume = rig()
    await volume.set(['accessibility.speech-volume', '0.5'])
    expect(volume.calls).toEqual([['updateSettings', { speechVolume: 0.5 }]])
    for (const bad of ['1.5', '-1']) expect((await failure(rig().set(['accessibility.speech-volume', bad]))).code, bad).toBe('invalid')

    const read = await rig({ speechOutput: 'on', speechVoice: 'urn:voice:anna', speechRate: 1.2, speechVolume: 0.8 }).call<SettingsGetResult>('settings-get', {
      keys: ['accessibility.speech-output', 'accessibility.speech-voice', 'accessibility.speech-rate', 'accessibility.speech-volume']
    })
    expect(read.rows.map((r) => r.value)).toEqual(['on', 'urn:voice:anna', '1.2', '0.8'])
  })

  it('takes speech input: the engine, the language and push to talk', async () => {
    const engine = rig()
    expect((await engine.set(['accessibility.stt-provider', 'openai'])).changes[0]).toMatchObject({ key: 'accessibility.stt-provider', value: 'openai', was: 'local' })
    expect(engine.calls).toEqual([['updateSettings', { sttProvider: 'openai' }]])
    expect((await failure(rig().set(['accessibility.stt-provider', 'google']))).code).toBe('invalid')

    const language = rig()
    expect((await language.set(['accessibility.stt-language', 'de'])).changes[0]).toMatchObject({ value: 'de', was: 'en' })
    expect(language.calls).toEqual([['updateSettings', { sttLanguage: 'de' }]])

    const talk = rig()
    expect((await talk.set(['accessibility.push-to-talk', 'toggle'])).changes[0]).toMatchObject({ value: 'toggle', was: 'hold' })
    expect(talk.calls).toEqual([['updateSettings', { pushToTalk: 'toggle' }]])
    expect((await failure(rig().set(['accessibility.push-to-talk', 'always']))).code).toBe('invalid')

    const read = await rig({ sttProvider: 'openai', sttLanguage: 'fr', pushToTalk: 'toggle' }).call<SettingsGetResult>('settings-get', {
      keys: ['accessibility.stt-provider', 'accessibility.stt-language', 'accessibility.push-to-talk']
    })
    expect(read.rows.map((r) => r.value)).toEqual(['openai', 'fr', 'toggle'])
    expect(defaultSettings()).toMatchObject({ sttProvider: 'local', sttLanguage: 'en', pushToTalk: 'hold' })
  })

  it('writes nothing unless every pair is valid', async () => {
    const { calls, set } = rig()
    const err = await failure(set(['appearance.theme', 'dark'], ['appearance.zoom', '9'], ['appearance.color-vision', 'plaid']))
    expect(err.code).toBe('invalid')
    // Both problems are reported together.
    expect(err.message).toMatch(/zoom/)
    expect(err.message).toMatch(/plaid/)
    expect(calls).toEqual([])
  })

  it('writes several plain settings in one call', async () => {
    const { calls, set } = rig()
    await set(['git.branch-prefix-type', 'custom'], ['git.branch-prefix', 'yatin/'])
    expect(calls).toEqual([['updateSettings', { branchPrefixType: 'custom', branchPrefix: 'yatin/' }]])
  })

  it('builds the nested cloud patch', async () => {
    const { calls, set } = rig()
    await set(['cloud.max-running', '5'], ['cloud.workspaces', 'on'])
    expect(calls).toEqual([['updateSettings', { cloud: { maxRunning: 5, enabled: true } }]])
  })

  it('sends the mobile settings to mobileConfigure with the values that stay', async () => {
    const on = rig({ mobileEnabled: false, mobileUrl: 'https://phone.example' })
    await on.set(['devices.mobile', 'on'])
    expect(on.calls).toEqual([['mobileConfigure', true, 'https://phone.example']])
    const url = rig({ mobileEnabled: true, mobileUrl: '' })
    await url.set(['devices.mobile-url', 'https://new.example'])
    expect(url.calls).toEqual([['mobileConfigure', true, 'https://new.example']])
    const lan = rig({ mobileLanEnabled: false, mobileLanAddress: '192.168.1.5' })
    await lan.set(['devices.mobile-lan', 'on'])
    expect(lan.calls).toEqual([['mobileConfigureLan', true, '192.168.1.5']])
  })

  it('sends hand-offs and the port to setAcceptHandOffs', async () => {
    const on = rig({ acceptHandOffs: false })
    await on.set(['devices.accept-hand-offs', 'on'])
    expect(on.calls).toEqual([['setAcceptHandOffs', true, undefined]])
    const port = rig({ acceptHandOffs: true })
    await port.set(['devices.port', '4040'])
    expect(port.calls).toEqual([['setAcceptHandOffs', true, 4040]])
    expect((await failure(rig().set(['devices.port', '80']))).code).toBe('invalid')
  })

  it('sends env files to setEnvFiles for the user', async () => {
    const { calls, set } = rig()
    await set(['environment.env-files', '~/.env, ./secrets.env'])
    expect(calls).toEqual([['setEnvFiles', { kind: 'user' }, ['~/.env', './secrets.env']]])
  })

  it('keeps an empty path empty and resolves the others against the caller’s folder', async () => {
    const empty = rig({ workspacesRoot: '/somewhere' })
    const result = await empty.set(['advanced.workspaces-folder', ''])
    expect(empty.calls).toEqual([['updateSettings', { workspacesRoot: '' }]])
    expect(result.changes[0].value).toBe('(automatic)')
    const relative = rig()
    await relative.call('settings-set', { pairs: [['advanced.workspaces-folder', 'work']], cwd: path.resolve('/projects/app') })
    expect(relative.calls).toEqual([['updateSettings', { workspacesRoot: path.resolve('/projects/app', 'work') }]])
  })

  it('merges open-in-path entries into the saved ones and an empty path clears one', async () => {
    const zed = path.resolve('/bin/zed')
    const cursor = path.resolve('/bin/cursor')
    const { calls, set } = rig({ openInPaths: { zed, vscode: path.resolve('/bin/code') } })
    await set(['general.open-in-path', 'vscode='], ['general.open-in-path', `cursor=${cursor}`])
    expect(calls).toEqual([['updateSettings', { openInPaths: { zed, cursor } }]])
  })

  it('says what a change was and prints the notes after the rows', async () => {
    const { set } = rig({ theme: 'dark', autoPermissionMode: false })
    const result = await set(['appearance.theme', 'light'], ['experimental.auto-permission-mode', 'on'])
    expect(result.text).toMatch(/appearance\.theme\s+light\s+\(was dark\)/)
    expect(result.text).toMatch(/experimental\.auto-permission-mode\s+on\s+\(was off\)/)
    expect(result.text).toContain('Agents now decide which actions need approval')
    expect(result.changes.find((c) => c.key === 'experimental.auto-permission-mode')?.note).toBeTruthy()
  })

  it('says when a setting has no effect on this computer', async () => {
    const mac = rig({}, {}, { platform: 'darwin' })
    const result = await mac.set(['general.terminal-shell-custom', 'pwsh.exe'])
    expect(result.changes[0].platformNote).toBe('no effect on this computer')
    expect(result.text).toContain('general.terminal-shell-custom: no effect on this computer')
    // It was still written: the value travels in Git backups.
    expect(mac.calls).toEqual([['updateSettings', { terminalShellCustom: 'pwsh.exe' }]])
    const win = rig({}, {}, { platform: 'win32' })
    expect((await win.set(['general.terminal-shell-custom', 'pwsh.exe'])).changes[0].platformNote).toBeUndefined()
  })

  it('names the key it thinks was meant', async () => {
    const { set, calls } = rig()
    const err = await failure(set(['theme', 'dark']))
    expect(err.code).toBe('not-found')
    expect(err.message).toContain("'appearance.theme'")
    expect(calls).toEqual([])
    expect((await failure(rig().set(['nonsense.thing', 'x']))).message).toContain('foreman settings keys')
  })
})

describe('policy', () => {
  it('refuses every change from a request that carries a turn token', () => {
    const host = rig().host
    for (const method of ['settings-set', 'settings-reset', 'settings-import']) {
      const request = { v: 2 as const, method, params: {}, caller: { token: 'turn-token' }, token: 'test-token' }
      expect(SETTINGS_METHODS[method].tier, method).toBe('admin')
      expect(tierCheck(method, SETTINGS_METHODS[method].tier, request, host), method).toMatchObject({ code: 'refused' })
    }
    for (const method of ['settings-list', 'settings-get', 'settings-keys', 'settings-search', 'settings-path', 'settings-export']) {
      const request = { v: 2 as const, method, params: {}, caller: { token: 'turn-token' } }
      expect(SETTINGS_METHODS[method].tier, method).toBe('read')
      expect(tierCheck(method, SETTINGS_METHODS[method].tier, request, host), method).toBeNull()
    }
  })

  it('shows a request from an agent turn only what the assistant may read', async () => {
    const { call } = rig({ theme: 'dark', workspacesRoot: '/secret/place', editorCommand: 'code --wait' })
    const result = await call<SettingsGetResult>('settings-get', { keys: ['appearance.theme', 'advanced.workspaces-folder', 'general.open-in-custom-command'] }, 'turn-token')
    expect(result.rows.map((r) => r.key)).toEqual(['appearance.theme'])
    expect(result.omitted).toEqual(['advanced.workspaces-folder', 'general.open-in-custom-command'])
    expect(result.text).not.toContain('/secret/place')
    expect(result.text).not.toContain('code --wait')
    // The same call without a token sees all three.
    expect((await call<SettingsGetResult>('settings-get', { keys: ['appearance.theme', 'advanced.workspaces-folder', 'general.open-in-custom-command'] })).rows).toHaveLength(3)
    // List and export leave them out too.
    const list = await call<SettingsListResult>('settings-list', {}, 'turn-token')
    expect(list.rows.find((r) => r.key === 'advanced.workspaces-folder')).toBeUndefined()
    expect(list.omitted).toBeGreaterThan(0)
    expect(list.text).not.toContain('/secret/place')
    const exported = await call<SettingsExportResult>('settings-export', {}, 'turn-token')
    expect(exported.settings['advanced.workspaces-folder']).toBeUndefined()
    expect(exported.settings['appearance.theme']).toBe('dark')
    // Cloud keys are not on the assistant's list either.
    expect(exported.settings['cloud.max-running']).toBeUndefined()
  })

  it('refuses to open Settings from an agent turn', async () => {
    const { call } = rig()
    expect((await failure(call('settings-path', { key: 'appearance.theme', open: true }, 'turn-token'))).code).toBe('refused')
  })
})

describe('settings reset', () => {
  it('routes each key through the call that owns it', async () => {
    const { calls, call } = rig({ theme: 'dark', mobileEnabled: true, mobileUrl: 'https://phone.example', envFiles: ['a.env'], acceptHandOffs: true, devicePort: 5000, cloud: { maxRunning: 3 } as Settings['cloud'] })
    const result = await call<SettingsResetResult>('settings-reset', { keys: ['appearance.theme', 'devices.mobile', 'environment.env-files', 'devices.accept-hand-offs', 'devices.port', 'cloud.max-running'] })
    expect(calls).toContainEqual(['updateSettings', { theme: 'system', cloud: { maxRunning: 8 } }])
    expect(calls).toContainEqual(['mobileConfigure', false, 'https://phone.example'])
    expect(calls).toContainEqual(['setEnvFiles', { kind: 'user' }, []])
    expect(calls).toContainEqual(['setAcceptHandOffs', false, defaultSettings().devicePort])
    expect(result.changes.map((c) => c.key)).toContain('devices.mobile')
    expect(result.text).toMatch(/appearance\.theme\s+system\s+\(was dark\)/)
  })

  it('does nothing for a key that already has its default, and says so', async () => {
    const { calls, call } = rig()
    const result = await call<SettingsResetResult>('settings-reset', { keys: ['appearance.theme'] })
    expect(calls).toEqual([])
    expect(result.unchanged).toEqual(['appearance.theme'])
    expect(result.text).toContain('Already the default')
  })

  it('resets everything that differs with all', async () => {
    const { calls, call } = rig({ theme: 'dark', zoom: 1.5 })
    const result = await call<SettingsResetResult>('settings-reset', { all: true })
    expect(calls).toEqual([['updateSettings', { theme: 'system', zoom: 1 }]])
    expect(result.changes.map((c) => c.key).sort()).toEqual(['appearance.theme', 'appearance.zoom'])
  })

  it('needs keys or all, not both', async () => {
    const { call } = rig()
    expect((await failure(call('settings-reset', {}))).code).toBe('invalid')
    expect((await failure(call('settings-reset', { keys: ['appearance.theme'], all: true }))).code).toBe('invalid')
    expect((await failure(call('settings-reset', { keys: ['theme'] }))).code).toBe('not-found')
  })

  it('puts the whole open-in-path map back, not just merges', async () => {
    const { calls, call } = rig({ openInPaths: { zed: path.resolve('/bin/zed') } })
    await call('settings-reset', { keys: ['general.open-in-path'] })
    expect(calls).toEqual([['updateSettings', { openInPaths: {} }]])
  })
})

describe('settings list, get, keys, search, path', () => {
  it('lists every key by page and stars what differs from the default', async () => {
    const { call } = rig({ theme: 'dark' })
    const list = await call<SettingsListResult>('settings-list', {})
    expect(list.rows).toHaveLength(SETTINGS_SCHEMA.length)
    expect(list.text).toMatch(/\* appearance\.theme\s+dark\s+\(default system\)/)
    expect(list.text).toContain('* differs from the default')
    expect(list.text).toMatch(/^General$/m)
  })

  it('lists only what changed with changed', async () => {
    const { call } = rig({ theme: 'dark', cloud: { maxRunning: 2 } as Settings['cloud'] })
    const list = await call<SettingsListResult>('settings-list', { changed: true })
    expect(list.rows.map((r) => r.key).sort()).toEqual(['appearance.theme', 'cloud.max-running'])
    expect(list.rows.every((r) => r.changed)).toBe(true)
    expect((await rig().call<SettingsListResult>('settings-list', { changed: true })).text).toBe('Every setting has its default.')
  })

  it('lists one page, and refuses a page that is not one', async () => {
    const { call } = rig()
    const list = await call<SettingsListResult>('settings-list', { page: 'appearance' })
    expect(list.rows.length).toBeGreaterThan(5)
    expect(list.rows.every((r) => r.page === 'appearance')).toBe(true)
    expect((await failure(call('settings-list', { page: 'nowhere' }))).code).toBe('invalid')
  })

  it('gets value, default, path and what the key takes', async () => {
    const { call } = rig({ theme: 'dark' })
    const result = await call<SettingsGetResult>('settings-get', { keys: ['appearance.theme', 'cloud.max-running', 'devices.port'] })
    expect(result.rows[0]).toMatchObject({ key: 'appearance.theme', value: 'dark', default: 'system', changed: true, path: 'Settings › Appearance › Theme', takes: 'system | light | dark' })
    expect(result.rows[1].path).toContain('Remote workspaces')
    // No row in Settings: the page name stands in.
    expect(result.rows[2].path).toBe('Settings › Data & devices')
    expect(result.text).toContain('Settings › Appearance › Theme')
  })

  it('answers an unknown key with the suggestion and the not-found code', async () => {
    const { call } = rig()
    const err = await failure(call('settings-get', { keys: ['appearance.theme', 'themes'] }))
    expect(err.code).toBe('not-found')
    expect(err.message).toMatch(/Did you mean 'appearance\.theme'/)
  })

  it('has a row in keys for every setting, with its page, title and what it takes', async () => {
    const { call } = rig()
    const keys = await call<SettingsKeysResult>('settings-keys', {})
    expect(keys.keys.map((k) => k.key)).toEqual(SETTINGS_SCHEMA.map((s) => s.key))
    expect(keys.keys.find((k) => k.key === 'appearance.zoom')).toMatchObject({ type: 'number', takes: 'number 0.5-2 in steps of 0.1', page: 'appearance' })
    expect(keys.keys.every((k) => k.title && k.takes)).toBe(true)
    expect(keys.text).toContain('appearance.theme')
  })

  it('searches the registry and names the key of each row, or none', async () => {
    const { call } = rig()
    const result = await call<SettingsSearchResult>('settings-search', { query: 'theme dark colors' })
    const theme = result.rows.find((r) => r.id === 'theme')
    expect(theme?.cli).toEqual([{ scope: 'settings', key: 'appearance.theme' }])
    expect(result.text).toContain('cli: foreman settings set appearance.theme <system | light | dark>')
    const repoRow = (await call<SettingsSearchResult>('settings-search', { query: 'run mode concurrent scripts' })).rows.find((r) => r.cli.some((c) => c.scope === 'repo settings'))
    expect(repoRow?.cli[0]).toEqual({ scope: 'repo settings', key: 'scripts.run-mode' })
    expect((await call<SettingsSearchResult>('settings-search', { query: 'zzzz qqqq' })).text).toContain('Nothing in Settings matches')
    // Some row has no key at all.
    const all = await call<SettingsSearchResult>('settings-search', { query: 'pane sizes' })
    expect(all.rows.some((r) => r.cli.length === 0)).toBe(true)
    expect(all.text).toContain('cli: none')
  })

  it('gives the path and, with open, shows the row in the window', async () => {
    const shown: string[] = []
    const { call } = rig({}, {}, { showSetting: (id) => void shown.push(id) })
    const plain = await call<SettingsPathResult>('settings-path', { key: 'appearance.theme' })
    expect(plain).toMatchObject({ path: 'Settings › Appearance › Theme', opened: false })
    expect(shown).toEqual([])
    const opened = await call<SettingsPathResult>('settings-path', { key: 'appearance.theme', open: true })
    expect(opened.opened).toBe(true)
    expect(shown).toEqual(['theme'])
    // A key with no row can be named but not opened.
    expect((await failure(call('settings-path', { key: 'devices.port', open: true }))).code).toBe('not-supported')
    expect((await failure(call('settings-path', { key: 'nope' }))).code).toBe('not-found')
  })
})

describe('settings export and import', () => {
  it('exports every plain setting by key, in the spelling the command takes', async () => {
    const { call } = rig({ theme: 'dark', claudeAuth: 'apiKey', envFiles: ['a.env'], zoom: 1.5, openInDefault: '' })
    const { settings } = await call<SettingsExportResult>('settings-export', {})
    expect(Object.keys(settings)).toEqual(SETTINGS_SCHEMA.map((s) => s.key))
    expect(settings['appearance.theme']).toBe('dark')
    expect(settings['agents.claude-auth']).toBe('api-key')
    expect(settings['environment.env-files']).toEqual(['a.env'])
    expect(settings['appearance.zoom']).toBe(1.5)
    expect(settings['general.open-in-default']).toBe('auto')
    expect(settings['appearance.code-ligatures']).toBe(true)
  })

  it('round-trips: importing an export changes nothing', async () => {
    const { call, calls } = rig({ theme: 'dark', claudeAuth: 'apiKey', openInPaths: { zed: path.resolve('/bin/zed') }, envFiles: ['a.env'] })
    const { settings } = await call<SettingsExportResult>('settings-export', {})
    const result = await call<SettingsImportResult>('settings-import', { values: settings })
    expect(result.rows).toEqual([])
    expect(result.applied).toBe(false)
    expect(calls).toEqual([])
  })

  it('shows what would change for a dry run and writes nothing', async () => {
    const { call, calls } = rig({ theme: 'dark' })
    const result = await call<SettingsImportResult>('settings-import', { values: { 'appearance.theme': 'light', 'appearance.zoom': 1, 'environment.env-files': ['x.env'] }, dryRun: true })
    expect(result.rows).toEqual([
      { key: 'appearance.theme', from: 'dark', to: 'light' },
      { key: 'environment.env-files', from: '(none)', to: 'x.env' }
    ])
    expect(result.unchanged).toBe(1)
    expect(result.applied).toBe(false)
    expect(result.text).toContain('Would change 2 settings')
    expect(calls).toEqual([])
  })

  it('applies an import through the same owners as set', async () => {
    const { call, calls } = rig({ theme: 'dark', mobileUrl: 'https://p.example' })
    const result = await call<SettingsImportResult>('settings-import', { values: { 'appearance.theme': 'light', 'devices.mobile': true, 'environment.env-files': ['x.env'] } })
    expect(result.applied).toBe(true)
    expect(calls).toContainEqual(['updateSettings', { theme: 'light' }])
    expect(calls).toContainEqual(['mobileConfigure', true, 'https://p.example'])
    expect(calls).toContainEqual(['setEnvFiles', { kind: 'user' }, ['x.env']])
  })

  it('writes nothing when one value is invalid', async () => {
    const { call, calls } = rig()
    const err = await failure(call('settings-import', { values: { 'appearance.theme': 'light', 'appearance.zoom': 9 } }))
    expect(err.code).toBe('invalid')
    expect(calls).toEqual([])
    expect((await failure(call('settings-import', { values: { 'appearance.themes': 'x' } }))).code).toBe('not-found')
  })
})
