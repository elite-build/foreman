// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextInput } from '../../src/renderer/src/ui/TextInput'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

describe('TextInput bare', () => {
  it('adds the bare class, alone or with mono and a layout class, and nothing by default', () => {
    render(
      <>
        <TextInput aria-label="plain" />
        <TextInput aria-label="bare" bare />
        <TextInput aria-label="both" bare mono className="find-input" />
      </>
    )
    expect(screen.getByLabelText('plain').className).toBe('ui-control ui-input')
    expect(screen.getByLabelText('bare').className).toBe('ui-control ui-input ui-input--bare')
    expect(screen.getByLabelText('both').className).toBe('ui-control ui-input ui-input--mono ui-input--bare find-input')
  })

  it('stays an ordinary, named, controlled input', async () => {
    const onChange = vi.fn()
    render(<TextInput aria-label="Find" bare value="" onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Find' }), 'a')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('strips the border, background and padding, and its own focus ring (the bar shows focus)', () => {
    const css = readCss('text-input')
    const body = ruleBody(css, '.ui-control.ui-input--bare') ?? ''
    expect(body).toMatch(/border:\s*0/)
    expect(body).toMatch(/background:\s*none/)
    expect(body).toMatch(/padding:\s*0/)
    expect(ruleBody(css, '.ui-control.ui-input--bare:focus-visible')).toMatch(/outline:\s*none/)
  })
})

describe('TextInput', () => {
  it('renders each type with the right role', () => {
    render(
      <>
        <TextInput aria-label="text" />
        <TextInput aria-label="number" type="number" />
        <TextInput aria-label="search" type="search" />
        <TextInput aria-label="password" type="password" />
        <TextInput aria-label="date" type="date" />
        <TextInput aria-label="time" type="time" />
      </>
    )
    expect(screen.getByRole('textbox', { name: 'text' }).getAttribute('type')).toBe('text')
    expect(screen.getByRole('spinbutton', { name: 'number' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'search' })).toBeTruthy()
    expect(screen.getByLabelText('password').getAttribute('type')).toBe('password')
    expect(screen.getByLabelText('date').getAttribute('type')).toBe('date')
    expect(screen.getByLabelText('time').getAttribute('type')).toBe('time')
  })

  it('works controlled and passes native change events through', async () => {
    const seen: string[] = []
    function Box() {
      const [value, setValue] = useState('a')
      return (
        <TextInput
          aria-label="name"
          value={value}
          onChange={(e) => {
            seen.push(e.target.value)
            setValue(e.target.value)
          }}
        />
      )
    }
    render(<Box />)
    await userEvent.type(screen.getByRole('textbox'), 'bc')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('abc')
    expect(seen).toEqual(['ab', 'abc'])
  })

  it('leaves the text-editing and Enter keys to the input and the caller', async () => {
    const onKeyDown = vi.fn()
    render(<TextInput aria-label="name" defaultValue="hello" onKeyDown={onKeyDown} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.click(input)
    await userEvent.keyboard('{Home}X{End}Y{Enter}')
    expect(input.value).toBe('XhelloY')
    expect(onKeyDown.mock.calls.map((c) => c[0].key)).toEqual(['Home', 'X', 'End', 'Y', 'Enter'])
  })

  it('applies the mono variant and keeps the caller className and own attributes', () => {
    render(<TextInput aria-label="path" mono className="wide" placeholder="~/code" disabled />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.classList.contains('ui-input--mono')).toBe(true)
    expect(input.classList.contains('wide')).toBe(true)
    expect(input.disabled).toBe(true)
    expect(input.placeholder).toBe('~/code')
  })

  it('compact adds the class and makes the box smaller, with 12px text; the code font keeps the ligature setting', () => {
    render(<TextInput aria-label="rename" compact className="tab-rename" />)
    expect(screen.getByLabelText('rename').className).toBe('ui-control ui-input ui-input--compact tab-rename')
    const css = readCss('text-input')
    expect(ruleBody(css, '.ui-control.ui-input--compact')).toMatch(/font-size:\s*var\(--text-sm\)/)
    expect(ruleBody(css, '.ui-input--mono')).toMatch(/font-variant-ligatures:\s*var\(--code-ligatures\)/)
  })

  it('takes a width as a style', () => {
    render(<TextInput aria-label="n" width={90} />)
    expect(screen.getByRole('textbox').style.width).toBe('90px')
  })

  it('does not let a caller change the type through rest props typed away', () => {
    render(<TextInput aria-label="n" type="number" />)
    expect(screen.getByRole('spinbutton').getAttribute('type')).toBe('number')
  })
})
