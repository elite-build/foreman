// O10 tests: a stand-in agent for the background host. Its prompt is a script, one step per line:
//   say:<text>      an assistant message
//   tool:<id>       a tool call that runs and finishes
//   gate:<file>     wait until the file exists (the test's go-ahead, across processes)
//   approve:<tool>  ask for a tool approval and say the answer
//   ask             ask a question and say the answer
//   diff:<file>     call Foreman's workspaceDiff tool (a host-tool call) and say the answer
//   fail:<error>    end the turn with an error (otherwise it ends ok)
import { existsSync } from 'node:fs'
import type { AgentDriver, AgentTurn, TurnCallbacks, TurnRequest } from '../src/main/agents/types'

class FakeTurn implements AgentTurn {
  private stopped = false
  private n = 0

  constructor(
    private req: TurnRequest,
    private cb: TurnCallbacks
  ) {}

  private say(text: string): void {
    this.cb.item({ kind: 'assistant', id: `${this.req.turnId}:${this.n++}`, turnId: this.req.turnId, text })
  }

  async run(): Promise<void> {
    this.cb.sessionStarted(`agent-${this.req.turnId}`)
    let failure: string | undefined
    for (const line of this.req.prompt.split('\n')) {
      if (this.stopped) break
      const [step, ...rest] = line.split(':')
      const arg = rest.join(':')
      if (step === 'say') this.say(arg)
      else if (step === 'tool') {
        const item = { kind: 'tool' as const, id: arg, turnId: this.req.turnId, name: 'Bash', input: { command: arg }, status: 'running' as const }
        this.cb.item(item)
        this.cb.item({ ...item, status: 'done', output: 'ok' })
      } else if (step === 'gate') {
        while (!existsSync(arg) && !this.stopped) await new Promise((r) => setTimeout(r, 20))
      } else if (step === 'approve') {
        const answer = await this.cb.approveTool({ kind: 'tool', toolName: arg, input: { command: 'npm run build' } }, new AbortController().signal)
        this.say(answer.allow ? 'approved' : `denied: ${answer.message ?? ''}`)
      } else if (step === 'ask') {
        const answer = await this.cb.ask([{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], new AbortController().signal)
        this.say(`answer: ${JSON.stringify(answer.answers ?? null)}`)
      } else if (step === 'diff') {
        this.say(`diff: ${(await this.req.hostTools?.workspaceDiff(arg || undefined)) ?? 'no tools'}`)
      } else if (step === 'fail') failure = arg
    }
    this.cb.finished(this.stopped ? { ok: false, error: 'Stopped.' } : failure ? { ok: false, error: failure } : { ok: true })
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  steer(text: string): boolean {
    this.say(`steered: ${text}`)
    return true
  }

  async setPlanMode(): Promise<void> {}
  async setModel(): Promise<void> {}
}

export const fakeDriver: AgentDriver = {
  kind: 'claude',
  createTurn: (req, cb) => new FakeTurn(req, cb),
  status: async () => ({ agent: 'claude', installed: true, ready: true })
}

export function fakeRequest(turnId: string, prompt: string, cwd = process.cwd()): TurnRequest {
  return { turnId, prompt, cwd, env: {}, model: 'claude-opus-5-5', fastMode: false, planMode: false, approvals: 'ask', systemPromptAppend: '' }
}
