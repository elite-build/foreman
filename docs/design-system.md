# Design system

The desktop renderer's canonical design system is `src/renderer/src/ui/`: React controls, tokens and component styles. `styles.css` loads the tokens first, then its parts in `src/renderer/src/styles/` (one file per area, in cascade order; `components/workspace.css` does the same for `styles/workspace/`). `main.tsx` imports `ui/ui.css` after `App` and its feature styles so the components own their appearance. Feature code composes controls and sets layout; it must not override their colours, borders, typography or focus styling. Legacy styles below are migration context, not patterns for new controls. See [AGENTS.md](../AGENTS.md) for mandatory reuse and the new-component process.

The phone app (`resources/mobile/`) has its own small stylesheet and isn't covered here.

## Finding and choosing a component

The **Components** sections below are the authoritative catalogue of purposes, variants, props and composition examples; do not maintain a second catalogue elsewhere. Import public controls and types from `src/renderer/src/ui/index.ts` using the appropriate relative path (for example, `import { Button, Field, TextInput } from '../ui'` in `components/`). The implementation is normally `ui/<Name>.tsx`; grouped exports such as `CardButton`, `Sheet`, tab parts and menu parts live in `Card.tsx`, `Dialog.tsx`, `Tabs.tsx` and `Menu.tsx`. Read the implementation and public prop types before use; the barrel is the definitive export list.

| Requirement | Catalogue entries to inspect | Runnable example source |
| --- | --- | --- |
| Actions, cards and feedback | Button, IconButton, LinkButton, ChipButton, Pressable, ActionRow, Card/CardButton, Tag, Status, Glyph, Spinner, Meter, Callout, Kbd, MediaThumb | `ui/gallery/2a.tsx` |
| Labelled inputs and choices | Field/useField, TextInput, TextArea, Range, FileInput, Checkbox, Select, MaskedValue, Switch, RadioList, RadioCards | `ui/gallery/2b.tsx` |
| Navigation and action menus | Segmented, Tabs and parts, Menu and parts, ContextMenu, SplitButton, Disclosure | `ui/gallery/2c.tsx` |
| Overlays, pickers and structure | Dialog/Sheet, Popover, HoverCard, Listbox, Combobox, Tree/TreeItem, Resizer | `ui/gallery/2d.tsx` |
| Brief emphasis after navigation | Flash (`flash`, `flashTargets` in `ui/flash.ts`) | Flash section below and `tests/ui/flash.test.tsx` |

For each family, `tests/ui/<Name>.test.tsx` exercises its contract and keyboard behaviour. Search feature callers for production compositions. Galleries demonstrate variants and states without requiring a new story framework.

Application-level reuse is separate from the primitive kit:

- Settings pages compose `Page`, `Section`, `Row`, `ToggleRow`, `TextRow`, `TextAreaRow`, `useRepoSetting` and save helpers from `components/settings/controls.tsx`. Its `MaskedValue` wrapper supplies translations and toasts to the UI primitive. Reuse these settings behaviours rather than copying auto-save and inheritance logic.
- Errors and notifications use `attempt`/`showToast` in renderer `store.ts` and `components/Announcer.tsx`; inline feedback uses `Callout`/`Status` and loading uses `Spinner`. Follow nearby feature handling for retries and empty states.
- Responsive panels use `components/resize.tsx` (`usePanelSize`, `useWindowWidth`) with `Resizer`; inspect `App.tsx` and `styles/layout.css` before changing breakpoints or panel behaviour. There is no general layout-component library in the UI exports: use existing grid/flex patterns and layout-only classes.
- Typography loads Geist and Geist Mono in `main.tsx`, with tokens below. Icons generally come from `lucide-react`; status shapes use `Glyph`. Theme selection is applied through Electron's native theme; `AppearanceSync` controls colour-vision and font settings, and `theme.ts` adapts tokens for terminal/content rendering. Reuse these mechanisms rather than introducing a theme provider.

If no existing component or reasonable composition fits, document the closest candidates and why neither reuse nor extension preserves their contracts. A new shared control requires its own design-system change, tests, CSS, gallery sample, export and catalogue section before feature adoption, as specified in `AGENTS.md`.

## Tokens

