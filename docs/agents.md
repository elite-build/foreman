# Agents: one capability contract

How Foreman runs coding agents: one capability record per agent that every feature reads, adapters that use what each agent's protocol offers, switching agents inside a chat with a recorded hand-off, usage limits that pause and resume, and tests that replay recorded agent traffic. The GitHub issue is elite-build/foreman#172; it absorbs #131 (limits), #152 (replay fixtures), #158 (version table) and the eval part of #151.

This document is the design and, once built, the reference. Section 12 is the per-agent reference. The design was reviewed against the code and the pinned protocols before building; section 15 lists what that review changed.

## 1. What stays the same

- **The driver contract stays the seam.** `AgentDriver`, `AgentTurn` and `TurnCallbacks` in `src/main/agents/types.ts` remain the only thing `SessionService` talks to. New abilities are new optional methods, the pattern `oneShot?` and `mcpProbe?` already use, never a branch on the agent's id in `sessions.ts`. **As built** (the first plan named `AgentTurn.fork`, `injectHistory` and `compact` and `AgentDriver.importTranscripts`, `mcpConfig` and `cloudCredentials`; none of those exists, see 3.1): on `AgentTurn` only `stopChild`; on `AgentDriver` `accepts` (what the adapter takes: in-process MCP and so on), `limits` (account limits without a turn), `cloudEnv` (what a sandbox needs to sign the agent in), `ownMcpToDisable` (the user's own same-service MCP servers to switch off), `updateCommand` and `signInCommand`, beside the older `oneShot`, `listModels`, `slashCommands` and `mcpProbe`. Fork, compaction, rollback and goals are request fields (`TurnRequest.resumeAt`, `rewind`) and commands (`/compact`, `/goal`) the adapter answers, because a Codex turn is one process that opens a thread and ends.
- **Persisted shapes are extended, not changed.** `Session`, `ChatItem` and `state.json` gain optional fields. No new table and no migration.
- **Read-only stays where the agent enforces it** (decision 2026-11-10). The record makes that rule data (`enforcement.readOnly`), it does not relax it.
- **The ceiling from #170 stays the cap**, and stays the only thing that refuses an agent for its permission mode (section 3).
- **Triage keeps its four buckets.** A paused tab stays in `idle` with its own label (section 7).
- **No hosted service.** Version tables, model overlays and fixtures are bundled; nothing is fetched.

## 2. The capability record (issue section A)

### 2.1 Shape

`src/shared/agentCapabilities.ts` defines the type and the helpers. Every field has a named reader; a field nobody reads is not added. A field is either a fact or an `Ability`:

```ts
type Level = 'native' | 'fallback' | 'none'
interface Ability {
  level: Level
  fallback?: FallbackId   // required when level is 'fallback': what Foreman does instead
  why?: PlainKey          // required when level is 'none': one sentence the UI shows
}
type FallbackId =
  | 'interrupt-restart'          // steer: interrupt, restart with the message, mark the turn
  | 'checkpoint-fresh-session'   // rollback: restore files, fresh session seeded with history up to there
  | 'prompt-history'             // fork / hand-off: history as attributed text in the first turn
  | 'session-always'             // "always allow" remembered by Foreman for this session, per (kind, command or path)
  | 'once-always'                // "always allow" answered as "once", reason shown
  | 'server-per-turn'            // a process of its own for every turn: its environment names the turn, and ACP has none per session

interface AgentCapabilities {
  sessions:     { modelSwitch: Ability; concurrentChats: Ability }       // composer model chip; OpenCode's server for each turn (3.2)
  threads:      { resume: Ability; fork: Ability }                       // switchAgent, forkSession
  turns:        { steer: Ability }                                       // planDelivery, composer, phone
  planning:     { planMode: Ability; questions: Ability; goals: Ability } // Plan chip, ask card, goal card (slice 4a)
  approvals:    { tools: Ability; alwaysAllow: Ability }                 // approval card, settings pickers
  tools:        { mcp: Ability; terminals: Ability }                     // repo MCP, foreman-app, integrations; ACP terminal/* (3.2)
  subagents:    { children: Ability; stop: Ability }                     // child rows (section 6)
  context:      { handoff: 'native' | 'inject' | 'prompt'; compact: Ability }   // hand-off, /compact
  checkpointing:{ restoreFiles: boolean; conversationRollback: Ability } // Restore: the files come back from Foreman's checkpoint; the conversation natively or by fallback
  enforcement:  { by: 'agent' | 'foreman'; readOnly: 'plan' | 'sandbox' | null;
                  permissionModes: ApprovalPolicy[]; ceilings: ApprovalPolicy[]; scopedWrites: Ability }
  usage:        { cost: boolean; limitWindows: boolean; resetTime: boolean }   // usage notes, Limits, LimitResume
  features:     { assistant; unattended; cloud; keptRunning; reportTools; diffTool; followups;
                  repoCommands; transcriptMirror; titles }               // booleans; 5 of the 10 derived, see below
  evidence:     'recorded' | 'simulated'                                 // Settings' evidence line
  declares:     DeclarableFact[]                                         // what the agent states at start that the record accepts: 'planMode' | 'version' | 'windowsSandbox'
  version?:     string                                                   // the account's declared version; never static
}
```

`features` is **partly** derived: five of the ten (`DRIVER_FEATURES`: `titles`, `diffTool`, `followups`, `reportTools`, `transcriptMirror`) are derived by main from what the registered driver implements (`oneShot` → `titles`, and so on), so they cannot drift from the adapter; the other five (`assistant`, `unattended`, `cloud`, `keptRunning`, `repoCommands`) are static data in the agent's catalog file, like the rest of the record. On top of that is what the agent **declares** when it starts (`declares` lists which facts the record accepts): ACP session modes (`planMode`), OpenCode's version (`version`) and, on Windows, Codex's `windowsSandbox/readiness` (`windowsSandbox`, section 8).

**Declared facts are per account.** #130 accounts can point at their own executable and home, so the same agent can run two versions, and a Windows sandbox is set up per Codex home. `resolveCapabilities(base: AgentCapabilities, declared?: DeclaredFacts): AgentCapabilities` folds a declaration into a record (only what `declares` lists, and only ever turning plan mode on or taking enforcement away: a sandbox that isn't ready removes read-only and scoped writes and leaves no ceiling below Never ask); the snapshot carries the static record per agent plus `declared[agent][account]`, and `capabilitiesFor(view, agent, instance?)` (renderer, phone) and `capabilitiesOf(agent, catalog?, declared?, instance?)` (main) merge them. What holds for the agent (ACP session modes) is under `EVERY_ACCOUNT` (`''`); what an account states about its own home is under that account's id, or `DEFAULT_ACCOUNT` (`'default'`) for the chat with no account, and never under `EVERY_ACCOUNT`, so no other account inherits it. Nothing else changes a record at runtime.

### 2.2 Where records live

- **Catalog file:** `src/shared/agentCatalog.ts` becomes a folder, `src/shared/agentCatalog/` (`index.ts` keeps every current export, so `import … from './agentCatalog'` is unchanged). Each agent with an adapter of its own gets `src/shared/agentCatalog/<id>.ts` holding its catalog entry, capability record, version table and model overlay. The generic ACP agents share `acpAgents.ts`, one entry each.
- **Adapter folder:** `src/main/agents/<id>/` (`index.ts` is today's `<id>.ts`, so importers don't change), with `fixtures/` and its recording scenario `record.ts`. Per-agent code that lived outside the adapters was meant to move here as optional driver methods. **As built:** sandbox credentials (`cloudEnv`), the user's own MCP servers to switch off (`ownMcpToDisable`) and limits (`limits`) did; transcript import stays in `portability.ts`, which asks `features.transcriptMirror` which agents have one, and MCP config formats stay in `integrationBridge.ts`.
- **Doc:** its section in section 12.

A new agent is one adapter folder, one catalog file, its fixtures and a doc section; the registry and the catalog index each gain one line. `tests/agentFolders.test.ts` fails when a listed agent lacks any of these. Two folders rather than one because the renderer imports the catalog file and must never import the adapter.

### 2.3 One object everywhere

Main publishes the records in the snapshot (`agentCapabilities`). The window reads them through `useCapabilities(agent, instance?)`; the phone and the browser client get the same snapshot field; `foreman agents --json` adds `capabilities` to each `AgentRow`. Shared helpers that decide something take the record, not the id: `planDelivery(record, …)`, `readOnlyEnforcement(record)`, `planControl(record, …)`, `canReview(record)`.

### 2.4 No branching on an agent's id

`tests/agentBranches.test.ts` scans `src/**` and `resources/mobile/**` outside `src/main/agents/` and `src/shared/agentCatalog/` and counts, per file:

- comparisons of an agent-named expression (`agent`, `kind`, `session.agent`, `loadout.agent`, `*.agent`, `id` in agent code) with one of the catalogue's ids (`=== 'claude'`, `!== 'codex'`), and `case '<id>':` labels;
- array or `Set` literals of two or more agent ids (`KEPT_AGENTS`, `ASSISTANT_AGENTS`, `READS_RESET_TIME`, `HOLDS_EVERY_CEILING` today);
- reads of the old flags (`supportsSteering`, `supportsPlanMode`, `supportsReadOnly`, `supportsRepoMcp`, `capabilities.rewind` …).

Scoping the match to agent-named expressions keeps `provider === 'claude'` (an API-key provider in `ProviderKeysPage.tsx` and `McpConsent.tsx`) out. Counts live in `tests/agentBranches.baseline.json` and may only fall, as `designSystem.baseline.json` works; each slice lowers them, and the last slice of the build empties the file, which is the issue's "no branch" check. The first count was about 120 sites in 40 files (101 comparisons, 16 flag reads, 4 id lists); the baseline is now empty, so a new site fails the test.

How each kind of site goes away:

| Today | Becomes |
|---|---|
| `supportsSteering`, `planDelivery` | `turns.steer` |
| `supportsPlanMode`, `supportsPlan`, `declaresPlanMode` | `planning.planMode` (ACP declaration resolved in) |
| `supportsReadOnly`, `agent === 'claude' ? 'plan' : 'sandbox'` | `enforcement.readOnly` |
| `supportsRepoMcp`, `repoMcpSupport` | `tools.mcp` (`repoMcpReach` stays as catalog data) |
| `agentControls().restore`, `capabilities.rewind` | `checkpointing.conversationRollback` |
| native fork test in `forkSession` | `threads.fork` |
| `KEPT_AGENTS`, `cloudAgentSupported` | `features.keptRunning`, `features.cloud` |
| `READS_RESET_TIME` | `usage.resetTime` |
| `HOLDS_EVERY_CEILING` | `enforcement.ceilings` |
| schedules/flows "Claude only" | `features.unattended` |
| `ASSISTANT_AGENTS`, titles via `driverFor('claude')` | `features.assistant`, `features.titles` (titles use the first agent that has it) |
| `hasReportTools`, `hasDiffTool`, followups, repo commands, mirror | `features.*` |
| `agent === 'opencode'` model naming in the pickers | catalog fields `models.chosenSubset`, `models.twoLineNames` |
| cloud credentials, the user's own MCP servers, limits, update and sign-in commands | optional driver methods in the adapter (`cloudEnv`, `ownMcpToDisable`, `limits`, `updateCommand`, `signInCommand`); transcript import and MCP config formats stayed where they were, reading the record (`features.transcriptMirror`) |
| per-agent settings panels (`AgentsPage`, `AgentAuth`, `AgentAccounts`, `AgentStatusCard`) | a map keyed by id in `components/settings/agentPanels.tsx`; copy differences become catalog fields (`auth.loginCommand`, `instances.homeEnv`) |
| defaults (`agent: 'claude'` for a new schedule) | `DEFAULT_AGENT` from the catalog |

