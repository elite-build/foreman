# Manual checks: screen readers and keyboard

Manual accessibility validation. Automated tests cannot say what a screen reader speaks, so changes affecting these flows need a recorded pass. Maintainers run NVDA on Windows and VoiceOver on macOS; JAWS is not a target. Every row below is **not yet run**.

## How to run a pass

- Start from the same state every time: a disposable data folder (`FOREMAN_DATA_DIR`) on the screenshot fixture, which has three workspaces (`api-fix`, `login-redesign`, `docs`), one pending tool approval and one pending question.
- Use the keyboard only. A step that needs the mouse is a failure, not a note.
- Watch what is spoken: NVDA's Speech Viewer (Tools menu, or log speech at the "input/output" level) or VoiceOver's caption panel. Paste the transcript next to the expected utterance and compare by eye. Reader phrasing may differ ("button" before or after the name); the words must not.
- Windows keys are shown. On macOS, Ctrl+Alt is Cmd+Option.
- Record the run in the matrix below, then set each row's status to `pass`, `fail` or `fixed in <commit>`.

## Run matrix

`npm run screens -- --walk` replays the key scripts for phases 0, A and C on the fixture automatically (real key presses, focus and live-region text recorded and compared with `tests/fixtures/walks`); it does not replace this pass with a screen reader.

One row per run. Copy the last row, fill in the versions and date, and keep the old rows.

| Phase | Date | Windows | macOS | Electron | NVDA | VoiceOver | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| B1 | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| A | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| C | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| D | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| E | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| F | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| G | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |
| H | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run | not yet run |

## Phase 0: approval keys that do what the button says

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | A tool approval is pending. Tab to the **No** button and press Enter. | The request is denied, not approved. The agent is told it was denied. | not yet run |
| 2 | Next request: Tab to the alternate button ("Always allow" or "Allow edits") and press Enter. | Only the alternate answer applies; nothing else is approved. | not yet run |
| 3 | Next request: Tab to **Yes** and press Enter. | "Yes button." then "Claude started working." | not yet run |
| 4 | Repeat 1 to 3 with Space instead of Enter. | The same result for each button. | not yet run |
| 5 | A question is pending. Tab to an option and press Enter. | That option is chosen. The question is not submitted. | not yet run |
| 6 | Tab to **Submit** and press Enter; on another question Tab to **Skip** and press Enter. | Submit sends the answer; Skip skips and nothing else. | not yet run |
| 7 | Focus lands on the panel when a request arrives. Press Enter on the panel itself; on another request press Backspace. | Enter approves, Backspace denies (panel shortcuts work only when the panel itself has focus). | not yet run |
| 8 | Tab into the reason field, type a reason, press Enter. | The request is denied and the reason is sent. The field's description is spoken: "Pressing Enter here denies the request and sends this reason to the agent." | not yet run |
| 9 | Arrive at a request and listen. | "Approval, group" with the title as its name (both panels are named groups). | not yet run |

**Pass criteria:** no Enter or Space on a button does anything but that button's own action, and the panels are announced as named groups.

