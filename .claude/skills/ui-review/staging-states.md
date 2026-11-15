# Staging states the fixture doesn't show

The screenshot fixture (`src/main/screenshots.ts` builds the data, `src/renderer/src/screens.ts` drives the page) shows
finished, quiet states. To review a state it lacks, add temporary screens, capture them, and revert both files before
the review starts. Mark every temporary line `AUDIT-TEMP` so a stray one is easy to find. If a staged state turns out
to be worth keeping for PR screenshots too, suggest adding it properly as its own task; don't leave the temporary
version in.

## 1. Name the screen in main

Add the names to the end of `SCREENS` in `src/main/screenshots.ts`. `--only` takes only names from that list.

## 2. Get there in the renderer

Add an entry to `SCREENS` in `src/renderer/src/screens.ts`. Each entry reaches the state with the store's own actions
and returns a selector that shows it has rendered:

```ts
// AUDIT-TEMP
'chat-failed': () => (selectWorkspace('ws-osaka'), selectSession('ws-osaka', 's-osaka-1'), '.chat .user-msg'),
'chat-new': async (f) => {
  selectWorkspace(f.workspaceId)
  await newChat(f.workspaceId) // import newChat from './store'
  return '.composer textarea'
},
'composer-mention': async (f) => composerTyped(f, '@'),
```

To type into the composer, set the textarea's value natively and fire `input`, as `typeInto` does for inputs:

```ts
async function composerTyped(f: Fixture, text: string): Promise<string | null> {
  openWorkspace(f)
  const area = await waitFor(element('.composer textarea'))
  if (!area) return null
  area.focus()
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text)
  ;(area as HTMLTextAreaElement).setSelectionRange(text.length, text.length)
  area.dispatchEvent(new Event('input', { bubbles: true }))
  return '.mention-menu'
}
```

`show()` blurs the focused element before the shot, which closes menus. For screens that need focus kept, skip the
blur for them (for example `if (!screen.startsWith('composer-') && …) document.activeElement.blur()`).

## 3. Hold an approval, question or plan open

These come from main, not the page. Hold a real request around the shot, the way the keyboard walk holds its approval
(`requestApproval` in `screenshots.ts`): start it before the page loads and abort it after the capture, in a `finally`
so a failed shot can't leave it open.

```ts
// AUDIT-TEMP: the request main holds open while each of these is taken.
const HOLD: Record<string, Record<string, unknown>> = {
  'chat-approval': { kind: 'tool', toolName: 'Bash', input: { command: 'npm test -- session && git push origin fix-login-redirect', description: 'Run the session tests, then push the branch' }, alternate: 'always-allow', alwaysScope: 'npm test' },
  'chat-question': { kind: 'question', questions: [{ header: 'Expired token', question: 'What should happen when the refresh token itself has expired?', options: [{ label: 'Sign the user out' }, { label: 'Keep the old session' }] }] },
  'chat-plan': { kind: 'plan', plan: '## Keep the session across token refresh\n\n1. …' }
}

// In the shot loop, before `try {`:
const holdAbort = new AbortController()
const hold = HOLD[shot.screen]
if (hold) {
  const sessions = core.sessions as unknown as { requestApproval(sessionId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }
  void sessions.requestApproval(run.fixture.chatId, hold, holdAbort.signal).catch(() => undefined)
}
// …and after the loop body's `catch`:
} finally {
  holdAbort.abort()
}
```

The renderer entry then only opens the chat and waits for the card: `.approval-panel`, `.approval-panel.question` or
`.plan-card`. The request kinds and their fields are `ApprovalRequest` in `src/shared/types.ts`.

## 4. Capture, then revert

Screens that change the fixture's data (a new chat adds a tab every later shot would show) go in a run of their own:

```
npm run screens -- --build --out <shots> --only chat-failed,composer-mention,chat-approval,chat-question,chat-plan
npm run screens -- --no-build --out <shots>/new --only chat-new   # then move its files up into <shots>
git checkout -- src/main/screenshots.ts src/renderer/src/screens.ts
git status --short   # nothing left from the audit
```

A screen reported as "did not render" usually means its selector never appeared. The `/` menu, for example, lists
`api.slashCommands`, and the fixture has none, so it can't be captured; review it from the code instead and say so.
