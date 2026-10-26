// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pressable, findInteractiveDescendant } from '../../src/renderer/src/ui/Pressable'

afterEach(cleanup)

describe('Pressable', () => {
  it('is a button with type=button that fires on click and keys', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Pressable onClick={onClick}>Open</Pressable>)
    const b = screen.getByRole('button', { name: 'Open' })
    expect(b.getAttribute('type')).toBe('button')
    await user.tab()
    expect(document.activeElement).toBe(b)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    await user.click(b)
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('passes ref (a ref object and a callback) and native props through', () => {
    const ref = createRef<HTMLButtonElement>()
    const { unmount } = render(<Pressable ref={ref} className="layout" aria-label="Card" aria-describedby="d">x</Pressable>)
    const b = screen.getByRole('button', { name: 'Card' })
    expect(ref.current).toBe(b)
    expect(b.className).toBe('ui-pressable layout')
    unmount()
    const seen: (HTMLButtonElement | null)[] = []
    render(<Pressable ref={(n) => void seen.push(n)}>y</Pressable>)
    expect(seen[0]).toBeInstanceOf(HTMLButtonElement)
  })

  it('does not let callers override type or role', () => {
    // @ts-expect-error not props
    render(<Pressable type="submit" role="link">Go</Pressable>)
    const b = screen.getByRole('button', { name: 'Go' })
    expect(b.getAttribute('type')).toBe('button')
  })

  it('is skipped by Tab and does not fire when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Pressable disabled onClick={onClick}>Off</Pressable>)
    await user.tab()
    expect(document.activeElement).toBe(document.body)
    await user.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('fails loudly in development when it contains an interactive element', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() =>
        render(
          <Pressable>
            Card <button type="button">nested</button>
          </Pressable>
        )
      ).toThrow(/must not contain interactive content/)
    } finally {
      spy.mockRestore()
    }
  })

  it('accepts static content: text, images, spans and svg', () => {
    render(
      <Pressable>
        <span>Title</span>
        <img alt="" src="x.png" />
        <svg aria-hidden="true" />
      </Pressable>
    )
    expect(screen.getByRole('button', { name: 'Title' })).toBeTruthy()
  })
})

describe('findInteractiveDescendant', () => {
  const make = (html: string) => {
    const el = document.createElement('div')
    el.innerHTML = html
    return el
  }

  it.each([
    ['a link', '<a href="/x">x</a>'],
    ['a button', '<button>x</button>'],
    ['an input', '<input />'],
    ['a select', '<select></select>'],
    ['a textarea', '<textarea></textarea>'],
    ['a tabindex', '<span tabindex="0">x</span>'],
    ['a role=button', '<span role="button">x</span>'],
    ['a role=checkbox', '<span role="checkbox"></span>'],
    ['a contenteditable', '<div contenteditable="true"></div>'],
    ['a summary', '<details><summary>x</summary></details>']
  ])('finds %s', (_name, html) => {
    expect(findInteractiveDescendant(make(`<div>${html}</div>`))).not.toBeNull()
  })

  it('ignores an anchor without href and plain content', () => {
    expect(findInteractiveDescendant(make('<a>x</a><span>y</span><img alt="" /><svg></svg>'))).toBeNull()
  })
})
