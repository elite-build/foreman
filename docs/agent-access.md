# Outside agents over MCP

A Claude Code or Codex session on the same computer can sign in to Foreman once and then drive it through MCP tools: list and start workspaces, send messages, wait for turns, read replies, answer its own workers' questions and propose schedules. The person at the computer approves each sign-in in Foreman and chooses its access level. A client's level bounds what it may call, and separately bounds the permission mode of every turn it causes, so nothing it starts through Foreman can do more than it was given. The GitHub issue is elite-build/foreman#133; the comparison that motivated it is `docs/research/t3code-review.md` (item 8). It builds on `docs/server.md`.

## 1. What stays the same

- **Foreman's tools stay one catalogue.** The delegation tools in `src/shared/foremanDelegation.ts`, the workspace tools in `src/shared/foremanTools.ts` and their handlers in `src/main/foremanDelegation.ts` and `src/main/foremanActions.ts` serve the outside agent too. It is a third caller, beside an agent turn's `foreman-app` server and the assistant, with its own scope. No tool gains a second implementation.
- **Agents Foreman starts keep their path.** A turn's `foreman-app` server (`src/main/foremanMcp.ts`), its turn grant, and the repository's opt-in "Let agents start workspaces and queue messages" are unchanged, except that a capped turn's grant carries its cap (section 4). An AI employee's run is the one turn whose `foreman-app` offers other tools: only its employee tools (`docs/ai-employees.md`).
- **The CLI socket stays local.** The outside endpoint does not go through it. Its tiers and launch token are unchanged; the act-tier methods that start a turn learn to carry a calling turn's cap (section 4).
- **The phone and browser sessions stay as they are.** An outside agent's sign-in is a separate record with separate credentials; it is never a `MobileDevice` and never reaches `/api/ws`.
- **No account, nothing hosted.** The endpoint listens on loopback only. Nothing is reachable from another computer, and no relay is involved.

## 2. What a level protects, and what it can't

A level bounds what comes **through Foreman**: the MCP tools the client may call, and the approval mode of every turn those tools start or message, and of everything those turns start in turn.

It does not bound the outside agent itself. Claude Code or Codex running as the same user with a shell can read every file that user can, including Foreman's state, the CLI's launch token (`src/main/cli/token.ts` already says it "does not hide anything from an agent running as the same user") and the worktrees, and can run `foreman` commands as if it were the user. Against that agent, its own permission settings are the boundary, as they are today without Foreman. The levels are for an outside agent whose own tools are limited, or that is simply expected to use Foreman's tools, and for a person who wants Foreman's side of the work held to a mode they chose. The approval flow is built so that a cooperating agent can't approve itself by accident (section 6), not so that a hostile one with a shell is contained.

The guide says this in so many words, next to the setup commands.

## 3. Access levels

The person approving a sign-in chooses one of five levels. A level is two separate things, kept as two fields and checked in two places, as the issue asks: what the client may call (its scopes), and the most permissive mode a turn it causes may run in (its ceiling).

| Level | Scopes | Ceiling |
| --- | --- | --- |
| Read only | `read` | none: it can start nothing |
| Ask | `read`, `operate` | `ask` |
| Ask except edits | `read`, `operate` | `ask-except-edits` |
| Auto | `read`, `operate` | `auto` |
| Never ask | `read`, `operate` | `never-ask` |

**Ask** is selected by default. A client never holds `admin` or `window`: no outside agent changes settings, keys, integrations or repositories, approves anything on the user's behalf, or opens anything on this computer's screen.

**The ceiling only lowers.** The order is `ask` < `ask-except-edits` < `auto` < `never-ask`. A turn's policy is the lower of what Foreman would give it now (`approvalPolicyFor` in `src/shared/permissions.ts`) and its ceiling; a level never raises a chat above the user's own settings. A read-only chat stays read-only whatever the ceiling.

**Each agent enforces what it can, and is refused what it can't.** The drivers do different things with the same policy, so the cap is per agent, in `CEILINGS_ENFORCED` and `capPolicy(policy, ceiling, agent)` in `src/shared/agentAccess.ts`:

