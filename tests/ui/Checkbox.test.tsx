// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checkbox } from '../../src/renderer/src/ui/Checkbox'

afterEach(cleanup)

describe('Checkbox', () => {
  it('is named by its label and toggles from the label, Space and a click', async () => {
    function Box() {
      const [on, setOn] = useState(false)
      return (
        <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)}>
          Resume at 14:30
        </Checkbox>
      )
    }
    render(<Box />)
    const box = screen.getByRole('checkbox', { name: 'Resume at 14:30' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.click(screen.getByText('Resume at 14:30'))
    expect(box.checked).toBe(true)
    box.focus()
    await userEvent.keyboard(' ')
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('puts className on the label row and the ref on the input', () => {
    const ref = createRef<HTMLInputElement>()
    render(
      <Checkbox ref={ref} className="row">
        Keep
      </Checkbox>
    )
    expect(ref.current?.type).toBe('checkbox')
    expect(ref.current?.closest('label')?.classList.contains('row')).toBe(true)
  })

  it('shows the mixed state through the indeterminate property', () => {
    const { rerender } = render(<Checkbox indeterminate>All</Checkbox>)
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.indeterminate).toBe(true)
    rerender(<Checkbox indeterminate={false}>All</Checkbox>)
    expect(box.indeterminate).toBe(false)
  })

  it('does not toggle when disabled', async () => {
    const onChange = vi.fn()
    render(
      <Checkbox disabled onChange={onChange}>
        Locked
      </Checkbox>
    )
    await userEvent.click(screen.getByText('Locked'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('accepts aria-label when there are no children, and fails loudly with neither', () => {
    render(<Checkbox aria-label="Select row" />)
    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeTruthy()
    cleanup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Checkbox />)).toThrow(/Checkbox has no accessible name/)
    spy.mockRestore()
  })
})
