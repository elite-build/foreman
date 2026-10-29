// The declarative half of every `foreman` command: name, group, summary, usage, positionals, options,
// examples, exit codes, long description and tier. No `run` lives here (src/cli/commands/* attaches
// those), so the app's main process can read the table without pulling in the command line. The
// help, the completion scripts and the tests are all generated from it: adding a command is one entry
// here and one function there.

import { APPROVAL_COMMANDS, TAB_COMMANDS, WORKSPACE_COMMANDS } from './cliCommandsOps'
import { AUTOMATION_COMMANDS } from './cliCommandsAutomations'
import { CLOUD_COMMANDS, GIT_COMMANDS, REPO_OPS_COMMANDS, WORDS_OPTION } from './cliCommandsGit'
import { ENV_COMMANDS, REPO_SETTINGS_COMMANDS, SETTINGS_COMMANDS } from './cliCommandsSettings'

export type CommandGroup = 'work' | 'workspaces' | 'chats' | 'git' | 'repos' | 'settings' | 'remote' | 'app' | 'agents'

export interface OptionSpec {
  type: 'string' | 'boolean'
  short?: string
  // Repeatable: the value is a list.
  multiple?: boolean
  help: string
  // The placeholder shown after a string option, like <n> or <name|path>.
  value?: string
  choices?: readonly string[]
  // How it behaves when left out, in words, for the help (parseArgs never sees it; the command applies it).
  default?: string
}

export interface ArgSpec {
  name: string
  required?: boolean
  // Takes every remaining word.
  rest?: boolean
  help: string
  // For completion and help: the words it accepts, when there is a short fixed list.
  choices?: readonly string[]
}

export interface CommandSpec {
  // The words that name it: ['settings', 'set'].
  path: string[]
  group: CommandGroup
  summary: string
  usage: string
  args: ArgSpec[]
  options: Record<string, OptionSpec>
  examples?: string[]
  // Codes this command gives beyond the shared table (`foreman help exit-codes`).
  exitCodes?: Record<number, string>
  // The long prose `foreman help <command>` prints last.
  details?: string
  // read: always served. act: starts or queues a turn, or does work an agent may do. admin: changes setup or moves data out; never from an agent turn.
  tier: 'read' | 'act' | 'admin'
  // The assistant may show this command but not run it, for this reason.
  noAssistant?: string
  hidden?: boolean
}

export const GROUP_ORDER: CommandGroup[] = ['work', 'workspaces', 'chats', 'git', 'repos', 'settings', 'remote', 'app', 'agents']

export const GROUP_LABELS: Record<CommandGroup, string> = {
  work: 'Work',
  workspaces: 'Workspaces',
  chats: 'Chats',
  git: 'Git & PRs',
  repos: 'Repositories',
  settings: 'Settings',
  remote: 'Remote',
  app: 'App',
  agents: 'Agents'
}

/**
 * Options every command takes. `--yes` is only acted on where a command asks (import's repository
 * suggestion, anything that needs confirmation); elsewhere it is harmless.
 */
export const COMMON_OPTIONS: Record<string, OptionSpec> = {
  json: { type: 'boolean', help: 'Print the result as JSON (FOREMAN_JSON=1 does the same)' },
  quiet: { type: 'boolean', short: 'q', help: 'Hide progress lines and notes' },
  yes: { type: 'boolean', short: 'y', help: 'Answer yes to confirmations' },
  help: { type: 'boolean', short: 'h', help: 'Show this command’s help' }
}

/** Short spellings of a noun. `ws` and `pr` are for the workspace and git commands that arrive in later phases; settings keys have none. */
export const ALIASES: Record<string, string[]> = {
  ws: ['workspace'],
  pr: ['git', 'pr']
}

