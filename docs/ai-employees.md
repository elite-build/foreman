# AI employees

An AI employee is a standing member of an organization: it has a name, a role, a hard hat in its own colour, instructions, memory and access to some of the organization's repositories, and it does work when a person asks, on a schedule or when another employee hands it a task. Each piece of work is a task; each attempt at it is a run, which is an ordinary Foreman workspace and session. Organizations are new too: a space you create on purpose, with its own memory repository. Everything you have today stays in **Personal**, unchanged.

This is the design. It started behind an Experimental switch and is now part of Foreman for everyone: until a person makes an organization, nothing about it shows except the **Personal ▾** switcher (section 3). The research behind it (four reference projects studied independently by two models, with two review rounds) and the mocks the decisions were made from are kept outside the repository; where they disagree with this document, this document wins.

## 1. What stays the same

- **Personal is today's Foreman.** Every repository you have, and every one you add, starts in Personal. Nothing changes for anyone who never creates an organization beyond the Personal tile at the top of the sidebar's rail, with New organization… under it (section 3): no new sidebar mode, no new files.
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

**Creating an organization** is one dialog: a name, and which repositories to bring from Personal. Its memory repository is never shown: what Foreman keeps for an organization is not for browsing on the left. Foreman makes it unasked, `<organization>-memory` (or `-2`, `-3`… when that folder is taken), private to this computer; the dialog names neither it nor its folder. Organizations made before this that "decided later" only group repositories; **Settings → Spaces** offers them **Set up memory**, made the same way. The API still takes a named folder or an existing repository (`OrganizationMemory`), refusing one that is another organization's memory repository, but the window no longer offers either.

**The spaces** are always at the top of the sidebar's rail, Personal first, each a tile with its name; the one shown is selected and every other says ▲ and how much waits in it. + under them makes an organization, and an organization's tile has Manage spaces… on right-click; none names or opens a memory repository. An organization's tile shows its icon (picked in Settings → Spaces, as a repository's is), else the icon of its repository of the same name (an organization called foreman takes the foreman repository's), else its initial. Home can show one space or all of them.

**New organization…** (in the switcher, the Add repository menu and **Settings → Spaces**) asks for a name, and which of Personal's repositories to bring, with the one the sidebar shows already ticked. Its memory repository is made beside the other repositories without a word about it. **Keep its repositories in one folder** gives the organization a folder of its own (`<clone location>/<name>`, or `<name>-org` when a registered repository already is that folder): its memory repository is made there, and while the organization is showing, Clone and Quick start start there and what they make joins the organization rather than Personal. Repositories brought in stay where they are on disk, and Personal's clone location is left as it was. A folder that is a Git repository, or inside one, is refused.

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
  bots/<id>.md                    each employee's own prompt (section 5.2)
  repos/<name>/                   Foreman files for repositories that chose option 3 in section 3
  wiki/                           the organization's wiki: people, each repository's reports and findings, projects (section 16)
  .foreman-memory.json            schema version; written by Foreman only
```

**One writer.** Foreman's memory service owns the repository's folder: it is not a workspace and never appears on the left (not the sidebar's rail or list, a space's tile, or Settings' repository list), and New workspace never offers it (main refuses a workspace there, whoever asks). Employees write only through tools (`remember`, `memory_append`, `memory_write` with compare-and-set on the version they read, `memory_checkpoint`). Writes are staged per run and committed when the run ends, parks or checkpoints, one commit per run with `Foreman-Employee`, `Foreman-Run` and `Foreman-Task` trailers, so `git log`, `blame` and `diff` answer who learned what, when and why. Git and the database are not one transaction: the service records the intent, commits against the expected head, then finalises, and reconciles unfinished intents on start.

**Foreign changes are proposals.** Before each commit the service checks that the head is its own last commit and the folder is clean. A commit it didn't make (a collaborator's push, an employee that edited files through a shell, your own edit in another tool) stops its commits until you accept or revert it. You edit memory by hand in the Memory view, which writes through the same service with you as author.

**Reading never loads everything.** A run gets: the organization's `PROJECT.md` and its own `MEMORY.md` and `RECAP.md`, each cut to a budget and framed as data, not instructions, receipted as a context part with path and commit; `memory_search` over a full-text index of the repository (bm25, at most 10 results, a disposable cache in `foreman.db`); `memory_read` of a path; and the inputs its task names, each at a commit. The run records the commit it started from.

**Reads are organization-wide.** Every employee of an organization can read all of its memory, including other employees' folders. Separation (requirement: logical separation of organization and employee memory) holds for writes, which the service enforces by path: an employee writes its own `memory/bots/<id>/` and, if granted, `memory/org/docs/` and `memory/org/data/`. `PROJECT.md`, `decisions.md` and `instructions.md` are proposal-only for employees: a change waits in Needs you. So are `bots/` and `repos/`, and `memory/org/docs/` and `memory/org/data/` when the definition doesn't grant them; another employee's folder, and anything else, is refused. A run that wears a read-only persona proposes even its own folder's changes. A proposal is added as the person's commit (`Foreman-Proposed-By`, `Foreman-Kept-By: person`) or discarded, in Needs you or the Memory view. It carries the employee's own reason (the `why` its memory tools take, in its words), which the person reads beside it; Foreman's rule for why it is a proposal is told only to the employee. Enforced read privacy would need a separate repository per scope and is not offered; the interface says reads are shared.

**Ordering.** A task or message that names a memory path with staged writes commits those writes first and carries the commit, so a recipient never starts before its input exists.

**Recaps.** If a run ends without the employee writing its journal entry and recap, the service writes them from the run record. The next run reads `RECAP.md` first.

**Secrets and deletion.** Writes are checked against the repository's sensitive paths and scanned for secret-shaped values, and refused with a reason. Removing a memory has three meanings and the interface says which: removed from what employees read (a commit); removed from history (a Foreman action that rewrites the memory repository, with a warning that pushed copies and model providers keep what they saw); never from an employee.

**Pushing** the memory repository is off until you link it: **Settings → Spaces → Link to GitHub…** makes a new private, empty GitHub repository with gh (`<organization>-memory` to start with), or takes the URL of an empty one you have (no credentials in it). Linking sets the memory repository's `origin` and pushes its branch; nothing is linked unless that first push lands, and a remote it had is put back. From then on each commit the memory service makes is pushed (`main/memoryLink.ts`), one push at a time per organization, fast-forward only: a push that fails is kept on the link with why (the Spaces card says it), and the next commit or **Push now** tries again. **Unlink** stops the pushes and removes the `origin` it set; the remote repository is left as it is. One computer is an organization's executor; another computer can read until you hand execution over to it explicitly.

## 5. Employees

### 5.1 The definition

`bots/<id>.toml` in the memory repository, with the employee's own prompt beside it in `bots/<id>.md` (section 5.2). The **id** is stable and never shown as a name: renaming the employee, changing its hat or moving it to another model changes no path, no history and no task.

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
template = "qa-engineer"          # optional; the job whose prompt it is given first (section 5.2)
persona = "docs-writer"           # optional; a persona it wears, applied narrowing-only as in flows
model = { agent = "claude", model = "claude-sonnet-5-5", effort = "medium", fallbacks = ["claude-haiku-5-5"] }
attendance = "unattended"         # or "attended": read-only, may use Codex, waits for a person on approvals

[access]
repos = { "foreman" = "read", "foreman-website" = "write" }
memory_write = ["org/docs"]       # its own folder is always writable unless read-only
profile = "shell"                 # the default, as a workspace's agent; or "no-shell": file tools only
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
```

Authoritative operating policy lives here and nowhere else. Memory is data; it never raises authority.

There is no MCP list and no `[limits]`: every run has every MCP server an agent in a workspace has, and no employee has limits (section 9). A file an earlier Foreman wrote with `mcp = [...]` or a `[limits]` table still reads; neither means anything now, and the next save leaves them out.

### 5.2 Instructions come in three layers

1. The organization's shared instructions (`memory/org/instructions.md`).
2. The employee's prompt, plus the persona it wears, narrowed as in flows.
3. The task.

**Every employee's prompt is a file of its own**, `bots/<id>.md` beside its definition, written and approved with it: a change to either pauses the employee until it is approved again. For an employee someone wrote or Generate drafted, the file is its whole prompt. For one hired from a job template, and for the program manager, the definition records the job (`template = "qa-engineer"`) and the file holds only what the organization adds. Each job's own prompt is a file in Foreman (`src/shared/employeePrompts/<job>.md`), written for that job. A run is given the job's prompt as the Foreman running it has it, then the organization's additions under `### What <organization> adds`, so every employee hired for a job improves when that job's prompt does, without asking for approval again; the approval covers the link and the additions, as it covers Foreman's own rules, and the run's receipt names the job's prompt and the version of its text. The note at the top of the file, between `<!--` and `-->`, is for whoever edits it; no run reads it (a comment anywhere else is part of the prompt). The Edit view shows the job's prompt above the field for the additions. What depends on the run (its access, a shell, what counts as a check) is Foreman's to say for each run, never a job's.

A definition from before prompts had their own kept its prompt in the TOML (`instructions`), and still reads. Whenever Foreman reads one, it writes the two files instead, which changes nothing the employee runs with, so no approval moves. Once per organization on each computer, an employee whose prompt is a job's prompt word for word, as an earlier Foreman wrote it (`src/main/earlierJobPrompts.ts` holds their hashes), is linked to that job instead, and its approval moves with it (`ownPromptFiles` in `src/main/employees.ts`). A prompt anyone edited stays the employee's own.

Before all three, every employee prompt carries Foreman's fixed rules, short and the same for everyone: never destroy an environment you didn't make, never publish, post, send or pay without the authorization your definition grants, never put secrets in memory, messages or tasks, say plainly when you are blocked, and finish every task with a reason (section 6.2). The broker enforces these too; the model is also told.

### 5.3 Creating one

One page, opened from the Team section's "+" or "New employee". A switch under its title, **How to add**, offers two ways and opens on the first; switching only hides the other way, so what was entered in each stays while the page is open.

**Pick a job** (the default) adds one of the fifteen job templates (section 15, "Starting templates") ready to work, with New organization's chips, hover cards and **Compare jobs…**, choosing one at a time: choosing another replaces it, choosing it again clears it. A job someone in the organization already does (a non-retired employee whose role is the job's Staff role) says so in words, "· you have Quinn" on its chip and "You already have Quinn" on its hover card and card, and can still be picked. **Who you get** shows the employee as it will be saved: its hat, name, role, what it does and its access, with the reason when the name or hat isn't the template's own. A name already taken (by anyone, retired employees and Priya included) becomes "<name> (<job>)", then "<name> (<job>) 2", 3 and so on; a hat already worn by an employee who isn't retired gives way to the first free colour (section 5.4). Beside **Add** the page says what it approves, naming Write and the repositories ("Adding approves Theo at once: Write on api and web. Theo pushes and opens pull requests without waiting for you."), or that there is no repository to read yet. **Add** makes the employee in one commit, as **Create** does, and approves it at once with the template's own access, recording its fingerprint (`addTemplateEmployee`, `EmployeeService.addTemplate`): there is no draft and nothing to edit first, because the template is fixed and the sentence beside Add is the plan. Main decides the name, hat and id at Add from the roster as it is then, by the same rule the page previews (`templateDefinitions`), and the toast says the name it got. If approving fails, the employee stays a draft and its page opens, where Approve is. Nothing is sent to a model, so Pick a job works with privacy mode on. "None of these fits? **Write your own**" is always in sight.

