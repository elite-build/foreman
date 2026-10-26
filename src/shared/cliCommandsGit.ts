// The declarative half of the git, repository and remote-workspace commands: `git *`, `diff`,
// `commits`, `comments`, `pr *`, `base-moved`, `ack-ci`; `repo add|clone|init|remove|show|branches|remotes|worktrees|
// account|files-to-copy` and `attention`; `cloud *`. src/cli/commands/{git,repoOps,cloud}.ts attach the functions;
// cliCommands.ts spreads these arrays into COMMANDS.
import type { ArgSpec, CommandSpec, OptionSpec } from './cliCommands'
import { SCOPE_HELP } from './cli/git'

const WORKSPACE_ARG: ArgSpec = { name: 'workspace', required: true, help: 'A name, id or branch from `foreman status`, or "." for the one you’re in' }

/** `--words` on the commands that report on work: sentences a screen reader or Emacspeak speaks as they arrive. */
export const WORDS_OPTION: OptionSpec = { type: 'boolean', help: 'Print sentences instead of a table or patch, for a screen reader (with --json, ignored: the JSON is the same)' }

const TAB_OPTION: OptionSpec = { type: 'string', short: 't', value: '<n>', help: 'Open tab to use, counting from 1', default: 'the only open tab' }

const WAIT_OPTIONS: Record<string, OptionSpec> = {
  wait: { type: 'boolean', help: 'Block until the turn it started ends, and report how it went' },
  timeout: { type: 'string', value: '<s>', help: 'With --wait: stop waiting after s seconds (the turn keeps running)' }
}

const WAIT_EXIT_CODES: Record<number, string> = {
  0: 'Done (with --wait: the turn completed)',
  1: 'Failed, or with --wait the turn failed, was stopped or was interrupted',
  2: 'Usage error, or --wait timed out (the turn keeps running)',
  5: 'The connection to Foreman was lost (the turn is unaffected)',
  7: 'Refused: an agent turn needs the repository’s “Let agents start workspaces and queue messages”'
}

const REPO_ARG: ArgSpec = { name: 'repo', help: 'A repository’s name, id or folder', }

/** The path words of the pull-request commands. The `pr` alias (cliCommands.ts ALIASES) expands to `git pr`. */
const PR = ['git', 'pr']
const PR_NAME = PR.join(' ')

const SENDS_DETAILS = `This puts a message in a chat tab, the same one the Git panel's button sends, and queues it behind a
turn that is already running. It prints the turn id and the tab; with --wait it then blocks for
that turn, with the exit codes of \`foreman run\`. A workspace with several open tabs needs --tab
(the command lists them). From inside an agent turn it needs the repository's “Let agents start
workspaces and queue messages”.`

const REVIEW_DETAILS = `foreman git review opens a new tab with the review model from Settings (the Review button's), asks it to
review the branch against its base, and prints the turn id of that tab's first turn. --tab picks
the tab the review is started from (it only matters for which chat the new tab sits next to). With
--wait it blocks until the review ends; the findings are in the new tab. From inside an agent turn it
needs the repository's “Let agents start workspaces and queue messages”.`

const PULL_DETAILS = `foreman git pull fetches and fast-forwards. When the branch has uncommitted work or has diverged from its
upstream or base, the merge needs judgement and is sent to a chat instead (the first open tab, or --tab), as the
Pull button does; the command then prints that turn's id.`

const REVERT_DETAILS = `foreman git revert puts each named file back as it was where the branch started (the base branch), the same
as the Changes panel's Revert: uncommitted and committed changes to it are discarded, and a file the branch added
is deleted. Paths are from the workspace's root. It prints what it would do and asks first; --yes answers for you,
and without a terminal and without --yes it prints that and exits with code 6, having done nothing.`