const RUN_DETAILS = `Values fill the template's {{placeholders}} in order; extra values join the last one.
A GitHub issue or PR URL as a value also attaches its text as a file; a PR URL checks out
its head (fetched from the repository the URL names) with the PR's base branch as the base.
An issue URL fills {{issue id}}.
The repository is the one you're in, unless --repo says otherwise.

If setup fails, the first message is held, not sent. The command prints the end of
the setup log and exits with code 3; use --start-anyway to send it regardless.

foreman run prints the workspace, chat (session) and turn ids. With --wait it then blocks
for that turn's outcome; \`foreman wait <turn>\` does the same later, also after the turn
has ended, because the outcome is read from the chat's saved record. Exit codes: 0 completed,
1 failed, stopped or interrupted, 2 timed out (the turn keeps running), 3 setup held,
5 the connection to Foreman was lost (the turn is unaffected). --json adds the outcome,
what the turn changed, the checks state and the pull request URL. The Foreman app must be
running for any of this: the turn runs in the app, and so does the waiting.`

const SEND_DETAILS = `foreman send queues a message into one tab of a workspace (a name, id or branch from
\`foreman status\`, or "." for the one you're in). The first word may be a template's exact
name, id or slug, followed by its values; otherwise everything after the workspace is the
message (put -- before text that starts with a dash). A workspace with one open tab needs
no --tab; with several, send refuses and lists the tabs (index, title, model, status). It
never steers a running turn. It prints the receipt: "Queued to tab 2 (Claude · Opus 5.5)
as turn <id>". An idle tab starts the turn at once ("Sent to tab ...").`

const CANCEL_DETAILS = `foreman cancel takes the turn id that foreman run and foreman send print: a queued turn
is dropped, a starting or running one is stopped, and it prints the outcome.`

const CHECKS_DETAILS = `foreman checks runs the commands under [[checks]] in the workspace you're in, with the
same definitions and records as the Git panel's Run checks. Exit codes: 0 passed,
1 failed, 2 error, timeout or cancelled, 3 not configured, 4 busy (an agent turn is
active in the workspace; try again when it ends).`

const STATUS_DETAILS = `foreman status is read-only. It lists each workspace with its state (the same groups as
the sidebar), its latest turn, the state of its checks (passed, failed, stale, running,
incomplete or none), what that turn changed, and its pull request. --words prints a line saying how many things need
you, then one sentence per workspace (“api-fix: Claude Code finished 2 minutes ago, this turn 3 files +120 -14, checks
12 passed, PR #51 open.”), for a screen reader; with --json it changes nothing. Every command needs the Foreman app to
be running.`

const ASK_DETAILS = `foreman ask runs one turn of the Foreman assistant (the Ask Foreman overlay) with its read-only state
tools, waits for it and prints the answer in plain sentences. --workspace gives it the workspace you mean (a name, id
or branch from \`foreman status\`, or "." for the one you're in); without it the assistant looks across all of them.
If the assistant proposes a command, ask prints it as a line you can run yourself: "Proposed: <what it does>" and
"Run it yourself: foreman <words>". It never runs the proposal, and the proposal is dropped from the Assistant view, so
nothing waits there. The question leaves no conversation in the Assistant view either. It gives up after two minutes
and prints what it has (exit 2). With --json it prints {answer, proposals: [{runId, command, summary}], timedOut?}.

It needs the assistant: it is refused under Privacy mode, when the assistant is turned off in Settings, and when no
agent is signed in, with the reason on stderr and exit code 3. It is an admin command, so it is never served to an
agent from inside a turn (exit 7), and the assistant itself can't propose it, because it runs the assistant.
Exit codes: 0 answered, 2 timed out, 3 the assistant isn't available, 7 called from an agent turn.
The Foreman app must be running.`

const EXPORT_DETAILS = `foreman export writes a .foreman file of one workspace: its chats (the latest version of each
message), attached files by hash, review comments and the names (never the values) of its
variables. By default it is a backup, encrypted with a passphrase (asked for twice, or set
FOREMAN_PASSPHRASE). --share instead writes the chats you pick in the clear, for someone
else: --chat <n|id> (repeatable; default every open tab), --tool-output, --no-attachments, --bundle (branch + uncommitted work; backups include it unless --no-bundle).
It lists what the file holds so you can review it first.`

