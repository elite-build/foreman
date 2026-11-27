// Dev-only demo (main/demo.ts): flow runs that are going when the demo opens, so you can watch them move. Each launch
// starts two, through the real flow engine, checks and chats; only the agent is a script.
// - "Fix until green" on atlas: its first version has an off-by-one the tests catch, the fix makes them pass, the
//   reviewer finds two things, the second review is clean, and the run waits at its ship-check gate for you.
// - "Document what changed" on beacon: the developer adds a health check, the checks pass, and the docs writer's turn
//   stops at the account's usage limit. The run waits for the reset (its tab offers Resume now), then the docs are
//   written, QA finds them right, and it waits at its gate for you.
// The previous launch's demo runs (which the restart left uncertain) and their workspaces are deleted first, so launches
// don't pile them up. An AI employee's turn is main/demoEmployees.ts's script.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { AGENTS, type AgentKind } from '../shared/agents'
import { translate } from '../shared/i18n'
import { isActiveRun } from '../shared/flows'
import { RESUME_TEXT } from '../shared/usageLimit'
import type { ChatItem } from '../shared/types'
import { claudeDriver } from './agents/claude'
import { codexDriver } from './agents/codex'
import { configureReplay, replayAware } from './agents/fixtures/replayDriver'
import { registerDriver } from './agents/registry'
import type { AgentDriver, AgentTurn, TurnCallbacks, TurnRequest } from './agents/types'
import { commandHash } from './checks'
import type { Core } from './core'
import { demoCost, EmployeeDemoTurn, isEmployeeTurn } from './demoEmployees'
import { git } from './git'
import { mainT } from './i18n'
import type { Store } from './store'

const FLOW_ID = 'built-in:fix-until-green'
const TASK = 'Add a retry with backoff to the API client: retry a failed request up to 3 times, waiting 200 ms, then 400 ms, then 800 ms.'
const RETRY = 'src/retry.ts'
const RETRY_TEST = 'src/retry.test.ts'
const IDENTITY = ['-c', 'user.name=Foreman Demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false']

// ---- what the demo adds to atlas: two check commands and the scripts they run ----

const CHECKS_TOML = `[[checks]]
name = "Tests"
command = "npm test"

[[checks]]
name = "Types"
command = "npm run typecheck"
`

// The demo's "test run": a few seconds, then it fails while src/retry.ts gives up one retry late. A script, not vitest,
// so the demo needs no install.
const TEST_SCRIPT = `import { existsSync, readFileSync } from 'node:fs'

await new Promise((resolve) => setTimeout(resolve, 3000))
const source = existsSync('${RETRY}') ? readFileSync('${RETRY}', 'utf8') : ''
if (!source) {
  console.log(' FAIL  ${RETRY_TEST}\\n   Cannot find module ./retry')
  process.exit(1)
}
if (source.includes('attempt > MAX_RETRIES')) {
  console.log(' FAIL  ${RETRY_TEST} > fetchWithRetry > gives up after 3 retries')
  console.log('   AssertionError: expected "fetch" to be called 4 times, but got 5 times')
  console.log('\\n Test Files  1 failed (1)\\n      Tests  1 failed | 3 passed (4)')
  process.exit(1)
}
console.log(' ✓ ${RETRY_TEST} (' + (source.includes('isIdempotent') ? 6 : 4) + ' tests) 38ms\\n\\n Test Files  1 passed (1)')
`

const TYPECHECK_SCRIPT = `await new Promise((resolve) => setTimeout(resolve, 2000))
console.log('No type errors.')
`

// ---- beacon's run: "Document what changed", with one check, and the docs step held at the usage limit ----

