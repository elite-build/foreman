import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithRef,
  type CompositionEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type SyntheticEvent,
  type UIEvent
} from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'
import { Glyph } from './Glyph'

export type CodeEditorTokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'title'
  | 'property'
  | 'type'
  | 'builtin'
  | 'literal'
  | 'regexp'
  | 'tag'
  | 'meta'
  | 'variable'
// A run of one line's text. A line's tokens, joined, must be the line exactly; otherwise it is drawn plain.
export type CodeEditorToken = { text: string; kind?: CodeEditorTokenKind }
// A problem on a line. `line` is 1-based. `from` and `to` are 1-based columns, `from` included and `to` not, and put a
// squiggle under that range (`to` defaults to the end of the line); without `from` the line gets its gutter mark only.
// `info` is a note (a review comment): its gutter square never squiggles, even with `from`, and an error or a warning on
// the same line shows instead.
export type CodeEditorMark = { line: number; tone: 'error' | 'warn' | 'info'; message: string; from?: number; to?: number }
// A change to show in the gutter. `line` is 1-based: 'added' and 'modified' mark that line; 'removed' marks the row
// where lines were removed just after `line`, and 0 means before the first line (drawn on line 1's top edge).
export type CodeEditorChange = { line: number; kind: 'added' | 'modified' | 'removed' }

// Marks come with `markLabel`: what a screen reader hears for each, in the user's language, with the line and the tone
// in words ("Line 40, problem: …"). The gutter shapes and squiggles are hidden from assistive tech, so it is the only
// place the tone is told.
type CodeEditorMarkProps = { marks?: undefined; markLabel?: undefined } | { marks: CodeEditorMark[]; markLabel: (mark: CodeEditorMark) => string }

export type CodeEditorProps = Omit<ComponentPropsWithRef<'textarea'>, 'value' | 'defaultValue' | 'onChange' | 'children' | 'wrap' | 'rows' | 'className' | 'ref'> &
  CodeEditorMarkProps & {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  // Lines to show as the current range (1-based, both included): the step selected elsewhere.
  highlight?: { from: number; to: number } | null
  tokenize?: (line: string) => CodeEditorToken[]
  // The tokens of each line, index 0 = line 1, for a feature that tokenizes ahead of the draw. An entry wins over
  // `tokenize` for its line; an undefined entry falls back to `tokenize`.
  tokenLines?: readonly (readonly CodeEditorToken[] | undefined)[]
  // Changed lines, drawn as a bar on the gutter's right edge. Decorative: say the changes in words nearby.
  changes?: readonly CodeEditorChange[]
  // Scrolls this line into view whenever the number changes.
  revealLine?: number
  // The caret's 1-based line, reported on select, key up and click.
  onCaretLine?: (line: number) => void
  // Visible lines before it scrolls (default 12). A height from `className` wins.
  rows?: number
  className?: string
  ref?: Ref<HTMLTextAreaElement>
}

type Tone = CodeEditorMark['tone']
type Segment = { text: string; kind?: CodeEditorTokenKind; squiggle?: Tone }
type LineMarks = { tone: Tone; ranges: { from: number; to: number; tone: Tone }[] }
// What a gutter row shows for a change: 'removed-above' is a 'removed' at line 0, drawn on line 1's top edge.
type ChangeShown = CodeEditorChange['kind'] | 'removed-above'

const NO_MARKS: CodeEditorMark[] = []
// A line's shown tone: error over warning over note.
const TONE_RANK: Record<Tone, number> = { info: 0, warn: 1, error: 2 }
// A row with more than one change shows the strongest: a modified line over an added one, over a removed row, over one above.
const CHANGE_RANK: Record<ChangeShown, number> = { 'removed-above': 0, removed: 1, added: 2, modified: 3 }

// The textarea's own line breaks: its value API turns CRLF and CR into LF, so the drawn lines split the same way.
const splitLines = (text: string) => text.split(/\r\n|\r|\n/)

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

const caretOf = (area: HTMLTextAreaElement) => (area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd)

