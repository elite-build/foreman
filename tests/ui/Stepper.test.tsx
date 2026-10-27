// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Stepper, type StepperStep } from '../../src/renderer/src/ui/Stepper'

afterEach(cleanup)

const statusText = { done: 'done', upcoming: 'not yet' }
const steps: StepperStep[] = [
  { id: 'commit', label: 'Committed', status: 'done' },
  { id: 'checks', label: 'Checks', status: 'current' },
  { id: 'merged', label: 'Merged', status: 'upcoming' }
]

describe('Stepper', () => {
  it('is a named ordered list with one item per step, in order', () => {
    render(<Stepper label="Pull request progress" steps={steps} statusText={statusText} />)
    const list = screen.getByRole('list', { name: 'Pull request progress' })
    expect(list.tagName).toBe('OL')
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Committed, done', 'Checks', 'Merged, not yet'])
  })

  it('marks the current step with aria-current and says the others’ state in words', () => {
    render(<Stepper label="Progress" steps={steps} statusText={statusText} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null])
    expect(items.map((li) => li.dataset.status)).toEqual(['done', 'current', 'upcoming'])
  })

  it('a done step is ok by default, a current one neutral, an upcoming one never toned', () => {
    render(
      <Stepper
        label="Progress"
        statusText={statusText}
        steps={[
          { id: 'a', label: 'A', status: 'done' },
          { id: 'b', label: 'B', status: 'done', tone: 'error' },
          { id: 'c', label: 'C', status: 'current' },
          { id: 'd', label: 'D', status: 'current', tone: 'info' },
          { id: 'e', label: 'E', status: 'upcoming', tone: 'warn' }
        ]}
      />
    )
    expect(screen.getAllByRole('listitem').map((li) => li.dataset.tone ?? null)).toEqual(['ok', 'error', null, 'info', null])
  })

  it('draws a tick for done, a dot for current and the caller’s icon in place of either; marks are hidden from screen readers', () => {
    render(
      <Stepper
        label="Progress"
        statusText={statusText}
        steps={[...steps.slice(0, 2), { id: 'merged', label: 'Merged', status: 'done', icon: <span data-testid="own-icon" /> }]}
      />
    )
    const marks = screen.getAllByRole('listitem').map((li) => li.querySelector('.ui-stepper__mark')!)
    expect(marks.every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(marks[0].querySelector('svg')).not.toBeNull()
    expect(marks[1].querySelector('.ui-stepper__dot')).not.toBeNull()
    expect(within(marks[2] as HTMLElement).getByTestId('own-icon')).toBeTruthy()
  })

  it('passes native props and a layout class through to the list', () => {
    render(<Stepper label="Progress" steps={steps} statusText={statusText} className="panel-progress" data-x="1" />)
    const list = screen.getByRole('list')
    expect(list.className).toBe('ui-stepper panel-progress')
    expect(list.dataset.x).toBe('1')
  })

  it('requires a label and the status words (type level)', () => {
    // Never rendered: the check is the compiler's.
    // @ts-expect-error label and statusText are required
    const missing = () => <Stepper steps={steps} />
    expect(typeof missing).toBe('function')
  })
})
