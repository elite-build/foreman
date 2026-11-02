// The declarative half of the operations commands for workspaces, chat tabs and approvals:
// `foreman new`, `workspace *` (alias `ws`), `tabs`, `tab *`, `chat`, `queue`, `rewind`, `resume-now`, `mcp`, `slash`,
// `search`, `approvals`, `approve`, `deny` and `stopped`. src/cli/commands/{workspace,tab,approvals}.ts attach the
// functions; cliCommands.ts spreads these arrays into COMMANDS.
import type { ArgSpec, CommandSpec, OptionSpec } from './cliCommands'

const WORKSPACE_ARG: ArgSpec = { name: 'workspace', required: true, help: 'A name, id or branch from `foreman status`, or "." for the one you’re in' }

const TAB_OPTION: OptionSpec = { type: 'string', short: 't', value: '<n>', help: 'Open tab, counting from 1', default: 'the only open tab' }

const BOARD_STATUSES = ['backlog', 'in-progress', 'in-review', 'done', 'canceled', 'none'] as const

const ARCHIVE_DETAILS = `foreman workspace archive first asks the app what archiving would do and prints it: the folder that
is removed (or stays, for a workspace added from disk or working in the repository folder),
tabs still running, uncommitted files (saved as a checkpoint first), commits not on the
remote, open terminals, Docker containers it would remove and the archive script. Then it
asks before doing it; --yes answers for you, and without a terminal and without --yes it
prints the preview and exits with code 6, having done nothing.

Archiving refuses while a tab is running unless --stop is given. --delete-branch also deletes
the branch. A failed checkpoint or archive script stops the archive before anything is deleted
(exit 1, with the step); --anyway carries on regardless. Progress is printed to stderr as each
step finishes. Unarchive brings the workspace back; forget deletes an archived one for good.`

const FORGET_DETAILS = `foreman workspace forget removes an archived workspace and its chats and records from Foreman for
good. It asks first (--yes answers for you). Archive the workspace first: forget refuses a live one.`

const NEW_DETAILS = `foreman new starts a workspace from the words you give it, with no template, the way the New
workspace dialog does. The repository is the one you're in unless --repo says otherwise; the
agent and model come from loadout slot 1 unless -l picks another. By default the branch is
new and named from the prompt: -b names it, --existing checks out a branch that already
exists in a new worktree, and --direct works in the repository folder on that branch. --attach
copies files into the first message (relative paths are taken from where you run it). --cloud
puts the worktree in a cloud sandbox (the repository's Remote settings apply).

Like foreman run, it waits for setup and prints the workspace, chat and turn ids; with --wait
it then blocks for the first turn's outcome, with the same exit codes as foreman run
(0 completed, 1 failed, 2 timed out, 3 setup held, 5 connection lost). From inside an agent
turn it needs the repository's "Let agents start workspaces and queue messages".`

const TAB_SET_DETAILS = `foreman tab set changes the tab's own settings, the same ones the composer's pickers change.
--agent switches the agent for that tab (with its default model unless --model says one) and
refuses while a turn is running. --model and --effort are checked against what the agent
lists. --plan, --auto-accept-edits and their --no- forms change what the agent may do without
asking, so they can't be used from inside an agent turn.`

const CHAT_DETAILS = `foreman chat prints a tab's conversation as text: who said what, each tool call on one line
(with --tool-output, its output too), notices, and how each turn ended. Each message shows its
turn id, which foreman tab fork --turn, foreman rewind --turn and --since take. --tail n keeps
the last n turns; --since <turn> keeps what came after that turn. With --json the items are the
chat's own records (no thinking; tool output only with --tool-output).`

const QUEUE_DETAILS = `The queue is the messages waiting behind a running turn. A message is named by its position
from 1 or its id (from \`list\`). move up sends it sooner. edit and move are checked against the
queue as it is when you run the command: when the queue changed meanwhile, or the message
already started, nothing changes and the command says so. steer delivers a queued message into
the running turn instead of waiting for it to end.`

