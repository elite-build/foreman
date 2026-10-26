# Accessibility: screen readers and low vision

This is a guide to using Foreman with a screen reader, with a keyboard only, or at large text sizes. It says what works now and what is coming. The manual checks are in [MANUAL-CHECKS.md](MANUAL-CHECKS.md).

How to read it:

- Plain statements describe what is in the code today.
- "From the next release" marks things that are being built alongside this guide and have not been checked in the code or in a running app yet.
- Nothing here has been tried yet with NVDA, JAWS or VoiceOver. The manual checks are written but every row is "not yet run". Expect rough edges, and see "Reporting a problem" below.

## Settings > Accessibility

Open Settings (Ctrl+, on Windows, Cmd+, on macOS) and choose **Accessibility**. The page has two sections.

**Low vision**

- **Content text size.** A slider from 12 to 24 px (13 is the default). It sets the size of chat messages, diff code and files. The rest of the interface keeps its own size. The slider saves a moment after you stop moving it, and has a reset button once it differs from the default. **App zoom** in Appearance changes everything, not only content; the two combine.
- **Terminal text follows content size.** A switch. When on, terminals use the content text size instead of the size set in Appearance.
- **Reduce motion.** Automatic, On or Off. It stops spinning, pulsing, sliding and smooth scrolling. Automatic follows the system setting.

**Screen readers**

