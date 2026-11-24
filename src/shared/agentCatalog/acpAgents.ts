// ACP catalogue reference portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's TypeScript catalogue; see NOTICE and docs/licenses/acp-integration.txt.
// The Chat agents: structured chats over the Agent Client Protocol (main/agents/acp), one catalog entry each, and the
// capability record of each (docs/agents.md, 2.1, 2.2). `acp.source` says where a launch command comes from: 'reference'
// is the external integration reference, 'docs' the agent's own docs; neither implies local end-to-end validation.
import type { AgentCapabilities } from '../agentCapabilities'
import { capsOf, type CatalogAgent, type ChatAgentId } from './catalog'
import { acpRecord } from './helpers'

/** One entry per Chat agent, so a later slice can give an agent that behaves differently a record of its own. */
// Restore is offered: the files come back from Foreman's own checkpoint and the agent starts a fresh conversation (`checkpoint-fresh-session`).
const chatRecord = (): AgentCapabilities => acpRecord({ restoreFiles: true, cost: false, keptRunning: false })

export const CHAT_AGENT_RECORDS: Record<ChatAgentId, AgentCapabilities> = {
  qwen: chatRecord(),
  kimi: chatRecord(),
  droid: chatRecord(),
  copilot: chatRecord(),
  goose: chatRecord(),
  deepseek: chatRecord(),
  pi: chatRecord(),
  commandcode: chatRecord(),
  omp: chatRecord(),
  antigravity: chatRecord()
}

export const ACP_CHAT_AGENTS: CatalogAgent[] = [
  {
    id: 'qwen', name: 'Qwen Code', monogram: 'Qw', level: 'chat', binaries: ['qwen'], versionArgs: ['--version'],
    acp: { args: ['--acp'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.qwen' }, sharedKeys: true, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.qwen), docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/', scratch: ['.qwen/']
  },
  {
    id: 'kimi', name: 'Kimi CLI', monogram: 'Ki', level: 'chat', binaries: ['kimi'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'reference' },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'KIMI_API_KEY', alsoStrip: ['MOONSHOT_API_KEY', 'KIMI_CODE_API_KEY'] }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.kimi), docsUrl: 'https://moonshotai.github.io/kimi-code/en/', scratch: ['.kimi/']
  },
  {
    // G1: each turn gets a `--settings` overlay (model and autonomy) that Foreman
    // writes in its own data folder, never in the repo (main/agents/acp/catalogDrivers.ts).
    id: 'droid', name: 'Factory Droid', monogram: 'Fd', level: 'chat', binaries: ['droid'], versionArgs: ['--version'],
    acp: { args: ['exec', '--output-format', 'acp-daemon'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, apiKey: { envVar: 'FACTORY_API_KEY', keyUrl: 'https://app.factory.ai/settings/api-keys' }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.droid), docsUrl: 'https://docs.factory.ai/droid-cli/cli-reference', scratch: ['.factory/']
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', monogram: 'Gh', level: 'chat', binaries: ['copilot'], versionArgs: ['--version'],
    acp: { args: ['--acp', '--no-auto-update'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, apiKey: { envVar: 'COPILOT_GITHUB_TOKEN', keyUrl: 'https://github.com/settings/personal-access-tokens/new' }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.copilot), docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli'
  },
  {
    // `goose acp` is from Goose's docs.
    id: 'goose', name: 'Goose', monogram: 'Go', level: 'chat', binaries: ['goose'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'docs' },
    auth: { login: { args: ['configure'] }, sharedKeys: true, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.goose), docsUrl: 'https://goose-docs.ai/docs/getting-started/installation/'
  },
  {
    id: 'deepseek', name: 'DeepSeek', monogram: 'Ds', level: 'chat', binaries: ['dsh'], versionArgs: ['--version'],
    acp: { args: ['--profile', 'acp'], source: 'reference' },
    auth: { apiKey: { envVar: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys' }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.deepseek), docsUrl: 'https://github.com/deepseek-ai/deepseek-harness'
  },
  {
    // ACP runs through the separate pi-acp adapter (npm i -g @victor-software-house/pi-acp).
    id: 'pi', name: 'Pi', monogram: 'Pi', level: 'chat', binaries: ['pi'], versionArgs: ['--version'],
    acp: { args: [], binaries: ['pi-acp'], install: 'npm i -g @victor-software-house/pi-acp', expect: { name: '@victor-software-house/pi-acp', minVersion: '0.17.1' }, source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, sharedKeys: true, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.pi), docsUrl: 'https://github.com/earendil-works/pi', scratch: ['.pi/']
  },
  {
    id: 'commandcode', name: 'Command Code', monogram: 'Cm', level: 'chat', binaries: ['cmd', 'command-code'], winBinaries: ['cmdc', 'command-code'], versionArgs: ['--version'],
    acp: { args: ['acp', '--skip-onboarding', '--no-auto-update', '--trust'], source: 'reference' },
    auth: { login: { args: ['login'], statusArgs: ['status'] }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.commandcode), docsUrl: 'https://commandcode.ai/docs/quickstart', scratch: ['.commandcode/']
  },
  {
    id: 'omp', name: 'OMP', monogram: 'Om', level: 'chat', binaries: ['omp'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.omp), docsUrl: 'https://github.com/can1357/oh-my-pi', scratch: ['.omp/']
  },
  {
    // ACP is agy's own `agy acp` (agy 1.5.0 and later; Google's ACP docs). It reuses agy's saved Google sign-in, and takes a
    // Gemini API key only once Foreman selects that method (main/agents/acp/catalogDrivers.ts). Gemini CLI's successor.
    id: 'antigravity', name: 'Antigravity', monogram: 'Ag', level: 'chat', binaries: ['agy'], versionArgs: ['--version'],
    acp: { args: ['acp'], expect: { name: 'Antigravity ACP Server', minVersion: '1.5.0' }, source: 'docs' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.browser' }, apiKey: { envVar: 'GEMINI_API_KEY', alsoStrip: ['GOOGLE_API_KEY'], keyUrl: 'https://aistudio.google.com/apikey' }, confirmed: true },
    capabilities: capsOf(CHAT_AGENT_RECORDS.antigravity), docsUrl: 'https://github.com/google-antigravity/antigravity-cli', scratch: ['.agents/']
  },
]