const REWIND_DETAILS = `foreman rewind restores the tab to just before a turn: the files go back to the checkpoint
saved then and the conversation continues from there. Work done after that turn is lost, so
it asks first (--yes answers for you). Find the turn id with foreman chat.`

const APPROVE_DETAILS = `foreman approvals lists what agents are waiting on: a tool asking permission, a plan to review
or a question. approve and deny answer one by its id (or the start of it, four characters or
more). For a tool, --always or --edits give the "allow from now on" and "allow edits for the
session" answers, when that tool offers them. For a plan, --feedback adds a note, and deny sends
the plan back with --message as the feedback. For a question, give --answer "question=choice"
once per question (the question's text, header or position from 1); deny skips it.

Answering lets an agent act, so approve and deny are refused from inside an agent turn.`

const STOPPED_DETAILS = `When Foreman quits or crashes with turns running, they are listed here until you retry or
dismiss each. retry sends the turn's message again in its tab (it starts a turn, so from inside
an agent turn it needs the repository's "Let agents start workspaces and queue messages").
dismiss clears an entry without sending anything; --all clears every entry.`

export const WORKSPACE_COMMANDS: CommandSpec[] = [
  {
    path: ['new'],
    group: 'work',
    summary: 'Start a workspace from a prompt, without a template',
    usage: 'foreman new <prompt...> [options]',
    args: [{ name: 'prompt', required: true, rest: true, help: 'What to work on, in your own words (quote it, or put -- before text that starts with a dash)' }],
    options: {
      repo: { type: 'string', short: 'r', value: '<name|path>', help: 'Repository to start the workspace in', default: 'the one you’re in' },
      branch: { type: 'string', short: 'b', value: '<name>', help: 'Name for the new branch', default: 'named from the prompt' },
      existing: { type: 'string', value: '<branch>', help: 'Check out this existing branch in a new worktree' },
      direct: { type: 'string', value: '<branch>', help: 'Work in the repository folder itself, on this branch' },
      base: { type: 'string', value: '<branch>', help: 'Branch to start from', default: 'the repository’s base branch' },
      loadout: { type: 'string', short: 'l', value: '<n>', help: 'Agent and model from loadout slot n', default: '1' },
      attach: { type: 'string', multiple: true, value: '<file>', help: 'A file for the first message' },
      cloud: { type: 'boolean', help: 'Put the worktree in a cloud sandbox' },
      open: { type: 'boolean', short: 'o', help: 'Bring Foreman forward on the new workspace' },
      'start-anyway': { type: 'boolean', help: 'If setup fails, send the first message anyway' },
      'no-wait': { type: 'boolean', help: 'Return once the workspace exists, without waiting for setup' },
      wait: { type: 'boolean', help: 'Block until the first turn ends, and report how it went' },
      timeout: { type: 'string', value: '<s>', help: 'With --wait: stop waiting after s seconds' },
      with: { type: 'string', value: '<a,b>', help: 'Integrations to switch on in this workspace (linear, slack, langfuse), over the repository’s defaults' },
      without: { type: 'string', value: '<a,b>', help: 'Integrations to switch off in this workspace' }
    },
    examples: ['foreman new "Add a dark mode toggle to the settings page" --open', 'foreman new "Why did the eval scores drop?" --with linear', 'foreman new "Fix the flaky login test" -b fix-flaky-login --wait --timeout 1800', 'foreman new "Review this" --existing feature/search --attach notes.md'],
    exitCodes: { 0: 'Started (with --wait: the turn completed)', 1: 'Failed, or the turn failed, was stopped or was interrupted', 2: 'Usage error, or --wait timed out (the turn keeps running)', 3: 'Setup failed; the first message is held', 5: 'The connection to Foreman was lost (the turn is unaffected)' },
    details: NEW_DETAILS,
    tier: 'act'
  },
  {
    path: ['workspace', 'list'],
    group: 'workspaces',
    summary: 'List workspaces, or the archived ones',
    usage: 'foreman workspace list [--repo r] [--archived]',
    args: [],
    options: {
      repo: { type: 'string', short: 'r', value: '<name|path>', help: 'Only this repository’s workspaces' },
      archived: { type: 'boolean', help: 'The archived workspaces, with when and what they changed' }
    },
    examples: ['foreman ws list', 'foreman ws list --repo api --json', 'foreman ws list --archived'],
    details: 'Without --archived this is the table `foreman status` prints: the same groups as the sidebar, the latest turn, checks, what it changed and the pull request.',
    tier: 'read'
  },
  {
    path: ['workspace', 'show'],
    group: 'workspaces',
    summary: 'Everything about one workspace',
    usage: 'foreman workspace show <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws show api', 'foreman ws show . --json'],
    details: 'Prints its state and board status, branch and base, folder, tabs, pull request, checks, open agent reports, note revision and the latest setup run.',
    tier: 'read'
  },
  {
    path: ['workspace', 'path'],
    group: 'workspaces',
    summary: 'Print a workspace’s folder',
    usage: 'foreman workspace path <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['cd "$(foreman ws path api)"'],
    details: 'Prints just the folder, for a script. A history-only or cloud workspace has none and the command says so.',
    tier: 'read'
  },
  {
    path: ['workspace', 'open'],
    group: 'workspaces',
    summary: 'Bring Foreman forward on a workspace',
    usage: 'foreman workspace open <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws open api'],
    tier: 'act'
  },
  {
    path: ['workspace', 'rename'],
    group: 'workspaces',
    summary: 'Rename a workspace',
    usage: 'foreman workspace rename <workspace> <name...>',
    args: [WORKSPACE_ARG, { name: 'name', required: true, rest: true, help: 'The new name' }],
    options: {},
    examples: ['foreman ws rename api "Login fix"'],
    tier: 'act'
  },
  {
    path: ['workspace', 'pin'],
    group: 'workspaces',
    summary: 'Pin a workspace to the top of the sidebar',
    usage: 'foreman workspace pin <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws pin api'],
    tier: 'act'
  },
  {
    path: ['workspace', 'unpin'],
    group: 'workspaces',
    summary: 'Unpin a workspace',
    usage: 'foreman workspace unpin <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws unpin api'],
    tier: 'act'
  },
  {
    path: ['workspace', 'status'],
    group: 'workspaces',
    summary: 'Set a workspace’s board status',
    usage: 'foreman workspace status <workspace> <backlog|in-progress|in-review|done|canceled|none>',
    args: [WORKSPACE_ARG, { name: 'status', required: true, choices: BOARD_STATUSES, help: 'The board column; none clears it' }],
    options: {},
    examples: ['foreman ws status api in-review', 'foreman ws status api none'],
    tier: 'act'
  },
  {
    path: ['workspace', 'archive'],
    group: 'workspaces',
    summary: 'Archive a workspace (shows what it will do first)',
    usage: 'foreman workspace archive <workspace> [--delete-branch] [--stop] [--yes]',
    args: [WORKSPACE_ARG],
    options: {
      'delete-branch': { type: 'boolean', help: 'Also delete the workspace’s branch' },
      stop: { type: 'boolean', help: 'Stop running tabs first instead of refusing' },
      anyway: { type: 'boolean', help: 'Carry on past a failed checkpoint or archive script' }
    },
    examples: ['foreman ws archive api', 'foreman ws archive api --delete-branch --stop --yes'],
    exitCodes: { 0: 'Archived', 1: 'A step failed and nothing was deleted, or you answered no', 6: 'Needs confirmation: run in a terminal or add --yes' },
    details: ARCHIVE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['workspace', 'unarchive'],
    group: 'workspaces',
    summary: 'Bring an archived workspace back',
    usage: 'foreman workspace unarchive <workspace>',
    args: [{ ...WORKSPACE_ARG, help: 'An archived workspace’s name, id or branch (`foreman ws list --archived`)' }],
    options: {},
    examples: ['foreman ws unarchive api'],
    tier: 'act'
  },
  {
    path: ['workspace', 'forget'],
    group: 'workspaces',
    summary: 'Delete an archived workspace and its chats for good',
    usage: 'foreman workspace forget <workspace> [--yes]',
    args: [{ ...WORKSPACE_ARG, help: 'An archived workspace’s name, id or branch (`foreman ws list --archived`)' }],
    options: {},
    examples: ['foreman ws forget api --yes'],
    exitCodes: { 0: 'Forgotten', 1: 'You answered no', 6: 'Needs confirmation: run in a terminal or add --yes' },
    details: FORGET_DETAILS,
    tier: 'admin',
    noAssistant: 'it deletes the workspace’s chats for good; run it yourself'
  },
  {
    path: ['workspace', 'activate'],
    group: 'workspaces',
    summary: 'Give a history-only workspace a worktree here',
    usage: 'foreman workspace activate <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws activate imported-fix'],
    details: 'An imported workspace is history only until its branch exists on this computer; activating checks it out into a worktree. Refused with the reason when the branch isn’t here.',
    tier: 'act'
  },
  {
    path: ['workspace', 'adopt'],
    group: 'workspaces',
    summary: 'Add a worktree that exists on disk as a workspace',
    usage: 'foreman workspace adopt <path> [--repo r] [--setup] [--prompt "…"]',
    args: [{ name: 'path', required: true, help: 'The worktree’s folder' }],
    options: {
      repo: { type: 'string', short: 'r', value: '<name|path>', help: 'The repository it belongs to', default: 'the one you’re in' },
      setup: { type: 'boolean', help: 'Run the repository’s setup script on it' },
      prompt: { type: 'string', value: '<text>', help: 'A first message for its chat' }
    },
    examples: ['foreman ws adopt ../api-hotfix', 'foreman ws adopt ~/trees/search --repo web --setup --prompt "Pick up where I left off"'],
    details: 'Archiving an adopted workspace leaves its folder and branch alone. With --prompt it sends a first message, so from inside an agent turn it needs the repository’s “Let agents start workspaces and queue messages”.',
    tier: 'act'
  },
  {
    path: ['workspace', 'setup'],
    group: 'workspaces',
    summary: 'Read or drive a workspace’s setup run',
    usage: 'foreman workspace setup [log|rerun|retry|stop|steps] <workspace> [--tail n]',
    args: [
      { name: 'verb', choices: ['log', 'rerun', 'retry', 'stop', 'steps'], help: 'What to do (log when left out)' },
      WORKSPACE_ARG
    ],
    options: { tail: { type: 'string', value: '<n>', help: 'With log: only the last n lines' } },
    examples: ['foreman ws setup api', 'foreman ws setup steps api', 'foreman ws setup retry api'],
    details: 'log prints the setup log; steps prints each step’s own log. rerun starts setup again, retry carries on from the step that failed (keeping the ones that passed), stop stops the running step.',
    tier: 'act'
  },
  {
    path: ['workspace', 'note'],
    group: 'workspaces',
    summary: 'Read, write or send the workspace note',
    usage: 'foreman workspace note [get|set|send] <workspace> [text...] [--file f | --stdin] [--tab n]',
    args: [
      { name: 'verb', choices: ['get', 'set', 'send'], help: 'What to do (get when left out)' },
      WORKSPACE_ARG,
      { name: 'text', rest: true, help: 'set: the new note (or --file, or --stdin)' }
    ],
    options: {
      file: { type: 'string', value: '<file>', help: 'set: read the note from this file' },
      stdin: { type: 'boolean', help: 'set: read the note from standard input' },
      tab: TAB_OPTION
    },
    examples: ['foreman ws note api', 'foreman ws note set api "Use the v2 endpoints; never touch billing/"', 'foreman ws note set api --file notes.md', 'foreman ws note send api --tab 2'],
    details: `The note is guidance shared by the workspace's tabs. Saving it sends nothing; send queues it
as a normal message in one tab and prints the receipt like foreman send. set and send are not
available from inside an agent turn (send follows the same opt-in as foreman send).`,
    tier: 'act'
  },
  {
    path: ['workspace', 'integrations'],
    group: 'workspaces',
    summary: 'Which integrations a workspace’s agents get, and switch one on or off',
    usage: 'foreman workspace integrations <workspace> [--on a,b] [--off a,b]',
    args: [WORKSPACE_ARG],
    options: {
      on: { type: 'string', value: '<a,b>', help: 'Switch these on (linear, slack, langfuse) from the next message' },
      off: { type: 'string', value: '<a,b>', help: 'Switch these off from the next message' }
    },
    examples: ['foreman ws integrations api', 'foreman ws integrations api --on linear', 'foreman ws integrations . --off slack --json'],
    details: `Lists each integration that can give this workspace's agents tools: whether it is on here, what new
workspaces in the repository start with, the account it acts as, and roughly what its tool definitions cost
(a turn carries them only while it is on). --on and --off apply from the next message; the chat's receipt
says so. Only a working connection that agents may use can be switched on: switching grants nothing the
connection doesn't allow. From inside an agent turn, switching one on needs the repository's opt-in
(Repository settings → Actions → "Let agents start workspaces and queue messages").`,
    tier: 'act'
  },
  {
    path: ['workspace', 'usage'],
    group: 'workspaces',
    summary: 'Turns, agent time and cost for a workspace',
    usage: 'foreman workspace usage <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ws usage api'],
    tier: 'read'
  },
  {
    path: ['workspace', 'spotlight'],
    group: 'workspaces',
    summary: 'Mirror a workspace’s changes into the repository folder',
    usage: 'foreman workspace spotlight <workspace> <on|off>',
    args: [WORKSPACE_ARG, { name: 'state', required: true, choices: ['on', 'off'], help: 'on or off' }],
    options: {},
    examples: ['foreman ws spotlight api on'],
    tier: 'act'
  },
  {
    path: ['workspace', 'docker'],
    group: 'workspaces',
    summary: 'A workspace’s Docker containers',
    usage: 'foreman workspace docker <workspace> [list|remove|dismiss]',
    args: [WORKSPACE_ARG, { name: 'verb', choices: ['list', 'remove', 'dismiss'], help: 'What to do (list when left out)' }],
    options: {},
    examples: ['foreman ws docker api', 'foreman ws docker api remove'],
    details: 'Only containers labelled foreman.workspace=<id> are touched. remove removes them (containers only, never volumes or images); dismiss hides Home’s “still running after archive” line without removing anything. Works for archived workspaces too.',
    tier: 'act'
  },
  {
    path: ['workspace', 'alerts'],
    group: 'workspaces',
    summary: 'Sensitive-path alerts on a workspace',
    usage: 'foreman workspace alerts <workspace> [list|dismiss] [id]',
    args: [WORKSPACE_ARG, { name: 'verb', choices: ['list', 'dismiss'], help: 'What to do (list when left out)' }, { name: 'id', help: 'dismiss: the alert’s id, or the start of it' }],
    options: {},
    examples: ['foreman ws alerts api', 'foreman ws alerts api dismiss 3f9a'],
    details: 'An alert is raised when a turn changed files matching the repository’s sensitive paths.',
    tier: 'act'
  },
  {
    path: ['workspace', 'reports'],
    group: 'workspaces',
    summary: 'What agents reported on a workspace',
    usage: 'foreman workspace reports <workspace> [list|close] [id]',
    args: [WORKSPACE_ARG, { name: 'verb', choices: ['list', 'close'], help: 'What to do (list when left out)' }, { name: 'id', help: 'close: the report’s id, or the start of it' }],
    options: {},
    examples: ['foreman ws reports api', 'foreman ws reports api close 3f9a'],
    details: 'Reports come from `foreman report` and `foreman review`. close dismisses an open needs-input, stuck or review request; it goes to history.',
    tier: 'act'
  }
]

