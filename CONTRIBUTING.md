# Contributing

Read [README.md](README.md) for setup and [AGENTS.md](AGENTS.md) for development conventions. Use a fork and a focused pull request. Explain the problem, the resulting behavior, and how you tested it.

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run check:repository`, and the checks relevant to your change. UI changes must follow [the design system](docs/design-system.md) and pass `npm run check:ui`. MCP and settings changes must pass `npm run check:mcp`. CI also scans secrets, dependencies and dependency licenses. A tool failure is a failed check.

Do not commit credentials, local application data, internal planning records, mockups or generated build output. Use synthetic test data. Keep third-party copyright notices, license texts and attribution intact; identify the source and license of new external material in your PR.

Merge restrictions are deferred until the open-source phase. CI continues to report test, build and security results; this repository does not currently supply CODEOWNERS or ruleset configuration to make those results or a specific approval mandatory for merging. Workflow, dependency and security-boundary changes still need careful human inspection. See [maintenance controls](docs/maintenance.md).

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in Foreman are provided under the [Apache License 2.0](LICENSE), as described in section 5 of that license. Submit only material you have the right to contribute, and preserve the separate terms and attribution of third-party material described in [NOTICE](NOTICE).

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not include sensitive data in public issues, pull requests or CI output.
