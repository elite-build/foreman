// Cursor: its catalog entry and its capability record (docs/agents.md, 2.1, 2.2).
// Each record reproduces what the adapter does TODAY: an ability is claimed only where the adapter implements it, so a later
// slice that adds one changes its record in the same commit. `evidence` is 'simulated' until a recording proves it.
import { ability, type AgentCapabilities } from '../agentCapabilities'
import { capsOf, type CatalogAgent, type CatalogModel } from './catalog'
import { NEVER_ASK, NO_FEATURES } from './helpers'

export const CURSOR_RECORD: AgentCapabilities = {
  sessions: { modelSwitch: ability('native'), concurrentChats: ability('native') },
  threads: { resume: ability('native'), fork: ability('fallback', 'prompt-history') },
  // `steer()` returns false: a follow-up waits in the queue by default. "Interrupt and send" is explicit: run.cancel(), then the
  // next turn resumes the same agent (Agent.resume) with the message first (docs/agents.md 2.5; the `interrupt` and `resume` fixtures).
  turns: { steer: ability('fallback', 'interrupt-restart') },
  // The SDK's `send` takes a plan mode, but Foreman doesn't offer it.
  planning: { planMode: ability('none', 'agentCaps.why.plan'), questions: ability('none', 'agentCaps.why.questions'), goals: ability('none', 'agentCaps.why.goals') },
  // "Cursor runs tools without asking: its SDK has no approval prompts" (cursor.ts). The catalog's `approvals` chip says
  // otherwise for Cursor and is left as it was (capsOf in catalog.ts).
  approvals: { tools: ability('none', 'agentCaps.why.approvals'), alwaysAllow: ability('none', 'agentCaps.why.alwaysAllow') },
  tools: { mcp: ability('native'), terminals: ability('none', 'agentCaps.why.terminals') },
  subagents: { children: ability('none', 'agentCaps.why.children'), stop: ability('none', 'agentCaps.why.stopChild') },
  context: { handoff: 'prompt', compact: ability('none', 'agentCaps.why.compact') },
  checkpointing: { restoreFiles: true, conversationRollback: ability('fallback', 'checkpoint-fresh-session') },
  enforcement: { by: 'foreman', readOnly: null, permissionModes: NEVER_ASK, ceilings: NEVER_ASK, scopedWrites: ability('none', 'agentCaps.why.scopedWrites') },
  // The SDK reports token usage and no price: its result row has no costUsd.
  usage: { cost: false, limitWindows: false, resetTime: false },
  // reportTools: the SDK's in-process custom tools (cursor.ts cursorReportTools). Cloud: its SDK runs on this computer.
  features: { ...NO_FEATURES, reportTools: true, keptRunning: true },
  evidence: 'simulated',
  declares: []
}

const MODELS: CatalogModel[] = [
  { id: 'auto', label: 'Auto', efforts: [], supportsFast: false, contextWindow: 200_000 },
  { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFast: true, contextWindow: 256_000 },
  { id: 'composer-2.5', label: 'Composer 2.5', efforts: [], supportsFast: true, contextWindow: 200_000 }
]

export const CURSOR_AGENT: CatalogAgent = {
  id: 'cursor', name: 'Cursor', monogram: 'Cu', level: 'full', binaries: ['cursor-agent'], versionArgs: ['--version'],
  auth: { apiKey: { envVar: 'CURSOR_API_KEY', keyUrl: 'https://cursor.com/dashboard/api?section=user-keys#user-api-keys', provider: 'Cursor' }, confirmed: true },
  // Nothing recorded (its fixtures are simulated) and no update command Foreman could check: its program isn't installed where this was built.
  versions: { tested: [] },
  capabilities: capsOf(CURSOR_RECORD), docsUrl: 'https://docs.cursor.com/en/cli/installation', defaultEnabled: true,
  readiness: 'key', models: { table: MODELS }, reportToolsNote: 'g1.reports.cursorTools', notInCloud: 'its SDK runs the agent on this computer'
}
