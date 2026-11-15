// @vitest-environment jsdom
// One decision card everywhere (components/DecisionCard.tsx): ▲ Needs you, who, the kind and its age; the thing decided;
// a line saying what the main button does, before the buttons; the buttons in one order with the main one last; Esc
// declines, Ctrl+Enter takes the alternate, Enter the main act, and nothing that leaves this computer has a key. As a
// row in a list, one line that opens into the same card, whose one button acts only when the act stays here.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionCard, DecisionList, DecisionRow, PlacedDecision } from '../src/renderer/src/components/DecisionCard'
import { fakeState } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

afterEach(() => {
  cleanup()
  fakeState.snapshot.platform = 'win32'
  vi.restoreAllMocks()
})

const acts = () => ({ decline: vi.fn(), alternate: vi.fn(), main: vi.fn() })

function push(spies = acts(), extra: Partial<Parameters<typeof DecisionCard>[0]> = {}) {
  return render(
    <DecisionCard
      who="Max"
      kind="Push"
      age="42 minutes ago"
      subject="Push max/launch-2.4 to site"
      leaves
      consequence="Pushes 1 commit of max/launch-2.4 to origin (github.com/acme/site) as @yatin."
      decline={{ label: 'Don’t push', onAct: spies.decline }}
      main={{ label: 'Push branch', onAct: spies.main, outward: true }}
      {...extra}
    >
      <p>1 commit ahead of main</p>
    </DecisionCard>
  )
}

function plan(spies = acts()) {
  return render(
    <DecisionCard
      who="Claude Code"
      kind="Plan"
      subject="Plan ready for review"
      consequence="The agent starts on these steps."
      decline={{ label: 'Keep planning', onAct: spies.decline }}
      alternate={{ label: 'Hand off', onAct: spies.alternate }}
      main={{ label: 'Approve plan', onAct: spies.main }}
    >
      <textarea aria-label="Note" />
    </DecisionCard>
  )
}

