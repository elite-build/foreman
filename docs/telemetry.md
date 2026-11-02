# Local telemetry

Foreman runs many agents at once, and the app's own cost grows with them. This page is the plan for measuring that cost on the user's computer, and the guide to the parts that exist. Nothing here leaves the computer: there is no telemetry service, no account and no upload. The numbers are for the person running Foreman and for whoever is fixing a slow build.

See [performance.md](performance.md) for the rules the app follows under load and the two load tests that guard them. This page is about *seeing* what the running app does; that one is about what it is built to do.

## Goals

1. **Answer "what is Foreman doing right now?"** without attaching a debugger: which of its processes is busy, which timers and child processes run, how often the state is rebuilt, how big it is, and whether the main thread is blocked.
2. **Attribute cost to its owner.** Foreman's own processes, each workspace's agent with the MCP servers and hooks it starts, terminals and scripts. Most of the memory on a busy machine is not Foreman's.
3. **Make it cheap enough to leave on.** Counters are integers in memory; samples are a few hundred bytes every few seconds; nothing is serialized unless someone asks. Anything heavier (a process listing on Windows, a log file) is opt-in and bounded.
4. **Turn findings into budgets.** Every fix that telemetry justifies gets a deterministic test, so it stays fixed (see "Budgets").

## What exists already

| Piece | Where | What it gives |
| --- | --- | --- |
| Resource usage line | Settings → Experimental → Show resource usage; `src/main/processUsage.ts`, `components/ResourceUsage.tsx` | CPU and memory of Foreman's own processes (`app.getAppMetrics`) and, per workspace, the memory and process count of its agents, terminals and scripts, grouped by executable. Polled every 3 s while shown; the Windows listing runs at most every 20 s. |
| Process roots | `src/main/processRoots.ts` | Every pid Foreman starts for a workspace, so a tree can be attributed. |
| Error ring | `src/main/reportProblem.ts` (`ErrorLog`) | The last 50 `console.error` lines, in memory, for Report a problem. |
| Load tests | `tests/perfParallelAgents.test.ts`, `tests/perfRenderer.test.tsx` | Deterministic budgets for streaming: appends vs whole sends, state broadcasts per frame, renders per frame, hidden chats never rendering. |
| Performance meter | `src/main/perf.ts`, `foreman app perf` | **Phase 1, this page.** Counters, timings, samples and the per-process view described below. |

Foreman writes no log of its own apart from `userData/logs/` for check runs and setup steps.

## What one busy machine showed

A five-second sample on a Windows 11 machine running the installed Foreman 1.0.3 with two Claude Code turns in progress (private bytes; CPU as a share of one core):

| Process tree | Processes | Memory | CPU |
| --- | --- | --- | --- |
| Everything under Foreman.exe | 42 | 1.9 GB | 48% |
| Foreman's own four processes (main, renderer, GPU, utility) | 4 | 412 MB | 33% |
| The two `claude.exe` turns | 2 | 1.26 GB | 10% |
| Their hooks and helpers (`bash`, `node`, `conhost`) | 33 | 185 MB | 4% |

Inside Foreman's own four: main 176 MB at 6.6%, renderer 101 MB at 12.5%, GPU process 124 MB at 14.1%. So on this machine the question "why is Foreman high?" splits into three that need different instruments: what the main process spawns and rebuilds, what the renderer re-renders, and what keeps the compositor drawing. Phase 1 answers the first and shows the split; Phase 2 answers the other two.

The hook chains (`bash → node → bash → observe.sh`, one chain per tool call per agent) come from the user's own Claude plugins, not from Foreman. The resource usage view already counts them against the workspace; the plan below makes that visible per turn.

## Where the remaining cost is

A read of every timer and per-event path (October 2026) found these, in rough order of how much they could matter. Each is paired with the measurement that will confirm or clear it.

**Main process**

