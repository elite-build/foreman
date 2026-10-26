// The keyboard shortcut registry (accessibility plan, phase B1).
//
// One list drives three things: `useShortcuts` in App.tsx dispatches window keydowns from it, the
// shortcuts help sheet (Overlays.tsx) renders its rows from it, and the command palette's hints
// come from it. Adding a shortcut means adding one entry here; tests/shortcuts.test.ts then checks
// the label exists, the chord collides with nothing active in the same place, and a Windows chord
// is not one a screen reader owns (RESERVED_WIN).
//
// Chords are strings like 'mod+alt+PageUp' or 'mod+shift+Enter': modifiers (`mod`, `ctrl`, `alt`,
// `shift`, `meta`) joined with '+', then a KeyboardEvent.code ('KeyK', 'Slash', 'Digit1', 'Enter').
// Matching is on `e.code`, because Option/Alt changes `e.key` on macOS. A single printable
// character ('n', ']', '.') is accepted as shorthand for its code. `mod` is Cmd on macOS and Ctrl
// elsewhere; `ctrl` is the literal Control key on both. A key may be a digit range ('Digit1-9').
// Matching is exact: every modifier the chord does not name must be up. Several chords for one
// action are separated by ' / '.
//
// This module is pure (type imports only), so the Node tests can load it; everything an entry does
// goes through `ctx.actions`, which App.tsx provides.
import type { PlainKey } from '../../shared/i18n'
import type { OnboardingMilestone } from '../../shared/onboarding'
import type { GitActionKind, Session, Workspace } from '../../shared/types'
import type { getState, Overlay, UiCommand } from './store'

type State = ReturnType<typeof getState>
export type Snapshot = NonNullable<State['snapshot']>

export type Platform = 'mac' | 'win'
/** Accepts what `snapshot.platform` holds ('darwin', 'win32', 'linux') as well as 'mac' and 'win'. */
export function platformOf(platform: string | undefined): Platform {
  return platform === 'darwin' || platform === 'mac' ? 'mac' : 'win'
}

export type ShortcutGroup = 'general' | 'workspaces' | 'chat' | 'terminal' | 'files' | 'git' | 'approvals'

/**
 * Where a chord is live. 'app' works anywhere; the others only inside that region (a terminal,
 * the file viewer, an open approval, the chat's find bar). Two entries only collide when their
 * scopes overlap: the same scope, or either one is 'app'.
 */
export type ShortcutScope = 'app' | 'chat' | 'chat-find' | 'terminal' | 'file-viewer' | 'approvals' | 'browser' | 'diff'

/** The slice of a KeyboardEvent matching needs, so tests can pass plain objects. */
export interface ChordEvent {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  target?: EventTarget | null
}

/** Everything an entry's `run` can do to the app. App.tsx implements these over the store. */
export interface ShortcutActions {
  openOverlay(overlay: Overlay | null): void
  // Get started: remember a milestone (the next-attention keys count as using Needs you).
  recordMilestone?(id: OnboardingMilestone): void
  toggleToolCalls(): void
  toggleTheme(): void
  toggleLeftPanel(): void
  toggleRightPanel(): void
  toggleBottomPanel(): void
  toggleZen(): void
  toggleSettings(): void
  toggleAssistant(): void
  toggleTerminalFullscreen(workspaceId: string): void
  selectWorkspace(workspaceId: string): void
  selectSession(workspaceId: string, sessionId: string): void
  newWorkspace(workspace: Workspace | undefined): void
  newChat(workspaceId: string): void
  reopenChat(workspaceId: string): void
  closeChat(workspaceId: string, sessionId: string): void
  closeBrowserTab(workspaceId: string): void
  forkChat(workspaceId: string, sessionId: string): void
  runGit(workspaceId: string, action: GitActionKind): void
  openPreview(workspaceId: string): void
  equipLoadout(session: Session, hasHistory: boolean, index: number): void
  focusComposer(workspaceId: string): void
  command(command: UiCommand, workspaceId: string): void
}

export interface ShortcutContext {
  event: ChordEvent
  state: State
  snapshot: Snapshot
  platform: Platform
  /** The selected workspace, unless it is archived. */
  ws: Workspace | undefined
  /** The workspace's active chat. */
  session: Session | undefined
  /** Workspaces in the sidebar's order; computed on first use. */
  order: () => Workspace[]
  actions: ShortcutActions
}