const BEACON_FLOW_ID = 'built-in:document-what-changed'
const BEACON_TASK = 'Add a /healthz endpoint to Beacon that answers 200 with the running version, for the load balancer.'
const BEACON_CHECKS_TOML = `[[checks]]
name = "Vet"
command = "node scripts/vet.mjs"
`
const BEACON_VET = `await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('go vet ./...\\nok   beacon  0.412s')
`
const MAIN_GO = 'package main\n\nfunc main() {}\n'
const MAIN_GO_V1 = `package main

import (
\t"fmt"
\t"net/http"
)

var version = "1.4.0"

func healthz(w http.ResponseWriter, r *http.Request) {
\tfmt.Fprintf(w, "ok %s\\n", version)
}

func main() {
\thttp.HandleFunc("/healthz", healthz)
\thttp.ListenAndServe(":8080", nil)
}
`
const HEALTH_DOCS = '\n## Health check\n\n`GET /healthz` answers `200 ok <version>` while Beacon is up. Point the load balancer’s health check at it.\n'
// The flow steps' working folders whose turn has already stopped at the limit once: the next one goes on.
const limited = new Set<string>()
// The out-of-credits chat in Lumen (demoLumen.ts): what its Resume or Continue on another account plays.
const TOML_CONFIG = `import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'smol-toml'

export interface Config {
  theme: string
  pageSize: number
}

/** lumen.toml, or .lumenrc.json until 1.0. */
export function loadConfig(): Config {
  if (existsSync('lumen.toml')) {
    const toml = parse(readFileSync('lumen.toml', 'utf8')) as { theme?: string; page_size?: number }
    return { theme: toml.theme ?? 'auto', pageSize: toml.page_size ?? 100 }
  }
  return JSON.parse(readFileSync('.lumenrc.json', 'utf8')) as Config
}
`

// ---- the code the scripted agent writes ----

const RETRY_V1 = `const MAX_RETRIES = 3
const BASE_DELAY_MS = 200

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fetch, retrying a failed request with backoff: 200 ms, 400 ms, 800 ms. */
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, init)
      if (response.ok || attempt > MAX_RETRIES) return response
    } catch (error) {
      if (attempt > MAX_RETRIES) throw error
    }
    await sleep(BASE_DELAY_MS * 2 ** attempt)
  }
}
`

const RETRY_TEST_V1 = `import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithRetry } from './retry'

afterEach(() => vi.unstubAllGlobals())

describe('fetchWithRetry', () => {
  it('returns the first good response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    expect((await fetchWithRetry('/api')).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 retries', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const response = fetchWithRetry('/api')
    await vi.runAllTimersAsync()
    expect((await response).status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
`

/** Each pair is one Edit: the text it replaces and the text it puts there. */
const FIX: [string, string][] = [
  ['if (response.ok || attempt > MAX_RETRIES) return response', 'if (response.ok || attempt >= MAX_RETRIES) return response'],
  ['if (attempt > MAX_RETRIES) throw error', 'if (attempt >= MAX_RETRIES) throw error']
]

const ADDRESS: [string, string][] = [
  [
    'const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))\n',
    "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))\n\n/** Worth another try: the server failed or was busy, never a request it refused. */\nconst isRetryable = (status: number) => status >= 500 || status === 429\n\n/** Safe to send twice: a retried POST could create the same thing twice. */\nconst isIdempotent = (method = 'GET') => ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method.toUpperCase())\n"
  ],
  [
    '  for (let attempt = 0; ; attempt++) {\n    try {\n      const response = await fetch(url, init)\n      if (response.ok || attempt >= MAX_RETRIES) return response',
    '  if (!isIdempotent(init?.method)) return fetch(url, init)\n  for (let attempt = 0; ; attempt++) {\n    try {\n      const response = await fetch(url, init)\n      if (response.ok || !isRetryable(response.status) || attempt >= MAX_RETRIES) return response'
  ]
]

const FINDINGS = [
  { severity: 'medium', file: RETRY, line: 7, title: 'POST and PATCH requests are retried', body: 'A request the server got before the connection dropped is sent again, so a POST can create the same thing twice. Retry only idempotent methods.' },
  { severity: 'low', file: RETRY, line: 11, title: 'A 4xx response is retried', body: 'A 400 or 404 fails the same way every time, so the user waits 1.4 s for nothing. Only 5xx and 429 are worth another try.' }
]