const DIFF_DETAILS = `foreman diff prints the Changes panel's diff as unified text. --scope picks the source: ${SCOPE_HELP}.
The default, branch, is everything since the branch left its base, uncommitted work included. --stat prints a line per
file with its additions and deletions, --files only the names (one per line, for scripts). A turn is kept as counts per
file, so turn:<id> prints counts only. --words prints sentences for a screen reader instead: a lead ("3 files changed,
+120 -14"), a line per file ("src/api.ts, modified, 12 added, 3 removed") and a line per hunk ("src/api.ts, hunk 2 of 4,
lines 40 to 58, near: handleLogin(: added: ...; removed: ..."); "near" is the text git puts after the hunk's @@, which may
not be a function. Nothing is changed.`

const COMMENTS_DETAILS = `Comments are notes on lines of the diff. Yours wait and go with the next message you send in any of the
workspace's chats, as the Changes panel's do (nothing is sent now); an agent's are open until resolved. \`list\` is the
default. \`add\` needs a file with changes in the diff (its path from the workspace's root), a line number and the text.
\`edit\` changes the text of a comment of yours that hasn't been sent. \`resolve\` marks one resolved; \`delete\` removes it.
A comment is named by its id from \`list\`, or the first four or more characters of it.`

const PR_DETAILS = `foreman pr prints what Foreman last read of the pull request (or merge request): its state, the checks, the review, whether
it merges cleanly, and the link. It reads Foreman's saved copy, so nothing is asked of GitHub or GitLab; \`pr refresh\`
asks again. \`foreman pr\` is short for \`foreman git pr\`.`

const MERGE_DETAILS = `foreman pr merge merges the pull request the way the Merge button does (squash, or what the repository allows),
and archives the workspace afterwards when that setting is on. It first prints what it will merge, with the checks and
review state, and asks (--yes answers for you; without a terminal and without --yes it prints that and exits with code 6).
--auto asks GitHub to merge it when the checks pass instead of now.`

const AUTO_FIX_DETAILS = `Auto-fix CI lets Foreman answer a failing CI run on its own: it sends the Fix errors message with the failure logs to one tab,
with no one asking, within a small budget per commit and per pull request. That is a consent, so \`on\` first prints what the
window's dialog shows (the tab and its agent, what that tab may do without asking, the exact instructions it sends and the budget)
and asks (--yes answers for you; without a terminal and without --yes it exits with code 6, having changed nothing). If the tab,
its permissions or the instructions change between the preview and the answer, Foreman refuses and you look again.
\`status\` says whether it is on and why it stopped; \`off\` turns it off. It can't be used from inside an agent turn.`

const CLONE_DETAILS = `foreman repo clone clones the URL into a new folder under --into (default: the folder Settings → Git → Clone location names)
and adds the repository to Foreman. Git's progress is printed as it goes. --account clones as that gh account and links the
repository to it. Relative --into paths are taken from where you run the command.`

const REMOVE_DETAILS = `foreman repo remove takes the repository out of Foreman: every workspace of it (worktrees and chats, archived records too) is
deleted. The repository folder itself is never touched. It prints what goes first and asks (--yes answers for you; without a
terminal and without --yes it prints that and exits with code 6). It refuses while an agent in the repository is running, and
from inside an agent turn.`

const ACCOUNT_DETAILS = `Without --detect, repo account says which GitHub account the repository uses. --detect asks \`gh\` which signed-in accounts can
push to the repository's remote and reports the only one that can; --save then links the repository to it (or clears a
link Foreman picked itself).`

const CLOUD_BUILD_DETAILS = `A repository's remote workspaces can start from a base: a sandbox with the repository cloned and its install script run once.
foreman cloud build makes (or remakes) it. The build runs in the app; with --wait this command follows its output as progress
lines and ends when it does (exit 0 built, exit 1 failed, up to 30 minutes). Providers that keep no base (E2B) refuse (JSON code
not-supported, exit 1) and nothing is started.`

