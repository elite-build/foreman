// Recording Codex (docs/agents.md, 9.2): the real driver on the cheapest model Codex lists, in a temporary repository, with
// the app-server's stdio teed under the adapter's own JSON-RPC client. Isolation: CODEX_HOME is a new folder that holds only
// the sign-in (auth.json), so none of the person's config, plugins, MCP servers, notify hooks or history reach the traffic.
// Run it with `npm run record:agent -- codex <scenario>`.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Settings } from '../../../shared/types'
import { agentEnv } from '../env'
import { setTransportOverride } from '../transport'
import type { Fixture, Frame } from '../fixtures/format'
import type { AgentRecorder, Plan } from '../fixtures/recorder'
import { teeCodexOpener } from '../fixtures/tee'
import { codexBinary, codexDriver } from '.'

// The cheapest of the models `model/list` offers (the small "luna" tier), at its lowest effort.
const MODEL = 'gpt-5.6-luna'

const PLAN: Plan = { prompt: '', approvals: 'ask', note: '' }

export const CODEX_PLANS: AgentRecorder['plans'] = {
  plain: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'One short answer, no tools. The person only reads it.' },
  approval: {
    ...PLAN,
    prompt: 'Create a file named hello.txt in the current folder containing the word hi, then say done.',
    note: 'The agent asks before writing a file or running a command; the person allows it once.'
  },
  question: {
    ...PLAN,
    planMode: true,
    approvals: 'never-ask',
    prompt: 'Before planning, ask me one clarifying question with the request_user_input tool: do I prefer Tabs or Spaces? Then give a one-line plan.',
    answer: true,
    note: 'Plan mode, where Codex may ask a question (item/tool/requestUserInput); the person picks the first option.'
  },
  plan: {
    ...PLAN,
    planMode: true,
    approvals: 'never-ask',
    prompt: 'Plan how to add a short Usage section to README.md. Keep the plan to three bullet points.',
    note: 'Plan mode: the agent writes a plan; the person approves it.'
  },
  steer: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Count from 1 to 40, one number per line, with no other text.',
    steer: 'Actually, stop at 10.',
    note: 'The person sends a follow-up while the agent is answering (turn/steer).'
  },
  interrupt: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    interrupt: true,
    note: 'The person stops the turn once the agent has started answering (turn/interrupt).'
  },
  crash: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    crash: true,
    note: 'The app-server process is killed while the agent is answering: the transport ends with no turn/completed.'
  },
  resume: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok' },
    note: 'A second turn that resumes the first one\'s thread (thread/resume); the recording is the second turn.'
  },
  // docs/agents.md 8: on Windows the app-server's start-up includes `windowsSandbox/readiness`, which decides whether read-only and scoped writes are offered.
  sandbox: {
    ...PLAN,
    prompt: 'Reply with the single word: ok',
    note: 'One short answer, recorded to hold the start-up exchange a Windows app-server has: windowsSandbox/readiness. The recorder’s CODEX_HOME is a new folder, where the sandbox was never set up, so it answers "notConfigured" (readiness is per Codex home, so per account). Recorded on Windows only.'
  },
  // docs/agents.md 8: a flow persona's `writes` on Codex: the read-only sandbox with `on-request` approvals, Foreman accepting a write inside the globs
  // and declining every other write, command and MCP call that asks.
  scoped: {
    ...PLAN,
    writes: ['allowed/**'],
    prompt: 'Create the file allowed/yes.txt containing the word yes, and also create the file other/no.txt containing the word no. Then say done and tell me which of the two you could create.',
    note: 'A persona-like turn held to writes ["allowed/**"]: the read-only sandbox, on-request approvals. The agent is asked to create one file inside the globs and one outside; the first is accepted, the second declined.'
  },
  // docs/agents.md 3: the Codex abilities slice 4a adds. Each is a turn after one or two setup turns on the same thread.
  fork: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok', then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1 },
    note: 'A turn that forks the thread as it stood after the first of two turns (thread/fork with lastTurnId): it answers with the first turn\'s word, never the second\'s.'
  },
  revert: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok', then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1, rewind: true },
    note: 'Restore: the thread is resumed and cut back to its first of two turns (thread/turns/list, then thread/revert), and the turn after it answers with the first turn\'s word.'
  },
  compact: {
    ...PLAN,
    prompt: '/compact',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok' },
    note: '/compact on a thread with one turn: thread/compact/start, a contextCompaction item, no model answer.'
  },
  goal: {
    ...PLAN,
    approvals: 'never-ask',
    maxMs: 90_000,
    prompt: '/goal Reply with the single word: done. Then mark the goal complete.',
    note: 'The person sets a goal (thread/goal/set); Codex works toward it by itself, a turn after another, until it marks the goal complete.'
  },
  goalclear: {
    ...PLAN,
    approvals: 'never-ask',
    maxMs: 90_000,
    prompt: '/goal clear',
    resumes: { prompt: '/goal Reply with the single word: done. Then mark the goal complete.' },
    note: 'A thread that had a goal, then the person clears it (thread/goal/clear, thread/goal/cleared).'
  }
}

