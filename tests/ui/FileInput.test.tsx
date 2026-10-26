// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Field } from '../../src/renderer/src/ui/Field'
import { FileInput } from '../../src/renderer/src/ui/FileInput'

afterEach(cleanup)

const file = (name: string) => new File(['x'], name, { type: 'image/png' })

describe('FileInput', () => {
  it('is a native file input named by its Field, with the button text and an empty state beside it', () => {
    render(<Field label="Icon">{(c) => <FileInput {...c} chooseLabel="Choose…" noneLabel="Nothing chosen" accept="image/*" />}</Field>)
    const input = screen.getByLabelText('Icon') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.accept).toBe('image/*')
    expect(screen.getByText('Choose…')).toBeTruthy()
    expect(screen.getByText('Nothing chosen')).toBeTruthy()
  })

  it('shows the chosen names and passes the native change event through', async () => {
    const onChange = vi.fn()
    render(<FileInput aria-label="Icon" chooseLabel="Choose" noneLabel="None" multiple onChange={onChange} />)
    await userEvent.upload(screen.getByLabelText('Icon'), [file('a.png'), file('b.png')])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].target.files).toHaveLength(2)
    expect(screen.getByText('a.png, b.png')).toBeTruthy()
    expect(screen.queryByText('None')).toBeNull()
  })

  it('still shows the names when the handler clears the input at once', async () => {
    render(
      <FileInput
        aria-label="Icon"
        chooseLabel="Choose"
        noneLabel="None"
        onChange={(e) => {
          e.target.value = ''
        }}
      />
    )
    await userEvent.upload(screen.getByLabelText('Icon'), file('logo.png'))
    expect(screen.getByText('logo.png')).toBeTruthy()
  })

  it('can hide the names, and can be disabled', () => {
    render(<FileInput aria-label="Icon" chooseLabel="Choose" noneLabel="None" showNames={false} disabled />)
    expect(screen.queryByText('None')).toBeNull()
    expect((screen.getByLabelText('Icon') as HTMLInputElement).disabled).toBe(true)
  })

  it('fails loudly without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<FileInput chooseLabel="Choose" noneLabel="None" />)).toThrow(/FileInput has no accessible name/)
    spy.mockRestore()
  })
})
