// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RadioCards, type RadioCardOption } from '../../src/renderer/src/ui/RadioCards'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

// jsdom has no CSS.escape, which user-event needs to walk a radio group with the arrow keys.
if (!window.CSS) Object.defineProperty(window, 'CSS', { value: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } })

function options(onRun: () => void = () => {}): RadioCardOption<string>[] {
  return [
    {
      value: 'token',
      label: 'Setup token',
      description: 'Expires in 30 days',
      actions: (
        <button type="button" onClick={onRun}>
          Run setup
        </button>
      )
    },
    { value: 'key', label: 'API key', description: 'Saved: abcd', icon: <svg data-testid="icon" /> },
    { value: 'old', label: 'Old plan', disabled: true, reason: 'Not available on this account' }
  ]
}

function Box({ initial, onChange, onRun, layout }: { initial?: string; onChange?: (v: string) => void; onRun?: () => void; layout?: 'grid' | 'stack' }) {
  const [value, setValue] = useState<string | undefined>(initial)
  return (
    <RadioCards
      legend="Sign-in method"
      layout={layout}
      value={value}
      options={options(onRun)}
      onChange={(v) => {
        onChange?.(v)
        setValue(v)
      }}
    />
  )
}

describe('RadioCards', () => {
  it('is a group named by its legend of native radios named by their titles, sharing one name', () => {
    render(<Box initial="token" />)
    expect(screen.getByRole('group', { name: 'Sign-in method' })).toBeTruthy()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.checked)).toEqual([true, false, false])
    expect(new Set(radios.map((r) => r.name)).size).toBe(1)
    expect(screen.getByRole('radio', { name: 'Setup token' }).getAttribute('aria-describedby')).toBe(screen.getByText('Expires in 30 days').id)
  })

  it('marks the chosen card and hides the decorative icon and tick from assistive tech', () => {
    const { container } = render(<Box initial="key" />)
    expect(container.querySelectorAll('.ui-radio-card[data-selected]')).toHaveLength(1)
    expect(container.querySelector('.ui-radio-card[data-selected] input')).toBe(screen.getByRole('radio', { name: 'API key' }))
    expect(screen.getByTestId('icon').closest('[aria-hidden="true"]')).toBeTruthy()
    expect(container.querySelector('.ui-radio-card__check')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('chooses on a click anywhere on the label', async () => {
    const onChange = vi.fn()
    render(<Box onChange={onChange} />)
    await userEvent.click(screen.getByText('Saved: abcd'))
    expect(onChange).toHaveBeenCalledWith('key')
  })

  it('keeps actions outside the label, as controls of their own', async () => {
    const onRun = vi.fn()
    const onChange = vi.fn()
    render(<Box onRun={onRun} onChange={onChange} />)
    const run = screen.getByRole('button', { name: 'Run setup' })
    expect(run.closest('label')).toBeNull()
    await userEvent.click(run)
    expect(onRun).toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(within(screen.getByRole('radio', { name: 'Setup token' }).closest('label')!).queryByRole('button')).toBeNull()
  })

  it('has one Tab stop into the group; arrows choose; Tab then reaches the actions', async () => {
    const onChange = vi.fn()
    render(<Box initial="token" onChange={onChange} />)
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Setup token' }))
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'API key' }))
    expect(onChange).toHaveBeenLastCalledWith('key')
    // The disabled card is skipped: wraps to the first.
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Setup token' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run setup' }))
  })

  it('shows why a card is disabled on its face, and will not choose it', async () => {
    const onChange = vi.fn()
    const { container } = render(<Box onChange={onChange} />)
    const radio = screen.getByRole('radio', { name: 'Old plan' }) as HTMLInputElement
    expect(radio.disabled).toBe(true)
    expect(screen.getByText('Not available on this account').id).toBe(radio.getAttribute('aria-describedby'))
    expect(container.querySelector('.ui-radio-card[data-disabled]')).toBeTruthy()
    await userEvent.click(screen.getByText('Old plan'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is measured at the narrowest width that keeps the columns, so a parent that sizes it from its intrinsic width sees the same layout', () => {
    const css = readCss('radio-cards')
    const intrinsic = /contain-intrinsic-inline-size:\s*(\d+)px/.exec(ruleBody(css, '.ui-radio-cards') ?? '')
    const breakpoint = /@container \(width < (\d+)px\)/.exec(css)
    expect(intrinsic).toBeTruthy()
    expect(breakpoint).toBeTruthy()
    // One column strictly below the breakpoint; the intrinsic width is the breakpoint itself, which is not below it.
    expect(intrinsic?.[1]).toBe(breakpoint?.[1])
    expect(css).not.toMatch(/@container \(max-width/)
  })

  it('supports a stack layout, a hidden legend, nothing chosen and an invalid chosen card', () => {
    const { container } = render(
      <RadioCards
        legend="Start from"
        hideLegend
        layout="stack"
        value="key"
        columns={3}
        options={[
          { value: 'key', label: 'API key', invalid: true, description: 'No key saved' },
          { value: 'x', label: 'X' }
        ]}
        onChange={() => {}}
      />
    )
    expect(container.querySelector('.ui-radio-cards--stack')).toBeTruthy()
    expect(container.querySelector('.ui-radio-card[data-invalid][data-selected]')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Start from' })).toBeTruthy()
    expect((container.querySelector('.ui-radio-cards__grid') as HTMLElement).style.getPropertyValue('--ui-radio-cards-columns')).toBe('3')
    cleanup()
    render(<RadioCards legend="L" value={undefined} options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />)
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false)
  })
})
