# opencode fixtures

`simulated` ACP traffic (docs/agents.md, section 9.1), recorded from the ACP conformance fake (`src/main/agents/fixtures/fakes.ts`) by `npm run record:agent -- simulated`: `plain`, `approval`, `question`, `terminal`, `interrupt`, `crash` and `resume`, and `version1` and `version2`, a plain turn from an OpenCode that says it is 1.14.3 or 2.1.0 (one server per chat, or per account; the 2.x recording ends with its server still up). OpenCode was not installed where this was built. `tests/replay/simulated.test.ts` plays them.