export const GIT_COMMANDS: CommandSpec[] = [
  {
    path: ['git', 'status'],
    group: 'git',
    summary: 'Show a workspace’s branch, what is ahead or behind and its pull request',
    usage: 'foreman git status <workspace> [--fresh]',
    args: [WORKSPACE_ARG],
    options: { fresh: { type: 'boolean', help: 'Ask the host (GitHub or GitLab) again instead of using what was read in the last minute' } },
    examples: ['foreman git status api', 'foreman git status . --fresh --json'],
    details: 'The Git panel’s header as text: ahead and behind the upstream and the base, uncommitted files, conflicts, the pull request and what the primary button would do next. A sleeping remote workspace shows what it last said, and when.',
    tier: 'read'
  },
  {
    path: ['git', 'commit'],
    group: 'git',
    summary: 'Ask the agent to commit and push the changes',
    usage: 'foreman git commit <workspace> [--tab n] [--wait]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION, ...WAIT_OPTIONS },
    examples: ['foreman git commit api', 'foreman git commit api --tab 2 --wait --timeout 600'],
    exitCodes: WAIT_EXIT_CODES,
    details: `The Commit and push button: the agent writes the commit message and pushes (or only commits, when there is no remote).\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: ['git', 'push'],
    group: 'git',
    summary: 'Push the branch',
    usage: 'foreman git push <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman git push api'],
    details: 'Pushes the workspace’s branch to the repository’s remote, setting the upstream the first time. No agent is involved.',
    tier: 'act'
  },
  {
    path: ['git', 'pull'],
    group: 'git',
    summary: 'Pull the upstream or base branch into the branch',
    usage: 'foreman git pull <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman git pull api'],
    details: PULL_DETAILS,
    tier: 'act'
  },
  {
    path: ['git', 'review'],
    group: 'git',
    summary: 'Ask the review model to review the branch in a new tab',
    usage: 'foreman git review <workspace> [--tab n] [--wait]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION, ...WAIT_OPTIONS },
    examples: ['foreman git review api', 'foreman git review api --wait --timeout 1800'],
    exitCodes: WAIT_EXIT_CODES,
    details: REVIEW_DETAILS,
    tier: 'act'
  },
  {
    path: ['git', 'fix-errors'],
    group: 'git',
    summary: 'Send the failing CI checks to the agent to fix',
    usage: 'foreman git fix-errors <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman git fix-errors api'],
    exitCodes: WAIT_EXIT_CODES,
    details: `The Fix errors button: the failing checks’ logs and the fix instructions go to a tab. \`foreman pr fix-ci\` does the same and also marks the CI failure as seen.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: ['git', 'resolve-conflicts'],
    group: 'git',
    summary: 'Ask the agent to merge the base branch in and resolve conflicts',
    usage: 'foreman git resolve-conflicts <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman git resolve-conflicts api --tab 1'],
    exitCodes: WAIT_EXIT_CODES,
    details: SENDS_DETAILS,
    tier: 'act'
  },
  {
    path: ['git', 'revert'],
    group: 'git',
    summary: 'Put files back as they were where the branch started',
    usage: 'foreman git revert <workspace> <file>... [--yes]',
    args: [WORKSPACE_ARG, { name: 'file', required: true, rest: true, help: 'Paths from the workspace’s root, as `foreman diff --files` prints them' }],
    options: {},
    examples: ['foreman git revert api src/login.ts', 'foreman git revert api notes.md scratch.txt --yes'],
    exitCodes: { 0: 'Reverted', 1: 'Not reverted (answered no)', 6: 'Needs confirmation: nothing was reverted' },
    details: REVERT_DETAILS,
    tier: 'admin'
  },
  {
    path: ['diff'],
    group: 'git',
    summary: 'Print a workspace’s diff',
    usage: 'foreman diff <workspace> [--scope source] [--stat] [--files] [--words]',
    args: [WORKSPACE_ARG],
    options: {
      scope: { type: 'string', value: '<source>', help: `Which changes: ${SCOPE_HELP}`, default: 'branch' },
      stat: { type: 'boolean', help: 'One line per file with its additions and deletions' },
      files: { type: 'boolean', help: 'Only the names of the changed files, one per line' },
      words: { ...WORDS_OPTION, help: 'Sentences instead of the patch: each file, then each hunk with the lines added and removed' }
    },
    examples: ['foreman diff api', 'foreman diff api --words', 'foreman diff api --scope uncommitted --stat', 'foreman diff api --scope commit:3f9a1c2 --files', 'foreman diff api --scope turn:7f3a9c --stat'],
    details: DIFF_DETAILS,
    tier: 'read'
  },
  {
    path: ['commits'],
    group: 'git',
    summary: 'List the commits on a workspace’s branch',
    usage: 'foreman commits <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman commits api', 'foreman commits . --json'],
    details: 'The Commits tab as text: each commit since the branch left its base (newest first) with its author, files and lines changed, and whether it is pushed, plus a line for uncommitted work. Use the short ids with `foreman diff --scope commit:<id>`.',
    tier: 'read'
  },
  {
    path: ['comments'],
    group: 'git',
    summary: 'List, add, edit, resolve or delete comments on a workspace’s diff',
    usage: 'foreman comments <workspace> [list|add <file> <line> "<text>"|edit <id> "<text>"|resolve <id>|delete <id>]',
    args: [WORKSPACE_ARG, { name: 'verb', rest: true, help: 'list (the default), add <file> <line> <text>, edit <id> <text>, resolve <id> or delete <id>', choices: ['list', 'add', 'edit', 'resolve', 'delete'] }],
    options: {},
    examples: ['foreman comments api', 'foreman comments api add src/login.ts 42 "Handle the empty password here"', 'foreman comments api resolve 3f9a1c2d'],
    details: COMMENTS_DETAILS,
    tier: 'act'
  },
  {
    path: PR,
    group: 'git',
    summary: 'Show a workspace’s pull request',
    usage: `foreman ${PR_NAME} <workspace>`,
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman pr api', 'foreman pr . --json'],
    details: PR_DETAILS,
    tier: 'read'
  },
  {
    path: [...PR, 'create'],
    group: 'git',
    summary: 'Ask the agent to create the pull request (or open it on the web)',
    usage: `foreman ${PR_NAME} create <workspace> [--draft|--web] [--tab n] [--wait]`,
    args: [WORKSPACE_ARG],
    options: {
      draft: { type: 'boolean', help: 'Create a draft' },
      web: { type: 'boolean', help: 'Push the branch and open the host’s compare page in the browser instead of asking the agent' },
      tab: TAB_OPTION,
      ...WAIT_OPTIONS
    },
    examples: ['foreman pr create api', 'foreman pr create api --draft --wait', 'foreman pr create api --web'],
    exitCodes: WAIT_EXIT_CODES,
    details: `The Create PR button: the agent writes the title and description (from the repository's Create PR prompt) and opens the pull request or, on GitLab, the merge request. --web only pushes and opens the browser on this computer; no agent is involved.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: [...PR, 'ready'],
    group: 'git',
    summary: 'Mark a draft pull request ready for review',
    usage: `foreman ${PR_NAME} ready <workspace>`,
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman pr ready api'],
    tier: 'act'
  },
  {
    path: [...PR, 'open'],
    group: 'git',
    summary: 'Open the pull request in the browser',
    usage: `foreman ${PR_NAME} open <workspace>`,
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman pr open api'],
    details: 'Opens it where Settings → Git says (GitHub, or Graphite) in the browser on this computer, and prints nothing else; `foreman pr` prints the link.',
    tier: 'act'
  },
  {
    path: [...PR, 'refresh'],
    group: 'git',
    summary: 'Read the pull request from the host again',
    usage: `foreman ${PR_NAME} refresh <workspace>`,
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman pr refresh api'],
    details: 'The hover card’s Refresh: it goes through Foreman’s shared pull request cache, so its back-off after errors still holds ("paused").',
    exitCodes: { 0: 'Read', 1: 'The host couldn’t be reached or isn’t signed in' },
    tier: 'act'
  },
  {
    path: [...PR, 'merge'],
    group: 'git',
    summary: 'Merge the pull request (or turn on auto-merge)',
    usage: `foreman ${PR_NAME} merge <workspace> [--auto] [--yes]`,
    args: [WORKSPACE_ARG],
    options: { auto: { type: 'boolean', help: 'Merge when the checks pass instead of now' } },
    examples: ['foreman pr merge api', 'foreman pr merge api --auto --yes'],
    exitCodes: { 0: 'Merged (or auto-merge is on)', 1: 'Not merged (answered no)', 6: 'Needs confirmation: nothing was merged' },
    details: MERGE_DETAILS,
    tier: 'admin'
  },
  {
    path: [...PR, 'watch'],
    group: 'git',
    summary: 'Get notified about CI results or review comments on the pull request',
    usage: `foreman ${PR_NAME} watch <workspace> ci|reviews on|off`,
    args: [WORKSPACE_ARG, { name: 'what', required: true, help: 'ci (failures and recovery) or reviews (new review comments)', choices: ['ci', 'reviews'] }, { name: 'state', required: true, help: 'on or off', choices: ['on', 'off'] }],
    options: {},
    examples: ['foreman pr watch api ci on', 'foreman pr watch api reviews off'],
    tier: 'act'
  },
  {
    path: [...PR, 'fix-ci'],
    group: 'git',
    summary: 'Send the failing CI logs to a tab and mark the failure seen',
    usage: `foreman ${PR_NAME} fix-ci <workspace> [--tab n|--new]`,
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION, new: { type: 'boolean', help: 'Open a new tab for it' } },
    examples: ['foreman pr fix-ci api', 'foreman pr fix-ci api --new'],
    exitCodes: WAIT_EXIT_CODES,
    details: `The "Fix CI in…" action on Home's CI failed row.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: [...PR, 'threads'],
    group: 'git',
    summary: 'List the pull request’s review threads, or send some to a tab',
    usage: `foreman ${PR_NAME} threads <workspace> [list|send <id>... [--tab n]]`,
    args: [WORKSPACE_ARG, { name: 'verb', rest: true, help: 'list (the default), or send followed by thread ids', choices: ['list', 'send'] }],
    options: { tab: TAB_OPTION },
    examples: ['foreman pr threads api', 'foreman pr threads api send PRRT_kwDOA --tab 2'],
    exitCodes: WAIT_EXIT_CODES,
    details: `\`list\` shows each thread's id, file and line, whether it is open, and the first comment. \`send\` attaches the named open threads (an id, or the first four or more characters of one) to a tab with the request to address them, as the review panel's button does.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: [...PR, 'auto-fix'],
    group: 'git',
    summary: 'Turn auto-fix CI on or off for a workspace’s pull request',
    usage: `foreman ${PR_NAME} auto-fix <workspace> [--tab n] [status|on|off] [--yes]`,
    args: [WORKSPACE_ARG, { name: 'verb', help: 'status (the default), on or off', choices: ['status', 'on', 'off'] }],
    options: { tab: { ...TAB_OPTION, help: 'The tab the fixes are sent to (for `on`)' } },
    examples: ['foreman pr auto-fix api status', 'foreman pr auto-fix api on --tab 1', 'foreman pr auto-fix api on --tab 1 --yes', 'foreman pr auto-fix api off'],
    exitCodes: { 0: 'Done', 1: 'Not changed (answered no)', 6: 'Needs confirmation: nothing was changed' },
    details: AUTO_FIX_DETAILS,
    tier: 'admin'
  },
  {
    path: ['base-moved'],
    group: 'git',
    summary: 'Ask the agent to resolve a moved base branch that now conflicts',
    usage: 'foreman base-moved <workspace> [--tab n|--new]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION, new: { type: 'boolean', help: 'Open a new tab for it' } },
    examples: ['foreman base-moved api', 'foreman base-moved api --new'],
    exitCodes: WAIT_EXIT_CODES,
    details: `The "Resolve in chat…" action on Home's “base moved” row: the merge request goes to a tab and the notice is marked seen.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: ['ack-ci'],
    group: 'git',
    summary: 'Mark a CI failure as seen',
    usage: 'foreman ack-ci <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman ack-ci api'],
    details: 'Clears the “CI failed” row on Home without sending anything to an agent.',
    tier: 'act'
  }
]

