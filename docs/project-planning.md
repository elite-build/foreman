# Priya decides: what she shows, the tasks and the models

A design, not yet built. It changes how the program manager (Priya, `docs/ai-employees.md` §15) plans a project: what she is told she has, what she shows the person, what a plan can say, and which model each part runs on. Draft 3, 2026-11-18, after three reviews by GPT-6.2 Astra (section 14).

## 1. What is wrong today

A plan is a list of parts: an owner, a brief, one file, what it waits for, and whether the person checks it (`PlanInput` in `src/shared/projects.ts`). Foreman draws it (`planWorkflow`, `PlanWorkflow.tsx`): the request, the questions when she asked, the parts in the order they run with parallel ones side by side, a check after each gated part, and her acceptance and the final check for a large plan.

That drawing is correct, and it is the only one. What is wrong:

1. **It answers "who works next?" and nothing else.** For "add CSV export to reports" the person sees *Questions → Build the export → Test it*. Nothing shows where the button goes, what file they would get, what her question about columns changes, or what will be different when it is done. The person approves a plan without a picture of the thing.
2. **Every plan gets the same picture.** She can't choose what to show, because she can give nothing to draw.
3. **She never chooses a model.** Every run uses its owner's own model (`admit` and `launch` in `src/main/employeeWork.ts` read `definition.model`). A copy fix and an authentication redesign run on the same one. `EmployeeTask` has no model field.
4. **She plans without being told what she has.** Her task lists the team by name, role, what to ask each about and state (`rosterText`). It doesn't say which models each employee can run on or what each model is for.
5. **What she understood isn't tied to what she planned.** `understood`, `done_when` and the parts are separate lists. Nothing shows which answer settled what, which part delivers which condition, or what will prove it.
6. **In the plan card the chart can't be used.** The side column's map selects a part (`PlanMap.tsx`); the plan card's chart is a picture, with the briefs in a closed list under it.

## 2. What the person asked for

In their words: the charts are "very dumb or basic"; they should be "a lot more flexible, usable, and dynamic". Their example for simple work: "a feature with the user, questions, and the proposed structure". "I don't want to decide. Priya should be capable of deciding on the chart, tasks, and the models. For example can we use Sonnet in some cases or do we need Opus?" On models: "It should define the prompt first. It should understand what all it has and then define." Priya's own model stays as it is.

So the person picks nothing from a menu. Priya decides what to show, the tasks and the models; Foreman checks what she decided, draws it and runs it; the person approves or sends it back.

## 3. Principles

1. **Show the thing before the schedule.** What will exist, for whom, and what is still open comes first. Who does what, in what order, on which model is one click away.
2. **Brief, then inventory, then assignment.** She states the project's brief. She is told what she has. She writes each part's brief (its prompt). Only then does she choose who runs it and on which model.
3. **A plan stays data that Foreman checks and runs** (decision of 2026-11-16). What she draws is data too, so Foreman can link it to parts and questions and keep it beside the work as it runs.
4. **The least that will do.** A typo fix gets no picture and a cheap model. Pictures, checks and model strength grow with what can go wrong.
5. **Foreman refuses what is wrong and remarks on what is doubtful.** She must fix a refusal. She may answer or leave a remark, and the person sees it at the plan gate.
6. **What runs is what the person approved.** A model, an effort, a waived check or a changed promise the plan card didn't show doesn't go ahead on its own.
7. **A picture claims only what the record shows.** "Ravi's build is running" is a fact. "This button is done" is not one Foreman has.

## 4. What the person sees

Two walk-throughs. They are the first thing to mock and iterate with the person (section 12), before anything else is built.

### 4.1 "Add CSV export to reports" (small)

**Her questions post** leads with a picture she chose to draw, *What I propose*. Three rows: the report user (opens a report, clicks **Export CSV**, gets a file); the Reports page (its toolbar, changed); the server (a new export endpoint reading the report query that exists). One step is drawn as undecided: *gets a file*, with a question pinned to it: *Which columns: the ones on screen, or all of them?* Opened, the step shows the first line of the file each answer would give (`date,account,amount` against all fourteen column names).