const findingsBlock = (findings: unknown[]) => '```foreman-findings\n' + JSON.stringify(findings, null, 2) + '\n```'

// ---- the scripted agent ----

/** One thing the agent does: a tool call that takes `ms`, or words it streams. */
type Beat =
  | { tool: string; input: Record<string, unknown>; output: string; ms: number; write?: { file: string; text: string } }
  | { say: string }
  // The turn stops at the account's usage limit, which resets in this many minutes (once per working folder).
  | { limit: number }

function read(cwd: string, file: string): string {
  const full = path.join(cwd, file)
  return existsSync(full) ? readFileSync(full, 'utf8') : ''
}

/** Edit tool calls that apply `pairs` to the file as it is now, in order. */
function edits(cwd: string, file: string, pairs: [string, string][]): Beat[] {
  let text = read(cwd, file)
  return pairs.map(([before, after]) => {
    text = text.replace(before, after)
    return { tool: 'Edit', input: { file_path: file, old_string: before, new_string: after }, output: `The file ${file} has been updated.`, ms: 1800, write: { file, text } }
  })
}

const testRun = (tests: number): Beat => ({
  tool: 'Bash',
  input: { command: 'npm test -- retry', description: 'Run the retry tests' },
  output: ` ✓ ${RETRY_TEST} (${tests} tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  ${tests} passed (${tests})`,
  ms: 3500
})

const GENERIC_REPLY = 'This is the demo: no agent runs here, so this reply is a script and nothing in the workspace changed.'

/** A message the script answers itself: one of the flow run's steps, or a chat asking for background work. */
const isFlowBeat = (request: TurnRequest): boolean => {
  if (wantsBackground(request)) return true
  const beats = script(request)
  return !(beats.length === 1 && 'say' in beats[0] && beats[0].say === GENERIC_REPLY)
}

/** A chat message that mentions background work gets the scripted background turn (BackgroundDemo), to show its block. */
const wantsBackground = (request: TurnRequest): boolean => /\bbackground\b/i.test(request.prompt)

// The background turn's subagent: what it reads, one call every ~2.5 s, then how it ends.
const SUBAGENT_STEPS: [string, Record<string, unknown>][] = [
  ['Grep', { pattern: 'fetch\\(', path: 'src' }],
  ['Read', { file_path: 'src/login.ts' }],
  ['Grep', { pattern: 'retry', path: 'src' }],
  ['Read', { file_path: 'src/session.ts' }],
  ['Glob', { pattern: 'src/**/*.test.ts' }],
  ['Read', { file_path: 'tests/session.test.ts' }],
  ['Grep', { pattern: 'status === 4', path: 'src' }]
]
// The background shell's progress lines, one every ~2.5 s.
const SHELL_LINES = ['Building the app', 'Captured home.png (1/5)', 'Captured workspace-chat.png (2/5)', 'Captured file-diff.png (3/5)', 'Captured settings.png (4/5)']

/**
 * A Claude-style turn with background work: it starts a shell and a subagent in the background, answers, then waits on
 * them (as the Claude adapter does, with its "Waiting for…" notice) while they report progress, and adds to its answer
 * once both have ended. The subagent can be stopped on its own.
 */
class BackgroundDemo {
  private shell: Extract<ChatItem, { kind: 'tool' }>
  private agent: Extract<ChatItem, { kind: 'tool' }>
  private agentStopped = false

