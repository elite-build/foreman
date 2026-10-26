// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaskedValue } from '../../src/renderer/src/ui/MaskedValue'

const labels = { copy: 'Copy API key', reveal: 'Reveal API key', hide: 'Hide API key', edit: 'Edit API key', remove: 'Remove API key' }

afterEach(cleanup)

let writeText: ReturnType<typeof vi.fn>
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('MaskedValue', () => {
  it('is a named group showing a mask and the hint, with no secret in the page', () => {
    const reveal = vi.fn().mockResolvedValue('sk-secret-abcd')
    render(<MaskedValue label="API key" labels={labels} hint="abcd" reveal={reveal} />)
    expect(screen.getByRole('group', { name: 'API key' }).textContent).toContain('••••••••abcd')
    expect(document.body.textContent).not.toContain('sk-secret')
    expect(reveal).not.toHaveBeenCalled()
  })

  it('reveals on the eye, hides again, and renames the button', async () => {
    const reveal = vi.fn().mockResolvedValue('sk-secret-abcd')
    render(<MaskedValue label="API key" labels={labels} reveal={reveal} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reveal API key' }))
    expect(screen.getByText('sk-secret-abcd')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Hide API key' }))
    expect(screen.queryByText('sk-secret-abcd')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reveal API key' })).toBeTruthy()
  })

  it('stays masked when the value cannot be fetched', async () => {
    render(<MaskedValue label="API key" labels={labels} hint="1234" reveal={() => Promise.reject(new Error('no'))} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reveal API key' }))
    expect(screen.getByRole('group').textContent).toContain('••••••••1234')
  })

  it('copies from the copy button and from the value, and reports the result', async () => {
    const onCopy = vi.fn()
    render(<MaskedValue label="API key" labels={labels} reveal={async () => 'sk-1'} onCopy={onCopy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy API key' }))
    expect(writeText).toHaveBeenCalledWith('sk-1')
    await userEvent.click(screen.getByTitle('Copy API key'))
    expect(onCopy.mock.calls).toEqual([[true], [true]])
  })

  it('reports a failed copy, whether the fetch or the clipboard failed', async () => {
    const onCopy = vi.fn()
    const { rerender } = render(<MaskedValue label="K" labels={labels} reveal={async () => null} onCopy={onCopy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy API key' }))
    expect(onCopy).toHaveBeenLastCalledWith(false)
    writeText.mockRejectedValueOnce(new Error('denied'))
    rerender(<MaskedValue label="K" labels={labels} reveal={async () => 'v'} onCopy={onCopy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy API key' }))
    expect(onCopy).toHaveBeenLastCalledWith(false)
  })

  it('shows edit and remove only when given, and disables remove while it runs', async () => {
    const { rerender } = render(<MaskedValue label="K" labels={labels} reveal={async () => 'v'} />)
    expect(screen.queryByRole('button', { name: 'Edit API key' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove API key' })).toBeNull()
    const onEdit = vi.fn()
    let done!: () => void
    const onRemove = vi.fn(() => new Promise<void>((resolve) => (done = resolve)))
    rerender(<MaskedValue label="K" labels={labels} reveal={async () => 'v'} onEdit={onEdit} onRemove={onRemove} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit API key' }))
    expect(onEdit).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove API key' }))
    expect((screen.getByRole('button', { name: 'Remove API key' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => done())
    expect((screen.getByRole('button', { name: 'Remove API key' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('is reachable by Tab through every button', async () => {
    render(<MaskedValue label="K" labels={labels} reveal={async () => 'v'} onEdit={() => {}} onRemove={async () => {}} />)
    const names: string[] = []
    for (let i = 0; i < 5; i++) {
      await userEvent.tab()
      names.push(document.activeElement?.getAttribute('aria-label') ?? 'value')
    }
    expect(names).toEqual(['value', 'Reveal API key', 'Copy API key', 'Edit API key', 'Remove API key'])
  })
})