**The plan card, after the answer** leads with the brief: who it is for, what will exist, and the two conditions for done. Beside her question, in her words: "You chose the columns on screen: the file's first line is `date,account,amount`", naming the step it changed. The picture is the same one, with that step now decided. Each thing that will be built names its part. Opening *Clicks Export CSV* shows: built in *Build the export* (Ravi, Sonnet 5.5 at medium effort, "one endpoint and a button from a clear brief"), proved by *Test it* (Quinn), delivers condition 1.

A switch above the picture, **What changes | Who does what**, shows the delivery chart instead: request, questions, build, test, done, each part with its owner and model.

**While it runs** the picture stays. *Clicks Export CSV* says "in Ravi's build · running", later "Ravi's build is done · Quinn's test is running". No step says it is finished or checked: Foreman knows the state of parts, not of buttons.

### 4.2 "Single sign-on for team accounts" (large)

Here the order of calls is the risk, so she leads with a different picture: the sign-in as a sequence diagram (the member, Foreman, the identity provider), with the undecided step marked (a member the provider knows and the team doesn't). Seven questions, four of them about named steps. Her map of what changes (the admin's setup screen, the sign-in page, the server, the provider) is the second picture.

**The plan card** leads with the brief and the picture she chose. *Who does what* shows: architecture (Kenji, Fable 5.1), your check, two builds side by side (Ravi and Mei, Sonnet 5.5), a security review (Omar, Opus 5.5) and tests (Quinn, Sonnet 5.5) that the pull request waits for, the setup guide (Theo, Haiku 5.5), her acceptance, your final check. One line under it names the models and what each is for; her reason for each is on the opened part.

### 4.3 A typo fix

One question (the rule that she asks before her first plan stays), then a plan with no picture: the brief in two lines, and *Who does what* with one part on Haiku 5.5. She chose not to draw, and nothing is added for show.

## 5. The brief

Added to `project_plan`:

- `for_whom`: who the work is for, in a line.
- `done_when` becomes `[{ id, text }]`. She gives each condition a short id of her own, unique in the plan, so parts can name it in the same call that creates it. Ids are kept across every later version, a second call in the same task and a sent-back plan: a new id is a new condition, a missing one is removed, and a removed id is never used again.
- `settled`: for each answered question, what the answer decided, and which steps of her picture it changed: `[{ question: "1.2", decided, items? }]`. This is how the card says "your answer changed this": she states it, with references Foreman checks. Foreman doesn't guess it from a comparison.

`summary`, `understood`, `out_of_scope` and `assumptions` stay. The plan card puts the brief first: for whom, what will exist, done when (each with the parts that deliver it), and beside each answer what it settled.

## 6. What she shows

### 6.1 A map

Optional, on a questions round and on a plan.

```
map: {
  lanes: [{ id, label }]            rows, top to bottom
  items: [{ id, lane, label, detail?, example?, kind, change?, open?, part? }]   in a lane, left to right in the order given
  links: [{ id?, from, to, label?, open? }]
  says:  [ … ]                      the same in words
}
```

