// The keyboard walk (accessibility plan, TESTING.md layer 4): a key script played against the real app on the screens
// fixture, with what a screen reader would meet recorded after every key. This module is pure so tests can run it: the
// walk format, the chord parser behind the key events, `runWalk` over a driver, and `compareTranscript`. The driver that
// presses real keys through the DevTools protocol and reads the page lives in screenshots.ts, the page's side in
// renderer/src/walk.ts, the scripts in walks.ts.

/** What has focus: a role and accessible name worked out from ARIA and text (renderer/src/walk.ts), the tag, a heading's level. */
export interface FocusInfo {
  role: string
  name: string
  tag: string
  level?: number
}

/** One look at the page after a key. `announced` is the live region's text; `nonce` changes with every announcement. */
export interface Reading {
  activeElement: FocusInfo
  announced: string
  nonce?: number
  /** For each selector a step asks about: whether anything matches it. */
  present?: Record<string, boolean>
}

/** Patterns are regular expression sources, unanchored, tested case-sensitively: `^Turn \d+`, `Selected 2 lines`. */
export interface FocusExpect {
  role?: string
  name?: string
  tag?: string
  level?: number
}

export interface StepExpect {
  focus?: FocusExpect
  /** Matched against what was announced after this key (and since the last one); '^$' asserts silence. */
  announced?: string
  /** Selectors that must match something / nothing after the key. */
  present?: string[]
  absent?: string[]
}

export interface WalkStep {
  /** A chord as the shortcut registry writes it (`mod+alt+]`, `shift+ArrowDown`) or a key name (`Tab`, `Enter`). */
  key: string
  expect?: StepExpect
  /** Press the key again until focus matches, at most `max` times (default 120). For "Tab to the No button". */
  until?: { focus: FocusExpect; max?: number }
}

export interface Walk {
  name: string
  /** A screen of the screens run (renderer/src/screens.ts), which the walk starts on. */
  screen: string
  /** A real approval request for the fixture chat, made before the first key; the walk says how it must end up answered. */
  approval?: { expect: 'denied' | 'approved' }
  /** A selector to wait for after the screen shows and any setup is done. */
  waitFor?: string
  steps: WalkStep[]
}

export interface TranscriptStep {
  key: string
  /** How many times the key was pressed (more than one with `until`). */
  presses: number
  activeElement: FocusInfo
  announced: string
  present?: Record<string, boolean>
}

export interface Transcript {
  name: string
  screen: string
  steps: TranscriptStep[]
  /** Set by the runner for what happened outside the page, such as how the approval was answered. */
  outcome?: Record<string, string>
}

/** The shape a transcript is compared against: a walk, or a file next to the fixture with the same `steps`. */
export interface ExpectedTranscript {
  name?: string
  steps: { key: string; expect?: StepExpect }[]
}

export interface WalkDriver {
  /** A look at the page before the first key, so announcements from setup are not taken for the first key's. */
  start?(): Promise<void>
  press(key: string): Promise<void>
  read(watch: string[]): Promise<Reading>
}

export interface RunOptions {
  /** Wait after the last press of a step, before reading: longer than the announcer's 700 ms delay. */
  settleMs?: number
  /** Wait between the presses of an `until` repeat. */
  repeatMs?: number
  delay?: (ms: number) => Promise<void>
}

// ---- Chords ----

export type KeyPlatform = 'mac' | 'win'
export const platformOf = (platform: string): KeyPlatform => (platform === 'darwin' || platform === 'mac' ? 'mac' : 'win')

export interface KeyDescriptor {
  /** KeyboardEvent.code, which is what the shortcut registry matches on. */
  code: string
  key: string
  windowsVirtualKeyCode: number
  /** The character the key types; only for a key pressed without Ctrl, Alt or Cmd. */
  text?: string
}

