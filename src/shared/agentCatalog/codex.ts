// Codex: its catalog entry and its capability record (docs/agents.md, 2.1, 2.2).
// Each record reproduces what the adapter does TODAY: an ability is claimed only where the adapter implements it, so a later
// slice that adds one changes its record in the same commit. `evidence` is 'recorded': tests/agentCapabilityProof.test.ts proves each claim against fixtures recorded from the real agent.
import { ability, type AgentCapabilities } from '../agentCapabilities'
import type { EffortLevel } from '../agents'
import { capsOf, type CatalogAgent, type CatalogModel } from './catalog'
import { ALL_MODES, NO_FEATURES } from './helpers'

export const CODEX_RECORD: AgentCapabilities = {
  sessions: { modelSwitch: ability('native'), concurrentChats: ability('native') },
  // `thread/resume` continues it; `thread/fork` with the turn the conversation last ended at forks it (recorded: fork.jsonl).
  threads: { resume: ability('native'), fork: ability('native') },
  turns: { steer: ability('native') },
  // `thread/goal/set` and `/updated`: Codex works toward a goal by itself, turn after turn (recorded: goal.jsonl, goalclear.jsonl).
  planning: { planMode: ability('native'), questions: ability('native'), goals: ability('native') },
  // `acceptForSession` when Codex offers to remember (codex.ts execApproval).
  approvals: { tools: ability('native'), alwaysAllow: ability('native') },
  tools: { mcp: ability('native'), terminals: ability('none', 'agentCaps.why.terminals') },
  subagents: { children: ability('none', 'agentCaps.why.children'), stop: ability('none', 'agentCaps.why.stopChild') },
  // `/compact` goes to `thread/compact/start` (recorded: compact.jsonl).
  context: { handoff: 'prompt', compact: ability('native') },
  // Restore puts the files back and cuts the thread's history back to that message with `thread/revert` (recorded: revert.jsonl).
  checkpointing: { restoreFiles: true, conversationRollback: ability('native') },
  // Its sandbox and approval policy come from the mode Foreman gives each turn (codex.ts codexSettings): any ceiling holds.
  // Scoped writes: the read-only sandbox, `on-request`, and Foreman answering every request against the persona's globs (recorded: scoped.jsonl), where the sandbox is ready (resolveCapabilities takes it away for an account whose isn't).
  enforcement: { by: 'agent', readOnly: 'sandbox', permissionModes: ALL_MODES, ceilings: ALL_MODES, scopedWrites: ability('native') },
  // Codex reports token usage (`thread/tokenUsage/updated`) and no price: its result row has no costUsd (the recorded
  // fixtures show it). Its windows come from `account/rateLimits/updated` during a turn and `account/rateLimits/read`
  // between them, and a failed turn takes the reset time of the blocked one.
  usage: { cost: false, limitWindows: true, resetTime: true },
  features: { ...NO_FEATURES, cloud: true, keptRunning: true },
  evidence: 'recorded',
  // `windowsSandbox/readiness`, read at the start of a turn on Windows: a sandbox that isn't ready takes read-only and scoped writes away from that account (resolveCapabilities).
  declares: ['windowsSandbox']
}

const EFFORTS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh']

const MODELS: CatalogModel[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: EFFORTS, defaultEffort: 'high', supportsFast: true, contextWindow: 500_000 },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: EFFORTS, defaultEffort: 'high', supportsFast: true, contextWindow: 272_000 },
  { id: 'gpt-5.5', label: 'GPT-5.5', efforts: EFFORTS, defaultEffort: 'high', supportsFast: true, contextWindow: 272_000 }
]

export const CODEX_AGENT: CatalogAgent = {
  id: 'codex', name: 'Codex', monogram: 'Cx', level: 'full', binaries: ['codex'], versionArgs: ['--version'],
  auth: { login: { args: ['login'] }, apiKey: { envVar: 'CODEX_API_KEY', alsoStrip: ['AI_GATEWAY_API_KEY', 'OPENAI_BASE_URL'], keyUrl: 'https://platform.openai.com/api-keys', importEnv: ['OPENAI_API_KEY'], provider: 'OpenAI' }, cards: { login: 'agentSettings.codex.loginDesc', apiKey: 'agentSettings.codex.keyDesc' }, confirmed: true },
  // tested: the version in the fixtures' headers (src/main/agents/codex/fixtures), which is the bundled @openai/codex.
  // minimum: not set. The pinned generated protocol says which methods exist in 0.163.0, not in which release each first
  // appeared. update: `codex update`, from `codex --help`.
  versions: { tested: ['0.163.0'], update: { args: ['update'] } },
  capabilities: capsOf(CODEX_RECORD), docsUrl: 'https://github.com/openai/codex', defaultEnabled: true,
  readiness: 'status', models: { table: MODELS },
  settings: { auth: 'codexAuth', executablePath: 'codexExecutablePath', approvals: { field: 'codexApprovals', notes: { always: 'permissions.codex.always', sandboxed: 'permissions.codex.sandboxed' } } }
}