| Agent | Ask | Ask except edits | Auto | Never ask |
| --- | --- | --- | --- | --- |
| Claude | every tool asks, but reads | edits in the workspace go ahead, the rest asks | auto mode's classifier decides | the app's settings |
| Codex | sandboxed to the workspace (`workspace-write`) with no network; asks before leaving the sandbox, before any file write outside the workspace and before a tool of any MCP server but Foreman's own: commands inside the sandbox don't ask | the same as Ask | sandboxed with no network, never asks: what needs leaving the sandbox fails | the app's settings |
| Cursor, OpenCode and other ACP agents | refused | refused | refused | the app's settings |

Cursor never prompts (`src/main/agents/cursor/index.ts`: under `ask` it runs every tool and posts a notice; only `auto` turns on its review), and an ACP agent asks only when it chooses to, so neither can be held below Never ask. `start_task` with a loadout on such an agent, and `send_task` to such a chat, are refused below Never ask with a message naming the agent, as a read-only chat is refused on an agent that can't enforce it today. The guide shows this table.

**Protected paths under a ceiling.** Below Never ask, a capped turn must not be able to raise its next turn or run code outside its mode by writing the files that configure agents or git. For Claude, a `PreToolUse` hook (the mechanism `writeScopeDecision` already uses) makes file tools on `.claude/`, `.codex/`, `.cursor/`, `.foreman/`, `.switchyard/`, `.mcp.json` and anything under the git directory ask, at every level below Never ask, even where edits would otherwise go ahead; and the git common directory is left out of `additionalDirectories`. For Codex, the git common directory is left out of the sandbox's writable roots, so a capped Codex turn can't write `.git/hooks` or `core.fsmonitor`; committing then asks to leave the sandbox (Ask) or fails (Auto), and the user commits from Foreman. The list is `CEILING_PROTECTED_PATHS` in `src/shared/agentAccess.ts`; a folder name counts at any depth, the worktree's `.git` file and home folders such as `~/.claude` included, without case on Windows. A capped Codex turn's file approvals on these paths ask too, even after "edits for this session".