describe('the card', () => {
  it('is a group named by what is decided, with Needs you, who, the kind and the age in its header', () => {
    push()
    const card = screen.getByRole('group', { name: 'Push max/launch-2.4 to site' })
    const head = card.querySelector('.decision-head')!
    expect(head.textContent).toMatch(/Needs you\s*·\s*Max\s*·\s*Push\s*42 minutes ago/)
    // The state is a glyph and a word, never colour alone.
    expect(head.querySelector('.ui-status--warn')?.textContent).toBe('Needs you')
  })

  it('says what will happen before the buttons, and that it leaves this computer', () => {
    push()
    const card = screen.getByRole('group', { name: 'Push max/launch-2.4 to site' })
    const line = card.querySelector('.decision-consequence')!
    expect(line.textContent).toBe('Leaves this computer' + 'Pushes 1 commit of max/launch-2.4 to origin (github.com/acme/site) as @yatin.')
    expect(line.compareDocumentPosition(card.querySelector('.decision-foot')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('puts the buttons in one order, decline, alternate, then the main act last', () => {
    plan()
    const names = within(screen.getByRole('group', { name: 'Plan ready for review' }))
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(names).toEqual(['Keep planning Esc', 'Hand off Ctrl+Enter', 'Approve plan Enter'])
    expect(screen.getByRole('button', { name: /^Approve plan/ }).className).toContain('ui-btn--primary')
  })

  it('writes the keys the macOS way there', () => {
    fakeState.snapshot.platform = 'darwin'
    plan()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep planning Esc', 'Hand off ⌘↵', 'Approve plan ↵'])
  })

  it('answers Esc with the decline, Ctrl+Enter with the alternate and Enter with the main act, from the card', async () => {
    const user = userEvent.setup()
    const spies = acts()
    plan(spies)
    screen.getByRole('group', { name: 'Plan ready for review' }).focus()
    await user.keyboard('{Enter}')
    expect(spies.main).toHaveBeenCalledTimes(1)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(spies.alternate).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(spies.decline).toHaveBeenCalledTimes(1)
  })

  it('lets a focused button do what it says, and keeps Enter in a text box a new line', async () => {
    const user = userEvent.setup()
    const spies = acts()
    plan(spies)
    screen.getByRole('button', { name: /^Keep planning/ }).focus()
    await user.keyboard('{Enter}')
    expect(spies.decline).toHaveBeenCalledTimes(1)
    expect(spies.main).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'a{Enter}b')
    expect(spies.main).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement).value).toBe('a\nb')
  })

  it('gives nothing that leaves this computer a key: no hint on its button, and Enter and Ctrl+Enter do nothing', async () => {
    const user = userEvent.setup()
    const spies = acts()
    push(spies, { alternate: { label: 'Edit, then push', onAct: spies.alternate, outward: true } })
    expect(screen.getByRole('button', { name: 'Push branch' }).querySelector('kbd')).toBeNull()
    screen.getByRole('group', { name: 'Push max/launch-2.4 to site' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(spies.main).not.toHaveBeenCalled()
    expect(spies.alternate).not.toHaveBeenCalled()
    // Tab to it, then Enter on the button itself: that pushes.
    screen.getByRole('button', { name: 'Push branch' }).focus()
    await user.keyboard('{Enter}')
    expect(spies.main).toHaveBeenCalledTimes(1)
  })

  it('keeps Esc to itself, so the view around it never closes with a typed answer', async () => {
    const user = userEvent.setup()
    const onWindow = vi.fn()
    window.addEventListener('keydown', onWindow)
    push()
    screen.getByRole('group', { name: 'Push max/launch-2.4 to site' }).focus()
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', onWindow)
    expect(onWindow).not.toHaveBeenCalled()
  })

  it('ignores its keys for a moment after it appears, when it asks to', async () => {
    const user = userEvent.setup()
    const spies = acts()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    render(<DecisionCard kind="Command" subject="Run this command?" guardMs={600} decline={{ label: 'Don’t run', onAct: spies.decline }} main={{ label: 'Run', onAct: spies.main }} />)
    screen.getByRole('group', { name: 'Run this command?' }).focus()
    await user.keyboard('{Enter}{Escape}')
    expect(spies.main).not.toHaveBeenCalled()
    expect(spies.decline).not.toHaveBeenCalled()
    now.mockReturnValue(1_700)
    await user.keyboard('{Enter}')
    expect(spies.main).toHaveBeenCalledTimes(1)
  })
})

describe('the row', () => {
  it('is one line, kind, who, what and age, with one button; open, it is the card', async () => {
    const user = userEvent.setup()
    const toggle = vi.fn()
    const { rerender } = render(
      <ul>
        <DecisionRow kind="Memory change" who="Ada" subject="Add to PROJECT.md" age="33 minutes ago" act={{ label: 'Add to PROJECT.md', onAct: vi.fn() }} open={false} onToggle={toggle}>
          <p>The card</p>
        </DecisionRow>
      </ul>
    )
    const row = screen.getByRole('button', { expanded: false })
    expect(row.textContent).toMatch(/Memory change\s*Ada\s*Add to PROJECT.md\s*33 minutes ago/)
    expect(screen.queryByText('The card')).toBeNull()
    await user.click(row)
    expect(toggle).toHaveBeenCalledTimes(1)
    rerender(
      <ul>
        <DecisionRow kind="Memory change" who="Ada" subject="Add to PROJECT.md" act={{ label: 'Add to PROJECT.md', onAct: vi.fn() }} open onToggle={toggle}>
          <p>The card</p>
        </DecisionRow>
      </ul>
    )
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('The card')).toBeTruthy()
  })

  it('acts from the row only when the act stays on this computer, else opens the card to be read first', async () => {
    const user = userEvent.setup()
    const keep = vi.fn()
    const pushed = vi.fn()
    const items = [{ id: 'proposal' }, { id: 'push' }]
    render(
      <DecisionList
        items={items}
        label="Needs you"
        render={(item, open, toggle) =>
          item.id === 'proposal' ? (
            <PlacedDecision key={item.id} place={{ form: 'row', open, onToggle: toggle }} parts={{ kind: 'Memory change', subject: 'Add to PROJECT.md', main: { label: 'Add to PROJECT.md', onAct: keep }, rowAct: { label: 'Add to PROJECT.md', onAct: keep } }} />
          ) : (
            <PlacedDecision
              key={item.id}
              place={{ form: 'row', open, onToggle: toggle }}
              parts={{ kind: 'Push', subject: 'Push max/launch-2.4 to site', leaves: true, consequence: 'It can’t be undone.', main: { label: 'Push branch', onAct: pushed, outward: true }, rowAct: { label: 'Review…', onAct: toggle } }}
            />
          )
        }
      />
    )
    const list = screen.getByRole('list', { name: 'Needs you' })
    await user.click(within(list).getByRole('button', { name: 'Add to PROJECT.md' }))
    expect(keep).toHaveBeenCalledTimes(1)
    await user.click(within(list).getByRole('button', { name: 'Review…' }))
    expect(pushed).not.toHaveBeenCalled()
    expect(screen.getByText('It can’t be undone.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Push branch' })).toBeTruthy()
  })

  it('opens one row at a time', async () => {
    const user = userEvent.setup()
    render(
      <DecisionList
        items={[{ id: 'a' }, { id: 'b' }]}
        label="Needs you"
        render={(item, open, toggle) => (
          <DecisionRow key={item.id} kind="Question" subject={`Question ${item.id}`} open={open} onToggle={toggle}>
            <p>{`Card ${item.id}`}</p>
          </DecisionRow>
        )}
      />
    )
    const [a, b] = screen.getAllByRole('button', { expanded: false })
    await user.click(a)
    expect(screen.getByText('Card a')).toBeTruthy()
    await user.click(b)
    expect(screen.queryByText('Card a')).toBeNull()
    expect(screen.getByText('Card b')).toBeTruthy()
  })
})