- `kind`: `person`, `screen`, `action`, `service`, `data`, `outside`: the item's icon and word.
- `change`: `new`, `changed`, `removed` against today's product; left out for what stays. This is the only meaning the map's marks have.
- `open`: not decided yet, on an item or a link. Drawn as undecided (dashed, with a question mark), never as a fact. A question names the item or link it is about (`about`), and Foreman remarks on a question about something not marked open. A plan's map may keep something open only if an assumption names it.
- `example`: a few lines shown when the item is opened (the file's first line, an error message, a URL).
- `part` (plans only): the part that builds or changes the item.

She chooses the lanes and the items, so the same data draws a user's journey, a structure, a before and after, or the person with what changes underneath. Foreman places it without guessing: lanes are rows, items go left to right as given.

**Size.** The channel's plan card is about 580px wide, and three of today's 180-wide cards with their gaps already take 588. So a map is small by design: at most four lanes, four items in a lane and twelve in all, with narrower cards; anything bigger is refused with "show less: the steps that matter for this decision". Full screen is for comfort, not for fitting. The limit is tried in the mocks first, on the fullest map with long labels and crossing links, before it becomes a refusal.

**Drawing it.** With the design system's `Graph`: it has selection, marks with their words, badges, dimming, dashed and dotted lines, and notes, which can label a row. It has no lane container, places nothing itself, and draws each link as one curve with no routing around boxes. Whether lane labels as notes and unrouted links read well at 580px and at 200% zoom is settled in the mocks (step 0). If they don't, the lane is added to `Graph` first, as its own pull request, as `AGENTS.md` requires. The layout is a pure function in `src/shared`, tested at that width.

**In words.** `says` is always shown under the map. The items are also a list, by lane, with each item's links, its question and its part: the keyboard and screen-reader equivalent.

Refused: an item in an unknown lane, a link to an unknown item, a `part` that isn't in the plan, no `says`, more than the size allows. Remarked: a new or changed item no part builds; a `build` part that builds no item of a map that exists.

### 6.2 Other drawings

Optional, on a questions round and on a plan: `drawings`, at most three, each `{ id, title, shows, mermaid, says, about? }`: a Mermaid source in any diagram type Foreman's renderer draws, for what a map can't say (a sequence of calls, records and their relations, a life cycle), one line on what it answers, the same in words, and what it is about (a question, parts, conditions) so it shows beside them.

Foreman checks only what it can check anywhere: size (6,000 characters), `says` given, references real. It doesn't parse Mermaid: that needs the renderer, and a plan's validity must not depend on a window being open. A drawing that doesn't render shows its `says` lines, its source and the error, as a Mermaid block in chat does. The plan is still valid; a broken drawing is fixed by sending the plan back with a note (only a planning task can give a plan).

### 6.3 What leads

`lead` on a round and on a plan: `map`, `delivery`, or a drawing's id. It is the picture that opens first; the others are one click away. Left out, it is the map when there is one, else the delivery chart. A questions round has no delivery chart yet: with no map, or a lead drawing that doesn't render, it leads with the questions and the drawing's words.

### 6.4 Linked, and honest while it runs

- Selecting an item opens it under the picture: its example, the question about it and what the answer settled, its part with owner, model and why, and the conditions that part delivers. Selecting a part in *Who does what* shows its items.
- Once the plan is in effect, an opened item says where its part is, in words from the record: "in Ravi's build · running", "Ravi's build is done · Quinn's test is running". An item is never marked done or checked. A part's state comes from its runs, as the channel's "who is at work now" does (`projectLive`: working, starting, queued), so a part whose run is still queued doesn't say running.

## 7. What a plan says about delivery

Added to each part:

| Field | What it says |
| --- | --- |
| `kind` | `research`, `design`, `build`, `check`, `write`. Shown on the chart; rules read it. |
| `serves` | The condition ids this part delivers. |
| `proves` | For a `check`: the parts whose result it judges. |
| `touches` | For a part that changes a repository: the areas or paths it changes, in a few words. A part with `kind: build`, or with `touches`, is a *writer*. |
| `publishes` | The one part that asks for the pull request. |
| `gate_ask` | With `gate_after`: what the person should look at. |
| `run` | The model it runs on (section 8). |

And on the plan: `shape`, one or two sentences on why these parts, in this order, with these checks.

Rules Foreman holds, beyond today's:

- **A check counts.** A `check` waits for what it proves. Whatever else waits for a proven part also waits for its checks, except another check of the same part (two checks of one build would otherwise wait for each other). Foreman adds those dependencies, refuses a plan whose order then has a circle, and the chart shows them. A check that fails or can't be made finishes blocked and she replans, as today.
- **A check is only waived by the person.** A replan that marks a check, or a part a check proves, `accept_as_is`, or that keeps a check and drops something it proved, never goes ahead on its own: it waits at the plan gate, shown as a waiver ("Quinn's test didn't pass. Priya asks you to accept the build without it").
- **One publisher, last.** When a plan has a writer it names one publisher, which waits for every other writer and every check. Today this is an instruction to her; it becomes a check on the plan, and `request_pull_request` is refused from any other part of the project.
- **Started work is fixed.** A later version can't change a done part's brief, file, `serves` or `proves`, nor the file and brief of a round already handed to its owner; today only a started part's id and owner are held. A replan is checked again when it is applied, not only when she gives it.
- **A check sees still code.** The aim: no check runs while a writer is changing the workspace, and a pass that a later writer undoes isn't taken as a pass. How is not settled (section 12, before slice 4). `touches` is words and can't prove two writers are apart, so it only feeds a remark.

Remarked: a condition no part serves; an answer `settled` doesn't use; a `build` part of a large plan nothing proves and no gate follows; a check owned by the owner of what it proves; two writers that can run at the same time; more than four gates.

## 8. Models

### 8.1 What she is told

Her planning task gains **What you have**:

- **The team**, as today, plus each employee's job and **the models that employee can run on**: its own configured model and effort, marked as usual, and the other models of its agent that Foreman knows, each with the efforts it has and its default. The list says where it came from and when (the agent's last report, or Foreman's built-in table when the agent hasn't reported; a refresh that failed keeps the old list). A model the person hid from pickers is left out unless it is an employee's own. An attended, read-only employee lists only its own. An employee she proposes gets the list of the agent its draft will use. At most twelve models are listed: every owner's own first (all of them, even past twelve), then the rest by class, lightest first, then by name.
- **What each model is for**, a line per model from the catalogue, in English since the agent reads it (a new optional `work` on `CatalogModel`: a class, `light`, `standard` or `deep`, and a sentence). Haiku 5.5, light, "mechanical work from an exact brief: a rename, a copy change, one file". Sonnet 5.5, standard, "building, fixing and testing from a clear brief". Opus 5.5, deep, "work the brief can't settle: architecture, a bug nobody has reproduced, a security review, a change across many modules". Fable 5.1, deep, "as Opus, for the hardest reasoning and the longest tasks". A model with no `work` is unrated. Nothing here is a price.
- **The repositories**, as today, with the names of the checks each has.

