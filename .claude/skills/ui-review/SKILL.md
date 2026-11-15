---
name: ui-review
description: Use this skill when the user asks you to audit, review, critique, score or evaluate Foreman's UI (the whole app, an area such as Settings or the composer, or a single screen), asks "what can be improved" about how something looks or behaves, or wants mocks of improvements. It captures the real app on the screenshot fixture, scores every screen on an 8-axis rubric, checks the findings in the code, and draws two-option HTML mocks for the problems worth fixing. Not for reviewing a pull request's code (create-pr's self-review does that) or for building a design-system component.
---

# Review the UI and mock improvements

The reader is the developer who owns Foreman's design. They want to know what is wrong with the screens people use, how sure you are, and what they could do about it, with mocks they can pick from. Write for someone who knows the app well: specific places, measured sizes, file and line, no praise.

Run this as an audit only. Nothing here changes app code, except temporary fixture edits that you revert before you finish (step 2), and nothing is committed or published. If the developer then picks options to build, that is a new task that starts from `main`.

Before the first command, write a checklist of the steps below and keep it current.

## 1. Scope and folders

Agree the scope in a sentence: the whole app, an area, or the states of one screen. The screens the fixture can show are listed in `SCREENS` in `src/main/screenshots.ts`, and `src/renderer/src/screens.ts` shows how each is reached.

Keep everything the audit produces outside every worktree, because Foreman re-makes a worktree after its PR merges and ignored files are lost with it, and `scripts/check-push.mjs` refuses commits that hold mocks. Use the developer's mocks folder if they have one (ask once if you don't know it), with one folder per audit:

```
<mocks>/<topic>/
  index.html        the report: scores, fix-first table, mocks, suggestions
  rubric.md         copied from this skill
  shots/            the screenshots and their .ax.json trees
  findings/<area>.md
  mocks/<n>-<slug>.html (+ .png renders)
  mock.css          generated in step 6
```

## 2. Capture the screens

Install dependencies if `node_modules` is missing (`npm ci`), then:

```
npm run screens -- --build --out <mocks>/<topic>/shots [--only <screen,…>]
```

Each screen is taken in light and dark at 1320x860, with `.ax.json` accessibility trees beside them; `home`, `workspace-chat`, `tiles` and `settings-agents` also come in two colour-vision modes and at 200% zoom. The run prints accessibility warnings; carry them into the findings.

The fixture shows finished, quiet states. The moments where people get stuck are usually others: an approval or question arriving, a plan to review, a failed turn, an empty new chat, a menu open, a panel loading. If the scope covers any of these and no screen shows them, stage them with temporary screens as described in [staging-states.md](staging-states.md), capture, and revert those edits with `git checkout --` on the two fixture files before step 4. Say in the report which states you staged and which you could not.

## 3. Review against the rubric

Read [rubric.md](rubric.md) and copy it into the audit folder. Split the screens into areas of about 8–16 screens (for the whole app: Home and starting work, the workspace, Settings, Automations and flows, AI employees and organizations; for the chat window: transcript and the cards in it, the composer). Give each area to a reviewer using the brief in [briefs.md](briefs.md), in parallel if you can start sub-agents, otherwise one area at a time yourself. Every reviewer reads the screens and the source behind them, because half the serious problems (a key that does the wrong thing, a draft thrown away) can't be seen in a still image.

While they work, look at the two or three most-used screens yourself, so you can judge their findings rather than relay them.

## 4. Check the findings in the code

A finding the developer acts on must be true. Before reporting:

- Open the file and line of every High finding and every item a reviewer calls a bug, and confirm it. Mark each one **Checked** (you read the code or reproduced it), **Seen** (visible in a screenshot) or **Reported** (a reviewer's claim you didn't confirm).
- Drop anything that is a fixture artefact (the fixture reuses one transcript for several chats; earlier shots tick off checklist items) or that the repository's rules require (coral brand-only, neutral selection), and say so.
- Bugs that need no design decision go in a "fix these first" table with file:line, not into mocks.

## 5. Pick what to mock

Group the findings into themes: problems that recur across screens or that cost people most on the screens they use most. Choose at most six. A good theme names the job it gets in the way of ("deciding fast and safely on an approval"), not a component ("the approval panel").

## 6. Draw the mocks

Generate the mock stylesheet from the real tokens, so the mocks can't drift from the app:

```
node .claude/skills/ui-review/scripts/mock-tokens.mjs <mocks>/<topic>/mock.css
```

It writes the light and dark tokens from `src/renderer/src/ui/tokens.css` under `[data-theme]` selectors, followed by `assets/mock-controls.css` (buttons, inputs, chips and the page around the frames, all in tokens), and copies the app's Geist fonts into `fonts/` beside it so no page depends on a `node_modules` folder. Give each theme to a designer with the mock brief in [briefs.md](briefs.md), in parallel if you can. Each mock page shows Today (the real screenshot), Option A and Option B as full-size frames with real fixture content, the `ui/` components each option uses, the files it would change, whether it needs a new design-system component (the answer should almost always be no; AGENTS.md says what happens if it's yes), and a suggested pick.

Frames are cheapest and most faithful when the real screenshot is the background and only the changed region is drawn over it in HTML.

Render every page with a headless Chromium (Edge on Windows: `msedge --headless=new --disable-gpu --hide-scrollbars --window-size=1400,4000 --screenshot=<png> file:///<html>`; Chrome elsewhere) and look at the frames at full size, cropping with Pillow if the page is tall. Fix anything that overlaps, is clipped, or no longer lines up with the screenshot underneath. Check dark as well as light.

## 7. Write the report

`index.html` in the audit folder, styled with `mock.css`:

1. One paragraph: what was captured, how it was reviewed, which states were staged.
2. Scores: a table per area (average, lowest screen, link to its findings file), and one sentence on the pattern behind the numbers.
3. Fix these first: the checked bugs, by severity, with file:line.
4. The mocks: a card per theme linking to its page.
5. Suggested: the pick for each mock, what it changes in one or two sentences, and whether it needs a `ui/` change; then an order to build in.
6. What wasn't covered.

Render it and look at it before you tell the developer about it.

## 8. Tell the developer

In chat, briefly: how to open the report (a `bash` block with `explorer.exe "<path>\index.html"` on Windows or `open "<path>/index.html"` on macOS), the averages in a line, the checked High bugs with file:line, a table of the mocks (today, suggested), and what you need from them: which options to build, and anything else they should decide. Keep the rest in the report.