export const TAB_COMMANDS: CommandSpec[] = [
  {
    path: ['tabs'],
    group: 'chats',
    summary: 'List a workspace’s chat tabs',
    usage: 'foreman tabs <workspace> [--closed]',
    args: [WORKSPACE_ARG],
    options: { closed: { type: 'boolean', help: 'The closed tabs (with their ids) that can be reopened' } },
    examples: ['foreman tabs api', 'foreman tabs api --closed --json'],
    details: 'One row per tab: its position (what --tab takes), title, agent and model, effort, flags (fast, plan, auto-accept), status, queued messages and how the last turn ended.',
    tier: 'read'
  },
  {
    path: ['tab', 'new'],
    group: 'chats',
    summary: 'Open a new chat tab',
    usage: 'foreman tab new <workspace> [--agent a] [--model m] [--effort e] [--fast] [--plan] [--title t]',
    args: [WORKSPACE_ARG],
    options: {
      agent: { type: 'string', value: '<agent>', help: 'The agent (claude, codex, …)', default: 'loadout 1’s' },
      model: { type: 'string', value: '<model>', help: 'The model’s id or name', default: 'the agent’s default' },
      effort: { type: 'string', value: '<level>', help: 'Effort level, when the model has one' },
      fast: { type: 'boolean', help: 'Fast mode, when the model has one' },
      plan: { type: 'boolean', help: 'Start in plan mode' },
      title: { type: 'string', value: '<title>', help: 'A title for the tab' }
    },
    examples: ['foreman tab new api', 'foreman tab new api --agent codex --title "Second opinion"'],
    details: 'The tab starts no turn; send it a message with foreman send.',
    tier: 'act'
  },
  {
    path: ['tab', 'set'],
    group: 'chats',
    summary: 'Change a tab’s title, agent, model or modes',
    usage: 'foreman tab set <workspace> [--tab n] [--title t] [--agent a] [--model m] [--effort e] [--fast|--no-fast] [--plan|--no-plan] [--auto-accept-edits|--no-auto-accept-edits] [--include-note|--no-include-note]',
    args: [WORKSPACE_ARG],
    options: {
      tab: TAB_OPTION,
      title: { type: 'string', value: '<title>', help: 'A new title' },
      agent: { type: 'string', value: '<agent>', help: 'Switch the agent (not while a turn runs)' },
      model: { type: 'string', value: '<model>', help: 'The model’s id or name' },
      effort: { type: 'string', value: '<level>', help: 'Effort level' },
      fast: { type: 'boolean', help: 'Turn fast mode on' },
      'no-fast': { type: 'boolean', help: 'Turn fast mode off' },
      plan: { type: 'boolean', help: 'Turn plan mode on' },
      'no-plan': { type: 'boolean', help: 'Turn plan mode off' },
      'auto-accept-edits': { type: 'boolean', help: 'Claude: accept file edits without asking' },
      'no-auto-accept-edits': { type: 'boolean', help: 'Claude: ask before file edits again' },
      'include-note': { type: 'boolean', help: 'Send the workspace note with this tab’s messages' },
      'no-include-note': { type: 'boolean', help: 'Stop sending the workspace note with this tab’s messages' }
    },
    examples: ['foreman tab set api --tab 2 --title "Migration"', 'foreman tab set api --model opus --effort high', 'foreman tab set api --plan'],
    details: TAB_SET_DETAILS,
    tier: 'act'
  },
  {
    path: ['tab', 'close'],
    group: 'chats',
    summary: 'Close a chat tab',
    usage: 'foreman tab close <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman tab close api --tab 2'],
    details: 'A closed tab stays restorable with foreman tab reopen until the workspace is archived.',
    tier: 'act'
  },
  {
    path: ['tab', 'reopen'],
    group: 'chats',
    summary: 'Reopen a closed chat tab',
    usage: 'foreman tab reopen <workspace> [--tab id]',
    args: [WORKSPACE_ARG],
    options: { tab: { type: 'string', short: 't', value: '<id>', help: 'The closed tab’s id from `foreman tabs <ws> --closed`', default: 'the most recently closed' } },
    examples: ['foreman tab reopen api', 'foreman tab reopen api --tab 3f9a1c'],
    tier: 'act'
  },
  {
    path: ['tab', 'fork'],
    group: 'chats',
    summary: 'Continue a chat in a new tab from a point in it',
    usage: 'foreman tab fork <workspace> [--tab n] [--turn id] [--before]',
    args: [WORKSPACE_ARG],
    options: {
      tab: TAB_OPTION,
      turn: { type: 'string', value: '<turn>', help: 'Fork after this turn (from `foreman chat`)', default: 'after the latest answer' },
      before: { type: 'boolean', help: 'With --turn: from just before that turn’s message (edit and resend)' }
    },
    examples: ['foreman tab fork api --tab 1', 'foreman tab fork api --tab 1 --turn 7f3a9c --before'],
    details: 'The new tab continues the same conversation and starts no turn; send it a message with foreman send.',
    tier: 'act'
  },
  {
    path: ['chat'],
    group: 'chats',
    summary: 'Print a tab’s conversation as text',
    usage: 'foreman chat <workspace> [--tab n] [--tail n] [--since turn] [--tool-output]',
    args: [WORKSPACE_ARG],
    options: {
      tab: TAB_OPTION,
      tail: { type: 'string', value: '<n>', help: 'Only the last n turns' },
      since: { type: 'string', value: '<turn>', help: 'Only what came after this turn' },
      'tool-output': { type: 'boolean', help: 'Include each tool call’s output' }
    },
    examples: ['foreman chat api', 'foreman chat api --tab 2 --tail 3 --tool-output', 'foreman chat api --since 7f3a9c --json'],
    details: CHAT_DETAILS,
    tier: 'read'
  },
  {
    path: ['queue'],
    group: 'chats',
    summary: 'See and change a tab’s queued messages',
    usage: 'foreman queue <workspace> [--tab n] [list|remove <msg>|steer <msg>|move <msg> up|down|edit <msg> "text"]',
    args: [
      WORKSPACE_ARG,
      { name: 'verb', choices: ['list', 'remove', 'steer', 'move', 'edit'], help: 'What to do (list when left out)' },
      { name: 'message', help: 'The queued message: its position from 1, or its id' },
      { name: 'text', rest: true, help: 'move: up or down; edit: the new text' }
    ],
    options: { tab: TAB_OPTION },
    examples: ['foreman queue api', 'foreman queue api --tab 2 remove 1', 'foreman queue api move 2 up', 'foreman queue api edit 1 "Also cover the empty case"'],
    details: QUEUE_DETAILS,
    tier: 'act'
  },
  {
    path: ['rewind'],
    group: 'chats',
    summary: 'Restore a tab’s files and conversation to before a turn',
    usage: 'foreman rewind <workspace> [--tab n] --turn <id> [--yes]',
    args: [WORKSPACE_ARG],
    options: {
      tab: TAB_OPTION,
      turn: { type: 'string', value: '<turn>', help: 'Rewind to just before this turn (from `foreman chat`)' }
    },
    examples: ['foreman rewind api --tab 1 --turn 7f3a9c'],
    exitCodes: { 0: 'Rewound', 1: 'You answered no', 6: 'Needs confirmation: run in a terminal or add --yes' },
    details: REWIND_DETAILS,
    tier: 'admin',
    noAssistant: 'it throws away work done after that turn; run it yourself'
  },
  {
    path: ['resume-now'],
    group: 'chats',
    summary: 'Send the message a missed usage-limit resume was waiting to send',
    usage: 'foreman resume-now <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman resume-now api --tab 1'],
    details: 'The tab’s last turn stopped at a usage limit and its resume time passed. This is the card’s “Resume now”: it sends the message again, so from inside an agent turn it needs the repository’s “Let agents start workspaces and queue messages”.',
    tier: 'act'
  },
  {
    path: ['mcp'],
    group: 'chats',
    summary: 'MCP servers of a tab: status, restart, reconnect',
    usage: 'foreman mcp <workspace> [--tab n] [status|restart|reconnect <name>]',
    args: [WORKSPACE_ARG, { name: 'verb', choices: ['status', 'restart', 'reconnect'], help: 'What to do (status when left out)' }, { name: 'name', help: 'reconnect: the server’s name' }],
    options: { tab: TAB_OPTION },
    examples: ['foreman mcp api', 'foreman mcp api --tab 2 restart', 'foreman mcp api reconnect linear'],
    details: 'status shows each server as the tab’s agent reports it. restart re-reads the configuration and connects again; reconnect retries one server.',
    tier: 'act'
  },
  {
    path: ['slash'],
    group: 'chats',
    summary: 'The /commands a tab offers',
    usage: 'foreman slash <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman slash api'],
    details: 'Lists the built-in commands of the tab’s agent and the commands and skills found in the repository and your home folder. They run in the app’s composer, not from the command line.',
    tier: 'read'
  },
  {
    path: ['search'],
    group: 'chats',
    summary: 'Search every chat (and notes) for words',
    usage: 'foreman search <words...> [--tool-output] [--notes] [--limit n]',
    args: [{ name: 'words', required: true, rest: true, help: 'What to look for' }],
    options: {
      'tool-output': { type: 'boolean', help: 'Also search tool names, inputs and output' },
      notes: { type: 'boolean', help: 'Also search workspace notes' },
      limit: { type: 'string', value: '<n>', help: 'At most this many hits' }
    },
    examples: ['foreman search "rate limiter"', 'foreman search migration --notes --limit 5 --json'],
    details: 'Matching words are shown in [brackets]. Archived workspaces’ chats are searched too.',
    tier: 'read'
  }
]

