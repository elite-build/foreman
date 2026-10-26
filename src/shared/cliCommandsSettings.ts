// The declarative half of the settings, repository settings, environment, key and token commands
//. Merged into COMMANDS by src/shared/cliCommands.ts; the
// functions that run them are in src/cli/commands/{settings,repo,env}.ts, keyed by the path joined with spaces.
import type { CommandSpec, OptionSpec } from './cliCommands'
import { SETTINGS_PAGES } from './settingsSchema'

const REPO: OptionSpec = { type: 'string', short: 'r', value: '<name|path>', help: 'Repository: a name, id or folder', default: 'the one you’re in' }
const STDIN_SECRET: OptionSpec = { type: 'boolean', help: 'Read the value from standard input (one trailing newline is dropped); it is never echoed' }

const SETTINGS_DETAILS = `Keys are <page>.<id>, the page Settings shows the row on and the row's id: appearance.theme,
git.branch-prefix, cloud.max-running. \`foreman settings keys\` lists them; \`foreman help settings-keys\`
prints the table with what each takes. Booleans accept on/off (also true/false, yes/no, 1/0). Changes go
through the same service as the Settings window, so what the window does (apply now, a note about what
changed) happens here too. Settings can't be changed from inside an agent turn.`

const REPO_SETTINGS_DETAILS = `Repository settings have layers: this computer's value (local), the committed .foreman/settings.toml
(shared), your own Settings (user) and the default. \`get\` and \`list\` say which layer a value comes from;
\`set\` writes this computer's layer and says when it hides a shared value; \`unset\` removes it so the value is
inherited again. Keys are <tab>.<id> after the Repository settings tab: git.base-branch,
scripts.checks-after-turn, actions.prompt-general, repo.icon, integrations.github-account, cloud.vcpus.
Lists and text values take the forms \`set\` documents. The repository is the one you are in unless --repo says
otherwise.`

const SECRET_DETAILS = 'The value is read from standard input or a prompt that does not echo it; it is never printed, logged or put on the command line by this command.'

const STEP_VERBS = ['list', 'add', 'remove', 'move', 'clear', 'inherit'] as const

const STEP_OPTIONS: Record<string, OptionSpec> = {
  repo: REPO,
  timeout: { type: 'string', value: '<s>', help: 'add: seconds before the step is stopped' },
  parallel: { type: 'boolean', help: 'add: run alongside the steps next to it' },
  at: { type: 'string', value: '<n>', help: 'add: position to insert at, from 1', default: 'the end' }
}