- **Screen reader support.** Automatic, On or Off. It lets a screen reader read terminal output (xterm.js's screen reader mode). Automatic turns it on while the system reports a screen reader. It is the same setting that used to be under Advanced.

The three settings with their own key can also be set from a terminal, for example `foreman settings set accessibility.content-font-size 20`. The keys are `accessibility.content-font-size`, `accessibility.reduce-motion` and `accessibility.terminal-screen-reader`. The terminal switch is the terminal font size setting with the value `content`.

From the next release, a third section, **Announcements**, adds a choice of what a screen reader is told about agents (only what needs you, your open chat, or all chats), whether a finished turn says what changed, and four short sound cues. See "What Foreman says" below.

## Keyboard

### The shortcuts sheet

Press **Ctrl+Alt+/** on Windows or **Cmd+Option+/** on macOS to open the shortcuts sheet, or choose **Keyboard shortcuts** in the command palette (Ctrl+K or Cmd+K). The sheet is generated from the same list the app uses to handle keys, so it cannot drift from what actually works. Every shortcut is also reachable from a named button or the command palette; the chords are shortcuts, not the only way.

### Workspace keys

- **Ctrl+1 to Ctrl+9** (Cmd+1 to Cmd+9) switch to the workspace in that position.
- **Ctrl+Alt+Page Up / Page Down** (Cmd+Option+Page Up / Page Down) move to the previous or next workspace.
- **Ctrl+Alt+L** (Cmd+Option+L) goes to the next chat that needs you: an unread chat or one with an approval waiting.

Previous and next workspace used to be Ctrl+Alt+Up and Ctrl+Alt+Down. NVDA and JAWS use Ctrl+Alt+arrows to move around table cells, so Foreman never saw those keys on Windows. They moved to Page Up and Page Down. The shortcuts sheet carries a note about the move.

### The reserved-chord rule

On Windows, Foreman does not bind chords that screen readers use. The reserved list is Ctrl+Alt+Up, Ctrl+Alt+Down, Ctrl+Alt+Left, Ctrl+Alt+Right and Ctrl+Alt+N (which starts NVDA). A test fails if any shortcut uses one of them. New shortcuts are added to one list (`src/renderer/src/shortcuts.ts`), where that check and a collision check run. The reserved list covers the conflicts known so far; it does not claim every other chord is free.

Known gap: some shortcuts are Ctrl+Alt plus a letter (theme, panels, uncommitted changes, next needing you). On keyboards where AltGr types letters, Windows treats AltGr as Ctrl+Alt, so these can collide with typing. US layouts are the target for now; other layouts are a follow-up.

### Approval panels

When an agent asks permission to run a tool, approve a plan or answer a question, focus moves to the approval panel. It is a named group, and the name is the request (the tool's title, or the question text).

- Every button works as a button. Tab to **Yes**, **No**, the "always" or "allow edits" button, a question option, **Skip** or **Submit** and press Enter or Space: it does what its name says, and nothing else. (Enter on No or on an option used to approve the request. That was a bug and is fixed.)
- A few shortcuts work only while the panel itself has focus, not a button inside it. **Enter** says Yes. **Backspace** says No. **Ctrl+Enter** (Cmd+Enter) takes the alternate answer, "always allow" or "allow edits", and works from anywhere in the panel.
- In a question, the panel itself takes **1 to 9** to pick that option, **0** to go to the "other" field, **Left/Right** to move between questions and **Enter** to submit.
- The reason field ("Tell the agent what to do instead") is described as: Pressing Enter here denies the request and sends this reason to the agent.

## What Foreman says

Foreman turns events into one plain sentence each, built in one place (`src/shared/narration.ts`) so the same event reads the same wherever it appears. Today the command line uses it (see below). The sentences look like this:

- A turn ended: "Claude Code finished in api-fix: this turn 3 files, +120 -14. Checks: 12 passed." Checks are marked stale when the files changed after they ran.
- Something needs you: who is asking, in which workspace, and the tool and its target.
- A diff: a lead line ("3 files changed, +120 -14"), a line per file ("src/api.ts, modified, 12 added, 3 removed") and a line per hunk with its line range and the lines added and removed.

From the next release these sentences also drive the screen reader announcements in the app, the toast, and the operating system notification, so a notification and the live region say the same words. How much is announced is set in Settings > Accessibility > Announcements. When your screen reader is on, Foreman does not add its own voice on top; there is one voice.

## Speech input

You can dictate instead of typing. Hold Ctrl+Alt+V (Cmd+Option+V on macOS), speak, and let go. The keys work only while the Foreman window has focus; nothing listens in the background, and there is no global shortcut.

- **Where the words go.** Into the text field you are in, at the caret (a selection is replaced). If no text field has focus, Foreman opens Ask Foreman and puts the words in its field. Nothing is sent for you: the words wait for you to edit them and press Enter. A password field, a read-only field and a terminal are never typed into; the words go to Ask Foreman instead.
- **What you hear.** "Listening" once when it starts, "Heard: <the words>" when it ends, and "Heard nothing" for silence. With the OpenAI engine, which gives no text until the end, it also says "Transcribing". A status line in the sidebar shows the same, with the words so far, and has a Stop button. It is not a live region, so your screen reader does not say everything twice.
- **Stopping.** In hold mode, letting go of V, Ctrl or Alt, or the window losing focus, stops it. In toggle mode a second press stops it. Either way it stops by itself after 60 seconds, and Escape throws the recording away. On macOS, a letter's key-up is not sent while Cmd is down, so if letting go of V does nothing, let go of Cmd, or press the chord again.
- **Settings > Accessibility > Speech input.** Push to talk (hold to talk, or press to start and press to stop), the engine, the dictation language, and the model. The engine is either the model on this computer, which sends no audio anywhere, or OpenAI, which sends each recording to OpenAI with your own API key (saved encrypted, as OPENAI_API_KEY). Privacy mode blocks OpenAI. The local model is downloaded the first time you choose to; Foreman asks first, naming its size and where it comes from, and shows progress. The language is a code such as `en`, `de` or `pt-BR`; the local model is English.
- **Your microphone.** The system asks for permission the first time. If it is refused, Foreman says so and where to allow it. Recordings are never stored.
- **Voice in Ask Foreman.** Dictation into Ask Foreman is how you talk to it: a spoken "approve" only proposes the command, and you still press Enter on its Run button. Foreman does not answer by voice unless you turn on Foreman's voice (Settings > Accessibility > Foreman's voice), and while you dictate it stops speaking so the microphone does not hear it.

## The command line, from a terminal or Emacs

The `foreman` command talks to the running app, so none of this needs the window. Install it from Settings > Advanced > foreman command > Install. The full reference is [cli.md](cli.md). Output is plain text, a sentence or row per line, so it works in a terminal under a screen reader, and in Emacs eshell with Emacspeak, which reads each line as it appears in your own voice and speed. Every command also takes `--json`.

The commands that matter here:

- `foreman status --words`: a line saying how many things need you, then one sentence per workspace.
- `foreman diff <workspace> --words`: the diff as sentences instead of a patch. Pick a source with `--scope` (`uncommitted`, `branch`, `staged`, `last-commit`, `pr`, `turn:<id>` and others). `--stat` and `--files` are the compact forms.
- `foreman wait <turn> --words`: block until a turn ends, then say the outcome in one sentence. `--timeout <s>` stops waiting without stopping the turn. The exit code is 0 for completed, 1 for failed or stopped, 2 for timed out and 5 for a lost connection. It reads the saved record, so it also works after the turn has finished. The turn id is the one `foreman run` and `foreman send` print.
- `foreman attention --words`: what happened lately, newest first, one sentence each. `foreman attention seen` marks it seen; listing changes nothing.
- `foreman approvals`: what agents are waiting on, one row each: id, workspace, tab, kind (tool, plan or question) and the ask.
- `foreman approve <id>` and `foreman deny <id>`: answer one. The id can be its first four characters or more. `--always` or `--edits` give the "allow from now on" answers where the tool offers them. For a plan, `--feedback "…"` adds a note. For a question, give `--answer "question=choice"` once per question.

Approving lets an agent act, so `approve` and `deny` are refused from inside an agent turn. You run them yourself, after hearing what you are approving.

To ask in your own words, use `foreman ask "what needs me?"`. It runs one turn of the Ask Foreman assistant with its read-only tools and prints the answer as plain sentences. `--workspace <name>` (or `.` for the workspace you are in) tells it which one you mean. If the assistant suggests a command, `ask` prints it as two lines, `Proposed: …` saying what it does and `Run it yourself: foreman …`, and never runs it. The exit code is 0 for an answer, 2 if it took longer than two minutes (what it had so far is printed) and 3 when the assistant isn't available: it is off, Privacy mode is on, or no agent is signed in. Like `approve`, it is refused from inside an agent turn, and the assistant itself can't propose it.

A session in eshell. The ids and sentences are examples; yours will differ, and `foreman help <command>` is the authority on exact wording.

```text
$ foreman status --words
api-fix: Claude Code finished 2 minutes ago, this turn 3 files +120 -14, checks 12 passed, PR #51 open.
login-redesign: Claude Code has a question for you: which breakpoint should the mobile menu use?
docs: idle, PR #52 open, checks passed.

$ foreman approvals
3f9a1c2  login-redesign  question  which breakpoint should the mobile menu use?  options: 768px, 640px

$ foreman approve 3f9a1c2 --answer "breakpoint=640px"
Answered. Claude is working.

$ foreman wait 7f3a9c --words
Claude Code finished in login-redesign: this turn 2 files, +18 -4.

$ foreman diff login-redesign --words
src/menu.tsx, hunk 1 of 1, lines 40 to 52: added: const bp = 640; removed: const bp = 768.
```

## Large text and zoom

Content text size and App zoom are described above. Foreman's screenshot run can capture Home, the chat, Changes and Settings > Accessibility at 200% zoom and at content size 24 (`npm run screens -- --large-text`), so overflow and hidden focus can be found. A keyboard pass at 200% belongs in the manual checks before a release.

## Reporting a problem

Open an issue and say which screen reader and version, which operating system, what you did, what was spoken and what you expected. A copy of the speech from NVDA's speech viewer or VoiceOver's caption panel is the most useful thing you can attach.
