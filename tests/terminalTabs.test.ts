import { describe, expect, it } from 'vitest'
import { createT } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import {
  bufferTail,
  capSavedTerminals,
  clampZoom,
  dimHistory,
  findStatus,
  historyDivider,
  isFindShortcut,
  isFullscreenShortcut,
  normalizeTabName,
  parseSavedTerminals,
  parseTabs,
  RESTORE_MAX_TABS,
  RESTORE_SCROLLBACK_MAX_CHARS,
  restoredLabel,
  restoredWhen,
  shortPath,
  stepZoom,
  TAB_NAME_MAX,
  TERMINAL_RESTORE_VERSION,
  trimScrollback,
  validRegex,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomedFontSize,
  zoomPercent,
  zoomShortcut,
  type SavedTerminalTab
} from '../src/shared/terminalTabs'

const AT = new Date(2026, 9, 22, 14, 2, 30).getTime()
const LATER = new Date(2026, 9, 22, 18, 40).getTime()
const tab = (over: Partial<SavedTerminalTab> = {}): SavedTerminalTab => ({ n: 1, cwd: '/w/kigali', savedAt: AT, scrollback: 'npm run dev', ...over })
const keys = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift)
})

describe('scrollback trimming', () => {
  it('keeps short output, minus escape codes, trailing spaces and blank lines at the end', () => {
    expect(trimScrollback('\x1b[31mError\x1b[0m   \r\nok\r\n\r\n\r\n')).toBe('Error\nok')
  })

  it('drops control codes that would run if written back into a terminal', () => {
    expect(trimScrollback('a\x1b]52;c;c2VjcmV0\x07b\x07c')).toBe('abc')
  })

  it('keeps the last characters, starting at a whole line', () => {
    const text = ['first line', 'second line', 'third line'].join('\n')
    expect(trimScrollback(text, 15)).toBe('third line')
    expect(trimScrollback(text, 22)).toBe('third line')
    expect(trimScrollback(text, 23)).toBe('second line\nthird line')
  })

  it('cuts inside a single long line rather than keeping nothing', () => {
    expect(trimScrollback('x'.repeat(50), 10)).toBe('x'.repeat(10))
  })

  it('caps at RESTORE_SCROLLBACK_MAX_CHARS by default', () => {
    const line = 'y'.repeat(99)
    const text = Array.from({ length: 2000 }, () => line).join('\n')
    const out = trimScrollback(text)
    expect(out.length).toBeLessThanOrEqual(RESTORE_SCROLLBACK_MAX_CHARS)
    expect(out.startsWith(line)).toBe(true)
  })

  it('reads a buffer from the bottom, joining wrapped rows', () => {
    const rows = [
      { text: 'one', wrapped: false },
      { text: 'a long li', wrapped: false },
      { text: 'ne wrapped', wrapped: true },
      { text: 'last', wrapped: false },
      { text: '', wrapped: false },
      { text: '', wrapped: false }
    ]
    expect(bufferTail(rows.length, (i) => rows[i])).toBe('one\na long line wrapped\nlast')
    expect(bufferTail(rows.length, (i) => rows[i], 25)).toBe('a long line wrapped\nlast')
  })
})