### 8.2 How she chooses

After a part's brief is written, she weighs four things the brief shows: how much it leaves unsettled; what a mistake would cost; whether someone or something will check the result; what another round would cost.

- Light when the brief is exact and a check follows.
- Standard for building, fixing and testing from a clear brief. The usual answer.
- Deep when the brief can't settle the hard part, or a mistake is costly and hard to see.
- The owner's own model is always allowed, and is the answer when she has no reason to change it.
- Effort: the model's default, raised only for a part where a mistake is costly and nothing checks it, lowered for mechanical work.

Her prompt carries worked pairs, the same owner choosing differently: a copy change with a test after it against a permissions change nothing tests; a non-Claude owner who has only its own model.

`run` is `{ model, effort?, why }`; the reason must name what in the brief decides it.

### 8.3 What Foreman checks, and what the person approves

Refused: a model that isn't one of the owner's candidates; an effort the model doesn't have; no `why`; an unrated model that isn't the owner's own. Remarked: every part on a deep model; a `design` or `check` part of a large plan on a light one; a deep model on a `write` part.

An accepted `run` is stored complete: agent, model and the effort that will be used (the one she gave, or the model's default, worked out then and not later). The plan card shows exactly that for every part, with her reason, so approving the plan approves it.

A replan goes ahead on its own only if, besides today's conditions:

- no kept part's `run` changes;
- every part it adds has a `run` (agent, model, effort) the plan in effect already gives that same owner;
- no condition is added, removed or reworded, nothing is added to or taken from `out_of_scope`, no check is removed, and the publisher is the same.

Anything else waits at the plan gate. One function decides this, used both for what her tool tells her and for what Foreman then does. `planDiff` counts a changed `run` as a change. A further round of a kept part on its approved `run` goes ahead as rounds do today, within the project's allowance of runs (80, which the person can raise); the plan card says so where it shows the models, so the person knows what approving a model can cost.

(Found while reading: `replanGoesAhead` passes a part that keeps its id whatever its new owner, so a pending part can move to an employee who had no part without the person seeing it. Fixed with this, for old projects too.)

### 8.4 What runs

- When a part's task is made, the approved `run` goes on it with the plan version, part and owner it was approved for (`EmployeeTask.runOn`). Admission, the launch and the run's record all read it from the task. Today each reads the definition separately, and the session fills in an effort when none is given (`createSession`); with the effort stored, nothing is filled in later.
- Each attempt checks again that the model can be used. The usage-limit hold is unchanged: it is per agent and account, and a part's model never changes either.
- The run records what was asked for. What `turnStarted` copies from the session is also what was asked, taken before the agent answers; the card calls it "asked for", and says "used" only where the agent reports the model it ran.
- If the model can't be used, the part **waits for the person** on the same task, naming the model, with **Try again**, **Run on Ravi's own (Sonnet 5.5, high)** with the exact replacement, and **Send back**. The answer is tied to the part, plan version and attempt, so a restart or a second click starts nothing twice. It doesn't become a failed run that wakes her to replan, and nothing is substituted silently. Not settled (section 12, before slice 6): today nothing tells an agent refusing a model apart from any other launch failure, and a project's stuck wait offers only retry or stop.
- Follow-ups, and all work outside a project, run on the owner's own model. The employee's definition and its fingerprint don't change.

### 8.5 Knowing whether she chose well

Each part's record keeps what was planned and what happened: the model and effort planned and used, each round, and why a further round was needed, kept apart (the person sent it back; a check failed; the requirement changed; the provider failed), and the cost where the agent reports one (unknown stays unknown). The plan card shows it per part once it has run. Feeding it back into her inventory waits until there are enough projects to compare like with like.

## 9. Who does what: the delivery chart

Foreman still draws it from the parts, with `Graph`, top to bottom. Each part's box has its owner and kind above the title and its model under it. It is selectable in the plan card, as the side column's map is; a selected part opens under the chart with its brief (the prompt its owner gets), owner, model, effort and why, the conditions it serves, what it proves or what proves it, what it touches, what the person is asked to check, its items on the map, and once it runs its state, round, cost and **Watch**. Her `shape` is the line above it. The parts table stays as the keyboard and screen-reader equivalent and gains Model and Delivers columns. `plan.md` gains the brief, the map as a Mermaid flowchart with its `says`, her drawings, "Why this shape" and the models.

## 10. How it fits what exists

**Formats.** A project is stamped with its format when it starts, before her first question; no stamp means today's. The stamp is a number that each slice changing the rules raises, with a table of what each number turns on, so a project started between two releases keeps exactly the rules it started with. Everything that differs reads the stamp: what her tools accept and require, how her tasks are written, the replan rule, recovery, `plan.md`, and how each card is drawn. An old project keeps today's rules for its whole life, and every plan version is drawn by the rules it was made under. The tools' schemas accept both. Tested: an upgrade while questions wait for answers; a plan waiting at its gate; a running part; a closed project's card; a replan of an old project; a project started after the pictures ship and before models do.

**Her next run needs what her last run gave.** Thirty questions can reach 60,000 characters and their answers 60,000 more, a task is cut at 20,000 (`MAX_TASK_BODY`), and a planning run today gets neither the earlier map nor its ids. The project's record stays where it is, in `foreman.db`; nothing new is written to the memory repository, which only the memory service writes. Her planning task gains a read-only tool, `project_record`, that returns the full rounds with their answers, and the last brief, map and drawings with their ids, for her own project only. The task itself carries a bounded index with separate budgets (each question and answer cut short, the condition ids, the map's item ids and labels, the team, the models), the protocol and the rules Foreman checks, whole. A test holds the largest legal planning task under the limit with the protocol intact.

