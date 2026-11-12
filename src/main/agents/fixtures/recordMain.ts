// What `npm run record:agent -- <agent> <scenario>` does once vitest has loaded it (the script is scripts/record-agent.mjs; a
// TypeScript entry that can import the drivers needs a bundler, and vitest is the one already here). Real agents (Claude Code,
// Codex) are recorded; `limit` is made from `plain`; the agents that aren't installed where this was built are recorded from
// protocol fakes (simulate.ts) and marked `simulated`.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeLimitFrom, claudeRecorder } from '../claude/record'
import { codexLimitFrom, codexRecorder } from '../codex/record'
import { fixturePath, formatFixture, parseFixture, readFixture, writeFixture, type Fixture } from './format'
import { findLeaks, sanitizeFixture } from './sanitize'
import { recordScenario, SCENARIOS, type AgentRecorder, type Scenario } from './recorder'
import { simulateAll } from './simulate'

const RECORDERS: Record<string, AgentRecorder> = { claude: claudeRecorder, codex: codexRecorder }
const LIMITS: Record<string, (plain: Fixture) => Fixture> = { claude: claudeLimitFrom, codex: codexLimitFrom }

export const RECORDABLE = Object.keys(RECORDERS)

/**
 * `npm run record:agent -- resanitize`: every fixture in the repository through the sanitiser again, in place, without running
 * an agent. For when the sanitiser learns something (it is idempotent: what is already a placeholder stays one).
 */
export function resanitizeAll(log: (text: string) => void = console.log): void {
  const base = path.join(process.cwd(), 'src', 'main', 'agents')
  for (const folder of readdirSync(base).filter((n) => statSync(path.join(base, n)).isDirectory())) {
    const dir = path.join(base, folder, 'fixtures')
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(dir, name)
      const before = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      const after = formatFixture(sanitizeFixture(parseFixture(before, name), { repo: '', tmp: '', home: os.homedir(), aliases: [{ path: os.tmpdir(), as: 'tmp' }], username: os.userInfo().username }))
      if (after !== before) writeFileSync(file, after)
      log(`${folder}/${name}: ${after === before ? 'unchanged' : 'sanitised'}`)
    }
  }
}

export async function recordMain(agent: string, scenario: string, log: (text: string) => void = console.log): Promise<void> {
  if (agent === 'resanitize') return resanitizeAll(log)
  if (agent === 'simulated') return simulateAll(log)
  if (!SCENARIOS.includes(scenario as Scenario)) throw new Error(`unknown scenario "${scenario}"; one of ${SCENARIOS.join(', ')}`)
  if (scenario === 'limit') {
    const edit = LIMITS[agent]
    if (!edit) throw new Error(`no limit edit for ${agent}`)
    if (!existsSync(fixturePath(agent, 'plain', process.cwd()))) throw new Error(`record ${agent} plain first: limit is made from it`)
    const limit = edit(readFixture(agent, 'plain'))
    const file = writeFixture(limit, fixturePath(agent, 'limit', process.cwd()))
    log(`wrote ${file} (${limit.frames.length} frames, edited from plain: ${limit.header.edits?.join('; ')})`)
    return
  }
  const spec = RECORDERS[agent]
  if (!spec) throw new Error(`cannot record "${agent}" here; one of ${RECORDABLE.join(', ')}`)
  const result = await recordScenario(spec, scenario as Scenario, log)
  log(result.file ? `wrote ${result.file}` : 'wrote nothing')
  log(`  ${result.frames} frames, ${result.items} chat items, version ${result.version}, result ${JSON.stringify(result.result)}${result.costUsd !== undefined ? `, cost $${result.costUsd.toFixed(4)}` : ''}`)
  if (result.leaks.length) {
    log('LEAKS (nothing was written; fix the sanitiser, then record again):')
    for (const leak of result.leaks) log(`  ${leak}`)
    process.exitCode = 1
    throw new Error('the recording holds something that must not be committed')
  }
}
