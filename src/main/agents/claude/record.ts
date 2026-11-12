// Recording Claude Code (docs/agents.md, 9.2): the real driver on the cheapest model, in a temporary repository, with the
// CLI's stdio teed below the Agent SDK. Isolation: the CLI's config folder is a new one that holds only the sign-in, so none
// of the person's hooks, plugins, MCP servers, settings or memory reach the traffic. Run it with
// `npm run record:agent -- claude <scenario>`; the scenarios and what the scripted person does are `plans`.
import { spawn, execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Settings } from '../../../shared/types'
import { bundledClaudeExecutable } from '../../platform'
import { agentEnv } from '../env'
import { setTransportOverride } from '../transport'
import type { Fixture, Frame } from '../fixtures/format'
import type { AgentRecorder, Plan } from '../fixtures/recorder'
import { teeClaudeStarter } from '../fixtures/tee'
import { claudeDriver } from '.'

const MODEL = 'claude-haiku-5-5'

const PLAN: Plan = { prompt: '', approvals: 'ask', note: '' }

export const CLAUDE_PLANS: AgentRecorder['plans'] = {
  plain: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'One short answer, no tools. The person only reads it.' },
  approval: {
    ...PLAN,
    prompt: 'Create a file named hello.txt in the current folder containing the word hi. Use the Write tool, then say done.',
    note: 'The agent asks to write a file (Write); the person allows it once.'
  },
  question: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Use the AskUserQuestion tool to ask me whether I prefer Tabs or Spaces (those two options), then reply with only my answer.',
    answer: true,
    note: 'The agent asks a multiple-choice question through Foreman\'s own tool; the person picks the first option.'
  },
  plan: {
    ...PLAN,
    planMode: true,
    approvals: 'never-ask',
    prompt: 'Plan how to add a short Usage section to README.md. Keep the plan to three bullet points, then present it.',
    note: 'Plan mode: the agent presents a plan (ExitPlanMode); the person approves it and the agent carries it out.'
  },
  steer: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Count from 1 to 40, one number per line, with no other text.',
    steer: 'Actually, stop at 10.',
    note: 'The person sends a follow-up while the agent is answering (a steer, priority "now").'
  },
  // docs/agents.md 8: a flow persona's `writes` on Claude: Foreman's PreToolUse hook allows a file tool inside the globs and refuses it elsewhere.
  scoped: {
    ...PLAN,
    writes: ['allowed/**'],
    prompt: 'Use the Write tool to create the file allowed/yes.txt containing the word yes. Then use the Write tool to create the file other/no.txt containing the word no. Then say done and tell me which of the two you could create.',
    note: 'A persona-like turn held to writes ["allowed/**"]: the agent writes one file inside the globs, which the hook allows, and one outside, which it refuses with words the agent reads.'
  },
  interrupt: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    interrupt: true,
    note: 'The person stops the turn once the agent has started answering (a control-protocol interrupt).'
  },
  crash: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    crash: true,
    note: 'The CLI process is killed (SIGKILL) while the agent is answering: the transport ends with no result.'
  },
  resume: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok' },
    note: 'A second turn that resumes the first one\'s session (the recording is the second turn).'
  },
  // docs/agents.md 3: a fork and Restore both continue the session through an earlier message (resumeSessionAt + forkSession), and /compact.
  fork: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok', then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1 },
    note: 'A turn that forks the session as it stood after the first of two turns (resumeSessionAt, forkSession): it answers with the word of the first turn, never the second.'
  },
  revert: {
    ...PLAN,
    prompt: 'What word did I ask you to remember? Answer with that one word.',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok', then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1, rewind: true },
    note: 'Restore: the same request as a fork (Claude rolls back by forking at the message), recorded as Restore sends it, with rewind set.'
  },
  compact: {
    ...PLAN,
    prompt: '/compact',
    resumes: { prompt: 'Remember the word "pineapple". Reply with the single word: ok' },
    note: '/compact as the composer sends it on a resumed session: a compact_boundary, which is also what idle compaction runs.'
  },
  // docs/agents.md 6: the Task tool starts a subagent whose own calls and messages come back tagged with parent_tool_use_id.
  subagents: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Use the Task tool exactly once to start a subagent whose only job is to read README.md and report its first line. Then reply with only that line.',
    note: "The agent starts one subagent (Task) that reads a file; the subagent's own calls and messages arrive tagged with parent_tool_use_id and the Task call carries its task id."
  }
}