const run = promisify(execFile)

export const codexRecorder: AgentRecorder = {
  agent: 'codex',
  driver: codexDriver,
  plans: CODEX_PLANS,
  async prepare(root, scenario) {
    const own = path.join(os.homedir(), '.codex', 'auth.json')
    const home = path.join(root, 'codex-home')
    mkdirSync(home, { recursive: true })
    const copy = path.join(home, 'auth.json')
    let before = ''
    if (existsSync(own)) {
      copyFileSync(own, copy)
      before = readFileSync(copy, 'utf8')
    }
    // Nothing else of the person's configuration: only what the run needs. A scenario that needs a working Windows sandbox (scoped writes run
    // in the read-only one) says so for this home: the unelevated sandbox is ready without setup and without a system change. The other
    // scenarios keep the empty config, where a Windows app-server says "notConfigured" (`sandbox`).
    writeFileSync(path.join(home, 'config.toml'), scenario === 'scoped' ? '[windows]\nsandbox = "unelevated"\n' : '')
    const env = agentEnv('codex', { claudeAuth: 'login', codexAuth: 'login', providerKeyAgents: {} } as unknown as Settings, {}, {}, { CODEX_HOME: home })
    return {
      env,
      model: MODEL,
      effort: 'low',
      version: async () => {
        const binary = codexBinary(undefined, env)
        const out = (await run(binary?.file ?? 'codex', ['--version'], { env })).stdout.trim()
        return out.split(/\s+/).pop() ?? out
      },
      install: (rec) => setTransportOverride('codex', () => teeCodexOpener(rec())),
      finish: async () => {
        if (existsSync(copy) && before && readFileSync(copy, 'utf8') !== before) copyFileSync(copy, own)
        // The copy of the sign-in goes now, whether or not the folder can be removed (Windows may hold it).
        rmSync(copy, { force: true })
      }
    }
  }
}

/**
 * `limit` is the `plain` recording with the frames Codex sends when the account is out of usage substituted
 * (docs/agents.md, 9.2): an `account/rateLimits/updated` notification whose primary window is at 100% with a reset
 * time, and a failed turn: `error` with a usage-limit message and `turn/completed` with status `failed`.
 * The shapes are those of the generated protocol (`codex app-server generate-ts`): RateLimitSnapshot, TurnError.
 */
export function codexLimitFrom(plain: Fixture): Fixture {
  const frames: Frame[] = []
  const edits = new Set<string>()
  const message = "You've hit your usage limit. Try again in 2 hours."
  const error = { message, codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null }
  for (const f of plain.frames) {
    const d = f.data as Record<string, any> | undefined
    // The answer never came: the agent message and its delta are not in a blocked turn.
    if (f.dir === 'recv' && typeof d?.method === 'string' && (d.method === 'item/agentMessage/delta' || ((d.method === 'item/started' || d.method === 'item/completed') && d.params?.item?.type === 'agentMessage'))) {
      edits.add('item/agentMessage/*: removed (a blocked turn has no answer)')
      continue
    }
    if (f.dir === 'recv' && d?.method === 'turn/completed') {
      frames.push({
        t: f.t,
        dir: 'recv',
        data: {
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              limitId: 'codex', limitName: null, normalModelSlug: null,
              primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: '<epoch+7200>' },
              secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: 'rate_limit_reached'
            }
          }
        }
      })
      edits.add('account/rateLimits/updated added: primary window at 100% (300 minutes) with resetsAt two hours after the replay starts')
      frames.push({ t: f.t, dir: 'recv', data: { method: 'error', params: { error, willRetry: false, threadId: d.params?.threadId, turnId: d.params?.turn?.id } } })
      edits.add('error added: codexErrorInfo "usageLimitExceeded"')
      edits.add('turn/completed: status "failed" with that error, no items')
      frames.push({ ...f, data: { ...d, params: { ...d.params, turn: { ...d.params?.turn, items: [], status: 'failed', error } } } })
      continue
    }
    frames.push(f)
  }
  return {
    header: { ...plain.header, scenario: 'limit', evidence: 'edited', edits: [...edits], note: 'The plain recording with the frames a usage limit produces substituted; its reset time is relative to the replay (<epoch+N>). Shapes are those of codex app-server generate-ts (RateLimitSnapshot, ErrorNotification, TurnError).' },
    frames
  }
}
