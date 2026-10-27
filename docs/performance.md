# Performance with many agents

Foreman is built to run 10 to 12 agents at once. This page covers what each running agent costs, the rules the app follows to stay responsive under that load, the settings that limit it, and the tests that fail if those rules break.

## What a running turn costs

Most of the cost of a running agent is in the agent's own processes. Foreman's share is small next to it.

| Per running turn | Notes |
| --- | --- |
| The agent CLI | For Claude Code, `claude.exe` used about **600 MB of private memory** per turn (measured on one Windows machine). Codex, Cursor and OpenCode have their own processes. |
| Foreman's MCP bridge | Turns that take MCP servers get `foreman-app` and integration servers through `out/main/bridge.js` (`src/cli/bridgeMain.ts`). It loads only the socket bridge, not the CLI's commands, settings or translations, so it stays small. Claude turns in the app get `foreman-app` in-process instead, so they start no bridge for it. |
| The user's own MCP servers and hooks | Claude turns load settings with `settingSources: ['user', 'project', 'local']`, so **every turn** starts the MCP servers and runs the hooks from the user's own Claude settings and plugins. With 12 agents running, that is 12 copies of each server. |
| Background work | Claude Code keeps a turn and its agent open while background shells or subagents run. |

Two things measured on one Windows machine:

- **Hooks are slow to start on Windows.** Each hook ran through Git Bash and took about **1.3 s** to spawn. A hook that runs on every tool call adds that to each call in every agent.
- **`npx -y <server>@latest` MCP servers** resolve and download the package again for each process. With one copy per turn, that adds network traffic, disk activity and start-up CPU for every agent.

What helps users with many agents:

- Remove heavy hooks and MCP servers from user-level Claude settings (`~/.claude/settings.json` and plugins), or move them into the projects that need them.
- Pin MCP servers to an installed version (a global install, or `npx <server>@1.2.3`) instead of `npx -y …@latest`.
- Set **Maximum agents running at once** (below) to a number the machine's memory can hold.

## Design rules

The Phase 1 and 2 changes follow these rules. New code should follow them too.

1. **Batch notifications.** The renderer store applies events from main straight away, but components hear about them at most once per animation frame. A timer covers frames when none run (`flushStore` in `src/renderer/src/store.ts`). Anything the user does shows at once. Main coalesces state broadcasts into one per microtask, and sends nothing when the snapshot did not change (`broadcastState` and `flushState` in `src/main/core.ts`).
2. **Reuse unchanged snapshot objects.** The renderer reconciles each new snapshot with the previous one (`shareUnchanged` in `src/shared/reconcile.ts`). Unchanged workspaces, sessions and settings keep the same objects, so memoized views skip them.
3. **Stream with appends.** After the first preview of a streaming block, main sends only the new text (`chat-append`, `src/shared/chatAppend.ts`). The whole block is sent again every `RESYNC_MS` (2 s) and once it is saved. Agents send at most one preview per item every 50 ms (`src/main/agents/previewThrottle.ts`).
4. **Do no per-event work in hidden views.** A workspace or chat tab that is not on screen stays mounted but holds what it last read (`useHeldStore`, `src/renderer/src/heldStore.ts`). Its transcript and composer sit in a hidden `Activity`. Transcript rows are memoized, so finished rows never render again. `useT` reads the locale from one `LocaleProvider`, so rows do not add store subscriptions. The streaming reply's Markdown renders at most every 300 ms.
5. **Pause when the window is hidden.** When the window is minimized or hidden, the store stops notifying components, and clocks and endless animations stop (`src/main/windowVisibility.ts`, `useClock`). Terminal output is batched per 16 ms (`src/main/pty.ts`).
6. **Limit git and share working-tree snapshots.** Local, CPU-bound git commands run at most `GIT_CONCURRENCY` at once. A read that is already running with the same arguments is shared (`src/main/git.ts`). Diff, checks and turn-end checkpoints share a recent working-tree snapshot (`src/main/checkpoints.ts`). The diff refreshes on events instead of polling.
7. **No synchronous child processes on main.** Use the async helpers. For example, gh account resolution is async and bounded (`Environment.githubReady`).

## Settings

Both settings are on **Settings → Advanced**, and both can be changed from the CLI with `foreman settings`.

- **Maximum agents running at once** (`advanced.max-running-agents`, default 0 = no limit). Over the limit, new turns wait and start oldest first as running ones finish (`src/shared/agentSlots.ts`, `SessionService.admitWaiting`). Turns in remote workspaces do not count.
- **Stop waiting for background tasks** (`advanced.background-wait-minutes`, default 0 = never). After a Claude Code turn has answered, its agent stays open only this long for background shells and subagents. Then the turn ends and that work stops.

## Benchmarks

Two Vitest load tests check these rules. Both are deterministic: they use a simulated clock and frames that run when the test says, and they never assert wall-clock time. They run with `npm test`, or on their own:

```sh
npx vitest run tests/perfParallelAgents.test.ts tests/perfRenderer.test.tsx --silent=false
```

`--silent=false` prints the `[perf]` lines with the measured numbers. The values below were measured when the tests were added.

**`tests/perfParallelAgents.test.ts` (main).** A real `Core` with 12 git repositories and a fake agent driver. Each turn streams 20 KB (four 5 KB blocks in 25-character previews, 50 ms apart) with three tool calls. Every event is counted at the Host broadcast.

| Measure | Measured | Budget |
| --- | --- | --- |
| Previews sent as appends | 9,360 of 9,600 (240 whole) | whole sends ≤ one per block per `RESYNC_MS` |
| Reply text carried by chat events | 4.0× the text (1× appends, 2× resyncs, 1× saved) | < 6× |
| Envelope per chat event | 154 bytes | < 256 bytes |
| Chat event bytes | 2.4 MB (whole previews would carry 23 MB of text) | < 1/5 of whole previews |
| State broadcasts while streaming | 4, for 48 usage changes in 4 frames | ≤ 2 per frame with a real change, + 2 |
| Largest single event | 32 KB (the 12-workspace snapshot) | < 256 KB |

**`tests/perfRenderer.test.tsx` (renderer, jsdom).** The real renderer store, fed through the bridge handler. It renders 12 chats with 20 finished turns each, one on screen, and streams 3,000 events over 240 frames.

| Measure | Measured | Budget |
| --- | --- | --- |
| Hidden chats: chat, reply and composer renders | 0 | 0 |
| Chat on screen: renders per frame | at most 1 (240 in 240 frames) | ≤ 1 |
| Streaming reply's Markdown renders (12 s) | 47 | ≤ 4 per second + 8 |
| Finished replies and tool calls drawn again | 0 of 240 and 0 of 240 | 0 |
| Store subscriptions, 2 vs 40 turns per chat | 88 and 88 | equal, and < 10 per chat |

If one of these tests fails, find which rule above the change broke. Do not raise the budget. The composer in the chat on screen still renders along with its chat on each streamed frame (240 times here) because it is not memoized. That is within budget and a possible next step.