Set on `:root`. There's one theme, with a light override (`prefers-color-scheme`, which the Theme setting drives) and colour-vision overrides (`data-color-vision`, from Settings → Appearance → Accessible colors). Low-contrast dark and the code themes were removed. `tests/contrast.test.ts` reads this file and fails if a pair below drops under its ratio in either theme or any colour-vision mode.

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg`, `--bg-sidebar`, `--bg-panel`, `--bg-raised`, `--bg-hover`, `--bg-selected`, `--bg-input`, `--user-bg`, `--toast-bg`, `--approval-bg` |
| Lines | `--border`, `--border-strong`, `--focus-border`; `--border-control` for the edge that shows where a control is (3:1 on every surface) |
| Text | `--text`, `--text-soft`, `--text-muted`; `--text-faint` is an alias of `--text-muted` (show hierarchy with size and weight). Each is 4.5:1 on all six surfaces (`--bg` … `--bg-selected`) |
| Accent | `--accent`, `--accent-bg`: a coral for **brand only**: the Foreman logo and brand icons, the Automations bolt, the Assistant sparkle, agent icons, the DEFAULT `Tag` and slot label, and the tour spotlight. Nothing else. It sits within about 10 delta-E (5 degrees of hue) of `--red`, so anything coral reads as an error: never a state (selected, focus, current), a link, a path, a search match, a panel edge or stripe, a chart or meter, a status, a mode that is on, a syntax colour, or any other label ("can push", "customized", a count, a receipt: those are neutral `Tag`s). `tests/ui/coralBrandOnly.test.ts` lists every remaining use with its reason and fails on a new one |
| Links | An `<a href>` (Markdown, a report's link, help text) is `--blue` and underlined (a soft underline, firm on hover), visited or not: `a[href]` in `styles/base.css`. A button that acts like a link inside a sentence is a `LinkButton underline`, which draws the same. The underline means colour is never the only cue, and `--blue` is 4.5:1 as text on every surface. A path or file name is not a link: it looks like code (the inline-code look, neutral and monospace) |
| Selected | `--selected-bg` (= `--bg-selected`), `--selected-border` (= `--text-soft`), `--selected-mark` (= `--text`) with `--on-selected-mark` (= `--on-primary`), `--selected-tint` (`--text` at 8%, see-through). Neutral and warm, so they follow the palette in light, dark and the colour-vision modes. Use them for every selected, chosen, current, checked or drop-target state. A selected edge and a mark are 3:1 on every surface (and on `--selected-bg`), a check is 3:1 on its fill, and text is 4.5:1 on `--selected-bg`; on the tint `--text` and `--text-soft` are 4.5:1 over every surface and `--text-muted` over `--bg`, `--bg-sidebar` and `--bg-panel` (muted text only just passes bare on the other surfaces, so keep a wash off them) |
| Status | `--green`, `--red`, `--amber`, `--blue` (4.5:1 as text on every surface) |
| Tints | `--accent-bg`, `--add-bg`, `--del-bg`, `--amber-bg`, `--blue-bg`, `--approval-bg` (neutral: `--text` at 3 to 4%) are `color-mix(in srgb, var(--colour) N%, transparent)` at the theme's opacity, so they follow the colour (and the colour-vision overrides). A tag's text stays 4.5:1 on its own tint over any surface |
| Actions | `--primary` (the text colour), `--on-primary`, `--primary-hover`, `--danger`, `--danger-hover`, `--on-danger` (4.5:1 on each fill and hover) |
| Focus and layers | `--focus-ring` (= `--blue`: 3:1 on every surface, in both themes and every colour-vision mode, so focus is never mistaken for selection or error), `--shadow`, `--backdrop`, `--backdrop-soft` |
| Media | `--media-scrim` and `--on-media` (text and buttons over a picture), `--qr-bg` (the white behind the pairing QR code, which scanners need) |
| Type | `--font`, `--mono`; chrome sizes `--text-xs` 11 (short metadata only), `--text-sm` 12, `--text-md` 13, `--text-lg` 15, `--text-xl` 20; content and display sizes named by use: `--text-display-subheading` 16, `--text-display-emoji-cell` 17, `--text-display-title` 18, `--text-display-heading` 22, `--text-display-phone-code` 26, `--text-display-emoji` 32, `--text-display-pair-code` 38; content sizes `--text-content` (13 by default), `--text-content-code` (one smaller) and `--text-content-heading` (two larger), which read `--content-font-size` from `<html>` so Settings → Accessibility → Content text size scales chat Markdown, diff code and the file viewer (`styles/content-size.css`) while chrome keeps the scale above |
| Radius and targets | `--radius-sm` 4 (tags), `--radius-md` 7, `--radius-lg` 10, `--radius-full`; `--target-min` 24px, the smallest pointer target for a control |
| Code and terminal | `--code-*` (every syntax colour is 4.5:1 on `--code-bg`; keywords purple, types and builtins teal, literals with numbers in amber, titles and tags blue, strings green: none in the coral or red hue), `--term-*` |
| Previews (G3 · #19) | `--preview-canvas`: a previewed web page's canvas, white in every theme as a browser draws it (`.preview-frame.page`) |

`ui/tokens.css` also holds the two global accessibility blocks: under `forced-colors: active` a selected or checked item (`[aria-checked=true]`, `[aria-selected=true]`, `[aria-current]`, `.selected`, `.active`) gets a `Highlight` outline, and under `html[data-reduce-motion="on"]` animations and transitions end at once (the flash, below, shows a static tint instead). That attribute is the resolved Reduce Motion setting (Settings → Accessibility: Automatic follows `prefers-reduced-motion`, On and Off decide). `theme.ts` sets it and exposes `reduceMotion()` and `useReduceMotion()` for code; `ui/flash.ts` reads the attribute. Key new motion rules on the attribute, never on the media query.

## Components (`src/renderer/src/ui/`)

Every control in the renderer comes from here; feature code composes these and owns only layout. `tests/designSystem.test.ts` fails on hand-built controls, raw colours and raw sizes outside `ui/`, and on feature CSS that sets appearance (colour, background, border, radius, shadow, font, outline, text decoration) on ui/ markup: an element with a `ui-` class, or with any class feature code hands to a ui/ component (`className`, `triggerClassName`, `panelClassName`, `primaryProps={{ className }}`). A feature's own class on a component is for layout; to colour text inside a component, wrap the text in your own element. A new component goes here first, with its doc section, before any feature uses it.

Conventions: one component per file, `ui/<Name>.tsx`, exported from `ui/index.ts`; its styles in `ui/css/<name>.css` (imported from `ui/ui.css`, which loads after all feature CSS). Every component spreads native props onto its main element, takes a `ref`, and accepts a `className` for layout only; colour, border, radius, font and focus are the component's. Visible text and accessible names come in as props (components never call `useT`); required names are required props, and inputs without a name throw in development. Keyboard logic shared by composite widgets lives in `ui/keys.ts`. Class names are `ui-<block>`, `ui-<block>--<variant>`, `ui-<block>__<part>`, with state in ARIA or `data-*` attributes. Focus ring: 2px `--focus-ring` (blue) with a 2px `--bg` band (inset on rows, menu items, list options and thumbnails, which clip). Minimum target: `--target-min` (24px).

### Class contract

Markup other components may rely on by class name:

| Component | Markup | Variants |
| --- | --- | --- |
| Button | `button.ui-btn` | `.ui-btn--primary`, `--danger`, `--ghost`, `--sm` |
| Icon button | `button.ui-icon-btn` | `--primary`, `--framed`, `--dashed`, `--badge`, `--danger`; highlighted while `[aria-pressed=true]` or `[aria-expanded=true]` |
| Link button | `button.ui-link-btn` | `--danger`, `--sm`, `--underline` (blue), `--mono` |
| Chip button | `button.ui-chip-btn` | `--warn`, `--pill`; `[aria-pressed=true]`, `[aria-expanded=true]` |
| Card | `div.ui-card` (a `CardButton` is `button.ui-pressable.ui-card`; an `ActionRow card` is `div.ui-action-row.ui-card`) | `--interactive`, `--sm`; `[data-selected\|target\|empty\|lifted\|ghost]`, `[data-tone=danger]`, `[data-drop=before\|after]`, `[data-stripe=neutral\|ok\|warn\|info\|muted]` |
| Glyph | `svg.ui-glyph[data-glyph=ok\|warn\|error\|info\|off]` | |
| Segmented | `div.ui-segmented[role=radiogroup]` > `button.ui-segmented__option[role=radio]` | `--plain`, `--small`; `[aria-checked=true]` |
| Tabs | `div.ui-tabs` > `div.ui-tablist[role=tablist]` > `span.ui-tab` > `button.ui-tab__button[role=tab]` + `span.ui-tab__actions`; `div.ui-tabpanel[role=tabpanel]` | `.ui-tabs--underline`, `--pill`, `--chat`; `[aria-selected=true]`, `.ui-tab[data-selected]` |
| Menu | `span.ui-menu-wrap` > trigger + `div.ui-menu[role=menu]` > `button.ui-menu__item`, `div.ui-menu__sep`, `div.ui-menu__heading`, `div.ui-menu__row` | `.ui-menu--bottom-end\|bottom-start\|top-end\|top-start`, `--fixed`, `--context`; item `[data-variant=danger\|value]`, `[data-indent]` |
| Split button | `span.ui-split` > `button.ui-btn` + `span.ui-menu-wrap.ui-split__menu` > `button.ui-btn` | `[data-variant=primary\|ghost]` |
| Disclosure | `div.ui-disclosure` > `button.ui-disclosure__button` + `div.ui-disclosure__panel` | `.ui-disclosure__button--quiet`; `[aria-expanded=true]` |

### Button

Replaces `.btn` (and `.btn.small`, `.primary`, `.danger`, `.ghost`).

- Props: `variant` (`default` / `primary` / `danger` / `ghost`), `size` (`md` / `sm`), `icon` (a leading icon, hidden from assistive tech), plus native button props except `type` and `role`.
- Always `type="button"`; 24px minimum height; control border (`--border-control`); focus ring with a `--bg` band so it shows on any fill.
- An icon-only action is an `IconButton`, not a `Button` without text.

```tsx
<Button variant="primary" onClick={save}>{t('common.save')}</Button>
```

### IconButton

Replaces `.icon-btn` (and its `.active`).

- Props: `label` (required: the accessible name and the tooltip; `aria-label` and `title` can't be set separately), `children` (the icon, hidden from assistive tech), `pressed` (a toggle: sets `aria-pressed` and the highlighted look), `variant` (`default`; `primary`: a 28px round filled button for a bar's one action, the composer's send and stop; `framed`: a bordered square that shows the current value and opens its picker, the repository icon; `dashed`: a dashed placeholder tile that adds something, the rail's "add a repository", solid while its menu is open; `badge`: a small round button with its own edge and a cut-out ring, for a control that sits over the corner of another surface, the loadout card's remove ×), `tone` (`default`, or `danger`: red on hover and keyboard focus, for delete), plus native button props except `type`, `role`, `aria-pressed`, `title`.
- 24×24 minimum. A menu trigger passes `aria-haspopup` and `aria-expanded` straight through; the button is highlighted while `aria-expanded` is true.

```tsx
<IconButton label={t('terminal.find.next')} onClick={next}><ArrowDown size={14} /></IconButton>
```

### LinkButton

Replaces `.link-btn` (and its `.danger`).

- Props: `danger`, `size` (`inherit` follows the surrounding text, `sm` is 12px), `underline` (an inline link inside a sentence: blue, as every link is, with an underline that is always drawn, firming up on hover, and no 24px minimum height since it sits in running text), `mono` (the code font, for a path or a pattern), plus native button props except `type`, `role`.
- A button that looks like a link, for actions ("Refresh", "Show more", an action inside a sentence). Navigation to a URL is an `<a href>`.
- Text goes underlined on hover; 24px minimum height.

```tsx
<LinkButton onClick={refresh}>{t('cloud.refresh')}</LinkButton>
```

### ChipButton

Replaces `.chip` (and `.active`, `.accent`, `.plan-on`), the phone pill and the cloud pill.

- Props: `tone` (`neutral` / `warn` amber text on an amber tint: waiting on the user; there is no coral tone, and a mode that is on is `pressed`, the neutral hover fill), `pressed` (a toggle: `aria-pressed`), `haspopup` (`menu` / `listbox` / `dialog` / `true`) with `expanded` (`aria-haspopup` and `aria-expanded`, false until `expanded`), `pill` (fully rounded), plus native button props except `type`, `role` and `aria-pressed`. A Popover's trigger props spread straight onto it: native `aria-haspopup` and `aria-expanded` are kept, and `haspopup` / `expanded` win when both are given.
- The highlighted look follows `aria-pressed=true` and `aria-expanded=true`; there is no look-only `active` prop. A chip that is a Plan mode toggle sets `pressed`; one that opens a picker sets `haspopup` and `expanded`.
- A `Status` can sit inside a chip (the phone pill: `<ChipButton pill haspopup="dialog"><Status tone="warn" label=… /></ChipButton>`).

```tsx
<ChipButton pressed={planMode} onClick={togglePlan}>{t('composer.plan')}</ChipButton>
```

### Pressable

For a surface with a single action: a card, a list entry, a row's main area.

- Props: native button props except `type`, `role`. Renders `<button type="button">` with no background, border or padding, the surrounding font and colour, left-aligned text, and the focus ring. No look props; layout comes from `className` and the content.
- Its content must not be interactive: in development it throws if it finds a link, button, input, `tabindex`, or widget role inside (`findInteractiveDescendant` is exported for tests). For a surface with extra actions use `ActionRow`.

```tsx
<Pressable className="board-card" onClick={open}>{title}</Pressable>
```

### ActionRow

Replaces the clickable-`div` rows: sidebar workspace rows, Home rows, board cards, composer queue rows.

- Props: `card` (the row is a card: the interactive `Card` outline, radius and selected fill; see Card), `onPress` (makes the main area a `Pressable` that stretches over the whole row), `primaryProps` (name, description, ref, or layout `className` for that button), `selected` (`--selected-bg` surface fill, `aria-current="true"` on the primary button), `pending` (a `--selected-border` outline for a choice waiting for confirmation, apart from `selected`; no `aria-current`), `disabled` (dims the main area and turns the primary button off; actions are the caller's to disable), `actions` (buttons beside the main area), `revealActions` (actions visible only while the row is hovered or has focus inside), `editor` (an inline editor that replaces the main area), `divided` (a hairline between consecutive divided rows, which must be siblings), plus native div props (`role`, `data-*`).
- A non-interactive container. The primary button, the actions and the editor are siblings, never nested, so each is its own tab stop and a screen reader names each one. Without `onPress` it is a plain row.
- `ui/` owns the hover, selected, pending, editing (a row with an `editor`), disabled and focus surfaces. The focus ring sits inside the row (an inset outline), so a card that hides overflow doesn't clip it; in forced colours a selected row gets a `Highlight` outline.
- A queue is a labelled list: `<ul aria-label=…><li><ActionRow …/></li></ul>`.

```tsx
<ActionRow onPress={open} selected={isOpen} actions={<IconButton label={t('ws.archive')} onClick={archive}><Archive size={13} /></IconButton>}>{title}</ActionRow>
```

### Card and CardButton

Replace the hand-drawn card frames: the loadout's slot and model cards, the Home add-repository cards, the Assistant starters, the Quit sheet's choice, question and reconcile options, the setup-step cards, the calendar blocks, the repository rail's tiles, and the frames around catalog, provider and setup lists. Nothing existing fits: `Pressable` has no look on purpose, and `ActionRow` is a list row (a flat surface that fills on hover) with no edge, so every feature drew its own border, hover, selected and drag look, most with the quiet `--border` (about 1.2:1) on things the user picks up.

- `Card` is a `div` (or `as` a `section`, `article`, `li`). Without `interactive` it is a quiet frame: `--border`, `--bg-panel`, for content that isn't a control. With `interactive` (draggable, selectable, clickable) the edge is `--border-control`, which meets 3:1 against every surface (WCAG 1.4.11), and it fills with `--bg-hover` on hover. The content may hold controls.
- `CardButton` is the card with one action: a `Pressable` wearing the interactive look (focus ring, `type="button"`, and the development check that nothing interactive is inside). Use `ActionRow card` for a card that also has actions of its own beside the main button (a board card, a sidebar entry): the row keeps its hover, focus and `selected`, and takes the card's outline, radius and selected fill.
- Look props, on both (state is `data-*`; add the matching ARIA yourself, because "selected" means different things: `aria-pressed` for a toggle, `aria-expanded` for a picker's trigger, `aria-current` for a page):
  - `selected`: the neutral selected edge (`--selected-border`) and fill (`--selected-bg`), never the accent (chosen, or open).
  - `target`: something being dragged would land here: the selected edge and a 1px ring. On an `empty` card the edge is the selected edge and the fill is `--selected-bg`, so a dashed slot turns solid as it takes the drop.
  - `empty`: a placeholder slot: dashed `--border-control`, no fill.
  - `lifted`: the original while its copy is dragged: dashed, no fill, content at 35%.
  - `ghost`: the copy that follows the pointer: raised fill, shadow, tilted, `pointer-events: none`. Position (fixed) and size it with CSS or `style`.
  - `tone="danger"`: the edge goes red (dropping here removes the item).
  - `drop` (`before` / `after`): a `--selected-mark` line on that edge, for reordering.
  - `stripe` (`neutral` (a plain edge: an automation with no run yet) / `ok` / `warn` / `info` / `muted`): a 3px leading edge in a status colour (steps that run in parallel, a calendar block's state). State is also said in words (a title, a label).
  - `size` (`md` 10px corner, `sm` 7px).
- Motion: transitions only, which Reduce Motion ends. A feature's own entrance animation (the loadout's equip pop) stays in its CSS and is ended the same way by `ui/tokens.css`. Under forced colours `selected` and `target` get a `Highlight` outline.
- Layout (grid, padding, size, position) is the caller's; the element qualifier trick (`button.card-class`, a doubled class) is still needed against `.ui-pressable`'s `display` and `padding`, which load after feature CSS.

```tsx
<CardButton size="sm" lifted={dragging} target={landing} className="ml-model" {...dragHandlers}>{name}</CardButton>
<Card empty target={landing} className="ml-empty">{t('loadout.empty')}</Card>
<ActionRow card selected={open} onPress={toggle}>{title}</ActionRow>
```

### Tag

Replaces `.tag`, `.pill`, `.ag-badge`, `.set-details-tag`, `.int-problem-tag`, `.tag.cloud-ok`, `.tag.cloud-warn`.

- Props: `tone` (`neutral` / `accent` (brand only: the DEFAULT label) / `outline` / `ok` / `warn` / `error` / `info`), `mono` (the code font at the tag's size: an environment variable, an id), plus native span props.
- 4px corner, 11px text. The four status tones draw a glyph (the same shapes as `Status`) and tint the background; text and glyph share the tone's colour. Put the state in the words ("Signed in", "Token expired").
- `outline` is for rows that already sit on a raised surface. Not interactive: a clickable label is a `ChipButton`.

```tsx
<Tag tone="error">{t('agents.notSignedIn')}</Tag>
```

### Status

Replaces the colour-only dots (`.dot`, `.set-dot`, `.blane-dot`, `.phone-dot`) and `.ws-cloud`.

- Props: `tone` (`ok` / `warn` / `error` / `info` / `off`), `label` (required: the state in words), `compact` (glyph only; the word stays in the DOM as screen-reader text), `children` (extra visible content after the word, such as a count).
- Where space is tight, use `compact` and show the same word in a tooltip that opens on the parent's hover **and** focus.

```tsx
<Status tone="ok" label={t('integrations.connected')} />
```

### Glyph

The status shapes: ● `ok`, ▲ `warn`, ◆ `error`, ■ `info`, ○ `off`.

- Props: `name`, plus native svg props except `role`, `focusable`, `children`. Always `aria-hidden`; 12px; coloured by its state (green, amber, red, blue, faint) unless a `Tag` or `Callout` sets `currentColor`.
- Other batches may inline the same paths with `class="ui-glyph"` and `data-glyph`; the shapes are in `ui/Glyph.tsx`.

```tsx
<Glyph name="warn" />
```

### Spinner

Replaces `.spin` on icons.

- Props: `size` (px, default 14), `label` (say what is loading), plus native span props.
- Without `label` it is decorative (`aria-hidden`), for use beside text that says what's happening. With `label` it is a `role="status"` with that text for screen readers; use it when the spinner is the only sign of progress.
- Under Reduce Motion it is a still ring.

```tsx
<Spinner label={t('addRepo.clone.cloning')} />
```

### Meter

Replaces `.cloud-bar`.

- Props: `value`, `min` (0), `max` (100), `label` (required name), `valueText` (the value in words, read instead of the number), `tone` (`ok` green / `warn` amber / `error` red, picked by the caller).
- `role="meter"`; `value` is clamped to the range; throws if `max <= min`. 4px bar on `--bg-raised`; the fill is 3:1 or better against it. In forced colours the track is outlined and the fill is `Highlight`.
- For task progress use a `Spinner` or text; a meter is an amount within a known range.

```tsx
<Meter label={t('cloud.usage')} value={used} max={limit} valueText={t('cloud.usage.text', { used, limit })} tone={used / limit > 0.9 ? 'error' : 'ok'} />
```

### Callout

Replaces `.notice`, `.cloud-callout`, `.recovery-card`'s cause, `.history-banner`, `.set-banner` and the other banners.

- Props: `tone` (`neutral` / `info` / `ok` / `warn` / `error`), `role` (`note` default, `status`, `alert`), `banner` (a full-width bar with a hairline below, no corners), `title`, `actions` (below the text in a box; at the end of the line in a banner), plus native div props.
- Coloured tones show a glyph and tint. The glyph is hidden from screen readers, so the text must say what is wrong. Use `role="status"` for something that appears while the user works, `alert` for an error that blocks.

```tsx
<Callout tone="warn" actions={<Button size="sm" onClick={wake}>{t('cloud.wake')}</Button>}>{t('cloud.asleep')}</Callout>
```

### Kbd

Replaces `.kbd`. A `<kbd>`: monospace 11px, muted. Props: native kbd props. Inside a filled button (`primary`, `danger`) it takes the button's text colour, so the shortcut reads on the fill.

```tsx
<Kbd>Esc</Kbd>
```

### MediaThumb

Replaces `.nw-thumb`.

- Props: `src` (the picture; or pass `children`, an icon), `name` (shown over the bottom edge), `onRemove` with `removeLabel` (required with `onRemove`: "Remove screenshot-login.png"), plus native div props.
- 96×68, 7px corners; the name and button use `--media-scrim` and `--on-media`. The remove button is 24px, shown on hover and whenever focus is inside the thumbnail. The picture is decorative (`alt=""`): the name is the text.

```tsx
<MediaThumb src={url} name={file.name} onRemove={remove} removeLabel={t('nw.attach.remove', { name: file.name })} />
```

### Forms: Field, useField, TextInput, TextArea, Range, FileInput, Checkbox, Select, MaskedValue, Switch, RadioList, RadioCards

**Naming rule.** Every input-like control needs an accessible name: use `Field`, a `<label htmlFor>`, `aria-labelledby` or `aria-label`. In development a control without one throws `X has no accessible name` after it mounts (it costs nothing in a production build).

**Layout.** `className` is for layout only. Default widths sit in `:where()` rules, so a feature's own one-class `width` or `margin` rule wins whatever the load order. A one-line `TextInput`, a `Select` and a medium `Button` are all 32px tall, so they sit level in a row; a small `Button` beside them gets `min-height: 32px` from the row's layout CSS (settings does this in `.set-control`).

| Component | Replaces | Props and behaviour |
| --- | --- | --- |
| `Field` | hand-wired `<label>` + help + error | `label`, `hideLabel`, `description`, `error`, `className`; `children` is a render function `(control) => node`. `control` is `{ id, 'aria-describedby'?, 'aria-invalid'? }`: spread it on the control. An `error` makes the control `aria-invalid`, is announced (`role="alert"`) and starts with the error glyph. `aria-describedby` only lists help and error elements that are rendered. |
| `useField` | the same, when a row lays out its own label and help (settings `Row`) | `useField({ id?, description?, error? })` returns `{ id, invalid, labelProps, controlProps, descriptionProps, errorProps }`: spread `labelProps` on the `<label>`, `controlProps` on the control, `descriptionProps` and `errorProps` on the elements you render. |
| `TextInput` | `<input>` and `.set-input` | `type` (`text` default, `number`, `date`, `time`, `search`, `password`), `mono` (the code font; it follows the Appearance ligatures setting), `compact` (a smaller box and 12px text, for a rename field in a tab or a row), `width` (number = px), plus every native input prop. Invalid state comes from `aria-invalid` (set by `Field`). |
| `TextArea` | `<textarea>`, `.set-textarea` | `mono`, `bare`, `rows` (default 3), every native textarea prop. Resizes vertically only. `bare` strips its border, background, padding and focus ring, for a textarea inside a box that draws them (the composer): that box has to show focus. |
| `Range` | `<input type="range">` (×2) | `valueText` (what a screen reader says, "14px"), plus native props (`min`, `max`, `step`, `value`, `onChange`). Arrow, Home, End and Page keys are the browser's. |
| `FileInput` | `<input type="file" hidden>` + a button | `chooseLabel` and `noneLabel` (required text), `showNames` (default true), native props (`accept`, `multiple`, `onChange`). The real input is invisible over the whole control, so click, Space, Enter and the file dialog are native and a ref reaches the input. Names are read before `onChange` runs, so a handler that clears the input still shows what was chosen. |
| `Checkbox` | `<input type="checkbox">` + `label.check` | `children` (the label), `indeterminate`, native props. `className` goes on the label row; `ref` on the input. With no children, give it `aria-label`. |
| `Select` | settings `Select` | Same props as before: `value`, `options` (`{ value, label, group?, disabled? }`), `onChange(value)`, `label` (accessible name when no `Field` gives one), `width`, `disabled`; now also `ref` and native select props. Native, so the browser draws the list. |
| `MaskedValue` | settings `MaskedValue` | `label` (the secret's name, names the group), `labels` (`copy`, `reveal`, `hide`, `edit`, `remove`: whole translated strings that already contain the name), `hint`, `reveal()`, `onEdit`, `onRemove`, `onCopy(ok)` (the feature shows its own toast). Behaviour unchanged: the value is fetched only on reveal or copy; clicking the value copies; remove is disabled while it runs. |
| `Switch` | settings `Switch` | `checked`, `onChange(checked)`, `label`, plus native button props (`id`, `title`, `disabled`, `aria-labelledby`). `role="switch"`, `type="button"` and `aria-checked` are the component's. The button is the 24px target; the 30x18 track is drawn inside it. On is a `--selected-mark` track with the knob moved right (`--on-selected-mark`). Takes a caller `onClick`; `preventDefault()` there vetoes the toggle. |
| `RadioList` | `.set-radio-list`, `.int-radio-list`, `.int-radio` | `legend`, `hideLegend`, `value` (undefined = none chosen), `options` (`{ value, label, description?, disabled?, reason?, extra? }`), `onChange(value)`, `inline`, `name` (generated if omitted). A `fieldset` with a `legend` around native radios: one Tab stop, arrow keys choose and skip disabled options, all by the browser. `reason` is visible and is the option's `aria-describedby`. `extra` renders under the option, outside its label (the "Custom prefix" field). |
| `RadioCards` | `.ag-auth-card`, `.nw-tree`, `.phone-modes`, `.cloud-option`, `.cloud-provider` | `legend`, `hideLegend`, `value`, `options` (`{ value, label, description?, icon?, disabled?, reason?, invalid?, actions? }`), `onChange(value)`, `layout` (`grid` default, `stack`), `columns` (default 2), `name`. Native radios in a `fieldset`; the chosen card has the neutral selected edge (doubled by a 1px ring), fill and a `--selected-mark` check (state is never colour alone: the check shows too); the whole card is clickable. `actions` render under the text as siblings of the label, so a card can hold buttons. A disabled card shows `reason` on its face. `invalid` turns the chosen card's border and ring red: say what is wrong in `description` too. The grid collapses to one column below 560px of its own width. |

```tsx
<Field label="Branch" description="Letters and dashes." error={taken ? 'Already exists' : undefined}>
  {(c) => <TextInput {...c} value={name} onChange={(e) => setName(e.target.value)} />}
