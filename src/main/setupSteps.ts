// Runs a workspace's setup steps (O19): in order, each with its own timeout,
// stopping at the first that doesn't pass. Each step is a user script run the
// same way a single setup script always was (scripts.ts). G3: consecutive steps
// marked `parallel` run at the same time, and archive steps run here too.
import { isWindows } from './platform'
import { runScript, type RunningScript } from './scripts'
import type { WorkspaceRuntime } from './runtime/types'
import { pendingResults, stepGroups } from '../shared/setupSteps'
import type { SetupStep, SetupStepResult } from '../shared/types'

export type SetupOutcome = 'done' | 'failed' | 'timed-out' | 'stopped'

export interface SetupStepsOptions {
  steps: SetupStep[]
  // Carry on from this step, keeping `previous` results for the ones before it (Retry failed step).
  from?: number
  previous?: SetupStepResult[]
  // Run a step that fails or times out once more before stopping.
  retryOnce?: boolean
  // A folder here, or a workspace runtime (a cloud workspace's sandbox).
  cwd: string | WorkspaceRuntime
  env: Record<string, string>
  // A step is starting; `attempt` counts its runs in this setup run, from 1 (2 for a retry).
  onStepStart?(index: number, attempt: number): void
  onOutput(index: number, chunk: string): void
  // Any step's status changed; `results` is the whole list, safe to keep.
  onChange(results: SetupStepResult[]): void
  // How long a timed-out step gets after being interrupted before it is killed.
  graceMs?: number
}

export interface SetupStepsRun {
  results: SetupStepResult[]
  done: Promise<SetupOutcome>
  // Stop setup: end the running step and skip the rest.
  kill(): Promise<void>
}

const ENDED: Record<Exclude<SetupOutcome, 'done'>, SetupStepResult['status']> = { failed: 'failed', 'timed-out': 'timed-out', stopped: 'stopped' }

export function runSetupSteps(options: SetupStepsOptions): SetupStepsRun {
  const { steps, cwd, env, graceMs = 5000 } = options
  const from = Math.max(0, Math.min(options.from ?? 0, steps.length))
  const fresh = pendingResults(steps)
  // Steps before `from` passed in the earlier attempt and aren't run again.
  // The step it carries on from keeps its count of runs, so its log can say it is a retry.
  // G3: a step in the same parallel group as `from` that passed last time keeps its result too.
  const resumedGroup = stepGroups(steps).find((g) => g.includes(from)) ?? []
  const results: SetupStepResult[] = fresh.map((r, i) => {
    const before = options.previous?.[i]
    if (!before) return r
    if (i > from && resumedGroup.includes(i) && before.status === 'done') return { ...before }
    return i < from ? { ...before } : i === from ? { ...r, attempts: before.attempts } : r
  })
  // The steps running now: one, or a parallel group's.
  const current = new Set<RunningScript>()
  let stopped = false
  let killing: Promise<void> | null = null

  const changed = () => options.onChange(results.map((r) => ({ ...r })))

  /** Interrupt the step, then kill it if it's still there after the grace period. */
  const interrupt = async (run: RunningScript) => {
    await run.kill()
    if (isWindows) return
    const pid = run.child?.pid
    const exited = run.done.then(() => true)
    const late = await Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))])
    if (late || !pid) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }

  const attemptStep = async (index: number): Promise<SetupOutcome> => {
    const step = steps[index]
    const result = results[index]
    const started = Date.now()
    Object.assign(result, { status: 'running', startedAt: new Date(started).toISOString(), attempts: (result.attempts ?? 0) + 1 })
    delete result.durationMs
    delete result.exitCode
    changed()
    options.onStepStart?.(index, result.attempts!)
    const run = runScript(step.command, cwd, env, (chunk) => options.onOutput(index, chunk))
    current.add(run)
    let timedOut = false
    const timer = step.timeoutSec
      ? setTimeout(() => {
          timedOut = true
          void interrupt(run)
        }, step.timeoutSec * 1000)
      : undefined
    const code = await run.done
    clearTimeout(timer)
    current.delete(run)
    const outcome: SetupOutcome = stopped ? 'stopped' : timedOut ? 'timed-out' : code === 0 ? 'done' : 'failed'
    Object.assign(result, { status: outcome === 'done' ? 'done' : ENDED[outcome], durationMs: Date.now() - started, exitCode: code })
    changed()
    return outcome
  }

  const done = (async (): Promise<SetupOutcome> => {
    // Start after the caller has the handle (and has recorded `results`).
    await Promise.resolve()
    let outcome: SetupOutcome = 'done'
    const groups = stepGroups(steps)
    const resumedGroupRef = groups.find((g) => g.includes(from))
    const runStep = async (i: number): Promise<SetupOutcome> => {
      const first = await attemptStep(i)
      return (first === 'failed' || first === 'timed-out') && options.retryOnce && !stopped ? attemptStep(i) : first
    }
    for (const group of groups) {
      // Carrying on: a step of the resumed group that passed last time isn't run again.
      const todo = group.filter((i) => i >= from && !(i > from && group === resumedGroupRef && options.previous?.[i]?.status === 'done'))
      if (!todo.length) continue
      if (stopped && outcome === 'done') outcome = 'stopped'
      if (outcome !== 'done') {
        for (const i of todo) results[i].status = 'skipped'
        continue
      }
      // A group's steps run together; it ends when they all have, as the first one that didn't pass.
      const ended = await Promise.all(todo.map(runStep))
      outcome = ended.includes('stopped') || stopped ? 'stopped' : (ended.find((o) => o !== 'done') ?? 'done')
    }
    changed()
    return outcome
  })()

  return {
    results,
    done,
    kill: () => {
      stopped = true
      if (current.size && !killing) killing = Promise.all([...current].map(interrupt)).then(() => undefined).finally(() => (killing = null))
      return killing ?? Promise.resolve()
    }
  }
}
