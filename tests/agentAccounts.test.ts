// #130: an agent's other accounts in the main process: the environment and binary a turn on an account gets, its own
// keys, which account a new chat starts on, and what changing a chat's account does under the agent's rule.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver, claudeExtraArgs, discoverClaudeCommands } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { executablePathFor } from '../src/main/agents/acp/catalogDrivers'
import { agentEnv } from '../src/main/agents/env'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { Environment } from '../src/main/environment'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import type { AgentInstance } from '../src/shared/agentInstances'
import type { AgentKind } from '../src/shared/agents'
import type { ChatItem, Settings } from '../src/shared/types'
import { tempDir } from './helpers'
import { fakeDriver, setupSessions } from './sessionHarness'

const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

const settings = (over: Partial<Settings> = {}) =>
  ({ claudeAuth: 'cli', codexAuth: 'cli', agentPrefs: {}, providerKeyAgents: {}, envFiles: [], agentInstances: [], claudeExecutablePath: '/bin/claude-default', ...over }) as unknown as Settings

const work: AgentInstance = { id: 'ai-work0001', agent: 'claude', label: 'Work', home: '/accounts/claude-work', path: '/bin/claude-work', args: ['--debug', '--name', 'w'], auth: 'cli' }
const keyed: AgentInstance = { id: 'ai-keyed001', agent: 'claude', label: 'Keyed', auth: 'apiKey' }

