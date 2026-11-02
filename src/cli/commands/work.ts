// The commands that start, watch and steer work: run, wait, send, cancel, resume-at, checks, status,
// report, review, plus the two lists (templates, repos). The text and JSON they print, and the exit
// codes they end with, are what `foreman` has always given; only the plumbing around them is new.
import { isReportKind } from '../../shared/agentReports'
import { statusTable } from '../../shared/status'
import { CliError, usageError } from '../client'
import type { Context, Run } from '../command'
import { waitText } from '../format'
import { commaList } from './automationKit'
import type { ReposListResult } from '../../shared/cli/repos'
import type { AskResult } from '../../main/cli/ask'
import { CHECKS_EXIT, EXIT_DISCONNECTED, EXIT_SETUP_HELD, WAIT_EXIT, type CancelResult, type ChecksCliResult, type ReportParams, type ReportResult, type ResumeAtResult, type RunResult, type SendResult, type StatusResult, type TemplateSummary, type WaitResult } from '../protocol'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `--timeout <s>`: seconds, above zero. */
function timeoutOf(ctx: Context): number | undefined {
  const raw = str(ctx.opts.timeout)
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageError('--timeout takes a number of seconds')
  return seconds
}

const waitFor = (ctx: Context, turn: string, timeoutSec: number | undefined) => ctx.send<WaitResult>('wait', { turn, timeoutSec }, { waiting: true })

const templates: Run = async (ctx) => {
  const list = await ctx.send<TemplateSummary[]>('templates', { cwd: ctx.cwd })
  ctx.print(list, () => {
    const width = Math.max(0, ...list.map((t) => t.slug.length))
    return list.map((t) => `${t.slug.padEnd(width)}  ${t.placeholders.map((p) => `{{${p}}}`).join(' ')}${t.source === 'repo' ? '  (from repo)' : ''}`.trimEnd()).join('\n')
  })
}

// The richer listing (default branch, remote, account, remote workspaces); its rows start with name and path,
// so the first two columns, and the JSON's first two fields, are what `foreman repos` printed before.
const repos: Run = async (ctx) => {
  const result = await ctx.send<ReposListResult>('repos-list')
  ctx.print(result.repos, () => result.text)
}

/** `--words`: the narrator's sentences in place of the table. JSON is unchanged, so with --json the flag asks for nothing. */
const wordsWanted = (ctx: Context): boolean => ctx.opts.words === true && !ctx.json

const status: Run = async (ctx) => {
  if (wordsWanted(ctx)) {
    const said = await ctx.send<{ rows: StatusResult; text: string }>('status', { words: true })
    ctx.print(said.rows, () => said.text)
    return
  }
  const rows = await ctx.send<StatusResult>('status')
  ctx.print(rows, () => statusTable(rows))
}

/**
 * `foreman ask "<question>"`: the assistant's answer, then each command it proposed as a line to run by hand. It never
 * runs one. Exit codes: 0 answered, 2 timed out (the partial answer is printed), 3 the assistant isn't available.
 */
const ask: Run = async (ctx) => {
  const question = ctx.args.join(' ').trim()
  if (!question) throw usageError('Ask a question: foreman ask "what needs me?"')
  ctx.progress({ text: 'Asking Foreman…' })
  const result = await ctx.send<AskResult>('ask', { question, workspace: str(ctx.opts.workspace), cwd: ctx.cwd })
  if (result.held) {
    // Machine-readable output carries the reason in the object; otherwise it goes to stderr, like a held setup.
    if (ctx.json) console.log(JSON.stringify(result, null, 2))
    else console.error(`foreman: ${result.held}`)
    process.exitCode = EXIT_SETUP_HELD
    return
  }
  ctx.print(result, () => {
    const lines: string[] = []
    if (result.answer) lines.push(result.answer)
    for (const proposal of result.proposals) {
      if (lines.length) lines.push('')
      lines.push(`Proposed: ${proposal.summary || proposal.command}`, `Run it yourself: ${proposal.command}`)
    }
    return lines.join('\n') || 'Foreman had nothing to say to that.'
  })
  if (result.timedOut) {
    ctx.note('Foreman was still answering after two minutes; this is what it had so far.')
    process.exitCode = WAIT_EXIT.timeout
  }
}

/** `foreman report <kind> "<text>"` and `foreman review "<what>"` share the request. */
function reporter(review: boolean): Run {
  return async (ctx) => {
    const [kind, ...words] = review ? ['review', ...ctx.args] : ctx.args
    if (!review && !isReportKind(kind)) throw usageError('Say what kind of report: foreman report needs-input|stuck|checkpoint|done "<text>"')
    const text = words.join(' ').trim()
    if (!text && (kind === 'needs-input' || kind === 'stuck' || kind === 'review')) throw usageError(review ? 'Say what to check: foreman review "<what>"' : `Say it in a few words: foreman report ${kind} "<text>"`)
    const reported = await ctx.send<ReportResult>('report', { kind: kind as ReportParams['kind'], text, link: str(ctx.opts.link), cwd: ctx.cwd })
    ctx.print(reported, () => reported.message)
  }
}

const checks: Run = async (ctx) => {
  const result = await ctx.send<ChecksCliResult>('checks', { cwd: ctx.cwd })
  ctx.print(result, () => {
    const lines = result.results.map((r) => `${r.status === 'passed' ? 'pass' : r.status.padEnd(4)}  ${r.name}${r.exitCode ? ` (exit ${r.exitCode})` : ''}  ${r.logPath}`)
    const headline = { passed: 'Configured checks passed', failed: 'Checks failed', error: 'Checks did not complete', 'not-configured': 'No checks configured', busy: 'Busy' }[result.outcome]
    return [headline + (result.message ? `: ${result.message}` : ''), ...lines].join('\n')
  })
  process.exitCode = CHECKS_EXIT[result.outcome]
}

