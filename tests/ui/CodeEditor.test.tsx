// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor, type CodeEditorMark, type CodeEditorProps, type CodeEditorToken } from '../../src/renderer/src/ui/CodeEditor'
import { Field } from '../../src/renderer/src/ui/Field'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const TOML = ['[steps.qa]', 'kind = "review"', 'persona = "qa-engineer"', 'context = ["diff", "checks.result"]', '', '[edges]'].join('\n')

// Enough of TOML for the tests: a [table] line is a title; otherwise the key before "=" is a property and "…" a string.
const tokenize = (line: string): CodeEditorToken[] => {
  if (line.startsWith('[')) return [{ text: line, kind: 'title' }]
  return line.split(/("[^"]*")/).filter(Boolean).map((text) => (text.startsWith('"') ? { text, kind: 'string' } : { text }))
}

function Controlled(props: Partial<CodeEditorProps> & { initial?: string; onValue?: (v: string) => void }) {
  const { initial = TOML, onValue, ...rest } = props
  const [value, setValue] = useState(initial)
  return (
    <CodeEditor
      aria-label="Flow"
      {...(rest as CodeEditorProps)}
      value={value}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
    />
  )
}

const area = () => screen.getByRole('textbox') as HTMLTextAreaElement
const frame = (container: HTMLElement) => container.querySelector('.ui-code-editor') as HTMLElement
const codeLine = (container: HTMLElement, n: number) => container.querySelector(`.ui-code-editor__line[data-line="${n}"]`) as HTMLElement
const gutterRow = (container: HTMLElement, n: number) => container.querySelector(`.ui-code-editor__gutter-row[data-line="${n}"]`) as HTMLElement
const description = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')

describe('CodeEditor', () => {
  it('is a native multi-line textbox named like any field, and fails loudly without a name', () => {
    render(<Field label="research-then-implement.toml">{(c) => <CodeEditor {...c} value={TOML} onChange={() => {}} />}</Field>)
    const box = screen.getByRole('textbox', { name: 'research-then-implement.toml' })
    expect(box.tagName).toBe('TEXTAREA')
    expect(box.getAttribute('wrap')).toBe('off')
    expect(box.getAttribute('spellcheck')).toBe('false')
    cleanup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<CodeEditor value="" />)).toThrow(/CodeEditor has no accessible name/)
    spy.mockRestore()
  })

  it('calls onChange with the new text, and draws the copy from the value', async () => {
    const onValue = vi.fn()
    const { container } = render(<Controlled initial={'a = 1'} onValue={onValue} />)
    await userEvent.type(area(), '{End}{Enter}b = "x"')
    expect(onValue).toHaveBeenLastCalledWith('a = 1\nb = "x"')
    expect(area().value).toBe('a = 1\nb = "x"')
    expect(codeLine(container, 2).textContent).toBe('b = "x"')
    expect(gutterRow(container, 2).textContent).toBe('2')
  })

  it('draws one gutter row and one line per line of text, empty and trailing lines included', () => {
    const { container } = render(<CodeEditor aria-label="Flow" value={'one\n\nthree\n'} onChange={() => {}} />)
    expect(container.querySelectorAll('.ui-code-editor__line')).toHaveLength(4)
    expect(container.querySelectorAll('.ui-code-editor__gutter-row')).toHaveLength(4)
    expect(codeLine(container, 3).textContent).toBe('three')
  })

  it('colours tokens, and draws a line plain when its tokens do not add up to it', () => {
    const { container } = render(<CodeEditor aria-label="Flow" value={TOML} tokenize={tokenize} onChange={() => {}} />)
    expect(codeLine(container, 1).querySelector('[data-kind="title"]')?.textContent).toBe('[steps.qa]')
    expect(codeLine(container, 2).querySelector('[data-kind="string"]')?.textContent).toBe('"review"')
    expect(codeLine(container, 2).textContent).toBe('kind = "review"')
    cleanup()
    const broken = render(<CodeEditor aria-label="Flow" value={'kind = "turn"'} tokenize={() => [{ text: 'kind', kind: 'property' }]} onChange={() => {}} />)
    const line = codeLine(broken.container, 1)
    expect(line.textContent).toBe('kind = "turn"')
    expect(line.querySelector('[data-kind]')).toBeNull()
  })

  it("puts the marks' messages in the description after the field's own help, in line order", () => {
    const marks: CodeEditorMark[] = [
      { line: 6, tone: 'warn', message: 'Nothing points here.' },
      { line: 4, tone: 'error', message: '"checks.result" is not a step output.', from: 20, to: 35 }
    ]
    render(
      <Field label="Flow" description="TOML">
        {(c) => (
          <CodeEditor {...c} value={TOML} onChange={() => {}} marks={marks} markLabel={(m) => `Line ${m.line}, ${m.tone === 'error' ? 'problem' : 'warning'}: ${m.message}`} />
        )}
      </Field>
    )
    expect(description(area())).toBe('TOML Line 4, problem: "checks.result" is not a step output.Line 6, warning: Nothing points here.')
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['Line 4, problem: "checks.result" is not a step output.', 'Line 6, warning: Nothing points here.'])
  })

  it('takes marks only with a markLabel, which carries the tone in words; without marks there is no list', () => {
    // The gutter shape is hidden from assistive tech, so marks without a label (and so without their tone) don't compile.
    // @ts-expect-error marks need markLabel
    const unlabelled = <CodeEditor aria-label="Flow" value={TOML} onChange={() => {}} marks={[{ line: 2, tone: 'error', message: 'Unknown kind.' }]} />
    expect(unlabelled).toBeTruthy()
    render(<CodeEditor aria-label="Flow" value={TOML} onChange={() => {}} />)
    expect(area().hasAttribute('aria-describedby')).toBe(false)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('draws the marks in an aria-hidden gutter, a diamond for an error and a triangle for a warning, and squiggles the range', () => {
    const marks: CodeEditorMark[] = [
      { line: 4, tone: 'error', message: 'bad', from: 20, to: 35 },
      { line: 4, tone: 'warn', message: 'meh', from: 1, to: 8 },
      { line: 6, tone: 'warn', message: 'later' }
    ]
    const { container } = render(<CodeEditor aria-label="Flow" value={TOML} tokenize={tokenize} onChange={() => {}} marks={marks} markLabel={(m) => m.message} />)
    const gutter = container.querySelector('.ui-code-editor__gutter')!
    expect(gutter.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.ui-code-editor__code')!.getAttribute('aria-hidden')).toBe('true')
    // An error and a warning on one line: the line shows the error's shape.
    expect(gutterRow(container, 4).getAttribute('data-mark')).toBe('error')
    expect(gutterRow(container, 4).querySelector('svg')!.getAttribute('data-glyph')).toBe('error')
    expect(gutterRow(container, 6).querySelector('svg')!.getAttribute('data-glyph')).toBe('warn')
    expect(gutterRow(container, 1).querySelector('svg')).toBeNull()
    const squiggles = [...codeLine(container, 4).querySelectorAll('[data-squiggle]')].map((s) => [s.getAttribute('data-squiggle'), s.textContent])
    expect(squiggles).toEqual([
      ['warn', 'context'],
      ['error', '"checks.result"']
    ])
    // The squiggle splits tokens without changing the text, so the copy still matches the textarea glyph for glyph.
    expect(codeLine(container, 4).textContent).toBe('context = ["diff", "checks.result"]')
    expect(codeLine(container, 6).querySelector('[data-squiggle]')).toBeNull()
  })

  it('gives the highlighted lines the state, with the first and last marked for their edges', () => {
    const { container, rerender } = render(<CodeEditor aria-label="Flow" value={TOML} onChange={() => {}} highlight={{ from: 2, to: 4 }} />)
    expect([1, 2, 3, 4, 5].map((n) => codeLine(container, n).getAttribute('data-highlight'))).toEqual([null, 'start', '', 'end', null])
    expect([1, 2, 3, 4, 5].map((n) => gutterRow(container, n).hasAttribute('data-highlight'))).toEqual([false, true, true, true, false])
    rerender(<CodeEditor aria-label="Flow" value={TOML} onChange={() => {}} highlight={{ from: 6, to: 6 }} />)
    expect(codeLine(container, 6).getAttribute('data-highlight')).toBe('both')
    rerender(<CodeEditor aria-label="Flow" value={TOML} onChange={() => {}} highlight={null} />)
    expect(container.querySelectorAll('[data-highlight]')).toHaveLength(0)
  })

  it('scrolls a line into view when revealLine changes', () => {
    // jsdom has no layout: lines are 20px tall, the scroller shows 100px.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return (Number(this.dataset.line ?? 1) - 1) * 20
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    const long = Array.from({ length: 60 }, (_, i) => `line${i + 1} = ${i}`).join('\n')
    const { container, rerender } = render(<CodeEditor aria-label="Flow" value={long} onChange={() => {}} />)
    const scroller = container.querySelector('.ui-code-editor__scroller') as HTMLElement
    expect(scroller.scrollTop).toBe(0)
    rerender(<CodeEditor aria-label="Flow" value={long} onChange={() => {}} revealLine={30} />)
    // Line 30 starts at 580px; centred in 100px: 580 - (100 - 20) / 2.
    expect(scroller.scrollTop).toBe(540)
    // A line already in view stays where it is.
    rerender(<CodeEditor aria-label="Flow" value={long} onChange={() => {}} revealLine={31} />)
    expect(scroller.scrollTop).toBe(540)
  })

  it('keeps the caret in view while typing, down and across', async () => {
    // jsdom has no layout: lines are 20px tall and 8px a character, after a 40px gutter and 12px of padding; the
    // scroller shows 200 by 100px.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return (Number(this.dataset.line ?? 1) - 1) * 20
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(12)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200)
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        return { left: this.startOffset * 8, right: this.endOffset * 8, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
      }
    })
    try {
      const long = Array.from({ length: 60 }, () => 'x = 1').join('\n')
      const { container } = render(<Controlled initial={long} />)
      const scroller = container.querySelector('.ui-code-editor__scroller') as HTMLElement
      await userEvent.type(area(), 'y'.repeat(40), { initialSelectionStart: long.length, initialSelectionEnd: long.length })
      // Line 60 (1180px down) just inside the bottom edge; column 45 (40 + 12 + 360px across) a line height inside the right.
      expect(scroller.scrollTop).toBe(1100)
      expect(scroller.scrollLeft).toBe(232)
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })

  it('brings a caret moved without typing out from under the sticky gutter', () => {
    // The same layout as above: a 40px gutter, 12px of padding, 8px a character.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return (Number(this.dataset.line ?? 1) - 1) * 20
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(12)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200)
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        return { left: this.startOffset * 8, right: this.endOffset * 8, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
      }
    })
    try {
      const { container } = render(<Controlled initial={`${'k'.repeat(100)}\nshort`} />)
      const scroller = container.querySelector('.ui-code-editor__scroller') as HTMLElement
      const box = area()
      box.focus()
      // Scrolled sideways, Home puts the caret at column 0: the whole start of the line comes back.
      scroller.scrollLeft = 300
      box.setSelectionRange(0, 0)
      fireEvent.keyUp(box, { key: 'Home' })
      expect(scroller.scrollLeft).toBe(0)
      // A caret clear of the gutter and padding (column 40: 40 + 12 + 320px, past 300 + 40 + 12) leaves the scroll alone.
      scroller.scrollLeft = 300
      box.setSelectionRange(40, 40)
      fireEvent.select(box)
      expect(scroller.scrollLeft).toBe(300)
      // ArrowLeft to column 33 (40 + 12 + 264px) would sit under them: it scrolls just far enough.
      box.setSelectionRange(33, 33)
      fireEvent.keyUp(box, { key: 'ArrowLeft' })
      expect(scroller.scrollLeft).toBe(264)
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })

  it('pages the caret by the lines in view, at the same column, and Shift extends the selection', () => {
    // Lines are 20px tall and the scroller shows 100px: five lines, so a page is four.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return (Number(this.dataset.line ?? 1) - 1) * 20
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1} = ${i}`)
    const text = lines.join('\n')
    const at = (line: number, col: number) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col
    const onCaretLine = vi.fn()
    const { container } = render(<Controlled initial={text} onCaretLine={onCaretLine} />)
    const scroller = container.querySelector('.ui-code-editor__scroller') as HTMLElement
    const box = area()
    box.focus()
    box.setSelectionRange(at(2, 3), at(2, 3))
    expect(fireEvent.keyDown(box, { key: 'PageDown' })).toBe(false)
    expect([box.selectionStart, box.selectionEnd]).toEqual([at(6, 3), at(6, 3)])
    expect(scroller.scrollTop).toBe(80)
    fireEvent.keyUp(box, { key: 'PageDown' })
    expect(onCaretLine).toHaveBeenLastCalledWith(6)
    // Shift+PageUp twice: the selection grows back from line 6 to line 2, then to the start of the text.
    fireEvent.keyDown(box, { key: 'PageUp', shiftKey: true })
    expect([box.selectionStart, box.selectionEnd, box.selectionDirection]).toEqual([at(2, 3), at(6, 3), 'backward'])
    fireEvent.keyDown(box, { key: 'PageUp', shiftKey: true })
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, at(6, 3)])
    expect(scroller.scrollTop).toBe(0)
    // Past the last line, the end of the text; with a modifier, the key is left alone.
    box.setSelectionRange(at(58, 1), at(58, 1))
    fireEvent.keyDown(box, { key: 'PageDown' })
    expect(box.selectionStart).toBe(text.length)
    expect(fireEvent.keyDown(box, { key: 'PageUp', ctrlKey: true })).toBe(true)
    expect(box.selectionStart).toBe(text.length)
  })

  it('shows the textarea its own text while an IME composes', () => {
    const { container } = render(<Controlled />)
    fireEvent.compositionStart(area())
    expect(frame(container).hasAttribute('data-composing')).toBe(true)
    fireEvent.compositionEnd(area())
    expect(frame(container).hasAttribute('data-composing')).toBe(false)
  })

  it("reports the caret's line on select, key up and click", () => {
    const onCaretLine = vi.fn()
    render(<Controlled onCaretLine={onCaretLine} />)
    const box = area()
    box.focus()
    box.setSelectionRange(TOML.indexOf('persona'), TOML.indexOf('persona'))
    fireEvent.keyUp(box, { key: 'ArrowDown' })
    expect(onCaretLine).toHaveBeenLastCalledWith(3)
    box.setSelectionRange(0, 0)
    fireEvent.click(box)
    expect(onCaretLine).toHaveBeenLastCalledWith(1)
    box.setSelectionRange(TOML.indexOf('[edges]'), TOML.length)
    fireEvent.select(box)
    expect(onCaretLine).toHaveBeenLastCalledWith(6)
  })

  it('read only: the text can be selected but not changed', async () => {
    const onChange = vi.fn()
    const { container } = render(<CodeEditor aria-label="Flow" value={TOML} readOnly onChange={onChange} />)
    await userEvent.type(area(), 'zz')
    expect(area().readOnly).toBe(true)
    expect(area().value).toBe(TOML)
    expect(onChange).not.toHaveBeenCalled()
    expect(frame(container).hasAttribute('data-readonly')).toBe(true)
  })

  it('takes a ref, layout className on the frame, rows, and marks the frame invalid with the field', () => {
    const ref = createRef<HTMLTextAreaElement>()
    const { container } = render(
      <Field label="Flow" error="Can't save">
        {(c) => <CodeEditor {...c} ref={ref} className="flow-editor" rows={20} value={TOML} onChange={() => {}} />}
      </Field>
    )
    expect(ref.current).toBe(area())
    expect(frame(container).classList.contains('flow-editor')).toBe(true)
    expect(frame(container).style.getPropertyValue('--ui-code-editor-rows')).toBe('20')
    expect(frame(container).hasAttribute('data-invalid')).toBe(true)
    expect(area().getAttribute('aria-invalid')).toBe('true')
  })
})