  constructor(private kind: AgentKind, private request: TurnRequest, private cb: TurnCallbacks, private signal: AbortSignal) {
    const { turnId } = request
    const startedAt = new Date().toISOString()
    this.shell = {
      kind: 'tool', id: `${turnId}:bg-shell`, turnId, name: 'Bash',
      input: { command: 'npm run screens -- --only home,workspace-chat,file-diff,settings', description: 'Capture the main screens', run_in_background: true },
      status: 'done', output: 'Command running in background with ID: demo-shell',
      task: { status: 'running', background: true, startedAt, summary: 'Starting' }
    }
    this.agent = {
      kind: 'tool', id: `${turnId}:bg-agent`, turnId, name: 'Task',
      input: { description: 'Find every request the retry should cover', subagent_type: 'Explore', run_in_background: true },
      status: 'done', output: 'Async agent launched.', childId: 'demo-agent',
      task: { status: 'running', background: true, startedAt, toolUses: 0 }
    }
  }

  async run(say: (id: string, text: string) => Promise<void>): Promise<void> {
    const { turnId } = this.request
    const started = Date.now()
    await say(`${turnId}:bg-0`, "I'll capture the screens in the background and send a subagent to find every request the retry should cover.")
    this.cb.item({ ...this.shell })
    this.cb.item({ ...this.agent })
    await say(`${turnId}:bg-1`, 'Both are running. I will add to this answer when they report back.')
    this.cb.item({ kind: 'result', id: `result:${turnId}`, turnId, ok: true, costUsd: await demoCost(this.kind, turnId, 0.31), durationMs: Date.now() - started, turns: 3 })
    this.cb.item({ kind: 'notice', id: `${turnId}:notice:0`, turnId, level: 'info', text: translate(this.request.locale ?? 'en', 'chat.background.waiting', { count: 2 }) })
    for (let step = 0; !this.signal.aborted; step++) {
      await sleep(2500, this.signal)
      if (this.signal.aborted) break
      const shellRunning = this.shell.task!.status === 'running'
      if (shellRunning) {
        const line = SHELL_LINES[step]
        this.update('shell', line ? { summary: line } : { status: 'completed', summary: 'Captured 5 screens in out/screens', durationMs: Date.now() - started })
      }
      const agentRunning = this.agent.task!.status === 'running'
      if (agentRunning) {
        const next = SUBAGENT_STEPS[step]
        if (next) this.agentCall(step, next)
        else this.update('agent', { status: 'completed', summary: 'Three requests need the retry: login, session refresh and the profile save.\nThe sign-out request must not be retried.', durationMs: Date.now() - started })
      }
      if (!shellRunning && !agentRunning) break
    }
    if (this.signal.aborted) {
      for (const which of ['shell', 'agent'] as const) if (this[which].task!.status === 'running') this.update(which, { status: 'stopped' })
      return this.cb.finished({ ok: false, error: 'Stopped.' })
    }
    await say(`${turnId}:bg-2`, this.agentStopped
      ? 'The screens are in `out/screens`. The subagent was stopped before it finished, so I have not checked every request.'
      : 'The screens are in `out/screens`, and the subagent found three requests the retry should cover: login, session refresh and the profile save. Sign-out must not be retried.')
    this.cb.finished({ ok: true })
  }

  /** Stop on the subagent's row: it ends as stopped, the shell carries on. */
  stopChild(childId: string): void {
    if (childId !== this.agent.childId || this.agent.task!.status !== 'running') throw new Error('That subagent is not running')
    this.agentStopped = true
    this.update('agent', { status: 'stopped', summary: 'Stopped' })
  }

  private agentCall(step: number, [name, input]: [string, Record<string, unknown>]): void {
    const call: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: `${this.agent.id}:${step}`, turnId: this.request.turnId, parentToolUseId: this.agent.id, name, input, status: 'done', output: 'ok' }
    this.cb.item(call)
    this.update('agent', { toolUses: step + 1, lastTool: name })
  }

  private update(which: 'shell' | 'agent', patch: Partial<NonNullable<Extract<ChatItem, { kind: 'tool' }>['task']>>): void {
    const item = this[which]
    this[which] = { ...item, task: { ...item.task!, ...patch } }
    this.cb.item({ ...this[which] })
  }
}

