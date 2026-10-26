import { cursorDriver } from './agents/cursor'
import type { CursorEvent, CursorStart } from './agents/cursorProcess'
import type { AgentTurn, TurnCallbacks } from './agents/types'

let turn: AgentTurn | undefined
const send = (event: CursorEvent) => { if (process.connected) process.send?.(event) }
process.on('disconnect', () => process.exit(0))
process.on('message', (message: CursorStart | { type: 'stop' }) => {
  if (message.type === 'stop') { void turn?.stop(); return }
  if (turn) return
  const cb: TurnCallbacks = {
    item: (...args) => send({ type: 'item', args }),
    sessionStarted: (...args) => send({ type: 'sessionStarted', args }),
    usage: (...args) => send({ type: 'usage', args }),
    finished: (...args) => send({ type: 'finished', args }),
    assistantMessage: () => undefined, planModeChanged: () => undefined, autoAcceptEdits: () => undefined,
    approveTool: async () => ({ kind: 'tool', allow: false }),
    reviewPlan: async () => ({ kind: 'plan', approve: false }),
    ask: async () => ({ kind: 'question', skipped: true })
  }
  const req = message.request
  turn = cursorDriver.createTurn({ ...req, ...(message.reports ? { hostTools: {
    workspaceDiff: async () => '', diffComments: async () => '', addDiffComments: async () => '',
    report: (kind, text, link) => { send({ type: 'report', args: [kind, text, link] }); return 'Noted.' }
  } } : {}) }, cb)
  void turn.run().catch((err: unknown) => cb.finished({ ok: false, error: String(err) })).finally(() => send({ type: 'ended' }))
})
