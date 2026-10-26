import { Copy, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { useState, type ComponentPropsWithRef } from 'react'
import { joinClass } from './Field'

const MASK = '••••••••'

// Every string the component shows or announces. The feature passes translated text with the secret's name already
// in it ("Reveal API key"), because word order differs between languages.
export type MaskedValueLabels = {
  copy: string
  reveal: string
  hide: string
  edit: string
  remove: string
}

export type MaskedValueProps = Omit<ComponentPropsWithRef<'div'>, 'children' | 'role' | 'aria-label'> & {
  // The secret's name: it names the group.
  label: string
  labels: MaskedValueLabels
  // The last characters, shown after the mask ("••••••••abcd").
  hint?: string
  // Fetches the real value; called only when it is revealed or copied.
  reveal: () => Promise<string | null>
  onEdit?: () => void
  onRemove?: () => Promise<unknown>
  // After a copy attempt, so the feature can toast the result.
  onCopy?: (ok: boolean) => void
}

// A secret shown masked. The eye reveals it, clicking the value or the copy button copies it, and edit and remove
// buttons appear when given. The value never reaches the page until asked for.
export function MaskedValue({ label, labels, hint, reveal, onEdit, onRemove, onCopy, className, ref, ...rest }: MaskedValueProps) {
  const [shown, setShown] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const copy = async () => {
    const value = shown ?? (await reveal().catch(() => null))
    if (value === null) return onCopy?.(false)
    try {
      await navigator.clipboard.writeText(value)
      onCopy?.(true)
    } catch {
      onCopy?.(false)
    }
  }
  return (
    <div {...rest} ref={ref} role="group" aria-label={label} className={joinClass('ui-masked', className)}>
      <button type="button" className="ui-masked__value" title={labels.copy} onClick={() => void copy()}>
        {shown ?? `${MASK}${hint ?? ''}`}
      </button>
      <button
        type="button"
        className="ui-icon-btn"
        aria-label={shown === null ? labels.reveal : labels.hide}
        onClick={async () => setShown(shown === null ? await reveal().catch(() => null) : null)}
      >
        {shown === null ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
      </button>
      <button type="button" className="ui-icon-btn" aria-label={labels.copy} onClick={() => void copy()}>
        <Copy size={13} aria-hidden="true" />
      </button>
      {onEdit && (
        <button type="button" className="ui-icon-btn" aria-label={labels.edit} onClick={onEdit}>
          <Pencil size={13} aria-hidden="true" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="ui-icon-btn"
          aria-label={labels.remove}
          disabled={removing}
          onClick={async () => {
            setRemoving(true)
            await onRemove().finally(() => setRemoving(false))
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
