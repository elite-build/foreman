# Contributing

Read [README.md](README.md) for setup and [AGENTS.md](AGENTS.md) for development conventions. Use a fork and a focused pull request. Explain the problem, the resulting behavior, and how you tested it, using the headings of the [pull request template](.github/pull_request_template.md). End with a one-line release note, or `None` and why: release notes are written from them. A UI change shows the screen before and after (`npm run pr:screens`).

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run check:repository`, and the checks relevant to your change. UI changes must follow [the design system](docs/design-system.md) and pass `npm run check:ui`. MCP and settings changes must pass `npm run check:mcp`. There is no CI, so run these checks yourself; `npm run check:security`, `npm audit --audit-level=high` and `npm run check:licenses` cover secrets, dependencies and dependency licenses. A tool failure is a failed check.

Do not commit credentials, local application data, internal planning records, mockups or generated build output. A branch may carry design mocks (`mocks/`, `mockups/`, `mock*.html`) while you work on it, but the `.githooks/pre-push` hook refuses to push a commit that still holds one, so none reaches a pull request or `main`: take them out with `git rm -r --cached` before you push. Use synthetic test data. Keep third-party copyright notices, license texts and attribution intact; identify the source and license of new external material in your PR.

Changes reach `main` only through a pull request approved by a maintainer with write access; the GitHub ruleset that enforces this is described in [maintenance controls](docs/maintenance.md). This repository does not supply CODEOWNERS or ruleset files. Dependency and security-boundary changes still need careful human inspection. So do build scripts, `package.json`'s `build` section and `.github/workflows/`: they decide what goes into a signed release, and their review is part of the [code signing policy](CODE_SIGNING.md).

## Releases

Only maintainers make releases, from `main`, and every step is in [Releases](docs/maintenance.md#releases):

1. **Version.** `npm run release -- prepare <patch|minor|major|x.y.z>` on a branch bumps the version. The release notes from the pull requests merged since the last release go into `CHANGELOG.md` in the same pull request, which is reviewed and merged like any other.
2. **Tag.** `npm run release -- tag --push` tags the merged commit on `main` as `v<version>`.
3. **Build.** `gh workflow run release.yml --ref v<version>` starts the **Release** workflow. It checks that the tag names `package.json`'s version and is on `main`, then builds the installers on GitHub-hosted runners with the **Installers** workflow. The macOS app is signed with Apple's Developer ID and notarized. The Windows app and installer are signed through SignPath once that is set up, each signing request approved by a maintainer in SignPath, and checked with SignTool. The workflow then attaches the installers, the update files and `SHA256SUMS.txt` to a **draft** GitHub release. Any failed check or signature stops it before a draft exists.
4. **Publish.** A maintainer reviews the draft's notes and assets, then publishes it. Installed copies offer the new version from then on.

Nothing is released from a developer's computer, and contributors' pull requests never run the release workflows or reach signing credentials: both workflows run only when a maintainer starts them.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in Foreman are provided under the [Apache License 2.0](LICENSE), as described in section 5 of that license. Submit only material you have the right to contribute, and preserve the separate terms and attribution of third-party material described in [NOTICE](NOTICE).

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not include sensitive data in public issues or pull requests.
