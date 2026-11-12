// `npm run record:agent -- simulated`: records the `simulated` fixtures from the protocol fakes (fakes.ts), through the
// same recorder and the same tee as a real agent. OpenCode and the shared ACP folder get the ACP conformance fake; Cursor
// gets its SDK fake under the worker's message loop. Their records stay `simulated` until someone who has the agent
// installed runs `npm run record:agent` for it (docs/agents.md, section 13).
import { setTransportOverride } from '../transport'
import { createAcpDriver } from '../acp'
import { cursorProcessDriver } from '../cursor/process'
import { setCursorScenario } from './cursorSdkFake'
import { acpFake, inProcessAcp, inProcessCursorWorker, type AcpScenario } from './fakes'
import { recordScenario, type AgentRecorder, type Plan, type Scenario } from './recorder'
import { teeAcpConnector, teeCursorFork } from './tee'

const PLAN: Plan = { prompt: 'Run the tests', approvals: 'ask', note: '' }

const ACP_PLANS: AgentRecorder['plans'] = {
  plain: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'A short answer and a usage update with its cost, from the ACP conformance fake.' },
  approval: { ...PLAN, note: 'The fake agent asks session/request_permission before a command; the scripted person allows it once.' },
  terminal: { ...PLAN, note: 'The fake agent asks permission for a command, then runs it through `terminal/create` (node printing 2), waits for it, reads `terminal/output` and releases it; the scripted person allows it once. The command really ran, in a piped process.' },
  question: { ...PLAN, answer: true, note: 'The fake agent asks `elicitation/create` with a form (a titled choice, a multi-select, a boolean, an integer); the scripted person picks the first option of each and leaves the number empty.' },
  interrupt: { ...PLAN, interrupt: true, note: 'The scripted person stops the turn once text has started: session/cancel, the fake answers `cancelled`.' },
  crash: { ...PLAN, note: 'The fake agent\'s end of the connection closes mid-turn, with its prompt unanswered.' },
  resume: { ...PLAN, prompt: 'What word did I ask you to remember?', resumes: { prompt: 'Remember the word "pineapple".' }, note: 'A second turn that continues the first one\'s session with session/load.' }
}

const CURSOR_PLANS: AgentRecorder['plans'] = {
  plain: { ...PLAN, prompt: 'Reply with the single word: ok', approvals: 'never-ask', note: 'A short answer and a usage tick, from Cursor\'s SDK replaced by a fake under the worker\'s message loop.' },
  interrupt: { ...PLAN, interrupt: true, approvals: 'never-ask', note: 'The scripted person stops the turn once text has started: run.cancel(), the stream ends and the run is `cancelled`.' },
  resume: { ...PLAN, prompt: 'What word did I ask you to remember?', approvals: 'never-ask', resumes: { prompt: 'Remember the word "pineapple".' }, note: 'A second turn that resumes the first one\'s agent (Agent.resume).' }
}

// OpenCode only: a plain turn from each major version, which declares it. Foreman starts a server for every turn, whatever it is (docs/agents.md 3.2).
const OPENCODE_PLANS: AgentRecorder['plans'] = {
  ...ACP_PLANS,
  version1: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'A plain turn from an OpenCode that says it is 1.14.3: Foreman starts a server for the turn and closes it when the turn ends.' },
  version2: { ...PLAN, prompt: 'Reply with the single word: ok', note: 'A plain turn from an OpenCode that says it is 2.1.0: Foreman starts a server for the turn and closes it when the turn ends, as for 1.x.' }
}

function acpSpec(agent: 'opencode' | 'acp'): AgentRecorder {
  return {
    agent,
    evidence: 'simulated',
    driver: createAcpDriver({ kind: agent === 'opencode' ? 'opencode' : 'gemini', label: agent, command: () => ({ file: 'unused', args: [] }) }),
    plans: agent === 'opencode' ? OPENCODE_PLANS : ACP_PLANS,
    async prepare(_root, scenario: Scenario) {
      return {
        env: {},
        model: '',
        version: async () => 'conformance-fake 1.0.0',
        install: (rec) => setTransportOverride('acp', () => teeAcpConnector(inProcessAcp(acpFake(scenario as AcpScenario)), rec())),
        finish: async () => undefined
      }
    }
  }
}

const cursorSpec: AgentRecorder = {
  agent: 'cursor',
  evidence: 'simulated',
  driver: cursorProcessDriver,
  plans: CURSOR_PLANS,
  async prepare(_root, scenario) {
    setCursorScenario(scenario === 'resume' ? 'resume' : scenario === 'interrupt' ? 'interrupt' : 'plain')
    return {
      env: { CURSOR_API_KEY: 'simulated-key' },
      model: 'auto',
      version: async () => 'sdk-fake 1',
      install: (rec) => setTransportOverride('cursor', () => teeCursorFork(inProcessCursorWorker(), rec())),
      finish: async () => undefined
    }
  }
}

/** Every simulated fixture, rewritten. */
export async function simulateAll(log: (text: string) => void = console.log): Promise<void> {
  for (const [spec, scenarios] of [
    [acpSpec('opencode'), Object.keys(OPENCODE_PLANS)],
    [acpSpec('acp'), Object.keys(ACP_PLANS)],
    [cursorSpec, Object.keys(CURSOR_PLANS)]
  ] as const) {
    for (const scenario of scenarios) {
      log(`recording ${spec.agent}/${scenario}`)
      const result = await recordScenario(spec, scenario as Scenario, log)
      log(`${spec.agent}/${scenario}: ${result.frames} frames, ${JSON.stringify(result.result)}${result.leaks.length ? ` LEAKS ${result.leaks.join('; ')}` : ''}`)
      if (result.leaks.length) throw new Error('a simulated fixture holds something that must not be committed')
    }
  }
}
