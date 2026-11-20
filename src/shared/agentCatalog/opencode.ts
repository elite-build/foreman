// OpenCode: its catalog entry and its capability record (docs/agents.md, 2.1, 2.2). Foreman drives it through its own server
// (`opencode serve`, main/agents/opencode), not ACP.
// Each record reproduces what the adapter does TODAY: an ability is claimed only where the adapter implements it, so a later
// slice that adds one changes its record in the same commit. `evidence` is 'recorded': tests/agentCapabilityProof.test.ts proves each claim against fixtures recorded from the real agent.
import { ability, type AgentCapabilities } from '../agentCapabilities'
import { capsOf, type CatalogAgent } from './catalog'
import { ACP_MODES, NEVER_ASK, NO_FEATURES } from './helpers'

export const OPENCODE_RECORD: AgentCapabilities = {
  // The model goes with each message. A server for each turn (docs/agents.md 3.2): the process's environment names the turn
  // (`FOREMAN_TURN_ID` and its token, which `foreman report` attributes by) and the server has no environment per session, so
  // one serving several turns would run the later ones as the first. Several chats run at once, each on a server of its own.
  sessions: { modelSwitch: ability('native'), concurrentChats: ability('fallback', 'server-per-turn') },
  // OpenCode keeps its sessions itself, so a later turn's server continues one; a fork is its own session fork, before the message
  // after the point (recorded: resume.jsonl, fork.jsonl).
  threads: { resume: ability('native'), fork: ability('native') },
  // A message sent while it works goes into the busy session, and OpenCode reads it at its next step (recorded: steer.jsonl).
  turns: { steer: ability('native') },
  // Plan is OpenCode's `plan` agent, and the plan is reviewed as Codex's is (recorded: plan.jsonl); its question tool is the
  // question card (recorded: question.jsonl).
  planning: { planMode: ability('native'), questions: ability('native'), goals: ability('none', 'agentCaps.why.goals') },
  // An Always allow is OpenCode's own: a rule on the session's permission ruleset, which every later turn's server reads.
  approvals: { tools: ability('native'), alwaysAllow: ability('native') },
  // The repository's MCP servers go into the server's config; OpenCode runs its own commands.
  tools: { mcp: ability('native'), terminals: ability('none', 'agentCaps.why.terminals') },
  // Its task tool starts a child session whose events come on the same stream; stopping one aborts that session (recorded: subagents.jsonl).
  subagents: { children: ability('native'), stop: ability('native') },
  // `/compact` is OpenCode's summarize (recorded: compact.jsonl).
  context: { handoff: 'prompt', compact: ability('native') },
  // Restore puts the files back and deletes the session's messages after that point (recorded: revert.jsonl).
  checkpointing: { restoreFiles: true, conversationRollback: ability('native') },
  // Under Ask and Ask except edits the turn's server is told to ask about everything that changes or reaches out, and Foreman
  // answers each request; Auto (Claude's classifier) runs as Ask. Read-only, scoped writes and ceilings below Never ask stay off
  // until OpenCode's own rules are verified to hold its plugins too (docs/decisions.md, 2026-11-10).
  enforcement: { by: 'foreman', readOnly: null, permissionModes: ACP_MODES, ceilings: NEVER_ASK, scopedWrites: ability('none', 'agentCaps.why.scopedWrites') },
  // Each step's cost, summed over the turn and its subagents.
  usage: { cost: true, limitWindows: false, resetTime: false },
  features: { ...NO_FEATURES, cloud: true, keptRunning: true },
  evidence: 'recorded',
  // Its server's version (`/global/health`), per account.
  declares: ['version']
}

export const OPENCODE_AGENT: CatalogAgent = {
  id: 'opencode', name: 'OpenCode', monogram: 'Oc', level: 'full', binaries: ['opencode'], versionArgs: ['--version'],
  auth: { sharedKeys: true, allProviderKeys: true, confirmed: true },
  // tested: the version in the fixtures' headers (src/main/agents/opencode/fixtures), the same as the pinned @opencode-ai/sdk.
  // No update command Foreman could check.
  versions: { tested: ['1.19.6'] },
  capabilities: capsOf(OPENCODE_RECORD), docsUrl: 'https://opencode.ai/docs', defaultEnabled: true,
  readiness: 'installed', settings: { executablePath: 'opencodeExecutablePath', models: 'opencodeModels' }, models: { twoLineNames: true }
}
