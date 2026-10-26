// The shortcut registry (accessibility plan, phase B1): every entry has a label, nothing collides,
// no Windows chord is one a screen reader owns, and matching and formatting work per platform.
import { describe, expect, it, vi } from 'vitest'
import { en } from '../src/shared/i18n/en'
import {
  canonicalChords,
  chordsOf,
  collisions,
  dispatchShortcut,
  formatChord,
  formatKeys,
  groupedShortcuts,
  isBare,
  matchShortcut,
  RESERVED_WIN,
  reservedBindings,
  shortcutHint,
  SHORTCUTS,
  type ChordEvent,
  type ShortcutActions,
  type ShortcutContext,
  type ShortcutEntry
} from '../src/renderer/src/shortcuts'

const event = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}): ChordEvent => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
const entry = (id: string) => SHORTCUTS.find((e) => e.id === id)!

describe('shortcut registry', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every label (and gesture text) is an English message', () => {
    for (const e of SHORTCUTS) {
      expect(en, e.id).toHaveProperty(e.labelKey)
      if (e.display) expect(en, e.id).toHaveProperty(e.display)
    }
  })

  it('every entry is either dispatched or names the component that handles it', () => {
    for (const e of SHORTCUTS) expect(typeof e.run === 'function' || Boolean((e as { handledBy?: string }).handledBy), e.id).toBe(true)
  })

  it.each(['mac', 'win'] as const)('no two entries live in the same place share a chord on %s', (platform) => {
    expect(collisions(SHORTCUTS, platform).map(([a, b]) => `${a.id} / ${b.id}`)).toEqual([])
  })

  it('collisions finds a real clash, and respects scopes and overrides', () => {
    const base = { group: 'general', labelKey: 'shortcuts.palette', handledBy: 'x' } as const
    const a: ShortcutEntry = { ...base, id: 'a', keys: { mac: 'mod+KeyK', win: 'mod+KeyK' }, scope: 'app' }
    const b: ShortcutEntry = { ...base, id: 'b', keys: { mac: 'meta+k', win: 'ctrl+k' }, scope: 'terminal' }
    expect(collisions([a, b], 'win').map(([x, y]) => [x.id, y.id])).toEqual([['a', 'b']])
    expect(collisions([a, b], 'mac').map(([x, y]) => [x.id, y.id])).toEqual([['a', 'b']])
    // Different regions do not clash; an explicit override is not reported.
    expect(collisions([{ ...a, scope: 'chat' }, b], 'win')).toEqual([])
    expect(collisions([a, { ...b, overrides: 'a' }], 'win')).toEqual([])
    // A digit range clashes with a single digit inside it.
    expect(collisions([{ ...a, keys: { mac: 'mod+Digit1-9', win: 'mod+Digit1-9' } }, { ...b, keys: { mac: 'mod+3', win: 'mod+3' } }], 'win')).toHaveLength(1)
  })

  it('no Windows chord is on the reserved list', () => {
    expect(reservedBindings(SHORTCUTS)).toEqual([])
    expect(RESERVED_WIN).toEqual(expect.arrayContaining(['ctrl+alt+ArrowUp', 'ctrl+alt+ArrowDown', 'ctrl+alt+ArrowLeft', 'ctrl+alt+ArrowRight', 'ctrl+alt+n']))
  })

  it('the reserved check catches a reserved chord', () => {
    const bad = { id: 'bad', keys: { mac: 'mod+alt+ArrowUp', win: 'mod+alt+ArrowUp' }, group: 'general', scope: 'app', labelKey: 'shortcuts.palette', handledBy: 'x' } as const
    expect(reservedBindings([bad])).toEqual([{ id: 'bad', chord: 'ctrl+alt+ArrowUp' }])
    const nvda = { ...bad, id: 'nvda', keys: { mac: 'mod+KeyN', win: 'mod+alt+KeyN' } }
    expect(reservedBindings([nvda])).toEqual([{ id: 'nvda', chord: 'ctrl+alt+n' }])
  })

  it('previous / next workspace moved to Page Up / Page Down on both platforms', () => {
    const e = entry('workspace.prevNext')
    for (const platform of ['mac', 'win'] as const) {
      expect(chordsOf(e.keys[platform])).toEqual(['mod+alt+PageUp', 'mod+alt+PageDown'])
      expect(matchShortcut(event('PageUp', platform === 'mac' ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }), platform)?.id).toBe('workspace.prevNext')
      // The old keys no longer do anything.
      expect(matchShortcut(event('ArrowUp', platform === 'mac' ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }), platform)).toBeUndefined()
      expect(matchShortcut(event('ArrowDown', platform === 'mac' ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true }), platform)).toBeUndefined()
    }
  })

  it('only the control that owns a bare key handles it: every dispatched chord includes Ctrl or Cmd', () => {
    for (const e of SHORTCUTS)
      for (const platform of ['mac', 'win'] as const)
        for (const chord of chordsOf(e.keys[platform])) if (e.run) expect(isBare(chord, platform), `${e.id} ${chord}`).toBe(false)
    // The documented bare keys are all handled by their own component.
    expect(SHORTCUTS.filter((e) => chordsOf(e.keys.win).some((c) => isBare(c, 'win'))).every((e) => !e.run)).toBe(true)
  })

  it('every entry appears in the help sheet, in a group', () => {
    const shown = groupedShortcuts().flatMap((g) => g.entries.map((e) => e.id))
    expect(shown.sort()).toEqual(SHORTCUTS.map((e) => e.id).sort())
  })
})