**Known gaps.** Writes that never reach Foreman as a tool call or an approval aren't covered: a capped Codex turn writing `.claude/`, `.codex/`, `.foreman/` or `.mcp.json` inside the workspace from its sandbox, and a capped Claude turn's shell commands at Auto, which auto mode's classifier judges. The first matters across agents: a Codex turn could write `.claude/settings.local.json` that a later capped Claude turn in the same workspace loads. `Bash(foreman:*)` gets the ask rule, but a `PowerShell(foreman:*)` rule waits until Claude Code's syntax for it is confirmed. A `foreman` command without a turn token is the user's: a capped Codex turn has no network, so it can't reach the CLI socket on macOS (whether its Windows sandbox can still reach the named pipe hasn't been checked), but a capped Claude turn at Auto that calls `foreman` some roundabout way (an absolute path, clearing the token, a raw socket client) is left to auto mode's classifier. These are recorded here rather than papered over; closing them (for example, Foreman checking the protected paths at the end of a capped turn and holding the next one) is a follow-up.

## 4. No escalation

A turn an outside agent causes carries a **cap**, and so does everything that turn causes:

```ts
interface TurnCap {          // src/shared/agentAccess.ts
  ceiling: ApprovalPolicy    // the lowest ceiling on the way here
  grantId: string            // the outside sign-in at the root of the tree
  name: string               // its name, for receipts and Lineage
}
```

**Where the cap lives.** It is persisted, not held in memory, so it survives a restart and a background-host turn adopted after one:

- on a queued message (`QueuedMessage.cap`), on a held first message (`HeldMessage.cap`) and on `createWorkspace`'s first-message options;
- on the user `ChatItem` of the turn it started (`cap`), so anything that continues or retries that turn can read it;
- on the session while the turn runs (`Session.turnCap`), set by `startTurn` and cleared when the turn ends, and cleared at startup for a turn a restart cut off.

`approvalPolicy(session)` caps with `session.turnCap`. Messages the user sends are the user's and carry no cap.

**Every path that starts a turn is named**, and each either carries a cap or inherits the cap of the turn it continues:

| Path | Cap |
| --- | --- |
| `send` (the three `queue.push` sites and the direct start in `src/main/sessions.ts`) | the caller's |
| `createWorkspace`'s first message, held or not (`HeldMessage`, "Start anyway" in `core.ts`) | the caller's |
| A cloud rollover (`queueContinuation`, from `cloud/turnHost.ts`) | the continued turn's |
| A usage-limit resume (`limitResume.ts`), armed by the user or by `foreman resume-at` from a turn | the stopped turn's |
| Stop safely's Retry (`stopSafely.ts`) | the retried turn's |
| A capped message sent with `mode: 'steer'` | queued instead when the running turn's ceiling is higher or absent; otherwise steered, under the running turn's cap |
| Steering a queued message (`steerQueued`) | refused, the message keeping its place, when the running turn's ceiling is higher or absent; otherwise the lower of the two |
| Git actions that send a message (commit and push, create a PR, fix errors, resolve conflicts, a pull that merges), the base-moved prompt, sending the note, adopting a worktree with a prompt, a review hand-off | the caller's, when a capped turn asks through the CLI |
| A fork, reopening a chat, a new tab | no turn starts; the next message decides |
| Auto-fix CI, auto-review, review-thread fixes, the chat's own Continue | started by Foreman or the user; uncapped, as today |

**Down the tree.** A capped turn's `foreman-app` grant holds its cap (`Grant.cap` in `src/main/foremanMcp.ts`), and its `start_task` and `send_task` pass it on, lowered further if the scope already had a lower one. The CLI from inside a turn does the same: every act-tier method that starts or queues a turn (`run`, `new`, `send`, `resume-at`, `resume-now`, `pr-fix-ci`, `pr-threads`, `cloud-continue`) applies the cap of the turn whose token it carries (`identifyCaller`). A `foreman` call without a turn token is the user's, as today; for Claude at an Auto ceiling, `Bash(foreman:*)` is added as an `ask` rule so the classifier can't wave it through, and at Ask and Ask except edits every command asks anyway. The repository opt-in still applies inside the tree.

**Code Foreman runs for the user.** Checks and setup scripts run the workspace's code with the user's full rights, outside any agent's sandbox, so code a capped turn just wrote would run uncapped. Below Never ask, an outside client's `run_checks`, a capped turn's `run_checks`, and `foreman checks` and the setup re-run and retry from a capped turn are refused, saying why; reading check results stays allowed.

**The user's own messages.** From a capped turn, `foreman queue … edit` is refused for a queued message whose cap is absent or higher than the caller's, and `foreman comments add` and `edit` are refused below Never ask, because a comment goes, as the user's, with the next message in any of the workspace's chats.

**Unattended work.** A flow's turn steps and a scheduled run are unattended and run in auto mode (`approvalPolicy` returns `auto` for `session.unattended`). They can't be held lower. A flow run also approves its setup, checks and commands when it starts (`shown: preview.fingerprint`), which is consent that belongs to the user. So:

- `start_flow` is not offered to outside agents in this design, and `start_flow` and `foreman flow run` are refused from any capped turn. Reading a run (`get_flow_status`) is fine.
- `schedule_task` only proposes: the schedule is saved waiting for the user's approval (section 7), and only Auto and Never ask clients may propose one.

**Approvals stay with the user, except a worker's question.** An outside agent may answer a question (an approval of kind `question`) only from a turn in its own tree: one whose `turnCap.grantId` is its own. That is its own worker asking, and the answer is text the worker reads. Tool approvals, plan approvals, gates, picks, check-command consent, repository MCP consent and saved-command consent are the user's: answering a tool approval would let an Ask client run anything.

**Revoking.** Revoking a sign-in refuses its next call, removes what its tree was waiting to start (queued messages whose cap names it in any chat, a new workspace's first message still waiting for setup, one held back by a failed setup, and usage-limit resumes armed under its cap: `Core.agentGrantRevoked`), refuses any later message or turn whose cap names it (a cloud continuation included), and leaves running turns to finish under their cap. A sign-in that ends any other way (its own refresh token revoked, or a reused code or refresh token) does the same. Text it already put in a conversation stays there, and a later turn the user sends in that chat can read it; the chat's receipt says who sent it.

**Checked when called.** Every tool reads the grant when it runs and again after each await (`refresh()`), so revoking or turning access off is felt at once.

## 5. The endpoint

A loopback listener of its own, `http://127.0.0.1:47634` by default (`agentAccessPort`, changeable like `devicePort`), in `src/main/agentAccess/server.ts`. It is off by default, turned on with **Let agents on this computer connect** (Settings → Data & devices → Agents on this computer; `devices.agent-access` from the CLI; `agentAccessEnabled` in `Settings`). It is not on the phone listeners: the private one is what Tailscale Serve forwards to, so anything on it is reachable from the tailnet.

| Route | What it is |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP, with `Authorization: Bearer <access token>`. Stateless (a new server and transport per request, `sessionIdGenerator: undefined`), JSON responses (`enableJsonResponse: true`). Body at most 1 MB. When the HTTP request closes, the server is closed, which aborts its tool handlers (the transport alone does not). |
| `GET /mcp`, `DELETE /mcp` | `405`: no server-sent stream, no MCP session to end. |
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | RFC 9728: the resource `http://127.0.0.1:<port>/mcp`, and this origin as its authorization server. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: the endpoints below, `code` only, `authorization_code` and `refresh_token`, PKCE `S256` only, client authentication `none`, `scopes_supported` the levels. |
| `POST /oauth/register` | RFC 7591 dynamic registration, public clients only. |
| `GET /oauth/authorize` | Starts a sign-in and shows the waiting page. |
| `GET /oauth/authorize/status` | The waiting page's poll. |
| `POST /oauth/token` | Codes and refresh tokens for tokens. |
| `POST /oauth/revoke` | RFC 7009. |
| `GET /oauth/page.js`, `/oauth/style.css` | The waiting page's script and style (no inline script). |

MCP's specification makes registration a MAY and client metadata documents a SHOULD; clients fall back to registration, which is all this server offers. The SDK's `server/auth` helpers need `express`, which Foreman doesn't use, so only its schemas (`@modelcontextprotocol/sdk/shared/auth.js`) are reused, and the routes are plain `node:http`.

**Guards, on every request.** The `Host` header must be exactly `127.0.0.1:<port>`; `localhost` is refused, so the issuer and resource are one origin and a rebound DNS name can't reach the listener. A request with an `Origin` header is refused unless it is this origin (the waiting page's poll). There are no CORS headers. A missing, bad, expired or revoked token on `/mcp` is `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`. Headers as the phone routes: `no-store`, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, and a CSP for the waiting page.

A listener that can't bind turns the setting off and says why, loudly: another program, or another user of this computer, may hold the port while Foreman was closed. Turning it off closes the listener (and its open connections, so a waiting `wait_for_turn` doesn't hold the close) and forgets what lives only in memory: sign-ins still waiting, codes, access tokens and refresh grace pairs. Approved sign-ins are kept, and their clients refresh once it is back.

