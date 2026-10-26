// The commands about the app and the command itself: app info, doctor, cli status, cli install,
// completion and help.
import { usageError } from '../client'
import type { Context, Run } from '../command'
import { completionScript, SHELLS } from '../completion'
import { helpFor } from '../help'
import { columns } from '../output'
import { CLI_PROTOCOL_VERSION, type AppInfoResult, type DoctorResult } from '../protocol'
import { CLI_VERSION } from '../version'
import type { CliInstallStatus } from '../../shared/types'

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
  doctor,
  'cli status': cliStatus,
  'cli install': cliInstall,
  completion,
  help
}