## Phase B1: shortcut registry and reserved chords

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | With NVDA in **browse mode**, press each chord in the help sheet in turn. | Every chord reaches Foreman and does its action; NVDA does not swallow it. | not yet run |
| 2 | Repeat 1 in **focus mode**. | The same. | not yet run |
| 3 | Press Ctrl+Alt+] and Ctrl+Alt+[. | Not swallowed by NVDA (latest reply and previous turn once Phase A is in). | not yet run |
| 4 | Press the rebound previous and next workspace keys (Ctrl+Alt+PageUp, Ctrl+Alt+PageDown). | "Switched to <workspace name>." | not yet run |
| 5 | Press Ctrl+Alt+Up and Ctrl+Alt+Down in a table. | NVDA's table navigation works; Foreman does nothing. | not yet run |
| 6 | Open the shortcut help sheet and read it. | Windows chords say "Ctrl+Alt" explicitly; single-letter keys are marked as focus-mode only; every registered chord is listed. | not yet run |

**Pass criteria:** every chord in the help sheet works in both modes, none collides with a reader key, and the help sheet matches what the keys do.

## Phase A: screen-reader mode for chat

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | In another app, wait for an approval. Alt+Tab to Foreman. | "Foreman window. Chat: login-redesign, region." | not yet run |
| 2 | Press Ctrl+Alt+Period (what needs me). | "Switched to api-fix. Claude in api-fix wants to run Bash: npm test. Approval, group. Yes button." Focus is on the Yes button. | not yet run |
| 3 | Press Enter on Yes. | "Yes button. Claude started working." | not yet run |
| 4 | Wait for the turn to end. | One live-region sentence, spoken once: "Claude finished in api-fix: this turn 3 files, +120 -14. Checks: 12 passed." Checks appear only when fresh ("checks: 3 passed, stale" or nothing); never "tests passed". | not yet run |
| 5 | Press Ctrl+Alt+] (latest reply). | "Heading level 3. Turn 7, Claude, 14:02, finished, 4 tool calls." (the time is when the turn's message was sent; the tool-call count is left out when there are none). | not yet run |
| 6 | Press Down arrow. | The reply is read: "I moved the retry loop into fetchWithRetry and added a test for the 429 case..." | not yet run |
| 7 | Press H, then Shift+H. | H moves to the next turn heading, Shift+H back. | not yet run |
| 8 | On a reply that has its own Markdown headings, press H repeatedly. | Per turn: the turn (level 3), "You, 14:02" and "Claude, reply to your 14:02 message" (level 4), then the reply's own headings (level 5 for `#`, level 6 for `##` and deeper). | not yet run |
| 9 | Press Ctrl+Alt+[ (previous turn). | Focus moves to the previous turn's heading. | not yet run |
| 10 | Press Ctrl+O on a turn with tool calls. | The tool calls expand; the count in the heading matches. | not yet run |
| 11 | A3 step 1, the NVDA reproduction: put the browse cursor in an old message while a long reply streams. | The browse cursor does not move. Record the result either way. The reply's Markdown is already throttled to one render per 300 ms while it streams (A3 step 2); if the cursor still moves, the next step is finished-block rendering. | not yet run |
| 12 | Switch to another chat with the keyboard while the cursor is in the old chat's messages, then again from the composer, then by clicking a sidebar entry. | "Switched to <chat> in <workspace>" is spoken each time. Focus moves to the chat heading ("Chat: <chat>") only in the first case, not from the composer or the sidebar. | not yet run |
| 13 | Open the file list's status icons. | Each file status has a word (added, modified, deleted, renamed). | not yet run |

**Pass criteria:** the script completes without a mouse, each utterance matches or differs only in reader phrasing, and nothing is spoken twice or not at all.

## Phase C: accessible diff

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | Open the Changes panel and Tab into the file list. | "modified, retry.ts, src/api/, plus 84 minus 10. Viewed, checkbox, not checked." | not yet run |
| 2 | Press Enter to open the file, then H. | "Table with 3 columns. Caption: src/api/retry.ts, modified, 84 added, 10 removed. Heading level 3. Hunk 1 of 3, lines 12 to 40, near: export async function fetchWithRetry." | not yet run |
| 3 | Press Down arrow. | "Row 2. Old 12. New 12. Space. import { sleep } from './sleep'" | not yet run |
| 4 | Press Down arrow to an added line. | "Row 3. Blank. New 13. Added. import { RetryError } from './errors'" (added and removed are spoken as words). | not yet run |
| 5 | Press H, then the heading key for level 2. | H jumps to the next hunk (level 3, the file's own name is level 2, under the workspace's level 1); level 2 jumps between files. | not yet run |
| 6 | Press Down until "Row 19. Blank. New 29. Added. if (attempt > 5) throw new RetryError(res.status)". | Rows read their own text. | not yet run |
| 7 | Press Shift+Down twice. | "Selected 3 lines, new 29 to 31." | not yet run |
| 8 | Press Enter (the row, not the toolbar). | The existing comment box opens with focus in it: "Leave a comment for the agent (sent with your next message), edit". The selection stays highlighted. | not yet run |
| 9 | Type "Make the limit configurable" and press Ctrl+Enter. | The box closes and focus is back on the anchored row (the first row of the selection's anchor): "Row 19 ..." is read again. Escape in the box does the same. | not yet run |
| 10 | Press Escape with a selection. | The selection clears; focus stays on the row. | not yet run |
| 11 | Switch to split mode. | Split still has its column headers (4 columns). With a screen reader on, unified is the default and the toggle's description says so. | not yet run |
| 12 | Walk a deletion-only hunk and a file with a comment between rows. | Hunk heading says "removed lines 30 to 31"; the arrows skip the comment row, and it is read in browse mode (down arrow in the browse cursor) between its rows. | not yet run |
| 13 | Press Down past the last row of a hunk. | Focus lands on the next hunk heading ("Hunk 2 of 3, lines ...") and Down again goes into its first row; Shift+Down never extends across the gap. | not yet run |
| 14 | In split, focus a row, press Left, then Shift+Down. | "Old side"; "Selected 2 lines, old 12 to 13." Right gives "New side" and clears the selection. | not yet run |
| 15 | Look at the screen while doing 3 to 10 with the keyboard. | A focus outline shows on the heading or the row that has focus and is not hidden behind the sticky file header; the selection highlight shows the selected lines. | not yet run |

**Pass criteria:** files and hunks are reachable by heading, rows read added and removed as words, a three-line comment is made without the mouse, and focus returns to the row.

## Phase D: low vision

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | Settings > Accessibility: set Content text size 24 and Reduce motion On. | Chat, diff and file viewer text is 24 px; toolbars stay at the chrome size. | not yet run |
| 2 | Zoom the app to 200 % and walk every screen with Tab. | Nothing overflows or is clipped; focus is visible everywhere. | not yet run |
| 3 | Jump to a setting from search; scroll to the bottom of a chat; start a turn. | No flash, no smooth scroll, no spinner animation. | not yet run |
| 4 | Tab through every control that is revealed on hover (chat message actions, rows). | Each is reachable and visible while focused, and has a name. | not yet run |
| 5 | Turn on Windows High Contrast. | All controls, focus rings and the add/remove marks in the diff remain visible. | not yet run |
| 6 | Look at a diff line with colours ignored. | Added and removed are marked by the sign and the word, not by colour alone. | not yet run |

**Pass criteria:** at 200 % and 24 px nothing is clipped or obscured, motion is off with Reduce motion on, and every hover-revealed control is reachable by keyboard.

## Phase E: the narrator

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | Focus another app and let an agent ask for approval. | The OS notification has the workspace name as its title and the narrator sentence as its body, and NVDA speaks it in its own voice: "api-fix. Claude Code in api-fix wants to run Bash: npm test". | not yet run |
| 2 | With Foreman focused, let a turn end. | With Settings > Accessibility > "Say what changed when a turn ends" on, the end-of-turn sentence is spoken once; any toast for it is shown but not read. With it off, only "Claude Code finished." is spoken. | not yet run |
| 3 | Turn "Sound cues" on and let a turn start, need you, finish and fail. | A short, different cue per event (under 400 ms); the completion sound is not also played. With the completion sound set to None, neither plays. | not yet run |
| 4 | Open Settings > Accessibility and operate every control with the keyboard. | Every control has a name and works; the terminal screen-reader switch is there. | not yet run |
| 5 | With Foreman's voice On and the reader off, let a turn end. | One voice only: Foreman's local voice says the sentence; the live region is not also fed. | not yet run |
| 6 | Open Home's Recent list and Tab to a row. | The row is described by the narrator sentence ("Claude Code finished in api-fix: ..."), or for a request that is waiting, what it wants. | not yet run |
| 7 | Set "Announce agent activity" to Only what needs me, then My open chat, then All chats, and let a turn in another chat start and end. | Only what needs me: a request is spoken, started and finished are not. My open chat: the open chat only. All chats: the other chat is spoken too, with its workspace and chat named. | not yet run |

**Pass criteria:** each event is heard once, on one channel, with the narrator's words.

## Phase F: Ask Foreman

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | In a diff on a line, press Ctrl+Alt+Space (Cmd+Option+K on macOS). | "Ask Foreman, dialog. Edit. Quick actions: What needs me, What happened here, Read the last reply." | not yet run |
| 2 | Activate **What needs me**. | The narrator's answer with no model turn. | not yet run |
| 3 | Type "what did Codex do in docs" and press Enter. | After a model turn (about 5 seconds): "Codex in docs finished 20 minutes ago: 2 files, +41 -3, updated README.md and CONTRIBUTING.md with the new retry settings. No approvals waiting. PR #52 open, checks passed." | not yet run |
| 4 | Press Escape. | The dialog closes and focus returns to where it was (for example "Row 19."). | not yet run |
| 5 | Ask "approve the npm test call". | A proposal is read with the command: "Proposed: foreman approve 3f9a1c2, Bash: npm test in api-fix. Run button." | not yet run |
| 6 | Press Enter with focus in the field, then Tab to Run and press Enter. | Enter in the field never runs the proposal; Enter on the focused Run button does. | not yet run |
| 7 | Load the adversarial fixture (a chat message asking for `foreman approve --always`) and ask what needs you. | At most a plain one-shot approve is proposed; `--always` is never proposed or run. | not yet run |
| 8 | Open the command palette, type "Ask", press Enter on **Ask Foreman**. | The same dialog opens; its palette hint reads "Ctrl+Alt+Space" (Cmd+Option+K on macOS). | not yet run |
| 9 | Turn the assistant off or sign the default agent out, then open Ask Foreman. | The field is disabled and its description says why; the three quick actions still answer. | not yet run |
| 10 | Use a quick action, then read the answer with the screen reader's browse keys. | The answer is spoken once (by the announcer) and is also readable under the heading "Answer"; the dialog adds no second live announcement. | not yet run |
| 11 | With Foreman's voice on, press Escape while an answer is being spoken. | The first Escape stops the voice and the dialog stays open; the second closes it. | not yet run |

**Pass criteria:** nothing runs without Enter on a focused Run button, the spoken proposal contains the tool summary and the exact command, and Escape restores focus.

## Phase G: speech

| # | Keys or action | Expected | Status |
| --- | --- | --- | --- |
| 1 | G0 spike, on a clean machine: install the packaged build, start the helper, feed a WAV through the stdio protocol; request microphone permission. | A transcript comes back; the permission prompt text is the one in the app's Info.plist (macOS) or the system prompt (Windows). | not yet run |
| 2 | With NVDA running, hold Ctrl+Alt+V and say "What needs me?" then release. | The transcript appears in the Ask field: "What needs me?" and is editable. | not yet run |
| 3 | Press Enter. | The narrator answers: "One thing. Claude in login-redesign has a question: which breakpoint should the mobile menu use? Two options." | not yet run |
| 4 | Hold the key and say "Open it." | "Switched to login-redesign. Question, group. Option 1 of 2: 768 pixels. Option 2: 640 pixels. Other." | not yet run |
| 5 | Say "approve the npm test call". | A proposal is read; nothing is approved until Enter on Run. | not yet run |
| 6 | G1: with NVDA or VoiceOver running, turn on Settings > Accessibility > Foreman reads announcements aloud, then let an agent finish. | Foreman speaks the sentence in the chosen voice; the screen reader says nothing for it (one voice). The note "A screen reader is running; it will also read what Foreman speaks." shows under the switch. Turn the switch off: the next event is read by the screen reader again, and anything Foreman was saying stops. | not yet run |
| 7 | G1: while Foreman speaks, press Escape with focus in the composer, then on a button outside Ask, then inside Ask. | The composer's Escape still stops the agent and does not touch the speech; on a button, and inside Ask (even in its field), the first Escape stops the speech and does nothing else. | not yet run |
| 8 | Transcript lands in a focused text field outside Ask. | The text goes to that field, editable before sending. | not yet run |
| 9 | G1: open the Voice list, pick another voice, move Speech rate to 2 and Speech volume to 0.5, press Test voice. | Only voices installed on this computer are listed, by name and language. The sample sentence is spoken with the new voice, faster and quieter. | not yet run |
| 10 | G1: let two agents start and finish within a second or two with the voice on. | One sentence per chat, in order, a started that was replaced by finished is not spoken; pressing Escape drops the rest. | not yet run |
| 11 | G2, hold mode: with the Composer focused and text in it, put the caret mid-sentence, hold Ctrl+Alt+V (Cmd+Option+V on macOS), say a few words, let go of V first; then repeat letting go of Ctrl or Alt first, and once alt-tabbing away while holding. | The reader says "Listening" once, then "Heard: ...". The words are at the caret with a space where needed, and sending the message includes them. All three ways of letting go stop it. Alt-tabbing away stops it and delivers what was heard. | not yet run |
| 12 | G2, macOS only: hold Cmd+Option+V and let go of V while still holding Cmd. | Letting go of V may not stop it (macOS sends no key-up for letters under Cmd). Letting go of Cmd, or pressing the chord again, stops it. The 60 second cap would otherwise. | not yet run |
| 13 | G2, toggle mode (Settings > Accessibility > Speech input > Press to start, press to stop): press the chord, speak, press it again; then press it and click elsewhere in the window and alt-tab away and back before the second press. | Starts and stops on the two presses only. Alt-tabbing does not stop it. The sidebar status shows "Listening…" with the words so far and a Stop button. | not yet run |
| 14 | G2: speak for more than 60 seconds in either mode. | It stops by itself at 60 seconds, says "Stopped after 60 seconds", and delivers the words. Escape during a recording throws it away and says "Dictation cancelled". | not yet run |
| 15 | G2: with nothing focused (or a button focused), hold the chord and say "What needs me?". | Ask Foreman opens with the words in its field and the caret at the end, and nothing is sent; Enter sends. With the assistant off in Settings, the words are read out with "no text field" and a toast, and nothing opens. | not yet run |
| 16 | G2, microphone: first use on a clean Windows and macOS machine, then refuse permission and try again. | The system prompt appears once; after a refusal Foreman says it cannot use the microphone and where to allow it, and works after allowing it. The microphone indicator goes off as soon as the key is up. | not yet run |
| 17 | G2, engines: dictate with the local model (download it first from Settings, the consent dialog names its size and source before anything downloads, then progress text shows), then switch to OpenAI with a saved key, then with Privacy mode on. | Local: no audio leaves the machine; dictation before the download reports that the model is missing. OpenAI: "Transcribing" is said after letting go, then the words. Privacy mode: dictation is refused with a spoken and toasted message, and Settings shows the note. | not yet run |
| 18 | G2: with Foreman's voice on, trigger an announcement, then start dictating. | Foreman stops speaking when dictation starts, and its own voice is not heard in the transcript. | not yet run |

**Pass criteria:** push-to-talk works with the reader running, the transcript lands where the focus is, and the reader and Foreman never speak the same event twice.

## Phase H: command line and Emacs

Run in a terminal with NVDA, and once from Emacs with Emacspeak if an Emacs user is available. The `--words` flag is opt-in on `status`, `wait`, `diff` and `attention`; `--json` is unchanged and ignores it.

| # | Command | Expected | Status |
| --- | --- | --- | --- |
| 1 | `foreman status --words` | A lead line ("1 thing needs you"), then one sentence per workspace, for example "api-fix: Claude Code finished 2 minutes ago, this turn 3 files +120 -14, checks 12 passed, PR #51 open." and "login-redesign: Claude Code has a question for you: which breakpoint should the mobile menu use?" | not yet run |
| 2 | `foreman approvals` | "3f9a1c2  login-redesign  question  which breakpoint should the mobile menu use?  options: 768px, 640px" | not yet run |
| 3 | `foreman approve 3f9a1c2 --answer "breakpoint=640px"` | "Answered. Claude is working." | not yet run |
| 4 | `foreman wait 3f9a1c2 --words` | "Claude Code finished in login-redesign: this turn 2 files, +18 -4." | not yet run |
| 5 | `foreman diff login-redesign --words` | "1 file changed, +1 -1", then "src/menu.tsx, modified, 1 added, 1 removed", then "src/menu.tsx, hunk 1 of 1, lines 40 to 52: added: const bp = 640; removed: const bp = 768". | not yet run |
| 6 | `foreman attention --words` | Each line starts with how long ago; a finished turn is "Claude Code finished in api-fix."; a request still waiting says what it is. | not yet run |
| 7 | `foreman status --words --json` | The same JSON as `foreman status --json`. | not yet run |
| 8 | Read each line as it arrives with the reader running. | Each line is a whole sentence, spoken once, with nothing that depends on columns or colour. | not yet run |

**Pass criteria:** the Session 4 commands read naturally one line at a time, and the JSON output is unchanged.
