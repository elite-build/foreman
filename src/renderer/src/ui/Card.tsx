import type { HTMLAttributes, Ref } from 'react'
import { Pressable } from './Pressable'
import type { PressableProps } from './Pressable'

// The look a card can wear. State is data-* on the element (CSS keys on it); the caller adds the matching ARIA
// (`aria-pressed`, `aria-current`, `aria-expanded`), because what "selected" means differs from card to card.
export type CardLook = {
  // Chosen or open: accent edge and tint.
  selected?: boolean
  // Something being dragged would land on this card: accent edge.
  target?: boolean
  // A placeholder slot: dashed edge, no fill (a free loadout slot, a drop zone).
  empty?: boolean
  // The original while its copy is being dragged: dashed, content dimmed.
  lifted?: boolean
  // The copy that follows the pointer: raised, shadowed, tilted, and it never takes the pointer. Place it with CSS.
  ghost?: boolean
  // danger: dropping here removes the item (the ghost's edge goes red).
  tone?: 'default' | 'danger'
  // A drop indicator on the card's top or bottom edge (reordering a list).
  drop?: 'before' | 'after'
  // A leading 3px edge in a status colour (a step that runs in parallel, a calendar block's state).
  stripe?: 'neutral' | 'ok' | 'warn' | 'info' | 'muted'
  // sm: a 7px corner for a compact card (a row-sized choice); md: 10px.
  size?: 'md' | 'sm'
}

export type CardProps = HTMLAttributes<HTMLDivElement> &
  CardLook & {
    // Draggable or selectable: the edge is the control outline (`--border-control`, 3:1), so it shows where the card is.
    // Without it the card is a quiet frame (`--border`) for content that isn't a control.
    interactive?: boolean
    // The element: a plain div, or a landmark-free section, article or list item.
    as?: 'div' | 'section' | 'article' | 'li'
    ref?: Ref<HTMLDivElement>
  }

export type CardButtonProps = PressableProps & CardLook

function lookProps({ selected, target, empty, lifted, ghost, tone, drop, stripe }: Omit<CardLook, 'size'>) {
  return {
    'data-selected': selected ? '' : undefined,
    'data-target': target ? '' : undefined,
    'data-empty': empty ? '' : undefined,
    'data-lifted': lifted ? '' : undefined,
    'data-ghost': ghost ? '' : undefined,
    'data-tone': tone && tone !== 'default' ? tone : undefined,
    'data-drop': drop,
    'data-stripe': stripe
  }
}

// A card's classes: the frame, the interactive edge, the compact corner.
export function cardClasses(interactive: boolean, size: CardLook['size'], className?: string): string {
  return ['ui-card', interactive && 'ui-card--interactive', size === 'sm' && 'ui-card--sm', className].filter(Boolean).join(' ')
}

// A surface that groups content: `<Card>` is a quiet frame; `<Card interactive>` is a card the user can pick up, drop on
// or choose, with the control outline. A card with one action is a `CardButton`; a list entry with extra actions is an
// `ActionRow card`. Content inside a Card may be interactive; inside a CardButton it may not (it is a button).
export function Card({ interactive = false, as = 'div', className, ref, selected, target, empty, lifted, ghost, tone, drop, stripe, size, ...rest }: CardProps) {
  const data = lookProps({ selected, target, empty, lifted, ghost, tone, drop, stripe })
  const As = as
  return <As {...(rest as object)} ref={ref as never} className={cardClasses(interactive, size, className)} {...data} />
}

// One action on a whole card: the Pressable (button, focus ring, no interactive content inside) wearing the interactive card look.
export function CardButton({ className, selected, target, empty, lifted, ghost, tone, drop, stripe, size, ...rest }: CardButtonProps) {
  const data = lookProps({ selected, target, empty, lifted, ghost, tone, drop, stripe })
  return <Pressable {...rest} {...data} className={cardClasses(true, size, className)} />
}
