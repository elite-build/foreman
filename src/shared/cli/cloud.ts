// Parameters and results of the remote-workspace methods. Each result has a
// `text` the command prints unless --json is given. `cloud token` is in settings (§6.5).
import type { CloudBuild, CloudPreflight, CloudStatus, CloudUsageView, SendDisposition } from '../types'

export interface CloudWorkspaceRef {
  id: string
  name: string
}

export interface CloudStatusParams {
  workspace?: string
  cwd?: string
}

export interface CloudRow {
  workspace: string
  id: string
  repo: string
  provider: string
  sandbox: string
  status: CloudStatus
  vcpus: number
  region: string
  // Minutes since the last turn, terminal or focus, and how long the repository lets it idle before it sleeps.
  idleMinutes?: number
  sleepsAfterMinutes?: number
  sessionExpiresAt?: string
  disconnected?: boolean
  error?: string
}

export interface CloudStatusResult {
  workspaces: CloudRow[]
  text: string
}

export interface CloudWorkspaceParams {
  workspace: string
  cwd?: string
}

export interface CloudActionResult {
  workspace: CloudWorkspaceRef
  verb: 'wake' | 'sleep' | 'restart' | 'reattach'
  status?: CloudStatus
  text: string
}

export interface CloudContinueParams extends CloudWorkspaceParams {
  tab?: number
}

export interface CloudContinueResult {
  workspace: CloudWorkspaceRef
  tab: number
  session: string
  turn?: string
  disposition: SendDisposition
  text: string
}

export interface CloudUsageResult {
  providers: CloudUsageView[]
  text: string
}

export interface CloudBuildParams {
  repo?: string
  cwd?: string
  wait?: boolean
}

export interface CloudBuildResult {
  repo: { id: string; name: string }
  provider: string
  build: CloudBuild
  // With --wait: how it ended. Without: still building.
  outcome: 'building' | 'active' | 'failed'
  text: string
}

export interface CloudPreflightParams {
  repo?: string
  cwd?: string
}

export interface CloudPreflightResult {
  repo: { id: string; name: string }
  preflight: CloudPreflight
  text: string
}

const MINUTE = 60_000

/** "12m", "1h 5m", "just now". */
export function idleText(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  return `${Math.floor(minutes / 60)}h${Math.floor(minutes % 60) ? ` ${Math.floor(minutes % 60)}m` : ''}`
}

export const minutesSince = (iso: string | undefined, now: number): number | undefined => (iso ? Math.max(0, (now - Date.parse(iso)) / MINUTE) : undefined)

export function cloudRowsText(rows: CloudRow[]): string {
  if (!rows.length) return 'No remote workspaces.'
  const cells = [['WORKSPACE', 'PROVIDER', 'STATE', 'SIZE', 'IDLE', 'NOTES']]
  for (const r of rows) {
    const notes = [r.disconnected ? 'disconnected: `foreman cloud reattach` picks the turn up again' : '', r.error ?? ''].filter(Boolean).join('; ')
    cells.push([r.workspace, r.provider, r.status, `${r.vcpus} vCPU${r.region ? ` · ${r.region}` : ''}`, r.idleMinutes === undefined ? '' : `${idleText(r.idleMinutes)}${r.sleepsAfterMinutes ? ` of ${r.sleepsAfterMinutes}m` : ''}`, notes])
  }
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...cells.map((c) => c[i].length)))
  return cells.map((c) => c.map((cell, i) => (i < 5 ? cell.padEnd(widths[i] + 2) : cell)).join('').trimEnd()).join('\n')
}

const hoursText = (ms: number): string => `${Math.round((ms / 3_600_000) * 10) / 10}h`

export function cloudUsageText(rows: CloudUsageView[], labelOf: (id: string) => string): string {
  if (!rows.length) return 'No remote provider is connected, and nothing has run this month.'
  return rows
    .map((r) => {
      const lines = [`${labelOf(r.provider)}${r.connectionName ? ` (${r.connectionName})` : ''}  ${r.usage.month}`]
      lines.push(`  running   ${r.running} (the plan allows ${r.limits.maxConcurrent} at once)`)
      lines.push(`  cpu       ${hoursText(r.usage.activeCpuMs)} active, ${r.usage.stops} stop${r.usage.stops === 1 ? '' : 's'}`)
      if (r.usage.memoryGbHours !== undefined) lines.push(`  memory    ${Math.round(r.usage.memoryGbHours * 10) / 10} GB-hours`)
      lines.push(`  a session ${r.capabilities.sessionCap ? `ends after ${Math.round(r.limits.maxSessionMs / MINUTE)} minutes` : 'has no time limit'}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export function preflightText(repoName: string, p: CloudPreflight): string {
  if (p.ok) return `A remote workspace can be made in ${repoName} now${p.provider ? ` (${p.provider.id})` : ''}.`
  const lines = [`A remote workspace can’t be made in ${repoName} now: ${p.message}`]
  if (p.running?.length) lines.push(`  running  ${p.running.map((r) => r.name).join(', ')}`)
  const hint = { limit: 'Sleep or archive one of those, or raise the limit in Repository settings → Remote.', unavailable: 'Check the provider’s connection (`foreman connections`).', disabled: 'Turn remote workspaces on in Settings → Remote workspaces.', 'no-build': 'Build the base first: `foreman cloud build`.' }[p.reason]
  lines.push(`  why      ${p.reason}: ${hint}`)
  return lines.join('\n')
}
