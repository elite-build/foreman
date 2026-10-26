// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Combobox, placeList } from '../../src/renderer/src/ui/Combobox'
import { Dialog } from '../../src/renderer/src/ui/Dialog'
import type { ListboxOption } from '../../src/renderer/src/ui/Listbox'

afterEach(cleanup)

const BRANCHES: ListboxOption[] = [
  { value: 'main', label: 'main' },
  { value: 'feature/login', label: 'feature/login' },
  { value: 'feature/logout', label: 'feature/logout', disabled: true, description: 'In use' },
  { value: 'release', label: 'release' }
]

function Demo({ onChange = () => {}, initial = '', onEscape }: { onChange?: (v: string) => void; initial?: string; onEscape?: () => void }) {
  const [query, setQuery] = useState(initial)
  const [value, setValue] = useState<string | null>('main')
  const shown = BRANCHES.filter((b) => b.value.includes(query))
  return (
    <div onKeyDown={(e) => e.key === 'Escape' && onEscape?.()}>
      <Combobox
        label="Branch"
        options={shown}
        value={value}
        query={query}
        onQueryChange={setQuery}
        onChange={(v) => {
          setValue(v)
          onChange(v)
        }}
        empty="No branches match"
        placeholder="main"
      />
    </div>
  )
}

const active = () => document.querySelector('[data-active]')?.textContent

