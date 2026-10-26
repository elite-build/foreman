import type { HTMLAttributes, MouseEventHandler, ReactNode, Ref } from 'react'
import { cardClasses } from './Card'
import { Pressable } from './Pressable'
import type { PressableProps } from './Pressable'

export type ActionRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onClick'> & {
  // The row's content. When `onPress` is set it is the primary button's content, so keep it non-interactive.
  children?: ReactNode
  // Makes the row's main area a button. It stretches over the whole row, so the row is one big target
  // while `actions` stay separate buttons on top of it.
  onPress?: MouseEventHandler<HTMLButtonElement>
  // Name, description or ref for the primary button (aria-label, aria-describedby, title, ref, data-*).
  // `className` here is for layout of the content inside it.
  primaryProps?: Omit<PressableProps, 'children' | 'disabled' | 'onClick' | 'aria-current'>
  // The current row (an open workspace, the chosen item): surface fill, and aria-current on the primary button.
  selected?: boolean
  // Dims the main area and turns the primary button off. Actions are the caller's to disable.
  disabled?: boolean
  // The row's choice is waiting for confirmation (a model picked while the picker asks "continue here or new chat"): an
  // accent outline, apart from `selected`, which marks what is current.
  pending?: boolean
  // Buttons beside the main area (archive, rename, more). Siblings of the primary button, never inside it.
  actions?: ReactNode
  // Show the actions only while the row is hovered or has focus inside (they stay reachable by keyboard).
  revealActions?: boolean
  // An inline editor (rename field) that replaces the main area. Not inside a button.
  editor?: ReactNode
  // A hairline between consecutive divided rows (rows must be siblings).
  divided?: boolean
  // The row is a card (a board card, a sidebar entry): the interactive card outline and radius, and the card's selected fill.
  card?: boolean
  ref?: Ref<HTMLDivElement>
}

// A list or board row: a non-interactive container with an optional primary action, extra actions and an
// inline editor side by side. ui/ owns the selected, hover, disabled and focus surfaces.
export function ActionRow({ children, onPress, primaryProps, selected, disabled, pending, actions, revealActions, editor, divided, card, className, ref, ...rest }: ActionRowProps) {
  const { className: primaryClass, ...primaryRest } = primaryProps ?? {}
  const mainClass = 'ui-action-row__main'
  let main: ReactNode
  if (editor) {
    main = <div className={`${mainClass} ui-action-row__editor`}>{editor}</div>
  } else if (onPress) {
    main = (
      <Pressable
        {...primaryRest}
        className={primaryClass ? `${mainClass} ${primaryClass}` : mainClass}
        onClick={onPress}
        disabled={disabled}
        aria-current={selected ? 'true' : undefined}
      >
        {children}
      </Pressable>
    )
  } else {
    main = <div className={mainClass}>{children}</div>
  }
  return (
    <div
      {...rest}
      ref={ref}
      className={['ui-action-row', card && cardClasses(true, 'md'), className].filter(Boolean).join(' ')}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-pending={pending ? '' : undefined}
      data-editing={editor ? '' : undefined}
      data-divided={divided ? '' : undefined}
      data-reveal-actions={revealActions ? '' : undefined}
    >
      {main}
      {actions ? <div className="ui-action-row__actions">{actions}</div> : null}
    </div>
  )
}
