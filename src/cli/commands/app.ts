// The commands about the app and the command itself: app info, doctor, cli status, cli install,
// completion and help.
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { completionScript, SHELLS } from '../completion'
import { helpFor } from '../help'
import { columns } from '../output'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CLI_PROTOCOL_VERSION, type AppInfoResult, type DoctorResult, type HeapResult, type PerfParams, type ProfileParams, type ProfileResult } from '../protocol'
import { CLI_VERSION } from '../version'
import { diagnosticsFileName, type DiagnosticsBundle } from '../../shared/diagnostics'
import type { PerfReport } from '../../shared/perf'
import type { CliInstallStatus } from '../../shared/types'
import type { ServiceRestartParams, ServiceRestartResult, ServiceStatusResult } from '../../shared/cli/service'

/** An app that speaks an older protocol than this command may lack things it asks for. Said once, on stderr. */
export function warnIfOlder(ctx: Context, info: AppInfoResult): void {
  if (info.protocol < CLI_PROTOCOL_VERSION) ctx.note(`The running Foreman app speaks protocol ${info.protocol}, older than this command's ${CLI_PROTOCOL_VERSION}. Update the app (the command is part of it).`)
}

const appInfo: Run = async (ctx) => {
  const info = await ctx.send<AppInfoResult>('app-info')
  warnIfOlder(ctx, info)
  ctx.print(info, () => {
    const command = info.cliInstalled === undefined ? undefined : info.cliInstalled ? `installed${info.cliPath ? ` (${info.cliPath})` : ''}` : 'not installed'
    return columns([
      ['version', info.version],
      ['protocol', String(info.protocol)],
      ['packaged', info.packaged ? 'yes' : 'no'],
      ['data folder', info.dataDir],
      ['socket', info.socket],
      ...(command ? [['command', command]] : [])
    ])
  })
}

const doctor: Run = async (ctx) => {
  const result = await ctx.send<DoctorResult>('doctor', { cliVersion: CLI_VERSION })
  const problems = result.items.filter((i) => i.status === 'problem')
  ctx.print({ ...result, ok: problems.length === 0 }, () => {
    const lines = [columns(result.items.map((i) => [i.status, i.name, i.detail]))]
    if (problems.length) {
      lines.push('', `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}:`, ...problems.map((p) => `  ${p.name}: ${p.detail}${p.fix ? `. ${p.fix}` : ''}`))
    } else lines.push('', 'Nothing wrong.')
    return lines.join('\n')
  })
  if (problems.length) process.exitCode = 1
}

