// The recorder (docs/agents.md, 9.2): runs the REAL driver in a temporary Git repository with a tee on the transport
// seam and a scripted user, then sanitises the traffic into a fixture. It costs real usage, so it never runs in tests:
// `npm run record:agent -- <agent> <scenario>` (scripts/record-agent.mjs) starts it.
//
// Isolation comes first, sanitising second: the agent runs with a fresh data folder, no integrations, no repository MCP
// servers, no provider keys from the shell, no hooks and none of the person's own agent settings (each agent's recorder
// spec points its config folder at a new one that holds only the sign-in), so secrets mostly never enter the traffic.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatItem, Question } from '../../../shared/types'
import type { AgentDriver, ApprovalPolicy, TurnCallbacks, TurnRequest, TurnResult } from '../types'
import type { EffortLevel } from '../../../shared/agents'
import { setTransportOverride } from '../transport'
import { fixturePath, writeFixture, type Evidence, type Fixture, type FixtureHeader } from './format'
import { sanitizeFrames, findLeaks, type SanitizeContext } from './sanitize'
import { FrameRecorder } from './tee'

export const SCENARIOS = ['plain', 'approval', 'question', 'plan', 'steer', 'interrupt', 'limit', 'crash', 'resume', 'fork', 'revert', 'compact', 'goal', 'goalclear', 'subagents', 'terminal', 'version1', 'version2', 'sandbox', 'scoped'] as const
export type Scenario = (typeof SCENARIOS)[number]

/** What a scenario has the scripted person do, and ask of the agent. `limit` is not recorded: it is an edit of `plain`. */
export interface Plan {
  prompt: string
  approvals: ApprovalPolicy
  planMode?: boolean
  /** Said into the running turn once the agent has started answering. */
  steer?: string
  /** Stop the turn once the agent has started answering. */
  interrupt?: boolean
  /** Kill the agent's process once it has started answering. */
  crash?: boolean
  /** Stop the turn after this long, whatever the agent is doing (a goal is the one thing that goes on by itself). */
  maxMs?: number
  /** Answer the agent's questions with the first option (otherwise they are skipped). */
  answer?: boolean
  /** Say no to every tool approval. */
  deny?: boolean
  /** A flow persona's `writes` globs: the turn is held to them (`TurnRequest.writeScope`). */
  writes?: string[]
  /**
   * Run this first, in the same repository, and record the turn that resumes it. `then` are further turns before it, each
   * resuming the one before. `at` (1 is the first turn, the default the last): the recorded turn continues the conversation as
   * it stood after that turn: a fork, or with `rewind` the same thread cut back to there.
   */
  resumes?: { prompt: string; then?: string[]; at?: number; rewind?: boolean }
  /** For the header: what the person did, and what the agent did not. */
  note: string
}

/** What recording one agent needs. Each agent's folder has one (claude/record.ts, codex/record.ts). */
export interface AgentRecorder {
  agent: string
  driver: AgentDriver
  /** `recorded` (the default) for a real agent, `simulated` for a protocol fake (fakes.ts). */
  evidence?: Evidence
  /** The prompts and policy per scenario (the same words suit most agents; an agent overrides what it needs). */
  plans: Partial<Record<Scenario, Plan>>
  /** Sets up an isolated run in `root`; its `env` is the turn's whole environment. */
  prepare(root: string, scenario: Scenario): Promise<{
    env: Record<string, string>
    model: string
    effort?: EffortLevel
    /** The agent's own version, as the header states it. */
    version: () => Promise<string>
    /** Puts the tee in the seam for the turn(s) about to run. */
    install(rec: () => FrameRecorder): () => void
    /** Puts back anything the run changed outside `root` (a refreshed sign-in). */
    finish(): Promise<void>
  }>
}

export interface RecordResult {
  // Where the fixture was written; undefined when it was not, because it held something that must not be committed.
  file?: string
  frames: number
  result: TurnResult | undefined
  items: number
  costUsd?: number
  version: string
  leaks: string[]
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Recorder', '-c', 'user.email=recorder@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
}

