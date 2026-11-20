// Recording OpenCode (docs/agents.md, 9.2): the real driver on one of OpenCode's own free models, in a temporary repository,
// with its server's HTTP traffic and events teed (fixtures/tee.ts). Isolation: OpenCode's data, config, state and cache
// folders are new ones under the recording's folder, and no provider key reaches it, so none of the person's sessions,
// settings, plugins, MCP servers or accounts are in the traffic. The free model needs no sign-in.
// Run it with `npm run record:agent -- opencode <scenario>`; OPENCODE_BIN names the binary when it isn't on PATH.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Settings } from '../../../shared/types'
import { PROVIDER_KEYS } from '../../../shared/providers'
import { agentEnv } from '../env'
import { setTransportOverride } from '../transport'
import type { AgentRecorder, Plan } from '../fixtures/recorder'
import { teeOpencodeLauncher } from '../fixtures/tee'
import { opencodeBinary, spawnOpencodeServer } from './server'
import { opencodeDriver } from '.'

// A model OpenCode offers for nothing, through its own provider, with no account.
const MODEL = 'opencode/big-pickle'

const PLAN: Plan = { prompt: '', approvals: 'ask', note: '' }
const REMEMBER = 'Remember the word "pineapple". Reply with the single word: ok'
const RECALL = 'What word did I ask you to remember? Answer with that one word.'

export const OPENCODE_PLANS: AgentRecorder['plans'] = {
  plain: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'One short answer, no tools. The person only reads it.' },
  approval: {
    ...PLAN,
    prompt: 'Create a file named hello.txt in the current folder containing the word hi, then run `git status --short` and tell me its output.',
    note: 'Ask mode: OpenCode asks before writing a file (edit) and before running a command (bash); the person allows each once.'
  },
  question: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Before doing anything, use your question tool to ask me one question: do I prefer Tabs or Spaces? Then reply with my answer in one word.',
    answer: true,
    note: 'OpenCode asks a question with its question tool (question.asked); the person picks the first option.'
  },
  plan: {
    ...PLAN,
    planMode: true,
    approvals: 'never-ask',
    prompt: 'Plan how to add a short Usage section to README.md. Keep the plan to three bullet points and do not change any file.',
    note: 'Plan mode (OpenCode\'s plan agent): it writes a plan; the person approves it, and the build agent is told to implement it.'
  },
  steer: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Run the shell command `sleep 5`, then count from 1 to 20, one number per line, with no other text.',
    steer: 'Actually, stop at 5.',
    note: 'The person sends a follow-up while the agent works (a second prompt_async into the busy session), which it reads within the same run.'
  },
  interrupt: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Run the shell command `sleep 30`, then say done.',
    interrupt: true,
    note: 'The person stops the turn once the agent has started (session abort): the command is cut and the session goes idle.'
  },
  crash: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Run the shell command `sleep 30`, then say done.',
    crash: true,
    note: 'The server process is killed while the agent works: its requests fail and its event stream ends with no idle.'
  },
  resume: {
    ...PLAN,
    prompt: RECALL,
    resumes: { prompt: REMEMBER },
    note: 'A second turn that continues the first one\'s session on a new server; the recording is the second turn.'
  },
  fork: {
    ...PLAN,
    prompt: RECALL,
    resumes: { prompt: REMEMBER, then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1 },
    note: 'A turn that forks the session as it stood after the first of two turns (session fork before the second turn\'s first message): it answers with the first turn\'s word.'
  },
  revert: {
    ...PLAN,
    prompt: RECALL,
    resumes: { prompt: REMEMBER, then: ['Forget that: remember the word "mango" instead. Reply with the single word: ok'], at: 1, rewind: true },
    note: 'Restore: the same session with the second turn\'s messages deleted, and the turn after it answers with the first turn\'s word.'
  },
  compact: {
    ...PLAN,
    prompt: '/compact',
    resumes: { prompt: REMEMBER },
    note: '/compact on a session with one turn: OpenCode summarizes it (session summarize, session.compacted), no answer.'
  },
  subagents: {
    ...PLAN,
    approvals: 'never-ask',
    prompt: 'Use your task tool to start one explore subagent that lists the files in this folder. Then tell me in one line what it found.',
    note: 'OpenCode starts a subagent with its task tool: a child session whose events come on the same stream.'
  }
}

const run = promisify(execFile)

export const opencodeRecorder: AgentRecorder = {
  agent: 'opencode',
  driver: opencodeDriver,
  plans: OPENCODE_PLANS,
  async prepare(root) {
    const home = path.join(root, 'opencode-home')
    const dirs = { XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' }
    for (const dir of Object.values(dirs)) mkdirSync(path.join(home, dir), { recursive: true })
    const folders = Object.fromEntries(Object.entries(dirs).map(([name, dir]) => [name, path.join(home, dir)]))
    const env = agentEnv('opencode', { providerKeyAgents: {} } as unknown as Settings, {}, {}, folders)
    // OpenCode reads provider keys from the shell; the recording runs on a model that needs none.
    for (const { envVar } of PROVIDER_KEYS) delete env[envVar]
    const binary = process.env.OPENCODE_BIN || opencodeBinary()
    return {
      env,
      model: MODEL,
      version: async () => (await run(binary, ['--version'], { env })).stdout.trim(),
      install: (rec) => setTransportOverride('opencode', () => teeOpencodeLauncher((launch) => spawnOpencodeServer({ ...launch, file: binary }), rec())),
      finish: async () => {}
    }
  }
}