**Her instructions.** How to judge (what to show, how to shape a plan, how to choose a model, the worked pairs) goes in her job prompt, `employeePrompts/program-manager.md`: a Priya linked to the job gets the current text. The format, the tools' fields, what Foreman requires and where the project's record is go in every planning task, because a Priya whose prompt the person edited keeps her own text and still has to follow the protocol. Tested with a linked Priya, one with the organization's additions, and an edited one.

## 11. Left for later, and on what condition

Astra's first review found each of these unsafe as drafted. They are not in the slices below, and come back only if plans in use show the need.

- **A check that sends work back on its own.** Needs a `pass`/`fail` decision in the check's contract (`finish_task` refuses a decision the contract doesn't list); a failed verdict told apart from a check that couldn't be made; the verdict bound to the round and commit it judged; one record of the loop's state and what starts next, reconciled at launch; the same pause, stop, replan and closed checks as any start. First with one producer, one independent checker and one retry.
- **Planning the rest once research is in.** Needs a checkpoint that waits for every result it depends on, fires once, has its own count beside the three replans, and shows the person the newly concrete scope. Until then she plans the finding out as one project and the fix as the next.
- **How earlier projects went**, in her inventory (section 8.5).

Also found while reading, to fix on its own: `startPart` saves a part as running before its task exists, so a crash between the two leaves a running part that `recover` never looks at (`src/main/projects.ts`).