**Write your own** is the way below, unchanged:

1. **Describe your employee**, in a sentence or two.
2. **Personality**, optional: toggle chips (Concise, Casual, Formal, Friendly, Direct, Data-driven, Playful, Thorough, Other…). Left empty, Generate picks one from the description.
3. **Hat**, optional: twelve colours; colours already worn in this organization are dimmed with the wearer's name. Left empty, Generate picks a colour nobody wears.
4. **Generate with AI** or **Use my words**. Generate is one request to the person's default agent (the Assistant's locked-down profile: no shell, no files), sending the description, the personality and the organization's repository names, and returns a draft: name, role, description, responsibilities, the full prompt, a personality line. Use my words makes the draft from your words, as its instructions (nothing is saved until **Create**). With privacy mode on, only Use my words is offered.
5. **The draft** is text you read and edit in place, with **Refine** ("Ask for changes…", Regenerate, Undo).
6. **What it can do** starts at the same settings for every employee, whatever the description says: writes the organization's repositories and pushes and opens pull requests without asking (an attended employee reads them instead, since it runs read-only), keeps its own notes and proposes shared changes, a shell (Edit turns it off), every MCP server, Slack and Linear wait for you, runs only when asked, with no limits. **Suggested** lists what the draft thinks it needs (write access to a repository, a schedule, an event trigger), each **switched off** until you turn it on. The AI drafts; it never grants.
7. **Create** saves `bots/<id>.toml` and its prompt `bots/<id>.md` (one commit) and creates `memory/bots/<id>/`; the employee is a **draft**, and its page opens.

**Employees made before every one had a shell.** Once per organization on each computer, Foreman gives the employees it already had what a new one has (`withFullAccess` in `src/shared/employees.ts`): Write where they read (attended ones keep Read), a shell, pushes and pull requests allowed, and each file written without the MCP list and limits nothing reads any more, in one commit by the person. An approval of the file as it was moves to the file as it is, since nothing else changed; the file as it was is the one the approval recorded (its blob), since its fingerprint was taken over the MCP list and limits and can't be taken again. Retired employees are left alone (`FULL_ACCESS_MIGRATION`, `employees-shell`, in `src/main/employees.ts`; its earlier version, `employees-full-access`, gave Write and pushes). Turning the shell off afterwards is the person's choice in Edit, and stays.

**A draft's page is its plan.** A draft can't run, so where its page would offer Ask it says what the employee may do once approved, in plain words and only what is true for its definition (`planGroups` in `src/shared/employeeDecisions.ts`): **Can** (read or change which repositories, keep its own notes, write the shared folders it is granted, use a shell and every MCP server an agent in a workspace has, with no hold, hand work to whom, send what its definition allows without asking), **Can't** (a read-only employee can't change any repository, push or open pull requests; no shell, once it is turned off; no hand-offs; what it may never send) and **Asks you first** (changes to shared memory always, and each outward route that is held). Then when it runs (its triggers in words, whether anyone watches), its model and effort on one line, what it is told, and **what this approval does not cover** (for example: a new trigger, a widened access, a different model, any outward action not listed). **Approve <name>** is the page header's main button: it approves at once, with no extra confirm step, and records the definition's fingerprint on this computer. A changed definition (after an edit here, or one that arrived through the memory repository) pauses the employee; its page shows the same plan, first saying "Changed since you approved it on <date>" with each difference old → new, a widening tagged "Wider" in words, and the exact lines one click away, until it is approved again.

The step-by-step form survives as the employee's **Edit** view, for precise changes.

### 5.4 The hat

Every employee wears the Foreman hard hat in its colour (`ui/HardHat`, twelve colours, an ink outline and no disc behind it, so it reads on light and dark). One colour per employee within an organization; a thirteenth employee repeats a colour, since the name is always shown beside the hat. Colour identifies; it never shows state. The hat doesn't change when the model does, and an employee card shows the model as text, never a second agent icon beside the hat.

## 6. Tasks and runs

### 6.1 Task first

Every piece of employee work is a task before it is a run. "Talk to Max", "Ask Max to…", Run now, a schedule firing, an event and another employee's hand-off all create a task record first, then a run. A continuation never asks again what the person already said.

### 6.2 Ownership and closure

A task always has an owner and is in one of: open, running, waiting (on a person, a reply, a dependency), or closed. **Closing needs a reason**: `done`, `handed-off` (with the new owner), `blocked` (on what), `declined`, `canceled`, `escalated` (to whom), `superseded`, `no-follow-on`. "Done" never means "waiting". A run closes its task with `finish_task`: `done` closes it done, `partial` and `blocked` close it blocked on what is left (so it can be retried), `declined` closes it declined; `report_no_update` closes it with no follow-on. A run that ends with its task still running gets a synthetic partial result ("ended without a result", closed blocked), never done. A **parked task names what wakes it** (an answer, a result, a date, a dependency) and **who owns recovery** if that wake fails. Every transition is logged.

### 6.3 What a run is

A workspace and one or more turns in one session: a fresh worktree per run by default (archived afterwards by auto-archive, like a scheduled run), or a persistent `home` worktree per employee for scratch files. Either way **each run starts a fresh conversation** seeded with the three instruction layers, pinned memory, the recap and the task; durable memory, not chat history, is what survives. The session carries an unattended mark for the employee's run, so limit resume and receipts work as they do for schedules and flows; an unattended employee's turn never asks (section 9), so nothing it does waits for an approval. An employee runs as many tasks at once as it is given, each in its own run and workspace. A run with nothing to report ends with `report_no_update`: no notification.

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

