// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tab, TabList, TabPanel, Tabs, type TabsVariant } from '../../src/renderer/src/ui/Tabs'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

function Demo({ variant, onChange, disabled, initial = 'general', children }: { variant?: TabsVariant; onChange?: (v: string) => void; disabled?: string; initial?: string; children?: ReactNode }) {
  const [value, setValue] = useState(initial)
  return (
    <Tabs value={value} onChange={(v) => (onChange?.(v), setValue(v))} variant={variant}>
      <TabList label="Repository settings">
        <Tab value="general">General</Tab>
        <Tab value="scripts" disabled={disabled === 'scripts'}>
          Scripts
        </Tab>
        <Tab value="actions" disabled={disabled === 'actions'}>
          Actions
        </Tab>
        {children}
      </TabList>
      <TabPanel value="general">General settings</TabPanel>
      <TabPanel value="scripts">Scripts settings</TabPanel>
      <TabPanel value="actions">Actions settings</TabPanel>
    </Tabs>
  )
}

const tab = (name: string) => screen.getByRole('tab', { name })

describe('Tabs', () => {
  it('names the tablist, marks the selected tab and links each tab to its panel', () => {
    render(<Demo />)
    expect(screen.getByRole('tablist', { name: 'Repository settings' })).toBeTruthy()
    expect(tab('General').getAttribute('aria-selected')).toBe('true')
    expect(tab('Scripts').getAttribute('aria-selected')).toBe('false')
    const panel = screen.getByRole('tabpanel', { name: 'General' })
    expect(panel.textContent).toBe('General settings')
    expect(tab('General').getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('General').id)
  })

  it('hides the other panels and leaves them empty', () => {
    const { container } = render(<Demo />)
    const hidden = container.querySelectorAll('[role="tabpanel"][hidden]')
    expect(hidden).toHaveLength(2)
    for (const p of hidden) expect(p.textContent).toBe('')
    expect(screen.queryByText('Scripts settings')).toBeNull()
  })

  it('has one Tab stop on the selected tab', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Demo initial="scripts" />
        <button>after</button>
      </>
    )
    await user.tab()
    expect(document.activeElement).toBe(tab('Scripts'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('arrows move focus and select, wrapping at the ends', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tab('Scripts'))
    expect(screen.getByRole('tabpanel').textContent).toBe('Scripts settings')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(document.activeElement).toBe(tab('Actions'))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(tab('General'))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(tab('Actions'))
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['scripts', 'general', 'actions', 'general', 'actions'])
  })

  it('ignores up and down, which are not horizontal tab keys', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    await user.tab()
    await user.keyboard('{ArrowDown}{ArrowUp}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('skips a disabled tab', async () => {
    const user = userEvent.setup()
    render(<Demo disabled="scripts" />)
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tab('Actions'))
  })

  it('makes the first enabled tab the Tab stop when the selected one is disabled', async () => {
    const user = userEvent.setup()
    render(<Demo initial="scripts" disabled="scripts" />)
    expect(tab('Scripts').tabIndex).toBe(-1)
    await user.tab()
    expect(document.activeElement).toBe(tab('General'))
  })

  it('selects on click, and a click on the selected tab changes nothing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Demo onChange={onChange} />)
    await user.click(tab('General'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(tab('Actions'))
    expect(onChange).toHaveBeenCalledWith('actions')
    expect(tab('Actions').getAttribute('aria-selected')).toBe('true')
  })

  it('keeps hidden panels mounted when asked', () => {
    render(
      <Tabs value="a" onChange={() => {}}>
        <TabList label="x">
          <Tab value="a">A</Tab>
          <Tab value="b">B</Tab>
        </TabList>
        <TabPanel value="a">one</TabPanel>
        <TabPanel value="b" keepMounted>
          two
        </TabPanel>
      </Tabs>
    )
    expect(screen.getByText('two', { ignore: 'none' })).toBeTruthy()
  })

  it('only points aria-controls at panels that exist', () => {
    render(
      <Tabs value="a" onChange={() => {}} variant="chat">
        <TabList label="Chats">
          <Tab value="a">A</Tab>
        </TabList>
      </Tabs>
    )
    expect(tab('A').hasAttribute('aria-controls')).toBe(false)
  })

  it('throws when a part is used outside Tabs', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Tab value="x">X</Tab>)).toThrow(/inside <Tabs>/)
    expect(() => render(<TabList label="x">{null}</TabList>)).toThrow(/inside <Tabs>/)
    quiet.mockRestore()
  })

  describe('chat variant', () => {
    function Chats({ editing, onClose }: { editing?: string; onClose?: (id: string) => void }) {
      const [value, setValue] = useState('one')
      const close = (id: string) => (
        <button aria-label={`Close ${id}`} onClick={() => onClose?.(id)}>
          x
        </button>
      )
      return (
        <Tabs value={value} onChange={setValue} variant="chat">
          <TabList label="Chats">
            <Tab value="one" actions={close('one')}>
              Chat one
            </Tab>
            <Tab value="two" actions={close('two')} editor={editing === 'two' ? <input aria-label="Rename chat" defaultValue="Chat two" /> : undefined}>
              Chat two
            </Tab>
            <Tab value="three" actions={close('three')}>
              Chat three
            </Tab>
            <button aria-label="New chat">+</button>
          </TabList>
        </Tabs>
      )
    }

    it('keeps the close button beside the tab, not inside it, and out of the arrow keys', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(<Chats onClose={onClose} />)
      const one = tab('Chat one')
      expect(one.querySelector('button')).toBeNull()
      expect(screen.getByRole('button', { name: 'Close one' }).closest('[role="tab"]')).toBeNull()
      await user.tab()
      expect(document.activeElement).toBe(one)
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(tab('Chat two'))
      await user.click(screen.getByRole('button', { name: 'Close three' }))
      expect(onClose).toHaveBeenCalledWith('three')
      expect(tab('Chat two').getAttribute('aria-selected')).toBe('true')
    })

    it('does not treat keys in a close button as tab navigation', async () => {
      const user = userEvent.setup()
      render(<Chats />)
      screen.getByRole('button', { name: 'Close one' }).focus()
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close one' }))
      expect(tab('Chat one').getAttribute('aria-selected')).toBe('true')
    })

    it('shows a rename field in place of the tab and leaves the hidden tab in the DOM', async () => {
      const user = userEvent.setup()
      render(<Chats editing="two" />)
      const input = screen.getByRole('textbox', { name: 'Rename chat' })
      expect(input.closest('[role="tab"]')).toBeNull()
      expect(screen.queryByRole('tab', { name: 'Chat two' })).toBeNull()
      const hiddenTab = screen.getAllByRole('tab', { hidden: true }).find((el) => el.getAttribute('data-tab-value') === 'two')
      expect(hiddenTab?.hidden).toBe(true)
      // Arrows typed in the field move its caret; they don't switch tabs. The hidden tab is skipped when arrowing.
      await user.click(input)
      await user.keyboard('{ArrowLeft}')
      expect(tab('Chat one').getAttribute('aria-selected')).toBe('true')
      await user.click(tab('Chat one'))
      await user.keyboard('{ArrowRight}')
      expect(document.activeElement).toBe(tab('Chat three'))
    })
  })
})

