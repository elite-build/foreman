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

For an agent to coordinate work, enable **Repository settings → Actions → Let agents start workspaces and queue messages**. With that opt-in, delegation tools can start tasks and inspect replies, queue messages or cancel turns in the same repository. Cross-repository access is refused; disabling the opt-in removes cross-workspace access immediately. A coordinator cannot wait on or cancel its own chat, including turns queued behind it. Reads exclude reasoning, tool output and user messages. Failed setup remains held for the user; the tools cannot approve scripts or bypass setup. Task creation and execution use the existing CLI/app services and their policies.

For example, configure loadouts 1–4 as Claude Code/Fable, Codex/Astra, OpenCode and Cursor, then ask a local coordinator: “Use loadout 1 to research, pass its findings to loadout 2 for planning, then split implementation across loadouts 3 and 4 in separate workspaces.” The coordinator discovers IDs, starts each stage, reads its reply and includes that text in the next task's prompt. Loadouts must be configured and their agents available. Separate workspaces do not share uncommitted files; delegation does not automatically merge their branches. This is agent-directed orchestration, not a persisted workflow scheduler.

The assistant has the same delegation tools across the user's repositories. Reads are immediate; starting, sending and cancelling tasks each use its existing Run/Cancel cards with the exact arguments shown. Start and send mutations do not run autonomously from the assistant. Its user-confirmed actions follow the CLI's user policy; workspace agents still require the repository opt-in.

The server uses Foreman's existing local socket/Windows named pipe and bundled CLI bridge; no separate installation or listening HTTP port is needed. It is available only while Foreman is open and is not provisioned to agents running in cloud sandboxes. The assistant can inspect cloud workspace state through the existing services; background check reads do not wake sleeping sandboxes. External MCP clients and settings mutations are outside this tool set.

Developers: `npm run check:mcp` checks CLI settings coverage, the reviewed MCP settings contract, and MCP/delegation behavior. New or changed settings require an explicit MCP coverage review; see [Keeping MCP coverage in sync with CLI settings](mcp-settings-coverage.md). This check records unavailable settings honestly and does not imply full CLI parity.

Dedicated tools are the primary interface. `run_foreman` is a CLI escape hatch: pass an argument array such as `["settings", "get", "appearance.theme"]`, not a shell command. Workspace agents can use help and reviewed read-only `settings list/get/keys/search/path` queries, with the CLI's existing sensitive-value filtering. Other commands, writes, file import/export and `settings path --open` are refused; operations already covered by dedicated tools direct the agent to those tools. The assistant retains its existing broader command fallback with Run/Cancel confirmation and command-policy checks. Fallback availability is recorded separately and never counts as dedicated MCP coverage.

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
| Schedules | `foreman schedules add nightly-triage --repo api --every daily --at 09:00` |

Exit codes are the same for every command (0 done, 1 failed, 2 usage error, up to 8 not found); `foreman help exit-codes` has the table. Agents can run `foreman report`, `foreman review` and `foreman checks` from inside a turn and, with the repository's opt-in (**Repository settings → Actions → Let agents start workspaces and queue messages**), `foreman run` and `foreman send`; they can never change settings. **Teach agents Foreman** in the same tab adds instructions for them.

Use the `foreman` command from the Foreman assistant: it shows the steps and the command, and runs a command when you click Run.

A default template, **Fix an issue**, is made for `foreman run`: `foreman run issue ENG-123`. A GitHub URL works as a value: `foreman run issue https://github.com/owner/repo/issues/12` fills `{{issue id}}` and attaches the issue's text as a file (it is untrusted, so it is never put in the instructions). A pull request URL also checks out the PR's head, fetched from the remote that points at the URL's repository, with the PR's base as the base branch.

To install the command, use **Settings → Advanced → foreman command → Install**:

- **macOS:** it links `/usr/local/bin/foreman`, asking for your password if that folder needs it.
- **Linux:** it falls back to `~/.local/bin` when `/usr/local/bin` isn't writable. The AppImage isn't supported, since it moves each time it runs.
- **Windows:** it adds the launcher's folder to your user PATH.

The installed command runs with Foreman's own binary, so Node.js isn't needed. From a checkout, `npm run build && npm link` works too.

The app must be running: the command talks to it over a socket in the data folder (a named pipe on Windows), readable only by you.

## Mobile access

Foreman serves a phone-sized attention inbox and workspace view from the Mac or Windows computer where agents run. It offers two separate connections. Both use the same QR pairing, desktop code confirmation and device revocation. Foreman does not expose the desktop API or terminal to the phone.

**Same Wi-Fi, without Tailscale:** Click the phone pill at the top of the sidebar, choose **Same Wi-Fi** and **Show QR code**, and scan it while the phone is on that network. This turns on same-Wi-Fi access for this computer's first private IPv4 address; pick another under **Network setup…**. Foreman listens only on the selected address, port `47633`, and rejects requests from outside its subnet. This mode uses plain HTTP: use it only on a network you trust. Browser push alerts and service-worker-backed PWA features require HTTPS, so they are unavailable through this local address. If the computer's address changes, select its new address and pair again.

**Private HTTPS away from home:** Install [Tailscale](https://tailscale.com/download) on the computer and phone, sign into the same tailnet, and run `tailscale serve --bg 47632` on the computer. In the phone pill's **Network setup…**, enter the resulting `https://…ts.net` address under **Anywhere (private)** and turn it on, then choose **Anywhere** → **Show QR code** and scan it. Foreman listens only on `127.0.0.1:47632` for this connection. Use **Serve**, not Funnel: Funnel would publish the service on the public internet. Add Foreman to the phone's Home Screen and tap **Enable phone alerts** for generic request and possible-stall notifications. On iPhone, web push needs an installed Home Screen web app.

For either connection, match the six-digit code on the phone and computer before approving the pairing. You can revoke either kind of phone from the phone pill. The phone can answer tool, plan and question requests; read chats, diffs, checks and PR status; send messages; stop runs; create chats and workspaces; and archive workspaces. Check commands that need approval show their command text before running. A possible stall means a running agent has produced no activity for 15 minutes; Foreman never auto-retries it. The computer must be awake and Foreman must be running. On Windows, closing the window leaves Foreman in the tray while either mobile connection is on.
