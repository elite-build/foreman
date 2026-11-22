# Write a full prompt

In the New workspace dialog, **Write a full prompt** (at the end of the first message's tool row) turns a short message
into a substantially better prompt for the model the workspace starts on. For the person it is a black box: they type a
line and press the button; when their answers would change the prompt it first asks up to three quick questions under
the message, each with options to pick or their own words, and any can be skipped; then the prompt replaces the message.
They read and edit it before creating the workspace, and Undo puts their message back. It is offered only there, never in
a chat's composer: a follow-up in a chat depends on a conversation the writer can't see. It is offered only when the
workspace starts on Claude Code or Codex.

The code is `src/shared/promptWriter.ts` (the model profiles, the ladder, the system prompt, its examples, the schema,
the request and the strict check), `src/main/promptWriter.ts` (the request, the timeout and the reasons), `promptDraft`
in `src/main/core.ts`, Codex's `answerOnce` (`src/main/agents/codex/answerOnce.ts`) and `NewWorkspaceDialog.tsx`. The
first version was drafted by Claude Fable 5.1 and reviewed twice by GPT-6 Astra; v4 rebuilt it on each agent maker's own
prompting guidance; this one (v5) writes for each model separately, with stages and a ladder in the prompt.

## Who writes, and for whom

The model the workspace will start on (the dialog's model, or a template's) writes the prompt, on the same account, at
medium effort where the model takes one (`PROMPT_WRITER_EFFORT`), and writes it for itself. A Claude model writes for
Claude Code; an OpenAI model writes for Codex. Nothing falls back to another model or account: a failure says why and
leaves the message. Failures are rare; the work the prompt sets up is where a model can fall short, so that is where the
ladder lives (below).

Claude answers through its one-shot path (the Agent SDK, no tools, one turn). Codex answers through `answerOnce`:
`codex exec` in an empty temporary folder, read-only, `--ephemeral`, the system prompt as `developer_instructions`, the
request on stdin, and `--output-schema` holding the answer to `PROMPT_WRITER_ANSWER_SCHEMA`. It is a separate driver
method from `oneShot` so that Codex doesn't become an agent that writes chat titles (`features.titles` follows `oneShot`).

## The eight profiles

Each model has its own profile (`PROFILE_STYLE`) on top of its family's (`FAMILY_STYLE`). A model id takes the profile
its name holds (`claude-opus-5-5[1m]` is Opus, `gpt-5.6-sol` is Sol); a name with none takes its family's everyday model
(Sonnet, GPT-6.2 Sol). Every rule comes from the maker's own guidance (Sources).

| Family | Form |
| --- | --- |
| Claude (Claude Code) | Plain sentences, no labels: goal, context, constraints, "Done when …"; a staged prompt uses labelled lines (Goal, Context, Constraints, Roles, Done when) so the split reads at a glance. Calm wording: no capitals or "you must" (Claude over-applies them), no "think hard" (effort is the control). "Be ambitious: …" when the person wants the full version, because Claude reads a request conservatively. Never asks for its reasoning in the reply. |
| OpenAI (Codex) | Labelled lines Goal, Context, Constraints, Roles, Done when, written as to a colleague: the outcome and what counts as finished, not steps. Done when includes the loop (run the relevant tests, fix what this change broke, rerun). No "ask before" or "stop for review" unless asked or the step is destructive, irreversible or published: it obeys them literally and stops early. It may make reasonable, reversible assumptions and say so. |

| Model | What its prompt adds or avoids |
| --- | --- |
| Fable | Short instructions (long procedures make its work worse). Report problems outside the task as follow-ups rather than fix them; edit files in place; tests only where asked; finish the work rather than end on "Next, I'll …"; verify with a fresh subagent. |
| Opus | Read the relevant code before changing anything on a loose request; the completion condition and no stopping before it; deliver what was asked at the scope intended, short report; no "double-check" lines. |
| Sonnet | The scope stated outright (it is literal); "keep working until everything asked for is done" and "don't add features, tests, files or docs the task doesn't need"; a real check that exercises the change; for a plan, give it and stop. |
| Haiku | Short and tightly scoped (a long prompt makes it hand the task back early); run the check and show the output; keep working, add nothing; no blanket "always" rules. |
| GPT-6.2 Astra | The outcome, what will be checked and where to be exhaustive, no steps; no "be concise" or "keep going"; subagents for work that splits; a bug across systems traced, fixed and its workflows tested. |
| GPT-6.2 Sol | The files, errors and steps the person gave; no "be concise" or "keep going"; a change across packages staged. |
| GPT-6.1 Terra | Focused fixes with one check; for visual work, names and numbers read from images compared with the source; the expected result spelled out. |
| GPT-6 Luna | The most specific prompt: exactly what a good result looks like, steps where the order matters, one change, one check. |

## Roles and the ladder

The point of a staged prompt is speed and tokens: the work is split by role so the most tokens go to the fastest model
that can do each part well. Each family's models, fastest and cheapest first, are its ladder (`PROMPT_LADDERS`): Haiku →
Sonnet → Opus → Fable, and GPT-6 Luna → GPT-6.1 Terra → GPT-6.2 Sol → GPT-6.2 Astra. The workspace's model is the lead.
The code works the roles out for the target (`rolesText`); the writer words them and proposes which builder takes each
slice, with a reason:

| Role | Claude | OpenAI | Why |
| --- | --- | --- | --- |
| Explore (read only) | Haiku | GPT-6 Luna | Reading takes the most tokens and no judgement. The lead explores itself when it is already the fastest. |
| Plan, as slices: files, exact change, check | the lead, or Opus when the lead is below it | the lead, or GPT-6.2 Sol | The plan decides everything after it, and a plan that exact is what lets a fast model build. |
| Build a slice the plan spells out, in an existing pattern, one concern, caught by its check | Haiku | GPT-6 Luna, or GPT-6.1 Terra when it's judged by how it looks | The fastest and cheapest model. Anthropic measured Haiku builders about 4 points less accurate than Sonnet for about a third less cost, so it pays exactly where the slice is clear. Luna is OpenAI's model for focused coding "when you know what a good result looks like"; Terra is its strongest at visual understanding. |
| Build a slice that needs judgement across files, can't be spelled out, or touches sign-in, security, payments, stored data, concurrency or a depended-on interface | Sonnet | GPT-6.2 Sol | There a wrong fast attempt and its retry cost more than one careful attempt. |
| Verify, fresh | Opus (Fable when Fable leads) | GPT-6.2 Sol (Astra when Astra leads) | Eyes that didn't build it, a step above the builders. GPT-6.2 Sol is OpenAI's own example reviewer, at about a fifth of Astra's cost. |

The lead builds nothing itself and keeps its context for leading; slices that don't depend on each other run at the same
time, and a chain of dependent steps isn't split (Anthropic: it gains nothing). The writer can't see the code, so its
split comes from the request and the answers, and the prompt tells the lead to adjust it after exploring, by the same
rules, keeping a reason for each slice. Each builder gets a short brief (the files, the change, the check, and to show
its output), which is also how Haiku is best prompted.

- **The climb**, for staged and brief requests: a slice that fails its check a second time goes one rung up with what
  was tried and why it failed; if it fails there too, the agent stops and reports. A brief request climbs from the lead;
  the strongest has nowhere to climb and stops. The trigger is the check failing, never the agent's own judgement.
- The report names which model built each slice.
- Everything else gets neither: on small work roles only add cost.

### Mock roles

Mocks with more than one direction, or several states each, split the same way (`mockRoles`), from a workflow the person
wrote by hand for their own mock requests:

| Role | Claude | OpenAI | Why |
| --- | --- | --- | --- |
| Lead | the workspace's model | the workspace's model | Asks first when told to, keeps the directions apart, assembles the files and an index. |
| Design the hero state of each direction, one subagent per direction at once, listing its visual system (colours, type sizes, spacing, radii, components) in the hero file | Opus (the lead when stronger) | GPT-6.2 Sol (the lead when stronger) | A direction's look is the part that needs the strongest judgement. |
| Extend each direction to the other states, one subagent per direction at once, using only what its list names | Haiku | GPT-6.1 Terra | Copying a written-down system is fast work; Haiku is the fastest, Terra fast and OpenAI's strongest at visual work. |
| Check | Haiku runs the checklist with evidence; the lead compares each extended file with its hero against the list | Luna, and the lead | The list makes "matches its direction" a check rather than a judgement, which a fast model checking its own model's work would miss. |
| Escalate | a file outside its list is redone on Sonnet; failing again, stop and report | redone on GPT-6.2 Sol | Extension work never climbs past one rung: a redo on the strongest model costs more than the file is worth. |
- A ladder never crosses families, and a target is never shown the other family's model names (its examples are its own
  family's, or ones that name no model). When the person names models themselves ("review with Fable and Astra"), the
  prompt uses theirs, from any family.

Both agents run this through their own subagents, with nothing in Foreman: Claude Code's subagent tool takes a model alias
(`haiku`, `sonnet`, `opus`, `fable`), and Codex's spawn tool takes `model` and `reasoning_effort` (checked on Codex
0.171.0: a subagent asked for on `gpt-6-luna` from a `gpt-6.2-sol` parent ran on `gpt-6-luna`, as its session file
records, while it said it was `gpt-6.2-sol`; so a prompt never asks a model to report its own name as proof). Flows could
enforce a ladder in code, but a flow's turn steps run on Claude only.

