# opencode fixtures

`recorded` traffic of a real `opencode serve` (OpenCode 1.19.6, on its free `opencode/big-pickle`; docs/agents.md, sections 3.3 and 9.1): each request and answer, each server-sent event and the end of the event stream, as `src/main/agents/fixtures/tee.ts` writes them. `npm run record:agent -- opencode <scenario>` records one again (`OPENCODE_BIN` names the binary when it isn't on PATH); the plans are in `../record.ts`. `tests/replay/opencode.test.ts` and `tests/agentCapabilityProof.test.ts` play them.
