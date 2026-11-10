# Foreman guide

How to configure repositories, the tools Foreman gives agents, integrations, backups, the `foreman` command and phone access. For setup, see the [README](../README.md).

## Repository configuration

Use repository settings for overrides on this computer, or commit `.foreman/settings.toml` to share configuration. Local overrides take precedence over the shared file, followed by user settings where supported and built-in defaults. Foreman also reads `.switchyard/settings.toml`, from the app's earlier name, when no Foreman file exists. Other applications' settings files and workspace-variable aliases are not imported; move shared settings into `.foreman/settings.toml` and use `FOREMAN_*` variables in scripts and preview URLs.

For example, a Node.js repository can share setup, run and check commands:

```toml
file_include_globs = [".env*"]

[scripts]
setup = "npm ci"

[scripts.run.dev]
command = "npm run dev"
default = true

[[checks]]
name = "Tests"
command = "npm test"

[[checks]]
name = "Types"
command = "npm run typecheck"
```

Setup and archive scripts also support ordered steps with timeouts. Repository settings include preview URLs, environment files, custom prompts, sensitive paths, saved commands and proposed MCP servers. Check commands and repository-proposed MCP servers require approval on this computer before they run.

Keep secret values in **Settings → Environment** or agent and integration credentials. A shared MCP definition lists environment variable names rather than secret values. On Windows, scripts use Command Prompt by default; change **Settings → Advanced → Script shell** for PowerShell or Git Bash, and use that shell's environment variable syntax.

## Foreman tools for agents and the assistant

Foreman supplies a local `foreman-app` MCP server to workspace agents that support repository MCP servers. Its workspace controls are `get_workspace_status` (including setup step results), `get_check_results`, `open_preview`, and `run_checks`. Those four tools remain restricted to the caller's own workspace and take no workspace selector or command-consent flag. Each turn receives a fresh capability. Plan/read-only turns receive only read tools, subject to additional restrictions imposed by the agent adapter. Grants expire when the turn ends, startup fails, the chat closes, or Foreman quits. This controls access through MCP; it does not sandbox an agent's shell or replace existing CLI policy.

The built-in assistant uses the same actions, with workspace IDs from `list_workspaces`. Reads are immediate; opening a preview and running checks use its existing Run/Cancel cards. Checks return after starting, and `get_check_results` reports progress and results for that workspace. New or changed check commands still require user consent in the Git panel. Previews use the configured URL and do not start a development server. Status results omit command text, log paths, credentials and chat content.

Delegation tools reuse the CLI handlers for creating workspaces, sending messages, waiting and cancellation:

| Tool | Purpose |
| --- | --- |
| `list_delegation_options` | Discover saved loadout slots, permitted repositories, workspaces and chat/turn IDs. |
| `start_task` | Start a plain-text task in a new workspace with a chosen loadout; return without waiting for setup. |
| `get_task_status` | Inspect setup state and discover the task's first/current/latest turn ID. |
| `send_task` | Queue a literal task or handoff into an explicit chat ID. |
| `get_turn_result` | Retrieve a turn's outcome and visible assistant reply, with explicit truncation for long replies. |
| `wait_for_turn` | Wait up to 30 seconds; a timeout leaves the task running. |
| `cancel_turn` | Cancel a queued/running turn; completed turns stay unchanged. |
| `start_flow` | Flows on only: start a flow from `list_delegation_options` (which then lists the runnable flows with their inputs and personas) in a new workspace, from the repository's base branch or `baseBranch`, with every input it asks for; return the run ID without waiting. |
| `get_flow_status` | Flows on only: a flow run's state, the step and iteration it is at, its steps with their facts and chat/turn IDs, and its workspaces. Without a run ID it reads the run the caller's own workspace belongs to, which every turn in a flow's workspace is told. |