export const REPO_OPS_COMMANDS: CommandSpec[] = [
  {
    path: ['repo', 'add'],
    group: 'repos',
    summary: 'Add a repository to Foreman',
    usage: 'foreman repo add <path>',
    args: [{ name: 'path', required: true, help: 'A folder inside a git repository (relative paths are taken from where you run it)' }],
    options: {},
    examples: ['foreman repo add ~/code/api', 'foreman repo add .'],
    details: 'Adds the repository the folder is in, as the window’s Add repository does. One Foreman already has is reported as it is.',
    tier: 'admin'
  },
  {
    path: ['repo', 'clone'],
    group: 'repos',
    summary: 'Clone a repository and add it to Foreman',
    usage: 'foreman repo clone <url> [--into dir] [--account a]',
    args: [{ name: 'url', required: true, help: 'What to clone: an https or ssh URL' }],
    options: {
      into: { type: 'string', value: '<dir>', help: 'The folder to clone into (the repository gets a folder of its own inside)', default: 'Settings → Git → Clone location' },
      account: { type: 'string', value: '<login>', help: 'Clone as this signed-in gh account, and link the repository to it' }
    },
    examples: ['foreman repo clone https://github.com/owner/repo', 'foreman repo clone git@github.com:owner/repo.git --into ~/code --account work'],
    details: CLONE_DETAILS,
    tier: 'admin'
  },
  {
    path: ['repo', 'init'],
    group: 'repos',
    summary: 'Create a new empty repository and add it to Foreman',
    usage: 'foreman repo init <name> [--into dir]',
    args: [{ name: 'name', required: true, help: 'The new folder’s (and repository’s) name' }],
    options: { into: { type: 'string', value: '<dir>', help: 'The folder to create it in', default: 'Settings → Git → Clone location' } },
    examples: ['foreman repo init scratchpad', 'foreman repo init notes --into ~/code'],
    details: 'The window’s Quick start: a new folder with git initialised, added to Foreman.',
    tier: 'admin'
  },
  {
    path: ['repo', 'remove'],
    group: 'repos',
    summary: 'Remove a repository and its workspaces from Foreman',
    usage: 'foreman repo remove <repo> [--yes]',
    args: [{ ...REPO_ARG, required: true }],
    options: {},
    examples: ['foreman repo remove api', 'foreman repo remove ~/code/old-project --yes'],
    exitCodes: { 0: 'Removed', 1: 'Not removed (answered no, or an agent is still running there)', 6: 'Needs confirmation: nothing was removed' },
    details: REMOVE_DETAILS,
    tier: 'admin',
    noAssistant: 'it deletes every workspace and chat of the repository'
  },
  {
    path: ['repo', 'show'],
    group: 'repos',
    summary: 'Everything about a repository: folder, branch, remote, account, settings, templates',
    usage: 'foreman repo show [<repo>]',
    args: [REPO_ARG],
    options: {},
    examples: ['foreman repo show', 'foreman repo show api --json'],
    details: 'The repository you are in unless one is named. The settings line counts how many of its settings each layer supplies (this computer, the committed .foreman/settings.toml, your own settings); `foreman repo settings list` shows them one by one.',
    tier: 'read'
  },
  {
    path: ['repo', 'branches'],
    group: 'repos',
    summary: 'List a repository’s branches',
    usage: 'foreman repo branches [<repo>] [--fetch]',
    args: [REPO_ARG],
    options: { fetch: { type: 'boolean', help: 'Update from the remote first' } },
    examples: ['foreman repo branches', 'foreman repo branches api --fetch'],
    details: 'Each branch with whether it exists locally, on the remote or both, which is the default, and where it is checked out.',
    tier: 'read'
  },
  {
    path: ['repo', 'remotes'],
    group: 'repos',
    summary: 'List a repository’s git remotes',
    usage: 'foreman repo remotes [<repo>]',
    args: [REPO_ARG],
    options: {},
    examples: ['foreman repo remotes', 'foreman repo remotes api --json'],
    tier: 'read'
  },
  {
    path: ['repo', 'worktrees'],
    group: 'repos',
    summary: 'List a repository’s git worktrees',
    usage: 'foreman repo worktrees [<repo>]',
    args: [REPO_ARG],
    options: {},
    examples: ['foreman repo worktrees', 'foreman repo worktrees api'],
    details: 'Each worktree with its branch, whether it is the main checkout or a Foreman workspace, and how many files changed. `foreman workspace adopt <path>` turns one that isn’t into a workspace.',
    tier: 'read'
  },
  {
    path: ['repo', 'account'],
    group: 'repos',
    summary: 'Show or detect the GitHub account a repository uses',
    usage: 'foreman repo account [<repo>] [--detect] [--save]',
    args: [REPO_ARG],
    options: {
      detect: { type: 'boolean', help: 'Ask gh which signed-in accounts can push to the remote' },
      save: { type: 'boolean', help: 'With --detect: link the repository to the account found' }
    },
    examples: ['foreman repo account', 'foreman repo account api --detect', 'foreman repo account api --detect --save'],
    details: ACCOUNT_DETAILS,
    tier: 'admin'
  },
  {
    path: ['repo', 'files-to-copy'],
    group: 'repos',
    summary: 'Preview which ignored files a new workspace would get a copy of',
    usage: 'foreman repo files-to-copy [<repo>] [--patterns p,q]',
    args: [REPO_ARG],
    options: { patterns: { type: 'string', value: '<p,q>', help: 'Try these gitignore-style patterns (comma-separated) instead of the repository’s', default: 'the repository’s Files to copy, or its .worktreeinclude' } },
    examples: ['foreman repo files-to-copy', 'foreman repo files-to-copy api --patterns ".env*,config/local.json"'],
    details: 'Nothing is copied or saved: it lists what the patterns would match among the repository’s gitignored files. Save patterns with `foreman repo settings set files-to-copy`.',
    tier: 'read'
  },
  {
    path: ['attention'],
    group: 'app',
    summary: 'List what needed your attention lately, or mark it seen',
    usage: 'foreman attention [list|seen] [--words]',
    args: [{ name: 'verb', help: 'list (the default) or seen', choices: ['list', 'seen'] }],
    options: { words: { ...WORDS_OPTION, help: 'Sentences instead of the table: how long ago, then what happened or what is waiting' } },
    examples: ['foreman attention', 'foreman attention --words', 'foreman attention seen'],
    details: 'Home’s Recent history: turns that finished or stopped, approvals asked and answered, CI failures, merged pull requests and agents’ reports, newest first, repeats folded into one line with a count. `seen` is “Mark all seen”: it moves only the history’s marker and resolves nothing. --words says each line as a sentence (“2 minutes ago: Claude Code finished in api-fix.”; a request still waiting says what it is), for a screen reader; with --json it changes nothing.',
    tier: 'act'
  }
]

