import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type ComponentPropsWithRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type SyntheticEvent,
  type UIEvent
} from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'
import { Glyph } from './Glyph'

export type CodeEditorTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'title' | 'property'
// A run of one line's text. A line's tokens, joined, must be the line exactly; otherwise it is drawn plain.
export type CodeEditorToken = { text: string; kind?: CodeEditorTokenKind }
// A problem on a line. `line` is 1-based. `from` and `to` are 1-based columns, `from` included and `to` not, and put a
// squiggle under that range (`to` defaults to the end of the line); without `from` the line gets its gutter mark only.
export type CodeEditorMark = { line: number; tone: 'error' | 'warn'; message: string; from?: number; to?: number }

export type CodeEditorProps = Omit<ComponentPropsWithRef<'textarea'>, 'value' | 'defaultValue' | 'onChange' | 'children' | 'wrap' | 'rows' | 'className' | 'ref'> & {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  // Lines to show as the current range (1-based, both included): the step selected elsewhere.
  highlight?: { from: number; to: number } | null
  marks?: CodeEditorMark[]
  // What a screen reader hears for a mark, in the user's language ("Line 40, problem: …"). Default: "40: <message>".
  markLabel?: (mark: CodeEditorMark) => string
  tokenize?: (line: string) => CodeEditorToken[]
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

const NO_MARKS: CodeEditorMark[] = []
const defaultMarkLabel = (mark: CodeEditorMark) => `${mark.line}: ${mark.message}`

// The textarea's own line breaks: its value API turns CRLF and CR into LF, so the drawn lines split the same way.
const splitLines = (text: string) => text.split(/\r\n|\r|\n/)

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

const caretOf = (area: HTMLTextAreaElement) => (area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd)

// One line cut into runs that share a token kind and a squiggle, so each run is one span. Error squiggles win over warnings.
function segments(line: string, tokenize: CodeEditorProps['tokenize'], marks: LineMarks | undefined): Segment[] {
  let tokens: CodeEditorToken[] = tokenize ? tokenize(line) : [{ text: line }]
  if (tokens.map((t) => t.text).join('') !== line) tokens = [{ text: line }]
  const tone: (Tone | undefined)[] = []
  for (const r of marks?.ranges ?? []) {
    for (let c = Math.max(0, r.from); c < Math.min(line.length, r.to); c++) if (tone[c] !== 'error') tone[c] = r.tone
  }
  const out: Segment[] = []
  let col = 0
  for (const token of tokens) {
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

// A code pane: a native textarea (typing, IME, undo, selection and screen readers stay the browser's) over an
// aria-hidden copy of its text that draws a line-number gutter, token colours, a highlighted range and problem marks.
// Lines never wrap: long ones scroll sideways. Both layers sit in one scroller sized to the text, so they move together.
export function CodeEditor({
  value,
  onChange,
  readOnly,
  highlight,
  marks = NO_MARKS,
  markLabel = defaultMarkLabel,
  tokenize,
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
  ...rest
}: CodeEditorProps) {
  const [own, setRef] = useOwnRef<HTMLTextAreaElement>(ref)
  useNameCheck(own, 'CodeEditor')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  const problemsId = `${useId()}-problems`

  const lines = useMemo(() => splitLines(value), [value])
  const byLine = useMemo(() => {
    const map = new Map<number, LineMarks>()
    for (const m of marks) {
      const entry = map.get(m.line) ?? { tone: m.tone, ranges: [] }
      if (m.tone === 'error') entry.tone = 'error'
      if (m.from !== undefined) entry.ranges.push({ from: m.from - 1, to: m.to === undefined ? Infinity : m.to - 1, tone: m.tone })
      map.set(m.line, entry)
    }
    return map
  }, [marks])
  const ordered = useMemo(() => [...marks].sort((a, b) => a.line - b.line || (a.from ?? 0) - (b.from ?? 0)), [marks])
  const band = highlight ? { from: Math.min(highlight.from, highlight.to), to: Math.max(highlight.from, highlight.to) } : null
  const bandEdge = (n: number): string | undefined => {
    if (!band || n < band.from || n > band.to) return undefined
    return n === band.from && n === band.to ? 'both' : n === band.from ? 'start' : n === band.to ? 'end' : ''
  }

  // Keeps the caret in view after an edit: the textarea never scrolls itself, so the scroller around it has to.
  const revealCaret = () => {
    const area = own.current
    const scroller = scrollerRef.current
    const caret = area && caretOf(area)
    if (!area || !scroller || caret === null) return
    const line = codeRef.current?.children[lineOf(area.value, caret) - 1]
    if (!(line instanceof HTMLElement)) return
    revealBand(scroller, line.offsetTop, line.offsetHeight, false)
    const lineStart = caret > 0 ? area.value.lastIndexOf('\n', caret - 1) + 1 : 0
    const x = columnX(line, caret - lineStart)
    if (x === null) return
    // In the scroller's terms: past the sticky gutter and the code's own padding.
    const gutter = gutterRef.current?.offsetWidth ?? 0
    const at = gutter + line.offsetLeft + x
    const margin = line.offsetHeight
    if (at < scroller.scrollLeft + gutter + margin) scroller.scrollLeft = Math.max(0, at - gutter - margin)
    else if (at > scroller.scrollLeft + scroller.clientWidth - margin) scroller.scrollLeft = at - scroller.clientWidth + margin
  }

  // Only after the text changes: moving the caret without typing is the browser's to scroll.
  useLayoutEffect(() => {
    if (own.current && own.current === own.current.ownerDocument.activeElement) revealCaret()
  }, [value])

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
      style={{ '--ui-code-editor-rows': rows, '--ui-code-editor-digits': digits } as CSSProperties}
    >
      <div className="ui-code-editor__scroller" ref={scrollerRef}>
        <div className="ui-code-editor__sheet">
          <div className="ui-code-editor__gutter" ref={gutterRef} aria-hidden="true">
            {lines.map((_, i) => {
              const n = i + 1
              const mark = byLine.get(n)
              return (
                <div key={n} className="ui-code-editor__gutter-row" data-line={n} data-highlight={bandEdge(n)} data-mark={mark?.tone}>
                  <span className="ui-code-editor__mark">{mark && <Glyph name={mark.tone} />}</span>
                  <span className="ui-code-editor__number">{n}</span>
                </div>
              )
            })}
          </div>
          <div className="ui-code-editor__body">
            <div className="ui-code-editor__code" ref={codeRef} aria-hidden="true">
              {lines.map((text, i) => (
                <div key={i} className="ui-code-editor__line" data-line={i + 1} data-highlight={bandEdge(i + 1)}>
                  {segments(text, tokenize, byLine.get(i + 1)).map((s, j) =>
                    s.kind || s.squiggle ? (
                      <span key={j} className="ui-code-editor__token" data-kind={s.kind} data-squiggle={s.squiggle}>
                        {s.text}
                      </span>
                    ) : (
                      s.text
                    )
                  )}
                </div>
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
                reportCaret()
              }}
              onKeyUp={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                onKeyUp?.(e)
                reportCaret()
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
                  revealCaret()
                }
              }}
            />
          </div>
        </div>
      </div>
      {ordered.length > 0 && (
        <ul id={problemsId} className="ui-code-editor__problems">
          {ordered.map((m, i) => (
            <li key={i}>{markLabel(m)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
