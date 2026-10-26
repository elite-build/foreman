// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Field, useField } from '../../src/renderer/src/ui/Field'
import { TextInput } from '../../src/renderer/src/ui/TextInput'

afterEach(cleanup)

describe('Field', () => {
  it('names the control by its label', () => {
    render(<Field label="Branch">{(c) => <TextInput {...c} />}</Field>)
    const input = screen.getByRole('textbox', { name: 'Branch' })
    expect(input.id).toBeTruthy()
    expect(document.querySelector('label')?.getAttribute('for')).toBe(input.id)
  })

  it('describes the control with its help text', () => {
    render(
      <Field label="Branch" description="Letters and dashes only">
        {(c) => <TextInput {...c} />}
      </Field>
    )
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe(screen.getByText('Letters and dashes only').id)
  })

  it('marks the control invalid and points at the error, which is announced', () => {
    render(
      <Field label="Branch" description="Help" error="Already exists">
        {(c) => <TextInput {...c} />}
      </Field>
    )
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = screen.getByRole('alert')
    expect(error.textContent).toContain('Already exists')
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(screen.getByText('Help').id)
  })

  it('does not reference help or error elements that are not rendered', () => {
    render(<Field label="Branch">{(c) => <TextInput {...c} />}</Field>)
    expect(screen.getByRole('textbox').hasAttribute('aria-describedby')).toBe(false)
    expect(screen.getByRole('textbox').hasAttribute('aria-invalid')).toBe(false)
  })

  it('keeps a hidden label as the accessible name', () => {
    render(
      <Field label="Search" hideLabel>
        {(c) => <TextInput type="search" {...c} />}
      </Field>
    )
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy()
    expect(screen.getByText('Search').hasAttribute('data-hidden')).toBe(true)
  })

  it('gives two fields different ids', () => {
    render(
      <>
        <Field label="One">{(c) => <TextInput {...c} />}</Field>
        <Field label="Two">{(c) => <TextInput {...c} />}</Field>
      </>
    )
    expect(screen.getByLabelText('One').id).not.toBe(screen.getByLabelText('Two').id)
  })
})

describe('useField', () => {
  function Row({ error }: { error?: boolean }) {
    const field = useField({ description: true, error })
    return (
      <div>
        <label {...field.labelProps}>Token</label>
        <p {...field.descriptionProps}>Paste it</p>
        <input {...field.controlProps} />
        {error && <p {...field.errorProps}>Expired</p>}
      </div>
    )
  }

  it('binds a hand-laid-out row', () => {
    render(<Row error />)
    const input = screen.getByLabelText('Token')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(`${screen.getByText('Paste it').id} ${screen.getByText('Expired').id}`)
  })

  it('uses a given id', () => {
    function Fixed() {
      const field = useField({ id: 'fixed' })
      return <input aria-label="x" {...field.controlProps} />
    }
    render(<Fixed />)
    expect(screen.getByLabelText('x').id).toBe('fixed')
  })
})

describe('unnamed controls (dev check)', () => {
  it('fails loudly when a control has no accessible name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<TextInput />)).toThrow(/no accessible name/)
    spy.mockRestore()
  })

  it('accepts aria-label, aria-labelledby and an outside label', () => {
    render(
      <>
        <TextInput aria-label="A" />
        <span id="b">B</span>
        <TextInput aria-labelledby="b" />
        <label htmlFor="c">C</label>
        <TextInput id="c" />
      </>
    )
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
  })

  it('forwards refs to the input, as an object or a callback', () => {
    const object = createRef<HTMLInputElement>()
    const callback = vi.fn()
    render(
      <>
        <TextInput aria-label="A" ref={object} />
        <TextInput aria-label="B" ref={callback} />
      </>
    )
    expect(object.current).toBe(screen.getByLabelText('A'))
    expect(callback).toHaveBeenCalledWith(screen.getByLabelText('B'))
  })
})
