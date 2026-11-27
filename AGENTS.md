# Working on Foreman

This is the repository-wide guide for coding agents. `CLAUDE.md` delegates here. It is part of every call an agent makes, so it holds the rules and points to the rest: where things live, the environment variables and every command are in [docs/map.md](docs/map.md). Read the relevant source and tests before changing code; keep changes focused on the task. Preserve existing public APIs, persisted data and visual conventions unless the task explicitly requires changing them.

## Start here

1. Check `git status --short` and any instructions in the area you will edit. Preserve unrelated work.
2. Read [README.md](README.md) for setup and the relevant source, tests and guides under `docs/` for current behavior and validation gaps. [docs/map.md](docs/map.md) says which files own an area.
3. Search with `rg` for the closest existing implementation, its callers and tests. Reuse business logic, hooks, utilities, API clients and services rather than adding parallel implementations.
4. For any UI task, follow the design-system workflow below **before writing JSX or CSS**.
5. Make the smallest coherent change, run the applicable checks, and report what changed, what was verified and any remaining limitations. Do not introduce speculative abstractions, unrelated refactors or dependencies to solve a local problem.
6. Before reversing an established choice, check [docs/decisions.md](docs/decisions.md) for why it was made: `rg '^## 20' docs/decisions.md` lists the decisions, one line each, and only the entries that bear on the change need reading. When the user asks for a pull request, follow [.claude/skills/create-pr/SKILL.md](.claude/skills/create-pr/SKILL.md); when they ask for a release, follow [.claude/skills/create-release/SKILL.md](.claude/skills/create-release/SKILL.md); when they ask for a UI audit, design review or mocks of improvements, follow [.claude/skills/ui-review/SKILL.md](.claude/skills/ui-review/SKILL.md), whichever agent you are.

## Reading, and long sessions

Whatever an agent reads is sent again with every later call in the same chat, so a file read whole is paid for many times over. Read what the change needs.

- **Search, then read a range.** Find the symbol with `rg`, then read the whole function with its callers and error paths, not the whole file. Send independent searches and reads in one message.
- **Never read these whole:** the locale files in `src/shared/i18n/` (find the key in `en.ts`, then the same key in each locale, keeping interpolation parameters and plural forms), `src/main/core.ts`, `src/main/sessions.ts`, `src/main/employeeWork.ts`, `src/shared/types.ts`, `src/shared/workspacePeople.json`, `src/main/agents/codex/protocol/`, `docs/cli.md` and recorded agent fixtures.
- **A long guide opens with "Where to look"** (`docs/ai-employees.md`, `docs/agents.md`, `docs/loops-and-graphs.md`; "Finding and choosing a component" in `docs/design-system.md`): read that, then the one section the task needs.
- **Use a subagent for a search only when it is a separate investigation with a short answer** (the cause, the files, the lines). Its tokens are spent too.
- **Start unrelated work in a fresh chat.** When a task is finished and the next one doesn't build on it, say so and offer a hand-off note of under 30 lines: the goal, what is done and the files changed, the next steps in order, what was tried and failed and why, the commands that verify it.
- **After two failed attempts at the same fix, write down what each one showed before trying a third,** so the next attempt, or a fresh chat, starts from what is known.

## UI: the design system comes first

Every control in the renderer comes from the design system in `src/renderer/src/ui/` (documented in `docs/design-system.md`, "Components"). Feature code composes those components and owns only layout.

**Mandatory discovery:** search the [component catalogue](docs/design-system.md), `src/renderer/src/ui/index.ts`, `ui/<Name>.tsx`, `ui/gallery/`, and existing feature usages. Read the implementation, exported prop types, supported variants and tests before choosing a component. Reuse domain compositions in `components/` too, especially `components/settings/controls.tsx`. Do not create a second button, form, dialog, dropdown, menu, card, table interaction, tooltip or notification system. The catalogue does not imply that every conceivable widget exists: compose the closest primitives before considering a new one. Do not add another UI library or styling system without explicit justification tied to a demonstrated gap.

