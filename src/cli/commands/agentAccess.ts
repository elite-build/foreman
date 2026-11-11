// `foreman agent-access status|pending|approve|deny|revoke`: agents on this computer signing in, from a terminal. Each
// sends a request and prints the answer's `text` (or the JSON with --json). `approve` asks for the code the sign-in's
// browser page shows at a prompt, and refuses without a terminal: an agent's shell tool has none, so it can't approve
// itself (docs/agent-access.md §6). There is no --code and no --yes.
import { AGENT_ACCESS_LEVELS } from '../../shared/agentAccess'
import type { AgentAccessPendingResult, AgentAccessPendingRow } from '../../shared/cli/agentAccess'
import { CliError, usageError } from '../client'
import type { Run } from '../command'
import { ERROR_EXIT } from '../protocol'
import { declinedNote, noMoreWords, optionalWord, printText, str } from './automationKit'
import { io } from './input'

const show =
  (method: string, usage: string): Run =>
  async (ctx) => {
    noMoreWords(ctx, 0, usage)
    printText(ctx, await ctx.send<{ text: string }>(method))
  }

const status: Run = async (ctx) => {
  optionalWord(ctx, 'status', 'agent-access')
  printText(ctx, await ctx.send<{ text: string }>('agent-access-status'))
}

const where = (p: AgentAccessPendingRow): string => `“${p.name}”, returning to ${p.redirect}`

/** With several sign-ins waiting and none named, the person picks one by its number. */
async function choose(rows: AgentAccessPendingRow[]): Promise<AgentAccessPendingRow> {
  if (rows.length === 1) return rows[0]
  const list = rows.map((p, i) => `  ${i + 1}. ${where(p)} (id ${p.id})`).join('\n')
  const answer = (await io.promptLine(`${rows.length} sign-ins are waiting:\n${list}\nWhich one? [1-${rows.length}] `)).trim()
  const n = Number(answer)
  if (!/^\d+$/.test(answer) || n < 1 || n > rows.length) throw usageError(`Answer with a number from 1 to ${rows.length}.`, 'Or name it: foreman agent-access approve <id>')
  return rows[n - 1]
}

const approve: Run = async (ctx) => {
  const usage = 'foreman agent-access approve [<id>] [--level read|ask|ask-except-edits|auto|never-ask]'
  noMoreWords(ctx, 1, usage)
  // Before anything is sent: a script or an agent's shell tool, with no terminal, never gets as far as the code.
  if (!io.stdinIsTTY()) {
    throw new CliError(
      'foreman agent-access approve asks for the code at a terminal, and there is none here.',
      ERROR_EXIT['needs-confirmation'],
      'needs-confirmation',
      'Run it yourself in a terminal, or approve the sign-in in Settings → Data & devices → Agents on this computer.'
    )
  }
  const level = str(ctx.opts.level)
  if (level !== undefined && !(AGENT_ACCESS_LEVELS as readonly string[]).includes(level)) throw usageError(`--level is one of ${AGENT_ACCESS_LEVELS.join(', ')}.`)
  const [named] = ctx.args
  const { pending } = await ctx.send<AgentAccessPendingResult>('agent-access-pending')
  if (!pending.length) throw new CliError('No sign-in is waiting.', ERROR_EXIT['not-found'], 'not-found', 'Start one from the agent: /mcp in Claude Code, or codex mcp login foreman.')
  // A named one is found by the app (an id, the start of one, or its name); otherwise the only one, or the one chosen.
  const target = named === undefined ? await choose(pending) : undefined
  if (target) ctx.note(`Approving ${where(target)}.`)
  const code = await io.promptLine('Type the code its browser page shows: ')
  if (!code.trim()) throw usageError('No code was typed; nothing was approved.')
  printText(ctx, await ctx.send<{ text: string }>('agent-access-approve', { id: target?.id ?? named, code, level }))
}

const deny: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman agent-access deny [<id>]')
  const [id] = ctx.args
  printText(ctx, await ctx.send<{ text: string }>('agent-access-deny', id === undefined ? undefined : { id }))
}

const revoke: Run = async (ctx) => {
  noMoreWords(ctx, 1, 'foreman agent-access revoke <id-or-name>')
  const [grant] = ctx.args
  if (!grant) throw usageError('Name a signed-in agent: its id or name (`foreman agent-access` lists them).')
  if (!(await ctx.confirm(`Revoke “${grant}”? Its next call is refused and what it queued is dropped.`))) return declinedNote(ctx, 'Nothing revoked.')
  printText(ctx, await ctx.send<{ text: string }>('agent-access-revoke', { grant }))
}

export const agentAccessRunners: Record<string, Run> = {
  'agent-access': status,
  'agent-access status': show('agent-access-status', 'foreman agent-access status'),
  'agent-access pending': show('agent-access-pending', 'foreman agent-access pending'),
  'agent-access approve': approve,
  'agent-access deny': deny,
  'agent-access revoke': revoke
}
