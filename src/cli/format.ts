// How the command line words a turn's outcome.
import { durationText } from '../shared/checks'
import type { WaitResult } from './protocol'

export function waitText(r: WaitResult, timeoutSec?: number): string {
  if (r.outcome === 'timeout') {
    return `Still going after ${timeoutSec ?? '?'}s: turn ${r.turn} in ${r.workspace.name}. It keeps running; \`foreman wait ${r.turn}\` picks it up again.`
  }
  const verb = { completed: 'completed', error: 'failed', cancelled: 'was stopped', interrupted: 'was interrupted' }[r.outcome]
  const lines = [`Turn ${r.turn} ${verb} in ${r.workspace.name}${r.durationMs !== undefined ? ` (${durationText(r.durationMs)})` : ''}`]
  if (r.error) lines.push(`  error    ${r.error}`)
  if (r.delta) lines.push(`  changed  +${r.delta.additions} -${r.delta.deletions} in ${r.delta.files.length} ${r.delta.files.length === 1 ? 'file' : 'files'}`)
  lines.push(`  checks   ${r.checks}`)
  if (r.pr) lines.push(`  PR       #${r.pr.number}${r.pr.state ? ` ${r.pr.state.toLowerCase()}` : ''}${r.pr.url ? `  ${r.pr.url}` : ''}`)
  return lines.join('\n')
}
