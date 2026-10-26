# Maintenance controls

`main` is protected by the repository ruleset **Protect main**, configured on GitHub rather than in this repository. Every change reaches `main` through a pull request with one approval from someone with write access, which is currently only the owner. A new push dismisses earlier approvals, and the most recent push must be approved by someone other than its pusher. Force-pushes and deleting `main` are blocked. Repository admins may bypass the review requirement when merging a pull request, but cannot push to `main` directly: GitHub does not let authors approve their own PRs, so without the bypass the owner's PRs, and PRs agents open with the owner's account, could never merge. Anything using the owner's credentials can use that bypass, so agents must not merge unless asked. No CODEOWNERS file is supplied; with a single writer it adds nothing. Add one and require code-owner review in the ruleset before granting anyone else write access.

The owner made the repository public on 2026-10-26. Publication did not complete the outstanding provenance, dependency licensing, security and platform checks. The project's original code uses Apache License 2.0; third-party material retains its separate terms. See [LICENSE](../LICENSE), [NOTICE](../NOTICE) and the [workspace names attribution](workspace-names.md). Selecting a project license does not complete the dependency/source-rights review.

No CI workflow is configured: the GitHub Actions workflow and Dependabot configuration were removed on 2026-10-26 to start again from scratch. Nothing runs automatically on pull requests or pushes, so run the checks locally before asking for review.