const IMPORT_DETAILS = `foreman import checks the file
(version, hashes, size limits, no path traversal or links) in a quarantine folder where
nothing runs, then creates a history-only workspace: the chats are readable and there is no
worktree. Foreman suggests a repository by remote URL and root commit; name it with --repo,
or accept a single suggestion with --yes. Importing the same export again needs --copy,
which mints new ids. Activate the workspace in the app once its branch exists locally.`

const REPORT_DETAILS = `foreman report and foreman review are for agents. Inside an agent turn Foreman sets
FOREMAN_SESSION_ID, FOREMAN_TURN_ID and FOREMAN_TURN_TOKEN, so a report lands on that tab and
turn; without them it counts for the workspace you're in, and says so. needs-input and stuck
stay on Home as "agent says" until the user replies in that tab or dismisses them; checkpoint
and done are quiet lines in the chat. The token is attribution, not a security boundary.
A call carrying a turn token can't use run or send unless the repository allows it
(Repository settings → Actions → "Let agents start workspaces and queue messages").`

const REVIEW_DETAILS = `foreman review adds a row on Home asking the user to look at something; it starts nothing.
Like foreman report it is for agents: see \`foreman help report\` and \`foreman help agents\`.`

export const COMMANDS: CommandSpec[] = [
  {
    path: ['run'],
    group: 'work',
    summary: 'Start a workspace with a filled-in template',
    usage: 'foreman run <template> [value...] [options]',
    args: [
      { name: 'template', required: true, help: 'A template’s slug, name, id or any unique part of it (`foreman templates` lists them)' },
      { name: 'value', rest: true, help: 'Values for the template’s {{placeholders}}, in order' }
    ],
    options: {
      repo: { type: 'string', short: 'r', value: '<name|path>', help: 'Repository to start the workspace in', default: 'the one you’re in' },
      branch: { type: 'string', short: 'b', value: '<name>', help: 'Name for the new branch', default: 'named from the prompt' },
      base: { type: 'string', value: '<branch>', help: 'Branch to start from', default: 'the repository’s base branch' },
      loadout: { type: 'string', short: 'l', value: '<n>', help: 'Agent and model from loadout slot n', default: '1' },
      open: { type: 'boolean', short: 'o', help: 'Bring Foreman forward on the new workspace' },
      'dry-run': { type: 'boolean', short: 'n', help: 'Print the filled-in prompt; create nothing' },
      'start-anyway': { type: 'boolean', help: 'If setup fails, send the first message anyway' },
      'no-wait': { type: 'boolean', help: 'Return once the workspace exists, without waiting for setup' },
      wait: { type: 'boolean', help: 'Block until the first turn ends, and report how it went' },
      timeout: { type: 'string', value: '<s>', help: 'With --wait (and for `wait`): stop waiting after s seconds' },
      with: { type: 'string', value: '<a,b>', help: 'Integrations to switch on in this workspace (linear, slack), over the repository’s defaults' },
      without: { type: 'string', value: '<a,b>', help: 'Integrations to switch off in this workspace' }
    },
    examples: ['foreman run fix-a-bug "ENG-123: login button does nothing" --open', 'foreman run issue https://github.com/owner/repo/issues/12', 'foreman run fix-linear-bug ENG-123 --wait --timeout 1800', 'foreman run triage ENG-123 --with linear --without slack'],
    exitCodes: { 0: 'Started (with --wait: the turn completed)', 1: 'Failed, or the turn failed, was stopped or was interrupted', 2: 'Usage error, or --wait timed out (the turn keeps running)', 3: 'Setup failed; the first message is held', 5: 'The connection to Foreman was lost (the turn is unaffected)' },
    details: RUN_DETAILS,
    tier: 'act'
  },
  {
    path: ['wait'],
    group: 'work',
    summary: 'Wait for a turn’s outcome',
    usage: 'foreman wait <turn> [--timeout s] [--words] [--json]',
    args: [{ name: 'turn', required: true, help: 'The turn id that `foreman run` and `foreman send` print' }],
    options: {
      timeout: { type: 'string', value: '<s>', help: 'Stop waiting after s seconds; the turn keeps running' },
      words: { ...WORDS_OPTION, help: 'One sentence, for a screen reader: “Claude Code finished in api-fix: this turn 3 files, +120 -14. Checks: 12 passed.”' }
    },
    examples: ['foreman wait 7f3a9c --timeout 600', 'foreman wait 7f3a9c --words', 'foreman wait 7f3a9c --json'],
    exitCodes: { 0: 'Completed', 1: 'Failed, stopped or interrupted', 2: 'Timed out (the turn keeps running)', 5: 'The connection to Foreman was lost (the turn is unaffected)' },
    details: 'The outcome is read from the chat’s saved record, so waiting after the turn finished still answers. --words prints the outcome as the narrator’s sentence (this turn’s change, or the workspace’s when the turn has none, labelled; checks as recorded, “stale” when the files have changed since); with --json it changes nothing. The Foreman app must be running.',
    tier: 'read'
  },
  {
    path: ['send'],
    group: 'work',
    summary: 'Queue a message into a chat tab',
    usage: 'foreman send <workspace> [--tab n] <template|text...>',
    args: [
      { name: 'workspace', required: true, help: 'A name, id or branch from `foreman status`, or "." for the one you’re in' },
      { name: 'template|text', required: true, rest: true, help: 'A template’s name, id or slug followed by its values, or the words of a message' }
    ],
    options: { tab: { type: 'string', short: 't', value: '<n>', help: 'Open tab to send to, counting from 1', default: 'the only open tab' } },
    examples: ['foreman send api "Also add a test for the empty case"', 'foreman send . --tab 2 fix-a-bug "flaky login test"'],
    details: SEND_DETAILS,
    tier: 'act'
  },
  {
    path: ['cancel'],
    group: 'work',
    summary: 'Cancel a queued, starting or running turn',
    usage: 'foreman cancel <turn> [--json]',
    args: [{ name: 'turn', required: true, help: 'The turn id that `foreman run` and `foreman send` print' }],
    options: {},
    examples: ['foreman cancel 7f3a9c'],
    details: CANCEL_DETAILS,
    tier: 'act'
  },
  {
    path: ['resume-at'],
    group: 'work',
    summary: 'Arm the “Resume at …” a usage-limit failure offers (or disarm it)',
    usage: 'foreman resume-at <turn> [--cancel] [--json]',
    args: [{ name: 'turn', required: true, help: 'The turn that hit the usage limit' }],
    options: { cancel: { type: 'boolean', help: 'Disarm the resume instead' } },
    examples: ['foreman resume-at 7f3a9c', 'foreman resume-at 7f3a9c --cancel'],
    details: 'Arming ticks the same “Resume at …” box on the usage-limit card in the chat; the chat then continues by itself once the limit resets.',
    tier: 'act'
  },
  {
    path: ['checks'],
    group: 'work',
    summary: 'Run this workspace’s configured checks',
    usage: 'foreman checks [--json]',
    args: [],
    options: {},
    examples: ['foreman checks', 'foreman checks --json'],
    exitCodes: { 0: 'Passed', 1: 'Failed', 2: 'Error, timeout or cancelled', 3: 'Not configured', 4: 'Busy: an agent turn is active in the workspace' },
    details: CHECKS_DETAILS,
    tier: 'act'
  },
  {
    path: ['status'],
    group: 'work',
    summary: 'List workspaces and what each needs',
    usage: 'foreman status [--words] [--json]',
    args: [],
    options: { words: { ...WORDS_OPTION, help: 'A line saying how many things need you, then a sentence per workspace, instead of the table' } },
    examples: ['foreman status', 'foreman status --words', 'foreman status --json'],
    details: STATUS_DETAILS,
    tier: 'read'
  },
  {
    path: ['report'],
    group: 'work',
    summary: 'Tell Foreman, as the agent, how the work is going',
    usage: 'foreman report needs-input|stuck|checkpoint|done "<text>" [--link url]',
    args: [
      { name: 'kind', required: true, help: 'What kind of report', choices: ['needs-input', 'stuck', 'checkpoint', 'done'] },
      { name: 'text', rest: true, help: 'A few words saying it' }
    ],
    options: { link: { type: 'string', value: '<url>', help: 'A link to show with the report' } },
    examples: ['foreman report needs-input "Which database should the migration target?"', 'foreman report done "Fixed the login redirect" --link https://github.com/owner/repo/pull/12'],
    details: REPORT_DETAILS,
    tier: 'read',
    noAssistant: 'it is for agents, which report from inside a turn'
  },
  {
    path: ['review'],
    group: 'work',
    summary: 'Ask the user for a review (adds a row on Home; starts nothing)',
    usage: 'foreman review "<what to check>"',
    args: [{ name: 'what', required: true, rest: true, help: 'What the user should look at' }],
    options: { link: { type: 'string', value: '<url>', help: 'A link to show with the request' } },
    examples: ['foreman review "The migration in db/20261024_add_index.sql"'],
    details: REVIEW_DETAILS,
    tier: 'read',
    noAssistant: 'it is for agents, which ask for a review from inside a turn'
  },
  {
    path: ['ask'],
    group: 'work',
    summary: 'Ask Foreman about your workspaces and get a spoken-style answer',
    usage: 'foreman ask "<question>" [--workspace ws] [--json]',
    args: [{ name: 'question', required: true, rest: true, help: 'What you want to know, in your own words' }],
    options: {
      workspace: { type: 'string', value: '<name|id|.>', help: 'The workspace you mean (a name, id or branch from `foreman status`, or "." for the one you’re in)', default: 'none: the assistant looks across all of them' }
    },
    examples: ['foreman ask "what needs me?"', 'foreman ask "did the checks pass?" --workspace .', 'foreman ask "which workspaces are idle?" --json'],
    exitCodes: { 0: 'Answered', 2: 'Timed out (what it had so far is printed)', 3: 'The assistant isn’t available: off, Privacy mode or no signed-in agent', 7: 'Called from inside an agent turn' },
    details: ASK_DETAILS,
    tier: 'admin',
    noAssistant: 'it runs the assistant itself'
  },
  {
    path: ['export'],
    group: 'workspaces',
    summary: 'Write a .foreman file: an encrypted backup, or chats you reviewed',
    usage: 'foreman export <workspace> [--out file] [--share]',
    args: [{ name: 'workspace', required: true, help: 'A name, id or branch from `foreman status`, or "." for the one you’re in' }],
    options: {
      out: { type: 'string', value: '<file>', help: 'Where to write it', default: '<workspace>.foreman in the current folder' },
      share: { type: 'boolean', help: 'Write the chats you pick in the clear, for someone else, instead of an encrypted backup' },
      chat: { type: 'string', multiple: true, value: '<n|id>', help: 'With --share: a chat to include', default: 'every open tab' },
      'tool-output': { type: 'boolean', help: 'With --share: include tool output' },
      'no-attachments': { type: 'boolean', help: 'Leave attached files out' },
      bundle: { type: 'boolean', help: 'Include the branch and uncommitted work (backups include it unless --no-bundle)' },
      'no-bundle': { type: 'boolean', help: 'Leave the branch and uncommitted work out of a backup' }
    },
    examples: ['foreman export api --out api-backup.foreman', 'foreman export api --share --chat 1 --out chat.foreman'],
    details: EXPORT_DETAILS,
    tier: 'admin',
    noAssistant: 'a backup asks for a passphrase at the prompt'
  },
  {
    path: ['import'],
    group: 'workspaces',
    summary: 'Stage a .foreman file and create a history-only workspace',
    usage: 'foreman import <file> [--repo name] [--copy]',
    args: [{ name: 'file', required: true, help: 'A .foreman file' }],
    options: {
      repo: { type: 'string', short: 'r', value: '<name|path>', help: 'The repository to put the workspace in', default: 'the single suggestion, with --yes' },
      copy: { type: 'boolean', help: 'Import it again as a copy, with new ids' }
    },
    examples: ['foreman import api-backup.foreman --repo api', 'foreman import api-backup.foreman --yes'],
    details: IMPORT_DETAILS,
    tier: 'admin',
    noAssistant: 'an encrypted backup asks for its passphrase at the prompt'
  },
  {
    path: ['templates'],
    group: 'settings',
    summary: 'List templates and their {{placeholders}}',
    usage: 'foreman templates [--json]',
    args: [],
    options: {},
    examples: ['foreman templates', 'foreman templates --json'],
    details: 'Lists your personal templates and, when you are in a repository, the ones in its .foreman/templates folder (marked "from repo").',
    tier: 'read'
  },
  {
    path: ['repos'],
    group: 'repos',
    summary: 'List repositories',
    usage: 'foreman repos [--json]',
    args: [],
    options: {},
    examples: ['foreman repos', 'foreman repos --json'],
    tier: 'read'
  },
  {
    path: ['app', 'info'],
    group: 'app',
    summary: 'Show the running app: version, protocol, data folder and socket',
    usage: 'foreman app info [--json]',
    args: [],
    options: {},
    examples: ['foreman app info', 'foreman app info --json'],
    details: 'Warns on stderr when the app speaks an older protocol than this command; update the app (the command is part of it).',
    tier: 'read'
  },
  {
    path: ['doctor'],
    group: 'app',
    summary: 'Check the app, git, gh, agents and the data folder',
    usage: 'foreman doctor [--json]',
    args: [],
    options: {},
    examples: ['foreman doctor', 'foreman doctor --json'],
    exitCodes: { 0: 'Nothing wrong', 1: 'At least one problem (listed at the end)' },
    details: 'Prints one line per item and, at the end, the problems with what to do about each. Items marked "note" are worth knowing but are not problems.',
    tier: 'read'
  },
  {
    path: ['cli', 'status'],
    group: 'app',
    summary: 'Show whether the foreman command is installed on your PATH',
    usage: 'foreman cli status [--json]',
    args: [],
    options: {},
    examples: ['foreman cli status'],
    tier: 'read'
  },
  {
    path: ['cli', 'install'],
    group: 'app',
    summary: 'Put the foreman command on your PATH (what Settings → Advanced → Install does)',
    usage: 'foreman cli install [--json]',
    args: [],
    options: {},
    examples: ['foreman cli install'],
    details: 'macOS links /usr/local/bin/foreman and may ask for your password. Linux falls back to ~/.local/bin when /usr/local/bin is not writable. Windows adds the launcher’s folder to your user PATH.',
    tier: 'admin'
  },
  {
    path: ['completion'],
    group: 'app',
    summary: 'Print a shell completion script',
    usage: 'foreman completion bash|zsh|fish|pwsh',
    args: [{ name: 'shell', required: true, help: 'The shell to print the script for', choices: ['bash', 'zsh', 'fish', 'pwsh'] }],
    options: {},
    examples: ['source <(foreman completion bash)', 'foreman completion fish > ~/.config/fish/completions/foreman.fish', 'foreman completion pwsh | Out-String | Invoke-Expression'],
    details: 'The script completes command names, subcommands, options and the words an option accepts. It needs nothing from the app.',
    tier: 'read'
  },
  {
    path: ['help'],
    group: 'app',
    summary: 'Show help for a command or a topic',
    usage: 'foreman help [command|topic]',
    args: [{ name: 'command|topic', rest: true, help: 'A command (`run`, `cli install`) or a topic: exit-codes, agents, environment, settings-keys' }],
    options: {},
    examples: ['foreman help', 'foreman help send', 'foreman help exit-codes'],
    details: '`foreman <command> --help` prints the same text as `foreman help <command>`.',
    tier: 'read'
  },
  {
    // The integration bridge agents start; its stdout is the MCP channel, so it never goes through the command framework.
    path: ['mcp-bridge'],
    group: 'app',
    summary: 'Run the stdio MCP server agents use for an integration',
    usage: 'foreman mcp-bridge <service>',
    args: [{ name: 'service', required: true, help: 'linear, github or slack' }],
    options: {},
    tier: 'read',
    hidden: true,
    noAssistant: 'agents start it themselves'
  },
  // Workspaces, chat tabs and approvals (phase 2-A); their specs live beside their runners.
  ...WORKSPACE_COMMANDS,
  ...TAB_COMMANDS,
  ...APPROVAL_COMMANDS,
  // Settings, repository settings, environment and keys (phase 1c-A).
  ...SETTINGS_COMMANDS,
  ...REPO_SETTINGS_COMMANDS,
  ...ENV_COMMANDS,
  // Loadouts, models, agents, templates, saved commands, schedules, connections, Slack, backups, usage (phase 1c-B).
  ...AUTOMATION_COMMANDS,
  // Git and pull requests, repository operations, remote workspaces (phase 2-B).
  ...GIT_COMMANDS,
  ...REPO_OPS_COMMANDS,
  ...CLOUD_COMMANDS
]

