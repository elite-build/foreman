import { DELEGATION_TOOLS } from '../../src/shared/foremanDelegation'
import { appTools, callsTo, currentDefinition } from '../fakeApp'
import type { EvalCase, ToolCall } from '../types'

/** What the model reads of wait_for_turn and get_turn_result: their descriptions in full, as the app registers them. */
interface WaitTexts {
  wait_for_turn: string
  get_turn_result: string
}

const AFTER: WaitTexts = { wait_for_turn: DELEGATION_TOOLS.wait_for_turn.description, get_turn_result: DELEGATION_TOOLS.get_turn_result.description }

const SYSTEM = 'You coordinate coding work for the user through Foreman’s app tools. Do only what is asked, and use as few calls as you can.'

/** A task the model starts takes a few waits to finish: wait_for_turn times out twice, then reports the turn ended. */
function replies() {
  let waits = 0
  let ended = false
  return {
    start_task: () => JSON.stringify({ workspaceId: 'ws-41', setup: 'ready', note: 'Use get_task_status to find the first turn.' }),
    get_task_status: () => JSON.stringify({ workspaceId: 'ws-41', setup: 'ready', chats: [{ sessionId: 's-41', turns: [{ turnId: 't-77', state: ended ? 'ended' : 'running' }] }] }),
    wait_for_turn: () => {
      waits++
      if (waits < 3) return JSON.stringify({ turnId: 't-77', state: 'running', timedOut: true })
      ended = true
      return JSON.stringify({ turnId: 't-77', state: 'ended', outcome: 'completed' })
    },
    get_turn_result: () => JSON.stringify(ended ? { turnId: 't-77', state: 'ended', outcome: 'completed', reply: 'Added the CSV export button and its test.' } : { turnId: 't-77', state: 'running' })
  }
}

/** The calls from the first get_task_status (the turn id is known) on, which is where waiting or polling begins. */
export function afterTurnKnown(calls: ToolCall[]): ToolCall[] {
  const at = calls.findIndex((c) => c.name === 'get_task_status')
  return at < 0 ? [] : calls.slice(at + 1)
}

export const toolWaitNotPoll: EvalCase<WaitTexts> = {
  id: 'tool-wait-not-poll',
  title: 'A coordinator waits with wait_for_turn instead of polling get_turn_result',
  source: 'Not from an observed failure yet: written from what the tools are for (src/shared/foremanDelegation.ts). get_turn_result answers at once whatever the turn state, so an agent that polls it in a loop burns calls and tokens; wait_for_turn exists to block. Replace this with the failure when one is seen.',
  before: { none: 'wait_for_turn and get_turn_result have had these descriptions since the initial commit (bbef7f3); no earlier text exists.' },
  after: AFTER,
  build: (variant, scenario) => ({
    system: SYSTEM,
    prompt:
      scenario === 'probe'
        ? 'Start the task “Add a CSV export to the usage page” on loadout 2, and once its first turn has finished tell me what it replied. Do nothing else.'
        : 'Which agent loadouts are configured? List them in one line each. Do nothing else.',
    tools: appTools({
      overrides: {
        wait_for_turn: { ...currentDefinition('wait_for_turn'), description: variant.wait_for_turn },
        get_turn_result: { ...currentDefinition('get_turn_result'), description: variant.get_turn_result }
      },
      replies: replies()
    }),
    maxTurns: 14
  }),
  check: (output, scenario) => {
    if (scenario === 'control') {
      const names = output.calls.map((c) => c.name)
      if (!names.includes('list_delegation_options')) return { pass: false, reason: 'never read the loadouts' }
      const extra = names.filter((n) => n !== 'list_delegation_options')
      return extra.length ? { pass: false, reason: `did more than asked: ${extra.join(', ')}` } : { pass: true, reason: 'read the loadouts and stopped' }
    }
    const names = output.calls.map((c) => c.name)
    if (!names.includes('start_task')) return { pass: false, reason: 'never started the task' }
    const after = afterTurnKnown(output.calls)
    const waits = callsTo(after, 'wait_for_turn').length
    const polls = callsTo(after, 'get_turn_result').length
    if (!waits) return { pass: false, reason: `never called wait_for_turn (polled get_turn_result ${polls} times)` }
    if (polls > 1) return { pass: false, reason: `polled get_turn_result ${polls} times while waiting` }
    return { pass: true, reason: `waited ${waits} times, read the result ${polls} times` }
  }
}
