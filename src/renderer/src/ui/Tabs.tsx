import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react'
import { nextIndex } from './keys'

export type TabsVariant = 'underline' | 'pill' | 'chat'

type TabsContextValue = {
  base: string
  value: string
  onChange: (value: string) => void
  // Values that have a TabPanel, so a tab only points at a panel that exists.
  panels: ReadonlySet<string>
  registerPanel: (value: string) => () => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabs(part: string): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error(`<${part}> must be rendered inside <Tabs>`)
  return ctx
}

// Values become part of DOM ids, and aria-controls is a space-separated list.
const slug = (value: string) => encodeURIComponent(value).replace(/%/g, '_')
const tabDomId = (base: string, value: string) => `${base}-tab-${slug(value)}`
const panelDomId = (base: string, value: string) => `${base}-panel-${slug(value)}`

const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

export type TabsProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  value: string
  onChange: (value: string) => void
  // underline: settings pages; pill: filters in a bordered track; chat: closable, browser-style tabs.
  variant?: TabsVariant
  ref?: Ref<HTMLDivElement>
}

export function Tabs({ value, onChange, variant = 'underline', className, children, ref, ...rest }: TabsProps) {
  const base = useId()
  const [panels, setPanels] = useState<ReadonlySet<string>>(() => new Set())
  const registerPanel = useCallback((panel: string) => {
    setPanels((prev) => new Set(prev).add(panel))
    return () =>
      setPanels((prev) => {
        const next = new Set(prev)
        next.delete(panel)
        return next
      })
  }, [])
  return (
    <TabsContext value={{ base, value, onChange, panels, registerPanel }}>
      <div {...rest} ref={ref} className={join('ui-tabs', `ui-tabs--${variant}`, className)}>
        {children}
      </div>
    </TabsContext>
  )
}

const tabsIn = (list: HTMLElement) => Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter((el) => !el.hidden)
const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'

export type TabListProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label'> & {
  // The tab strip's accessible name.
  label: string
  ref?: Ref<HTMLDivElement>
}

// ← → Home End move between the tabs and select (focus follows selection). Other focusable children of the list
// (a "new tab" button) keep their own Tab stops and their own keys.
export function TabList({ label, className, children, onKeyDown, ref, ...rest }: TabListProps) {
  const ctx = useTabs('TabList')
  const local = useRef<HTMLDivElement | null>(null)

  // One Tab stop: the selected tab, or the first enabled one when the selected is disabled or absent.
  // Done on the DOM after every render because the tabs render independently of the list.
  useLayoutEffect(() => {
    const list = local.current
    if (!list) return
    const tabs = tabsIn(list)
    const stop = tabs.find((el) => el.getAttribute('aria-selected') === 'true' && !isOff(el)) ?? tabs.find((el) => !isOff(el))
    for (const el of tabs) el.tabIndex = el === stop ? 0 : -1
  })

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    const target = e.target as HTMLElement
    // Keys typed in a rename field or on a close button aren't tab navigation.
    if (target.getAttribute('role') !== 'tab') return
    const tabs = tabsIn(e.currentTarget)
    const next = nextIndex(e.key, tabs.indexOf(target as HTMLButtonElement), tabs.length, { orientation: 'horizontal', wrap: true, disabled: (i) => isOff(tabs[i]) })
    if (next === undefined || isOff(tabs[next])) return
    e.preventDefault()
    const value = tabs[next].dataset.tabValue
    if (value !== undefined && value !== ctx.value) ctx.onChange(value)
    tabs[next].focus()
  }

  return (
    <div
      {...rest}
      ref={(node) => {
        local.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      className={join('ui-tablist', className)}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  )
}

export type TabProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'id' | 'aria-selected' | 'aria-controls' | 'children' | 'value'> & {
  value: string
  children: ReactNode
  // Controls beside the tab (a close button), kept as siblings of the tab button, never inside it.
  actions?: ReactNode
  // While set (a rename field), it takes the tab's place and the tab button stays in the DOM, hidden, so its panel keeps its name.
  editor?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function Tab({ value, children, actions, editor, disabled, className, onClick, ref, ...rest }: TabProps) {
  const ctx = useTabs('Tab')
  const selected = ctx.value === value
  return (
    <span className={join('ui-tab', className)} data-selected={selected || undefined} data-editing={editor ? '' : undefined}>
      <button
        {...rest}
        ref={ref}
        type="button"
        role="tab"
        id={tabDomId(ctx.base, value)}
        data-tab-value={value}
        aria-selected={selected}
        aria-controls={ctx.panels.has(value) ? panelDomId(ctx.base, value) : undefined}
        tabIndex={selected && !disabled ? 0 : -1}
        disabled={disabled}
        hidden={editor ? true : undefined}
        className="ui-tab__button"
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          onClick?.(e)
          if (!e.defaultPrevented && !selected) ctx.onChange(value)
        }}
      >
        {children}
      </button>
      {editor}
      {actions && <span className="ui-tab__actions">{actions}</span>}
    </span>
  )
}

export type TabPanelProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'id' | 'aria-labelledby'> & {
  value: string
  // Keep the content mounted (hidden) while another tab is selected.
  keepMounted?: boolean
  ref?: Ref<HTMLDivElement>
}

export function TabPanel({ value, keepMounted, className, children, ref, ...rest }: TabPanelProps) {
  const ctx = useTabs('TabPanel')
  const { registerPanel } = ctx
  useLayoutEffect(() => registerPanel(value), [registerPanel, value])
  const selected = ctx.value === value
  return (
    <div {...rest} ref={ref} className={join('ui-tabpanel', className)} role="tabpanel" id={panelDomId(ctx.base, value)} aria-labelledby={tabDomId(ctx.base, value)} hidden={!selected}>
      {selected || keepMounted ? children : null}
    </div>
  )
}
