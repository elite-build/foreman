// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaThumb } from '../../src/renderer/src/ui/MediaThumb'

afterEach(cleanup)

describe('MediaThumb', () => {
  it('shows the picture as decoration and the name as text', () => {
    const { container } = render(<MediaThumb src="x.png" name="shot.png" />)
    expect(screen.getByText('shot.png').className).toBe('ui-media-thumb__name')
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows children (an icon) when there is no picture', () => {
    const { container } = render(<MediaThumb name="notes.txt"><svg data-testid="i" /></MediaThumb>)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('i')).toBeTruthy()
  })

  it('has a remove button named by removeLabel that calls onRemove', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<MediaThumb src="x.png" name="shot.png" onRemove={onRemove} removeLabel="Remove shot.png" />)
    const b = screen.getByRole('button', { name: 'Remove shot.png' })
    expect(b.getAttribute('type')).toBe('button')
    await user.click(b)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('removes by keyboard: Tab reaches the button and Enter or Space activates it', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<MediaThumb src="x.png" name="shot.png" onRemove={onRemove} removeLabel="Remove shot.png" />)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove shot.png' }))
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onRemove).toHaveBeenCalledTimes(2)
  })

  it('keeps the button inside the thumbnail so the stylesheet can reveal it on focus-within', async () => {
    const user = userEvent.setup()
    const { container } = render(<MediaThumb src="x.png" name="a.png" onRemove={() => undefined} removeLabel="Remove a.png" />)
    await user.tab()
    expect(container.querySelector('.ui-media-thumb:focus-within')).not.toBeNull()
  })

  it('fails loudly when onRemove has no accessible name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => render(<MediaThumb src="x.png" name="a.png" onRemove={() => undefined} />)).toThrow(/removeLabel/)
    } finally {
      spy.mockRestore()
    }
  })
})