export const CLOUD_COMMANDS: CommandSpec[] = [
  {
    path: ['cloud', 'status'],
    group: 'remote',
    summary: 'Show remote workspaces and their sandboxes',
    usage: 'foreman cloud status [<workspace>]',
    args: [{ name: 'workspace', help: 'One remote workspace (its provider is asked again); without it, all of them from what Foreman last knew' }],
    options: {},
    examples: ['foreman cloud status', 'foreman cloud status api-fix --json'],
    details: 'Each remote workspace’s provider, sandbox state (running, sleeping, capped, …), size, how long it has been idle against how long the repository lets it idle before it sleeps, and whether a turn was left running while Foreman was disconnected (`foreman cloud reattach`).',
    tier: 'read'
  },
  {
    path: ['cloud', 'wake'],
    group: 'remote',
    summary: 'Wake a remote workspace’s sandbox',
    usage: 'foreman cloud wake <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman cloud wake api-fix'],
    tier: 'act'
  },
  {
    path: ['cloud', 'sleep'],
    group: 'remote',
    summary: 'Put a remote workspace’s sandbox to sleep',
    usage: 'foreman cloud sleep <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman cloud sleep api-fix'],
    details: 'Its files are kept; it wakes when you open it, run a turn, or run `foreman cloud wake`.',
    tier: 'act'
  },
  {
    path: ['cloud', 'restart'],
    group: 'remote',
    summary: 'Force-stop a remote workspace’s sandbox and wake it again',
    usage: 'foreman cloud restart <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman cloud restart api-fix'],
    details: 'For an unresponsive or failed sandbox. Anything running in it is stopped.',
    tier: 'act'
  },
  {
    path: ['cloud', 'reattach'],
    group: 'remote',
    summary: 'Pick up turns a sandbox kept running while Foreman was disconnected',
    usage: 'foreman cloud reattach <workspace>',
    args: [WORKSPACE_ARG],
    options: {},
    examples: ['foreman cloud reattach api-fix'],
    tier: 'act'
  },
  {
    path: ['cloud', 'continue'],
    group: 'remote',
    summary: 'Continue a chat the sandbox’s session limit cut off',
    usage: 'foreman cloud continue <workspace> [--tab n]',
    args: [WORKSPACE_ARG],
    options: { tab: TAB_OPTION },
    examples: ['foreman cloud continue api-fix --tab 1'],
    exitCodes: WAIT_EXIT_CODES,
    details: `Wakes the sandbox and sends the chat a message to carry on from where the limit stopped it; it prints the turn id.\n\n${SENDS_DETAILS}`,
    tier: 'act'
  },
  {
    path: ['cloud', 'usage'],
    group: 'remote',
    summary: 'Show this month’s remote workspace usage per provider',
    usage: 'foreman cloud usage',
    args: [],
    options: {},
    examples: ['foreman cloud usage', 'foreman cloud usage --json'],
    details: 'Per connected provider: sandboxes running against the plan’s limit, active CPU time and stops this month, and how long a session may last.',
    tier: 'read'
  },
  {
    path: ['cloud', 'build'],
    group: 'remote',
    summary: 'Build a repository’s base sandbox for remote workspaces',
    usage: 'foreman cloud build [<repo>] [--wait]',
    args: [REPO_ARG],
    options: { wait: { type: 'boolean', help: 'Follow the build’s output and end when it does (up to 30 minutes)' } },
    examples: ['foreman cloud build api', 'foreman cloud build api --wait'],
    exitCodes: { 0: 'Started (with --wait: built)', 1: 'The build failed, --wait gave up, or the provider keeps no base to build (code not-supported)', 2: 'Usage error' },
    details: CLOUD_BUILD_DETAILS,
    tier: 'admin'
  },
  {
    path: ['cloud', 'preflight'],
    group: 'remote',
    summary: 'Say whether a remote workspace can be made in a repository now, and why not',
    usage: 'foreman cloud preflight [<repo>]',
    args: [REPO_ARG],
    options: {},
    examples: ['foreman cloud preflight', 'foreman cloud preflight api --json'],
    exitCodes: { 0: 'One can be made', 1: 'One can’t be made now (the reason is printed)' },
    details: 'Checks what the New workspace dialog checks before offering Remote: the feature is on, the provider is connected, the repository has a base where the provider keeps one, and the limit isn’t reached.',
    tier: 'read'
  }
]