1. **Use an existing component as it is.** Buttons, inputs, radio groups, switches, tabs, menus, popovers, lists, dialogs, tags, status, callouts, trees: they're all there, with keyboard and screen-reader behaviour built in.
2. **If it's not quite enough, add a variant or prop to the existing component**, in `ui/`, with its tests (`tests/ui/`) and its doc section.
3. **Add a new component only when nothing existing can do the job.** Then add it to `ui/` first, as its own pull request with the `new-component` label: the component, its `ui/css/<name>.css`, keyboard and ARIA behaviour, tests (`tests/ui/<Name>.test.tsx`), a sample in a `ui/gallery/` page, an export in `ui/index.ts` and a section in `docs/design-system.md` saying why nothing existing fit. Only then, in a later pull request, use it in a feature.

**A component is used only once it is in the design system.** "In the design system" means exported from `ui/index.ts` on `main`, not on your branch or an unmerged one. If a task needs a component that isn't there yet, an agent does not build it as part of that task: stop before writing the feature, tell the developer which component is missing, which existing components you considered and why they don't fit (the rationale below), and ask them to have it added to the design system first, as its own task and pull request. Continue the feature only after it has merged, from a branch that includes it. Build the component yourself only when the developer's task is that component, and then touch nothing outside `ui/`, its tests, its gallery sample and its doc section.

Before adding a shared component, record the closest existing components and why their props, variants or composition cannot satisfy the requirement. Explain why extending one would break its contract or create an inappropriate abstraction, and define the new component's narrow responsibility. Put that rationale in its catalogue section and change description. Register its stylesheet in `ui/ui.css`. This is a controlled exception, not permission to bypass the existing separate-PR rule; that rule does not authorize an agent to publish a PR without being asked.

Never hand-build a control in feature code: no raw `<button>`, `<input>`, `<select>`, `<textarea>`, no `role="menu"`/`"tab"`/`"radio"`/`"dialog"`… on plain elements, no clickable `div`s. Feature CSS sets layout only (display, grid/flex, gap, size, margin, padding, position); colours, borders, fonts, radii and focus belong to the component. That holds for the classes you pass to a component too (`className`, `triggerClassName`, `panelClassName`, `primaryProps`): the guard reads them and fails on appearance in a rule for them. A card (draggable, selectable, clickable) is a `Card`, `CardButton` or `ActionRow card`, so its edge meets 3:1. Use tokens from `src/renderer/src/ui/tokens.css`, never raw colours, font sizes or radii.

