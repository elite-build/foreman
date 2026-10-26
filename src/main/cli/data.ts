// `foreman backup | git-backup | data | usage`: Settings → Data and Settings → Usage from the command line. The database
// backup, the Git backup of your configuration and its restore, and the usage report are the same service calls the window
// makes. A restore overwrites settings and templates, so it needs the user's confirmation after the preview; a remote's
// user name and password are never printed.
import type { GitBackupConfig, GitBackupPreview, GitBackupStatus } from '../../shared/gitBackup'
import type { BackupNowResult, BackupStatusResult, DataInfoResult, DeleteLegacyResult, GitBackupCategory, GitBackupNowResult, GitBackupPreviewResult, GitBackupRestoreCliResult, GitBackupStatusResult, UsageResult, UsageRowOut } from '../../shared/cli/data'
import type { DataInfo } from '../../shared/types'
import type { UsageFigures } from '../../shared/usageReport'
import type { CliHost } from './host'
import { columns, flagParam, invalid, numberParam, paramsObject, textList, textParam, type MethodDef } from './kit'
import { durationText, formatBytes, plural, redactUrl, utcText } from './refs'

// ---- the database backup ----

const backupNow: MethodDef = {
  tier: 'admin',
  async handle(host, _params, ctx): Promise<BackupNowResult> {
    ctx.progress('Backing up the database…')
    const r = await host.api.backupNow()
    return { ...r, text: `Backed up to ${r.path}${r.attachments ? ` with ${plural(r.attachments, 'attachment')}` : ''}${r.missingAttachments ? `; ${plural(r.missingAttachments, 'attachment')} could not be found` : ''}.` }
  }
}

function backupView(info: DataInfo): BackupStatusResult {
  const last = info.lastBackup ? `Last backup: ${utcText(info.lastBackup.at)}, ${info.lastBackup.path}` : 'No backup yet.'
  const legacy = info.legacy.files ? `\nLeft over from before the database: ${plural(info.legacy.files, 'file')} (${formatBytes(info.legacy.bytes)}); \`foreman data delete-legacy\` removes them.` : ''
  return {
    path: info.path,
    backupFolder: info.backupFolder,
    sizeBytes: info.sizeBytes,
    messages: info.messages,
    ...(info.lastBackup ? { lastBackup: info.lastBackup } : {}),
    legacy: info.legacy,
    text: `Database: ${info.path} (${formatBytes(info.sizeBytes)}, ${plural(info.messages, 'message')})\nBackups go to ${info.backupFolder}\n${last}${legacy}`
  }
}

const backupStatus: MethodDef = {
  tier: 'read',
  async handle(host): Promise<BackupStatusResult> {
    return backupView(await host.api.dataInfo())
  }
}

const dataInfo: MethodDef = {
  tier: 'read',
  async handle(host): Promise<DataInfoResult> {
    const info = await host.api.dataInfo()
    const view = backupView(info)
    const t = info.claudeTranscripts
    const m = info.migration
    const extra = [
      `Data folder: ${info.dataFolder}`,
      `Claude transcripts mirrored: ${plural(t.sessions, 'session')}${t.errors ? `, ${plural(t.errors, 'batch', 'batches')} failed to mirror` : ''}${t.partial ? `, ${t.partial} partial` : ''}`,
      ...(m ? [`Moved into the database ${utcText(m.at)} (${m.status})${m.malformed ? `; ${m.malformed} malformed lines skipped` : ''}${m.warnings.length ? `; ${plural(m.warnings.length, 'warning')}` : ''}`] : [])
    ]
    return { ...view, dataFolder: info.dataFolder, claudeTranscripts: t, ...(m ? { migration: { status: m.status, at: m.at, malformed: m.malformed, warnings: m.warnings } } : {}), text: `${view.text}\n${extra.join('\n')}` }
  }
}

const deleteLegacy: MethodDef = {
  tier: 'admin',
  async handle(host): Promise<DeleteLegacyResult> {
    const { legacy } = await host.api.dataInfo()
    if (!legacy.files) return { files: 0, bytes: 0, text: 'Nothing left over from before the database; there is nothing to delete.' }
    await host.api.deleteLegacyFiles()
    return { files: legacy.files, bytes: legacy.bytes, text: `Deleted ${plural(legacy.files, 'file')} (${formatBytes(legacy.bytes)}) left over from before the database.` }
  }
}

// ---- the Git backup of the configuration ----