export const SETTINGS_COMMANDS: CommandSpec[] = [
  {
    path: ['settings'],
    group: 'settings',
    summary: 'Read and change Foreman’s settings (the Settings window, from a terminal)',
    usage: 'foreman settings [list|get|set|reset|keys|search|path|export|import]',
    args: [{ name: 'verb', help: 'What to do; without one, this help', choices: ['list', 'get', 'set', 'reset', 'keys', 'search', 'path', 'export', 'import'] }],
    options: {},
    examples: ['foreman settings', 'foreman settings list --changed', 'foreman settings set appearance.theme dark'],
    details: SETTINGS_DETAILS,
    tier: 'read'
  },
  {
    path: ['settings', 'list'],
    group: 'settings',
    summary: 'Every setting with its value, grouped as Settings is',
    usage: 'foreman settings list [--page <page>] [--changed] [--json]',
    args: [],
    options: {
      page: { type: 'string', value: '<page>', help: 'Only this Settings page', choices: SETTINGS_PAGES },
      changed: { type: 'boolean', help: 'Only the settings that differ from their default' }
    },
    examples: ['foreman settings list', 'foreman settings list --page appearance', 'foreman settings list --changed --json'],
    details: 'A * marks a value that differs from the default. Inside an agent turn only the settings the assistant may read are listed.',
    tier: 'read'
  },
  {
    path: ['settings', 'get'],
    group: 'settings',
    summary: 'Show settings: value, default, where it is in Settings, what it takes',
    usage: 'foreman settings get <key>... [--json]',
    args: [{ name: 'key', required: true, rest: true, help: 'One or more settings keys, like appearance.theme' }],
    options: {},
    examples: ['foreman settings get appearance.theme', 'foreman settings get git.branch-prefix-type git.branch-prefix --json'],
    exitCodes: { 2: 'A key is not a setting (the error names the nearest keys)' },
    tier: 'read'
  },
  {
    path: ['settings', 'set'],
    group: 'settings',
    summary: 'Change one or several settings',
    usage: 'foreman settings set <key> <value> [<key> <value>...]  |  foreman settings set <key> --add <item> | --remove <item> | --stdin',
    args: [{ name: 'key value', required: true, rest: true, help: 'Pairs: a key, then its value (quote values with spaces)' }],
    options: {
      add: { type: 'string', multiple: true, value: '<item>', help: 'List settings: add an item to the current list' },
      remove: { type: 'string', multiple: true, value: '<item>', help: 'List settings: take an item out of the current list' },
      stdin: { type: 'boolean', help: 'Read the value from standard input: one item per line for a list, the whole text otherwise' }
    },
    examples: [
      'foreman settings set appearance.theme dark',
      'foreman settings set git.branch-prefix-type custom git.branch-prefix yatin/',
      'foreman settings set environment.env-files --add .env.local',
      'git ls-files "*.env" | foreman settings set environment.env-files --stdin'
    ],
    exitCodes: { 2: 'A value is not valid for its key (nothing is written unless every pair is valid)', 7: 'Called from inside an agent turn' },
    details: `Every pair is checked before anything is written. A list takes a,b,c to replace it, or --add / --remove to
change it by an item (the current list is read first). Each change prints "key value (was old)", plus a note
where the setting widens what an agent may do or deletes something.`,
    tier: 'admin'
  },
  {
    path: ['settings', 'reset'],
    group: 'settings',
    summary: 'Put settings back to their defaults',
    usage: 'foreman settings reset <key>... | --all [--yes]',
    args: [{ name: 'key', rest: true, help: 'The settings to reset' }],
    options: { all: { type: 'boolean', help: 'Every setting; asks first (--yes skips the question)' } },
    examples: ['foreman settings reset appearance.theme', 'foreman settings reset --all --yes'],
    exitCodes: { 6: '--all without --yes and without a terminal to ask on' },
    details: 'Each key goes through the same owner as `set`, so a reset has the same side effects as choosing the default in Settings.',
    tier: 'admin'
  },
  {
    path: ['settings', 'keys'],
    group: 'settings',
    summary: 'The key table: key, what it takes, Settings page and title',
    usage: 'foreman settings keys [--json]',
    args: [],
    options: {},
    examples: ['foreman settings keys', 'foreman settings keys --json'],
    details: '`foreman help settings-keys` prints the same keys, and the repository ones, in full.',
    tier: 'read'
  },
  {
    path: ['settings', 'search'],
    group: 'settings',
    summary: 'Find a setting by what it does',
    usage: 'foreman settings search "<words>"',
    args: [{ name: 'words', required: true, rest: true, help: 'What to look for' }],
    options: {},
    examples: ['foreman settings search "dark mode"', 'foreman settings search branch name'],
    details: 'The same search the in-app assistant uses; each hit shows where it is in Settings and the command that sets it.',
    tier: 'read'
  },
  {
    path: ['settings', 'path'],
    group: 'settings',
    summary: 'Where a setting is in the Settings window',
    usage: 'foreman settings path <key> [--open]',
    args: [{ name: 'key', required: true, help: 'A settings key' }],
    options: { open: { type: 'boolean', help: 'Show the row in the running app' } },
    examples: ['foreman settings path appearance.theme', 'foreman settings path git.branch-prefix --open'],
    tier: 'read'
  },
  {
    path: ['settings', 'export'],
    group: 'settings',
    summary: 'Write the plain settings as JSON',
    usage: 'foreman settings export [--out <file>]',
    args: [],
    options: { out: { type: 'string', value: '<file>', help: 'Write to this file instead of standard output' } },
    examples: ['foreman settings export --out settings.json', 'foreman settings export > settings.json'],
    details: 'Every plain setting by key. No secrets, templates, loadouts or other structured settings are included.',
    tier: 'read'
  },
  {
    path: ['settings', 'import'],
    group: 'settings',
    summary: 'Apply settings from a JSON file made by `settings export`',
    usage: 'foreman settings import <file> [--yes]',
    args: [{ name: 'file', required: true, help: 'A JSON file of key: value' }],
    options: {},
    examples: ['foreman settings import settings.json', 'foreman settings import settings.json --yes'],
    exitCodes: { 6: 'Not confirmed (no --yes and no terminal, or you answered no)' },
    details: 'Prints what would change first, then asks before applying. Keys the file does not name are left alone.',
    tier: 'admin'
  }
]