</Field>
<RadioCards legend="Sign-in method" value={auth} onChange={setAuth} options={[{ value: 'token', label: 'Setup token', description, actions: <LinkButton …/> }]} />
```

**Notes for the feature migrations**

- `Row` keeps its own label markup: it calls `useField({ description: Boolean(help) })` and, when its children are a function, passes it `controlProps` (`<Row label help>{(control) => <Select {...control} … />}</Row>`), so the label names the control and the help (and detail line) describe it. Plain children and `htmlFor` still work for rows not migrated yet. `ToggleRow`, `TextRow` and `TextAreaRow` are built this way.
- `TextRow` and `TextAreaRow` keep `useDraft`; they render `TextInput` / `TextArea` instead of `<input className="set-input">`. The Enter-to-blur handler stays in `TextRow`.
- Native radios arrow-navigate on their own; `ui/keys.ts` is not used by `RadioList` or `RadioCards`.
- `Checkbox` indeterminate is set from a prop in an effect, because there is no HTML attribute for it.
- `Checkbox`, `RadioList` and `Range` draw the native control with `accent-color: var(--selected-mark)`, so a checked box and a radio dot are neutral ink with the browser's own contrasting tick. A focused `TextInput` / `Select` / `TextArea` edge is `--focus-ring`.
- Selected state in a card or switch is `data-selected` / `aria-checked`; under forced colours the chosen card gets a `Highlight` outline and the switch is drawn with system colours.

### Segmented

Replaces `Segmented` in `settings/controls.tsx` (`.segmented`, `.segmented.small`, `.set-seg`) and the hand-written Rich / Source toggle.

- Props: `value` (`undefined` when nothing is picked), `options` (`{ value, label, title?, disabled? }`), `onChange`, `label` (the group's accessible name, required), `plain`, `small`.
- `role="radiogroup"` of `role="radio"` buttons with one Tab stop: the picked option, or the first enabled one when the picked option is disabled (the old control left the only Tab stop on a disabled option). Arrows (all four), Home and End pick and focus, step over disabled options and wrap. Say why an option is disabled in its `title`.
- Options are at least 24px tall. The picked option differs by weight and surface (neutral: no accent), and keeps an outline marker under forced colours.

```tsx
<Segmented plain small value={mode} onChange={setMode} label={t('field.mode')} options={[{ value: 'rich', label: t('mode.rich') }, { value: 'source', label: t('mode.source') }]} />
```

### Tabs, TabList, Tab, TabPanel

Replaces `Tabs` in `settings/controls.tsx` (`.set-tabs`), the sidebar filters (`.sidebar-filters`) and the chat tabs (`.chat-tab`).

- `Tabs`: `value`, `onChange`, `variant` (`underline` default: a `--selected-mark` underline under the selected tab, in `--text` at weight 500; `pill`, `chat`). Controlled only. It provides the ids; use the parts inside it (they throw outside `Tabs`).
- `TabList`: `label` (required). One Tab stop (the selected tab, or the first enabled one), ← → Home End move and select, wrapping, over disabled tabs. Other focusable children (a "new chat" button) keep their own Tab stops and keys.
- `Tab`: `value`, `disabled`, native button props (`title`, `onDoubleClick`, `onContextMenu`, `onMouseEnter`). `onChange` fires only when the selection changes.
  - `actions`: controls beside the tab, rendered as **siblings** of the tab button (the chat tab's close button), never inside it. Keys pressed on them are not tab navigation.
  - `editor`: a rename field. While set it takes the tab's place; the tab button stays in the DOM, hidden, so its panel keeps its name, and arrow keys skip it.
- `TabPanel`: `value`, `keepMounted`. `role="tabpanel"` with `aria-labelledby` its tab; a tab gets `aria-controls` only when its panel exists. Panels for other tabs stay in the DOM, hidden and empty, unless `keepMounted`.
- The chat variant is closable browser-style tabs on the same behaviour; `actions` appear on hover, on the selected tab and whenever focus is inside it. Tab titles that need an ellipsis put it on their own span.

```tsx
<Tabs value={tab} onChange={setTab}>
  <TabList label={t('repo.tabs')}><Tab value="general">{t('repo.general')}</Tab><Tab value="scripts">{t('repo.scripts')}</Tab></TabList>
  <TabPanel value="general">…</TabPanel><TabPanel value="scripts">…</TabPanel>
