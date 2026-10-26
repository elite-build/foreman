import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOADOUTS, type Loadout, type ModelInfo } from '../src/shared/agents'
import type { AgentsListResult, AgentsStatusResult, LoadoutsResult, ModelsListResult, ModelsVisibilityResult } from '../src/shared/cli/agents'
import { AGENTS_METHODS } from '../src/main/cli/agents'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { defaultSettings } from '../src/main/store'
import type { Api, AppSnapshot, Settings } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const model = (agent: ModelInfo['agent'], id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ id, agent, label: id, efforts: ['low', 'high'], defaultEffort: 'high', supportsFast: false, contextWindow: 200_000, ...over })

const CLAUDE = [model('claude', 'claude-opus-5-5[1m]', { label: 'Opus 5.5', supportsFast: true, contextWindow: 1_000_000 }), model('claude', 'claude-sonnet-5-5[1m]', { label: 'Sonnet 5.5' }), model('claude', 'claude-haiku-5-5', { label: 'Haiku 5.5', efforts: [], defaultEffort: undefined })]

function snapshot(agents: AppSnapshot['catalog']['agents'] = { claude: { models: CLAUDE } }): AppSnapshot {
  return { catalog: { agents, outputStyles: [] }, settings: defaultSettings() } as unknown as AppSnapshot
}

