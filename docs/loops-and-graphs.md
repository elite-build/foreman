# Loops and graphs

Foreman already runs loops and graphs of agent work; it just never lets anyone see or write one. A schedule is a loop over time. Auto-fix CI is a loop over a pull request's checks. Auto review is an edge from a worker's turn to a reviewer's. Hand-offs, forks, Compare models and the delegation tools are edges between chats and workspaces, and a template's follow-up is a two-node path. Each was built on its own, with its own record, consent dialog, budget and stop rule, and none of them can be composed or repeated with a stop condition.

This page designs **flows**: a graph of steps the user (or, under the existing opt-in, an agent) writes once and runs many times, with loops that stop on facts Foreman already knows. It deliberately does not stop at the run order. The same flow is read through four graphs, because the run order is the least of what goes wrong when agents work in a chain: what each step is shown (context), what survives from one step or one iteration to the next (memory), and which tree, branch or pull request each step works on (data) are where chains silently break. Every lens is drawn from records Foreman keeps today, so a flow can also be *recovered* from work that was done by hand and turned into one.

Nothing here adds a server, a daemon or an account. Flows run while Foreman is open, on this computer, under the rules the schedule and auto-review services already follow.

## Status

Built so far, all behind **Settings → Experimental → Flows** (off by default):

1. **Flow files.** The TOML format and its checks, the built-in starters, a repository's `.foreman/flows/*.toml` and personal flows, listed on Automations with an editor that checks as you type.
2. **Runs.** `turn`, `checks` and `gate` steps in a new workspace, loops with iteration and minute bounds, the run approval and its fingerprint, Stop, needs-you, uncertain after a crash, the Flow tab, and flow rows on Home and in the sidebar. A gate is an approval with Continue, Send back and Stop.
3. **The command line.** `foreman flow list | show | add | remove | run [--wait] | runs | status | stop`, and gate answers on `foreman approve <id> --continue | --send-back [--note] | --stop` ([cli.md](cli.md)). Saving or removing a personal flow or persona (`flow add | remove`, `flow draft --save`, `persona add | remove`) is in the admin tier: refused inside an agent turn, as settings are; the assistant's Run card runs it after the click.
4. **Personas.** The markdown format with its strict frontmatter, the four starters (architect, developer, qa-engineer, designer), a repository's `.foreman/personas/*.md`, its `.claude/agents/*.md` offered for Claude steps (name, description and model read; tools kept, not applied), and personal personas in `state.json`, listed on Automations beside Flows with an editor that shows a persona as settings with the instructions beneath (read-only for built-in and repository ones, with Copy to personal). A name means your persona first, then the repository's file, then its `.claude/agents` file, then the built-in one. In a run, a `turn` step's persona (or, for a step continuing another's tab, that step's) adds its instructions to the turn's system prompt, receipted as a `persona` part; holds the turn read-only (plan mode for Claude); keeps only its MCP servers; adds its `shows` to the step's context; and gives its loadout when the step names none. A step may narrow (`read_only = true`, fewer `mcp`) but a step that loosens one, a persona that isn't there, a read-only persona on an agent that can't hold it, or a persona's loadout that isn't set refuses the start. Every persona a flow uses is part of its fingerprint, and the Run dialog, the Flow tab's steps, the chat's flow chip and `foreman flow show` name them; `foreman persona list | show | add | remove` drives them from a terminal.

5. **Every step kind.** A `review` captures the workspace's diff and reads it in a read-only tab (Claude Code or Codex; any other reviewer refuses the start), as auto review does: a non-empty `foreman-findings` block is `findings`, `[]` is `clean`, and with no block a review request is findings and `done` is clean; a persona with `ends_with` that ends with neither is `undecided`, which takes the `findings` edge when the flow has none for it. Its findings, as Send to worker words them, are the `<step>.findings` section, and the step records the tree it read. A `script` runs a saved command (yours, or one in the repository's settings) by name as checks run theirs, with the same approval; its command is part of the run's fingerprint, an unapproved one leaves the run in Needs you, and the end of its output is `<step>.output`. A `decide` is a read-only turn offered Foreman's `decide` tool (and `foreman decide <option>`) for that turn only; an option it doesn't name is refused, and a turn that ends without one is `undecided`; the decision shows in the chat as "agent says: decided". A `wait` reads the pull request's CI (`green`, `failed`, `none`) or review (`approved`, `changes-requested`) through the PR cache once a minute, ends as `timed-out` after `at_most = { minutes }` (120 by default), fails the run when the workspace has no pull request, and counts no loop minutes. A `workspace` step makes a new workspace from the base branch, or from a step's end (that turn's end checkpoint, restored before setup as Compare does); later steps work there, the run keeps every workspace it made, and a failed setup ends the run unless the flow branches on `failed`. A `pick` asks you (in the window, on the phone, or with `foreman approve <id> --pick <step>`) which of two or more turn or workspace steps' results to go on with, each shown with its changes, last turn and checks. `compact-when-full` sends the agent's `/compact` before a pass's turn in a tab past `compact_above` percent of its window (70 by default) and waits for it; an agent without one gets a fresh tab. `fresh-with-summary` starts each pass in a new tab with the run ledger (each finished step's fact and words, and each turn step's last answer) as a `ledger` section; `ledger` and `tree` (the base branch and the working tree's hash) can be sent to any step. A loop's `cost` bound sums what its turns' `result` items say they cost, which only Claude reports, and the Run dialog says so. A completed run's `[after]` archives the workspaces it made, or deletes the ones with nothing changed, through auto-archive (the Archived view says "Flow run completed"). The starters run as written.

