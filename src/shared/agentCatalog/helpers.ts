// What the capability records share (docs/agents.md, 2.1): the permission-mode sets, the features no driver adds, and the
// record of the generic ACP adapter (main/agents/acp), which OpenCode and every Chat agent sit behind.
//
// Agent-id literals belong in this folder and nowhere else (tests/agentBranches.test.ts).
import { ability, type AgentCapabilities } from '../agentCapabilities'
import type { ApprovalPolicy } from '../permissions'

export const ALL_MODES: readonly ApprovalPolicy[] = ['ask', 'ask-except-edits', 'auto', 'never-ask']
// An ACP agent asks only when it chooses to, and Foreman answers its permission requests: Ask, Ask except edits and
// Never ask are told apart; Auto (Claude's classifier) behaves as Ask.
export const ACP_MODES: readonly ApprovalPolicy[] = ['ask', 'ask-except-edits', 'never-ask']
export const NEVER_ASK: readonly ApprovalPolicy[] = ['never-ask']

export const NO_FEATURES: AgentCapabilities['features'] = {
  assistant: false,
  unattended: false,
  cloud: false,
  keptRunning: false,
  reportTools: false,
  diffTool: false,
  followups: false,
  repoCommands: false,
  transcriptMirror: false,
  titles: false
}

/**
 * What the generic ACP adapter (main/agents/acp) does, for any agent behind it. Where an ACP agent's own declaration
 * decides (a plan session mode, whether it can resume or remember an "always allow"), the record says what the adapter
 * attempts and the adapter falls back with a notice.
 */
export function acpRecord(over: { restoreFiles: boolean; cost: boolean; keptRunning: boolean }): AgentCapabilities {
  return {
    sessions: { modelSwitch: ability('native'), concurrentChats: ability('native') },
    // session/resume or session/load when the agent offers either, else a new conversation and a notice.
    threads: { resume: ability('native'), fork: ability('fallback', 'prompt-history') },
    // ACP agents take one prompt at a time, so a follow-up waits in the queue by default. "Interrupt and send" is explicit: session/cancel,
    // then the next turn continues the session (session/resume or session/load) with the message first (docs/agents.md 2.5).
    turns: { steer: ability('fallback', 'interrupt-restart') },
    // Plan: none until the agent lists a plan session mode (`declares`): then Plan turns on (declaresPlanMode). Questions: the adapter
    // advertises form elicitation and shows `elicitation/create` as the question card (acp/elicitation.ts); whether an agent asks is its own.
    planning: { planMode: ability('none', 'agentCaps.why.plan'), questions: ability('native'), goals: ability('none', 'agentCaps.why.goals') },
    // session/request_permission. An always-allow is Foreman's: remembered for the agent's session, keyed on the tool's kind and the command
    // or path, and shown on the card ("Always allow `npm test` in this session"); a fresh process each turn means the agent's own memory
    // of an allow_always can't be counted on (docs/agents.md 8). OpenCode's record says once-always instead.
    approvals: { tools: ability('native'), alwaysAllow: ability('fallback', 'session-always') },
    // The agent's `terminal/*` requests run as piped processes (acp/terminals.ts), asked about like a shell tool; the client says so in `initialize`.
    tools: { mcp: ability('native'), terminals: ability('native') },
    subagents: { children: ability('none', 'agentCaps.why.children'), stop: ability('none', 'agentCaps.why.stopChild') },
    context: { handoff: 'prompt', compact: ability('none', 'agentCaps.why.compact') },
    // Restore puts the files back from Foreman's checkpoint; the agent's own conversation can't be rewound, so it starts a fresh one
    // seeded with the chat up to there (docs/agents.md 2.5, `checkpoint-fresh-session`).
    checkpointing: { restoreFiles: over.restoreFiles, conversationRollback: ability('fallback', 'checkpoint-fresh-session') },
    enforcement: { by: 'foreman', readOnly: null, permissionModes: ACP_MODES, ceilings: NEVER_ASK, scopedWrites: ability('none', 'agentCaps.why.scopedWrites') },
    usage: { cost: over.cost, limitWindows: false, resetTime: false },
    // Cloud: any ACP agent runs in the sandbox.
    features: { ...NO_FEATURES, cloud: true, keptRunning: over.keptRunning },
    evidence: 'simulated',
    declares: ['planMode']
  }
}
