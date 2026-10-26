// Terminal upgrades (O3): find in a terminal, renamed tabs, per-tab zoom, and
// tabs that come back after a restart. A restored tab shows its last output
// dimmed under "Restored from 14:02 · the process was not kept"; the shell and
// whatever ran in it ended with the app, and nothing re-runs on its own.
// Saved output can hold secrets a command printed, so it is capped, kept in
// Foreman's data folder only, and turned off by one preference.
import type { TFunction } from './i18n'
import { isShellChoice, type ShellChoice } from './shells'
import { snippetClock, stripAnsi } from './terminalSnippet'

// ---- restore after a restart ----

/**
 * Bump when the saved shape changes; a file with another version is ignored, not guessed at.
 * 2 (O4) added each tab's own shell; a version 1 file reads the same, every tab on the Shell setting.
 */
export const TERMINAL_RESTORE_VERSION = 2
const READABLE_VERSIONS: readonly number[] = [1, 2]
/** Each tab keeps the last this-many characters of its output (about 64 KB of text). */
export const RESTORE_SCROLLBACK_MAX_CHARS = 64 * 1024
/** All saved output together stays under this; the oldest output is dropped first. */
export const RESTORE_TOTAL_MAX_CHARS = 2 * 1024 * 1024
/** Terminal tabs kept per workspace. */
export const RESTORE_MAX_TABS = 12
/** A tab's name, at most. */
export const TAB_NAME_MAX = 40

/** One terminal tab as saved: its number, name, zoom, the folder its shell started in, and its last output. */
export interface SavedTerminalTab {
  n: number
  // Set when renamed; otherwise the tab is "Terminal {n}".
  name?: string
  // 1 is 100%; left out at 100%.
  zoom?: number
  // A shell picked for this tab only (O4, Windows); left out when it follows Settings → Shell.
  shell?: ShellChoice
  cwd: string
  // When the output was captured (ms since the epoch).
  savedAt: number
  // Plain text, or with `styled` (G3 · O3) colours kept as SGR codes only; never cursor or other control codes.
  scrollback: string
  // G3 · O3: the scrollback keeps its colours (SGR sequences only, checked again when read).
  styled?: boolean
  // G3 · O10: when Foreman quit and so ended this tab's shell: set on the launch after a clean quit, and kept while
  // the restored tab isn't started again (so a later quit doesn't move it).
  quitAt?: number
}

/**
 * What the renderer sends. The main process sets the folder: the shell's own (G3 · O3, from OSC 7) when it names a
 * folder that exists, otherwise the workspace's.
 */
export type TerminalTabSave = Omit<SavedTerminalTab, 'cwd'> & { cwd?: string }

/** terminals.json in Foreman's data folder: workspace id → its tabs, in order. */
export interface SavedTerminals {
  version: typeof TERMINAL_RESTORE_VERSION
  workspaces: Record<string, SavedTerminalTab[]>
  // G3 · O10: written by the flush at a clean quit; absent after a crash, so the band can say which it was.
  quitAt?: number
}

export function emptySavedTerminals(): SavedTerminals {
  return { version: TERMINAL_RESTORE_VERSION, workspaces: {} }
}

/**
 * Output ready to save: escape and control codes gone (written back into a terminal they would run),
 * line endings as \n, trailing whitespace and blank lines at the end dropped, and only the last
 * `max` characters kept, starting at a whole line.
 */
export function trimScrollback(text: string, max = RESTORE_SCROLLBACK_MAX_CHARS): string {
  let out = stripAnsi(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '')
  if (out.length <= max) return out
  out = out.slice(out.length - max)
  const cut = out.indexOf('\n')
  // A cut through the middle of a line drops the partial line, unless that was the only line.
  return cut === -1 ? out : out.slice(cut + 1)
}

/**
 * The end of a terminal's buffer as text, reading upwards from the last line until `max` characters.
 * Wrapped rows join the row before them without a newline, as they were one line of output.
 */
export function bufferTail(length: number, line: (index: number) => { text: string; wrapped: boolean } | undefined, max = RESTORE_SCROLLBACK_MAX_CHARS): string {
  const lines: string[] = []
  let size = 0
  let pending = ''
  for (let i = length - 1; i >= 0 && size <= max; i--) {
    const row = line(i)
    if (!row) continue
    pending = row.text + pending
    if (row.wrapped) continue
    lines.push(pending)
    size += pending.length + 1
    pending = ''
  }
  if (pending) lines.push(pending)
  return trimScrollback(lines.reverse().join('\n'), max)
}

