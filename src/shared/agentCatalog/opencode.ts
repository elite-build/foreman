// OpenCode: its catalog entry and its capability record (docs/agents.md, 2.1, 2.2). It speaks ACP, so its record is the
// generic ACP adapter's (helpers.ts), as it is today.
// Each record reproduces what the adapter does TODAY: an ability is claimed only where the adapter implements it, so a later
// slice that adds one changes its record in the same commit. `evidence` is 'simulated' until a recording proves it.
import { ability, type AgentCapabilities } from '../agentCapabilities'
import { capsOf, type CatalogAgent } from './catalog'
import { acpRecord } from './helpers'

const ACP = acpRecord({ restoreFiles: true, cost: true, keptRunning: true })

export const OPENCODE_RECORD: AgentCapabilities = {
  ...ACP,
  // A server for each turn, whatever its version (docs/agents.md 3.2): the process's environment names the turn (`FOREMAN_TURN_ID` and its
  // token, which `foreman report` attributes by) and ACP has no environment per session, so one server serving several turns would run
  // the later ones as the first. Several chats run at once, each on a process of its own.
  sessions: { ...ACP.sessions, concurrentChats: ability('fallback', 'server-per-turn') },
  // Its "always" can't be relied on: Foreman starts a fresh `opencode acp` for every turn, so whatever the agent remembered in its own process is gone by the next one. Nothing recorded shows OpenCode remembering an
  // always-allow across turns, so the card has no Always allow button and says it asks each time (docs/agents.md 8).
  approvals: { ...ACP.approvals, alwaysAllow: ability('fallback', 'once-always') },
  declares: ['planMode', 'version']
}

export const OPENCODE_AGENT: CatalogAgent = {
  id: 'opencode', name: 'OpenCode', monogram: 'Oc', level: 'full', binaries: ['opencode'], versionArgs: ['--version'],
  auth: { sharedKeys: true, allProviderKeys: true, confirmed: true },
  // Nothing recorded (its fixtures are simulated) and no update command Foreman could check: it isn't installed where this was built.
  versions: { tested: [] },
  capabilities: capsOf(OPENCODE_RECORD), docsUrl: 'https://opencode.ai/docs', defaultEnabled: true,
  readiness: 'installed', settings: { executablePath: 'opencodeExecutablePath', models: 'opencodeModels' }, models: { twoLineNames: true }
}
