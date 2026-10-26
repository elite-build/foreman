# Maintenance controls

Merge restrictions are deferred until the open-source phase at the owner's request. The proposed CODEOWNERS and branch/tag ruleset files are not included in this repository. CI continues to run and report failures, but this source configuration does not make checks or a specific review mandatory for merging. GitHub repository permissions and any separately configured remote rules remain independent of these files.

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

These jobs use disposable hosted runners, read-only tokens, immutable action revisions, no persisted checkout credentials and no cache or artifact handoff. Installs disable lifecycle scripts; only the platform jobs explicitly rebuild the PTY dependency and then run the repository's own `scripts/postinstall.mjs`, which restores the execute bit node-pty's macOS prebuilds omit from `spawn-helper` (without it every terminal fails with `posix_spawnp failed`). Live cloud tests remain opt-in and must never receive credentials in fork jobs.

Gitleaks scans the checked-out source and reachable Git history with redacted output. Its exceptions match only specific synthetic fixture secrets, never an entire test directory. Actionlint validates workflow syntax, the repository guard checks workflow policy, npm audit rejects high/critical dependency advisories, and license checks reject unreviewed licenses or changed package evidence. The source dependency inventory uses exact-version, integrity-bound reviews and retained notices; it does not clear installer redistribution. Run `npm run check:licenses:distribution` for the separate distribution findings, documented in [dependency licenses](dependency-licenses.md). These tools do not certify IPC, local CLI permissions, authentication, webviews, mobile access, sandbox execution or source provenance.

One dependency override answers an audit finding: `package.json` pins `@vercel/oidc` to 3.2.0 for `@vercel/sandbox` only. Every `@vercel/oidc` from 3.6.0 depends on `@vercel/cli-config`, and every `@vercel/cli-config` release through 0.3.3 pins `zod` 4.1.11 and bundles it into its entry point, which is affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (fixed in 4.6.6). Because the copy is bundled, overriding `zod` would only hide it from `npm audit`. `@vercel/sandbox` 3.6.1, the downgrade `npm audit fix --force` suggests, would avoid the chain but predates the command stdin API that `vercelProvider.ts` uses (3.7.0). `@vercel/sandbox` 3.9.0 imports only `getVercelOidcToken({ team, project, expirationBufferMs })` from `@vercel/oidc`, the same calls 3.6.1 made against 3.2.0. Foreman passes an access token with team and project explicitly, so the SDK never asks `@vercel/oidc` for credentials. The tradeoff: if an OIDC token (a JWT) is passed and it expires, 3.2.0 refreshes only from the Vercel CLI's file-stored login, not a keychain-stored one, and the SDK then keeps the expired token. `tests/vercelSdk.test.ts` checks the SDK still finds every OIDC function it imports and still sends Foreman's token. Remove the override once a `@vercel/sandbox` release resolves to a `@vercel/cli-config` built with zod 4.6.6 or later ([vercel/vercel#17678](https://github.com/vercel/vercel/issues/17678)), and check it again whenever `@vercel/sandbox` changes.

Do not mask a failing check to obtain a green result. Investigate installation, network and tool errors as failures. Human review remains necessary: a PR can change the workflow, guard or tests that produce its own check results. The repository guard checks CI and source policy; it does not require a code owner or branch-protection rules.

Before publication, separately verify: the private vulnerability-reporting channel works; Actions defaults are read-only and fork runs require approval for all external contributors; allowed actions match the pins; Actions cannot create/approve PRs; no self-hosted runner, release credential or privileged workflow runs untrusted code; log/artifact retention and spending limits are approved. Security add-ons and settings are not enabled by committing these files.

### GitHub settings observed on 2026-10-26

Read through the GitHub REST API by an organization admin while `elite-build/foreman` was private, on the organization's free plan. The token lacked `admin:org`, so organization-level Actions policy, runners, runner groups and secrets could not be read. Settings can change; read them again immediately before and after any visibility change.

| Setting | Observed | Before or after publication |
| --- | --- | --- |
| Default workflow token | Read only; `ci.yml` also sets `contents: read` | Keep |
| Actions can create or approve PRs | Not allowed | Keep |
| Allowed actions | All actions and reusable workflows; SHA pinning not required by the setting | Owner decision: restrict to the two pinned actions and require SHA pinning, then confirm CI and Dependabot updates still run. Until then only the source guard enforces the pins |
| Fork PR workflows (private-repository setting) | Not run; no write tokens, secrets or variables sent; forking disabled | Superseded by the public-repository approval setting |
| Approval for fork PR workflows from outside contributors | Unavailable while private (API: not allowed for private repositories) | After the visibility change and before any outside PR, set and confirm **Require approval for all external contributors** |
| Self-hosted runners | None registered to the repository; organization runners and runner groups not readable | Owner confirms none can reach this repository. CI uses GitHub-hosted labels only and the guard rejects `self-hosted` |
| Secrets, variables, environments | None in the repository (Actions or Dependabot); organization secrets not readable | Owner confirms organization secrets are not shared with this repository |
| Log and artifact retention | 90 days (maximum 90) | Owner approves; CI uploads no artifacts |
| Actions spending limit | Not checked | Owner decision |
| Private vulnerability reporting | API returned 404 while private, so its state is unknown, not shown as disabled. GitHub documents the setting for public repositories | After the visibility change, enable it, confirm the API reports it enabled and that **Report a vulnerability** appears to a non-maintainer |
| Dependabot | Version updates configured and running; alerts and automated security fixes disabled | Owner decision |
| Secret scanning, push protection | Not reported for this private repository | Owner decision after the visibility change |
| Rulesets | Unavailable: API requires GitHub Pro or a public repository | Deferred with merge restrictions |
| Access | One organization member (admin); no outside collaborators, teams, invitations, deploy keys or webhooks; organization two-factor requirement off | Owner decision on requiring two-factor authentication |

Revisit merge restrictions as a separate step during open-source preparation. Confirm the intended approver, owner-authored PR process, supported GitHub plan, actual CI context names and writer access before proposing new rules. GitHub prohibits authors from approving their own PRs, so an exclusive-owner policy needs an explicit decision about that workflow. Install any future ownership file on the base branch, apply the reviewed rules remotely and test their effective behavior before claiming enforcement. See [review restrictions](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews), [CODEOWNERS behavior](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) and [ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

This repository started from a reviewed source snapshot with fresh history: on 2026-10-26 every branch, pull-request ref and Dependabot branch descended from the single root commit `bbef7f3`, and there were no tags. Do not push the earlier repository's branches, tags, PR refs, logs or internal review material into it. Local file deletion does not delete Git history or historical Actions runs.

GitHub references: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use), and [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
