# Map

Where things live in the code, the environment variables Foreman reads and sets, and every npm script. This is reference for [AGENTS.md](../AGENTS.md), which holds the rules: it is loaded into every call an agent makes, so facts to look up are kept here and read when a task needs them.

## Areas and entry points

The main process uses Node APIs; the renderer is sandboxed. Terminal support is `node-pty` plus xterm.js.

| Area | Entry points and responsibilities |
| --- | --- |
| Desktop lifecycle | `src/main/index.ts`: Electron windows, native integration, service startup, IPC handlers and event broadcasts. |
| Application services | `src/main/core.ts`: composes services and implements the renderer-facing API. Electron capabilities are injected through `Host` so the core stays testable without importing Electron. |
| Renderer bridge | `src/preload/index.ts`: exposes `window.foreman` with typed invoke, signals and event subscriptions. `src/shared/types.ts` defines `Api`, `Bridge`, `MainEvent`, `API_METHODS` and `SIGNAL_METHODS`. |
| Renderer | `src/renderer/index.html` → `src/renderer/src/main.tsx` → `App.tsx`; `store.ts` owns snapshot/event state and `useStore` via React `useSyncExternalStore`. Feature views live in `components/`; no separate router or state library is needed for ordinary additions. |
| UI system | `src/renderer/src/ui/`: controls, prop types, tokens, component CSS, keyboard helpers and galleries. `components/settings/controls.tsx` contains application-specific settings compositions and save helpers, not a competing primitive kit. |
| Shared domain | `src/shared/`: contracts and reusable domain logic, settings schemas/registries, agent capabilities, CLI definitions and i18n. Keep reusable pure logic here rather than copying it into main and renderer. |
| Agents and sessions | `src/main/sessions.ts`, `agents/types.ts`, `agents/registry.ts`: common driver contract and Claude, Codex, Cursor, OpenCode (its own server) and ACP adapters. `agentHost/` handles hosted turns; `cursorWorker.ts` is a separate build entry. Respect capability flags and existing approval/read-only policies. The design is [agents.md](agents.md). |
| Workspaces and execution | `workspaces.ts`, `git.ts`, `checkpoints.ts`, `scripts.ts`, `pty.ts`, `platform.ts`, `shells.ts` in `src/main/`. Reuse platform quoting and process helpers; do not assume POSIX shells on Windows. |
| Remote workspaces | `src/main/cloud/` and `runtime/`: sandbox providers (Vercel, Docker, E2B, Daytona), execution and file/Git routing. Use the existing workspace target/runtime helpers; a cloud workspace is not a local filesystem path. Background reads must not wake sleeping sandboxes. |
| Command line | `bin/foreman.mjs` launches built `out/main/cli.js`; `src/cli/index.ts` dispatches `commands/`. `src/shared/cliCommands.ts` and `src/shared/cli/` define command metadata; `src/main/cli/` serves the local socket API. `cliServer.ts` is a compatibility re-export. |
| Persistence | `src/main/store.ts`, `db.ts`, `legacyImport.ts`, `secrets.ts`; the rules are "Data, authentication and authorization" in `AGENTS.md`. |
| Integrations | `github.ts`, `gitlab.ts`, `scm.ts`, `integrations.ts`, `linear.ts`, `slack.ts`, `integrationBridge.ts`, `repoMcp.ts` in `src/main/`. Extend the existing service and credential selection paths. |
| Flows and automations | `src/main/flows.ts`, `schedules.ts`, `autoFix.ts`, `autoReview.ts`, pure rules in `src/shared/flows.ts` and its `flow*.ts` neighbours, the views in `components/automations/`. The design is [loops-and-graphs.md](loops-and-graphs.md). |
| AI employees | `organizations.ts`, `memory.ts` (the only writer of an organization's memory repository), `employees.ts`, `employeeWork.ts` (tasks, runs and the broker), `employeeTools.ts`, `employeeActions.ts`, `employeeTriggers.ts`, `employeeEvents.ts` in `src/main/`, pure rules beside them in `src/shared/`, the views in `components/spaces/` and `components/employees/`. The design is [ai-employees.md](ai-employees.md). |
| Phone and devices | `resources/mobile/` is a separate small web client. `src/main/mobile.ts` serves paired-phone access; device pairing, network and transfer services live alongside it. The desktop UI catalogue does not govern the phone stylesheet. |
| Tests | `tests/*.test.ts` for domain/services and integration behaviour; `tests/*.test.tsx` and `tests/ui/` for renderer behaviour; `tests/helpers.ts` for temporary Git repos and other helpers; `tests/fixtures/` for fixtures, including guard examples. |
| Tooling and references | `scripts/`, `.githooks/`, `.github/`, root build/test configs; `docs/` for guides and `build/icons/` for production icon sources. |

### Files too large to read whole

Search these and read a range; `AGENTS.md`, "Reading, and long sessions", has the rule.

| File | Size | How to work in it |
| --- | --- | --- |
| `src/shared/i18n/en.ts` and the seven other locales | about 8,500 to 9,300 lines each | `rg` the key in `en.ts`, then the same key in each locale. |
| `src/shared/workspacePeople.json` | about 14,000 lines | Generated by `scripts/buildWorkspacePeople.py`; see [workspace-names.md](workspace-names.md). |
| `src/main/core.ts` | about 5,000 lines | `rg` the `Api` method's name. |
| `src/shared/types.ts` | about 3,400 lines | `rg` the type's name. |
| `src/main/sessions.ts`, `src/main/employeeWork.ts` | about 3,000 and 2,500 lines | `rg` the method's name. |
| `src/main/agents/codex/protocol/` | over 100 generated files | Generated by `scripts/gen-agent-protocols.mjs`; open the one type you need. |
| `docs/cli.md` | about 290,000 characters | Generated by `npm run docs:cli`; `rg` the command's name. |

## Configuration and environment

There is no mandatory repository `.env` file for building or running the ordinary test suite. Provider credentials are needed to actually run agents; optional services require their own configuration.

| Setting | Meaning |
| --- | --- |
| `FOREMAN_DATA_DIR` | Isolate development/test state from installed app data; `SWITCHYARD_DATA_DIR` is a legacy fallback. Use a disposable folder for manual tests. Without it, `npm run dev` sets it to the worktree's own folder, `<appData>/Foreman Dev/<worktree>-<hash of its path>` (`scripts/devData.mjs`), outside the worktree so it survives Foreman making the worktree again, and prints where; `npm run dev -- --real-data` leaves it unset, so the development app opens the installed app's data. Packaged builds and `npm run dev demo` are unaffected. |
| `FOREMAN_DEMO`, `FOREMAN_DEMO_RESET`, `FOREMAN_DEMO_DIR` | Set by `npm run dev demo [reset]` (`scripts/dev.mjs`); ignored by an installed build. `FOREMAN_DEMO_DIR` chooses the demo's folder, default `Foreman Demo` beside the app's data folder (`Foreman Demo (<scenario>)` for a scenario other than `full`). A folder with files that isn't a demo's is refused, never deleted. |
| `FOREMAN_SCENARIO`, `FOREMAN_SCENARIO_WITH`, `FOREMAN_SCENARIO_WITHOUT` | What the demo or a screenshot run starts with (`src/shared/scenarios.ts`): a scenario's name, and parts to add and leave out. Set by `npm run dev demo <scenario> [--with …] [--without …]` and `npm run screens -- --scenario <name>`; prefer those. |
| `FOREMAN_PORT` | First port in a local workspace's reserved block of 10. Use the assigned block for development servers. Cloud workspaces expose sandbox URLs instead. |
| `FOREMAN_WORKSPACE_ID`, `FOREMAN_WORKSPACE_NAME`, `FOREMAN_WORKSPACE_PATH`, `FOREMAN_ROOT_PATH`, `FOREMAN_DEFAULT_BRANCH` | Context supplied to workspace scripts, terminals and agents; see `WorkspaceService.env` in `src/main/workspaces.ts`. Environment-file and secret layering lives in `src/main/environment.ts`. |
| `FOREMAN_IS_CLOUD` | Set to `1` for cloud workspaces; their path variables refer to the sandbox. |
| `ELECTRON_RENDERER_URL` | Development renderer URL consumed by main; managed by electron-vite. Do not hard-code it for production. |
| `FOREMAN_SCREENSHOTS*` | Fixture/screenshot controls managed by `scripts/screenshots.mjs` and `src/main/screenshots.ts`; prefer `npm run screens` over setting them manually. |
| `FOREMAN_VERCEL_TOKEN`, `FOREMAN_VERCEL_TEAM_ID`, `FOREMAN_VERCEL_PROJECT_ID` | Opt-in live Vercel smoke test credentials. The test creates real sandboxes; ordinary tests skip it when these are absent. |

Shared repository settings live in `.foreman/settings.toml`; `.switchyard/settings.toml` is the compatibility fallback for this app's earlier name. Workspace scripts receive `FOREMAN_*` and the earlier `SWITCHYARD_*` aliases only. Local overrides take precedence over shared settings, then supported user settings, then defaults; `src/main/repoSettings.ts` and the shared settings schemas/registries implement that. Shared MCP configuration names environment variables, not their secret values.

## Commands

These come from `package.json`. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`; changing machine execution policy is unnecessary. There is no configured lint/formatter script.

| Command | Purpose |
| --- | --- |
| `npm install` / `npm ci` | Install dependencies (clean reproducible installs use `ci`). Postinstall fixes Unix PTY helper permissions and configures hooks when appropriate. |
| `npm run dev` | Run the Electron app with electron-vite development builds, on the worktree's own data folder (printed at start; see `FOREMAN_DATA_DIR`). `npm run dev -- --real-data` runs it on the installed app's data instead. |
| `npm run dev demo` | The development app on demo data (`src/main/demo.ts`): the screenshot fixture in a folder kept between launches, with no network and no external services. Two organizations (`demoOrganization.ts`, `demoLumen.ts`). Agents answer from a script: each launch starts two flow runs you can watch (`src/main/demoRun.ts`), and AI employees' runs call their real tools while a director starts the channels and plays the person for some decisions (`src/main/demoEmployees.ts`). `npm run dev demo reset` seeds it again; bump `DEMO_VERSION` in `demo.ts` when the seed changes, so a kept demo says a reset shows the new one. `npm run dev demo <scenario>` starts it with only what an area needs, in a folder of its own, and opens on that area's screen: `channels`, `hire-employee`, or `full` (the default). `--with <part,…>` and `--without <part,…>` add and leave out parts (`team`, `lumen`, `usage`, `flows`, `channels`), after a `--` so npm passes them on; `npm run dev demo list` prints the scenarios and parts, which are `src/shared/scenarios.json`. |
| `npm run typecheck` | Strict TypeScript check over source, tests and build/test configs. |
| `npm test` | Full Vitest suite. A focused run is `npm test -- tests/<name>.test.ts`. |
| `npm run test:changed` | Only the tests the branch's changes (since `origin/main`, plus uncommitted files) can affect: Vitest's import graph, plus the `check:ui` checks for a renderer or i18n change and any test naming a changed non-module file. For the loop while working; `npm test` is still the check before a pull request. `-- <base ref>` compares with another ref. |
| `npm run check:ui` | Design-system guard, contrast, i18n, UI and content accessibility checks. Can run after `npm ci --ignore-scripts`, without downloading Electron or building native modules. |
| `npm run build` | Build main, CLI, Cursor worker, sandbox host/attach, preload and renderer into `out/`. Preload output is CommonJS for Electron's sandbox. |
| `npm start` | Preview the built Electron app. |
| `npm run screens` | Capture real-app fixture screens; `npm run screens -- --compare <a> <b>` compares runs. Supports `--out`, `--only`, `--build`, `--no-build`, and `--scenario <name>` (with `--with`, `--without`) to start the fixture with what a demo scenario adds and take its screens: `--scenario channels` plays the demo's channel stories until nothing moves, then takes a channel at each stage. Requires Electron. |
| `npm run pr:screens` | Before-and-after fixture screens for a UI pull request: `-- capture --only <screen,…>` takes them from the merge base and the working tree and compares them, and `-- capture --scenario <name>` does so on a demo scenario's data and screens (`channels`, `hire-employee`); `-- publish <png>…` pushes them to the `pr-screenshots` branch and prints image links. See `.claude/skills/create-pr/ui-changes.md`. |
| `npm run docs:cli` | Regenerate `docs/cli.md` from command metadata; do not hand-edit generated command reference content. |
| `npm run cloud:smoke` | Live Vercel integration test; requires the three Vercel variables above and a build first. Run only when live sandbox use is within the task's scope. |
| `npm run dist:mac` / `npm run dist:win` | Build and package DMG/NSIS into `dist/`, with publishing disabled. |

The security, licence, repository, MCP and workflow checks (`check:security`, `check:licenses`, `check:repository`, `check:mcp`, `check:workflows`) are in the local-check table of [maintenance.md](maintenance.md), with CI, the nightly run and the installer and release workflows.

### Packaging and generated files

`electron-builder` settings are in `package.json` (including a Linux AppImage target, but no Linux dist script). README targets macOS and Windows, and both are tested; [windows.md](windows.md) records Windows-specific notes and the checks still open there; configuration alone does not establish platform support. `.github/workflows/installers.yml` builds unsigned macOS (DMG) and Windows (NSIS) installers only when started manually, keeping them as 7-day run artifacts; packaging is not publication. Releases follow "Releases" in [maintenance.md](maintenance.md): `npm run release -- prepare <bump>` on a branch, merge, `npm run release -- tag --push`, then the manual `.github/workflows/release.yml` creates a draft GitHub release.

`out/`, `dist/`, `node_modules/`, `release/` and logs are ignored artifacts. `build/` contains checked-in packaging assets, not just disposable output. Icon sources are in `build/icons/`; README documents `npx electron scripts/render-icons.mjs` on macOS to regenerate assets. `src/shared/workspacePeople.json` is maintained by `scripts/buildWorkspacePeople.py` (see [workspace-names.md](workspace-names.md)).
