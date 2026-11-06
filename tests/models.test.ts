import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toModelInfo } from '../src/main/agents/claude'
import { codexContextWindows, toCodexModelInfo, type CodexModel } from '../src/main/agents/codex'
import { toCursorModelInfo } from '../src/main/agents/cursor'
import { defaultModel, modelInfo, modelsFor, setModelCatalog } from '../src/shared/agents'

afterEach(() => setModelCatalog({}))

describe('Claude model list', () => {
  it('labels models by name and version and keeps the resolved id as an alias', () => {
    const m = toModelInfo({
      value: 'opus',
      resolvedModel: 'claude-opus-5-5',
      displayName: 'Opus',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true
    })
    expect(m).toMatchObject({ id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks', supportsFast: true, defaultEffort: 'high' })
    expect(m.aliases).toContain('claude-opus-5-5[1m]')
  })

  it('falls back to the display name when the description has no version', () => {
    const m = toModelInfo({ value: 'custom', displayName: 'My model', description: 'Something the admin set up' })
    expect(m.label).toBe('My model')
    expect(m.efforts).toEqual([])
  })
})

describe('Codex model list', () => {
  const base: CodexModel = {
    id: 'gpt-6.1-sol',
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'persistent' }],
    defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'priority' }],
    isDefault: true
  }

  it('maps names, efforts and the fast tier', () => {
    const m = toCodexModelInfo(base)
    expect(m).toMatchObject({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['none', 'low', 'ultra'], defaultEffort: 'low', supportsFast: true, isDefault: true })
  })

  it('leaves names without a suffix alone and reports no fast tier', () => {
    const m = toCodexModelInfo({ ...base, model: 'gpt-5.5', displayName: 'GPT-5.5', serviceTiers: [], isDefault: false })
    expect(m.label).toBe('GPT-5.5')
    expect(m.supportsFast).toBe(false)
  })

  it('uses the working window Codex reports, else the built-in table or the generic fallback', () => {
    const windows = new Map([['gpt-6-astra', 272_000]])
    expect(toCodexModelInfo({ ...base, model: 'gpt-6-astra' }, windows)).toMatchObject({ contextWindow: 272_000, contextReported: true })
    const listed = toCodexModelInfo(base, windows)
    expect(listed.contextWindow).toBe(500_000)
    expect(listed.contextReported).toBeUndefined()
    expect(toCodexModelInfo({ ...base, model: 'gpt-7-new' }).contextWindow).toBe(200_000)
  })

  it('reads working windows from Codex’s model cache, skipping bad entries', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'))
    try {
      expect((await codexContextWindows(home)).size).toBe(0)
      await writeFile(
        path.join(home, 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }, { slug: 'gpt-6.1-sol', context_window: 500_000 }, { slug: 'broken', context_window: '1' }, { context_window: 9 }] })
      )
      expect([...(await codexContextWindows(home))]).toEqual([['gpt-6-astra', 272_000], ['gpt-6.1-sol', 500_000]])
      await writeFile(path.join(home, 'models_cache.json'), '{not json')
      expect((await codexContextWindows(home)).size).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('Cursor model list', () => {
  it('reads effort and fast parameters from the catalog entry', () => {
    const m = toCursorModelInfo({
      id: 'grok-5',
      displayName: 'Grok 5',
      parameters: [
        { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
        { id: 'fast', values: [{ value: 'true' }, { value: 'false' }] }
      ]
    })
    expect(m).toMatchObject({ label: 'Grok 5', efforts: ['low', 'high'], defaultEffort: 'high', supportsFast: true })
  })
})

describe('live catalog lookups', () => {
  it('prefers what the agent reported and matches aliases', () => {
    setModelCatalog({ claude: [{ id: 'opus', agent: 'claude', label: 'Opus 5.5', aliases: ['claude-opus-5-5', 'claude-opus-5-5[1m]'], efforts: ['high'], supportsFast: true, contextWindow: 200_000 }] })
    expect(modelsFor('claude').map((m) => m.id)).toEqual(['opus'])
    expect(modelInfo('claude', 'claude-opus-5-5[1m]').label).toBe('Opus 5.5')
    expect(defaultModel('claude')).toBe('opus')
  })

  it('uses the built-in list until the agent answers', () => {
    expect(modelsFor('codex').length).toBeGreaterThan(0)
    expect(modelInfo('opencode', 'deepseek/v4').label).toBe('deepseek/v4')
  })
})
