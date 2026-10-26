import type { HTMLAttributes, ReactNode, Ref } from 'react'

export type MediaThumbProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  // The picture. Omit for a non-image attachment and pass `children` (an icon) instead.
  src?: string
  // The file name, shown over the bottom edge.
  name: string
  // Shows a remove button, which appears on hover and whenever focus is inside the thumbnail.
  onRemove?: () => void
  // The remove button's accessible name ("Remove screenshot-login.png"). Required with `onRemove`.
  removeLabel?: string
  children?: ReactNode
  ref?: Ref<HTMLDivElement>
}

// An attachment thumbnail: a 96×68 picture or icon, its name, and an optional 24px remove button.
export function MediaThumb({ src, name, onRemove, removeLabel, className, children, ref, ...rest }: MediaThumbProps) {
  if (onRemove && !removeLabel) throw new Error('MediaThumb: removeLabel is required when onRemove is set')
  return (
    <div {...rest} ref={ref} className={className ? `ui-media-thumb ${className}` : 'ui-media-thumb'}>
      {src ? <img className="ui-media-thumb__img" src={src} alt="" draggable={false} /> : children}
      <span className="ui-media-thumb__name">{name}</span>
      {onRemove ? (
        <button type="button" className="ui-media-thumb__remove" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M3 3l6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
