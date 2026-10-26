// export and import: the same service the Workspace menu uses.
import { CliError, usageError } from '../client'
import type { Run } from '../command'
import { readPassphrase } from '../prompt'
import type { ExportCliResult, ImportCliResult } from '../protocol'

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const exportRun: Run = async (ctx) => {
  const { opts } = ctx
  const [workspace] = ctx.args
  if (!workspace) throw usageError('Name a workspace. `foreman status` lists them.')
  let passphrase: string | undefined
  if (!opts.share) {
    passphrase = await readPassphrase('Passphrase for the backup: ')
    if (!process.env.FOREMAN_PASSPHRASE && passphrase !== (await readPassphrase('Again: '))) throw new CliError('The passphrases differ.')
  }
  const exported = await ctx.send<ExportCliResult>('export', {
    workspace,
    cwd: ctx.cwd,
    out: str(opts.out),
    share: opts.share,
    passphrase,
    chats: opts.chat,
    toolOutput: opts['tool-output'],
    noAttachments: opts['no-attachments'],
    bundle: opts.bundle,
    noBundle: opts['no-bundle']
  })
  ctx.print(exported, () => exported.message)
}

const importRun: Run = async (ctx) => {
  const { opts } = ctx
  const [file] = ctx.args
  if (!file) throw usageError('Name a .foreman file.')
  const params = { file, cwd: ctx.cwd, repo: str(opts.repo), copy: opts.copy, yes: opts.yes }
  let imported = await ctx.send<ImportCliResult>('import', params)
  if (imported.status === 'needs-passphrase') {
    const passphrase = await readPassphrase('Passphrase for this backup: ')
    imported = await ctx.send<ImportCliResult>('import', { ...params, passphrase })
  }
  if (imported.status === 'needs-passphrase') throw new CliError('That passphrase did not open the backup.')
  const done = imported
  ctx.print(done, () => done.message)
}

export const portabilityRunners: Record<string, Run> = { export: exportRun, import: importRun }