For an agent to coordinate work, enable **Repository settings → Actions → Let agents start workspaces and queue messages**. With that opt-in, delegation tools can start tasks and inspect replies, queue messages or cancel turns in the same repository. Cross-repository access is refused; disabling the opt-in removes cross-workspace access immediately. A coordinator cannot wait on or cancel its own chat, including turns queued behind it. A flow run is under the same rules: `start_flow` needs the opt-in and the coordinator's repository, starts exactly what the flow's run approval covers when it is called (its turn steps unattended on Claude, else it is refused), records the coordinating chat as the run's origin, and `get_flow_status` reads only runs in that repository and never waits (wait on a step's turn with `wait_for_turn`). No tool answers a gate or a pick: they wait for the user. While Flows are off, neither tool is offered. Reads exclude reasoning, tool output and user messages. Failed setup remains held for the user; the tools cannot approve scripts or bypass setup. Task creation and execution use the existing CLI/app services and their policies.

For example, configure loadouts 1–4 as Claude Code/Fable, Codex/Astra, OpenCode and Cursor, then ask a local coordinator: “Use loadout 1 to research, pass its findings to loadout 2 for planning, then split implementation across loadouts 3 and 4 in separate workspaces.” The coordinator discovers IDs, starts each stage, reads its reply and includes that text in the next task's prompt. Loadouts must be configured and their agents available. Separate workspaces do not share uncommitted files; delegation does not automatically merge their branches. This is agent-directed orchestration, not a persisted workflow scheduler.

The assistant has the same delegation tools across the user's repositories. Reads are immediate; starting, sending and cancelling tasks, and starting a flow, each use its existing Run/Cancel cards with the exact arguments shown. Start and send mutations do not run autonomously from the assistant. Its user-confirmed actions follow the CLI's user policy; workspace agents still require the repository opt-in.

The server uses Foreman's existing local socket/Windows named pipe and bundled CLI bridge; no separate installation or listening HTTP port is needed. It is available only while Foreman is open and is not provisioned to agents running in cloud sandboxes. The assistant can inspect cloud workspace state through the existing services; background check reads do not wake sleeping sandboxes. External MCP clients and settings mutations are outside this tool set.

Developers: `npm run check:mcp` checks CLI settings coverage, the reviewed MCP settings contract, and MCP/delegation behavior. New or changed settings require an explicit MCP coverage review; see [Keeping MCP coverage in sync with CLI settings](mcp-settings-coverage.md). This check records unavailable settings honestly and does not imply full CLI parity.

Dedicated tools are the primary interface. `run_foreman` is a CLI escape hatch: pass an argument array such as `["settings", "get", "appearance.theme"]`, not a shell command. Workspace agents can use help and reviewed read-only `settings list/get/keys/search/path` queries, with the CLI's existing sensitive-value filtering. Other commands, writes, file import/export and `settings path --open` are refused; operations already covered by dedicated tools direct the agent to those tools. The assistant retains its existing broader command fallback with Run/Cancel confirmation and command-policy checks. Fallback availability is recorded separately and never counts as dedicated MCP coverage.

## Several accounts for one agent

In **Settings → Agents → Claude Code**, **Codex** or **Cursor**, **Accounts** adds more accounts for that agent beside its default sign-in, such as a work one beside a personal one. A Claude Code or Codex account has its own config folder (passed as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so it keeps its own login, settings, MCP servers, custom commands and conversations), its own sign-in method and API key, and optionally its own binary. A Claude Code account can also add launch flags, except those Foreman sets itself (permissions, model, prompts, MCP servers). A Cursor account is an API key of its own. An account without a config folder shares the default one. Keys stay in Foreman's encrypted storage, apart from the default account's.

Choose the account in the model picker's **Account** row, in a chat, a new workspace or a loadout. A workspace's chats then start on the account its first chat used, and the picker shows the account beside the model. Moving a chat that already has a conversation to another account follows the agent's rule under **Accounts**: **Not allowed** (the default) offers a new chat on the other account instead, and **Allowed** starts a new conversation there that gets the earlier messages as text. Accounts that share a config folder always continue the same conversation. A chat whose account was removed stops with a message until you choose another account; it never runs on a different account by itself.

The default account still answers for the model list, the agent's readiness, the assistant and cloud workspaces (a chat in a cloud workspace must use the default account).

## Integrations

In **Settings → Integrations**, add named GitHub, Linear, Slack and Langfuse connections and choose a default for each service. In **Repository settings → Integrations**, inherit that default, select another connection, or turn a service off. A missing or broken selected connection blocks that service rather than silently using another account.

