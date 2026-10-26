import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createTypeahead, nextIndex, tabStop, typeahead } from './keys'

// A single-select list: the language menu, the shell list, OpenIn's switcher rows. Focus stays on the list (or, inside
// a Combobox, on its input) and `aria-activedescendant` names the active option, so the options themselves are never
// tab stops. ↑ ↓ Home End and typeahead move the active option; Enter and Space choose it.

// A label is text, or markup (matched letters in <mark>) with `textValue`, its plain text: what typeahead matches and,
// for markup, the option's accessible name.
type OptionLabel = { label: string; textValue?: string } | { label: ReactNode; textValue: string }

export type ListboxOption<V = string> = OptionLabel & {
  value: V
  disabled?: boolean
  // Consecutive options with the same group share a headed group.
  group?: string
  // A second, smaller line.
  description?: ReactNode
  // Before the text (an icon) and after it (tags).
  leading?: ReactNode
  trailing?: ReactNode
  title?: string
  // The language of the label when it differs from the page's (a language picker lists each in its own).
  lang?: string
}

export type ListboxProps<V = string> = {
  // The list's accessible name.
  label: string
  options: ListboxOption<V>[]
  // The chosen option's value; it shows a check mark.
  value?: V | null
  onChange: (value: V) => void
  // The active option (the keyboard cursor). Leave out to let the list track it; a Combobox passes it in.
  activeIndex?: number
  onActiveChange?: (index: number) => void
  // Base id; options are `${id}-${index}`. A Combobox needs it to point `aria-controls` here.
  id?: string
  // False inside a Combobox: the input owns focus and keys, and mousedown on an option keeps it there.
  focusable?: boolean
  // Arrow keys wrap from the last option to the first.
  wrap?: boolean
  // Option labels in the code font (file paths, command names).
  mono?: boolean
  className?: string
}

const textOf = (o: OptionLabel) => o.textValue ?? (o.label as string)

const CheckMark = () => (
  <svg viewBox="0 0 12 12" width="12" height="12" focusable="false" aria-hidden="true">
    <path d="M2.5 6.4l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function Listbox<V = string>({ label, options, value, onChange, activeIndex, onActiveChange, id, focusable = true, wrap = false, mono, className }: ListboxProps<V>) {
  const generated = useId()
  const base = id ?? generated
  const root = useRef<HTMLDivElement>(null)
  const [own, setOwn] = useState(-1)
  const typed = useMemo(() => createTypeahead(), [])
  const disabled = (i: number) => Boolean(options[i]?.disabled)
  const selected = options.findIndex((o) => o.value === value)
  // The active option: the one asked for, else the chosen one, else the first that can be chosen.
  const asked = activeIndex ?? own
  const current = asked >= 0 && asked < options.length && !disabled(asked) ? asked : (tabStop(selected, options.length, disabled) ?? -1)
  const setActive = (i: number) => {
    if (activeIndex === undefined) setOwn(i)
    onActiveChange?.(i)
  }

  useEffect(() => {
    root.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  useEffect(() => () => typed.reset(), [typed])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!focusable || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    const next = nextIndex(e.key, current, options.length, { orientation: 'vertical', wrap, disabled })
    if (next !== undefined) {
      e.preventDefault()
      return setActive(next)
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (current < 0) return
      e.preventDefault()
      return onChange(options[current].value)
    }
    const query = typed.push(e.key)
    if (query === undefined) return
    const hit = typeahead(query, options.map(textOf), current, disabled)
    if (hit !== undefined) setActive(hit)
  }

  const row = (o: ListboxOption<V>, i: number) => (
    <div
      key={i}
      id={`${base}-${i}`}
      role="option"
      aria-label={typeof o.label === 'string' ? undefined : o.textValue}
      aria-selected={i === selected}
      aria-disabled={o.disabled || undefined}
      data-active={i === current || undefined}
      title={o.title}
      lang={o.lang}
      className="ui-option"
      // In a Combobox, keep focus in the input until the click lands.
      onMouseDown={focusable ? undefined : (e) => e.preventDefault()}
      onMouseMove={() => !o.disabled && i !== current && setActive(i)}
      onClick={() => !o.disabled && onChange(o.value)}
    >
      {o.leading}
      <span className="ui-option__text">
        <span className="ui-option__label">{o.label}</span>
        {o.description && <span className="ui-option__desc">{o.description}</span>}
      </span>
      {o.trailing}
      <span className="ui-option__check">{i === selected && <CheckMark />}</span>
    </div>
  )

  // Consecutive options with the same group become one role=group under a heading.
  const parts: ReactNode[] = []
  for (let i = 0; i < options.length; i++) {
    const name = options[i].group
    if (name === undefined) {
      parts.push(row(options[i], i))
      continue
    }
    let end = i
    while (end + 1 < options.length && options[end + 1].group === name) end++
    parts.push(
      <div key={i} role="group" aria-labelledby={`${base}-group-${i}`} className="ui-listbox__group">
        <div id={`${base}-group-${i}`} className="ui-listbox__heading">
          {name}
        </div>
        {options.slice(i, end + 1).map((o, n) => row(o, i + n))}
      </div>
    )
    i = end
  }

  return (
    <div
      ref={root}
      id={base}
      role="listbox"
      aria-label={label}
      aria-activedescendant={focusable && current >= 0 ? `${base}-${current}` : undefined}
      tabIndex={focusable ? 0 : undefined}
      className={['ui-listbox', mono && 'ui-listbox--mono', className].filter(Boolean).join(' ')}
      onKeyDown={onKeyDown}
    >
      {parts}
    </div>
  )
}
