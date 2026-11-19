# Decisions

Choices about Foreman's direction that a later change could undo without knowing why they were made. Newest first. The pull request that added an entry is one `git log -- docs/decisions.md` away.

This is one file with a high bar, not a record per feature: Foreman has one maintainer, records for routine work would mostly repeat their pull requests, and every file an agent reads costs context. Revisit that when several regular contributors weren't there when the choices were made.

## When to add an entry

Add one only when all three hold:

- A real alternative was considered and turned down.
- Someone could later reverse the choice without knowing why it was made.
- The reasoning has no better home. Behaviour belongs in the doc that describes it (`AGENTS.md`, `docs/design-system.md`, `docs/maintenance.md` and the other guides), and if it fits there it goes there.

Typical entries: a persisted format or migration strategy, a security or consent boundary, a platform or dependency choice, removing or hiding a feature, changing a default people rely on (security, data or workflow, not a size or a colour), a rule about how work is done.

Not entries: bug fixes, ordinary features, refactors, dependency bumps, UI polish. For those the pull request is the record.

## How to write one

A heading with the date and the decision as a statement, then four short paragraphs. Keep it under about 150 words: this file is read for orientation, not for the whole story, which stays in the PR.

```markdown
## YYYY-MM-DD: <The decision, as a statement>

**Decision.** What was chosen, in one or two sentences.

**Why.** The problem, and what made this the better option.

**Turned down.** The alternatives, each with the reason.

**Revisit when.** The change in circumstances that would reopen it.
```