GitHub connections use a `gh` account or a personal access token. Linear connections support issue intake and agent tools with **Nothing**, **Read only**, or **Read and write** access. Slack rules can notify you, a reviewer or a channel about selected pull request and agent events; manage recipient matches under **People**. Linear, Slack and Langfuse keys stay in Foreman's encrypted storage and are not passed to agents.

A Langfuse connection is one project's key pair (Project settings → API Keys in Langfuse) and where Langfuse runs: Langfuse Cloud EU, US or HIPAA, or a self-hosted address over HTTPS. With **Read only** access, agents in repositories that use it get a `foreman-langfuse` MCP server whose tools read your app's traces through Langfuse's Observations API v2: `search_observations` (by time, trace, session, user, name, level, or any Langfuse filter), `get_trace` (every observation of one trace, with errors, cost and latency) and `get_observation`. Long inputs and outputs are cut to keep replies small. They can't change anything in Langfuse. A self-hosted Langfuse needs a version with the Observations API v2. From a terminal: `printf %s "$LANGFUSE_SECRET_KEY" | foreman connections add langfuse --public-key "$LANGFUSE_PUBLIC_KEY" --token-stdin` (add `--host` for another region or a self-hosted Langfuse).

## Git configuration backup

In **Settings → Data & devices → Git configuration backup**, connect an existing Git remote or create a private GitHub repository. **Back up now** commits readable files under `foreman-backup/` on its default branch; opt-in daily backups run while Foreman is open and make a commit only when configuration changes. **Restore from Git** previews the latest backup, lets you choose categories, and reconnects repositories and existing worktrees by their local folders.

The Git backup includes personal settings and templates, per-repository local overrides, repository registrations and active workspace registrations. It excludes chats, repository files, uncommitted work and credential values. Variable names are listed to help you set their values again after restoring. Shared `.foreman/` files remain in their source repositories. Anyone with access to the destination can read the backed-up settings and prompts.

## Command line

The `foreman` command drives the running app from a terminal or a script: start workspaces from templates, send and wait for turns, change any setting, manage repositories, pull requests, schedules and remote workspaces. `foreman help` lists the commands by group, `foreman help <command>` shows one with its options and examples, and [docs/cli.md](cli.md) has every command, the exit codes and every settings key. Every command takes `--json`.

| Group | Examples |
|---|---|
| Settings | `foreman settings set appearance.theme dark`<br>`foreman repo settings set scripts.checks-after-turn on --repo api`<br>`foreman env set OPENAI_API_KEY --repo api` |
| Work | `foreman run fix-linear-bug ENG-123 --wait`<br>`foreman send api "also add a test"`<br>`foreman wait <turn>`, `foreman approvals`, `foreman approve <id>` |
| Workspaces | `foreman ws list`<br>`foreman ws archive api` |
| Git & PRs | `foreman pr create api --draft`<br>`foreman pr merge api` |
| Repositories | `foreman repo clone https://github.com/owner/repo` |
| Remote | `foreman cloud build api` |
| Schedules | `foreman schedules add nightly-triage --repo api --every daily --at 09:00` (or `--flow fix-until-green --input task="…"`) |
| Flows | `foreman flow run fix-until-green --wait` |

