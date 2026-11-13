# AI employees

An AI employee is a standing member of an organization: it has a name, a role, a hard hat in its own colour, instructions, memory and access to some of the organization's repositories, and it does work when a person asks, on a schedule or when another employee hands it a task. Each piece of work is a task; each attempt at it is a run, which is an ordinary Foreman workspace and session. Organizations are new too: a space you create on purpose, with its own memory repository. Everything you have today stays in **Personal**, unchanged.

This is the design. It is built behind **Settings → Experimental → AI employees**, off by default (section 13). The research behind it (four reference projects studied independently by two models, with two review rounds) and the mocks the decisions were made from are kept outside the repository; where they disagree with this document, this document wins.

## 1. What stays the same

- **Personal is today's Foreman.** Every repository you have, and every one you add, starts in Personal. Nothing changes for anyone who never creates an organization: no switcher, no new sidebar section, no new files.
- **A run is a workspace and a session.** Employees run on Foreman's existing drivers, agent slots, worktrees, receipts, checkpoints and consent dialogs. There is no second runtime, no daemon, no terminal automation, and no conversation kept alive between runs.
- **Unattended means Claude, and nobody answers for you.** An unattended turn runs only on an agent whose capability record has `features.unattended` (Claude today), any approval it asks for is denied and the turn stops (`src/main/sessions.ts`, `denyUnattended`), and no employee answers another's approval, gate or consent.
- **Code repositories stay clean.** Foreman writes nothing into a code repository. Everything Foreman keeps for an organization lives in that organization's memory repository.
- **Personas, flows, schedules, delegation and the Assistant keep working as they do.** Employees build on them (section 11); none of them changes meaning.

## 2. Words

| Word | Meaning |
| --- | --- |
| **Space** | Where a repository belongs. Every repository belongs to exactly one space. |
| **Personal** | The space that always exists. It needs no setup and has no memory repository unless you give it one. |
| **Organization** | A space you create, for example "Foreman" or "XYZ", with a name and, once you choose one, a memory repository. |
| **Memory repository** | A private git repository dedicated to one organization (for example `foreman-memory`). It holds the organization's memory, each employee's memory and definition, and Foreman's files for repositories that shouldn't carry them. It is never shared between organizations. |
| **Employee** | An AI worker that belongs to one organization: identity, hat, instructions, access, triggers, limits and memory. |
| **Task** | A piece of accepted work with an owner and a contract. It outlives its runs. |
| **Run** | One attempt at a task: a workspace and a session. |
| **Delivery** | One message or task on its way to one employee, with its own state. |

The interface says "employee" and "memory repository". "Bot" appears only in file and code names where a short word helps (`bots/`, `BotService`).

## 3. Spaces and repositories

**One space per repository.** A repository is in Personal or in exactly one organization. Moving it changes three things and nothing else: which list shows it, which employees may be given access to it, and where its Foreman files may be kept. Its workspaces and chats move with it. Nothing in the repository changes.

**Creating an organization** is one dialog: a name; a memory repository (create a new one, named `<organization>-memory` by default, private, in a folder you pick; use an existing repository; or decide later); and which repositories to bring from Personal. "Decide later" makes an organization that only groups repositories: employees and memory need a memory repository. A repository already used as another organization's memory repository is not offered, and the list says why.

**The space switcher** appears in the sidebar header once a second space exists, listing each space with its repository and employee counts, plus "Create an organization…" and "Manage spaces…". Home can show one space or all of them.

**Where a repository's Foreman files live** is a per-repository choice, shown in Repository settings:

1. **In the repository**: `.foreman/` is committed and shared with everyone who clones it (today's behaviour, the default).
2. **In the repository, private to this computer**: `.foreman/` stays in the folder, listed in `.git/info/exclude`.
3. **In the organization's memory repository**: nothing is added to the repository; its files live in `<memory>/repos/<name>/`. For a fork you contribute upstream, or a client's repository.

Layering, first wins: this computer's settings, then the private or memory-repository files, then the repository's committed `.foreman/`, then user settings, then defaults. A client's committed `.foreman/` still applies under your own. The agents' own files (`AGENTS.md`, `CLAUDE.md`, `.claude/agents`, `.mcp.json`) are not Foreman's and never move.

**A cloned organization starts inert.** Definitions travel with the memory repository; approvals never do. On another computer nothing runs until a person approves the organization and each employee there.

## 4. The memory repository

```
<organization>-memory/            (one per organization; Foreman's memory service is its only automatic writer)
  README.md
  memory/
    org/
      PROJECT.md                  pinned: what the organization is, its goals, preferences, accepted decisions
      decisions.md                append-only, one dated entry per decision
      instructions.md             the organization's shared instructions for every employee (layer 1 of 3)
      docs/*.md                   research and notes, one topic per file
      data/*.json|csv|toml        structured records
    bots/<id>/
      MEMORY.md                   pinned: the employee's own facts and preferences
      journal.md                  append-only: one entry per run
      RECAP.md                    the last run's recap, read first by the next run
      *.md, data/*                the employee's working knowledge
  bots/<id>.toml                  employee definitions (section 5)
  repos/<name>/                   Foreman files for repositories that chose option 3 in section 3
  .foreman-memory.json            schema version; written by Foreman only
```

**One writer.** Foreman's memory service owns the repository's folder: it is not a workspace and never appears in the sidebar's workspace list. Employees write only through tools (`remember`, `memory_append`, `memory_write` with compare-and-set on the version they read, `memory_checkpoint`). Writes are staged per run and committed when the run ends, parks or checkpoints, one commit per run with `Foreman-Employee`, `Foreman-Run` and `Foreman-Task` trailers, so `git log`, `blame` and `diff` answer who learned what, when and why. Git and the database are not one transaction: the service records the intent, commits against the expected head, then finalises, and reconciles unfinished intents on start.

**Foreign changes are proposals.** Before each commit the service checks that the head is its own last commit and the folder is clean. A commit it didn't make (a collaborator's push, an employee that edited files through a shell, your own edit in another tool) stops its commits until you accept or revert it. You edit memory by hand in the Memory view, which writes through the same service with you as author.