- **Every state change rebuilds and stringifies the whole snapshot** (`flushState`, `src/main/core.ts`): every workspace and session including archived ones, comments, settings, templates and repository files, then `JSON.stringify` to compare with the last text. `SessionService.changed()` reaches it on each usage update, plan-mode change and turn start or end. *Measure:* `state.flush` count, `state.snapshot` and `state.stringify` timings, `state.bytes`.
- **Every store save stringifies every workspace, session and comment row** to diff them (`db.syncRows`), then writes `state.json` pretty-printed. Saves are debounced by 100 ms but `assistantMessage` saves per message. *Measure:* `store.save` count and timing.
- **Git and gh child processes.** The on-screen workspace's Git panel spawns six git processes every 10 s while a turn runs; the Checks tab takes a working-tree snapshot (temp index, `git add -A`, `write-tree`) every 20 s, and keeps doing so for a hidden workspace; the PR poller runs `gh pr view` per workspace with an open PR every 60 s. *Measure:* `git.<subcommand>` and `gh.<subcommand>` counts and timings, `git.queue` depth.
- **Timers that ignore whether anything is happening.** Schedules (30 s), limit resume (15 s), tray redraw (60 s), the phone server's stall check (60 s, which rebuilds a snapshot with fresh disk reads), the phone pill in the sidebar (8 s, `os.networkInterfaces()` each time, even with phone access off). *Measure:* `ipc.<method>` counts while idle; the "idle budget" below.
- **Main-thread stalls.** Synchronous SQLite reads and writes per chat item, `JSON.stringify` of large snapshots, synchronous `appendFileSync` per event in the agent host. *Measure:* event-loop delay p50, p99 and max per sample.

**Renderer**

- **Chats are never unloaded.** Every chat tab opened during a run stays in memory with its full item array, and each streamed event copies that array. *Measure:* loaded chats and total items, heap used.
- **Terminal scrollback is 50,000 lines per terminal by default** (`terminalScrollbackMb: 10` × 5,000), in every opened workspace, hidden ones included. *Measure:* terminals mounted and their buffer lengths.
- **Endless animations while a turn runs** (`pulse` in `styles/chat.css`, the spinner) keep the compositor busy; the GPU process at 14% while idle-looking is the clue. *Measure:* GPU process CPU in the per-process view, with and without a running turn; renderer long tasks.
- **The composer re-renders with every streamed frame** (documented in performance.md as the next step). *Measure:* renders per frame of the composer.

**Outside Foreman** (reported, not fixed here): one copy of every user-level MCP server and hook per running turn; `npx -y …@latest` servers; a 1.3 s Git Bash spawn per hook on Windows.

## Design

Four layers, each with one owner and one way out.

### Layer A: the main-process meter (Phase 1)

`src/main/perf.ts` exports one `perf` meter, as `reportProblem.ts` exports one error log.

- **Counters** `perf.count(name, n = 1)`: integers in a `Map`. Names are dotted and stable: `state.flush`, `state.broadcast`, `event.<type>`, `ipc.<method>`, `git.<subcommand>`, `gh.<subcommand>`, `store.save`, `db.putItem`, `db.readChat`.
- **Timings** `perf.time(name, ms)` and `perf.timed(name, fn)`: count, total, max per name. Same names as the counters where a duration exists.
- **Gauges** `perf.gauge(name, value)`: the latest value (`state.bytes`, `git.queue`).
- **Samples**, every 5 s while the app runs: the main process's `process.cpuUsage()` and `process.memoryUsage()`, the event-loop delay histogram (`perf_hooks.monitorEventLoopDelay`, p50/p99/max with its own 20 ms sampling interval taken off, reset per sample), and every Electron process from `app.getAppMetrics()` by type (Browser is main, Tab is the renderer, then GPU and Utility: CPU share and working set). A ring of the last 120 samples (10 minutes). Electron is reached through what `perf.start` is given in `src/main/index.ts`, so the meter and its tests never import it.
- **Report** `perf.report()`: `since`, `uptimeMs`, the latest sample, the ring, counters and timings sorted by cost. `perf.reset()` zeroes counters and timings without touching samples.
- **Reading it:** `foreman app perf` prints the report as text or `--json`; `--reset` zeroes the counters after printing, so two calls a minute apart give a rate. It is a read-tier method on the local socket, so it is always served.
- **Recording it:** while **Keep diagnostics** is on (below), each sample is also appended as one JSON line to `userData/logs/perf.jsonl` with the counter and timing deltas since the previous line: a flight recorder, so the record exists before anyone knows it is needed. A line is a few hundred bytes, about 5 MB a day; the file is capped at 20 MB and then started again (`perf.jsonl.1` keeps the previous one).
- **The stall watchdog:** when a sample's worst event-loop delay reaches 500 ms (`STALL_MS`), the meter reports a `stall` with that interval's counter and timing deltas, and the event log records it. The deltas say what main was doing when the thread stopped answering.

