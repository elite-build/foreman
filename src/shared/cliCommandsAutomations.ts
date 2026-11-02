// The declarative half of the loadout, model, agent, template, saved-command, schedule, integration, backup and data
// commands. Merged into COMMANDS by src/shared/cliCommands.ts; the functions
// that run them are in src/cli/commands/{agents,templates,schedules,integrations,data}.ts, keyed by the path joined
// with spaces. `foreman templates` itself (the list) is declared in cliCommands.ts and stays there. `agents key` and
// `cloud token` belong to the environment and cloud commands.
import { EFFORT_LEVELS } from './cli/agents'
import type { CommandSpec, OptionSpec } from './cliCommands'
import { SLACK_EVENTS } from './integrations'

const REPO: OptionSpec = { type: 'string', short: 'r', value: '<name|path>', help: 'Repository: a name, id or folder', default: 'the one you’re in' }
const EFFORT: OptionSpec = { type: 'string', value: '<level>', choices: EFFORT_LEVELS, help: 'Reasoning effort; the model’s own default when left out' }
const CONFIRM_EXIT = { 1: 'You answered no, so nothing changed', 6: 'Needs confirmation: run it in a terminal or add --yes' }
const RECURRENCES = ['once', 'hourly', 'daily', 'weekly', 'monthly'] as const

// ---- loadouts, review model, models, agents (section 6.3) ----

const LOADOUT_DETAILS = `Settings → Default models holds up to five loadouts. Slot 1 is the default for new chats; the others are what
\`foreman run --loadout n\` and the new-chat picker offer. The agent and model are checked against the agent
catalog and the model list Foreman has: \`foreman models\` prints the ids to copy. Without --effort the model's
default effort is used, as the picker does; changing only the effort or fast mode of a slot that already has
this model keeps the rest.`

const LOADOUT_OPTIONS: Record<string, OptionSpec> = {
  effort: EFFORT,
  fast: { type: 'boolean', help: 'Use fast mode (for models that have one)' },
  'no-fast': { type: 'boolean', help: 'Turn fast mode off' }
}