Neither setting is copied by Git configuration backup (`LOCAL_ONLY_SETTINGS` in `src/main/gitBackup.ts`), so restoring a backup never opens this listener on another computer. Neither is in `READABLE_SETTINGS`, as `devicePort` isn't.

## 6. Signing in

OAuth 2.1 authorization code with PKCE, as MCP's authorization specification asks, so Claude Code and Codex do it themselves. The approval happens in Foreman, never in the browser page, and the person approving **types the code the browser page shows**: a loopback port is reachable by every user of the computer and by every process of this one, so the page proves nothing by itself, and a code read off Foreman's screen and compared by eye is weaker than one typed from the page the person opened.

1. **Discovery.** The client calls `/mcp`, gets the `401`, and reads the two metadata documents.
2. **Registration.** `POST /oauth/register` with `client_name` and `redirect_uris`. Each redirect must be `http` on `127.0.0.1`, `[::1]` or `localhost`; there is no remote redirect, since nothing remote can reach this server. The answer is a random `client_id`, no secret. Registrations are kept (`agentAccess.clients` in `state.json`: id, name, redirect URIs, `createdAt`, `lastUsedAt`, `everSignedIn`), at most 50. One that has never had a sign-in is dropped after a day; one that has had a sign-in is kept, so a client whose sign-in was revoked can sign in again with the `client_id` it cached. When the list is full, a new registration drops one: the oldest that never signed in first, then the least recently used with no current sign-in. A client with a current sign-in, or with a sign-in waiting, is never dropped; when every one has a current sign-in, registration is refused (`invalid_client_metadata`) until one is revoked.
3. **Authorization.** The browser opens `/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, and `resource` if sent (it must be this resource). The redirect must be one the client registered, with the port ignored for loopback hosts (RFC 8252 §7.3: a native client picks a free port each time). A bad client or redirect shows an error page and never redirects; any other bad parameter redirects back with the OAuth error. A good one creates a pending sign-in for five minutes with a six-digit code and shows, in the user's language (`mainT`): "This sign-in calls itself *Claude Code*. To let it use Foreman, type **123 456** in Foreman." The page polls once a second. At most three sign-ins wait at once; a fourth is refused with an error page, never by dropping one that waits.
4. **Approval.** In Settings → Data & devices → Agents on this computer, each waiting sign-in shows what it calls itself and where it will return (`127.0.0.1:53682`), a field for the code, the level (Ask selected), and **Approve** and **Deny**. Approve checks the typed code against that request in constant time; three wrong codes deny it. A request raises a system notification whose action opens that section (action `agent-access`), at most one a minute (`WaitingNotices`, `src/main/agentAccess/notice.ts`). It is of kind `info`, so it is not pushed to paired phones, which hear only what needs the user. From a terminal, `foreman agent-access approve [<id>] [--level …]` asks for the code interactively and refuses when its input isn't a terminal, so an agent's shell tool, which usually has none, doesn't approve by accident; it is friction, not a boundary (section 2): an agent with a shell can give itself a terminal or read the waiting page; there is no `--code` argument and no `--yes`. With no id and several sign-ins waiting, it lists them and asks which by number; an id may be the start of one, or a name only one waiting sign-in has. `foreman agent-access deny [<id>]` takes the same optional id. A phone or browser with Full control can approve too (the Api methods are `admin`). Nothing in Foreman shows the code, so no read of Foreman's state reveals it.
5. **Redirect.** Approved, the page goes to `redirect_uri?code=…&state=…` (and `iss`) with a one-time code good for 60 seconds, bound to the client, the exact redirect, the challenge and the chosen level. There is one resource, so it isn't bound to the code: a `resource` sent to `/oauth/authorize` or `/oauth/token` must be this one (`invalid_target` otherwise). Denied or expired, it goes there with `error=access_denied`.
6. **Tokens.** `POST /oauth/token` (`application/x-www-form-urlencoded`) with the code, `redirect_uri`, `client_id`, `code_verifier` and `resource` if sent: the verifier is checked against the challenge (SHA-256, constant time) and the answer is `access_token` (an hour), `token_type: Bearer`, `expires_in`, `refresh_token` and `scope` (the level). That creates the sign-in record. A code used twice revokes what it was exchanged for.
7. **Refresh.** `grant_type=refresh_token` answers a new pair and retires the old refresh token. For 60 seconds the retired token answers the same new pair again, because several processes of one client share a stored credential and may refresh at once. After that, the retired token presented again revokes the sign-in: someone copied it. The new pair is held in memory only, so a retired token presented within the 60 seconds after Foreman restarted (or after access was turned off and on) gets `invalid_grant` ("just replaced") without revoking anything: the retirement time is in the vault, so it isn't taken for a copy.

**The records.** In `state.json`, top level (`agentAccess: { clients, grants }`), not in `Settings`, which goes to the renderer, phones and Git backup. Left out of export, backup and device transfer. No migration: the field is new.

```ts
interface AgentGrant {       // src/shared/agentAccess.ts
  id: string                 // random UUID
  clientId: string
  name: string               // what it calls itself, at most 50 characters: "Claude Code"
  redirect: string           // host and port it last returned to, for the list
  level: AgentAccessLevel    // 'read' | 'ask' | 'ask-except-edits' | 'auto' | 'never-ask'
  grantedAt: string
  lastSeen?: string          // updated at most once a minute
}
```

The refresh token's SHA-256, current and previous with its retirement time, is in the vault (`SecretStore`, `agent-access:<grantId>`). Access tokens live only in memory, so restarting Foreman ends them and the client refreshes. Revoking deletes the record and the vault entry and ends its access tokens at once. A sign-in never expires on its own.

## 7. The tools

Each tool names the scope it needs, in `OUTSIDE_TOOL_SCOPES` (`src/shared/agentAccess.ts`, exhaustive over the tools offered); a read-only client is never offered an `operate` tool, and each refuses at call time anyway. Descriptions are the existing ones, which already treat returned content as data; where a description says "the caller's repository", the outside variant says `repoId` is required.

| Tool | Scope | Notes |
| --- | --- | --- |
| `list_delegation_options` | `read` | Every repository, workspace and loadout, as the assistant sees them; each loadout says which levels its agent can be held to. No flows. `delegationEnabled` is false for a read-only client. |
| `get_task_status`, `get_turn_result`, `wait_for_turn` | `read` | As today. `wait_for_turn` ends when the HTTP request closes. |
| `get_workspace_status`, `get_check_results` | `read` | With `workspaceId` as an argument. |
| `get_flow_status` | `read` | Needs a `runId`. While Flows are on. |
| `list_questions` | `read` | New. Pending `question` approvals from turns in this client's tree, with workspace, chat, questions and options. Content is data. |
| `list_schedules` | `read` | New. The schedules, their state and next run, with `pausedKind` and `proposedBy`; also the templates a schedule may run (`templates: [{ id, name, repoId? }]`, written-out ones only) and, while Flows are on, the flows with their inputs, so `schedule_task` has ids to name. |
| `start_task` | `operate` | `repoId` required; refused when the loadout's agent can't hold the ceiling. Carries the cap to the first message. |
| `send_task` | `operate` | Refused when the chat's agent can't hold the ceiling. Carries the cap. |
| `cancel_turn` | `operate` | As today. |
| `run_checks` | `operate` | Already-approved checks only, as today, and Never ask only: checks run the workspace's code with the user's full rights (section 4). |
| `answer_question` | `operate` | New. `{ approvalId, answers?: Record<question, answer>, skipped? }`: one `question` approval from this client's tree, the keys checked against its questions (a key it doesn't ask is refused, and so are no answers without `skipped`), each answer cut to 2,000 characters, and a question left out answered `(no answer)`, as the phone route does; `via: 'outside'`, with the client's name as who answered. Refuses any other kind or another tree's. |
| `schedule_task` | `operate` | New, Auto and Never ask only (offered from Ask, refused below Auto saying why). `{ repoId, templateId \| flowId, inputs?, baseBranch?, recurrence, startDate, time, timezone?, weekdays?, dayOfMonth?, model?, maxMinutes?, afterRun? }`, validated as `saveSchedule` validates: exactly one of `templateId` and `flowId`; `model` (a Claude model, checked as `foreman schedules add --model` checks it) is required with a template and refused with a flow, whose steps name their own; `inputs` fill a flow's inputs, since a scheduled run can't ask, and are refused with a template; a flow only while Flows are on. Unset fields default as the Schedule dialog would: the repository's default branch, this computer's time zone, the start date's weekday and day of the month, 30 minutes. Saved as a proposal (below). |

Not offered: `start_flow` (section 4), `open_preview` (it opens a panel in the window), `run_foreman` (the CLI fallback; its reads are covered above), and `decide` (a flow step's own tool).

**A proposed schedule.** `Schedules.propose()` saves it with `state: 'paused'`, a new `pausedKind: 'proposed'`, `proposedBy: { grantId, name }` and no `approved` fingerprint (`approved` and `approvedAt` become optional, present on every other schedule). `tick` and `checkFingerprint` skip it, and `pause` and `resume` refuse it, so pausing it as the user's can't let `resume` start what nobody approved. Automations lists it as "Proposed by Claude Code (outside agent)", and it runs only once the user opens it in `ScheduleDialog`, which shows it as proposed (the cadence, model, time limit, what happens after a run, and a flow's inputs and run approval) with **Approve**, or **Change before approving** for the ordinary form, where saving approves the changes. Either approval is the ordinary `approveSchedule` (or `update`), which records the fingerprint; `foreman schedules approve` works on a proposal too. Deleting it is the user's; the client has no tool to delete its proposals.

**How a call runs.** `src/main/agentAccess/tools.ts` builds an `McpServer` for the grant's level and calls the handlers with a `DelegationScope` that has no workspace (like the assistant's), `readOnly` for a read-only client, `cap` from the grant, and the request's abort signal. Each call is timed as `mcp.<tool>` (`docs/telemetry.md`).

**Who did it.** `WorkspaceStartedBy` gains `{ via: 'outside'; grantId: string; name: string }` beside its current shape (which keeps its required `sessionId`), and `MessageOrigin` gains `{ kind: 'outside'; grantId: string; name: string }`. A message's receipt in the chat and in the phone's transcript says "Sent by Claude Code (outside agent)", a queued one is tagged "Outside agent", and a question's answer is listed in Home's Recent card as answered "by Claude Code (outside agent)". The Lineage tab (`src/shared/lineage.ts`) draws the sign-in as a node of its own, "Claude Code (outside agent)", with "started by" edges to the workspaces it started (from `Workspace.startedBy`) and "sent by" edges to its messages (from `MessageOrigin`); "started by" appears only there.

## 8. Setting a client up

Settings → Data & devices → Agents on this computer shows, once access is on, the address and how to add it:

- **Claude Code:** `claude mcp add --scope user --transport http foreman http://127.0.0.1:47634/mcp`, then `/mcp` in a session and **Authenticate**. Without `--scope user` it is added to the current project only.
- **Codex:** `codex mcp add foreman --url http://127.0.0.1:47634/mcp`, then `codex mcp login foreman`. Older releases needed the remote MCP client turned on in `~/.codex/config.toml`; the minimum version is recorded in section 13 once checked.

