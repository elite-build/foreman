// Replay in development, and the demo (docs/agents.md, 9.5). Replay is NOT an agent kind (a `replay` id would enter every
// per-agent map, and a dev build could persist it into data a packaged build later reads). While it is on, Claude Code and
// Codex run through their own adapters, over ReplayTransport, playing the recording a word in the prompt picks, and the
// chat says "Replaying a recording" on each turn.
//
// Nothing here runs in a packaged build: main configures it only when `!app.isPackaged` (index.ts), and `enabled()` is the
// setting (Settings → Experimental → Replay recorded traffic) or, in the demo, always.
import type { AgentDriver } from '../types'
import { hasFixture, readFixture, setFixturesRoot } from './format'
import { replayTransport, type ReplayHandle } from './replayTransports'

export interface ReplayConfig {
  /** Whether a turn should be replayed now (the setting). */
  enabled(): boolean
  /** The repository root the fixtures are read from. */
  root: string
  /** 1 (the default) plays at the speed it was recorded; 0 as fast as it can (tests). */
  speed?: number
  /** The notice's text, in the person's language. */
  notice(): string
}

/** Words in a message that pick a recording: the scenario that has the same name, else `plain`. */
const WORDS = ['approval', 'question', 'plan', 'limit', 'crash'] as const

export function scenarioFor(prompt: string): string {
  const found = WORDS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(prompt))
  return found ?? 'plain'
}

/** The agents replay can stand in for: the ones that were recorded. */
export const REPLAYED_AGENTS = ['claude', 'codex'] as const

let config: ReplayConfig | undefined
let handles: ReplayHandle[] = []

/** Turns replay on for development (or off, with undefined). Idempotent. */
export function configureReplay(next: ReplayConfig | undefined): void {
  for (const h of handles) h.uninstall()
  handles = []
  config = next
  if (!next) return
  setFixturesRoot(next.root)
  for (const agent of REPLAYED_AGENTS) {
    handles.push(
      replayTransport(
        agent,
        (req) => readFixture(agent, hasFixture(agent, scenarioFor(req.prompt)) ? scenarioFor(req.prompt) : 'plain'),
        // At the speed it was recorded, long silences cut short.
        { speed: next.speed ?? 1, maxGapMs: 1500 },
        () => Boolean(config?.enabled())
      )
    )
  }
}

export const replaying = (): boolean => Boolean(config?.enabled())

/** The driver, saying "Replaying a recording" at the start of each turn that is. Unchanged while replay is off. */
export function replayAware(driver: AgentDriver): AgentDriver {
  return {
    ...driver,
    createTurn: (req, cb) => {
      if (config?.enabled()) cb.item({ kind: 'notice', id: `${req.turnId}:replay`, turnId: req.turnId, level: 'info', text: config.notice() })
      return driver.createTurn(req, cb)
    }
  }
}