export const AGENT_COMMANDS: CommandSpec[] = [
  {
    path: ['loadouts'],
    group: 'settings',
    summary: 'List the default model loadouts',
    usage: 'foreman loadouts [list]',
    args: [{ name: 'list', help: 'Optional: listing is what the command does', choices: ['list'] }],
    options: {},
    examples: ['foreman loadouts', 'foreman loadouts --json'],
    details: LOADOUT_DETAILS,
    tier: 'read'
  },
  {
    path: ['loadouts', 'set'],
    group: 'settings',
    summary: 'Set one loadout slot',
    usage: 'foreman loadouts set <n> <agent> <model> [--effort e] [--fast|--no-fast]',
    args: [
      { name: 'n', required: true, help: 'The slot, from 1 (`foreman loadouts` lists them)' },
      { name: 'agent', required: true, help: 'An agent id: claude, codex, … (`foreman agents` lists them)' },
      { name: 'model', required: true, help: 'A model id (`foreman models <agent>` lists them)' }
    ],
    options: LOADOUT_OPTIONS,
    examples: ['foreman loadouts set 1 claude claude-opus-5-5 --effort high', 'foreman loadouts set 2 codex gpt-5.5 --fast'],
    details: LOADOUT_DETAILS,
    tier: 'admin'
  },
  {
    path: ['loadouts', 'add'],
    group: 'settings',
    summary: 'Add a loadout slot',
    usage: 'foreman loadouts add <agent> <model> [--effort e] [--fast|--no-fast]',
    args: [
      { name: 'agent', required: true, help: 'An agent id: claude, codex, …' },
      { name: 'model', required: true, help: 'A model id' }
    ],
    options: LOADOUT_OPTIONS,
    examples: ['foreman loadouts add claude claude-sonnet-5 --effort medium'],
    details: LOADOUT_DETAILS,
    tier: 'admin'
  },
  {
    path: ['loadouts', 'remove'],
    group: 'settings',
    summary: 'Remove a loadout slot',
    usage: 'foreman loadouts remove <n> [--yes]',
    args: [{ name: 'n', required: true, help: 'The slot, from 1' }],
    options: {},
    examples: ['foreman loadouts remove 3'],
    exitCodes: CONFIRM_EXIT,
    details: 'There always stays at least one slot. Later slots move up by one.',
    tier: 'admin'
  },
  {
    path: ['loadouts', 'move'],
    group: 'settings',
    summary: 'Move a loadout slot to another position',
    usage: 'foreman loadouts move <n> <m>',
    args: [
      { name: 'n', required: true, help: 'The slot to move' },
      { name: 'm', required: true, help: 'Where it goes' }
    ],
    options: {},
    examples: ['foreman loadouts move 3 1'],
    details: 'Moving a slot to position 1 makes it the default for new chats.',
    tier: 'admin'
  },
  {
    path: ['review-model'],
    group: 'settings',
    summary: 'Show or set the model that reviews changes',
    usage: 'foreman review-model [set <agent> <model> [--effort e] [--fast|--no-fast]]',
    args: [
      { name: 'verb', help: 'set, to change it; without it the current review model is printed', choices: ['set'] },
      { name: 'agent', help: 'With set: an agent id' },
      { name: 'model', help: 'With set: a model id' }
    ],
    options: LOADOUT_OPTIONS,
    examples: ['foreman review-model', 'foreman review-model set claude claude-opus-5-5 --effort high'],
    details: 'The review model is what auto review and `foreman git review` use (Settings → Default models). Printing it is a read; `set` changes setup, so it is refused from inside an agent turn.',
    tier: 'admin'
  },
  {
    path: ['models'],
    group: 'settings',
    summary: 'List the models the picker offers',
    usage: 'foreman models [<agent>] [--all]',
    args: [{ name: 'agent', help: 'Only this agent’s models' }],
    options: { all: { type: 'boolean', help: 'Include the models hidden from the picker, marked, with their context sizes' } },
    examples: ['foreman models', 'foreman models claude --all', 'foreman models --json'],
    details: 'Prints each agent’s models with their ids (the words `loadouts set` and `run --model` take), the efforts each offers and whether it has a fast mode.',
    tier: 'read'
  },
  {
    path: ['models', 'hide'],
    group: 'settings',
    summary: 'Hide models from the picker',
    usage: 'foreman models hide <agent> <model>...',
    args: [
      { name: 'agent', required: true, help: 'An agent id' },
      { name: 'model', required: true, rest: true, help: 'Model ids to hide' }
    ],
    options: {},
    examples: ['foreman models hide claude claude-haiku-4-5'],
    details: 'Settings → Agents → Hidden models. A hidden model that a loadout or a template still uses keeps working; the command says which.',
    tier: 'admin'
  },
  {
    path: ['models', 'show'],
    group: 'settings',
    summary: 'Show hidden models in the picker again',
    usage: 'foreman models show <agent> <model>...',
    args: [
      { name: 'agent', required: true, help: 'An agent id' },
      { name: 'model', required: true, rest: true, help: 'Model ids to show' }
    ],
    options: {},
    examples: ['foreman models show claude claude-haiku-4-5'],
    tier: 'admin'
  },
  {
    path: ['models', 'refresh'],
    group: 'settings',
    summary: 'Fetch the model lists again',
    usage: 'foreman models refresh [<agent>]',
    args: [{ name: 'agent', help: 'Only this agent; otherwise every agent' }],
    options: {},
    examples: ['foreman models refresh', 'foreman models refresh claude'],
    tier: 'admin'
  },
  {
    path: ['agents'],
    group: 'settings',
    summary: 'List the agents: installed, signed in, enabled',
    usage: 'foreman agents [--refresh]',
    args: [],
    options: { refresh: { type: 'boolean', help: 'Look at the computer again for installed agents' } },
    examples: ['foreman agents', 'foreman agents --refresh --json'],
    details: 'Prints each agent in the catalog with whether it is enabled, installed (and its version), how it signs in (login or API key) and the program path it runs.',
    tier: 'read'
  },
  {
    path: ['agents', 'enable'],
    group: 'settings',
    summary: 'Offer an agent in the pickers',
    usage: 'foreman agents enable <id>',
    args: [{ name: 'id', required: true, help: 'An agent id (`foreman agents` lists them)' }],
    options: {},
    examples: ['foreman agents enable codex'],
    tier: 'admin'
  },
  {
    path: ['agents', 'disable'],
    group: 'settings',
    summary: 'Stop offering an agent in the pickers',
    usage: 'foreman agents disable <id>',
    args: [{ name: 'id', required: true, help: 'An agent id' }],
    options: {},
    examples: ['foreman agents disable codex'],
    details: 'Refused with the slot number while a loadout uses the agent.',
    tier: 'admin'
  },
  {
    path: ['agents', 'auth'],
    group: 'settings',
    summary: 'Choose how an agent signs in',
    usage: 'foreman agents auth <id> login|api-key',
    args: [
      { name: 'id', required: true, help: 'An agent id' },
      { name: 'mode', required: true, help: 'login: the agent’s own sign-in; api-key: the key saved in Foreman', choices: ['login', 'api-key'] }
    ],
    options: {},
    examples: ['foreman agents auth claude api-key'],
    details: 'This only chooses the method. The key itself is saved with `foreman agents key`.',
    tier: 'admin'
  },
  {
    path: ['agents', 'path'],
    group: 'settings',
    summary: 'Set the program an agent runs',
    usage: 'foreman agents path <id> [<exe>|--clear]',
    args: [
      { name: 'id', required: true, help: 'An agent id' },
      { name: 'exe', help: 'A command name or a path (a relative path is taken from where you run it)' }
    ],
    options: { clear: { type: 'boolean', help: 'Go back to the one found on PATH' } },
    examples: ['foreman agents path codex /opt/codex/bin/codex', 'foreman agents path codex --clear'],
    tier: 'admin'
  },
  {
    path: ['agents', 'status'],
    group: 'settings',
    summary: 'Check an agent: installed, ready, signed in',
    usage: 'foreman agents status <id>',
    args: [{ name: 'id', required: true, help: 'An agent id' }],
    options: {},
    examples: ['foreman agents status claude'],
    details: 'Runs Foreman’s own readiness check and the agent’s sign-in command where it has one.',
    tier: 'admin'
  }
]

// ---- templates (section 6.6) ----

const TEMPLATE_BODY: Record<string, OptionSpec> = {
  file: { type: 'string', value: '<file>', help: 'Read the prompt from a file (relative paths are taken from where you run it)' },
  stdin: { type: 'boolean', help: 'Read the prompt from standard input' }
}

const TEMPLATE_MODEL: Record<string, OptionSpec> = {
  agent: { type: 'string', value: '<id>', help: 'Start workspaces from this template with this agent (needs --model)' },
  model: { type: 'string', value: '<id>', help: 'The start model (needs --agent)' },
  effort: EFFORT,
  'follow-up': { type: 'string', value: '<title>', help: 'A follow-up button’s title (needs --follow-up-prompt, or an existing follow-up)' },
  'follow-up-prompt': { type: 'string', value: '<text>', help: 'What the follow-up sends' }
}