describe('a turn’s environment on an account', () => {
  it('points the agent at the account’s config folder, over one set in Settings → Environment', () => {
    const env = agentEnv('claude', settings(), { CLAUDE_CONFIG_DIR: '/everyone', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/everyone' }, {}, {}, {}, work)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accounts/claude-work')
    // Claude Code's secure storage follows the folder too, or every account would share one login.
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/accounts/claude-work')
    expect(agentEnv('codex', settings(), {}, {}, {}, {}, { ...work, agent: 'codex', home: '/accounts/codex-work' }).CODEX_HOME).toBe('/accounts/codex-work')
    // Without a folder of its own it shares the default one, as the default account does.
    expect(agentEnv('claude', settings(), { CLAUDE_CONFIG_DIR: '/everyone' }, {}, {}, {}, keyed).CLAUDE_CONFIG_DIR).toBe('/everyone')
  })

  it('gives an API-key account its own key, which a key in Settings → Environment can’t replace', () => {
    const env = agentEnv('claude', settings(), { ANTHROPIC_API_KEY: 'everyone', ANTHROPIC_AUTH_TOKEN: 'token' }, {}, {}, { ANTHROPIC_API_KEY: 'keyed-own' }, keyed)
    expect(env.ANTHROPIC_API_KEY).toBe('keyed-own')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    const codex = agentEnv('codex', settings(), { OPENAI_API_KEY: 'everyone' }, {}, {}, { CODEX_API_KEY: 'codex-own' }, { ...keyed, agent: 'codex' })
    expect([codex.CODEX_API_KEY, codex.OPENAI_API_KEY]).toEqual(['codex-own', 'codex-own'])
  })

  it('signs a Login account in by its folder alone, whatever the default account’s method', () => {
    const env = agentEnv('claude', settings({ claudeAuth: 'apiKey' }), { ANTHROPIC_API_KEY: 'everyone' }, {}, {}, {}, work)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('leaves the default account’s environment as it was', () => {
    const vars = { ANTHROPIC_API_KEY: 'repo-key', CLAUDE_CONFIG_DIR: '/everyone' }
    const s = settings({ claudeAuth: 'apiKey' })
    expect(agentEnv('claude', s, vars, {}, {}, { ANTHROPIC_API_KEY: 'own' }, undefined)).toEqual(agentEnv('claude', s, vars, {}, {}, { ANTHROPIC_API_KEY: 'own' }))
  })

  it('reads an account’s keys, never the default account’s, and the reverse', async () => {
    const dir = await tempDir('foreman-accounts-')
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), plain)
    secrets.setAgentKey('claude', 'ANTHROPIC_API_KEY', 'default-key')
    secrets.setInstanceKey(keyed.id, 'ANTHROPIC_API_KEY', 'keyed-key')
    const s = settings({ claudeAuth: 'apiKey', agentInstances: [keyed] })
    const environment = new Environment(secrets, () => s, () => { throw new Error('no repo') })
    expect(environment.forAgent('claude', undefined, {}, keyed).ANTHROPIC_API_KEY).toBe('keyed-key')
    expect(environment.forAgent('claude').ANTHROPIC_API_KEY).toBe('default-key')
  })
})

describe('an account’s keys in the vault', () => {
  it('round-trip, survive a reload, and go with the account alone', async () => {
    const dir = await tempDir('foreman-accounts-')
    const file = path.join(dir, 'secrets.bin')
    const secrets = new SecretStore(file, plain)
    secrets.setAgentKey('claude', 'ANTHROPIC_API_KEY', 'default-key')
    secrets.setInstanceKey('ai-a0000001', 'ANTHROPIC_API_KEY', ' a-key ')
    secrets.setInstanceKey('ai-b0000001', 'ANTHROPIC_API_KEY', 'b-key')
    const again = new SecretStore(file, plain)
    again.load()
    expect(again.instanceKey('ai-a0000001', 'ANTHROPIC_API_KEY')).toBe('a-key')
    again.forgetInstance('ai-a0000001')
    expect(again.instanceKeys('ai-a0000001')).toEqual({})
    expect(again.instanceKey('ai-b0000001', 'ANTHROPIC_API_KEY')).toBe('b-key')
    expect(again.agentKey('claude', 'ANTHROPIC_API_KEY')).toBe('default-key')
    // An empty value removes the key.
    again.setInstanceKey('ai-b0000001', 'ANTHROPIC_API_KEY', '')
    expect(again.instanceKeys('ai-b0000001')).toEqual({})
  })

  it('loads a vault written before accounts', async () => {
    const dir = await tempDir('foreman-accounts-')
    const file = path.join(dir, 'secrets.bin')
    await writeFile(file, JSON.stringify({ version: 2, user: {}, repos: {}, providers: {}, app: {}, agents: { claude: { ANTHROPIC_API_KEY: 'k' } } }))
    const secrets = new SecretStore(file, plain)
    secrets.load()
    expect(secrets.instanceKeys('ai-a0000001')).toEqual({})
    expect(secrets.agentKey('claude', 'ANTHROPIC_API_KEY')).toBe('k')
  })
})

describe('an account’s binary, flags and folder', () => {
  it('runs the account’s binary, else the default account’s', () => {
    expect(executablePathFor(settings(), 'claude', work)).toBe('/bin/claude-work')
    expect(executablePathFor(settings(), 'claude', keyed)).toBe('/bin/claude-default')
    expect(executablePathFor(settings(), 'claude')).toBe('/bin/claude-default')
  })

  it('adds the account’s flags to Claude Code’s, with Chrome', () => {
    expect(claudeExtraArgs({ launchArgs: ['--debug', '--name', 'w'], chrome: true })).toEqual({ debug: null, name: 'w', chrome: null })
    expect(claudeExtraArgs({ chrome: true })).toEqual({ chrome: null })
    expect(claudeExtraArgs({})).toBeUndefined()
  })

  it('reads custom commands and skills from the account’s config folder', async () => {
    const home = await tempDir('foreman-home-')
    const account = path.join(home, 'claude-work')
    await mkdir(path.join(home, '.claude', 'commands'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'commands', 'personal.md'), 'Personal command')
    await mkdir(path.join(account, 'commands'), { recursive: true })
    await writeFile(path.join(account, 'commands', 'work.md'), 'Work command')
    const cwd = await tempDir('foreman-repo-')
    expect((await discoverClaudeCommands(cwd, home)).map((c) => c.name)).toEqual(['personal'])
    expect((await discoverClaudeCommands(cwd, home, account)).map((c) => c.name)).toEqual(['work'])
  })
})

// ---- chats on accounts ----

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

type Sent = TurnRequest & { agent: AgentKind }

/** Claude and Codex stand-ins: each turn continues the conversation it was given, or starts `<agent>-<n>`. */
function agents() {
  const requests: Sent[] = []
  for (const agent of ['claude', 'codex'] as const) {
    registerDriver({
      ...fakeDriver(async (req, cb) => {
        requests.push({ ...req, agent })
        cb.sessionStarted(req.resume ?? `${agent}-${requests.length}`)
        cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `answer ${requests.length}` })
        cb.finished({ ok: true })
      }),
      kind: agent,
      oneShot: async () => 'title'
    })
  }
  return requests
}

/** A stand-in environment that says which account it was built for. */
function environment() {
  const calls: (AgentInstance | undefined)[] = []
  return {
    calls,
    forAgent: (_agent: string, _repo?: string, extra: Record<string, string> = {}, instance?: AgentInstance) => {
      calls.push(instance)
      return { ...extra, ...(instance?.home ? { CLAUDE_CONFIG_DIR: instance.home } : {}), ...(instance?.id === keyed.id ? { ANTHROPIC_API_KEY: 'keyed-key' } : {}) }
    }
  }
}

