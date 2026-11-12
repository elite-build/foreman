// The fixture format (docs/agents.md, 9.1): JSONL, a header line and then one frame per line.
//
//   {"fixture":1,"agent":"codex","scenario":"approval","version":"0.163.0","recordedAt":"2026-11-11","evidence":"recorded"}
//   {"t":0,"dir":"send","data":{...}}
//   {"t":42,"dir":"recv","data":{...}}
//
// `dir` is `send` (adapter to agent) or `recv` (agent to adapter), and two more that a process has and a message does
// not: `stderr` (text the agent wrote on its error stream) and `exit` (the process ended: `{code, signal}`). A `send`
// whose data is `{"$":"eof"}` is the adapter closing the agent's input, `{"$":"kill","signal":"SIGTERM"}` its killing it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** `recorded` real traffic, `edited` a recording with documented frames substituted, `simulated` recorded from a protocol fake, `scripted` the demo's beats. */
export type Evidence = 'recorded' | 'edited' | 'simulated' | 'scripted'
export const EVIDENCE: readonly Evidence[] = ['recorded', 'edited', 'simulated', 'scripted']

export type FrameDir = 'send' | 'recv' | 'stderr' | 'exit'

export interface Frame {
  /** Milliseconds since the recording started. */
  t: number
  dir: FrameDir
  data: unknown
}

export interface FixtureHeader {
  fixture: 1
  agent: string
  scenario: string
  /** The agent's own version when it was recorded (`claude --version`, `initialize.userAgent`, the fake's name). */
  version: string
  recordedAt: string
  evidence: Evidence
  /** The model the recording ran on, where the agent has one. */
  model?: string
  /** For an `edited` fixture: what was substituted, and from which recording. */
  edits?: string[]
  /** Anything a reader should know (what the scripted user did, what the agent did not do). */
  note?: string
}

export interface Fixture {
  header: FixtureHeader
  frames: Frame[]
}

/** The `data` of a `send` that is the adapter closing the agent's input, or killing it. */
export const EOF = { $: 'eof' } as const
export const kill = (signal: string) => ({ $: 'kill', signal })
export const isControl = (data: unknown, kind: 'eof' | 'kill'): boolean => typeof data === 'object' && data !== null && (data as { $?: unknown }).$ === kind

export function formatFixture(fixture: Fixture): string {
  return [JSON.stringify(fixture.header), ...fixture.frames.map((f) => JSON.stringify(f))].join('\n') + '\n'
}

export function parseFixture(text: string, source = 'fixture'): Fixture {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) throw new Error(`${source} is empty`)
  let header: FixtureHeader
  try {
    header = JSON.parse(lines[0]) as FixtureHeader
  } catch {
    throw new Error(`${source}: the first line is not a JSON header`)
  }
  if (header.fixture !== 1) throw new Error(`${source}: unknown fixture format ${String(header.fixture)}`)
  if (!EVIDENCE.includes(header.evidence)) throw new Error(`${source}: unknown evidence "${String(header.evidence)}"`)
  const frames = lines.slice(1).map((line, i) => {
    let frame: Frame
    try {
      frame = JSON.parse(line) as Frame
    } catch {
      throw new Error(`${source}: line ${i + 2} is not JSON`)
    }
    if (typeof frame.t !== 'number' || !['send', 'recv', 'stderr', 'exit'].includes(frame.dir)) throw new Error(`${source}: line ${i + 2} is not a frame`)
    return frame
  })
  return { header, frames }
}

/** The folder under src/main/agents that holds an agent's fixtures: its own, or the shared ACP one. */
export function fixtureFolder(agent: string): string {
  return ['claude', 'codex', 'cursor', 'opencode'].includes(agent) ? agent : 'acp'
}

let root = process.cwd()
/** The repository root fixtures are read from (the app sets it in development; tests run from it). */
export function setFixturesRoot(dir: string): void {
  root = dir
}

export function fixturePath(agent: string, scenario: string, repoRoot = root): string {
  return path.join(repoRoot, 'src', 'main', 'agents', fixtureFolder(agent), 'fixtures', `${scenario}.jsonl`)
}

export function hasFixture(agent: string, scenario: string): boolean {
  return existsSync(fixturePath(agent, scenario))
}

export function readFixture(agent: string, scenario: string): Fixture {
  const file = fixturePath(agent, scenario)
  return parseFixture(readFileSync(file, 'utf8'), path.basename(file))
}

export function writeFixture(fixture: Fixture, file = fixturePath(fixture.header.agent, fixture.header.scenario)): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, formatFixture(fixture))
  return file
}