const TEMPLATE_DETAILS = `A template is a prompt with optional {{placeholders}} that \`foreman run <template> <values…>\` fills in order.
Its start model (--agent and --model) is what a new workspace opens with; a follow-up is the button offered when
a turn ends. Templates a repository keeps in .foreman/templates are read-only here: change the file instead.
Changing a template's text pauses the schedules that run it until you approve them again.`

export const TEMPLATE_COMMANDS: CommandSpec[] = [
  {
    path: ['templates', 'show'],
    group: 'settings',
    summary: 'Print a template’s prompt, placeholders and start model',
    usage: 'foreman templates show <template>',
    args: [{ name: 'template', required: true, help: 'A template’s slug, name or id (`foreman templates` lists them)' }],
    options: {},
    examples: ['foreman templates show fix-a-bug', 'foreman templates show fix-a-bug --json'],
    tier: 'read'
  },
  {
    path: ['templates', 'add'],
    group: 'settings',
    summary: 'Save a new template',
    usage: 'foreman templates add <name> [--file f|--stdin] [--agent a --model m [--effort e]] [--follow-up "title" --follow-up-prompt "…"]',
    args: [{ name: 'name', required: true, help: 'The template’s name; `foreman run` takes its slug' }],
    options: { ...TEMPLATE_BODY, ...TEMPLATE_MODEL },
    examples: ['foreman templates add fix-a-bug --file prompts/fix.md', 'cat prompt.md | foreman templates add review-pr --stdin --agent claude --model claude-opus-5-5'],
    details: TEMPLATE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['templates', 'edit'],
    group: 'settings',
    summary: 'Change a template',
    usage: 'foreman templates edit <template> [--name n] [--file f|--stdin] [--agent a --model m] [--clear-start-model]',
    args: [{ name: 'template', required: true, help: 'A template’s slug, name or id' }],
    options: {
      name: { type: 'string', value: '<name>', help: 'A new name' },
      ...TEMPLATE_BODY,
      ...TEMPLATE_MODEL,
      'clear-start-model': { type: 'boolean', help: 'Remove the start model' },
      'clear-follow-up': { type: 'boolean', help: 'Remove the follow-up' }
    },
    examples: ['foreman templates edit fix-a-bug --file prompts/fix.md', 'foreman templates edit fix-a-bug --clear-start-model'],
    details: TEMPLATE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['templates', 'remove'],
    group: 'settings',
    summary: 'Delete a template',
    usage: 'foreman templates remove <template> [--yes]',
    args: [{ name: 'template', required: true, help: 'A template’s slug, name or id' }],
    options: {},
    examples: ['foreman templates remove fix-a-bug --yes'],
    exitCodes: CONFIRM_EXIT,
    details: 'Repository templates (.foreman/templates) are read-only here: the command refuses and names the file. Schedules that run the template pause when it is removed.',
    tier: 'admin'
  }
]

// ---- saved commands ----

export const SAVED_COMMAND_COMMANDS: CommandSpec[] = [
  {
    path: ['commands'],
    group: 'settings',
    summary: 'List saved commands (Automations → Commands)',
    usage: 'foreman commands [list] [--repo r]',
    args: [{ name: 'list', help: 'Optional: listing is what the command does', choices: ['list'] }],
    options: { repo: { ...REPO, help: 'The repository whose commands to list with yours', default: 'the one you’re in, else every personal command' } },
    examples: ['foreman commands', 'foreman commands --repo api --json'],
    details: 'Lists your personal commands and the ones the repository shares in .foreman/settings.toml, with whether this computer approved each shared one.',
    tier: 'read'
  },
  {
    path: ['commands', 'add'],
    group: 'settings',
    summary: 'Save a command for the workspace Run menu',
    usage: 'foreman commands add <name> <command> [--repo r|--all] [--start-in dir]',
    args: [
      { name: 'name', required: true, help: 'What the Run menu calls it' },
      { name: 'command', required: true, help: 'The command line to type into a terminal (quote it)' }
    ],
    options: {
      repo: { ...REPO, help: 'The repository it is for' },
      all: { type: 'boolean', help: 'Offer it in every repository' },
      'start-in': { type: 'string', value: '<dir>', help: 'A folder inside the workspace to start in' }
    },
    examples: ['foreman commands add "Start dev" "npm run dev" --start-in web', 'foreman commands add Lint "npm run lint" --all'],
    details: 'Without --all the command is for the repository you are in (or --repo).',
    tier: 'admin'
  },
  {
    path: ['commands', 'edit'],
    group: 'settings',
    summary: 'Change a saved command',
    usage: 'foreman commands edit <id> [--name n] [--command c] [--scope repo|all] [--repo r] [--start-in dir|--clear-start-in]',
    args: [{ name: 'id', required: true, help: 'A command’s id or name (`foreman commands` lists them)' }],
    options: {
      name: { type: 'string', value: '<name>', help: 'A new name' },
      command: { type: 'string', value: '<line>', help: 'A new command line' },
      scope: { type: 'string', value: '<repo|all>', choices: ['repo', 'all'], help: 'Move it to one repository (with --repo, or the one you are in) or to all of them' },
      repo: { ...REPO, help: 'The repository the command is in, or moves to' },
      'start-in': { type: 'string', value: '<dir>', help: 'A folder inside the workspace to start in' },
      'clear-start-in': { type: 'boolean', help: 'Start in the workspace folder again' }
    },
    examples: ['foreman commands edit dev --command "npm run dev -- --port 4000"'],
    details: 'Only your own commands change here; a repository’s shared commands are edited in its .foreman/settings.toml.',
    tier: 'admin'
  },
  {
    path: ['commands', 'remove'],
    group: 'settings',
    summary: 'Delete a saved command',
    usage: 'foreman commands remove <id> [--repo r] [--yes]',
    args: [{ name: 'id', required: true, help: 'A command’s id or name' }],
    options: { repo: { ...REPO, help: 'The repository the command is in' } },
    examples: ['foreman commands remove dev --yes'],
    exitCodes: CONFIRM_EXIT,
    tier: 'admin'
  },
  {
    path: ['commands', 'approve'],
    group: 'settings',
    summary: 'Approve a command the repository shares',
    usage: 'foreman commands approve <id> [<workspace>] [--yes]',
    args: [
      { name: 'id', required: true, help: 'The shared command’s id or name (`foreman commands --repo r` lists them)' },
      { name: 'workspace', help: 'The workspace whose Run menu would offer it: a name, id or branch (default: . , the one you’re in)' }
    ],
    options: {},
    examples: ['foreman commands approve dev api-hotfix'],
    exitCodes: CONFIRM_EXIT,
    details: `A command from .foreman/settings.toml runs only after you approve its text on this computer. The command prints the
text it would approve (and the text approved before, when it changed), asks, and approves exactly that text: if the
repository's file changed meanwhile, nothing is approved. Run menus type the command into a terminal.`,
    tier: 'admin'
  }
]

