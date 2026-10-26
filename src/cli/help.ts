// `foreman help`, `foreman help <command>`, `foreman <command> --help` and the help topics, all rendered
// from the command table in src/shared/cliCommands.ts so the text can't drift from what the commands accept.
import { ALIASES, COMMANDS, COMMON_OPTIONS, GROUP_LABELS, GROUP_ORDER, commandName, displayNoun, findCommand, suggestCommands, visibleCommands, type CommandSpec, type OptionSpec } from '../shared/cliCommands'
import { CLI_VERSION } from './version'

// Rows of `foreman help` wrap here, at a comma, so they stay readable in a narrow terminal.
const WIDTH = 100
// A noun with more verbs than this is shown as a count in the overview.
const COMPACT_AT = 8
const LABEL = 15

/**
 * The entries of one group's row in `foreman help`: a command on its own, or `noun verb|verb|…` when
 * several commands share a first word. Exported for the test that every command is listed.
 */
export function groupEntries(group: CommandSpec['group'], commands: CommandSpec[] = COMMANDS): string[] {
  const entries: string[] = []
  const nouns = new Map<string, string[]>()
  const inGroup = visibleCommands(commands).filter((c) => c.group === group)
  // A noun with a command of its own (`foreman settings`, `foreman env`) prints its verbs itself, so the
  // overview names it once; a noun without one (`ws`) shows its verbs here.
  const bare = new Set(inGroup.filter((c) => c.path.length === 1).map((c) => c.path[0]))
  for (const spec of inGroup) {
    if (spec.path.length === 1) entries.push(spec.path[0])
    else if (bare.has(spec.path[0])) continue
    else {
      const [noun, ...verb] = spec.path
      if (!nouns.has(noun)) {
        nouns.set(noun, [])
        entries.push(`\u0000${noun}`)
      }
      nouns.get(noun)!.push(verb.join(' '))
    }
  }
  // A noun with many verbs and no command of its own (ws, git, repo) is one entry with a count; its verbs are
  // a `foreman help <noun>` away, and the row stays readable.
  return entries.map((e) => {
    if (!e.startsWith('\u0000')) return e
    const noun = displayNoun(e.slice(1))
    const verbs = nouns.get(e.slice(1))!
    return verbs.length > COMPACT_AT ? `${noun} (${verbs.length} commands: foreman help ${noun})` : `${noun} ${verbs.join('|')}`
  })
}

function wrapRow(label: string, entries: string[]): string {
  const lines: string[] = []
  let line = ''
  entries.forEach((entry, i) => {
    const piece = i < entries.length - 1 ? `${entry}, ` : entry
    if (line && label.length + line.length + piece.length > WIDTH) {
      lines.push(line.trimEnd())
      line = ''
    }
    line += piece
  })
  lines.push(line.trimEnd())
  return lines.map((l, i) => (i === 0 ? label : ' '.repeat(LABEL)) + l).join('\n')
}

// Topics are registered by name so another part of the CLI (the settings keys, once they exist) can add its own.
const topics = new Map<string, () => string>()

/** Add or replace a help topic: `foreman help <name>` prints what `render` returns. */
export function registerTopic(name: string, render: () => string): void {
  topics.set(name, render)
}

export function topicNames(): string[] {
  return [...topics.keys()]
}

export function renderTopic(name: string): string | undefined {
  return topics.get(name)?.()
}

/** `foreman help`: the groups of commands, one row each. */
export function renderHelp(commands: CommandSpec[] = COMMANDS): string {
  const rows = GROUP_ORDER.map((group) => ({ group, entries: groupEntries(group, commands) }))
    .filter((r) => r.entries.length)
    .map((r) => wrapRow(GROUP_LABELS[r.group].padEnd(LABEL), r.entries))
  const lines = [
    `foreman ${CLI_VERSION} · drives the running Foreman app`,
    '',
    ...rows,
    '',
    `foreman help <command>   options, examples and exit codes       foreman help ${topicNames().join(' | ')}`,
    'Every command takes --json. Inside an agent turn, foreman report and foreman review are the commands to know.',
    'foreman --version prints the command’s version and the running app’s.'
  ]
  return lines.join('\n')
}

function optionLabel(name: string, spec: OptionSpec): string {
  return `${spec.short ? `-${spec.short}, ` : '    '}--${name}${spec.value ? ` ${spec.value}` : ''}`
}

function optionHelp(spec: OptionSpec): string {
  let text = spec.help
  if (spec.choices) text += ` (one of: ${spec.choices.join(', ')})`
  if (spec.multiple) text += ' (repeatable)'
  if (spec.default) text += ` (default: ${spec.default})`
  return text
}

