# Foreman

Run coding agents in parallel, each in its own git worktree on its own branch. Claude Code, Codex, Cursor, OpenCode and other ACP agents work side by side while you review their changes, answer their questions and open pull requests from one window.

Foreman runs on your computer. There is no Foreman account or cloud service: workspaces and app data stay local, and agents connect to their model providers with your own accounts or API keys. As an experiment, a workspace can also run in a remote sandbox on your own account (Vercel Sandbox, Docker, E2B or Daytona).

![A workspace: the agent's chat in the middle, its changes on the right](docs/images/workspace-chat-dark.png)

## A look around

**Tiles.** Watch several workspaces at once and step in where you're needed.

![Two workspaces side by side in Tiles](docs/images/tiles-dark.png)

**Editor.** Prefer an editor's arrangement? Settings → Appearance → Window layout → Editor puts files and diffs in the middle, the chat beside them, and an activity bar for switching between workspaces, changes, commits, files and checks.

![The Editor layout: a file diff in the middle, the changes on the left and the chat on the right](docs/images/editor-dark.png)

**Review.** Read every change as a diff before you commit, push or open a pull request.

![A file diff with the list of changed files](docs/images/file-diff-light.png)

**Automations.** Save prompts as templates, then run them on demand or on a schedule.

![The Automations library of templates and commands, with the schedules beside it](docs/images/automations-light.png)

**Flows.** Write a way of working down once as a graph of agent steps: loops that run until the checks pass or a review comes back clean, and gates where you decide whether to go on. Start from one of eleven built-in flows, give each step a persona (architect, developer, QA engineer and seven more), or describe who does what and let the assistant draft the flow. Flows are experimental: turn them on in **Settings → Experimental → Flows**.

![A flow's page in Automations: its graph of steps, loops and a gate, with the assistant under it](docs/images/flow-light.png)

Run a flow from Automations, **New workspace**, a schedule or `foreman flow run`, and follow it on the workspace's **Flow** tab. **Full screen** puts the run in the middle of the workspace with the chat beside it.

![A flow run's diagram in the middle of the workspace, with its chat beside it](docs/images/flow-run-dark.png)

**AI employees.** Group repositories into an organization with its own memory repository, then give it employees: each one a role written in plain words, a hard hat of its own, and access you approve. Ask one for something, or let its schedule or an event (a pull request, the base branch moving, a Linear assignment) start it; it works in a fresh workspace, remembers through the memory repository, hands work to its colleagues, and asks you before anything leaves your computer. Start one from the **Personal ▾** switcher at the top of the sidebar: **New organization…** asks only for a name. `docs/ai-employees.md` has the design.

![An organization's Team page: its employees, what each needs from you, and a memory change waiting for approval](docs/images/team-light.png)

**Command line.** Most of what you do in the window can also be done from a terminal or a script with the `foreman` command: start workspaces from templates, send messages and wait for turns, answer approvals, open and merge pull requests, run flows, manage repositories, schedules and remote workspaces, and change any setting. Every command takes `--json`, and exit codes are the same for every command, so scripts and CI can rely on them. Agents use it too, from inside a turn, to report progress or ask for a review.

```bash
foreman run fix-a-bug "the login page loops after sign-in" --repo atlas --wait
foreman send atlas "also add a test for an expired token"
foreman approvals
foreman pr create atlas --draft
foreman flow run fix-until-green --input task="make the tests pass" --wait
```

`foreman help` lists the commands by group, and the [command line reference](docs/cli.md) has every one with its options and examples.

Foreman also has checkpoints you can rewind to, terminals and run scripts, file paths in the chat that open in the right app, a built-in assistant, GitHub, Linear and Slack integrations, and a phone view for approving requests away from your desk. The phone view updates live, a browser on another computer can open the whole app with the same sign-in, and Foreman can run without a window, with sign-ins approved from a terminal. A Claude Code or Codex session you run yourself can sign in to Foreman over MCP and start and follow work there, held to the access level you approve. See the [guide](docs/guide.md) for those.

## Install

Download Foreman from the [latest release](https://github.com/elite-build/foreman/releases/latest): the `.dmg` for macOS on Apple Silicon, or `Foreman-Setup-<version>.exe` for Windows. It's an ordinary desktop app; you don't need Node.js or a checkout to run it.

- The macOS app is signed and notarized, so it opens without a warning.
- The Windows installer isn't signed yet, so SmartScreen warns on first run (**More info → Run anyway**). Foreman has applied to SignPath Foundation's open-source code signing programme; see the [code signing policy](CODE_SIGNING.md).
- On Windows 11 with **Smart App Control** on, Windows blocks the unsigned installer outright, with no **Run anyway**. Until releases are signed, use a computer where it is off or in evaluation mode, or turn it off in Windows Security → App & browser control, knowing that on some Windows 11 versions it can then be turned back on only by resetting Windows ([Windows](docs/windows.md)).
- Foreman is tested on both macOS and Windows; see [Windows](docs/windows.md) for notes specific to Windows.
- Each release lists the SHA-256 checksum of every file in `SHA256SUMS.txt`. The [code signing policy](CODE_SIGNING.md#verifying-a-download) explains how to check a download against it. Every file also has a build provenance attestation from the release workflow: `gh attestation verify <file> --repo elite-build/foreman` confirms it was built by this repository's Release workflow ([build provenance](docs/maintenance.md#build-provenance)).

You'll also need:

- Git on your PATH.
- A login or API key for at least one agent, set in **Settings → Agents**.
- For GitHub actions, the `gh` CLI with a login, or a token connection in **Settings → Integrations**.

Add a local Git repository, review its setup and run commands in repository settings, then create a workspace and send a prompt. To use the `foreman` command, install it from **Settings → Advanced → foreman command → Install**; Foreman must be running for it to work.

### Build from source

With Node.js 22.12+ (22.x) or 24.x and Git:

```bash
npm install
npm run dev        # or: npm run dev demo
```

`npm run dev demo` opens the app on demo data, with no network and no agent login: your own repositories and two organizations of AI employees (eight code repositories in all), two flow runs you can watch (one waits out a usage limit, then stops at its gate), and channels that move for a few minutes after the demo is first seeded until they stand at every stage: questions, a plan, a mock to check, a part that didn't finish, a paused project, a final check and a release held at the account's usage limit until it resets. `npm run dev demo reset` starts it again from scratch, and shows the current demo data in a demo kept from before it changed. `npm run dev demo <scenario>` starts it with only what one area needs and opens on that area (`channels`, `hire-employee`; `npm run dev demo list` prints them, with the parts `--with` and `--without` add and leave out). `npm run dev` keeps its data apart from an installed Foreman, in a folder of the checkout's own that it prints at start; set `FOREMAN_DATA_DIR=/some/folder` to choose another, or run `npm run dev -- --real-data` to open the installed app's data. Run `npm link` after `npm run build` to put `foreman` on your PATH from the checkout. `npm run dev` installs the dependencies when a checkout has none, and downloads Electron's binary when it's missing; if it still says Electron failed to install, run `node node_modules/electron/install.js`.

`npm test`, `npm run typecheck` and `npm run build` are the checks; `npm run dist:mac` / `npm run dist:win` build an installer into `dist/`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for the rest.

### Releases

Releases are built by GitHub Actions from a version tag on `main`, never on a developer's computer. A maintainer bumps the version through a pull request and tags the merged commit. Then the manual **Release** workflow builds the macOS and Windows installers on GitHub-hosted runners: the macOS app is signed and notarized by Apple, and the Windows installer is signed through SignPath once that is set up. The jobs that sign wait for a maintainer's approval, and each installer is installed and started once on the runner before anything is kept. The workflow attaches the installers, the update files and `SHA256SUMS.txt` to a draft GitHub release, with a build provenance attestation for each file. A maintainer reviews the draft and publishes it. [Releases](docs/maintenance.md#releases) has the steps, and the [code signing policy](CODE_SIGNING.md) covers signing.

### Updates

An installed Foreman asks `api.github.com` whether a newer release of `elite-build/foreman` is out: a few seconds after each start, when your computer wakes, and every 4 hours (hourly or daily if you prefer). Each check is one unauthenticated request; GitHub sees your IP address and Foreman's version. When there is a new version, a card in the sidebar says so, with its release notes under **What's new**.

By default Foreman downloads the new version in the background and asks you to restart. **Restart** waits for running agents to finish first, holding new messages meanwhile; **Restart now** stops them, and they are listed for retry afterwards. You can also have it install whenever you quit, or only tell you. The Beta channel also offers prereleases. All of this is in **Settings → General → Updates**, where automatic checks can be turned off.

Foreman installs updates itself on Windows, and on macOS only when the app is signed with an Apple Developer ID, as releases after 1.0.4 are: macOS won't let an ad-hoc signed copy, such as 1.0.4 and earlier or a test build, replace itself. There, and when a release has no installers attached, the card links to the release page instead.

### Uninstall

First, if you used them: run `foreman service uninstall` so Foreman no longer starts at login, and remove the `foreman` command (below). Then quit Foreman (from the tray or menu bar too, if it is running without a window).

- **macOS.** Drag **Foreman** from Applications to the Bin. Remove the `foreman` command with `rm /usr/local/bin/foreman` or `rm ~/.local/bin/foreman`, whichever it was installed to.
- **Windows.** **Settings → Apps → Installed apps → Foreman → Uninstall**. The `foreman` command's folder (`…\resources\cli` inside Foreman's install folder) was added to your user `Path`; remove that entry in **Edit environment variables for your account**.

Uninstalling leaves your data, so a reinstall picks up where you were. To remove it too, delete the data folder: it holds the database of workspaces, chats and comments, your settings, encrypted credentials and logs.

- **macOS:** `~/Library/Application Support/Foreman`. The key its credentials are encrypted with is **Foreman Safe Storage** in Keychain Access; delete it too. Update downloads may be left in `~/Library/Caches/foreman-updater` and `~/Library/Caches/dev.foreman.app.ShipIt`.
- **Windows:** `%APPDATA%\Foreman`. Update downloads may be left in `%LOCALAPPDATA%\foreman-updater`.

Workspaces are Git worktrees in the workspaces folder (`~/foreman/workspaces` by default, or the one in Settings). Deleting it discards any work in them you haven't pushed; afterwards run `git worktree prune` in each repository you added, and delete the workspaces' branches you no longer want. Nothing is held on a Foreman server: [what leaves your computer](docs/privacy.md) lists the services Foreman contacts, whose accounts are yours to close.

## Learn more

- [Guide](docs/guide.md): repository configuration, agent tools, integrations, backups, the command line, flows, phone access and agents on this computer
- [Command line reference](docs/cli.md)
- [Design system](docs/design-system.md), [accessibility](docs/accessibility.md) and [performance with many agents](docs/performance.md)
- [Contributing](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for development conventions, and the [map](docs/map.md) of where things live, with every command and environment variable
- [Code signing policy](CODE_SIGNING.md), [security](SECURITY.md) and [what leaves your computer](docs/privacy.md)

## License

Foreman's original code is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for copyright and attribution. Third-party dependencies and separately identified material keep their own licenses, including the Wikipedia-derived [workspace names catalogue](docs/workspace-names.md); see [dependency licenses](docs/dependency-licenses.md).