const wait: Run = async (ctx) => {
  const timeoutSec = timeoutOf(ctx)
  const [turn] = ctx.args
  if (!turn) throw usageError('Name a turn. `foreman run` prints its id.')
  const words = wordsWanted(ctx)
  const waited = await ctx.send<WaitResult & { words?: string }>('wait', { turn, timeoutSec, ...(words ? { words: true } : {}) }, { waiting: true })
  ctx.print(waited, () => (words && waited.words ? waited.words : waitText(waited, timeoutSec)))
  process.exitCode = WAIT_EXIT[waited.outcome]
}

const send: Run = async (ctx) => {
  const [workspace, ...args] = ctx.args
  if (!workspace) throw usageError('Name a workspace. `foreman status` lists them.')
  let tab: number | undefined
  if (ctx.opts.tab !== undefined) {
    tab = Number(ctx.opts.tab)
    if (!Number.isInteger(tab) || tab < 1) throw usageError('--tab takes a tab number, from 1')
  }
  const sent = await ctx.send<SendResult>('send', { workspace, tab, args, cwd: ctx.cwd })
  ctx.print(sent, () => sent.message)
}

const resumeAt: Run = async (ctx) => {
  const [turn] = ctx.args
  if (!turn) throw usageError('Name the turn that hit the usage limit. `foreman run` and `foreman send` print its id.')
  const armed = await ctx.send<ResumeAtResult>('resume-at', { turn, cancel: ctx.opts.cancel })
  ctx.print(armed, () => armed.message)
}

const cancel: Run = async (ctx) => {
  const [turn] = ctx.args
  if (!turn) throw usageError('Name a turn. `foreman run` and `foreman send` print its id.')
  const cancelled = await ctx.send<CancelResult>('cancel', { turn })
  ctx.print(cancelled, () => cancelled.message)
}

const run: Run = async (ctx) => {
  const { opts } = ctx
  const timeoutSec = timeoutOf(ctx)
  const [template, ...values] = ctx.args
  if (!template) throw usageError('Name a template. `foreman templates` lists them.')
  let loadout: number | undefined
  if (opts.loadout !== undefined) {
    loadout = Number(opts.loadout)
    if (!Number.isInteger(loadout) || loadout < 1) throw usageError('--loadout takes a slot number, from 1')
  }
  if (opts.wait && opts['no-wait']) throw usageError('--wait and --no-wait can’t be used together')
  if (opts.wait && opts['dry-run']) throw usageError('--wait has nothing to wait for with --dry-run')
  const result = await ctx.send<RunResult>('run', {
    template,
    values,
    cwd: ctx.cwd,
    repo: str(opts.repo),
    branch: str(opts.branch),
    base: str(opts.base),
    loadout,
    open: opts.open,
    dryRun: opts['dry-run'],
    startAnyway: opts['start-anyway'],
    noWait: opts['no-wait'],
    with: commaList(opts.with),
    without: commaList(opts.without)
  })
  const describe = () => {
    if (!result.workspace) return result.prompt
    let started = `Started ${result.workspace.name} in ${result.repo} with “${result.template}”\n  workspace  ${result.workspace.id}\n  branch     ${result.workspace.branch}\n  path       ${result.workspace.path}`
    if (result.session) started += `\n  session    ${result.session}`
    if (result.turn) started += `\n  turn       ${result.turn}`
    if (result.startedAnyway) started += '\n  setup failed; sent the first message anyway'
    return result.pullRequest ? `${started}\n  checked out  ${result.pullRequest.repo}#${result.pullRequest.number}` : started
  }
  // Scripts get one JSON document, at the end; people see the ids at once.
  const waiting = opts.wait && result.turn && !result.held
  if (!ctx.json || !waiting) ctx.print(result, describe)
  if (result.held) {
    // Machine-readable output already says so; otherwise explain on stderr.
    if (!ctx.json) {
      console.error(`\nSetup failed. The first message was held, not sent. Last lines of the setup log:\n\n${result.held.logTail}\n`)
      console.error('Open the workspace and choose Start anyway, or run again with --start-anyway.')
    }
    process.exitCode = EXIT_SETUP_HELD
  }
  if (opts.wait && !result.held && !result.turn) throw new CliError('The first message did not start a turn, so there is nothing to wait for.')
  if (waiting) {
    let waited: WaitResult
    try {
      waited = await waitFor(ctx, result.turn!, timeoutSec)
    } catch (err) {
      // The ids are what the caller needs to reattach.
      if (ctx.json && err instanceof CliError && err.exitCode === EXIT_DISCONNECTED) console.log(JSON.stringify({ ...result, outcome: 'disconnected' }, null, 2))
      throw err
    }
    if (ctx.json) console.log(JSON.stringify({ ...result, ...waited, workspace: result.workspace }, null, 2))
    else console.log(`\n${waitText(waited, timeoutSec)}`)
    process.exitCode = WAIT_EXIT[waited.outcome]
  }
}

export const workRunners: Record<string, Run> = {
  run,
  wait,
  send,
  cancel,
  'resume-at': resumeAt,
  checks,
  status,
  ask,
  report: reporter(false),
  review: reporter(true),
  templates,
  repos
}