`foreman agent-access status` prints the same. Both, and that each client accepts an `http` loopback issuer, are still to be checked by hand (section 13); until then the guide gives them saying so.

**ChatGPT** calls its connectors from OpenAI's servers, which can't reach a loopback address; see section 11.

## 9. In Foreman

- **Settings → Data & devices → Agents on this computer**: the switch and the port; the address and the setup commands; each waiting sign-in (what it calls itself, where it returns, a code `TextInput` in a `Field`, the level as a `RadioList` with one line per level from the table in section 3, **Approve** / **Deny**); and the signed-in agents as `ActionRow`s with level, when approved and last used, and **Revoke**. Composed from `components/settings/controls.tsx` (`Section`, `ToggleRow`) and `ui/`; no new component.
- **The Api**: `agentAccessInfo` (`read`; it holds no codes, so it needs no filtering), `agentAccessConfigure`, `agentAccessApprove(id, code, level)`, `agentAccessDeny`, `agentAccessRevoke` (`admin`), in `METHOD_SCOPES`. A change broadcasts an `agent-access` event, `always` in `EVENT_REACH`.
- **The CLI**: `foreman agent-access status | pending | approve [<id>] [--level …] | deny [<id>] | revoke <id-or-name> [--yes]`, in `src/main/cli/agentAccess.ts` and `src/cli/commands/agentAccess.ts`; `pending` lists what each calls itself, where it returns and when it expires; `approve` prompts for the code (section 6), `revoke` asks to confirm unless `--yes`; every verb that changes who may sign in is the `admin` tier; `docs/cli.md` regenerated.
- **Settings plumbing**: `agentAccessEnabled` and `agentAccessPort` through `types.ts`, `store.ts`, `settingsSchema.ts` (`devices.agent-access`, `devices.agent-access-port`), `settingsRegistry.ts`; neither is in `READABLE_SETTINGS`, following `devicePort`, and both are left out of Git backup (section 5).
- **Text**: every word through `src/shared/i18n`, in every locale, including the waiting page (`mainT`). The name `AgentAccess` is taken by `src/shared/integrations.ts`; this feature's types are `AgentAccessLevel`, `AgentGrant`, `AgentClient` and `TurnCap`.

