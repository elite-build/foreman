// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RadioList, type RadioOption } from '../../src/renderer/src/ui/RadioList'

afterEach(cleanup)

// jsdom has no CSS.escape, which user-event needs to walk a radio group with the arrow keys.
if (!window.CSS) Object.defineProperty(window, 'CSS', { value: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } })

const options: RadioOption<string>[] = [
  { value: 'github', label: 'GitHub username', description: 'Branches start with it' },
  { value: 'custom', label: 'Custom', extra: <input aria-label="Prefix" /> },
  { value: 'none', label: 'None', disabled: true, reason: 'Needs a repository' }
]

function Box({ initial, onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState<string | undefined>(initial)
  return (
    <RadioList
      legend="Branch prefix"
      value={value}
      options={options}
      onChange={(v) => {
        onChange?.(v)
        setValue(v)
      }}
    />
  )
}

describe('RadioList', () => {
  it('is a radiogroup named by its legend, with native radios sharing one name', () => {
    render(<Box initial="github" />)
    expect(screen.getByRole('group', { name: 'Branch prefix' })).toBeTruthy()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(3)
    expect(new Set(radios.map((r) => r.name)).size).toBe(1)
    expect(radios[0].name).toBeTruthy()
    expect(radios.map((r) => r.checked)).toEqual([true, false, false])
  })

  it('names each radio by its label alone and describes it with the description', () => {
    render(<Box />)
    const radio = screen.getByRole('radio', { name: 'GitHub username' })
    expect(radio.getAttribute('aria-describedby')).toBe(screen.getByText('Branches start with it').id)
  })

  it('chooses on click and on the label text', async () => {
    const onChange = vi.fn()
    render(<Box onChange={onChange} />)
    await userEvent.click(screen.getByText('Custom'))
    expect(onChange).toHaveBeenCalledWith('custom')
    expect((screen.getByRole('radio', { name: 'Custom' }) as HTMLInputElement).checked).toBe(true)
  })

  it('has one Tab stop, and arrow keys move and choose, skipping the disabled option', async () => {
    const onChange = vi.fn()
    render(<Box initial="github" onChange={onChange} />)
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'GitHub username' }))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Custom' }))
    expect(onChange).toHaveBeenLastCalledWith('custom')
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'GitHub username' }))
    // Tab leaves the group instead of visiting each radio.
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prefix' }))
  })

  it('shows why an option is disabled, and does not let it be chosen', async () => {
    const onChange = vi.fn()
    render(<Box onChange={onChange} />)
    const radio = screen.getByRole('radio', { name: 'None' }) as HTMLInputElement
    expect(radio.disabled).toBe(true)
    expect(screen.getByText('Needs a repository').id).toBe(radio.getAttribute('aria-describedby'))
    await userEvent.click(screen.getByText('None'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders extra content outside the label', () => {
    render(<Box />)
    expect(screen.getByRole('textbox', { name: 'Prefix' }).closest('label')).toBeNull()
  })

  it('can start with nothing chosen, be inline and be disabled as a whole', () => {
    const { container } = render(<RadioList legend="Mode" hideLegend inline disabled value={undefined} options={options} onChange={() => {}} />)
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).every((r) => !r.checked && r.matches(':disabled'))).toBe(true)
    expect(container.querySelector('.ui-radio-list--inline')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Mode' })).toBeTruthy()
  })

  it('uses a given name', () => {
    render(<RadioList legend="Mode" name="mode" value="github" options={options} onChange={() => {}} />)
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement).name).toBe('mode')
  })
})