/** A renamed tab's name: trimmed, inner whitespace collapsed, capped. Empty means "Terminal {n}" again. */
export function normalizeTabName(input: string): string | undefined {
  const name = input.replace(/\s+/g, ' ').trim().slice(0, TAB_NAME_MAX).trim()
  return name || undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** One saved tab checked field by field; anything malformed is dropped rather than repaired. */
function parseTab(raw: unknown): SavedTerminalTab | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const tab = raw as Record<string, unknown>
  if (!finite(tab.n) || tab.n < 1 || !Number.isInteger(tab.n)) return undefined
  if (typeof tab.cwd !== 'string' || !tab.cwd || !finite(tab.savedAt) || typeof tab.scrollback !== 'string') return undefined
  const name = typeof tab.name === 'string' ? normalizeTabName(tab.name) : undefined
  const zoom = finite(tab.zoom) ? clampZoom(tab.zoom) : 1
  // A shell this version doesn't know is dropped; the tab follows the Shell setting.
  const shell = isShellChoice(tab.shell) && tab.shell !== 'auto' ? tab.shell : undefined
  return {
    n: tab.n,
    ...(name ? { name } : {}),
    ...(zoom !== 1 ? { zoom } : {}),
    ...(shell ? { shell } : {}),
    cwd: tab.cwd,
    savedAt: tab.savedAt,
    // G3 · O3: styled output keeps its colours; anything but SGR is stripped again here, whatever the file says.
    ...(tab.styled === true ? { styled: true } : {}),
    ...(finite(tab.quitAt) && tab.quitAt > 0 ? { quitAt: tab.quitAt } : {}),
    scrollback: tab.styled === true ? trimStyled(tab.scrollback) : trimScrollback(tab.scrollback)
  }
}

/** One workspace's tabs: valid ones in order, no repeated numbers, at most RESTORE_MAX_TABS. */
export function parseTabs(raw: unknown): SavedTerminalTab[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const tabs: SavedTerminalTab[] = []
  for (const item of raw) {
    const tab = parseTab(item)
    if (!tab || seen.has(tab.n)) continue
    seen.add(tab.n)
    tabs.push(tab)
    if (tabs.length === RESTORE_MAX_TABS) break
  }
  return tabs
}

/** terminals.json as read from disk. Another version, or anything unreadable, restores nothing. */
export function parseSavedTerminals(raw: unknown): SavedTerminals {
  const data = emptySavedTerminals()
  if (!raw || typeof raw !== 'object') return data
  const file = raw as Record<string, unknown>
  if (typeof file.version !== 'number' || !READABLE_VERSIONS.includes(file.version) || !file.workspaces || typeof file.workspaces !== 'object') return data
  for (const [id, tabs] of Object.entries(file.workspaces as Record<string, unknown>)) data.workspaces[id] = parseTabs(tabs)
  const capped = capSavedTerminals(data)
  return finite(file.quitAt) && file.quitAt > 0 ? { ...capped, quitAt: file.quitAt } : capped
}

/**
 * Keep the file small: each tab's output trimmed, then, while the total is over `total`, the oldest
 * output emptied first. Names, order and folders stay, so the tabs still come back.
 */
export function capSavedTerminals(data: SavedTerminals, total = RESTORE_TOTAL_MAX_CHARS): SavedTerminals {
  const workspaces: Record<string, SavedTerminalTab[]> = {}
  for (const [id, tabs] of Object.entries(data.workspaces)) workspaces[id] = tabs.map((tab) => ({ ...tab, scrollback: tab.styled ? trimStyled(tab.scrollback) : trimScrollback(tab.scrollback) }))
  const all = Object.values(workspaces).flat()
  let size = all.reduce((sum, tab) => sum + tab.scrollback.length, 0)
  for (const tab of [...all].sort((a, b) => a.savedAt - b.savedAt)) {
    if (size <= total) break
    size -= tab.scrollback.length
    tab.scrollback = ''
  }
  return { version: TERMINAL_RESTORE_VERSION, workspaces }
}