## Categories

The writer names the kind of request on every answer it can (`category`, one of `PROMPT_CATEGORIES`; optional, never
shown, dropped when unknown rather than failing the answer). The kind decides the prompt's shape.

**Every request is drafted in full.** Write a full prompt is the person's path for a thorough prompt with its models
chosen; they type small requests straight into the message. So nothing comes back unchanged for being small or already
precise (only a request that needs a conversation the writer can't see, such as "try again"): every code change gets the
full roles however small it looks, and every other draft a "Models:" line that puts the reading on the fastest model
and the judgement on the lead or a stronger one, each with its reason.

| Shape | Categories | What the prompt gets |
| --- | --- | --- |
| Read only, Models line | question, explain, research, review | The question, scope, read only, what to hand back; a review's rubric and at most two rounds. The fastest model reads; the lead answers, or Opus / GPT-6.2 Sol judges a research or review. |
| Light, Models line | writing, docs, script | Audience, tone, length, or what the script must do. The fastest model gathers the facts (or writes and runs the script); the lead writes. |
| Code change, full roles | wrapper (its steps kept word for word as the plan), bug, refactor, performance, tests, prompt-authoring, feature, build-mock, upgrade, infra, security, data-migration | Each kind's own rules: reproduce first, no behaviour change, measure first, a persona's cases run with their inputs and replies shown; security adds a review, a migration a backup, a way back and a question before real data. |
| Ask first, Models line | release | The repository's own release process if it has one, and a question before anything published, tagged, merged by an administrator or deleted. |
| Mock roles | mocks | The count of directions, the format and the states, with "ask first" kept, and the mock roles above, also for a single mock. |
| Read first, Models line | link, external | The writer can't open links: the fastest model reads it first with the agent's tools, then the work takes the kind it turns out to be. |
| Fallback | other | The general rules, with a Models line. |

Iterating on earlier output, reverting and "continue" aren't categories: they need a conversation, and the writer only
runs before the workspace exists. An empty message is refused before anything is sent.

## The prompt it writes

The agent can read the repository; it finds files, conventions, tests and commands itself and follows the repository's
instruction files. What it can't see is what's in the person's head. The prompt carries exactly that, briefly: the
person's request as typed on the first line, then a brief built only from the request and the answers.

| Part | What it is | What it is not |
| --- | --- | --- |
| Goal | The outcome as observable behaviour, with the person's specifics ("idle users stay signed in for the full session, not sent to login after about 30 minutes"). | The request repeated in other words. |
| Context | Facts only the person has: the symptom, when, since when, examples. | Guessed causes, or lists of places to look. |
| Constraints | What the person said must or must not happen, and what the category adds. | Generic advice nobody asked for. |
| Roles | Staged requests only, as above: each role's model and why. | Roles for small work. |
| Done when | A check that passes or fails and proves the goal (for a bug, a test that fails before the fix and passes after), the evidence to report, and the climb. | "Tests pass" on its own. |

A part with nothing true to say is left out. Every sentence must carry a fact or an instruction the agent wouldn't follow
anyway; most prompts are 40 to 120 words, a staged one up to about 250. It never invents paths, names, numbers,
libraries, designs or requirements, and never leaves a blank to fill.

**Questions.** It asks, on the first call only, when the answers would change what the agent does: for a bug what
exactly happens, when, since when and what should happen instead; for a feature which reading and how far; for "clean
up X" what specifically is wrong; for an explanation, only what the person is trying to find out. One to three
questions, each with two to four concrete options ("About 30 minutes", not "after a while"), the person's own words, or
skip. A question that can take several answers (what must not change) is marked `multi` and shown as checkboxes; its
answer is the picks joined with "; ".

## How it works

- **What is sent**: one JSON object with the message unchanged, the target's profile name and the resolved locale; on
  the second call, the questions answered and the answers. Nothing about the repository. The system prompt is the
  target's (`promptWriterSystemPrompt`): the shared rules, the family's and the model's profile, its roles, and the
  examples it is shown.
- **What comes back**: one JSON object, `{version: 3, status, category, prompt, questions, message}`, checked strictly
  in `parsePromptWriterAnswer`; Codex is held to it by the schema as well. `draft` replaces the message; `ask` shows
  the questions (first call only); `unchanged`, `not_task` and `refused` leave the message and say so.
- **The check**: version 3; the unused fields null (one left out is read as null, and a key it doesn't read is ignored;
  `multi: null` is one pick); a draft must contain the request word for word (a capital first letter allowed) and no
  blank like `[paste the error here]`; each question has two to four distinct options, and past the third question the
  rest are dropped. On a second call a bare prompt, not wrapped in the JSON, is taken as a draft when its first line
  carries the request, and checked as one.
- **Limits** (UTF-16 code units): message 1000 (longer is refused, never cut), an answer 200, the prompt 4000, a
  question 200, an option 80, a message 240, a model id 200. The prompt's limit is above what the rules ask for, so a long staged prompt is edited by the person rather than lost. The system prompt stays under 26,000 characters escaped,
  because Codex takes it on the command line (Windows caps one at 32,767).
- **Failures** come back as a reason, not an error, and the dialog says it in the person's language: privacy mode, no
  agent (no profile, a removed account, or a driver that can't answer), too long, no answer within 90 seconds, an answer
  that fails the check, or an error from the agent. There's no automatic retry, and nothing reaches the new workspace's
  agent until the person creates it.
- **Stale answers are dropped.** The timeout doesn't cancel the request (Codex's process is ended after two minutes), so
  the dialog applies an answer only if it belongs to the newest call and the message is still exactly what was sent;
  editing the message closes the questions.

## Why it is this way

| Decision | Why |
| --- | --- |
| The workspace's own model writes, for itself, and nothing falls back. | The person asked for each model to be prompted its own maker's way, and for the writer to stay in that family. A cross-family fallback would write a Claude prompt with an OpenAI model's habits, or the reverse. |
| One profile per model, not per family. | The makers document real differences inside a family: Sonnet is literal and checks in early, Haiku hands back long prompts, Fable over-reaches and rewrites files, Luna wants the most specific prompt. |
| Roles split staged work by speed and judgement, and the writer gives each model its reason. | The aim of a detailed prompt is to finish sooner on fewer tokens. A role map fixed per lead put everything on Opus when Opus led; the rules instead send reading and spelled-out slices to the fastest model and judgement to a careful one, with the makers' own cost and accuracy numbers as the reason, so the lead can apply them per slice. |
| The ladder is in the prompt, not around the writer. | Writing a prompt rarely fails; building, checking and fixing is where a model falls short. The agents' own subagents carry it, for both families; flows can't, since their turn steps are Claude only. |
| The climb is tied to the check failing twice, one rung up. | Anthropic measured an "advisor" pattern where the executor escalates when it thinks it should: Sonnet at high effort asked on none of 20 problems. A rule on a fact is followed; a rule on judgement isn't. One rung, and Fable only from Opus, keeps the expensive model out of the common case. |
| Planning and verifying at least on Opus or GPT-6.2 Sol. | Anthropic's Opus-orchestrating-Sonnet run cost about a third less than Opus alone at the same score; OpenAI's example reviewer is GPT-6.2 Sol. Fable and Astra stay for when the person picked them. |
| The category is the writer's, in the same call, optional and unshown. | A second call or a classifier in code would double the wait for a field only the writer's own shape needs; the person sees only the prompt. |
| The request on the first line, and a Goal that says what's true when done. | With the request forced into the Goal line (v2), the Goal only repeated it; the structural eval scored those goals 1 of 2. |
| No guessed causes, no generic advice, 40 to 120 words. | v2's prompts listed places the bug might be and added constraints nobody asked for; the judge flagged them as invented or filler. v4 added about a third fewer words and the judge found one to three invented items in ten prompts over two runs, against six. |
| Questions ask for specifics, and a must-not-change question takes several picks. | Category options ("After being idle for a while") never surfaced "about 30 minutes"; a single pick could carry only one of three constraints. |
| The request kept word for word inside the prompt. | Their words are the most precise statement of what they want; the check enforces it. |
| Strict JSON, and Codex's schema. | Without "every answer, first call and second", 2 of 12 second calls came back as a bare prompt; with it, about 1 in 50. The schema closes the rest for Codex. |
| Worked examples, reasons on its rules, calm wording. | Anthropic: a few varied examples are among the most reliable steering, Claude generalises from a reason, and newer models over-react to emphasis. The tests check every example passes the check it teaches. |
| Only in the New workspace dialog, only for Claude Code and Codex. | That's where one-line tasks start, and those are the two families with profiles. |

## Evals

**One eval per category.** `evals/cases/promptWriterCategories.ts` holds 24 cases, `prompt-writer-category-<kind>`, one
realistic request each with the person's answers (or every question skipped), so a single call drafts. Each runs on
Claude Code with Sonnet leading (probe) and on Codex with GPT-6.2 Sol leading (control), and checks exactly three things
in code and nothing else:

| Check | Passes when |
| --- | --- |
| Goal | The Goal line (or an unlabelled prompt's first paragraph) carries the parts of the request the case names, and isn't the request repeated. |
| Models | Every model is the target family's (a Claude one with its version), and each part has the model its rules give: for a code change Explore on the fastest, Plan on Opus or GPT-6.2 Sol (or the lead when it is that strong), a listed builder, a fresh verifier on that rung and the climb; for mocks the designer, extender and redo; otherwise a Models line with the reading on the fastest and, for research, review and external, the judgement on the strong rung. |
| Done when | For a code change, a check that runs and passes or fails, with the commands (or, for a prompt, each case's input and reply) as evidence; for mocks, the index and which model made each file; otherwise what to hand back. |

On 2026-11-22 the first full run passed 41 of 48 runs; the misses were the checker reading the request's own "Plan:" as
a role, reading only a role's first line, and not knowing every way a Done when names what comes back, plus two the
writer's rules fixed: a persona's Done when now runs each case and shows its input and reply, and the mock roles say
what Done when holds. After those, all 24 pass on both families, prompt-authoring and mocks 3 of 3 each.

**The earlier five.** `evals/cases/promptWriter.ts` holds five cases from failures the drafts showed: a Codex brief on
GPT-6.2 Sol and a Claude brief on Sonnet (`prompt-writer-brief-structure`, whose number check now ignores model names and
which no longer refuses labelled lines, since a code change's roles use them), an explanation on GPT-6 Luna read only
(`prompt-writer-explain-read-only`), a precise rename drafted with its models rather than returned unchanged
(`prompt-writer-precise-drafted`, which replaced `prompt-writer-precise-unchanged` when the writer became the thorough
path), concrete options for a vague bug (`prompt-writer-asks-for-specifics`) and several picks for what must not change
(`prompt-writer-several-constraints`). All five pass on v5; the baseline in `evals/baseline.json` is still v4's.

v5 was checked live once per family on 2026-11-21: on Codex 0.171.0, GPT-6.2 Sol asked two concrete questions about a
slow CSV export (6 s) and GPT-6.1 Terra wrote a staged dark-mode prompt with planning and verifying on GPT-6.2 Sol and
the climb to it (7 s), both through the schema; on Claude Code, Haiku 5.5 wrote a bug prompt in plain sentences with the
person's facts and the climb to Sonnet (13 s). After roles replaced stages, "build a sign-in page" with the same answers: Opus gave the page and form to Haiku (they follow existing pages) and the sign-in wiring to Sonnet (it touches sign-in), with a fresh Opus verifying, in 14 s but at 396 words, over the 250 the rules ask for; GPT-6.2 Sol gave the layout to Terra (judged visually) and the wiring to Sol, 259 words. Earlier measurements of v2 to v4 with a model-graded structural eval kept
outside the repository (five cases, a simulated person, GPT-6 Astra grading each part 0 to 2):

| Writer | Structure | Overall (1 to 10) | Invented items (10 prompts) | Words added |
| --- | --- | --- | --- | --- |
| v2 | 88% | 7.7 | 6 | 110 |
| v3 | 89% | 8.0 | 4 | 83 |
| v4 | 94% | 8.6 | 1 and 3 | about 85 per draft; the precise rename unchanged |

Still open: the evals on more than one writer model (they run on Sonnet 5.5) and a v5 baseline; whether the agents follow the climb in a real run (Claude's
"advisor" result says a rule on a fact is followed, but it hasn't been measured here); Claude's answer isn't held to the
schema yet (the Agent SDK's `json_schema` output format would do it). The bundled Codex is 0.171.0 (GPT-6.2 needs
0.166.0 or later; a Codex the person points Foreman at that is older gets "needs a newer Codex" from `versions.models`).

## Sources

- Anthropic: [Claude Code best practices](https://code.claude.com/docs/en/best-practices),
  [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
  [Prompting Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1),
  [Prompting Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5),
  [Prompting Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5),
  [Prompting Haiku 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5),
  [Optimizing for cost and intelligence](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence),
  [Subagents](https://code.claude.com/docs/en/sub-agents).
- OpenAI: [Codex models](https://learn.chatgpt.com/docs/models),
  [Model selection](https://learn.chatgpt.com/docs/model-selection),
  [Prompting GPT-6.2 in Codex](https://learn.chatgpt.com/guides/prompting-gpt-6-2-astra),
  [Latest model guide](https://developers.openai.com/api/docs/guides/latest-model),
  [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra),
  [Codex best practices](https://learn.chatgpt.com/guides/best-practices),
  [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