const DEFAULT_TOP = 20

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${Math.round(s - m * 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** The report as a person reads it: processes, the main thread, then the busiest counters and timings. */
export function perfText(report: PerfReport, top = DEFAULT_TOP): string {
  const lines: string[] = [`Since ${report.since} (up ${duration(report.uptimeMs)})`, '']
  const sample = report.sample
  if (!sample) lines.push('No sample yet: the app takes one every few seconds.')
  else {
    lines.push(`Processes at ${sample.at}:`)
    const rows = sample.processes.map((p) => [`  ${p.type}`, String(p.pid), `${p.cpuPercent}% cpu`, `${p.memoryMb} MB`])
    lines.push(rows.length ? columns(rows) : '  (not reported)')
    lines.push(`  main: ${sample.cpuPercent}% cpu, ${sample.rssMb} MB resident, ${sample.heapUsedMb} MB heap`)
    lines.push(`Main thread: event-loop delay p50 ${sample.loop.p50} ms, p99 ${sample.loop.p99} ms, max ${sample.loop.max} ms`)
  }
  const counters = Object.entries(report.counters).slice(0, top)
  lines.push('', counters.length ? `Counters (top ${counters.length}):` : 'Counters: none yet')
  if (counters.length) lines.push(columns(counters.map(([name, n]) => [`  ${name}`, String(n)])))
  const timings = Object.entries(report.timings).slice(0, top)
  lines.push('', timings.length ? `Timings (top ${timings.length} by total):` : 'Timings: none yet')
  if (timings.length) lines.push(columns([['  name', 'count', 'total', 'avg', 'max'], ...timings.map(([name, t]) => [`  ${name}`, String(t.count), duration(t.totalMs), duration(t.totalMs / t.count), duration(t.maxMs)])]))
  const gauges = Object.entries(report.gauges)
  if (gauges.length) lines.push('', 'Gauges (latest):', columns(gauges.map(([name, v]) => [`  ${name}`, String(v)])))
  return lines.join('\n')
}

const appPerf: Run = async (ctx) => {
  const top = ctx.opts.top === undefined ? DEFAULT_TOP : Number(ctx.opts.top)
  if (!Number.isInteger(top) || top < 1) throw usageError('--top takes a whole number of 1 or more.')
  const report = await ctx.send<PerfReport>('app-perf', { reset: Boolean(ctx.opts.reset) } satisfies PerfParams)
  ctx.print(report, () => perfText(report, top))
}

/** `foreman app diagnostics`: the bundle from the app, written to --out or the current folder; attach it to an issue. */
const appDiagnostics: Run = async (ctx) => {
  const bundle = await ctx.send<DiagnosticsBundle>('app-diagnostics')
  const out = typeof ctx.opts.out === 'string' && ctx.opts.out ? path.resolve(ctx.cwd, ctx.opts.out) : path.join(ctx.cwd, diagnosticsFileName())
  const text = `${JSON.stringify(bundle, null, 2)}\n`
  await writeFile(out, text)
  ctx.print({ file: out, bytes: text.length, events: bundle.events.length, crashDumps: bundle.crashDumps.length }, () =>
    [
      `Saved ${out}`,
      `${bundle.events.length} events this session, ${bundle.logTail.length} log lines, ${bundle.perfTail.length} performance samples, ${bundle.crashDumps.length} crash dump${bundle.crashDumps.length === 1 ? '' : 's'} listed.`,
      'Paths, user names, tokens and e-mail addresses were removed. Read it over, then attach it to the issue.'
    ].join('\n')
  )
}

function profileParams(ctx: Context): ProfileParams {
  const params: ProfileParams = { target: ctx.opts.renderer ? 'renderer' : 'main' }
  if (ctx.opts.seconds !== undefined) {
    const seconds = Number(ctx.opts.seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) throw usageError('--seconds takes a number above 0.')
    params.seconds = seconds
  }
  return params
}

/** `foreman app profile`: a CPU profile of main or the window, saved in the data folder's logs. */
const appProfile: Run = async (ctx) => {
  const params = profileParams(ctx)
  ctx.note(`Profiling the ${params.target === 'renderer' ? 'window' : 'main process'} for ${params.seconds ?? 20} s…`)
  const result = await ctx.send<ProfileResult>('app-profile', params)
  ctx.print(result, () => `Saved ${result.file} (${Math.round(result.ms / 1000)} s). Open it in Chrome DevTools (Performance → Load profile) or VS Code.`)
}

/** `foreman app heap`: a heap snapshot of main or the window, saved in the data folder's logs. */
const appHeap: Run = async (ctx) => {
  const params = profileParams(ctx)
  ctx.note(`Taking a heap snapshot of the ${params.target === 'renderer' ? 'window' : 'main process'}; this pauses it for a moment…`)
  const result = await ctx.send<HeapResult>('app-heap', { target: params.target })
  ctx.print(result, () => `Saved ${result.file}. Open it in Chrome DevTools (Memory → Load).`)
}

function statusText(status: CliInstallStatus): string {
  const lines = [status.installed ? `The foreman command is installed${status.path ? `: ${status.path}` : ''}` : 'The foreman command isn’t installed. Run `foreman cli install`, or use Settings → Advanced → foreman command → Install.']
  if (status.note) lines.push(status.note)
  return lines.join('\n')
}

const cliStatus: Run = async (ctx) => {
  const status = await ctx.send<CliInstallStatus>('cli-status')
  ctx.print(status, () => statusText(status))
}

const cliInstall: Run = async (ctx) => {
  const status = await ctx.send<CliInstallStatus>('cli-install')
  ctx.print(status, () => statusText(status))
}

/** `foreman service [status|install|uninstall]`: the app does the work and the wording (src/main/cli/service.ts). */
const service =
  (method: string, usage: string): Run =>
  async (ctx) => {
    if (ctx.args.length) throw usageError(`${usage} takes no more words.`, usage)
    const result = await ctx.send<{ text: string }>(method)
    ctx.print(result, () => result.text)
  }

/**
 * After `foreman service restart`: ask until a Foreman other than `pid` answers. It is gone for a moment (shutting down,
 * then starting), which the command sees as not running.
 */
export async function waitForRestart(ctx: Context, pid: number, options: { tries?: number; delayMs?: number } = {}): Promise<ServiceStatusResult> {
  const { tries = 120, delayMs = 500 } = options
  for (let i = 0; i < tries; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      const status = await ctx.send<ServiceStatusResult>('service-status')
      if (status.pid !== pid) return status
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== 'not-running') throw err
    }
  }
  throw new CliError(`Foreman hasn’t come back after ${Math.round((tries * delayMs) / 1000)} s.`, 1, 'failed', 'Open Foreman, or log out and in for the service to start it; `foreman service` then says how the last start went.')
}

const serviceRestart: Run = async (ctx) => {
  if (ctx.args.length) throw usageError('foreman service restart takes no more words.', 'foreman service restart [--force]')
  const result = await ctx.send<ServiceRestartResult>('service-restart', { force: Boolean(ctx.opts.force) } satisfies ServiceRestartParams)
  ctx.note(result.text)
  const back = await waitForRestart(ctx, result.pid)
  ctx.print({ ...result, back }, () => `Foreman is back (process ${back.pid}), started as the service’s${result.window ? ', with its window' : ''}.`)
}

const serviceStatus: Run = async (ctx) => {
  if (ctx.args.length > 1 || (ctx.args[0] !== undefined && ctx.args[0] !== 'status')) throw usageError('foreman service takes no words, or just “status”.', 'foreman service [status]')
  const result = await ctx.send<{ text: string }>('service-status')
  ctx.print(result, () => result.text)
}

const completion: Run = async (ctx) => {
  const [shell] = ctx.args
  if (!shell) throw usageError(`Name a shell: foreman completion ${SHELLS.join('|')}`)
  const script = completionScript(shell)
  if (script === undefined) throw usageError(`No completion for “${shell}”. Choose ${SHELLS.join(', ')}.`)
  process.stdout.write(script)
}

const help: Run = async (ctx) => {
  const answer = helpFor(ctx.args)
  if ('error' in answer) throw usageError(answer.error, answer.suggestions.length ? `Did you mean: ${answer.suggestions.map((s) => `foreman help ${s}`).join(', ')}?` : 'foreman help lists the commands.')
  console.log(answer.text)
}

export const appRunners: Record<string, Run> = {
  'app info': appInfo,
  'app perf': appPerf,
  'app diagnostics': appDiagnostics,
  'app profile': appProfile,
  'app heap': appHeap,
  doctor,
  'cli status': cliStatus,
  'cli install': cliInstall,
  service: serviceStatus,
  'service status': service('service-status', 'foreman service status'),
  'service install': service('service-install', 'foreman service install'),
  'service uninstall': service('service-uninstall', 'foreman service uninstall'),
  'service restart': serviceRestart,
  completion,
  help
}
