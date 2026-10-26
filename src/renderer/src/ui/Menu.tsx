import { Check } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ChipTone } from './ChipButton'
import { createTypeahead, nextIndex, typeahead } from './keys'

// Why a menu closed. Escape and activation give focus back to the trigger; Tab and a click elsewhere don't
// (Tab lets focus move on from the trigger, and a click has already put focus where the user wanted it).
export type MenuCloseReason = 'escape' | 'select' | 'tab' | 'outside'

type MenuContextValue = { close: (reason: MenuCloseReason) => void }
const MenuContext = createContext<MenuContextValue | null>(null)
// Inside a MenuControlRow, items stay open by default.
const RowContext = createContext(false)

function useMenu(part: string): MenuContextValue {
  const ctx = useContext(MenuContext)
  if (!ctx) throw new Error(`<${part}> must be rendered inside a <Menu>`)
  return ctx
}

const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

function setRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}

// ---- the DOM the keys work on ----

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const ROW = '[data-ui-menu-row]'

const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'

// The up/down stops in DOM order: every item, with a control row counting as one stop.
function stopsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`${ITEM}, ${ROW}`)).filter((el) => el.matches(ROW) || !el.closest(ROW))
}

const itemsOf = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLElement>(ITEM)).filter((el) => !isOff(el))
const stopOff = (el: HTMLElement) => (el.matches(ROW) ? itemsOf(el).length === 0 : isOff(el))
const stopLabel = (el: HTMLElement) => (el.matches(ROW) ? (el.dataset.label ?? '') : (el.querySelector('.ui-menu__label')?.textContent ?? el.textContent ?? ''))

function focusStop(el: HTMLElement | undefined) {
  if (!el) return
  ;(el.matches(ROW) ? itemsOf(el)[0] : el)?.focus()
}

// ---- Menu ----

export type MenuProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label'> & {
  // The menu's accessible name.
  label: string
  onClose: (reason: MenuCloseReason) => void
  // Where focus lands when the menu mounts. A menu opened with ArrowUp starts at the last item.
  initialFocus?: 'first' | 'last' | 'none'
  // Clicks inside this element (the trigger) aren't "outside": the trigger toggles the menu itself.
  ignore?: RefObject<HTMLElement | null>
  // For menus placed with position: fixed: close on window blur, resize and scrolling elsewhere, since the menu can't follow.
  closeOnViewportChange?: boolean
  ref?: Ref<HTMLDivElement>
}

// The popup surface: role="menu" with arrows, Home, End and typeahead over its items. Escape, Tab, a click outside
// and activating an item report through onClose; the owner decides what to do with focus (MenuButton and
// ContextMenu follow the rules above). Place it with CSS, or use MenuButton / ContextMenu.
export function Menu({ label, onClose, initialFocus = 'first', ignore, closeOnViewportChange, className, children, onKeyDown, ref, ...rest }: MenuProps) {
  const local = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  const type = useRef(createTypeahead())

  useLayoutEffect(() => {
    const root = local.current
    if (!root || initialFocus === 'none') return
    const enabled = stopsOf(root).filter((el) => !stopOff(el))
    const target = initialFocus === 'last' ? enabled[enabled.length - 1] : enabled[0]
    if (target) focusStop(target)
    else root.focus()
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const root = local.current
    const typing = type.current
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (root?.contains(target) || ignore?.current?.contains(target)) return
      closeRef.current('outside')
    }
    const leave = () => closeRef.current('outside')
    const onScroll = (e: Event) => !root?.contains(e.target as Node) && leave()
    window.addEventListener('mousedown', onDown)
    if (closeOnViewportChange) {
      window.addEventListener('blur', leave)
      window.addEventListener('resize', leave)
      window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    }
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', leave)
      window.removeEventListener('resize', leave)
      window.removeEventListener('scroll', onScroll, { capture: true })
      typing.reset()
    }
  }, [ignore, closeOnViewportChange])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      // A menu inside a dialog closes alone; the dialog's own Escape handler must not also fire.
      e.stopPropagation()
      closeRef.current('escape')
      return
    }
    if (e.key === 'Tab') {
      // No preventDefault: the owner puts focus on the trigger, and the browser then moves on from there.
      closeRef.current('tab')
      return
    }
    const stops = stopsOf(e.currentTarget)
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>(ROW)
    const here = stops.indexOf(row ?? target.closest<HTMLElement>(ITEM) ?? target)
    if (row && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const items = itemsOf(row)
      const next = nextIndex(e.key, items.indexOf(target), items.length, { orientation: 'horizontal', wrap: false })
      e.preventDefault()
      if (next !== undefined) items[next]?.focus()
      return
    }
    const next = nextIndex(e.key, here, stops.length, { orientation: 'vertical', wrap: true, disabled: (i) => stopOff(stops[i]) })
    if (next !== undefined) {
      e.preventDefault()
      focusStop(stops[next])
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const query = type.current.push(e.key)
    if (query === undefined) return
    e.preventDefault()
    const found = typeahead(query, stops.map(stopLabel), here, (i) => stopOff(stops[i]))
    if (found !== undefined) focusStop(stops[found])
  }

  return (
    <MenuContext value={{ close: (reason) => closeRef.current(reason) }}>
      <div
        {...rest}
        ref={(node) => {
          local.current = node
          setRef(ref, node)
        }}
        className={join('ui-menu', className)}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </MenuContext>
  )
}

