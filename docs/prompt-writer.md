# Write a full prompt

In the New workspace dialog, **Write a full prompt** (at the end of the first message's tool row) turns a short message
into a substantially better prompt for the agent the workspace starts with. When the person's answers would change the
prompt, it first asks up to three quick questions, each with options to pick or their own words, and any can be
skipped. While it asks, the message folds to one line with Edit and the questions take its place in a box that
scrolls, with Write prompt and Skip questions (the prompt from the message alone) pinned under it. The person reads and edits the result before creating the workspace, and Undo puts their message
back. It is offered only there, never in a chat's composer: a follow-up in a chat depends on a conversation the writer
can't see.

The code is `src/shared/promptWriter.ts` (the system prompt, its examples, the request and the strict check),
`src/main/promptWriter.ts` (the request, the timeout and the reasons) and `NewWorkspaceDialog.tsx`. The first version
was drafted by Claude Fable 5.1 and reviewed twice by GPT-6 Astra; this one rebuilds it on each agent maker's own
prompting guidance, listed under Sources.

## The prompt it writes

The agent can read the repository; it finds files, conventions, tests and commands itself and follows the repository's
instruction files. What it can't see is what's in the person's head. The prompt carries exactly that, briefly: the
person's request as typed on the first line, then a brief built only from the request and the answers.

| Part | What it is | What it is not |
| --- | --- | --- |
| Goal | The outcome as observable behaviour, with the person's specifics ("idle users stay signed in for the full session, not sent to login after about 30 minutes"). | The request repeated in other words. |
| Context | Facts only the person has: the symptom, when, since when, examples. | Guessed causes, or lists of places to look. |
| Constraints | What the person said must or must not happen; for a bug, fixing the cause rather than hiding the symptom. | Generic advice ("keep the change small") nobody asked for. |
| Done when | A check that passes or fails and proves the goal (for a bug, a test that fails before the fix and passes after), and the evidence to report: the commands and their output, and for a bug the cause. | "Tests pass" on its own. |

A part with nothing true to say is left out. A request to explain or review gets its question as the Goal (no topics
the person didn't raise), read only as the Constraint, and what to hand back as Done when, with no tests. Every sentence
must carry a fact or an instruction the agent wouldn't follow anyway; most prompts are 40 to 120 words. It never invents
paths, names, numbers, libraries, designs or requirements, and never leaves a blank to fill.

**Questions.** It asks, on the first call only, when the answers would change what the agent does: for a bug what
exactly happens, when, since when and what should happen instead; for a feature which reading and how far; for "clean
up X" what specifically is wrong; for an explanation, only what the person is trying to find out. One to three
questions, each with two to four concrete options ("About 30 minutes", not "after a while"), the person's own words, or
skip. A question that can take several answers (what must not change) is marked `multi` and shown as checkboxes; its
answer is the picks joined with "; ". A request that already says what to change and where comes back unchanged.

## Three targets

The target comes from the agent the workspace starts with (the dialog's model, or a template's), through its catalog
field `promptStyle` (`src/shared/agentCatalog/`): set for Claude and Codex, and absent for every other agent, which gets
the common ground. Adding an agent whose maker publishes its own guide means a new style here and a field on its row.

| Target | Form | What it adds or avoids |
| --- | --- | --- |
| `claude` (Claude Code) | Plain sentences, no labels, in the same order: goal, context, constraints, "Done when …". | Says "be ambitious: …" when the person wants the full version and says so when they want the smallest fix, because Claude reads a request conservatively. No emphasis or "think step by step". |
| `codex` (Codex) | Labelled lines Goal, Context, Constraints, Done when. | Done when includes the loop: run the relevant tests, fix failures this change causes, rerun. No "ask before" or "stop for review" unless asked: GPT-6 Astra obeys them literally and stops early. |
| `generic` (every other agent) | The same labels, plain words, no product syntax (no @-mentions, slash commands, modes). | When the agent will change code: "Read the relevant code before changing it." and "Report what changed, what you ran and what it showed.", because harnesses differ. Not for an explanation. |

## How it works

- **One request on the one-shot path** employee drafts use (`Core.oneShotDraft`): the person's default agent when its
  driver answers one, else the agent that writes titles; no tools, run in the temp folder, never in privacy mode (the
  button is off, the service refuses before building anything, and the host returns nothing). A second request follows
  when the person answers questions. Only Claude's driver answers one-shot requests today, so Claude writes the prompt
  even when the target is Codex: on the person's chosen Claude model, else Sonnet 5.5 (`PROMPT_WRITER_FALLBACK_MODEL`)
  rather than the one-shot default, Haiku 5.5.
- **What is sent**: one JSON object with the message unchanged, the target and the resolved locale; on the second call,
  the questions answered and the answers. Nothing about the repository.
- **What comes back**: one JSON object, `{version: 2, status, prompt, questions, message}`, checked strictly in
  `parsePromptWriterAnswer`. `draft` replaces the message; `ask` shows the questions (first call only); `unchanged`,
  `not_task` and `refused` leave the message and say so.
- **The check**: version 2; the unused fields null (one left out is read as null, and a key it doesn't read, such as a
  note the model added, is ignored); a draft must
  contain the request word for word (a capital first letter allowed) and no blank like `[paste the error here]`; each
  question has two to four distinct options and an optional `multi`, and past the third question the rest are dropped
  (they come most useful first). On a second call a bare prompt, not wrapped in the JSON, is taken as a draft when its
  first line carries the request, and checked as one: after answers, a draft is the only answer with a prompt in it.
- **Limits** (UTF-16 code units): message 1000 (longer is refused, never cut), an answer 200, the prompt 2500, a
  question 200, an option 80, a message 240.
- **Failures** come back as a reason, not an error, and the dialog says it in the person's language: privacy mode, no
  agent, too long, no answer within 90 seconds, an answer that fails the check, or an error from the agent (a model's
  safety refusal isn't the JSON, so it fails the check). There's no automatic retry, and nothing reaches the new
  workspace's agent until the person creates it.
- **Stale answers are dropped.** The timeout doesn't cancel the request, so the dialog applies an answer only if it
  belongs to the newest call and the message is still exactly what was sent; Edit, which opens the message again,
  closes the questions.

## Why it is this way

| Decision | Why |
| --- | --- |
| The target is sent, and nothing about the repository. | Claude Code and Codex are prompted differently by their makers' own guidance, so the target decides the prompt's form. A repository's name, branches, `AGENTS.md` headings and check names establish nothing the agent can't read itself. |
| A short brief in the target's form, not a few sentences after the message. | The first version added at most three sentences after the message; that can't carry symptom, scope, boundaries and a check, which both makers' guides put at the centre of a good prompt. |
| The request on the first line, and a Goal that says what's true when done. | With the request forced into the Goal line (v2), the Goal only repeated it; the structural eval scored those goals 1 of 2. |
| No guessed causes, no generic advice, 40 to 120 words. | v2's prompts listed places the bug might be and added constraints nobody asked for ("don't alter how login works"); the judge flagged them as invented or filler. v4 added about a third fewer words and the judge found one to three invented items in ten prompts over two runs, against six. |
| Questions ask for specifics, and a must-not-change question takes several picks. | Category options ("After being idle for a while") never surfaced "about 30 minutes"; a single pick could carry only one of three constraints. |
| Up to three questions, answers woven in. | The person holds what makes the prompt better. One question wasn't enough for a bug (what you see, since when) and pasting answers verbatim read badly ("happens After a set amount of time"). Options never presume product facts or stand for "I'll type it", which left `[paste here]` blanks in early runs. |
| The request kept word for word inside the prompt. | Their words are the most precise statement of what they want; the check enforces it in place of the first version's exact prefix. |
| No "Assumptions: edit or delete" section. | Deleting an assumption line leaves the decision it made in the body (found in review of the first version). |
| Strict JSON, "every answer, first call and second", and a bare second-call draft taken only on its first line. | Without that line, 2 of 12 second calls came back as a bare prompt; with it, about 1 in 50. |
| Sonnet 5.5 writes when no Claude model is chosen, not Haiku 5.5. | In live runs Haiku rephrased the request about once in twelve second calls ("fix the bug where users get logged out…"), so its draft fails the check; Sonnet and Opus kept it every time, at the same speed (about 9 seconds a call). |
| Worked examples inside the system prompt, for all three targets; reasons on its rules; calm wording. | Anthropic: a few varied examples are among the most reliable steering, Claude generalises from a reason, and newer models over-react to emphasis. The tests check every example passes the check it teaches. |
| Not copied from the Console prompt generator: roles, step-by-step reasoning, `{{VARIABLES}}`, long templates. | Those build application prompts. A coding agent already has its harness's system prompt and the repository. |
| Only in the New workspace dialog. | That's where one-line tasks start. |

## Evals

`evals/cases/promptWriter.ts` holds five cases for `npm run evals` (see `evals/README.md`), each from a failure the
drafts showed, each checking one part of the prompt's structure in code against the shipped system prompt:

| Case | Probe | Control |
| --- | --- | --- |
| `prompt-writer-brief-structure` | A Codex bug with the person's answers: the request first; a Goal that states the outcome with their specifics instead of repeating the request; their facts in Context; "fix the cause" in Constraints; a check that fails before and passes after and asks for commands; no hedges; no number nobody gave. | A Claude bug: the same, in plain sentences with no labels. |
| `prompt-writer-explain-read-only` | An explanation for another agent, with the person's purpose: read only, no "report what changed", no tests to run, the purpose carried. | A Claude explanation never asks for changes or tests. |
| `prompt-writer-precise-unchanged` | An exact rename comes back unchanged, or with a short sentence that doesn't repeat it. | A vague request never comes back unchanged. |
| `prompt-writer-asks-for-specifics` | A vague bug gets questions with a concrete option (a duration, a number), none presuming the product ("Web only") or standing for "I'll paste it". | Another vague bug's questions are as clean. |
| `prompt-writer-several-constraints` | "clean up the settings code" asks what must not change with several picks. | Three joined constraints in one answer all reach the prompt. |

On Sonnet 5.5, three runs each, every probe and control passes (recorded in `evals/baseline.json`). The first run
caught two things this version fixes: an answer with an extra `questions_note` key (2 of 6), which the check now
ignores, and questions presuming a browser or devices (about one run in four), which stopped once the system prompt
named those examples.

While it was built, the writer was also measured with a model-graded structural eval kept outside the repository: five
cases with the person's private intent, a simulated person answering the questions from it, and GPT-6 Astra grading
each part of the prompt 0 to 2 with a quote. Two runs per case on Sonnet 5.5:

| Writer | Structure | Overall (1 to 10) | Invented items (10 prompts) | Words added |
| --- | --- | --- | --- | --- |
| v2 | 88% | 7.7 | 6 | 110 |
| v3 | 89% | 8.0 | 4 | 83 |
| v4 (this one; two separate runs) | 94% | 8.6 | 1 and 3 | about 85 per draft; the precise rename unchanged |

The contract checks, on eight lines including French, "try again" and an attack: Sonnet 5.5 and Opus 5.5 passed
every answer; Haiku 5.5 rephrased the request on about one second call in twelve, which is why Sonnet is the fallback.

Still weak: an answer coarser than the person's intent loses facts ("about 30 minutes" without "idle"); an explanation
drafts without asking what the person wants to find out. Next: structured output (the Agent SDK's `json_schema`
output format) so the schema, not the prompt, owns the answer's shape.

## Sources

- Anthropic: [Claude Code best practices](https://code.claude.com/docs/en/best-practices),
  [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
  [Metaprompt](https://platform.claude.com/cookbook/misc-metaprompt),
  [Prompt generator](https://claude.com/resources/articles/prompt-generator).
- OpenAI: [Codex prompting](https://developers.openai.com/codex/prompting),
  [Codex best practices](https://developers.openai.com/codex/learn/best-practices),
  [Prompting GPT-6.2 in Codex](https://learn.chatgpt.com/guides/prompting-gpt-6-2-astra),
  [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