## 12. Building it

**0. Mocks, iterated with the person.** The two walk-throughs of section 4 as HTML, at the channel's real width: the questions post with an undecided step; the plan card with the answer shown changing the proposal; an opened item; *Who does what* with models; a part running, labelled as section 6.4 says; a questions round with no picture; a lead drawing that failed to draw. One of the maps is an unedited one a model wrote from the format, beside the hand-made ones (in Astra's two trials a model filled the format compactly, and once drew an undecided branch as if it were decided, which is why `open` exists). The test: the person, without the chart being explained, can say what is proposed, what is open, what their answer changed and what they are approving. This is where "the types of charts" get iterated, and where the `Graph` question of section 6.1 is settled.

**A first measurement.** `evals/cases/planRoundOpenSteps.ts` runs her questions round on a real model with the draft's wording: her job prompt and planning task as they ship, section 6.1's map added to `project_questions`, and a small repository that settles who may change a subscription. On 2026-11-19, with Sonnet 5.5 and nine runs in all: every run that was read in full read the repository before asking, and none asked outright who may pause (one asked the person to confirm what the repository had decided). She drew a picture in none of three runs with the first wording ("when the request changes what someone sees, give a picture") and in four of six with a firmer one ("gets a picture; only a typo or a rename goes without one"). In the one run kept in full that drew, Foreman's checks refused her first attempt and she repaired it. Nine runs are a signal, not a rate. What it suggests for slice 2: left to decide, she often draws nothing, so either the wording must be firmer still or Foreman asks for a picture on anything a sentence doesn't describe; and the checks on `open` and `about` earn their place. It measures nothing about whether a picture is a good one.

Then, each its own pull request with its tests and its part of `docs/ai-employees.md` §15:

1. **The format and the brief.** The stamp and what reads it; `for_whom`, condition ids, `settled`; `project_record` and the bounded task; the plan card led by the brief.
2. **One picture that leads.** `map` on questions and plans, its layout at the card's width, `says` and the list; `lead`.
3. **Linked.** Questions and parts on items; the opened item; what each answer settled, beside the answer.
4. **Delivery.** `kind`, `serves`, `proves`, `touches`, `publishes`, `gate_ask`, `shape`; the rules of section 7 with service tests; remarks; the selectable delivery chart.
5. **While it runs.** The labels of section 6.4, from tasks and runs.
6. **Models, end to end.** The catalogue's `work`; the inventory; `run` and its checks; `runOn` through admission, launch and the record; the wait when a model can't be used; the replan rule and the owner fix; planned and used on each part.
7. **Other drawings**, and letting one lead.

Slice 6 touches different code from 2 to 5 and can be built beside them once 1 is in.

