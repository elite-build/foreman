// #22: the agent catalog — registry integrity, detection with an injected PATH
// and file system, the shared pickers' logic, sign-in states and capability-based
// control hiding.
import { describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG,
  agentAuthMode,
  CAPABILITIES,
  catalogAgent,
  CHAT_AGENT_IDS,
  chosenModels,
  enabledAgentIds,
  excludeAdditions,
  filterCatalog,
  FULL_AGENT_IDS,
  hasTwoLineNames,
  isAgentEnabled,
  loginCommandLabel,
  parseAgentPrefs,
  signInMethods,
  signInState,
  staticCapabilities,
  TERMINAL_AGENT_IDS,
  TERMINAL_QUIET_MS,
  terminalActivity,
  usesOwnApiKey
} from '../src/shared/agentCatalog'
import { offers } from '../src/shared/agentCapabilities'
import { STATUS_CHECKED_AGENTS } from '../src/shared/agentReadiness'
import { enabledCount, noteCapabilities, pickerAgents, pickerGroups } from '../src/shared/agentPicker'
import { closeAgentTab, closeNeedsConfirm, openAgentTab, restartAgentTab, showAgentTab, tabsOf } from '../src/shared/agentTabs'
import { AGENT_ORDER, AGENTS, DEFAULT_MODEL } from '../src/shared/agents'
import { detectAgent, findBinary, launchFor, parseVersion, type DetectDeps } from '../src/main/agents/catalogDetect'
import { parseSignInOutput } from '../src/main/agentCatalogService'

const auth = (over: Partial<{ claudeAuth: 'cli' | 'apiKey'; codexAuth: 'cli' | 'apiKey'; agentPrefs: Record<string, { auth?: 'cli' | 'apiKey'; enabled?: boolean }> }> = {}) => ({
  claudeAuth: 'cli' as const,
  codexAuth: 'cli' as const,
  agentPrefs: {},
  ...over
})

