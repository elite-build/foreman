// The turn-start guard (docs/agents.md 8, "Ceiling everywhere"). Every path that starts an agent's turn reaches
// `SessionService.startTurn`, which builds the request (the ceiling's cap, the permission mode, the scoped writes, read-only) and
// then starts the turn at one place. A new `createTurn(` anywhere else would start a turn that skipped all of that, so this fails on
// any call outside the files below, each with the reason it may. The agents' own folder (adapters, the recorder, the replay and the
// protocol fakes) is the other side of the seam: they are what `createTurn` is.
//
// A declaration (`createTurn(request: TurnRequest, …): AgentTurn`, a host's method of that name) is not a call. Everything else that
// names `createTurn` in a file not listed here fails: a call, a destructured or aliased reference, a `.bind`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The files outside src/main/agents/ that call `createTurn`, and why each may. */
const MAY_START_A_TURN: Record<string, string> = {
  'src/main/sessions.ts': 'startTurn: the one path of a chat, a flow step, a schedule, a hand-off, an outside agent, the phone and the CLI. It builds the request, with the ceiling, then calls the host or the driver.',
  'src/main/agentHost/server.ts': 'the background agent host process runs a request SessionService built and sent over IPC; it adds only the host tools and the session store.',
  'src/main/agentHost/sandboxHost.ts': 'the same host inside a cloud sandbox: it wraps the driver to give the request the sandbox’s environment and binary, and changes nothing else about it.',
  'src/main/cursorWorker.ts': 'Cursor’s worker process runs the request SessionService built and forwarded to it; the SDK lives in this process, not Foreman’s.',
  'src/main/assistant.ts': 'the Assistant’s own turn: its folder is its own, with no workspace, and it is locked to its own tools, so no ceiling or scope applies to it.',
  'src/main/demoRun.ts': 'the demo’s driver: a scripted turn or the replay driver over recorded traffic; no real agent starts.'
}

/** src/main/agents/ is the seam: adapters, the replay and recorder, and the protocol fakes. */
const SEAM = 'src/main/agents/'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'protocol' || name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

const posix = (p: string) => p.split('\\').join('/')

/** The text with comments blanked, so a mention of `createTurn(` in a comment is not a call. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, (_m, before: string) => before)
}

const DECLARATION = /^createTurn\(\s*[A-Za-z_]\w*\??\s*:/

/** Every reference to `createTurn` in a file that is not a declaration, with its line. */
function startsOf(text: string): { line: number; code: string }[] {
  const clean = withoutComments(text)
  const out: { line: number; code: string }[] = []
  for (const match of clean.matchAll(/\bcreateTurn\b/g)) {
    const rest = clean.slice(match.index)
    if (DECLARATION.test(rest)) continue
    const line = clean.slice(0, match.index).split('\n').length
    out.push({ line, code: clean.split('\n')[line - 1].trim() })
  }
  return out
}

const files = walk('src').map(posix)
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

describe('every turn starts through startTurn', () => {
  it('no file but the listed ones, and the agents’ own folder, starts a turn', () => {
    const strays = files
      .filter((f) => !f.startsWith(SEAM) && !(f in MAY_START_A_TURN))
      .flatMap((f) => startsOf(sources.get(f)!).map((s) => `${f}:${s.line}  ${s.code}`))
    expect(strays, 'a turn started outside startTurn skips the ceiling, the permission mode, the scoped writes and read-only: build the request in SessionService instead, or list the file in MAY_START_A_TURN with the reason').toEqual([])
  })

  it('every listed file still starts one, so the list only names what is real', () => {
    for (const file of Object.keys(MAY_START_A_TURN)) {
      expect(sources.has(file), `${file} is gone: remove it from the list`).toBe(true)
      expect(startsOf(sources.get(file)!).length, `${file} no longer starts a turn: remove it from the list`).toBeGreaterThan(0)
    }
  })

  it('every listed file says why', () => {
    for (const reason of Object.values(MAY_START_A_TURN)) expect(reason.length).toBeGreaterThan(30)
  })

  it('a stray call is what the guard looks for: it sees one in a file that is not listed, and ignores comments and declarations', () => {
    expect(startsOf('const turn = driver.createTurn(req, cb)').map((s) => s.line)).toEqual([1])
    expect(startsOf('const { createTurn } = driver\nconst make = driver.createTurn.bind(driver)').map((s) => s.line)).toEqual([1, 2])
    expect(startsOf('// driver.createTurn(req, cb)\n/* host.createTurn(a, b) */\n  createTurn(session: Session, ws: Workspace): AgentTurn {}')).toEqual([])
  })
})