**Reading never loads everything.** A run gets: the organization's `PROJECT.md` and its own `MEMORY.md` and `RECAP.md`, each cut to a budget and framed as data, not instructions, receipted as a context part with path and commit; `memory_search` over a full-text index of the repository (bm25, at most 10 results, a disposable cache in `foreman.db`); `memory_read` of a path; and the inputs its task names, each at a commit. The run records the commit it started from.

**Reads are organization-wide.** Every employee of an organization can read all of its memory, including other employees' folders. Separation (requirement: logical separation of organization and employee memory) holds for writes, which the service enforces by path: an employee writes its own `memory/bots/<id>/` and, if granted, `memory/org/docs/` and `memory/org/data/`. `PROJECT.md`, `decisions.md` and `instructions.md` are proposal-only for employees: a change waits in Needs you. So are `bots/` and `repos/`, and `memory/org/docs/` and `memory/org/data/` when the definition doesn't grant them; another employee's folder, and anything else, is refused. A run that wears a read-only persona proposes even its own folder's changes. A proposal is kept as the person's commit (`Foreman-Proposed-By`, `Foreman-Kept-By: person`) or retired, in Needs you or the Memory view. Enforced read privacy would need a separate repository per scope and is not offered; the interface says reads are shared.

**Ordering.** A task or message that names a memory path with staged writes commits those writes first and carries the commit, so a recipient never starts before its input exists.

**Recaps.** If a run ends without the employee writing its journal entry and recap, the service writes them from the run record. The next run reads `RECAP.md` first.

**Secrets and deletion.** Writes are checked against the repository's sensitive paths and scanned for secret-shaped values, and refused with a reason. Removing a memory has three meanings and the interface says which: removed from what employees read (a commit); removed from history (a Foreman action that rewrites the memory repository, with a warning that pushed copies and model providers keep what they saw); never from an employee.

**Pushing** the memory repository is a setting, off by default. The service only fast-forwards. One computer is an organization's executor; another computer can read until you hand execution over to it explicitly.

## 5. Employees

### 5.1 The definition

`bots/<id>.toml` in the memory repository. The **id** is stable and never shown as a name: renaming the employee, changing its hat or moving it to another model changes no path, no history and no task.

```toml
id = "e-7k2m"                     # stable; memory lives under memory/bots/e-7k2m/
name = "Max"
role = "Marketing"
description = "Launch posts, release notes and the changelog email, from what ships."
look = { family = "hardhat", colour = "orange" }
personality = "Casual, data-driven: short sentences, numbers over adjectives, no hype."
responsibilities = [
  "Write launch posts and release notes from what merges in foreman and foreman-website",
  "Draft the changelog email; I approve every send",
]
ask_me_about = "Release notes, launch copy, the changelog"   # what bot_list shows other employees
instructions = """…the full prompt Generate drafted, sections: Role, What you do, How you write, What you never do, How you finish…"""
persona = "docs-writer"           # optional; a persona it wears, applied narrowing-only as in flows
model = { agent = "claude", model = "claude-sonnet-5-5", effort = "medium", fallbacks = ["claude-haiku-5-5"] }
attendance = "unattended"         # or "attended": read-only, may use Codex, waits for a person on approvals

[access]
repos = { "foreman" = "read", "foreman-website" = "write" }
memory_write = ["org/docs"]       # its own folder is always writable unless read-only
profile = "no-shell"              # or "shell": may use a shell and these tools with no hold
mcp = []                          # MCP servers it keeps; every other one is disabled
delegate_to = ["e-3fq9"]          # employees it may hand tasks to
actions = { "slack-post" = "held", "newsletter" = "held", "publish" = "never" }

[[triggers]]                      # section 8
id = "t-4hq2"                     # optional; the Edit view gives each new trigger one, so edits keep its history here
kind = "cron"                     # or "interval" (every = "90m", optional anchor = "2026-11-16T09:00"), or "schedule"
cron = "0 9 * * 1"                #   (recurrence once|hourly|daily|weekly|monthly, start_date, time, weekdays, day_of_month)
timezone = "Europe/London"
prompt = "Draft the week's update" # default: work through your responsibilities and report
repo = "foreman-website"          # default: its first repository with Write, else its first with Read
missed = "skip"                   # or "run-once"
overlap = "skip"                  # or "queue", "coalesce"
enabled = true

[[triggers]]                      # section 8
kind = "event"
source = "pull-request"           # or "base-moved", "memory" (paths = ["memory/org/docs/**"]), "linear" (on = ["assigned"], team, label)
on = ["merged"]                   # merged, ci-failed, review-requested, changes-requested, approved
repo = "foreman"                  # the repository it watches and works in
branch = "release/*"              # optional; authored_by = "anyone" | "employees" | "people" too
debounce = 60                     # seconds: events within it become one run
overlap = "skip"
enabled = true

[limits]
runs_per_day = 6
minutes_per_run = 30
cost_per_day_usd = 5              # a threshold, not a hard cap (section 9)
```

