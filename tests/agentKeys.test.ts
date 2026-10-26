// #22: per-agent keys. A key reaches only its agent, only in API-key mode; the
// old user-variable keys move once without changing what Claude Code, Codex and
// Cursor get; import never overwrites; shared provider keys go only where ticked.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowedProviderKeys, keyAgents, parseProviderKeyAgents, toggleKeyAgent } from '../src/shared/agentCatalog'
import type { Settings } from '../src/shared/types'
import { agentEnv } from '../src/main/agents/env'
import { AgentCatalogService, LEGACY_AGENT_KEYS } from '../src/main/agentCatalogService'
import { Environment } from '../src/main/environment'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { tempDir } from './helpers'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

function settings(over: Partial<Settings> = {}): Settings {
  return { claudeAuth: 'cli', codexAuth: 'cli', agentPrefs: {}, providerKeyAgents: {}, envFiles: [], ...over } as unknown as Settings
}

// Shell credentials the tests plant, removed again afterwards.
const SHELL = { OPENAI_API_KEY: 'sk-shell-openai', GROQ_API_KEY: 'gsk-shell', GEMINI_API_KEY: 'shell-gemini', ANTHROPIC_API_KEY: 'sk-ant-shell' }
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(SHELL).map((k) => [k, process.env[k]]))
  Object.assign(process.env, SHELL)
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('agentEnv: per-agent keys', () => {
  it('passes an agent’s own key only to it, and only in API-key mode', () => {
    const own = { GEMINI_API_KEY: 'AIza-own' }
    const loginMode = agentEnv('gemini', settings(), {}, {}, {}, own)
    // Login mode: neither the saved key nor the one in the shell.
    expect(loginMode.GEMINI_API_KEY).toBeUndefined()
    expect(loginMode.GOOGLE_API_KEY).toBeUndefined()
    const keyMode = agentEnv('gemini', settings({ agentPrefs: { gemini: { auth: 'apiKey' } } }), {}, {}, {}, own)
    expect(keyMode.GEMINI_API_KEY).toBe('AIza-own')
    // Another agent never sees it, even handed the same table by mistake.
    expect(agentEnv('qwen', settings(), {}, {}, {}, {}).GEMINI_API_KEY).toBeUndefined()
    expect(agentEnv('amp', settings({ agentPrefs: { amp: { auth: 'apiKey' } } }), {}, {}, {}, own).GEMINI_API_KEY).toBeUndefined()
  })

  it('strips provider keys in the shell from Chat and Terminal agents, but not from OpenCode', () => {
    const aider = agentEnv('aider', settings(), {})
    expect(aider.OPENAI_API_KEY).toBeUndefined()
    expect(aider.GROQ_API_KEY).toBeUndefined()
    const opencode = agentEnv('opencode', settings(), {})
    expect(opencode.OPENAI_API_KEY).toBe('sk-shell-openai')
    expect(opencode.GROQ_API_KEY).toBe('gsk-shell')
  })

  it('gives unconfirmed agents no keys at all', () => {
    const env = agentEnv('kimchi', settings({ providerKeyAgents: { OPENAI_API_KEY: ['kimchi'] } }), {}, { OPENAI_API_KEY: 'sk-saved' }, {}, { KIMCHI_API_KEY: 'x' })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.KIMCHI_API_KEY).toBeUndefined()
  })

  it('keeps Claude, Codex and Cursor exactly as before for the same key, now read from their own store', () => {
    // Before #22 the key was a user variable; now it's the agent's own. Same result either way.
    const before = (agent: 'claude' | 'codex' | 'cursor', s: Settings, name: string) => agentEnv(agent, s, { [name]: 'k-123' })
    const after = (agent: 'claude' | 'codex' | 'cursor', s: Settings, name: string) => agentEnv(agent, s, {}, {}, {}, { [name]: 'k-123' })
    const pick = (env: Record<string, string>) => ({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, CODEX_API_KEY: env.CODEX_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY, CURSOR_API_KEY: env.CURSOR_API_KEY })
    for (const mode of ['cli', 'apiKey'] as const) {
      const s = settings({ claudeAuth: mode, codexAuth: mode })
      expect(pick(after('claude', s, 'ANTHROPIC_API_KEY')), `claude ${mode}`).toEqual(pick(before('claude', s, 'ANTHROPIC_API_KEY')))
      expect(pick(after('codex', s, 'CODEX_API_KEY')), `codex ${mode}`).toEqual(pick(before('codex', s, 'CODEX_API_KEY')))
      expect(pick(after('cursor', s, 'CURSOR_API_KEY')), `cursor ${mode}`).toEqual(pick(before('cursor', s, 'CURSOR_API_KEY')))
    }
    // Spot checks: Claude's key in API-key mode, none in Login mode; Codex mirrors to OPENAI_API_KEY; the shell's Anthropic key never leaks.
    expect(after('claude', settings({ claudeAuth: 'apiKey' }), 'ANTHROPIC_API_KEY').ANTHROPIC_API_KEY).toBe('k-123')
    expect(after('claude', settings(), 'ANTHROPIC_API_KEY').ANTHROPIC_API_KEY).toBeUndefined()
    expect(after('codex', settings({ codexAuth: 'apiKey' }), 'CODEX_API_KEY').OPENAI_API_KEY).toBe('k-123')
    expect(after('cursor', settings(), 'CURSOR_API_KEY').CURSOR_API_KEY).toBe('k-123')
  })

  it('lets a repo variable still override an agent’s own key, as it overrode the user variable', () => {
    const env = agentEnv('claude', settings({ claudeAuth: 'apiKey' }), { ANTHROPIC_API_KEY: 'repo-key' }, {}, {}, { ANTHROPIC_API_KEY: 'own-key' })
    expect(env.ANTHROPIC_API_KEY).toBe('repo-key')
  })
})