/** When the output was saved: "14:02" today, otherwise with the date ("21 Oct, 14:02" in English). */
export function restoredWhen(savedAt: number, now: number, locale: string): string {
  const saved = new Date(savedAt)
  const today = new Date(now)
  const sameDay = saved.getFullYear() === today.getFullYear() && saved.getMonth() === today.getMonth() && saved.getDate() === today.getDate()
  if (sameDay) return snippetClock(savedAt)
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(saved.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(saved)
  return `${date}, ${snippetClock(savedAt)}`
}

/**
 * The band over a restored tab: "Restored from 14:02 · the process was not kept". G3 · O10: after a clean quit it
 * says so: "Ended when Foreman quit at 12:10 · terminals aren't kept in the background".
 */
export function restoredLabel(savedAt: number, now: number, t: TFunction, locale: string, quitAt?: number): string {
  if (quitAt) return t('terminal.endedQuit', { time: restoredWhen(quitAt, now, locale) })
  return t('terminal.restored', { time: restoredWhen(savedAt, now, locale) })
}

/**
 * Saved output as written back into a terminal: dimmed, so it reads as history, with the cursor hidden. G3 · O3:
 * styled output keeps its colours, still dimmed: every colour change is followed by dim again (a reset clears it).
 */
export function dimHistory(text: string, styled = false): string {
  if (!text) return '\x1b[?25l'
  if (styled) {
    return `${keepSgr(text)
      .split('\n')
      .map((line) => `\x1b[2m${line.replace(SGR, '$&\x1b[2m')}\x1b[0m`)
      .join('\r\n')}\r\n\x1b[?25l`
  }
  return `${text
    .split('\n')
    .map((line) => `\x1b[2m${line}\x1b[22m`)
    .join('\r\n')}\r\n\x1b[?25l`
}

// ---- G3 · O3: colours kept, and the folder the shell is in ----

/** Rows of scrollback the serializer reads for a save (the text is then cut to RESTORE_SCROLLBACK_MAX_CHARS). */
export const RESTORE_SERIALIZE_ROWS = 2000

// An SGR sequence (colours, bold, …): CSI, numeric parameters, m. Nothing else in saved output survives.
const SGR = /\u001b\[[0-9;:]{0,64}m/g
const ESC = '\u001b'

/**
 * Only SGR sequences survive; every other escape sequence (cursor moves, queries that would make the terminal answer,
 * titles, hyperlinks, clipboard and device strings) and every control character but newline and tab is dropped.
 */
export function keepSgr(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const code = text.charCodeAt(i)
    if (c === ESC) {
      const next = text[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < text.length && /[0-9;:?<=>]/.test(text[j])) j++
        while (j < text.length && /[ -/]/.test(text[j])) j++
        const params = text.slice(i + 2, j)
        if (text[j] === 'm' && /^[0-9;:]{0,64}$/.test(params)) out += text.slice(i, j + 1)
        i = j
        continue
      }
      // OSC, DCS, SOS, PM, APC: a string up to BEL or ST, all of it dropped.
      if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        let j = i + 2
        while (j < text.length && text[j] !== '\u0007' && !(text[j] === ESC && text[j + 1] === '\\')) j++
        i = text[j] === ESC ? j + 1 : j
        continue
      }
      // Any other escape is two characters (ESC 7, ESC c, …), both dropped.
      i++
      continue
    }
    if (c === '\n' || c === '\t') out += c
    else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) out += c
  }
  return out
}

/**
 * The xterm serialize addon's output as styled text: its tricks for wrapped rows ending in empty cells are undone,
 * a run of empty cells (cursor forward) becomes spaces, and then only SGR survives (keepSgr).
 */
export function styledFromSerialized(text: string): string {
  const out = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[A\u001b\[\d+C\u001b\[\d+X\u001b\[\d+D\u001b\[B/g, '')
    .replace(/-+\u001b\[1D\u001b\[1X/g, '')
    .replace(/\u001b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n || 1), 1000)))
  return keepSgr(out)
}

/** Styled output ready to save: like trimScrollback, but colours (SGR only) are kept. */
export function trimStyled(text: string, max = RESTORE_SCROLLBACK_MAX_CHARS): string {
  let out = keepSgr(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '')
  if (out.length <= max) return out
  out = out.slice(out.length - max)
  const cut = out.indexOf('\n')
  // Cut at a whole line (no SGR spans a newline). One overlong line may have been cut inside a sequence: drop its tail.
  if (cut !== -1) return out.slice(cut + 1)
  return out.replace(/^(\[[0-9;:]*|[0-9;:]+)m/, '')
}

/**
 * The folder an OSC 7 report names (`file://host/path`, percent-encoded), as a path for this computer, or null.
 * "/C:/Users/me" becomes "C:\Users\me". Shells that report it (fish, zsh/bash with the snippet, Windows Terminal setups)
 * let restore start the new shell where the old one was.
 */
export function osc7Folder(data: string): string | null {
  let url: URL
  try {
    url = new URL(data.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  let folder: string
  try {
    folder = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (!folder.startsWith('/') || folder.includes('\0')) return null
  if (/^\/[A-Za-z]:(\/|$)/.test(folder)) return folder.slice(1).replace(/\//g, '\\').replace(/^([A-Za-z]:)$/, '$1\\')
  return folder.length > 1 ? folder.replace(/\/+$/, '') : folder
}

/** ConEmu's and Windows Terminal's `OSC 9;9;"C:\path"`: the folder, or null (OSC 9 is also used for notifications). */
export function osc99Folder(data: string): string | null {
  if (!data.startsWith('9;')) return null
  const folder = data.slice(2).trim().replace(/^"(.*)"$/, '$1')
  if (folder.includes('\0')) return null
  return /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('/') || folder.startsWith('\\\\') ? folder : null
}

/** The line left in the output when a restored tab starts a new shell, then the cursor back. */
export function historyDivider(label: string): string {
  return `\r\n\x1b[2m── ${label} ──\x1b[22m\r\n\r\n\x1b[?25h`
}

/** "~/foreman/workspaces/kigali" for a folder under the home folder. */
export function shortPath(folder: string, home: string | undefined): string {
  if (!home) return folder
  const trimmed = home.replace(/[\\/]+$/, '')
  if (folder === trimmed) return '~'
  for (const sep of ['/', '\\']) if (folder.startsWith(trimmed + sep)) return `~${sep}${folder.slice(trimmed.length + 1)}`
  return folder
}

// ---- zoom, per tab ----

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
export const ZOOM_STEP = 0.1

/** A zoom within bounds, on a whole step (0.1), so repeated steps never drift. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 10) / 10
}

/** One step in or out (direction 1 or -1), or back to 100% (0). */
export function stepZoom(zoom: number, direction: 1 | -1 | 0): number {
  return direction === 0 ? 1 : clampZoom(clampZoom(zoom) + direction * ZOOM_STEP)
}

/** "110%". */
export function zoomPercent(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`
}

/** The tab's font size: the terminal font size from Settings times its zoom, kept readable. */
export function zoomedFontSize(base: number, zoom: number): number {
  return Math.min(64, Math.max(6, Math.round(base * clampZoom(zoom))))
}

// ---- keys ----

interface Keys {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

function modOnly(e: Keys, platform: string | undefined): boolean {
  return platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/** ⌘F (Ctrl+F elsewhere) in a focused terminal: find in its output. */
export function isFindShortcut(e: Keys, platform: string | undefined): boolean {
  return e.code === 'KeyF' && modOnly(e, platform) && !e.altKey && !e.shiftKey
}

/** ⌘⇧J (Ctrl+Shift+J): the terminal panel fills the workspace, or goes back. */
export function isFullscreenShortcut(e: Keys, platform: string | undefined): boolean {
  return e.code === 'KeyJ' && modOnly(e, platform) && !e.altKey && e.shiftKey
}

/** ⌘= / ⌘− / ⌘0 in a focused terminal zoom that tab: 1 in, -1 out, 0 back to 100%; null for other keys. */
export function zoomShortcut(e: Keys, platform: string | undefined): 1 | -1 | 0 | null {
  if (!modOnly(e, platform) || e.altKey) return null
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return 1
  if (e.shiftKey) return null
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return -1
  if (e.code === 'Digit0' || e.code === 'Numpad0') return 0
  return null
}

// ---- find ----

/** Whether a regex search term compiles (JavaScript syntax, as the search addon uses). */
export function validRegex(term: string): boolean {
  try {
    new RegExp(term)
    return true
  } catch {
    return false
  }
}

/** The find bar's count: "3 of 12", "No matches", "More than 1000 matches", or an invalid pattern. Empty with no term. */
export function findStatus(state: { term: string; regex: boolean; index: number; count: number }, t: TFunction): string {
  if (!state.term) return ''
  if (state.regex && !validRegex(state.term)) return t('terminal.find.invalid')
  if (state.count <= 0) return t('terminal.find.none')
  if (state.index < 0) return t('terminal.find.many', { count: state.count })
  return t('terminal.find.count', { index: state.index + 1, count: state.count })
}
