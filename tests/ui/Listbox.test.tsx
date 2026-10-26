// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Listbox, type ListboxOption } from '../../src/renderer/src/ui/Listbox'

afterEach(cleanup)

const OPTIONS: ListboxOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français', disabled: true },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' }
]

function Demo({ onChange = () => {}, initial = 'en', wrap }: { onChange?: (v: string) => void; initial?: string; wrap?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <Listbox
      label="Language"
      options={OPTIONS}
      value={value}
      wrap={wrap}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

const active = () => document.querySelector('[data-active]')?.textContent

describe('Listbox', () => {
  it('is a named listbox of options, with the chosen one selected and the rest not', () => {
    render(<Demo initial="es" />)
    const list = screen.getByRole('listbox', { name: 'Language' })
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false', 'false'])
    expect(screen.getByRole('option', { name: 'Français' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('is one tab stop, with the active option named by aria-activedescendant (options never take focus)', async () => {
    const user = userEvent.setup()
    render(<Demo initial="es" />)
    const list = screen.getByRole('listbox')
    expect(list.tabIndex).toBe(0)
    await user.tab()
    expect(document.activeElement).toBe(list)
    // Starts on the chosen option.
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Español' }).id)
    for (const option of screen.getAllByRole('option')) expect(option.hasAttribute('tabindex')).toBe(false)
  })

  it('moves with the arrows, skipping a disabled option, and stops at the ends (or wraps on request)', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Demo initial="es" />)
    await user.tab()
    await user.keyboard('{ArrowDown}')
    expect(active()).toBe('Deutsch')
    await user.keyboard('{ArrowUp}')
    expect(active()).toBe('Español')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(active()).toBe('English')
    rerender(<Demo initial="es" wrap />)
    await user.keyboard('{ArrowUp}')
    expect(active()).toBe('Português')
  })

  it('Home and End jump to the first and last enabled option', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.tab()
    await user.keyboard('{End}')
    expect(active()).toBe('Português')
    await user.keyboard('{Home}')
    expect(active()).toBe('English')
  })

  it('types ahead to an option, and skips disabled ones', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.tab()
    await user.keyboard('d')
    expect(active()).toBe('Deutsch')
    await user.keyboard('f')
    // "Français" is disabled: no match, the cursor stays.
    expect(active()).toBe('Deutsch')
  })

  it('Enter and Space choose the active option; a disabled option cannot be chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    await user.tab()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('es')
    await user.keyboard('{ArrowDown} ')
    expect(onChange).toHaveBeenLastCalledWith('de')
    onChange.mockClear()
    await user.click(screen.getByRole('option', { name: 'Français' }))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('option', { name: 'Português' }))
    expect(onChange).toHaveBeenCalledWith('pt')
  })

  it('follows the pointer', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.hover(screen.getByRole('option', { name: 'Deutsch' }))
    expect(active()).toBe('Deutsch')
    await user.hover(screen.getByRole('option', { name: 'Français' }))
    expect(active()).toBe('Deutsch')
  })

  it('can have its active option driven from outside', () => {
    const onActiveChange = vi.fn()
    render(<Listbox label="L" options={OPTIONS} onChange={() => {}} activeIndex={3} onActiveChange={onActiveChange} />)
    expect(active()).toBe('Deutsch')
  })

  it('groups consecutive options under a labelled group and shows long text without breaking', () => {
    const options: ListboxOption[] = [
      { value: 'a', label: 'Alpha', group: 'First' },
      { value: 'b', label: 'Beta', group: 'First', description: 'A very long description '.repeat(10) },
      { value: 'c', label: 'Gamma', group: 'Second' },
      { value: 'd', label: 'Loose' }
    ]
    render(<Listbox label="L" options={options} onChange={() => {}} />)
    const first = screen.getByRole('group', { name: 'First' })
    expect(within(first).getAllByRole('option').map((o) => o.textContent)).toEqual(['Alpha', 'BetaA very long description A very long description A very long description A very long description A very long description A very long description A very long description A very long description A very long description A very long description '])
    expect(within(screen.getByRole('group', { name: 'Second' })).getAllByRole('option')).toHaveLength(1)
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('inside a combobox it is not a tab stop, and keeps focus where it was on mousedown', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <input aria-label="Field" />
        <Listbox label="L" options={OPTIONS} onChange={() => {}} focusable={false} />
      </div>
    )
    expect(screen.getByRole('listbox').hasAttribute('tabindex')).toBe(false)
    const field = screen.getByLabelText('Field')
    await user.click(field)
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('option', { name: 'Deutsch' }) })
    expect(document.activeElement).toBe(field)
  })
})

describe('Listbox lang and mono', () => {
  it('puts lang on an option and the code font on the list on request', () => {
    render(<Listbox label="Language" mono options={[{ value: 'ja', label: '日本語', lang: 'ja' }, { value: 'en', label: 'English' }]} onChange={() => undefined} />)
    expect(screen.getByRole('option', { name: '日本語' }).getAttribute('lang')).toBe('ja')
    expect(screen.getByRole('option', { name: 'English' }).hasAttribute('lang')).toBe(false)
    expect(screen.getByRole('listbox', { name: 'Language' }).classList.contains('ui-listbox--mono')).toBe(true)
  })
})

describe('Listbox markup labels', () => {
  const marked = (text: string, at: number) => (
    <>
      {text.slice(0, at)}
      <mark>{text[at]}</mark>
      {text.slice(at + 1)}
    </>
  )
  const options: ListboxOption[] = [
    { value: 'a', label: marked('Alpha', 0), textValue: 'Alpha' },
    { value: 'b', label: marked('Beta', 0), textValue: 'Beta' },
    { value: 'c', label: 'Gamma' }
  ]

  it('renders a ReactNode label and names the option by its textValue', () => {
    render(<Listbox label="Pages" options={options} onChange={() => undefined} />)
    expect(screen.getByRole('option', { name: 'Alpha' }).querySelector('mark')?.textContent).toBe('A')
    expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('aria-label')).toBe('Alpha')
    // A plain string label stays its own name.
    expect(screen.getByRole('option', { name: 'Gamma' }).hasAttribute('aria-label')).toBe(false)
  })

  it('typeahead matches the textValue, not the markup', async () => {
    const user = userEvent.setup()
    render(<Listbox label="Pages" options={options} onChange={() => undefined} />)
    screen.getByRole('listbox').focus()
    await user.keyboard('b')
    expect(active()).toBe('Beta')
  })
})