const run = promisify(execFile)

export const claudeRecorder: AgentRecorder = {
  agent: 'claude',
  driver: claudeDriver,
  plans: CLAUDE_PLANS,
  async prepare(root, scenario) {
    const own = path.join(os.homedir(), '.claude', '.credentials.json')
    const config = path.join(root, 'claude-config')
    mkdirSync(config, { recursive: true })
    const copy = path.join(config, '.credentials.json')
    let before = ''
    if (existsSync(own)) {
      copyFileSync(own, copy)
      before = readFileSync(copy, 'utf8')
    }
    // Account data at the source: ENABLE_CLAUDEAI_MCP_SERVERS=false keeps the account's claude.ai connectors out of `mcp_servers`,
    // and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 stops the CLI fetching the organisation's skills (`anthropic-skills:*`, listed
    // in init, `commands_changed` and the initialize response). Tried and found not to: CLAUDE_CODE_SYNC_SKILLS=0 and
    // CLAUDE_CODE_DISABLE_POLICY_SKILLS=1. The account's email, plan and organisation still come back in `account`;
    // the sanitiser (sanitize.ts) is the guard for those, and for a CLI that lists something new.
    const env = agentEnv('claude',{ claudeAuth: 'login', codexAuth: 'login', providerKeyAgents: {} } as unknown as Settings, {}, {}, { CLAUDE_CONFIG_DIR: config, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_SYNC_SKILLS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(scenario === 'subagents' ? { CLAUDE_CODE_SUBAGENT_MODEL: MODEL } : {}) })
    const binary = bundledClaudeExecutable()
    return {
      env,
      model: MODEL,
      version: async () => {
        const out = (await run(binary ?? 'claude', ['--version'], { env })).stdout.trim()
        return out.split(/\s+/)[0]
      },
      install: (rec) => setTransportOverride('claude', () => teeClaudeStarter(spawn, rec())),
      // The CLI may have refreshed the sign-in in the copy; the refresh token is single-use, so put the new one back.
      finish: async () => {
        if (existsSync(copy) && before && readFileSync(copy, 'utf8') !== before) copyFileSync(copy, own)
        rmSync(copy, { force: true })
      }
    }
  }
}

/**
 * `limit` is not recorded (a usage limit can't be had on demand): it is the `plain` recording with the frames Claude
 * Code sends when the account is out of usage substituted (docs/agents.md, 9.2): a `rate_limit_event` whose status is
 * `rejected`, and a `result` that is an error saying so, with the same assistant text swapped for the limit message.
 */
export function claudeLimitFrom(plain: Fixture): Fixture {
  const frames: Frame[] = []
  const edits = new Set<string>()
  const reset = '<epoch+7200>'
  const message = "You've hit your limit · resets in 2 hours"
  let limited = false
  for (const f of plain.frames) {
    const d = f.data as Record<string, any> | undefined
    if (f.dir === 'recv' && d?.type === 'rate_limit_event') {
      const info = d.rate_limit_info ?? {}
      const windows = info.unifiedWindows ? { ...info.unifiedWindows, five_hour: { utilization: 1, resetsAt: reset } } : undefined
      edits.add('rate_limit_event: status "rejected", rateLimitType "five_hour", its window at 100% and resetsAt two hours after the replay starts')
      frames.push({ ...f, data: { ...d, rate_limit_info: { ...info, status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset, ...(windows ? { unifiedWindows: windows } : {}) } } })
      limited = true
      continue
    }
    if (f.dir === 'recv' && d?.type === 'result') {
      if (!limited) throw new Error('the plain recording holds no rate_limit_event to turn into the limit')
      edits.add('result: is_error true, api_error_status 429 and the limit message as its text')
      frames.push({ ...f, data: { ...d, is_error: true, api_error_status: 429, result: message } })
      continue
    }
    // The answer the agent gave becomes the message too: a blocked request has no answer.
    if (f.dir === 'recv' && d?.type === 'assistant') {
      edits.add('assistant: the limit message instead of the answer, as a synthetic error message')
      frames.push({ ...f, data: { ...d, error: 'rate_limit', message: { ...d.message, content: [{ type: 'text', text: message }] } } })
      continue
    }
    frames.push(f)
  }
  return {
    header: { ...plain.header, scenario: 'limit', evidence: 'edited', edits: [...edits], note: 'The plain recording with the frames a usage limit produces substituted; its reset time is relative to the replay (<epoch+N>).' },
    frames
  }
}
