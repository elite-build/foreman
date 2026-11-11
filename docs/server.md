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
interface MobileDevice {     // src/shared/mobile.ts
  id: string                 // random UUID
  name: string               // "iPhone", "Chrome on Windows"
  pairedAt: string
  kind?: 'phone' | 'browser' // absent: a phone; 'computer' sessions come from pairing in src/main/remote/
  scopes?: Scope[]           // ['read'], ['read','operate'] or ['read','operate','admin']; absent: ['read','operate']
  transport?: 'private' | 'lan'
  lastSeen?: string
  push?: …                   // the phone's web push subscription, as before
}
```

These are the `MobileDevice` records in `state.json` (`mobileDevices`), extended with optional `kind` and `scopes`, so no migration is needed: a record without `scopes` is read as `['read', 'operate']`, which is what a phone could do before, and `window` is dropped even from a hand-edited record (`deviceScopes`). The credential stays what it was: a random secret in the vault under `mobile:<id>`, handed to the client once as the `foreman_mobile=<id>.<secret>` HttpOnly, `SameSite=Strict` cookie (`Secure` on the private connection). It is accepted only on the listener of the device's own transport. A cookie goes with the WebSocket upgrade from the same origin, so a browser client never handles a token. A client that is not a browser may instead send `Authorization: Bearer <id>.<secret>` on the upgrade (only there; the HTTP routes take the cookie), with an `Origin` that matches the listener.

**Signing in** is the pairing flow that exists: the desktop shows a QR code or link with a one-time secret, good for two minutes, the client opens it, both show a six-digit code, and the person at the desktop approves. The approval now also chooses the scopes, with **Operate** selected: Watch (`read`), Operate (`read`, `operate`), Full control (`read`, `operate`, `admin`). The name and kind come from the client's `POST /api/pair/start`; the dialog's button says **Sign in browser** for a browser.

**Signing in from a terminal.** A Foreman with no window is signed into with `foreman phone` (`src/main/cli/phone.ts`): `link [--lan | --private] [--browser] [--qr]` turns the connection on if it is off and prints the one-time link (`/app?pair=…` for a browser), `pending` shows who is asking, and `approve <code> [--access read|operate|admin]` approves only when the code typed is the one the device shows, so the person approving has seen it; `status`, `deny` and `revoke <id-or-name>` complete the dialog's set. Each one that changes who may sign in is the CLI's `admin` tier, so an agent turn can't call it.

**Revoking** deletes the record and the vault secret, as before, and now also closes that session's live connections with a `bye` whose reason is `revoked`. A revoked client shows that it is signed out and offers nothing else; one that was offline learns it from the 401 its next request gets.

**Expiry.** The private cookie lasts a year and the same-Wi-Fi cookie a day, as before. `lastSeen` is updated at most once a minute and shown in the pairing dialog and by `foreman phone`; a session is never marked stale or removed on its own.

## 4. The dispatcher

`ApiDispatcher` in `src/main/api/dispatch.ts` is the one place a call enters the core from any client:

```ts
invoke(session: ApiSession, method: string, args: unknown[]): Promise<unknown>
signal(session: ApiSession, method: string, args: unknown[]): void
```

It checks, in order: the method is in `API_METHODS`; the session holds `METHOD_SCOPES[method]`; then it calls `core.api[method](...args)` under `perf.timed('<kind>.<method>')`, where kind is `ipc` for the window (the name telemetry already uses), `ws` for phones and browsers, and `remote` for a paired computer. The window's IPC handler does the timing itself, as it always has, so the calls it routes to another computer are timed too; its dispatcher is made with `perfPrefix: () => null`. Arguments are passed through as they are: validation of argument shapes stays in the core's methods, which already treat every caller as untrusted.

`mobileInfo` and `devicesInfo` are `read`, so any session can see who is paired, but a session without `admin` gets them without a pairing in progress: no sign-in link (it carries the one-time secret), no six-digit code a device signing in shows, and no code a computer would type to pair. Each would let a session that may only watch or operate sign in another device, or pair a computer, which holds `admin`, while the person here is pairing.

Callers:

- `ipcMain.handle('foreman:invoke')` in `src/main/index.ts` dispatches with the window session, after the sender check it already does and through the remote router when the window shows another computer.
- `RemoteHost` in `src/main/remote/host.ts` dispatches with a `computer` session.
- The WebSocket server and the phone's HTTP routes dispatch with the record's session.

## 5. The stream

Clients get a snapshot and then changes. The server numbers every broadcast (`seq`, increasing for the life of the process), the welcome says the current `seq`, and the client then reads the state (`getSnapshot` in a browser, `GET /api/state` on the phone). A `state` event carries a whole `AppSnapshot`, and main already coalesces them to one per microtask and sends none when nothing changed, so a client that misses events heals on the next `state` event, and a client that reconnects simply fetches a fresh snapshot. There is no event log to replay. That is a deliberate choice: Foreman's state fits in one snapshot (about 32 KB for 12 workspaces), the renderer already reconciles unchanged objects, and an event store would be a second source of truth.

**What a session is sent** is bounded by its *view*, which the client sets with a `view` frame:

| Event | Sent when |
| --- | --- |
| `state`, `approval`, `approval-resolved`, `notify`, `attention-history`, `archive-progress`, `assistant-threads`, `assistant-item` | Always (an assistant item belongs to a thread, not a chat, so a view can't name it). |
| `chat-item`, `chat-append`, `chat-reset` | The event's session is in the view (`sessionId`), or the view is `all`. |
| `pty-data`, `pty-exit`, `pty-state` | The session has `operate`, and the view is `all` or names the terminal's workspace (`workspaceId`, which main sets on these events). |
| `setup-log`, `cloud-build-log`, `clone-progress`, `auto-run` | The view is `all` and the session has `operate`. |
| Window events (`WINDOW_EVENTS` in `src/shared/remote.ts`: browser panel, navigation, dictation, tour, quit, computer chip) | Never. |

A phone views one chat at a time, or on its Terminal tab one workspace's terminals; the browser client views `all`, like the window.

**Backpressure.** Each connection has an outbound budget. Above 4 MB buffered (`COALESCE_BYTES`), the server holds only the newest `state` event, sent once the buffer drains below it (checked every 100 ms), drops `pty-data` and `chat-append` for that connection, and still sends everything else; above 16 MB (`DROP_BYTES`) it closes the connection with `bye` reason `slow` (close code 1013), and the client reconnects and fetches a snapshot. A reply larger than 16 MB is replaced by a `failed` reply. Each event is serialised once however many connections it goes to. The budgets are constants in `src/main/api/socket.ts`, and `tests/apiSocket.test.ts` pins them.

## 6. The wire

The WebSocket is served on the phone listeners that exist in `src/main/mobile.ts`: `127.0.0.1:47632` for the private HTTPS connection through Tailscale, and the opt-in same-Wi-Fi address on `47633`. The upgrade is `GET /api/ws`. It passes the same guards as a `POST`: the same-Wi-Fi host and subnet check, an `Origin` header that is present and matches the listener, and a valid cookie or bearer credential for that listener's transport. A refused upgrade gets a plain HTTP answer (`401` not paired, `403` wrong network or origin, `404` any other path) and the socket is closed. There is no WebSocket in the Electron window and no new port.

The library is `ws` (MIT, now a direct dependency; it was already in the tree through the Daytona SDK, and Node and Electron ship a WebSocket client but no server). Frames are JSON text, one message each, at most `MAX_CLIENT_FRAME_BYTES` (1 MB) inbound, past which `ws` closes the socket with 1009; `API_PROTOCOL = 1` in `src/shared/api.ts`:

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
{ t: 'reply', id, ok: false, error: string, code?: 'refused' | 'unavailable' | 'failed' }  // the core's message, never a stack
{ t: 'event', seq: number, event: MainEvent }
{ t: 'bye', reason: 'revoked' | 'slow' | 'shutdown' | 'off' }
{ t: 'pong' }
```