// ---- schedules ----

const SCHEDULE_OPTIONS: Record<string, OptionSpec> = {
  repo: { ...REPO, help: 'The repository each run works in' },
  every: { type: 'string', value: '<cadence>', choices: RECURRENCES, help: 'once, hourly, daily, weekly or monthly' },
  on: { type: 'string', value: '<days>', help: 'Weekly: the days, comma separated: mon,wed or weekdays (0 is Sunday)', default: 'the start date’s weekday' },
  'day-of-month': { type: 'string', value: '<n>', help: 'Monthly: the day, 1 to 31 (the last day in shorter months)', default: 'the start date’s day' },
  at: { type: 'string', value: '<HH:MM>', help: 'Time of day, 24 hour, in the time zone' },
  tz: { type: 'string', value: '<zone>', help: 'An IANA zone, like Europe/London', default: 'this computer’s' },
  start: { type: 'string', value: '<YYYY-MM-DD>', help: 'The first date it may run, in the zone', default: 'today there' },
  base: { type: 'string', value: '<branch>', help: 'The branch each run starts from', default: 'the repository’s base branch' },
  model: { type: 'string', value: '<id>', help: 'A Claude model id', default: 'a Sonnet from the picker' },
  'max-minutes': { type: 'string', value: '<n>', help: 'Stop a run after n minutes, 5 to 480', default: '30' }
}

/** What add, edit and approve print before they save anything; shown in the help so nobody has to guess. */
export const FINGERPRINT_SAMPLE = `What add, edit and approve print before they save anything (the fingerprint block):

  Schedule “nightly-triage” (template revision 3fa91c2)
  Repository: api, each run starts from main in a fresh workspace
  Runs every day at 09:00 (Europe/London), from 2026-10-26
  Next: Mon 26 Oct 09:00; Tue 27 Oct 09:00; Wed 28 Oct 09:00
  Runs on: Claude · claude-sonnet-5, permission mode auto; a question or an approval stops the run and leaves it for you
  Limit: 30 minutes per run
  Setup script: npm ci
  Checks: lint (npm run lint), test (npm test)
  Repository MCP servers: (none)`

const SCHEDULE_DETAILS = `A schedule starts a workspace from a template in a repository at a time. Saving it approves what it will run: the
template's text, the repository's setup script, its checks and its MCP servers. add and edit print that (the
fingerprint block below) and save only after you answer yes in a terminal or pass --yes; what you confirm is exactly
what is saved, and the app refuses if the setup, checks or template changed meanwhile. A change to any of them later
pauses the schedule until \`foreman schedules approve <id>\`. Runs happen only while Foreman is open; a late run is
skipped, never replayed; two failed runs in a row pause the schedule.

A scheduled run can't ask for values, so the template must have no {{placeholders}}: \`foreman templates edit\` writes
them out. \`schedules add\` takes no values for that reason.

${FINGERPRINT_SAMPLE}`

