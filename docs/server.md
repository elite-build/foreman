# Foreman as a server

Foreman's main process serves one typed API to every client: the desktop window, a paired phone, a browser, and a paired computer. Each client holds a session with scopes, gets a snapshot of the state and then a stream of changes, and the server keeps running with no window open. This document is the design and the reference for `src/shared/api.ts`, `src/main/api/`, the client in the renderer, and the behaviour the tests pin down. The GitHub issue is elite-build/foreman#126; the comparison that motivated it is `docs/research/t3code-review.md`.

## 1. What stays the same

- **The API is `Api`, `Signals` and `MainEvent` in `src/shared/types.ts`.** The server does not get a second vocabulary. A method is a name in `API_METHODS`, a change is a `MainEvent`, and the state is an `AppSnapshot`. The window, the phone and a browser call the same methods and read the same events.
- **The core stays where it is.** `Core` in `src/main/core.ts` implements `Api` once. The server is a layer around it: it decides who may call what, and it carries calls and events over each transport.
- **The desktop window keeps Electron IPC.** The renderer stays sandboxed and the preload bridge stays the window's transport. It becomes one client of the server with a local session, not a WebSocket client. This is the boundary the T3 Code review and its second reviewer both said to keep.
- **The CLI socket stays.** Its tiers (`read`, `act`, `admin`) and launch token in `src/main/cli/policy.ts` assume everyone on the socket is on this computer, which is true. It is not exposed over the network. Its tier names map onto the scopes below (`act` is `operate`); moving the CLI onto the API is a later step, not this one.
- **Paired computers keep their channel.** The encrypted TCP channel in `src/main/remote/` stays the transport between two Foremans. Its host now serves calls through the same dispatcher as every other client, so it has the same rules, but its frames and pairing are unchanged.
- **The no-account promise.** The server runs on the user's computer and is reached through the connections Foreman already has: the loopback listener behind Tailscale HTTPS, or the opt-in same-Wi-Fi listener. Nothing is hosted.

## 2. Scopes

A session holds a set of scopes. Every method in `Api` names the scope it needs, in `METHOD_SCOPES` in `src/shared/api.ts`, and that record is exhaustive at compile time (`satisfies Record<keyof Api, Scope>`), so adding a method without placing it fails `npm run typecheck`.

| Scope | May call | Held by |
| --- | --- | --- |
| `read` | Reads: snapshots, chats, diffs, checks status, git status, history, usage, settings reads. | Every session. |
| `operate` | Work on workspaces and chats: send, cancel, approve, create and archive workspaces and chats, run checks, git actions, PRs, flows, schedules reads, terminals. | Phones and browsers approved for operating (the default), computers, the window. |
| `admin` | Changing how Foreman is set up or moving data out: settings writes, keys and environment, integrations, repositories, templates, backups, import and export, revoking devices. | Phones and browsers approved for full control, computers, the window. |
| `window` | What only makes sense on the computer with the screen: file pickers, open-in, previews, dictation, quitting and updating, the computer chip, revealing a secret. | The desktop window only. |

