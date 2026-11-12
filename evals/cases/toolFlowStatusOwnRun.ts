import { z } from 'zod'
import { appTools, callsTo, currentDefinition, type ToolDefinition } from '../fakeApp'
import type { EvalCase } from '../types'

const id = z.string().min(1).max(200)

/** get_flow_status as it was before #109: the run's id was required, so a flow step that wasn't told it had nothing to give. */
const BEFORE: ToolDefinition = {
  description:
    'Inspect a permitted flow run: its state and reason, the step and iteration it is at, its steps so far with their facts and chat/turn IDs, and its workspaces. A run waiting at a gate or pick waits for the user, whom only the user answers. Does not wait; to wait for a step, use wait_for_turn on its turn ID.',
  schema: z.object({ runId: id }).strict()
}

const SYSTEM =
  'You are a coding agent working in a Foreman workspace, as one step of a flow run. Foreman gave you its app tools. ' +
  'You were not told the run’s id. Do only what is asked.'

/** #109: "Let a flow step read its own run without being told the run's id". */
export const toolFlowStatusOwnRun: EvalCase<ToolDefinition> = {
  id: 'tool-flow-status-own-run',
  title: 'A flow step reads its own run without being told the run id',
  source: 'PR #109 (commit 2ea9850): a flow step that wanted to read its own run had to supply a runId it was never given, so it guessed one or asked.',
  before: { value: BEFORE, ref: '2ea9850^' },
  after: currentDefinition('get_flow_status'),
  build: (variant, scenario) => ({
    system: SYSTEM,
    prompt:
      scenario === 'probe'
        ? 'Before you carry on, check which step of this flow run you are in and whether the run is waiting on anyone. Answer in one sentence.'
        : 'Check how flow run run-8f21 is going and tell me which step it is at. Answer in one sentence.',
    tools: appTools({ overrides: { get_flow_status: variant } })
  }),
  check: (output, scenario) => {
    const calls = callsTo(output.calls, 'get_flow_status')
    if (!calls.length) return { pass: false, reason: `never called get_flow_status (called: ${output.calls.map((c) => c.name).join(', ') || 'nothing'})` }
    const runIds = calls.map((c) => c.args.runId)
    if (scenario === 'control') {
      return runIds.includes('run-8f21') ? { pass: true, reason: 'read the named run' } : { pass: false, reason: `asked for ${JSON.stringify(runIds)} instead of run-8f21` }
    }
    const guessed = runIds.find((r) => typeof r === 'string' && r !== '')
    if (guessed !== undefined) return { pass: false, reason: `invented a run id: ${JSON.stringify(guessed)}` }
    return { pass: true, reason: 'read its own run with no runId' }
  }
}