/** What a command is called in the first word of a path, for display: the alias when one points at exactly that noun. */
export function displayNoun(noun: string): string {
  const alias = Object.entries(ALIASES).find(([, target]) => target.length === 1 && target[0] === noun)
  return alias ? alias[0] : noun
}

/** The commands a person sees (everything but the hidden ones). */
export function visibleCommands(commands: CommandSpec[] = COMMANDS): CommandSpec[] {
  return commands.filter((c) => !c.hidden)
}

export function commandName(spec: CommandSpec): string {
  return spec.path.join(' ')
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/** Commands whose name is close to what was typed: the ones it is a prefix of first, then the nearest by edit distance. */
export function suggestCommands(typed: string[], commands: CommandSpec[] = COMMANDS): string[] {
  const words = typed.filter((w) => !w.startsWith('-')).slice(0, 2)
  if (!words.length) return []
  const whole = words.join(' ').toLowerCase()
  const first = words[0].toLowerCase()
  const scored = visibleCommands(commands).map((spec) => {
    const name = commandName(spec)
    const prefix = name.startsWith(whole) || spec.path[0].startsWith(first)
    const near = Math.min(distance(whole, name), distance(first, spec.path[0]))
    const limit = Math.max(2, Math.ceil(first.length / 3))
    return { name, score: prefix ? 0 : near <= limit ? near : Infinity }
  })
  return scored
    .filter((s) => s.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((s) => s.name)
}

export type FoundCommand = { spec: CommandSpec; rest: string[] } | { error: string; suggestions: string[] }

/**
 * Resolve the words a person typed to a command: the longest path that matches the start of `argv`
 * (after expanding a noun alias), with everything after the path as `rest`. An unknown word comes back
 * as an error with the nearest commands; a noun without its verb (`foreman cli`) lists the verbs.
 */
export function findCommand(argv: string[], commands: CommandSpec[] = COMMANDS): FoundCommand {
  const alias = argv.length ? ALIASES[argv[0]] : undefined
  const words = alias ? [...alias, ...argv.slice(1)] : argv
  let best: CommandSpec | undefined
  for (const spec of commands) {
    if (spec.path.length > words.length || !spec.path.every((p, i) => words[i] === p)) continue
    if (!best || spec.path.length > best.path.length) best = spec
  }
  if (best) return { spec: best, rest: words.slice(best.path.length) }
  const noun = words[0]
  const verbs = noun === undefined ? [] : visibleCommands(commands).filter((c) => c.path.length > 1 && c.path[0] === noun)
  if (verbs.length) {
    const second = words[1] && !words[1].startsWith('-') ? words[1] : undefined
    if (!second) return { error: `foreman ${argv[0]} needs a subcommand`, suggestions: verbs.map(commandName) }
    return { error: `Unknown ${argv[0]} command “${second}”`, suggestions: verbs.map(commandName) }
  }
  const typed = argv.find((w) => !w.startsWith('-')) ?? argv[0] ?? ''
  return { error: `Unknown command “${typed}”`, suggestions: suggestCommands(argv, commands) }
}
