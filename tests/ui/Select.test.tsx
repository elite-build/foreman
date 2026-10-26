// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Field } from '../../src/renderer/src/ui/Field'
import { Select } from '../../src/renderer/src/ui/Select'

afterEach(cleanup)

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', group: 'Group' },
  { value: 'c', label: 'Gamma', group: 'Group', disabled: true }
]

describe('Select', () => {
  it('is a named combobox showing the current value', () => {
    render(<Select label="Greek" value="b" options={options} onChange={() => {}} />)
    const select = screen.getByRole('combobox', { name: 'Greek' }) as HTMLSelectElement
    expect(select.value).toBe('b')
  })

  it('calls onChange with the value, not the event', async () => {
    const onChange = vi.fn()
    render(<Select label="Greek" value="a" options={options} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'b')
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('puts grouped options in an optgroup and keeps disabled options disabled', () => {
    render(<Select label="Greek" value="a" options={options} onChange={() => {}} />)
    const group = screen.getByRole('group', { name: 'Group' })
    expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual(['Beta', 'Gamma'])
    expect((screen.getByRole('option', { name: 'Gamma' }) as HTMLOptionElement).disabled).toBe(true)
  })

  it('takes its name from a Field, passes Field wiring through, and sets a width', () => {
    render(
      <Field label="Letter" error="Pick one">
        {(c) => <Select {...c} value="a" options={options} onChange={() => {}} width={120} />}
      </Field>
    )
    const select = screen.getByRole('combobox', { name: 'Letter' })
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect(select.style.width).toBe('120px')
  })

  it('is not changed when disabled', async () => {
    const onChange = vi.fn()
    render(<Select label="Greek" value="a" options={options} onChange={onChange} disabled />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'b')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fails loudly without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Select value="a" options={options} onChange={() => {}} />)).toThrow(/Select has no accessible name/)
    spy.mockRestore()
  })
})