describe('persistence shape and versioning', () => {
  it('reads what it wrote', () => {
    const file = { version: TERMINAL_RESTORE_VERSION, workspaces: { ws1: [tab(), tab({ n: 3, name: 'dev server', zoom: 1.2 })] } }
    expect(parseSavedTerminals(JSON.parse(JSON.stringify(file)))).toEqual(file)
  })

  it('ignores another version or a broken file instead of guessing', () => {
    expect(parseSavedTerminals({ version: 3, workspaces: { ws1: [tab()] } }).workspaces).toEqual({})
    expect(parseSavedTerminals({ workspaces: { ws1: [tab()] } }).workspaces).toEqual({})
    expect(parseSavedTerminals(null).workspaces).toEqual({})
    expect(parseSavedTerminals('nope').workspaces).toEqual({})
  })

  it('drops malformed tabs and repeated numbers, and keeps at most RESTORE_MAX_TABS', () => {
    const tabs = parseTabs([tab(), { n: 'x' }, tab({ cwd: '' }), tab({ n: 1 }), tab({ n: 0 }), tab({ n: 2.5 }), tab({ n: 2 })])
    expect(tabs.map((t) => t.n)).toEqual([1, 2])
    expect(parseTabs(Array.from({ length: 20 }, (_, i) => tab({ n: i + 1 })))).toHaveLength(RESTORE_MAX_TABS)
    expect(parseTabs('nope')).toEqual([])
  })

  it('cleans what it reads: names, zoom and output', () => {
    const [read] = parseTabs([tab({ name: '  dev   server ', zoom: 9, scrollback: '\x1b[1mhi\x1b[0m\n\n' })])
    expect(read).toEqual(tab({ name: 'dev server', zoom: ZOOM_MAX, scrollback: 'hi' }))
    const [plain] = parseTabs([tab({ name: '   ', zoom: 1 })])
    expect(plain).not.toHaveProperty('name')
    expect(plain).not.toHaveProperty('zoom')
  })

  it('keeps an empty list: the user closed every terminal', () => {
    expect(parseSavedTerminals({ version: TERMINAL_RESTORE_VERSION, workspaces: { ws1: [] } }).workspaces).toEqual({ ws1: [] })
  })

  it('empties the oldest output first when the whole file is over its cap, keeping the tabs', () => {
    const data = {
      version: TERMINAL_RESTORE_VERSION,
      workspaces: {
        old: [tab({ savedAt: 1, scrollback: 'a'.repeat(60) })],
        recent: [tab({ savedAt: 3, scrollback: 'c'.repeat(60) }), tab({ n: 2, savedAt: 2, scrollback: 'b'.repeat(60) })]
      }
    } as const
    const capped = capSavedTerminals({ ...data, workspaces: { old: [...data.workspaces.old], recent: [...data.workspaces.recent] } }, 130)
    expect(capped.workspaces.old[0].scrollback).toBe('')
    expect(capped.workspaces.recent.map((t) => t.scrollback.length)).toEqual([60, 60])
    const tighter = capSavedTerminals({ ...data, workspaces: { old: [...data.workspaces.old], recent: [...data.workspaces.recent] } }, 70)
    expect(tighter.workspaces.recent.map((t) => t.scrollback.length)).toEqual([60, 0])
    // The input isn't changed.
    expect(data.workspaces.old[0].scrollback).toHaveLength(60)
  })
})

describe('restore-state labels', () => {
  const t = createT('en')

  it('says when, and that the process is gone', () => {
    expect(restoredLabel(AT, LATER, t, 'en')).toBe('Restored from 14:02 · the process was not kept')
    expect(restoredLabel(AT, LATER, createT('es'), 'es')).toBe('Restaurado de las 14:02 · el proceso no se conservó')
  })

  it('adds the date when it was saved on another day, and the year in another year', () => {
    const nextDay = new Date(2026, 9, 23, 9, 0).getTime()
    expect(restoredWhen(AT, nextDay, 'en')).toMatch(/Oct.*22|22.*Oct/)
    expect(restoredWhen(AT, nextDay, 'en')).toContain('14:02')
    expect(restoredWhen(AT, new Date(2027, 0, 2).getTime(), 'en')).toContain('2026')
  })

  it('dims the old output and hides the cursor until a shell starts', () => {
    expect(dimHistory('a\nb')).toBe('\x1b[2ma\x1b[22m\r\n\x1b[2mb\x1b[22m\r\n\x1b[?25l')
    expect(dimHistory('')).toBe('\x1b[?25l')
    expect(historyDivider('Restored from 14:02')).toContain('── Restored from 14:02 ──')
    expect(historyDivider('x').endsWith('\x1b[?25h')).toBe(true)
  })

  it('shortens the folder under the home folder', () => {
    expect(shortPath('/Users/yatin/foreman/workspaces/kigali', '/Users/yatin')).toBe('~/foreman/workspaces/kigali')
    expect(shortPath('C:\\Users\\yatin\\foreman\\kigali', 'C:\\Users\\yatin\\')).toBe('~\\foreman\\kigali')
    expect(shortPath('/Users/yatina/x', '/Users/yatin')).toBe('/Users/yatina/x')
    expect(shortPath('/srv/x', undefined)).toBe('/srv/x')
  })

  it('every new string has a Spanish translation', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('terminal.') || k.startsWith('settings.advanced.'))
    expect(keys.length).toBeGreaterThan(30)
    for (const key of keys) expect(es[key as keyof typeof es], key).toBeTruthy()
  })
})