export const SCHEDULE_COMMANDS: CommandSpec[] = [
  {
    path: ['schedules'],
    group: 'settings',
    summary: 'List schedules (Automations → Schedules)',
    usage: 'foreman schedules [list]',
    args: [{ name: 'list', help: 'Optional: listing is what the command does', choices: ['list'] }],
    options: {},
    examples: ['foreman schedules', 'foreman schedules --json'],
    details: 'Prints each schedule’s id, template, repository, cadence, and its next run, paused reason or running occurrences.',
    tier: 'read'
  },
  {
    path: ['schedules', 'preview'],
    group: 'settings',
    summary: 'Show what a schedule would approve and when it would run, without saving',
    usage: 'foreman schedules preview <template> --every cadence --at HH:MM [--repo r] [--on days] [--day-of-month n] [--tz zone] [--start date] [--base b] [--model m] [--max-minutes n]',
    args: [{ name: 'template', required: true, help: 'A template’s slug, name or id; it must have no {{placeholders}}' }],
    options: SCHEDULE_OPTIONS,
    examples: ['foreman schedules preview nightly-triage --repo api --every daily --at 09:00'],
    details: SCHEDULE_DETAILS,
    tier: 'read'
  },
  {
    path: ['schedules', 'add'],
    group: 'settings',
    summary: 'Schedule a template to start a workspace',
    usage: 'foreman schedules add <template> --repo r --every cadence --at HH:MM [--on days] [--day-of-month n] [--tz zone] [--start date] [--base b] [--model m] [--max-minutes n] [--yes]',
    args: [{ name: 'template', required: true, help: 'A template’s slug, name or id; it must have no {{placeholders}}' }],
    options: SCHEDULE_OPTIONS,
    examples: [
      'foreman schedules add nightly-triage --repo api --every daily --at 09:00 --tz Europe/London',
      'foreman schedules add weekly-deps --repo api --every weekly --on mon,thu --at 08:30 --yes',
      'foreman schedules add release-notes --repo api --every monthly --day-of-month 1 --at 10:00'
    ],
    exitCodes: CONFIRM_EXIT,
    details: SCHEDULE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['schedules', 'edit'],
    group: 'settings',
    summary: 'Change a schedule',
    usage: 'foreman schedules edit <id> [--template t] [--repo r] [--every cadence] [--on days] [--day-of-month n] [--at HH:MM] [--tz zone] [--start date] [--base b] [--model m] [--max-minutes n] [--yes]',
    args: [{ name: 'id', required: true, help: 'A schedule’s id (four characters or more) or its template’s name' }],
    options: { template: { type: 'string', value: '<t>', help: 'Run this template instead' }, ...SCHEDULE_OPTIONS },
    examples: ['foreman schedules edit 4f2a --at 10:30', 'foreman schedules edit nightly-triage --every weekly --on weekdays --yes'],
    exitCodes: CONFIRM_EXIT,
    details: `Options you leave out keep the schedule's values. ${SCHEDULE_DETAILS}`,
    tier: 'admin'
  },
  {
    path: ['schedules', 'approve'],
    group: 'settings',
    summary: 'Approve a schedule that paused because its setup changed',
    usage: 'foreman schedules approve <id> [--yes]',
    args: [{ name: 'id', required: true, help: 'A schedule’s id or its template’s name' }],
    options: {},
    examples: ['foreman schedules approve 4f2a'],
    exitCodes: CONFIRM_EXIT,
    details: `Prints what changed since you approved it (the template, the setup script, the checks or the MCP servers) and what it would run now,
asks, and approves exactly that. If something changes again meanwhile, nothing is approved.

${FINGERPRINT_SAMPLE}`,
    tier: 'admin'
  },
  {
    path: ['schedules', 'pause'],
    group: 'settings',
    summary: 'Pause a schedule',
    usage: 'foreman schedules pause <id>',
    args: [{ name: 'id', required: true, help: 'A schedule’s id or its template’s name' }],
    options: {},
    examples: ['foreman schedules pause 4f2a'],
    tier: 'admin'
  },
  {
    path: ['schedules', 'resume'],
    group: 'settings',
    summary: 'Resume a paused schedule',
    usage: 'foreman schedules resume <id>',
    args: [{ name: 'id', required: true, help: 'A schedule’s id or its template’s name' }],
    options: {},
    examples: ['foreman schedules resume 4f2a'],
    details: 'A schedule paused because its setup changed needs `foreman schedules approve` first.',
    tier: 'admin'
  },
  {
    path: ['schedules', 'remove'],
    group: 'settings',
    summary: 'Delete a schedule and its run history',
    usage: 'foreman schedules remove <id> [--yes]',
    args: [{ name: 'id', required: true, help: 'A schedule’s id or its template’s name' }],
    options: {},
    examples: ['foreman schedules remove 4f2a --yes'],
    exitCodes: CONFIRM_EXIT,
    details: 'Refused while a run is going: stop it with `foreman schedules stop-run` first.',
    tier: 'admin'
  },
  {
    path: ['schedules', 'runs'],
    group: 'settings',
    summary: 'List scheduled runs, newest first',
    usage: 'foreman schedules runs [<id>]',
    args: [{ name: 'id', help: 'Only this schedule’s runs (id or template name)' }],
    options: {},
    examples: ['foreman schedules runs', 'foreman schedules runs nightly-triage --json'],
    details: 'Shows the 20 newest runs with their outcome, how long they took, the workspace they made and its pull request.',
    tier: 'read'
  },
  {
    path: ['schedules', 'stop-run'],
    group: 'settings',
    summary: 'Stop a scheduled run that is going',
    usage: 'foreman schedules stop-run <occurrence>',
    args: [{ name: 'occurrence', required: true, help: 'A run’s id from `foreman schedules runs` (four characters or more)' }],
    options: {},
    examples: ['foreman schedules stop-run 9c1d'],
    tier: 'admin'
  }
]

// ---- integrations ----

const SERVICES = ['github', 'linear', 'slack', 'langfuse', 'vercel', 'e2b', 'daytona', 'docker'] as const

const CONNECTION_DETAILS = `A connection is an account Foreman signs in to: GitHub, Linear, Slack, Langfuse, or a sandbox service for remote workspaces
(Vercel, E2B, Daytona, Docker). Secrets are never arguments: a token comes from standard input (--token-stdin) or
from a prompt that does not echo it, and never comes back in any output (at most its last four characters).

  github   --gh-account <login> (a \`gh\` account), --gh-active (whichever is active now), or a token
  linear   a Linear API key
  slack    a bot token (xoxb-…)
  langfuse a project's secret key (sk-lf-…), --public-key (pk-lf-…); --host (default https://cloud.langfuse.com)
  vercel   a token, --team-id and --project-id
  e2b      an API key; --domain for a self-hosted domain
  daytona  an API key; --api-url (default https://app.daytona.io/api), --target
  docker   no token: --context or --host, or the current context`