function setup(over: { settings?: Partial<Settings>; api?: Partial<Api>; agents?: AppSnapshot['catalog']['agents'] } = {}) {
  const settings = { ...defaultSettings(), ...over.settings }
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => ({ ...settings, ...patch }) as Settings)
  const host = stubHost({
    state: () => ({ repos: [], workspaces: [], sessions: [], settings }),
    snapshot: () => snapshot(over.agents),
    api: fakeApi({ updateSettings, ...over.api })
  })
  const call = <T>(method: string, params?: unknown) => AGENTS_METHODS[method].handle(host, params, ctx) as Promise<T>
  return { host, call, updateSettings, settings }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the agents methods', () => {
  it('puts every method in a tier: lists and statuses read, every change admin', () => {
    const tiers = Object.fromEntries(Object.entries(AGENTS_METHODS).map(([name, m]) => [name, m.tier]))
    expect(tiers).toEqual({
      'loadouts-list': 'read',
      'loadouts-set': 'admin',
      'loadouts-add': 'admin',
      'loadouts-remove': 'admin',
      'loadouts-move': 'admin',
      'review-model-get': 'read',
      'review-model-set': 'admin',
      'models-list': 'read',
      'models-hide': 'admin',
      'models-show': 'admin',
      'models-refresh': 'admin',
      'agents-list': 'read',
      'agents-enable': 'admin',
      'agents-disable': 'admin',
      'agents-auth': 'admin',
      'agents-path': 'admin',
      'agents-status': 'read'
    })
  })

  describe('loadouts', () => {
    it('lists the slots with the model names', async () => {
      const { call } = setup()
      const result = await call<LoadoutsResult>('loadouts-list')
      expect(result.loadouts.map((l) => [l.slot, l.agent, l.model])).toEqual(DEFAULT_LOADOUTS.map((l, i) => [i + 1, l.agent, l.model]))
      expect(result.loadouts[0].modelLabel).toBe('Opus 5.5')
      expect(result.text).toContain('Slot 1 is the default')
    })

    it('set checks the agent and saves the whole new array through updateSettings', async () => {
      const { call, updateSettings } = setup()
      const result = await call<LoadoutsResult>('loadouts-set', { slot: 2, agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low' })
      const expected: Loadout[] = [DEFAULT_LOADOUTS[0], { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low', fast: false }, DEFAULT_LOADOUTS[2]]
      expect(updateSettings).toHaveBeenCalledWith({ loadouts: expected })
      expect(result.loadouts[1]).toMatchObject({ slot: 2, model: 'claude-sonnet-5-5[1m]', effort: 'low', modelLabel: 'Sonnet 5.5' })
    })

    it('set takes the model’s default effort when none is given', async () => {
      const { call, updateSettings } = setup()
      await call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-sonnet-5-5[1m]' })
      expect(updateSettings.mock.calls[0][0].loadouts![0]).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'high', fast: false })
    })

    it('set refuses an unknown agent, a terminal agent, an unlisted model, a bad effort and fast on a model without it, and saves nothing', async () => {
      const { call, updateSettings } = setup()
      expect((await failure(call('loadouts-set', { slot: 1, agent: 'nope', model: 'x' }))).message).toMatch(/Unknown agent “nope”/)
      expect((await failure(call('loadouts-set', { slot: 1, agent: 'aider', model: 'x' }))).message).toMatch(/terminal agent/)
      const unlisted = await failure(call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-nope' }))
      expect(unlisted.code).toBe('invalid')
      expect(unlisted.message).toContain('claude-opus-5-5[1m]')
      expect((await failure(call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-haiku-5-5', effort: 'high' }))).message).toMatch(/no adjustable effort/)
      expect((await failure(call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'max' }))).message).toMatch(/takes these efforts: low, high/)
      expect((await failure(call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-sonnet-5-5[1m]', fast: true }))).message).toMatch(/no fast mode/)
      expect((await failure(call('loadouts-set', { slot: 9, agent: 'claude', model: 'claude-sonnet-5-5[1m]' }))).message).toMatch(/no slot 9/)
      expect(updateSettings).not.toHaveBeenCalled()
    })

    it('set accepts a model of an agent whose list Foreman does not have yet, and says it did not check', async () => {
      const { call, updateSettings } = setup()
      const result = await call<LoadoutsResult>('loadouts-set', { slot: 3, agent: 'codex', model: 'gpt-next', effort: 'medium' })
      expect(updateSettings.mock.calls[0][0].loadouts![2]).toEqual({ agent: 'codex', model: 'gpt-next', effort: 'medium', fast: false })
      expect(result.note).toMatch(/wasn’t checked/)
    })

    it('set keeps the effort and fast mode of a slot when only the other changes', async () => {
      const { call, updateSettings } = setup({ settings: { loadouts: [{ agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'low', fast: true }] } })
      await call('loadouts-set', { slot: 1, agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high' })
      expect(updateSettings.mock.calls[0][0].loadouts).toEqual([{ agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: true }])
    })

    it('add appends a slot, up to five', async () => {
      const { call, updateSettings } = setup()
      await call('loadouts-add', { agent: 'claude', model: 'claude-haiku-5-5' })
      expect(updateSettings.mock.calls[0][0].loadouts).toHaveLength(4)
      expect(updateSettings.mock.calls[0][0].loadouts![3]).toEqual({ agent: 'claude', model: 'claude-haiku-5-5', fast: false })
      const full = setup({ settings: { loadouts: [...DEFAULT_LOADOUTS, DEFAULT_LOADOUTS[0], DEFAULT_LOADOUTS[1]] } })
      expect((await failure(full.call('loadouts-add', { agent: 'claude', model: 'claude-haiku-5-5' }))).message).toMatch(/All 5 slots/)
    })

    it('remove drops a slot but refuses the last one', async () => {
      const { call, updateSettings } = setup()
      await call('loadouts-remove', { slot: 2 })
      expect(updateSettings).toHaveBeenCalledWith({ loadouts: [DEFAULT_LOADOUTS[0], DEFAULT_LOADOUTS[2]] })

      const only = setup({ settings: { loadouts: [DEFAULT_LOADOUTS[0]] } })
      const refused = await failure(only.call('loadouts-remove', { slot: 1 }))
      expect(refused.message).toMatch(/only slot/)
      expect(only.updateSettings).not.toHaveBeenCalled()
    })

    it('move reorders like a drag', async () => {
      const { call, updateSettings } = setup()
      await call('loadouts-move', { from: 3, to: 1 })
      expect(updateSettings).toHaveBeenCalledWith({ loadouts: [DEFAULT_LOADOUTS[2], DEFAULT_LOADOUTS[0], DEFAULT_LOADOUTS[1]] })
      expect((await failure(call('loadouts-move', { from: 0, to: 1 }))).code).toBe('invalid')
    })
  })

  describe('the review model', () => {
    it('reads and sets it', async () => {
      const { call, updateSettings } = setup()
      const got = await call<{ reviewModel: { agent: string; model: string }; text: string }>('review-model-get')
      expect(got.reviewModel).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5[1m]' })
      await call('review-model-set', { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low' })
      expect(updateSettings).toHaveBeenCalledWith({ reviewModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low', fast: false } })
    })
  })

  describe('models', () => {
    it('lists the picker’s models, and with --all the hidden ones marked, with context sizes', async () => {
      const { call } = setup({ settings: { hiddenModels: { claude: ['claude-haiku-5-5'] } } })
      const picker = await call<ModelsListResult>('models-list', { agent: 'claude' })
      expect(picker.agents[0].models.map((m) => m.id)).toEqual(['claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]'])
      expect(picker.agents[0].omitted).toBe(1)
      expect(picker.text).toContain('1M')
      const all = await call<ModelsListResult>('models-list', { agent: 'claude', all: true })
      expect(all.agents[0].models.find((m) => m.id === 'claude-haiku-5-5')).toMatchObject({ hidden: true, inPicker: false })
      expect(all.text).toContain('hidden')
    })

    it('hide builds the hiddenModels setting; show takes ids out of it', async () => {
      const { call, updateSettings } = setup()
      const hid = await call<ModelsVisibilityResult>('models-hide', { agent: 'claude', models: ['claude-haiku-5-5', 'claude-sonnet-5-5[1m]'] })
      expect(updateSettings).toHaveBeenCalledWith({ hiddenModels: { claude: ['claude-haiku-5-5', 'claude-sonnet-5-5[1m]'] } })
      expect(hid.hidden).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5[1m]'])

      const shown = setup({ settings: { hiddenModels: { claude: ['claude-haiku-5-5', 'claude-sonnet-5-5[1m]'] } } })
      await shown.call('models-show', { agent: 'claude', models: ['claude-haiku-5-5'] })
      expect(shown.updateSettings).toHaveBeenCalledWith({ hiddenModels: { claude: ['claude-sonnet-5-5[1m]'] } })
      const last = setup({ settings: { hiddenModels: { claude: ['claude-haiku-5-5'] } } })
      await last.call('models-show', { agent: 'claude', models: ['claude-haiku-5-5'] })
      expect(last.updateSettings).toHaveBeenCalledWith({ hiddenModels: {} })
    })

    it('hide says what still uses a hidden model, and refuses a model the agent does not list', async () => {
      const { call } = setup()
      const result = await call<ModelsVisibilityResult>('models-hide', { agent: 'claude', models: ['claude-opus-5-5[1m]'] })
      expect(result.stillUsed).toEqual(['claude-opus-5-5[1m] (loadout 1)'])
      expect((await failure(call('models-hide', { agent: 'claude', models: ['claude-nope'] }))).message).toMatch(/doesn’t list a model “claude-nope”/)
    })

    it('refresh asks the agent and reports what it listed', async () => {
      const refreshModels = vi.fn(async () => undefined)
      const { call } = setup({ api: { refreshModels } })
      const result = await call<{ agents: { agent: string; models: number }[]; text: string }>('models-refresh', { agent: 'claude' })
      expect(refreshModels).toHaveBeenCalledWith('claude')
      expect(result.agents).toEqual([{ agent: 'claude', models: 3 }])
    })
  })

  describe('agents', () => {
    it('lists the catalog with enabled, installed, sign-in and ready', async () => {
      const agentCatalog = vi.fn(async () => ({
        detections: { claude: { id: 'claude', installed: true, version: '9.9.9', path: '/bin/claude', checkedAt: '' }, aider: { id: 'aider', installed: false, checkedAt: '' } },
        statuses: { claude: { agent: 'claude' as const, installed: true, ready: true, version: '9.9.9', method: 'Claude Max account' } },
        acp: {},
        shellKeys: {},
        shellProviderKeys: [],
        savedProviderKeys: []
      }))
      const { call } = setup({ api: { agentCatalog } })
      const result = await call<AgentsListResult>('agents-list', { refresh: true })
      expect(agentCatalog).toHaveBeenCalledWith(true)
      const claude = result.agents.find((a) => a.id === 'claude')!
      expect(claude).toMatchObject({ level: 'full', enabled: true, installed: true, version: '9.9.9', auth: 'login', ready: true, method: 'Claude Max account' })
      expect(result.agents.find((a) => a.id === 'aider')).toMatchObject({ level: 'terminal', enabled: false, installed: false })
      expect(result.text).toMatch(/claude\s+Claude Code\s+full\s+on/)
    })

    it('enable and disable write agentPrefs', async () => {
      const { call, updateSettings } = setup()
      await call('agents-enable', { id: 'gemini' })
      expect(updateSettings).toHaveBeenCalledWith({ agentPrefs: { gemini: { enabled: true } } })
      const on = setup({ settings: { agentPrefs: { gemini: { enabled: true, path: '/x/gemini' } } } })
      await on.call('agents-disable', { id: 'gemini' })
      expect(on.updateSettings).toHaveBeenCalledWith({ agentPrefs: { gemini: { enabled: false, path: '/x/gemini' } } })
      expect((await failure(call('agents-enable', { id: 'nope' }))).code).toBe('invalid')
    })

    it('disable refuses an agent a loadout uses and names the slot', async () => {
      const { call, updateSettings } = setup()
      const refused = await failure(call('agents-disable', { id: 'codex' }))
      expect(refused.code).toBe('invalid')
      expect(refused.message).toContain('loadout 3')
      expect(refused.hint).toContain('foreman loadouts set 3')
      const review = await failure(call('agents-disable', { id: 'claude' }))
      expect(review.message).toContain('loadout 1, loadout 2 and the review model')
      expect(updateSettings).not.toHaveBeenCalled()
    })

    it('auth: claude and codex go to their own settings, other agents to agentPrefs, and an agent with one method has nothing to switch', async () => {
      const { call, updateSettings } = setup()
      await call('agents-auth', { id: 'claude', mode: 'api-key' })
      expect(updateSettings).toHaveBeenLastCalledWith({ claudeAuth: 'apiKey' })
      await call('agents-auth', { id: 'codex', mode: 'login' })
      expect(updateSettings).toHaveBeenLastCalledWith({ codexAuth: 'cli' })
      const result = await call<{ text: string }>('agents-auth', { id: 'claude', mode: 'api-key' })
      expect(result.text).toContain('foreman agents key claude --stdin')
      expect((await failure(call('agents-auth', { id: 'claude', mode: 'token' }))).code).toBe('invalid')
      expect((await failure(call('agents-auth', { id: 'aider', mode: 'login' }))).message).toMatch(/no confirmed sign-in|signs in only/)
    })

    it('path: the three with their own setting write it, others go to agentPrefs, --clear empties it', async () => {
      const { call, updateSettings } = setup()
      await call('agents-path', { id: 'claude', path: 'C:\\tools\\claude.exe' })
      expect(updateSettings).toHaveBeenLastCalledWith({ claudeExecutablePath: expect.stringContaining('claude.exe') })
      await call('agents-path', { id: 'opencode', clear: true })
      expect(updateSettings).toHaveBeenLastCalledWith({ opencodeExecutablePath: '' })
      await call('agents-path', { id: 'gemini', path: 'gemini-nightly' })
      expect(updateSettings).toHaveBeenLastCalledWith({ agentPrefs: { gemini: { path: 'gemini-nightly' } } })
      const withPath = setup({ settings: { agentPrefs: { gemini: { path: '/x', auth: 'apiKey' } } } })
      await withPath.call('agents-path', { id: 'gemini', clear: true })
      expect(withPath.updateSettings).toHaveBeenLastCalledWith({ agentPrefs: { gemini: { auth: 'apiKey' } } })
      expect((await failure(call('agents-path', { id: 'claude' }))).code).toBe('invalid')
      expect((await failure(call('agents-path', { id: 'claude', path: 'x', clear: true }))).code).toBe('invalid')
    })

    it('status combines Foreman’s check of a full agent with its own sign-in answer', async () => {
      const agentStatus = vi.fn(async () => ({ agent: 'claude' as const, installed: true, ready: false, version: '1.0.0', detail: 'Not signed in' }))
      const agentSignInStatus = vi.fn(async () => ({ signedIn: false, output: 'Not logged in' }))
      const { call } = setup({ api: { agentStatus, agentSignInStatus } })
      const result = await call<AgentsStatusResult>('agents-status', { id: 'claude' })
      expect(agentStatus).toHaveBeenCalledWith('claude')
      expect(agentSignInStatus).toHaveBeenCalledWith('claude')
      expect(result.status).toMatchObject({ installed: true, ready: false, version: '1.0.0' })
      expect(result.signIn).toMatchObject({ signedIn: false })
      expect(result.text).toContain('not signed in')
    })

    it('status of a chat agent asks only for its sign-in', async () => {
      const agentSignInStatus = vi.fn(async () => null)
      const { call } = setup({ api: { agentSignInStatus } })
      const result = await call<AgentsStatusResult>('agents-status', { id: 'gemini' })
      expect(result.status).toBeUndefined()
      expect(result.text).toContain('unknown')
    })
  })
})