describe('agent registry', () => {
  it('lists the 33 agents once each, in the three levels the brief names', () => {
    const ids = AGENT_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(33)
    expect(AGENT_CATALOG.filter((a) => a.level === 'full').map((a) => a.id)).toEqual([...FULL_AGENT_IDS])
    expect(AGENT_CATALOG.filter((a) => a.level === 'chat').map((a) => a.id)).toEqual([...CHAT_AGENT_IDS])
    expect(AGENT_CATALOG.filter((a) => a.level === 'terminal').map((a) => a.id)).toEqual([...TERMINAL_AGENT_IDS])
    expect(CHAT_AGENT_IDS).toHaveLength(11)
    expect(TERMINAL_AGENT_IDS).toHaveLength(18)
  })

  it('gives every agent what its level needs', () => {
    for (const agent of AGENT_CATALOG) {
      expect(agent.name.trim(), agent.id).not.toBe('')
      expect(agent.monogram, agent.id).toMatch(/^[A-Z][a-z]$/)
      expect(agent.binaries.length, agent.id).toBeGreaterThan(0)
      expect(agent.versionArgs, agent.id).toEqual(['--version'])
      expect(agent.docsUrl, agent.id).toMatch(/^https:\/\//)
      expect(Object.keys(agent.capabilities).sort(), agent.id).toEqual([...CAPABILITIES].sort())
      if (agent.level === 'chat') {
        expect(agent.acp, agent.id).toBeDefined()
        expect(['reference', 'docs'], agent.id).toContain(agent.acp!.source)
        expect(agent.terminal, agent.id).toBeUndefined()
      }
      if (agent.level === 'terminal') {
        expect(agent.terminal, agent.id).toBeDefined()
        expect(agent.acp, agent.id).toBeUndefined()
        // Foreman sees the process, nothing else.
        expect(Object.values(agent.capabilities), agent.id).toEqual(CAPABILITIES.map(() => false))
      }
      if (agent.level === 'full') expect(agent.acp, agent.id).toBeUndefined()
      // An API key method names a real variable.
      if (agent.auth.apiKey) expect(agent.auth.apiKey.envVar, agent.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('enables only the four Full agents by default', () => {
    expect(AGENT_CATALOG.filter((a) => a.defaultEnabled).map((a) => a.id)).toEqual([...FULL_AGENT_IDS])
    expect(enabledAgentIds(undefined)).toEqual([...FULL_AGENT_IDS])
    expect(isAgentEnabled('gemini', { gemini: { enabled: true } })).toBe(true)
    expect(isAgentEnabled('claude', { claude: { enabled: false } })).toBe(false)
  })

  it('keeps the ACP launch commands and distinguishes integration references from agent docs', () => {
    const flags = Object.fromEntries(AGENT_CATALOG.filter((a) => a.acp).map((a) => [a.id, [a.acp!.binaries?.[0] ?? a.binaries[0], ...a.acp!.args].join(' ')]))
    expect(flags).toMatchObject({
      gemini: 'gemini --experimental-acp',
      qwen: 'qwen --acp',
      kimi: 'kimi acp',
      droid: 'droid exec --output-format acp-daemon',
      copilot: 'copilot --acp --no-auto-update',
      deepseek: 'dsh --profile acp',
      pi: 'pi-acp',
      commandcode: 'cmd acp --skip-onboarding --no-auto-update --trust',
      omp: 'omp acp',
      antigravity: 'agy_acp_server',
      goose: 'goose acp'
    })
    // These two commands were sourced from agent docs only.
    expect(catalogAgent('gemini')!.acp!.source).toBe('docs')
    expect(catalogAgent('goose')!.acp!.source).toBe('docs')
    expect(AGENT_CATALOG.filter((a) => a.acp?.source === 'reference').length).toBe(9)
  })

  it('marks the six agents whose sign-in nobody has confirmed as Check docs, with no methods', () => {
    const unconfirmed = AGENT_CATALOG.filter((a) => !a.auth.confirmed).map((a) => a.id)
    expect(unconfirmed).toEqual(['kimchi', 'muse', 'mimo', 'autohand', 'codewhale', 'primeagent'])
    for (const id of unconfirmed) expect(signInMethods(catalogAgent(id)!)).toEqual([])
  })

  it('keeps Aider’s scratch files in the exclude list', () => {
    expect(catalogAgent('aider')!.scratch).toContain('.aider*')
  })

  it('gives Chat agents no plan mode or steering until they declare one, and a name and no default model', () => {
    for (const id of CHAT_AGENT_IDS) {
      expect(AGENTS[id]).toMatchObject({ kind: id, label: catalogAgent(id)!.name })
      expect(catalogAgent(id)!.capabilities).toMatchObject({ plan: false, steer: false })
      expect(DEFAULT_MODEL[id]).toBe('')
    }
  })
})

describe('capability-based controls', () => {
  it('the controls follow the record: Plan, steering and Restore for the agents that can do them', () => {
    const controls = (id: string) => ({ plan: offers(staticCapabilities(id)!.planning.planMode), steer: staticCapabilities(id)!.turns.steer.level === 'native', restore: staticCapabilities(id)!.checkpointing.restoreFiles })
    expect(controls('claude')).toEqual({ plan: true, steer: true, restore: true })
    expect(controls('codex')).toEqual({ plan: true, steer: true, restore: true })
    // A Chat agent restores the files and starts a fresh conversation (checkpoint-fresh-session); it can't steer mid-turn natively.
    expect(controls('gemini')).toEqual({ plan: false, steer: false, restore: true })
    expect(controls('qwen').restore).toBe(true)
  })

  it('names what a Chat agent lacks in the picker’s hover note', () => {
    const gemini = pickerGroups({ gemini: { enabled: true } }, { cursor: true, opencode: true }).find((g) => g.level === 'chat')!.agents[0]
    expect(noteCapabilities(gemini)).toEqual(['plan', 'steer'])
    // Full agents carry no note.
    const claude = pickerGroups(undefined, { cursor: true, opencode: true })[0].agents[0]
    expect(noteCapabilities(claude)).toEqual([])
  })
})

describe('the picker', () => {
  it('offers only enabled agents, grouped Full / Chat / Terminal', () => {
    const prefs = { gemini: { enabled: true }, aider: { enabled: true }, cursor: { enabled: false } }
    const groups = pickerGroups(prefs, { cursor: true, opencode: false })
    expect(groups.map((g) => [g.level, g.agents.map((a) => a.id)])).toEqual([
      ['full', ['claude', 'codex', 'opencode']],
      ['chat', ['gemini']],
      ['terminal', ['aider']]
    ])
    // OpenCode is enabled but not installed: listed, not ready (picking it opens its settings).
    expect(groups[0].agents.find((a) => a.id === 'opencode')!.ready).toBe(false)
    expect(enabledCount(prefs)).toEqual({ enabled: 5, total: 33 })
  })

  it('makes a chat agent available only while enabled; Terminal agents never take chats', () => {
    const off = pickerAgents(undefined, { cursor: false, opencode: false })
    expect(off).toMatchObject({ claude: true, codex: true, cursor: false, opencode: false, gemini: false })
    expect('aider' in off).toBe(false)
    expect(pickerAgents({ gemini: { enabled: true } }, { cursor: true, opencode: true }).gemini).toBe(true)
  })
})

describe('catalog page filters', () => {
  it('filters by level, enabled, installed and search text', () => {
    const state = { enabled: (id: string) => ['claude', 'gemini'].includes(id), installed: (id: string) => ['claude', 'aider'].includes(id) }
    expect(filterCatalog(AGENT_CATALOG, 'enabled', '', state).map((a) => a.id)).toEqual(['claude', 'gemini'])
    expect(filterCatalog(AGENT_CATALOG, 'installed', '', state).map((a) => a.id)).toEqual(['claude', 'aider'])
    expect(filterCatalog(AGENT_CATALOG, 'chat', '', state)).toHaveLength(11)
    expect(filterCatalog(AGENT_CATALOG, 'terminal', '', state)).toHaveLength(18)
    expect(filterCatalog(AGENT_CATALOG, 'all', 'qwen', state).map((a) => a.id)).toEqual(['qwen'])
  })
})

describe('detection', () => {
  const gemini = catalogAgent('gemini')!

  function deps(files: string[], over: Partial<DetectDeps> = {}): DetectDeps & { ran: string[][] } {
    const ran: string[][] = []
    return {
      path: '/opt/homebrew/bin:/usr/local/bin',
      platform: 'darwin',
      exists: (f) => files.includes(f),
      run: async (file, args) => {
        ran.push([file, ...args])
        return 'gemini 0.21.0\n'
      },
      env: {},
      ran,
      ...over
    }
  }

  it('finds the binary on the injected PATH and reads its version', async () => {
    const d = deps(['/usr/local/bin/gemini'])
    const found = await detectAgent(gemini, d)
    expect(found).toMatchObject({ id: 'gemini', installed: true, path: '/usr/local/bin/gemini', version: '0.21.0' })
    expect(d.ran).toEqual([['/usr/local/bin/gemini', '--version']])
  })

  it('says not installed when nothing is on PATH, without running anything', async () => {
    const d = deps([])
    expect(await detectAgent(gemini, d)).toMatchObject({ id: 'gemini', installed: false })
    expect(d.ran).toEqual([])
  })

  it('reports found-but-failing with the command and its output, not as missing', async () => {
    const d = deps(['/usr/local/bin/gemini'], {
      run: async () => {
        throw new Error('Error: Cannot find module "node:sqlite"')
      }
    })
    const found = await detectAgent(gemini, d)
    expect(found.installed).toBe(true)
    expect(found.error).toEqual({ command: '/usr/local/bin/gemini --version', output: 'Error: Cannot find module "node:sqlite"' })
  })

  it('uses a configured path instead of PATH, and only if it exists', async () => {
    expect(await detectAgent(gemini, deps(['/custom/gemini']), '/custom/gemini')).toMatchObject({ installed: true, path: '/custom/gemini' })
    expect(await detectAgent(gemini, deps(['/usr/local/bin/gemini']), '/missing/gemini')).toMatchObject({ installed: false })
  })

  it('tries PATHEXT names on Windows, so an npm .cmd shim counts', () => {
    const files = ['C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd']
    const found = findBinary(['gemini'], { path: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm', platform: 'win32', pathExt: '.COM;.EXE;.BAT;.CMD', exists: (f) => files.includes(f) })
    expect(found).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd')
  })

  it('starts .cmd shims through cmd.exe on Windows, and everything else directly', () => {
    expect(launchFor('/usr/local/bin/qwen', ['--acp'], 'darwin')).toEqual({ file: '/usr/local/bin/qwen', args: ['--acp'] })
    expect(launchFor('C:\\npm\\qwen.cmd', ['--acp'], 'win32').args).toEqual(['/d', '/c', 'C:\\npm\\qwen.cmd', '--acp'])
    expect(launchFor('C:\\Program Files\\x\\agy.exe', [], 'win32')).toEqual({ file: 'C:\\Program Files\\x\\agy.exe', args: [] })
  })

  it('reads version numbers out of noisy output', () => {
    expect(parseVersion('aider 0.86.1')).toBe('0.86.1')
    expect(parseVersion('v2026.10.09-abc')).toBe('2026.10.09-abc')
    expect(parseVersion('')).toBeUndefined()
  })
})

describe('sign-in states', () => {
  const agent = (id: string) => catalogAgent(id)!

  it('says only what something reported: key hints, ticked keys, a status answer, else unknown', () => {
    expect(signInState(agent('gemini'), { mode: 'apiKey', keyHint: '3f2a', providerKeys: 0 })).toEqual({ kind: 'api-key', hint: '3f2a' })
    expect(signInState(agent('gemini'), { mode: 'apiKey', providerKeys: 0 })).toEqual({ kind: 'no-key' })
    expect(signInState(agent('gemini'), { mode: 'cli', providerKeys: 0 })).toEqual({ kind: 'unknown' })
    expect(signInState(agent('kiro'), { mode: 'cli', providerKeys: 0, reported: { signedIn: false } })).toEqual({ kind: 'not-signed-in' })
    expect(signInState(agent('goose'), { mode: 'cli', providerKeys: 0 })).toEqual({ kind: 'unknown' })
    expect(signInState(agent('aider'), { mode: 'cli', providerKeys: 2 })).toEqual({ kind: 'provider-keys', count: 2 })
    expect(signInState(agent('openhands'), { mode: 'cli', providerKeys: 0 })).toEqual({ kind: 'no-provider-keys' })
    expect(signInState(agent('kimchi'), { mode: 'cli', providerKeys: 3 })).toEqual({ kind: 'check-docs' })
    // Key-only agents are on their key whatever the mode says.
    expect(signInState(agent('deepseek'), { mode: 'cli', keyHint: 'abcd', providerKeys: 0 })).toEqual({ kind: 'api-key', hint: 'abcd' })
  })

  it('picks the sign-in mode per agent; Claude and Codex keep their own settings', () => {
    expect(agentAuthMode('claude', auth({ claudeAuth: 'apiKey' }))).toBe('apiKey')
    expect(agentAuthMode('gemini', auth())).toBe('cli')
    expect(agentAuthMode('gemini', auth({ agentPrefs: { gemini: { auth: 'apiKey' } } }))).toBe('apiKey')
    expect(agentAuthMode('deepseek', auth())).toBe('apiKey')
    expect(agentAuthMode('kiro', auth({ agentPrefs: { kiro: { auth: 'apiKey' } } }))).toBe('cli')
    expect(usesOwnApiKey('kimchi', auth({ agentPrefs: { kimchi: { auth: 'apiKey' } } }))).toBe(false)
  })

  it('reads a status command’s answer only when it’s clear', () => {
    expect(parseSignInOutput('devin', 'Logged in as yatin@hey.com', true)).toEqual({ signedIn: true, account: 'yatin@hey.com' })
    expect(parseSignInOutput('devin', 'Not logged in. Run devin auth login.', false)).toEqual({ signedIn: false })
    expect(parseSignInOutput('commandcode', 'Authentication verified', true)).toMatchObject({ signedIn: true })
    expect(parseSignInOutput('kiro', '{"email":"me@x.dev"}', true)).toEqual({ signedIn: true, account: 'me@x.dev' })
    expect(parseSignInOutput('devin', 'something else entirely', true)).toBeNull()
    expect(parseSignInOutput('devin', 'network error', false)).toBeNull()
  })

  it('drops unknown agents and fields from saved preferences', () => {
    expect(parseAgentPrefs({ gemini: { enabled: true, auth: 'apiKey', path: ' /x ', junk: 1 }, nope: { enabled: true }, aider: 'yes' })).toEqual({ gemini: { enabled: true, auth: 'apiKey', path: '/x' } })
  })
})

describe('terminal agent status and tabs', () => {
  it('reads running with seconds since output, quiet after a minute, and never anything about needing you', () => {
    const now = 1_000_000
    expect(terminalActivity({ lastOutputAt: now - 2_400 }, now)).toEqual({ kind: 'running', secondsAgo: 2 })
    expect(terminalActivity({ lastOutputAt: now - TERMINAL_QUIET_MS }, now)).toEqual({ kind: 'quiet' })
    expect(terminalActivity({ lastOutputAt: now, exitCode: 0 }, now)).toEqual({ kind: 'exited', code: 0 })
  })

  it('opens, shows, restarts and closes tabs; closing the shown one brings the chat back', () => {
    let s = openAgentTab({}, 'ws', 'aider', 'a1')
    s = openAgentTab(s, 'ws', 'amp', 'a2')
    expect(tabsOf(s, 'ws')).toEqual({ tabs: [{ key: 'a1', agent: 'aider', run: 0 }, { key: 'a2', agent: 'amp', run: 0 }], active: 'a2' })
    s = showAgentTab(s, 'ws', null)
    expect(tabsOf(s, 'ws').active).toBeNull()
    s = showAgentTab(s, 'ws', 'a1')
    s = restartAgentTab(s, 'ws', 'a1')
    expect(tabsOf(s, 'ws').tabs[0].run).toBe(1)
    s = closeAgentTab(s, 'ws', 'a1')
    expect(tabsOf(s, 'ws')).toEqual({ tabs: [{ key: 'a2', agent: 'amp', run: 0 }], active: null })
    s = closeAgentTab(s, 'ws', 'a2')
    expect(s).toEqual({})
  })

  it('asks before closing a tab whose agent printed in the last 10 seconds', () => {
    expect(closeNeedsConfirm(9_000, false, 15_000)).toBe(true)
    expect(closeNeedsConfirm(1_000, false, 15_000)).toBe(false)
    expect(closeNeedsConfirm(14_000, true, 15_000)).toBe(false)
  })

  it('adds only the scratch patterns info/exclude doesn’t have yet', () => {
    expect(excludeAdditions('.context/\n.aider*\n', ['.aider*', '.crush/'])).toEqual(['.crush/'])
  })
})

describe('what the settings pages and pickers read from the catalog instead of an agent’s id', () => {
  it('model names: OpenCode’s read "provider/model" as two lines, no other agent’s do; its chosen subset is a setting', () => {
    expect(AGENT_CATALOG.filter((a) => hasTwoLineNames(a.id)).map((a) => a.id)).toEqual(['opencode'])
    const settings = { opencodeModels: ['anthropic/claude-sonnet-5-5'] }
    expect(chosenModels('opencode', settings)).toEqual(['anthropic/claude-sonnet-5-5'])
    // An agent that lists every model has no chosen subset.
    expect(chosenModels('claude', settings)).toBeUndefined()
    expect(chosenModels('gemini', settings)).toBeUndefined()
    expect(chosenModels('nobody', settings)).toBeUndefined()
  })

  it('the login command is the binary and the login arguments, and only an agent with a Login has one', () => {
    expect(loginCommandLabel(catalogAgent('claude')!)).toBe('claude auth login')
    expect(loginCommandLabel(catalogAgent('codex')!)).toBe('codex login')
    expect(loginCommandLabel(catalogAgent('cursor')!)).toBeUndefined()
  })

  it('the Login and API key cards are worded by the catalog, for the agents that have both', () => {
    expect(catalogAgent('claude')!.auth.cards).toEqual({ login: 'agentSettings.claude.loginDesc', apiKey: 'agentSettings.claude.keyDesc' })
    expect(catalogAgent('codex')!.auth.cards).toEqual({ login: 'agentSettings.codex.loginDesc', apiKey: 'agentSettings.codex.keyDesc' })
    for (const agent of AGENT_CATALOG) if (agent.auth.cards) expect(agent.auth.login && agent.auth.apiKey, agent.id).toBeTruthy()
  })

  it('names whose key an agent’s API key is, and what is shown beside the teaching instructions', () => {
    expect(['claude', 'codex', 'cursor'].map((id) => catalogAgent(id)!.auth.apiKey!.provider)).toEqual(['Anthropic', 'OpenAI', 'Cursor'])
    expect(AGENT_CATALOG.filter((a) => a.reportToolsNote).map((a) => a.id)).toEqual(['cursor'])
  })

  it('the agents whose sign-in is checked from outside a turn are the ones judged by their status', () => {
    expect(STATUS_CHECKED_AGENTS).toEqual(['claude', 'codex'])
  })
})