// One line cut into runs that share a token kind and a squiggle, so each run is one span. Error squiggles win over warnings.
function segments(line: string, tokens: readonly CodeEditorToken[] | undefined, marks: LineMarks | undefined): Segment[] {
  let runs: readonly CodeEditorToken[] = tokens ?? [{ text: line }]
  if (runs.map((t) => t.text).join('') !== line) runs = [{ text: line }]
  const tone: (Tone | undefined)[] = []
  for (const r of marks?.ranges ?? []) {
    for (let c = Math.max(0, r.from); c < Math.min(line.length, r.to); c++) if (tone[c] !== 'error') tone[c] = r.tone
  }
  const out: Segment[] = []
  let col = 0
  for (const token of runs) {
    let start = 0
    for (let i = 1; i <= token.text.length; i++) {
      if (i === token.text.length || tone[col + i] !== tone[col + start]) {
        out.push({ text: token.text.slice(start, i), kind: token.kind, squiggle: tone[col + start] })
        start = i
      }
    }
    col += token.text.length
  }
  return out
}

// The offset `count` lines up (negative) or down from `caret`, at the same column or the end of a shorter line; past the
// first or last line, the start or end of the text, as a textarea's own PageUp and PageDown go.
function linesAway(text: string, caret: number, count: number): number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const from = lineOf(text, caret) - 1
  const to = from + count
  if (to < 0) return 0
  if (to >= starts.length) return text.length
  const end = to + 1 < starts.length ? starts[to + 1] - 1 : text.length
  return Math.min(starts[to] + caret - starts[from], end)
}

// Scrolls `scroller` so a band from `top` of `height` px is inside it: centred when it was out of view, left alone when not.
function revealBand(scroller: HTMLElement, top: number, height: number, centre: boolean) {
  const view = scroller.clientHeight
  if (top >= scroller.scrollTop && top + height <= scroller.scrollTop + view) return
  scroller.scrollTop = centre ? Math.max(0, top - (view - height) / 2) : top < scroller.scrollTop ? top : top + height - view
}

// The x of a column in a drawn line, from the line's left edge; null where layout can't be measured (tests).
function columnX(line: HTMLElement, col: number): number | null {
  const doc = line.ownerDocument
  const range = doc.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return null
  const walker = doc.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent) nodes.push(node as Text)
  // An empty line: the caret sits at its start.
  if (!nodes.length) return col === 0 ? 0 : null
  const origin = line.getBoundingClientRect().left
  let left = col
  for (const [i, node] of nodes.entries()) {
    const length = node.data.length
    // Measure a character, not a collapsed range: the edge before it, or after the last one at the end of the line.
    if (left < length) {
      range.setStart(node, left)
      range.setEnd(node, left + 1)
      return range.getBoundingClientRect().left - origin
    }
    if (left === length && i === nodes.length - 1) {
      range.setStart(node, left - 1)
      range.setEnd(node, left)
      return range.getBoundingClientRect().right - origin
    }
    left -= length
  }
  return null
}

// One gutter row. Memoised: a keystroke redraws only the rows whose number, mark, change or highlight edge moved.
type GutterRowProps = { n: number; tone?: Tone; change?: ChangeShown; edge?: string }
const GutterRow = memo(function GutterRow({ n, tone, change, edge }: GutterRowProps) {
  return (
    <div className="ui-code-editor__gutter-row" data-line={n} data-highlight={edge} data-mark={tone} data-change={change}>
      <span className="ui-code-editor__mark">{tone && <Glyph name={tone} />}</span>
      <span className="ui-code-editor__number">{n}</span>
    </div>
  )
})

// The segments compared by value (text, kind and squiggle), so a fresh array of equal tokens is not a change.
const sameSegments = (a: Segment[], b: Segment[]) =>
  a.length === b.length && a.every((s, i) => s.text === b[i]?.text && s.kind === b[i]?.kind && s.squiggle === b[i]?.squiggle)

// One drawn line. Memoised on its number, highlight edge and segments: a keystroke redraws only the lines whose text,
// tokens or squiggle ranges changed.
type CodeLineProps = { n: number; segments: Segment[]; edge?: string }
const CodeLine = memo(
  function CodeLine({ n, segments, edge }: CodeLineProps) {
    return (
      <div className="ui-code-editor__line" data-line={n} data-highlight={edge}>
        {segments.map((s, j) =>
          s.kind || s.squiggle ? (
            <span key={j} className="ui-code-editor__token" data-kind={s.kind} data-squiggle={s.squiggle}>
              {s.text}
            </span>
          ) : (
            s.text
          )
        )}
      </div>
    )
  },
  (a, b) => a.n === b.n && a.edge === b.edge && sameSegments(a.segments, b.segments)
)