/** What the agent does for this message: the flow's steps by what their messages say, and a plain reply for anything else. */
function script(request: TurnRequest): Beat[] {
  const { prompt, cwd } = request
  if (read(cwd, 'package.json').includes('"lumen-cli"') && prompt.trim() === RESUME_TEXT) return tomlScript()
  if (existsSync(path.join(cwd, 'main.go'))) {
    const beacon = beaconScript(prompt, cwd)
    if (beacon) return beacon
  }
  const source = read(cwd, RETRY)
  if (prompt.includes('foreman-findings')) {
    const clean = source.includes('isIdempotent')
    return [
      { tool: 'Read', input: { file_path: RETRY }, output: source, ms: 2500 },
      { tool: 'Read', input: { file_path: RETRY_TEST }, output: read(cwd, RETRY_TEST), ms: 2000 },
      clean
        ? { say: `No findings: only idempotent requests are retried, and only after a 5xx or a 429. The tests cover both.\n\n${findingsBlock([])}` }
        : { say: `Two things to fix before this ships:\n\n1. **POST and PATCH are retried.** A request the server already got is sent again.\n2. **A 4xx is retried.** It fails the same way each time.\n\n${findingsBlock(FINDINGS)}` }
    ]
  }
  if (prompt.includes('The checks below failed') && source) {
    return [
      { say: 'The test says `fetch` ran 5 times: the loop gives up one attempt late.' },
      { tool: 'Read', input: { file_path: RETRY }, output: source, ms: 2000 },
      ...edits(cwd, RETRY, FIX),
      testRun(4),
      { say: '`attempt > MAX_RETRIES` let a fourth retry through; it is `>=` now, and the four retry tests pass.' }
    ]
  }
  if (prompt.includes(FINDINGS[0].title) && source) {
    return [
      { say: 'Both findings hold. I will retry only idempotent methods, and only after a 5xx or a 429.' },
      ...edits(cwd, RETRY, ADDRESS),
      testRun(6),
      { say: 'Fixed both: a POST or PATCH goes once, and a 4xx comes straight back. Two new tests cover them.' }
    ]
  }
  if (prompt.includes(TASK)) {
    return [
      { say: "I'll add the retry next to the API client." },
      { tool: 'Grep', input: { pattern: 'fetch\\(', path: 'src' }, output: "src/login.ts:6:  return fetch('/api/login', { method: 'POST', body: JSON.stringify(credentials) })", ms: 2500 },
      { tool: 'Write', input: { file_path: RETRY, content: RETRY_V1 }, output: `The file ${RETRY} has been written.`, ms: 4000, write: { file: RETRY, text: RETRY_V1 } },
      { tool: 'Write', input: { file_path: RETRY_TEST, content: RETRY_TEST_V1 }, output: `The file ${RETRY_TEST} has been written.`, ms: 3000, write: { file: RETRY_TEST, text: RETRY_TEST_V1 } },
      { say: '`fetchWithRetry` in `src/retry.ts` retries a failed request up to 3 times, waiting 200, 400 and 800 ms, with two tests. I have not run them yet.' }
    ]
  }
  return [{ say: GENERIC_REPLY }]
}