6. **The diagram and the four lenses.** Each step's record now keeps what the lenses need, small: the tab's context window when its turn ended (`usage`), the memory files Claude's breakdown named, the memory paths its delta wrote (`isMemoryPath` in `shared/memoryPaths.ts`: CLAUDE.md and AGENTS.md anywhere, `.claude/`, and the breakdown's files), the note revision it was shown, the model it ran on, and the working tree's short hash before it ran and after it ended (`tree.start`, `tree.end`; checks, a review and a script record the tree they read, a workspace step its new workspace's). A step that starts on another tree than the step before it ended on in the same workspace is `moved`, and its detail says "tree moved since the last step". `shared/flowGraph.ts` draws a flow, and a run of it, through each lens (run: facts, taken or not, the ends and the loops as rings; context: sources declared and as sent, the window per turn and per pass; memory: the run ledger, the note with the revisions seen, standing instructions, personas, memory files and reports, with reads and writes; data: the base branch, the workspaces the run made, each step's trees with "moved" in words, the pull request a wait read) and `flowMermaid` turns it into Mermaid source with no colours: state is a glyph and a word, a gate a hexagon, loops subgraphs titled with their bounds; left to right where it is wide (the Flows dialog, `--mermaid`), top to bottom in the side panel's Flow and Lineage tabs. The Flow tab has a Run · Context · Memory · Data switch over the diagram (the chat's Mermaid renderer, re-themed with the app) with per-lens rows under it (the shown sections and a window meter per turn, the ledger and memory with read and write counts, the trees with "Moved"), and the step list, the diagram's accessible equivalent, follows the lens; the Flows dialog shows a flow's run graph above its TOML. `foreman flow status <run> --lens context|memory|data` prints the same facts and `foreman flow show <flow> --mermaid` the run graph. A run whose flow file changed since it started is drawn from its records alone (the steps that ran and the facts they went on by). Nodes don't open what they stand for yet (the step list does), the standing-instructions node is drawn for every agent step rather than read from a record, the context lens has no breakdown beyond the memory files, and the turn that makes the run's workspace has no start tree.

7. **Records and Lineage.** The seven gaps below are recorded now, each optional on the record that has it, so older history still reads: a hand-off keeps `Session.handedOffFrom` (the source tab, the turn it was taken after, the sections and their previewed hashes); a workspace that a workspace agent's `start_task`, `foreman new`/`run` from inside a turn or the assistant started keeps `Workspace.startedBy`; `MessageOrigin` is a union (`auto-fix`, `delegation` for `send_task` and `foreman send` from a turn, `flow` with run, step and pass, `schedule`, `limit-resume`); each `turn-end` item keeps the window as the turn ended (`usage`), the memory paths its changes wrote (`memoryWrites`) and its checkpoints' short tree hashes (`tree`); a check run keeps `startedBy` (`user` for the Git panel, the phone, `foreman checks approve` and an agent's `run_checks`; `auto`; the flow run and step; `cli` for `foreman checks`). While Flows are on, every workspace has a **Lineage** tab: `shared/lineage.ts` draws its chats' turns (and the one turn each linked chat elsewhere stands for), its check run, CI runs and pull request through the four lenses, in flowGraph's shape so `flowMermaid` draws it. Run: forked from, handed off, findings sent, compare sibling, auto review, auto-fix n of m, delegated by, a flow run's step, checks after a turn, a scheduled run, resumed after a limit. Context: what Foreman added to each turn with its size, the window, a hand-off's sections and hashes. Memory: the note revisions seen, standing instructions, memory files read and written, reports, personas. Data: the base branch, each turn's trees with `moved` across the workspace's chats, the compare checkpoint and the pull request. Each link names the record it comes from or, when it was inferred from a message's words or from timing, is dashed and names the record it needs; the outline under the diagram lists every node with its links and those tags, each opening its turn or the checks, and a Gaps callout lists the records the history lacks. **Make a flow from this…** drafts a flow in the order things happened: each turn a `turn` step with its template, else `prompt = "{{task}}"`, later turns in the same chat continuing its tab; the check run a `checks` step; a review a read-only `review` step on the reviewer's model; findings sent back an `address` step in `review-until-clean`, at most 2; a pull request opened by hand a `pr-check` gate and a turn running `foreman git pr create`; auto-fix a `wait` on CI with a `fix` in a loop. What it leaves out is listed in a comment and in the dialog, which saves it as a personal flow or copies it. `foreman workspace lineage <workspace> [--lens …] [--mermaid]` and `foreman flow draft <workspace> [--save --name …]` do the same from a terminal. Reading stays bounded: the workspace's newest 24 chats, 12 linked ones, and the last 600 user, turn-end and result items of each. Findings sent with "Send to worker…" have no origin kind yet, so that link stays inferred; a message's template is known only through its follow-up or a repository template's name; and who opened the pull request is inferred from timing.

8. **Entry points.** New workspace has a **Start with** row while Flows are on (Message · Template · Flow · Issue or PR; off, the dialog is as it was): Flow lists the repository's runnable flows as cards with their source, steps, loops, gates and personas, asks for the chosen flow's inputs, draws its run graph and shows the approval card the Run dialog shows (now with the flow's `[after]` as read-only text; no flow can override it), and **Start flow** starts it from the form's repository and base branch with the fingerprint shown, while **Create workspace only** makes the workspace as before; Issue or PR is a link field the existing link detection reads, sent with anything written under it. The Run dialog, New workspace and the Schedule dialog share `automations/FlowStartFields.tsx`. A schedule's target is a template or a flow (`Schedule.flow`: id, source, name and inputs; `templateId` stays for the schedules before it, and one of the two is set): the Schedule dialog has a Template | Flow choice with the same picker, inputs and approval, and no model, maximum duration or After each run for a flow (the flow's `[after]` is the one policy for its runs), and saving sends back the approval it showed, so a flow changed since is refused; saving refuses a flow whose turns aren't on Claude, in the design's words, and one with an input left empty (a scheduled run can't ask); the fingerprint is the flow run's (the flow, its templates and personas, setup, checks with its script steps' commands, MCP), so a change pauses the schedule naming "the flow" or "its personas"; a due run starts through `FlowService.begin` from the schedule's base branch on exactly what was approved, the run's new `origin` names the schedule and occurrence, the occurrence keeps the run id and ends as the run ends, and the flow's loop bounds stand in for the duration limit; Home's Scheduled card, the schedule's page and `foreman schedules` name the flow, and `foreman schedules add|preview|edit --flow <flow> --input key=value` do the same from a terminal. The assistant's guide tells it to draft a flow (and a persona for a role none fits) when the user says who does what, and to propose `foreman flow add --toml "<document>"` and `foreman persona add --markdown=<document>` on its Run card: the card carries the whole document, nothing is saved before the click, and its `run_foreman` takes words as long as a flow file (the workspace fallback keeps its limit). It may now propose `foreman flow run` there too; a workspace agent's `run_foreman` refuses `flow run` and points at `start_flow`. Delegation adds `start_flow` (the coordinator's repository, the opt-in, a runnable flow and every input, the approval as it stands when called, the coordinating chat or the assistant's thread as the run's origin, which its workspace records as `startedBy`) and `get_flow_status` (runs in that repository only; it never waits), offered only while Flows are on, and `list_delegation_options` lists the runnable flows with their inputs and personas (and why one can't run unattended). No tool answers a gate or a pick. The sidebar groups a run's workspaces under the flow's name as Compare siblings are grouped, and Home's row for a run waiting at a gate or a pick says so.

9. **Scoped writes, counted loops, Codex reviewers, pull requests, and more starters.** A persona may say `writes: [docs/features/**]` (globs relative to the workspace root): with it, and not read-only, its turn edits files only there and has no shell. Foreman enforces it, not the prompt: a PreToolUse hook on the Claude turn allows Edit, Write, MultiEdit and NotebookEdit inside the globs and refuses them elsewhere (naming the allowed area) and refuses Bash and PowerShell, each refusal words the agent reads and carries on from rather than the unattended denial that stops the run (`writeScopeDecision` in `shared/permissions.ts`). Only Claude can be held to it, so such a step refuses the start on another agent; a step may narrow `writes`, never widen it, and the persona editor, the approval card, `foreman persona show` and `foreman flow show` name it. A loop may say `times = N` and `then = "<step>"`: its steps run exactly N passes (each entry of its first step is one), and the edge that would start pass N+1, or leave after the Nth, goes to `then`; `at_most` still bounds it, and the diagram titles it "3 times, then show". Review and decide steps may run on Codex: read-only in its sandbox and attended, so an approval it asks for waits in Needs you, with the run waiting (no loop minutes) rather than denied; turn steps stay Claude only, and GPT-6 Astra is in the Codex list. A `pr` step opens the pull request for the run's workspace branch with no agent: the branch is pushed as the Git panel's Push does (the repository's account), then `gh pr create` or GitLab's merge request API opens it, a draft unless `draft = false`, its title the step's or the last commit's, its body the step's (`{{ledger}}` is the run ledger); `opened` keeps the number on the run for a later `wait`, and `failed` says why (no remote, nothing pushed, the host refusing), failing the run when the flow has no edge for it. Nothing commits for it, so the starters commit in a turn first. "Make a flow from this…" drafts a pull request opened by hand as a `pr` step. A gate's `show` takes file paths ("docs/features/{{slug}}/requirements.md", inputs filled in; a `*` in a part of it means the newest match), read in the workspace, never outside it, cut at 8 KB, and shown read-only on the gate card, on the phone and by `foreman approvals`; a cloud workspace's files aren't read yet. A review step may have a `prompt`, which leads its instructions. Ten personas ship now (architect, developer, qa-engineer and designer, then product-manager and ux-designer writing only under `docs/features/`, security-reviewer, docs-writer under `docs/`, researcher under `docs/research/`, and research-reviewer), and eleven flows: Fix until green, Research then implement, Test first then make it pass, Issue to draft pull request, Second opinion then pick (one plan built in two workspaces, one after the other, then a pick), Two reviewers must agree, Keep a long-lived branch fresh (for a schedule), Flaky test triage (it runs a saved command named `flaky-tests`, so it can't start until one is saved), Document what changed, Is this feature worth building? (a counted loop of three review rounds) and From an idea to a feature. Each has bounds on every loop and a gate before anything leaves the computer, and starts with the default loadouts (1 builds or researches, 2 thinks and reviews, 3 is the Codex reviewer).

Not built yet: the `attachments` and `comments` context sources (a step's record says they weren't sent); diagram nodes that open what they stand for (the outlines do); the outline editor (flows are written as TOML, drafted from a lineage, or drafted by the assistant); the flow page's edge counts across runs; pausing a flow after two failed runs (a schedule that targets one pauses, the flow alone doesn't); an assistant draft opened in the Flows dialog before it is saved (it is shown in the chat and on the Run card); a run started from the assistant's `flow run` card recording the assistant's thread as its origin (`start_flow` from the assistant does); scoped writes on another agent than Claude; a `script` step whose command is one of the flow's inputs; a gate showing the file a step chose to write (the built-in flows show `docs/features/*/requirements.md`, the newest match, since the persona picks the slug as it writes); and a check that a `decide` step on Codex can reach the decide tool from its read-only sandbox (a review there needs no tool: its findings block is in its answer).

## What exists already

| Piece | Where | Loop or graph it is | Stop rule and record |
| --- | --- | --- | --- |
| Schedules | `src/main/schedules.ts`, `shared/schedule.ts` | A loop over wall-clock time: one template, a fresh workspace per run. | Duration cap, two failures pause it, fingerprint of template, setup, checks and MCP; an `Occurrence` written before launch; missed runs skipped, never replayed; two at once app-wide; Claude only. |
| Auto-fix CI | `src/main/autoFix.ts`, `shared/autoFix.ts` | A loop over a PR: CI fails → fix turn → new head → CI again. | Each failure (PR, SHA, checks) spent before sending; one at a time app-wide; stops on a failed, stopped, over-long or head-less turn; 20-minute cap. |
| Auto review | `src/main/autoReview.ts`, `shared/autoReview.ts` | An edge: worker turn completes → read-only reviewer tab reads the diff → findings offered back through Send to worker. | Checks must have passed for exactly this tree; six a day, ten minutes each; findings go stale when the tree moves. |
| Checks after a turn | `src/main/autoChecks.ts` | An edge: turn completes → check commands run. | Interrupted by any new work; never an agent. |
| Hand-offs | `src/main/handOffs.ts`, `shared/handOff.ts` | An edge to a new chat: second opinion, review or continue, carrying a chosen task, answer and diff. | Sections are hashed in the preview and refused if the source moved. |
| Forks, agent switches | `shared/fork.ts`, `shared/switchAgent.ts` | An edge inside a tab's history: `forkedFrom`, parked conversations, catch-up notes. | Receipted as `ContextPart`s on the message. |
| Compare models | `shared/compare.ts`, `src/main/compare.ts` | A fan-out: one prompt, sibling workspaces from a fresh checkpoint, different models; `compareId` ties them. | Reports how each ended; never picks a winner. |
| Delegation | `src/main/foremanDelegation.ts`, `shared/foremanDelegation.ts` | An agent-directed graph: start, send, wait, read, cancel across workspaces of one repo. | Opt-in per repository; no self-wait; replies read as untrusted text; not persisted as a workflow. |
| Template follow-ups | `PromptTemplate.followUp` | A two-node path: answer → "Continue to …" with a prompt and model. | Offered, never run. |
| Limit resume, Later | `shared/types.ts` (`LimitResume`), `shared/later.ts` | A single timed retry; a workspace that comes back on a day. | Asks instead of sending late. |
| Agent reports | `src/main/agentReports.ts` | The agent's own signals: needs-input, stuck, checkpoint, done, review. | Attributed to a turn by token; nothing written into the repo. |
| Context receipts and usage | `shared/context.ts`, `shared/contextUsage.ts` | What Foreman added to a message; what fills the window (memory files, MCP servers, skills; Claude only). | Kept on the message and the session. |
| Checkpoints and turn deltas | `src/main/checkpoints.ts`, `src/main/turnDelta.ts` | A tree per turn start and end, so every turn is a data edge. | A missing checkpoint is "unknown", never "nothing changed". |

What none of them give: a model of a step that any of the others can be a node of, a loop with a stop condition other than time or a one-off trigger, a way to say what the next step is shown, a record of what a run of several steps did as one thing, and a view of any of it.

## Goals

1. **Write a graph once, run it many times.** Steps, edges and loops in a file the user can read, with the same personal-or-repository split as templates, and the same approval-by-fingerprint as schedules.
2. **Stop on facts, not hope.** A loop ends on checks passing, a PR's CI going green, a review with no findings, an agent's `done` report, no diff, a context window past a threshold, or a bound on iterations, minutes and cost, whichever comes first. Never on an agent saying it is finished in prose.
3. **Make the context explicit.** Each edge says what the next step is shown, and the receipt on its first message says what was really sent. A loop says whether an iteration continues the same conversation, compacts it or starts fresh with a carried summary.
4. **Make memory a thing you can see.** What crosses iterations and runs (a run ledger, the workspace note, agent memory files, reports) is a node in the graph, with who writes it and who reads it.
5. **Make data lineage a thing you can see.** Which checkpoint, branch, worktree or pull request each step started from and produced, so "it worked on the wrong tree" is visible, not deduced.
6. **Recover graphs from what happened.** The four lenses are drawn from existing records, so a workspace's history shows as a graph without a flow, and "Make a flow from this" turns a chain done by hand into a file.
7. **Keep the existing safety rules.** Unattended turns stop for the human on any approval or question; caps, fingerprints, consent for check commands and MCP servers, and the repository opt-in for agents starting work all hold. Foreman writes nothing into the repository.

Not goals: a visual drag-and-drop canvas (see "Showing a graph"), a general workflow engine with expressions, running while Foreman is closed, running across computers (a flow's steps run on the computer that owns the workspace), merging branches automatically.

## The model

A **flow** is a named graph with one start node. It belongs to a repository (its steps make workspaces and run checks there) or is personal and asks for the repository when started, as templates do.

```toml
# .foreman/flows/fix-until-green.toml
name = "Fix until green"
description = "Implement, run checks, fix what fails, review, stop when the review is clean."

[start]
step = "implement"

[steps.implement]
kind = "turn"                  # an agent turn in a tab of the flow's workspace
template = "implement-issue"   # a personal or repo template; {{placeholders}} are the flow's inputs
persona = "developer"          # who the step is: instructions, what it may do, what it is shown (see "Personas")
loadout = 1                    # or agent = "claude", model = "…"; overrides the persona's default

[steps.checks]
kind = "checks"                # the repo's approved check commands, never an agent

[steps.fix]
kind = "turn"
prompt = "The checks below failed. Fix them and run them again."
context = ["checks.results", "implement.answer"]
same_tab = "implement"         # continue that conversation, else a new tab

[steps.review]
kind = "review"                # a read-only reviewer tab, as auto review does
persona = "qa-engineer"
loadout = 2
context = ["diff"]

[steps.address]
kind = "turn"
same_tab = "implement"
context = ["review.findings"]

[edges]
implement = "checks"
checks = { passed = "review", failed = "fix" }
fix = "checks"
review = { clean = "done", findings = "address" }
address = "checks"

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"        # or "compact-when-full" (above 70% of the window) or "fresh-with-summary"

[loops.review-until-clean]
over = ["review", "address", "checks"]
at_most = { iterations = 2 }

[after]
workspace = "keep"            # keep | archive | delete-unchanged, as schedules say it
```

The format is TOML because repository settings already are, parsed by the same loader (`src/main/repoSettings.ts`) with a flow schema beside the repository settings schema. A personal flow is the same document kept in `state.json`, like personal templates. Fields are few on purpose: a flow names steps, says which fact chooses the next one, and bounds its loops. It has no variables, expressions or scripting; the facts it branches on are the ones below.

### Steps

| Kind | What runs | What it produces (facts the graph can read) |
| --- | --- | --- |
| `turn` | A message in a tab of the flow's workspace: a template with the flow's inputs, or a prompt. `same_tab` continues another step's conversation; otherwise a new tab, seeded with the edge's context. | `answer` (the visible reply), `delta` (files, +/-), `outcome`, `reports` (the agent's `done`, `stuck`, `needs-input`, `review`), `usage` (context ring). |
| `checks` | The repository's check commands, through `ChecksService`, with their existing consent. | `passed`, `failed`, `results` (the failing output, as Fix CI sends it). |
| `review` | A read-only reviewer tab reading a captured diff, exactly as auto review starts one. | `clean`, `findings`, the tree it read. |
| `workspace` | A new workspace for the following steps: from the flow's base branch, or from a named step's end checkpoint (what Compare models does for siblings). | `workspace`, `tree`. |
| `script` | A saved command or repository script, run as `checks` runs its commands: no agent, the same consent and fingerprint. The deterministic steps of a procedure (build, lint, a data fix-up, a report generator) belong here, not in an agent's prompt. | `ok`, `failed`, `output` (cut to a size limit). |
| `decide` | An agent turn whose only job is to pick one of the options the flow names (`options = ["low", "medium", "high"]`), through `foreman report` or the MCP tool, so the choice is a deliberate call and never read from prose. Read-only. | The option chosen, or `undecided` when the turn ends without one. |
| `wait` | A fact that changes outside a turn: the PR's CI (`green`, `failed`) or a review on the PR. | The fact, with how long it waited. |
| `gate` | A person decides. The run stops in Needs you with what to look at (`show = ["diff", "checks.results", "review.findings"]`, or a file by its path, `"docs/features/{{slug}}/requirements.md"`, a `*` meaning the newest match), and offers **Continue**, **Stop** and **Send back** with a note. Nothing runs until answered; the phone can answer it like any other request. Time spent waiting doesn't count against the loop's minutes. | `continued`, `sent-back` (the note goes to the next step as context), `stopped`. |
| `pick` | The user chooses among sibling results (a Compare-style card). Never automatic. | The chosen step. |
| `pr` | Opens the pull request for the workspace's branch, as the Git panel pushes and the host creates one, with no agent: a draft unless `draft = false`, with an optional `title` and `body` (the flow's inputs and `{{ledger}}`). Nothing is committed for it. | `opened` (its number kept on the run, where a `wait` finds it), `failed` (the reason). |

A `gate` is different from the approvals an unattended turn would ask for. Those are denied and stop the run, because nobody planned for them. A gate is planned: the flow says "here, a person looks before anything else happens", so the usual place for one is before a pull request is opened, before a merge, or after research and before implementation.

```toml
[steps.plan-check]
kind = "gate"
show = ["research.answer"]
ask = "Is this the plan you want implemented?"

[edges]
research = "plan-check"
plan-check = { continued = "implement", sent-back = "research", stopped = "done" }
```

Every step runs with the rules its service already has: a `turn` or `review` is unattended (auto mode, approvals denied, any question stops the run for the human), `checks` needs approved commands, a new workspace runs setup and holds the first message when setup fails. A flow can't do anything its steps can't do alone.

### Edges and the facts they branch on

An edge is either a plain next step or a table keyed by a fact of the step it leaves. The facts are the step's own, listed above, plus the loop bounds. Nothing else: no comparisons, no text matching, no reading the agent's prose. The agent's `done` report counts as a fact because it is a deliberate call through `foreman report` or the MCP tool, not a sentence in its answer.

Routing done by the file rather than by the agent is also what makes a step cheaper. An agent that has to work out the procedure as well as do the work needs a strong model and a long turn; a step that is handed one job inside a fixed procedure can often run on a smaller model in a fraction of the time. That is the practical case for per-step loadouts, and it is why `script` and `decide` exist: the more of a procedure that is deterministic, the less there is for a model to get wrong.

### Loops

A loop names the steps it spans and what ends it. It ends when an edge leaves the spanned steps (the fact the loop was for came true) or when a bound is hit: `iterations`, `minutes` (time spent waiting for an agent slot doesn't count, as with schedules), `cost` (from the turns' `result` items), or the context window past a threshold with no policy to deal with it. A bound that ends a loop ends the run as `stopped`, with the bound named, never as `completed`.

A loop counts in **passes**. A pass opens when the run enters one of the loop's steps from outside and closes when it leaves them, and the bounds count within a pass. So a gate placed outside the loop, whose `sent-back` edge re-enters it, starts a fresh pass with fresh bounds: the person at the gate chose another round. A flow that wants the gate's rounds to count against the loop lists the gate in the loop's `over`. The run record numbers the passes ("pass 2 · iteration 1 of at most 3").

A note sent back from a gate is the user's own instruction for the step it goes to. It leads that step's message as such, before the step's prompt, and is never framed as data from an earlier step. A step that gets a sent-back note with checks that already pass should expect to act on the note, so a flow's "fix" prompt is better written as "address what failed or what you were sent back for" than "the checks below failed".

A loop can also be **counted**: `times = 3` and `then = "show"` run its steps exactly three passes, counting each entry of its first step, and the edge that would start a fourth, or leave the loop after the third, goes to `then` instead. `at_most` still applies as a safety bound, and `then` is a step outside the loop. It is how "review, reconcile, revise, three times, then show me" is written without a decision step to count.

Each loop has an **iteration policy**, the context decision that makes loops safe or dangerous:

- `same-tab`: the next iteration continues the conversation. Cheapest, and the window fills; the context lens shows the ring per iteration.
- `compact-when-full`: the same, but when the ring passes the threshold (default 70%) the tab is compacted before the next iteration (the agents that have `/compact`), and the divider is recorded as it is today.
- `fresh-with-summary`: a new tab each iteration, seeded with the run ledger (below) and the chosen context sections, the way a fork carries history. Costly in tokens, immune to drift.

### Personas: who a step is

A step's "who" has two parts. The **loadout** is the agent and model. The **persona** is the role the step plays, named once and reused across flows: `persona = "qa-engineer"`. It is a property of a `turn`, `review` or `decide` step, never a step kind, and it bundles things the app already has separately:

| Part of a persona | What it is today | In a persona |
| --- | --- | --- |
| Instructions | Standing instructions and "Teach agents Foreman", appended to the system prompt for every agent kind. | The persona's body text, appended the same way, receipted as a `ContextPart` ("persona: qa-engineer 1.4k") and part of the fingerprint. |
| What it may do | Read-only (plan mode or sandbox), tool approvals, repo MCP servers, integrations. | Defaults for the step: `read_only`, the MCP servers and integrations it gets, and `writes`: the only paths its turn may edit (`[docs/features/**]`), with no shell, enforced by Foreman on Claude turns and refused on other agents. A persona can only narrow what the repository and its consents allow, never widen. |
| What it is shown | The edge's `context = […]`. | A default `shows` list the step inherits and may add to: the designer gets before-and-after screens (`npm run screens` already captures them), QA gets the diff and check results, the architect gets the task and the tree. |
| What it produces | The step kind's facts. | The same facts; `ends_with` names the ones the persona is expected to produce, so a QA step that ends without findings or `done` reads as `undecided`, not as clean. |
| Who runs it | A loadout. | A default loadout the step can override, so "QA on Sonnet" and "QA on Fable" are one persona, two steps. |

A persona is a markdown file with frontmatter, the shape Claude Code already uses for its subagents in `.claude/agents/*.md`, under `.foreman/personas/` (shared, read-only in the app, like repo templates) or personal. A repository's existing `.claude/agents` files are offered as personas for Claude steps as they are, with their `name`, `model` and `tools` read and the rest left alone.

```md
---
name: qa-engineer
loadout: 3                 # Sonnet 5.5 by default; a step may override
read_only: true
shows: [diff, checks.results]
ends_with: [review, done]
---
You are the QA engineer on this change. You don't fix; you find. Read the diff and the check
results, run the tests that cover the changed files, and report what a reviewer would want to
know, with file and line, through `foreman review`. Say `done` only when you found nothing.
```

Ten personas ship as starters, each a few lines. The first four: **architect** (read-only, plan mode, shown the task and the tree, ends with a plan at a gate), **developer** (edits, shown the plan and the checks, ends with `done`), **qa-engineer** (above), **designer** (read-only, shown before-and-after screens, ends with findings). Six more came with the starter flows that use them: **product-manager** (decides whether and what to build, never how; writes only `docs/features/**`), **ux-designer** (turns requirements into a design specification; writes only `docs/features/**`), **security-reviewer** (read-only, reports through `foreman review`), **docs-writer** (writes only `docs/**`, never code or CHANGELOG.md), **researcher** (writes a report under `docs/research/**` and revises it in place) and **research-reviewer** (read-only, reviews a report alone). The starter flow "Research then implement" uses the first four:

```toml
[steps.plan]
kind = "turn"
persona = "architect"
loadout = 2                      # Fable 5.1 here; the persona's default elsewhere

[steps.plan-check]
kind = "gate"
show = ["plan.answer"]

[steps.implement]
kind = "turn"
persona = "developer"
context = ["plan.answer"]

[steps.qa]
kind = "review"
persona = "qa-engineer"

[steps.design]
kind = "review"
persona = "designer"
```

How a persona shows up in the graph: the Run lens labels the node with it ("qa · qa-engineer · Sonnet 5.5"), the Context lens receipts its instructions as one more part and shows its `shows` as edges, and the Memory lens shows which persona read or wrote which memory file, so a developer persona that keeps rewriting CLAUDE.md is visible. A chat tab run by a persona carries it on the flow chip. Changing a persona's file changes the fingerprint of every flow that uses it, which pauses them and asks again, naming the persona.

Two rules keep this honest. A persona's worth is its constraints and inputs, not its title: "you are a senior architect" in a prompt changes little, while "cannot edit files, is shown the tree and the task, must end at a gate" changes the run. So the editor presents a persona as those settings with the instructions beneath, not as a name with a prompt, and a step may override a persona's loadout and add to its `shows`, but may not loosen its `read_only` or add servers beyond the repository's consents. And a persona is human-owned, like the note: no run writes to it. The assistant drafts personas the way it drafts flows, when a sentence names a role ("a QA engineer that only finds"), through the same Run card.

### Where a flow lives, and reusing it

A flow is written once and run as often as wanted. A repository flow is a file under `.foreman/flows/`, committed and shared like a repo template; a personal flow is kept with personal templates and asks for the repository when started. Every run is a record under its flow, so the Automations page lists a flow with its runs, and a run names the workspaces it made. Copying a repository flow to personal, or exporting a personal one to a file, is the same document either way. A flow drafted from a lineage or by the assistant records where it came from (`made_from`: the workspace and date, or the assistant thread), so a flow's own provenance is kept alongside each run's.

### Building one without writing a file

Most people shouldn't start from TOML. Graphs with loops are hard to write and easy to get wrong, so the design gives four ways in, in the order most people will use them:

1. **Starters.** Flows ship built in, next to the default templates: Fix until green, Research then implement (with a gate between), Test first then make it pass, Issue to draft pull request, Second opinion then pick, Two reviewers must agree, Keep a long-lived branch fresh, Flaky test triage, Document what changed, Is this feature worth building?, and From an idea to a feature. Starting from one and changing a step is the ordinary path.
2. **Ask the assistant.** "Fable researches, Opus implements, Sonnet writes the PR text, and ask me before implementing" becomes a draft flow the assistant proposes, shown in the outline editor with its diagram, saved only when the user says so. The assistant drafts through the same Run card it uses for every mutation; it never saves or runs a flow on its own.
3. **Make a flow from this.** On any workspace's Lineage panel, a chain of work done by hand becomes a draft (see "Recovering graphs from what happened").
4. **The outline editor.** For adjusting any of the above. It starts as a plain list of steps joined by "then"; a step grows a branch only when a fact is chosen for it, and a loop appears only when an edge points backwards. Most flows are a line with one loop, and the editor should look like that until it isn't.

The TOML stays the source of truth because it diffs, reviews and ships with the repository, but it is what the editor writes, not what people are asked to type.

## Four graphs over one flow

The file above is the run graph. The other three are drawn from the same steps and from records Foreman keeps for every turn, flow or not.

### Run graph

Nodes are steps; edges are the facts that choose the next. In a run, each node carries its state (`waiting`, `running`, `completed`, `failed`, `needs-you`, `stopped`, `skipped`) and its turn, so a node opens the tab or check run it stands for. Loops draw as a ring around their steps with the iteration count and the bound.

### Context graph

Nodes are steps and the **context sources**: the task, each step's answer, the diff (stat or patch), the workspace note, review comments, check results, review findings, attachments, the run ledger. Edges say which sources each step is shown, in the file's `context = […]`. The run fills in what was really sent: the step's first message already carries `ContextPart` receipts (`shared/context.ts`), so a run's context graph is receipts, not intentions. The lens shows, per step: the ring (`ContextUsage`) at the end of the turn with its breakdown when the agent gives one, and for a loop, the ring per iteration as a sparkline so the user sees the window filling.

Two rules come from this lens. A flow is refused at approval when a step is shown a section that doesn't exist yet in the graph's order (a reviewer shown `address.answer` before `address` can run). And hand-off hashing holds: a section is captured when the edge fires and recorded with its hash, so "what did the reviewer see?" has one answer.

### Memory graph

Nodes are the things that outlive a step: the **run ledger**, the workspace note, the agent's memory files, the repository's standing instructions, and agent reports. Edges are reads and writes.

- The **run ledger** is new: a short record Foreman keeps per flow run in `foreman.db` (one row per step and iteration: what it was shown, how it ended, the agent's reports, the delta). An iteration with `fresh-with-summary` is shown the ledger as a `ContextPart` and the receipt says so. Steps read it; only Foreman writes it. It is the loop's memory, and it is where "we tried this twice already" comes from instead of from a window that was compacted away.
- The **workspace note** (`WorkspaceNote`, human-owned, revisioned) is read by steps that include it; a flow can't write it. The lens shows which revision each step saw.
- **Agent memory files** (CLAUDE.md, auto-memory, the files `ContextUsage.breakdown.memoryFiles` names) are read by every Claude turn and written by whichever turn's delta touches them. The lens draws a write edge from a step whose `TurnDelta` includes a memory path, so a loop that keeps rewriting its own instructions is visible. This is the one place an agent's memory crosses runs, and it lives in the repository or the user's home, never in Foreman: the lens reads it, doesn't manage it.
- **Reports** are the agent's writes to Foreman: a `done` or `stuck` report is both a fact for an edge and a memory node the next iteration is shown.

Foreman writes nothing into the repository for memory: the ledger stays in `foreman.db`, as reports do, and it is not in a Git backup or an export unless the export already carries the chats it summarises.

### Data graph

Nodes are **trees and their homes**: the base branch, each step's start and end checkpoints (`refs/switchyard-checkpoints/<session>-<turn>-start|end`), the workspaces (worktrees or sandboxes) the flow made, the pull request, and the data a step waits on (CI results, review comments, a Linear issue from intake, a Langfuse trace when a step's context names one). Edges: a step starts from a tree and ends on one; a `workspace` step branches a tree; `checks` and `review` read a tree; `wait` reads the PR.

The lens answers the question the other automations can't: *which tree did this step act on, and is it the one the next step reads?* Auto review already guards one case (findings go stale when the tree moves); here it is general. A step whose declared input tree differs from the tree at its start (because another tab or the user changed files meanwhile) is marked, the way a sensitive-file alert is, and the edge's fact is `moved` so a flow can choose to re-run checks rather than trust them.

Separate workspaces share nothing uncommitted. A flow that fans out into sibling workspaces and then wants one of them continues in that workspace; it never merges. That stays with the user and the Git panel.

## Running a flow

A **flow run** is a record like an `Occurrence`: written and flushed before anything launches, with the flow's fingerprint, its inputs, and one entry per step and iteration. It is kept with the workspace(s) it made and listed under the flow. After a crash, in-flight steps are `uncertain` and never retried, exactly as scheduled runs are.

Starting: from the Automations page, a template-like dialog that shows what the approval covers (the same `ScheduleSummary` shape: template texts and revisions, setup, checks, MCP servers, integrations, plus the flow file's revision) and asks for the inputs; from New workspace, where **Start with** offers a flow beside a message, a template and an issue or PR link, with the flow's inputs, its graph and the approval shown before Create; from `foreman flow run <name> [--input k=v] [--wait]`; from the assistant through its Run card; or from a workspace agent through delegation, under the repository's existing opt-in, which lists flows in `list_delegation_options` and adds `start_flow` and `get_flow_status` with the same scope rules as `start_task`. A flow can also be scheduled: a schedule's target becomes a template *or a flow*, and the schedule's fingerprint includes the flow.

Caps: a flow run counts as one against the schedule service's app-wide cap of two unattended runs, and its turns queue behind "Maximum agents running at once" like any others. Budgets per step come from the step kinds (auto review's ten minutes, the fix turn's twenty); the flow adds only the loop bounds.

Where it shows: Home's rows get the flow run as the thing that needs you (one row per run, naming the step waiting), the sidebar groups the run's workspaces as Compare siblings are grouped today, and the chat tab a step runs in carries a chip naming the flow, step and iteration, as a scheduled tab says it is unattended. The run's page is the graph, with the lens switch. Across runs, the flow's page counts how often each edge was taken and marks the ones never taken, with time and cost per run, so a flow can be audited and trimmed without reading every run.

Stopping: Stop on the run cancels the current turn and marks the run `stopped`; a step that stopped for a human keeps the run at `needs-you` with the request in Needs you; answering resumes it. Pausing a flow (the user, two failed runs in a row, or a changed fingerprint) follows schedules.

## Showing a graph

Foreman's catalogue has no canvas and this page doesn't ask for one. A graph here is small (a dozen nodes), its edges are labelled with facts, and it has to work with a keyboard and a screen reader. So:

- **The graph is edited as an outline and a form.** A `Tree` of steps, each a `Card` with the step's fields (`Field`, `Select`, `RadioCards` for the kind, a numeric `TextInput` for bounds: the catalogue's `Stepper` is read-only progress, which fits a run's iterations, not a bound being edited), the edge table as `Segmented` choices per fact, and loops as a `Disclosure` that lists the steps it spans. This is the same shape as the schedule and auto-review dialogs, and it is what the TOML round-trips to; the file is the source of truth for a repository flow and the outline is read-only for it (as repo templates are), with "Copy to personal" to edit.
- **The graph is shown as a diagram.** The renderer already turns Mermaid into themed SVG (`components/MermaidBlock.tsx`, `mermaidRender.ts`) for chat; the same renderer draws the flow from the outline, read-only, with a `Segmented` lens switch: **Run · Context · Memory · Data**. Node colour is never the only signal: state is a `Glyph` and a label; loops are a labelled ring; a moved tree is a marked edge with words. The diagram is a picture of the outline, so everything in it is reachable in the outline.
- **A step in the diagram opens what it stands for**: the tab, the check run, the review, the workspace, through the same navigation the sidebar uses.

Four lenses, one outline, one diagram renderer: no new component. If the outline turns out to need a shared piece (a node card with ports, say), it goes through the design-system rule as its own PR first.

## Recovering graphs from what happened

Every lens is drawn from records that exist for every workspace, flow or not: `forkedFrom`, `compareId`, `scheduled`, `MessageOrigin`, `ContextPart` receipts, `ContextUsage`, `TurnDelta`, checkpoints, reports, `prInfo`, note revisions. So a workspace view gets a **Lineage** panel showing the same four lenses for work done by hand: which chat was forked or handed off from which, what each was shown, which memory files each turn touched, which trees each turn moved between. Most of this is reconstruction, not new recording; the gaps are listed below.

"Make a flow from this" turns a lineage into a flow file: each turn a `turn` step with the template it used, each check run a `checks` step, each hand-off a `review` or `turn` step with the context sections the receipt names, the loop drawn where the same tab was sent the check results more than once. The result is a draft the user edits before approval, not something that runs.

## Switching it on

Flows are off by default and switched on per computer in **Settings → Experimental → Flows**, the way the Home board was (#21). Off means nothing of this exists in the app: no Flows section on Automations, no Flow choice in New workspace, no Lineage tab, no flow rows on Home, no `start_flow` in the delegation tools, no flow target in the Schedule dialog, and the `foreman flow` commands answer "Flows are off; turn them on in Settings → Experimental". Repository flow files are ignored while it is off, so a repo that ships flows adds nothing to a colleague's app until they choose it. Turning it off while a run is in progress stops that run as the user would (`stopped`, with the reason), never silently. The switch is an app setting, not a repo one: a repository can't turn it on for someone.

## Policy

- A flow's run approval covers everything the schedule's does and the flow file. Any change pauses the flow and asks again, naming the changed parts.
- Steps keep their services' consent: check commands, repo MCP servers, the auto-review exclusions, the repository opt-in before an agent starts a flow. A flow file alone grants nothing.
- Unattended turns are Claude only, as schedules are, until another agent can be held to auto mode with approvals denied: a flow with a `turn` step on another agent is refused, and the dialog says which. A `review` or `decide` step, read-only by construction, may run on Codex: it runs in Codex's read-only sandbox and attended, so an approval it asks for waits in Needs you (the run waits with it, counting no loop minutes) instead of being denied, and the dialog lists those steps before approval.
- A persona's `writes` is enforced by Foreman, not its prompt: a refused write or shell is a message the agent reads and carries on from, never an approval that stops the run. Only Claude turns can be held to it.
- An agent's reply, report text and findings are data: the flow branches on their *kind*, never on their words, and they are shown to the next step as untrusted text, as delegation already labels them.
- Foreman writes the ledger to `foreman.db`, never into the repository; a flow can't write the note or memory files, and the memory lens shows when an agent did.
- Flows don't cross computers or repositories. A flow started on a controlled computer runs there.

## What isn't recorded yet

The lenses are only as good as the records. These were the gaps an implementation closed first, each small and useful on its own. All of them are recorded now (slice 7 in Status); the table stays as the history of what older workspaces lack, and the Lineage tab's Gaps callout names the ones a workspace's history is missing.

| Gap | Before | Recorded since |
| --- | --- | --- |
| Hand-off provenance | The new session didn't say which session and sections it came from; the dialog hashed them but the result kept nothing. | `Session.handedOffFrom: { sessionId, kind, turnId, sections, hashes, at }`, written by `HandOffService.start`. |
| Delegation provenance | A workspace started by `start_task` didn't record the coordinating chat. | `Workspace.startedBy: { sessionId, turnId, via }` from the delegation scope (`delegation`), a turn's `foreman new`/`run` (`cli`) or the assistant's thread (`assistant`); `send_task` and a turn's `foreman send` set the queued message's `origin`. |
| Message origin kinds | `MessageOrigin` was auto-fix only. | A union: `auto-fix`, `delegation`, `flow` (run, step, iteration), `schedule`, `limit-resume`, each set where Foreman sends the message. Findings sent with "Send to worker…" have no kind yet. |
| Context usage history | `Session.contextUsage` was the latest only. | `usage` on the `turn-end` item: the window as each turn ended. |
| Memory writes | `TurnDelta.files` had the paths; nothing marked memory paths. | A shared `isMemoryPath` (CLAUDE.md, `.claude/`, AGENTS.md, the paths the agent's breakdown names), and `memoryWrites` on the `turn-end` item. |
| Tree identity per step | Auto review hashed the tree it read; turns recorded checkpoint refs. | `tree: { start, end }` on the `turn-end` item beside `delta`: the 12-character tree hashes of the turn's checkpoints. |
| Check run attribution | A check run knew its workspace, not what started it. | `WorkspaceChecks.startedBy: 'user' \| 'auto' \| { flowRun, step } \| 'cli'`, set by each caller of `ChecksService.start`. |

## Phases

1. **Records.** Close the gaps above, with tests on the main services that write them. Nothing visible yet except richer receipts.
2. **Lineage.** The four lenses on a workspace, read-only, from existing and new records, with the Mermaid renderer. This proves the lenses before any flow exists, and it is useful alone.
3. **Flow files and runs.** The Experimental switch first, so everything below hides behind it. Then the schema, the loader beside repository settings, the `FlowService` built on `ScheduleService`'s rules (`Occurrence`-style records, caps, fingerprints, needs-you, uncertain after a crash), `turn`, `checks`, `script`, `review`, `decide`, `workspace` and `gate` steps, loops with bounds and the three iteration policies, personas with the four starters, the starter flows, the Automations page with the outline editor and the run page, `foreman flow` commands, and Home and sidebar rows.
4. **Entry points.** Schedules that target a flow; the assistant drafting and starting flows through its Run card; delegation's `start_flow` and `get_flow_status`; `wait` and `pick` steps.
5. **Recovery.** "Make a flow from this" on the lineage panel.

Each phase ships behind nothing: a flow is an opt-in file, and the lineage panel reads what is already there.

## Prior art

- **Graph engineering (Neo4j).** Zachary Blumenfeld's AI Engineer conference talk "Make Your AI Agents Predictable With Graph Engineering" names three graphs: execution graphs (the runtime's routers and agents), context graphs (decision traces linked to the domain's data), and procedural graphs (a skill compiled into steps, many of them scripts and decision models rather than agents). The talk's demo compiles successful but inconsistent runs into a graph-shaped skill, routes with code instead of the agent, and reports that the same task then runs correctly on a smaller model in a fraction of the time. This page's Context, Memory and Data lenses are its context graph; "Make a flow from this" is its compilation from traces; `script` and `decide` are its procedural steps. What this page doesn't take: a graph database as a knowledge layer between the app and its data. Foreman is a local app with one SQLite file and the repository, and the graphs here are small enough to be rows and refs.
- **Runtime graph frameworks (LangGraph, ADK and the like).** Graphs that live inside the agent process as code. The portability argument against them holds here too: a flow is a file beside the repository, run by Foreman's services, readable without the runtime.
- **Claude Code's subagents and skills.** Persona-like files with frontmatter under `.claude/agents/`, and skills as markdown with scripts. The persona format in "Personas: who a step is" is the same shape, and a skill is the natural thing for a `turn` step to invoke.

## Open questions

- **Name.** "Flow" is used here; "automation" already means the page that holds schedules, auto-fix and auto-review, and this belongs on it. "Run" and "plan" are taken.
- **Where personal flows live.** `state.json` beside personal templates is the smallest change; `foreman.db` is where run records go. The file format is the same either way.
- **Compaction as a step.** `compact-when-full` relies on an agent's own `/compact`; agents without it fall back to `fresh-with-summary`, and the dialog should say which the chosen loadout gets.
- **Cost bound.** `result` items carry `costUsd` for Claude; other agents don't report it, so a cost bound applies only where it is known, and the dialog says so.
- **Persona memory.** Should a persona carry its own memory across runs (a QA persona's running list of flaky tests)? The ledger could hold it per persona, but then a run writes to something a persona reads, which the "human-owned" rule forbids today. Also open: whether two steps with the same persona in sibling workspaces are one node or two.
- **Opening a pull request.** Closed: the `pr` step opens one with no agent, pushing as the Git panel does, under the repository's account, after the flow's gate. Still open: whether it should commit for the flow rather than leave that to a turn.
- **A gate's reach.** Should a gate be able to hold *other* work in the workspace (the user chatting in the same tab while a flow waits), or only the flow? The design says only the flow: the workspace stays yours.
- **Decision record.** Once built, "Graphs are edited as an outline and shown as a diagram, not drawn on a canvas" and "A flow branches on a fact's kind, never on an agent's words" meet the bar in [decisions.md](decisions.md).
