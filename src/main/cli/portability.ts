// Backup, share and import: the same service the Workspace menu uses. Moved here from cliServer.ts as it was.
import path from 'node:path'
import { tabListText } from '../../shared/tabs'
import type { ExportCliResult, ExportParams, ImportCliResult, ImportParams } from '../../cli/protocol'
import type { CliHost } from './host'
import { findWorkspace, resolveRepo } from './resolve'

/**
 * `foreman export`: a backup (encrypted with a passphrase) or, with --share, the chats you
 * name in the clear. A share lists what goes into the file so you can review it first.
 */
export async function exportCommand(host: CliHost, params: ExportParams): Promise<ExportCliResult> {
  const state = host.state()
  const ws = findWorkspace(state, params.workspace, params.cwd)
  const share = Boolean(params.share)
  if (!share && !params.passphrase) throw new Error('A backup is encrypted: give it a passphrase (it asks for one, or set FOREMAN_PASSPHRASE). Use --share for chats you have reviewed.')
  const info = await host.exportInfo(ws.id)
  let sessionIds: string[] | undefined
  if (share) {
    const open = state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
    if (params.chats?.length) {
      sessionIds = params.chats.map((c) => {
        const n = Number(c)
        const found = Number.isInteger(n) && n >= 1 ? open[n - 1] : state.sessions.find((s) => s.workspaceId === ws.id && s.id === c)
        if (!found) throw new Error(`${ws.name} has no chat “${c}”. Its open tabs:\n${tabListText(open)}`)
        return found.id
      })
    } else sessionIds = open.map((s) => s.id)
  }
  const out = path.resolve(params.cwd, params.out ?? `${ws.name.replace(/[^\w.-]+/g, '-')}.foreman`)
  const summary = await host.exportWorkspace(ws.id, {
    mode: share ? 'share' : 'backup',
    passphrase: params.passphrase,
    sessionIds,
    includeToolOutput: Boolean(params.toolOutput),
    includeAttachments: !params.noAttachments,
    includeWorktree: params.noBundle ? false : params.bundle ? true : undefined,
    outPath: out
  })
  const chats = info.chats.filter((c) => (sessionIds ? sessionIds.includes(c.id) : true)).map((c) => ({ id: c.id, title: c.title }))
  const lines = [`Exported ${ws.name} to ${summary.path} (${Math.max(1, Math.round(summary.bytes / 1024))} KB, ${summary.encrypted ? 'encrypted backup' : 'selected share, not encrypted'})`]
  if (share) {
    lines.push('Chats in this file (reviewed by you):', ...chats.map((c) => `  ${c.title}`), params.toolOutput ? 'Tool output is included.' : 'Tool output is left out.')
  }
  if (summary.worktree) lines.push(summary.worktree.message, ...summary.worktree.notes.map((n) => `  ${n.text}`))
  if (summary.variables) lines.push(`${summary.variables} variable names are listed; their values are never exported.`)
  return { workspace: { id: ws.id, name: ws.name }, path: summary.path, bytes: summary.bytes, mode: summary.mode, encrypted: summary.encrypted, exportId: summary.exportId, chats, attachments: summary.attachments, variables: summary.variables, message: lines.join('\n') }
}

/**
 * `foreman import`: stage the file in quarantine, then create a history-only workspace.
 * The repository is a choice: a suggestion is only taken with --yes (or named with --repo).
 */
export async function importCommand(host: CliHost, params: ImportParams): Promise<ImportCliResult> {
  const staged = await host.stageImport(path.resolve(params.cwd, params.file), params.passphrase)
  if (staged.kind === 'needs-passphrase') return { status: 'needs-passphrase' }
  const { preview } = staged
  try {
    const state = host.state()
    if (preview.duplicate && !params.copy) {
      throw new Error(`“${preview.workspace.name}” is already here as “${preview.duplicate.name}” (id ${preview.duplicate.workspaceId}). Open that one, or run again with --copy to import a copy with new ids.`)
    }
    let repoId: string
    if (params.repo?.trim()) repoId = (await resolveRepo(state, params.cwd, params.repo)).id
    else if (preview.suggested.length === 1 && params.yes) repoId = preview.suggested[0].repoId
    else {
      const hints = preview.suggested.length
        ? `Suggested: ${preview.suggested.map((o) => `${o.name} (${o.reasons.join(' and ')})`).join(', ')}. Run again with --repo <name>, or --yes to accept the suggestion.`
        : `No repository matches its remote or root commit. Pass --repo <name>. Repositories: ${state.repos.map((r) => r.name).join(', ') || 'none yet'}`
      throw new Error(`Which repository does “${preview.workspace.name}” belong to? ${hints}`)
    }
    const ws = await host.importStaged(preview.stageId, { repoId, asCopy: params.copy })
    const repo = state.repos.find((r) => r.id === repoId)
    const option = preview.repos.find((o) => o.repoId === repoId)
    const lines = [
      `Imported ${ws.name} from ${preview.sourceMachine} as history only (${preview.tabs.length} tab${preview.tabs.length === 1 ? '' : 's'}). No worktree was created.`,
      option?.branchExists ? `Branch ${ws.branch} exists here, so it can be activated from the app.` : `Branch ${ws.branch} isn’t in ${repo?.name ?? 'that repository'} here; it stays history only until it is.`
    ]
    if (ws.variablesToSet?.length) lines.push(`${ws.variablesToSet.length} variables to set: ${ws.variablesToSet.join(', ')}`)
    if (preview.missingAttachments.length) lines.push(`Missing attachments: ${preview.missingAttachments.join(', ')}`)
    return { status: 'imported', workspace: { id: ws.id, name: ws.name, branch: ws.branch }, repo: repo?.name ?? repoId, tabs: preview.tabs.length, variablesToSet: ws.variablesToSet ?? [], missingAttachments: preview.missingAttachments, message: lines.join('\n') }
  } catch (err) {
    await host.discardImport(preview.stageId).catch(() => undefined)
    throw err
  }
}
