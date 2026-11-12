// npm run record:agent -- <agent> <scenario>   (docs/agents.md, section 9.2)
//
// Runs the real driver of <agent> in a temporary Git repository, with a scripted person, and writes the traffic as a
// sanitised fixture to src/main/agents/<agent>/fixtures/<scenario>.jsonl. It starts the real agent, so it costs real usage;
// `npm test` never runs it.
//
//   agents:     claude, codex      (the others are recorded from protocol fakes by `npm run record:agent -- simulated`)
//   `simulated` rewrites the simulated fixtures from the fakes; `resanitize` runs every fixture through the sanitiser again, in place.
//   scenarios:  (sandbox: Codex on Windows, the start-up that reads the sandbox's readiness; scoped: Codex held to a persona's writes) plain approval question plan steer interrupt crash resume, fork revert compact goal goalclear (Codex, and compact for Claude), subagents (Claude),
//               and limit (made from plain, no agent is run)
//
// It is a script that needs the TypeScript drivers, so it runs them under vitest (vitest.record.config.ts), the one
// bundler already installed; nothing else is added. Needs Claude Code or Codex signed in on this computer.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [agent, scenario] = process.argv.slice(2)
const AGENTS = ['claude', 'codex', 'simulated', 'resanitize']
const SCENARIOS = ['plain', 'approval', 'question', 'plan', 'steer', 'interrupt', 'limit', 'crash', 'resume', 'fork', 'revert', 'compact', 'goal', 'goalclear', 'subagents', 'terminal', 'version1', 'version2', 'sandbox', 'scoped']

if (!AGENTS.includes(agent ?? '') || (!['simulated', 'resanitize'].includes(agent) && !SCENARIOS.includes(scenario ?? ''))) {
  console.error(`usage: npm run record:agent -- <${AGENTS.join('|')}> <${SCENARIOS.join('|')}>`)
  process.exit(2)
}

const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.record.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RECORD_AGENT: agent, RECORD_SCENARIO: scenario ?? '' }
})
process.exit(result.status ?? 1)