</Tabs>
```

### Menu, MenuButton, MenuItem, MenuCheckboxItem, MenuRadioItem, MenuSeparator, MenuLabel, MenuGroup, MenuControlRow

Replaces every `.menu` (RowActions, AddRepository, DiffSourceMenu, OpenIn, user and answer menus, the terminal menu).

- `Menu` is the popup surface: `label` (required), `onClose(reason)`, `initialFocus` (`first` / `last` / `none`), `ignore` (a ref whose clicks don't count as outside), `closeOnViewportChange` (for fixed menus). It owns the keys; place it with CSS, or use `MenuButton` or `ContextMenu`.
- `MenuButton`: `label` (the menu's name; for an icon-only trigger also its name and tooltip), `trigger` (its content), `children` (the items), `look` (`button` / `ghost` / `primary` / `icon` / `dashed` (an icon trigger drawn as IconButton's dashed tile) / `chip`, the 2a classes), `small`, `pill` (fully rounded, with `look="chip"`: the cloud pill), `iconOnly`, `placement` (`bottom-end` default, `bottom-start`, `top-end`, `top-start`, and `right-start` when `portal`), `portal` (draw in `<body>`, fixed and kept on screen, for triggers in clipped or scrolling containers), `open` + `onOpenChange` (for items that load on open). `ref` goes to the trigger.
- Items are `role="menuitem"`, `menuitemcheckbox` (`checked`, `onCheckedChange`) or `menuitemradio` (`checked`, `onSelect`). Common props: `icon`, `hint` (shortcut), `description` (second line), `indent`, `disabled`, `title`, `closeOnSelect`. `MenuItem` also takes `onSelect` and `variant` (`danger`, `value`). A checked item shows a `--selected-mark` check. `MenuLabel` is a heading, `MenuGroup` (`label`) names a set of items, `MenuSeparator` divides.
- Keys: ↑ ↓ move (wrapping, over disabled items), Home End, typeahead by label. ← → do nothing (there are no submenus). On the trigger, ↓ opens with the first item focused and ↑ with the last.
- **Dismissal:** Escape and activating an item close the menu and return focus to the trigger (for an item, then run its action, so a dialog it opens returns focus to the trigger). Tab closes it **without** moving focus back: focus goes on to the next control after the trigger (Shift+Tab to the one before). A click elsewhere closes it and leaves focus where the click put it. Escape does not reach a dialog around the menu.
- `closeOnSelect={false}` keeps the menu open after one item (default: close).
- `MenuControlRow` (`label`, `icon`; children are `MenuItem`s, which stay open by default): one stop for ↑ ↓, ← → move between its buttons without wrapping, ↑ ↓ leave it. Typeahead matches its label. This is the terminal zoom row: a `−` item, a `variant="value"` item (the percentage, resets), a `+` item, each with an `aria-label`.
- Menu items can't be keyboard-focused while `disabled` (they are native disabled buttons); put the reason in the item's `title` and, where it matters, in a neighbouring description.

```tsx
<MenuButton label={t('row.actions')} look="icon" trigger={<MoreHorizontal size={14} />}>
  <MenuItem onSelect={onReset}>{t('common.reset')}</MenuItem>