/** Beacon's flow run: the health check, the docs (stopped at the limit the first time), and QA's clean review. */
function beaconScript(prompt: string, cwd: string): Beat[] | undefined {
  const main = read(cwd, 'main.go')
  if (prompt.includes('foreman-findings')) {
    return [
      { tool: 'Read', input: { file_path: 'README.md' }, output: read(cwd, 'README.md'), ms: 2000 },
      { tool: 'Read', input: { file_path: 'main.go' }, output: main, ms: 1800 },
      { say: `No findings: the README documents \`GET /healthz\` and its answer exactly as main.go serves it.\n\n${findingsBlock([])}` }
    ]
  }
  const docs = prompt.includes('Update the documentation for what this change does')
  if (docs || (prompt.trim() === RESUME_TEXT && limited.has(cwd))) {
    if (!limited.has(cwd)) {
      return [{ say: 'I’ll document the new health check in the README.' }, { tool: 'Read', input: { file_path: 'README.md' }, output: read(cwd, 'README.md'), ms: 2200 }, { limit: 2 }]
    }
    const readme = read(cwd, 'README.md')
    return [
      { say: 'Picking up where I stopped: the health check’s section in the README.' },
      { tool: 'Edit', input: { file_path: 'README.md', old_string: readme.trimEnd(), new_string: `${readme.trimEnd()}\n${HEALTH_DOCS}` }, output: 'The file README.md has been updated.', ms: 2500, write: { file: 'README.md', text: `${readme.trimEnd()}\n${HEALTH_DOCS}` } },
      { say: 'The README now has a **Health check** section: what `GET /healthz` answers, and where to point the load balancer.' }
    ]
  }
  if (prompt.includes(BEACON_TASK)) {
    return [
      { say: 'I’ll add the endpoint next to `main`.' },
      { tool: 'Read', input: { file_path: 'main.go' }, output: main || MAIN_GO, ms: 1800 },
      { tool: 'Write', input: { file_path: 'main.go', content: MAIN_GO_V1 }, output: 'The file main.go has been written.', ms: 3500, write: { file: 'main.go', text: MAIN_GO_V1 } },
      { say: '`GET /healthz` answers `200 ok 1.4.0`, and Beacon now listens on :8080.' }
    ]
  }
  return undefined
}

/** The Lumen chat that ran out of credits, resumed: it finishes the TOML loader it was in the middle of. */
function tomlScript(): Beat[] {
  return [
    { say: 'Picking up where I stopped: the loader reads lumen.toml now, and I’ll keep .lumenrc.json as the fallback.' },
    { tool: 'Write', input: { file_path: 'src/config.ts', content: TOML_CONFIG }, output: 'The file src/config.ts has been written.', ms: 3500, write: { file: 'src/config.ts', text: TOML_CONFIG } },
    { tool: 'Edit', input: { file_path: 'README.md', old_string: '`lumen stats`.', new_string: '`lumen stats`. Configure it in `lumen.toml`.' }, output: 'The file README.md has been updated.', ms: 1800 },
    { say: '`loadConfig` reads `lumen.toml` first and falls back to `.lumenrc.json` until 1.0, so nobody’s setup breaks. The README says where the config lives.' }
  ]
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

class DemoTurn implements AgentTurn {
  private stopper = new AbortController()
  private background: BackgroundDemo | null = null

  constructor(private kind: AgentKind, private request: TurnRequest, private cb: TurnCallbacks) {}

  /** Streamed a few words at a time, as an agent's answer arrives. */
  private async say(id: string, said: string): Promise<void> {
    const { turnId } = this.request
    const signal = this.stopper.signal
    const words = said.split(/(?<= )/)
    let text = ''
    for (let i = 0; i < words.length && !signal.aborted; i += 4) {
      text += words.slice(i, i + 4).join('')
      this.cb.item({ kind: 'assistant', id, turnId, text, streaming: true }, true)
      await sleep(120, signal)
    }
    this.cb.item({ kind: 'assistant', id, turnId, text: said })
  }

  async run(): Promise<void> {
    if (wantsBackground(this.request)) {
      this.background = new BackgroundDemo(this.kind, this.request, this.cb, this.stopper.signal)
      return this.background.run((id, text) => this.say(id, text))
    }
    const { turnId, cwd } = this.request
    const signal = this.stopper.signal
    const startedAt = Date.now()
    const beats = script(this.request)
    let n = 0
    for (const beat of beats) {
      if (signal.aborted) break
      const id = `${turnId}:demo-${n++}`
      if ('say' in beat) {
        await this.say(id, beat.say)
        continue
      }
      if ('limit' in beat) {
        // As Claude Code says it: the turn ends at the limit with its reset time, the tab pauses and its resume is armed.
        limited.add(cwd)
        const resetAt = new Date(Date.now() + beat.limit * 60_000)
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        const source = `resets ${resetAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (${timeZone})`
        return this.cb.finished({ ok: false, error: `You've hit your limit · ${source}`, limit: { resetAt: resetAt.toISOString(), source, timeZone } })
      }
      const tool: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id, turnId, name: beat.tool, input: beat.input, status: 'running' }
      this.cb.item({ ...tool })
      await sleep(beat.ms, signal)
      if (signal.aborted) break
      if (beat.write) {
        mkdirSync(path.dirname(path.join(cwd, beat.write.file)), { recursive: true })
        writeFileSync(path.join(cwd, beat.write.file), beat.write.text)
      }
      this.cb.item({ ...tool, status: 'done', output: beat.output })
    }
    if (signal.aborted) return this.cb.finished({ ok: false, error: 'Stopped.' })
    const durationMs = Date.now() - startedAt
    this.cb.item({ kind: 'result', id: `result:${turnId}`, turnId, ok: true, costUsd: await demoCost(this.kind, turnId, Math.round(beats.length * 4.7) / 100), durationMs, turns: beats.length })
    this.cb.usage({ used: Math.min(180_000, 24_000 + this.request.prompt.length * 3 + beats.length * 2_600), limit: 200_000 })
    this.cb.finished({ ok: true })
  }

  async stop(): Promise<void> {
    this.stopper.abort()
  }

  async stopChild(childId: string): Promise<void> {
    if (!this.background) throw new Error('That subagent is not running')
    this.background.stopChild(childId)
  }

  steer(): boolean {
    return false
  }

  async setPlanMode(): Promise<void> {}

  async setModel(): Promise<void> {}
}