Authoritative operating policy lives here and nowhere else. Memory is data; it never raises authority.

### 5.2 Instructions come in three layers

1. The organization's shared instructions (`memory/org/instructions.md`).
2. The employee's prompt (`instructions`, plus the persona it wears, narrowed as in flows).
3. The task.

Before all three, every employee prompt carries Foreman's fixed rules, short and the same for everyone: never destroy an environment you didn't make, never publish, post, send or pay without the authorization your definition grants, never put secrets in memory, messages or tasks, say plainly when you are blocked, and finish every task with a reason (section 6.2). The broker enforces these too; the model is also told.

### 5.3 Creating one

One page, opened from the Team section's "+" or "New employee":

1. **Describe your employee**, in a sentence or two.
2. **Personality**, optional: toggle chips (Concise, Casual, Formal, Friendly, Direct, Data-driven, Playful, Thorough, Other…). Left empty, Generate picks one from the description.
3. **Hat**, optional: twelve colours; colours already worn in this organization are dimmed with the wearer's name. Left empty, Generate picks a colour nobody wears.
4. **Generate with AI** or **Save as is**. Generate is one request to the person's default agent (the Assistant's locked-down profile: no shell, no files), sending the description, the personality and the organization's repository names, and returns a draft: name, role, description, responsibilities, the full prompt, a personality line. Save as is uses your words as the instructions. With privacy mode on, only Save as is is offered.
5. **The draft** is text you read and edit in place, with **Refine** ("Ask for changes…", Regenerate, Undo).
6. **What it can do** starts at the safest settings whatever the description says: reads the organization's repositories, keeps its own notes and proposes shared changes, no shell, messages to other people wait for you, runs only when asked. **Suggested** lists what the draft thinks it needs (write access to a repository, a schedule, an event trigger), each **switched off** until you turn it on. The AI drafts; it never grants.
7. **Create** saves `bots/<id>.toml` (one commit) and creates `memory/bots/<id>/`; the employee is a **draft**. **Create and approve** also approves it on this computer.

**Approving shows the plan first:** the model and fallbacks, repositories and access, the execution profile, outward actions and whether they're held, triggers, limits, what Foreman will write (only the memory repository), and **what this approval does not cover** (for example: a new trigger, a widened access, a different model, any outward action not listed). Approval records the definition's fingerprint on this computer; a changed definition pauses the employee with "changed since approval" and a diff until approved again.

The step-by-step form survives as the employee's **Edit** view, for precise changes.

### 5.4 The hat

Every employee wears the Foreman hard hat in its colour (`ui/HardHat`, twelve colours, an ink outline and no disc behind it, so it reads on light and dark). One colour per employee within an organization; a thirteenth employee repeats a colour, since the name is always shown beside the hat. Colour identifies; it never shows state. The hat doesn't change when the model does, and an employee card shows the model as text, never a second agent icon beside the hat.

## 6. Tasks and runs

### 6.1 Task first

Every piece of employee work is a task before it is a run. "Talk to Max", "Ask Max to…", Run now, a schedule firing, an event and another employee's hand-off all create a task record first, then a run. A continuation never asks again what the person already said.

### 6.2 Ownership and closure

A task always has an owner and is in one of: open, running, waiting (on a person, a reply, a dependency), or closed. **Closing needs a reason**: `done`, `handed-off` (with the new owner), `blocked` (on what), `declined`, `canceled`, `escalated` (to whom), `superseded`, `no-follow-on`. "Done" never means "waiting". A run closes its task with `finish_task`: `done` closes it done, `partial` and `blocked` close it blocked on what is left (so it can be retried), `declined` closes it declined; `report_no_update` closes it with no follow-on. A run that ends with its task still running gets a synthetic partial result ("ended without a result", closed blocked), never done. A **parked task names what wakes it** (an answer, a result, a date, a dependency) and **who owns recovery** if that wake fails. Every transition is logged.

### 6.3 What a run is