Rules: the first frame must be `hello`, within 5 seconds (`HELLO_MS`), or the socket closes with 1002. A `protocol` other than the server's is refused with `welcome ok: false, refused: 'protocol'`, the only refusal the server sends today: a bad credential is refused at the upgrade, and `version` and `scope` are reserved (the clients read `credential` and `scope` as signed out, the others as outdated). A different app `version` is accepted for phones and browsers because the server serves their code, and the welcome carries the version so a client can say so. After the hello, a frame the server can't read is ignored. The server pings every 20 seconds (`PING_MS`) and cuts the socket when two pings in a row go unanswered; the clients send a `ping` frame every 25 seconds too, so a NAT keeps the path open. A `call` to a method whose scope the session lacks is answered `refused`; a `window` method is answered `unavailable`. Replies are matched by `id`; a connection that closes rejects every pending call. Turning a listener off, or changing the same-Wi-Fi address, sends `bye` reason `off` to that transport's connections, and quitting sends `shutdown`. A closing handshake that takes longer than 2 seconds (`CLOSE_GRACE_MS`) is cut, so a stalled client can't hold a listener open.

## 7. The clients

**The window** is unchanged for the user. Under it, `foreman:invoke` goes through the dispatcher.

**The phone** (`resources/mobile/app.js`) opens the socket after it loads and views the chat it shows. It stops polling every 4 seconds: `state`, `approval`, `approval-resolved` and `notify` events refresh the list and the thread at once (debounced to one refresh per 150 ms), `chat-item` and `chat-append` for the viewed chat update the transcript directly so a streaming reply types live, and `archive-progress` shows the step. While the socket is down it shows "Reconnecting…" and falls back to a refresh every 30 seconds, retrying on the backoff below and at once when the page is shown again; after `bye off` it shows "Phone access is off" and tries every 60 seconds. On `bye` reason `revoked`, or a 401 from `GET /api/state` (revoked while it was offline, or an expired cookie), it shows the signed-out state. It opens a chat with `GET /api/chat/<id>?live=1`, which includes the reply still being written, so the `chat-append` events that follow continue it; `GET /api/session` gives its id, name, kind and scopes before the first welcome. Its actions keep using the HTTP routes, which now dispatch with the session so scopes apply; a phone approved to watch hides what it may not do, and a refusal from the server shows the server's message. The phone stays English-only plain JavaScript, as the design-system document records.