function demoDriver(kind: AgentKind, replayed?: AgentDriver): AgentDriver {
  return {
    kind,
    // An AI employee's run is its own script of tool calls (demoEmployees.ts); the flow runs' steps are a script (they
    // write the files the checks then run); a chat of the person's goes to the real adapter over ReplayTransport, so it
    // answers as the recorded agent did (docs/agents.md, 9.5).
    createTurn: (request, callbacks) =>
      isEmployeeTurn(request) ? new EmployeeDemoTurn(kind, request, callbacks) : replayed && !isFlowBeat(request) ? replayed.createTurn(request, callbacks) : new DemoTurn(kind, request, callbacks),
    status: async () => ({ agent: kind, installed: true, ready: true, detail: replayed ? 'Demo: answers from recordings' : 'Demo: answers from a script' })
  }
}

/**
 * Every agent answers from the script: the demo reaches no model (main/index.ts keeps turns out of the background host).
 * With `replayRoot` (the app, not the tests), a chat of the person's with Claude Code or Codex is played from the recordings
 * under that folder through the real adapter instead, with "Replaying a recording" in the chat.
 *
 * TODO(#172 slice 2): the flow run's own steps are still DemoTurn's beats, not `scripted` fixtures. A beat reads and writes
 * the workspace (the Edit it plays changes the file the checks then run), which a fixture of frames can't do; they become
 * fixtures once ReplayOptions has a hook that runs a beat's file write as its frame is played.
 */
export function registerDemoAgents(options: { replayRoot?: string } = {}): void {
  if (options.replayRoot) configureReplay({ enabled: () => true, root: options.replayRoot, notice: () => mainT(undefined)('replay.notice') })
  const replayed: Partial<Record<AgentKind, AgentDriver>> = options.replayRoot ? { claude: replayAware(claudeDriver), codex: replayAware(codexDriver) } : {}
  for (const kind of Object.keys(AGENTS) as AgentKind[]) registerDriver(demoDriver(kind, replayed[kind]))
}

// ---- starting the run ----

/**
 * A repository's checks and their scripts, committed on main once (a demo seeded before this existed gets them on its next
 * launch), and approved on this computer, as if you had said yes once: a run never approves a check itself.
 */
