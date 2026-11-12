// Claude Code: its catalog entry and its capability record (docs/agents.md, 2.1, 2.2).
// Each record reproduces what the adapter does TODAY: an ability is claimed only where the adapter implements it, so a later
// slice that adds one changes its record in the same commit. `evidence` is 'recorded': tests/agentCapabilityProof.test.ts proves each claim against fixtures recorded from the real agent.
import { ability, type AgentCapabilities } from '../agentCapabilities'
import type { EffortLevel } from '../agents'
import { capsOf, type CatalogAgent, type CatalogModel } from './catalog'
import { ALL_MODES } from './helpers'

export const CLAUDE_RECORD: AgentCapabilities = {
  sessions: { modelSwitch: ability('native'), concurrentChats: ability('native') },
  threads: { resume: ability('native'), fork: ability('native') },
  turns: { steer: ability('native') },
  planning: { planMode: ability('native'), questions: ability('native'), goals: ability('none', 'agentCaps.why.goals') },
  approvals: { tools: ability('native'), alwaysAllow: ability('native') },
  tools: { mcp: ability('native'), terminals: ability('none', 'agentCaps.why.terminals') },
  // A subagent's own calls and messages are kept under its Task row (task_started, parent_tool_use_id) and `stopTask` stops one.
  subagents: { children: ability('native'), stop: ability('native') },
  // A switch carries the history as text (shared/fork.ts carriedHistory) whichever agent receives it.
  context: { handoff: 'prompt', compact: ability('native') },
  // Restore forks the conversation at the checkpoint's message (resumeFrom, set only from Claude's assistantMessage).
  checkpointing: { restoreFiles: true, conversationRollback: ability('native') },
  enforcement: { by: 'agent', readOnly: 'plan', permissionModes: ALL_MODES, ceilings: ALL_MODES, scopedWrites: ability('native') },
  // Reset times come from its error text and `rate_limit_event` (usageLimit.ts readsResetTime).
  usage: { cost: true, limitWindows: true, resetTime: true },
  // titles, diffTool, followups, reportTools and transcriptMirror are derived from the driver in main
  // (main/agents/capabilities.ts); the values here are what it derives, and a test holds them equal.
  // assistant, unattended, cloud, keptRunning and repoCommands are decisions made outside the driver, so they stay static;
  // every feature that asks (assistantAgents, canRunUnattended, keptRunning, repoCommands) reads them here.
  features: { assistant: true, unattended: true, cloud: true, keptRunning: true, reportTools: true, diffTool: true, followups: true, repoCommands: true, transcriptMirror: true, titles: true },
  evidence: 'recorded',
  declares: []
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const MODELS: CatalogModel[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: EFFORTS, defaultEffort: 'high', supportsFast: false, contextWindow: 1_000_000 },
  { id: 'claude-opus-5-5[1m]', label: 'Opus 5.5', efforts: EFFORTS, defaultEffort: 'high', supportsFast: true, contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5-5[1m]', label: 'Sonnet 5.5', efforts: EFFORTS, defaultEffort: 'high', supportsFast: false, contextWindow: 1_000_000 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: [], supportsFast: false, contextWindow: 200_000 }
]

export const CLAUDE_AGENT: CatalogAgent = {
  id: 'claude', name: 'Claude Code', monogram: 'Cc', level: 'full', binaries: ['claude'], versionArgs: ['--version'],
  auth: { login: { args: ['auth', 'login'], statusArgs: ['auth', 'status'] }, apiKey: { envVar: 'ANTHROPIC_API_KEY', alsoStrip: ['ANTHROPIC_AUTH_TOKEN'], keyUrl: 'https://console.anthropic.com/settings/keys', provider: 'Anthropic' }, cards: { login: 'agentSettings.claude.loginDesc', apiKey: 'agentSettings.claude.keyDesc' }, confirmed: true },
  // tested: the version in the fixtures' headers (src/main/agents/claude/fixtures), which is the CLI bundled with the pinned Agent SDK.
  // minimum: not set, because nothing here says which release first had every message the adapter reads. update: `claude update`
  // (also `upgrade`), from `claude --help`.
  versions: { tested: ['2.1.301'], update: { args: ['update'] } },
  capabilities: capsOf(CLAUDE_RECORD), docsUrl: 'https://code.claude.com/docs/en/installation', defaultEnabled: true,
  readiness: 'status', settings: { auth: 'claudeAuth', executablePath: 'claudeExecutablePath' }, models: { millionMarker: '[1m]', table: MODELS }, personaFiles: true
}
