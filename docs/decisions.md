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
