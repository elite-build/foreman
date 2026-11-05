// `foreman flow …`: flows (docs/loops-and-graphs.md). Starting a run approves what it will do, so `flow run` asks the
// app for the approval summary first, prints it, asks, and sends the fingerprint back as `shown`: the app refuses when it
// no longer matches, as the Run dialog does. `--wait` then follows the run step by step until it ends.
import { flowEndText, flowRunExit, flowRunGoing, flowStepText, gateWaitText, pickWaitText, type FlowAddResult, type FlowDraftResult, type FlowRunResult, type FlowRunRow, type FlowRunStartedResult, type FlowWaitResult } from '../../shared/cli/flows'
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { EXIT_DISCONNECTED } from '../protocol'
import { declinedNote, io, noMoreWords, previewAndAsk, printText, str } from './automationKit'

/** `--input key=value`, once per input: split at the first =. */
export function inputsOf(values: unknown): Record<string, string> {
  const inputs: Record<string, string> = {}
  if (values === undefined) return inputs
  for (const raw of Array.isArray(values) ? values : [values]) {
    const text = String(raw)
    const at = text.indexOf('=')
    if (at < 1) throw usageError(`--input takes key=value, not “${text}”.`)
    const key = text.slice(0, at).trim()
    if (key in inputs) throw usageError(`--input ${key} is given twice.`)
    inputs[key] = text.slice(at + 1)
  }
  return inputs
}

const list: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman flow list [--repo <name|path>]')
  printText(ctx, await ctx.send<{ text: string }>('flow-list', { repo: str(ctx.opts.repo), cwd: ctx.cwd }))
}

const show: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman flow show <flow> [--mermaid]')
  if (!ctx.args[0]) throw usageError('Name a flow. `foreman flow list` lists them.')
  printText(ctx, await ctx.send<{ text: string }>('flow-show', { flow: ctx.args[0], repo: str(ctx.opts.repo), cwd: ctx.cwd, ...(ctx.opts.mermaid ? { mermaid: true } : {}) }))
}

const add: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman flow add <file.toml> [--name <name>]')
  const [file] = ctx.args
  if (!file) throw usageError('Give the flow’s TOML file: foreman flow add <file.toml>')
  let toml: string
  try {
    toml = await io.readFile(file, ctx.cwd)
  } catch (err) {
    throw usageError(`Can’t read ${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`)
  }
  const result = await ctx.send<FlowAddResult>('flow-add', { toml, name: str(ctx.opts.name) })
  printText(ctx, result)
  if (!result.saved) process.exitCode = 1
}

const remove: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman flow remove <flow>')
  const [flow] = ctx.args
  if (!flow) throw usageError('Name a personal flow. `foreman flow list` lists them.')
  if (!(await ctx.confirm(`Remove the personal flow “${flow}”?`))) return declinedNote(ctx, 'Nothing removed.')
  printText(ctx, await ctx.send<{ text: string }>('flow-remove', { flow }))
}

/** Prints each step once as it starts and once as it ends, and a gate or pick once as it starts to wait. */
export function stepPrinter(say: (line: string) => void): (run: FlowRunRow) => void {
  const started = new Set<number>()
  const ended = new Set<number>()
  const gates = new Set<string>()
  return (run) => {
    run.steps.forEach((step, i) => {
      if (!started.has(i)) {
        started.add(i)
        say(flowStepText(step, true))
      }
      if (!ended.has(i) && step.state !== 'running' && step.state !== 'waiting') {
        ended.add(i)
        say(flowStepText(step))
      }
    })
    if (run.gate && !gates.has(run.gate.id)) {
      gates.add(run.gate.id)
      say(gateWaitText(run.gate))
    }
    if (run.pick && !gates.has(run.pick.id)) {
      gates.add(run.pick.id)
      say(pickWaitText(run.pick))
    }
  }
}