// ---- items ----

type ItemBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'onClick' | 'children' | 'aria-checked'> & {
  children: ReactNode
  // A leading icon (decorative).
  icon?: ReactNode
  // A shortcut or note at the end of the row.
  hint?: ReactNode
  // A second line under the label.
  description?: ReactNode
  // Under a group label, such as the chats listed under Send.
  indent?: boolean
  // Keep the menu open after this item (zoom steps). Default: close, except inside a MenuControlRow.
  closeOnSelect?: boolean
  ref?: Ref<HTMLButtonElement>
}

type ItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'

function Item({ role, checked, onActivate, closeOnSelect, icon, hint, description, indent, className, children, ref, ...rest }: ItemBase & { role: ItemRole; checked?: boolean; onActivate?: () => void }) {
  const menu = useMenu(role === 'menuitem' ? 'MenuItem' : role === 'menuitemradio' ? 'MenuRadioItem' : 'MenuCheckboxItem')
  const inRow = useContext(RowContext)
  const closes = closeOnSelect ?? !inRow
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role={role}
      aria-checked={checked}
      tabIndex={-1}
      className={join('ui-menu__item', className)}
      data-indent={indent || undefined}
      onClick={() => {
        // Close first: focus goes back to the trigger, and then the action may move it elsewhere (open a dialog).
        if (closes) menu.close('select')
        onActivate?.()
      }}
    >
      {icon && (
        <span className="ui-menu__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-menu__text">
        <span className="ui-menu__label">{children}</span>
        {description && <span className="ui-menu__desc">{description}</span>}
      </span>
      {hint && <span className="ui-menu__hint">{hint}</span>}
      {checked && <Check className="ui-menu__check" size={14} aria-hidden="true" />}
    </button>
  )
}

export type MenuItemProps = ItemBase & {
  onSelect?: () => void
  // danger: a destructive action; value: the readout button in a control row (the zoom percentage).
  variant?: 'default' | 'danger' | 'value'
}

export function MenuItem({ onSelect, variant = 'default', ...rest }: MenuItemProps) {
  return <Item {...rest} role="menuitem" data-variant={variant === 'default' ? undefined : variant} onActivate={onSelect} />
}

export type MenuCheckboxItemProps = ItemBase & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function MenuCheckboxItem({ checked, onCheckedChange, ...rest }: MenuCheckboxItemProps) {
  return <Item {...rest} role="menuitemcheckbox" checked={checked} onActivate={() => onCheckedChange(!checked)} />
}

export type MenuRadioItemProps = ItemBase & {
  checked: boolean
  onSelect: () => void
}

export function MenuRadioItem({ checked, onSelect, ...rest }: MenuRadioItemProps) {
  return <Item {...rest} role="menuitemradio" checked={checked} onActivate={onSelect} />
}

export function MenuSeparator() {
  return <div className="ui-menu__sep" role="separator" />
}

// A heading for the items below it. Not announced on its own: wrap the items in a MenuGroup to name them.
export function MenuLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="ui-menu__heading" id={id} role="presentation">
      {children}
    </div>
  )
}