/** Environment variables, provider keys, tokens and an agent's own key. */
export const ENV_COMMANDS: CommandSpec[] = [
  {
    path: ['env'],
    group: 'settings',
    summary: 'List environment variables: names and where they come from, never values',
    usage: 'foreman env [list] [--repo <name|path>] [--json]',
    args: [{ name: 'verb', help: 'list (the default)', choices: ['list'] }],
    options: { repo: REPO },
    examples: ['foreman env', 'foreman env --repo api', 'foreman env --json'],
    details: 'Without --repo, your own variables; with it, that repository’s (its own, its env files and the committed settings file, with your own underneath).',
    tier: 'read'
  },
  {
    path: ['env', 'set'],
    group: 'settings',
    summary: 'Save an environment variable',
    usage: 'foreman env set <KEY> [VALUE] [--repo <name|path>] [--stdin]',
    args: [
      { name: 'KEY', required: true, help: 'Variable name' },
      { name: 'VALUE', help: 'The value. Without it: --stdin, or a prompt that does not echo' }
    ],
    options: { repo: REPO, stdin: STDIN_SECRET },
    examples: ['foreman env set API_URL https://example.test', 'printf %s "$TOKEN" | foreman env set MY_TOKEN --stdin', 'foreman env set DATABASE_URL --repo api'],
    exitCodes: { 2: 'No value given and no terminal to prompt on (use --stdin)' },
    details: `A value on the command line lands in your shell history and in the process list; prefer the prompt or --stdin for anything secret.
${SECRET_DETAILS}`,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  },
  {
    path: ['env', 'unset'],
    group: 'settings',
    summary: 'Remove saved environment variables',
    usage: 'foreman env unset <KEY>... [--repo <name|path>] [--yes]',
    args: [{ name: 'KEY', required: true, rest: true, help: 'Variables to remove' }],
    options: { repo: REPO },
    examples: ['foreman env unset OLD_TOKEN', 'foreman env unset A B C D --yes --repo api'],
    exitCodes: { 6: 'More than three variables without --yes and without a terminal to ask on' },
    details: 'Asks first when removing more than three at once. Variables that come from an env file are removed from the file, not here.',
    tier: 'admin'
  },
  {
    path: ['env', 'rename'],
    group: 'settings',
    summary: 'Rename a saved variable, keeping its value',
    usage: 'foreman env rename <OLD> <NEW> [--repo <name|path>]',
    args: [
      { name: 'OLD', required: true, help: 'Current name' },
      { name: 'NEW', required: true, help: 'New name' }
    ],
    options: { repo: REPO },
    examples: ['foreman env rename API_KEY SERVICE_API_KEY'],
    tier: 'admin'
  },
  {
    path: ['env', 'get'],
    group: 'settings',
    summary: 'Say where a variable comes from, or (with --reveal) print its value',
    usage: 'foreman env get <KEY> [--reveal [--force]] [--repo <name|path>]',
    args: [{ name: 'KEY', required: true, help: 'Variable name' }],
    options: {
      repo: REPO,
      reveal: { type: 'boolean', help: 'Print the value on standard output' },
      force: { type: 'boolean', help: 'With --reveal: allow it when standard output is not a terminal' }
    },
    examples: ['foreman env get API_URL', 'foreman env get MY_TOKEN --reveal'],
    exitCodes: { 7: '--reveal without a terminal (add --force), or from inside an agent turn', 8: 'No such variable' },
    details: 'Without --reveal only the origin is shown. --reveal needs a terminal on standard output unless --force; it prints the value on standard output and says "revealed KEY" on standard error. It is refused inside an agent turn.',
    tier: 'read',
    noAssistant: 'reveals a secret'
  },
  {
    path: ['env', 'files'],
    group: 'settings',
    summary: 'List, add or remove env files Foreman loads variables from',
    usage: 'foreman env files [list|add <path>|remove <path>] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'list (the default), add or remove', choices: ['list', 'add', 'remove'] },
      { name: 'path', help: 'The env file, for add and remove' }
    ],
    options: { repo: REPO },
    examples: ['foreman env files', 'foreman env files add .env.local --repo api', 'foreman env files remove .env.local'],
    details: '`list` is read-only and works from an agent turn; add and remove change setup.',
    tier: 'admin'
  },
  {
    path: ['env', 'import'],
    group: 'settings',
    summary: 'Save the variables of a .env file',
    usage: 'foreman env import <file> [--repo <name|path>] [--yes]',
    args: [{ name: 'file', required: true, help: 'A .env file: KEY=VALUE lines, # comments, quotes allowed' }],
    options: { repo: REPO },
    examples: ['foreman env import .env', 'foreman env import .env.production --repo api --yes'],
    exitCodes: { 6: 'Not confirmed (no --yes and no terminal, or you answered no)' },
    details: 'Lists the names it found (never the values) and whether each is new or replaces a saved value, then asks before saving.',
    tier: 'admin',
    noAssistant: 'reads secrets from a file on this computer'
  },
  {
    path: ['keys'],
    group: 'settings',
    summary: 'List provider keys: name, last four characters, which agents get it',
    usage: 'foreman keys [list] [--json]',
    args: [{ name: 'verb', help: 'list (the default)', choices: ['list'] }],
    options: {},
    examples: ['foreman keys', 'foreman keys --json'],
    tier: 'read'
  },
  {
    path: ['keys', 'set'],
    group: 'settings',
    summary: 'Save a provider key (never taken from the command line)',
    usage: 'foreman keys set <ENV_VAR> [--stdin | --from-shell]',
    args: [{ name: 'ENV_VAR', required: true, help: 'The variable name, like OPENAI_API_KEY' }],
    options: {
      stdin: STDIN_SECRET,
      'from-shell': { type: 'boolean', help: 'Copy it from the shell Foreman was started from' }
    },
    examples: ['foreman keys set OPENAI_API_KEY', 'printf %s "$KEY" | foreman keys set ANTHROPIC_API_KEY --stdin', 'foreman keys set GEMINI_API_KEY --from-shell'],
    exitCodes: { 2: 'A value was put on the command line, or there is no terminal to prompt on (use --stdin)' },
    details: SECRET_DETAILS,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  },
  {
    path: ['keys', 'remove'],
    group: 'settings',
    summary: 'Delete a saved provider key',
    usage: 'foreman keys remove <ENV_VAR> [--yes]',
    args: [{ name: 'ENV_VAR', required: true, help: 'The variable name' }],
    options: {},
    examples: ['foreman keys remove OPENAI_API_KEY'],
    exitCodes: { 6: 'Not confirmed (no --yes and no terminal, or you answered no)' },
    tier: 'admin'
  },
  {
    path: ['keys', 'allow'],
    group: 'settings',
    summary: 'Let agents use a provider key',
    usage: 'foreman keys allow <ENV_VAR> <agent>...',
    args: [
      { name: 'ENV_VAR', required: true, help: 'The variable name' },
      { name: 'agent', required: true, rest: true, help: 'Agent ids, like claude or codex' }
    ],
    options: {},
    examples: ['foreman keys allow OPENAI_API_KEY codex'],
    tier: 'admin'
  },
  {
    path: ['keys', 'deny'],
    group: 'settings',
    summary: 'Stop agents from getting a provider key',
    usage: 'foreman keys deny <ENV_VAR> <agent>...',
    args: [
      { name: 'ENV_VAR', required: true, help: 'The variable name' },
      { name: 'agent', required: true, rest: true, help: 'Agent ids, like claude or codex' }
    ],
    options: {},
    examples: ['foreman keys deny OPENAI_API_KEY claude'],
    tier: 'admin'
  },
  {
    path: ['keys', 'reveal'],
    group: 'settings',
    summary: 'Print a saved provider key',
    usage: 'foreman keys reveal <ENV_VAR> [--force]',
    args: [{ name: 'ENV_VAR', required: true, help: 'The variable name' }],
    options: { force: { type: 'boolean', help: 'Allow it when standard output is not a terminal' } },
    examples: ['foreman keys reveal OPENAI_API_KEY'],
    exitCodes: { 7: 'No terminal on standard output (add --force), or from inside an agent turn', 8: 'No such saved key' },
    details: 'Same rules as `env get --reveal`: a terminal (or --force), refused inside an agent turn, "revealed KEY" on standard error.',
    tier: 'admin',
    noAssistant: 'reveals a secret'
  },
  {
    path: ['github'],
    group: 'settings',
    summary: 'GitHub sign-in: how Foreman reaches GitHub and whether it works',
    usage: 'foreman github [status]',
    args: [{ name: 'verb', help: 'status (the default)', choices: ['status'] }],
    options: {},
    examples: ['foreman github', 'foreman github --json'],
    details: 'Token and account commands: `foreman github token set|clear`, `foreman github accounts`.',
    tier: 'read'
  },
  {
    path: ['github', 'accounts'],
    group: 'settings',
    summary: 'The GitHub accounts the gh command knows, and the active one',
    usage: 'foreman github accounts [--json]',
    args: [],
    options: {},
    examples: ['foreman github accounts'],
    tier: 'read'
  },
  {
    path: ['github', 'token', 'set'],
    group: 'settings',
    summary: 'Save a GitHub personal access token',
    usage: 'foreman github token set [--stdin]',
    args: [],
    options: { stdin: STDIN_SECRET },
    examples: ['foreman github token set', 'printf %s "$GH_TOKEN" | foreman github token set --stdin'],
    exitCodes: { 2: 'No terminal to prompt on (use --stdin)' },
    details: SECRET_DETAILS,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  },
  {
    path: ['github', 'token', 'clear'],
    group: 'settings',
    summary: 'Forget the saved GitHub token',
    usage: 'foreman github token clear',
    args: [],
    options: {},
    examples: ['foreman github token clear'],
    tier: 'admin'
  },
  {
    path: ['gitlab'],
    group: 'settings',
    summary: 'GitLab hosts Foreman has a token for',
    usage: 'foreman gitlab [list]',
    args: [{ name: 'verb', help: 'list (the default)', choices: ['list'] }],
    options: {},
    examples: ['foreman gitlab', 'foreman gitlab --json'],
    details: 'Also: `foreman gitlab add <url>`, `foreman gitlab remove <host>`, `foreman gitlab test <url>`.',
    tier: 'read'
  },
  {
    path: ['gitlab', 'add'],
    group: 'settings',
    summary: 'Connect a GitLab host with an access token',
    usage: 'foreman gitlab add <url> [--token-stdin | --from-glab]',
    args: [{ name: 'url', required: true, help: 'The host, like https://gitlab.com or https://gitlab.example.com' }],
    options: {
      'token-stdin': { type: 'boolean', help: 'Read the token from standard input; it is never echoed' },
      'from-glab': { type: 'boolean', help: 'Use the token the glab command already has for this host' }
    },
    examples: ['foreman gitlab add https://gitlab.com', 'printf %s "$GL_TOKEN" | foreman gitlab add https://gitlab.example.com --token-stdin', 'foreman gitlab add https://gitlab.com --from-glab'],
    exitCodes: { 2: 'No terminal to prompt on (use --token-stdin or --from-glab)' },
    details: `Without --token-stdin or --from-glab the token is asked for at a prompt that does not echo. ${SECRET_DETAILS}`,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  },
  {
    path: ['gitlab', 'remove'],
    group: 'settings',
    summary: 'Forget a GitLab host and its token',
    usage: 'foreman gitlab remove <host> [--yes]',
    args: [{ name: 'host', required: true, help: 'The host name, as `foreman gitlab` shows it' }],
    options: {},
    examples: ['foreman gitlab remove gitlab.example.com'],
    exitCodes: { 6: 'Not confirmed (no --yes and no terminal, or you answered no)' },
    tier: 'admin'
  },
  {
    path: ['gitlab', 'test'],
    group: 'settings',
    summary: 'Check that Foreman can reach a GitLab host with its saved token',
    usage: 'foreman gitlab test <url>',
    args: [{ name: 'url', required: true, help: 'The host URL' }],
    options: {},
    examples: ['foreman gitlab test https://gitlab.com'],
    exitCodes: { 1: 'The connection failed (the reason is printed)' },
    tier: 'admin'
  },
  {
    path: ['cloud', 'token'],
    group: 'remote',
    summary: 'Whether Claude’s setup token for remote workspaces is saved',
    usage: 'foreman cloud token [status]',
    args: [{ name: 'verb', help: 'status (the default)', choices: ['status'] }],
    options: {},
    examples: ['foreman cloud token', 'foreman cloud token --json'],
    details: 'Also: `foreman cloud token set [--stdin]` and `foreman cloud token clear`.',
    tier: 'read'
  },
  {
    path: ['cloud', 'token', 'set'],
    group: 'remote',
    summary: 'Save Claude’s setup token for remote workspaces',
    usage: 'foreman cloud token set [--stdin]',
    args: [],
    options: { stdin: STDIN_SECRET },
    examples: ['foreman cloud token set', 'claude setup-token | foreman cloud token set --stdin'],
    exitCodes: { 2: 'No terminal to prompt on (use --stdin)' },
    details: SECRET_DETAILS,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  },
  {
    path: ['cloud', 'token', 'clear'],
    group: 'remote',
    summary: 'Forget the saved setup token',
    usage: 'foreman cloud token clear',
    args: [],
    options: {},
    examples: ['foreman cloud token clear'],
    tier: 'admin'
  },
  {
    path: ['agents', 'key'],
    group: 'settings',
    summary: 'Set or remove an agent’s own API key',
    usage: 'foreman agents key <agent> [--stdin | --from-shell | --remove]',
    args: [{ name: 'agent', required: true, help: 'The agent id, like claude or codex' }],
    options: {
      stdin: STDIN_SECRET,
      'from-shell': { type: 'boolean', help: 'Copy the key from the shell Foreman was started from' },
      remove: { type: 'boolean', help: 'Delete the saved key' }
    },
    examples: ['foreman agents key claude', 'printf %s "$KEY" | foreman agents key codex --stdin', 'foreman agents key codex --remove'],
    exitCodes: { 2: 'No terminal to prompt on (use --stdin)' },
    details: `Without --stdin, --from-shell or --remove the key is asked for at a prompt that does not echo. ${SECRET_DETAILS}`,
    tier: 'admin',
    noAssistant: 'reads a secret from the terminal'
  }
]