Flows (graphs of agent turns, reviews, decisions, check runs, saved commands, waits on a pull request, new workspaces, gates and picks, with bounded loops, on Automations) are experimental: they and the `foreman flow` commands do nothing until **Settings → Experimental → Flows** is on, a gate is answered with `foreman approve <id> --continue`, `--send-back --note "…"` or `--stop`, and a pick among sibling results with `foreman approve <id> --pick <step>`. A flow's step can run as a persona (built-in, `.foreman/personas/*.md`, a Claude subagent in `.claude/agents` or your own, listed beside Flows and by `foreman persona list`): its instructions, read-only, the MCP servers it keeps and what it is shown apply to that step's turn, and changing one asks again before its flows run. A run's Flow tab draws it as a diagram through four lenses (Run, Context, Memory, Data: what each step was shown and how full its window got, the memory it read and wrote, the trees it worked on), `foreman flow status <run> --lens context|memory|data` prints the same facts and `foreman flow show <flow> --mermaid` prints a flow's run graph. Any workspace's **Lineage** tab draws the work done there by hand through the same four lenses (which chat was forked, handed off or delegated from which, what each turn was shown, the memory files it touched, the trees it moved between), says which links are recorded and which are inferred, and **Make a flow from this…** drafts a flow file from it; `foreman workspace lineage <workspace>` and `foreman flow draft <workspace> [--save]` do the same from a terminal. A flow starts from Automations (Run…), from **New workspace**, whose **Start with** row offers Message, Template, Flow and Issue or PR (Flow picks one of the repository's runnable flows, asks for its inputs, shows its run graph and what the run approves, and **Start flow** runs it from the form's base branch; **Create workspace only** makes the workspace without it), from a schedule (the Schedule dialog's Template | Flow choice, or `foreman schedules add --flow <flow> --input key=value`: saving approves what a run of the flow approves, its turns must be on Claude, and its loop bounds stand in for the maximum duration), from a workspace agent's `start_flow`, or from the assistant. Describe who does what ("Fable researches, Opus implements, Sonnet writes the PR text, and ask me before implementing") and the assistant drafts the flow, and a persona for a role that has none, and proposes `foreman flow add --toml "…"` (and `foreman persona add --markdown=…`) on its Run card: the card carries the whole document, so you read it before anything is saved, and nothing is saved or run until you click Run. It may also propose `foreman flow run` there; a workspace agent's `run_foreman` fallback refuses `flow run` and points at `start_flow`. A flow run's workspaces sit together in the sidebar under the flow's name, as Compare siblings do.

Foreman ships eleven flows and ten personas to start from, listed on Automations as built-in (copy one to change it). The flows: **Fix until green**; **Research then implement**; **Test first, then make it pass** (failing tests, a check that they fail, then the change); **Issue to draft pull request** (resolved, reviewed, committed after you look, then a draft pull request Foreman opens itself and CI fixed until green); **Second opinion, then pick** (one plan built in two workspaces on two loadouts, then you pick); **Two reviewers must agree** (QA, then security, both clean on the same tree); **Keep a long-lived branch fresh** (for a schedule: merge `origin/main`, fix what fails, push after you look); **Flaky test triage** (runs your saved command `flaky-tests`, then quarantines a flaky test or fixes a real failure); **Document what changed** (a docs writer, then QA checks the docs match the diff); **Is this feature worth building?** (a research report, three rounds of two independent reviews and a consensus, then the report and the consensus at a gate); and **From an idea to a feature** (requirements, design, build and QA, each with a gate to iterate). The personas: architect, developer, qa-engineer, designer, product-manager and ux-designer (they write only under `docs/features/`), security-reviewer, docs-writer (only `docs/`), researcher (only `docs/research/`) and research-reviewer. A persona's `writes` is enforced, not suggested: its turn edits files only there and has no shell, so it runs on Claude only. Review and decide steps may run on Codex, read-only, and an approval they ask for waits for you. A `pr` step opens a pull request without an agent, and a gate can show a file by its path.

Exit codes are the same for every command (0 done, 1 failed, 2 usage error, up to 8 not found); `foreman help exit-codes` has the table. Agents can run `foreman report`, `foreman review` and `foreman checks` from inside a turn and, with the repository's opt-in (**Repository settings → Actions → Let agents start workspaces and queue messages**), `foreman run`, `foreman send` and `foreman flow run`; they can never change settings. **Teach agents Foreman** in the same tab adds instructions for them.

Use the `foreman` command from the Foreman assistant: it shows the steps and the command, and runs a command when you click Run.

A default template, **Fix an issue**, is made for `foreman run`: `foreman run issue ENG-123`. A GitHub URL works as a value: `foreman run issue https://github.com/owner/repo/issues/12` fills `{{issue id}}` and attaches the issue's text as a file (it is untrusted, so it is never put in the instructions). A pull request URL also checks out the PR's head, fetched from the remote that points at the URL's repository, with the PR's base as the base branch.

To install the command, use **Settings → Advanced → foreman command → Install**:

- **macOS:** it links `/usr/local/bin/foreman`, asking for your password if that folder needs it.
- **Linux:** it falls back to `~/.local/bin` when `/usr/local/bin` isn't writable. The AppImage isn't supported, since it moves each time it runs.
- **Windows:** it adds the launcher's folder to your user PATH.

The installed command runs with Foreman's own binary, so Node.js isn't needed. From a checkout, `npm run build && npm link` works too.