async function harness(accounts: AgentInstance[] = [work, keyed]) {
  const env = environment()
  // Chats opened here have no title yet, so one is written: the naming prompt is empty.
  const h = await setupSessions({ environment: env as never, workspaces: { settingsFor: () => ({ prompts: { general: '', renameBranch: '' }, sensitivePaths: [] }) } })
  h.store.state.settings.agentInstances = accounts
  return { ...h, env }
}
type H = Awaited<ReturnType<typeof harness>>

const tab = (h: H, id = h.session.id) => h.store.state.sessions.find((s) => s.id === id)!

async function say(h: H, text: string, id = h.session.id) {
  await h.sessions.send(id, text)
  await vi.waitFor(() => {
    expect(tab(h, id).status).toBe('idle')
    expect(tab(h, id).turnId).toBeUndefined()
  }, { timeout: 10_000 })
}

const noticesOf = async (h: H, id = h.session.id) => (await h.store.readChat(id)).filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice').map((i) => i.text)

describe('which account a new chat starts on', () => {
  it('the one asked for, else the workspace’s pick for that agent, else loadout 1’s, else the default', async () => {
    const h = await harness()
    expect(h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id }).instanceId).toBe(work.id)
    h.store.state.settings.loadouts = [{ agent: 'claude', model: 'claude-opus-5-5[1m]', fast: false, instance: keyed.id }]
    expect(h.sessions.createSession(h.ws.id, {}).instanceId).toBe(keyed.id)
    // Loadout 1's account is Claude's; a Codex chat doesn't take it.
    expect(h.sessions.createSession(h.ws.id, { agent: 'codex' }).instanceId).toBeUndefined()
    h.ws.agentInstances = { claude: work.id }
    expect(h.sessions.createSession(h.ws.id, { agent: 'claude' }).instanceId).toBe(work.id)
    // null: the default account, whatever the workspace picked.
    expect(h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: null }).instanceId).toBeUndefined()
    expect(() => h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: 'ai-gone0001' })).toThrow(/no longer exists/)
    expect(() => h.sessions.createSession(h.ws.id, { agent: 'codex', instanceId: work.id })).toThrow(/no longer exists/)
  })
})

describe('a turn on an account', () => {
  it('runs with the account’s environment, binary and launch flags, and remembers where its conversation lives', async () => {
    const requests = agents()
    const h = await harness()
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id })
    await say(h, 'hello', chat.id)
    const req = requests.at(-1)!
    expect(req.env.CLAUDE_CONFIG_DIR).toBe('/accounts/claude-work')
    expect(req.executablePath).toBe('/bin/claude-work')
    expect(req.launchArgs).toEqual(['--debug', '--name', 'w'])
    expect(h.env.calls).toContainEqual(work)
    expect(tab(h, chat.id).conversationKey).toMatch(/^claude:home:.*claude-work$/i)
    const user = (await h.store.readChat(chat.id)).find((i) => i.kind === 'user')
    expect(user).toMatchObject({ instance: work.id })
  })

  it('stops on a removed account instead of running as another one', async () => {
    const requests = agents()
    const h = await harness()
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id })
    h.store.state.settings.agentInstances = []
    await say(h, 'hello', chat.id)
    expect(requests).toEqual([])
    expect((await noticesOf(h, chat.id)).join('\n')).toMatch(/account was removed/)
  })

  it('stops on an API-key account with no key saved', async () => {
    const requests = agents()
    const h = await harness([{ ...keyed, id: 'ai-nokey001', label: 'No key' }])
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: 'ai-nokey001' })
    await say(h, 'hello', chat.id)
    expect(requests).toEqual([])
    expect((await noticesOf(h, chat.id)).join('\n')).toMatch(/“No key” has no API key saved/)
  })

  it('gives the default account’s chats what they always had', async () => {
    const requests = agents()
    const h = await harness()
    await say(h, 'hello')
    expect(requests.at(-1)!.launchArgs).toBeUndefined()
    expect(h.env.calls.at(-1)).toBeUndefined()
    expect(tab(h).conversationKey).toBeUndefined()
  })
})

