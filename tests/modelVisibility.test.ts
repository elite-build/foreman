import { afterEach, describe, expect, it } from 'vitest'
import { modelInfo, setModelCatalog, type ModelInfo } from '../src/shared/agents'
import {
  contextSize,
  hiddenCount,
  isModelHidden,
  knownContextWindow,
  modelUses,
  parseHiddenModels,
  pickerModels,
  setModelHidden,
  showAllModels
} from '../src/shared/modelVisibility'
import { chooseStartLoadout } from '../src/shared/startModel'
import { defaultSettings, Store } from '../src/main/store'
import { tempDir } from './helpers'

afterEach(() => setModelCatalog({}))

const claude = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, agent: 'claude', label: id, efforts: [], supportsFast: false, contextWindow: 200_000, ...extra })

const LIST = [claude('fable'), claude('opus[1m]'), claude('sonnet'), claude('haiku'), claude('opus-4-7')]

describe('O8 persistence shape', () => {
  it('stores a set of hidden ids per agent and drops an agent once nothing is hidden', () => {
    let hidden = setModelHidden({}, 'claude', 'sonnet', true)
    hidden = setModelHidden(hidden, 'claude', 'opus-4-7', true)
    hidden = setModelHidden(hidden, 'codex', 'gpt-5.5', true)
    expect(hidden).toEqual({ claude: ['sonnet', 'opus-4-7'], codex: ['gpt-5.5'] })
    // Hiding twice doesn't duplicate.
    expect(setModelHidden(hidden, 'claude', 'sonnet', true).claude).toEqual(['opus-4-7', 'sonnet'])
    hidden = setModelHidden(hidden, 'codex', 'gpt-5.5', false)
    expect(hidden).toEqual({ claude: ['sonnet', 'opus-4-7'] })
    expect(showAllModels(hidden, 'claude')).toEqual({})
  })

  it('checks what it loads: unknown agents, non-strings and duplicates go', () => {
    expect(parseHiddenModels({ claude: ['a', 'a', 3, ''], codex: 'x', robot: ['y'], cursor: [] })).toEqual({ claude: ['a'] })
    expect(parseHiddenModels(null)).toEqual({})
    expect(parseHiddenModels(['claude'])).toEqual({})
  })

  it('starts with nothing hidden and keeps the set across a restart, cleaned on load', async () => {
    expect(defaultSettings().hiddenModels).toEqual({})
    const dir = await tempDir('foreman-o8-')
    const store = new Store(dir)
    await store.load()
    ;(store.state.settings as unknown as Record<string, unknown>).hiddenModels = { claude: ['sonnet', 'sonnet', 7], robot: ['x'] }
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.hiddenModels).toEqual({ claude: ['sonnet'] })
    again.close()
    store.close()
  })
})

describe('O8 picker filtering', () => {
  it('omits hidden models and counts them', () => {
    const hidden = { claude: ['sonnet', 'opus-4-7'] }
    const { shown, hidden: rest } = pickerModels(LIST, hidden)
    expect(shown.map((m) => m.id)).toEqual(['fable', 'opus[1m]', 'haiku'])
    expect(rest.map((m) => m.id)).toEqual(['sonnet', 'opus-4-7'])
    expect(hiddenCount(LIST, hidden)).toBe(2)
  })

  it('shows models the agent adds later', () => {
    const hidden = { claude: ['sonnet'] }
    const grown = [...LIST, claude('opus-6')]
    expect(pickerModels(grown, hidden).shown.map((m) => m.id)).toContain('opus-6')
    expect(hiddenCount(grown, hidden)).toBe(1)
  })

  it('always shows the selected model, even when hidden', () => {
    const hidden = { claude: ['sonnet', 'opus-4-7'] }
    const { shown, hidden: rest } = pickerModels(LIST, hidden, { agent: 'claude', model: 'sonnet' })
    expect(shown.map((m) => m.id)).toEqual(['fable', 'opus[1m]', 'sonnet', 'haiku'])
    expect(rest.map((m) => m.id)).toEqual(['opus-4-7'])
    // Another agent's selection doesn't unhide anything.
    expect(pickerModels(LIST, hidden, { agent: 'codex', model: 'sonnet' }).hidden).toHaveLength(2)
  })

  it('matches a saved full id to the alias the agent lists', () => {
    setModelCatalog({ claude: [claude('opus[1m]', { aliases: ['claude-opus-5-5', 'claude-opus-5-5[1m]'] })] })
    const hidden = { claude: ['opus[1m]'] }
    expect(isModelHidden(hidden, 'claude', 'claude-opus-5-5[1m]')).toBe(true)
    expect(pickerModels([modelInfo('claude', 'opus[1m]')], hidden, { agent: 'claude', model: 'claude-opus-5-5[1m]' }).shown).toHaveLength(1)
  })

  it('ignores stale ids the agent no longer lists in the count', () => {
    expect(hiddenCount(LIST, { claude: ['gone', 'haiku'] })).toBe(1)
  })
})