// A code pane: a native textarea (typing, IME, undo, selection and screen readers stay the browser's) over an
// aria-hidden copy of its text that draws a line-number gutter, token colours, a highlighted range, problem marks and
// change bars. Lines never wrap: long ones scroll sideways. Both layers sit in one scroller sized to the text, so they
// move together.
export function CodeEditor({
  value,
  onChange,
  readOnly,
  highlight,
  marks = NO_MARKS,
  markLabel,
  tokenize,
  tokenLines,
  changes,
  revealLine,
  onCaretLine,
  rows = 12,
  className,
  ref,
  spellCheck = false,
  'aria-describedby': describedBy,
  onSelect,
  onKeyUp,
  onClick,
  onScroll,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  ...rest
}: CodeEditorProps) {
  const [own, setRef] = useOwnRef<HTMLTextAreaElement>(ref)
  useNameCheck(own, 'CodeEditor')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  const problemsId = `${useId()}-problems`
  // While an IME composes, the textarea shows its own text, so the browser draws the composition's underline and clause.
  const [composing, setComposing] = useState(false)

  const lines = useMemo(() => splitLines(value), [value])
  const byLine = useMemo(() => {
    const map = new Map<number, LineMarks>()
    for (const m of marks) {
      const entry = map.get(m.line) ?? { tone: m.tone, ranges: [] }
      if (TONE_RANK[m.tone] > TONE_RANK[entry.tone]) entry.tone = m.tone
      if (m.from !== undefined && m.tone !== 'info') entry.ranges.push({ from: m.from - 1, to: m.to === undefined ? Infinity : m.to - 1, tone: m.tone })
      map.set(m.line, entry)
    }
    return map
  }, [marks])
  const ordered = useMemo(() => [...marks].sort((a, b) => a.line - b.line || (a.from ?? 0) - (b.from ?? 0)), [marks])
  const shownChange = useMemo(() => {
    const map = new Map<number, ChangeShown>()
    for (const c of changes ?? []) {
      const above = c.kind === 'removed' && c.line === 0
      const row = above ? 1 : c.line
      const kind: ChangeShown = above ? 'removed-above' : c.kind
      const prev = map.get(row)
      if (prev === undefined || CHANGE_RANK[kind] > CHANGE_RANK[prev]) map.set(row, kind)
    }
    return map
  }, [changes])
  const band = highlight ? { from: Math.min(highlight.from, highlight.to), to: Math.max(highlight.from, highlight.to) } : null
  const bandEdge = (n: number): string | undefined => {
    if (!band || n < band.from || n > band.to) return undefined
    return n === band.from && n === band.to ? 'both' : n === band.from ? 'start' : n === band.to ? 'end' : ''
  }

  // Keeps the caret in view: the textarea never scrolls itself, so the scroller around it has to. After an edit or a
  // page (`driven`) it follows the caret down and across, with a line height of room ahead. After any other move the
  // browser has scrolled already, but it may leave the caret under the sticky gutter (the scroller's scroll-padding is
  // meant to stop that), so this only brings it back out, with the code's own padding of room.
  const revealCaret = (driven: boolean) => {
    const area = own.current
    const scroller = scrollerRef.current
    const caret = area && caretOf(area)
    if (!area || !scroller || caret === null) return
    const line = codeRef.current?.children[lineOf(area.value, caret) - 1]
    if (!(line instanceof HTMLElement)) return
    if (driven) revealBand(scroller, line.offsetTop, line.offsetHeight, false)
    const lineStart = caret > 0 ? area.value.lastIndexOf('\n', caret - 1) + 1 : 0
    const x = columnX(line, caret - lineStart)
    if (x === null) return
    // In the scroller's terms: past the sticky gutter and the code's own padding.
    const gutter = gutterRef.current?.offsetWidth ?? 0
    const at = gutter + line.offsetLeft + x
    const margin = driven ? line.offsetHeight : line.offsetLeft
    if (at < scroller.scrollLeft + gutter + margin) scroller.scrollLeft = Math.max(0, at - gutter - margin)
    else if (driven && at > scroller.scrollLeft + scroller.clientWidth - margin) scroller.scrollLeft = at - scroller.clientWidth + margin
  }

  useLayoutEffect(() => {
    if (own.current && own.current === own.current.ownerDocument.activeElement) revealCaret(true)
  }, [value])

  // PageUp and PageDown move the caret (Shift: the selection's moving end) by the lines in view, at the same column,
  // and scroll as far. Left to itself the textarea would page by its own height, which is the whole text's.
  const page = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const area = e.currentTarget
    const scroller = scrollerRef.current
    const lineHeight = (codeRef.current?.firstElementChild as HTMLElement | null)?.offsetHeight
    if (!scroller || !lineHeight) return
    e.preventDefault()
    const count = Math.max(1, Math.floor(scroller.clientHeight / lineHeight) - 1) * (e.key === 'PageUp' ? -1 : 1)
    const backward = area.selectionDirection === 'backward'
    const anchor = backward ? area.selectionEnd : area.selectionStart
    const from = backward ? area.selectionStart : area.selectionEnd
    const to = linesAway(area.value, from, count)
    if (e.shiftKey) area.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward')
    else area.setSelectionRange(to, to)
    scroller.scrollTop = Math.max(0, scroller.scrollTop + (lineOf(area.value, to) - lineOf(area.value, from)) * lineHeight)
    revealCaret(true)
  }

  useEffect(() => {
    const line = revealLine ? codeRef.current?.children[revealLine - 1] : undefined
    if (line instanceof HTMLElement && scrollerRef.current) revealBand(scrollerRef.current, line.offsetTop, line.offsetHeight, true)
  }, [revealLine])

  const reportCaret = () => {
    const area = own.current
    if (area && onCaretLine) onCaretLine(lineOf(area.value, caretOf(area) ?? 0))
  }

  const digits = String(lines.length).length
  return (
    <div
      className={joinClass('ui-code-editor', className)}
      data-invalid={rest['aria-invalid'] && rest['aria-invalid'] !== 'false' ? '' : undefined}
      data-readonly={readOnly ? '' : undefined}
      data-disabled={rest.disabled ? '' : undefined}
      data-composing={composing ? '' : undefined}
      style={{ '--ui-code-editor-rows': rows, '--ui-code-editor-digits': digits } as CSSProperties}
    >
      <div className="ui-code-editor__scroller" ref={scrollerRef}>
        <div className="ui-code-editor__sheet">
          <div className="ui-code-editor__gutter" ref={gutterRef} aria-hidden="true">
            {lines.map((_, i) => (
              <GutterRow key={i + 1} n={i + 1} tone={byLine.get(i + 1)?.tone} change={shownChange.get(i + 1)} edge={bandEdge(i + 1)} />
            ))}
          </div>
          <div className="ui-code-editor__body">
            <div className="ui-code-editor__code" ref={codeRef} aria-hidden="true">
              {lines.map((text, i) => (
                <CodeLine key={i} n={i + 1} segments={segments(text, tokenLines?.[i] ?? tokenize?.(text), byLine.get(i + 1))} edge={bandEdge(i + 1)} />
              ))}
            </div>
            <textarea
              {...rest}
              ref={setRef}
              className="ui-code-editor__input"
              value={value}
              readOnly={readOnly}
              wrap="off"
              spellCheck={spellCheck}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              aria-describedby={joinClass(describedBy, ordered.length > 0 && problemsId) || undefined}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value)}
              onSelect={(e: SyntheticEvent<HTMLTextAreaElement>) => {
                onSelect?.(e)
                revealCaret(false)
                reportCaret()
              }}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                onKeyDown?.(e)
                if (!e.defaultPrevented && (e.key === 'PageUp' || e.key === 'PageDown') && !e.altKey && !e.ctrlKey && !e.metaKey) page(e)
              }}
              onKeyUp={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                onKeyUp?.(e)
                revealCaret(false)
                reportCaret()
              }}
              onCompositionStart={(e: CompositionEvent<HTMLTextAreaElement>) => {
                onCompositionStart?.(e)
                setComposing(true)
              }}
              onCompositionEnd={(e: CompositionEvent<HTMLTextAreaElement>) => {
                onCompositionEnd?.(e)
                setComposing(false)
              }}
              onClick={(e: MouseEvent<HTMLTextAreaElement>) => {
                onClick?.(e)
                reportCaret()
              }}
              onScroll={(e: UIEvent<HTMLTextAreaElement>) => {
                onScroll?.(e)
                // Sized to its text, the textarea only scrolls when the browser reveals the caret before the copy has grown;
                // put it back so the two layers stay glyph for glyph, and let the scroller do the revealing.
                const area = e.currentTarget
                if (area.scrollTop || area.scrollLeft) {
                  area.scrollTop = 0
                  area.scrollLeft = 0
                  revealCaret(true)
                }
              }}
            />
          </div>
        </div>
      </div>
      {ordered.length > 0 && (
        <ul id={problemsId} className="ui-code-editor__problems">
          {ordered.map((m, i) => (
            <li key={i}>{markLabel ? markLabel(m) : m.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
