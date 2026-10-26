import { useCallback, useEffect, useId, useRef, type ReactNode, type Ref, type RefObject } from 'react'

// What a control needs to be wired to its label, help text and error. Passed by explicit binding (spread
// `controlProps` onto the control), not by React context, so a missed binding is visible at the call site.
export type FieldControlProps = {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export type FieldBinding = {
  id: string
  invalid: boolean
  labelProps: { htmlFor: string }
  controlProps: FieldControlProps
  descriptionProps: { id: string }
  errorProps: { id: string }
}

export type UseFieldOptions = {
  // Use a known id instead of a generated one.
  id?: string
  // True when a description element with `descriptionProps` is rendered.
  description?: boolean
  // True when an error is showing: the control becomes invalid and points at the element with `errorProps`.
  error?: boolean
}

// Ids and ARIA wiring for a label, a control, optional help and an optional error. `Field` uses it for the
// usual stacked layout; call it directly when a row lays its label and help out itself (settings rows).
export function useField({ id: given, description = false, error = false }: UseFieldOptions = {}): FieldBinding {
  const generated = useId()
  const id = given ?? generated
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy = [description && descriptionId, error && errorId].filter(Boolean).join(' ')
  return {
    id,
    invalid: error,
    labelProps: { htmlFor: id },
    controlProps: { id, ...(describedBy && { 'aria-describedby': describedBy }), ...(error && { 'aria-invalid': true as const }) },
    descriptionProps: { id: descriptionId },
    errorProps: { id: errorId }
  }
}

export type FieldProps = {
  label: ReactNode
  // Show the label to screen readers only (a search box whose placeholder says it all).
  hideLabel?: boolean
  description?: ReactNode
  // Shown under the control; its presence marks the control invalid.
  error?: ReactNode
  className?: string
  children: (control: FieldControlProps) => ReactNode
}

// A label, optional help, a control and an optional error, wired together. The control comes in as a render
// function so the binding is explicit: <Field label="Name">{(c) => <TextInput {...c} />}</Field>
export function Field({ label, hideLabel, description, error, className, children }: FieldProps) {
  const hasError = Boolean(error)
  const field = useField({ description: Boolean(description), error: hasError })
  return (
    <div className={['ui-field', className].filter(Boolean).join(' ')} data-invalid={hasError ? '' : undefined}>
      <label className="ui-field__label" data-hidden={hideLabel ? '' : undefined} {...field.labelProps}>
        {label}
      </label>
      {description && (
        <p className="ui-field__description" {...field.descriptionProps}>
          {description}
        </p>
      )}
      {children(field.controlProps)}
      {hasError && (
        <p className="ui-field__error" role="alert" {...field.errorProps}>
          <svg className="ui-glyph" data-glyph="error" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M6 .6 11.4 6 6 11.4.6 6z" fill="currentColor" />
          </svg>
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

// ---- helpers shared by the form controls ----

function hasAccessibleName(el: HTMLElement): boolean {
  if (el.getAttribute('aria-label')?.trim()) return true
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy && labelledBy.split(/\s+/).some((id) => el.ownerDocument.getElementById(id)?.textContent?.trim())) return true
  const labels = (el as HTMLInputElement).labels
  return Boolean(labels && [...labels].some((l) => l.textContent?.trim()))
}

// Dev only: a control with no name is invisible to a screen reader, so fail where the mistake is made. Runs after
// every render (a label may arrive later) and costs nothing in a production build.
export function useNameCheck(ref: RefObject<HTMLElement | null>, component: string): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const el = ref.current
    if (el && !hasAccessibleName(el)) {
      throw new Error(`${component} has no accessible name. Wrap it in <Field label=…>, give it a <label htmlFor>, or pass aria-label or aria-labelledby.`)
    }
  })
}

// One ref for the component's own use (the name check) that also feeds the caller's ref, object or callback.
export function useOwnRef<T extends HTMLElement>(forwarded: Ref<T> | undefined): [RefObject<T | null>, (node: T | null) => void | (() => void)] {
  const own = useRef<T | null>(null)
  const set = useCallback(
    (node: T | null) => {
      own.current = node
      if (typeof forwarded === 'function') {
        const cleanup = forwarded(node)
        return typeof cleanup === 'function'
          ? () => {
              own.current = null
              cleanup()
            }
          : undefined
      }
      if (forwarded) forwarded.current = node
      return undefined
    },
    [forwarded]
  )
  return [own, set]
}

export const joinClass = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')