The app must be running: the command talks to it over a socket in the data folder (a named pipe on Windows), readable only by you.

## Mobile access

Foreman serves a phone-sized attention inbox and workspace view from the Mac or Windows computer where agents run, and the whole app to a browser on another computer (see [In a browser](#in-a-browser)). It offers two separate connections. Both use the same pairing, desktop code confirmation and device revocation, and a paired device can do only what the access approved for it allows.

**Same Wi-Fi, without Tailscale:** Open the device chip at the top of the sidebar and choose the phone item under **Phone**. In the dialog, choose **Same Wi-Fi** and **Show QR code**, and scan it while the phone is on that network. This turns on same-Wi-Fi access for this computer's first private IPv4 address; pick another under **Connection** in the same dialog. Foreman listens only on the selected address, port `47633`, and rejects requests from outside its subnet. This mode uses plain HTTP: use it only on a network you trust. Browser push alerts and service-worker-backed PWA features require HTTPS, so they are unavailable through this local address. If the computer's address changes, select its new address and pair again.

**Private HTTPS away from home:** Install [Tailscale](https://tailscale.com/download) on the computer and phone, sign into the same tailnet, and run `tailscale serve --bg 47632` on the computer. In the phone dialog's **Connection** section, enter the resulting `https://…ts.net` address under **Anywhere (private)** and turn it on, then choose **Anywhere** → **Show QR code** and scan it. Foreman listens only on `127.0.0.1:47632` for this connection. Use **Serve**, not Funnel: Funnel would publish the service on the public internet. Add Foreman to the phone's Home Screen and tap **Enable phone alerts** for generic request and possible-stall notifications. On iPhone, web push needs an installed Home Screen web app.

**Pairing and access.** For either connection, check that the phone and the computer show the same six-digit code, choose under **What it may do**, and approve:

- **Watch:** see workspaces, chats, diffs, checks, comments and usage, and change nothing. The phone shows requests but offers no answers or actions.
- **Operate** (the default): also answer tool, plan and question requests, send, queue and steer messages, stop runs, comment on the diff, read terminals, create chats and workspaces, and archive workspaces. A phone paired before access levels existed has Operate.
- **Full control:** also change settings, repositories, keys and integrations. The phone page offers nothing beyond Operate; this level is for a browser.

Something the access doesn't allow is refused with a message that says so ("This phone can watch but not operate. Approve it again with more access."); to change a device's access, revoke it and pair it again. A phone stays signed in for a year over the private connection and a day over same Wi-Fi. The dialog lists every signed-in phone and browser with its access, connection and when it was last seen, and **Revoke** signs one out. Check commands that need approval show their command text before running. A possible stall means a running agent has produced no activity for 15 minutes; Foreman never auto-retries it.

**Live updates.** While the phone page is open it keeps a connection to Foreman, so the inbox and the open chat change as soon as something happens and a reply appears as the agent writes it. If the connection drops, the page says **Reconnecting…**, refreshes every 30 seconds meanwhile, retries at once when you come back to it, and catches up when it reconnects. If phone access is turned off on the computer, it says **Phone access is off** and looks again every minute. A phone revoked while it is open, or whose sign-in expired, is signed out at once and says so; only pairing it again brings it back.

**What a phone can do in a workspace.**

- **Queue or steer.** While the agent works, the button beside the message box says whether your message waits for the turn to end (**Queue**) or goes into it now (**Steer**). It starts at the computer's **Follow-up behavior** setting; tap it to change it for that chat. Agents that can't take a message mid-turn only queue. Queued messages are listed above the box, each with **Send now** (into the running turn) and **Delete**.
- **Comment on the diff.** In **Changes**, tap a line to comment on it, a removed line included (its comment quotes the line). Your comments wait under their lines and go with your next message, as comments written on the computer do; a message steered into a running turn doesn't take them, the next turn's does. **Delete** takes one back. An agent's open comment can be marked **Resolve**.
- **Read terminals.** **Terminal** shows the workspace's terminals, run scripts included, as plain text: the last 500 lines of each, as its tab shows them (a progress bar as drawn last, a full-screen program such as `less` as its screen), following its output while it prints, with whether it still runs or how it ended. Typing stays on the computer.
- **See usage.** The workspace menu (**⋯**) shows how full the open chat's context is, and the turns, agent time and cost of the chat and of the workspace. After a usage limit, a missed **Resume at …** offers **Resume now** and **Dismiss**.

**From a terminal.** The `foreman phone` commands do what the dialog does, for a computer with no window open or a terminal over SSH; `foreman help phone` has every option.

| Command | What it does |
|---|---|
| `foreman phone` | Both connections, every signed-in phone and browser with its kind, access, connection and when it was last seen, and a sign-in waiting for approval. Same as `foreman phone status`. |
| `foreman phone link --lan --qr` | A one-time link, good for two minutes, also drawn as a QR code. Without `--lan` or `--private` it is private when the HTTPS address is set, else same Wi-Fi; a connection that is off is turned on first. `--browser` links to the full app instead of the phone page. |
| `foreman phone pending` | The device asking to sign in, its kind and the code it shows. |
| `foreman phone approve 123456 --access read` | Approves the waiting device only if that is the code it shows, with `read` (Watch), `operate` (Operate, the default) or `admin` (Full control). |
| `foreman phone deny` | Refuses the waiting device. |
| `foreman phone revoke iPhone` | Signs a device out by its name or id, after asking (`--yes` doesn't ask). |

The commands that change who may sign in are refused from inside an agent turn.

The computer must be awake and Foreman must be running. On Windows, closing the window leaves Foreman in the tray while either mobile connection is on; to keep it running whatever the phone settings, see [Running without a window](#running-without-a-window).

## In a browser

A browser on another computer can show the whole Foreman window, not just the phone page, at `/app` on the address the phone uses (`https://<computer>.<tailnet>.ts.net/app`, or `http://<address>:47633/app` on the same Wi-Fi), with the same sign-in and the same choice of access. To sign one in, choose **Browser** in the phone dialog and **Show sign-in link**, then copy the link into the browser within two minutes; or run `foreman phone link --browser` on the computer (add `--lan` for same Wi-Fi) and open the printed link. Approve the six-digit code the browser then shows with **Sign in browser** in the phone dialog, or with `foreman phone approve <code>`. `/app` without a sign-in only says how to get one. A browser stays signed in as a phone does, is listed in the phone dialog as a browser, and is revoked the same way.

**What works.** Everything the window does, within the access approved: workspaces, chats, approvals, diffs, checks, terminals and flows, and settings with Full control. Something the access doesn't allow is refused with an error that says so.

**What doesn't.** What needs the computer's own screen or files: file pickers (paste a file or drop it on the composer instead, up to about 700 KB), **Open in…**, import and export, the embedded browser panel and its previews, dictation, updates and quitting Foreman. **Import**, **Export** and **Open in…** are hidden; the rest say "Not available in a browser". The device chip lists no other computers, and links open in a new tab.

**If the connection drops,** a banner says **Reconnecting to <computer>…** while the agents keep working there; the page retries, at once when its tab is shown again, and catches up when it is back. What you try meanwhile fails with "Not connected to Foreman". If the browser is revoked or its sign-in expires, the banner says it was signed out, and it needs a new link. If browser access is turned off on the computer, the banner says so and the page reconnects on its own once it is on again. If Foreman on the computer is updated, the banner asks you to reload the page.

## Running without a window

Foreman can run with no window open, so agents, schedules, flows, the `foreman` command, phones, browsers and paired computers keep working while the desktop stays clear. There are three ways:

- **Keep running without a window:** turn it on in **Settings → Data & devices → Devices** (`foreman settings set devices.keep-running on`). Closing the last window then leaves Foreman running instead of quitting it. macOS apps already keep running when their windows close; the setting also keeps Foreman's menu-bar icon up there.
- **Start it headless:** start Foreman with `--headless` and it opens no window at all.
  - macOS: `open -a Foreman --args --headless`
  - Windows (the installer's default folder; use yours if you chose another): `"%LOCALAPPDATA%\Programs\Foreman\Foreman.exe" --headless` from Command Prompt, or `& "$env:LOCALAPPDATA\Programs\Foreman\Foreman.exe" --headless` from PowerShell.
- **As a background service:** run `foreman service install` once, and Foreman starts headless every time you log in, so schedules and flows run without anyone opening the app. See [Starting with your login](#starting-with-your-login).

Either way the tray icon (the menu-bar icon on macOS) stays up, even with **Settings → General → Tray icon** off, because it is how you get back: **Show Foreman** or **Open Home** opens the window, as do starting Foreman again, a `foreman://` link and `foreman run --open`. A phone, a browser or another computer can do everything but what needs the window itself, such as file pickers. To stop Foreman, choose **Quit Foreman** from the tray; if agents, checks or run scripts are still going, the window opens to ask first, as Quit always does.

With no screen to approve a sign-in on, approve it from a terminal: `foreman phone link` (with `--browser` for a browser) makes the link, and `foreman phone approve <code>` approves the code the device shows (see [Mobile access](#mobile-access)). `--headless` doesn't turn on phone access by itself; `foreman phone link` turns on the connection it uses.

On Linux, which Foreman does not support officially, `--headless` still starts Electron, and Electron needs a display server: a machine without one needs a virtual one such as Xvfb.

### Starting with your login

`foreman service install` registers the Foreman that runs it to start with no window whenever you log in: a launchd agent on macOS (`~/Library/LaunchAgents/dev.foreman.app.service.plist`), a Task Scheduler task named **Foreman** on Windows, and a systemd user unit on Linux (`~/.config/systemd/user/foreman.service`). None of them needs an administrator. Foreman must be running to install it (open it once, or start it with `--headless`), and installing doesn't start or stop anything: it takes effect at the next login. `foreman service` says whether it is installed, what it starts, and whether the running Foreman is the one it started; `foreman service uninstall` removes it and leaves the running Foreman alone. Run `foreman service install` again after moving Foreman to another folder; `foreman service` says when the service starts a different copy.

The service's Foreman works like any headless Foreman: the tray icon opens the window, closing the window leaves it running, and **Quit Foreman** stops it until the next login. launchd and systemd start it again if it crashes. It also updates itself: when **Settings → General → Updates** downloads a new version (the default), the service's Foreman installs it once no agents, checks or run scripts are going and no window is open, then starts again in the background. With a window open, the update card asks as usual, and Foreman still comes back as the service's after the restart. A schedule due during the minute or so of the restart is missed, as it always is while Foreman isn't running.

On macOS, open Foreman from the Applications folder before installing: an app opened from the disk image runs from a temporary copy. On Linux, the unit takes the display the running Foreman has, or runs it under `xvfb-run` when there is none; `loginctl enable-linger` lets systemd start it at boot with nobody logged in.

## Controlling another computer

If you run Foreman on more than one computer, Mac or Windows, one computer's window can show and drive another computer's Foreman. Everything keeps running on the computer it belongs to: agents, worktrees, git, scripts, terminals and checks. The other window only sends what you type and shows what happens. The two computers talk directly over the paired, encrypted channel used for hand-offs, on the same network. There is no server in between.

**Set up once.** On the computer you want to control, open Settings → Data & devices and turn on **Let paired computers control this one**. **Ask on this screen before a computer takes control** is on by default. Pair the two computers there with **Show a code** on one and **Enter a code** on the other. Both computers must run the same version of Foreman.

**Switch.** The device chip at the top of the sidebar lists your paired computers alongside your phone. It lists your paired computers, whether each is online and what's running there. Pick one and the window loads that computer's repositories and workspaces, with a banner saying which computer you are controlling and a **Back to this computer** button. If the other computer asks first, someone there has to click **Allow**. An Allow lasts until that person disconnects you or quits Foreman.

**While you're away from it.** The chip's ▲ count and a notification tell you when a workspace on another computer needs you, with **Open on…** to switch straight to it. If the link drops, the window keeps what it last showed under a warning and retries. Sending is off until the link is back, and nothing is queued on this computer. The agents over there keep working.

**On the computer being controlled.** A chip at the top of its sidebar names the computer controlling it. Its **Disconnect** button ends the remote control; the work keeps running. Both screens stay live, so someone there can keep working alongside.

**What stays on each computer.** File pickers, **Open in…**, previews and import or export files need the computer's own screen or files, so they're unavailable while you control another computer. Switch back to use them. Dictation, links and updates use the computer you're sitting at. A computer controlling another can set keys and environment variables there, but never reads their values. Files dropped on the composer are copied over.