describe('O8 loadout and template references', () => {
  const loadouts = [
    { agent: 'claude' as const, model: 'opus[1m]', effort: 'high' as const, fast: false },
    { agent: 'codex' as const, model: 'sonnet', fast: false },
    { agent: 'claude' as const, model: 'sonnet', effort: 'medium' as const, fast: false }
  ]
  const templates = [{ startModel: { agent: 'claude' as const, model: 'opus-4-7' } }, {}]

  it('says which loadouts and templates use a model, by loadout number and agent', () => {
    expect(modelUses('claude', 'sonnet', loadouts, templates)).toEqual({ loadouts: [3], template: false })
    expect(modelUses('claude', 'opus-4-7', loadouts, templates)).toEqual({ loadouts: [], template: true })
    expect(modelUses('claude', 'haiku', loadouts, templates)).toEqual({ loadouts: [], template: false })
  })

  it('leaves a hidden model usable: lookups and template start models are untouched', () => {
    setModelCatalog({ claude: LIST })
    const hidden = { claude: ['sonnet', 'opus-4-7'] }
    expect(isModelHidden(hidden, 'claude', 'sonnet')).toBe(true)
    // The loadout's model still resolves to the real entry, not a generic one.
    expect(modelInfo('claude', loadouts[2].model)).toBe(LIST[2])
    expect(chooseStartLoadout(undefined, templates[0]).loadout).toMatchObject({ agent: 'claude', model: 'opus-4-7' })
  })
})

describe('O8 context sizes', () => {
  it('uses Foreman’s table or Claude Code’s [1m] marker, and otherwise says unknown', () => {
    expect(knownContextWindow({ ...claude('claude-haiku-5-5') })).toBe(200_000)
    expect(knownContextWindow(claude('haiku', { aliases: ['claude-haiku-5-5', 'claude-haiku-5-5[1m]'] }))).toBe(200_000)
    expect(knownContextWindow(claude('opus[1m]'))).toBe(1_000_000)
    // The plain alias isn't the [1m] model, so the table's 1M entry doesn't apply.
    expect(knownContextWindow(claude('opus', { aliases: ['claude-opus-5-5', 'claude-opus-5-5[1m]'] }))).toBeUndefined()
    expect(knownContextWindow(claude('claude-opus-4-7'))).toBeUndefined()
    expect(knownContextWindow({ id: 'gpt-6.1-sol', agent: 'codex', label: '', efforts: [], supportsFast: false, contextWindow: 475_000 })).toBe(475_000)
    expect(knownContextWindow({ id: 'anthropic/x', agent: 'opencode', label: '', efforts: [], supportsFast: false, contextWindow: 200_000 })).toBeUndefined()
  })

  it('formats sizes', () => {
    expect(contextSize(1_000_000)).toBe('1M')
    expect(contextSize(200_000)).toBe('200k')
    expect(contextSize(475_000)).toBe('475k')
  })
})
