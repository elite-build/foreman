---
name: create-pr
description: Use this skill when the user asks you to open, create or raise a pull request for the current branch of this repository. It covers the checks to run, a self-review of the diff, before-and-after screenshots for UI changes, the PR title and body, the release note the changelog is built from, and reading the PR back. Not for reviewing someone else's PR, replying to review comments, or cutting a release (create-release does that).
---

# Open a pull request

A Foreman PR is read by one maintainer who has to decide, from the PR alone, whether the change is correct, safe and ready to merge, and later by whoever writes the release notes from it. Write for that reader: someone who knows the repository but not this change.

Run this only when the user has asked for a PR. Opening one means committing, pushing a branch and publishing text on a public repository; nothing here merges, tags or touches `main`.

Before the first command, write a short checklist of the steps below and keep it current until step 7 is done.

## 1. Know what is going in

```sh
git fetch origin main
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

- Uncommitted work that belongs to the change: commit it with a message in the repository's style (an outcome, in plain words: "Keep a Claude turn going when a follow-up cuts off its request"). Leave unrelated files alone and say so.
- Mocks never go into a PR. If the branch holds any (`mocks/`, `mockups/`, `mock*.html`, `design/`), take them out with `git rm -r --cached -- <path>`, add the path to `$(git rev-parse --git-path info/exclude)` so the workspace keeps its copy untracked, and commit. The `pre-push` hook refuses the push in step 7 otherwise.
- Do not rename the branch; Foreman names it.
- If `origin/main` has moved and touches the same files, merge it in now so the checks run on what will merge, and mention the merge in your report.

Done when you can say in two sentences what the branch changes and why.

## 2. Run the checks

Always: `npm run typecheck`, `npm test`, `npm run build`, `npm run check:repository`.

Add the ones the diff calls for (AGENTS.md, "Development, checks and packaging", is the source of truth):

| The diff touches | Also run |
| --- | --- |
| `src/renderer/`, `src/shared/i18n/` | `npm run check:ui` |
| `ui/` exports | `node scripts/check-new-components.mjs origin/main` |
| MCP, CLI or settings | `npm run check:mcp`; `npm run docs:cli` and commit any change to `docs/cli.md` |
| `package.json` dependencies, `package-lock.json` | `npm run check:security`, `npm audit --audit-level=high`, `npm run check:licenses` |

Write down each command and its result for the Verification section. A failure is fixed, or reported in the PR as a failure; never left out. A tool that can't run (no Electron, no network) is reported as not run, with the reason.

## 3. Review the diff before anyone else does

Read `git diff origin/main...HEAD` from top to bottom as the reviewer would, once. Look for:

- Leftovers: debug output, commented-out code, files the change doesn't need, unrelated reformatting.
- Code that doesn't read like its neighbours (naming, comment density, idiom), and comments that narrate the change instead of explaining the code.
- Changed behaviour without a test, or a test that would pass without the fix.
- The repository's rules: design-system components only, words through `src/shared/i18n` in every locale, IPC allowlists, secrets in `SecretStore`, append-only migrations.
- One-way changes, which a rollback can't undo: a migration, a persisted shape, a settings default, a CLI flag, the update feed, a security boundary. Each one goes into the Compatibility section.
- Docs that describe what you changed: `rg` the feature's name in `docs/`, `README.md` and `AGENTS.md` and update what is now wrong.

Fix what you find in one batch, rerun the checks that cover it, and move on. A second full review pass is not needed; a review that finds nothing is a valid result.

## 4. If the UI changed, show it

When the diff changes what the app draws (anything under `src/renderer/` beyond tests and pure logic), read [ui-changes.md](ui-changes.md) and follow it. It produces before-and-after screenshots for the PR, and says when the reasoning also belongs in `docs/design-system.md` or `docs/decisions.md`.

## 5. Decide what else gets written down

- **The release note** goes in the PR body (step 6), never in `CHANGELOG.md`: parallel branches would all conflict at its top, and the notes are collected into it at release time ([docs/decisions.md](../../../docs/decisions.md)).
- **A decision record** in [docs/decisions.md](../../../docs/decisions.md) only when that file's "When to add an entry" says so. Most PRs, including most features and every ordinary fix, need none: the PR is the record. When one is needed, add the entry in this branch and mention it in the PR.

## 6. Write the title and body

**Title.** The outcome, in plain words, sentence case, no prefix and no trailing period, under about 80 characters. Describe what changes for the user or the developer, not the code: "Show the pull request's number in the side panel header while it's open", not "Update SidePanel header".

**Body.** Use the headings of [.github/pull_request_template.md](../../../.github/pull_request_template.md), in its order, and replace each comment with the content it asks for. Write the body to a temporary file. Leave out a section with nothing to say rather than writing "N/A"; never leave a heading empty. Beyond what the template's comments say:

- **Lead**: one to three sentences before the first heading. Someone who reads only that knows what changed and whether it was verified.
- **What changed**: the files a reviewer should open first, each with what it does now, and why this way when there was a real alternative. Not every file.
- **UI**: what [ui-changes.md](ui-changes.md) produced.
- **Verification**: each command from step 2 with its result (`npm test`: N files, N tests, pass). Mark proof by kind where it isn't obvious: a test with a fake process is not a run with the real agent, and a fixture screenshot is not a manual check. "Not verified: …, because …" is a fine line to write.
- **Compatibility**: only for the one-way changes from step 3. What an existing install sees when it updates, and what a user has to do.
- **Release note**: one line per user-visible effect, each starting with its category: `Added`, `Changed`, `Fixed`, `Security` or `Development`. Write it in the changelog's voice: what the user notices, UI names in **bold**, not the implementation and not the PR title again. From `CHANGELOG.md`: "Fixed: Plans from ACP agents (such as OpenCode) show in the chat again." For a change nobody would notice (a refactor, tests only), write `None: <reason>`.

End the body with any attribution line your tools require.

## 7. Push, open, and read it back

```sh
git push -u origin HEAD
gh pr create --base main --title "<title>" --body-file <file>
```

Add `--draft` when a check fails or something is knowingly unfinished, and say which in the lead.

Then read the PR as GitHub stored it, because a body can be cut, mangled by shell quoting, or still hold a placeholder:

```sh
gh pr view --json url,title,body,isDraft,files
```

Check that the title and body are what you wrote, that no `<…>` placeholder, template comment (`<!-- … -->`) or empty heading is left, that the Release note section is there, that the file list holds nothing unexpected, and that every image link loads (`curl -sIL <url>` ends in `200`). Fix with `gh pr edit` and check again.

Report the PR's URL, the checks and their results, anything not verified, and any decision or docs entry you added. Do not merge it, approve it, or ask for the ruleset bypass.