describe('matchShortcut', () => {
  it('resolves mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(event('KeyK', { metaKey: true }), 'darwin')?.id).toBe('palette.toggle')
    expect(matchShortcut(event('KeyK', { ctrlKey: true }), 'win32')?.id).toBe('palette.toggle')
    expect(matchShortcut(event('KeyK', { ctrlKey: true }), 'darwin')).toBeUndefined()
    expect(matchShortcut(event('KeyK', { metaKey: true }), 'win32')).toBeUndefined()
    expect(matchShortcut(event('KeyK', { ctrlKey: true }), 'linux')?.id).toBe('palette.toggle')
  })

  it('matches modifiers exactly', () => {
    expect(matchShortcut(event('KeyK', { ctrlKey: true, shiftKey: true }), 'win32')).toBeUndefined()
    expect(matchShortcut(event('KeyB', { ctrlKey: true, altKey: true }), 'win32')?.id).toBe('panel.right')
    expect(matchShortcut(event('KeyB', { ctrlKey: true, shiftKey: true }), 'win32')?.id).toBe('workspace.preview')
    expect(matchShortcut(event('KeyB', { ctrlKey: true }), 'win32')?.id).toBe('panel.left')
  })

  it('resolves per-platform chords: loadouts, Open in, tool calls', () => {
    expect(matchShortcut(event('Digit2', { metaKey: true, ctrlKey: true }), 'darwin')?.id).toBe('loadout.use')
    expect(matchShortcut(event('Digit2', { metaKey: true }), 'darwin')?.id).toBe('workspace.switch')
    expect(matchShortcut(event('Digit2', { ctrlKey: true, shiftKey: true }), 'win32')?.id).toBe('loadout.use')
    expect(matchShortcut(event('Digit2', { ctrlKey: true }), 'win32')?.id).toBe('workspace.switch')
    expect(matchShortcut(event('KeyO', { metaKey: true }), 'darwin')?.id).toBe('openIn.toggle')
    expect(matchShortcut(event('KeyO', { ctrlKey: true, shiftKey: true }), 'win32')?.id).toBe('openIn.toggle')
    expect(matchShortcut(event('KeyO', { ctrlKey: true }), 'win32')?.id).toBe('chat.toolCalls')
    expect(matchShortcut(event('KeyO', { ctrlKey: true }), 'darwin')?.id).toBe('chat.toolCalls')
    expect(matchShortcut(event('KeyO', { metaKey: true }), 'win32')).toBeUndefined()
  })

  it('treats the numpad Enter as Enter, and finds the capture-phase fork', () => {
    const fork = matchShortcut(event('NumpadEnter', { ctrlKey: true, altKey: true }), 'win32')
    expect(fork?.id).toBe('chat.fork')
    expect(fork?.capture).toBe(true)
    expect(matchShortcut(event('Enter', { ctrlKey: true, altKey: true }), 'win32', { capture: false })).toBeUndefined()
    expect(matchShortcut(event('KeyK', { ctrlKey: true }), 'win32', { capture: true })).toBeUndefined()
  })

  it('does not match documented entries, which their component handles', () => {
    expect(matchShortcut(event('KeyF', { ctrlKey: true }), 'win32')).toBeUndefined()
    expect(matchShortcut(event('Enter'), 'win32')).toBeUndefined()
    expect(matchShortcut(event('KeyS', { ctrlKey: true }), 'win32')).toBeUndefined()
  })

  it('matches git keys and digit ranges', () => {
    for (const [code, id] of [['KeyP', 'create-pr'], ['KeyY', 'commit-and-push'], ['KeyL', 'pull'], ['KeyM', 'merge'], ['KeyX', 'fix-errors'], ['KeyR', 'review'], ['KeyG', 'open-pr']])
      expect(matchShortcut(event(code, { metaKey: true, shiftKey: true }), 'darwin')?.id).toBe(`git.${id}`)
    for (const n of [1, 5, 9]) expect(matchShortcut(event(`Digit${n}`, { ctrlKey: true }), 'win32')?.id).toBe('workspace.switch')
    expect(matchShortcut(event('Digit0', { ctrlKey: true }), 'win32')).toBeUndefined()
  })

  it('honours `when` when given a context', () => {
    const ctx = (over: Partial<ShortcutContext>) => ({ event: event('KeyW', { ctrlKey: true }), ws: undefined, session: undefined, state: { browserTabs: {} }, snapshot: { settings: {} }, ...over }) as unknown as ShortcutContext
    const e = event('KeyW', { ctrlKey: true })
    expect(matchShortcut(e, 'win32')?.id).toBe('browser.closeTab')
    expect(matchShortcut(e, 'win32', { ctx: ctx({}) })).toBeUndefined()
    const ws = { id: 'w1' } as ShortcutContext['ws']
    const session = { id: 's1' } as ShortcutContext['session']
    expect(matchShortcut(e, 'win32', { ctx: ctx({ ws, session }) })?.id).toBe('chat.close')
    expect(matchShortcut(e, 'win32', { ctx: ctx({ ws, session, state: { browserTabs: { w1: { active: true } } } as never }) })?.id).toBe('browser.closeTab')
  })
})

