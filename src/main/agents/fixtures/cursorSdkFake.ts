// A fake of `@cursor/sdk` for the simulated Cursor recording (fakes.ts, simulate.ts): one agent whose one run streams a
// short answer and a usage tick. Kept apart from the modules that import the Cursor driver, because the mock that
// installs it (scripts/record/record.record.ts) is loaded while that driver imports the SDK.
export type CursorScenario = 'plain' | 'resume' | 'interrupt'

let scenario: CursorScenario = 'plain'
export const setCursorScenario = (next: CursorScenario) => void (scenario = next)

const ids = { agent_id: 'agent-1', run_id: 'run-1' }

export function fakeCursorSdk() {
  class AgentNotFoundError extends Error {}
  class AuthenticationError extends Error {}
  const run = () => {
    // `interrupt`: the run goes on until it is cancelled (run.cancel), then its stream ends and wait() says `cancelled`.
    let cancelled = false
    let release = () => {}
    const cancelledAt = new Promise<void>((resolve) => (release = resolve))
    return {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        if (scenario === 'interrupt') {
          yield { type: 'assistant', ...ids, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } }
          await cancelledAt
          return
        }
        yield { type: 'assistant', ...ids, message: { role: 'assistant', content: [{ type: 'text', text: scenario === 'resume' ? 'pineapple' : 'ok' }] } }
        yield { type: 'usage', ...ids, usage: { inputTokens: 1200, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1204 } }
      },
      wait: async () => ({ id: 'run-1', status: cancelled ? 'cancelled' : 'finished', durationMs: 900 }),
      cancel: async () => {
        cancelled = true
        release()
      }
    }
  }
  const agent = () => ({ agentId: 'agent-1', send: async () => run(), close: () => undefined })
  return { Agent: { create: async () => agent(), resume: async () => agent() }, Cursor: { models: { list: async () => [] } }, AgentNotFoundError, AuthenticationError }
}
