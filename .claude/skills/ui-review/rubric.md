# Screen audit rubric

Drawn from the design-review skills in AI LABS' "Insane Claude Design Skills You Need To Actually Build Beautiful
Sites" (Jakob Krehel's review and layout skills, the screen-critique and perception-laws skills, tastemaker's "no
generic defaults"), adapted to a desktop app for running coding agents.

Score each screen 0–10 on every axis. Every finding names a place on the screen and, for layout, a size in pixels
(screenshots are 1320x860 at 1x unless the file name says `-z200`). Read the source behind a screen before scoring
axes 5 and 8: keyboard handlers, focus and what a control does can't be seen in a still image.

| Axis | Question | Source idea |
| --- | --- | --- |
| 1. First glance | Squint: what do you see first, second, third? Is that the order the person needs? Is there one obvious primary action, or several equal ones? | Perception laws; a landing page's "one job" |
| 2. Layout and spacing | Do edges line up? Is spacing on one rhythm (4/8 px)? Anything cramped, truncated, clipped, wrapping, or floating in empty space? What happens at 200% zoom or in a narrow window? Give pixels. | Krehel's layout skill |
| 3. Type | How many sizes and weights are on screen? Is hierarchy carried by size and weight rather than colour alone? Line lengths readable? | Design-engineering skills |
| 4. Grouping and density | Do related things sit together and unrelated things apart? Too many borders and boxes? Space given to what matters, or to what is empty? | Gestalt and perception laws |
| 5. State and feedback | Can you tell at a glance, without colour, what is running, done, failed, or waiting on you? Are loading, empty and error states helpful and stable? Does the person know what a key or button will do before pressing it? | Screen critique |
| 6. Consistency | Does the same thing look and behave the same here as elsewhere: headers, toolbars, lists, buttons, empty states, shortcuts, words? | Krehel's review skill |
| 7. Not generic | Does it look like a specific, considered product, or like default output: identical cards for everything, centred empty text, label: value lists, the same weight for everything? | Tastemaker |
| 8. Accessibility | 24 px targets, focus order and visible focus, contrast of muted text, colour-only meaning, names in the `.ax.json`, keyboard traps, anything only reachable by hover. | Krehel's review skill |

## Severity

- **High**: slows or misleads someone doing the screen's main job, loses their work, or lets them do something risky without meaning to.
- **Medium**: noticeable friction, inconsistency or an accessibility gap.
- **Low**: polish.

## Patterns that recur in Foreman

Check for these on every screen; each has turned up in more than one place before.

- **Moments, not just screens.** What happens when something arrives while the person is busy: an approval while they type, data loading under them, a panel opening. Look for focus that jumps, drafts that vanish and keys that change meaning.
- **Keys that lie.** A shortcut labelled one thing that does another, Esc or Enter falling through to a bigger action when a menu is empty, Shift+Tab captured.
- **Mac symbols on Windows.** ⌘, ⌥, ⇧, ↵ or ⌫ in a label or tooltip on the Windows fixture. The fix is `formatChord` / `shortcutHint` in `shortcuts.ts`.
- **Reasons only on hover.** A disabled control whose reason is only in a `title` tooltip, which a keyboard never reaches.
- **State by colour alone.** A failed row that only turns red, a status shown only by a dot's colour. Pair it with a glyph from `ui/Glyph` or a word.
- **Glyph meanings.** ▲ means "needs you" and ◆ means "failed" across the app; a screen that swaps them misleads.
- **Blank or jumping loads.** An empty panel while loading, controls that appear late and push the layout.
- **The important part truncated.** The folder, reason or name that matters is the part cut off with "…".
- **Said twice.** Two primary buttons for the same action, the same filter as a chip and a tab, the same sentence in two places.
- **Internal names.** Field names, ids or schema terms in the interface.
- **Outward actions not flagged.** Anything that pushes, publishes, deletes or spends without saying so before the button.

## Constraints a fix must respect

From AGENTS.md: controls come from `src/renderer/src/ui/` (catalogue in `docs/design-system.md`); tokens only; coral
`--accent` is brand only; selection is neutral, focus and links are blue (links underlined); state is never colour
alone; reduced motion and forced colours are preserved; Foreman's words go through `src/shared/i18n`. A fix that needs
a new component must say so and why nothing existing fits.
