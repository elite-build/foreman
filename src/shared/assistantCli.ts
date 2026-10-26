// What the assistant knows about the `foreman` command, taken from the tables the command itself is built
// from (settingsSchema, repoSettingsSchema, cliCommands) so the two can't disagree. Pure: no I/O.
import { FULL_REQUEST_ID_LENGTH } from './assistant'
import { commandName, displayNoun, visibleCommands, type CommandSpec } from './cliCommands'
import { describeRepoSpec, REPO_SETTINGS_SCHEMA, type RepoSettingSpec } from './repoSettingsSchema'
import { describeSpec, SETTINGS_SCHEMA, type SettingSpec } from './settingsSchema'
import type { SettingEntry } from './settingsRegistry'

const MAX_KEYS = 5

/** What a key takes, as it goes in a usage line: `<on|off>`, `<system|light|dark>`, `<integer 1-5>`. */
function takes(description: string): string {
  return `<${description.replace(/ \| /g, '|')}>`
}

function personal(spec: SettingSpec): string {
  return `foreman settings set ${spec.key} ${takes(describeSpec(spec))}`
}

function repository(spec: RepoSettingSpec): string {
  return `foreman repo settings set ${spec.key} ${takes(describeRepoSpec(spec).split('. ')[0])} --repo <name>`
}

/** The specs whose registry row this is. A row can have several (keep-awake has four keys). */
export function specsOfRow(registryId: string): { settings: SettingSpec[]; repository: RepoSettingSpec[] } {
  return {
    settings: SETTINGS_SCHEMA.filter((s) => s.registryId === registryId),
    repository: REPO_SETTINGS_SCHEMA.filter((s) => s.registryId === registryId)
  }
}

/** The `cli:` part of a search_settings line: the command that sets this row, or `none` when no command can. */
export function cliLine(entry: Pick<SettingEntry, 'id'>): string {
  const found = specsOfRow(entry.id)
  const lines = [...found.settings.map(personal), ...found.repository.map(repository)]
  if (!lines.length) return 'cli: none'
  const shown = lines.slice(0, MAX_KEYS).join('; ')
  return `cli: ${shown}${lines.length > MAX_KEYS ? `; …${lines.length - MAX_KEYS} more (foreman settings keys)` : ''}`
}

// ---- finding commands ----

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)

/** Spellings of a command's name: `workspace archive` is also `ws archive`. */
function nameWords(spec: CommandSpec): string[] {
  return words(`${spec.path.join(' ')} ${displayNoun(spec.path[0])}`)
}

/**
 * Visible commands that match a question, best first: every query word found in the command's name counts most,
 * then its summary, then its examples and arguments. At most `limit` (five).
 */
export function searchCommands(query: string, commands: CommandSpec[], limit = 5): CommandSpec[] {
  const terms = [...new Set(words(query))]
  if (!terms.length) return []
  const scored: { spec: CommandSpec; score: number; index: number }[] = []
  visibleCommands(commands).forEach((spec, index) => {
    const name = nameWords(spec)
    const summary = words(`${spec.summary} ${spec.usage}`)
    const rest = words([...(spec.examples ?? []), ...spec.args.map((a) => `${a.name} ${a.help}`), ...Object.keys(spec.options)].join(' '))
    let score = 0
    const hit = (list: string[], term: string) => list.some((w) => w === term || (term.length > 3 && w.startsWith(term)))
    for (const term of terms) {
      if (hit(name, term)) score += 4
      else if (hit(summary, term)) score += 2
      else if (hit(rest, term)) score += 1
    }
    if (score > 0) scored.push({ spec, score, index })
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((s) => s.spec)
}

/** Why the assistant may not run this command, in a sentence; undefined when it may. */
export function refusalFor(spec: CommandSpec): string | undefined {
  if (spec.hidden) return 'That command is internal.'
  if (spec.noAssistant) return `The assistant can't run \`foreman ${commandName(spec)}\`: ${spec.noAssistant}. Show the user the command so they can copy it into a terminal.`
  return undefined
}

// ---- answering what an agent waits on ----

const ANSWERS = new Set(['approve', 'deny'])

/** Whether this command answers a waiting request (`approve`, `deny`). */
export const answersRequest = (spec: CommandSpec): boolean => ANSWERS.has(commandName(spec))

/** What cli_help adds under `approve` and `deny`: the assistant proposes only the plain, one-shot form. */
export const ANSWER_NOTE = 'You may propose only a plain approve or deny, by the request’s full id from the approvals tool (never the start of it). `--always` and `--edits` give an agent standing permission, so the user presses those buttons on the approval panel; never propose them.'

/**
 * Why the assistant may not propose this `approve` or `deny`, in a sentence; undefined when it may. Only the plain one-shot
 * answer by full request id: `--always` and `--edits` stay on the approval panel's own buttons. `pending` is the ids waiting now
 * (when known), so a request that has already been answered is not proposed again.
 */
export function answerRefusal(spec: CommandSpec, opts: Record<string, unknown>, positionals: readonly string[], pending?: readonly string[]): string | undefined {
  if (!answersRequest(spec)) return undefined
  if (opts.always || opts.edits) {
    return `Only a plain one-shot ${commandName(spec)} may be proposed. --always and --edits give the agent standing permission, so the user presses those buttons on the approval panel themselves. Propose \`foreman approve <full id>\` without them, or tell the user which button to press.`
  }
  const id = positionals[0]?.trim()
  if (!id) return 'Name the request by its full id. Use the full id from approvals.'
  if (id.length < FULL_REQUEST_ID_LENGTH) return `“${id}” is not a full id. Use the full id from approvals: ${commandName(spec)} takes the whole request id (${FULL_REQUEST_ID_LENGTH} characters), never the start of it.`
  if (pending && !pending.includes(id)) return 'No request with that id is waiting any more; it may have been answered already. Call approvals to see what is waiting now.'
  return undefined
}