**The phone's actions** (elite-build/foreman#127) are the window's, through routes that call the same methods:

- **Queue or steer.** `GET /api/state` gives each chat `canSteer` (the agent's `supportsSteering`), its `queue` (id and text) and `followUpMode` (the window's setting). While a turn runs, a Queue/Steer button beside the box starts at that setting and is the phone's choice per chat after a tap; `POST /api/chat/<id>/send` takes `mode: 'steer'` (anything else queues) and answers with the disposition. `POST /api/chat/<id>/queued/<messageId>` with `action: 'steer'` or `'remove'` is the queue row's Send now (`steerQueued`) and Delete (`removeQueued`).
- **Diff comments.** The state carries the comments that still do something: the user's `pending` ones and the agent's `open` ones, of workspaces it lists. On **Changes** every line is a button: a line of the new side comments on its new number, and a removed line (#164) on its old one. `POST /api/workspace/<id>/comment` (`file`, a positive integer `line`, a body under 10,000 characters, and `side: 'old'` with `quote`, the removed line's text, for a removed line) is `addComment`, so the comment goes with the next message like one written in the window; a removed line's goes as a one-line selection on the old side quoting it, as the window comments on removed lines. A steered message doesn't take pending comments (they are added when a turn starts), so while the phone is set to steer a running turn its composer says they wait for the next turn. `POST /api/comment/<id>` with `action: 'delete'` deletes the user's pending comment and `'resolve'` resolves the agent's open one; anything else that comment no longer is gets `409`.
- **Terminals.** `terminalOutput(workspaceId)` (`operate`, as terminal events are) lists the workspace's terminals with the end of each one's output: main keeps what each terminal shows from its start until its tab closes (`PtyTails` in `src/main/pty.ts`; an ended terminal stays, only the newest four ended per workspace), and sends its last 500 lines as plain text. #164: each is kept as a screen (`TerminalScreen` in `src/main/terminalScreen.ts`) at the tab's size, not as raw output, so carriage returns, wrapping, cursor moves (which ConPTY repaints with), erases and the alternate screen apply and colours and other codes are dropped: a progress line, a repaint or a full-screen program reads as the window's tab shows it. It is a reader, not an emulator; a sequence it doesn't follow is skipped, never shown. `GET /api/workspace/<id>/terminals` serves it. On its Terminal tab the phone views `{ workspaceId }`, so it is sent that workspace's `pty-*` events and no others, and reads the list again at most once a second while they come. It types nothing: `ptyWrite` stays the window's and the browser's.
- **Usage.** `GET /api/workspace/<id>/usage` is `workspaceUsage`; the workspace menu shows the open chat's context (`context` in the state, from `contextUsage`), and the turns, agent time and cost of the chat and the workspace. A missed resume after a usage limit offers **Resume now** (`resume-at` with `now: true`, `resumeLimitNow`) and **Dismiss**.

**A browser** loads the real renderer at `/app` on either listener, signed in through the same pairing flow with kind `browser`:

- **Serving.** With a valid cookie, `GET /app` serves `out/renderer/index.html` (under the app path, packaged or not) and `GET /assets/<name>` its hashed scripts, styles and fonts (cookie required, one file name with no folders, cached as immutable). The built page carries a CSP meta tag for Electron (`ws://localhost:*`, `foreman-preview:`); a browser applies a meta tag and a header both, so the tag is stripped and one header says what the page may do here: `default-src 'self'`, its own scripts, inline styles, `img-src 'self' data: https:`, and `connect-src 'self'` plus the listener's own `ws:`/`wss:` origin, with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `no-store` for the HTML. `/app/` redirects to `/app`; any other `/app/...` is 404.
- **Signing in.** Without a cookie, `/app?pair=<secret>` redirects to `/?pair=<secret>&then=/app`: the phone page runs the pairing, sends `kind: 'browser'` (named from the user agent, "Chrome on Windows"), keeps `then` through its own reload in `sessionStorage`, and once approved goes to `/app` with `location.replace`. The server redirects a `then` that isn't exactly `/app` to the same page without it, and the page checks it again. `/app` with neither cookie nor link is a small English page saying to run `foreman phone link --browser` on the computer and approve the code; it shows nothing else. The pairing dialog in the window offers the same: choosing **Browser** instead of **Phone** shows the link at `/app?pair=…` beside the QR code, read-only with a copy button, and says the browser must reach this computer at that address.
- **The transport.** `src/renderer/src/bridge.ts` chooses it: `window.foreman` when the preload put it there, else a socket bridge (`src/renderer/src/socketBridge.ts`) that implements `Bridge` over `/api/ws`, opened the first time it is used. `invoke` sends `call` frames (a `window`-scope method is refused before sending, with the translated `browser.unavailable` and code `unavailable`; a frame over the server's 1 MB inbound limit is refused before sending too, as it would otherwise close the socket), `send` sends `signal` frames (the `window` ones, the unread badge and the battery, are dropped), `onEvent` delivers `event` frames, and `browser.*` reject as unavailable. `openExternal` opens the link in a new tab of the browser instead of asking the computer. `pathForFile` returns `''`, what Electron says of a file that isn't on disk, so pasting and the composer's drop send the file's contents with `attachData` and a new workspace's attachments are staged the same way. The calls made before the first welcome (the store's first snapshot) wait for it; after that, a call while the socket is down fails at once with `browser.offline`.
- **Reconnecting.** Statuses are `connecting`, `live`, `reconnecting`, `signedOut`, `off` and `outdated`. A drop retries on the backoff the paired-computer link uses (2, 5, 10, 20, 40, 60 s, reset by a welcome), pauses while the tab is hidden and retries at once when it is shown, and pings every 25 s. After every welcome that follows a drop the bridge sends its `view` again and fetches `getSnapshot` and `pendingApprovals`; `resyncStore` applies the snapshot exactly as a `state` event (through `shareUnchanged`), replaces the approvals and reads the chats it had loaded again. Events keep arriving during that fetch, and the server may have computed an answer before an event that reaches the page ahead of it: when a `state` event came meanwhile, it is kept and the fetched snapshot is not applied (main sends another `state` on any later change, so the newest one received is never left behind), and approval events that came meanwhile are applied again over the fetched list, in order. `bye revoked`, or a 401 from `GET /api/session` when a reconnect is turned away before its welcome (an expired cookie), is `signedOut` and stops; `bye off` is `off`, retried every 60 s; a refused `protocol` or a welcome whose `version` differs from the first one is `outdated` and stops, since the page's code is older than the server's.
- **What shows.** `state.client` in the store is the browser's status (null in the window). `BrowserBanner` (the `Callout` banner `RemoteBanner` uses) says "Reconnecting to <computer>…", "This browser was signed out", "Browser access is off on the computer" or "Foreman was updated. Reload this page." with a Reload button. A refusal for want of the window shows as an information toast without the Report link. The computer chip lists no computers (`computers` isn't asked), the folder drop overlay and launch folders are off, Import, Export (button, sidebar menu and palette) and Open in are hidden, and any other control that needs the window (Attach's file picker, previews, dictation, updates) answers with that toast rather than being hidden one by one. A refusal for want of scope (an Operate browser changing a setting) is the server's `refused` message as an error toast, as on the phone. The welcome tour doesn't open by itself in a browser (`tourStartsOnLaunch`): marking it seen is a settings change, which an Operate browser may not make, so it would come back on every load. Opened from Help there, finishing or skipping it closes quietly when that write is refused.

**A paired computer** is as today; its host calls the dispatcher.

## 8. Headless

Foreman runs without a window when started with `--headless`, or when the last window closes and **Keep running without a window** is on (Settings → Data & devices; `devices.keep-running` from the CLI). In both cases the tray shows, every service runs (agents, schedules, flows, the CLI socket, the phone listeners, paired computers), and a phone, a browser or a paired computer can do everything a window could except the `window` scope. On macOS the app already stays alive with no window; on Windows it already stays in the tray while phone access is on; this generalises that rule. Opening the window from the tray, a `foreman://` link or `foreman run --open` creates it, as `sendToWindow` does today.

The rule is pure and tested in `src/main/headless.ts`: `quitsWhenWindowsClose` (never on macOS; otherwise only with no `--headless`, no keep running and, on Windows, no phone access) and `trayWanted` (any of those three, with phone access counting only on Windows as before). While the tray is wanted it shows even with **Tray icon** off, headed "Foreman" when its attention rows are off. Off macOS, a tray icon that could not be made means closing the last window quits after all, so Foreman is never left running with no way back but starting it again. Starting Foreman again with `--headless` while it runs leaves it as it is (the flag travels as the single-instance request's data); starting it any other way brings the window. `--headless` is taken off Chromium's command line at startup: Chromium reads it as its own headless mode and passes it to the GPU process, and a window opened later would then never show. Quit from the tray asks first when something is running, as Quit always does, by opening the window for the Quit sheet.

Headless means no window, not no Electron: secrets use Electron's `safeStorage`, background agent turns use the Electron agent host, and the embedded browser panel is a `WebContentsView`. A server with no Electron at all would need those three replaced, and `Host` in `core.ts` is the seam for it; it is recorded in `docs/decisions.md` as not now. It follows that `--headless` still needs a display server where Electron does: on Linux, which Foreman does not support officially, a machine with no screen needs a virtual one.

### As a service

`foreman service install` registers the Foreman that runs it to start headless at the user's login, so schedules, flows, phones and paired computers work without anyone opening the app (elite-build/foreman#128). It is per user and at login, never system-wide or at boot: Foreman's secrets are in the user's keychain or DPAPI, its tray and agent host belong to the user's session, and it needs a display, so a system service could neither read the vault nor show the window when asked. On each platform the service manager starts `<Foreman> --headless --service`, with `--data-dir=<folder>` when the installing Foreman uses a data folder other than the default (from `--data-dir=` or `FOREMAN_DATA_DIR`; Task Scheduler can't set environment variables, so the folder travels as an argument), and with the app path first in a development build:

| Platform | Registered as | Restarted | Notes |
| --- | --- | --- | --- |
| macOS | launchd agent `~/Library/LaunchAgents/dev.foreman.app.service.plist`, `RunAtLoad`, `LimitLoadToSessionType Aqua` | after a crash (`KeepAlive` with `SuccessfulExit` false, `ThrottleInterval` 30 s), not after Quit | Refused from a disk image or an App Translocation copy, which won't exist at the next login. |
| Windows | Task Scheduler task `Foreman`: a logon trigger for this user, `InteractiveToken`, `LeastPrivilege`, no time limit, not stopped on battery, priority 5 | when it fails to start (`RestartOnFailure`, three times a minute apart); Task Scheduler does not watch the process after that | `schtasks /Create /XML` from a UTF-16 file in the temp folder; needs no administrator (checked on Windows 11 from a non-elevated shell). |
| Linux | systemd user unit `$XDG_CONFIG_HOME/systemd/user/foreman.service`, `WantedBy=default.target`, enabled | after a failure (`Restart=on-failure`, 10 s) | The AppImage's path rather than its mount; the running Foreman's `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY`, or `xvfb-run -a` when it has none and xvfb-run is installed. `loginctl enable-linger` starts it at boot. |

Installing and removing never start or stop a process. Installing writes the registration for the next login, as the Foreman that answers the command is already running. Removing deletes it and leaves the running Foreman alone, since stopping the service would stop that process: launchd is not asked to unload anything (`bootout` would stop whatever the agent started, which may be the Foreman asking), systemd's unit is disabled, not stopped, and deleting a task leaves the process it started running (checked on Windows 11). `foreman service` reads the registration back and says whether it starts this Foreman as installing now would (another copy, an older install or a hand edit isn't current), and whether this Foreman is the service's. Install and uninstall are the CLI's `admin` tier, so an agent turn can't make Foreman start at login or stop it; status is `read`. The demo offers none of it.

**The service's Foreman.** `--service` makes a Foreman headless (`--headless` is there too) and adds the fact `service` to the headless rule: it never quits when its last window closes, and its tray is always up. Starting the service while Foreman is already open (the user opened it before the login task ran) hands `service` over with the single-instance request, and the open Foreman becomes the service's.

**Updating itself.** Updates download as Settings → General → Updates says (download is the default). Once a minute, an installed build started by the service checks `serviceUpdateDue`: a downloaded update that wasn't skipped, no visible window, and nothing Quit would ask about (turns, check runs, run scripts). Then it restarts to install, as the update card's Restart does. With a window open, the card decides as usual. The installers start Foreman again with no arguments (NSIS's `--force-run`, Squirrel.Mac's relaunch), so just before running the installer the service's Foreman writes `service-relaunch.json` in its data folder: `{ version, window, at }`. The next start reads it once, after the single-instance lock, and removes it; if it names this version and is under 30 minutes old, that Foreman is the service's again, headless unless a window was open. An install that failed starts the old version, which ignores the note, so a Foreman opened by hand never starts hidden by mistake. A Foreman brought back this way was started by the installer, not by the service manager, so until the next login launchd won't restart it after a crash. Linux builds don't install updates themselves (`installUnavailable: 'unsupported'`), so there the service only starts Foreman.

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
| Phone | `resources/mobile/app.js` (socket, live updates, scope-aware actions; #127: queue and steer, diff comments, the Terminal tab, usage), `resources/mobile/style.css`; its routes in `src/main/mobile.ts`; terminal output kept in `src/main/pty.ts` (`PtyTails`) as screens (`src/main/terminalScreen.ts`, #164) and read by `terminalOutput` in `src/main/core.ts`. |
| Signing in from a terminal | `src/main/cli/phone.ts` (handlers, approve by code), `src/cli/commands/phone.ts`, `PHONE_COMMANDS` in `src/shared/cliCommandsSettings.ts`, `tests/cliPhone.test.ts`. |
| Browser client | `src/renderer/src/bridge.ts`, `src/renderer/src/socketBridge.ts`, `src/renderer/src/store.ts` (bridge import, `client` state, `resyncStore`, the unavailable toast), `src/renderer/src/components/computers/BrowserBanner.tsx`, the browser cases in `DropFolder.tsx` and `composer/Composer.tsx`; serving `/app` and `/assets/*` in `src/main/mobile.ts`; `then` in `resources/mobile/app.js`; `MAX_CLIENT_FRAME_BYTES` in `src/shared/api.ts`; `browser.*` i18n keys. |
| Headless | `src/main/index.ts` (`--headless`, `closingQuits`, `drawTray`), `src/main/headless.ts` (the pure rule, tested), `src/main/tray.ts` (stays up while wanted), the `keepRunning` setting end to end (`types.ts`, `store.ts`, `settingsSchema.ts`, `settingsRegistry.ts`, i18n, `DataPage.tsx`). |
| As a service | `src/main/service.ts` (`--service`, `--data-dir=`, the launchd, systemd and Task Scheduler files, `ServiceManager`, `serviceUpdateDue`, the relaunch note), `src/main/cli/service.ts` and `SERVICE_COMMANDS` in `src/shared/cliCommands.ts` (`foreman service status\|install\|uninstall`), `src/shared/cli/service.ts`, `UpdateCheck.readyVersion` in `src/main/updates.ts`, and in `src/main/index.ts` the flags, the update tick, the note and `serviceHost`; `tests/service.test.ts`. |
| Tests | `tests/apiScopes.test.ts` (every method placed; window set equals the remote sets it replaces; dispatcher refusals), `tests/apiSocket.test.ts` (real `ws` on loopback: hello and refusals, scope and unavailable replies, view filter, backpressure close, revoke, pings), `tests/mobile.test.ts` (routes through the dispatcher, scopes on routes, upgrade guards), `tests/mobile.test.ts` also `/app` (sign-in page, pairing redirect, `then`, CSP, assets and traversal), `tests/socketBridge.test.ts` (jsdom with a fake socket: hello, calls, local refusals, events, reconnect and backoff, resync, revoked, off, outdated, the session check), the bridge end to end against the real server in `tests/apiSocket.test.ts`, `tests/browserResync.test.tsx` (the store's resync and the unavailable toast), the banner in `tests/computers.test.tsx`, `tests/headless.test.ts`, `tests/trayRedraw.test.ts`; for #127, the phone's routes and its workspace view in `tests/mobile.test.ts`, the page itself in jsdom against a fake server in `tests/mobilePage.test.ts`, the terminal tails in `tests/ptyTails.test.ts`, the workspace reach in `tests/apiScopes.test.ts`; for #164, the screen model in `tests/terminalScreen.test.ts` and removed-line comments in `tests/mobile.test.ts` and `tests/mobilePage.test.ts`. |
| Docs | This file; `docs/guide.md` ("Mobile access", "In a browser", "Running without a window"); `docs/telemetry.md` (`ipc.<method>`, `remote.<method>`, `ws.<method>`, `ws.connect`, `ws.event`, `ws.dropped`, `ws.slow`); `docs/performance.md` (design rule 8); `docs/decisions.md`; `docs/windows.md` (item 9); `README.md`; `docs/cli.md` regenerated. |

## 11. Build order

Each slice is one pull-request-sized change that leaves `npm run typecheck`, `npm test` and `npm run check:ui` green.

1. **Contract and dispatcher.** `src/shared/api.ts` with every method placed; `ApiDispatcher`; the window and the paired-computer host call through it; `hostAccepts` derived from the scopes. No behaviour changes; tests for the placement and the refusals.
2. **Sessions and the socket.** `ws` as a dependency; `kind` and `scopes` on the records, chosen at approval; the HTTP routes through the dispatcher; `/api/ws` with hello, calls, the view filter, backpressure, pings and revoke; tests on loopback.
3. **The phone goes live.** The socket in `app.js`, event-driven refresh and live transcript, reconnect and signed-out states, scope-aware actions; the pairing dialog lists kind and scopes.
4. **Headless.** `--headless`, the setting, the tray rule as a pure function with tests, docs.
5. **The browser client.** The bridge choice, the socket bridge with reconnect and resync, `/app` served with sign-in, window-only features hidden, tests.
6. **Docs and review.** Guide, decisions, telemetry, a fresh-eyes review of the whole change and its fixes.

## 12. Checked by hand

The tests above run the server on loopback and the clients against fakes. These are the checks that need real devices and networks. Record a run by replacing its status with the date and platform.

| Check | Status |
| --- | --- |
| Pair a phone with each access level, Watch, Operate and Full control, over each connection: Watch offers no actions, and the dialog and `foreman phone` list each with its access. | not yet run |
| Live updates: with a chat open on the phone, a reply types as the agent writes it and a new approval shows within a second, with no request every 4 seconds in the network log. | not yet run |
| Revoke while connected, from the dialog and with `foreman phone revoke`: an open phone and an open browser show that they were signed out at once. | not yet run |
| Start with `--headless`: no window opens, the tray shows, **Show Foreman** opens the window, and starting again with `--headless` leaves it as it is. | run on Windows, 2026-11-10 |
| Sign a client in from a terminal: `foreman phone link`, `foreman phone pending` and `foreman phone approve <code>`, with the device's side driven by curl. | run on Windows, 2026-11-10 |
| A browser at `/app` over same Wi-Fi: `foreman phone link --browser --lan`, approve, and the app loads and works within its access. | run on Windows, 2026-11-10 |
| The browser's reconnect: drop the network, see the **Reconnecting** banner, restore it, and the page catches up without a reload. | run 2026-11-10 on Windows: the app was killed and restarted under the page; the banner showed, and the page reconnected and resynced about 11 s later with no toasts |
| Phone and browser over private HTTPS (`tailscale serve --bg 47632`). | not yet run |
| The phone's actions (#127) on a real phone: steer a running Claude turn and see it land in the window's chat; Send now and Delete a queued message; comment on a diff line and see it go with the next message; read a dev server's output on the Terminal tab while it prints; open the workspace menu for context and usage. | not yet run |
| All of the above on macOS. | not yet run |
| `foreman service install` from an installed Foreman, log out and in: Foreman starts with no window, `foreman service` says the running one is the service's, and `foreman service uninstall` leaves it running. On each of macOS, Windows and Linux. | run 2026-11-10 on Windows 11 with a development build and its own data folder, the task started with `schtasks /Run` rather than a logon: install from a non-elevated shell, the task read back as current, `/Run` while Foreman ran made that one the service's, `/Run` with none running started it headless (no window) as the service's, uninstall removed the task and left it running. A relaunch note for this version brought a plain start back headless and the service's, and a plain start with none opened the window. Not yet: a real logon, macOS, Linux. |
| The service's Foreman updates itself: an older installed build, started by the service, with a newer release out, installs it with no window open and comes back headless and the service's. | not yet run |