interface ShortcutBase {
  /** Stable name: tests, the help sheet's React keys and the palette's hints use it. */
  id: string
  /** Chords per platform; ' / ' separates alternatives. Empty for a gesture (see `display`). */
  keys: { mac: string; win: string }
  group: ShortcutGroup
  scope: ShortcutScope
  labelKey: PlainKey
  /** Shown in the help sheet instead of the chord, for a gesture such as a double-click. */
  display?: PlainKey
  /** Extra condition on top of the chord; an entry whose `when` is false is skipped. */
  when?: (ctx: ShortcutContext) => boolean
  /** This entry shadows another one on purpose, so the pair is not reported as a collision. */
  overrides?: string
}

/** Handled by the global dispatcher. */
export interface DispatchedShortcut extends ShortcutBase {
  run: (ctx: ShortcutContext) => void
  /** Runs in the capture phase and stops the event, ahead of the focused control (the composer). */
  capture?: boolean
}

/** Listed in the help sheet, handled by the named component's own listener. */
export interface DocumentedShortcut extends ShortcutBase {
  run?: undefined
  handledBy: string
}

export type ShortcutEntry = DispatchedShortcut | DocumentedShortcut

// ---- Chords ----

const CHAR_CODES: Record<string, string> = {
  ']': 'BracketRight',
  '[': 'BracketLeft',
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  '=': 'Equal',
  '-': 'Minus',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote'
}

interface ResolvedChord {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** The key as written ('Digit1-5', 'KeyK'), for display. */
  token: string
  /** Every KeyboardEvent.code it stands for. */
  codes: string[]
}

function keyCodes(token: string): string[] {
  const range = /^Digit(\d)-(\d)$/.exec(token)
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => `Digit${Number(range[1]) + i}`)
  if (/^[a-zA-Z]$/.test(token)) return [`Key${token.toUpperCase()}`]
  if (/^\d$/.test(token)) return [`Digit${token}`]
  return [CHAR_CODES[token] ?? token]
}

/** The alternatives in a `keys` string, e.g. 'mod+KeyG / mod+shift+KeyG'. */
export function chordsOf(keys: string): string[] {
  return keys
    .split(' / ')
    .map((c) => c.trim())
    .filter(Boolean)
}

function resolveChord(chord: string, platform: Platform): ResolvedChord {
  const parts = chord.split('+').map((p) => p.trim())
  const token = parts.pop() ?? ''
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const mac = platform === 'mac'
  return {
    ctrl: mods.has('ctrl') || (!mac && mods.has('mod')),
    meta: mods.has('meta') || (mac && mods.has('mod')),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    token,
    codes: keyCodes(token)
  }
}

/** Letters and digits as the bare character, everything else by its code: 'ctrl+alt+n', 'ctrl+alt+ArrowUp'. */
function canonicalKey(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit(\d)$/.exec(code)
  return digit ? digit[1] : code
}

/** One canonical string per key a chord stands for, `mod` resolved: ctrl, alt, shift, meta, then the key. */
export function canonicalChords(chord: string, platform: string | undefined): string[] {
  const r = resolveChord(chord, platformOf(platform))
  const mods = [r.ctrl && 'ctrl', r.alt && 'alt', r.shift && 'shift', r.meta && 'meta'].filter(Boolean) as string[]
  return r.codes.map((code) => [...mods, canonicalKey(code)].join('+'))
}

function chordMatches(chord: string, e: ChordEvent, platform: Platform): boolean {
  const r = resolveChord(chord, platform)
  if (e.ctrlKey !== r.ctrl || e.metaKey !== r.meta || e.altKey !== r.alt || e.shiftKey !== r.shift) return false
  // The numpad's Enter is Enter.
  const code = e.code === 'NumpadEnter' ? 'Enter' : e.code
  return r.codes.includes(code)
}

