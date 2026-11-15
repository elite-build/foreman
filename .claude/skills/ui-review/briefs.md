# Briefs for reviewers and designers

Fill the `<…>` parts and give one brief per area or theme. A sub-agent starts with none of your context, so the brief
carries everything it needs: where things are, what to read, what to write, and the facts you already know.

## Reviewer brief

```
You are a senior product designer auditing <area> of Foreman, a desktop Electron app that runs coding agents in
parallel, each in its own git worktree. Read-only: don't change app code. <If staging edits are still in the tree:
"Ignore uncommitted AUDIT-TEMP edits in src/main/screenshots.ts and src/renderer/src/screens.ts.">

Read first: <audit>/rubric.md (8 axes scored 0-10, severities, and Foreman's recurring patterns; follow it), and skim
docs/design-system.md in the repo at <worktree> so every fix names existing components from src/renderer/src/ui/.

Screens (real app on a fixture, 1320x860 at 1x) are in <audit>/shots/ as <screen>-light.png and -dark.png, with
.ax.json accessibility trees beside them. Your screens: <list>. Also look at <z200 / colour-vision shots, if any>.
<Known facts: fixture quirks not to score, states that couldn't be captured and must be reviewed from code.>

For each screen: view the light PNG and at least glance at the dark one; read the .ax.json where it helps; read the
source behind it (<likely files>) to know what each control does and what the keys do. Think about the person's real
job here: <the job, e.g. "follow what the agent did, decide fast and safely on approvals, recover from failures">.
Be concrete: name the element and where it is, and measure in pixels. Don't praise; a strength gets one line at most.
Don't flag what AGENTS.md requires (coral brand-only, neutral selection).

Write <audit>/findings/<area>.md:
1. A table: screen | the 8 axis scores | overall.
2. Per screen, bullets: `[High|Medium|Low] <axis>: <what, where, measured> → <fix, naming ui components>`.
3. Themes: the 3-5 problems that recur or matter most, each with the screens affected, why it matters, and an
   improvement idea described well enough for a designer to draw.
4. Bugs: anything plainly defective, with file:line.
Return a 10-line summary of your themes.
```

## Designer brief

```
You are a product designer making one HTML mock page for Foreman, a desktop Electron app that runs coding agents in
parallel, each in its own git worktree. An audit found problems: screenshots in <audit>/shots/ (1320x860 at 1x,
<screen>-light.png / -dark.png), findings in <audit>/findings/, rubric in <audit>/rubric.md. Don't change app code in
<worktree>; read it freely (the components behind your screens, src/renderer/src/ui/, docs/design-system.md).

Output <audit>/mocks/<n>-<slug>.html, linking ../mock.css (the app's real tokens under [data-theme='light'|'dark'],
and the mock controls, with the app's fonts; read it first and reuse its classes, and don't link fonts from node_modules). The page, top to bottom:
1. Title, and 2-3 sentences on the problem in plain words with the audit's measurements.
2. Today: the real screenshot(s) at 1:1, swapped to -dark with the theme.
3. Option A and Option B: two genuinely different proposals, each as one or more full-size frames with real fixture
   content. Cheapest and most faithful: the real screenshot as the frame's background, with only the changed region
   drawn over it in HTML at its exact position. After each option, 3-6 bullets: what changed and why (tie to the
   audit), which src/renderer/src/ui/ exports it composes, which files would change, and whether it needs a new
   design-system component (avoid; if unavoidable, say which and why nothing existing fits).
4. Suggested: your pick and why, in 2-3 sentences.
5. A Light / dark button toggling document.documentElement.dataset.theme, remembered in localStorage 'mock-theme',
   and ?theme=dark in the URL.

Rules (AGENTS.md): existing design-system looks only; tokens only (var(--…)); coral --accent is brand only (agent
icons, the Automations bolt, the Assistant sparkle), never state, links, selection or warnings; selection neutral;
focus and links blue, links underlined; state never by colour alone; the keyboard path visible; shortcuts written for
the platform of the screenshots ("Ctrl+Enter" on Windows, not ⌘ ↵ ⇧); plain English, sentence case, no internal
names. Prefer the option with the least relearning that still solves the problem.

THEME: <file name, title>. Shots: <list>. Facts from the audit: <the measured problems, checked bugs with file:line>.
Option ideas, yours to refine: A — <…>; B — <…>.

Check your work: render the page with a headless Chromium (on Windows: "C:\Program Files (x86)\Microsoft\Edge\
Application\msedge.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1400,4000
--screenshot=<png> file:///<html>), crop the frames at full size with Python and Pillow (python -I), and fix anything
overlapping, clipped, unreadable or out of line with the screenshot beneath; check ?theme=dark too. Delete your
temporary crops. Return a 6-line summary: the two options and your pick.
```