The one workflow, **Installers** (`.github/workflows/installers.yml`), runs only when someone with write access starts it from the Actions tab or with `gh workflow run installers.yml --ref <branch>`. It checks nothing; it packages the chosen ref with the existing `dist:mac` and `dist:win` scripts: an Apple Silicon DMG on `macos-15` and an x64 NSIS installer on `windows-2022`. It uses a read-only token, SHA-pinned actions (checkout, setup-node, upload-artifact), a checkout without persisted credentials and a lifecycle-disabled install. It then rebuilds node-pty and runs `scripts/postinstall.mjs`, which restores the execute bit node-pty's macOS prebuilds omit from `spawn-helper` (without it every terminal in the packaged app fails with `posix_spawnp failed`). Each installer is uploaded as a run artifact that expires after 7 days. It is not a release: there is no signing identity, notarization or publishing step, so macOS Gatekeeper and Windows SmartScreen warn about the installers. On this public repository, anyone signed in to GitHub can download a run's artifacts until they expire. Installer redistribution has not been cleared (see [dependency licenses](dependency-licenses.md#installer-and-bundle-distribution)), so treat these builds as internal test builds.

| Local check | What it validates |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checking |
| `npm test` | Full ordinary test suite |
| `npm run build` | Production build |
| `npm run check:ui` | UI, accessibility, contrast, i18n and new-component rules |
| `npm run check:mcp` | MCP and settings checks |
| `npm run check:security` | Secret scans of source and history (x64 Linux and Windows) |
| `npm audit --audit-level=high` | Dependency audit rejecting high/critical advisories |
| `npm run check:repository` | Repository policy regression tests and source policy |
| `npm run check:licenses` | Dependency license review |

Gitleaks scans the checked-out source and reachable Git history with redacted output. Its exceptions match only specific synthetic fixture secrets, never an entire test directory. npm audit rejects high/critical dependency advisories, and license checks reject unreviewed licenses or changed package evidence. The source dependency inventory uses exact-version, integrity-bound reviews and retained notices; it does not clear installer redistribution. Run `npm run check:licenses:distribution` for the separate distribution findings, documented in [dependency licenses](dependency-licenses.md). These tools do not certify IPC, local CLI permissions, authentication, webviews, mobile access, sandbox execution or source provenance.

One dependency override answers an audit finding: `package.json` pins `@vercel/oidc` to 3.2.0 for `@vercel/sandbox` only. Every `@vercel/oidc` from 3.6.0 depends on `@vercel/cli-config`, and every `@vercel/cli-config` release through 0.3.3 pins `zod` 4.1.11 and bundles it into its entry point, which is affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (fixed in 4.6.6). Because the copy is bundled, overriding `zod` would only hide it from `npm audit`. `@vercel/sandbox` 3.6.1, the downgrade `npm audit fix --force` suggests, would avoid the chain but predates the command stdin API that `vercelProvider.ts` uses (3.7.0). `@vercel/sandbox` 3.9.0 imports only `getVercelOidcToken({ team, project, expirationBufferMs })` from `@vercel/oidc`, the same calls 3.6.1 made against 3.2.0. Foreman passes an access token with team and project explicitly, so the SDK never asks `@vercel/oidc` for credentials. The tradeoff: if an OIDC token (a JWT) is passed and it expires, 3.2.0 refreshes only from the Vercel CLI's file-stored login, not a keychain-stored one, and the SDK then keeps the expired token. `tests/vercelSdk.test.ts` checks the SDK still finds every OIDC function it imports and still sends Foreman's token. Remove the override once a `@vercel/sandbox` release resolves to a `@vercel/cli-config` built with zod 4.6.6 or later ([vercel/vercel#17678](https://github.com/vercel/vercel/issues/17678)), and check it again whenever `@vercel/sandbox` changes.

Do not mask a failing check to obtain a green result. Investigate installation, network and tool errors as failures. Human review remains necessary: a PR can change the guard or tests that produce its own check results. The repository guard checks source policy; it does not require a code owner or branch-protection rules.

Still to verify now that the repository is public: **Report a vulnerability** appears to a non-maintainer; no self-hosted runner, release credential or privileged workflow can run untrusted code; log/artifact retention and spending limits are approved before a new workflow is added. Security add-ons and settings are not enabled by committing these files.

### GitHub settings observed on 2026-10-26

Read through the GitHub REST API by an organization admin, first while `elite-build/foreman` was private on the organization's free plan and again after the owner made it public the same day. The token lacked `admin:org`, so organization-level Actions policy, runners, runner groups and secrets could not be read. Settings can change; read them again before relying on them.

| Setting | Observed | Follow-up |
| --- | --- | --- |
| Default workflow token | Read only | Keep |
| Actions can create or approve PRs | Not allowed | Keep |
| Allowed actions | All actions and reusable workflows; SHA pinning not required by the setting | Owner decision: restrict allowed actions to the three the Installers workflow pins (checkout, setup-node, upload-artifact) and require SHA pinning |
| Visibility, forking | Public; forking allowed (always possible for public repositories) | Keep |
| Approval for fork PR workflows from outside contributors | **Require approval for all external contributors**, set and read back after the visibility change | Keep |
| Self-hosted runners | None registered to the repository; organization runners and runner groups not readable | Owner confirms none can reach this repository |
| Secrets, variables, environments | None in the repository (Actions or Dependabot); organization secrets not readable | Owner confirms organization secrets are not shared with this repository |
| Log and artifact retention | 90 days (maximum 90) | Owner approves; the Installers workflow sets 7 days on its installers |
| Actions spending limit | Not checked. While private, every Actions job was refused to start because of failed payments or the spending limit | Owner decision. Standard GitHub-hosted runners are free for public repositories |
| Private vulnerability reporting | Enabled after the visibility change; the API reports it enabled | Confirm **Report a vulnerability** appears to a non-maintainer |
| Dependabot | Version updates were running; their configuration has since been removed. Alerts and automated security fixes disabled | Owner decision |
| Secret scanning, push protection | Disabled | Owner decision; free for public repositories |
| Rulesets | **Protect main** active on the default branch, as described at the top of this page; no branch protection rules | Keep. Test changes against a PR before relying on them |
| Access | One organization member (admin); no outside collaborators, teams, invitations, deploy keys or webhooks; organization two-factor requirement off | Owner decision on requiring two-factor authentication |

To change who can merge, edit the **Protect main** ruleset on GitHub, then read the effective rules back with `gh api repos/elite-build/foreman/rules/branches/main`. GitHub prohibits authors from approving their own PRs, so removing the admin bypass blocks every owner-authored PR until agents open PRs under a separate account. A future ownership file must be on the base branch before code-owner review takes effect. See [review restrictions](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews), [CODEOWNERS behavior](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) and [ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

This repository started from a reviewed source snapshot with fresh history: on 2026-10-26 every branch, pull-request ref and Dependabot branch descended from the single root commit `bbef7f3`, and there were no tags. Do not push the earlier repository's branches, tags, PR refs, logs or internal review material into it. Local file deletion does not delete Git history or historical Actions runs.

GitHub references: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use), and [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