Instrumented in Phase 1: `flushState` (snapshot time, stringify time, bytes, whether it broadcast), `Host.broadcast` (per event type), `ipcMain.handle('foreman:invoke')` (per method, with duration), `localGit` (per subcommand, with duration and queue depth), `runGh` (per subcommand, with duration), `Store.writeState`, `ForemanDb.putItem` and `readChat`, and the process listing in `processUsage.ts`.

Cost: a `Map` lookup and an integer add per counted event; `performance.now()` twice per timed call; one `getAppMetrics` and one histogram read every 5 s.

### Evidence for a bug report

Counters answer "what is it doing now". A bug report needs what happened before, and a crash takes the process's memory with it. These parts write to disk, all under `userData/logs/`, and all governed by one switch: **Settings → Experimental → Keep diagnostics** (`diagnostics`, default on). Off, nothing below is written and Report a problem has only this session's error ring.

- **The event log, `foreman.log`** (`src/main/diagnosticsLog.ts`): one JSON line per event, `{ at, kind, ...fields }`. Kinds: `app.start` and `app.quit`; `error` (every `console.error` line, the same ones Report a problem shows); `exception` and `rejection` (uncaught in main, with the stack, recorded before Electron's dialog); `renderer.gone` and `process.gone` (a renderer, GPU or utility process that crashed or was killed, with the reason and exit code); `window.unresponsive` and `window.responsive`; `turn.start` and `turn.end` (agent, workspace, outcome, first line of the error, duration); `stall` (from the watchdog); `profile.start`, `profile.end` and `heap.snapshot`; `diagnostics.off`. Capped at 5 MB, then `foreman.log.1`. The last 500 events also stay in memory for the bundle.
- **Crash dumps.** Electron's crash reporter runs with uploads off, so a native crash of main, the renderer or the GPU process leaves a minidump under the app's `crashDumps` folder and nowhere else. The bundle lists them by name, size and time; the dumps themselves stay on the computer unless the user attaches one.
- **The diagnostics bundle** (`src/main/diagnostics.ts`, shape in `src/shared/diagnostics.ts`): one JSON file with the app and OS versions, the settings the assistant may read (never accounts, tokens or addresses), the perf report with its last ten minutes of samples, this session's events, the last 400 lines of `foreman.log` (which reach back before a crash), the last 120 lines of `perf.jsonl`, the error ring, resource usage and the crash dump list. Every string in it goes through the report's redaction (paths, user names, tokens, e-mail addresses). **Help → Report a problem → Save diagnostics…** writes it where the user chooses; `foreman app diagnostics` writes it to the current folder. GitHub issues accept `.json` attachments.
- **On-demand profiles** (`src/main/profiler.ts`): `foreman app profile [--renderer] [--seconds n]` records a CPU profile of main (Node's in-process inspector; no debugger port is opened) or of the window (its DevTools session) and writes a `.cpuprofile` into `logs/`; `foreman app heap [--renderer]` writes a `.heapsnapshot`. Chrome DevTools opens both. Counters say what is busy; a profile says which function.

What a report then carries, by kind of problem:

| Problem | Evidence |
| --- | --- |
| Slow right now | `foreman app perf`, then `foreman app profile` while it is slow; both in or next to the bundle. |
| Was slow earlier | The bundle's `perfTail` (120 samples, 10 minutes) and `foreman.log` stalls with their deltas. Longer: `perf.jsonl` itself. |
| Memory grows | Two `foreman app heap` snapshots some minutes apart, compared in DevTools. |
| Crashed or hung | `foreman.log`'s last lines before the gap (`exception`, `renderer.gone`, `process.gone`, `window.unresponsive`, the last `turn.*`), and the crash dump list. |
| An agent failed | `turn.end` with outcome and error, next to the `error` lines around it. |

### Layer B: the renderer meter (Phase 2)

A small module in the renderer counts what main cannot see: store flushes and events applied, renders of the chat on screen, the composer and the sidebar (React Profiler callbacks on those three subtrees only), loaded chats and total items, mounted terminals and their buffer lengths, long tasks (`PerformanceObserver` for `longtask`), and `performance.memory` heap. Every 10 s it sends one `perfReport` signal to main, which folds the numbers into the same report under `renderer.*`. Nothing is sent while the window is hidden; the store already stops notifying then.

### Layer C: per-turn attribution (Phase 2)

When a turn ends, the session service records one `turn` timing and counters per agent kind: duration, chat events sent, previews sent and whole resyncs, tool calls, and the peak process count and memory under the agent's pid from the process table (when the resource usage view is on, so no extra listing runs). This is what shows a user that one plugin's hook costs more than the agent.

### Layer D: showing it (Phase 3)

The existing resource usage line gains Foreman's own split (main, renderer, GPU) in its popover, and a "Save diagnostics…" action in Report a problem writes the `perf` report, the error ring and the resource usage into one JSON file the user can share. No new components: the popover and the dialog exist.

## Budgets

Each phase adds deterministic tests next to the two in performance.md. They use a real `Core` on temporary repositories, a simulated clock and the counters above, and never wall-clock time.

- **Idle budget** (Phase 1): with twelve ready workspaces and nothing running, after ten simulated minutes main has spawned no git or gh process for a repository that did not opt into base watching or PR watching, and `state.flush` is at most the number of real changes.
- **Streaming budget** (exists): the two tests in performance.md, extended with `state.stringify` total under a limit per 1,000 events.
- **Hidden budget** (Phase 2): a hidden workspace makes no `checksStatus`, `gitStatus`, `probePreview` or `mobileInfo` call in a simulated minute.
- **Memory budget** (Phase 2): after opening and leaving twelve chats, the renderer holds at most N loaded chats and the rest are evicted.

## Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 1 | `src/main/perf.ts`, the instrumentation points above, `foreman app perf`, `FOREMAN_PERF_LOG`, the idle budget test. | Done in this change |
| 1a | The low-risk fixes the survey confirmed: the Checks tab stops polling for a hidden workspace; the phone pill polls only while the window can be seen; the phone server's stall check reuses the snapshot's 3 s cache. | Done in this change |
| 1b | Evidence: the event log, the perf flight recorder, local crash dumps, the diagnostics bundle (Save diagnostics… and `foreman app diagnostics`), `foreman app profile` and `app heap`, the stall watchdog, and the Keep diagnostics switch. | Done in this change |
| 2 | Renderer meter, per-turn attribution, hidden and memory budgets; then the fixes they justify (chat eviction, scrollback for hidden workspaces, fewer git processes per Git panel refresh, pausing endless animations in hidden views). | Next |
| 3 | Resource usage popover split, Save diagnostics. | After 2 |

## Using it

```sh
foreman app perf                      # the report as text: processes, main-thread stalls, top counters and timings
foreman app perf --json               # the same as JSON
foreman app perf --reset              # print, then start the counters again (for a rate: run it twice)
foreman app diagnostics               # write foreman-diagnostics-<date>.json here, redacted, to attach to an issue
foreman app profile --seconds 20      # a CPU profile of main into the data folder's logs (--renderer for the window)
foreman app heap                      # a heap snapshot of main (--renderer for the window)
```

The files live in `userData/logs/` (the data folder is shown by `foreman app info`): `foreman.log`, `perf.jsonl`, and the profiles and snapshots. In the app, Help → Report a problem has **Save diagnostics…**, which writes the same bundle the command does.

To collect from more than one Foreman, point a log shipper at each instance's `foreman.log` and `perf.jsonl`; both are JSON lines with an ISO timestamp per line, which Loki, an OpenTelemetry collector or a spreadsheet can take. Foreman itself never sends them anywhere.

What to look for first:

- `loop.p99` or `loop.max` in the hundreds of milliseconds: something synchronous on the main thread. Compare with `db.*`, `store.save` and `state.stringify` timings.
- `git.*` or `gh.*` counts climbing while nothing runs: a poll that should be gated. The names say which command.
- `state.flush` far above `state.broadcast`: many changes that produced the same snapshot, each paid for in full.
- The GPU or renderer process high while the window shows nothing moving: an animation or a render loop; Phase 2 narrows it.
