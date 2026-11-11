// #164: what a terminal shows, as plain text, so a phone can read a workspace's terminals and run scripts with or
// without the window open (PtyTails in pty.ts keeps one per terminal). The window draws its terminals with xterm.js;
// this is a small screen model of the same stream, enough to read: it prints, wraps at the terminal's width, follows
// the cursor moves, erases and the alternate screen that shells, build tools and ConPTY's repaints use, and drops
// colours and every other sequence. It is not an emulator: anything it doesn't follow is skipped, never shown as codes.

/** Lines kept per terminal by default; older ones go, and `text` says so. */
export const SCREEN_LINES = 1000

const ESC = '\x1b'
// The text up to the next control character or escape (the fast path for ordinary output).
const PRINTABLE = /[^\x00-\x1f\x7f]+/y

type Mode = 'text' | 'esc' | 'esc-pick' | 'csi' | 'osc' | 'osc-esc' | 'string' | 'string-esc'

export class TerminalScreen {
  private lines: string[] = ['']
  private row = 0
  private col = 0
  private mode: Mode = 'text'
  private params = ''
  private saved: { row: number; col: number } | null = null
  // The main screen while a full-screen program has the alternate one.
  private main: { lines: string[]; row: number; col: number } | null = null
  private dropped = false

  constructor(private cols = 80, private rows = 24, private maxLines = SCREEN_LINES) {
    this.resize(cols, rows)
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(cols, 2)
    this.rows = Math.max(rows, 2)
  }

  write(data: string): void {
    let i = 0
    while (i < data.length) {
      if (this.mode === 'text') {
        PRINTABLE.lastIndex = i
        const run = PRINTABLE.exec(data)
        if (run) {
          this.print(run[0])
          i += run[0].length
          continue
        }
        this.control(data[i++])
        continue
      }
      this.escape(data[i++])
    }
    this.trim()
  }

  /** The last `limit` lines as text, blank ones at either end left out; `cut` when there were more than it shows. */
  text(limit = SCREEN_LINES): { text: string; cut: boolean } {
    const lines = this.lines.map((l) => l.trimEnd())
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    while (lines.length && !lines[0]) lines.shift()
    const cut = this.dropped || lines.length > limit
    return { text: lines.slice(-limit).join('\n'), cut }
  }

  // ---- printing ----

  private get top(): number {
    return Math.max(0, this.lines.length - this.rows)
  }

  private line(row: number): string {
    while (this.lines.length <= row) this.lines.push('')
    return this.lines[row]
  }

  private put(text: string): void {
    const line = this.line(this.row)
    const padded = line.length < this.col ? line + ' '.repeat(this.col - line.length) : line
    this.lines[this.row] = padded.slice(0, this.col) + text + padded.slice(this.col + text.length)
    this.col += text.length
  }

  private print(text: string): void {
    let rest = text
    while (rest) {
      // A character past the last column wraps to the next line first, as a terminal does.
      if (this.col >= this.cols) {
        this.col = 0
        this.down()
      }
      const room = this.cols - this.col
      this.put(rest.slice(0, room))
      rest = rest.slice(room)
    }
  }

  private down(): void {
    this.row++
    this.line(this.row)
  }

