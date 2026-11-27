---
name: create-release
description: Use this skill when the user asks you to cut, make, ship or publish a release of Foreman, or to bump its version for one. It runs the whole release - choosing the version, collecting the release notes from merged PRs into CHANGELOG.md, the version-bump PR, the tag, the Release workflow's builds, the draft release's notes and assets, and publishing - and picks up where an earlier run stopped. Not for opening an ordinary PR, building test installers for a branch, or changing the release tooling itself.
---

# Cut a release

A release is a version in `package.json`, an annotated `v<version>` tag on a commit of `main`, and a published GitHub release for that tag. "Releases" in [docs/maintenance.md](../../../docs/maintenance.md) is the source of truth: read it first, and follow it where it disagrees with this file. Publishing is what installed copies see: within hours they offer the new version in the sidebar and show the release's text in **What's new**. Write the notes for those users.

Run this only when the user has asked for a release. Asking for one is asking for the version bump, the tag, the Release workflow and publishing. Two steps still need the user's word at the moment they happen, unless the request already said so in as many words:

- **Merging the bump PR** (step 6). `main` needs an approval, and AGENTS.md allows merging with the admin bypass only when asked.
- **Publishing** (step 10), whenever anything in the run deviated from this file: a failed or skipped check, a note you had to write without a source, a rerun build, a policy you weren't sure of.

Before the first command, write a checklist of the steps below and keep it current until step 11 is done. Commands are POSIX shell; on Windows use the Bash tool, or translate them.

## 1. Find out where the release stands

```sh
git fetch --quiet origin main --tags
git status --short
git log --oneline origin/main..HEAD
git tag --list 'v*' --sort=-v:refname | head -3
git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version"
gh release list --limit 3
gh pr list --state open --search 'Release in:title' --json number,title,url
```

Call the newest tag `v<last>` and `origin/main`'s version `<main>`. Then continue from the first step that isn't done:

| What you see | Continue at |
| --- | --- |
| An open `Release <version>` PR | Step 6 |
| `<main>` is newer than `<last>` and has no tag | Step 7 (a bump merged but wasn't tagged) |
| `v<main>` exists but has no GitHub release | Step 8 |
| `v<main>` has a **draft** release | Step 9 |
| `v<main>` has a published release | Step 2: a new release |

For a new release the tree must be clean and the branch must hold nothing beyond `origin/main`, because the bump PR carries only the bump and the changelog (`npm run release -- prepare` refuses a dirty tree and `main`). If the branch is behind, `git merge --ff-only origin/main`; if it carries other work, stop and tell the user. Don't rename the branch.

Also check that `gh auth status` succeeds; every later step needs it.

Done when you know which step you're on and why.

## 2. Collect the release notes

Every PR merged since `v<last>` carries a `## Release note` section in its body ([decisions](../../../docs/decisions.md), "Each pull request carries its release note"). `main` takes squash merges, so each commit subject ends in `(#<number>)`:

```sh
git log --format=%s v<last>..origin/main
gh pr view <number> --json number,title,body,url
```

Read each PR's whole body, not just its note. Its lines under `## Release note` start with a section: `Before you update:`, `Security:`, `Fixed:`, `Added:`, `Changed:` or `Development:` (older PRs use only the last five). They are a starting point. The lead, **Why**, **What changed** and **Compatibility** say what the user actually sees.

- Skip `None: …` notes and the previous `Release <version>` PR.
- A commit without a PR number, or a PR without a Release note section: write a note from its title and body in the same voice, and list it in your report as written by you.
- **Put each note in the section a reader needs it in**, whatever the PR chose. Anything the user has to act on goes in **Before you update**: a **Compatibility** section that asks something of the user, a habit that stops working, a setting that resets. A change to approvals, permissions, credentials or what leaves the computer goes in **Security**, even when the PR called it `Fixed`.
- **One bullet per effect.** Split a note that packs several effects into one bullet for each, in their own sections, each citing the PR. Merge notes from several PRs that describe the same effect into one bullet citing every PR. A bullet is one or two short sentences. If it needs three, it's probably two effects.
- **Changed behaviour says before, now and what to do.** Say what it did before and what it does now. Give an example when the rule alone is hard to picture, and say what to do when the user has to act. A security fix links its CVE or advisory when there is one and says who is affected.
- Edit them as one document, not a pile of lines: keep what the user notices, keep UI names in **bold**, and don't add anything no PR says.

If nothing is user-visible (only `None` notes), tell the user and ask whether to release anyway.

Done when every merged PR is accounted for: in a note, merged into one, or skipped with its reason.

## 3. Choose the version

Use the bump or version the user asked for. Otherwise use `patch`, as every 1.0.x release so far has, and say so in your report; when the notes add something large, propose `minor` and ask. A version with a suffix (`1.1.0-beta.1`) becomes a GitHub prerelease, offered only to copies on the Beta channel.

## 4. Bump the version and write the changelog

```sh
npm run release -- prepare <patch|minor|major|x.y.z>
```

It sets the version in `package.json` and `package-lock.json` and nothing else. Then add the release to the top of [CHANGELOG.md](../../../CHANGELOG.md), above the newest entry, in its existing format:

```md
## <version> (<YYYY-MM-DD, today>)

### Fixed

- <note> ([#81](https://github.com/elite-build/foreman/pull/81))
```

Sections go in this order, each only when it has a note: `Before you update`, `Security`, `Fixed`, `Added`, `Changed`, `Development`. Entries up to 1.2.12 use the earlier order (`Added`, `Changed`, `Fixed`, `Security`, `Development`); leave them as they are. If the newest entry in `CHANGELOG.md` isn't `<last>`, earlier releases are missing from it: don't backfill them unasked, but mention the gap in your report.

Commit both with the repository's subject for it:

```sh
git commit -am "Release <version>"
```

## 5. Read main's checks and open the bump PR

Run no checks locally. The bump PR changes only the version fields and `CHANGELOG.md`, every commit on `main` passed CI's whole suite on its own PR, and CI runs the suite once more on the bump PR (step 6). Nightly covers the rest on `main`: macOS, Node 22, `check:security`, `npm audit --audit-level=high`, `check:repository` and `check:licenses`. Read its latest run, and whether a dependency changed since:

```sh
gh run list --workflow nightly.yml --branch main --limit 1 --json databaseId,conclusion,headSha,createdAt,url
git log --oneline <headSha>..origin/main -- package.json package-lock.json
```

- Nightly passed and the log prints nothing: write down the run's date and URL, and go on.
- Nightly failed: show the user which jobs failed and why (`gh run view <databaseId> --log-failed`, the lines that say why), and ask whether to release anyway. A failure already on `main` is reported, not fixed here.
- The log prints a commit (a dependency changed since that run): start Nightly on `main` now with `gh workflow run nightly.yml --ref main` and carry on; step 7 reads its result before tagging.

Open the PR as [create-pr](../create-pr/SKILL.md) steps 6 and 7 describe, with:

- **Title**: `Release <version>`.
- **Lead**: the version, and that only the version fields and `CHANGELOG.md` change.
- **What changed**: the new `CHANGELOG.md` entry, quoted, so the reviewer approves the notes as well as the bump.
- **Verification**: the Nightly run relied on (date, URL, result), and that CI runs the whole suite on this PR.
- **Compatibility**: that the release carries the installers and update files (step 9), so installed copies can update themselves.
- **Release note**: `None: release bump; its notes are the CHANGELOG.md entry it adds.`

Read it back with `gh pr view` as create-pr says.

## 6. Merge the bump

CI has to pass first; the Require CI ruleset has no bypass. Watch it with `gh pr checks <number> --watch --fail-fast` in the background (about five minutes). If it fails, read the log (`gh run view <run> --log-failed`) and rerun a test that failed only under load on its own; a real failure is on `main` too, so stop and tell the user.

`main` needs one approval, and GitHub doesn't let authors approve their own PRs. Unless the request already said, ask the user whether to:

- wait for someone else's approval, then merge; or
- merge now with the admin bypass.

Then merge it the way `main` takes every PR:

```sh
gh pr merge <number> --squash            # after an approval
gh pr merge <number> --squash --admin    # the bypass, only on the user's word
```

If the user chooses to wait, stop here and say that running this skill again after the merge picks up at step 7.

## 7. Tag the merged version

If step 5 started Nightly, read it first (`gh run list --workflow nightly.yml --branch main --limit 1 --json databaseId,status,conclusion,url`, and `gh run watch <databaseId>` while it runs). If it failed, show the user why and ask whether to release anyway.

```sh
npm run release -- tag --push
```

It fetches `origin/main`, refuses a version that is already tagged or older than the newest tag, tags `origin/main` as `v<version>` and pushes the tag. Check the tag is the bump PR's merge:

```sh
git rev-parse 'v<version>^{commit}'
gh pr view <number> --json mergeCommit --jq .mergeCommit.oid
```

Never move or delete a pushed tag yourself. If one is wrong, stop and tell the user (docs/maintenance.md says how it's deleted by hand).

## 8. Build the draft release

```sh
gh workflow run release.yml --ref v<version>
gh run list --workflow release.yml --branch v<version> --limit 1 --json databaseId,status,url
gh run watch <run-id> --exit-status
```

The run takes from 15 minutes to over an hour (macOS notarization waits for Apple), so start `gh run watch` in the background and carry on when it ends. The run verifies the tag, builds both installers with the macOS app Developer ID signed and notarized, and creates a **draft** release with generated notes and every asset. When the repository variable `SIGNPATH_SIGNING` is `true`, the Windows job also makes two SignPath signing requests, `Foreman.exe` and then the installer, and each waits up to an hour for an approver. Tell the user as soon as the Windows job reaches them, so they can approve both in SignPath; you can't approve them. Otherwise the run's summary warns that the Windows installer is unsigned, which is expected until signing is turned on (CODE_SIGNING.md).

If it fails, read `gh run view <run-id> --log-failed`:

- Transient (a runner or network error, stapling failing on every attempt): `gh run rerun <run-id> --failed`, once.
- A SignPath request rejected or not approved within the hour: ask the user before rerunning the failed jobs, which makes new requests to approve.
- Missing or wrong signing secrets or SignPath settings, a failed signature check, or a build error: stop and report it. A fix goes through an ordinary PR, and the release becomes a new patch version; the tag stays where it is.
- "already has a release": a release for this tag exists. Look at it (`gh release view v<version>`) and continue at step 9 if it's this tag's draft; don't delete one without asking.

## 9. Edit the draft

**Notes.** Replace the generated list of PR titles with the `CHANGELOG.md` entry from step 4, without its `## <version>` heading and without its `### Development` section: installed copies show these notes in **What's new**, and those lines are for contributors, who read `CHANGELOG.md`. If `Development` was the entry's only section, the notes are `Nothing changes for users in this release; see CHANGELOG.md for what changed for contributors.` Add these after it when they apply:

- `## Known validation findings`: each check that failed in step 5 that the user chose to release with, in a sentence.
- `**Full changelog**: https://github.com/elite-build/foreman/compare/v<last>...v<version>`

Write it to a temporary file as UTF-8 **without a BOM**, with LF line endings: PowerShell's `>` and `Out-File` add a BOM, and it ends up in **What's new**. Use the Write tool or a shell heredoc. Keep it under 20,000 characters, where the app cuts notes off (`MAX_NOTES` in `src/shared/appUpdate.ts`).

```sh
gh release edit v<version> --notes-file <file>
```

**Assets.** Installers are cleared for distribution (step 4 of "Releases" in docs/maintenance.md), so keep every asset the workflow attached and delete none: the DMG, the Windows installer, the macOS zip, the blockmaps, `latest.yml`, `latest-mac.yml` and `SHA256SUMS.txt`. An installed copy updates from `latest*.yml` and the installers they name, so a release without them stops self-updating. Compare the asset names with the previous release's (`gh release view v<last> --json assets --jq '.assets[].name'`); if one is missing, or maintenance.md no longer says installers are cleared, stop and ask before publishing. GitHub adds the tag's source archives to every release by itself.

Then read the draft back:

```sh
gh release view v<version> --json name,tagName,isDraft,isPrerelease,body,assets
gh release view v<version> --json body --jq .body | head -c 3 | od -c
```

Check that the name is `Foreman <version>`; it's still a draft; it's a prerelease exactly when the version has a suffix; the body starts with your first heading, not a BOM, holds no generated "What's Changed" list or placeholder, and its notes match the `CHANGELOG.md` entry without its `Development` section; and every asset is still attached.

## 10. Publish

Before publishing, say in two or three lines what is about to go out: the version, the notes' headings, the assets attached, and anything that deviated. Ask first if anything did (see the top of this file).

```sh
gh release edit v<version> --draft=false --latest     # a release
gh release edit v<version> --draft=false              # a prerelease
```

Check that it landed:

```sh
gh release view v<version> --json isDraft,url,publishedAt
gh api repos/elite-build/foreman/releases/latest --jq .tag_name    # v<version>, unless a prerelease
```

## 11. Report

Report the release's URL, the version and the bump PR, the checks and their results, how the bump PR was merged (approval or bypass), the build run's URL and any rerun, the assets it went out with, the notes you wrote without a PR note, and anything still open (a gap in `CHANGELOG.md`, a failing check released anyway).