describe('Combobox', () => {
  it('is a named combobox that is closed until asked', () => {
    render(<Demo />)
    const input = screen.getByRole('combobox', { name: 'Branch' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('marks the input chosen when it has a value (the placeholder is the choice), and not without one', () => {
    const { rerender } = render(<Combobox label="Branch" options={BRANCHES} value="main" query="" onQueryChange={() => {}} onChange={() => {}} placeholder="main" />)
    expect(screen.getByRole('combobox').hasAttribute('data-chosen')).toBe(true)
    rerender(<Combobox label="Branch" options={BRANCHES} query="" onQueryChange={() => {}} onChange={() => {}} placeholder="Search" />)
    expect(screen.getByRole('combobox').hasAttribute('data-chosen')).toBe(false)
  })

  it('opens on ArrowDown, with aria-controls and aria-activedescendant pointing into the list', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const input = screen.getByRole('combobox')
    await user.click(input)
    // A click opens it; the cursor starts on the chosen branch.
    const list = screen.getByRole('listbox', { name: 'Branch' })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe(list.id)
    // Focus never leaves the input. The cursor starts on the chosen branch.
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'main' }).id)
  })

  it('moves the cursor with ↑ ↓, skipping a disabled option and wrapping', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(screen.getByRole('combobox'))
    expect(active()).toBe('main')
    await user.keyboard('{ArrowDown}')
    expect(active()).toBe('feature/login')
    await user.keyboard('{ArrowDown}')
    expect(active()).toBe('release')
    await user.keyboard('{ArrowDown}')
    expect(active()).toBe('main')
    await user.keyboard('{ArrowUp}')
    expect(active()).toBe('release')
  })

  it('keeps the input\'s text keys: typing filters, Home and End move the caret, not the list', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const input = screen.getByRole('combobox') as HTMLInputElement
    await user.click(input)
    await user.keyboard('rel')
    expect(input.value).toBe('rel')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Home}')
    expect(input.selectionStart).toBe(0)
    await user.keyboard('{End}')
    expect(input.selectionStart).toBe(3)
    expect(active()).toBe('release')
    // Typing to a state with no matches shows the empty message.
    await user.keyboard('zzz')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('No branches match')
  })

  it('Enter chooses the active option, clears the search and closes; it does not bubble to a form behind', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <Demo onChange={onChange} />
      </div>
    )
    const input = screen.getByRole('combobox') as HTMLInputElement
    await user.click(input)
    await user.keyboard('rel{Enter}')
    expect(onChange).toHaveBeenCalledWith('release')
    expect(input.value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onKeyDown.mock.calls.some(([e]) => e.key === 'Enter')).toBe(false)
  })

  it('Enter with the list closed passes through (a form can submit)', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <Demo />
      </div>
    )
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{Escape}{Enter}')
    expect(onKeyDown.mock.calls.some(([e]) => e.key === 'Enter')).toBe(true)
  })

  it('choosing with the mouse works and keeps focus in the input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    await user.click(screen.getByRole('option', { name: 'release' }))
    expect(onChange).toHaveBeenCalledWith('release')
    expect(document.activeElement).toBe(input)
  })

  it('a disabled option cannot be chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown}')
    await user.click(screen.getByRole('option', { name: /feature\/logout/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Escape closes the list and keeps the page\'s Escape out; the next one clears the text; then it passes on', async () => {
    const user = userEvent.setup()
    const onEscape = vi.fn()
    render(<Demo onEscape={onEscape} />)
    const input = screen.getByRole('combobox') as HTMLInputElement
    await user.click(input)
    await user.keyboard('rel')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.value).toBe('rel')
    await user.keyboard('{Escape}')
    expect(input.value).toBe('')
    expect(onEscape).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('does not close a dialog around it while it is handling Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog title="New workspace" onClose={onClose}>
        <Demo />
      </Dialog>
    )
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown}{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('Tab closes the list and lets focus move on', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <Demo />
        <button>Next</button>
      </div>
    )
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown}')
    await user.tab()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  })

  it('ArrowDown opens it from the keyboard, and ArrowUp too', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const input = screen.getByRole('combobox')
    await user.tab()
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeTruthy()
    await user.keyboard('{Escape}{ArrowUp}')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('can be controlled open (always-on results) and reports closing', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Combobox label="Search" options={BRANCHES} query="" onQueryChange={() => {}} onChange={() => {}} open onOpenChange={onOpenChange} inline />)
    expect(screen.getByRole('listbox')).toBeTruthy()
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not open when disabled', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Search" options={BRANCHES} query="" onQueryChange={() => {}} onChange={() => {}} disabled />)
    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Combobox mono and markup labels', () => {
  it('mono sets the code font on the input and on the options', async () => {
    const user = userEvent.setup()
    render(<Combobox label="Branch" mono options={BRANCHES} query="" onQueryChange={() => undefined} onChange={() => undefined} />)
    const input = screen.getByRole('combobox')
    expect(input.classList.contains('ui-combobox__input--mono')).toBe(true)
    await user.click(input)
    expect(screen.getByRole('listbox').classList.contains('ui-listbox--mono')).toBe(true)
  })

  it('without mono neither is in the code font', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('combobox').classList.contains('ui-combobox__input--mono')).toBe(false)
    expect(screen.getByRole('listbox').classList.contains('ui-listbox--mono')).toBe(false)
  })

  it('shows a ReactNode label (matched letters marked) and names the option by its textValue', async () => {
    const user = userEvent.setup()
    const options: ListboxOption[] = [{ value: 'theme', label: <><mark>The</mark>me</>, textValue: 'Theme' }]
    render(<Combobox label="Search" options={options} query="the" onQueryChange={() => undefined} onChange={() => undefined} open />)
    await user.click(screen.getByRole('combobox'))
    const option = screen.getByRole('option', { name: 'Theme' })
    expect(option.querySelector('mark')?.textContent).toBe('The')
  })
})

describe('placeList', () => {
  it('goes under the field when there is room', () => {
    expect(placeList({ top: 100, bottom: 132, left: 40, width: 300 }, 800)).toEqual({ left: 40, width: 300, maxHeight: 300, top: 136 })
  })

  it('goes over the field when there is more room above and little below', () => {
    expect(placeList({ top: 600, bottom: 632, left: 40, width: 300 }, 700)).toEqual({ left: 40, width: 300, maxHeight: 300, bottom: 104 })
  })

  it('never gets shorter than 120px', () => {
    const style = placeList({ top: 60, bottom: 92, left: 0, width: 100 }, 140)
    expect(style.maxHeight).toBe(120)
  })
})