function gitStatusView(status: GitBackupStatus): GitBackupStatusResult {
  const config = status.config
  const lines = config ? [`Remote: ${redactUrl(config.remoteUrl)}${config.account ? ` (as ${config.account})` : ''}`, `Daily: ${config.daily ? 'on' : 'off'}`] : ['Not set up. `foreman git-backup configure <remote>` or `create-repo <name>` starts it.']
  if (status.lastSuccessAt) lines.push(`Last backup: ${utcText(status.lastSuccessAt)}`)
  if (status.lastError) lines.push(`Last error: ${redactUrl(status.lastError)}${status.lastAttemptAt ? ` (${utcText(status.lastAttemptAt)})` : ''}`)
  return {
    configured: Boolean(config),
    ...(config ? { config: { remote: redactUrl(config.remoteUrl), ...(config.account ? { account: config.account } : {}), daily: config.daily } } : {}),
    ...(status.lastSuccessAt ? { lastSuccessAt: status.lastSuccessAt } : {}),
    ...(status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
    ...(status.lastError ? { lastError: redactUrl(status.lastError) } : {}),
    text: lines.join('\n')
  }
}

const gitBackupStatus: MethodDef = {
  tier: 'read',
  async handle(host): Promise<GitBackupStatusResult> {
    return gitStatusView(await host.api.gitBackupStatus())
  }
}

const gitBackupConfigure: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<GitBackupStatusResult> {
    const p = paramsObject(params)
    const remote = textParam(p, 'remote').trim()
    if (!remote) throw invalid('Give the remote: a Git URL.')
    const account = textParam(p, 'account', { optional: true })?.trim()
    const dailyGiven = p.daily
    if (dailyGiven !== undefined && dailyGiven !== null && typeof dailyGiven !== 'boolean') throw invalid('daily must be true or false.')
    const daily = typeof dailyGiven === 'boolean' ? dailyGiven : ((await host.api.gitBackupStatus()).config?.daily ?? false)
    const config: GitBackupConfig = { remoteUrl: remote, ...(account ? { account } : {}), daily }
    const view = gitStatusView(await host.api.configureGitBackup(config))
    return { ...view, text: `Saved.\n${view.text}` }
  }
}

const gitBackupCreateRepo: MethodDef = {
  tier: 'admin',
  async handle(host, params, ctx): Promise<GitBackupStatusResult> {
    const p = paramsObject(params)
    const name = textParam(p, 'name').trim()
    if (!name) throw invalid('Name the new private GitHub repository.')
    ctx.progress(`Creating ${name} on GitHub…`)
    const account = textParam(p, 'account', { optional: true })?.trim()
    const view = gitStatusView(await host.api.createGitBackupGithubRepo(name, account || undefined))
    return { ...view, text: `Created the private repository and set it up.\n${view.text}` }
  }
}

const gitBackupNow: MethodDef = {
  tier: 'admin',
  async handle(host, _params, ctx): Promise<GitBackupNowResult> {
    ctx.progress('Pushing the backup…')
    const r = await host.api.gitBackupNow()
    const remote = redactUrl(r.remoteUrl)
    return { changed: r.changed, at: r.at, remote, text: r.changed ? `Backed up to ${remote} (${utcText(r.at)}).` : `Nothing changed since the last backup to ${remote}.` }
  }
}

function previewView(r: GitBackupPreview): GitBackupPreviewResult {
  const count = (action: string) => r.templates.filter((t) => t.action === action).length
  const lines = [
    `Backup made ${utcText(r.createdAt)}`,
    `Settings that differ here: ${r.settingsChanged.length ? r.settingsChanged.join(', ') : 'none'}`,
    `Templates: ${count('add')} new, ${count('update')} changed, ${count('same')} the same`,
    `Repositories: ${r.repositories.length ? r.repositories.map((x) => `${x.name}${x.suggestedPath ? ` → ${x.suggestedPath}${x.matchedRepoId ? ' (already added)' : ''}` : ' (no folder here)'}`).join('; ') : 'none'}`,
    `Workspaces: ${r.workspaces.length ? r.workspaces.map((x) => `${x.name}${x.alreadyAdded ? ' (already here)' : x.suggestedPath ? '' : ' (no folder here)'}`).join('; ') : 'none'}`
  ]
  const missingPaths = r.machinePaths.filter((m) => !m.available)
  if (missingPaths.length) lines.push(`Paths that don’t exist on this computer (skipped): ${missingPaths.map((m) => m.key).join(', ')}`)
  const missingVars = r.variableChecklist.filter((v) => !v.present)
  if (missingVars.length) lines.push(`Environment variables to set again (values are never backed up): ${missingVars.map((v) => `${v.name} (${v.scope})`).join(', ')}`)
  if (r.unavailableAccounts.length) lines.push(`GitHub accounts not signed in here: ${r.unavailableAccounts.join(', ')}`)
  return {
    stageId: r.stageId,
    createdAt: r.createdAt,
    settingsChanged: r.settingsChanged,
    templates: r.templates,
    repositories: r.repositories.map((x) => ({ name: x.name, ...(x.suggestedPath ? { folder: x.suggestedPath } : {}), matched: Boolean(x.matchedRepoId) })),
    workspaces: r.workspaces.map((x) => ({ name: x.name, branch: x.branch, alreadyAdded: x.alreadyAdded, ...(x.suggestedPath ? { folder: x.suggestedPath } : {}) })),
    machinePaths: r.machinePaths,
    variableChecklist: r.variableChecklist,
    unavailableAccounts: r.unavailableAccounts,
    text: lines.join('\n')
  }
}

function remoteOf(p: Record<string, unknown>): { remote: string; account?: string } {
  const remote = textParam(p, 'remote').trim()
  if (!remote) throw invalid('Give the remote: a Git URL.')
  const account = textParam(p, 'account', { optional: true })?.trim()
  return { remote, ...(account ? { account } : {}) }
}

