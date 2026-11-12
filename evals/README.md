# Evals

Evals run real models against the text Foreman writes for models: tool descriptions, persona bodies, the chat-title
prompt and the pull-request prompt. They answer one question: did this prompt change help or hurt? (Design:
`docs/agents.md` section 9.6; the issue is #151.)

**They cost real money and are never part of `npm test`, `npm run test:changed` or any automatic run.** A full run of
the default model, three runs per case, is well under a dollar (a measured Haiku run of every case, one run each, was
about a cent and a half; it scales with the model and `--runs`). Run them by hand, when
you change model-facing text.

## Running

```
npm run evals -- [case...] [--model <id>] [--runs <n>] [--update-baseline] [--list]
```

- `case...` runs only those cases (`--list` shows their ids and where each `before` comes from).
- `--model <id>` is the model to run; the default is `claude-sonnet-5-5`, the model the baseline is meant for.
- `--runs <n>` is runs per scenario and text, where a case has its own default (3).
- `--update-baseline` writes the run to `evals/baseline.json` (see below).

It uses the Claude Agent SDK with whatever sign-in this computer's Claude Code has (`ANTHROPIC_API_KEY` or a login).
Each run is locked down so the result doesn't depend on the computer: no user, project or local settings (so no hooks,
skills, plugins or memory files), no MCP servers except the case's own fake tools, none of Claude Code's built-in tools,
no saved session, a plain system prompt of the case's choosing and an empty scratch directory.

The fake tools are an in-process MCP server. Their names, descriptions and argument schemas are the app's own (imported
from `src/shared/foremanDelegation.ts` and `foremanTools.ts`); they do nothing but record the call and answer with canned
data (`evals/fakeApp.ts`).

## Reading a report

```
case                      before  after  control (before / after)  status  vs baseline
tool-flow-status-own-run  0/1     1/1    1/1 / 1/1                ok      same (was 3/3)
```

- **before** is the old text on the probe, **after** the current text on the probe, **control** an input both texts must
  get right (a control that fails means the check or the setup is wrong and the other numbers mean nothing).
- **status**: `ok` (old failed, new passes, controls pass), `no before` (no earlier text exists, so only the new text was
  measured), `before passes (does not discriminate)` (the case doesn't show what the fix did: sharpen the probe or drop
  the case), `CONTROL FAILED`, `RUN ERROR` (a run could not be made, such as sign-in or network: not a verdict).
- **vs baseline** compares the after rate with `evals/baseline.json`. The process exits non-zero when it got worse, a control
  failed or a run errored.

The baseline file records the model it was made with. A run with another model is not compared with it. `--update-baseline`
refuses a run that had a run error or a failed control, and refuses to mix models: to record a different model, run every
case. Record baselines with the default model only; a baseline from a cheaper model (used to check the harness) is
labelled with that model and is of no use for the default one.

## A case

`evals/cases/<id>.ts` exports an `EvalCase` (`evals/types.ts`) that `evals/cases/index.ts` lists:

| Field | What it is |
| --- | --- |
| `id`, `title` | Lower-case words joined by hyphens; one line saying what the model should do. |
| `source` | The failure it comes from: an issue, a pull request, a commit, or what went wrong. Not "it seemed worth testing". |
| `before` | A real earlier version of the text, with the commit it is from (`{ value, ref }`): find it with `git log -S'<phrase>' -- <file>` and `git show <commit>^:<file>`. Where none exists, `{ none: 'why' }`; never write one by hand to have something to compare. |
| `after` | The current text, imported from the module the app reads it from, so it can't drift. If it isn't exported yet, export it from its source module (`src/shared/chatTitle.ts` is an example) without changing what the app sends. |
| `build(variant, scenario)` | The run (system prompt, user prompt, fake tools) for one variant of the text. `probe` is the input the old text got wrong; `control` is one both texts must get right. |
| `check(output, scenario)` | Reads the answer and the tool calls and returns `{ pass, reason }`. Check what the model did, not how it phrased it. |
| `runs` | Runs per scenario and text; default 3. |

To add one: write it from a real failure and cite the source; run it on the **old** text and check that the probe fails
(a case the old text passes shows nothing); make sure the control passes on both; run it on the new text; add a canned
output or two for its `check` to `tests/evals.test.ts` (that file runs without a model); then record the baseline.
`npm test` also checks the list itself (a source, a commit or a reason for each case, unique ids).

## What this does not do

A pass rate over a few runs is a signal, not a proof. Models change, so a baseline is tied to the model and date in the file.
The suite is small on purpose: add a case when a real failure shows up.