export const INTEGRATION_COMMANDS: CommandSpec[] = [
  {
    path: ['connections'],
    group: 'settings',
    summary: 'List the integrations: id, service, account, default, problem',
    usage: 'foreman connections [list]',
    args: [{ name: 'list', help: 'Optional: listing is what the command does', choices: ['list'] }],
    options: {},
    examples: ['foreman connections', 'foreman connections --json'],
    details: 'Settings → Integrations. The id (or its first characters, or the name) is what the other connection commands take.',
    tier: 'read'
  },
  {
    path: ['connections', 'add'],
    group: 'settings',
    summary: 'Connect an account',
    usage: 'foreman connections add github|linear|slack|langfuse|vercel|e2b|daytona|docker [--label name] [--token-stdin] [--default] […]',
    args: [{ name: 'service', required: true, help: 'The service to connect', choices: SERVICES }],
    options: {
      label: { type: 'string', value: '<name>', help: 'What to call it', default: 'the account’s name' },
      'token-stdin': { type: 'boolean', help: 'Read the token from standard input (without it a terminal gets a prompt that does not echo)' },
      'gh-account': { type: 'string', value: '<login>', help: 'github: sign in as this `gh` account' },
      'gh-active': { type: 'boolean', help: 'github: sign in as whichever `gh` account is active now' },
      'team-id': { type: 'string', value: '<id>', help: 'vercel: the team id (team_…)' },
      'project-id': { type: 'string', value: '<id>', help: 'vercel: the project id (prj_…)' },
      domain: { type: 'string', value: '<domain>', help: 'e2b: a self-hosted domain' },
      'api-url': { type: 'string', value: '<url>', help: 'daytona: the API URL' },
      target: { type: 'string', value: '<region>', help: 'daytona: the target region' },
      context: { type: 'string', value: '<name>', help: 'docker: a Docker context' },
      host: { type: 'string', value: '<url>', help: 'docker: a host, like ssh://user@host; langfuse: its address, like https://us.cloud.langfuse.com' },
      'public-key': { type: 'string', value: '<pk-lf-…>', help: 'langfuse: the public key that goes with the secret key' },
      'agent-access': { type: 'string', value: '<level>', choices: ['off', 'read', 'write'], help: 'linear, langfuse (off or read): what agents may do with it', default: 'read' },
      default: { type: 'boolean', help: 'Make it the service’s default connection' },
      'allow-duplicate': { type: 'boolean', help: 'Add it although a connection to the same account exists' }
    },
    examples: [
      'foreman connections add github --gh-account octocat --label Work',
      'printf %s "$LINEAR_API_KEY" | foreman connections add linear --token-stdin --label Acme',
      'printf %s "$LANGFUSE_SECRET_KEY" | foreman connections add langfuse --public-key "$LANGFUSE_PUBLIC_KEY" --token-stdin --label Kite',
      'foreman connections add vercel --team-id team_123 --project-id prj_456 --token-stdin',
      'foreman connections add docker --context colima'
    ],
    details: CONNECTION_DETAILS,
    tier: 'admin',
    noAssistant: 'it reads a secret; type it yourself'
  },
  {
    path: ['connections', 'check'],
    group: 'settings',
    summary: 'Test a connection’s sign-in',
    usage: 'foreman connections check <id>',
    args: [{ name: 'id', required: true, help: 'A connection’s id, the start of it, or its name' }],
    options: {},
    examples: ['foreman connections check work'],
    exitCodes: { 1: 'The connection has a problem' },
    details: 'Asks the service again who the connection is signed in as, and reports a problem when it can’t.',
    tier: 'admin'
  },
  {
    path: ['connections', 'remove'],
    group: 'settings',
    summary: 'Remove a connection and its saved token',
    usage: 'foreman connections remove <id> [--yes]',
    args: [{ name: 'id', required: true, help: 'A connection’s id, the start of it, or its name' }],
    options: {},
    examples: ['foreman connections remove acme --yes'],
    exitCodes: CONFIRM_EXIT,
    details: 'First prints what removing affects: the repositories that use it, whether it is the default and the Slack rules that send through it. Then asks; the saved token is deleted from this computer.',
    tier: 'admin'
  },
  {
    path: ['connections', 'default'],
    group: 'settings',
    summary: 'Choose a service’s default connection',
    usage: 'foreman connections default <service> <id|none>',
    args: [
      { name: 'service', required: true, help: 'github, linear, slack, langfuse, vercel, e2b, daytona or docker', choices: SERVICES },
      { name: 'id', required: true, help: 'A connection of that service, or none' }
    ],
    options: {},
    examples: ['foreman connections default github work', 'foreman connections default slack none'],
    tier: 'admin'
  },
  {
    path: ['connections', 'edit'],
    group: 'settings',
    summary: 'Change what agents may do with a connection, and whether new workspaces start with it',
    usage: 'foreman connections edit <id> [--agent-access level] [--new-workspaces on|off]',
    args: [{ name: 'id', required: true, help: 'A connection’s id, the start of it, or its name' }],
    options: {
      'agent-access': { type: 'string', value: '<level>', choices: ['off', 'read', 'write'], help: 'linear: off, read or write; slack: off or write (post to allowed channels); langfuse: off or read' },
      'new-workspaces': { type: 'string', value: '<on|off>', choices: ['on', 'off'], help: 'linear, slack, langfuse: whether new workspaces start with its tools on (a repository can override it)' }
    },
    examples: ['foreman connections edit acme --new-workspaces off', 'foreman connections edit 3f2a --agent-access write'],
    details: '--new-workspaces off keeps its tools out of new workspaces (and their context) until a workspace switches it on: in New workspace, the composer, `foreman run --with`, or `foreman workspace integrations --on`. It never changes what agents may do; --agent-access does.',
    tier: 'admin'
  },
  {
    path: ['connections', 'apply'],
    group: 'settings',
    summary: 'Use a connection in repositories',
    usage: 'foreman connections apply <id> --repos a,b [--replace]',
    args: [{ name: 'id', required: true, help: 'A connection’s id, the start of it, or its name' }],
    options: {
      repos: { type: 'string', value: '<a,b>', help: 'Repositories (names, ids or folders), comma separated' },
      replace: { type: 'boolean', help: 'Make these the only repositories that choose it, as the window’s “Use in repositories…” does; by default they are added' }
    },
    examples: ['foreman connections apply work --repos api,web'],
    tier: 'admin'
  },
  {
    path: ['slack', 'rules'],
    group: 'settings',
    summary: 'List, add, remove or consent to Slack notification rules',
    usage: 'foreman slack rules [list|add|remove <id>|consent <id>] [--event e --recipient me|reviewer|channel …]',
    args: [
      { name: 'verb', help: 'list (the default), add, remove or consent', choices: ['list', 'add', 'remove', 'consent'] },
      { name: 'id', help: 'remove and consent: the rule’s id (or the start of it)' }
    ],
    options: {
      connection: { type: 'string', value: '<id|name>', help: 'add: the Slack connection', default: 'the default Slack connection' },
      event: { type: 'string', value: '<event>', choices: SLACK_EVENTS, help: 'add: what happens' },
      recipient: { type: 'string', value: '<who>', choices: ['me', 'reviewer', 'channel'], help: 'add: who is told', default: 'the first the event allows' },
      channel: { type: 'string', value: '<name>', help: 'add, with --recipient channel: one of the connection’s channels' },
      repos: { type: 'string', value: '<a,b>', help: 'add: repository names, comma separated', default: 'every repository that uses the connection' },
      template: { type: 'string', value: '<text>', help: 'add: the message text', default: 'the event’s default message' },
      mode: { type: 'string', value: '<mode>', choices: ['ask', 'auto'], help: 'add: ask before sending, or send (auto is kept only for messages to yourself, or after `consent`)', default: 'ask' },
      'away-only': { type: 'boolean', help: 'add, agent events: only while you are away from this Mac' },
      disabled: { type: 'boolean', help: 'add: save it switched off' }
    },
    examples: ['foreman slack rules', 'foreman slack rules add --event pr-ready --recipient channel --channel eng-reviews --repos api', 'foreman slack rules consent 3fa91c2b'],
    exitCodes: CONFIRM_EXIT,
    details: `Rules decide which GitHub and agent events send a Slack message and to whom. Messages to other people ask first
in the app unless the rule has your consent; \`consent\` prints exactly what would go out, and to whom, and asks.
The consent covers the rule as it is: changing any part of it asks again.`,
    tier: 'admin'
  },
  {
    path: ['slack', 'people'],
    group: 'settings',
    summary: 'List, link or unlink GitHub logins and Slack users',
    usage: 'foreman slack people [list|link <gh> <slack-id>|unlink <gh>] [--team t] [--name n]',
    args: [
      { name: 'verb', help: 'list (the default), link or unlink', choices: ['list', 'link', 'unlink'] },
      { name: 'github', help: 'link, unlink: the GitHub login' },
      { name: 'slack-id', help: 'link: the Slack user’s id (U…)' }
    ],
    options: {
      team: { type: 'string', value: '<T…>', help: 'The Slack workspace’s id', default: 'the only connected one' },
      name: { type: 'string', value: '<name>', help: 'link: the name to show for them', default: 'the Slack id' }
    },
    examples: ['foreman slack people', 'foreman slack people link octocat U012ABC --team T012XYZ --name "Octo Cat"'],
    details: 'Linked people are who a review request or mention goes to in Slack.',
    tier: 'admin'
  },
  {
    path: ['slack', 'deliveries'],
    group: 'settings',
    summary: 'List the Slack messages Foreman sent or is holding',
    usage: 'foreman slack deliveries [--connection c]',
    args: [],
    options: { connection: { type: 'string', value: '<id|name>', help: 'Only this Slack connection’s', default: 'all' } },
    examples: ['foreman slack deliveries', 'foreman slack deliveries --connection acme --json'],
    details: 'Each row has an id: `slack answer <id> send|skip` answers one waiting for you, `slack resend <id>` sends one again.',
    tier: 'admin'
  },
  {
    path: ['slack', 'answer'],
    group: 'settings',
    summary: 'Send or skip a Slack message that is waiting for you',
    usage: 'foreman slack answer <id> send|skip [--text t]',
    args: [
      { name: 'id', required: true, help: 'A delivery from `foreman slack deliveries` (or the start of its id)' },
      { name: 'action', required: true, help: 'send it, or skip it', choices: ['send', 'skip'] }
    ],
    options: { text: { type: 'string', value: '<message>', help: 'send: the message to send instead of the drafted one' } },
    examples: ['foreman slack answer 7be1 send', 'foreman slack answer 7be1 send --text "Ready for review: PR 42"', 'foreman slack answer 7be1 skip'],
    tier: 'admin'
  },
  {
    path: ['slack', 'resend'],
    group: 'settings',
    summary: 'Send a Slack message again',
    usage: 'foreman slack resend <id>',
    args: [{ name: 'id', required: true, help: 'A delivery from `foreman slack deliveries`' }],
    options: {},
    examples: ['foreman slack resend 7be1'],
    tier: 'admin'
  },
  {
    path: ['linear', 'issues'],
    group: 'settings',
    summary: 'List the Linear issues assigned to you for a repository',
    usage: 'foreman linear issues [--repo r]',
    args: [],
    options: { repo: REPO },
    examples: ['foreman linear issues', 'foreman linear issues --repo api --json'],
    details: 'Uses the repository’s Linear connection. Each issue shows its identifier (the word `foreman run fix-linear-bug ENG-123` takes), team, state, priority and branch name.',
    tier: 'admin'
  }
]