`tests/designSystem.test.ts` enforces this and fails the test run on a hand-built control, a raw colour or size, or a `ui/` export without a doc section. Its named exceptions (content such as the Markdown editor and read-only `<details>`, the welcome tour's spotlight card) each carry their reason; don't add one without a reason as good. `tests/contrast.test.ts` keeps every token pair at WCAG AA in light and dark and in every colour-vision mode.

**Checks that enforce this.** Guard rule 9 ("new look outside `ui/`") counts every `background*`, `border*` (bar a plain `1px solid var(--border)` divider), radius, shadow and outline in feature CSS and inline `style={{…}}`, and fails when a file's count goes above `tests/designSystem.baseline.json`; the answer is a component from `ui/`, never a new baseline entry. `npm run check:ui` runs the guard, contrast, i18n, accessibility and `ui/` tests without an Electron or native build. `.githooks/pre-commit` runs the guard and contrast tests when a commit touches `src/renderer/`, `src/shared/i18n/` or those tests, and `node scripts/check-new-components.mjs --staged` when it touches `src/renderer/`: a branch that adds a `ui/index.ts` export may not also change feature code, whichever commits the two are in. `scripts/postinstall.mjs` enables the hook outside CI if no hooks path is already configured. Fix failures rather than bypassing the hook. `tests/ui/componentKit.test.ts` fails on any `.tsx` in `ui/` that isn't exported, tested and in a gallery. See "CI and automation" below for the separate new-component check.

Coral (`--accent`) is brand only (logo and brand icons, the Automations bolt, the Assistant sparkle, agent icons, the DEFAULT tag and label, the tour spotlight), never a state, link, path, search match, panel edge, chart, syntax colour or a tag other than DEFAULT: selection is neutral (`--selected-*`), focus and links are blue (links underlined), and `tests/ui/coralBrandOnly.test.ts` fails on a new use outside its allowlist.

Accessibility is part of done: every control has an accessible name (inputs without one throw in development), state is never shown by colour alone, and anything that works with a mouse works with the keyboard.

Follow the existing loading, error and empty-state patterns: `Spinner`, `Status`, `Callout`, and the renderer store's `attempt`/`showToast`, rendered by `components/Announcer.tsx`. Use `Field`/`useField` for labels, descriptions and errors; use the existing overlay focus handling instead of writing another focus trap. Preserve forced-colour and reduced-motion support. Reuse `components/resize.tsx` and the layouts in `App.tsx`/`styles/layout.css`; check narrow windows and zoom when changing layout. Use existing Lucide icons and `ui/Glyph` status shapes, not a parallel icon system.

## Text

Foreman's own words go through `src/shared/i18n`: add the key to `en.ts` and every other locale (see "i18n" in `docs/design-system.md`). `ui/` components never call `useT`; features pass translated text in as props.

Use renderer `useT`, main `mainT`, and the shared date/number helpers with the active locale. Preserve interpolation parameters and plural forms. Do not translate user content. The design-system document lists intentional English-only surfaces (including CLI output, agent prompts and the phone app); do not silently expand those exceptions.

## Project and architecture

Foreman is a local Electron desktop app for running coding agents in parallel, each in an isolated Git worktree and branch. Major areas are chat and approvals, terminals and scripts, diffs/reviews and SCM operations, checkpoints, setup/check workflows, automations, integration settings, backups, paired devices, experimental remote sandbox workspaces and AI employees (organizations with a memory repository and employees that run as workspaces). There is no Foreman account or hosted application backend; model providers and optional integrations use the user's accounts.

The repository is one npm package with `package-lock.json`, TypeScript in strict mode, React 19, Electron, electron-vite/Vite, plain CSS and Vitest. Node 22.12+ (22.x) or 24.x and Git are documented requirements. See `package.json` for exact dependency ranges; do not replace the package manager or add a framework for functionality already present.

[docs/map.md](docs/map.md) lists each area's entry points. The rules that go with them:

- **Main.** `src/main/core.ts` composes the services and implements the renderer-facing API. Electron capabilities are injected through `Host`, so the core stays testable without importing Electron.
- **Renderer.** `store.ts` owns snapshot and event state (`useStore`); no separate router or state library is needed for ordinary additions. The renderer is sandboxed.
- **Shared.** Reusable pure logic goes in `src/shared/` rather than being copied into main and renderer.
- **Agents.** Respect capability flags and the existing approval and read-only policies.
- **Execution.** Reuse the platform quoting and process helpers (`platform.ts`, `shells.ts`); do not assume POSIX shells on Windows.
- **Remote workspaces.** A cloud workspace is not a local filesystem path: use the existing workspace target/runtime helpers. Background reads must not wake sleeping sandboxes.
- **AI employees.** `src/main/memory.ts` is the only writer of an organization's memory repository.
- **Integrations.** Extend the existing service and credential selection paths.
- **Phone.** `resources/mobile/` is a separate small web client; the desktop UI catalogue does not govern its stylesheet.

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

There is no mandatory repository `.env` file for building or running the ordinary test suite. Provider credentials are needed to actually run agents; optional services require their own configuration. Every variable Foreman reads or sets is in [docs/map.md](docs/map.md#configuration-and-environment).

- Manual tests use a disposable `FOREMAN_DATA_DIR`, so they never touch the installed app's data.
- Development servers use the workspace's reserved block of 10 ports, starting at `FOREMAN_PORT`.
- Shared repository settings live in `.foreman/settings.toml` (`.switchyard/settings.toml` is the compatibility fallback for this app's earlier name). Local overrides take precedence over shared settings, then supported user settings, then defaults. Follow `src/main/repoSettings.ts` and the shared settings schemas/registries rather than implementing another parser or precedence chain.
- Shared MCP configuration names environment variables, not their secret values.

## Development, checks and packaging

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`; changing machine execution policy is unnecessary. The checks are at the end of this file; [docs/map.md](docs/map.md#commands) has every script with its options. The ones a change most often needs besides them:

- `npm test -- tests/<name>.test.ts` runs one test file. `npm run test:changed` runs only the tests the branch's changes can affect, while working and before a pull request. Don't run the whole `npm test` locally unless the user asks: CI runs it, split four ways, on every ready PR.
- `npm run check:ui` runs the design-system guard and the contrast, i18n, UI and content accessibility checks.
- `npm run dev` runs the app; `npm run dev demo` runs it on demo data, with no network and no external services.
- `npm run pr:screens` takes before-and-after fixture screens for a UI pull request (`.claude/skills/create-pr/ui-changes.md`).
- `npm run docs:cli` regenerates `docs/cli.md` from command metadata; do not hand-edit generated command reference content.
- There is no configured lint/formatter script; do not invent `npm run lint`.
- `npm run cloud:smoke` creates real Vercel sandboxes. Run it only when live sandbox use is within the task's scope.
- Bump `DEMO_VERSION` in `src/main/demo.ts` when the demo's seed changes, so a kept demo says a reset shows the new one.
- Do not tag, push tags, start the installers or release workflow or publish a release unless the user asks; there is no deployment workflow, and packaging is not publication. Releases follow "Releases" in `docs/maintenance.md`.
- `out/`, `dist/`, `node_modules/`, `release/` and logs are ignored artifacts: do not edit built output. `build/` contains checked-in packaging assets, not just disposable output.
- README targets macOS and Windows, and both are tested; `docs/windows.md` records the Windows checks still open. Configuration alone (such as the Linux AppImage target) does not establish platform support.

### Test expectations

Vitest defaults to Node with a 30-second test timeout; renderer tests opt into jsdom via `// @vitest-environment jsdom`. Reuse Testing Library/user-event conventions for keyboard and accessible-name assertions. Service tests use temporary directories and real Git repositories through `tests/helpers.ts`; use injected hosts, encryptors and mocks at external boundaries instead of real credentials or the user's repositories.

Add regression coverage for changed behaviour, including error paths and cleanup where relevant. UI variants need their UI tests and catalogue updates. Do not weaken guards, increase appearance baselines, or add unexplained allowlist entries to make a feature pass. Tests should check observable contracts rather than merely repeat implementation details.

### CI and automation

`.github/workflows/ci.yml` runs on a pull request into `main` once it is ready for review, never on a draft. Its two checks, **Types and design system** (`typecheck`, `check:ui` and the new-component check) and **Tests and build** (the whole suite in four parts at once, and `npm run build`), are required by a ruleset nobody can bypass, so a PR that fails either can't be merged. Run the checks below locally before marking a PR ready, and open it as a draft while one fails; a failure only CI finds is fixed in the next push. `docs/maintenance.md` has the rest: the nightly run, the installer and release workflows, the rulesets and the live-protection boundary.

- `.githooks/pre-push` (`scripts/check-push.mjs`) refuses a push whose commit holds a design mock (`mocks/`, `mockups/`, `mock*.html`) or any other path `scripts/publication-paths.mjs` forbids: a branch may carry mocks while it's worked on, but take them out (`git rm -r --cached`) before raising its PR, so none reaches `main`.
- `main` takes a PR with one approval; admins may bypass that only when merging a PR. Do not merge or use that bypass unless the user asks.
- `scripts/check-new-components.mjs` compares UI value exports with a base commit. A new export requires the `new-component` label, test and gallery coverage, and no simultaneous feature-renderer changes. Run it as `node scripts/check-new-components.mjs <base-ref>`; label validation only happens when `PR_LABELS` is supplied. With `--staged` it checks only the ordering rule, against the staged index, for the pre-commit hook.

### Documentation authority

Keep this file as the agent entry point, holding rules and pointers: a table of facts to look up belongs in `docs/map.md`, because everything here is sent with every call. Keep `docs/design-system.md` as the single UI catalogue. `CLAUDE.md` should continue to delegate here. Repository skills live in `.claude/skills/` (currently `create-pr`, `create-release` and `ui-review`); this file points to each, so agents other than Claude find them too. There are no nested agent instructions or Cursor rule files. [docs/decisions.md](docs/decisions.md) records direction choices that would otherwise be lost, with a deliberately high bar for adding one. Legacy class tables and design plans are historical context, not permission to bypass current UI rules. When source, docs and guards disagree, inspect the actual behaviour and report any unresolved conflict; do not invent commands or silently relax a requirement.

## Checks

`npm run typecheck`, `npm run test:changed` and `npm run build` must pass locally; CI runs the whole `npm test` on the PR, and it must pass there. `npm run screens` captures every main screen of the real app on a fixture (`-- --compare <a> <b>` diffs two runs); use it when a change could move layout.