export const APPROVAL_COMMANDS: CommandSpec[] = [
  {
    path: ['approvals'],
    group: 'work',
    summary: 'List what agents are waiting on',
    usage: 'foreman approvals [list]',
    args: [{ name: 'list', choices: ['list'], help: 'Optional; listing is all this does' }],
    options: {},
    examples: ['foreman approvals', 'foreman approvals --json'],
    details: 'One row per request: id, workspace, tab, kind (tool, plan or question) and the ask. Answer with foreman approve or foreman deny.',
    tier: 'read'
  },
  {
    path: ['approve'],
    group: 'work',
    summary: 'Approve a tool, plan or question an agent is waiting on',
    usage: 'foreman approve <id> [--always|--edits] [--message "…"] [--plan] [--feedback "…"] [--answer "question=choice"]...',
    args: [{ name: 'id', required: true, help: 'The request’s id from `foreman approvals` (or the start of it)' }],
    options: {
      always: { type: 'boolean', help: 'Tool: allow it from now on, when the tool offers that' },
      edits: { type: 'boolean', help: 'Tool: allow edits for the rest of the session, when offered' },
      message: { type: 'string', value: '<text>', help: 'Tool: a note to the agent with the answer' },
      plan: { type: 'boolean', help: 'Plan: approve it (checked against the request’s kind)' },
      feedback: { type: 'string', value: '<text>', help: 'Plan: a note with the approval' },
      answer: { type: 'string', multiple: true, value: '<question=choice>', help: 'Question: one answer per question' }
    },
    examples: ['foreman approve 3f9a', 'foreman approve 3f9a --always', 'foreman approve 5c21 --plan --feedback "Skip step 4"', 'foreman approve 8d07 --answer "Which database?=Postgres"'],
    details: APPROVE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['deny'],
    group: 'work',
    summary: 'Deny a tool, send a plan back or skip a question',
    usage: 'foreman deny <id> [--message "…"]',
    args: [{ name: 'id', required: true, help: 'The request’s id from `foreman approvals` (or the start of it)' }],
    options: { message: { type: 'string', value: '<text>', help: 'Tell the agent why (a tool’s reason, a plan’s feedback)' } },
    examples: ['foreman deny 3f9a --message "Use the staging database"', 'foreman deny 5c21 --message "Split it into two PRs"'],
    details: APPROVE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['stopped'],
    group: 'work',
    summary: 'Review turns a quit or crash stopped',
    usage: 'foreman stopped [list|retry|dismiss] [key] [--all]',
    args: [
      { name: 'verb', choices: ['list', 'retry', 'dismiss'], help: 'What to do (list when left out)' },
      { name: 'key', help: 'retry, dismiss: a turn id (or the start of it) or checks:<workspace id>' }
    ],
    options: { all: { type: 'boolean', help: 'dismiss: clear every entry' } },
    examples: ['foreman stopped', 'foreman stopped retry 7f3a9c', 'foreman stopped dismiss --all --yes'],
    details: STOPPED_DETAILS,
    tier: 'act'
  }
]