describe('changing a chat’s account', () => {
  it('just moves a chat with no conversation yet, whatever the rule', async () => {
    agents()
    const h = await harness()
    await h.sessions.updateSession(h.session.id, { instanceId: work.id })
    expect(tab(h).instanceId).toBe(work.id)
    // The workspace's later chats on Claude start there too.
    expect(h.ws.agentInstances).toEqual({ claude: work.id })
    await h.sessions.updateSession(h.session.id, { instanceId: null })
    expect(tab(h).instanceId).toBeUndefined()
    expect(h.ws.agentInstances).toBeUndefined()
  })

  it('refuses to move a conversation under the default rule, and changes nothing', async () => {
    agents()
    const h = await harness()
    await say(h, 'first')
    const before = { ...tab(h) }
    await expect(h.sessions.updateSession(h.session.id, { instanceId: work.id })).rejects.toThrow(/keeps chats on their account/)
    expect(tab(h)).toEqual(before)
    expect(h.ws.agentInstances).toBeUndefined()
  })

  it('with “as text”, starts a new conversation on the other account that gets the history', async () => {
    const requests = agents()
    const h = await harness()
    h.store.state.settings.agentPrefs = { claude: { moveChats: 'as-text' } }
    await say(h, 'first question')
    await h.sessions.updateSession(h.session.id, { instanceId: work.id })
    expect(tab(h)).toMatchObject({ instanceId: work.id, seedHistory: 'account' })
    expect(tab(h).agentSessionId).toBeUndefined()
    expect((await noticesOf(h)).at(-1)).toBe('Moved to the account Work · earlier messages passed to Claude Code as text')
    await say(h, 'go on')
    const req = requests.at(-1)!
    expect(req.resume).toBeUndefined()
    expect(req.env.CLAUDE_CONFIG_DIR).toBe('/accounts/claude-work')
    expect(req.prompt).toContain('first question')
    expect(req.prompt).toContain('another account')
    expect(req.prompt.endsWith('go on')).toBe(true)
  })

  it('keeps the same conversation on an account that shares its config folder', async () => {
    const requests = agents()
    const h = await harness()
    await say(h, 'first')
    const conversation = tab(h).agentSessionId
    await h.sessions.updateSession(h.session.id, { instanceId: keyed.id })
    expect(tab(h)).toMatchObject({ instanceId: keyed.id, agentSessionId: conversation })
    expect((await noticesOf(h)).at(-1)).toBe('Now on the account Keyed · same Claude Code conversation')
    await say(h, 'again')
    expect(requests.at(-1)).toMatchObject({ resume: conversation })
    expect(requests.at(-1)!.env.ANTHROPIC_API_KEY).toBe('keyed-key')
  })

  it('refuses an account that’s gone or another agent’s', async () => {
    agents()
    const h = await harness()
    await expect(h.sessions.updateSession(h.session.id, { instanceId: 'ai-gone0001' })).rejects.toThrow(/no longer exists/)
    await expect(h.sessions.updateSession(h.session.id, { agent: 'codex', instanceId: work.id })).rejects.toThrow(/no longer exists/)
    expect(tab(h).agent).toBe('claude')
  })

  it('a fork stays on the chat’s account', async () => {
    agents()
    const h = await harness()
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id })
    await say(h, 'first', chat.id)
    const fork = await h.sessions.forkSession(chat.id)
    expect(fork.instanceId).toBe(work.id)
  })

  it('switching agents parks the account with the conversation and restores both on the way back', async () => {
    const requests = agents()
    const h = await harness()
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id })
    await say(h, 'claude first', chat.id)
    await h.sessions.updateSession(chat.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    expect(tab(h, chat.id).instanceId).toBeUndefined()
    expect(tab(h, chat.id).parked?.claude).toMatchObject({ instanceId: work.id })
    await say(h, 'codex turn', chat.id)
    await h.sessions.updateSession(chat.id, { agent: 'claude', model: 'claude-opus-5-5[1m]' })
    expect(tab(h, chat.id).instanceId).toBe(work.id)
    await say(h, 'back', chat.id)
    expect(requests.at(-1)).toMatchObject({ agent: 'claude', resume: 'claude-1', executablePath: '/bin/claude-work' })
  })

  it('a conversation whose account changed folders starts again there, with the history as text', async () => {
    const requests = agents()
    const h = await harness()
    const chat = h.sessions.createSession(h.ws.id, { agent: 'claude', instanceId: work.id })
    await say(h, 'first question', chat.id)
    h.store.state.settings.agentInstances = [{ ...work, home: '/accounts/moved' }, keyed]
    await say(h, 'next', chat.id)
    const req = requests.at(-1)!
    expect(req.resume).toBeUndefined()
    expect(req.prompt).toContain('first question')
    expect((await noticesOf(h, chat.id)).join('\n')).toMatch(/config folder changed/)
  })
})