/** Follow a started run to its end; prints its steps (not with --json) and sets the exit code from how it ended. */
async function follow(ctx: Context, started: FlowRunStartedResult): Promise<void> {
  const say = (line: string) => {
    if (!ctx.json) ctx.print(null, line)
  }
  const update = stepPrinter(say)
  let run = started.run
  let seen = started.seen
  update(run)
  while (flowRunGoing(run.state)) {
    let waited: FlowWaitResult
    try {
      waited = await ctx.send<FlowWaitResult>('flow-wait', { run: run.id, seen }, { waiting: true })
    } catch (err) {
      // The run id is what the caller needs to look again.
      if (ctx.json && err instanceof CliError && err.exitCode === EXIT_DISCONNECTED) ctx.print({ ...started, run, outcome: 'disconnected' }, '')
      throw err
    }
    run = waited.run
    seen = waited.seen
    update(run)
  }
  say(flowEndText(run))
  if (ctx.json) ctx.print({ ...started, run }, '')
  process.exitCode = flowRunExit(run.state)
}

const run: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman flow run <flow> [options]')
  const [flow] = ctx.args
  if (!flow) throw usageError('Name a flow. `foreman flow list` lists them.')
  const { opts } = ctx
  const params = { flow, cwd: ctx.cwd, repo: str(opts.repo), base: str(opts.base), inputs: inputsOf(opts.input), open: Boolean(opts.open) }
  const first = await ctx.send<FlowRunResult>('flow-run', params)
  let result: FlowRunResult = first
  if (!first.started) {
    if (!(await previewAndAsk(ctx, first.text, `Start “${first.summary.flowName}”?`, first))) return declinedNote(ctx, 'Nothing started.')
    result = await ctx.send<FlowRunResult>('flow-run', { ...params, shown: first.fingerprint })
  }
  if (!result.started) throw new CliError('Foreman asked again instead of starting the run. Nothing started.')
  const started = result
  // Scripts get one JSON document, at the end; people see the ids at once.
  if (!ctx.json || !opts.wait) printText(ctx, started)
  if (!opts.wait) {
    if (!flowRunGoing(started.run.state) && started.run.state !== 'completed') process.exitCode = 1
    return
  }
  if (!ctx.json) ctx.print(null, '')
  await follow(ctx, started)
}

const runs: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman flow runs [--repo <name|path>] [--all]')
  if (ctx.opts.all && str(ctx.opts.repo)) throw usageError('Give --repo or --all, not both.')
  printText(ctx, await ctx.send<{ text: string }>('flow-runs', { repo: str(ctx.opts.repo), cwd: ctx.cwd, all: Boolean(ctx.opts.all) }))
}

function byRun(method: 'flow-status' | 'flow-stop', usage: string): Run {
  return async (ctx) => {
    noMoreWords(ctx, 1, usage)
    if (!ctx.args[0]) throw usageError('Name a run. `foreman flow runs` lists their ids.')
    const lens = method === 'flow-status' ? str(ctx.opts.lens) : undefined
    printText(ctx, await ctx.send<{ text: string }>(method, { run: ctx.args[0], ...(lens ? { lens } : {}) }))
  }
}

/** `foreman flow draft <workspace> [--save [--name <name>]]`: a flow drafted from a workspace's lineage. */
const draft: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman flow draft <workspace> [--save] [--name <name>]')
  if (!ctx.args[0]) throw usageError('Name a workspace. `foreman status` lists them.')
  const result = await ctx.send<FlowDraftResult>('flow-draft', { workspace: ctx.args[0], cwd: ctx.cwd, ...(ctx.opts.save ? { save: true } : {}), ...(str(ctx.opts.name) ? { name: str(ctx.opts.name) } : {}) })
  printText(ctx, result)
  if (result.saved === false) process.exitCode = 1
}

export const flowRunners: Record<string, Run> = {
  'flow list': list,
  'flow show': show,
  'flow add': add,
  'flow remove': remove,
  'flow run': run,
  'flow runs': runs,
  'flow status': byRun('flow-status', 'foreman flow status <run> [--lens context|memory|data]'),
  'flow stop': byRun('flow-stop', 'foreman flow stop <run>'),
  'flow draft': draft
}