  private control(c: string): void {
    if (c === '\n' || c === '\v' || c === '\f') this.down()
    else if (c === '\r') this.col = 0
    else if (c === '\b') this.col = Math.max(0, Math.min(this.col, this.cols - 1) - 1)
    else if (c === '\t') this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8)
    else if (c === ESC) this.mode = 'esc'
  }

  // ---- escape sequences ----

  private escape(c: string): void {
    switch (this.mode) {
      case 'esc':
        this.mode = 'text'
        if (c === '[') { this.mode = 'csi'; this.params = '' }
        else if (c === ']') this.mode = 'osc'
        else if (c === 'P' || c === 'X' || c === '^' || c === '_') this.mode = 'string'
        else if ('()*+-./#%'.includes(c)) this.mode = 'esc-pick'
        else if (c === 'D') this.down()
        else if (c === 'E') { this.col = 0; this.down() }
        else if (c === 'M') this.row = Math.max(this.top, this.row - 1)
        else if (c === '7') this.saved = { row: this.row - this.top, col: this.col }
        else if (c === '8') this.restore()
        else if (c === 'c') this.reset()
        return
      case 'esc-pick':
        // A character set or line size: one more character, then text again.
        this.mode = 'text'
        return
      case 'csi':
        if (c >= '@' && c <= '~') {
          this.mode = 'text'
          this.csi(c, this.params)
        } else if (this.params.length < 64) this.params += c
        return
      case 'osc':
        if (c === '\x07') this.mode = 'text'
        else if (c === ESC) this.mode = 'osc-esc'
        return
      case 'osc-esc':
        this.mode = c === '\\' ? 'text' : 'osc'
        return
      case 'string':
        if (c === ESC) this.mode = 'string-esc'
        return
      case 'string-esc':
        this.mode = c === '\\' ? 'text' : 'string'
        return
    }
  }

  private csi(final: string, raw: string): void {
    const priv = /^[?>=<]/.test(raw)
    const nums = raw.replace(/^[?>=<]/, '').split(';').map((p) => parseInt(p, 10))
    const n = (i = 0) => (Number.isFinite(nums[i]) && nums[i] > 0 ? nums[i] : 1)
    const bottom = this.top + this.rows - 1
    if (priv) {
      // The alternate screen: vim, less and the like draw there, and leaving it brings back what was before.
      if ((final === 'h' || final === 'l') && nums.some((p) => p === 1049 || p === 1047 || p === 47)) this.alternate(final === 'h')
      return
    }
    switch (final) {
      case 'A': this.row = Math.max(this.top, this.row - n()); break
      case 'B': case 'e': this.row = Math.min(bottom, this.row + n()); this.line(this.row); break
      case 'C': case 'a': this.col = Math.min(this.cols - 1, this.col + n()); break
      case 'D': this.col = Math.max(0, Math.min(this.col, this.cols - 1) - n()); break
      case 'E': this.row = Math.min(bottom, this.row + n()); this.line(this.row); this.col = 0; break
      case 'F': this.row = Math.max(this.top, this.row - n()); this.col = 0; break
      case 'G': case '`': this.col = Math.min(this.cols - 1, n() - 1); break
      case 'H': case 'f': this.moveTo(n(0) - 1, n(1) - 1); break
      case 'd': this.moveTo(n() - 1, this.col); break
      case 'J': this.eraseDisplay(Number.isFinite(nums[0]) ? nums[0] : 0); break
      case 'K': this.eraseLine(Number.isFinite(nums[0]) ? nums[0] : 0); break
      case 'X': this.blank(this.col, this.col + n()); break
      case 'P': { const l = this.line(this.row); this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + n()); break }
      case '@': { const l = this.line(this.row); if (l.length > this.col) this.lines[this.row] = l.slice(0, this.col) + ' '.repeat(n()) + l.slice(this.col); break }
      case 'L': this.lines.splice(this.row, 0, ...Array<string>(Math.min(n(), this.rows)).fill('')); break
      case 'M': this.lines.splice(this.row, n()); this.line(this.row); break
      case 'S': {
        const k = Math.min(n(), this.rows)
        for (let j = 0; j < k; j++) this.lines.push('')
        this.row += k
        break
      }
      case 's': this.saved = { row: this.row - this.top, col: this.col }; break
      case 'u': this.restore(); break
      // Colours (m), scroll regions (r), modes (h, l) and the rest change nothing that reads as text.
    }
  }

  private moveTo(row: number, col: number): void {
    // Rows count from the top of the screen, which is the last `rows` lines.
    this.row = this.top + Math.max(0, Math.min(row, this.rows - 1))
    this.line(this.row)
    this.col = Math.max(0, Math.min(col, this.cols - 1))
  }

  private blank(from: number, to: number): void {
    const l = this.line(this.row)
    if (from >= l.length) return
    this.lines[this.row] = l.slice(0, from) + ' '.repeat(Math.min(to, l.length) - from) + l.slice(to)
  }

  private eraseLine(how: number): void {
    const l = this.line(this.row)
    if (how === 0) this.lines[this.row] = l.slice(0, this.col)
    else if (how === 1) this.blank(0, this.col + 1)
    else if (how === 2) this.lines[this.row] = ''
  }

  private eraseDisplay(how: number): void {
    const top = this.top
    if (how === 0) {
      this.eraseLine(0)
      this.lines.length = this.row + 1
    } else if (how === 1) {
      for (let r = top; r < this.row; r++) this.lines[r] = ''
      this.blank(0, this.col + 1)
    } else if (how === 2) {
      for (let r = top; r < this.lines.length; r++) this.lines[r] = ''
    } else if (how === 3) {
      // `clear` also empties the scrollback.
      this.lines.splice(0, top)
      this.row -= top
    }
  }

  private restore(): void {
    if (this.saved) this.moveTo(this.saved.row, this.saved.col)
  }

  private alternate(on: boolean): void {
    if (on && !this.main) {
      this.main = { lines: this.lines, row: this.row, col: this.col }
      this.lines = Array<string>(this.rows).fill('')
      this.row = 0
      this.col = 0
    } else if (!on && this.main) {
      ;({ lines: this.lines, row: this.row, col: this.col } = this.main)
      this.main = null
    }
  }

  private reset(): void {
    this.lines = ['']
    this.row = 0
    this.col = 0
    this.main = null
    this.saved = null
  }

  private trim(): void {
    const over = this.lines.length - this.maxLines
    // A little slack, so a busy terminal isn't trimmed on every chunk.
    if (over <= 0 || over < Math.ceil(this.maxLines / 16)) return
    this.lines.splice(0, over)
    this.row = Math.max(0, this.row - over)
    this.dropped = true
  }
}