**Not settled yet.** Slices 1 to 3, 5 and 7 can be built from this document once the mocks are agreed. Two need more design first, and Astra's last review says so:

- **Before slice 4: how a check sees still code.** Parts start from several places today (`advance`, a gate's send-back, a stuck part's retry, the last two without the pause and replan checks), and a task can close before its turn ends. Keeping writers and checks apart needs one rule every start goes through, checks that can't write, and a pass tied to the tree it examined. Also exactly when a checked change may be published.
- **Before slice 6: when a model can't be used.** A way to tell an agent refusing a model from any other failure; the wait's three answers on a project's wait; and how the plan card states what further rounds on an approved model may cost.

## 13. Turned down

- **A menu of chart types or plan templates the person picks from.** They asked not to decide.
- **Levels the person maps to models in Settings.** One more thing to set up, and it hides the answer to "Sonnet or Opus?" behind a word. She names the model, from the list for that owner.
- **Only Mermaid for what she draws.** She could draw anything, but a picture can't be linked to parts and questions or stay beside the work. The map is data; Mermaid is for what a map can't say, and may lead when it explains the decision better.
- **Working out "what your answer changed" by comparing two maps.** A comparison can't say which answer caused a change. She states it in `settled`.
- **Marking a step of the picture built or checked.** Foreman knows the state of parts, not of buttons.
- **Parsing Mermaid in main through an open window.** A plan would be valid or not depending on whether a window was open.
- **Her drawing the delivery chart herself.** It could disagree with what runs.
- **Swapping a model silently when one is gone.** The person approved a named model.
- **Running a project as a flow** (decision of 2026-11-16), and **changing the employee's own model from a plan** (it would change approved work outside the project).
- **Choosing Priya's model by the project's size.** The person said no.

## 14. The reviews

GPT-6.2 Astra reviewed drafts 1, 2 and 3 read-only against the code. Fable checked each finding in the code before acting on it.

**Round 1, on draft 1.** The person would "still see essentially the same delivery chart first": her drawing sat under it. Check loops, planned replans and a silent model fallback could change what runs after approval, release work on a stale pass and lose their place on a crash. A replan could raise any part to a model class already in the plan. Only unattended agents' visible models were offered. Main parsed Mermaid through a window. Putting the brief first in a schema didn't make planning brief-first. All accepted: the picture of the thing leads and is data; loops and planned replans moved to section 11 with conditions; approval is per part and exact; candidates are per owner; Mermaid isn't parsed; the brief is part of the plan.

**Round 2, on draft 2.** Ready to mock; not ready to build as written. A blocked check could be waved through by `accept_as_is` in a replan that went ahead alone, and a publisher could start before a check (section 7 now holds both). "Resolved once" covered the choice but not availability or the session filling in an effort (section 8.4). A replan could put a new part on an owner's costlier own model, or hang a new condition on a finished part (sections 7 and 8.3). `lead` excluded her own drawings (section 6.3). `Graph` draws marks and links but no lanes and no routing, and three cards already fill the channel (section 6.1). A model filled the map format well but drew an undecided branch as decided (`open`). "Changed" meant two things and an item "built" claimed more than the record shows (sections 5 and 6.4). Answers can reach 60,000 characters and the earlier map wasn't given back to her (section 10). The format stamp must be set at start and read everywhere (section 10). Slice 1 was five slices (section 12).

**Round 3, on draft 3.** Ready to mock. Slice 1 is ready after the mocks. Two checks of one build would have waited for each other, and a publisher for itself (fixed in section 7). A replan could change the file of a round already handed out, or keep a check while dropping what it proved (section 7). Conditions need ids in the call that creates them, and an undecided link needs an id a question can name (sections 5 and 6.1). The project's record can't be written to the memory repository by anything but the memory service, so it stays in the database behind a read-only tool (section 10). A queued run isn't a running one (section 6.4). Two things it says still need design, and they are listed as not settled in section 12: keeping writers and checks apart in one workspace, and what happens when a model can't be used.
