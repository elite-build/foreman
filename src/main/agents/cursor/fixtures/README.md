# cursor fixtures

`simulated` traffic of the worker process's IPC events (docs/agents.md, section 9.1), recorded from Cursor's SDK replaced by a fake under the worker's own message loop (`src/main/agents/fixtures/fakes.ts`, `cursorSdkFake.ts`) by `npm run record:agent -- simulated`: `plain`, `interrupt` (`run.cancel()`, the run ends `cancelled`) and `resume`. No Cursor API key was available where this was built. `tests/replay/simulated.test.ts` plays them.
