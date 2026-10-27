# Working on Foreman

This is the repository-wide guide for coding agents. `CLAUDE.md` delegates here. Read the relevant source and tests before changing code; keep changes focused on the task. Preserve existing public APIs, persisted data and visual conventions unless the task explicitly requires changing them.

## Start here

1. Check `git status --short` and any instructions in the area you will edit. Preserve unrelated work.
2. Read [README.md](README.md) for setup and the relevant source, tests and guides under `docs/` for current behavior and validation gaps.
3. Search with `rg` for the closest existing implementation, its callers and tests. Reuse business logic, hooks, utilities, API clients and services rather than adding parallel implementations.
4. For any UI task, follow the design-system workflow below **before writing JSX or CSS**.
5. Make the smallest coherent change, run the applicable checks, and report what changed, what was verified and any remaining limitations. Do not introduce speculative abstractions, unrelated refactors or dependencies to solve a local problem.

## UI: the design system comes first

Every control in the renderer comes from the design system in `src/renderer/src/ui/` (documented in `docs/design-system.md`, "Components"). Feature code composes those components and owns only layout.

**Mandatory discovery:** search the [component catalogue](docs/design-system.md), `src/renderer/src/ui/index.ts`, `ui/<Name>.tsx`, `ui/gallery/`, and existing feature usages. Read the implementation, exported prop types, supported variants and tests before choosing a component. Reuse domain compositions in `components/` too, especially `components/settings/controls.tsx`. Do not create a second button, form, dialog, dropdown, menu, card, table interaction, tooltip or notification system. The catalogue does not imply that every conceivable widget exists: compose the closest primitives before considering a new one. Do not add another UI library or styling system without explicit justification tied to a demonstrated gap.

1. **Use an existing component as it is.** Buttons, inputs, radio groups, switches, tabs, menus, popovers, lists, dialogs, tags, status, callouts, trees: they're all there, with keyboard and screen-reader behaviour built in.
2. **If it's not quite enough, add a variant or prop to the existing component**, in `ui/`, with its tests (`tests/ui/`) and its doc section.
3. **Add a new component only when nothing existing can do the job.** Then add it to `ui/` first, as its own pull request with the `new-component` label: the component, its `ui/css/<name>.css`, keyboard and ARIA behaviour, tests (`tests/ui/<Name>.test.tsx`), a sample in a `ui/gallery/` page, an export in `ui/index.ts` and a section in `docs/design-system.md` saying why nothing existing fit. Only then, in a later pull request, use it in a feature.

Before adding a shared component, record the closest existing components and why their props, variants or composition cannot satisfy the requirement. Explain why extending one would break its contract or create an inappropriate abstraction, and define the new component's narrow responsibility. Put that rationale in its catalogue section and change description. Register its stylesheet in `ui/ui.css`. This is a controlled exception, not permission to bypass the existing separate-PR rule; that rule does not authorize an agent to publish a PR without being asked.

Never hand-build a control in feature code: no raw `<button>`, `<input>`, `<select>`, `<textarea>`, no `role="menu"`/`"tab"`/`"radio"`/`"dialog"`… on plain elements, no clickable `div`s. Feature CSS sets layout only (display, grid/flex, gap, size, margin, padding, position); colours, borders, fonts, radii and focus belong to the component. That holds for the classes you pass to a component too (`className`, `triggerClassName`, `panelClassName`, `primaryProps`): the guard reads them and fails on appearance in a rule for them. A card (draggable, selectable, clickable) is a `Card`, `CardButton` or `ActionRow card`, so its edge meets 3:1. Use tokens from `src/renderer/src/ui/tokens.css`, never raw colours, font sizes or radii.