Don't delete or rewrite an entry that no longer holds. Add a new entry, and put `**Superseded** by <new entry's heading>.` as the old entry's first line.

## 2026-11-19: A plain message in a project channel goes to the program manager

**Decision.** In a project's channel, a message without `@Name` is for Priya: it goes into her running turn, or her message task reads it (one at a time), where she answers in the channel, asks, or replans. Later briefs carry the person's channel messages. `@Name` while that person's part runs goes into its running turn, or waits until it ends.

**Why.** The person used the channel as the place to correct the team ("Stop, I never approved this layout"), and nothing read it; a second run beside the running part edited the same files.

**Turned down.** Notes that wake nobody: the correction is lost. Sending every message to every running employee: several runs acting on one sentence, in one workspace.

**Revisit when.** Employees can be told to stop a running part safely, or a channel needs more than one reader.

## 2026-11-19: Settings opens on Quick, and the rail's gear shows its first six tiles

**Decision.** Settings › Quick is the first menu entry and where Settings (and Ctrl+,) opens: one ordered list of tiles (`shared/quickTiles.ts`), each a setting drawn with its own page's control. The rail's gear opens a popover of the first six with All settings; the order and which tiles show are chosen on the page and kept in the window's local storage.

**Why.** Settings opened on General › Language, one row on an empty page, and what the person changes most (models, accounts, integrations) was three levels down. Of ten mocks they picked one list shown at two sizes (08).

**Turned down.** Tiles that only link to their category (01); a status page of problems (04); agent and connection cards (06); a sheet beside the rail with search (09, it needs a left-side `ui/Sheet`); tiles that follow the open workspace (10).

**Revisit when.** People want tiles for settings that have no compact control, or want the list to follow them across computers (then it belongs in `Settings`).

## 2026-11-19: A folder without git is added as it is, and its one workspace works in the folder

**Decision.** A folder outside git can be added "without git" (`Repo.plain`). Its one workspace works in the folder itself, with no branch; diff, commits, checkpoints, flows and pull requests are off and say why.

**Why.** Not every folder an agent should work in is a repository, and refusing it made git a requirement for using Foreman at all.

**Turned down.** Running `git init` and a first commit behind the user's back: it changes their folder and its history without being asked (making a repository stays a separate, explicit choice). Copying the folder for each workspace: no way to bring the work back without a diff.

**Revisit when.** Foreman keeps its own snapshots outside git, which would give plain folders checkpoints and a diff.

## 2026-11-19: A branch already checked out is worked on where it is, never checked out twice

**Decision.** Checking out an existing branch that is already checked out opens it where it is: the repository folder, that worktree added as a workspace, or the workspace that already has it.

**Why.** git refuses a second checkout of a branch, so these branches couldn't be opened at all.

**Turned down.** `git worktree add --force`: two checkouts of one branch move each other's HEAD on every commit, so one shows the other's work as reverted changes.

**Revisit when.** git can share a branch between worktrees safely.

## 2026-11-19: New is a split button under the sidebar's top row, and its ▾ opens a list in the middle of the window

**Decision.** The + menu at the end of the sidebar's top row is gone. Under the top row, a full-width split button makes what the mode is about (Inbox and Work a workspace, Team an employee, Channels a project); its ▾, and Ctrl+Shift+N, open the list of everything to make in the middle of the window, the mode's own item first. Home's own New workspace and Import… buttons went with it.

**Why.** The menu opened from a 26 px square into the window's corner, 12 rows mixing making work with setting Foreman up, and typing a letter cycled through five "New…" items. Of 12 mocks the person picked a labelled split button and a centred list that leads with the mode.

**Turned down.** A shorter menu opening rightward, a two-column panel, New in the page header (a workspace page has no room on the right), a per-mode button with no list, a New page in place of the dialog, and a ▾ opening a searchable dropdown under the button.

**Revisit when.** People reach for the list more often than the main half.

## 2026-11-18: Needs you is a ring around a dot, failed a dot with a cross, and a count is a filled pill

**Decision.** `ui/Glyph` draws `warn` (needs you) as a ring around a dot and `error` (failed) as a dot with a cross cut out; ● ok, ■ info and ○ off stay. A count of what needs you on a tile is a soft filled pill in the needs-you colour, with no mark inside.

**Why.** The person found the pointed triangle (brown in light mode) and the diamond ugly and asked for something round and soothing. Of four drawn options they picked the ring: round like the dots around it, still a shape nothing else has, so no state rests on colour.

**Turned down.** Rounded triangle and diamond (still pointed). A dot with "!" cut out (calm, but the mark is small at 10 px). A half-filled dot (less obvious at a glance). A plain circle (it would be ● ok told apart by colour alone).

**Revisit when.** People with colour-vision differences confuse the ring with ○ off at small sizes.

## 2026-11-18: The sidebar is a rail of spaces and modes beside the list of the mode picked

**Decision.** The rail shows every space as a tile with its name under it, the one shown selected and the others with ▲ and how much waits there; under them the modes are labelled tabs (`Tabs` variant `rail`): Inbox and Work, and in an organization Team and Channels. Beside the rail is the list of the mode picked, titled with the space and the mode. Inbox holds everything in the space that waits on the person and links to what waits in the other spaces; Work groups by repository (each with ⋯ for its menu) or, chosen in Group by, by state, under a line saying how much waits in Inbox. Automations, the Assistant, Settings and ⋯ (palette, shortcuts, report a problem, tour, Mark all as read, Archived, version) sit at the rail's foot. The repository rail, the space dropdown, the filter tabs and the footer line are gone.

**Why.** The person found which space they were in (Personal or an organization) too hard to see in a dropdown, and the sidebar cluttered by four ways of filtering one list in 312px. Of 36 mocks they leaned to a rail of modes (28) but found its icon-only rail hard to tell apart, and picked spaces as named tiles above labelled modes (36, rail B).

**Turned down.** Space tabs and a coloured band per space (the band needed a new component), one list across every space, an icon-only rail (28 as drawn), no left sidebar at all (title-bar crumbs, top tabs, command first). A Memory mode and Open memory on a space's tile: the entry below keeps an organization's memory off the left. A + on each repository's heading: the top row's + stays the one way to add, and the heading's ⋯ has New workspace….

Every line of the list keeps one grid, as Slack's does: an icon column (18px) and a text column 10px after it, the same for headings, rows, the line to Inbox and the links under a list; two type sizes (15px names and headings, 13px the rest); every line 32px, the selected row one line like the others (its branch and age are in its hover card).

A row says what its workspace is for, not what it is called: its first chat's title (or an employee run's task), the workspace's name (its branch's) only until a chat has one. A generated name like osaka or a branch slug tells nobody which piece of work it is; the name and branch stay in the hover card, Find matches all three, and Rename changes what the row shows.

**Revisit when.** People with many organizations find the space tiles crowd the modes, or people miss what waits because they stay in Work.

## 2026-11-18: An organization's memory repository is never shown, only linked

**Decision.** New organization makes the memory repository unasked, without naming it or its folder. Nothing on the left shows it: not the rail, the sidebar list, the space switcher or Settings' repository list. Settings → Spaces says only where the memory is kept, and links it to GitHub (a new private repository or a URL), pushing each commit fast-forward.

**Why.** The person didn't want people seeing what Foreman stores for an organization, and a memory tile beside code repositories invited browsing it.

**Turned down.** Hiding it in Foreman's data folder (the person kept it beside the other repositories, only unseen). Removing the Memory view altogether (it stays on the Team, employee and project pages and in Spaces). Moving existing memory repositories (they stay where they are).

**Revisit when.** Several computers share an organization's memory and need to see where it lives.

## 2026-11-17: A sidebar row is one line, and its details are in a hover card that a click never opens

**Superseded** by the selected row's line: since 2026-11-18 the selected row is one line too (the sidebar's one grid, in "The sidebar is a rail of spaces and modes…").

**Decision.** Each workspace row shows its glyph, title, label and hat. Repository, branch, age, cloud state and the shortcut are in a HoverCard that opens after the hover delay or on keyboard focus (`openOnFocus="keyboard"`); the selected row keeps them on a second line.

**Why.** The person picked the dense 7a sidebar to cut clutter. A card that opened on the focus a click gives covered the workspace just opened, on the sidebar's most frequent action.

**Turned down.** Keeping the details on every row (the clutter the redesign removes). Opening the card on any focus (every click pops it). No focus opening (keyboard users would lose the details). This narrows the 2026-11-06 refusal of a repository hover preview ("accidental triggers"): rows get a delayed card, and the rail still has none.

**Revisit when.** People miss branch and age at a glance, or touch use matters.

## 2026-11-17: An AI employee has what a workspace's agent has, and no limits

**Decision.** Every employee gets a shell by default (Edit turns it off), every MCP server a workspace's agent has, Never ask when unattended, no refused paths, and no limits: no runs a day, minutes, cost threshold, lanes, organization cap, failure pause, hand-off depth or counts, or trigger floor. Kept: the memory repository's rules, held Slack and Linear posts, a chain's 20 runs, the event guards and a trigger's own overlap.

**Why.** The maintainer wants employees to work like a workspace's agent, and found the old limits stopped real work.

**Turned down.** Dropping the chain's runs too (a loop of employees would run until someone stopped it); per-employee MCP lists as opt-outs (nobody needed one); auto mode for unattended runs (it could deny a push and stop the run).

**Revisit when.** An employee loses work or does damage a guard would have stopped, or teams want limits back.

## 2026-11-17: A template employee is linked to its job's prompt, which improves without asking again

**Decision.** Each job (the fifteen templates and the program manager) has its own prompt file in `src/shared/employeePrompts/`. An employee hired from one records `template = "<job>"` and keeps only its organization's additions in its own `bots/<id>.md`; every run gets the job's prompt as that Foreman has it, then the additions. The fingerprint covers the link and the additions, not the job's text.

**Why.** The owner wants every hired template employee to improve when its job's prompt does. Copies froze each employee at the text it was hired with.

**Turned down.** Copying the job's text into each employee (frozen, and an upgrade would have to tell edited copies from unedited ones). Approving every new job prompt again (a release would pause every template employee).

**Revisit when.** People need an employee frozen at one version of its job's prompt.

## 2026-11-17: Every AI employee writes, pushes and opens pull requests without asking, with no limits

**Superseded** by 2026-11-17: An AI employee has what a workspace's agent has, and no limits.

**Decision.** A new employee (Priya, templates, proposals, New employee) gets Write on the organization's repositories, pushes and pull requests allowed, and no limit on runs or minutes; limits are optional. Employees that already existed were given the same once, keeping an approval nothing else changed.

**Why.** The maintainer wants employees to ship their work: a held push and a read-only template stopped that, and 6 runs a day or 30 minutes a run cut work short.

**Turned down.** Write with pushes still held for Send (a person in every loop); new employees only (existing ones would stay stuck); Priya left read-only.

**Revisit when.** Foreman is used by teams who don't want unattended publishing, or an employee pushes something it shouldn't.

## 2026-11-16: A project starts only by tagging the organization's one program manager, who plans it as data

**Decision.** Small work stays a workspace. A project starts when the person tags the organization's program manager (Priya), made and approved with every organization. She plans each project with `project_plan`; Foreman checks the plan and runs its parts as ordinary employee tasks (`docs/ai-employees.md` §15).

**Why.** Fixed procedures fit one kind of feature; a plan as data fits research, small changes and large features alike, and Foreman can still check it and hold what matters for the person.

**Turned down.** A standard team (chief product officer, product officer, user experimenter, developer, QA) running fixed stages: rigid, and five drafts to approve before anything runs. Projects as flow runs: flow steps are tabs of one flow workspace behind Experimental, while employee tasks have their own admission.

**Revisit when.** Flows and employee tasks share one ledger, or organizations need more than one program manager.

## 2026-11-13: An organization keeps its memory in one dedicated repository that only Foreman's memory service writes

**Decision.** Each organization has its own memory repository (for example `foreman-memory`), never shared with another organization. It holds organization memory, each AI employee's memory and definition, and Foreman's files for repositories that shouldn't carry `.foreman/`. Foreman's memory service is its only automatic writer, one commit per run; code repositories stay untouched (`docs/ai-employees.md`).

**Why.** Employees need memory that is persistent, inspectable and versioned. Memory in a code repository conflicts across work branches (`docs/ai-memory.md`, option F) and shows to everyone who clones it.

**Turned down.** Memory on a reserved branch of a code repository (a second worktree of a checked-out branch is impossible, and it shares the code's object store). One repository for all organizations (sharing one organization would share the others). Memory only in `foreman.db` (not inspectable or versioned). Agents committing memory themselves (no verified provenance).

**Revisit when.** Several computers must run one organization, or employees need read access to memory enforced between them.

## 2026-11-12: Features read one capability record per agent, and no feature branches on an agent's id

**Decision.** Every feature asks the agent's capability record (`src/shared/agentCapabilities.ts`, with what an account declares at start folded in) what it can do. None compares an agent's id: `tests/agentBranches.test.ts` holds the count at zero outside the adapters and the catalog.

**Why.** Ten agents with different protocols had spread `agent === 'claude'` checks over forty files, each silently deciding what another agent lacked. A record makes each gap data (works, works with a fallback, not offered) that Settings shows and tests prove against recordings.

**Turned down.** Per-feature flags or id lists: they drift from the adapters and nobody sees what is missing. A guard that only warns: the count never fell.

**Revisit when.** A capability depends on the turn rather than the agent and can't be a record field, or the record grows past what Settings can show a person.

## 2026-11-10: Outside agents sign in on a loopback listener of their own, and a level is scopes plus a ceiling carried down every turn

**Decision.** Agents on this computer use MCP on `127.0.0.1:47634`, OAuth with PKCE, approved in Foreman by typing the browser page's code. A level is scopes plus a ceiling that only lowers a turn's mode and passes to everything that turn starts; an agent that can't hold a ceiling (Cursor, ACP agents) is refused below Never ask.

**Why.** Any local process can reach a loopback port, and a cap held only on the first turn is escaped by delegating.

**Turned down.** The phone listeners (Tailscale Serve reaches the private one); the CLI socket (any same-user process holds its token); approving in the browser page, or comparing a code by eye (anything local can drive the page); letting Cursor run at Ask (it never asks).

**Revisit when.** A remote client such as ChatGPT must connect, or Cursor or an ACP agent can enforce a mode.

## 2026-11-10: One dispatcher and scoped sessions serve every client; the window keeps IPC and the server keeps Electron

**Decision.** `Api` and `MainEvent` stay the API; each method is `read`, `operate`, `admin` or `window`; every client calls through `ApiDispatcher`. Phones and browsers use a WebSocket on the phone listeners with the pairing cookie: a snapshot, then live events, no event log. Headless means no window, not no Electron.

**Why.** The T3 Code review traced phone control, a web client and background service to serving clients; its second reviewer said to grow that from the main-process service, not rewrite.

**Turned down.** The renderer over WebSocket (sandbox and IPC stay); exposing the CLI socket (its policy assumes local trust); event sourcing with cursors (the state fits one snapshot); a Rust or Electron-free server (`safeStorage`, the agent host and the browser panel need Electron; nothing measured is Foreman's own code).

**Revisit when.** A machine must serve with no display, state outgrows one snapshot, or users want Foreman where Electron can't run.

## 2026-11-10: Read-only is offered only where the agent enforces it, so not for OpenCode or other ACP agents

**Decision.** `supportsReadOnly` stays false for OpenCode and the other agents spoken to over ACP. Read-only chats exist for Claude (plan mode, with Foreman refusing edit tools) and Codex (its read-only sandbox), where the agent itself holds the line.

**Why.** An ACP agent runs its own edit and shell tools in its own process and only asks Foreman (`session/request_permission`) when it chooses to. Foreman's path containment covers only the writes an agent routes through `fs/write_text_file`, and plugins or MCP tools can still write. A read-only switch Foreman can't enforce would be a promise it can't keep.

**Turned down.** Refusing permission requests and file writes in Foreman alone (the agent's own tools bypass both); passing OpenCode's `permission` config to deny `edit` and `bash` (not verified, and OpenCode isn't installed where this was decided).

**Revisit when.** An agent-side setting that really blocks writes and commands has been verified for that agent, per turn, including its plugins and MCP tools.

## 2026-11-08: Full screen puts the terminal or a Flow run in the middle and moves the chat beside it

**Decision.** The terminal's full screen and the Flow tab's take the workspace's middle, and the chat moves to the side panel's first tab, Chat, still whole and usable. It is kept per workspace, across restarts, until put back; Esc doesn't leave it. One of the two at a time, and never a separate window.

**Why.** The terminal's full screen covered the whole workspace, so nothing else could be used until it was left, and a run is something to watch while talking to its chat.

**Turned down.** The terminal or Flow as a chat tab (can't watch and type at once); full screen with a floating chat card, a drawer, reply cards or a mini view (each covers part of the view or shows only pieces of the chat); a new window, which the user ruled out.

**Revisit when.** People want the terminal and a Flow run in the middle together, or the side panel is too narrow for the chat.

## 2026-11-07: A flow starts from its own page, where a run chooses its models

**Decision.** Run a flow is a page in Automations (flow, base branch, estimate and Start over Task, Models, Steps and Approves tabs beside the graph), replacing the Run dialog and the flow form in New workspace. A run may choose each agent step's model and effort: a tier, a person's choice for their steps, or one step. Only what differs from the flow is sent, checked by the flow's own agent rules, and kept on the run; it isn't part of the approved fingerprint.

**Why.** The dialog stacked the picker, inputs, a clipped graph and the approval in one scroll, and a flow's models could only be changed by editing it.

**Turned down.** Models in the fingerprint (they arrive with the start, so there is nothing to approve ahead). One model for every step (too coarse for planners and reviewers). A price-based estimate (no price table to keep current).

**Revisit when.** Schedules, `start_flow` or the CLI need to choose models too.

## 2026-11-06: A flow is drawn on a selectable graph laid out by Foreman, and edited with the assistant beside it

**Decision.** Flows, runs and lineage are drawn with a `Graph` component from `ui/` and a layout in `src/shared/flowLayout.ts` (main path along one axis, a loop's body folded under the step it returns to), not with Mermaid. A step or exit can be selected to open it; the outline stays the full keyboard and screen-reader equivalent. The assistant proposes a whole new flow document (`propose_flow`), shown as its changes, and changes nothing until the user applies it. Nothing is dragged.

**Why.** Mermaid's layout, shrunk into a dialog, was unreadable, and changing a flow meant writing TOML by hand.

**Turned down.** Keeping Mermaid at a larger size (overlapping loops still cross, nothing can be selected). A drag-and-drop canvas (a new interaction model). The assistant editing the file directly (it would change things the user didn't review).

**Revisit when.** People want to draw flows rather than describe them.

## 2026-11-06: A template opens as its own page in Automations, not in the side panel

**Decision.** Clicking a template replaces the library with the template's page: breadcrumbs and Back (or Escape), the prompt and its options on the left, Run now, Schedule…, ⋯ (Duplicate, Delete), schedules and recent runs on the right. The side panel keeps the schedules. The library stays mounted, so Back finds it as it was.

**Why.** In the 340px panel the prompt was about 320px wide and four rows tall, with everything stacked under it.

**Turned down.** A dialog like New workspace (hides the runs, turns autosave into Save/Cancel). A template list beside the editor (a new Schedules tab and a moved overview). Tabs per template, a live preview of the run, the template drawn as a small flow, and a card that expands in the grid (more to build or too short for a long prompt).

**Revisit when.** People edit templates one after another often enough that Back, then pick, gets in the way: the list beside the editor was the runner-up.

## 2026-11-06: The repository rail widens in place to show names; nothing opens over the list

**Decision.** The rail is tiles alone (52px). One toggle (Ctrl/⌘+Shift+N) widens it beside the workspace list to show each repository's name and what is going on in it, and narrows it back; the choice is remembered. The drawer that covered the list is gone.

**Why.** Captions under the tiles were cut to fit, and the drawer opened from a button that couldn't close it and hid the list it was meant to filter.

**Turned down.** A switcher in the sidebar title (switching takes two actions). Repositories as foldable groups, or as a filter (a larger change, moves repository Home). Tabs (three names fit). A drill-in list (two clicks between repositories). A hover preview (accidental triggers, no touch).

**Revisit when.** People routinely keep more repositories than the rail shows without scrolling.

## 2026-11-05: Automations is a library, not a week calendar

**Decision.** The Automations page centres on a library of templates and commands, as cards with tabs and a search. Each template says when it runs and how its last run went; the side panel lists every schedule. The week calendar is gone.

**Why.** The calendar answered only "when" for schedules, which most templates don't have, and flows (`docs/loops-and-graphs.md`) add runs that aren't on a clock at all.

**Turned down.** Runs first (Needs you, Running, Coming up), which empties the page for anyone without runs. Rules ("when CI fails, run…"), which makes templates secondary. One template that grows into a flow, which merges two persisted shapes before flows exist.

**Revisit when.** Flows ship: they add Flows and Personas tabs here, and runs may earn the centre.

## 2026-11-06: A flow branches on a fact's kind, never on an agent's words

**Decision.** A flow's edges choose the next step from facts a step produced: checks passed or failed, a review clean or with findings, a gate continued, sent back or stopped, an option a `decide` step reported through Foreman's tool. Nothing in a flow reads an agent's prose, and a sent-back note is the user's instruction, never data.

**Why.** Loops that end when an agent says it is done end when the agent is wrong. Facts come from Foreman's own records and tools, so a run is predictable and auditable, and a step can run on a smaller model because the routing isn't its job.

**Turned down.** Matching the answer's text (brittle, and an agent can be prompted into it). Confidence scores from the model (uncalibrated). Letting the agent call the next step itself (that is delegation, which already exists and isn't persisted).

**Revisit when.** An agent can return a typed verdict the harness verifies, not a sentence.

## 2026-11-06: A flow is edited as an outline and shown as a diagram, not drawn on a canvas

**Superseded** by 2026-11-06: A flow is drawn on a selectable graph laid out by Foreman, and edited with the assistant beside it.

**Decision.** A flow is a TOML file; the app edits it as a list of steps with forms, and draws it with the Mermaid renderer the chat already has, with a Run · Context · Memory · Data lens switch. The diagram is a picture of the outline and opens nothing itself; the outline carries every fact and is what the keyboard and a screen reader use. Flows are off by default, behind Settings → Experimental → Flows, and off means none of it is shown.

**Why.** The graphs are a dozen nodes with labelled edges; a canvas would be a new component with its own keyboard model for little gain, and the catalogue forbids a second way to build controls. The file diffs and ships with the repository.

**Turned down.** A drag-and-drop canvas (a new interaction model and component). Rendering the graph as the only view (not accessible). Shipping the feature on by default (it adds tabs, sections and tools everyone would see).

**Revisit when.** Flows routinely exceed what a list can show, or the switch has been on for most users for a release.

## 2026-11-03: The terminal panel's scripts and terminals are tabs in its header

**Decision.** Run scripts, Setup and terminals are one row of tabs in the panel's header, with + for a new terminal, another shell or a saved command (the Commands button is gone). No terminal opens until asked for; with no run script and nothing open, Run is the only tab and its panel offers four ways on. Setup's tab is an icon until selected.

**Why.** The side rail took a fixed column from every terminal and run log, and drew a list beside an empty panel.

**Turned down.** Keeping the rail (a column beside every output). A title menu listing everything (hides which terminals are open). A Run | Setup | Terminals switch (terminals a click deeper). Tabs along the bottom edge (less discoverable). Run and a terminal side by side (halves both).

**Revisit when.** People routinely keep more terminals open than the header shows without scrolling.

## 2026-11-03: Controlling another computer forwards the whole window, minus a short refusal list

**Decision.** A paired computer that is let in serves every window call except those in `src/shared/remote.ts`: its own screen and app (pickers, Open in…, quitting, updates), local file paths, and reading a saved secret back. Keys can be set from the other computer, never read. Asking first is the default, and agents can neither read nor change these settings.

**Why.** The window already speaks one generic call channel, so forwarding it gives the whole app remotely with one rule to review, where a curated list would lag every new feature.

**Turned down.** The phone's hand-picked endpoints (a second API to maintain). Mixing both computers' workspaces in one list (busier, and every call would need a target). Letting a paired computer in without asking by default (pairing proves the computer, not who is at it).

**Revisit when.** Watch-only access is added, which needs every call classed as read or write.

## 2026-11-02: The terminal panel lists its scripts and terminals in a side rail

**Superseded** by The terminal panel's scripts and terminals are tabs in its header.

**Decision.** Run scripts, Setup and terminals are entries in a vertical list on the panel's right, icons only below 420px, with a header for the selected one. Several scripts can run at once. A terminal's rename and close live in its own right-click menu, not on its entry.

**Why.** The horizontal strip crowded out the Run button and shrank terminal names to "▣ 1" at the side panel's width, and Setup held a tab it rarely needed.

**Turned down.** Tidying the strip (still one script at a time, still crowded). A Run | Terminals switch (an extra click between a server's output and a shell). A process list above the output (takes the output's height). Close buttons on rail entries (crowd an icon rail).

**Revisit when.** People routinely keep more terminals open than the rail shows without scrolling.

## 2026-11-02: Pull request screenshots live on their own branch

**Decision.** `npm run pr:screens -- publish` pushes a PR's before-and-after screenshots to the `pr-screenshots` branch, which shares no history with `main`, and the PR links to them by commit.

**Why.** `gh` can't attach images to a PR, and screenshots committed with the change would stay in `main`'s history for good. Links pinned to a commit keep working after the PR merges.

**Turned down.** Committing the images with the change (they grow every clone). Dragging them into the PR by hand (agents can't, so UI PRs would go without). Release assets (they show up as releases).

**Revisit when.** GitHub's CLI or API can upload images to a pull request.

## 2026-11-02: Each pull request carries its release note, and CHANGELOG.md keeps them

**Decision.** Every PR body ends with a release note in the changelog's categories, or `None` with a reason. When a release is cut, the notes of the PRs merged since the last release are to be edited into `CHANGELOG.md`, which becomes the only record of releases and the source of the GitHub release's text. Until that release step exists, the Release workflow still drafts notes from PR titles (see "Releases" in [maintenance.md](maintenance.md)).

**Why.** The release notes were a generated list of PR titles, and `CHANGELOG.md` stopped at 1.0.2. Installed copies show the notes in **What's new**, so they're written for users.

**Turned down.** Each PR editing `CHANGELOG.md` directly: branches run in parallel here and would all conflict at the top of the file. GitHub's generated notes alone: titles are written for reviewers, not users.

**Revisit when.** Several people merge every day and collecting by hand at release time stops scaling.