describe('shared provider keys', () => {
  const keys = { OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-ant', GROQ_API_KEY: 'gsk' }

  it('gives OpenCode every key and other agents only the ones ticked for them', () => {
    const allow = { OPENAI_API_KEY: ['aider', 'goose'], ANTHROPIC_API_KEY: ['aider'] }
    expect(allowedProviderKeys('opencode', keys, allow)).toEqual(keys)
    expect(allowedProviderKeys('aider', keys, allow)).toEqual({ OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-ant' })
    expect(allowedProviderKeys('goose', keys, allow)).toEqual({ OPENAI_API_KEY: 'sk-1' })
    // New agents start with none.
    expect(allowedProviderKeys('crush', keys, allow)).toEqual({})
    // Agents that don't take shared keys never get them, even if a stale tick names them.
    expect(allowedProviderKeys('gemini', keys, { OPENAI_API_KEY: ['gemini'] })).toEqual({})
    expect(allowedProviderKeys('claude', keys, { OPENAI_API_KEY: ['claude'] })).toEqual({})
  })

  it('reaches the agent’s process through agentEnv', () => {
    const s = settings({ providerKeyAgents: { GROQ_API_KEY: ['aider'] } })
    const env = agentEnv('aider', s, {}, keys)
    expect(env.GROQ_API_KEY).toBe('gsk')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(agentEnv('crush', s, {}, keys).GROQ_API_KEY).toBeUndefined()
  })

  it('ticks and unticks, keeps OpenCode locked on, and cleans saved lists', () => {
    let allow = toggleKeyAgent({}, 'OPENAI_API_KEY', 'aider', true)
    allow = toggleKeyAgent(allow, 'OPENAI_API_KEY', 'goose', true)
    expect(allow).toEqual({ OPENAI_API_KEY: ['aider', 'goose'] })
    expect(keyAgents('OPENAI_API_KEY', allow)).toEqual(['opencode', 'aider', 'goose'])
    expect(toggleKeyAgent(allow, 'OPENAI_API_KEY', 'opencode', false)).toEqual(allow)
    allow = toggleKeyAgent(allow, 'OPENAI_API_KEY', 'aider', false)
    allow = toggleKeyAgent(allow, 'OPENAI_API_KEY', 'goose', false)
    expect(allow).toEqual({})
    expect(parseProviderKeyAgents({ OPENAI_API_KEY: ['aider', 'gemini', 'aider', 7], 'bad name': ['aider'], GROQ_API_KEY: [] })).toEqual({ OPENAI_API_KEY: ['aider'] })
  })
})

describe('migration and import', () => {
  async function store(content: object): Promise<{ secrets: SecretStore; file: string }> {
    const file = path.join(await tempDir('foreman-keys-'), 'secrets.bin')
    await writeFile(file, JSON.stringify(content))
    const secrets = new SecretStore(file, plain)
    secrets.load()
    return { secrets, file }
  }

  function service(secrets: SecretStore, shell: Record<string, string> = {}) {
    const changed: string[] = []
    const svc = new AgentCatalogService({
      secrets,
      settings: () => settings(),
      fullStatus: async (agent) => ({ agent, installed: false, ready: false }),
      agentEnv: () => ({}),
      executablePath: () => undefined,
      shell: () => shell,
      keysChanged: (agent) => void changed.push(agent)
    })
    return { svc, changed }
  }

  it('moves the Claude, Codex and Cursor keys out of the user variables into their own, once', async () => {
    const { secrets, file } = await store({
      version: 2,
      user: { ANTHROPIC_API_KEY: 'sk-ant-1234567890', CODEX_API_KEY: 'sk-codex-1234567890', CURSOR_API_KEY: 'cur-1234567890', OTHER: 'stays' },
      repos: {},
      providers: {},
      app: {}
    })
    const { svc } = service(secrets)
    expect(svc.migrateKeys()).toBe(true)
    expect(secrets.vars({ kind: 'user' })).toEqual({ OTHER: 'stays' })
    expect(secrets.agentKeys('claude')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-1234567890' })
    expect(secrets.agentKeys('codex')).toEqual({ CODEX_API_KEY: 'sk-codex-1234567890' })
    expect(secrets.agentKeys('cursor')).toEqual({ CURSOR_API_KEY: 'cur-1234567890' })
    // OpenCode used to read the Anthropic key from the user variables: it keeps getting it, now visibly.
    expect(secrets.providerKeys()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-1234567890' })
    expect(svc.legacyKeyHints()).toEqual({ ANTHROPIC_API_KEY: '7890', CODEX_API_KEY: '7890', CURSOR_API_KEY: '7890' })

    // Survives a reload, and a key added to Environment later stays there.
    const again = new SecretStore(file, plain)
    again.load()
    expect(again.agentKey('codex', 'CODEX_API_KEY')).toBe('sk-codex-1234567890')
    again.set({ kind: 'user' }, 'ANTHROPIC_API_KEY', 'deliberate')
    expect(service(again).svc.migrateKeys()).toBe(false)
    expect(again.get({ kind: 'user' }, 'ANTHROPIC_API_KEY')).toBe('deliberate')
  })

  it('keeps Claude working end to end: its environment is the same before and after the move', async () => {
    const before = await store({ version: 2, user: { ANTHROPIC_API_KEY: 'sk-ant-1234567890', CODEX_API_KEY: 'sk-codex-1234567890' }, repos: {}, providers: {}, app: {} })
    const s = settings({ claudeAuth: 'apiKey', codexAuth: 'apiKey' })
    const env = (secrets: SecretStore) => new Environment(secrets, () => s, () => { throw new Error('no repo') })
    const pre = { claude: env(before.secrets).forAgent('claude'), codex: env(before.secrets).forAgent('codex') }
    service(before.secrets).svc.migrateKeys()
    const post = { claude: env(before.secrets).forAgent('claude'), codex: env(before.secrets).forAgent('codex') }
    expect(post.claude.ANTHROPIC_API_KEY).toBe(pre.claude.ANTHROPIC_API_KEY)
    expect(post.codex.CODEX_API_KEY).toBe(pre.codex.CODEX_API_KEY)
    expect(post.codex.OPENAI_API_KEY).toBe(pre.codex.OPENAI_API_KEY)
    // What changed: other agents no longer see Claude's key.
    expect(pre.codex.ANTHROPIC_API_KEY).toBe('sk-ant-1234567890')
    expect(post.codex.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env(before.secrets).forCatalogAgent('aider').ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('imports a key from the shell only while none is saved, and never overwrites one', async () => {
    const { secrets } = await store({ version: 2, user: {}, repos: {}, providers: {}, app: {} })
    const { svc, changed } = service(secrets, { GEMINI_API_KEY: 'shell-key', GROQ_API_KEY: 'gsk-shell' })
    expect(svc.importKey('gemini')).toBe(true)
    expect(secrets.agentKey('gemini', 'GEMINI_API_KEY')).toBe('shell-key')
    secrets.setAgentKey('gemini', 'GEMINI_API_KEY', 'typed-key')
    expect(svc.importKey('gemini')).toBe(false)
    expect(secrets.agentKey('gemini', 'GEMINI_API_KEY')).toBe('typed-key')
    expect(changed).toEqual(['gemini'])
    // Provider keys: the same rule.
    expect(svc.importProviderKey('GROQ_API_KEY')).toBe(true)
    secrets.setProviderKey('GROQ_API_KEY', 'mine')
    expect(svc.importProviderKey('GROQ_API_KEY')).toBe(false)
    expect(secrets.providerKeys().GROQ_API_KEY).toBe('mine')
    // Agents without an API key method can't take one.
    expect(() => svc.setKey('aider', 'x')).toThrow()
    expect(() => svc.importKey('kimchi')).toThrow()
  })

  it('reports shell key names, never values, in the catalog view', async () => {
    const { secrets } = await store({ version: 2, user: {}, repos: {}, providers: {}, app: {} })
    const { svc } = service(secrets, { GEMINI_API_KEY: 'shell-key', GROQ_API_KEY: 'gsk-shell' })
    const view = await svc.view()
    expect(view.shellKeys.gemini).toBe('GEMINI_API_KEY')
    expect(view.shellProviderKeys).toContain('GROQ_API_KEY')
    expect(JSON.stringify(view)).not.toContain('shell-key')
    expect(JSON.stringify(view)).not.toContain('gsk-shell')
  })

  it('maps each legacy key to its agent', () => {
    expect(LEGACY_AGENT_KEYS.map((k) => `${k.envVar}→${k.agent}`)).toEqual(['ANTHROPIC_API_KEY→claude', 'CODEX_API_KEY→codex', 'CURSOR_API_KEY→cursor'])
  })
})
