// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionRow } from '../../src/renderer/src/ui/ActionRow'
import { IconButton } from '../../src/renderer/src/ui/IconButton'

const archive = (name = 'Archive') => <IconButton label={name}><svg /></IconButton>

afterEach(cleanup)

describe('ActionRow', () => {
  it('is a non-interactive container without onPress', () => {
    const ref = createRef<HTMLDivElement>()
    const { container } = render(<ActionRow ref={ref}>Just text</ActionRow>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(ref.current).toBe(container.firstElementChild)
    expect(ref.current?.className).toBe('ui-action-row')
  })

  it('makes the main area a button, with actions as siblings and never inside it', async () => {
    const onPress = vi.fn()
    const onArchive = vi.fn()
    const user = userEvent.setup()
    render(
      <ActionRow onPress={onPress} actions={<IconButton label="Archive" onClick={onArchive}><svg /></IconButton>}>
        Workspace one
      </ActionRow>
    )
    const main = screen.getByRole('button', { name: 'Workspace one' })
    const act = screen.getByRole('button', { name: 'Archive' })
    expect(main.contains(act)).toBe(false)
    expect(main.parentElement).toBe(act.closest('.ui-action-row'))
    await user.click(main)
    expect(onPress).toHaveBeenCalledTimes(1)
    await user.click(act)
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('tabs from the main button to its actions and back out', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ActionRow onPress={() => undefined} actions={<>{archive('A1')}{archive('A2')}</>}>One</ActionRow>
        <ActionRow onPress={() => undefined}>Two</ActionRow>
      </>
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'A1' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'A2' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Two' }))
  })

  it('marks the selected row with aria-current on the primary button and data-selected on the row', () => {
    const { container } = render(
      <>
        <ActionRow onPress={() => undefined} selected>Open</ActionRow>
        <ActionRow onPress={() => undefined}>Other</ActionRow>
      </>
    )
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Other' }).hasAttribute('aria-current')).toBe(false)
    expect(container.querySelectorAll('[data-selected]')).toHaveLength(1)
  })

  it('disables the primary button but leaves actions to the caller', async () => {
    const onPress = vi.fn()
    const onRestore = vi.fn()
    const user = userEvent.setup()
    render(
      <ActionRow disabled onPress={onPress} actions={<IconButton label="Restore" onClick={onRestore}><svg /></IconButton>}>
        Archived
      </ActionRow>
    )
    const main = screen.getByRole('button', { name: 'Archived' }) as HTMLButtonElement
    expect(main.disabled).toBe(true)
    await user.click(main)
    expect(onPress).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('shows an editor instead of the primary button, as a sibling of the actions', () => {
    render(
      <ActionRow onPress={() => undefined} editor={<input aria-label="Rename" defaultValue="x" />} actions={archive('Save')}>
        Hidden label
      </ActionRow>
    )
    expect(screen.queryByRole('button', { name: 'Hidden label' })).toBeNull()
    const input = screen.getByRole('textbox', { name: 'Rename' })
    expect(input.closest('button')).toBeNull()
    expect(input.closest('.ui-action-row')?.getAttribute('data-editing')).toBe('')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('names and describes the primary button through primaryProps', () => {
    render(
      <ActionRow onPress={() => undefined} primaryProps={{ 'aria-label': 'Open login-flow', 'aria-describedby': 'why', className: 'content-grid' }}>
        <span>login-flow</span>
      </ActionRow>
    )
    const b = screen.getByRole('button', { name: 'Open login-flow' })
    expect(b.getAttribute('aria-describedby')).toBe('why')
    expect(b.className).toContain('content-grid')
    expect(b.className).toContain('ui-action-row__main')
  })

  it('does not let primaryProps take over aria-current', () => {
    render(
      // @ts-expect-error aria-current belongs to the row's selected state
      <ActionRow onPress={() => undefined} primaryProps={{ 'aria-current': 'page' }}>Row</ActionRow>
    )
    expect(screen.getByRole('button', { name: 'Row' }).hasAttribute('aria-current')).toBe(false)
  })

  it('works as a labelled list of rows', () => {
    render(
      <ul aria-label="Queued messages">
        <li><ActionRow actions={archive('Remove 1')}>First</ActionRow></li>
        <li><ActionRow actions={archive('Remove 2')}>Second</ActionRow></li>
      </ul>
    )
    const list = screen.getByRole('list', { name: 'Queued messages' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  it('fails loudly when the primary content holds an interactive element', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() =>
        render(
          <ActionRow onPress={() => undefined}>
            Name <button type="button">inner</button>
          </ActionRow>
        )
      ).toThrow(/interactive/)
    } finally {
      spy.mockRestore()
    }
  })

  it('flags revealActions and divided as data attributes for the stylesheet', () => {
    const { container } = render(<ActionRow revealActions divided actions={archive()}>Row</ActionRow>)
    const row = container.firstElementChild!
    expect(row.hasAttribute('data-reveal-actions')).toBe(true)
    expect(row.hasAttribute('data-divided')).toBe(true)
  })

  it('passes native props such as role and data attributes to the row', () => {
    const { container } = render(<ActionRow role="listitem" data-testid="r" className="layout">Row</ActionRow>)
    const row = container.firstElementChild!
    expect(row.getAttribute('role')).toBe('listitem')
    expect(row.className).toBe('ui-action-row layout')
  })
})

describe('ActionRow pending and editing', () => {
  it('marks a pending row apart from the selected one', () => {
    const { container } = render(
      <>
        <ActionRow onPress={() => undefined} selected>Current</ActionRow>
        <ActionRow onPress={() => undefined} pending>Waiting</ActionRow>
      </>
    )
    const [current, waiting] = Array.from(container.querySelectorAll('.ui-action-row'))
    expect(current.hasAttribute('data-selected')).toBe(true)
    expect(current.hasAttribute('data-pending')).toBe(false)
    expect(waiting.hasAttribute('data-pending')).toBe(true)
    // Pending is not "current": no aria-current.
    expect(screen.getByRole('button', { name: 'Waiting' }).hasAttribute('aria-current')).toBe(false)
  })

  it('an editing row shows its editor in place of the main area, as a sibling of the actions', () => {
    const { container } = render(<ActionRow editor={<textarea aria-label="Edit" />} actions={archive('Delete')}>Hidden</ActionRow>)
    expect(container.querySelector('.ui-action-row')?.hasAttribute('data-editing')).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Edit' })).toBeTruthy()
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' }).closest('textarea')).toBeNull()
  })
})
