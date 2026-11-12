// What an eval case is and what running one produces. Pure types: nothing here calls a model.
import type { z } from 'zod'

/** A tool the model is offered that does nothing in the app: it records the call and answers with a canned reply. */
export interface FakeTool {
  name: string
  description: string
  schema: z.ZodRawShape
  /** The reply to the `nth` call of this tool (0 for the first) in this run. */
  reply: (args: Record<string, unknown>, nth: number) => string
}

/** One model run: what it is told and the tools it may call (served in-process, never touching the app). */
export interface RunSpec {
  system?: string
  prompt: string
  tools?: FakeTool[]
  /** Model turns the run may take. Default 1 without tools, 8 with. */
  maxTurns?: number
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface RunOutput {
  /** The model's final answer. */
  text: string
  /** Every tool call, in order. */
  calls: ToolCall[]
  costUsd: number
  /** The run itself failed (sign-in, network, the SDK): neither a pass nor a fail of the text under test. */
  error?: string
}

/** `probe` is the input the old text got wrong; `control` is one the old and the new text must both get right. */
export type Scenario = 'probe' | 'control'

export interface Verdict {
  pass: boolean
  reason: string
}

/**
 * One eval case. `V` is the text under test: a prompt, a persona body, a tool definition. `build` puts a variant of it
 * into a run; `check` reads what came back. A case comes from a real failure (`source`), `before` is the text as it was
 * when that failure happened (with the commit it is from), `after` is the text now (imported from its source module, so
 * it can't drift), and the case must fail on `before`. Where no earlier text exists, `before` says why, and the runner
 * reports "no before" rather than inventing one.
 */
export interface EvalCase<V = unknown> {
  id: string
  title: string
  /** The failure this case comes from: an issue, a pull request, a commit, or what went wrong. */
  source: string
  before: { value: V; ref: string } | { none: string }
  after: V
  /** The run for a variant of the text. Called afresh for every run, so a closure can hold that run's state. */
  build: (variant: V, scenario: Scenario) => RunSpec
  check: (output: RunOutput, scenario: Scenario) => Verdict
  /** Runs per scenario and variant when `--runs` isn't given. Default 3. */
  runs?: number
}

// A list of cases holds cases of different V.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCase = EvalCase<any>

export const DEFAULT_RUNS = 3
