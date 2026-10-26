// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from '../../src/renderer/src/ui/Switch'

afterEach(cleanup)

function Box({ onChange }: { onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState(false)
  return (
    <Switch
      label="Notifications"
      checked={on}
      onChange={(v) => {
        onChange?.(v)
        setOn(v)
      }}
    />
  )
}

describe('Switch', () => {
  it('is a named switch whose state is aria-checked', () => {
    render(<Switch label="Notifications" checked onChange={() => {}} />)
    const sw = screen.getByRole('switch', { name: 'Notifications' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.getAttribute('type')).toBe('button')
  })

  it('toggles with a click, Space and Enter, handing over the new state', async () => {
    const onChange = vi.fn()
    render(<Box onChange={onChange} />)
    const sw = screen.getByRole('switch')
    await userEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
    sw.focus()
    await userEvent.keyboard(' ')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await userEvent.keyboard('{Enter}')
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false, true])
  })

  it('is a Tab stop and does nothing when disabled', async () => {
    const onChange = vi.fn()
    render(<Switch label="Locked" checked={false} onChange={onChange} disabled />)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
    cleanup()
    render(<Box />)
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('switch'))
  })

  it('is named by an outside label through id', () => {
    render(
      <>
        <label htmlFor="sw">Keep awake</label>
        <Switch id="sw" checked={false} onChange={() => {}} />
      </>
    )
    expect(screen.getByRole('switch', { name: 'Keep awake' })).toBeTruthy()
  })

  it('keeps caller props but not role, type or checked state', () => {
    render(<Switch label="x" checked={false} onChange={() => {}} title="Why" {...({ role: 'button', type: 'submit', 'aria-checked': true } as object)} />)
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('title')).toBe('Why')
    expect(sw.getAttribute('type')).toBe('button')
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('lets a caller click handler veto the toggle', async () => {
    const onChange = vi.fn()
    render(<Switch label="x" checked={false} onChange={onChange} onClick={(e) => e.preventDefault()} />)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fails loudly without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Switch checked={false} onChange={() => {}} />)).toThrow(/Switch has no accessible name/)
    spy.mockRestore()
  })
})
