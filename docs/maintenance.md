# Maintenance controls

Merge restrictions are deferred until the open-source phase at the owner's request. The proposed CODEOWNERS and branch/tag ruleset files have been removed from this change. CI continues to run and report failures, but this source configuration does not make checks or a specific review mandatory for merging. GitHub repository permissions and any separately configured remote rules remain independent of these files.

Keep the source private until the owner approves publication and the outstanding provenance, dependency licensing, security and platform checks are complete. The project's original code uses Apache License 2.0; third-party material retains its separate terms. See [LICENSE](../LICENSE), [NOTICE](../NOTICE) and the [workspace names attribution](workspace-names.md). Selecting a project license does not complete the dependency/source-rights review.

The single CI workflow runs on every PR, including drafts, base-branch edits and label changes, and `main`/release branch pushes. Its `CI result` aggregate reports success only when every dependency job succeeds; missing, failed, skipped or cancelled jobs produce a failed result. This aggregate reports CI health, not merge authorization.

| CI check | What it validates |
| --- | --- |
| Types | Strict TypeScript checking |
| Validate / Windows / Node 22 | Full ordinary test suite and build |
| Validate / Windows / Node 24 | Full ordinary test suite and build |
| Validate / macOS / Node 22 | Full ordinary test suite and build |
| Validate / macOS / Node 24 | Full ordinary test suite and build |
| Design system | UI, accessibility, contrast, i18n and new-component rules |
| MCP coverage | MCP and settings checks |
| Security | Secret scans, workflow validation and dependency audit rejecting high/critical advisories |
| Publication policy | Repository/CI policy regression tests, source policy and dependency license review |
| CI result | Every CI job completed successfully |

These jobs use disposable hosted runners, read-only tokens, immutable action revisions, no persisted checkout credentials and no cache or artifact handoff. Installs disable lifecycle scripts; only the platform jobs explicitly rebuild the PTY dependency. Live cloud tests remain opt-in and must never receive credentials in fork jobs.

Gitleaks scans the checked-out source and reachable Git history with redacted output. Its exceptions match only specific synthetic fixture secrets, never an entire test directory. Actionlint validates workflow syntax, the repository guard checks workflow policy, npm audit rejects high/critical dependency advisories, and license checks reject unreviewed licenses or changed package evidence. The source dependency inventory uses exact-version, integrity-bound reviews and retained notices; it does not clear installer redistribution. Run `npm run check:licenses:distribution` for the separate distribution findings, documented in [dependency licenses](dependency-licenses.md). These tools do not certify IPC, local CLI permissions, authentication, webviews, mobile access, sandbox execution or source provenance.

Do not mask a failing check to obtain a green result. Investigate installation, network and tool errors as failures. Human review remains necessary: a PR can change the workflow, guard or tests that produce its own check results. The repository guard checks CI and source policy; it does not require a code owner or branch-protection rules.

Before publication, separately verify: the private vulnerability-reporting channel works; Actions defaults are read-only and fork runs require approval for all external contributors; allowed actions match the pins; Actions cannot create/approve PRs; no self-hosted runner, release credential or privileged workflow runs untrusted code; log/artifact retention and spending limits are approved. Security add-ons and settings are not enabled by committing these files.

Revisit merge restrictions as a separate step during open-source preparation. Confirm the intended approver, owner-authored PR process, supported GitHub plan, actual CI context names and writer access before proposing new rules. GitHub prohibits authors from approving their own PRs, so an exclusive-owner policy needs an explicit decision about that workflow. Install any future ownership file on the base branch, apply the reviewed rules remotely and test their effective behavior before claiming enforcement. See [review restrictions](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews), [CODEOWNERS behavior](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) and [ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

New repositories start from a reviewed source snapshot with fresh history. Do not mirror or push this private repository's old branches, tags, PR refs, logs or internal review material into the public destination. Local file deletion does not delete Git history or historical Actions runs. A new destination needs its own inventory and controls before any visibility change. Existing linked worktrees keep pointing at the private source.

GitHub references: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use), and [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