**Guards, enforced by the broker for every way a run can start:** every run carries a `root_id` and `cause_id` and counts against its root's execution limit (default 20 runs), so even an information ping-pong ends; that is the one limit on a chain (section 9: no depth, no count of hand-offs or messages a run, no count of tasks a chain); a target already in the chain is refused, and so is a dependency cycle; hard deduplication by request id or the full contract, title similarity only warns; sibling results wait for each other at most 30 minutes; deadlines expire tasks and tell the requester. Memory and messages are data and never raise authority.

**As built.** The broker is `EmployeeWorkService` (`src/main/employeeWork.ts`), its pure rules `src/shared/employeeBroker.ts`; each chain's ledger is the `employee_roots` table. `finish_task` is the closing tool (no separate `bot_finish_task`), and `escalate { reason }` is a closing tool too. The choices the section left open:

- **Messages wake a run.** `bot_send` makes a message task in the sender's chain (not waited for, not counted as a handed-off task), so it is a counted run; a second message to a recipient that hasn't read the first (it is still held, at a usage limit say) joins it instead of waking another run.
- **Parking.** A hand-off parks the requester's task on a reply at once, in the same transaction as the child, the ledger and the child's queued run (its durable wake); several hand-offs in one run are waited for together. The parked run goes on until its turn ends, and is marked as having parked its task, so how it ends never moves the task. A closing tool after a hand-off is refused.
- **Results.** A continuation starts with the newest delivery ("Ada finished “Review” (task …): status done. Summary: … Artifacts: …"), then earlier ones, then answers, then the task. A hand-off that fails, is refused at admission, expires (a new closure reason, `expired`, which closes what it handed off too) or is canceled by a person comes back as a result Foreman wrote. Results still open when the hold ran out are waited for again only if the requester parks again; otherwise they arrive late, are logged on the requester, and start nothing. A requester's own `bot_cancel` withdraws a child without waking it.
- **Dependencies** wait in the chain: a dependent starts once each closed done (or with no follow-on); any other closure blocks it.
- **Deduplication** is within the chain: a run's `request_id`, else a hash of the whole contract. The title warning looks at the recipient's tasks in any chain in the last 24 hours.
- **The lead** is kept per computer on the organization record (`leadEmployeeId`, set on the Team page). `"lead"` in `bot_delegate` and `bot_send` still needs the lead in `delegate_to`; `escalate` doesn't (it is not delegation). An escalation goes to the lead as a successor its requester now waits on, unless there is no lead, the lead is the caller or already above it on the chain, the guards forbid it, or the caller's definition changed since approval; then it goes to the person as a question.
- **`bot_wake_me`** parks the task on a date (or, after a hand-off in the same run, wakes it at that date even if results are missing); between a minute and 7 days ahead, at most 5 waiting per employee.
- **`bot_propose`** files a memory proposal for a new version of the employee's own `bots/<id>.toml` (a trigger, a `delegate_to` change) or a new `bots/<id>.toml` at the safest settings, checked as the file would be. Keeping it is a person's commit, so the definition is "changed since approval" (or a new draft) until approved.
- **The chain's runs** are an organization-wide default (`workLimits.runs` beside the organization record in `state.json`, no setting yet; an older file's `depth`, `delegationsPerRun` and `descendants` are dropped); a person raises one spent chain's runs by 10 with Raise limit in Needs you (admin scope, never from a turn), or cancels the chain.

## 8. Schedules and events

