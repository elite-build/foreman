// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Field } from '../../src/renderer/src/ui/Field'
import { TextArea } from '../../src/renderer/src/ui/TextArea'

afterEach(cleanup)

describe('TextArea', () => {
  it('is a labelled multi-line textbox that keeps Enter as a newline', async () => {
    render(<Field label="Notes">{(c) => <TextArea {...c} />}</Field>)
    const area = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    expect(area.tagName).toBe('TEXTAREA')
    await userEvent.type(area, 'a{Enter}b')
    expect(area.value).toBe('a\nb')
  })

  it('defaults to 3 rows and takes rows, mono and a ref', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<TextArea aria-label="script" ref={ref} rows={8} mono />)
    expect(ref.current?.rows).toBe(8)
    expect(ref.current?.classList.contains('ui-textarea--mono')).toBe(true)
    cleanup()
    render(<TextArea aria-label="script" />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).rows).toBe(3)
  })

  it('passes change events and read-only through', async () => {
    const onChange = vi.fn()
    render(<TextArea aria-label="a" onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox'), 'xy')
    expect(onChange).toHaveBeenCalledTimes(2)
    cleanup()
    render(<TextArea aria-label="a" readOnly defaultValue="fixed" />)
    await userEvent.type(screen.getByRole('textbox'), 'zz')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('fixed')
  })

  it('fails loudly without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<TextArea />)).toThrow(/TextArea has no accessible name/)
    spy.mockRestore()
  })
})

describe('TextArea bare', () => {
  it('is the same textarea with a class that strips its own box, so a surrounding box can draw it', () => {
    render(<TextArea aria-label="message" bare />)
    const area = screen.getByRole('textbox', { name: 'message' })
    expect(area.classList.contains('ui-textarea--bare')).toBe(true)
    expect(area.classList.contains('ui-textarea')).toBe(true)
  })
})
