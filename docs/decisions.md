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
