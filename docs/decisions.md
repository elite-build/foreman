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