// ---- backups, data, usage ----

const BACKUP_DETAILS = `The database holds your chats and records. \`backup now\` writes a copy (with the attachments) to the backup folder;
\`backup status\` (the default) says where the database and the backups are, how big they are, and when the last
backup was made.`

const GIT_BACKUP_DETAILS = `Git backup keeps your settings, templates, repository list and workspaces in a Git repository you choose, so another
computer can restore them. It never includes secrets: a restore lists the environment variables to set again.

  status                          Whether it is set up, the last backup and the last error
  configure <remote> [--account a] [--daily|--no-daily]
                                  Choose the remote (a Git URL; the user name and password never print) and whether it
                                  backs up once a day while Foreman is open
  create-repo <name> [--account a]
                                  Create a private GitHub repository and set it up
  now                             Push a backup now
  preview <remote>                What restoring would change here, without changing anything
  restore <remote> [--categories settings,templates,repos,workspaces]
                                  Shows the preview, asks, then restores exactly that preview

Restoring overwrites the settings and templates you pick on this computer, so it asks and is refused from inside an agent turn.`

export const DATA_COMMANDS: CommandSpec[] = [
  {
    path: ['backup'],
    group: 'settings',
    summary: 'Back up the database, or show its backup status',
    usage: 'foreman backup [now|status]',
    args: [{ name: 'verb', help: 'now, to back up; status (the default) to look', choices: ['now', 'status'] }],
    options: {},
    examples: ['foreman backup', 'foreman backup now'],
    details: BACKUP_DETAILS,
    tier: 'admin'
  },
  {
    path: ['git-backup'],
    group: 'settings',
    summary: 'Back up and restore your configuration through a Git repository',
    usage: 'foreman git-backup [status|configure <remote>|create-repo <name>|now|preview <remote>|restore <remote>] [options]',
    args: [
      { name: 'verb', help: 'status (the default), configure, create-repo, now, preview or restore', choices: ['status', 'configure', 'create-repo', 'now', 'preview', 'restore'] },
      { name: 'target', help: 'configure, preview, restore: the remote (a Git URL); create-repo: the new repository’s name' }
    ],
    options: {
      account: { type: 'string', value: '<login>', help: 'A signed-in `gh` account, for github.com remotes' },
      daily: { type: 'boolean', help: 'configure: back up once a day while Foreman is open' },
      'no-daily': { type: 'boolean', help: 'configure: stop the daily backup' },
      categories: { type: 'string', value: '<a,b>', help: 'restore: settings, templates, repos, workspaces', default: 'all four' }
    },
    examples: ['foreman git-backup', 'foreman git-backup create-repo foreman-backup', 'foreman git-backup configure git@github.com:me/foreman-backup.git --daily', 'foreman git-backup restore git@github.com:me/foreman-backup.git --categories settings,templates'],
    exitCodes: CONFIRM_EXIT,
    details: GIT_BACKUP_DETAILS,
    tier: 'admin',
    noAssistant: 'a restore overwrites settings and templates; run it yourself'
  },
  {
    path: ['data'],
    group: 'app',
    summary: 'Show where Foreman keeps its data',
    usage: 'foreman data [info]',
    args: [{ name: 'info', help: 'Optional: showing the data is what the command does', choices: ['info'] }],
    options: {},
    examples: ['foreman data', 'foreman data --json'],
    details: 'Prints the data folder, the database and its size, the backup folder and last backup, the Claude transcripts mirrored, and anything left over from before the database.',
    tier: 'read'
  },
  {
    path: ['data', 'delete-legacy'],
    group: 'app',
    summary: 'Delete the files left over from before the database',
    usage: 'foreman data delete-legacy [--yes]',
    args: [],
    options: {},
    examples: ['foreman data delete-legacy --yes'],
    exitCodes: CONFIRM_EXIT,
    details: 'Foreman moved your chats into a database; the old files stay until you delete them. It prints how many files and how much space, then asks.',
    tier: 'admin',
    noAssistant: 'it deletes files for good; run it yourself'
  },
  {
    path: ['usage'],
    group: 'app',
    summary: 'Show turns, agent time and cost by repository and model',
    usage: 'foreman usage [--days 7|30|90]',
    args: [],
    options: { days: { type: 'string', value: '<n>', help: 'The last n days (any whole number up to 366; the window offers 7, 30 and 90)', default: '30' } },
    examples: ['foreman usage', 'foreman usage --days 7 --json'],
    details: 'Costs are what the agents reported; turns with no reported cost make a figure a lower bound, shown with ≥.',
    tier: 'read'
  }
]

/** Every command of this file, in the order `foreman help` lists them. */
export const AUTOMATION_COMMANDS: CommandSpec[] = [...AGENT_COMMANDS, ...TEMPLATE_COMMANDS, ...SAVED_COMMAND_COMMANDS, ...SCHEDULE_COMMANDS, ...INTEGRATION_COMMANDS, ...DATA_COMMANDS]
