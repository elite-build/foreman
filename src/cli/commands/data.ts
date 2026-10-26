// `foreman backup | git-backup | data | usage`: Settings → Data and Usage. A Git backup restore overwrites settings and
// templates, so it shows what the backup would change, asks, and restores exactly the preview it showed (by its stage id).
// Deleting the files left from before the database says how many there are first.
import type { BackupStatusResult, DataInfoResult, GitBackupRestoreCliResult } from '../../shared/cli/data'
import { usageError } from '../client'
import type { Run } from '../command'
import { commaList, declinedNote, noMoreWords, optionalWord, previewAndAsk, printText, str, wholeOption } from './automationKit'
import { unknownVerb } from './input'

const backup: Run = async (ctx) => {
  const [verb = 'status', ...extra] = ctx.args
  if (verb !== 'status' && verb !== 'now') throw unknownVerb('backup', verb, ['now', 'status'])
  if (extra.length) throw usageError(`foreman backup ${verb} takes no more words.`)
  printText(ctx, await ctx.send<BackupStatusResult>(verb === 'now' ? 'backup-now' : 'backup-status'))
}

const GIT_VERBS = ['status', 'configure', 'create-repo', 'now', 'preview', 'restore']

const gitBackup: Run = async (ctx) => {
  const [verb = 'status', target, ...extra] = ctx.args
  if (!GIT_VERBS.includes(verb)) throw unknownVerb('git-backup', verb, ['status', 'configure <remote>', 'create-repo <name>', 'now', 'preview <remote>', 'restore <remote>'])
  if (extra.length) throw usageError(`foreman git-backup ${verb} takes one word after it.`)
  const needsTarget = verb !== 'status' && verb !== 'now'
  if (needsTarget && !target) throw usageError(verb === 'create-repo' ? 'Name the new private repository: foreman git-backup create-repo <name>' : `Give the remote (a Git URL): foreman git-backup ${verb} <remote>`)
  if (!needsTarget && target !== undefined) throw usageError(`foreman git-backup ${verb} takes no more words.`)
  if ((ctx.opts.daily || ctx.opts['no-daily']) && verb !== 'configure') throw usageError('--daily and --no-daily go with `git-backup configure`.')
  if (ctx.opts.daily && ctx.opts['no-daily']) throw usageError('--daily and --no-daily can’t be used together.')
  if (ctx.opts.categories !== undefined && verb !== 'restore') throw usageError('--categories goes with `git-backup restore`.')
  if (ctx.opts.account !== undefined && !needsTarget) throw usageError(`--account doesn’t go with \`git-backup ${verb}\`.`)
  const account = str(ctx.opts.account)

  switch (verb) {
    case 'status':
      return printText(ctx, await ctx.send<{ text: string }>('git-backup-status'))
    case 'now':
      return printText(ctx, await ctx.send<{ text: string }>('git-backup-now'))
    case 'configure':
      return printText(ctx, await ctx.send<{ text: string }>('git-backup-configure', { remote: target, account, daily: ctx.opts.daily ? true : ctx.opts['no-daily'] ? false : undefined }))
    case 'create-repo':
      return printText(ctx, await ctx.send<{ text: string }>('git-backup-create-repo', { name: target, account }))
    case 'preview':
      return printText(ctx, await ctx.send<{ text: string }>('git-backup-preview', { remote: target, account }))
  }
  // restore: the preview, then the answer, then exactly that preview.
  const params = { remote: target, account, categories: commaList(ctx.opts.categories) }
  const first = await ctx.send<GitBackupRestoreCliResult>('git-backup-restore', params)
  if (first.restored || !first.needsConfirmation) return printText(ctx, first)
  if (!(await previewAndAsk(ctx, first.text, 'Restore this backup over this computer’s settings and templates?', first))) return declinedNote(ctx, 'Nothing restored.')
  printText(ctx, await ctx.send<GitBackupRestoreCliResult>('git-backup-restore', { ...params, ...(first.preview ? { stageId: first.preview.stageId } : {}), confirmed: true }))
}

const data: Run = async (ctx) => {
  optionalWord(ctx, 'info', 'data')
  printText(ctx, await ctx.send<DataInfoResult>('data-info'))
}

const mb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`)

const deleteLegacy: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman data delete-legacy [--yes]')
  const { legacy } = await ctx.send<DataInfoResult>('data-info')
  if (legacy.files) {
    if (!(await ctx.confirm(`Delete ${legacy.files} ${legacy.files === 1 ? 'file' : 'files'} (${mb(legacy.bytes)}) left over from before the database? This can’t be undone.`))) return declinedNote(ctx, 'Nothing deleted.')
  }
  printText(ctx, await ctx.send<{ text: string }>('data-delete-legacy'))
}

const usage: Run = async (ctx) => {
  noMoreWords(ctx, 0, 'foreman usage [--days 7|30|90]')
  const days = wholeOption(ctx.opts.days, '--days')
  if (days !== undefined && days > 366) throw usageError('--days is a whole number from 1 to 366 (7, 30 and 90 are the usual).')
  printText(ctx, await ctx.send<{ text: string }>('usage', { days }))
}

export const dataRunners: Record<string, Run> = {
  backup,
  'git-backup': gitBackup,
  data,
  'data delete-legacy': deleteLegacy,
  usage
}

/** Hands each command's function to the registry (`register('git-backup', run)`). */
export function registerDataCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(dataRunners)) register(name, run)
}