A workspace and one or more turns in one session: a fresh worktree per run by default (archived afterwards by auto-archive, like a scheduled run), or a persistent `home` worktree per employee for scratch files. Either way **each run starts a fresh conversation** seeded with the three instruction layers, pinned memory, the recap and the task; durable memory, not chat history, is what survives. The session carries an unattended mark for the employee's run, so deny-and-stop, limit resume and receipts work as they do for schedules and flows. A run with nothing to report ends with `report_no_update`: no notification.

### 6.4 Asking the person

`ask_person { question, options? }` is offered to every run. It records the question in Needs you (and the phone, and Slack's "needs me" event), parks the task as waiting on a person, ends the turn cleanly and releases the employee's lane. **One answer per question**: the answer becomes the task's continuation and starts a new run, with each question and its answer first in its message. Retry isn't offered for a task that waits on a question; Cancel withdraws the question. A question is not a permission: answers never approve a tool, and no employee answers a permission.

### 6.5 Receipts and states

A delivery moves through **saved → delivered → started → completed**, each recorded; a started session is never shown as done. An employee's state on the Team page is a state (draft, idle, running, paused) and, separately, a **count and a reason** ("Needs you · approve the send"). When Foreman doesn't know an employee's state it says unknown, never idle.

### 6.6 Pause, stop and recovery

**Pause** holds accepted work: queued tasks and continuations wait with the hold "paused" and run on Resume (budgets and usage limits hold work the same way, never fail it: section 9); only scheduled firings that come due while paused follow the missed-run rule. **Stop now** cancels the running turn. Discarding queued work is an explicit Cancel.

**Crash recovery is honest.** A run whose turn was never handed to the driver is retried with the same task identity. A run whose turn started becomes **uncertain**, and its task waits in Needs you with "Foreman closed while this ran; retry or cancel". Foreman never silently replaces an interrupted run with a fresh one. The same rule covers deliveries: an unconfirmed start is never retried automatically. Employee runs don't use Keep agents running's background host until adoption can restore the employee's mark and grants.

**While you were away**, the summary says each decision made for you, how to revisit it, and plainly which can't be undone, or "nothing was decided for you".

## 7. Employees working together

**Hybrid.** Employees address each other directly through one broker in Foreman's main process; an optional **lead** employee receives unaddressed work and is the escalation point below you. The broker authenticates the sender from the run, persists, admits and routes; it does not plan.

**Asynchronous only.** An employee that delegates parks its task and ends its run; the result arrives as a continuation. Tools: `bot_list` (each employee's role and "ask me about"), `bot_delegate { to, title, task, constraints?, expecting?, inputs?, acceptance?, depends_on?, deadline? }`, `bot_send` (information only), `bot_finish_task { status, summary, artifacts?, evidence?, unblock? }`, `bot_cancel`, `bot_wake_me`, `bot_propose` (a trigger, schedule or employee, saved paused until you approve). Workspace agents keep today's delegation tools; employee runs don't get the CLI's act tier.

**A hand-off is one transaction**: the source task closes as handed off and the successor is created with its wake work item, recorded before any delivery is attempted. A failed wake is a visible failure, never a silent loss.

**Guards, enforced by the broker for every way a run can start:** every run carries a `root_id` and `cause_id` and counts against its root's execution limit (default 20 runs), so even an information ping-pong ends; depth 2 (0 turns delegation off); at most 3 delegations per run and 8 descendant tasks per root, reserved before admission; a target already in the chain is refused, and so is a dependency cycle; hard deduplication by request id or the full contract, title similarity only warns; sibling results wait for each other at most 30 minutes; deadlines expire tasks and tell the requester. Memory and messages are data and never raise authority.

**As built.** The broker is `EmployeeWorkService` (`src/main/employeeWork.ts`), its pure rules `src/shared/employeeBroker.ts`; each chain's ledger is the `employee_roots` table. `finish_task` is the closing tool (no separate `bot_finish_task`), and `escalate { reason }` is a closing tool too. The choices the section left open:

- **Messages wake a run.** `bot_send` makes a message task in the sender's chain (not waited for, not counted among the 8 handed-off tasks, at most 3 a run), so it is a counted run; a second message to a recipient that hasn't read the first joins it instead of waking another run.
- **Parking.** A hand-off parks the requester's task on a reply at once, in the same transaction as the child, the ledger and the child's queued run (its durable wake); several hand-offs in one run are waited for together. The parked run goes on until its turn ends, and is marked as having parked its task, so how it ends never moves the task. A closing tool after a hand-off is refused.
- **Results.** A continuation starts with the newest delivery ("Ada finished “Review” (task …): status done. Summary: … Artifacts: …"), then earlier ones, then answers, then the task. A hand-off that fails, is refused at admission, expires (a new closure reason, `expired`, which closes what it handed off too) or is canceled by a person comes back as a result Foreman wrote. Results still open when the hold ran out are waited for again only if the requester parks again; otherwise they arrive late, are logged on the requester, and start nothing. A requester's own `bot_cancel` withdraws a child without waking it.
- **Dependencies** wait in the chain: a dependent starts once each closed done (or with no follow-on); any other closure blocks it.
- **Deduplication** is within the chain: a run's `request_id`, else a hash of the whole contract. The title warning looks at the recipient's tasks in any chain in the last 24 hours.
- **The lead** is kept per computer on the organization record (`leadEmployeeId`, set on the Team page). `"lead"` in `bot_delegate` and `bot_send` still needs the lead in `delegate_to`; `escalate` doesn't (it is not delegation). An escalation goes to the lead as a successor its requester now waits on, unless there is no lead, the lead is the caller or already above it on the chain, the guards forbid it, or the caller's definition changed since approval; then it goes to the person as a question.
- **`bot_wake_me`** parks the task on a date (or, after a hand-off in the same run, wakes it at that date even if results are missing); between a minute and 7 days ahead, at most 5 waiting per employee.
- **`bot_propose`** files a memory proposal for a new version of the employee's own `bots/<id>.toml` (a trigger, a `delegate_to` change) or a new `bots/<id>.toml` at the safest settings, checked as the file would be. Keeping it is a person's commit, so the definition is "changed since approval" (or a new draft) until approved.
- **Limits** are organization-wide defaults (`workLimits` beside the organization record in `state.json`, no setting yet); a person raises one spent chain's runs by 10 with Raise limit in Needs you (admin scope, never from a turn), or cancels the chain.

## 8. Schedules and events

**Schedules** are declarative and owned by Foreman, never re-armed by an employee. They are the definition's `[[triggers]]` (section 5.1), so they travel with the memory repository and are part of the fingerprint: adding, changing or turning one off in the definition needs approving again, and the approval plan lists each in words. Three kinds: cron (five fields with lists, ranges, steps and names, in an IANA time zone; `src/shared/cron.ts`), intervals ("every 90m" from an anchor, by default midnight on 1 January 2000 in its zone) and today's recurrences (once, hourly, daily, weekly, monthly). No trigger fires more often than every 15 minutes. On the zone's wall clock, a local time daylight saving skips fires once at the first minute after the gap, and one it repeats fires once, the first time.

They fire on the schedule clock, not a second timer: `ScheduleService`'s tick drives them as a source (`src/main/employeeTriggers.ts`), with the same 5-minute grace and the same pause while Foreman quits. A trigger's next time is worked out on each computer from now, the first time it is seen, whenever its timing changes and when it is turned on again; nothing is backfilled. A time missed by more than the grace is skipped, or, with `missed = "run-once"`, every missed time collapses into one run. A firing makes a task from `schedule` with a stable request id (employee, trigger, planned minute), so a firing again after a crash finds its task instead of making another; the task goes through admission like any. A draft's, a changed one's, a retired one's or an invalid one's triggers don't fire, and the firing is recorded with why. A paused employee's firing follows the missed rule (section 6.6): skipped, or with `run-once` held as one task that runs on Resume. While the trigger's last task is still open, running or waiting, overlap decides: skip (default), queue (one more waits behind it, never two) or coalesce (one waits, and each later firing replaces what it asks). Each trigger's next time, its last ten firings and whether it is turned off on this computer are kept in `state.json` (`employeeTriggers`); the Triggers tab's switch turns one off here without touching the definition (narrowing only, so no approval). Automations lists employee triggers with the schedules, with the hat and name, read-only.

**Events**: pull request events from the PR watch, the base branch moving, a Linear assignment (needs new polling), memory changes and finished tasks. Each event-started run carries its cause; `self` (an echo of the organization's own change) and `chain` (at most 3 event runs per item per 10 minutes) throttle, and the root limit terminates.

**As built: event triggers.** The service is `EmployeeEventService` (`src/main/employeeEvents.ts`), its pure rules `src/shared/employeeEvents.ts`; the trigger itself is in `src/shared/employeeTriggers.ts`. The choices the section left open:

- **The definition.** `[[triggers]] kind = "event"` with `source` (`pull-request`, `base-moved`, `memory`, `linear`), checked as strictly as the timed kinds and part of the fingerprint. `pull-request` takes `on` (one or more of `merged`, `ci-failed`, `review-requested`, `changes-requested`, `approved`), `repo` (required: it watches that repository and works in it), an optional `branch` glob on the head branch and `authored_by` (`anyone`, `employees`, `people`). `base-moved` takes `repo`. `memory` takes `paths`, globs inside the memory repository. `linear` takes `on = ["assigned"]` (the default) and optional `team` (key or name) and `label`. All take `prompt`, `repo` (where it works, for memory and Linear), `overlap`, `enabled` and `debounce` (seconds, 0 to 3600, default 60). An event trigger has no `missed`. Globs match from the start of the branch or path (`release/*` is never `x/release/1`). Finished tasks are not an event source: hand-offs already return results (section 7).
- **Watching.** Only enabled triggers of approved, unchanged employees (paused ones too, to record their skips) are watched for. Pull requests: each watched repository's open (50) and recently merged (20) pull requests are listed in its own folder (`ScmProvider.listPullRequests`: `gh pr list` as the repository's account, or GitLab's merge request list) on the PR poll's cadence, at most every 2 minutes a repository, behind the PR cache's per-account pause. GitLab's list has no pipelines or approvals, so only merges and review requests are heard there. Base-moved: each watched repository's base tip by `git ls-remote` (no fetch, nothing written), on the base watch's 5-minute cadence. Memory: the memory service tells its host of each commit it made as the branch moves (in process, immediate); commits Foreman didn't make are not events. Linear: the issues assigned to the account of the work repository's Linear connection, every 5 minutes on the schedule clock, only while a Linear trigger exists. Nothing reads a workspace, so nothing wakes a cloud workspace's sandbox.
- **What happened while Foreman was closed.** Each source's last look is kept in `state.json` (`employeeEventWatch`). The first look, or one after a day without looking, is a baseline and fires nothing. Otherwise what changed since the last look fires once, as the next look shows it: never each step between (CI that failed and passed again while Foreman was closed is nothing), never anything a stale baseline would replay. A pull request the baseline doesn't know fires only if it was made, or merged, since the last look.
- **Firing.** Each trigger keeps the identities of the events it took (pull request, head and event; base tip; memory commit; Linear issue and state), so one event is one firing whatever looks at it again. An event goes into the trigger's batch, which fires `debounce` seconds after its first event (never pushed back by later ones) as one task from `event`, through admission like any. The task asks the trigger's prompt (or its responsibilities) and carries each event's facts as JSON in a block marked untrusted, whose backticks are neutralised. Its request id is the trigger and its first event's identity, its cause `event:<identity>`. A batch waiting out its debounce is kept in `state.json` and fires after a restart. Coalesce adds the later events to the waiting task instead of replacing what it asks.
- **Guards.** Self: an event caused by the employee's own work is recorded as skipped and never batched: a pull request whose head branch an employee's push or pull request record (or run workspace) names, a base that moved to a head its push recorded, a memory commit whose `Foreman-Employee` (or `Foreman-Proposed-By`) trailer is the employee, a Linear issue it changed in the last 24 hours. Chain: at most 3 event-started tasks per item (`pr:<repo>#<n>`, `base:<repo>:<branch>`, `memory:<org>:<path>`, `linear:<issue>`) in 10 minutes across the organization; an event whose item is spent is held back, and a batch with none left is recorded as "skipped: chain guard". Cause propagation: a task started by another employee's work joins that work's chain (its root, with no parent: nobody waits for it), so its runs count against that chain's limit and a loop of employees answering each other's events ends there, held in Needs you; a cause whose chain was canceled is skipped. A paused employee's events are recorded as skipped, never held for Resume.
- **Linear connections.** Only the work repository's own Linear connection, as it resolves now; a missing or broken one, or one whose key is gone, is recorded on the trigger once per reason ("skipped: …") and checked again when a batch fires, never replaced by another account.
- **In the window.** The Edit view's trigger dialog has the Event kind (source, event checkboxes, repository, branch, whose pull requests, memory paths, team and label, debounce, prompt, with the guards in words); the Triggers tab and the approval plan say each in words ("When a pull request merges in site · last: fired for #42, 10:31"). Automations lists timed triggers only. The New employee page's event suggestions say to add one in Edit.

## 9. Permissions and safety

Effective authority is the **intersection** of the organization's approval on this computer, the employee's approved definition, the trigger, the caller's ceiling, the task's allocation and any persona's narrowing, checked at admission and again at every brokered call; a new approval revision reaches queued work at admission and running work at its next brokered call.

| Dimension | How |
| --- | --- |
| Repositories | None, Read or Write per repository. Read runs read-only (Claude plan mode or Codex's read-only sandbox); Write runs with scoped writes in its own branch. Offered only where the agent's capability record enforces it |
| Execution profile | **No shell** (default): scoped writes, which remove the shell, and Foreman-brokered tools only. **Shell**: approved with the plain statement that its shell and tools act with no hold |
| MCP | Only listed servers; every other one, including `.mcp.json` and user servers, is disabled for the run |
| Outward actions | **Brokered** routes (bridged Slack and Linear, Foreman's own push and pull requests) are recorded before sending and held for Send or Skip unless the definition allows that class. **Unbrokered** routes (a shell, `gh`, an unbridged MCP server, a browser tool) can't be held: they need the explicit "no hold" approval, or they're removed |
| Protected paths | `.claude/`, `.codex/`, `.cursor/`, `.foreman/`, `.switchyard/`, `.mcp.json`, `.git/` and the git common directory are denied for every employee run, with a reason the model reads (a refusal, not an approval that would end the run) |
| Delegation | `delegate_to`; absence is refusal |
| Secrets | Variable names in the definition; values from the vault; never in memory, tasks, messages or run records |
| Outside agents | May read employee status and propose a task; may not start an employee's run |
| CLI | `foreman employee list|status|memory` read; `run` and `ask` act; approve, pause, retire and edit admin, never from a turn |

**Budgets.** Runs per day, minutes per run, active runs per organization and executions per root are hard limits. Cost is reported only after a turn, and not at all by Codex, so a cost limit is a threshold that pauses new work once crossed; a run in flight can overshoot, and the interface says so. A run keeps what its turns cost where the agent says (Claude Code's result does); once the runs that ended since local midnight cost the threshold or more, new work is held as over budget and runs on the next local day, or once the threshold is raised. Two failing runs in a row pause the employee for a person (`pausedKind = "failures"`, in Needs you with how the last ended): a run that failed, timed out, was stopped for an approval nobody could give, or ended without a result. A run that finished with its own result (declined too) resets the count; one a person stopped, or one Foreman closed on, counts neither way; Resume starts the count over.

**A usage limit is a hold, not a failure.** A run whose turn stops at its agent account's usage limit (read as the rest of Foreman reads one: the turn's `limit`, from Claude Code's result or rate-limit event or Codex's windows, never from the words alone) ends as `usage-limit`, counts neither way towards the two-failures pause, and its task goes back to open with the hold `usage-limit`: the same task and request id, its next attempt queued. The work service's clock (the tick that releases budget holds) admits it again once the reset time (the turn's, else the account's blocked windows in `state.limits`) and a minute have passed, or 15 minutes on when no time is known (and every 15 minutes while it keeps stopping there), as a fresh run with the whole brief; the cut-off turn is never resumed, so the session limit resume leaves employee runs out. New work for an account known to be at its limit (a blocked window that says when it resets, or other work already held on it) is held the same way instead of starting a run that would stop there. Employee runs use their agent's default account. The window says the hold in words ("Waiting for the usage limit to reset at 23:30") on the task, the Team card and the sidebar row; Needs you doesn't list it, since it clears itself.

**As built: held actions.** The broker is `EmployeeActionService` (`src/main/employeeActions.ts`), its pure rules `src/shared/employeeActions.ts`, its records the `employee_actions` table (the exact payload, the connection's id and name but never a secret, the state, an idempotency key over the run and payload, the result). The choices the section left open:

- **Routes.** The bridge hands an employee run's `slack_post` and every Linear tool that isn't a read to the broker after its own checks (the grant, the connection as it is now, the allowed channel); reads and every other chat's calls act as before. Push and pull request are the employee tools `request_push { commit_message? }` and `request_pull_request { title, body, base?, commit_message? }`, for a run admitted with Write access whose definition still gives it. Foreman commits what the run changed first, as the employee and without the repository's hooks, then previews the branch against the base. A pull request opens as a draft and pushes its branch, so its rule is never looser than the rule for pushes. An employee's bridged tools reach the broker without the agent's approval prompt (Claude), since the hold is the approval.
- **The rule.** `allowed` sends at once (recorded as on its way first), `held` waits in Needs you, `never` refuses with a reason the model reads and is recorded. A class the definition doesn't list is held. A refusal before anything is recorded (no Write access, a definition changed since approval, a missing or broken connection, nothing ahead of the base) records nothing. The same request twice in a run finds the first.
- **Connections.** An action is sent only as the connection it was recorded for: Slack and Linear through `IntegrationBridge.sendAction`, which refuses when the repository's connection changed, broke or lost agents' write access; push and pull request through Foreman's own push and `openPullRequest`, refused when the repository's GitHub connection (or GitLab host token) is missing or no longer the recorded one. With no connection chosen, gh's active account is Foreman's usual default and is named as such.
- **The person.** Needs you shows the exact preview with Send, Edit then send (text fields only: Slack's text, a pull request's title and body, a Linear change's title, description or body) and Skip; sending and skipping are admin-tier API calls, never from a turn. An action is marked on its way before the service is asked, so a double Send sends once; one Foreman closed on becomes uncertain on start and waits for "It arrived" or "It didn't arrive: send again". A failed one can be sent again. Canceling a task skips its held actions.
- **The employee is told.** Each state change is on the task's log (`action-held`, `action-approved`, `action-sent`, `action-skipped`…) and the chain view lists the task's actions. An outcome reached while the task waits (or is about to run again) is kept on the task and starts its next continuation, once; otherwise the log has it. A held push or pull request keeps its run's workspace until it is sent or skipped.
- **Decided for you.** The Team page lists what went out without asking in the last 24 hours (sent under `allowed`), each with how to revisit it (open it, change the employee's rule) and plainly whether it can be undone (a Slack message, a push and a pull request can't; a Linear change can be changed back), or says nothing was decided for you.

**Codex employees** are offered only as attended and read-only until Codex's capability record earns unattended runs, and only after a test proves the `foreman-app` bridge works inside Codex's sandbox (its default workspace sandbox may block the connection).

## 10. Where it lives in the app

- **Sidebar**: the space switcher in the header (once a second space exists); for an organization, a **Team** section (each employee's hat, name, role, state glyph and word, current task or reason) above Repositories (memory repository first, tagged "memory") and Workspaces. A workspace started by an employee shows its hat and task.
- **Team page**: a card per employee answering five things: what it's responsible for, what it's doing or waiting for, how much work is queued, whether it needs you and what your answer unblocks, and its last result. Model, usage and recovery details are on its own page.
- **Employee page**: overview (responsibilities, model, triggers, memory folders, approval), Tasks, Runs, Memory, Access, Triggers, with Talk to, Run now, Pause/Resume, Edit and Retire.
- **New employee page**: section 5.3.
- **Needs you, the phone and Slack**: questions, held actions, memory proposals, changed definitions and foreign memory changes.
- **Memory view**: the memory repository's folders and files, per-file history, proposals to keep or retire, conflicts.
- **Spaces page** (Manage spaces…): one column per space, its memory repository, repositories and employees; moving a repository.

Everything composes existing `ui/` components except the hard hat (`ui/HardHat`, added first, on its own). The hat picker is a grid of radio cards; personality is toggle chips; the draft is editable rows.

## 11. How it relates to what exists

| Existing | Relation |
| --- | --- |
| Persona | An employee may wear one (narrowing only). Personas keep working in flows on their own. Neither extends the other |
| Flow | A run's body may be a flow; later a flow step may hand a task to an employee and branch on its typed result |
| Schedule | Its clock fires employee triggers (cron, intervals and its own recurrences, kept in the definition) as a source, with its grace and missed rule; Automations lists them read-only |
| Workspace and session | A run is one; the employee's run mark joins the unattended union |
| Delegation tools | Unchanged for workspace agents; employees get their own tools |
| Agent reports | `ask_person` is a needs-input report attached to a task |
| Assistant | Drafts employees and tasks and proposes "Ask Max to…"; never an employee, never a required coordinator |
| `docs/ai-memory.md` | Its proposal (proposed → kept → retired facts with provenance, budgeted retrieval, receipts), placed in the memory repository |

## 12. Persistence

| What | Where |
| --- | --- |
| Organizations (name, memory repository, approval, executor), repository → space | `state.json` |
| Employee definitions | `<memory>/bots/<id>.toml` |
| Employee approvals and lifecycle (draft, active, paused, retired; failures in a row), trigger firing state (`employeeTriggers`) | `state.json` |
| Tasks, runs, messages, deliveries, work items, root ledgers, budget accounting, memory mutation intents, the memory search index | `foreman.db`, as appended migrations |
| Memory | The memory repository |
| Secrets | The vault |

## 13. Building it

The work was planned in the slices below. The hard hat (1) went in as its own pull request, as a new design-system component must; slices 2 to 8 went in together in the next one, behind the Experimental switch, because each builds on the last and none is useful to a person without the ones before it. Slice 9 isn't built.

| # | Slice | Contents |
| --- | --- | --- |
| 1 | Hard hat | `ui/HardHat` with tokens, tests, gallery and catalogue section. Its own pull request, merged first |
| 2 | Personal and organizations | The switch; organizations with a memory repository (create, use existing, later); repository → space; moving repositories; the switcher and Spaces page; where each repository's Foreman files live |
| 3 | Memory repository service | The single writer with intent, commit and finalise; foreign changes; the search index; recaps; the Memory view; memory tools for employee runs |
| 4 | Creating employees | Definitions with stable ids; the New employee page (describe, personality, hat, Generate, Save as is, draft, what it can do, suggestions off, Refine); approval with the plan; Team section, Team page and employee page |
| 5 | Talk to and Run now | Task first; runs as workspaces and sessions with the three layers, pinned memory and recap; access enforcement and the no-shell profile; `ask_person` and continuations; closure reasons; receipts; pause, stop and uncertain recovery; history |
| 6 | Schedules | Employee targets, cron and intervals, missed and overlap rules, limits and thresholds |
| 7 | Working together | The broker, delegation tools, transactional hand-offs, dependencies and every guard in section 7, the lead |
| 8 | Events and held actions | Event triggers with causes and guards; held brokered actions; proposals |
| 9 | Organization sandboxes | An organization's cloud defaults (provider such as E2B, its connection, size, region, idle sleep, a running limit across the organization), inherited by its repositories unless they set their own, with a missing connection refused rather than replaced by a personal one; kept in `state.json`, never in the memory repository. An employee's definition can say where it runs (this computer or a sandbox); unattended employees with a shell run in a sandbox by default, and read and write memory through tools there |

### Known gaps

What is built but not yet whole, so nobody reads more into it than is there:

- **Only Claude keeps to the definition's MCP servers.** An employee run asks every agent to load only the definition's servers and Foreman's own; Claude does (`strictMcpConfig`). Codex, which an attended employee may use, still loads the person's own MCP configuration.
- **Model fallbacks are recorded, not used.** A definition's `fallbacks` are kept and shown as not used yet; a run whose model can't answer fails as any run does.
- **GitLab sends fewer events.** Pull request events come from the PR watch, which for GitLab reports opened, merged and closed but not failed checks, approvals or requested changes, so those event triggers never fire on a GitLab repository.
- **A Linear assignment can fire again.** Assignments are read from the newest 50 assigned issues; an issue that drops out of them and comes back is seen as newly assigned.

## 14. Open questions

- The full brief stopped partway through its trigger list; event sources beyond section 8 are assumptions.
- Whether personal employees (in Personal, with a personal memory repository) are wanted at all.
- Whether a thirteenth colour should repeat or the palette grow.
- Retention for tasks, runs and messages (90 days?), which like chats stay out of backup and export.
- Whether an employee may propose edits to its own definition, the way it proposes organization facts.