export const REPO_SETTINGS_COMMANDS: CommandSpec[] = [
  {
    path: ['repo', 'settings'],
    group: 'repos',
    summary: 'Read and change a repository’s settings (the Repository settings window)',
    usage: 'foreman repo settings [list|get|set|unset|file]',
    args: [{ name: 'verb', help: 'What to do; without one, this help', choices: ['list', 'get', 'set', 'unset', 'file'] }],
    options: {},
    examples: ['foreman repo settings', 'foreman repo settings list --repo api'],
    details: REPO_SETTINGS_DETAILS,
    tier: 'read'
  },
  {
    path: ['repo', 'settings', 'list'],
    group: 'repos',
    summary: 'Every repository setting with its value and the layer it comes from',
    usage: 'foreman repo settings list [--repo <name|path>] [--shared] [--json]',
    args: [],
    options: { repo: REPO, shared: { type: 'boolean', help: 'Only what the committed .foreman/settings.toml sets' } },
    examples: ['foreman repo settings list', 'foreman repo settings list --repo api --shared'],
    tier: 'read'
  },
  {
    path: ['repo', 'settings', 'get'],
    group: 'repos',
    summary: 'Show repository settings: value and layer',
    usage: 'foreman repo settings get <key>... [--repo <name|path>] [--json]',
    args: [{ name: 'key', required: true, rest: true, help: 'One or more keys, like scripts.checks-after-turn' }],
    options: { repo: REPO },
    examples: ['foreman repo settings get scripts.checks-after-turn', 'foreman repo settings get git.base-branch git.remote --repo api'],
    tier: 'read'
  },
  {
    path: ['repo', 'settings', 'set'],
    group: 'repos',
    summary: 'Change repository settings on this computer',
    usage: 'foreman repo settings set <key> <value> [<key> <value>...] [--repo <name|path>]  |  <key> --add|--remove <item> | --stdin | --file <path>',
    args: [{ name: 'key value', required: true, rest: true, help: 'Pairs: a key, then its value' }],
    options: {
      repo: REPO,
      add: { type: 'string', multiple: true, value: '<item>', help: 'List settings: add an item to the current list' },
      remove: { type: 'string', multiple: true, value: '<item>', help: 'List settings: take an item out of the current list' },
      stdin: { type: 'boolean', help: 'Read the value from standard input: one item per line for a list, the whole text for a text setting' },
      file: { type: 'string', value: '<path>', help: 'Read the value from a file (an image file for repo.icon)' }
    },
    examples: [
      'foreman repo settings set scripts.checks-after-turn on --repo foreman',
      'foreman repo settings set actions.prompt-general --file prompt.md',
      'foreman repo settings set git.sensitive-paths --add secrets/ --add .env',
      'foreman repo settings set repo.icon emoji:🚀'
    ],
    exitCodes: { 2: 'A value is not valid for its key (nothing is written unless every pair is valid)', 7: 'Called from inside an agent turn' },
    details: `Writes this computer's layer (updateRepoSettings), or the repository's own record for keys like repo.name and
cloud.vcpus. When a key is also set by the committed .foreman/settings.toml the answer says it overrides it.
Lists take a,b,c to replace them or --add / --remove to change them by an item. Text settings
(actions.prompt-*, cloud.install-script) take --file <path> or --stdin; the file is read here and its text sent.
repo.icon takes emoji:<emoji>, lucide:<name>, or --file with an image.`,
    tier: 'admin'
  },
  {
    path: ['repo', 'settings', 'unset'],
    group: 'repos',
    summary: 'Remove this computer’s value so the setting is inherited again',
    usage: 'foreman repo settings unset <key>... [--repo <name|path>]',
    args: [{ name: 'key', required: true, rest: true, help: 'Keys to unset' }],
    options: { repo: REPO },
    examples: ['foreman repo settings unset scripts.checks-after-turn', 'foreman repo settings unset actions.prompt-general actions.prompt-create-pr --repo api'],
    details: 'Only settings kept on this computer can be unset; the ones stored on the repository itself (name, base branch, cloud …) have no inherited value, so set them instead.',
    tier: 'admin'
  },
  {
    path: ['repo', 'settings', 'file'],
    group: 'repos',
    summary: 'The committed .foreman/settings.toml: its path and whether it exists',
    usage: 'foreman repo settings file [--repo <name|path>] [--open]',
    args: [],
    options: { repo: REPO, open: { type: 'boolean', help: 'Open it in your editor' } },
    examples: ['foreman repo settings file', 'foreman repo settings file --repo api --open'],
    tier: 'read'
  },
  {
    path: ['repo', 'setup'],
    group: 'repos',
    summary: 'The steps that set up a new workspace',
    usage: 'foreman repo setup [list | add <name> <command> | remove <name|n> | move <n> <m> | clear | inherit] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'list (the default), add, remove, move, clear or inherit', choices: STEP_VERBS },
      { name: 'words', rest: true, help: 'add: the name then the command; remove: a name or number; move: two positions' }
    ],
    options: STEP_OPTIONS,
    examples: ['foreman repo setup', 'foreman repo setup add install "npm ci" --timeout 600', 'foreman repo setup move 3 1', 'foreman repo setup inherit --yes'],
    exitCodes: { 6: 'clear or inherit without --yes and without a terminal to ask on' },
    details:
      'Steps run in order when a workspace is created. Editing starts from this computer’s steps; with none, the committed ones are copied here first. `clear` empties the list; `inherit` drops this computer’s steps so the committed (or default) ones apply again. `list` is read-only and works from an agent turn.',
    tier: 'admin'
  },
  {
    path: ['repo', 'archive-steps'],
    group: 'repos',
    summary: 'The steps that run when a workspace is archived',
    usage: 'foreman repo archive-steps [list | add <name> <command> | remove <name|n> | move <n> <m> | clear | inherit] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'list (the default), add, remove, move, clear or inherit', choices: STEP_VERBS },
      { name: 'words', rest: true, help: 'add: the name then the command; remove: a name or number; move: two positions' }
    ],
    options: STEP_OPTIONS,
    examples: ['foreman repo archive-steps', 'foreman repo archive-steps add stop-db "docker compose down"'],
    exitCodes: { 6: 'clear or inherit without --yes and without a terminal to ask on' },
    details: 'The same verbs as `foreman repo setup`, for the steps that run before a workspace is archived.',
    tier: 'admin'
  },
  {
    path: ['repo', 'scripts'],
    group: 'repos',
    summary: 'The run scripts (buttons in the workspace’s Run menu)',
    usage: 'foreman repo scripts [list | add <name> <command> | remove <name> | set-default <name>] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'list (the default), add, remove or set-default', choices: ['list', 'add', 'remove', 'set-default'] },
      { name: 'words', rest: true, help: 'add: the name then the command; remove and set-default: the name' }
    ],
    options: {
      repo: REPO,
      icon: { type: 'string', value: '<icon>', help: 'add: the icon name' },
      default: { type: 'boolean', help: 'add: make it the default script' },
      hidden: { type: 'boolean', help: 'add: keep it out of the Run menu' },
      'preview-url': { type: 'string', value: '<url>', help: 'add: the URL its preview opens' }
    },
    examples: ['foreman repo scripts', 'foreman repo scripts add dev "npm run dev" --default --preview-url http://localhost:$FOREMAN_PORT', 'foreman repo scripts set-default dev'],
    details: '`list` is read-only and works from an agent turn.',
    tier: 'admin'
  },
  {
    path: ['repo', 'checks'],
    group: 'repos',
    summary: 'The commands that count as this repository’s checks',
    usage: 'foreman repo checks [list | add <name> <command> | remove <name>] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'list (the default), add or remove', choices: ['list', 'add', 'remove'] },
      { name: 'words', rest: true, help: 'add: the name then the command; remove: the name' }
    ],
    options: { repo: REPO },
    examples: ['foreman repo checks', 'foreman repo checks add test "npm test"', 'foreman repo checks remove lint'],
    details: 'A new or changed command needs approval before it runs: see `foreman checks approve`. `list` is read-only and works from an agent turn.',
    tier: 'admin'
  },
  {
    path: ['checks', 'approve'],
    // Beside `checks` in the help, not under Repositories: it is the consent `foreman checks` asks for.
    group: 'work',
    summary: 'Approve the check commands a workspace would run, and run them',
    usage: 'foreman checks approve [<workspace>] [--yes]',
    args: [{ name: 'workspace', help: 'A name, id or branch from `foreman status`, or "." for the one you’re in' }],
    options: {},
    examples: ['foreman checks approve', 'foreman checks approve api --yes'],
    exitCodes: { 6: 'Not confirmed (no --yes and no terminal, or you answered no), or the commands changed since you read them', 8: 'No checks are configured' },
    details: 'Lists each command with its hash and whether it is approved, asks, then approves exactly the commands shown and starts the checks. If a command changes meanwhile nothing is approved.',
    tier: 'admin'
  },
  {
    path: ['repo', 'auto-review'],
    group: 'repos',
    summary: 'Review each agent turn automatically with a second agent',
    usage: 'foreman repo auto-review [status | on [--reviewer <agent> <model>] [--effort <e>] [--fast] [--exclude <glob>]... [--yes] | off] [--repo <name|path>]',
    args: [
      { name: 'verb', help: 'status (the default), on or off', choices: ['status', 'on', 'off'] },
      { name: 'model', help: 'on, after --reviewer <agent>: the reviewer’s model' }
    ],
    options: {
      repo: REPO,
      reviewer: { type: 'string', value: '<agent>', help: 'on: the reviewing agent; its model is the next word', default: 'the review model from Settings' },
      model: { type: 'string', value: '<model>', help: 'on: the reviewer’s model (instead of the word after the agent)' },
      effort: { type: 'string', value: '<e>', help: 'on: the reviewer’s effort level' },
      fast: { type: 'boolean', help: 'on: use the reviewer’s fast mode' },
      exclude: { type: 'string', multiple: true, value: '<glob>', help: 'on: skip turns that only touch files matching this' }
    },
    examples: ['foreman repo auto-review', 'foreman repo auto-review on --reviewer codex gpt-5 --exclude "docs/**" --yes', 'foreman repo auto-review off'],
    exitCodes: { 6: 'on without --yes and without a terminal to ask on, or the preview changed meanwhile' },
    details:
      'on prints what the Repository settings dialog shows (the reviewer, the exclusions and the fingerprint that consent covers), asks, then turns it on with exactly that. status and off need no confirmation; status is read-only and works from an agent turn.',
    tier: 'admin'
  },
  {
    path: ['repo', 'integrations'],
    group: 'repos',
    summary: 'Which GitHub, Linear and Slack connection this repository uses',
    usage: 'foreman repo integrations [--repo <name|path>] [--json]',
    args: [],
    options: { repo: REPO },
    examples: ['foreman repo integrations', 'foreman repo integrations --repo api --json'],
    details: 'Per service: the choice made here (default, off or a connection), the connection it resolves to, and any problem. Change the choice with `foreman repo settings set integrations.github-account <name|default|off>`.',
    tier: 'read'
  }
]
