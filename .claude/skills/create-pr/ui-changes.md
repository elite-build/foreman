# UI changes in a pull request

Loaded from step 4 of [SKILL.md](SKILL.md) when the diff changes what the app draws. A reviewer should be able to see the change without running the branch, and know why it looks the way it does.

## 1. Pick the screens

The screenshot fixture (`npm run screens`, `src/main/screenshots.ts`) draws the real app on synthetic data. Its screens are listed in `SCREENS` in that file: `home`, `workspace-chat`, `file-diff`, `settings-general` and so on, plus `gallery-2a` to `gallery-2d` for the design system's galleries. Choose the one to three that show the change.

When you changed something in `ui/` or `tokens.css` that many screens use, capture every screen once (`--only` with the whole list) and look for differences you didn't intend. Those are regressions to fix before the PR, not evidence.

Some areas need more than the fixture holds, and have a **scenario** for it (`src/shared/scenarios.json`; `npm run dev demo list` prints them). A scenario starts the fixture with more data, or plays work until it rests, and names the screens that show its area. Use the scenario when the change is in its area:

| The change is in | Scenario | What its screens show |
| --- | --- | --- |
| A project's channel, the Channels page or sidebar, a wait card, a part's state | `channels` | The demo's channel stories, played by the branch's own services until nothing moves: questions to answer, a plan to approve, a part's check, a part that didn't finish, a paused project, one held at a usage limit, a final check |
| Adding an AI employee, a job's preview, a draft's approval | `hire-employee` | The jobs to pick from, one picked, Compare jobs, Write your own, a draft's plan, an employee's page, the Team page |

`npm run dev demo <scenario>` opens the app on the same data and on the scenario's first screen, to click through what the screenshots will show.

When no fixture screen shows the change, in this order:

1. Extend the fixture if the screen is worth keeping (a new state in `screenshots.ts`, `renderer/src/screens.ts`), as part of this change. A state only work can reach (a run, a wait, a hold) goes in a scenario: add the story or the stage to `src/main/demoEmployees.ts`, its screen to `renderer/src/screens.ts` and `CHANNEL_SCREENS`, and name it in `scenarios.json`. Do not write "No screenshot: the fixture shows none of the new states" for a channel or an employee: add the state.
2. Otherwise take the shot by hand from `npm run dev` with `FOREMAN_DATA_DIR` set to an empty temporary folder. Never from your own data folder: the repository is public and a real window shows real repository names, paths, branch names and chat text.
3. Otherwise describe the change in words, and write "No screenshot: <why>" in the UI section.

## 2. Capture before and after

```sh
npm run pr:screens -- capture --only settings-general,home
```

For a scenario's area, name the scenario instead; `--only` with it takes some of its screens rather than all:

```sh
npm run pr:screens -- capture --scenario channels
npm run pr:screens -- capture --scenario channels --only channel-check,channel-stuck
```

This takes the screens from the merge base with `origin/main` (in a temporary worktree that shares this checkout's `node_modules`) and from your working tree, then compares them. It prints three folders: `before/`, `after/` and `diff/`. Each screen is taken in light and dark; `home`, `workspace-chat`, `tiles` and `settings-agents` also come in two colour-vision modes and at 200%.

With `--scenario channels` each side plays the stories with its own code, so a change to what the services write shows as well as a change to how it is drawn. A merge base from before the scenario existed has no "before": the script says so and takes "after" alone.

Look at each pair yourself before you publish it. Two known differences have nothing to do with your change: the host's agent sign-in state (an "isn't signed in" badge) and a button under the pointer drawn in its hover state. If the only difference is one of those, it isn't evidence.

Look at each shot for anything from this machine before you publish it: the terminal screen shows the temporary folder's path, which on Windows contains the user name, and the sign-in badge shows which agents this machine is signed in to. Leave such a shot out.

If `package-lock.json` changed on the branch, the "before" run used the branch's dependencies; say so if it could matter.

## 3. Publish and lay out

Use the light theme unless the change is about dark mode or contrast. Add a diff image (`diff/<name>.png`, changed pixels in magenta) only when the change is too small to spot. A colour-vision or 200% shot belongs in the PR when the change is about that.

```sh
npm run pr:screens -- publish <run>/before/settings-general-light.png <run>/after/settings-general-light.png
```

A shot from `before/`, `after/` or `diff/` is published as `before-<name>.png` and so on, under a folder named after the branch. The script pushes to the `pr-screenshots` branch (never `main`, and without touching your checkout) and prints Markdown image links pinned to that commit, so they keep working after the PR merges. Publish only fixture or empty-data screenshots.

In the PR body:

```markdown
## UI

| Before | After |
| --- | --- |
| ![before](…) | ![after](…) |

**Why it changed:** <the problem a user had with the old screen>.
**Why it looks like this:** <the components used, and the alternative you rejected and why>.
**Checked:** <only what you actually checked, and how: keyboard path, narrow window, 200% zoom, light and dark, state not shown by colour alone. Name what you didn't check.>
**Recorded in:** <see below>.
```

## 4. Where the reasoning lives after the PR

The PR keeps the screenshots and the reasoning for this change. Some of it also needs to outlive the PR, in one place:

- **`docs/design-system.md`**: a new component, variant or prop (already required by AGENTS.md), or a pattern other screens should now follow (how a kind of list, empty state or confirmation looks). Update the component's section in this branch.
- **`docs/decisions.md`**: a direction a future change could undo without knowing why. A feature removed, moved or hidden; a default changed; one interaction model chosen over another that was seriously considered. Follow that file's "When to add an entry".
- **Neither**: a fix that restores the intended look, polish, spacing, wording, or a new screen built from existing patterns. That is most UI changes. Write "Recorded in: this PR" and stop.
