import { useState, type ChangeEvent, type ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type FileInputProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'size' | 'width' | 'value' | 'defaultValue' | 'children'> & {
  // The button's text ("Choose file…"); the input is named by its Field or label, not by this.
  chooseLabel: string
  // Shown beside the button until something is chosen.
  noneLabel: string
  // Show the chosen file names beside the button. Turn off when onChange clears the input straight away.
  showNames?: boolean
}

// A native file input drawn as a button plus the chosen names. The real input sits invisibly over the whole
// control, so a click, Space, Enter and the file dialog are all the browser's, and focus shows on the button.
export function FileInput({ chooseLabel, noneLabel, showNames = true, className, ref, onChange, disabled, ...rest }: FileInputProps) {
  const [own, setRef] = useOwnRef<HTMLInputElement>(ref)
  const [names, setNames] = useState('')
  useNameCheck(own, 'FileInput')
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    // Read before the handler runs: a handler that resets the input empties `files`.
    setNames([...(e.target.files ?? [])].map((f) => f.name).join(', '))
    onChange?.(e)
  }
  return (
    <span className={joinClass('ui-file', className)} data-disabled={disabled ? '' : undefined}>
      <input {...rest} ref={setRef} type="file" className="ui-file__input" disabled={disabled} onChange={change} />
      <span className="ui-file__button" aria-hidden="true">
        {chooseLabel}
      </span>
      {showNames && (
        <span className="ui-file__names" aria-hidden="true">
          {names || noneLabel}
        </span>
      )}
    </span>
  )
}