`tests/designSystem.test.ts` enforces this and fails the test run on a hand-built control, a raw colour or size, or a `ui/` export without a doc section. Its named exceptions (content such as the Markdown editor and read-only `<details>`, the welcome tour's spotlight card) each carry their reason; don't add one without a reason as good. `tests/contrast.test.ts` keeps every token pair at WCAG AA in light and dark and in every colour-vision mode.

**Checks that enforce this.** Guard rule 9 ("new look outside `ui/`") counts every `background*`, `border*` (bar a plain `1px solid var(--border)` divider), radius, shadow and outline in feature CSS and inline `style={{…}}`, and fails when a file's count goes above `tests/designSystem.baseline.json`; the answer is a component from `ui/`, never a new baseline entry. `npm run check:ui` runs the guard, contrast, i18n, accessibility and `ui/` tests without an Electron or native build. `.githooks/pre-commit` runs the guard and contrast tests when a commit touches `src/renderer/`, `src/shared/i18n/` or those tests. `scripts/postinstall.mjs` enables the hook outside CI if no hooks path is already configured. Fix failures rather than bypassing the hook. `tests/ui/componentKit.test.ts` fails on any `.tsx` in `ui/` that isn't exported, tested and in a gallery. See "CI and automation" below for the separate new-component check.

Coral (`--accent`) is brand only (logo and brand icons, the Automations bolt, the Assistant sparkle, agent icons, the DEFAULT tag and label, the tour spotlight), never a state, link, path, search match, panel edge, chart, syntax colour or a tag other than DEFAULT: selection is neutral (`--selected-*`), focus and links are blue (links underlined), and `tests/ui/coralBrandOnly.test.ts` fails on a new use outside its allowlist.

Accessibility is part of done: every control has an accessible name (inputs without one throw in development), state is never shown by colour alone, and anything that works with a mouse works with the keyboard.

Follow the existing loading, error and empty-state patterns: `Spinner`, `Status`, `Callout`, and the renderer store's `attempt`/`showToast`, rendered by `components/Announcer.tsx`. Use `Field`/`useField` for labels, descriptions and errors; use the existing overlay focus handling instead of writing another focus trap. Preserve forced-colour and reduced-motion support. Reuse `components/resize.tsx` and the layouts in `App.tsx`/`styles/layout.css`; check narrow windows and zoom when changing layout. Use existing Lucide icons and `ui/Glyph` status shapes, not a parallel icon system.

## Text

Foreman's own words go through `src/shared/i18n`: add the key to `en.ts` and every other locale (see "i18n" in `docs/design-system.md`). `ui/` components never call `useT`; features pass translated text in as props.

Use renderer `useT`, main `mainT`, and the shared date/number helpers with the active locale. Preserve interpolation parameters and plural forms. Do not translate user content. The design-system document lists intentional English-only surfaces (including CLI output, agent prompts and the phone app); do not silently expand those exceptions.

## Project and architecture

Foreman is a local Electron desktop app for running coding agents in parallel, each in an isolated Git worktree and branch. Major areas are chat and approvals, terminals and scripts, diffs/reviews and SCM operations, checkpoints, setup/check workflows, automations, integration settings, backups, paired devices and experimental remote sandbox workspaces. There is no Foreman account or hosted application backend; model providers and optional integrations use the user's accounts.

The repository is one npm package with `package-lock.json`, TypeScript in strict mode, React 19, Electron, electron-vite/Vite, plain CSS and Vitest. Node 22.12+ (22.x) or 24.x and Git are documented requirements. The main process uses Node APIs; the renderer is sandboxed. Terminal support is `node-pty` plus xterm.js. See `package.json` for exact dependency ranges; do not replace the package manager or add a framework for functionality already present.

| Area | Entry points and responsibilities |
| --- | --- |
| Desktop lifecycle | `src/main/index.ts`: Electron windows, native integration, service startup, IPC handlers and event broadcasts. |
| Application services | `src/main/core.ts`: composes services and implements the renderer-facing API. Electron capabilities are injected through `Host` so the core stays testable without importing Electron. |
| Renderer bridge | `src/preload/index.ts`: exposes `window.foreman` with typed invoke, signals and event subscriptions. `src/shared/types.ts` defines `Api`, `Bridge`, `MainEvent`, `API_METHODS` and `SIGNAL_METHODS`. |
| Renderer | `src/renderer/index.html` → `src/renderer/src/main.tsx` → `App.tsx`; `store.ts` owns snapshot/event state and `useStore` via React `useSyncExternalStore`. Feature views live in `components/`; no separate router or state library is needed for ordinary additions. |
| UI system | `src/renderer/src/ui/`: controls, prop types, tokens, component CSS, keyboard helpers and galleries. `components/settings/controls.tsx` contains application-specific settings compositions and save helpers, not a competing primitive kit. |
| Shared domain | `src/shared/`: contracts and reusable domain logic, settings schemas/registries, agent capabilities, CLI definitions and i18n. Keep reusable pure logic here rather than copying it into main and renderer. |
| Agents and sessions | `src/main/sessions.ts`, `agents/types.ts`, `agents/registry.ts`: common driver contract and Claude, Codex, Cursor, OpenCode/ACP adapters. `agentHost/` handles hosted turns; `cursorWorker.ts` is a separate build entry. Respect capability flags and existing approval/read-only policies. |
| Workspaces and execution | `workspaces.ts`, `git.ts`, `checkpoints.ts`, `scripts.ts`, `pty.ts`, `platform.ts`, `shells.ts` in `src/main/`. Reuse platform quoting and process helpers; do not assume POSIX shells on Windows. |
| Remote workspaces | `src/main/cloud/` and `runtime/`: sandbox providers (Vercel, Docker, E2B, Daytona), execution and file/Git routing. Use the existing workspace target/runtime helpers; a cloud workspace is not a local filesystem path. Background reads must not wake sleeping sandboxes. |
| Command line | `bin/foreman.mjs` launches built `out/main/cli.js`; `src/cli/index.ts` dispatches `commands/`. `src/shared/cliCommands.ts` and `src/shared/cli/` define command metadata; `src/main/cli/` serves the local socket API. `cliServer.ts` is a compatibility re-export. |
| Persistence | `src/main/store.ts`, `db.ts`, `legacyImport.ts`, `secrets.ts`; see data rules below. |
| Integrations | `github.ts`, `gitlab.ts`, `scm.ts`, `integrations.ts`, `linear.ts`, `slack.ts`, `integrationBridge.ts`, `repoMcp.ts` in `src/main/`. Extend the existing service and credential selection paths. |
| Phone and devices | `resources/mobile/` is a separate small web client. `src/main/mobile.ts` serves paired-phone access; device pairing, network and transfer services live alongside it. The desktop UI catalogue does not govern the phone stylesheet. |
| Tests | `tests/*.test.ts` for domain/services and integration behaviour; `tests/*.test.tsx` and `tests/ui/` for renderer behaviour; `tests/helpers.ts` for temporary Git repos and other helpers; `tests/fixtures/` for fixtures, including guard examples. |
| Tooling and references | `scripts/`, `.githooks/`, `.github/`, root build/test configs; `docs/` for guides and `build/icons/` for production icon sources. |

For an API change, trace the shared contract → main implementation → preload exposure → renderer caller and events. Keep method allowlists and tests consistent; do not expose raw Node or Electron capabilities to the renderer. Keep side effects in services and domain decisions in reusable helpers. Follow the surrounding TypeScript style (type imports, single quotes, no semicolons) rather than reformatting unrelated files.

## Data, authentication and authorization

- Main owns one SQLite connection in WAL mode using built-in `node:sqlite`. `foreman.db` stores operational records (workspaces, sessions, chat items, comments, check results and attachment references); `state.json` holds preferences, repository registrations, templates and other configuration. Use `Store`/`ForemanDb`, not direct renderer persistence for domain data. Small renderer preferences already use local storage.
- Schema upgrades are ordered entries in `src/main/db.ts`: append migrations; never edit a shipped migration. Preserve legacy imports and settings defaults when changing persisted shapes. Test upgrades as well as new installs where relevant.
- Credentials and environment values use `SecretStore` with injected Electron `safeStorage` encryption (Keychain on macOS, DPAPI on Windows). Do not put secrets into shared settings files, logs, snapshots or fixtures. Agent keys, provider keys and app-integration secrets have separate scopes; preserve those boundaries.
- Agents use their configured login or API-key mode. GitHub uses `gh` authentication or selected token connections; GitLab uses configured tokens. Integration selection is per repository with defaults; a missing selected connection must not silently fall back to another account. Linear access levels and MCP consent are explicit policies.
- Desktop windows use `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. Preserve those settings and the IPC method allowlists.
- The CLI communicates over a local socket/named pipe, not a general HTTP backend. `src/main/cli/policy.ts` assigns method tiers and checks caller/launch tokens where required; `cli/token.ts` manages the data-directory token. Preserve opt-ins for agents starting workspaces or queuing messages.
- Phone access uses expiring pairing links, desktop approval and device credentials/cookies. `mobile.ts` enforces origin checks and offers a loopback listener plus opt-in LAN access. Device transfer has its own pairing services; do not bypass these paths when adding endpoints.
- Repository scripts, checks, proposed MCP servers and scheduled actions have existing consent/fingerprint rules. Reuse their validation; neither a saved configuration nor a renderer flag alone grants execution permission.

## Configuration and environment

There is no mandatory repository `.env` file for building or running the ordinary test suite. Provider credentials are needed to actually run agents; optional services require their own configuration.

| Setting | Meaning |
| --- | --- |
| `FOREMAN_DATA_DIR` | Isolate development/test state from installed app data; `SWITCHYARD_DATA_DIR` is a legacy fallback. Use a disposable folder for manual tests. |
| `FOREMAN_PORT` | First port in a local workspace's reserved block of 10. Use the assigned block for development servers. Cloud workspaces expose sandbox URLs instead. |
| `FOREMAN_WORKSPACE_ID`, `FOREMAN_WORKSPACE_NAME`, `FOREMAN_WORKSPACE_PATH`, `FOREMAN_ROOT_PATH`, `FOREMAN_DEFAULT_BRANCH` | Context supplied to workspace scripts, terminals and agents; see `WorkspaceService.env` in `src/main/workspaces.ts`. Environment-file and secret layering lives in `src/main/environment.ts`. |
| `FOREMAN_IS_CLOUD` | Set to `1` for cloud workspaces; their path variables refer to the sandbox. |
| `ELECTRON_RENDERER_URL` | Development renderer URL consumed by main; managed by electron-vite. Do not hard-code it for production. |
| `FOREMAN_SCREENSHOTS*` | Fixture/screenshot controls managed by `scripts/screenshots.mjs` and `src/main/screenshots.ts`; prefer `npm run screens` over setting them manually. |
| `FOREMAN_VERCEL_TOKEN`, `FOREMAN_VERCEL_TEAM_ID`, `FOREMAN_VERCEL_PROJECT_ID` | Opt-in live Vercel smoke test credentials. The test creates real sandboxes; ordinary tests skip it when these are absent. |

Shared repository settings live in `.foreman/settings.toml`; `.switchyard/settings.toml` is the compatibility fallback for this app's earlier name. Workspace scripts receive `FOREMAN_*` and the earlier `SWITCHYARD_*` aliases only. Local overrides take precedence over shared settings, then supported user settings, then defaults. Follow `src/main/repoSettings.ts` and the shared settings schemas/registries rather than implementing another parser or precedence chain. Shared MCP configuration names environment variables, not their secret values.

## Development, checks and packaging

Commands below come from `package.json`. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`; changing machine execution policy is unnecessary.

| Command | Purpose |
| --- | --- |
| `npm install` / `npm ci` | Install dependencies (clean reproducible installs use `ci`). Postinstall fixes Unix PTY helper permissions and configures hooks when appropriate. |
| `npm run dev` | Run the Electron app with electron-vite development builds. |
| `npm run typecheck` | Strict TypeScript check over source, tests and build/test configs. |
| `npm test` | Full Vitest suite. A focused run is `npm test -- tests/<name>.test.ts`. |
| `npm run check:ui` | Design-system guard, contrast, i18n, UI and content accessibility checks. Can run after `npm ci --ignore-scripts`, without downloading Electron or building native modules. |
| `npm run build` | Build main, CLI, Cursor worker, sandbox host/attach, preload and renderer into `out/`. Preload output is CommonJS for Electron's sandbox. |
| `npm start` | Preview the built Electron app. |
| `npm run screens` | Capture real-app fixture screens; `npm run screens -- --compare <a> <b>` compares runs. Supports `--out`, `--only`, `--build`, `--no-build`. Requires Electron. |
| `npm run docs:cli` | Regenerate `docs/cli.md` from command metadata; do not hand-edit generated command reference content. |
| `npm run cloud:smoke` | Live Vercel integration test; requires the three variables above and a build first. Run only when live sandbox use is within the task's scope. |
| `npm run dist:mac` / `npm run dist:win` | Build and package DMG/NSIS into `dist/`, with publishing disabled. |

There is no configured lint/formatter script; do not invent `npm run lint`. `electron-builder` settings are in `package.json` (including a Linux AppImage target, but no Linux dist script). README targets macOS and Windows; `docs/windows.md` records Windows validation gaps; configuration alone does not establish platform support. `.github/workflows/installers.yml` builds unsigned macOS (DMG) and Windows (NSIS) installers only when started manually, keeping them as 7-day run artifacts; packaging is not publication. Releases follow "Releases" in `docs/maintenance.md`: `npm run release -- prepare <bump>` on a branch, merge, `npm run release -- tag --push`, then the manual `.github/workflows/release.yml` creates a draft GitHub release. Do not tag, push tags, start either workflow or publish a release unless the user asks; there is no deployment workflow.

`out/`, `dist/`, `node_modules/`, `release/` and logs are ignored artifacts. Do not edit built output. `build/` contains checked-in packaging assets, not just disposable output. Icon sources are in `build/icons/`; README documents `npx electron scripts/render-icons.mjs` on macOS to regenerate assets. `src/shared/workspacePeople.json` is maintained by `scripts/buildWorkspacePeople.py` (see `docs/workspace-names.md`).

### Test expectations

Vitest defaults to Node with a 30-second test timeout; renderer tests opt into jsdom via `// @vitest-environment jsdom`. Reuse Testing Library/user-event conventions for keyboard and accessible-name assertions. Service tests use temporary directories and real Git repositories through `tests/helpers.ts`; use injected hosts, encryptors and mocks at external boundaries instead of real credentials or the user's repositories.

Add regression coverage for changed behaviour, including error paths and cleanup where relevant. UI variants need their UI tests and catalogue updates. Do not weaken guards, increase appearance baselines, or add unexplained allowlist entries to make a feature pass. Tests should check observable contracts rather than merely repeat implementation details.

### CI and automation

There is no CI workflow and no Dependabot configuration; both were removed to start again from scratch. The two workflows, `.github/workflows/installers.yml` and `release.yml`, run only when someone starts them, and check nothing beyond the release tag. Nothing runs automatically on pull requests or pushes, so run the checks in this file locally (`npm run check:security`, `check:repository` and `check:licenses` remain available as local scripts). `main` is protected by a GitHub ruleset (PR with one approval; admins may bypass only when merging a PR); no CODEOWNERS or ruleset payloads are supplied. Do not merge or use that bypass unless the user asks. See `docs/maintenance.md` for the live-protection boundary.

`scripts/check-new-components.mjs` compares UI value exports with a base commit. A new export requires the `new-component` label, test and gallery coverage, and no simultaneous feature-renderer changes. Run it as `node scripts/check-new-components.mjs <base-ref>`; label validation only happens when `PR_LABELS` is supplied.

### Documentation authority

Keep this file as the agent entry point and `docs/design-system.md` as the single UI catalogue. `CLAUDE.md` should continue to delegate here. No additional nested agent instructions or Cursor rule files were found in this audit. Legacy class tables and design plans are historical context, not permission to bypass current UI rules. When source, docs and guards disagree, inspect the actual behaviour and report any unresolved conflict; do not invent commands or silently relax a requirement.

## Checks

`npm run typecheck`, `npm test` and `npm run build` must pass. `npm run screens` captures every main screen of the real app on a fixture (`-- --compare <a> <b>` diffs two runs); use it when a change could move layout.