</MenuButton>
```

### ContextMenu

Replaces `TerminalMenu`'s own portal, positioning and dismissal, and the `.context-menu` class.

- Props: `x`, `y` (pointer, client coordinates), `label` (required), `onClose()`, `className` (layout, a minimum width). Render it while open; it takes the same items as `Menu`.
- Drawn in `<body>` with `position: fixed`, kept on screen, closed by Escape, activation, Tab, a click elsewhere, window blur and resize. Focus returns on Escape and activation to the element that had it when the menu opened; Tab lets focus move on from there. The browser's own menu is suppressed inside it.

```tsx
{menu && <ContextMenu x={menu.x} y={menu.y} label={t('terminal.menuLabel')} onClose={() => setMenu(null)}>…</ContextMenu>}
```

### SplitButton

Replaces `.split-btn` (four places).

- Props: `label` (the primary action's content), `menuLabel` (names the arrow button and the menu; required), `children` (the menu items), `variant` (`default` / `primary` / `ghost`), `size` (`md` / `sm`), `placement`, `portal`, `menuDisabled` (the arrow; unset it follows the primary's `disabled`, set it wins either way, so `menuDisabled={false}` keeps the menu usable while the primary action is off), `menuOpen` + `onMenuOpenChange` (control the menu, so code can open it, e.g. the primary action when there is no default to run); other props (`onClick`, `disabled`, `title`) go to the primary button, and `ref` too.
- Two real buttons, each a Tab stop with its own name and target; the arrow is a `MenuButton`, so it follows the menu's keyboard and dismissal rules (focus returns to the arrow). Both halves wear the Button look and share one outline.

```tsx
<SplitButton label={t('openIn.open')} menuLabel={t('openIn.more')} onClick={openDefault}><MenuItem onSelect={openEditor}>{t('openIn.editor')}</MenuItem></SplitButton>
```

### Disclosure

Replaces `.repo-prompt-toggle`, `.env-doc-toggle` and `<details>` used as a control.

- Props: `label` (the button's content), `children` (the panel), `open` + `onOpenChange` (controlled) or `defaultOpen`, `quiet` (lighter, link-like), native div props. `className` goes to the wrapper.
- `aria-expanded` and `aria-controls` on the button; the panel stays mounted while closed, hidden, so its state survives and `aria-controls` always points at it. The chevron turns, but not under Reduce Motion. 24px minimum height.

```tsx
<Disclosure label={t('repo.setupPrompt')}><textarea … /></Disclosure>
```

### Dialog and Sheet

Replace `Modal` + `useDialogFocus` (`components/Dialogs.tsx`), `AgentDialog`, the repo `Dialog`, the environment `Sheet` and the Tour card's frame. Render one while it is open; it portals to `<body>`.

| Prop | Notes |
| --- | --- |
| `title` (required) | The dialog's accessible name and visible heading. Empty or blank throws. `hideTitle` keeps it for assistive tech only. |
| `onClose` | Called by Escape, the backdrop and the close button. |
| `closeLabel` | Adds a close button (`ui-icon-btn`) with this name. |
| `description`, `footer`, `headerExtra` | Slots; `description` is `aria-describedby`. Dialog also has `toolbar` (does not scroll) and `size` (`md` 520, `lg` 640, `xl` 820). |
| `closeOnBackdrop` | Mousedown on the backdrop closes (default true). |
| `container` (Sheet) | Portals into this element and fills it, e.g. the settings view. Add the inset (`var(--titlebar)`) with `layerClassName`. |
| `preview` | Gallery and screenshots only: drawn in place, not modal. |
| `className`, `layerClassName` | Layout for the panel and the backdrop. |

Behaviour:

- Focus moves into the dialog when it opens (an `autoFocus` inside wins), Tab and Shift+Tab stay inside, and focus returns to the opener on close, or to the opener of the dialog it was opened from if that one is gone too (same as `useDialogFocus`).
- The trap knows portals the dialog owns. A menu or hover card rendered from inside a dialog lives in `<body>`, but React still bubbles its key events to the dialog, so Tab there is the portal's own. If such a portal closes and drops focus, focus returns to where it was in the dialog.
- Nested dialogs: one document-level Escape handler closes only the topmost layer, and skips an Escape that an inner widget (combobox, popover, hover card, menu) already handled with `preventDefault()`. The handler stops the event, so Settings behind it stays open. A dialog nested in another is above it even when both mount in one commit.
- Everything outside the layer is `inert` while it is open: siblings along the path from the layer up to `<body>`, so a contained sheet works too. Branches that hold a live region (`[aria-live]`, `role=status|alert`, `[data-ui-live]`, such as the toast) stay live, and so do elements added later (owned portals). The previous layer is inert behind a nested one and live again when it closes.

```tsx
{open && <Dialog title={t('rename.title')} closeLabel={t('common.close')} onClose={() => setOpen(false)} footer={<Button variant="primary">…</Button>}>…</Dialog>}
```

### Popover

Replaces the hand-built picker pop-ups (AgentPicker, TemplatePicker, PhonePill, RepoIcon, OpenIn). Non-modal, controlled.

| Prop | Notes |
| --- | --- |
| `open`, `onOpenChange` | Controlled. |
| `trigger(props)` | Render prop: spread `PopoverTriggerProps` (`ref`, `onClick`, `aria-haspopup`, `aria-expanded`, `aria-controls`) onto one button. |
| `label` (required) | Accessible name of the panel (`role="dialog"`, not modal). |
| `side` (`top` default, `bottom`), `align` (`start` default, `end`) | Where the panel opens. |
| `portal` | Draws the panel in `<body>` (fixed, placed beside the trigger on `side` and `align`, flipped to the other side when it doesn't fit, kept on screen, and moved again when the page scrolls or resizes), for a trigger inside a scrolling or clipping container such as a dialog's body. It sits above a dialog. |
| `className`, `panelClassName` | Layout for the wrapper and the panel. The panel's default width (360px) and height are in `:where()`, so a one-class `width` or `max-height` rule on `panelClassName` wins whatever the load order. |

Focus goes into the panel on open (first focusable, an `autoFocus` wins). Escape closes, returns focus to the trigger and does not reach a dialog behind. Choosing an item that removes the focused row also returns focus to the trigger. A click outside, or Tab to something outside, closes without taking focus back.

A portalled panel works inside a `Dialog`: it is added after the dialog opened, so the dialog's inert background leaves it live, and its Tab and Escape are its own (React bubbles its events through the Popover, which the dialog's trap and Escape handler skip). Tab past its last control, or Shift+Tab from its first, closes it and returns to the trigger (forward Tab then moves on from the trigger), since the panel sits at the end of the page.

```tsx
<Popover open={open} onOpenChange={setOpen} label={t('agentPicker.label')} trigger={(p) => <ChipButton {...p}>Claude</ChipButton>}>…</Popover>
```

### HoverCard

Replaces `role="tooltip"` cards that hold buttons (`Attention.tsx`, `HomeBoard.tsx`). Portalled to `<body>`, placed with fixed coordinates (`placeCard`, below or beside, flipping when short of room).

| Prop | Notes |
| --- | --- |
| `trigger(props)` | Spread `HoverCardTriggerProps` onto one focusable element. It gets `aria-details` while the card is open. |
| `label` (required) | Accessible name of the card (`role="group"`). |
| `side` (`bottom` default, `right`), `width`, `openDelay` (300), `closeDelay` (200), `className` | Placement and layout. |
| `open`, `onOpenChange` | Optional control. |

Opens on hover (after the delay) and on focus; stays open while the pointer or focus is on the trigger or the card. Tab goes from the trigger into the card and, past its last control, closes it and carries on to whatever follows the trigger; Shift+Tab returns to the trigger. Escape dismisses it wherever focus is (window capture; focus goes back to the trigger when it was inside the card) and does not reach a dialog behind.

### Listbox

A single-select list; `role="listbox"` with options that are never tab stops. Focus stays on the list, and `aria-activedescendant` names the active option. It is also the list inside a Combobox. Not for the composer queue (that is a labelled list of `ActionRow`s).

| Prop | Notes |
| --- | --- |
| `label` (required), `options`, `value`, `onChange` | An option is `{ value, label, textValue?, disabled?, group?, description?, leading?, trailing?, title?, lang? }`; `label` is text, or markup (matched letters in `<mark>`) with `textValue`, its plain text: typeahead matches `textValue`, and a markup label's option is named by it (TypeScript requires `textValue` with a non-string label); `lang` marks a label in another language (the language picker). The chosen option shows a `--selected-mark` check. |
| `activeIndex`, `onActiveChange` | Drive the keyboard cursor from outside (Combobox does). Otherwise the list tracks it, starting on the chosen option. |
| `id`, `focusable`, `wrap`, `mono`, `className` | `id` is the base for option ids (`${id}-${i}`). `focusable={false}` inside a Combobox, or in any popup that a text field drives (no tab stop, no keys, mousedown keeps focus in the field; the composer's @ and / suggestions point the textarea's `aria-activedescendant` at it). `mono` puts option labels in the code font (paths, command names; a description asks for it itself). Arrows stop at the ends unless `wrap`. |

Keys: ↑ ↓ Home End (disabled options skipped), typeahead, Enter and Space choose. Consecutive options with the same `group` render as a `role=group` under a heading.

### Combobox

A text input with a Listbox under it (the branch picker, settings search). The input keeps every text key: typing, Home, End, ← → and Ctrl+A edit the text. The combobox claims only ↑ ↓ (open, then move; wraps, skips disabled), Enter (choose the active option while the list is open; otherwise it passes through), Escape (close; with the list closed and text present, clear it; otherwise it passes through) and Tab (close, focus moves on). Focus never leaves the input; `aria-activedescendant` points into the list.

| Prop | Notes |
| --- | --- |
| `label` (required), `options`, `value`, `onChange` | Options are what to show for the query; the feature filters. |
| `query`, `onQueryChange` | The input holds only the search text; show the chosen value as the placeholder. Choosing clears it. |
| `open`, `onOpenChange` | Optional control (always-on results); closes on blur, Escape, Tab and choosing. |
| `empty`, `footer` | Shown in the list when there are no options (no match, loading), and after the options. |
| `value` | The chosen value. With one, the placeholder is the choice, so it is drawn in the full text colour (`data-chosen`), not as a hint. |
| `leading`, `trailing`, `mono` (the code font for the input and the options' labels), `inline`, `inputRef`, `className` | Adornments inside the field; code font; `inline` puts the list in the page flow instead of floating over the field (`placeList` fixes it to the viewport, over or under the field, so a dialog's scroll can't clip it). Other native input props (`name`, `placeholder`, `disabled`, `autoFocus`) pass through. |

### Tree and TreeItem

Replace `FilesTree`'s hand-built rows. The feature supplies the visible rows in order (`rows: TreeRow[]` from `shared/fileTree.ts`, with an optional `label` for typeahead) and one `TreeItem` per row with its content; depth, folder and open state come from `rows`, so `TreeItem` takes `path` and `selected` only (`TreeItem` for a path not in `rows` throws).

| Prop | Notes |
| --- | --- |
| `label` (required), `rows`, `onToggle(path)`, `onOpen(path)` | Click, Enter, Space, → and ← call these. |

One tab stop (the focused row, else the first). Keys come from `treeKey`: ↑ ↓ Home End, → opens a closed folder or steps in, ← closes an open folder or steps out, Enter and Space open a file or toggle a folder; typing jumps to a row by the last part of its path. Keys from a control inside a row stay the control's. Rows are `role=treeitem` with `aria-level`, `aria-expanded` (folders) and `aria-selected`. Anything that is not a row (loading, error) belongs outside the tree.

### Resizer

Replaces `ResizeHandle` (`components/resize.tsx`). A `role="separator"` with `aria-valuenow/min/max`, so it is a slider for keyboard and screen-reader users. The size stays with the owner (`usePanelSize`); this reports sizes. The parent must be `position: relative`.

| Prop | Notes |
| --- | --- |
| `label` (required), `edge` (`left`, `right`, `top`, `bottom`) | The panel edge it sits on; dragging away from the panel makes it bigger. |
| `value`, `min`, `max`, `onResize(size, commit)` | `commit` is false while dragging and true when the drag or a key press is done; a click without a move reports nothing. |
| `onReset`, `measure(handle)`, `step` | Double-click resets; `measure` gives the real size of a pane sized by CSS; arrows move 16px. |

Keys: ← → on a vertical edge, ↑ ↓ on a horizontal one (mirrored on the left and top edges), Home and End go to the limits. Hover, drag and keyboard focus draw its 2px line in `--focus-ring`.

### Flash

The jump-to highlight: where the app scrolls the user to something (a setting reached from search or the navigation, a message reached from chat search), `flash(element, options)` from `ui/flash.ts` lights the target for a moment. It is a behaviour with a look (`ui/css/flash.css`), not a component, and it replaces the two feature animations (`.set-flash` in settings.css, `.chat-flash` in search-chats.css) that tinted the target in the accent and drew a 2px inset outline hard against its content. Nothing existing fit: no component owns a transient highlight, and each feature had drawn its own, in the one colour that reads as an error.

- Look: a pseudo-element on `[data-ui-flash]` behind the target's content: `--selected-tint` (neutral), 6px outside the target on every side so nothing inside touches its edge, rounded to the target's own corners plus the 6px (at least `--radius-md`), no outline, no layout change. It fades in over the first 12% and out from 60% of 1.4 s. A target that doesn't position itself becomes `position: relative` (zero specificity) and gets its own stacking context while lit.
- `flash(target, { parts, tall, duration })` puts the attribute on, takes it off after `duration` (1400 ms, 1000 ms under Reduce Motion), restarts a target already flashing, and returns a function that ends it early (call it in an effect's cleanup). `flashTargets(target, { parts, tall })` is what it will light.
- **Tall targets.** A target taller than `tall` (120px by default) is a block of rows and controls, not one thing, so `parts(target)` names what to light instead (its title and description) and the block stays still. With no `parts`, or none found, the target itself is lit. Settings passes `settingFlashParts` (`components/settings/flashParts.ts`): a row's own `.set-row-text`; otherwise the `h2` and `.set-section-desc` of the section the target is or sits in; otherwise the first row's text. The loadout, the model lists and Claude Code's authentication card therefore flash their heading and help text and leave the cards and radios alone.
- **Reduce Motion:** no animation. The wash is simply on (a static tint) for the 1000 ms, then off. Forced colours drop backgrounds, so the wash becomes a 2px `Highlight` outline.
- `data-ui-flash="hold"` keeps the wash on with no animation and no timer; `npm run screens` uses it to freeze the flash in the `flash-*` screens.

```ts
useEffect(() => (row ? flash(row, { parts: settingFlashParts }) : undefined), [row])
```


## Classes

Legacy: today's shared classes, which phase 3 of the migration replaces with the components above. Don't use them in new code.

| Component | Markup | Variants |
| --- | --- | --- |
| Button | `button.btn` | `.small`, `.primary`, `.danger`, `.ghost` |
| Icon button | `button.icon-btn` (always give it `aria-label`) | `.active` |
| Link button | `button.link-btn` (add the `.small` text helper for 12px) | `.danger` |
| Chip | `button.chip` | `.active`, `.accent`, `.plan-on` |
| Tag | `span.tag`: a short inline label such as `r3`, `tool` or `read only` | `.accent`, `.outline` (on raised rows) |
| Pill | `span.pill`: status text in headers | `.error` |
| Keyboard hint | `span.kbd` | |
| Notice | `div.notice` (centered, faint) with optional `div.notice-actions` | `.error` |
| Recovery card | `div.recovery-card` > `div.recovery-cause` + `div.notice-actions` | `.sensitive-card`, `.limit-card` |
| Usage-limit resume (#11) | inside `div.recovery-cause`: `div.resume` > `label.check` (checkbox + "Resume at 14:30"), `div.resume-source` (with a mono `q`), `div.resume-preview`; unknown or missed: `div.resume-unknown` (icon + text), missed adds `div.notice-actions`; Home's Scheduled card: `div.home-row.resume-row` with `span.home-pill.accent` (`.amber` when missed) and `div.home-row-sub.resume-src` (`limitResume.css`) | `.resume-flat` (no checkbox) |
| Attention (#3) | PR glyph `span.pr-glyph` (+ `span.pr-glyph-num` on Home) beside a row's own glyph; its hover card `div.pr-card` (portalled to `<body>`) > `.pr-card-title`, `.pr-card-line`, `.pr-card-foot` ("as of 14:02 · Refresh" `link-btn`), `.pr-card-note`; Home → Recent is `section.home-card.recent-card` with `span.recent-count`, `div.recent-row`s (`.recent-time`, icon, `.recent-ws`, `.recent-text`, `span.recent-repeats`) and `footer.recent-foot` (`attention.css`). G2: Board cards use the same PR glyph; a GitLab repo's sidebar row leads its sub-line with `span.ws-gitlab` > `GitlabMark` (`gitlab.css`) | `.pr-glyph.open`, `.draft`, `.merged`, `.ci-failing`, `.stale`; `.recent-row.seen` |
| Floating find bar | `div.chat-search.term-find` (absolute, top right of a `.fill`): input, `icon-btn.active` toggles, `span.term-find-sep`, `span.search-count`, ↑ ↓ × | `TerminalFind.tsx` |
| Restored terminal | `div.terminal.restored` + `div.term-restored` > `div.term-restored-band` (ruled label) + `div.term-restored-actions`; the tab gets `span.term-restored-icon` | Tab rename reuses `input.tab-rename` inside `.bottom-tab.renaming`; fullscreen is `div.bottom-slot.terminal-fullscreen` |
| Diff selection (#15) | selected cells get `td.sel` (`.sel-edge` on the side's number); `tr.sel-anchor-tr` > `div.sel-float` > `div.sel-bar` (`chip.sel-dest` + `div.menu.sel-dest-menu`, `span.sel-sep`, ghost `btn.small`s); quoting comments add `div.comment-quote` (`.comment-quote-head`, `.dim`), `span.comment-prefix`, `div.stale-line`, `div.stale-review`, `div.comment-actions-row` (`diffSelection.css`) | `.inline-comment.stale`, `.pill.queued`, `.pill.held` |
| Composer draft block | `div.term-draft` > `div.term-draft-head` (toggle, label, preview, ×) + `pre.term-draft-body` when open | `.open`; G4: `textarea.term-draft-edit` (with `span.term-draft-hint`) when the block can be trimmed; `.term-sent` for a block drawn in a sent bubble (`UserMessageText`) |
| Command tab status (G4 O9) | `span.term-exit` after a command tab's name, with a ✓ or ✗ icon and a title saying the exit code | `.ok`, `.fail` |
| Markdown field (G4 O15) | `FieldModeToggle` (`div.segmented.small.field-mode`, Rich / Source) + `RichField` (`div.rich-field` around `RichMarkdown compact`); `div.field-mode-row` right-aligns the toggle above a field | one remembered choice for every field (`useFieldMode`) |
| Queue row | `div.queued` > `div.queued-head` + `div.queued-row` (`span.pos`, `span.queued-text`, `span.move` with ↑/↓ `icon-btn`s); editing: `.queued-row.editing` > `div.queued-edit-top`, `textarea`, `div.queued-edit-foot` (`span.keep`) | `.editing`; `div.held-bar.race-bar` for an edit kept as a draft |
| Stop sheet (#1) | `.modal.stop-modal` > `section.stop-group` > `header.stop-group-head` (icon, title, `span.stop-group-hint`) + `div.stop-row`s (`span.stop-row-icon`, `span.stop-row-ws`, `span.stop-row-text`, `tag.outline`, `span.stop-row-time`); archive adds `div.stop-columns` > `div.stop-column` and `div.stop-steps`; the review uses `div.stop-review-list` > `div.stop-review-row` (`stopSafely.css`) | `.stop-row-icon.waiting`, `.stop-step.failed`; `div.stop-bar` for the waiting-to-quit bar |
| Auto-fix CI (#5) | Git panel: `div.autofix-line` under a Checks header, `div.autofix-stopped` under the toggle; consent: `.modal.checks-dialog.autofix-dialog` > `div.autofix-section`s (`pre.consent-diff.autofix-prompt`, `div.autofix-budget` of `tag.outline`s, `ul.consent-list`); chat: `div.autofix-receipt` (`tag.accent` + why) under the user message (`autoFix.css`) | `.autofix-line.stopped` |
| Auto review (#17) | consent: `.modal.handoff-modal.ar-modal` (`.field`s, `ul.consent-list`, `div.ar-budget` of `tag.outline`s, `details.ar-prompt`, `div.handoff-dest`); reviewer tab: `div.ar-bar` above the chat, `div.ar-receipt` under Foreman's message, `div.ar-findings` > `div.review-actions` + `div.review-thread`s (`span.ar-sev`, `span.ar-sent`), the tab's lock `.ar-tab-lock`; Home: `tag.ar-stale` (`autoReview.css`) | `.ar-bar.running`, `.stale`, `.stopped`; `.ar-sev.high`, `.medium`, `.low`; `.ar-paused` |
| Welcome tour | `div.tour-layer` (fixed, z-index 100, takes the clicks) > `div.tour-spot` (the hole: accent ring plus a 9999px `--backdrop` shadow) or `div.tour-dim`, and `div.tour-card` (`role=dialog`, `.tour-eyebrow`, `h2`, `p` with `.kbd` keycaps, `p.tour-away`, `div.tour-action` (the step's button), `div.tour-foot` > `span.tour-count`) (`tour.css`). A control joins the tour with `data-tour="<target>"`; steps live in `shared/tour.ts` | `.tour-card.side-right`, `.side-left`, `.side-below`, `.side-above` (arrow at `--tour-arrow`), `.side-center` (no arrow) |
| Agent catalog (#22) | `span.agent-mono` (two-letter badge, `.large`); `div.cat-legend` > `div.cat-legend-item`; `section.cat-group` > `header.cat-group-head` + `div.cat-rows` > `div.cat-row` (`.cat-row-main`, `.cat-row-line`, `span.cat-chips` of `tag.outline.cat-chip`, `button.cat-more`); Sign-in `div.si-row`; Provider keys `div.pk-row` > `div.pk-allowed` > `label.pk-check`; Terminal agent tab `div.agent-term` > `.agent-term-banner`, `.agent-term-body`, `.agent-term-foot` (`components/agents/catalog.css`) | `.cat-chip.off` (struck through), `.pk-check.locked` |
| Toast | `showToast(text, kind, { action: { label, run } })` from the store (`action`/`actions` are optional; a toast with a button stays 10 s and renders `button.toast-action`) | `info`, `error`; G4: an `error` toast ends with a "Report…" action (8 s, or its buttons' 10 s) unless `{ report: false }` |
| Text helpers | `.muted`, `.faint`, `.small`, `.mono`, `.error-text`, `.spacer` | |

Inputs, selects and text areas are styled by element. Disabled, placeholder, checkbox, radio and range states are global. Settings rows use `.set-input`, `.set-select` and `.set-textarea`.

Every `button`, link, `summary` and `role="tab|radio|switch|option|button"` element gets the same keyboard focus ring (`--focus-ring`). The rule has zero specificity, so a component's own `:focus-visible` style still wins.

## React controls

Primitive controls live in `ui/`; application-specific settings compositions remain in `components/settings/controls.tsx`. `Modal` is gone: every new dialog is a `ui/Dialog`.

| Control | Where | Notes |
| --- | --- | --- |
| `useDialogFocus(ref)` | `components/Dialogs.tsx` | Moves focus into a dialog, keeps Tab inside it, and gives focus back on close (to the opener of the dialog it was opened from, if that one is gone too). Only the Tour card uses it now (it is positioned and drops the backdrop); a new dialog is a `ui/Dialog`. |
| `Switch`, `Segmented`, `Tabs`, `Select` | `ui/index.ts` | Canonical primitives; see their Components sections above for variants, controlled state and keyboard behaviour. |
| `TextRow`, `TextAreaRow`, `ToggleRow`, `RepoToggleRow`, `Row`, `Section`, `Page`, `MaskedValue` | `components/settings/controls.tsx` | Settings page building blocks. `Row`/`ToggleRow` take `below` for full-width sub-options inside the row (`.set-row-below`), as with keep-awake's cutoffs. |

Import primitives directly from `ui/`. In `controls.tsx`, `MaskedValue` wraps the UI primitive with Foreman's translated labels and toasts; settings rows compose UI controls and shared field bindings. Keep these domain behaviours in the existing wrappers rather than duplicating them in each settings page.

## Content accessibility

What a screen reader hears beyond the controls.

- **Chat.** `ChatView` is a `region` named "Chat: <title>" (an `h2`, visually hidden with `.sr-only`) holding one `article` per message, each headed by an `h3` that says who wrote it and when ("You, 2:02 PM", "Claude Code, reply to your 2:02 PM message"). It is deliberately not `role="log"` or `aria-live`: a live log would speak every tool call and every streamed chunk, and a live attribute on the log would keep the whole chat outside the `inert` background of a dialog. A streaming answer is `aria-busy`; when it finishes, `announce()` says its first 300 characters once, for the chat on screen only.
- **Announcer** (`announce.ts`, `components/Announcer.tsx`). One polite `role="status"` region, mounted in `App`. `announce(text, key)` batches what arrives within 700 ms into one sentence each, and a later message with the same key replaces one still waiting. The watcher feeds it agent status for the chat on screen (started, finished, failed, stopped) and for any chat that needs you (approval, question, plan to review). Nothing is said for other chats, for a chat covered by Settings, Automations or the Assistant, or on the first look at the state.
- **Toasts.** `ToastHost` keeps a `role="status"` and a `role="alert"` region in the page at all times and fills the one that fits (errors go to the alert), so the text is a change inside a live region, not a new region. Both are zero-size and fixed.
- **Landmarks and headings.** One `main`; the sidebar is a named `aside` and the workspace's side panel and the terminal panel are named regions; each view starts with a heading (Home and the Settings pages use `h1`; Automations and Assistant title their bar with `role="heading" aria-level="1"`; a workspace names its centre section with its own name the same way). Visually hidden text uses `.sr-only` (`styles/base.css`).
- **Terminal.** Settings → Advanced → Terminal → Screen reader support (`terminalScreenReader`: Automatic, On, Off). Automatic follows `app.accessibilitySupportEnabled`, sent in the snapshot as `screenReader`. It becomes xterm's `screenReaderMode`, and `TerminalView`'s options effect applies it to terminals that are already open.

## i18n

Foreman's own text can be shown in English, 简体中文, 日本語, 한국어, Español, Français, Deutsch and Português (Brasil). Settings → General → Language picks one, or System, which follows the OS. The change applies at once. The module is `src/shared/i18n/`: plain TypeScript with no dependency, so main can use it too, for example for notifications, with `createT(resolveLocale(settings.language, app.getPreferredSystemLanguages()))`. User content (chat, task titles, branch and file names, agent replies) is never translated.

**Adding a string**

1. Add the key and its English text to `src/shared/i18n/en.ts`, the source catalogue. Name keys `area.thing.part`, for example `settings.general.sendKey.help`. If the text needs explaining to a translator, add a comment above the key.
2. In a component, call `const t = useT()` (from `renderer/src/i18n.ts`) and then `t('the.key')`. The component re-renders when the language changes. Outside React, for example in store toasts, import the store-backed `t` from the same file.
3. Placeholders: write `'Use {keys} to queue'` and call `t(key, { keys })`. Keys and params are type-checked, so a missing param is a compile error. When a placeholder holds markup, use `t.rich(key, { code: <code>code</code> })`.
4. Plurals: make the message an object of `Intl.PluralRules` forms, such as `{ one: '{count} running', other: '{count} running' }`, and pass `count`. An optional `zero` form is used for exactly 0 in any language.
5. In tables of labels, type the field as `PlainKey` (a key with no params) and call `t(row.label)` at render time. Don't call `t` at module level, because it would never update.
6. A new key shows in English in every other language until someone translates it, so the build never breaks. Each language's percentage in Settings drops until then, and `tests/i18nCatalogue.test.ts` fails until every locale has it (or it is listed in that test's `LEFT_ENGLISH`, with a reason).
7. Dates, times and ages: never hand-write "12m ago" or call `toLocaleString()` with no locale. Use `src/shared/i18n/time.ts` (`timeAgo`, `timeWaited`, `formatClock`, `formatDate`, `formatDateTime`, `formatNumber`) with `t.locale`, or `store.ts`'s `timeAgo(iso)` / `timeWaited(iso)`. English keeps the compact "just now · 12m ago · 3h ago · 2d ago"; other languages get `Intl.RelativeTimeFormat`'s words ("hace 12 min", "12分前").
8. Shared helpers that return display text take an optional last `t: TFunction` that defaults to English, so `foreman` CLI output and existing tests stay English while the renderer passes its own `t`. Main uses the user's language for notifications, native dialogs, the app menu and the tray.
9. What stays English: prompts and instructions sent to agents, the Report a problem report, errors thrown in main (they also go to logs and the CLI), `foreman` CLI output and the phone web app.

**Adding or finishing a locale (translators)**

- Each locale is one file, for example `src/shared/i18n/fr.ts`. It exports a `Catalogue`, which is a partial map from key to text. Copy keys from `en.ts`, translate the values and keep the `{placeholders}` as written. Leave out a key, or give it `''`, and it shows in English. Plural keys use your language's own forms: Japanese needs only `other`, while Polish uses `one`, `few`, `many` and `other`. A plain string works when the form doesn't change.
- To add a new language: create the file, then add it to `LOCALES` (code plus its own name) and to `CATALOGUES` in `index.ts`. Extend `matchLocale` if OS tags need mapping. Today, any `es-*` maps to es, any `pt-*` to pt-BR, and `zh`, `zh-CN` or `zh-Hans-*` to zh-CN. Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-HK`) is not matched and falls back to English.
- `completeness(locale)` is the percentage of English keys translated, rounded down so that 100% means complete. Settings shows this number beside each language. `tests/i18n.test.ts` covers fallback, interpolation, plurals, completeness and OS-locale mapping. `tests/i18nCatalogue.test.ts` checks that every locale is complete, that every `t('key')` in `src` exists in `en.ts`, that each translation keeps English's `{placeholders}`, that plural messages have the language's CLDR forms (es, fr and pt-BR may omit `many`, which only applies to exact millions), and how dates and ages format per locale.