describe('Tabs overflow', () => {
  it('keeps every tab at its own size and wraps the list; the chat list scrolls in one row instead', () => {
    const css = readCss('tabs')
    expect(ruleBody(css, '.ui-tablist')).toMatch(/flex-wrap:\s*wrap/)
    expect(ruleBody(css, '.ui-tab')).toMatch(/flex:\s*none/)
    // Pill tabs fill the track but never shrink below their content.
    expect(ruleBody(css, '.ui-tabs--pill .ui-tab')).toMatch(/flex:\s*1 0 auto/)
    const chat = ruleBody(css, '.ui-tabs--chat > .ui-tablist') ?? ''
    expect(chat).toMatch(/flex-wrap:\s*nowrap/)
    expect(chat).toMatch(/overflow-x:\s*auto/)
    expect(ruleBody(css, '.ui-tabs--chat .ui-tab')).toMatch(/flex:\s*none/)
  })

  it('renders every tab of a long list in every variant', () => {
    for (const variant of ['underline', 'pill', 'chat'] as const) {
      render(
        <Tabs value="t0" onChange={() => {}} variant={variant}>
          <TabList label="Many">
            {Array.from({ length: 11 }, (_, i) => (
              <Tab key={i} value={`t${i}`}>{`Tab ${i}`}</Tab>
            ))}
          </TabList>
        </Tabs>
      )
      expect(screen.getAllByRole('tab')).toHaveLength(11)
      cleanup()
    }
  })
})