A map keyed by agent id is data, not a branch, and is allowed; the guard can't tell a map from a decision, so review watches for maps used as hidden branches.

### 2.5 Fallbacks, written next to the flag

Each `FallbackId` has one implementation in `SessionService` and one sentence in `en.ts`:

- **`interrupt-restart` (steer).** For agents on this fallback the composer's default follow-up is **Queue**; **Interrupt and send** is an explicit choice (it cuts work in progress and partly written files stay). It interrupts the running turn, waits for it to end, marks the turn `restartedBy: <message id>`, and starts the next turn on the same agent session with the message first. A `restartedBy` turn counts neither as attention nor as a failure in triage; the chat shows "Interrupted and restarted with your message" on it. Cursor and the ACP agents.
- **`checkpoint-fresh-session` (rollback).** `restore()` restores files from the checkpoint, drops the agent session, sets `seedHistory` to the chat up to the restore point and adds a "Context restarted" notice. This also fixes a bug: today a rewound Codex, Cursor or ACP chat restarts with no history (`sessions.ts` seeds history only on a switch). Restore's confirmation (a `Dialog` instead of today's `window.confirm`, since the text is longer) says "Restores files; the agent starts a fresh conversation" for these agents.
- **`prompt-history` (fork, hand-off).** History as attributed text (section 5).
- **`session-always`, `once-always`.** Section 8.
- **`none`** disables the control with the `why` sentence as its tooltip: no plan mode means the Plan switch is shown disabled saying why (a hidden control can't carry a tooltip).

### 2.6 Settings → Agents shows the record

Each agent's page gains a **Capabilities** section: a list grouped like the record, each line **Works**, **Works with a fallback** (its sentence) or **Not offered** (its `why`), plus the **Enforced by** tag (section 8) and the evidence line ("Tested against recorded traffic · Codex 0.163.0", or "Tested against a protocol simulation"). Built from `ActionRow` lists with `Glyph` + word (state never by colour alone) and `Tag`; the catalog's capability chips read the same record. Mock 1.

## 3. Adapters that use what each agent offers (issue section B)

| Agent | Adds | How |
|---|---|---|
| **Claude Code** | plan card on leaving plan mode (exists, now in the record); **idle compaction**, opt-in; rate-limit events feed limits (section 7); subagents as children (section 6) | Idle compaction is off by default (`idleCompactTokens: 0`). Turned on, after a turn in a chat over that many tokens, it compacts before the prompt cache expires: the timer reads the turn's reported `cache_ttl` (`5m` or `1h`) and fires 30 seconds before it, only while `prompt_cache_warm` was true, never in an unattended tab, with a resume armed, or once the user has started typing, queued or sent. The Claude process exits after each turn, so this is a respawn, a resume and one full-context call: the setting's description says it spends usage to make the next turn cheaper. A "Compacted while idle" row marks it; it moves the rewind boundary like any `/compact`. |
| **Codex** | native fork (`thread/fork`), compaction on request (`thread/compact/start`), goals (`thread/goal/*`) as a pinned card, conversation rollback (`thread/revert`, history only, with Foreman's file checkpoint), rate limits (`account/rateLimits/read`, `/updated`), subagents (`collabAgentToolCall`), hand-off injection (`thread/inject_items`, gated, section 5.3) | Not new `AgentTurn` methods (superseded, see 3.1): fork and rollback are request fields (`resumeAt`, `rewind`), `/compact` and `/goal` are messages the adapter answers; goals arrive as `thread/goal/updated` and show as a `Card` above the composer with Clear. All typed from the generated protocol (section 4.2). |
| **Cursor** | steer by `interrupt-restart`; Restore notes "no rollback of the conversation" | The record plus the shared fallbacks. |
| **OpenCode** | its version per account; "always allow" → "once" with the reason | The version comes from `initialize.agentInfo.version` per account. A server for each turn (3.2: pooling one server across turns was designed and dropped). |
| **ACP chat agents** | rewind by `checkpoint-fresh-session`; steer by `interrupt-restart`; elicitation as the question card; agent terminals as read-only terminal tabs; MCP through the session (exists) | Terminals (`terminal/create`, `output`, `wait_for_exit`, `kill`, `release`) run as piped child processes through `platform.ts`, not a PTY (the agent reads `terminal/output`, which must be plain text with its byte limit, `truncated` flag and exit status), mirrored into a read-only terminal tab. `clientCapabilities.terminal` is sent per record, not for every agent. Elicitation and terminals are in the pinned SDK 2.0.1 v1 export. |
| **Grok, Kiro, Pi RPC** | full adapters | **Deferred** (section 13). |

**Permission modes.** Each record lists `enforcement.permissionModes`. The approval settings and New-workspace pickers offer only those for the chosen agent. At turn start `effectivePolicy(record, stored, cap)`:

- With a #170 cap: unchanged, an agent that can't hold the ceiling is refused (`ceilingRefusal`).
- Without a cap: the most restrictive supported mode at or below the stored one; if none exists (Cursor never asks), the agent's one mode. Either way, when the mode differs from the stored one, a one-time notice in the chat says so and names who enforces it ("Cursor doesn't ask before running tools; Foreman can't make it. Enforced by: Foreman's review."). Never silent, and never a refusal outside a cap, as today.

### 3.1 As built (slice 4a: Codex and Claude Code)

Fixtures came first (`npm run record:agent`, each a few cents, the cheapest model at low effort): Codex 0.163.0 on `gpt-5.6-luna` for `fork`, `revert`, `compact`, `goal` and `goalclear`; Claude Code 2.1.301 on `claude-haiku-5-5` for `fork`, `revert` and `compact` (about $0.01 for the three). `fork` and `revert` run two setup turns ("remember pineapple", then "remember mango instead") and record the third, which must answer "pineapple": the history was cut after the first. The recorder's plans gained `resumes.then`, `resumes.at`, `resumes.rewind` and `maxMs` (a cap on a turn that otherwise goes on by itself: a goal).

- **Contract.** The doc's first plan, `AgentTurn.fork`, `compact` and a goal method, did not survive the protocol: a Codex turn is one app-server process that opens a thread and ends, so nothing is alive to ask. They are a request field and two commands instead. `TurnRequest.resumeAt` is the point the conversation last ended at (Claude's assistant message uuid; **Codex's turn id**, which the adapter now reports through `assistantMessage` when each Codex turn completes); with `resume` it forks. `TurnRequest.rewind`, set by Restore, rolls the same thread back instead. `TurnCallbacks.goal` reports the thread's goal; `TurnCallbacks.cacheWindow` reports the prompt cache a turn left. `/compact` and `/goal` stay messages, as the composer sends them, and the Codex adapter answers them through the protocol.
- **Codex fork.** `threads.fork` is native. `forkSession` already forks natively for any agent whose record says so and whose chat has a resume point, so Codex needed only the point: the next turn sends `thread/fork { threadId, lastTurnId: resumeAt, excludeTurns: true }` with the thread settings, and the fork's thread becomes the chat's. Same agent and same home only, as for Claude: a chat that other agents answered part of, or whose account home changed, still carries its history as text.
- **Codex Restore.** `checkpointing.conversationRollback` is native, by `thread/revert`, which only works on a loaded thread and only drops history (files come back from Foreman's checkpoint). The adapter resumes the thread, lists its turns newest first (`thread/turns/list`, `itemsView: notLoaded`), finds the turn Restore keeps, and reverts before the one after it. A thread that no longer has that turn (a compaction, another home) starts a new conversation and the chat says so. A revert is in place only for a message that went to the chat's **own** thread: `restore()` sets `Session.rewound` only then; the first message of a fork went to its parent's thread, and Restore forks there, so a parent's history is never cut by a child's Restore. Reverting also clears the thread's goal.
- **Codex compaction.** `context.compact` is native: `/compact` calls `thread/compact/start`, which runs a turn of its own whose only item is a `contextCompaction`, shown as the divider Claude's `compact_boundary` draws. `thread/compacted` is deprecated and was not sent.
- **Codex goals.** New record field `planning.goals`, native for Codex. `/goal <text>` (offered in the composer from the record, not the agent's name) calls `thread/goal/set`; Codex then works at it turn after turn by itself, so the Foreman turn stays open until the goal is no longer `active` (complete, blocked, paused, over budget, cleared), ten seconds' silence ending the wait. `thread/goal/updated` and `/cleared` keep `Session.goal`, which the card above the composer (`Card`, `Status`, `Button`: no new component) shows, with **Clear**, which sends `/goal clear` (steered into the running turn when one runs). `/goal pause`, `/goal resume` and `/goal clear` are the other commands. Two behaviours found in the recordings shaped it: an interrupted goal stays `active` and **starts a turn of its own the next time the thread is resumed**, so a goal still active when the process ends (Stop, a stalled wait) is paused first; and `thread/goal/cleared` can come after the process has been closed, so a Clear updates the card from the answer. Subagents (`collabAgentToolCall`) stay `none` until a recorded fixture proves them.
- **Claude idle compaction.** Setting `idleCompactTokens` (`agents.idle-compact-tokens`; 0, the default, is off) in Settings → Agents → Claude Code; the description says it spends usage. **The SDK reports `cache_ttl` and `prompt_cache_warm` only on its PreModelSwitch hook**, so the adapter reads the same facts from the last main-thread response's usage: `cache_creation` says which time-to-live it wrote with (`ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`), and a response that read or wrote the cache left it warm; a response that only read keeps the last TTL seen, else the shorter. After a completed turn, if the setting is on, the context is over it and the cache was warm, `src/main/idleCompact.ts` arms a timer 30 seconds before the TTL. When it fires, the tab must still be idle, unqueued, not a reviewer's, not in the workspace of a scheduled run or a flow run, and have no limit resume armed (a turn that was unattended arms nothing at all: the unattended mark is read before the turn's end clears it, and so is the turn's cap); then the session service sends `/compact` with `origin: { kind: 'idle-compact' }` under the cap the turn it follows ran under (a compaction is a turn of the same outside caller's chat), without marking anything the agent reported as replied to (it is maintenance, not an answer), which the chat shows as one row, "Compacted while idle · 168,000 → 22,000 tokens · 11:58" (from `compact_boundary`'s `pre_tokens` and `post_tokens`), and no message of the person's. Any `activity()` in the tab (send, queue, steer, restore, model change, close) cancels it, and so does the composer having text in it: the new `composerTyping` signal, sent at most every five seconds. It moves the rewind boundary like any `/compact`.
- **Proof.** `tests/agentCapabilityProof.test.ts` gained claims for `threads.fork`, `checkpointing.conversationRollback`, `context.compact` and `planning.goals` (native only), each replayed from its fixture; `tests/replay/codex.test.ts` and `claude.test.ts` read what each request carried. `tests/idleCompact.test.ts` (fake timers) and `tests/idleCompactSessions.test.ts` cover the timer and what cancels it.

### 3.2 As built (slice 4b: Cursor, OpenCode and the ACP agents)

Every claim is proven by a `simulated` fixture or a test (none of these agents is installed where this was built, so their records stay `simulated`; `tests/agentCapabilityProof.test.ts` has a claim for each fallback and native ability below).

- **Interrupt and send (`interrupt-restart`).** Cursor, OpenCode and the Chat agents say `turns.steer` is the fallback. `SendMode` (`shared/delivery.ts`) is `queue | steer | interrupt`: `interrupt` is never stored as the follow-up setting and never the default, so the composer still queues; its chip offers **Interrupt and send** (the shortcut for the other mode, and the title says it cuts work in progress and partly written files stay). **Send now** on a queued message of such an agent (the window's queue row, the phone's, `foreman tab queue steer`) is the same explicit interrupt, and says so: both the window and the phone label it "Interrupt and send" from the record (`canInterrupt` in the phone's snapshot), the window's tooltip says it cuts work in progress, and neither asks first (the label is the warning). `deliver()` marks the running turn `restartedBy: <user message id>` (an `ActiveTurn` field, written on its `turn-end` and `lastTurn`), stops it, waits for its end, and starts the next turn through the usual `startTurn` (same agent session, the message first, the queue after it). The same cap rule as a steer applies (a lower-capped message waits in the queue); a turn already being cut leaves the next message queued. A `restartedBy` turn is skipped by triage's `turn-outcome`, the attention log and the "stopped" notification, and the chat's end line reads "Interrupted and restarted with your message". It rests on two things the adapters already do and the fixtures show: the agent can be stopped (`interrupt` fixtures: `session/cancel`, `run.cancel()`; a new simulated Cursor `interrupt` fixture) and its session continued (`resume`: `session/resume` or `session/load`, `Agent.resume`; an agent that can do neither starts a new conversation and says so).
- **Restore (`checkpoint-fresh-session`).** `conversationRollback` is the fallback for Cursor, OpenCode and the Chat agents, which now offer Restore (`restoreFiles` is true for them: the files come back from Foreman's own checkpoint, whatever the agent). `restore()` restores the files, drops the session (`dropConversation`), sets `Session.seedHistory = 'restore'` when there is history before the point, and the next turn carries it as attributed text (`renderHandOff` reason `restore`: "The user restored this chat to an earlier point, so it continues here as a new conversation …"). The chat shows "Restored files to before “…”. Context restarted: Cursor starts a fresh conversation, given the chat up to there." This fixes a rewound chat that resumed the agent's session with every later turn in it. Restore's confirmation is a `Dialog` (`chat.restore.dialogTitle`), saying "Restores files; the agent starts a fresh conversation" for these agents and keeping the old wording for native rollback.
- **Elicitation as the question card.** `acp/elicitation.ts` maps a form's properties to `Question`s (a titled choice or enum, a multi-select, a boolean as Yes / No, typed text and numbers in the card's own box) and the answers back to the values the schema names (a required property left empty or a number that isn't one declines). A URL form, an unknown property type or a form for another session is declined, a stopped turn cancels the wait. `clientCapabilities.elicitation.form` is sent only for a record whose `planning.questions` is not `none` (the ACP record: native). The card's English-only words are the two boolean labels, as in the rest of the adapters.
- **Agent terminals.** `terminal/create`, `output`, `wait_for_exit`, `kill` and `release` run as piped children (`acp/terminals.ts`: `spawn` with `treeSpawnOptions`, `killProcessTree`, `launchFor` for Windows shims, `scriptInTerminal` for a whole command line sent as `command`): plain text with escape codes stripped, the `outputByteLimit` kept from the end at a character boundary with `truncated`, the exit status, an absolute `cwd` inside the workspace, the agent's `env` list laid over the turn's (but never `PATH`, `PATHEXT`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `GIT_*`, `FOREMAN_*` or `SWITCHYARD_*`, compared without case on Windows: those are refused with the name, under every policy), at most 16 at once, and everything still running stopped when the turn ends. A command is a run like a shell tool: refused in a read-only chat or under a cap, asked about under Ask (the answer to the agent's own `session/request_permission` for its execute tool call covers one terminal that runs exactly the command the card showed, compared as the words a shell would give the program, so there is no second prompt for it; any other command, or the same one a second time, is asked about on its own), run under Never ask; session-always applies. The approval card's input carries the **folder** (relative to the workspace, when it isn't the workspace) and the **names** of the variables the agent sets (never their values, which can be secrets), the summary line shows them (`cmd (cwd: sub; env: FOO)`), and the remembered key includes both, so an Always allow covers that command there and with those names only; the approval of an execute tool call covers a terminal only when the terminal has neither, since the tool call's card showed neither. New record field `tools.terminals` (native for the ACP agents, `none` for Claude, Codex and Cursor, which start their own commands); `clientCapabilities.terminal` follows it. **There is no mirror terminal tab**: the terminal panel's tabs are ptys, and a read-only feed would need a new surface (and likely a new component), so the output is shown in the chat, as the agent's own tool call when its content names the terminal, else as a `Bash` row of Foreman's.
- **OpenCode's servers: one for each turn, not a pool.** The first design (one server per account on 2.x, one per chat before it) was built and then taken out in review, because it cannot be made correct. A server is an operating-system process, and its **environment** names the turn: `FOREMAN_SESSION_ID`, `FOREMAN_TURN_ID` and `FOREMAN_TURN_TOKEN` (which `foreman report` attributes by: a report from a turn that is not the live one is refused), besides the workspace's own variables (`FOREMAN_WORKSPACE_ID`, its port block). ACP has no environment per session (`session/new` takes a folder and MCP servers), so a server that outlived its turn would run the next turn's commands with the first turn's identity, and a pool could only ever join turns whose whole environment was equal, which no two turns' is. So `AcpLink` is one connection for one turn, the turn closes its process when it ends, and Stop on a turn closes its own process and no other. The record says so: `sessions.concurrentChats` is the fallback `server-per-turn` ("Foreman starts a server of its own for each turn, so chats run side by side without sharing one"), whatever the version, and there is no `pooledServerFrom`. `initialize.agentInfo.version` is still reported to Foreman (`TurnCallbacks.declared`, also forwarded from the background host) and kept per account in `state.json` (`declared`, only a version) and in the snapshot's `declared[agent][account]`, for Settings. What was given up is the cost of starting `opencode acp` for every turn, which a shared server would have saved; the issue's wording ("one server per account on 2.x") is not met, deliberately. If OpenCode ever takes an environment per session, or Foreman stops naming the turn in the process environment, pooling can come back behind the same record field. `tests/acpServers.test.ts` runs turns with the environment a real turn has and checks that each process carries its own turn's, and closes with it.
- **Always allow.** OpenCode: `once-always`. Its card has no Always allow button and says "OpenCode can't remember an always-allow; it asks each time", and a card answered with a stale alternate is still answered once. The basis is the adapter's: Foreman starts a fresh `opencode acp` for every turn, so whatever the agent remembered in its own process is gone by the next one, and nothing recorded shows an always surviving; if a recording of a real OpenCode shows it does, the record changes. The Chat agents: `session-always`. Foreman remembers an Always allow for the agent's session keyed on the tool kind and the normalised command, path, pattern or address (`acp/remembered.ts`), the card names it ("Yes, and always allow `npm test` in this session": `alwaysScope` on the request), the agent is answered once so it allows exactly that, a terminal command is remembered the same way, and under a cap a request on agent or git configuration (`isCeilingProtected`, checked on every request) has no Always allow and asks every time.
- **Permission modes.** `effectivePolicy(record, stored, cap)` (`shared/permissionModes.ts`): with a cap, unchanged (the lower of the stored mode and the ceiling; a refusal, `ceilingRefusal`, for an agent whose record can't hold the ceiling); without one, the stored mode where `enforcement.permissionModes` lists it, else the most restrictive listed mode below it (an agent with no Auto runs Auto as Ask, as it did), else the agent's one mode (Cursor). Never a refusal outside a cap. `SessionService.resolvePolicy` uses it for every turn; when the mode differs a notice says once who holds it ("Cursor doesn't ask before running tools; Foreman can't make it. Enforced by: Foreman's review."; "Gemini CLI can't run in “Auto”, so this chat runs as “Ask”. …"), and again only when the stored mode or what the agent runs as changes (`Session.modeNoticed`). `permissionNote` (the second-opinion, compare and hand-off dialogs) and the catalog's approvals chip read the same rule (Cursor has no approvals chip). The app has no per-agent permission-mode picker in Settings or in the New workspace dialog (Settings → Account holds the app-wide approvals switch and Codex's own select; the access levels in Data & devices are #170 ceilings for outside agents), so there was nothing to filter there: `offeredModes(record)` is what such a picker would read.
- **Fixtures** (`npm run record:agent -- simulated`): `question`, `terminal` (a command that really ran) and `version1` / `version2` for OpenCode and the shared ACP folder, `interrupt` for Cursor; the other simulated fixtures were recorded again for the new `initialize`. No recording was made of a real agent.

## 4. Nothing guessed: versions, models, protocols (issue section F, #158)

### 4.1 Version table

```ts
versions: {
  tested: string[]                 // versions fixtures were recorded with (written by the recorder)
  minimum?: string                 // set by hand: the oldest version with every method the adapter calls
  degraded?: { below?: string; range?: string; why: PlainKey }[]
  broken?: { range: string; why: PlainKey }[]
  models?: Record<string, string>  // model id -> minimum CLI version, only where the agent reports it
  update?: { args: string[] }      // the agent's own update command
}
```

`versionStatus(agent, version)` → `tested | untested | degraded | broken`. Only facts: `tested` from recordings, `minimum` from the methods the adapter uses, model minimums from the agent's own report where verified (Codex's `model/list` `upgrade`/`upgradeInfo` is checked against a recording before it is used), breakages as they are found. Settings shows the word next to the version ("2.1.319 · tested") and **Update** where `update` exists.

**Launch problems.** `launchProblem(agent, facts)` turns a failed start into one sentence, first match wins: not installed; version broken; model needs a newer CLI ("GPT-6.1 Sol needs a newer Codex than 0.163.0. Update"); protocol mismatch (ACP version, unknown Codex method); not signed in; else the agent's own error. It replaces the ad-hoc start-failure text in the four adapters.

### 4.2 Generated protocol types and pins

`scripts/gen-agent-protocols.mjs` writes `src/main/agents/protocolPins.json` and:

- **Codex:** runs the pinned `@openai/codex` binary's `app-server generate-ts` into `src/main/agents/codex/protocol/` (generated header, committed). The adapter imports these instead of its hand-written `any` shapes. Payloads the schema leaves as `JsonValue` (`thread/inject_items`) stay untyped and are written by hand with a comment.
- **ACP:** `@agentclientprotocol/sdk` ships types generated from its v1 and v2 schemas; the script records their hashes. `acp.ts` checks `initialize.protocolVersion` and reports "speaks only ACP v2" as a launch problem until v2 is negotiated.
- **Claude Agent SDK:** pinned exactly in `package.json` (no `^`), its version and `sdk.d.ts` hash recorded, because the replay seam (section 9) is the CLI's stdio control protocol, which changes between SDK releases.

`tests/agentProtocolPins.test.ts` fails when an installed version differs from its pin (regenerate and re-record) or the generated folder differs from its hash (hand-edited).

### 4.3 Models

`modelsFor(agent)` becomes the agent's own report overlaid with the catalog file's `models` table (display name, effort levels, context window). The static `MODELS` list remains only as that overlay and the list used before the first report. A model whose minimum is above the installed version is listed with **Update** and can't be chosen.

### 4.4 As built (slice 3)

- **Pins.** `npm run gen:agent-protocols` (`scripts/gen-agent-protocols.mjs`) writes `src/main/agents/protocolPins.json` and regenerates `src/main/agents/codex/protocol/` (896 files, about 530 KB of text, every file under a generated header; `.gitattributes` keeps them LF so the hash is the same on every checkout). It uses `--experimental` because the adapter initializes with `experimentalApi: true`. The ACP SDK's four schema files (v1 and v2, stable and unstable) and the Claude Agent SDK's `sdk.d.ts` are hashed. `@anthropic-ai/claude-agent-sdk` is pinned exactly (`0.3.301`) in `package.json` and `package-lock.json`. `tests/agentProtocolPins.test.ts` fails on a moved package or an edited folder and says to run the script and re-record.
- **Codex types.** `codex/wire.ts` holds the type-only imports and a typed `call(server, method, params)` for the eight requests the adapter sends; the mapper, the four server requests, thread/turn start, `model/list` and the ChatGPT sign-in read the generated shapes. The notification and server-request entry points still take `(method: string, params: unknown)` (the wire is untyped, and a test or an older CLI may leave fields out) and narrow with `switch (n.method)`. `thread/inject_items` is not used yet, and stays untyped when it is.
- **Tables.** Each Full agent's catalog file has `versions`. `tested` is the fixture headers (a test holds them equal); `minimum` is **unset for Claude Code and Codex**, because nothing says which release first had each message or method the adapter uses; `update` is `claude update` and `codex update` only (checked against each program's `--help`). `acp.expect.minVersion` stays with the ACP spec: it is the minimum of the ACP *program* (`pi-acp`, `antigravity-acp`) as it reports itself, a different program from the CLI whose `--version` the table describes; its check now uses the shared version helpers.
- **Update.** Settings → Agents shows `2.1.301 · tested` and, on the Claude Code and Codex pages, **Update**, which opens the agent's update command in the inline terminal the sign-in uses and runs nothing until pressed. It is not shown for the copy bundled with Foreman (`AgentStatus.bundled`): that copy changes with Foreman's own update, and `claude update` would try to rewrite a file inside the app.
- **Launch problems.** `shared/launchProblem.ts`. Not installed, a broken or too old version (with Update where the agent has an update command), a model that needs a newer CLI, a protocol mismatch (ACP answering `initialize` with a version other than 1, or Codex not knowing a request: the real 0.163.0 answers an unknown method with code -32600 and "Invalid request: unknown variant `x`"), not signed in or no key, else the agent's own error. The notice says the sentence; the turn's result keeps the agent's own words. The notice's action gained `'update'` (it opens the agent's page, where Update is).
- **Models.** The static `MODELS` list is gone from `shared/agents.ts`: each agent's table is in its catalog file (`models.table`) and `MODELS` is built from them. `overlayModel` lays the agent's report over its table entry by exact id: what the agent states wins, the table supplies a name, a default effort and a context window the agent did not itself report. **No "needs a newer CLI" marking on models:** Codex's `model/list` `upgrade` / `upgradeInfo`, checked against a real 0.163.0, name a *newer model* that supersedes this one (`gpt-5.5` → `gpt-6-sol`, with migration copy), not a newer CLI, and no report carries a minimum client version. `versions.models` and its launch problem exist for the day an agent says so.
- **Records.** Codex and Cursor now say `usage.cost: false` (neither reports a price; the usage note already read "Cost: n/a" from the turns themselves). Nothing is listed in the proof's `UNPROVEN` any more.

## 5. Switching agents and accounts, with a recorded hand-off (issue section C)

Switching agent inside a chat already exists (`switchAgent`, parked conversations, catch-up). What's added is a record of exactly what the next agent received, a budget, native paths where the agent has them, and a tool to read what was left out.

### 5.1 The record

A switch already writes a notice `ChatItem` with `switched: AgentSwitch`, which Lineage reads. The record goes on it as `switched.handOff`, written when the target's first turn starts:

```ts
interface ChatHandOff {            // src/shared/chatHandOff.ts
  turnId: string                   // the target's first turn that carried it
  from: { agent; instance?; model }; to: { agent; instance?; model }
  strategy: 'native-fork' | 'resume-delta' | 'inject' | 'prompt-delta' | 'prompt-full'
  budgetTokens: number             // setting handOffTokenBudget: default 16,000, 1,024..64,000
  usedTokens: number               // estimate (characters / 4), labelled as one
  full: string[]                   // turn ids included in full
  condensed: string[]              // turn ids reduced to request + final answer (≤ 400 characters each)
  omitted: string[]                // turn ids left out; readable with read_chat_history
  sinceTurn?: string               // delta: the last turn the target saw
}
```

### 5.2 Building it

`buildHandOff(items, target, lastSeen, budget)` is pure and deterministic, with no model call: newest turns in full until 60% of the budget, older turns condensed until the budget, the rest omitted. **Delta** when the target has a parked conversation (it saw the chat up to `lastSeen`); **full** otherwise. Each turn is headed with the agent and model that answered it.

### 5.3 Delivering it

- **Same agent, same home, `threads.fork` native** (Claude's fork; Codex `thread/fork` with `lastTurnId`): `native-fork`, no text.
- **Returning to an agent that saw the chat:** resume its parked thread and send only the delta (`resume-delta`, today's catch-up through the same builder).
- **Codex arriving from another agent:** `thread/inject_items` takes raw Responses API items (`{ type: 'message', role: 'user' | 'assistant', content: [{ type: 'input_text' | 'output_text', text }] }`), not typed by the schema. `context.handoff` is `inject` only once a recorded fixture shows injected items reaching the model and surviving `thread/resume`; until then Codex uses `prompt-full`.
- **Everyone else:** an attributed text block at the start of the first turn (`prompt-delta` / `prompt-full`), replacing today's `carriedHistory` and `catchUpBlock`.
- **`read_chat_history`**, a new `foreman-app` tool (agents with `tools.mcp`): `{ turns?: number[]; from?: number; to?: number }` returns those turns in full, at most 64,000 tokens per call, only from the chat the calling turn belongs to. The hand-off text names it when anything was omitted.

### 5.4 Blocked moves

`continueBlock` already refuses some moves; it grows the account rule (`moveChats: 'never'`) and cloud (a cloud workspace needs the default account). The agent picker keeps its shape (agent tabs and the Account `Select`); a blocked choice shows its reason on a line of its own under it, before anything changes (a disabled row dims its contents, so the reason can't live inside it).

### 5.5 Where it shows

Lineage's switch edge opens the record (strategy, budget, turns in full / condensed / omitted). The switch notice in the chat links to it. In the UI it is called "What Codex received" (the agent's name), never "hand-off": the app already uses Hand off for moving a workspace to another computer and for handing a plan or review to a new chat. CLI: `foreman chat switch <tab> --agent <id> [--account <id>] [--model <id>] [--json]` returns the record. Flows: a step whose persona runs on a different agent from the chat's switches through the same path, so its record appears in Lineage. Mock 3.

### 5.6 As built (slice 6)

- **Types and builder:** `src/shared/chatHandOff.ts`: `ChatHandOff`, `buildHandOff`, `renderHandOff`, `chooseStrategy`, `readChatHistory`, `describeHandOff`. The record has two additions to 5.1, both for showing it: `turnId` is absent on the preview a switch writes (the first turn that carries it writes the record again with its id), and `turns` lists every turn considered (its number counted from 1 across the whole chat, who answered it, its request cut to a line, its size in the text) so the dialog and Lineage need nothing but the record. `full`, `condensed` and `omitted` stay turn ids. Turn numbers are the ones `read_chat_history` takes.
- **Where it is written:** `switched.handOff` on the switch notice (`AgentSwitch`); an account move that starts a new conversation puts it on its own notice as `handOff` (that notice has no `switched`, so the chat isn't "mixed" by it). `Session.handOffPending` (the notice id and who is involved) carries it from the switch to the first turn and is cleared when the agent starts. No new table, no migration; an older notice has no record and shows its old line.
- **Strategy:** `chooseStrategy` holds the rule of 5.3 in one place. In the switch path an agent that is back on its parked conversation is `resume-delta` (the thread is resumed, the delta goes as text in front of the message), any other is `prompt-full`, Codex included (`inject` waits for its recorded fixture, slice 4). `native-fork` is the rule `forkSession` reads for Claude; a fork carries no record. A fork to a new tab and the archived-chat seed keep `carriedHistory` (100,000 characters, unattributed): they aren't a switch of agent.
- **Text:** turns oldest first, each headed `### Turn n · Claude Code (Opus 5.5)`, then `**You:**` and the agent's answer; a condensed one is headed `… · condensed` with the request and the final answer cut to 400 characters. When turns were left out the text says which (`[Turns 1–3 are left out. Read them with read_chat_history.]`), naming the tool only for an agent whose record has `tools.mcp`. The receipt on the user's message (`added`) shows the same text's size.
- **`read_chat_history`:** in `foremanTools.ts` beside `decide`, registered by `ForemanMcp` for every turn that has `foreman-app` (a read tool: read-only turns have it too), except an AI employee's run, whose `foreman-app` offers only the employee tools (`docs/ai-employees.md`). Its chat is the grant's session, so no argument can name another chat; `SessionService.readChatHistory` reads that chat. Messages only (a turn says how many tool calls it had); with nothing selected it lists the chat's turns, one line each.
- **Setting:** `handOffTokenBudget`, Settings → Default models → Switching agents in a chat (a `Range`, 1,024 to 64,000, default 16,000, steps of 64), CLI key `models.switch-history-tokens`; kept within its limits when read.
- **Blocked moves:** `continueBlock` gained `cloud`; `accountBlocked` is the account rule for a chosen account (the chat's own agent, or the account a parked conversation would resume on) and `cloudAccountBlocked` the cloud one; `updateSession` refuses a chosen account in a cloud workspace before changing anything. In the picker the reason is a line of its own under the disabled choice, tied to it with `aria-describedby`. A tab whose agent can't be chosen (a read-only chat on Cursor) says why when the choice is made, as before; showing it on the agent tab itself is not built.
- **Where it shows:** `SwitchDivider` / `MoveDivider` in the chat (counts, size, "What Codex received" opening `HandOffDialog`); Lineage's run lens draws a "What Codex received" node between the two turns (edge `switched: Claude Code → Codex`) that opens the same dialog; `foreman chat switch <workspace> [--tab n] --agent <id> [--model m] [--account <id>]` (a workspace, as every tab command takes, rather than a bare tab) answers with the record.
- **Flows:** a `same_tab` step that names its own agent, in a tab on another agent, switches the tab through `updateSession` first (`FlowServiceDeps.switchTab`), so its record appears. A step that names another **account** of the tab's own agent moves the chat to it through the same call (`stepTabPatch`: the agent's move rule allows it or refuses, and a refusal fails the step with its reason); a step that names no account leaves the tab's alone. A step in a new tab starts a fresh chat and has nothing to hand over.

## 6. Subagents as first-class (issue section D)

- **Items.** A subagent stays a `tool` item with `task` (as today) plus `childId`; its own tool calls and messages, dropped today (`claude.ts` skips frames with `parent_tool_use_id`), are kept as items with `parentToolUseId`, collapsed under the child row.
- **Approvals and questions** from a child carry `subagent: { id, name }` (Claude's `can_use_tool` carries `agent_id`); the card says "From subagent *explore-tests*".
- **Stop** on a child calls `AgentTurn.stopChild(childId)` (Claude `stopTask(taskId)`; Codex interrupt on the child thread). **Wait** on the parent is today's "keep the turn open while background work runs"; a child ending never ends the parent turn.
- **Codex** maps `collabAgentToolCall` (`senderThreadId`, `receiverThreadIds`) to children and keeps a child-thread → parent map for approvals. Its `subagents` abilities stay `none` until a recorded `collab` fixture proves them.
- Agents without subagent events show none.

Rendered with the existing `ToolRow`, a `Disclosure`, and `Tree`/`TreeItem` for the child list (each child a branch whose leaves are its calls). Mock 4.

### 6.1 As built (slice 7)

- **Items.** `ChatItem` gains `parentToolUseId` on `assistant`, `thinking` and `tool`, and `childId` on `tool` (the task id the SDK gave the Task call in `task_started`; set only on `Task`/`Agent` calls, and on a `SendMessage` call that resumed a finished background subagent, since the SDK starts that agent's task again, with the same id, on it). A resumed run's frames still carry the first call's id as `parent_tool_use_id`, so `childItemsOf` puts the items that come after a resume under that `SendMessage` row (the latest call with that task id), named by its `summary`, with "resumed" where a Task row shows its type; the first row keeps what the first run did. Claude's adapter keeps a subagent's final messages and tool calls (and their results) as items with `parentToolUseId`; it still drops its streaming previews and its thinking (cost, and the Task row is detail enough). They are persisted like any item (the items table's JSON; no migration, an older chat has none). `src/shared/subagents.ts` is the one place that knows: `isChildItem`, `withoutChildren`, `childItemsOf`, `isSubagentCall`, `subagentName` (the Task's `description`, else its type).
- **Who sees them.** The window draws them under the Task row (below). Left out, because they are not the parent agent's: the chat's rows, turn headings' tool-call counts and "last answer" (`lastAnswer`, `turnAnswer`), `foreman chat` text and `--json`, Copy transcript and fork/hand-off history (`chatToMarkdown`), the hand-off record's turns, the stop review's last step, steps counted after a gap, the CLI's `ask` and delegation's `get_turn_result` replies, an export's message counts, and the phone (its Task row is the one row for it). **Chat search does not index them**: a hit would have no row of its own to jump to, only a folded part of the Task call (a search that matches the Task's own input and output still opens that row). Exports and imports keep them (they are chat data).
- **Approvals and questions.** `ApprovalRequest` `tool` and `question` carry `subagent?: { id, name }`. For a permission ask Claude's `canUseTool` carries `agentID` (a subagent's task id; the ask's `toolUseID` is the fallback, mapped through the calls the subagent made); the name is the Task's description. For `AskUserQuestion`, which is an in-process tool call that doesn't carry it, the permission ask that precedes it does: the adapter keeps who asked and `TurnCallbacks.ask` takes it as a third argument. A subagent Foreman never saw start is still a subagent, with an empty name ("From a subagent"). The card (`ApprovalPanel`) says "From subagent *name*"; the phone card and the CLI's `approvals` line say the same in English. Notifications and the narrator are unchanged. Answers are unchanged.
- **Stop.** `AgentTurn.stopChild?(childId)` (Claude: `Query.stopTask(taskId)`, refused for a task it never saw or once the turn is over); `Api.stopChild(sessionId, childId)`, scope `operate` (like `cancel`), also through the background host (`stopChild` host method) and the cloud turn host. It refuses an agent whose record says `subagents.stop: none`. The SDK then reports the task stopped and the Task call returns to the parent, which carries on; a child ending or being stopped never completes the turn (only the parent's `result` does). No CLI command: nothing asked for one, and a stop with no row to see it is easy to get wrong.
- **Record.** Claude: `subagents.children` and `subagents.stop` native. Everyone else stays `none` (Codex until a recorded `collab` fixture exists). **Evidence.** A recorded `subagents` fixture (Claude Code 2.1.301 on `claude-haiku-5-5`, about $0.006: the agent starts one Task whose job is to read a file) shows the `task_started` id on the Task row and the subagent's own call and messages tagged with `parent_tool_use_id`; `tests/replay/claude.test.ts` replays it and `tests/agentCapabilityProof.test.ts` proves `subagents.children` from it. The hand-written frames in `tests/claudeSubagents.test.ts` stay for what a recording can't hold on demand (a stop, an approval from a child).
- **UI.** `ToolRow` for a Task call whose agent said a task started (`childId`): beside its row, `Button size="sm"` **Stop** named "Stop subagent *name*" while the task runs (disabled with "Stopping…" from the press until the row says stopped; back if the agent couldn't be told), and `Tag tone="warn"` "Waiting for you" while a request from that subagent is open. Opened (the row's own expand, `⌃O` setting included, folded by default), it shows a `Tree` of what the subagent did: each call or message a leaf (one line, a shape and a word for a failed one), a Task call inside it a branch with its own `Status`/spinner and word, tool count and duration (`TaskMeta`) and Stop, whose own calls are its leaves. One tab stop, ↑ ↓ Home End → ←, keys on Stop stay Stop's. A Task call with no subagent events, or from an agent whose record has none, is today's ordinary tool row. `Tree` took the small mapping the mock predicted (rows with `dir`, `depth`, `expanded` from the child items); no `ui/` change.
- **Not built, from the mock.** The aggregate "N subagents · M running" header over several parallel Task calls: each Task call is its own row in the log (they are separate tool calls), and each says its own state. The child's tool calls inside the Tree are leaves with no detail view of their own.

## 7. Limits that recover (issue section E, #131)

### 7.1 Windows per account

```ts
interface LimitWindow { kind: 'session' | 'weekly' | 'model-weekly' | 'other'; label?: string
  usedPercent?: number; resetsAt?: string; state: 'ok' | 'warning' | 'blocked' }
interface AccountLimits { agent: AgentKind; instance?: string; windows: LimitWindow[]; updatedAt: string }
```

Kept in `state.json` under `limits` (small, live, not history). Sources: Claude's `rate_limit_event` (one window per event, by `rateLimitType`: `five_hour` → session, `seven_day*` → weekly or model-weekly); Codex's `account/rateLimits/updated` during turns and `account/rateLimits/read` on status refresh. No experimental API. Agents with `usage.limitWindows: false` show "This agent doesn't report its limits".

The Usage page gains **Limits**: per agent, accounts pooled (tightest window first), each account below with its windows as a `Meter` and the reset as text ("Resets in 1 h 52 min · 14:20"; `Countdown` is for things that vanish on their own, not a clock). Percentages of two accounts don't add up, so the pooled line is a sentence with a `Status` ("Work has room; Personal is blocked until 14:20"), not a bar. A window at 80% or more is a warning, at its limit an error. Mock 2.

### 7.2 Paused, then resumed

- A turn that ends with a limit sets `lastTurn.outcome = 'limit'`; the tab shows **Paused: limit · resets 14:20**.
- **Waiting, not Needs you.** The tab stays in triage's `idle` bucket (as an armed resume already does) with the label "Waiting · resumes at 14:20"; Home, the sidebar and the phone show that label. No new bucket.
- **Auto-arm.** When the reset time is known (`usage.resetTime`: Claude, and Codex through its rate limits), the resume is armed with no click (`resumeAfterLimit` setting, default `auto`; `ask` keeps today's offer). When it isn't known, the card offers a time, as today; nothing retries blindly.
- **Provenance.** A resume re-runs the paused turn the way it was started: an attended chat through `send()` with its cap (as today); a flow step or schedule run back through `flows.ts` / `schedules.ts`, with its persona, write scope, read-only hold and `unattended` flag. Today's resume path would lose those; that is fixed here.
- When it fires: one notification ("Resumed after the usage limit"). **Resume now** and **Dismiss** stay on the window and the phone.
- **Continue on account Y**: offered on the paused card when another account of the same agent has no blocked window and `moveChats` allows it; never automatic. Uses the hand-off path (section 5).
- **Schedules and flows** wait for the armed resume while the reset falls inside the run's time budget; otherwise they fail with "The usage limit resets after this step's time budget".

### 7.3 As built (slice 5a)

- **Types and mappers:** `src/shared/limits.ts` (`LimitWindow`, `AccountLimits`, `claudeWindow`, `codexWindows`, `pooled`, `continueOptions`, `codexLimit`). Claude's `utilization` is read as a fraction up to 1 and a percentage above it (the SDK doesn't say). A Codex window of up to 6 hours is the session, one of 6 days or more weekly, a bucket that names a model is that model's.
- **Where it comes from:** `TurnCallbacks.limits(windows)` (Claude on each `rate_limit_event`, Codex on `account/rateLimits/updated`) and the optional driver method `AgentDriver.limits(env, executablePath)` (Codex's `account/rateLimits/read`, no turn), called from Usage → Limits (Refresh, throttled) and, in the background, when an account's status is read. `state.limits` and `snapshot.limits` hold one entry per `(agent, instance)`; a read replaces an account's windows, a notification merges into them. A window whose reset time has passed shows no figure until the agent reports again.
- **Paused:** `Session.lastTurn.outcome` is `'limit'` (type `LastTurnOutcome`; the turn's own `turn-end` stays `error` with `limit`, so flows, schedules and the CLI see an error as before, and `turnOutcomeOf` maps it for code that wants a `TurnOutcome`). `lastTurn.resetAt` carries the time. Triage: `idle`, "Waiting · resumes at 14:20", never `attention` and never "Ready for review" while armed; without an armed resume (Ask me first, a missed one) it is a failed turn that asks for you. The feed (`attention.ts`) leaves no "Turn failed" for a waiting chat and no notification is sent when it pauses; one is sent when it resumes by the clock.
- **Setting:** `resumeAfterLimit` (`auto` | `ask`, default `auto`), Settings → Usage, CLI key `usage.resume-after-limit`. An unknown or past reset time is an offer under both.
- **Provenance:** the turn's `Session.unattended` is kept as `Session.limitHeld` while the tab is paused and copied onto the `LimitResume` (`unattended`), so the resume starts the turn under the same mark (core.ts `send`): a flow step through `FlowService.resumeTurn` (its persona, write scope, read-only hold, unattended flag; the same shape as the sign-in retry), a schedule run through `ScheduleService.resumeRun`. A resume whose run has ended refuses and comes back as missed, saying why. An auto review's reviewer isn't held or resumed.
- **Time budget:** a flow step waits only while the reset fits in what is left of the tightest `minutes` bound of the loops it is in (the wait itself counts no minutes, as a gate's doesn't); a step in no loop has no budget and waits until the resume or Stop. A schedule run's budget is its maximum duration (default 30 minutes) counted from the run's start; a reset after that fails the run with "The usage limit resets after this run's time budget". Both fail when the resume they wait for is dismissed or missed.
- **Imported chats:** the file's `lastTurn.outcome` is read against the known outcomes (anything else is dropped), and a turn that stopped at a limit comes in as an error (`turnOutcomeOf`) without its reset time: the armed resume is the computer's own and doesn't travel, so the chat isn't shown as waiting for one.
- **Continue on account:** `Api.continueOnAccount(sessionId, to)`; offered for another account that reported room and that the agent's move rule allows (`continueOptions`, the same `accountMoveGuess` the picker uses; main refuses what the rule refuses). Not offered for a turn that belongs to a flow step or schedule run.

## 8. Permission honesty (issue section G)

- **Enforced by.** `enforcement.by` is `agent` (Claude's permission modes, Codex's sandbox) or `foreman` (ACP agents, OpenCode, Cursor's review). A `Tag` on the agent's settings page and in the composer's permission tooltip. Read-only is offered only where `by: 'agent'` and `readOnly` is set.
- **Codex on Windows.** The sandbox depends on `windowsSandbox/readiness`, which the adapter reads at start (8.1) and declares; when the sandbox isn't ready, Codex's `enforcement.readOnly` and `scopedWrites` resolve to `none` and its `ceilings` to Never ask alone for that account (every ceiling protection is a sandbox policy), so read-only, scoped writes and a #170 ceiling below Never ask aren't offered rather than promised: `SessionService.resolvePolicy` reads the turn's own account record and the adapter refuses a capped turn itself on a first start. Readiness is kept per account, the default account under its own key (`DEFAULT_ACCOUNT`), never as a fact every account inherits.
- **Ceiling everywhere.** Every path that starts a turn already reaches `SessionService.startTurn`; the only direct `createTurn` callers are the host, worker, assistant and demo files listed in 8.1, each given a request built by `SessionService` (or, for the assistant, its own folder and tools). `tests/turnStartPaths.test.ts` fails on any new `createTurn(` outside those, and the existing cap tests cover the paths.
- **"Always allow"** shows its scope on the card. `session-always` remembers the allow for this session keyed on `(tool kind, normalised command or path)`, shown on the card, and re-checks `isCeilingProtected` under a cap on every request, as Codex's file approvals do. `once-always` (OpenCode): the card has no Always allow button, only Allow, and a line saying "OpenCode can't remember an always-allow; it asks each time". A button that allows once while saying always would mislead.
- **Scoped writes on Codex.** A flow persona's `writes` globs on Codex run the turn with the read-only sandbox and `on-request` approvals; `item/fileChange/requestApproval` inside the globs is accepted, outside declined with a message the agent reads; commands that need to write are declined the same way; MCP servers are set to `prompt` and their calls declined (MCP tools run outside the sandbox). `enforcement.scopedWrites` becomes native for Claude and for Codex where its sandbox is ready.

### 8.1 As built (slice 5b)

Fixtures first, on this Windows machine: `codex/sandbox.jsonl` (the start-up with `windowsSandbox/readiness`), `codex/scoped.jsonl` and `claude/scoped.jsonl` (a persona-like turn held to `writes: ["allowed/**"]`, asked to write one file inside and one outside).

- **Enforced by, in the composer.** The read-only chip's tooltip and the auto-accept chip's carry the record's `enforcement.by` as the same line Settings shows ("Enforced by: the agent" / "Enforced by: Foreman"); no new component. `readOnlyEnforcement` now returns a way only where `by` is `agent`, so a record that said Foreman holds the rules could never offer read-only, whatever its `readOnly` field says; `tests/readOnlyOpinion.test.ts` holds every record to that.
- **Codex's Windows sandbox.** When `initialize` says `platformOs: "windows"` the adapter sends `windowsSandbox/readiness` (no params) and declares the answer for the account: `ready`, or `not-ready` for `notConfigured` and `updateRequired`. Codex's record now `declares: ['windowsSandbox']`; declared facts persist per account in `state.json` beside a version, ride the snapshot, and `SessionService` resolves the record **for the turn's account** (it used one record per agent before), so read-only and scoped writes aren't offered, and are refused with the reason, for an account whose sandbox isn't ready, and the second-opinion dialog reads the account's record too. A turn that asks for either on a sandbox found not ready does not start (the first turn on an account learns it only at start, so the adapter refuses itself). Readiness is per Codex home, so per account: the recorder's new home answers `notConfigured` (the `sandbox` fixture, a real not-ready exchange), and a home with `[windows] sandbox = "unelevated"` answers `ready` without setup or any system change (how `scoped` was recorded). Not read off Windows, and an answer that can't be read declares nothing. A recording lacking the exchange (every older fixture) replays without a warning: `Protocol.tolerated`.
- **Scoped writes on Codex.** `TurnRequest.writeScope` on Codex runs the thread in the read-only sandbox with `on-request` (network as the workspace sandbox has it, off under a ceiling). Codex asks for a file change and the adapter answers itself, never the person: every file inside the globs and not protected by a ceiling, accept; otherwise decline. A command or a permission request that asks is declined (a command that only reads runs in the sandbox without asking, as the recording shows). Repo MCP servers are set to `prompt` (Foreman's own server excepted, as under a ceiling) and the prompt is declined. **The decision carries no text**, so the reason goes into the running turn as `turn/steer` just after the answer ("Foreman declined that: writing “other/no.txt” is outside the folders this step may write in. Writes are allowed only inside allowed/** …. Carry on."); in the recording Codex took the message, wrote only the allowed file and said which it could create. `enforcement.scopedWrites` is native for Codex, resolved to `none` for an account whose sandbox isn't ready. The agent-neutral persona text in `sessions.ts` no longer says "no shell"; the flow checks and `SessionService.writeScope` read the record (their message names the agent, "which Codex can't be held to").
- **Not in this slice.** Scoped writes are proven but a Codex *turn step* is still refused in a flow, by the unattended rule (`features.unattended` is Claude's alone: a turn in a flow has nobody to answer an approval or a question), not by the writes; lifting that is a separate decision. The record's windows fact is only read at a turn's start: Settings shows the static record for an account until it has run once. Windows, `unelevated` sandbox only (the elevated one needs system changes and wasn't tried); macOS and Linux Codex have no readiness step.
- **Ceiling everywhere.** `tests/turnStartPaths.test.ts` fails on any `createTurn` reference outside `src/main/agents/` and six listed files, each with its reason: `sessions.ts` (startTurn), `agentHost/server.ts` and `agentHost/sandboxHost.ts` (the background and sandbox hosts), `cursorWorker.ts`, `assistant.ts` (its own folder and tools, no ceiling applies) and `demoRun.ts`. A declaration of a host's own method is not a call; an alias or `.bind` is.

## 9. Tested against real traffic (issue section H, #152, #151)

### 9.1 Fixture format

JSONL, first line a header, then one frame per line:

```
{"fixture":1,"agent":"codex","scenario":"approval","version":"0.163.0","recordedAt":"2026-11-11","evidence":"recorded"}
{"t":0,"dir":"send","data":{...}}
{"t":42,"dir":"recv","data":{...}}
```

`evidence` is one of `recorded` (real traffic), `edited` (a recording with documented frames substituted), `simulated` (recorded from a protocol fake) or `scripted` (the demo's flow beats). `t` is milliseconds since start. Frames are the transport's own messages: Claude Code's stream-json lines on the CLI process's stdio (below the SDK, so the SDK itself is exercised), Codex app-server JSON-RPC, ACP JSON-RPC, Cursor's worker IPC events.

### 9.2 Recording

`npm run record:agent -- <agent> <scenario>` runs the real driver in a temporary Git repository with a tee on the transport seam (`spawnClaudeCodeProcess`, `AppServerFactory`, `AcpConnector`, Cursor's `fork`) and a scripted user (approve, answer, steer at a frame, interrupt, kill the process). Scenarios: `plain`, `approval`, `question`, `plan`, `steer`, `interrupt`, `limit`, `crash`, `resume`, and (slice 4a) `fork`, `revert`, `compact`, `goal`, `goalclear`. It costs real usage, so it never runs in tests, and uses the cheapest model the agent offers.

**Isolation first, then sanitising.** The recorder runs with a fresh `FOREMAN_DATA_DIR`, no integrations, no repository MCP servers, no provider keys and no hooks, so secrets mostly never enter the traffic. The sanitiser (`src/main/agents/fixtures/sanitize.ts`) then replaces paths (`<repo>`, `<home>`, `<tmp>`), tokens, keys, emails, account and organisation ids with stable placeholders, consistent within a file. `tests/agentFixtures.test.ts` fails if any fixture contains the recorder's home path, an email, a key pattern, a JWT (`eyJ…`) or any `env` value that isn't a placeholder. Text that streams in fragments (Claude's `text_delta`, `thinking_delta` and `input_json_delta`, Codex's item deltas) is read **joined, per stream**, by both the sanitiser and the leak check, because a path or a login name can be cut across fragments and match in none of them; where cleaning the joined text changes it, the cleaned text goes in the first fragment and the rest are empty. The recorder writes a fixture only after the leak check passes, and sanitising a file again continues after the placeholder numbers it already holds.

**What can't be recorded on demand:** a usage limit. `limit.jsonl` is the `plain` recording with the agent's documented limit frames substituted (Claude's `rate_limit_event` with `status: 'rejected'` and its error result; Codex's error and `account/rateLimits/updated`), marked `edited`.

### 9.3 Replay

`ReplayTransport` stands in for the process at the same seam. When the adapter sends, it matches the next `send` frame by `method` (JSON-RPC) or `type` + `subtype` + `request.subtype` (Claude's control protocol), never by content, remaps JSON-RPC ids, and emits the following `recv` frames (`t` scaled; `0` in tests). A Claude control request the fixture doesn't hold (a newer SDK asks something new) gets a generic success answer and a warning, rather than failing the replay. Adapter tests (`tests/replay/<agent>.test.ts`) run each fixture through the real driver and the real `SessionService` (`tests/sessionHarness.ts`) and assert chat items, approvals, limits and turn results.

### 9.4 Records are proven by fixtures

`tests/agentCapabilityProof.test.ts`: for every listed agent and every `native` or `fallback` claim with observable behaviour (steer, plan, questions, approvals, resume, fork, limit windows, cost, subagents), a fixture scenario must exist and its replay test must pass. Agents with no recordings (the generic ACP agents, OpenCode and Cursor here, since none is installed where this was built) are proven against `simulated` fixtures recorded from the ACP conformance fake and Cursor's worker fake, and their record's `evidence` is `simulated`, which Settings says.

### 9.5 Replay in development, and the demo

Replay is **not** an agent kind (a `replay` id would enter every per-agent map and could be persisted by a dev build into data a packaged build later reads). Instead, development builds (`!app.isPackaged`) get **Settings → Experimental → Replay recorded traffic**: while on, Claude Code and Codex run through their own adapters over `ReplayTransport`, choosing a fixture by a word in the prompt (`approval`, `question`, `plan`, `limit`, `crash`, else `plain`). The chat says "Replaying a recording" on each turn. The demo (`npm run dev demo`) registers the same replay drivers instead of `demoRun.ts`'s hand-written turns; its flow beats become `scripted` fixtures.

### 9.6 Evals (#151)

`evals/` with `npm run evals -- [case…]`, run by hand only (real models, real cost). A case has a `source` (issue, PR or failure), a `before` text (the old prompt or tool description) and `after` (current), a `control` that must pass on both, and a check. The runner reports before / after / control and compares with `evals/baseline.json`. First cases: tool choice among `foreman-app` tools (delegate or answer, `wait_for_turn` or polling), persona step endings, chat titles, and PR text that must still describe the diff when the repository holds text trying to redirect it.

**As built.** `evals/README.md` is the guide; `npm run evals -- [case…] [--model <id>] [--runs N] [--update-baseline] [--list]` starts `scripts/evals.mjs`, which runs `evals/run.eval.ts` under its own `vitest.evals.config.ts` (`vitest.config.ts` includes only `tests/**`, so `npm test` and `test:changed` never reach a model). A run uses the Claude Agent SDK with no settings sources, no built-in tools, no saved session and the case's fake tools on an in-process MCP server (`evals/fakeApp.ts`: the app's real tool names, descriptions and schemas, replies canned). Cases are `evals/cases/<id>.ts`: `source`, `before` (`{ value, ref }` with the commit, or `{ none: reason }`), `after` (imported from the module the app reads), `build`, `check`, `runs` (default 3). Each is run as a probe and a control, on `before` and `after`; the report gives the rates, a status (`ok`, `no before`, `before passes (does not discriminate)`, `CONTROL FAILED`, `RUN ERROR`) and the movement against `evals/baseline.json`, which records the model and refuses to mix models or to be written from a failed run. The pure parts (case list, checks, runner, baseline, arguments) are tested without a model in `tests/evals.test.ts`.

Cases: `tool-flow-status-own-run` (#109, before `2ea9850^`), `tool-read-chat-history`, `tool-wait-not-poll`, `persona-qa-ending` (#106, before `f8436a7^`), `chat-title-topic-label` and `pr-text-injection`. Only the first and fourth have an earlier text in history; the others say why they have none (`git log -S` finds the same text since the initial commit). To let evals import what the app sends, the chat-title prompt and its clean-up moved to `src/shared/chatTitle.ts` and the persona's step text to `personaTurnText` in `src/shared/personas.ts`; the text is unchanged. The baseline is empty until one is recorded with the default model (`claude-sonnet-5-5`); the harness was proven on Haiku without recording one. `persona-qa-ending` did not discriminate on Haiku or Sonnet in the first runs (the auto-review prompt, which a real review step also receives, already asks for the block), and the report says so rather than hiding it.

### 9.7 As built (slice 2)

- **The seam** is `src/main/agents/transport.ts`: `setTransportOverride(agent, factory)` with one slot per transport (`claude`: the process starter `trackedClaudeSpawn` takes; `codex`: the `AppServerFactory`; `acp`: the `AcpConnector`; `cursor`: the worker `fork`). Each adapter asks it once, where it starts its agent, and with nothing set starts the real one. The factory is a function of the turn's request, so a replay can pick a fixture by the prompt and a gate can say "not this turn".
- **Code** is in `src/main/agents/fixtures/`: `format.ts` (read, write, header), `replay.ts` (the engine and the three protocols' matching rules), `replayTransports.ts` (the fake process, stream pair and worker), `tee.ts` and `recorder.ts` (recording), `sanitize.ts` (the sanitiser and the leak check), `fakes.ts` and `simulate.ts` (the `simulated` recordings), `replayDriver.ts` (the dev switch). Each real agent's scenarios and prompts are in its folder's `record.ts`.
- **Frames beyond send and recv.** `stderr` (text) and `exit` (`{code, signal}`) are frames too, and a `send` whose data is `{"$":"eof"}` or `{"$":"kill","signal":…}` is the adapter closing or killing the process. A value `"<epoch+N>"` in an `edited` limit fixture becomes the time N seconds after the replay starts, so a recorded reset time is never in the past.
- **Running the recorder.** `npm run record:agent -- <claude|codex> <scenario>` runs the TypeScript drivers under vitest (`vitest.record.config.ts`, the one bundler already installed; `npm test` doesn't include it). `npm run record:agent -- simulated` rewrites the simulated fixtures from the fakes, and `… <agent> limit` rewrites the edited one from `plain`, and `… resanitize` runs every fixture through the sanitiser again in place (idempotent; for when the sanitiser learns something). The sanitiser replaces the account's organisation (`<org>`) and plan (`<plan>`), and every skill, command, agent and plugin the CLI doesn't ship with (`<skill-1>`; the allowlist is `CLI_BUNDLED_COMMANDS` in `sanitize.ts`), which `tests/agentFixtures.test.ts` enforces; the recorder also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which keeps the organisation's claude.ai skills out of the traffic at the source. Isolation: a new config folder holding only the sign-in (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), claude.ai connectors off, shell credentials stripped, the cheapest model; the copy of the sign-in is deleted afterwards and, if the CLI refreshed it, put back.
- **The proof** (`tests/agentCapabilityProof.test.ts`) replays each claim's scenario through the agent's own driver and shows the behaviour. Claims no fixture shows are listed there with the reason (`UNPROVEN`); the list is empty (Codex's and Cursor's `usage.cost`, which their adapters don't report, are now recorded as `false`, and the proof checks a recorded plain turn carries no `costUsd`).
- **The dev switch** is Settings → Experimental → Replay recorded traffic (`replayTraffic`, shown when `import.meta.env.DEV`, applied only when main is not packaged). The demo (`npm run dev demo`) plays a person's chats from recordings the same way; its flow run's own steps are still `demoRun.ts`'s script (a beat writes the files the checks then run), which becomes `scripted` fixtures once the replay can run a beat's write as its frame is played.

## 10. UI summary

All from `src/renderer/src/ui/`; no new component. The HTML mocks and architecture diagrams were kept outside the repository on purpose, as design mocks are (`scripts/publication-paths.mjs`).

1. Settings → Agents → *agent* → **Capabilities**: grouped `ActionRow` list in `Disclosure` groups (groups where everything works start closed), `Glyph` + word per line, **Enforced by** `Tag`, evidence line, version word and **Update**; the composer's disabled Plan chip with its reason.
2. Usage → **Limits**: per agent a pooled sentence with `Status`, per account `Meter` and the reset as text; the paused card with **Resume now**, **Dismiss**, **Continue on account Y**; "Waiting · resumes at" on Home, the sidebar and the phone.
3. The composer's agent picker with accounts and blocked choices with their reason; the hand-off notice; the record from Lineage; the budget setting (`Range`).
4. Subagent child rows with Stop, and an approval card "From subagent X".
5. Codex goal card; "Compacted while idle"; "Interrupted and restarted with your message"; "Context restarted"; permission-mode notices; "always allow" scope; launch problems with Update.

## 11. Slices

Fixtures come before the adapter changes they cover. Each slice is one or a few commits with typecheck, its tests, `test:changed` and `check:ui` passing before the next. **Status** (what is built is described under each section's "As built"; what is not is in section 13):

| Slice | Status |
|---|---|
| 1 Record | Done: records, `resolveCapabilities`, the snapshot field, the branch guard with an **empty** baseline, `foreman agents --json`, the phone, the Settings Capabilities section |
| 2 Replay | Done for Claude Code and Codex (recorded) and Cursor, OpenCode and the ACP agents (simulated); the dev switch. The demo's own flow steps are still `demoRun.ts`'s script (9.7) |
| 3 Versions, protocols, models | Done (4.4). ACP v2 is pinned and checked, not negotiated |
| 4 Adapters | Done for Codex, Claude Code (4a) and Cursor, OpenCode and the ACP agents (4b). Not built: Grok, Kiro and Pi RPC adapters, Codex history injection, Codex subagents, a read-only terminal tab |
| 5 Limits and permissions | Done (5a limits, 5b permission honesty and Codex's scoped writes). Not built: unattended Codex flow steps |
| 6 Hand-off | Done (5.6) |
| 7 Subagents | Done for Claude Code (6.1); Codex's wait for a recorded fixture |
| 8 Evals | The harness, six cases and the guide are built; **no baseline is recorded** and the one persona case does not discriminate (9.6) |
| 9 Docs, review, screens | Done: section 12, a decisions entry, the branch guard's baseline emptied, this review's fixes. **Not done:** `npm run screens` (it needs the real app; run it before the pull request) |

1. **1a Record.** `agentCapabilities.ts`, records for every agent, `resolveCapabilities`, snapshot field, `agentBranches` guard with its baseline, `foreman agents --json`, phone. **1b Moves.** Catalog folder and adapter folders (pure renames), `agentFolders` test. **1c–1e Branches.** Replace the sites by area (main services; shared helpers; renderer and settings panels), lowering the baseline each time; Settings Capabilities section.
2. **Replay** (#152). Fixture format, recorder, isolation and sanitiser, `ReplayTransport` for the four transports, recordings for Claude Code and Codex on today's adapters, simulated ACP / OpenCode / Cursor fixtures, replay tests, capability proof, the dev replay switch, demo on fixtures.
3. **Versions, protocols, models** (#158). Pins (Claude SDK exact), generated Codex protocol and the adapter retyped against the recorded fixtures, version tables, `launchProblem`, model overlay, Update.
4. **Adapters.** Section 3 and permission modes, each with its fixture first.
5. **Limits and permissions** (#131). Sections 7 and 8.
6. **Hand-off.** Section 5.
7. **Subagents.** Section 6.
8. **Evals** (#151).
9. **Docs, review, screens.** Section 12 completed, `docs/guide.md`, a decisions entry, the baseline emptied, `npm run screens`.

## 12. Per-agent reference

One `###` section per agent that can hold a chat, named as the catalog names it, written from its record (`src/shared/agentCatalog/<id>.ts`; the lines Settings → Agents → *agent* → Capabilities draws are the same facts): what works, what works with a fallback (what Foreman does instead, 2.5), what isn't offered, who enforces the permission mode, the versions the fixtures were recorded with, and the fixtures. `tests/agentFolders.test.ts` fails when an agent has no section here, and when a section names different tested versions than its catalog file. **Recorded** means the fixtures are real traffic from the version named; **simulated** means they were recorded from a protocol fake, because the agent isn't installed where this was built (section 9.4), and the record says so in Settings.

### Claude Code

- **Works:** several chats at once, changing the model mid-chat, resume, fork, steer a running turn, Plan mode, questions from the agent, tool approvals and Always allow, MCP servers, subagents as rows with Stop, compaction on request (and idle compaction, opt-in), Restore of files and of the conversation, read-only, all four permission modes, a flow persona's scoped writes, cost, limit windows and reset times. Features: the Foreman assistant, unattended runs (schedules, flows), cloud workspaces, kept running while Foreman is closed, report and diff tools, follow-ups, repository commands, transcript mirror, chat titles.
- **Works with a fallback:** taking a chat over from another agent (the earlier turns go in as attributed text).
- **Not offered:** goals; commands it asks Foreman to run (it starts its own).
- **Enforced by:** the agent (its permission modes; read-only is plan mode, which the chat can't leave). Every #170 ceiling is held.
- **Tested:** Claude Code 2.1.301 (recorded, on `claude-haiku-5-5`). No minimum version is set: nothing says which release first had each message the adapter uses.
- **Fixtures:** `src/main/agents/claude/fixtures`: approval, compact, crash, fork, interrupt, limit (edited), plain, plan, question, resume, revert, scoped, steer, subagents.

### Codex

- **Works:** several chats at once, changing the model, resume, fork (`thread/fork`), steer, Plan mode, questions, goals (`/goal`, the card above the composer), tool approvals and Always allow, MCP servers, compaction on request, Restore of files and of the conversation (`thread/revert`), read-only (its sandbox), all four permission modes, scoped writes (the read-only sandbox with Foreman answering every request itself), limit windows and reset times. Features: cloud workspaces, kept running while Foreman is closed.
- **Works with a fallback:** taking a chat over from another agent (attributed text; `thread/inject_items` stays off until a recorded fixture shows it works).
- **Not offered:** commands it asks Foreman to run, subagents as rows and Stop (until a recorded `collab` fixture exists), cost (it reports no price). It can't run unattended: flow turn steps on Codex are refused (section 8.1).
- **Enforced by:** the agent (its sandbox). On Windows the sandbox must be set up: for an account whose `windowsSandbox/readiness` says it isn't, read-only, scoped writes and every ceiling below Never ask are not offered, and a turn that asks for one doesn't start (section 8).
- **Tested:** Codex 0.163.0 (recorded, on `gpt-5.6-luna`), on Windows.
- **Fixtures:** `src/main/agents/codex/fixtures`: approval, compact, crash, fork, goal, goalclear, interrupt, limit (edited), plain, plan, question, resume, revert, sandbox, scoped, steer.

### Cursor

- **Works:** several chats at once, changing the model, resume (`Agent.resume`), MCP servers, Restore of files. Features: kept running while Foreman is closed, report tools.
- **Works with a fallback:** fork and taking a chat over (attributed text); steer by interrupt and restart (an explicit choice, "Interrupt and send"); Restore of the conversation (a fresh conversation seeded with the chat up to there).
- **Not offered:** Plan mode, questions, goals, approval prompts and Always allow (it never asks), commands it asks Foreman to run, subagents, compaction, read-only, a choice of permission mode, scoped writes, cost, limit windows, reset times.
- **Enforced by:** Foreman (its review). It can't hold any #170 ceiling below Never ask, so a turn capped below it is refused.
- **Tested:** no version: simulated fixtures from the worker's SDK fake only.
- **Fixtures:** `src/main/agents/cursor/fixtures`: interrupt, plain, resume (simulated).

### OpenCode

- **Works:** changing the model, resume, questions, tool approvals, MCP servers, commands it asks Foreman to run (as piped processes, asked about like a shell tool), Restore of files, permission modes (Ask, Ask except edits, Never ask), cost. Features: cloud workspaces, kept running while Foreman is closed.
- **Works with a fallback:** several chats at once (a server of its own for each turn, section 3.2); fork and taking a chat over (attributed text); steer by interrupt and restart; Always allow answered as "once" (the card says so); Restore of the conversation (a fresh conversation).
- **Not offered:** Plan mode (until it lists a plan session mode), goals, subagents, compaction, read-only, scoped writes, limit windows, reset times.
- **Enforced by:** Foreman (it answers `session/request_permission`). Held to Never ask as the only ceiling.
- **Tested:** no version: simulated fixtures only. Its version is read from `initialize.agentInfo.version` per account and shown in Settings.
- **Fixtures:** `src/main/agents/opencode/fixtures`: approval, crash, interrupt, plain, question, resume, terminal, version1, version2 (simulated).

### The ACP chat agents

The eleven agents below run through the generic ACP adapter (`src/main/agents/acp`) and share one record (`acpRecord` in `src/shared/agentCatalog/helpers.ts`), so each section says only what is its own and points here.

- **Works:** several chats at once, changing the model, resume (`session/resume` or `session/load`, else a new conversation and a notice), questions (`elicitation/create` as the question card), tool approvals, MCP servers, commands they ask Foreman to run (`terminal/*` as piped processes: asked about like a shell tool, with the folder and variable names on the card), Restore of files, permission modes (Ask, Ask except edits, Never ask). Cloud workspaces.
- **Works with a fallback:** fork and taking a chat over (attributed text); steer by interrupt and restart; Always allow kept by Foreman for the session (`session-always`, the card names what it lets through); Restore of the conversation (a fresh conversation seeded with the chat up to there).
- **Not offered:** Plan mode until the agent lists a plan session mode (then it turns on), goals, subagents, compaction, read-only, scoped writes, cost, limit windows, reset times.
- **Enforced by:** Foreman. Held to Never ask as the only ceiling.
- **Tested:** none of them is installed where this was built: the fixtures are recorded from the ACP conformance fake (simulated).
- **Fixtures:** `src/main/agents/acp/fixtures`, shared: approval, crash, interrupt, plain, question, resume, terminal (simulated).

### Gemini CLI

The common record above. Tested: none (simulated).

### Qwen Code

The common record above. Tested: none (simulated).

### Kimi CLI

The common record above. Tested: none (simulated).

### Factory Droid

The common record above. Tested: none (simulated).

### GitHub Copilot CLI

The common record above. Tested: none (simulated).

### Goose

The common record above. Tested: none (simulated).

### DeepSeek

The common record above. Tested: none (simulated).

### Pi

The common record above, through `pi-acp` (a different program from `pi`: its own minimum version, 0.17.1, is checked at start). Tested: none (simulated).

### Command Code

The common record above. Tested: none (simulated).

### OMP

The common record above. Tested: none (simulated).

### Antigravity

The common record above, through Google's `antigravity-acp` server (its own minimum version is checked at start). Tested: none (simulated).

## 13. Deferred, and why

- **Grok, Kiro and Pi in RPC mode as full adapters.** None is installed where this was built, so no fixtures can be recorded, and the issue lists nothing without them. They stay as they are (Grok and Kiro terminal agents, Pi a chat agent through `pi-acp`). A follow-up issue holds them.
- **Recordings for Cursor, OpenCode and the ACP chat agents.** Their records are `simulated` until someone with them installed runs `npm run record:agent`.
- **A read-only terminal tab for an ACP agent's terminals.** The terminal panel's tabs are ptys; showing a piped command there needs a new surface, so its output is a tool row in the chat (section 3.2).
- **Sharing OpenCode's server between turns.** Built, then dropped in review: a process's environment names its turn (`FOREMAN_TURN_ID` and token, which `foreman report` attributes by) and ACP has no environment per session, so a shared server would attribute every later turn to the first (section 3.2).
- **Codex history injection and Codex subagents** stay off until their recorded fixtures exist (sections 5.3, 6).
- **ACP v2 negotiation.** Types pinned and checked; negotiating v2 waits for an agent that speaks only v2.
- **Unattended Codex flow steps.** Scoped writes on Codex are proven (8.1), but a turn step in a flow has nobody to answer an approval or a question, and `features.unattended` is Claude's alone; lifting that is a separate decision.
- **The Sonnet baseline for the evals, and a discriminating persona eval.** The suite runs and was proven on Haiku; `evals/baseline.json` is empty until it is recorded with the default model, and `persona-qa-ending` did not tell the old text from the new on Haiku or Sonnet (9.6).
- **The recordings and the `npm run screens` run** that a pull request for this work should carry: recordings of real Cursor, OpenCode and ACP agents need them installed; the screens need the real app.

## 14. Done when (the issue's list, and how it is checked)

| Issue's "done when" | Check |
|---|---|
| Every listed agent's capability list matches what a test proves against its fixtures | `agentCapabilityProof.test.ts` |
| A chat moved Claude → Codex → Claude keeps its thread; the third answers about the first turn; the record is in Lineage | `tests/replay/handOff.test.ts`, which runs the real `SessionService` with **stand-in drivers** that remember only what they were given (not recorded fixtures: a switch spans two agents, and no recording holds both); each agent's own half is proven by its fixtures (`tests/replay/claude.test.ts`, `codex.test.ts`). A live run is noted in the PR |
| A usage limit on a 12-workspace run pauses and resumes without a click, window and phone | `tests/limitPause.test.ts` (12 sessions, fake clock); the phone's side in `tests/mobile.test.ts` (the snapshot carries `limitResume`, `continueOn` and `canInterrupt`) and `tests/mobilePage.test.ts` (the page's card for a paused chat: Resume now, Continue on another account, Dismiss) |
| No `agent === '…'` branch outside the adapters and catalog | `agentBranches.test.ts` with an empty baseline |
| A new agent is one adapter folder, one catalog file, fixtures and a doc section | `agentFolders.test.ts` |

## 15. What the review changed

A review of the first draft against the code and the pinned protocols changed: no refusal for a user-chosen permission mode outside a cap (Cursor would have stopped working with approvals on); the Claude SDK pinned exactly with replay matching on control subtypes; Codex injection described as raw Responses items and gated on a fixture; Windows sandbox readiness and MCP `prompt` for Codex enforcement; resumes keep a flow step's persona and scope, and no blind retries; replay as a driver switch instead of an agent kind; the hand-off record on the existing switch item instead of a new table; a shrinking baseline for the branch guard scoped to agent-named expressions, with per-agent main code moved into driver methods; a smaller record whose `features` derive from the driver and whose declared facts are per account; idle compaction opt-in and reading the real cache TTL; interrupt-and-restart behind an explicit choice and out of attention; ACP terminals as piped processes; "always allow" keyed on the command or path; no new triage bucket; fixtures recorded in isolation and checked for JWTs and `env` values; Codex subagents gated on a fixture; a `createTurn` guard instead of a path list; the version minimum set by hand; and smaller first slices with fixtures before retyping.
