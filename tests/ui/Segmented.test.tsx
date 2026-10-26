// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Segmented, type SegmentOption } from '../../src/renderer/src/ui/Segmented'

afterEach(cleanup)

const options: SegmentOption<string>[] = [
  { value: 'rich', label: 'Rich' },
  { value: 'source', label: 'Source' },
  { value: 'split', label: 'Split', disabled: true, title: 'Not available for this file' },
  { value: 'diff', label: 'Diff' }
]

function Controlled({ initial, list = options, onChange }: { initial: string | undefined; list?: SegmentOption<string>[]; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <Segmented value={value} options={list} label="Markdown view" onChange={(v) => (onChange?.(v), setValue(v))} />
      <button>after</button>
    </>
  )
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('Segmented', () => {
  it('is a named radio group with the picked option checked', () => {
    render(<Controlled initial="source" />)
    expect(screen.getByRole('radiogroup', { name: 'Markdown view' })).toBeTruthy()
    expect(radio('Source').getAttribute('aria-checked')).toBe('true')
    expect(radio('Rich').getAttribute('aria-checked')).toBe('false')
    expect(radio('Split').getAttribute('title')).toBe('Not available for this file')
  })

  it('has one Tab stop, on the picked option', async () => {
    const user = userEvent.setup()
    render(<Controlled initial="source" />)
    await user.tab()
    expect(document.activeElement).toBe(radio('Source'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('puts the Tab stop on the first enabled option when the picked one is disabled', async () => {
    const user = userEvent.setup()
    render(<Controlled initial="split" />)
    expect(radio('Split').tabIndex).toBe(-1)
    await user.tab()
    expect(document.activeElement).toBe(radio('Rich'))
  })

  it('has a Tab stop when nothing is picked', async () => {
    const user = userEvent.setup()
    render(<Controlled initial={undefined} />)
    await user.tab()
    expect(document.activeElement).toBe(radio('Rich'))
    await user.keyboard('{ArrowRight}')
    expect(radio('Source').getAttribute('aria-checked')).toBe('true')
  })

  it('arrows pick and focus, skip disabled options and wrap', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled initial="source" onChange={onChange} />)
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(radio('Diff'))
    expect(radio('Diff').getAttribute('aria-checked')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(radio('Rich'))
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(radio('Diff'))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(radio('Source'))
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['diff', 'rich', 'diff', 'source'])
  })

  it('Home and End go to the first and last enabled option', async () => {
    const user = userEvent.setup()
    const list = [{ ...options[0], disabled: true }, options[1], options[3]]
    render(<Controlled initial="source" list={list} />)
    await user.tab()
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(radio('Diff'))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(radio('Source'))
  })

  it('does not call onChange for the picked option, and ignores clicks on a disabled one', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled initial="rich" onChange={onChange} />)
    await user.click(radio('Rich'))
    await user.click(radio('Split'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(radio('Diff'))
    expect(onChange).toHaveBeenCalledWith('diff')
  })

  it('stays controlled: an arrow reports the change but the value is the parent\'s', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Segmented value="rich" options={options} label="View" onChange={onChange} />)
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenCalledWith('source')
    expect(radio('Rich').getAttribute('aria-checked')).toBe('true')
  })

  it('takes the plain and small looks and layout classes', () => {
    render(<Segmented value="rich" options={options} label="View" plain small className="mine" onChange={() => {}} />)
    const group = screen.getByRole('radiogroup')
    expect(group.className).toContain('ui-segmented--plain')
    expect(group.className).toContain('ui-segmented--small')
    expect(group.className).toContain('mine')
  })
})