const gitBackupPreview: MethodDef = {
  tier: 'admin',
  async handle(host, params, ctx): Promise<GitBackupPreviewResult> {
    const { remote, account } = remoteOf(paramsObject(params))
    ctx.progress('Fetching the backup…')
    return previewView(await host.api.previewGitBackup(remote, account))
  }
}

const CATEGORY_NAMES: Record<string, GitBackupCategory> = { settings: 'settings', templates: 'templates', repos: 'repositories', repositories: 'repositories', workspaces: 'workspaces' }

const gitBackupRestore: MethodDef = {
  tier: 'admin',
  async handle(host, params, ctx): Promise<GitBackupRestoreCliResult> {
    const p = paramsObject(params)
    const { remote, account } = remoteOf(p)
    const names = textList(p, 'categories', { optional: true }) ?? []
    const picked = new Set<GitBackupCategory>()
    for (const name of names.flatMap((n) => n.split(',')).map((n) => n.trim().toLowerCase()).filter(Boolean)) {
      const category = CATEGORY_NAMES[name]
      if (!category) throw invalid(`Unknown category “${name}”. Categories: settings, templates, repos, workspaces.`)
      picked.add(category)
    }
    const categories = picked.size ? picked : new Set<GitBackupCategory>(['settings', 'templates', 'repositories', 'workspaces'])
    const stageId = textParam(p, 'stageId', { optional: true })
    if (!flagParam(p, 'confirmed')) {
      ctx.progress('Fetching the backup…')
      const preview = previewView(await host.api.previewGitBackup(remote, account))
      return { restored: false, needsConfirmation: true, preview, text: `${preview.text}\n\nRestoring ${[...categories].join(', ')} overwrites those on this computer. Nothing is restored yet.` }
    }
    let id = stageId
    if (!id) {
      ctx.progress('Fetching the backup…')
      id = (await host.api.previewGitBackup(remote, account)).stageId
    }
    ctx.progress('Restoring…')
    const result = await host.api.restoreGitBackup({
      stageId: id,
      categories: { settings: categories.has('settings'), templates: categories.has('templates'), repositories: categories.has('repositories'), workspaces: categories.has('workspaces') },
      repositoryPaths: {},
      workspacePaths: {}
    })
    const lines = [`Restored ${plural(result.settings, 'setting')}, ${plural(result.templates, 'template')}, ${plural(result.repositories, 'repository', 'repositories')} and ${plural(result.workspaces, 'workspace')}.`]
    if (result.skipped.length) lines.push(`Skipped:`, ...result.skipped.map((s) => `  ${s}`))
    return { restored: true, result, text: lines.join('\n') }
  }
}

// ---- usage ----

const money = (f: UsageRowOut): string => (f.costUsd === null ? '—' : `${f.partial ? '≥ ' : ''}$${f.costUsd.toFixed(2)}`)

function figures(name: string, f: UsageFigures): UsageRowOut {
  return { name, turns: f.turns, agentMs: f.agentMs, costUsd: f.costUsd, partial: f.partial }
}

const usage: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<UsageResult> {
    const p = paramsObject(params)
    const days = numberParam(p, 'days') ?? 30
    if (!Number.isInteger(days) || days < 1 || days > 366) throw invalid('days is a whole number from 1 to 366 (the window offers 7, 30 and 90).')
    const report = await host.api.usageReport(days)
    const repos = host.state().repos
    const byRepo = report.byRepo.map((r) => figures(repos.find((x) => x.id === r.repoId)?.name ?? r.repoId, r))
    const byModel = report.byModel.map((m) => ({ ...figures(`${m.agent} ${m.model}`, m), agent: m.agent, model: m.model }))
    const total = figures('total', report.total)
    const table = (rows: UsageRowOut[]) => columns([['', 'TURNS', 'AGENT TIME', 'COST'], ...rows.map((r) => [r.name, String(r.turns), durationText(r.agentMs), money(r)])]).map((l) => `  ${l}`).join('\n')
    const partial = report.total.costUnknownTurns ? `\n${plural(report.total.costUnknownTurns, 'turn')} had no cost reported, so costs are a lower bound.` : ''
    const text = [`The last ${plural(days, 'day')}: ${plural(total.turns, 'turn')}, ${durationText(total.agentMs)} of agent time, ${money(total)}`, byRepo.length ? `By repository\n${table(byRepo)}` : '', byModel.length ? `By model\n${table(byModel)}` : ''].filter(Boolean).join('\n\n')
    return { days: report.days, since: report.since, total, byRepo, byModel, text: text + partial }
  }
}

export const DATA_METHODS: Record<string, MethodDef> = {
  'backup-now': backupNow,
  'backup-status': backupStatus,
  'git-backup-status': gitBackupStatus,
  'git-backup-configure': gitBackupConfigure,
  'git-backup-create-repo': gitBackupCreateRepo,
  'git-backup-now': gitBackupNow,
  'git-backup-preview': gitBackupPreview,
  'git-backup-restore': gitBackupRestore,
  'data-info': dataInfo,
  'data-delete-legacy': deleteLegacy,
  usage
}
