// Builds each agent's environment. Credentials from the user's shell are
// stripped; keys saved in Settings → Environment come back only where the
// agent's sign-in method allows, so a stray key in .zshrc never overrides a
// deliberate choice. #22: each agent's own API key (saved per agent) and the
// provider keys ticked for it are added here, and nowhere else.
import { AGENT_CATALOG, allowedProviderKeys, catalogAgent, loginStripVars, usesOwnApiKey } from '../../shared/agentCatalog'
import type { AgentKind } from '../../shared/agents'
import { PROVIDER_KEYS } from '../../shared/providers'
import type { Settings } from '../../shared/types'
import { agentBaseEnv } from '../platform'

const SHELL_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'AI_GATEWAY_API_KEY', 'CURSOR_API_KEY']

// Variables a CLI sign-in must not see: they would switch the agent to API billing.
const API_KEY_ONLY: Partial<Record<AgentKind, string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['CODEX_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENAI_BASE_URL'],
  cursor: [],
  opencode: []
}

// #22: provider keys removed from the shell environment of Chat and Terminal agents, which get
// only the ones ticked for them. GitHub and GitLab tokens stay: git tools in the agent use them.
// Every catalog agent's own key variables go too (GEMINI_API_KEY, FACTORY_API_KEY, …).
const SHELL_PROVIDER_KEYS = [
  ...new Set([...PROVIDER_KEYS.map((p) => p.envVar), ...AGENT_CATALOG.flatMap(loginStripVars)])
].filter((name) => name !== 'GITHUB_TOKEN' && name !== 'GITLAB_TOKEN')

/** Whether the agent runs on an API key now: Claude and Codex by their setting, Cursor and OpenCode always, catalog agents by theirs. */
export function usesApiKey(agent: string, settings: Settings): boolean {
  if (agent === 'claude') return settings.claudeAuth === 'apiKey'
  if (agent === 'codex') return settings.codexAuth === 'apiKey'
  if (agent === 'cursor' || agent === 'opencode') return true
  return usesOwnApiKey(agent, settings)
}

/**
 * @param agent a catalog id: a Full or Chat agent, or a Terminal agent for its terminal tab
 * @param vars the layered variables from Settings → Environment
 * @param providerKeys the shared provider keys (env var → key); OpenCode gets all, others only those ticked for them
 * @param own the agent's own saved keys (#22), passed only to it and only in API-key mode
 */
export function agentEnv(
  agent: string,
  settings: Settings,
  vars: Record<string, string>,
  providerKeys: Record<string, string> = {},
  extra: Record<string, string> = {},
  own: Record<string, string> = {}
): Record<string, string> {
  const env = agentBaseEnv()
  const info = catalogAgent(agent)
  const full = !info || info.level === 'full'
  // OpenCode is meant to pick up provider keys from the shell; the others must not.
  if (agent !== 'opencode') for (const name of SHELL_CREDENTIALS) delete env[name]
  // #22: Chat and Terminal agents lose every provider key in the shell, and their own key's variables.
  if (!full) for (const name of SHELL_PROVIDER_KEYS) delete env[name]
  const layered = { ...vars }
  const apiKey = usesApiKey(agent, settings)
  if (!apiKey) for (const name of API_KEY_ONLY[agent as AgentKind] ?? (info ? loginStripVars(info) : [])) delete layered[name]
  // OpenCode's own provider keys sit underneath the user's variables.
  if (agent === 'opencode') Object.assign(env, providerKeys)
  else if (!full) Object.assign(env, allowedProviderKeys(agent, providerKeys, settings.providerKeyAgents))
  // #22: the agent's own key, saved for it alone, also underneath the user's variables.
  const keyVar = info?.auth.confirmed ? info.auth.apiKey?.envVar : undefined
  if (apiKey && keyVar && own[keyVar]) env[keyVar] = own[keyVar]
  Object.assign(env, layered)
  // `codex exec` reads either name.
  if (agent === 'codex' && usesApiKey(agent, settings) && env.CODEX_API_KEY) env.OPENAI_API_KEY = env.CODEX_API_KEY
  return { ...env, ...extra }
}

/** The raw value of a variable in the user's login shell, for importing a key. */
export function shellCredential(name: string): string | undefined {
  return process.env[name] || undefined
}