const MAC_KEYS: Record<string, string> = { Enter: '↵', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down', Minus: '−' }
// Words, not arrows or symbols: screen readers on Windows read "Up", not "upwards arrow".
const WIN_KEYS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down' }
const PUNCTUATION: Record<string, string> = { Slash: '/', Period: '.', Comma: ',', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`' }

function formatKey(token: string, platform: Platform): string {
  const range = /^Digit(\d)-(\d)$/.exec(token)
  if (range) return `${range[1]}–${range[2]}`
  const [code] = keyCodes(token)
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  return (platform === 'mac' ? MAC_KEYS : WIN_KEYS)[code] ?? PUNCTUATION[code] ?? code
}

/**
 * A chord for people: '⌘⌥]' on macOS, 'Ctrl+Alt+]' on Windows. Windows says "Ctrl+Alt" in words
 * (never AltGr), and names Enter, Backspace and the arrows rather than drawing them.
 */
export function formatChord(chord: string, platform: string | undefined): string {
  const p = platformOf(platform)
  const r = resolveChord(chord, p)
  const key = formatKey(r.token, p)
  if (p === 'mac') return `${r.meta ? '⌘' : ''}${r.ctrl ? '⌃' : ''}${r.alt ? '⌥' : ''}${r.shift ? '⇧' : ''}${key}`
  return [r.ctrl && 'Ctrl', r.alt && 'Alt', r.shift && 'Shift', r.meta && 'Win', key].filter(Boolean).join('+')
}

/** An entry's chords for a platform, alternatives joined: '⌘G / ⌘⇧G'. Empty for a gesture. */
export function formatKeys(entry: Pick<ShortcutEntry, 'keys'>, platform: string | undefined): string {
  const p = platformOf(platform)
  return chordsOf(entry.keys[p])
    .map((c) => formatChord(c, p))
    .join(' / ')
}

// ---- Reserved chords ----

/**
 * Windows chords a screen reader owns, in canonical form. NVDA and JAWS use Ctrl+Alt+Arrow for
 * table navigation; Ctrl+Alt+N launches NVDA. Ctrl+Alt+letter chords (AltGr on some European
 * layouts) stay allowed for now: US keyboards first, per the plan's decision 1. This catches known
 * conflicts; it does not claim other chords are free.
 */
export const RESERVED_WIN: string[] = ['ctrl+alt+ArrowUp', 'ctrl+alt+ArrowDown', 'ctrl+alt+ArrowLeft', 'ctrl+alt+ArrowRight', 'ctrl+alt+n']

/** The entries' Windows chords that are on the reserved list. */
export function reservedBindings(entries: readonly ShortcutEntry[]): { id: string; chord: string }[] {
  const out: { id: string; chord: string }[] = []
  for (const entry of entries)
    for (const chord of chordsOf(entry.keys.win))
      for (const canonical of canonicalChords(chord, 'win')) if (RESERVED_WIN.includes(canonical)) out.push({ id: entry.id, chord: canonical })
  return out
}

const overlaps = (a: ShortcutScope, b: ShortcutScope) => a === b || a === 'app' || b === 'app'

/** Pairs of entries live in the same place with a chord in common (unless one is marked `overrides` the other). */
export function collisions(entries: readonly ShortcutEntry[], platform: string | undefined): [ShortcutEntry, ShortcutEntry][] {
  const p = platformOf(platform)
  const chords = entries.map((e) => new Set(chordsOf(e.keys[p]).flatMap((c) => canonicalChords(c, p))))
  const out: [ShortcutEntry, ShortcutEntry][] = []
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      if (!overlaps(a.scope, b.scope) || a.overrides === b.id || b.overrides === a.id) continue
      if ([...chords[i]].some((c) => chords[j].has(c))) out.push([a, b])
    }
  return out
}

/** Whether a chord has neither Ctrl nor Cmd: a bare key such as Enter, Esc or 1-9, live only while a control has focus. */
export function isBare(chord: string, platform: string | undefined): boolean {
  const r = resolveChord(chord, platformOf(platform))
  return !r.ctrl && !r.meta
}

// ---- Matching and dispatch ----

/** The event's digit key, 0-9; undefined for any other key. */
export function digitOf(e: Pick<ChordEvent, 'code'>): number | undefined {
  const m = /^Digit([0-9])$/.exec(e.code)
  return m ? Number(m[1]) : undefined
}

export interface MatchOptions {
  /** With a context, entries whose `when` is false are skipped; without one, `when` is ignored. */
  ctx?: ShortcutContext
  /** true: only capture-phase entries; false: only the others; undefined: both. */
  capture?: boolean
  entries?: readonly ShortcutEntry[]
}

/**
 * The entry the global dispatcher runs for a keydown: the first dispatched entry (one with a `run`)
 * whose chord matches the event exactly for the platform and whose `when` passes. Documented
 * entries, whose component handles the key itself, never match.
 */
export function matchShortcut(event: ChordEvent, platform: string | undefined, options: MatchOptions = {}): DispatchedShortcut | undefined {
  const p = platformOf(platform)
  const { ctx, capture, entries = SHORTCUTS } = options
  for (const entry of entries) {
    if (!entry.run) continue
    if (capture !== undefined && Boolean(entry.capture) !== capture) continue
    if (!chordsOf(entry.keys[p]).some((c) => chordMatches(c, event, p))) continue
    if (ctx && entry.when && !entry.when(ctx)) continue
    return entry
  }
  return undefined
}

/** Runs the matching entry, if any, after preventDefault (and stopPropagation for capture entries). Returns whether one ran. */
export function dispatchShortcut(event: ChordEvent & { preventDefault(): void; stopPropagation(): void }, ctx: ShortcutContext, capture: boolean): boolean {
  const entry = matchShortcut(event, ctx.platform, { ctx, capture })
  if (!entry) return false
  event.preventDefault()
  if (capture) event.stopPropagation()
  entry.run(ctx)
  return true
}

// ---- The entries ----

const k = (mac: string, win: string = mac) => ({ mac, win })
const inWorkspace = (c: ShortcutContext) => Boolean(c.ws)
const inChat = (c: ShortcutContext) => Boolean(c.ws && c.session)

/** Opens the next chat that has unread activity or waits for the user, other than the one open. Returns it, or undefined when there is none. */
function goToNextAttention(c: ShortcutContext): Session | undefined {
  const { state, snapshot } = c
  const target = snapshot.sessions.find((s) => !s.closedAt && s.id !== c.session?.id && (state.unreadSessions[s.id] || state.approvals.some((a) => a.sessionId === s.id)))
  if (!target) return undefined
  c.actions.recordMilestone?.('needsYou')
  c.actions.selectWorkspace(target.workspaceId)
  c.actions.selectSession(target.workspaceId, target.id)
  return target
}

/** ⌘⇧ + key runs a git action. */
const GIT_SHORTCUTS: [key: string, action: GitActionKind, label: PlainKey][] = [
  ['KeyP', 'create-pr', 'palette.git.createPr'],
  ['KeyY', 'commit-and-push', 'palette.git.commitAndPush'],
  ['KeyL', 'pull', 'palette.git.pull'],
  ['KeyM', 'merge', 'palette.git.merge'],
  ['KeyX', 'fix-errors', 'shortcuts.fixChecks'],
  ['KeyR', 'review', 'shortcuts.codeReview'],
  ['KeyG', 'open-pr', 'shortcuts.openPr']
]

/** The registry id of a git action's shortcut. */
export const gitShortcutId = (action: GitActionKind) => `git.${action}`

/** What `stt.pushToTalk` runs: a key-down, with `repeat` set while the key is held. */
export type PushToTalkHandler = (event: ChordEvent & { repeat?: boolean }) => void
let pushToTalkHandler: PushToTalkHandler | undefined
/**
 * stt.ts registers itself here when it loads (SttChip in the sidebar imports it, so it is in the window from the start).
 * That keeps this module free of the store and the audio code, which the Node tests import. stt.ts owns the key-up and
 * blur listeners a held chord needs, which the dispatcher (key-downs only) cannot.
 */
export function setPushToTalkHandler(handler: PushToTalkHandler | undefined): void {
  pushToTalkHandler = handler
}

/**
 * Order is the help sheet's order within each group, and the dispatcher's order among entries
 * with the same chord (the browser tab's ⌘W comes before the chat's).
 *
 * Bare single keys (Enter, Esc, 1-9, 0) are documented here but never dispatched globally: they are
 * live only while the control that owns them has focus, and each keeps a visible, named button.
 */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  // ---- General ----
  { id: 'palette.toggle', keys: k('mod+KeyK'), group: 'general', scope: 'app', labelKey: 'shortcuts.palette', run: (c) => c.actions.openOverlay(c.state.overlay === 'palette' ? null : 'palette') },
  { id: 'settings.toggle', keys: k('mod+Comma'), group: 'general', scope: 'app', labelKey: 'shortcuts.settings', run: (c) => c.actions.toggleSettings() },
  { id: 'theme.toggle', keys: k('mod+alt+KeyT'), group: 'general', scope: 'app', labelKey: 'shortcuts.toggleTheme', run: (c) => c.actions.toggleTheme() },
  { id: 'panel.left', keys: k('mod+KeyB'), group: 'general', scope: 'app', labelKey: 'palette.toggleSidebar', run: (c) => c.actions.toggleLeftPanel() },
  { id: 'panel.right', keys: k('mod+alt+KeyB'), group: 'general', scope: 'app', labelKey: 'palette.toggleSidePanel', run: (c) => c.actions.toggleRightPanel() },
  { id: 'panel.bottom', keys: k('mod+alt+KeyJ'), group: 'general', scope: 'app', labelKey: 'palette.toggleTerminal', run: (c) => c.actions.toggleBottomPanel() },
  { id: 'zen.toggle', keys: k('mod+Period'), group: 'general', scope: 'app', labelKey: 'palette.zen', run: (c) => c.actions.toggleZen() },
  // ⌘O on macOS; Ctrl+Shift+O elsewhere, because Ctrl+O is the tool-call toggle below (same rule as isOpenInKey).
  { id: 'openIn.toggle', keys: k('mod+KeyO', 'ctrl+shift+KeyO'), group: 'general', scope: 'app', labelKey: 'openIn.switcher.label', run: (c) => c.actions.openOverlay(c.state.overlay === 'open-in' ? null : 'open-in') },
  { id: 'assistant.toggle', keys: k('mod+shift+KeyA'), group: 'general', scope: 'app', labelKey: 'assistant.title', when: (c) => Boolean(c.snapshot.settings.assistantEnabled), run: (c) => c.actions.toggleAssistant() },
  // Phase F3: a one-line Ask Foreman dialog over the current view. Ctrl+Alt+Space on Windows is not a screen reader's key.
  { id: 'assistant.ask', keys: k('mod+alt+KeyK', 'ctrl+alt+Space'), group: 'general', scope: 'app', labelKey: 'ask.title', when: (c) => Boolean(c.snapshot.settings.assistantEnabled), run: (c) => c.actions.openOverlay(c.state.overlay === 'ask' ? null : 'ask') },
  // Phase G2: push-to-talk dictation (stt.ts). The chord is in-window only; hold or toggle is a setting. Ctrl+Alt+V is not a screen reader's key.
  {
    id: 'stt.pushToTalk',
    keys: k('mod+alt+KeyV'),
    group: 'general',
    scope: 'app',
    labelKey: 'shortcuts.pushToTalk',
    run: (c) => pushToTalkHandler?.(c.event as ChordEvent & { repeat?: boolean })
  },
  { id: 'shortcuts.help', keys: k('mod+alt+Slash'), group: 'general', scope: 'app', labelKey: 'shortcuts.thisList', run: (c) => c.actions.openOverlay('shortcuts') },

  // ---- Workspaces ----
  { id: 'workspace.new', keys: k('mod+KeyN'), group: 'workspaces', scope: 'app', labelKey: 'palette.newWorkspace', run: (c) => c.actions.newWorkspace(c.ws) },
  {
    id: 'workspace.switch',
    keys: k('mod+Digit1-9'),
    group: 'workspaces',
    scope: 'app',
    labelKey: 'shortcuts.switchWorkspace',
    run: (c) => {
      const target = c.order()[(digitOf(c.event) ?? 0) - 1]
      if (target) c.actions.selectWorkspace(target.id)
    }
  },
  {
    // Was mod+alt+ArrowUp / ArrowDown, which NVDA and JAWS use for table navigation on Windows.
    id: 'workspace.prevNext',
    keys: k('mod+alt+PageUp / mod+alt+PageDown'),
    group: 'workspaces',
    scope: 'app',
    labelKey: 'shortcuts.prevNextWorkspace',
    run: (c) => {
      const order = c.order()
      const index = order.findIndex((w) => w.id === c.ws?.id)
      const next = order[index + (c.event.code === 'PageDown' ? 1 : -1)]
      if (next) c.actions.selectWorkspace(next.id)
    }
  },
  {
    id: 'workspace.nextAttention',
    keys: k('mod+alt+KeyL'),
    group: 'workspaces',
    scope: 'app',
    labelKey: 'shortcuts.nextAttention',
    run: (c) => void goToNextAttention(c)
  },
  { id: 'workspace.run', keys: k('mod+KeyR'), group: 'workspaces', scope: 'app', labelKey: 'shortcuts.runStop', when: inWorkspace, run: (c) => c.actions.command('run', c.ws!.id) },
  { id: 'workspace.preview', keys: k('mod+shift+KeyB'), group: 'workspaces', scope: 'app', labelKey: 'shortcuts.openPreview', when: (c) => Boolean(c.ws && !c.ws.cloud), run: (c) => c.actions.openPreview(c.ws!.id) },

  // ---- Chat ----
  { id: 'chat.find', keys: k('mod+KeyF'), group: 'chat', scope: 'chat', labelKey: 'chatFind.label', handledBy: 'ChatSearch' },
  // The chat's find bar, while open, takes ⌘G in the capture phase, ahead of the Open PR git key below.
  { id: 'chat.findNext', keys: k('mod+KeyG / mod+shift+KeyG'), group: 'chat', scope: 'chat-find', labelKey: 'shortcuts.nextPrevMatch', overrides: gitShortcutId('open-pr'), handledBy: 'ChatSearch' },
  { id: 'chat.new', keys: k('mod+KeyT'), group: 'chat', scope: 'app', labelKey: 'palette.newChat', when: inWorkspace, run: (c) => c.actions.newChat(c.ws!.id) },
  // With a browser tab showing, ⌘W closes it; otherwise the chat.
  { id: 'browser.closeTab', keys: k('mod+KeyW'), group: 'chat', scope: 'browser', labelKey: 'shortcuts.closeBrowserTab', overrides: 'chat.close', when: (c) => Boolean(c.ws && c.state.browserTabs[c.ws.id]?.active), run: (c) => c.actions.closeBrowserTab(c.ws!.id) },
  { id: 'chat.close', keys: k('mod+KeyW'), group: 'chat', scope: 'app', labelKey: 'shortcuts.closeChat', when: inChat, run: (c) => c.actions.closeChat(c.ws!.id, c.session!.id) },
  { id: 'chat.reopen', keys: k('mod+shift+KeyT'), group: 'chat', scope: 'app', labelKey: 'shortcuts.reopenChat', when: inWorkspace, run: (c) => c.actions.reopenChat(c.ws!.id) },
  // Text selected in a Setup log goes to chat; otherwise the composer takes focus.
  { id: 'composer.focus', keys: k('mod+KeyL'), group: 'chat', scope: 'app', labelKey: 'shortcuts.focusComposer', when: inWorkspace, run: (c) => c.actions.focusComposer(c.ws!.id) },
  { id: 'picker.toggle', keys: k('mod+Slash'), group: 'chat', scope: 'app', labelKey: 'shortcuts.picker', when: inWorkspace, run: (c) => c.actions.command('toggle-picker', c.ws!.id) },
  { id: 'effort.cycle', keys: k('mod+shift+Slash'), group: 'chat', scope: 'app', labelKey: 'shortcuts.cycleEffort', when: inWorkspace, run: (c) => c.actions.command('cycle-effort', c.ws!.id) },
  { id: 'fast.toggle', keys: k('mod+shift+KeyE'), group: 'chat', scope: 'app', labelKey: 'shortcuts.fastMode', when: inWorkspace, run: (c) => c.actions.command('toggle-fast', c.ws!.id) },
  { id: 'plan.toggle', keys: k('shift+Tab'), group: 'chat', scope: 'chat', labelKey: 'shortcuts.planMode', handledBy: 'Composer' },
  {
    id: 'loadout.use',
    keys: k('mod+ctrl+Digit1-5', 'mod+shift+Digit1-5'),
    group: 'chat',
    scope: 'app',
    labelKey: 'shortcuts.useLoadout',
    when: inChat,
    run: (c) => {
      const session = c.session!
      const hasHistory = Boolean(session.agentSessionId) || Boolean(c.state.chats[session.id]?.some((i) => i.kind === 'user'))
      c.actions.equipLoadout(session, hasHistory, (digitOf(c.event) ?? 1) - 1)
    }
  },
  { id: 'attach.files', keys: k('mod+KeyU'), group: 'chat', scope: 'app', labelKey: 'shortcuts.attachFiles', when: inWorkspace, run: (c) => c.actions.command('attach', c.ws!.id) },
  { id: 'templates.toggle', keys: k('mod+KeyJ'), group: 'chat', scope: 'app', labelKey: 'shortcuts.templates', when: inWorkspace, run: (c) => c.actions.command('toggle-templates', c.ws!.id) },
  { id: 'agent.stop', keys: k('Escape'), group: 'chat', scope: 'chat', labelKey: 'shortcuts.stopAgent', handledBy: 'Composer' },
  { id: 'agent.cancel', keys: k('mod+shift+Backspace'), group: 'chat', scope: 'app', labelKey: 'shortcuts.stopAgent', when: inWorkspace, run: (c) => c.actions.command('cancel', c.ws!.id) },
  { id: 'plan.approve', keys: k('mod+shift+Enter'), group: 'chat', scope: 'chat', labelKey: 'shortcuts.approvePlan', handledBy: 'Composer' },
  {
    // Capture phase: the composer would otherwise take ⌘↵ as send before a bubbling listener saw it.
    id: 'chat.fork',
    keys: k('mod+alt+Enter'),
    group: 'chat',
    scope: 'app',
    labelKey: 'shortcuts.forkChat',
    capture: true,
    when: (c) => Boolean(c.snapshot.settings.forkToNewTab && !c.state.settingsPage && c.ws && c.session),
    run: (c) => c.actions.forkChat(c.ws!.id, c.session!.id)
  },
  // Ctrl, not ⌘, on macOS too. A terminal keeps Ctrl+O for itself.
  { id: 'chat.toolCalls', keys: k('ctrl+KeyO'), group: 'chat', scope: 'app', labelKey: 'shortcuts.toolCalls', when: (c) => !(c.event.target as Element | null)?.closest?.('.terminal'), run: (c) => c.actions.toggleToolCalls() },
  // Jump keys for a screen reader (accessibility plan, phase A2). Each one moves focus to a heading in the chat on screen,
  // never to a container. Ctrl+Alt+brackets and period: not NVDA's Ctrl+Alt+N or the Ctrl+Alt+Arrow table keys (RESERVED_WIN).
  { id: 'chat.latestReply', keys: k('mod+alt+]'), group: 'chat', scope: 'app', labelKey: 'shortcuts.latestReply', when: inChat, run: (c) => c.actions.command('chat-latest-reply', c.ws!.id) },
  { id: 'chat.previousTurn', keys: k('mod+alt+['), group: 'chat', scope: 'app', labelKey: 'shortcuts.previousTurn', when: inChat, run: (c) => c.actions.command('chat-previous-turn', c.ws!.id) },
  {
    // The open chat's own approval, question or plan first; else the next chat that needs attention, whose panel then takes focus.
    id: 'chat.needsMe',
    keys: k('mod+alt+.'),
    group: 'chat',
    scope: 'app',
    labelKey: 'shortcuts.needsMe',
    run: (c) => {
      const here = c.session && c.state.approvals.some((a) => a.sessionId === c.session!.id)
      if (here) return c.actions.command('chat-needs-me', c.ws!.id)
      const target = goToNextAttention(c)
      // The chat opens on the next tick; its panel is what needs the user (an unread chat has none, and stays as it opens).
      if (target) setTimeout(() => c.actions.command('chat-needs-me', target.workspaceId), 0)
      else if (c.ws) c.actions.command('chat-needs-none', c.ws.id)
    }
  },

  // ---- Terminal ----
  { id: 'terminal.find', keys: k('mod+KeyF'), group: 'terminal', scope: 'terminal', labelKey: 'shortcuts.findTerminal', handledBy: 'Terminal' },
  { id: 'terminal.findNext', keys: k('Enter / shift+Enter'), group: 'terminal', scope: 'terminal', labelKey: 'shortcuts.nextPrevMatch', handledBy: 'Terminal' },
  { id: 'terminal.zoom', keys: k('mod+Equal / mod+Minus'), group: 'terminal', scope: 'terminal', labelKey: 'shortcuts.zoom', handledBy: 'Terminal' },
  { id: 'terminal.zoomReset', keys: k('mod+Digit0'), group: 'terminal', scope: 'terminal', labelKey: 'shortcuts.resetZoom', handledBy: 'Terminal' },
  // ⌘⇧M is Merge PR, so the fullscreen key is ⌘⇧J.
  { id: 'terminal.fullscreen', keys: k('mod+shift+KeyJ'), group: 'terminal', scope: 'app', labelKey: 'shortcuts.terminalFullscreen', when: inWorkspace, run: (c) => c.actions.toggleTerminalFullscreen(c.ws!.id) },
  { id: 'terminal.rename', keys: k('', ''), display: 'shortcuts.doubleClickTab', group: 'terminal', scope: 'terminal', labelKey: 'shortcuts.renameIt', handledBy: 'Terminal' },

  // ---- Files ----
  { id: 'file.quickOpen', keys: k('mod+KeyP'), group: 'files', scope: 'app', labelKey: 'shortcuts.openFile', when: inWorkspace, run: (c) => c.actions.openOverlay('quick-open') },
  { id: 'search.open', keys: k('mod+shift+KeyF'), group: 'files', scope: 'app', labelKey: 'shortcuts.searchFilesChats', run: (c) => c.actions.openOverlay('search') },
  { id: 'changes.uncommitted', keys: k('mod+alt+KeyU'), group: 'files', scope: 'app', labelKey: 'shortcuts.uncommitted', handledBy: 'WorkspaceView' },
  { id: 'file.edit', keys: k('mod+KeyE'), group: 'files', scope: 'file-viewer', labelKey: 'shortcuts.editFile', handledBy: 'FileViewer' },
  { id: 'file.save', keys: k('mod+KeyS'), group: 'files', scope: 'file-viewer', labelKey: 'shortcuts.saveFile', handledBy: 'FileViewer' },

  // ---- Git ----
  ...GIT_SHORTCUTS.map(
    ([key, action, labelKey]): ShortcutEntry => ({ id: gitShortcutId(action), keys: k(`mod+shift+${key}`), group: 'git', scope: 'app', labelKey, when: inWorkspace, run: (c) => c.actions.runGit(c.ws!.id, action) })
  ),

  // ---- Approvals (live while an approval or question has focus) ----
  { id: 'approval.yes', keys: k('Enter'), group: 'approvals', scope: 'approvals', labelKey: 'shortcuts.yes', handledBy: 'ApprovalPanel' },
  { id: 'approval.always', keys: k('mod+Enter'), group: 'approvals', scope: 'approvals', labelKey: 'shortcuts.yesAlways', handledBy: 'ApprovalPanel' },
  { id: 'approval.no', keys: k('Backspace'), group: 'approvals', scope: 'approvals', labelKey: 'shortcuts.no', handledBy: 'ApprovalPanel' },
  { id: 'approval.answer', keys: k('Digit1-9 / Digit0'), group: 'approvals', scope: 'approvals', labelKey: 'shortcuts.answerOptions', handledBy: 'ApprovalPanel' },
  // Diff rows (Changes): from a hunk heading, arrows walk the lines; the selection is announced.
  { id: 'diff.rowNext', keys: k('ArrowDown / ArrowUp'), group: 'files', scope: 'diff', labelKey: 'shortcuts.diffRows', handledBy: 'Changes' },
  { id: 'diff.selectExtend', keys: k('shift+ArrowDown / shift+ArrowUp'), group: 'files', scope: 'diff', labelKey: 'shortcuts.diffExtend', handledBy: 'Changes' },
  { id: 'diff.half', keys: k('ArrowLeft / ArrowRight'), group: 'files', scope: 'diff', labelKey: 'shortcuts.diffHalf', handledBy: 'Changes' },
  { id: 'diff.comment', keys: k('Enter'), group: 'files', scope: 'diff', labelKey: 'shortcuts.diffComment', handledBy: 'Changes' },
  { id: 'diff.selectClear', keys: k('Escape'), group: 'files', scope: 'diff', labelKey: 'shortcuts.diffClear', handledBy: 'Changes' }
]

// ---- For the help sheet and the palette ----

export const GROUP_LABELS: Record<ShortcutGroup, PlainKey> = {
  general: 'shortcuts.group.general',
  workspaces: 'shortcuts.group.workspaces',
  chat: 'shortcuts.group.chat',
  terminal: 'shortcuts.group.terminal',
  files: 'shortcuts.group.files',
  git: 'shortcuts.group.git',
  approvals: 'shortcuts.group.approvals'
}

/** The registry grouped for the help sheet, in group order. */
export function groupedShortcuts(entries: readonly ShortcutEntry[] = SHORTCUTS): { group: ShortcutGroup; entries: ShortcutEntry[] }[] {
  return (Object.keys(GROUP_LABELS) as ShortcutGroup[]).map((group) => ({ group, entries: entries.filter((e) => e.group === group) })).filter((g) => g.entries.length > 0)
}

/** The palette's hint for an entry, formatted for the platform; undefined if there is no such entry or it has no chord. */
export function shortcutHint(id: string, platform: string | undefined): string | undefined {
  const entry = SHORTCUTS.find((e) => e.id === id)
  const hint = entry ? formatKeys(entry, platform) : ''
  return hint || undefined
}