`admin` includes `operate`, which includes `read`. `window` is separate: a network session never has it, however it was approved, and a paired computer never has it either (today's `LOCAL_METHODS`, `UNAVAILABLE_REMOTELY` and `SECRET_METHODS` in `src/shared/remote.ts` become the `window` entries of `METHOD_SCOPES`, and `hostAccepts` is derived from it). Signals have the same treatment in `SIGNAL_SCOPES`: `ptyWrite`, `ptyResize`, `ptyKill` and `saveTerminals` are `operate`; `setUnread` and `setBattery` are `window`.

A refused call fails with the error code `refused` and a message that names the scope ("This phone can watch but not operate. Approve it again with more access."). Nothing is silently downgraded.

## 3. Sessions

A session is what a client holds after signing in. The desktop window holds an implicit local session with every scope. Every other session is a record:

```ts
interface ApiSessionRecord {
  id: string                 // random UUID
  kind: 'phone' | 'browser'  // what signed in; 'computer' sessions come from pairing in src/main/remote/
  name: string               // "iPhone", "Chrome on Mac"
  scopes: Scope[]            // ['read'], ['read','operate'] or ['read','operate','admin']
  transport: 'private' | 'lan'
  createdAt: string
  lastSeen?: string
  push?: …                   // the phone's web push subscription, as today
}
```

These are today's `MobileDevice` records in `state.json` (`mobileDevices`), extended with `kind` and `scopes`; an existing record without `scopes` is read as `['read', 'operate']`, which is what a phone could do before. The credential stays what it is: a random secret in the vault under `mobile:<id>`, handed to the client once as the `foreman_mobile=<id>.<secret>` HttpOnly cookie. A cookie goes with the WebSocket upgrade from the same origin, so a browser client never handles a token. A client that is not a browser may instead send `Authorization: Bearer <id>.<secret>` on the upgrade.

**Signing in** is the pairing flow that exists: the desktop shows a QR code or link with a one-time secret, the client opens it, both show a six-digit code, and the person at the desktop approves. The approval now also chooses the scopes, with **Operate** selected: Watch (`read`), Operate (`read`, `operate`), Full control (`read`, `operate`, `admin`). The name and kind come from the client's hello. A Foreman with no window is signed into from a terminal instead: `foreman phone link [--lan | --private] [--browser]` turns the connection on if it is off and prints the one-time link (`/app?pair=…` for a browser), `foreman phone pending` shows who is asking, and `foreman phone approve <code> [--access read|operate|admin]` approves the sign-in only when the code typed is the one the device shows, so the person approving has seen it. `foreman phone status`, `deny` and `revoke <id-or-name>` complete the dialog's set; every one that changes who may sign in is the CLI's `admin` tier, so an agent turn can't call it.

**Revoking** deletes the record and the vault secret, as today, and now also closes that session's live connections with a `bye` whose reason is `revoked`. A revoked client shows that it is signed out and offers nothing else.

**Expiry.** The private cookie lasts a year and the same-Wi-Fi cookie a day, as today. A session that has not been seen for 90 days is listed as stale in the pairing dialog; it is not removed on its own.

## 4. The dispatcher

`ApiDispatcher` in `src/main/api/dispatch.ts` is the one place a call enters the core from any client:

```ts
invoke(session: ApiSession, method: string, args: unknown[]): Promise<unknown>
signal(session: ApiSession, method: string, args: unknown[]): void
```

It checks, in order: the method is in `API_METHODS`; the session holds `METHOD_SCOPES[method]`; then it calls `core.api[method](...args)` under `perf.timed('<kind>.<method>')`, where kind is `ipc` for the window (the name telemetry already uses), `ws` for phones and browsers, and `remote` for a paired computer. Arguments are passed through as they are: validation of argument shapes stays in the core's methods, which already treat every caller as untrusted.

Callers:

- `ipcMain.handle('foreman:invoke')` in `src/main/index.ts` dispatches with the window session, after the sender check it already does and through the remote router when the window shows another computer.
- `RemoteHost` in `src/main/remote/host.ts` dispatches with a `computer` session.
- The WebSocket server and the phone's HTTP routes dispatch with the record's session.

## 5. The stream

Clients get a snapshot and then changes. The server numbers every broadcast (`seq`, increasing for the life of the process), the welcome says the current `seq`, and the client then calls `getSnapshot`. A `state` event carries a whole `AppSnapshot`, and main already coalesces them to one per microtask and sends none when nothing changed, so a client that misses events heals on the next `state` event, and a client that reconnects simply fetches a fresh snapshot. There is no event log to replay. That is a deliberate choice: Foreman's state fits in one snapshot (about 32 KB for 12 workspaces), the renderer already reconciles unchanged objects, and an event store would be a second source of truth.

**What a session is sent** is bounded by its *view*, which the client sets with a `view` frame:

| Event | Sent when |
| --- | --- |
| `state`, `approval`, `approval-resolved`, `notify`, `attention-history`, `archive-progress`, `assistant-threads` | Always. |
| `chat-item`, `chat-append`, `chat-reset`, `assistant-item` | The event's session is in the view (`sessionId`), or the view is `all`. |
| `pty-data`, `pty-exit`, `pty-state`, `setup-log`, `cloud-build-log`, `clone-progress`, `auto-run` | The view is `all` and the session has `operate`. |
| Window events (`WINDOW_EVENTS` in `src/shared/remote.ts`: browser panel, navigation, dictation, tour, quit, computer chip) | Never. |

A phone views one chat at a time; the browser client views `all`, like the window.

**Backpressure.** Each connection has an outbound budget. Above 4 MB buffered, the server keeps only the newest `state` event and drops `pty-data` and `chat-append` for that connection; above 16 MB it closes the connection with `bye` reason `slow`, and the client reconnects and fetches a snapshot. The budgets are constants in `src/main/api/socket.ts`, and `tests/apiSocket.test.ts` pins them.

## 6. The wire

The WebSocket is served on the phone listeners that exist in `src/main/mobile.ts`: `127.0.0.1:47632` for the private HTTPS connection through Tailscale, and the opt-in same-Wi-Fi address on `47633`. The upgrade is `GET /api/ws`. It passes the same guards as every request: the same-Wi-Fi host and subnet check, an `Origin` that matches the listener, and a valid cookie or bearer credential. There is no WebSocket in the Electron window and no new port.

The library is `ws` (MIT, already in the dependency tree through the Daytona SDK; Node and Electron ship a WebSocket client but no server). Frames are JSON, one message each, 1 MB maximum inbound, `API_PROTOCOL = 1` in `src/shared/api.ts`:

```ts
// client → server
{ t: 'hello', protocol: 1, version: string, client: { kind: 'phone' | 'browser', name: string }, view?: View }
{ t: 'call', id: number, method: string, args: unknown[] }
{ t: 'signal', method: string, args: unknown[] }
{ t: 'view', view: View }            // { all: true } | { sessionId?: string; workspaceId?: string }
{ t: 'ping' }

// server → client
{ t: 'welcome', ok: true, session: { id, name, kind, scopes }, version, platform, name, seq }
{ t: 'welcome', ok: false, refused: 'protocol' | 'version' | 'credential' | 'scope' }
{ t: 'reply', id, ok: true, value }
{ t: 'reply', id, ok: false, error: string, code?: 'refused' | 'unavailable' | 'failed' }
{ t: 'event', seq: number, event: MainEvent }
{ t: 'bye', reason: 'revoked' | 'slow' | 'shutdown' | 'off' }
{ t: 'pong' }
```

Rules: the first frame must be `hello`, within 5 seconds, or the socket closes. A `protocol` other than the server's is refused; a different app `version` is accepted for phones and browsers because the server serves their code, and the welcome carries the version so a client can say so. The server pings every 20 seconds and closes after two missed pongs; the client pings too, so a NAT keeps the path open. A `call` to a method whose scope the session lacks is answered `refused`; a `window` method is answered `unavailable`. Replies are matched by `id`; a connection that closes rejects every pending call. Turning a listener off sends `bye` reason `off` to its connections.

## 7. The clients

**The window** is unchanged for the user. Under it, `foreman:invoke` goes through the dispatcher.

**The phone** (`resources/mobile/app.js`) opens the socket after it loads and views the chat it shows. It stops polling every 4 seconds: `state`, `approval`, `approval-resolved` and `notify` events refresh the list and the thread at once (debounced to one refresh per 150 ms), `chat-item` and `chat-append` for the viewed chat update the transcript directly so a streaming reply types live, and `archive-progress` shows the step. While the socket is down it shows "Reconnecting" and falls back to a refresh every 30 seconds; on `bye` reason `revoked` it shows the signed-out state. Its actions keep using the HTTP routes, which now dispatch with the session so scopes apply; a phone approved to watch hides what it may not do, and a refusal from the server shows the server's message. The phone stays English-only plain JavaScript, as the design-system document records.

**A browser** loads the real renderer at `/app` on either listener, signed in through the same pairing flow with kind `browser`. `src/renderer/src/bridge.ts` chooses the transport: `window.foreman` when the preload put it there, else a socket bridge (`src/renderer/src/socketBridge.ts`) that implements `Bridge` over `/api/ws`: `invoke` sends `call` frames, `send` sends `signal` frames, `onEvent` delivers `event` frames, `browser.*` and `pathForFile` reject with "not available in a browser". It reconnects with the backoff the paired-computer link uses (2, 5, 10, 20, 40, 60 s), and on each reconnect it re-sends its `view` and fetches a fresh snapshot, which the store applies as a `state` event. The renderer shows a thin banner while reconnecting, like the one it shows for a paired computer whose link dropped. Window-only features are unavailable, and the controls that need them are hidden the same way they are hidden while controlling another computer. The renderer build (`out/renderer`) is served by the phone HTTP server with the headers and CSP it already sets, plus `connect-src` for the socket on the same origin.

**A paired computer** is as today; its host calls the dispatcher.

## 8. Headless

Foreman runs without a window when started with `--headless`, or when the last window closes and **Keep running without a window** is on (Settings → Data & devices; `devices.keep-running` from the CLI). In both cases the tray shows, every service runs (agents, schedules, flows, the CLI socket, the phone listeners, paired computers), and a phone, a browser or a paired computer can do everything a window could except the `window` scope. On macOS the app already stays alive with no window; on Windows it already stays in the tray while phone access is on; this generalises that rule. Opening the window from the tray, a `foreman://` link or `foreman run --open` creates it, as `sendToWindow` does today.

The rule is pure and tested in `src/main/headless.ts`: `quitsWhenWindowsClose` (never on macOS; otherwise only with no `--headless`, no keep running and, on Windows, no phone access) and `trayWanted` (any of those three, with phone access counting only on Windows as before). While the tray is wanted it shows even with **Tray icon** off, headed "Foreman" when its attention rows are off. Off macOS, a tray icon that could not be made means closing the last window quits after all, so Foreman is never left running with no way back but starting it again. Starting Foreman again with `--headless` while it runs leaves it as it is (the flag travels as the single-instance request's data); starting it any other way brings the window. `--headless` is taken off Chromium's command line at startup: Chromium reads it as its own headless mode and passes it to the GPU process, and a window opened later would then never show. Quit from the tray asks first when something is running, as Quit always does, by opening the window for the Quit sheet.

Headless means no window, not no Electron: secrets use Electron's `safeStorage`, background agent turns use the Electron agent host, and the embedded browser panel is a `WebContentsView`. A server with no Electron at all would need those three replaced, and `Host` in `core.ts` is the seam for it; it is recorded in `docs/decisions.md` as not now.

## 9. What is not in this design

- An event log or cursor replay. Snapshot plus live events, with a fresh snapshot on reconnect, is enough at Foreman's state size.
- A native phone app. The live PWA and the browser client are the surfaces.
- Exposing the CLI socket or the CLI's policy over the network.
- Hosted relays, push through anything but the user's own Tailscale HTTPS, or any Foreman account.
- Moving paired computers onto the WebSocket frames. Their channel works and is encrypted end to end; only their authorisation now shares the dispatcher.
- A Rust or other native rewrite of any part of this. The measured costs are in agent processes, git and the wire, none of which this changes.

## 10. Files

| Area | Files |
| --- | --- |
| Contract | `src/shared/api.ts`: `Scope`, `METHOD_SCOPES`, `SIGNAL_SCOPES`, `View`, frames, `API_PROTOCOL`, `sentToView(event, view, scopes)`, `holds(scopes, scope)`. |
| Dispatcher | `src/main/api/dispatch.ts`; wired in `src/main/index.ts`, `src/main/remote/host.ts`, `src/main/mobile.ts`. |
| Socket server | `src/main/api/socket.ts` (connections, hello, view filter, backpressure, pings, revoke); upgrade handling in `src/main/mobile.ts`. |
| Sessions | `src/shared/mobile.ts` (`MobileDevice` gains `kind`, `scopes`), `src/main/mobile.ts` (approval with scopes, revoke closes sockets), `src/renderer/src/components/phone/PairPanel.tsx` (scope choice, list with kind and scopes). |
| Phone | `resources/mobile/app.js` (socket, live updates, scope-aware actions). |
| Signing in from a terminal | `src/main/cli/phone.ts` (handlers, approve by code), `src/cli/commands/phone.ts`, `PHONE_COMMANDS` in `src/shared/cliCommandsSettings.ts`, `tests/cliPhone.test.ts`. |
| Browser client | `src/renderer/src/bridge.ts`, `src/renderer/src/socketBridge.ts`, `src/renderer/src/store.ts` (bridge import, resync), serving `/app` in `src/main/mobile.ts`. |
| Headless | `src/main/index.ts` (`--headless`, `closingQuits`, `drawTray`), `src/main/headless.ts` (the pure rule, tested), `src/main/tray.ts` (stays up while wanted), the `keepRunning` setting end to end (`types.ts`, `store.ts`, `settingsSchema.ts`, `settingsRegistry.ts`, i18n, `DataPage.tsx`). |
| Tests | `tests/apiScopes.test.ts` (every method placed; window set equals the remote sets it replaces; dispatcher refusals), `tests/apiSocket.test.ts` (real `ws` on loopback: hello and refusals, scope and unavailable replies, view filter, backpressure close, revoke, pings), `tests/mobile.test.ts` (routes through the dispatcher, scopes on routes, upgrade guards), `tests/socketBridge.test.ts` (jsdom: reconnect, resync, pending calls rejected), `tests/headless.test.ts`, `tests/trayRedraw.test.ts`. |
| Docs | This file; `docs/guide.md` ("Phones and browsers", headless); `docs/telemetry.md` (`ws.<method>`, `remote.<method>`, `event.sent.<kind>`); `docs/decisions.md`; `docs/cli.md` regenerated. |

## 11. Build order

Each slice is one pull-request-sized change that leaves `npm run typecheck`, `npm test` and `npm run check:ui` green.

1. **Contract and dispatcher.** `src/shared/api.ts` with every method placed; `ApiDispatcher`; the window and the paired-computer host call through it; `hostAccepts` derived from the scopes. No behaviour changes; tests for the placement and the refusals.
2. **Sessions and the socket.** `ws` as a dependency; `kind` and `scopes` on the records, chosen at approval; the HTTP routes through the dispatcher; `/api/ws` with hello, calls, the view filter, backpressure, pings and revoke; tests on loopback.
3. **The phone goes live.** The socket in `app.js`, event-driven refresh and live transcript, reconnect and signed-out states, scope-aware actions; the pairing dialog lists kind and scopes.
4. **Headless.** `--headless`, the setting, the tray rule as a pure function with tests, docs.
5. **The browser client.** The bridge choice, the socket bridge with reconnect and resync, `/app` served with sign-in, window-only features hidden, tests.
6. **Docs and review.** Guide, decisions, telemetry, a fresh-eyes review of the whole change and its fixes.