async function prepareChecks(store: Store, repoId: string, files: Record<string, string>, commands: string[], scripts?: Record<string, string>): Promise<void> {
  const repo = store.state.repos.find((r) => r.id === repoId)
  if (!repo) throw new Error(`the ${repoId} repository was removed`)
  const root = repo.rootPath
  if (!Object.keys(files).every((file) => existsSync(path.join(root, file)))) {
    const all = { ...files }
    if (scripts) {
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      pkg.scripts = { ...pkg.scripts, ...scripts }
      all['package.json'] = `${JSON.stringify(pkg, null, 2)}\n`
    }
    for (const [file, text] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    await git(root, ['add', '--', ...Object.keys(all)])
    await git(root, [...IDENTITY, 'commit', '-q', '-m', 'Add Foreman checks', '--', ...Object.keys(all)])
  }
  const approved = new Set(store.state.checkApprovals?.[repoId] ?? [])
  for (const command of commands) approved.add(commandHash(command))
  store.state.checkApprovals = { ...store.state.checkApprovals, [repoId]: [...approved] }
  store.save()
}

const RUNS = [
  { flowId: FLOW_ID, repoId: 'repo-atlas', task: TASK },
  { flowId: BEACON_FLOW_ID, repoId: 'repo-beacon', task: BEACON_TASK }
]

/** The demo runs a previous launch started, ended now, and their workspaces: deleted, so only this launch's shows. */
async function clearEarlierRuns(core: Core, store: Store): Promise<void> {
  const earlier = core.flows.runs.filter((r) => RUNS.some((d) => r.inputs.task === d.task && r.flow.id === d.flowId) && !isActiveRun(r))
  if (!earlier.length) return
  for (const run of earlier) {
    for (const id of run.workspaces ?? (run.workspaceId ? [run.workspaceId] : [])) {
      if (!store.state.workspaces.some((w) => w.id === id)) continue
      try {
        await core.api.archiveWorkspace(id, true, { stopTabs: true, anyway: true })
        await core.api.deleteArchived([id])
      } catch (err) {
        console.error(`[demo] Could not delete an earlier demo run's workspace: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  const gone = new Set(earlier.map((r) => r.id))
  store.state.flowRuns = core.flows.runs.filter((r) => !gone.has(r.id))
  store.save()
}

/** After the flow engine started (and marked the last launch's runs uncertain): start this launch's runs. */
export async function startDemoRun(core: Core, store: Store): Promise<void> {
  if (!store.state.settings.flows) return console.log('[demo] Flows are off (Settings → Experimental), so no flow run starts.')
  await prepareChecks(store, 'repo-atlas', { '.foreman/settings.toml': CHECKS_TOML, 'scripts/test.mjs': TEST_SCRIPT, 'scripts/typecheck.mjs': TYPECHECK_SCRIPT }, ['npm test', 'npm run typecheck'], {
    test: 'node scripts/test.mjs',
    typecheck: 'node scripts/typecheck.mjs'
  })
  if (store.state.repos.some((r) => r.id === 'repo-beacon')) await prepareChecks(store, 'repo-beacon', { '.foreman/settings.toml': BEACON_CHECKS_TOML, 'scripts/vet.mjs': BEACON_VET }, ['node scripts/vet.mjs'])
  await clearEarlierRuns(core, store)
  limited.clear()
  for (const { flowId, repoId, task } of RUNS) {
    const repo = store.state.repos.find((r) => r.id === repoId)
    if (!repo) continue
    try {
      const preview = await core.api.flowRunPreview({ flowId, repoId, baseBranch: 'main' })
      const run = await core.api.startFlowRun({ flowId, repoId, baseBranch: 'main', inputs: { task }, shown: preview.fingerprint })
      console.log(`[demo] Started a run of “${run.flow.name}” on ${repo.name}`)
    } catch (err) {
      console.error(`[demo] Could not start a run on ${repo.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