function table(rows: [string, string][], width: number): string[] {
  return rows.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`.trimEnd())
}

/** Everything about one command: usage, positionals, options, examples, exit codes, then the long description. */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [spec.summary, '', 'Usage:', `  ${spec.usage}`]
  const own = Object.entries(spec.options)
  const common = Object.entries(COMMON_OPTIONS)
  const argLabel = (a: CommandSpec['args'][number]) => `<${a.name}${a.rest ? '...' : ''}>`
  const width = Math.max(0, ...spec.args.map((a) => argLabel(a).length), ...[...own, ...common].map(([n, o]) => optionLabel(n, o).length))
  if (spec.args.length) {
    lines.push('', 'Arguments:', ...table(spec.args.map((a) => [argLabel(a), `${a.help}${a.choices ? ` (one of: ${a.choices.join(', ')})` : ''}${a.required ? '' : ' (optional)'}`]), width))
  }
  if (own.length) lines.push('', 'Options:', ...table(own.map(([n, o]) => [optionLabel(n, o), optionHelp(o)]), width))
  lines.push('', 'Common options:', ...table(common.map(([n, o]) => [optionLabel(n, o), optionHelp(o)]), width))
  if (spec.examples?.length) lines.push('', 'Examples:', ...spec.examples.map((e) => `  ${e}`))
  if (spec.exitCodes) {
    lines.push('', 'Exit codes:', ...Object.entries(spec.exitCodes).map(([code, meaning]) => `  ${code}  ${meaning}`), '  Every code: foreman help exit-codes')
  }
  if (spec.details) lines.push('', spec.details)
  return lines.join('\n')
}

/** `foreman help cli`: a noun with several verbs lists them. */
export function renderGroupHelp(noun: string, commands: CommandSpec[] = COMMANDS): string {
  const specs = visibleCommands(commands).filter((c) => c.path.length > 1 && c.path[0] === noun)
  const width = Math.max(...specs.map((c) => commandName(c).length))
  return [`foreman ${noun}`, '', 'Commands:', ...table(specs.map((c) => [commandName(c), c.summary]), width), '', `foreman help ${noun} <command> shows one in full.`].join('\n')
}

export type HelpAnswer = { text: string } | { error: string; suggestions: string[] }

/** The help for what `foreman help <words…>` was asked: nothing (the overview), a command, a noun or a topic. */
export function helpFor(words: string[], commands: CommandSpec[] = COMMANDS): HelpAnswer {
  if (!words.length) return { text: renderHelp(commands) }
  // `foreman help ws` means the workspace noun, as `foreman ws …` does.
  if (words[0] in ALIASES) words = [...ALIASES[words[0]], ...words.slice(1)]
  const found = findCommand(words, commands)
  if ('spec' in found && !found.spec.hidden) return { text: renderCommandHelp(found.spec) }
  if (words.length === 1) {
    const topic = renderTopic(words[0])
    if (topic !== undefined) return { text: topic }
    if (visibleCommands(commands).some((c) => c.path.length > 1 && c.path[0] === words[0])) return { text: renderGroupHelp(words[0], commands) }
  }
  if ('error' in found) return { error: `No help for “${words.join(' ')}”`, suggestions: found.suggestions.length ? found.suggestions : suggestCommands(words, commands) }
  return { error: `No help for “${words.join(' ')}”`, suggestions: [] }
}

registerTopic(
  'exit-codes',
  () => `Exit codes, the same for every command:

  0  Done (wait: the turn completed; checks: they passed)
  1  Failed; or the turn failed, was stopped or was interrupted; or a check failed
  2  Usage error (unknown command or option, a bad value); or wait timed out; or checks errored
  3  Setup held (run); or checks are not configured
  4  Busy (checks while an agent turn is active)
  5  Foreman isn't running, or the connection to it dropped
  6  Needs confirmation or consent (--yes is missing, or what you were shown has changed)
  7  Refused by policy (a turn token on a command that changes setup, or agents may not start work)
  8  Not found or ambiguous (workspace, repository, tab, template…)

wait's 2 and checks' 2 and 3 overlap with usage errors by history; their own help says which is
which, and the JSON they print says it in words. A command that fails with --json also writes one
JSON object to stderr: {"error": "…", "code": "not-found"}, where code is one of not-running,
unknown-method, invalid, not-found, ambiguous, refused, busy, needs-confirmation, needs-consent,
not-supported or failed.

Earlier versions of foreman gave 1 for every failure. Any non-zero code is still a failure.`
)

registerTopic(
  'agents',
  () => `Agents and the foreman command

Inside an agent turn Foreman sets FOREMAN_SESSION_ID, FOREMAN_TURN_ID and FOREMAN_TURN_TOKEN. Every
foreman command run there carries them, so a report lands on that tab and turn. The token is
attribution, not a security boundary: an agent can leave it out, and the app says so when a call
comes without one.

What an agent may call
  foreman report needs-input|stuck|checkpoint|done "<text>"   tell the user how the work is going
  foreman review "<what to check>"                            ask for a review (a row on Home)
  foreman checks                                              run the repository's configured checks
  foreman status, templates, repos, wait, cancel              read and manage turns (a turn can't wait for itself)
  foreman run, send, resume-at                                only with the repository's opt-in (below)

Starting work needs the user's say-so: Repository settings → Actions → "Let agents start workspaces and queue messages"
must be on for the repository the agent works in.

What an agent may not do
  Anything that changes how Foreman is set up or moves data out of it (export, import, cli install, and
  settings as they arrive) is refused with exit code 7: "Settings can't be changed from inside an agent turn."

Repository settings → Actions → "Teach agents Foreman" adds these instructions to the agent's own.`
)

registerTopic('settings-keys', () => 'The settings keys come from the settings schema, and `foreman settings` arrives with it. This topic will list every key with its type, accepted values and default.')

registerTopic(
  'environment',
  () => `Environment variables the foreman command reads

  FOREMAN_DATA_DIR      The app's data folder (where cli.sock and cli.token live). Default: the app's own folder.
  FOREMAN_PASSPHRASE    The passphrase for export and import, so a script needn't type it.
  FOREMAN_SESSION_ID    Set by Foreman inside an agent turn: the chat the call comes from.
  FOREMAN_TURN_ID       Set by Foreman inside an agent turn: the turn.
  FOREMAN_TURN_TOKEN    Set by Foreman inside an agent turn: proves the two above. Don't set it yourself.
  FOREMAN_JSON=1        Same as --json on every command.
  NO_COLOR              Respected; the output is plain text already.`
)