## 10. Decisions this design takes

These follow from the review of the first draft; each is a place where a reasonable person might choose otherwise.

1. **The levels bound Foreman's side only** (section 2). Containing an outside agent that has its own shell is its own permissions' job.
2. **Agents that can't hold a ceiling are refused below Never ask** (section 3): Cursor and the ACP agents. Codex's Ask and Ask except edits are the same sandboxed mode.
3. **Capped turns can't write agent or git configuration**, and capped Codex turns can't commit without leaving the sandbox (section 3).
4. **No flows for outside agents** in this design (section 4): a flow run approves consent that is the user's. A later design can let an outside agent propose a run the user approves, as with schedules.
5. **The person types the code** (section 6), and the CLI approves only from a terminal, which stops an agent approving itself by accident, not one set on it.

## 11. What is not in this design

- Reaching the endpoint from another computer, including ChatGPT's connectors. A public endpoint needs a threat model of its own; the phone and browser server (`docs/server.md`) is the remote path.
- Starting flows from an outside agent, or proposing a run for approval.
- Limiting a sign-in to some repositories; a later addition to `AgentGrant`.
- Changing a sign-in's level in place. Revoke it and approve it again, as a phone.
- A per-call ceiling header (T3 Code's `t3-mode-limit`). The level is the only ceiling.
- Idempotent retries (`clientRequestId`). `send_task` and `start_task` return ids a client can check before resending.
- Outside agents answering tool or plan approvals, gates, picks, consent, or another tree's questions.

## 12. Build order

Each slice leaves `npm run typecheck`, `npm test` and `npm run check:ui` green. Slices 1 to 5 are built; of slice 6, the docs are written, and the review and the checks by hand (section 13) are still to do.

1. **Levels and the cap.** Built. `src/shared/agentAccess.ts` (levels, scopes, order, `CEILINGS_ENFORCED`, `capPolicy`, `CEILING_PROTECTED_PATHS`, `TurnCap`); the cap on every path in section 4's table, persisted; `approvalPolicy`; the protected-path hook and writable roots; `Grant.cap` and its hand-down in `ForemanMcp`, `ForemanDelegation` and the CLI's act-tier methods; capped `start_flow`/`flow run` refused. Tests: the cap table per agent, each path in the table, a delegated child's and a CLI child's cap, a restart clearing `turnCap`, the protected paths, the refusals.
2. **The endpoint and sign-in.** Built. `src/main/agentAccess/` (listener, guards, metadata, registration, authorize and the waiting page, token, refresh with its grace window, revoke, the records); the settings end to end; core wiring. Tests on loopback with a real HTTP client: discovery, registration rules, loopback port matching, PKCE, typed-code approval and wrong codes, code reuse, refresh rotation, grace and reuse, revoke, Host and Origin guards, the waiting limit.
3. **The tools.** Built. `src/main/agentAccess/tools.ts` over Streamable HTTP; `OUTSIDE_TOOL_SCOPES`; `list_questions`, `answer_question`; `startedBy` and the origin through receipts and Lineage; revoking drops queued messages. Tests with the SDK's own client against the listener: tools per level, read-only refused, an agent that can't hold the ceiling refused, revoked mid-wait, a started task's cap, another tree's question refused.
4. **Foreman's side.** Built. The Api methods and scopes, the event, the settings section, the notification, `foreman agent-access`, i18n. Tests for the section, the approval with a typed code, and the CLI's terminal check.
5. **Proposed schedules.** Built. `pausedKind: 'proposed'`, `Schedules.propose()`, `list_schedules`, `schedule_task`, the Automations row and the approval in `ScheduleDialog`. Tests.
6. **Docs and review.** Docs written: `docs/guide.md` ("Agents on this computer", with section 2 and the table in section 3), `docs/decisions.md`, `docs/telemetry.md` (`mcp.<tool>`), `docs/windows.md` (item 10) and `README.md`. Still to do: a fresh-eyes review and its fixes, and the manual checks below.

## 13. Checked by hand

| Check | Status |
| --- | --- |
| Claude Code: `claude mcp add --scope user --transport http …`, authenticate, type the code in Foreman at each level; Read only offers no changing tools; Ask starts a task whose tool calls ask in Foreman. | not yet run |
| Codex: `codex mcp add … --url`, `codex mcp login`, approve, list and send; record the minimum version. | not yet run |
| Two Claude Code sessions sharing one sign-in refresh at once and both keep working. | not yet run |
| Revoke while Claude Code waits on `wait_for_turn`: the call fails and the next one asks to sign in again. | not yet run |
| Approve from a terminal with `foreman agent-access approve` while Foreman runs `--headless`. | not yet run |
| On Windows: `foreman agent-access approve` prompts in PowerShell, Command Prompt and Windows Terminal, and refuses when its input is piped; a capped turn asks before writing `.claude\settings.json`, `.MCP.JSON` or a file in the git folder named with backslashes. | not yet run |
| All of the above on macOS. | not yet run |
