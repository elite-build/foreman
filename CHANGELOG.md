# Changelog

Notable changes to Foreman, newest first. Versions follow [semver](https://semver.org/); see "Releases" in [docs/maintenance.md](docs/maintenance.md) for how a release is made.

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
