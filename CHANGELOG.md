# Changelog

Notable changes to Foreman, newest first. Versions follow [semver](https://semver.org/); see "Releases" in [docs/maintenance.md](docs/maintenance.md) for how a release is made.

## 1.0.23 (2026-11-13)

### Fixed

- A background agent that Claude resumes now shows as its own subagent row, named for what it was asked, with **Stop** and what it did since resuming, instead of a plain **SendMessage** row. ([#178](https://github.com/elite-build/foreman/pull/178))
- Picking **Limits** or **Usage** in **Settings → Data & usage**, or in settings search, now scrolls to that section instead of leaving **Data & devices** on screen. ([#179](https://github.com/elite-build/foreman/pull/179))

## 1.0.22 (2026-11-12)

### Added

- **Accounts** in Settings → Agents for Claude Code, Codex and Cursor: more than one account per agent (such as work and personal), each with its own sign-in, config folder and key, chosen in the model picker's **Account** row, with a rule for whether a chat may move between accounts. ([#161](https://github.com/elite-build/foreman/pull/161))
- **Settings → Agents** shows each agent's capabilities: what works, what works another way, what isn't offered, and who enforces its permissions. ([#173](https://github.com/elite-build/foreman/pull/173))
- **Usage → Limits** shows each account's usage windows. A chat that hits a limit waits and resumes by itself when the limit resets, and can **Continue on another account**. ([#173](https://github.com/elite-build/foreman/pull/173))
- Switching agent or account in a chat shows **What Codex received** (or another agent's name), and agents can read the turns that were left out. ([#173](https://github.com/elite-build/foreman/pull/173))
- Subagents appear under their turn with their own **Stop**, and their approvals say which subagent asked. ([#173](https://github.com/elite-build/foreman/pull/173))
- **Codex** can plan: turn on **Plan**, review its plan, and it carries on to implement it once you approve. ([#162](https://github.com/elite-build/foreman/pull/162))
- Messages you send while **Codex** works now reach it in the running turn, instead of waiting for it to finish. ([#162](https://github.com/elite-build/foreman/pull/162))
- **Sign in with ChatGPT** in Settings › Agents › Codex signs in through the browser; the terminal stays as **Use a terminal instead**. ([#162](https://github.com/elite-build/foreman/pull/162))
- Codex chats can be forked, rewound, compacted, and given a goal. ([#173](https://github.com/elite-build/foreman/pull/173))
- Claude Code and Codex sessions on this computer can sign in to Foreman over MCP and start and message work, wait for turns and answer their workers' questions, at an access level you choose when you approve them in **Settings → Data & devices → Agents on this computer**. ([#170](https://github.com/elite-build/foreman/pull/170))
- An outside agent at **Auto** or **Never ask** can propose a schedule, which waits in **Automations** until you approve it. ([#170](https://github.com/elite-build/foreman/pull/170))
- `foreman service install` starts Foreman with no window whenever you log in, so schedules, flows and phones keep working without opening the app; `foreman service` and `foreman service uninstall` show and remove it, and `foreman service restart` stops it and starts it again, then waits for it to answer (`--force` restarts even with agents running). ([#167](https://github.com/elite-build/foreman/pull/167), [#169](https://github.com/elite-build/foreman/pull/169))
- Foreman started by the background service installs a downloaded update by itself once nothing is running and no window is open, then starts again in the background. It copies your data aside first: if the new version can't open it and start, your data is put back as it was, `foreman service` says how the last update went, and a version that failed isn't installed by itself again. ([#167](https://github.com/elite-build/foreman/pull/167), [#169](https://github.com/elite-build/foreman/pull/169))
- Run Foreman without a window with `--headless`, or keep it running in the tray after the last window closes with **Keep running without a window**. ([#163](https://github.com/elite-build/foreman/pull/163))
- Open the whole Foreman in a browser at `/app` on the phone's address, signed in from the phone dialog's **Browser** choice or `foreman phone link --browser`. ([#163](https://github.com/elite-build/foreman/pull/163))
- Pairing a phone now chooses what it may do: **Watch**, **Operate** or **Full control**. ([#163](https://github.com/elite-build/foreman/pull/163))
- `foreman phone` signs phones and browsers in from a terminal: `status`, `link`, `pending`, `approve`, `deny`, `revoke`. ([#163](https://github.com/elite-build/foreman/pull/163))
- The phone updates live as agents work instead of refreshing every few seconds, shows a reply as it is written, and says when it is reconnecting or has been signed out. ([#163](https://github.com/elite-build/foreman/pull/163))
- A paired phone can **Steer** a running turn or **Queue** a message, and **Send now** or **Delete** queued messages. ([#166](https://github.com/elite-build/foreman/pull/166))
- A paired phone can comment on a line in **Changes**, a removed line too (the comment quotes it for the agent), delete its comments and **Resolve** the agent's. The comments go with the next message. ([#166](https://github.com/elite-build/foreman/pull/166), [#168](https://github.com/elite-build/foreman/pull/168))
- A paired phone has a read-only **Terminal** tab that follows the workspace's terminals and run scripts as they print. ([#166](https://github.com/elite-build/foreman/pull/166))
- The phone's workspace menu shows how full the chat's context is, and the turns, agent time and cost of the chat and the workspace. ([#166](https://github.com/elite-build/foreman/pull/166))
- After a usage limit, a missed resume on the phone offers **Resume now** and **Dismiss**. ([#166](https://github.com/elite-build/foreman/pull/166))

### Changed

- With **Codex tool approvals** set to **Sandboxed**, Codex asks before leaving its sandbox instead of being stopped there. ([#162](https://github.com/elite-build/foreman/pull/162))
- Cursor, OpenCode and chat agents can **Interrupt and send** a follow-up, and their questions and terminal commands appear in the chat. ([#173](https://github.com/elite-build/foreman/pull/173))
- An agent that fails to start says why in one sentence, and Settings shows whether its version was tested, with **Update**. ([#173](https://github.com/elite-build/foreman/pull/173))
- A phone's **Terminal** tab shows each terminal as its tab on the computer does, so progress bars, Windows terminal repaints and full-screen programs such as `less` read correctly. ([#168](https://github.com/elite-build/foreman/pull/168))

### Fixed

- Rewinding a chat on Cursor, OpenCode or a chat agent keeps the conversation up to that point instead of starting with no history. ([#173](https://github.com/elite-build/foreman/pull/173))
- While set to **Steer**, a phone no longer says your diff comments go with the message; they wait for the next turn. ([#168](https://github.com/elite-build/foreman/pull/168))

### Security

- Pairing links and codes are shown only to devices with full control. ([#163](https://github.com/elite-build/foreman/pull/163))

### Development

- Adapter tests replay recorded agent traffic (`npm run record:agent`), and model-facing text has hand-run evals (`npm run evals`). ([#173](https://github.com/elite-build/foreman/pull/173))
- The Windows release build can be signed through SignPath Foundation once Foreman is approved; until then the Windows installer stays unsigned, and **CODE_SIGNING.md** explains the policy and how to verify a download. ([#175](https://github.com/elite-build/foreman/pull/175))
- `npm run check:security` passes again: it no longer flags the recorded agent fixtures' message IDs or the sanitizer test's dummy JWT. The persona template test passes on Windows checkouts that use CRLF line endings. ([#176](https://github.com/elite-build/foreman/pull/176))

## 1.0.21 (2026-11-09)

### Added

- **New flow** asks what the flow is called and where it starts: **Blank**, **Describe it**, or a copy of a flow. ([#121](https://github.com/elite-build/foreman/pull/121))
- Rename a flow, and edit its description, from the top of its page (the pencil, F2, or **Rename** in its menu and on its card); a built-in flow's card offers **Rename a copy…**. ([#121](https://github.com/elite-build/foreman/pull/121))
- Rename a step from the panel beside the graph; every edge, loop and step that names it follows, with **Undo**. ([#121](https://github.com/elite-build/foreman/pull/121))

### Changed

- The **Flow** tab's **Full screen** is now a button beside **Run** · **Context** · **Memory** · **Data**, where the graph's scroll bar can't cover it, and **Back to the panel** in the same spot puts the run back. ([#123](https://github.com/elite-build/foreman/pull/123))

### Fixed

- A workspace whose pull request merged shows **Archive** again when a test run has only changed a file's line endings, instead of **Create PR**. ([#122](https://github.com/elite-build/foreman/pull/122))

## 1.0.20 (2026-11-08)

### Changed

- **Full screen** for the terminal (Ctrl/⌘+Shift+J) and the **Flow** tab's run (its graph's full-screen button, or Ctrl/⌘+Shift+K) now puts it in the middle of the workspace with the chat beside it in the side panel's new **Chat** tab. It stays until you put it back, across restarts, and Esc no longer leaves it. ([#119](https://github.com/elite-build/foreman/pull/119))
- The **Flow** tab opens on the run's diagram, without the flow's name, state, times and row of steps above it that repeated what the diagram shows. ([#117](https://github.com/elite-build/foreman/pull/117), [#118](https://github.com/elite-build/foreman/pull/118))
- When you start a flow, every input it asks for (such as the **idea** for **From an idea to a feature**) has a text area to write in, not a one-line box. ([#114](https://github.com/elite-build/foreman/pull/114))

### Development

- `npm run dev demo` opens the development app on demo data (repositories, workspaces, chats, diffs and a flow run) with no network, kept between launches, and starts a flow run each time it opens so you can watch a flow move through its steps and wait at its gate; agents answer from a script. `npm run dev demo reset` starts it again from scratch. ([#113](https://github.com/elite-build/foreman/pull/113), [#116](https://github.com/elite-build/foreman/pull/116))
- `npm run test:changed` runs only the tests a branch's changes can affect, for a faster loop while working. ([#115](https://github.com/elite-build/foreman/pull/115))

## 1.0.19 (2026-11-08)

### Changed

- New workspace's **Flow** tab lists the repository's flows to pick from, and shows that the run starts in a new worktree. ([#111](https://github.com/elite-build/foreman/pull/111))
- A flow run's **Flow** tab says where the run is or where it stopped, shows its steps as a row marking what ran, where it is and what it hasn't reached, and **Why it stopped** opens the failed step's chat. ([#110](https://github.com/elite-build/foreman/pull/110))

### Fixed

- A flow run whose agent wasn't signed in now waits for you, and goes on when you sign in and press **Retry** in the step's chat, instead of ending as **Failed**. ([#108](https://github.com/elite-build/foreman/pull/108))
- An agent in a flow run's workspace can now say which step the run is at and why it stopped or is waiting, instead of guessing. ([#109](https://github.com/elite-build/foreman/pull/109))
- A run that ended short no longer ends at a cut-off "done · f…" on its graph; the end reads **failed**, **stopped**, **needs you** or **uncertain** in full. ([#110](https://github.com/elite-build/foreman/pull/110))

## 1.0.18 (2026-11-08)

### Added

- With **Flows** on, **Automations** has **Flows** and **Personas** tabs beside **Templates** and **Commands**. ([#104](https://github.com/elite-build/foreman/pull/104))
- Choose a flow run's models: **Faster**, **Balanced** or **Best** for the whole run, a model and effort per persona under **Who works on it**, or per step on **Steps**. Your choices are remembered per flow, and **Save to the flow** keeps them in a personal flow. A flow step can also set `effort` in its flow file. ([#105](https://github.com/elite-build/foreman/pull/105))

### Changed

- Running a flow opens a **Run a flow** page in **Automations**, with its inputs, models and approval in tabs beside the flow's graph; **Run** on a flow and the **Flow** tab in **New workspace** open it. ([#105](https://github.com/elite-build/foreman/pull/105))
- The built-in personas end the way a flow reads them, so a clean review no longer counts as undecided and a reviewer no longer tries to run tests in a step without a shell. ([#106](https://github.com/elite-build/foreman/pull/106))

### Development

- `docs/persona-template.md` is the template every built-in persona follows, with the review that produced it. ([#106](https://github.com/elite-build/foreman/pull/106))
- `npm run dev` in a Foreman workspace serves the renderer from the workspace's reserved port, so it no longer fails with `EACCES` when Windows has reserved port 5173. ([#103](https://github.com/elite-build/foreman/pull/103))

## 1.0.17 (2026-11-07)

### Added

- With **Flows** on, a flow opens as its own page on **Automations**. Its graph is drawn at a readable size with zoom and full screen, a selected step's details sit beside it, and **Assistant**, **Steps**, **TOML** and **Problems** tabs sit under it. The assistant proposes changes you see on the graph and apply only if you want them. ([#101](https://github.com/elite-build/foreman/pull/101))

### Changed

- The **Flow** and **Lineage** tabs draw readable graphs you can click to open a step's chat or checks. The **Flow** tab answers a waiting gate and says why a run stopped. ([#101](https://github.com/elite-build/foreman/pull/101))
- The **Run** dialog shows what to do beside what the run does, step by step. Each flow card shows its graph, and **Flows** can list every flow's runs. ([#101](https://github.com/elite-build/foreman/pull/101))

## 1.0.16 (2026-11-07)

### Added

- Ten built-in personas and eleven built-in flows, from **Test first** to **From an idea to a feature** (product manager, UX designer, developer and QA, with you deciding after each) and **Is this feature worth building?** (a report drafted by Opus and reviewed three times by Fable and a Codex model, with a consensus each round). ([#99](https://github.com/elite-build/foreman/pull/99))
- A persona can be allowed to write only inside chosen folders, such as `docs/features/`, with the shell off; a loop can run a set number of rounds and then move on; a flow can open its own draft pull request; a gate can show the file it asks about. ([#99](https://github.com/elite-build/foreman/pull/99))

### Changed

- Clicking a template in **Automations** opens it as its own page, with a wide prompt beside its schedules and recent runs; **Duplicate** and **Delete** are in its **⋯** menu. ([#93](https://github.com/elite-build/foreman/pull/93))
- Read-only review and decide steps in a flow can run on a Codex model, including GPT-6 Astra. ([#99](https://github.com/elite-build/foreman/pull/99))

### Fixed

- The **turns stopped when Foreman closed** warning on Home shows only on the repository those turns belong to, and **Review and retry…** lists and dismisses only that repository's turns. ([#94](https://github.com/elite-build/foreman/pull/94))
- Codex models show the context window Codex actually works with (272K for GPT-6 Astra instead of 200K), so the **context** meter and a flow's compact-when-full loop use the right size. ([#95](https://github.com/elite-build/foreman/pull/95))
- After a pull request merges, a workspace where work carries on for another PR offers **Create PR** again instead of **Archive and delete branch**. ([#96](https://github.com/elite-build/foreman/pull/96))
- A save of `state.json` could lose its temporary file to a flush at the same moment; each write now has its own. ([#99](https://github.com/elite-build/foreman/pull/99))

### Development

- Releases keep their installers and update files, so installed copies can update themselves from every release. ([#92](https://github.com/elite-build/foreman/pull/92))

## 1.0.15 (2026-11-06)

### Added

- **Flows**, off by default under **Settings → Experimental**: write a graph of agent steps with loops and gates once, run it from **Automations**, **New workspace**, a schedule, the assistant or the `foreman flow` command, and watch it through a **Flow** tab with Run, Context, Memory and Data lenses. ([#88](https://github.com/elite-build/foreman/pull/88))
- **Personas** for flow steps (architect, developer, QA engineer, designer built in; your own beside the flows), setting a step's instructions, read-only, what it is shown and how it ends. ([#88](https://github.com/elite-build/foreman/pull/88))
- Gates: a flow step where you decide, with **Continue**, **Send back with a note** and **Stop**, in Needs you and on the phone. ([#88](https://github.com/elite-build/foreman/pull/88))
- A **Lineage** tab on every workspace (with Flows on) that draws how its chats, turns, checks and pull request came about, and **Make a flow from this** to turn that history into a draft flow. ([#88](https://github.com/elite-build/foreman/pull/88))
- Click a file path in the chat to open it: pages open in your browser, pictures in your image viewer and code in your editor. **Ctrl-click** (**⌘-click** on Mac) shows the file in File Explorer or Finder, and right-click offers **Preview in Foreman** and **Copy path**. Programs and archives are only shown in their folder, never run. ([#86](https://github.com/elite-build/foreman/pull/86))
- Repositories in the sidebar get their own icon when they're added: the project's app icon or logo, its organisation's avatar, or a fitting icon, chosen once; one you pick or remove in **Repository settings → Misc** is kept. ([#87](https://github.com/elite-build/foreman/pull/87))

### Changed

- The repository rail shows tiles alone, and **Show repository names** (Ctrl+Shift+N, ⌘⇧N on macOS) widens it beside the workspace list to show each repository's name and what is going on in it; pressing it again narrows it. It replaces the Repositories drawer, which covered the list. ([#89](https://github.com/elite-build/foreman/pull/89))
- A repository that needs you shows a ▲ and a count on its tile in the rail. ([#89](https://github.com/elite-build/foreman/pull/89))

### Fixed

- `npm run pr:screens` no longer empties `node_modules` on Windows. ([#88](https://github.com/elite-build/foreman/pull/88))

### Security

- follow-redirects updated to 1.16.2, fixing [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p) (credentials could follow a cross-origin redirect). ([#90](https://github.com/elite-build/foreman/pull/90))

### Development

- Agents asked to cut a release follow a new `create-release` skill, which writes the release's `CHANGELOG.md` entry from the merged PRs' release notes and uses it as the GitHub release's text. ([#83](https://github.com/elite-build/foreman/pull/83))
- A commit that uses a new design-system component before that component is on `main` is now blocked by the pre-commit hook, and agents are told to ask for the component first. ([#84](https://github.com/elite-build/foreman/pull/84))
- Pushing a branch that still holds a design mock (`mocks/`, `mockups/`, `mock*.html`) is refused, so mocks stay in the workspace and never reach a pull request or `main`. ([#85](https://github.com/elite-build/foreman/pull/85))

## 1.0.2 (2026-10-27)

### Added

- Foreman keeps checking for new releases (at start, on wake and on a schedule; Stable or Beta channel) and, on Windows, downloads them in the background and installs on restart or quit. The sidebar card and **Settings → General → Updates** show progress and choices, and **What's new** shows the release notes. The macOS app is ad-hoc signed, so it still opens the release page instead. Only copies from this version on can update themselves. ([#36](https://github.com/elite-build/foreman/pull/36))
- A progress strip (Committed → PR → Checks → Merged) in the side panel once a PR is merged, so a merged PR stands out. ([#34](https://github.com/elite-build/foreman/pull/34), [#35](https://github.com/elite-build/foreman/pull/35))

### Changed

- The archive dialog's branch has its own **Keep / Delete** row, so choosing no longer moves it between columns. The merged header remembers whether you last archived with or without deleting the branch. ([#35](https://github.com/elite-build/foreman/pull/35))
- Installer file names no longer contain spaces, and releases carry the update files (`latest.yml`, `latest-mac.yml`, the macOS zip and blockmaps). ([#36](https://github.com/elite-build/foreman/pull/36))

## 1.0.1 (2026-10-27)

### Fixed

- Plans from ACP agents (such as OpenCode) show in the chat again. The ACP SDK 2.0 bump had dropped the `plan_update` messages they're sent in. ([#32](https://github.com/elite-build/foreman/pull/32))
- The macOS app is ad-hoc signed, so a downloaded DMG can be opened with **Open Anyway** instead of being killed at launch. ([#31](https://github.com/elite-build/foreman/pull/31))

### Changed

- Electron 45 (from 44.9.3). ([#1](https://github.com/elite-build/foreman/pull/1))
- `@agentclientprotocol/sdk` 2.0.1 (from 1.8.0). Foreman uses its `/unstable` entry point, which matches how 1.8 behaved. ([#2](https://github.com/elite-build/foreman/pull/2), [#32](https://github.com/elite-build/foreman/pull/32))
- `lucide-react` 1.61.0 (from 1.57.0) and `@babel/parser` 8.0.7 (from 7.29.9). ([#3](https://github.com/elite-build/foreman/pull/3), [#5](https://github.com/elite-build/foreman/pull/5))
- A shorter README with screenshots. ([#30](https://github.com/elite-build/foreman/pull/30))

### Development

- `@types/node` stays on 22.x, the oldest Node Foreman supports (a bump to 26.x was reverted). ([#4](https://github.com/elite-build/foreman/pull/4), [#32](https://github.com/elite-build/foreman/pull/32))
- The viewed-marks test no longer fails on fast machines. ([#32](https://github.com/elite-build/foreman/pull/32))

## 1.0.0 (2026-10-27)

First release. Highlights:

- Foreman tells you when a newer version is released, and shows the running version in the sidebar footer. ([#27](https://github.com/elite-build/foreman/pull/27), [#28](https://github.com/elite-build/foreman/pull/28))
- CPU and memory stay flat when many agents run in parallel. ([#25](https://github.com/elite-build/foreman/pull/25))
- Tighter local CLI socket authorization and bridge input checks. ([#14](https://github.com/elite-build/foreman/pull/14))
- Screen capture stays refused when Electron reports it as display capture. ([#17](https://github.com/elite-build/foreman/pull/17))
- The vulnerable `zod` is out of the Vercel sandbox auth chain. ([#13](https://github.com/elite-build/foreman/pull/13))
- Composer and Daytona sandbox fixes on macOS. ([#7](https://github.com/elite-build/foreman/pull/7), [#9](https://github.com/elite-build/foreman/pull/9), [#10](https://github.com/elite-build/foreman/pull/10))
- A release process, manually started installer builds for macOS and Windows, and third-party notices generated from the packaged app. ([#12](https://github.com/elite-build/foreman/pull/12), [#24](https://github.com/elite-build/foreman/pull/24), [#26](https://github.com/elite-build/foreman/pull/26))

Full list: [v1.0.0 release](https://github.com/elite-build/foreman/releases/tag/v1.0.0).