describe('tab names', () => {
  it('trims, collapses whitespace and caps; empty goes back to the default', () => {
    expect(normalizeTabName('  dev \t server ')).toBe('dev server')
    expect(normalizeTabName('   ')).toBeUndefined()
    expect(normalizeTabName('n'.repeat(100))).toHaveLength(TAB_NAME_MAX)
  })
})

describe('zoom bounds', () => {
  it('steps by 10% within 50%–200%', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, -1)).toBe(1)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(stepZoom(1.7, 0)).toBe(1)
  })

  it('never drifts off a whole step', () => {
    let zoom = 1
    for (let i = 0; i < 7; i++) zoom = stepZoom(zoom, 1)
    for (let i = 0; i < 7; i++) zoom = stepZoom(zoom, -1)
    expect(zoom).toBe(1)
  })

  it('clamps nonsense', () => {
    expect(clampZoom(NaN)).toBe(1)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(10)).toBe(ZOOM_MAX)
    expect(clampZoom(1.04)).toBe(1)
  })

  it('labels and sizes', () => {
    expect(zoomPercent(1.1)).toBe('110%')
    expect(zoomedFontSize(12, 1.1)).toBe(13)
    expect(zoomedFontSize(12, 0.5)).toBe(6)
    expect(zoomedFontSize(32, 2)).toBe(64)
    expect(zoomedFontSize(8, 0.5)).toBe(6)
  })
})

describe('keys', () => {
  it('⌘F on macOS, Ctrl+F elsewhere, opens find', () => {
    expect(isFindShortcut(keys('KeyF', { meta: true }), 'darwin')).toBe(true)
    expect(isFindShortcut(keys('KeyF', { ctrl: true }), 'darwin')).toBe(false)
    expect(isFindShortcut(keys('KeyF', { ctrl: true }), 'win32')).toBe(true)
    expect(isFindShortcut(keys('KeyF', { ctrl: true, shift: true }), 'win32')).toBe(false)
  })

  it('⌘⇧J toggles fullscreen (⌘⇧M is Merge PR)', () => {
    expect(isFullscreenShortcut(keys('KeyJ', { meta: true, shift: true }), 'darwin')).toBe(true)
    expect(isFullscreenShortcut(keys('KeyJ', { ctrl: true, shift: true }), 'win32')).toBe(true)
    expect(isFullscreenShortcut(keys('KeyJ', { ctrl: true }), 'win32')).toBe(false)
    expect(isFullscreenShortcut(keys('KeyM', { meta: true, shift: true }), 'darwin')).toBe(false)
  })

  it('⌘= ⌘− ⌘0 zoom the focused tab', () => {
    expect(zoomShortcut(keys('Equal', { meta: true }), 'darwin')).toBe(1)
    expect(zoomShortcut(keys('Equal', { meta: true, shift: true }), 'darwin')).toBe(1)
    expect(zoomShortcut(keys('Minus', { ctrl: true }), 'win32')).toBe(-1)
    expect(zoomShortcut(keys('Digit0', { ctrl: true }), 'linux')).toBe(0)
    expect(zoomShortcut(keys('Minus', { ctrl: true }), 'darwin')).toBeNull()
    expect(zoomShortcut(keys('Minus', { ctrl: true, alt: true }), 'win32')).toBeNull()
    expect(zoomShortcut(keys('KeyA', { ctrl: true }), 'win32')).toBeNull()
  })
})

describe('find status', () => {
  const t = createT('en')
  it('counts, or says why there is nothing', () => {
    expect(findStatus({ term: '', regex: false, index: 0, count: 0 }, t)).toBe('')
    expect(findStatus({ term: 'ECONN', regex: false, index: 2, count: 12 }, t)).toBe('3 of 12')
    expect(findStatus({ term: 'ECONN', regex: false, index: 0, count: 0 }, t)).toBe('No matches')
    expect(findStatus({ term: 'ECONN', regex: false, index: -1, count: 1000 }, t)).toBe('More than 1000 matches')
    expect(findStatus({ term: 'ECONN(', regex: true, index: 0, count: 0 }, t)).toBe('Invalid pattern')
    expect(findStatus({ term: 'ECONN(', regex: false, index: 0, count: 0 }, t)).toBe('No matches')
    expect(findStatus({ term: 'x', regex: false, index: 0, count: 2 }, createT('es'))).toBe('1 de 2')
  })

  it('checks regex syntax', () => {
    expect(validRegex('ECONN(REFUSED|RESET)')).toBe(true)
    expect(validRegex('ECONN(')).toBe(false)
  })
})
