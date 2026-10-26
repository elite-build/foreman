// The remote-workspace commands: cloud status|wake|sleep|restart|reattach|continue|usage|build|preflight. Each one sends
// a request and prints the `text` of the answer (or the JSON with --json). `cloud build --wait` prints the build's output as
// progress lines and exits 1 when the build fails; `cloud preflight` exits 1 when a remote workspace can't be made.
import type { CloudBuildResult, CloudPreflightResult } from '../../shared/cli/cloud'
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { needWorkspace, tabNumber } from './git'

/** A request whose answer is its text. */
function simple(method: string, params: (ctx: Context) => Record<string, unknown>, what: string): Run {
  return async (ctx) => {
    if (ctx.args.length > 1) throw usageError(`Too many words for foreman ${what}.`)
    const result = await ctx.send<{ text: string }>(method, params(ctx))
    ctx.print(result, () => result.text)
  }
}

const onWorkspace = (method: string, what: string): Run => simple(method, (ctx) => ({ workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd }), what)

const usage: Run = async (ctx) => {
  if (ctx.args.length) throw usageError('foreman cloud usage takes no words.')
  const result = await ctx.send<{ text: string }>('cloud-usage')
  ctx.print(result, () => result.text)
}

const build: Run = async (ctx) => {
  if (ctx.args.length > 1) throw usageError('foreman cloud build takes one repository.')
  const wait = Boolean(ctx.opts.wait)
  const result = await ctx.send<CloudBuildResult>('cloud-build', { repo: ctx.args[0], cwd: ctx.cwd, wait: wait ? true : undefined }, { waiting: wait })
  ctx.print(result, () => result.text)
  if (result.outcome === 'failed') process.exitCode = 1
}

const preflight: Run = async (ctx) => {
  if (ctx.args.length > 1) throw usageError('foreman cloud preflight takes one repository.')
  const result = await ctx.send<CloudPreflightResult>('cloud-preflight', { repo: ctx.args[0], cwd: ctx.cwd })
  ctx.print(result, () => result.text)
  if (!result.preflight.ok) process.exitCode = 1
}

export const cloudRunners: Record<string, Run> = {
  'cloud status': simple('cloud-status', (ctx) => ({ workspace: ctx.args[0], cwd: ctx.cwd }), 'cloud status'),
  'cloud wake': onWorkspace('cloud-wake', 'cloud wake'),
  'cloud sleep': onWorkspace('cloud-sleep', 'cloud sleep'),
  'cloud restart': onWorkspace('cloud-restart', 'cloud restart'),
  'cloud reattach': onWorkspace('cloud-reattach', 'cloud reattach'),
  'cloud continue': simple('cloud-continue', (ctx) => ({ workspace: needWorkspace(ctx.args[0]), cwd: ctx.cwd, tab: tabNumber(ctx) }), 'cloud continue'),
  'cloud usage': usage,
  'cloud build': build,
  'cloud preflight': preflight
}

/** Hands each command's function to the registry (`register('cloud status', run)`). */
export function registerCloudCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(cloudRunners)) register(name, run)
}