/** A repository with one commit, as a workspace is. */
function makeRepo(repo: string): void {
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  writeFileSync(path.join(repo, 'README.md'), '# Demo\n\nA tiny project.\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Start')
}

const aliasesOf = (p: string) => {
  const real = realpathSync.native(p)
  return real === p ? [] : [real]
}

/** Waits (briefly) for the recorded process to have exited and its exit to be in the frames. */
async function processEnded(rec: FrameRecorder): Promise<void> {
  if (!rec.child) return
  for (let i = 0; i < 100 && !rec.frames.some((f) => f.dir === 'exit'); i++) await new Promise((resolve) => setTimeout(resolve, 100))
}

/** The agent has begun answering: text or a tool call is in the chat. */
const started = (item: ChatItem) => item.kind === 'assistant' || item.kind === 'tool' || item.kind === 'thinking'

export async function recordScenario(spec: AgentRecorder, scenario: Scenario, log: (text: string) => void = console.log): Promise<RecordResult> {
  const plan = spec.plans[scenario]
  if (!plan) throw new Error(`${spec.agent} has no "${scenario}" scenario to record (${scenario === 'limit' ? 'it is made from plain, with `edit`' : 'not offered'})`)

  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'foreman-record-')))
  const repo = path.join(root, 'repo')
  makeRepo(repo)
  const run = await spec.prepare(root, scenario)
  const recorders: FrameRecorder[] = []
  const uninstall = run.install(() => {
    const rec = new FrameRecorder()
    recorders.push(rec)
    return rec
  })

  let sessionId: string | undefined
  let result: TurnResult | undefined
  const items: ChatItem[] = []
  const costOf = (frames: FrameRecorder['frames']) => {
    for (const f of [...frames].reverse()) {
      const d = f.data as { type?: string; total_cost_usd?: number }
      if (f.dir === 'recv' && d?.type === 'result' && typeof d.total_cost_usd === 'number') return d.total_cost_usd
    }
    return undefined
  }

  // Where each turn left the conversation (the agent's assistantMessage callback): a fork or a rewind cuts there.
  let marker: string | undefined
  const turn = async (prompt: string, p: Plan, resume?: string, cut?: { at?: string; rewind?: boolean }): Promise<void> => {
    let fired = false
    let handle: ReturnType<AgentDriver['createTurn']> | undefined
    const act = (item: ChatItem) => {
      if (fired || !started(item)) return
      if (!p.steer && !p.interrupt && !p.crash) return
      fired = true
      // After the first frames are in, so the action lands mid-turn.
      setTimeout(() => {
        const rec = recorders[recorders.length - 1]
        if (p.steer) {
          log(`steering: "${p.steer}"`)
          handle?.steer(p.steer)
        } else if (p.interrupt) {
          log('interrupting')
          void handle?.stop()
        } else if (p.crash && rec?.child?.pid) {
          log('killing the agent process')
          process.kill(rec.child.pid, 'SIGKILL')
        }
      }, 400)
    }
    const cb: TurnCallbacks = {
      item: (item, transient) => {
        if (!transient) items.push(item)
        act(item)
      },
      sessionStarted: (id) => void (sessionId = id),
      assistantMessage: (uuid) => void (marker = uuid),
      approveTool: async (req) => {
        log(`approval asked: ${req.toolName}`)
        return { kind: 'tool', allow: !p.deny }
      },
      reviewPlan: async () => {
        log('plan reviewed: approved')
        return { kind: 'plan', approve: true }
      },
      ask: async (questions: Question[]) => {
        log(`question asked: ${questions.map((q) => q.question).join(' | ')}`)
        if (!p.answer) return { kind: 'question', skipped: true }
        return { kind: 'question', answers: Object.fromEntries(questions.map((q) => [q.question, q.options[0]?.label ?? ''])) }
      },
      planModeChanged: () => {},
      autoAcceptEdits: () => {},
      usage: () => {},
      finished: (r) => void (result = r)
    }
    const req: TurnRequest = {
      turnId: `record-${scenario}`,
      prompt,
      cwd: repo,
      env: run.env,
      model: run.model,
      effort: run.effort,
      fastMode: false,
      planMode: Boolean(p.planMode),
      approvals: p.approvals,
      ...(p.writes ? { writeScope: p.writes } : {}),
      systemPromptAppend: '',
      ...(resume ? { resume } : {}),
      ...(resume && cut?.at ? { resumeAt: cut.at, ...(cut.rewind ? { rewind: true } : {}) } : {})
    }
    handle = spec.driver.createTurn(req, cb)
    const cap = p.maxMs ? setTimeout(() => void handle?.stop(), p.maxMs) : undefined
    try {
      await handle.run()
    } finally {
      clearTimeout(cap)
    }
  }

  let outcome: Fixture | undefined
  try {
    log(`recording ${spec.agent} / ${scenario} in ${root}`)
    if (plan.resumes) {
      const setup = [plan.resumes.prompt, ...(plan.resumes.then ?? [])]
      const marks: (string | undefined)[] = []
      for (const [n, prompt] of setup.entries()) {
        await turn(prompt, { ...plan, resumes: undefined, interrupt: false, crash: false, steer: undefined }, n ? sessionId : undefined)
        if (!sessionId) throw new Error('the first turn gave no session to resume')
        marks.push(marker)
        log(`setup turn ${n + 1} done (${recorders.length} process), resuming ${sessionId}`)
        recorders.length = 0
        result = undefined
        items.length = 0
      }
      const at = plan.resumes.at ? marks[plan.resumes.at - 1] : undefined
      if (plan.resumes.at && !at) throw new Error(`turn ${plan.resumes.at} reported no point to cut at`)
      await turn(plan.prompt, plan, sessionId, { at, rewind: plan.resumes.rewind })
    } else {
      await turn(plan.prompt, plan)
    }
    const rec = recorders[recorders.length - 1]
    if (!rec) throw new Error('the agent was never started through the seam')
    // The process may still be on its way out; its exit is the last frame.
    await processEnded(rec)
    const version = await run.version()
    const ctx: SanitizeContext = {
      repo,
      tmp: root,
      home: os.homedir(),
      aliases: [...aliasesOf(repo).map((p) => ({ path: p, as: 'repo' as const })), { path: os.tmpdir(), as: 'tmp' as const }],
      username: os.userInfo().username
    }
    const header: FixtureHeader = {
      fixture: 1,
      agent: spec.agent,
      scenario,
      version,
      recordedAt: new Date().toISOString().slice(0, 10),
      evidence: spec.evidence ?? 'recorded',
      ...(run.model ? { model: run.model } : {}),
      note: plan.note
    }
    outcome = { header, frames: sanitizeFrames(rec.frames, ctx) }
    const leaks = findLeaks(outcome, { home: os.homedir(), username: os.userInfo().username })
    // Written only when it is clean: a recording that holds a leak is never left on disk for a `git add` to find.
    const file = leaks.length ? undefined : writeFixture(outcome, fixturePath(spec.agent, scenario, process.cwd()))
    return { file, frames: outcome.frames.length, result, items: items.length, costUsd: costOf(rec.frames), version, leaks }
  } finally {
    uninstall()
    await run.finish().catch((err) => log(`finish failed: ${String(err)}`))
    // A process the agent started may still hold the folder for a moment; leaving it behind is not a failed recording.
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
    } catch (err) {
      log(`could not remove ${root}: ${String(err)}`)
    }
  }
}

/** Restores the transport seam after a script (used by tests that record against fakes). */
export const clearTransports = () => (['claude', 'codex', 'acp', 'cursor'] as const).forEach((a) => setTransportOverride(a, undefined))
