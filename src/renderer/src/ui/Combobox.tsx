import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Listbox, type ListboxOption } from './Listbox'
import { nextIndex, tabStop } from './keys'

// A text input with a list of choices under it (the branch picker, settings search). The input keeps every text
// key: Home, End, ← →, typing and Ctrl+A all edit the text. The combobox claims only ↑ ↓ (open, move), Enter
// (choose the active option), Escape (close, then clear) and Tab (close, focus moves on). The feature filters:
// pass the options to show for `query`.

export type ComboboxProps<V = string> = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'role' | 'type' | 'aria-label' | 'aria-expanded' | 'aria-controls' | 'aria-activedescendant'> & {
  // The input's accessible name.
  label: string
  options: ListboxOption<V>[]
  // The chosen value, marked in the list. The input holds only the search text; show the choice as the placeholder.
  value?: V | null
  onChange: (value: V) => void
  query: string
  onQueryChange: (query: string) => void
  // Optional control; by default it opens on typing, ↑ ↓ or a click, and closes on choosing, Escape, Tab and blur.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Shown in the list when there are no options (no match, still loading).
  empty?: ReactNode
  // After the options (a "+12 more" note).
  footer?: ReactNode
  // Inside the field, before the text and after it (icons, tags).
  leading?: ReactNode
  trailing?: ReactNode
  // The list sits in the page flow under the field (always-on results) instead of floating over it.
  inline?: boolean
  // Code font for the input and the options (branch names, file paths).
  mono?: boolean
  inputRef?: Ref<HTMLInputElement>
  // Layout for the whole combobox.
  className?: string
}

type Box = { top: number; bottom: number; left: number; width: number }

/** Fixed placement for the floating list: under the field, or over it when there is more room above. */
export function placeList(field: Box, viewportHeight: number): CSSProperties {
  const below = viewportHeight - field.bottom - 12
  const above = field.top - 12
  const up = below < 220 && above > below
  return {
    left: field.left,
    width: field.width,
    maxHeight: Math.max(120, Math.min(300, up ? above : below)),
    ...(up ? { bottom: viewportHeight - field.top + 4 } : { top: field.bottom + 4 })
  }
}

export function Combobox<V = string>({
  label,
  options,
  value,
  onChange,
  query,
  onQueryChange,
  open: controlled,
  onOpenChange,
  empty,
  footer,
  leading,
  trailing,
  inline,
  mono,
  inputRef,
  className,
  disabled,
  onKeyDown,
  onBlur,
  ...rest
}: ComboboxProps<V>) {
  const listId = useId()
  const field = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const [own, setOwn] = useState(false)
  const [active, setActive] = useState(-1)
  const [place, setPlace] = useState<CSSProperties>({})
  const open = !disabled && (controlled ?? own)
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
  const isDisabled = (i: number) => Boolean(options[i]?.disabled)
  const selected = options.findIndex((o) => o.value === value)
  // The cursor: where the user put it, else (before typing) the chosen option, else the first that can be chosen.
  const current = active >= 0 && active < options.length && !isDisabled(active) ? active : (tabStop(query ? -1 : selected, options.length, isDisabled) ?? -1)
  const showing = open && (options.length > 0 || Boolean(empty))

  const choose = (v: V) => {
    onChange(v)
    onQueryChange('')
    setActive(-1)
    setOpen(false)
  }

  // Floating list: fixed to the viewport so a dialog's own scrolling can't clip it.
  useLayoutEffect(() => {
    if (!showing || inline) return
    const update = () => {
      const r = field.current?.getBoundingClientRect()
      if (r) setPlace(placeList(r, window.innerHeight))
    }
    update()
    const onScroll = (e: Event) => !popup.current?.contains(e.target as Node) && (setOwn(false), onOpenChange?.(false))
    window.addEventListener('resize', update)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', onScroll, true)
    }
    // Placement depends on whether it shows, not on the callback's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, inline])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      if (!open) setOpen(true)
      else {
        const next = nextIndex(e.key, current, options.length, { orientation: 'vertical', wrap: true, disabled: isDisabled })
        if (next !== undefined) setActive(next)
      }
    } else if (e.key === 'Enter' && open && !e.metaKey && !e.ctrlKey && current >= 0) {
      // Choosing is this input's Enter; a form or dialog behind must not also submit.
      e.preventDefault()
      e.stopPropagation()
      choose(options[current].value)
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      } else if (query) {
        // Closed with text in it: the next Escape clears; the one after that is the page's.
        e.preventDefault()
        e.stopPropagation()
        onQueryChange('')
      }
    } else if (e.key === 'Tab' && open) setOpen(false)
  }

  return (
    <div className={['ui-combobox', className].filter(Boolean).join(' ')} data-open={showing || undefined} data-inline={inline || undefined}>
      <div
        ref={field}
        className="ui-combobox__field"
        data-disabled={disabled || undefined}
        onMouseDown={(e) => {
          if (disabled) return
          // On the text itself the browser places the caret; around it, a click toggles the list.
          if (e.target === input.current) return open || setOpen(true)
          e.preventDefault()
          input.current?.focus()
          setOpen(!open)
        }}
      >
        {leading}
        <input
          {...rest}
          ref={(el) => {
            input.current = el
            if (typeof inputRef === 'function') inputRef(el)
            else if (inputRef) inputRef.current = el
          }}
          type="text"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showing}
          aria-controls={showing && options.length > 0 ? listId : undefined}
          aria-activedescendant={showing && current >= 0 ? `${listId}-${current}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className={['ui-combobox__input', mono && 'ui-combobox__input--mono'].filter(Boolean).join(' ')}
          value={query}
          // The choice is shown as the placeholder, so with one the placeholder reads as a value, not as a hint.
          data-chosen={value != null ? '' : undefined}
          onChange={(e) => {
            onQueryChange(e.target.value)
            setActive(-1)
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            onBlur?.(e)
            setOpen(false)
          }}
        />
        {trailing}
      </div>
      {showing && (
        <div ref={popup} className="ui-combobox__popup" style={inline ? undefined : place} onMouseDown={(e) => e.preventDefault()}>
          {options.length > 0 ? (
            <Listbox id={listId} label={label} options={options} value={value} onChange={choose} activeIndex={current} onActiveChange={setActive} focusable={false} mono={mono} />
          ) : (
            <div className="ui-combobox__empty" role="status">
              {empty}
            </div>
          )}
          {footer && <div className="ui-combobox__footer">{footer}</div>}
        </div>
      )}
    </div>
  )
}