**Schedules** are declarative and owned by Foreman, never re-armed by an employee. They are the definition's `[[triggers]]` (section 5.1), so they travel with the memory repository and are part of the fingerprint: adding, changing or turning one off in the definition needs approving again, and the approval plan lists each in words. Three kinds: cron (five fields with lists, ranges, steps and names, in an IANA time zone; `src/shared/cron.ts`), intervals ("every 90m" from an anchor, by default midnight on 1 January 2000 in its zone) and today's recurrences (once, hourly, daily, weekly, monthly). A trigger may fire as often as its timing says, every minute included (section 9: no limits). On the zone's wall clock, a local time daylight saving skips fires once at the first minute after the gap, and one it repeats fires once, the first time.

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
| Repositories | None, Read or Write per repository. Read runs read-only (Claude plan mode or Codex's read-only sandbox); Write runs in its own branch, as a workspace's agent with a shell, or with scoped writes without one. Offered only where the agent's capability record enforces it |
| Execution profile | **Shell** (default): what an agent in a workspace has, approved with the plain statement that its shell and tools act with no hold. **No shell**, once the person turns it off: scoped writes over the workspace, which remove the shell |
| Approval mode | An unattended run never asks (Never ask, Claude's bypass mode), as a workspace's agent by default; an attended one runs in auto mode and a person answers what it asks |
| MCP | Every server an agent in a workspace has: the person's own, the repository's `.mcp.json` and approved servers, and the integrations' bridges (a persona it wears may keep fewer). Foreman's own `foreman-app` server offers the employee's tools rather than the workspace agents' |
| Outward actions | **Brokered** routes (bridged Slack and Linear, Foreman's own `request_push` and `request_pull_request`) are recorded before sending and held for Send or Skip unless the definition allows that class. **Unbrokered** routes (a shell's `git push` and `gh`, an unbridged MCP server, a browser tool) can't be held: with a shell an employee pushes and opens pull requests itself, as a workspace's agent does; Foreman's rules still tell it never to post or send another way round a hold |
| Paths | None refused: a run may write anything in its workspace, agent and git configuration (`.claude/`, `.mcp.json`, `.git/`) included, as a workspace's agent may. The memory repository is the exception: only Foreman's memory service writes it, so its own folder and the shared folders it is granted, and proposals for the rest |
| Delegation | `delegate_to`; absence is refusal |
| Secrets | Variable names in the definition; values from the vault; never in memory, tasks, messages or run records |
| Outside agents | May read employee status and propose a task; may not start an employee's run |
| CLI | `foreman employee list|status|memory` read; `run` and `ask` act; approve, pause, retire and edit admin, never from a turn |

**No limits.** No employee has limits: no runs a day, no minutes a run, no cost threshold, no lane (an employee runs every task it is given at once, each in its own workspace) and no limit on the organization's runs; failing runs pause nothing (a person retries or cancels each). A run still keeps what its turns cost where the agent says (Claude Code's result does). What remains: a chain's runs (section 7, default 20, so employees handing work to each other end somewhere), a trigger's own overlap (section 8: a firing that queues or coalesces waits for the trigger's last task), the event guards (section 8) and an account's usage limit, which is the agent's, not Foreman's. An employee paused for failures by an earlier Foreman (`pausedKind = "failures"`) stays paused until Resume.

**A usage limit is a hold, not a failure.** A run whose turn stops at its agent account's usage limit (read as the rest of Foreman reads one: the turn's `limit`, from Claude Code's result or rate-limit event or Codex's windows, never from the words alone) ends as `usage-limit`, is not a failure, and its task goes back to open with the hold `usage-limit`: the same task and request id, its next attempt queued. The work service's clock (the tick that releases budget holds) admits it again once the reset time (the turn's, else the account's blocked windows in `state.limits`) and a minute have passed, or 15 minutes on when no time is known (and every 15 minutes while it keeps stopping there), as a fresh run with the whole brief; the cut-off turn is never resumed, so the session limit resume leaves employee runs out. New work for an account known to be at its limit (a blocked window that says when it resets, or other work already held on it) is held the same way instead of starting a run that would stop there. Employee runs use their agent's default account. The window says the hold in words ("Waiting for the usage limit to reset at 23:30") on the task, the Team card and the sidebar row; Needs you doesn't list it, since it clears itself.

**As built: held actions.** The broker is `EmployeeActionService` (`src/main/employeeActions.ts`), its pure rules `src/shared/employeeActions.ts`, its records the `employee_actions` table (the exact payload, the connection's id and name but never a secret, the state, an idempotency key over the run and payload, the result). The choices the section left open:

- **Routes.** The bridge hands an employee run's `slack_post` and every Linear tool that isn't a read to the broker after its own checks (the grant, the connection as it is now, the allowed channel); reads and every other chat's calls act as before. Push and pull request are the employee tools `request_push { commit_message? }` and `request_pull_request { title, body, base?, commit_message? }`, for a run admitted with Write access whose definition still gives it. Foreman commits what the run changed first, as the employee and without the repository's hooks, then previews the branch against the base. A pull request opens as a draft and pushes its branch, so its rule is never looser than the rule for pushes. An employee's bridged tools reach the broker without the agent's approval prompt (Claude), since the hold is the approval.
- **The rule.** `allowed` sends at once (recorded as on its way first), `held` waits in Needs you, `never` refuses with a reason the model reads and is recorded. A class the definition doesn't list is held. A refusal before anything is recorded (no Write access, a definition changed since approval, a missing or broken connection, nothing ahead of the base) records nothing. The same request twice in a run finds the first.
- **Connections.** An action is sent only as the connection it was recorded for: Slack and Linear through `IntegrationBridge.sendAction`, which refuses when the repository's connection changed, broke or lost agents' write access; push and pull request through Foreman's own push and `openPullRequest`, refused when the repository's GitHub connection (or GitLab host token) is missing or no longer the recorded one. With no connection chosen, gh's active account is Foreman's usual default and is named as such.
- **The person.** Needs you shows each as a decision card (`components/DecisionCard.tsx`): the exact preview, where it goes and as whom (a push records the repository, the remote and its URL, the account's login when Foreman knows it, the commits and the files it changes, with a way to its workspace), a line just above the buttons saying what the main button sends and that it can't be undone, and buttons named for the act, the main one last: Don't push · Push branch, Don't post · Edit, then post · Post to #launches, Don't open · Edit, then open · Open draft pull request (Edit, then … changes text fields only: Slack's text, a pull request's title and body, a Linear change's title, description or body). Nothing that leaves the computer has a keyboard shortcut. Sending and skipping are admin-tier API calls, never from a turn. An action is marked on its way before the service is asked, so a double Send sends once; one Foreman closed on becomes uncertain on start and waits for "It arrived" or "It didn't arrive: send again". A failed one can be sent again. Canceling a task skips its held actions.
- **The employee is told.** Each state change is on the task's log (`action-held`, `action-approved`, `action-sent`, `action-skipped`…) and the chain view lists the task's actions. An outcome reached while the task waits (or is about to run again) is kept on the task and starts its next continuation, once; otherwise the log has it. A held push or pull request keeps its run's workspace until it is sent or skipped.
- **Decided for you.** The Team page lists what went out without asking in the last 24 hours (sent under `allowed`), each with how to revisit it (open it, change the employee's rule) and plainly whether it can be undone (a Slack message, a push and a pull request can't; a Linear change can be changed back), or says nothing was decided for you.

**Codex employees** are offered only as attended and read-only until Codex's capability record earns unattended runs, and only after a test proves the `foreman-app` bridge works inside Codex's sandbox (its default workspace sandbox may block the connection).

## 10. Where it lives in the app

- **Sidebar**: the spaces at the top of the rail (always, Personal alone until an organization exists), then its modes: **Inbox** (everything in the space that waits on the person) and **Work** (its workspaces by repository, code repositories only: the memory repository is never on the left), and for an organization **Team** (a row per employee: hat, name, current task or reason, ▲ and a count or a turning ring, its state in words in the row's name) and **Channels** (section 15: the organization’s channel and one per project). A workspace started by an employee shows its hat and task.
- **Team page**: a column per employee, side by side (at most three to a row, one column below about 1000 px), answering five things: what it's responsible for, what it's doing or waiting for (one state in a glyph and a word: Idle, Working on "…", Needs you, Draft — review and approve), how much work is queued, what of it waits for you, as one-line decisions that open into the decision card in place, and its last result. What waits from the whole organization rather than one employee (a change to `PROJECT.md`) is a strip above the columns. Under it, **Hand-offs outside projects** draws each chain one employee handed to another outside any project, open or changed in the last day, as a map (`components/employees/HandOffMap.tsx`, `shared/handoffMap.ts`): what started it, each task to the right of the one that handed it over with its state in a glyph and a word, the result going back, each held action under the task that asked for it; selecting a task or an action opens what waits for you on it as the same one-line decision, and the section is open while anything in it waits. New employee is a secondary button. Model, usage and recovery details are on its own page.
- **Employee page**: a status header (hat, name, role and model, and "▲ Needs you: push max/launch-2.4" or "Working on …"), then what of it waits for you as decision cards, decided there, then Ask on one line, then Overview (responsibilities, model, triggers, its notes, approval), Tasks (marked ▲ while anything waits), Runs and Triggers, with Run now, Pause/Resume, Edit and Remove from team…. A draft's or changed employee's page is its plan instead of Ask (section 5.3).
- **A run's workspace**: its banner names the employee and the task; while a decision of the run waits it says "Needs you" with what (never "Done") and opens the same decision card under it, and the run's chat docks the card above its message box (F6 reaches it). Cancel task is under More. A message typed in the run's chat runs as the person: it doesn't answer the employee or send what it asked to send.
- **New employee page**: section 5.3.
- **Needs you, the phone and Slack**: questions, held actions, memory proposals, changed definitions and foreign memory changes. In the window each is one decision card (`components/DecisionCard.tsx`), the same as an agent's approval in a chat: "Needs you", who, the kind and its age; what is decided; a line saying what the main button will do; buttons named for the act with the main one last; Esc declines, Ctrl+Enter takes the alternate, Enter the main act, and nothing that leaves the computer has a key. In a list it is a one-line row that opens into the card; a row's button acts at once only when the act stays on this computer (Add to PROJECT.md), and otherwise says Answer… or Review….
- **Memory view**: the memory repository's folders and files, per-file history, proposals to add or discard, conflicts. A page (`.html`) also has **Open in browser**, which opens it from the repository's folder.
- **Spaces page** (Manage spaces…): one column per space, its memory (kept on this computer, or the remote it is pushed to with the last push or why it failed; Open memory, Link to GitHub…, Push now, Unlink, or Set up memory for an organization without one; never the memory repository's name or folder), its code repositories and employees; moving a repository.

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
| Employee definitions | `<memory>/bots/<id>.toml`, and each one's prompt in `<memory>/bots/<id>.md` |
| Employee approvals and lifecycle (draft, active, paused, retired; failures in a row), trigger firing state (`employeeTriggers`) | `state.json` |
| Tasks, runs, messages, deliveries, work items, root ledgers, budget accounting, memory mutation intents, the memory search index | `foreman.db`, as appended migrations |
| Memory | The memory repository |
| Secrets | The vault |

## 13. Building it

The work was planned in the slices below. The hard hat (1) went in as its own pull request, as a new design-system component must; slices 2 to 8 went in together in the next one, behind an Experimental switch, because each builds on the last and none is useful to a person without the ones before it. A third took the switch away, made the space switcher always there and cut New organization down to a name. Slice 9 isn't built.

| # | Slice | Contents |
| --- | --- | --- |
| 1 | Hard hat | `ui/HardHat` with tokens, tests, gallery and catalogue section. Its own pull request, merged first |
| 2 | Personal and organizations | The switch; organizations with a memory repository (create, use existing, later); repository → space; moving repositories; the switcher and Spaces page; where each repository's Foreman files live |
| 3 | Memory repository service | The single writer with intent, commit and finalise; foreign changes; the search index; recaps; the Memory view; memory tools for employee runs |
| 4 | Creating employees | Definitions with stable ids; the New employee page (describe, personality, hat, Generate, Use my words, draft, what it can do, suggestions off, Refine); approval with the plan; Team section, Team page and employee page |
| 5 | Talk to and Run now | Task first; runs as workspaces and sessions with the three layers, pinned memory and recap; access enforcement and the no-shell profile; `ask_person` and continuations; closure reasons; receipts; pause, stop and uncertain recovery; history |
| 6 | Schedules | Employee targets, cron and intervals, missed and overlap rules, limits and thresholds |
| 7 | Working together | The broker, delegation tools, transactional hand-offs, dependencies and every guard in section 7, the lead |
| 8 | Events and held actions | Event triggers with causes and guards; held brokered actions; proposals |
| 9 | Organization sandboxes | An organization's cloud defaults (provider such as E2B, its connection, size, region, idle sleep, a running limit across the organization), inherited by its repositories unless they set their own, with a missing connection refused rather than replaced by a personal one; kept in `state.json`, never in the memory repository. An employee's definition can say where it runs (this computer or a sandbox); unattended employees with a shell run in a sandbox by default, and read and write memory through tools there |

### Known gaps

What is built but not yet whole, so nobody reads more into it than is there:

- **Model fallbacks are recorded, not used.** A definition's `fallbacks` are kept and shown as not used yet; a run whose model can't answer fails as any run does.
- **GitLab sends fewer events.** Pull request events come from the PR watch, which for GitLab reports opened, merged and closed but not failed checks, approvals or requested changes, so those event triggers never fire on a GitLab repository.
- **A Linear assignment can fire again.** Assignments are read from the newest 50 assigned issues; an issue that drops out of them and comes back is seen as newly assigned.

## 14. Open questions

- The full brief stopped partway through its trigger list; event sources beyond section 8 are assumptions.
- Whether personal employees (in Personal, with a personal memory repository) are wanted at all.
- Whether a thirteenth colour should repeat or the palette grow.
- Retention for tasks, runs and messages (90 days?), which like chats stay out of backup and export.
- Whether an employee may propose edits to its own definition, the way it proposes organization facts.

## 15. Projects and the program manager

Small work is a workspace, as it always was. Mid-to-large work is a **project**, and a project starts only one way: the person tags the organization's **program manager** (`@Priya …`). She is the single entry point. She checks the work is worth doing, plans it, proposes the employees it needs, replans when something goes wrong and accepts the result; there is no chief product officer and no fixed procedure. The person is one of the team: they approve each plan and each employee it proposes, check results where a plan asks, and approve what leaves the computer. Every piece of work in a project is an ordinary employee task (sections 6 and 9 apply unchanged), in one chain per project, so a project adds no runtime of its own.

**Priya.** Every organization has exactly one program manager, made with it (`Organization.programManagerId`, also its lead, section 7) as soon as it has a memory repository: at New organization, when a memory repository is chosen later, or with **Add Priya** on the Team page or the organization's channel for an organization made before. Her definition is fixed and the same everywhere (`programManagerDefinition` in `shared/employeeTeams.ts`), so making the organization approves it: Write on its repositories with pushes and pull requests allowed, as every employee has, a shell, Slack and Linear held, no limits, on the first agent that can run unattended. She writes only the project's own files (`plan.md`, `acceptance.md`, and parts her plan gives her), changes no repository and starts no task herself: Foreman starts each part of the plan the person approved. Any number of her runs go at once, as any employee’s do (section 9: no lanes), so she plans any number of projects at once. A new organization is You and Priya, plus any **starting templates** the person picks in the same dialog; anyone else comes when a plan proposes them.

**Starting templates.** New organization offers fifteen ready Staff employees, one per common job from the section 16 catalogue (`EMPLOYEE_TEMPLATES` in `shared/employeeTemplates.ts`): software engineer (Ravi), frontend engineer (Mei), QA engineer (Quinn), security engineer (Omar), site reliability engineer (Sofia), software architect (Kenji), UX designer (Uma), web designer (Leo), product manager (Nia), data analyst (Dara), technical writer (Theo), copywriter (Ines), SEO specialist (Sam), marketing manager (Ana) and support engineer (Jonah). Under Your team, a chip per job adds that employee (pressed again, or its row unticked, takes them out); a hover card on the chip, opened by focus as well as the pointer, says what the job does, its access and what it hands back; **Compare jobs…** shows the same choice as a grid of cards, and Done returns to the form. Nothing is picked but Priya. Each one is made as a plan's proposal is (`proposedDefinition`): its job's responsibilities, linked to its job's prompt, Write on the organization's repositories for every job, pushes and pull requests allowed, a shell, Slack and Linear held, no limits, on the first agent that can run unattended. Each job's prompt is its own file (`src/shared/employeePrompts/<job>.md`, Priya's `program-manager.md`), written for that job one heading level under Foreman's `## Your instructions` and before Foreman's own `## How you finish`; what a run may do and claim (its access, a shell, a pass only from a run it saw or a record names) is Foreman's run text, so the same job prompt is true of a Write run, a Read run and a run with a shell (section 5.2). They are made in the same commit as Priya and approved with her, because the dialog names everyone Create approves; with no memory repository yet the chips aren't offered. A name already taken in an existing memory repository becomes "<name> (<job>)", then "<name> (<job>) 2", 3 and so on. Name, hat and access change later on the employee's page, which asks for approval again, as any edit does. In an organization that already exists, New employee's **Pick a job** offers the same fifteen, one at a time, approved at once (section 5.3); `EmployeeService.createApproved` makes and approves them for both.

**Channels.** The sidebar's **Channels** mode lists the organization's channel (`#frlk`) and a channel per project going or closed and not archived, each with its state and what it is doing, then **All channels**. Its **+** is how a channel is made: it opens the organization's channel with `@Priya ` in the box, because a new channel is a project she plans. In the organization's channel the message box starts with a name: `@Priya …` starts a project (her welcome says how); `@Ravi …` asks Ravi, as Ask does; a message naming nobody is refused with how to start. Under the box, **Small change? Start a workspace instead** opens New workspace. A workspace that grew can become a project: **Hand to Priya…** in its header (or More, when narrow) starts one with what the person adds, the workspace's chat as her first input and the workspace as the project's, so its branch and files carry on.

**Managing channels.** A project's channel has a ⋯ menu in the sidebar and on the Channels page, and **More** in its header. **Rename…** changes only the name shown (lowercase letters, numbers and dashes, at most 32, not another channel's or the organization's): the slug stays the project's folder in the memory repository. **Archive**, for a closed project only (also a button in its header), takes the channel off the sidebar. One closed more than two weeks ago is archived on its own unless it was restored. An archived channel opens read-only, with **Restore** and **Delete…**. **Delete…** asks first: a project still going is stopped as Stop does, then the project leaves Foreman (its record, posts, notes and what it waits on). Its files under `memory/org/projects/<slug>/` stay unless the person ticks the box, which removes them in one commit by the person. Its workspace's branch always stays, and a new project never takes a folder a deleted one left. **All channels** opens the Channels page: every channel, archived ones too, with search, a Going/Closed/Archived filter, **New channel**, and archiving or deleting several at once. The organization's own channel is listed first and can't be renamed, archived or deleted.

**Questions first.** Priya asks before she plans, every time, and assumes nothing she could ask. Her first planning task tells her to read what she can find out herself and then ask everything she would otherwise guess, with her `project_questions` tool: the goal and who it is for, scope, constraints, how it fits what exists, what done looks like and how the person will check it, priorities and risks; one to four questions for a small change, four to ten for a large project. Each question is one thing, with why she asks and options when there are a few likely answers, and she says what she understood so far. Foreman checks a round (`checkQuestions` in `shared/projects.ts`: one to ten questions, at most six options each, none asked twice, three rounds in all, none while a round waits) and records it on the project (`Project.asks`); the task then finishes and the project waits for the person (a wait of kind `questions`, a Needs you item). In the channel her post lists the questions with why she asks, and one card at the bottom takes every answer: an option or the person's own words for each, **Send answers** once each is answered (pressed before that, it goes to the first unanswered question and names every one still open), **Plan with what you have** (she then lists every assumption for the person to check), or **Stop** (`answerProject`, operate). The answers start her planning again with every question and answer so far; she may ask another round about what is still open. Foreman refuses her first plan until a round is answered or the person said to plan with what she has, refuses `project_plan` in the task that asked, and refuses `project_questions` once a plan is in effect (a replan asks with `ask_person`).

**The plan.** Priya's planning task carries the request, the organization's repositories, the roster (each employee's id, name, role, what to ask it about and whether it is approved), the questions and answers so far and the rules. She gives the plan as data with her `project_plan` tool: a summary, a size, what she understood (`understood`), what must be true for it to be done (`done_when`, each a thing the person can check), what it leaves out (`out_of_scope`), what she assumed (`assumptions`), and parts, each with an id, a title, one owner (an employee by id or name, or `new:<key>` for one she proposes), a brief, the one file it writes in the project's folder, the parts it reads and the parts it waits for, and whether the person checks its result (`gate_after`). Foreman checks it (`checkPlan` in `shared/projects.ts`) and answers what to fix: at most three parts for a small plan and eight for a large one, ids and files well-formed and unique (`plan.md` and `acceptance.md` are hers), every owner on the team and not retired, every dependency a part of the plan and no circle, at most four proposed employees, each with a new name, a part to own and only the organization's repositories; for a replan, every part that started kept with its owner; and a large plan says what she understood and when it is done, and lists no assumption while she can still ask (only after **Plan with what you have**, or once her rounds are spent; a small plan may assume, and the person checks each at the plan gate). A good plan is recorded as a version, its proposed employees are made as drafts in one commit (`proposedDefinition`: the safest settings, Write only where she asked and only when the agent can run unattended), and Foreman writes `plan.md` (what will exist, the request, what she understood, done when, out of scope, assumptions, the workflow as a Mermaid flowchart, the order the parts run in, the parts as a table, each brief, the proposed employees and the questions asked) in her run, committed when she finishes. A planning task can't finish done without a plan or a round of questions.

**The plan gate.** The plan waits for the person in the project's channel as a card: the plan drawn as its workflow (`PlanWorkflow.tsx`, the design system's Graph placed by `planWorkflow`: the request, the questions, each part with its owner and file and the person's check under it, Priya's acceptance and the final check, left to right in the order things happen, with full screen for a wide one; once the plan is in effect each part shows its state); the order in words; what she understood, done when, out of scope and her assumptions; the parts with their owners, files, order and checks; Foreman's checks; what changed since the plan before; and each proposed employee with **Review** (their page, where they are approved like any draft). **Approve plan** is refused until every owner is approved; **Send back** needs a note and starts her planning again with it; **Stop** closes the project.

**Parts.** Once a plan is in effect Foreman starts every part whose dependencies are done, at the same time, each as a task of its owner with a contract (`EmployeeTaskContract.produces`, `writes`, `inputs`): the file it must write (the one memory file it may write beyond its own folder, for the task's duration), and the files of the parts it reads and waits for, at the commits they were written in. `finish_task` refuses `done` without the file and commits it first (section 4, "Ordering"). A part closed done records its file (its latest version, who wrote it, its task and commit); with `gate_after` it waits for the person (**Approve**; **Approve with note**, whose note goes into the brief of every part that waits for it or reads it, as the option the person picked, and tells that part's owner to finish blocked rather than start when the note asks for more of the gated part; **Send back** with a note, a new round for the same owner; **Stop**) before what depends on it starts. At the plan gate and the final check a note goes only with **Send back**: Approve is held while one is written. A small project closes when its last part is done; a large one goes to Priya's **acceptance** (she reads every file and writes `acceptance.md`, deciding `accept` or `replan`) and then the person's **final check** (**Approve and close**, **Send back** with a note, which replans, or **Stop**).

**Mocks.** A part that designs or changes screens also draws them as HTML mocks, in its standard folder `memory/org/projects/<slug>/mocks/<part id>/` (`mocksFolder`): its contract grants that folder as well as its file (`writesUnder`, for the task's duration, a follow-up on the part too), and its task says how to draw them: two options for each screen or problem, each one self-contained file that opens offline (inline CSS from the product's tokens, no scripts, nothing loaded from elsewhere), with an `index.html` that links each and says which option it suggests, every one named in `finish_task`'s artifacts. The part's file records the mocks its result names (`ProjectArtifact.mocks`, `partMocks`: HTML files directly in its folder, `index.html` first, at most 24), and the parts that read it get them as inputs beside it, at the same commit. In the channel each mock is a chip under the file, at the part's end and at its gate, that opens it in the browser from the memory repository's folder, so the person picks between the options before anything is built. Priya's rules give such a part to a designer, gated, and name it in the reads of the part that builds it. The UX designer's job prompt (`employeePrompts/ux-designer.md`, Uma, section 16) draws mocks for what it proposes, in the folder its task names or in its own memory folder's `mocks/<topic>/`, so every Uma already hired draws them too; a project part's task tells any other owner where its mocks go. Nothing renders or checks a mock: it is a picture of the proposal, not the product.

**Replans.** A part that can't finish (it closes blocked or partial) wakes Priya to replan, with why and the plan's state; nothing new starts until she has. A project has three replans. A replan that keeps the size, proposes nobody and only gives the plan's owners more work (another round, a follow-on part) and keeps every check the person had **goes ahead** on its own; one that adds a person or gives someone new a part waits at the plan gate. A part she keeps that couldn't finish runs again, its next round, unless she marks it `accept_as_is` (what it did counts as done, and only the parts she adds do what is left). Out of replans, a part that can't finish waits for the person (**Try again** with an optional note, or **Stop**), as does any task of the project that closes another way (declined, canceled, escalated) or can't be made.

**One workspace.** A project's runs share one workspace: the first run's (or the workspace handed over) is recorded on the project, and every later run of it opens a new chat there (`EmployeeLaunchPlan.workspaceId`), so a tester reads the code the developer left and the pull request carries every round. It stays until the project closes, then is archived (its branch kept) once no push or pull request of its runs waits for the person there. It is the channel's, opened from its **Open workspace**: the sidebar's and Home's workspace lists leave it out, and their counts don't include it, even when a run there has just finished, unless one of its chats waits on an approval, which only that chat can give (`listsWorkspace`). What the project waits on, and what its tasks ask or hold, are its channel's too: the Channels tab counts what the projects wait on and the channel's Waiting shows them, not rows in the sidebar's Inbox (`inChannel` in `shared/needsYou.ts`). A workspace handed to Priya was the person's own and stays listed (`projectWorkspaceIds` in `shared/triage.ts`).

**Nobody disappears.** In a project's channel, `@Name …` asks anyone who worked on it a follow-up: a new task for them in the project's chain (or a new chain once it closed), reading the file they last wrote, which they may update. Anything else typed there is a note: kept in the channel, waking nobody. Any finished task elsewhere takes **Ask a follow-up** too, reading what it said and the memory it named.

**The channel.** A project's channel reads top to bottom as it happened: the request, Priya planning, each plan card, each part starting and what its owner said when it finished with its file (opening to its words) its mocks (section "Mocks" above), and a button for any other page its task named in memory (an HTML mock elsewhere, such as the employee's own folder; a folder's `index.html` stands for the pages beside it), which opens it in the person's browser, the person's decisions and notes, follow-ups and their answers, then who is at work on it now, and under that what it waits for the person on, with the questions and held actions of its employees' tasks. **Who is at work now** comes from the runs that haven't ended (`projectLive` in `shared/projects.ts`): a line per step being done (who, on what, for how long, and **Watch** to open their chat; or that it is getting its workspace ready, or queued and why), a word beside the channel's state ("Ravi working", or **Nothing running** when its stage says someone should be at it and no run is), and a turning ring on the part in the Parts list, on the channel's row in the sidebar, on the Channels page and in the organization's channel. Beside it: the parts and their states, the files, the workspace and the replans used. Once a plan is in effect its table gains a State column. The Parts card beside the channel is a list or, with **List | Map** (kept on the computer), a compact map drawn with `Graph` (`components/employees/PlanMap.tsx`, `shared/planLayout.ts`): a node per part titled by the file it writes, with its owner and state, an edge per "after", the parts the person checks as gates, owners still only proposed dim, and what a replan added, changed or took out marked in words; selecting a part takes the channel to its newest post (or the plan, before it starts) and flashes it. Each node's name carries the table's columns, so the map reads like the list. **Pause** holds it (what runs finishes, nothing new starts); **Stop** cancels what is going and closes it, keeping its files. Each thing a project waits on is a Needs you item of kind `project`, the person's own (no employee's count moves), counted on the sidebar's Channels tab and its space's tile, and on Home.

**Recovery.** Every task's request id is stable for its part and round (or planning round), and what starts next is decided from the record on every change, so a crash in between starts it once, at the next launch (`ProjectService.recover`), which also goes on from a task that closed while Foreman wasn't looking.

**As built.** `ProjectService` (`src/main/projects.ts`) owns the record (`employee_projects` in `foreman.db`, an appended migration) and moves it on, one change at a time; `submitPlan` answers `project_plan` (`shared/employeeTools.ts`, `main/employeeTools.ts`); `EmployeeWorkService.projectTask` makes each task and `askFollowUp` a follow-up; `EmployeeProjectHooks` is how the work service asks the project service about its tasks (their workspace, whether a planning task may finish, a task closing). Pure rules are in `shared/projects.ts` (checks, readiness, replans, `plan.md`, the words each task carries) and `shared/employeeTeams.ts` (the two definitions). The window: `components/employees/ProjectsSection.tsx` (Channels), `OrgChannel.tsx`, `ProjectPage.tsx` (a project's channel), `Channel.tsx` (posts and the message box), `ChannelActions.tsx` (the ⋯ menu, Rename and Delete), `ChannelsPage.tsx` (All channels), `HandToPm.tsx` and `TeamRoles.tsx` (the person's column, Add Priya). API: `startProject`, `decideProject`, `answerProject`, `pauseProject`, `stopProject`, `noteProject`, `askProjectFollowUp`, `askEmployeeFollowUp`, `renameProject`, `archiveProject` (operate), `listChannels` (read), `deleteProject` and `addProgramManager` (admin); the snapshot's `projects` (those not archived).

**Not built yet.** Projects don't run as flows (flow steps run as tabs of one flow workspace behind the Experimental switch, while employee tasks have their own admission). No checks run between parts (Priya has no shell; a builder says in its file what to run). A part's start isn't animated along its edge on the side column's map (that would be a `travel` prop on `Graph`, in `ui/` first). The message box puts a name first with a chip, not an @ list as you type. Plan gates reach the phone and Slack only as Needs you counts. Codex employees can't finish a task (section 13, Known gaps). She draws nothing of her own and chooses no model: every plan gets the one workflow chart, and every part runs on its owner's model. [project-planning.md](project-planning.md) is the design for changing both.

## 16. Job profiles, work reports and the wiki

This section is a design, not yet built. It changes three things: who an employee can be, what it hands back, and where that is kept.

### 16.1 Every employee holds a real job

An employee is hired into a job that exists among people, never one named after its first task. Asked to evaluate a UI, Generate makes a **UX designer** whose focus is interface evaluation, not a "UI evaluator": an organization asks the designer it has, as a company would, and a job everyone recognises says what the employee knows, what it is responsible for and what it hands back.

**An organization isn't always a software company.** One may be a codebase, a website, a job search kept in a repository, a book or a small business. The catalogue covers the work people actually hire for across all of them, in families, and the same rules hold everywhere: a job someone could be hired as, an anchor in an official occupation list, and the work products that job hands back.

**A closed catalogue.** `src/shared/jobProfiles.ts` lists the profiles, each anchored to an occupation in O\*NET-SOC 2019 or ESCO (the anchors are checked when the catalogue is written; a profile with no anchor isn't added). A profile has an id, a family, a title, its anchor, its standard responsibilities, the report kinds it produces (16.2), the persona it wears where a starter fits (`developer`, `qa-engineer`, `security-reviewer`, `ux-designer`, `designer`, `product-manager`, `architect`, `docs-writer`, `researcher`), and whether it suggests Write. The first catalogue:

| Family | Profile | Anchor | Produces | Suggests |
| --- | --- | --- | --- | --- |
| Engineering | Software engineer | O\*NET 15-1252 Software Developers | change, tech-plan | Write |
| | Frontend engineer | O\*NET 15-1254 Web Developers | change, tech-plan | Write |
| | Mobile engineer | O\*NET 15-1252 Software Developers | change, tech-plan | Write |
| | Software architect | O\*NET 15-1299.08 Computer Systems Engineers/Architects | tech-plan, architecture-review | Read |
| | QA engineer | O\*NET 15-1253 Software Quality Assurance Analysts and Testers | test-plan, qa-review | Read |
| | Security engineer | O\*NET 15-1212 Information Security Analysts | security-review | Read |
| | Site reliability engineer | O\*NET 15-1244 Network and Computer Systems Administrators (closest) | ops-review, change | Write |
| | Database administrator | O\*NET 15-1242 Database Administrators | ops-review, change | Write |
| Data | Data scientist | O\*NET 15-2051 Data Scientists | analysis | Read |
| | Data analyst | O\*NET 15-2051.01 Business Intelligence Analysts | analysis, dashboard-spec | Read |
| | Data engineer | O\*NET 15-1243 Database Architects (closest) | change, tech-plan | Write |
| | Machine learning engineer | O\*NET 15-1221 Computer and Information Research Scientists (closest) | change, analysis | Write |
| Design | UX designer | O\*NET 15-1255 Web and Digital Interface Designers | ux-review, design-spec | Read |
| | Web designer | O\*NET 15-1255 Web and Digital Interface Designers | site-design, change | Write |
| | UX researcher | ESCO user experience analyst | research | Read |
| | Graphic designer | O\*NET 27-1024 Graphic Designers | brand-kit, design-spec | Write |
| | Motion designer | O\*NET 27-1014 Special Effects Artists and Animators | design-spec | Write |
| | Video editor | O\*NET 27-4032 Film and Video Editors | edit-plan | Write |
| Product and delivery | Product manager | ESCO ICT product manager | requirements, roadmap | Read |
| | Program manager | O\*NET 13-1082 Project Management Specialists | plan, acceptance | Read |
| | Business analyst | O\*NET 13-1111 Management Analysts | requirements, process-review | Read |
| Writing and communications | Technical writer | O\*NET 27-3042 Technical Writers | doc | Write |
| | Copywriter | O\*NET 27-3043 Writers and Authors | copy | Write |
| | Editor | O\*NET 27-3041 Editors | edit-review | Write |
| | Public relations specialist | O\*NET 27-3031 Public Relations Specialists | comms-plan, copy | Read |
| | Translator | O\*NET 27-3091 Interpreters and Translators | translation, translation-review | Write |
| Marketing and growth | Marketing manager | O\*NET 11-2021 Marketing Managers | launch-plan, copy | Read |
| | SEO specialist | O\*NET 13-1161.01 Search Marketing Strategists | seo-audit | Read |
| | Social media manager | ESCO social media manager | content-calendar, copy | Read |
| | Market research analyst | O\*NET 13-1161 Market Research Analysts and Marketing Specialists | market-analysis | Read |
| Sales and customers | Sales engineer | O\*NET 41-9031 Sales Engineers | solution-brief | Read |
| | Support engineer | O\*NET 15-1232 Computer User Support Specialists | triage | Read |
| Careers and people | Career coach | O\*NET 21-1012 Educational, Guidance, and Career Counselors and Advisors | profile-review, career-plan | Write |
| | Recruiter | O\*NET 13-1071 Human Resources Specialists | role-shortlist, candidate-review | Read |
| | Learning and development specialist | O\*NET 13-1151 Training and Development Specialists | learning-plan | Write |
| Business and finance | Financial analyst | O\*NET 13-2051 Financial and Investment Analysts | analysis | Read |
| | Compliance specialist | O\*NET 13-1041 Compliance Officers | compliance-review | Read |

**Rules for the catalogue:**

- **Titles are the market's.** A profile's title is what job postings call the job, not the occupation list's wording ("Career coach", anchored to Career Counselors). Two profiles may share an anchor when people are hired for them separately: a UX designer and a web designer are both O\*NET 15-1255, but one reviews and specifies, and the other designs and builds a site.
- **Choose the most specific fit.** Generate and Priya pick the narrowest profile whose title fits the work, and between two that fit, the one whose report kinds match what is asked: a marketing site is a web designer's, an app's settings screen a UX designer's, a LinkedIn profile a career coach's.
- **No licensed professions.** A job that needs a licence to practise (lawyer, doctor, therapist, licensed financial adviser, certified accountant) is never a profile, because an employee can't hold the licence. The nearest unlicensed job is offered (compliance specialist, financial analyst), and its prompt says its work is not professional advice.
- **A job doesn't grant the world.** Profiles that would act for the person outside the computer (a recruiter applying for a role, a social media manager posting, a PR specialist sending a pitch) get exactly the held actions every employee has (section 9). The profile shapes the work, never the access.
- **Write follows the work product.** A profile suggests Write when what it makes lives in a repository (a site, a résumé in Markdown, translations); a reviewer's work lives in its reports and suggests Read. Either way it is a suggestion the person switches on.
- **The catalogue grows by adding to it.** A new profile is a change to `jobProfiles.ts` with its anchor, market title, responsibilities and report kinds, made when a real case doesn't fit. Never by a draft, a plan or an employee; until then, the person's custom title (below) is the way through.

**Examples.** A job-search repository gets a **Staff career coach** (focus: LinkedIn profile and positioning, writing the profile and résumé in the repository), a **Staff recruiter** (focus: finding roles and projects that fit, a shortlist report per search), and, for personal brand, a **Staff public relations specialist**. A website for Foreman gets a **Staff web designer** (focus: the Foreman marketing site), with a **Staff copywriter** and a **Staff SEO specialist** when it grows; the app's own screens stay with the UX designer.

**The templates are the first fifteen.** The job templates (`shared/employeeTemplates.ts`) are ready employees for fifteen of these profiles, offered in New organization and in New employee's **Pick a job** in an organization that already exists (section 5.3). Until a definition records its `profile`, "already have this job" is read from the role: a non-retired employee whose role is the template's Staff role. Once `profile` is built, that check moves to it.

**Everyone is Staff.** There are no levels to pick and no junior employees: every employee is hired at Staff level, and its role reads "Staff UX designer". The prompt says what that means (owns the outcome, makes judgment calls and says why, raises risks unprompted, needs no step-by-step direction), and a new employee's effort starts at high, which the person may lower. Small work is still a workspace (section 15); nothing here changes the workspace personas.

**Focus, not role.** The task-shaped words go into `focus` ("interface evaluation and accessibility"), shown after the title: Staff UX designer · interface evaluation and accessibility. The definition gains two fields, and `role` stops being free text: Foreman writes it from the profile.

```toml
profile = "ux-designer"
focus = "Interface evaluation and accessibility"
role = "Staff UX designer"        # written by Foreman from the profile; free text only for a custom title
```

**Generate and Refine** send the catalogue (id, title, responsibilities) and must answer with a `profile` from it; the parser refuses any other, the same way it refuses a missing instruction heading. The draft's responsibilities start from the profile's and add the focus.

**Priya** proposes `new_employees` with a `profile`. `checkPlan` refuses one outside the catalogue, and refuses hiring a profile someone on the roster already holds unless the proposal says why one isn't enough (two parts at once that both need a designer, say). The roster she reads gives each employee's profile. Her own definition takes `profile = "program-manager"`; since it is fixed and approved with the organization, the upgrade that changes it is approved the way the organization's approval is.

**A custom title is the person's exception.** New employee's **More options** offers **Other job title…**, for the case no profile fits. The person types a specific title (refused when it matches a profile's title, so a near-duplicate of the catalogue isn't made) and picks what it produces from the report kinds; Generate drafts from that title but can't choose it, and Priya can't propose one. Its page and card say "Custom title". Employees made before this section have no profile and are shown as custom titles; Edit offers to pick a profile, which changes the definition and so needs approving again, as any edit does.

### 16.2 One format for what an employee hands back

Every task whose result is a document ends with one **work report**: a Markdown file with front matter, in format `foreman-report/1`. Foreman tells the run the report's path (as it names a project part's file today) and `finish_task done` refuses until the file is there and parses; `partial` and `blocked` take one too, saying what is left. Reports are data: nothing in one raises authority.

```markdown
---
format: foreman-report/1
kind: ux-review                  # one of the author's profile's report kinds
title: "Settings: keyboard and contrast review"
author: e-7k2m                   # the id; the name and title are looked up
task: t-…                        # and project, part and round when it is a project's
repo: foreman@3d91ea19           # what it looked at, at which commit; one line per repository
status: done                     # done | partial | blocked
date: 2026-11-16
---
# Settings: keyboard and contrast review

## Summary
The answer first, in at most three lines.

## Findings
Each a heading `### <severity> · <title>` (critical, high, medium, low), then where (file:line or screen), the evidence, and what a fix would be.

## Recommendations
## Open questions
## Not checked
What was out of scope or couldn't be looked at, so nobody reads more into the report than is there.

## Sources
```

The front matter and Summary, Findings, Open questions and Not checked are the same for every kind; Findings and Open questions may say "None". Each kind adds its own sections between Findings and Recommendations: `change` adds What changed and Checks run, `ux-review` adds Screens, `test-plan` adds Cases, `requirements` adds Must and Won't. Findings are written twice, as prose for people and as the `foreman-findings` block reviewer personas already end with, which is what Foreman files (16.3); the check refuses a report whose two lists don't match in number. `plan.md` and `acceptance.md` keep their own fixed formats, written as today.

The format is versioned. A later `foreman-report/2` comes with a migration (16.4); Foreman reads every version it has shipped and writes only the newest.

### 16.3 The wiki

The memory repository is the organization's wiki. `memory/` stays each employee's working memory as section 4 describes; `wiki/` is the structured, readable layer beside it:

```
wiki/
  index.md                                   generated: the organization, its people, repositories and projects
  people/<id>.md                             generated: profile, focus, responsibilities, reports written, findings raised
  repos/<repo>/
    index.md                                 generated: open findings by severity, latest reports, projects that touched it
    reports/<date>-<kind>-<task>.md          work reports from tasks outside a project
    findings/F-0042.md                       one page per finding
  projects/<slug>/
    project.md                               generated: the request, the state, the plan's version, the parts and their files
    plan.md, acceptance.md                   the program manager's, as today
    <part>.md                                each part's work report
.foreman-memory.json                         { "schema": 2, "wiki": 1, … }
```

Pages link with `[[F-0042]]` and `[[people/e-7k2m]]`, and the generated pages carry back-links, so the folder opens as it is in Obsidian or reads on GitHub. Generated pages are written by Foreman whenever what they summarise changes, never by an employee, and say so in their first line. Reports are written by their authors through the memory tools, within the path their task names; the write rules of section 4 hold (`wiki/` is Foreman's, except each task's own report path for that task). A findings index in `foreman.db` is a disposable cache, as the search index is.

**Findings.** When a report is committed, Foreman files each of its findings as a page: an id unique in the organization (`F-0042`), the repository, where, severity, the report that raised it, and `status: open`. That is the only thing Foreman does by itself. **A finding's status never changes on its own**: Foreman doesn't close a finding because a later report doesn't mention it, and doesn't merge two that look alike; a new one that looks like an open one (same repository, same file or screen, same kind) is filed with "May be the same as F-0042" for the person to decide. Statuses (open, fixed, won't fix, duplicate of) change in two ways only:

- **By the person**, on the finding's page in the Wiki view, as a commit with the person as author.
- **By a re-check the person starts**: **Re-check findings** on a repository's page (all open, or the ones picked) makes a task for an employee with the profile that raised them (the author, if still on the team). Its report, kind `recheck`, says for each finding what it found now, with evidence; the statuses it proposes wait as one decision card ("Mark 5 fixed, keep 1 open") until the person applies them, and only what the person keeps changes.

Nothing schedules a re-check. A trigger that would start one is refused when the definition is checked.

**In the app**, the Memory view becomes the **Wiki** view: rendered pages with working links, a page per repository with its findings as a list filtered by status and severity, a page per person and per project, and the raw folders, proposals and conflicts the Memory view has today one tab away. It composes existing `ui/` components.

### 16.4 One project format, versioned, and moving what exists

Every project uses the one format above: its folder is `wiki/projects/<slug>/`, its parts' files are work reports, and `project.md` is generated. The layout is versioned by `wiki` in `.foreman-memory.json`, starting at 1; changing the layout or the report format later is a new version with its own migration, never a silent change.

**Migrating an organization** (memory `schema` 1 to 2) happens once, when the memory service first opens the repository after the upgrade, as one commit by Foreman with a `Foreman-Migration: wiki/1` trailer, through the same intent, commit and finalise as any write:

1. It waits while the repository has foreign changes (section 4) or any of the organization's project tasks is running; new project tasks wait for it.
2. It moves each `memory/org/projects/<slug>/` to `wiki/projects/<slug>/`, unchanged except for what follows.
3. It gives each part's file front matter from the project record (kind `report`, the part's owner, task, round and status), keeping the body as it was; a file that already has front matter keeps it. `plan.md` and `acceptance.md` move as they are.
4. It writes `project.md` for each project and the generated pages, and sets `schema: 2, wiki: 1`.
5. On finalise, it rewrites the current paths in each project's record (part files, inputs not yet read) to the new folder. A reference that carries a commit keeps its old path, which still reads at that commit.

Findings in the moved files are not filed: they were written before the format, and filing them is a re-check the person may start. An organization whose migration can't finish yet (a foreign change it waits on) says so in the Wiki view and in Needs you, and the old paths keep working until it does.

### 16.5 Building it

| # | Slice | Contents |
| --- | --- | --- |
| 1 | Job profiles | The catalogue with anchors; `profile`, `focus` and Staff in the definition; Generate, Refine and Priya constrained to it; Other job title; existing employees shown as custom |
| 2 | Work reports | `foreman-report/1`, its check in `finish_task`, report paths for every task, project parts writing reports |
| 3 | Wiki and migration | The `wiki/` layout, generated pages, memory schema 2, moving existing projects |
| 4 | Findings | Filing from reports, finding pages, statuses by the person, Re-check findings and its decision card |
| 5 | Wiki view | The Memory view grown into the Wiki view |
