// Dev-only demo (main/demo.ts): a flow run that is going when the demo opens, so you can watch one move. Each launch
// starts the built-in "Fix until green" on atlas, through the real flow engine, checks and chats; only the agent is a
// script. Its first version has an off-by-one the tests catch, the fix makes them pass, the reviewer finds two things,
// the second review is clean, and the run waits at its ship-check gate for you. The previous launch's demo run (which
// the restart left uncertain) and its workspace are deleted first, so launches don't pile them up.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { AGENTS, type AgentKind } from '../shared/agents'
import { isActiveRun } from '../shared/flows'
import type { ChatItem } from '../shared/types'
import { registerDriver } from './agents/registry'
import type { AgentDriver, AgentTurn, TurnCallbacks, TurnRequest } from './agents/types'
import { commandHash } from './checks'
import type { Core } from './core'
import { git } from './git'
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

/** What the agent does for this message: the flow's steps by what their messages say, and a plain reply for anything else. */
function script(request: TurnRequest): Beat[] {
  const { prompt, cwd } = request
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
  return [{ say: 'This is the demo: no agent runs here, so this reply is a script and nothing in the workspace changed.' }]
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

  constructor(private request: TurnRequest, private cb: TurnCallbacks) {}

  async run(): Promise<void> {
    const { turnId, cwd } = this.request
    const signal = this.stopper.signal
    const startedAt = Date.now()
    const beats = script(this.request)
    let n = 0
    for (const beat of beats) {
      if (signal.aborted) break
      const id = `${turnId}:demo-${n++}`
      if ('say' in beat) {
        // Streamed a few words at a time, as an agent's answer arrives.
        const words = beat.say.split(/(?<= )/)
        let text = ''
        for (let i = 0; i < words.length && !signal.aborted; i += 4) {
          text += words.slice(i, i + 4).join('')
          this.cb.item({ kind: 'assistant', id, turnId, text, streaming: true }, true)
          await sleep(120, signal)
        }
        this.cb.item({ kind: 'assistant', id, turnId, text: beat.say })
        continue
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
    this.cb.item({ kind: 'result', id: `result:${turnId}`, turnId, ok: true, costUsd: Math.round(beats.length * 4.7) / 100, durationMs, turns: beats.length })
    this.cb.usage({ used: Math.min(180_000, 24_000 + this.request.prompt.length * 3 + beats.length * 2_600), limit: 200_000 })
    this.cb.finished({ ok: true })
  }

  async stop(): Promise<void> {
    this.stopper.abort()
  }

  steer(): boolean {
    return false
  }

  async setPlanMode(): Promise<void> {}

  async setModel(): Promise<void> {}
}

function demoDriver(kind: AgentKind): AgentDriver {
  return {
    kind,
    createTurn: (request, callbacks) => new DemoTurn(request, callbacks),
    status: async () => ({ agent: kind, installed: true, ready: true, detail: 'Demo: answers from a script' })
  }
}

/** Every agent answers from the script: the demo reaches no model (main/index.ts keeps turns out of the background host). */
export function registerDemoAgents(): void {
  for (const kind of Object.keys(AGENTS) as AgentKind[]) registerDriver(demoDriver(kind))
}

// ---- starting the run ----

/** Atlas's checks and their scripts, committed on main once (a demo seeded before this existed gets them on its next launch). */
async function prepareAtlas(store: Store, repoId: string): Promise<void> {
  const repo = store.state.repos.find((r) => r.id === repoId)
  if (!repo) throw new Error('the atlas repository was removed')
  const root = repo.rootPath
  if (!existsSync(path.join(root, 'scripts', 'test.mjs'))) {
    const files: Record<string, string> = { '.foreman/settings.toml': CHECKS_TOML, 'scripts/test.mjs': TEST_SCRIPT, 'scripts/typecheck.mjs': TYPECHECK_SCRIPT }
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    pkg.scripts = { ...pkg.scripts, test: 'node scripts/test.mjs', typecheck: 'node scripts/typecheck.mjs' }
    files['package.json'] = `${JSON.stringify(pkg, null, 2)}\n`
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    await git(root, ['add', '--', ...Object.keys(files)])
    await git(root, [...IDENTITY, 'commit', '-q', '-m', 'Add the tests and type check as Foreman checks', '--', ...Object.keys(files)])
  }
  // Approved on this computer, as if you had said yes once: a run never approves a check itself.
  const approved = new Set(store.state.checkApprovals?.[repoId] ?? [])
  for (const command of ['npm test', 'npm run typecheck']) approved.add(commandHash(command))
  store.state.checkApprovals = { ...store.state.checkApprovals, [repoId]: [...approved] }
  store.save()
}

/** The demo runs a previous launch started, ended now, and their workspaces: deleted, so only this launch's shows. */
async function clearEarlierRuns(core: Core, store: Store): Promise<void> {
  const earlier = core.flows.runs.filter((r) => r.inputs.task === TASK && r.flow.id === FLOW_ID && !isActiveRun(r))
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

/** After the flow engine started (and marked the last launch's run uncertain): start this launch's run. */
export async function startDemoRun(core: Core, store: Store, repoId = 'repo-atlas'): Promise<void> {
  if (!store.state.settings.flows) return console.log('[demo] Flows are off (Settings → Experimental), so no flow run starts.')
  await prepareAtlas(store, repoId)
  await clearEarlierRuns(core, store)
  const preview = await core.api.flowRunPreview({ flowId: FLOW_ID, repoId, baseBranch: 'main' })
  const run = await core.api.startFlowRun({ flowId: FLOW_ID, repoId, baseBranch: 'main', inputs: { task: TASK }, shown: preview.fingerprint })
  console.log(`[demo] Started a run of “${run.flow.name}” on atlas`)
}