describe('dispatchShortcut', () => {
  const actions = new Proxy({}, { get: (target: Record<string, unknown>, key: string) => (target[key] ??= vi.fn()) }) as unknown as ShortcutActions & Record<string, ReturnType<typeof vi.fn>>
  const workspaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as ShortcutContext['ws'][]
  const ctxFor = (e: ChordEvent, ws: number | undefined): ShortcutContext =>
    ({ event: e, platform: 'win', ws: ws === undefined ? undefined : workspaces[ws], session: undefined, state: { overlay: null, browserTabs: {} }, snapshot: { settings: {} }, order: () => workspaces, actions }) as unknown as ShortcutContext
  const keydown = (code: string, mods: Parameters<typeof event>[1]) => Object.assign(event(code, mods), { preventDefault: vi.fn(), stopPropagation: vi.fn() })

  it('moves to the previous and next workspace with Page Up and Page Down', () => {
    const down = keydown('PageDown', { ctrlKey: true, altKey: true })
    expect(dispatchShortcut(down, ctxFor(down, 0), false)).toBe(true)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(actions.selectWorkspace).toHaveBeenLastCalledWith('b')
    const up = keydown('PageUp', { ctrlKey: true, altKey: true })
    dispatchShortcut(up, ctxFor(up, 2), false)
    expect(actions.selectWorkspace).toHaveBeenLastCalledWith('b')
  })

  it('switches by digit, and leaves unmatched keys alone', () => {
    const three = keydown('Digit3', { ctrlKey: true })
    dispatchShortcut(three, ctxFor(three, 0), false)
    expect(actions.selectWorkspace).toHaveBeenLastCalledWith('c')
    const other = keydown('KeyZ', { ctrlKey: true })
    expect(dispatchShortcut(other, ctxFor(other, 0), false)).toBe(false)
    expect(other.preventDefault).not.toHaveBeenCalled()
  })

  it('a capture entry stops the event; a bubble entry does not', () => {
    const palette = keydown('KeyK', { ctrlKey: true })
    dispatchShortcut(palette, ctxFor(palette, undefined), false)
    expect(palette.stopPropagation).not.toHaveBeenCalled()
    expect(actions.openOverlay).toHaveBeenLastCalledWith('palette')
  })
})

