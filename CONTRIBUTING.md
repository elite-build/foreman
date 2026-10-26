# Contributing

Read [README.md](README.md) for setup and [AGENTS.md](AGENTS.md) for development conventions. Use a fork and a focused pull request. Explain the problem, the resulting behavior, and how you tested it.

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run check:repository`, and the checks relevant to your change. UI changes must follow [the design system](docs/design-system.md) and pass `npm run check:ui`. MCP and settings changes must pass `npm run check:mcp`. There is no CI, so run these checks yourself; `npm run check:security`, `npm audit --audit-level=high` and `npm run check:licenses` cover secrets, dependencies and dependency licenses. A tool failure is a failed check.

Do not commit credentials, local application data, internal planning records, mockups or generated build output. Use synthetic test data. Keep third-party copyright notices, license texts and attribution intact; identify the source and license of new external material in your PR.

Changes reach `main` only through a pull request approved by a maintainer with write access; the GitHub ruleset that enforces this is described in [maintenance controls](docs/maintenance.md). This repository does not supply CODEOWNERS or ruleset files. Dependency and security-boundary changes still need careful human inspection.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in Foreman are provided under the [Apache License 2.0](LICENSE), as described in section 5 of that license. Submit only material you have the right to contribute, and preserve the separate terms and attribution of third-party material described in [NOTICE](NOTICE).

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not include sensitive data in public issues or pull requests.