export interface ParsedChord extends KeyDescriptor {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

// The same shorthand the registry accepts (shortcuts.ts CHAR_CODES): a printable character stands for its code.
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

const NAMED: Record<string, { key: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', vk: 9 },
  Escape: { key: 'Escape', vk: 27 },
  Space: { key: ' ', vk: 32, text: ' ' },
  Backspace: { key: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', vk: 46 },
  PageUp: { key: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', vk: 34 },
  End: { key: 'End', vk: 35 },
  Home: { key: 'Home', vk: 36 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', vk: 40 },
  BracketRight: { key: ']', vk: 221, text: ']' },
  BracketLeft: { key: '[', vk: 219, text: '[' },
  Period: { key: '.', vk: 190, text: '.' },
  Comma: { key: ',', vk: 188, text: ',' },
  Slash: { key: '/', vk: 191, text: '/' },
  Equal: { key: '=', vk: 187, text: '=' },
  Minus: { key: '-', vk: 189, text: '-' },
  Backslash: { key: '\\', vk: 220, text: '\\' },
  Semicolon: { key: ';', vk: 186, text: ';' },
  Quote: { key: "'", vk: 222, text: "'" },
  Backquote: { key: '`', vk: 192, text: '`' }
}

const ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', ' ': 'Space' }

/** The key a token names, `mod`/`ctrl`/`alt`/`shift`/`meta` aside: 'Tab', 'KeyK', 'k', 'Digit1', '1', ']', 'BracketRight'. */
export function describeKey(token: string, shift = false): KeyDescriptor {
  const named = ALIASES[token] ?? CHAR_CODES[token] ?? token
  const entry = NAMED[named]
  if (entry) return { code: named, key: entry.key, windowsVirtualKeyCode: entry.vk, ...(entry.text ? { text: entry.text } : {}) }
  const letter = /^Key([A-Z])$/.exec(named) ?? (/^[a-zA-Z]$/.test(named) ? [named, named.toUpperCase()] : null)
  if (letter) {
    const char = shift ? letter[1] : letter[1].toLowerCase()
    return { code: `Key${letter[1]}`, key: char, windowsVirtualKeyCode: letter[1].charCodeAt(0), text: char }
  }
  const digit = /^Digit(\d)$/.exec(named) ?? (/^\d$/.test(named) ? [named, named] : null)
  if (digit) return { code: `Digit${digit[1]}`, key: digit[1], windowsVirtualKeyCode: 48 + Number(digit[1]), text: digit[1] }
  throw new Error(`Unknown key "${token}" in a walk`)
}

/** `mod+alt+]`: modifiers, then one key. `mod` is Cmd on macOS and Ctrl elsewhere, as in the shortcut registry. */
export function parseChord(chord: string, platform: string): ParsedChord {
  const plus = chord.endsWith('++') || chord === '+'
  const parts = (plus ? chord.slice(0, -1) : chord).split('+').map((p) => p.trim())
  const token = plus ? '+' : (parts.pop() ?? '')
  if (!token) throw new Error(`Empty chord "${chord}"`)
  const mods = new Set(parts.filter(Boolean).map((p) => p.toLowerCase()))
  for (const mod of mods) if (!['mod', 'ctrl', 'alt', 'shift', 'meta'].includes(mod)) throw new Error(`Unknown modifier "${mod}" in "${chord}"`)
  const mac = platformOf(platform) === 'mac'
  const ctrl = mods.has('ctrl') || (!mac && mods.has('mod'))
  const meta = mods.has('meta') || (mac && mods.has('mod'))
  const alt = mods.has('alt')
  const shift = mods.has('shift')
  const key = describeKey(token, shift)
  // A chord with Ctrl, Alt or Cmd types nothing.
  const types = !ctrl && !alt && !meta
  const { text, ...rest } = key
  return { ...rest, ...(types && text ? { text } : {}), ctrl, meta, alt, shift }
}

export interface KeyEventParams {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  modifiers: number
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  text?: string
  unmodifiedText?: string
}

/** The DevTools protocol events (Input.dispatchKeyEvent) for pressing a chord: a down and an up, trusted like a real key. */
export function keyEvents(chord: string, platform: string): KeyEventParams[] {
  const c = parseChord(chord, platform)
  // Input.dispatchKeyEvent: Alt 1, Ctrl 2, Meta 4, Shift 8.
  const modifiers = (c.alt ? 1 : 0) | (c.ctrl ? 2 : 0) | (c.meta ? 4 : 0) | (c.shift ? 8 : 0)
  const base = { modifiers, key: c.key, code: c.code, windowsVirtualKeyCode: c.windowsVirtualKeyCode, nativeVirtualKeyCode: c.windowsVirtualKeyCode }
  return [
    { type: c.text ? 'keyDown' : 'rawKeyDown', ...base, ...(c.text ? { text: c.text, unmodifiedText: c.text } : {}) },
    { type: 'keyUp', ...base }
  ]
}

// ---- Matching and running ----

/** Whether `value` matches the pattern (a regular expression source). A pattern that is not valid never matches. */
export function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

const focusMisses = (expect: FocusExpect, actual: FocusInfo): [field: string, expected: string, actual: string][] => {
  const out: [string, string, string][] = []
  if (expect.role !== undefined && !matches(expect.role, actual.role)) out.push(['focus.role', expect.role, actual.role])
  if (expect.name !== undefined && !matches(expect.name, actual.name)) out.push(['focus.name', expect.name, actual.name])
  if (expect.tag !== undefined && !matches(expect.tag, actual.tag)) out.push(['focus.tag', expect.tag, actual.tag])
  if (expect.level !== undefined && expect.level !== actual.level) out.push(['focus.level', String(expect.level), String(actual.level ?? '')])
  return out
}

export const focusMatches = (expect: FocusExpect, actual: FocusInfo): boolean => focusMisses(expect, actual).length === 0

/** Every selector the walk's expectations ask about, so the driver reads just those. */
export function watchedSelectors(expect: StepExpect | undefined): string[] {
  return [...(expect?.present ?? []), ...(expect?.absent ?? [])]
}

/**
 * Plays a walk: each step presses its key (again and again with `until`), waits `settleMs`, then reads the page. What a
 * step announced is the live region's text when its nonce changed since the last look, so an earlier step's sentence
 * (held for ten seconds) is not counted twice.
 */
export async function runWalk(driver: WalkDriver, walk: Walk, options: RunOptions = {}): Promise<Transcript> {
  const { settleMs = 900, repeatMs = 40, delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options
  await driver.start?.()
  let seen = (await driver.read([])).nonce
  const steps: TranscriptStep[] = []
  for (const step of walk.steps) {
    const watch = watchedSelectors(step.expect)
    let presses = 0
    if (step.until) {
      const max = step.until.max ?? 120
      while (presses < max) {
        await driver.press(step.key)
        presses++
        await delay(repeatMs)
        if (focusMatches(step.until.focus, (await driver.read([])).activeElement)) break
      }
    } else {
      await driver.press(step.key)
      presses = 1
    }
    await delay(settleMs)
    const reading = await driver.read(watch)
    const fresh = reading.nonce === undefined || reading.nonce !== seen
    seen = reading.nonce
    steps.push({
      key: step.key,
      presses,
      activeElement: reading.activeElement,
      announced: fresh ? reading.announced : '',
      ...(watch.length ? { present: reading.present ?? {} } : {})
    })
  }
  return { name: walk.name, screen: walk.screen, steps }
}

export interface StepDiff {
  /** 1-based; 0 for the walk as a whole. */
  step: number
  key: string
  field: string
  expected: string
  actual: string
}

/** Where the transcript differs from what was expected, one entry per field that does not match; empty when it matches. */
export function compareTranscript(expected: ExpectedTranscript, actual: Transcript): StepDiff[] {
  const diffs: StepDiff[] = []
  if (expected.steps.length !== actual.steps.length) diffs.push({ step: 0, key: '', field: 'steps', expected: String(expected.steps.length), actual: String(actual.steps.length) })
  const count = Math.min(expected.steps.length, actual.steps.length)
  for (let i = 0; i < count; i++) {
    const want = expected.steps[i]
    const got = actual.steps[i]
    const add = (field: string, exp: string, act: string) => diffs.push({ step: i + 1, key: got.key, field, expected: exp, actual: act })
    if (want.key !== got.key) {
      add('key', want.key, got.key)
      continue
    }
    const expect = want.expect
    if (!expect) continue
    if (expect.focus) for (const [field, exp, act] of focusMisses(expect.focus, got.activeElement)) add(field, exp, act)
    if (expect.announced !== undefined && !matches(expect.announced, got.announced)) add('announced', expect.announced, got.announced)
    for (const selector of expect.present ?? []) if (got.present?.[selector] !== true) add(`present ${selector}`, 'present', got.present?.[selector] === false ? 'absent' : 'not read')
    for (const selector of expect.absent ?? []) if (got.present?.[selector] !== false) add(`absent ${selector}`, 'absent', got.present?.[selector] === true ? 'present' : 'not read')
  }
  return diffs
}

/** A diff as lines for the run's summary. */
export function formatDiffs(name: string, diffs: readonly StepDiff[]): string[] {
  return diffs.map((d) => `${name}${d.step ? ` step ${d.step} (${d.key})` : ''}: ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`)
}

/** One line per step for the summary: the key, the focus and what was announced. */
export function formatTranscript(transcript: Transcript): string[] {
  return transcript.steps.map((s, i) => {
    const focus = `${s.activeElement.role || s.activeElement.tag}${s.activeElement.level ? ` ${s.activeElement.level}` : ''} "${s.activeElement.name}"`
    return `  ${i + 1}. ${s.key}${s.presses > 1 ? ` x${s.presses}` : ''} -> ${focus}${s.announced ? `; said "${s.announced}"` : ''}`
  })
}