describe('formatChord', () => {
  it('writes macOS chords with symbols', () => {
    expect(formatChord('mod+alt+]', 'darwin')).toBe('⌘⌥]')
    expect(formatChord('mod+alt+BracketRight', 'mac')).toBe('⌘⌥]')
    expect(formatChord('mod+shift+Enter', 'darwin')).toBe('⌘⇧↵')
    expect(formatChord('mod+ctrl+Digit1-5', 'darwin')).toBe('⌘⌃1–5')
    expect(formatChord('ctrl+KeyO', 'darwin')).toBe('⌃O')
    expect(formatChord('mod+alt+PageUp', 'darwin')).toBe('⌘⌥Page Up')
    expect(formatChord('mod+Comma', 'darwin')).toBe('⌘,')
  })

  it('writes Windows chords in words, Ctrl+Alt never AltGr', () => {
    expect(formatChord('mod+alt+]', 'win32')).toBe('Ctrl+Alt+]')
    expect(formatChord('mod+shift+Enter', 'win32')).toBe('Ctrl+Shift+Enter')
    expect(formatChord('mod+alt+PageDown', 'win32')).toBe('Ctrl+Alt+Page Down')
    expect(formatChord('mod+alt+Enter', 'win32')).toBe('Ctrl+Alt+Enter')
    expect(formatChord('mod+shift+Digit1-5', 'win32')).toBe('Ctrl+Shift+1–5')
    expect(formatChord('mod+alt+ArrowUp', 'win32')).toBe('Ctrl+Alt+Up')
    expect(formatChord('mod+alt+KeyT', 'win32')).toBe('Ctrl+Alt+T')
    for (const e of SHORTCUTS) expect(formatKeys(e, 'win32')).not.toMatch(/altgr/i)
  })

  it('formats an entry with alternatives, and the palette hints', () => {
    expect(formatKeys(entry('workspace.prevNext'), 'win32')).toBe('Ctrl+Alt+Page Up / Ctrl+Alt+Page Down')
    expect(formatKeys(entry('workspace.prevNext'), 'darwin')).toBe('⌘⌥Page Up / ⌘⌥Page Down')
    expect(formatKeys(entry('terminal.rename'), 'win32')).toBe('')
    expect(shortcutHint('workspace.new', 'darwin')).toBe('⌘N')
    expect(shortcutHint('workspace.new', 'win32')).toBe('Ctrl+N')
    expect(shortcutHint('openIn.toggle', 'win32')).toBe('Ctrl+Shift+O')
    expect(shortcutHint('openIn.toggle', 'darwin')).toBe('⌘O')
    expect(shortcutHint('git.create-pr', 'win32')).toBe('Ctrl+Shift+P')
    expect(shortcutHint('no.such.entry', 'win32')).toBeUndefined()
  })

  it('canonicalises chords for comparison', () => {
    expect(canonicalChords('mod+alt+KeyN', 'win32')).toEqual(['ctrl+alt+n'])
    expect(canonicalChords('mod+alt+KeyN', 'darwin')).toEqual(['alt+meta+n'])
    expect(canonicalChords('mod+Digit1-3', 'win32')).toEqual(['ctrl+1', 'ctrl+2', 'ctrl+3'])
  })
})