// A named set of items (the chats under Send, a set of radio items).
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      {children}
    </div>
  )
}

export type MenuControlRowProps = {
  // Names the row; also what typeahead matches.
  label: string
  icon?: ReactNode
  // The row's buttons, as MenuItems. They default to staying open.
  children: ReactNode
  className?: string
}

// A row of controls in a menu (terminal zoom: − 110% +). Arrow Down and Up reach it as one stop; ← → move between
// its buttons; Down and Up leave it. Its MenuItems keep the menu open so the effect can be watched.
export function MenuControlRow({ label, icon, children, className }: MenuControlRowProps) {
  useMenu('MenuControlRow')
  return (
    <div className={join('ui-menu__row', className)} role="group" aria-label={label} data-ui-menu-row="" data-label={label}>
      {icon && (
        <span className="ui-menu__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-menu__row-label" aria-hidden="true">
        {label}
      </span>
      <span className="ui-menu__row-ctl">
        <RowContext value={true}>{children}</RowContext>
      </span>
    </div>
  )
}

// ---- placement ----

export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start'
type Point = { left: number; top: number }

const GAP = 4

// Where a menu of `size` goes next to an anchor rectangle. Pure, so it is tested without a layout.
export function menuPlacement(anchor: { left: number; right: number; top: number; bottom: number }, size: { width: number; height: number }, placement: MenuPlacement): Point {
  switch (placement) {
    case 'bottom-start':
      return { left: anchor.left, top: anchor.bottom + GAP }
    case 'bottom-end':
      return { left: anchor.right - size.width, top: anchor.bottom + GAP }
    case 'top-start':
      return { left: anchor.left, top: anchor.top - size.height - GAP }
    case 'top-end':
      return { left: anchor.right - size.width, top: anchor.top - size.height - GAP }
    case 'right-start':
      return { left: anchor.right + 2 * GAP, top: anchor.top }
  }
}

// Pulls a box back inside the viewport, `margin` from every edge.
export function keepOnScreen(at: Point, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = GAP): Point {
  return {
    left: Math.max(margin, Math.min(at.left, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(at.top, viewport.height - size.height - margin))
  }
}

// Measures the menu after each render and returns where to draw it, kept on screen. The first render uses the
// unclamped spot so the menu is already visible (and focusable) when it mounts; the layout effect corrects it before paint.
export function usePlaced(ref: RefObject<HTMLElement | null>, place: (size: { width: number; height: number }) => Point): Point {
  const [at, setAt] = useState<Point>(() => place({ width: 0, height: 0 }))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const next = keepOnScreen(place({ width, height }), { width, height }, { width: window.innerWidth, height: window.innerHeight })
    setAt((prev) => (prev.left === next.left && prev.top === next.top ? prev : next))
  })
  return at
}

// Focus after the menu closes, by the dismissal rules. On Tab the element is focused without cancelling the key,
// so the browser then moves on from it: focus advances naturally instead of landing back on the trigger.
export function giveFocusBack(reason: MenuCloseReason, to: HTMLElement | null | undefined) {
  if (reason === 'outside' || !to?.isConnected) return
  to.focus({ preventScroll: true })
}

// ---- MenuButton ----

export type MenuButtonLook = 'button' | 'ghost' | 'primary' | 'icon' | 'dashed' | 'chip'

const LOOK: Record<MenuButtonLook, string> = {
  button: 'ui-btn',
  ghost: 'ui-btn ui-btn--ghost',
  primary: 'ui-btn ui-btn--primary',
  icon: 'ui-icon-btn',
  // An icon trigger drawn as a dashed placeholder tile (the rail's "add a repository"): IconButton's `dashed` variant.
  dashed: 'ui-icon-btn ui-icon-btn--dashed',
  chip: 'ui-chip-btn'
}

export type MenuButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'children' | 'aria-haspopup' | 'aria-expanded' | 'aria-controls'> & {
  // The menu's accessible name. For an icon-only trigger it is also the trigger's name and tooltip.
  label: string
  // The trigger's content (text, icon, chevron). Items go in `children`.
  trigger: ReactNode
  children: ReactNode
  // Which Button look the trigger wears (the ui-btn / ui-icon-btn / ui-chip-btn classes).
  look?: MenuButtonLook
  small?: boolean
  // Fully rounded, like ChipButton's `pill` (header status pills). Only with look="chip".
  pill?: boolean
  // ChipButton's tone (neutral, warn). Only with look="chip"; independent of `pill`.
  tone?: ChipTone
  // The trigger has no text: it gets `label` as aria-label and title.
  iconOnly?: boolean
  placement?: MenuPlacement
  // Draw the menu in <body>, fixed beside the trigger and kept on screen, for triggers inside clipping or scrolling containers.
  portal?: boolean
  // For a menu whose items load when it opens.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Layout classes for the wrapper and the menu. `triggerClassName` goes on the trigger button itself (layout only:
  // a size, a margin, a place in a row); `className` goes on the wrapper around it.
  menuClassName?: string
  triggerClassName?: string
  ref?: Ref<HTMLButtonElement>
}

// A button that opens a Menu: aria-haspopup / aria-expanded / aria-controls, ArrowDown or ArrowUp opens with focus
// on the first or last item, Escape and activating an item close and return focus to the button, Tab closes
// and lets focus move on, a click elsewhere closes.
export function MenuButton({
  label,
  trigger,
  children,
  look = 'button',
  small,
  pill,
  tone,
  iconOnly,
  placement = 'bottom-end',
  portal,
  open: openProp,
  onOpenChange,
  menuClassName,
  triggerClassName,
  className,
  disabled,
  onClick,
  onKeyDown,
  ref,
  ...rest
}: MenuButtonProps) {
  const [inner, setInner] = useState(false)
  const open = openProp ?? inner
  const [start, setStart] = useState<'first' | 'last'>('first')
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInner(next)
    onOpenChange?.(next)
  }
  const at = usePlaced(menuRef, (size) => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 }
    return menuPlacement(rect, size, placement)
  })
  const icon = look === 'icon' || look === 'dashed'
  const named = icon || iconOnly

  const menu = open && (
    <Menu
      id={menuId}
      ref={menuRef}
      label={label}
      initialFocus={start}
      ignore={triggerRef}
      closeOnViewportChange={portal}
      className={join(portal ? 'ui-menu--fixed' : `ui-menu--${placement}`, menuClassName)}
      style={portal ? { left: at.left, top: at.top } : undefined}
      onClose={(reason) => {
        giveFocusBack(reason, triggerRef.current)
        setOpen(false)
      }}
    >
      {children}
    </Menu>
  )

  return (
    <span className={join('ui-menu-wrap', className)}>
      <button
        {...rest}
        ref={(node) => {
          triggerRef.current = node
          setRef(ref, node)
        }}
        type="button"
        className={join(LOOK[look], small && !icon && 'ui-btn--sm', look === 'chip' && tone && tone !== 'neutral' && `ui-chip-btn--${tone}`, pill && look === 'chip' && 'ui-chip-btn--pill', triggerClassName)}
        disabled={disabled}
        aria-label={named ? label : rest['aria-label']}
        title={named ? label : rest.title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          onClick?.(e)
          if (e.defaultPrevented) return
          setStart('first')
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.defaultPrevented || open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
          e.preventDefault()
          setStart(e.key === 'ArrowUp' ? 'last' : 'first')
          setOpen(true)
        }}
      >
        {icon ? (
          <span className="ui-icon-btn__icon" aria-hidden="true">
            {trigger}
          </span>
        ) : (
          trigger
        )}
      </button>
      {portal && menu ? createPortal(menu, document.body) : menu}
    </span>
  )
}
