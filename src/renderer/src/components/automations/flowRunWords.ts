// A flow run's states in words and tones (docs/loops-and-graphs.md), shared by Automations, the workspace's Flow tab
// and the Run a flow page. State is never colour alone: each tone goes with these words in a Status.
import type { FlowRun, FlowRunStep, FlowStepKind } from '../../../../shared/flows'
import type { PlainKey } from '../../../../shared/i18n'
import type { StatusTone } from '../../ui'

export const RUN_STATE: Record<FlowRun['state'], PlainKey> = {
  starting: 'flowRun.state.starting',
  running: 'flowRun.state.running',
  waiting: 'flowRun.state.waiting',
  completed: 'flowRun.state.completed',
  failed: 'flowRun.state.failed',
  'needs-you': 'flowRun.state.needsYou',
  stopped: 'flowRun.state.stopped',
  uncertain: 'flowRun.state.uncertain'
}

export const RUN_TONE: Record<FlowRun['state'], StatusTone> = {
  starting: 'info',
  running: 'info',
  waiting: 'warn',
  completed: 'ok',
  failed: 'error',
  'needs-you': 'warn',
  stopped: 'off',
  uncertain: 'warn'
}

export const STEP_STATE: Record<FlowRunStep['state'], PlainKey> = {
  running: 'flowRun.stepState.running',
  completed: 'flowRun.stepState.completed',
  failed: 'flowRun.stepState.failed',
  waiting: 'flowRun.stepState.waiting',
  stopped: 'flowRun.stepState.stopped'
}

export const STEP_TONE: Record<FlowRunStep['state'], StatusTone> = {
  running: 'info',
  completed: 'ok',
  failed: 'error',
  waiting: 'warn',
  stopped: 'off'
}

/** The kinds a run carries out, by name. */
export const STEP_KIND: Record<FlowStepKind, PlainKey> = {
  turn: 'flowRun.kind.turn',
  checks: 'flowRun.kind.checks',
  script: 'flowRun.kind.script',
  review: 'flowRun.kind.review',
  decide: 'flowRun.kind.decide',
  workspace: 'flowRun.kind.workspace',
  wait: 'flowRun.kind.wait',
  gate: 'flowRun.kind.gate',
  pick: 'flowRun.kind.pick',
  pr: 'flowRun.kind.pr'
}
