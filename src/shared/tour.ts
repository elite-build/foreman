// The welcome tour: a spotlight that walks a new user through Foreman's main controls.
// Each step points at an element marked `data-tour="<target>"`; this file holds the steps
// and the geometry, so it has no DOM in it and the renderer only measures and draws.

/**
 * Where a step's control lives, which says what to tell the user when it isn't on screen:
 * - `sidebar`: in the sidebar (hidden with ⌘B).
 */
export type TourArea = 'sidebar'

/** What a step's button does (the renderer maps each to a store action and its label). */
export type TourAction = 'filterNeedsYou' | 'switchLayout' | 'openAutomations' | 'openAssistant' | 'openAccessibility'

export interface TourStep {
  id: string
  // The `data-tour` value of the element it points at. None: a centered card.
  target?: string
  area?: TourArea
  // Left out of the tour when its control isn't there when the tour starts (the assistant, when it's turned off).
  optional?: boolean
  // A button on the card that does the thing the step is about, then ends the tour.
  action?: TourAction
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'welcome' },
  { id: 'addRepo', target: 'add-repo', area: 'sidebar' },
  { id: 'newWorkspace', target: 'new-workspace', area: 'sidebar' },
  { id: 'needsYou', target: 'needs-you', area: 'sidebar', action: 'filterNeedsYou' },
  // No control to point at: the layout is a setting (and ⌘K), so this is a centered card.
  { id: 'layout', action: 'switchLayout' },
  { id: 'automations', target: 'automations', area: 'sidebar', action: 'openAutomations' },
  { id: 'assistant', target: 'assistant', area: 'sidebar', optional: true, action: 'openAssistant' },
  { id: 'settings', target: 'settings', area: 'sidebar', action: 'openAccessibility' },
  { id: 'help', target: 'help', area: 'sidebar' }
]

/** The steps for this run: optional ones only when their control is there. */
export function tourSteps(present: (target: string) => boolean, steps: readonly TourStep[] = TOUR_STEPS): TourStep[] {
  return steps.filter((s) => !s.optional || (s.target !== undefined && present(s.target)))
}

/**
 * Whether the tour opens by itself. Only once, on a first launch: someone who already has
 * repositories when this version arrives has found their way around (see the store migration).
 */
export function tourStartsOnLaunch(settings: { tourSeen: boolean }): boolean {
  return !settings.tourSeen
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export type CardSide = 'right' | 'left' | 'below' | 'above' | 'center'

export interface CardPlacement {
  left: number
  top: number
  // Which side of the target the card sits on; `center` when there's no target.
  side: CardSide
  // Along the card's edge facing the target: where the arrow points (px from the card's top or left).
  arrow: number
}

// Space between the target and the card, and between the card and the window edge.
const GAP = 14
const MARGIN = 8
// The arrow stays this far from the card's corners.
const ARROW_INSET = 18

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/**
 * Where the card goes: beside the target (right first, as most targets are in the left-hand
 * sidebar, then left, below, above), kept inside the window. With no target it's centered.
 */
export function placeCard(target: Rect | null, card: { width: number; height: number }, view: { width: number; height: number }): CardPlacement {
  if (!target) return { left: Math.round((view.width - card.width) / 2), top: Math.round((view.height - card.height) / 2), side: 'center', arrow: 0 }
  const right = target.left + target.width
  const bottom = target.top + target.height
  const midX = target.left + target.width / 2
  const midY = target.top + target.height / 2
  const fits: Record<Exclude<CardSide, 'center'>, boolean> = {
    right: right + GAP + card.width + MARGIN <= view.width,
    left: target.left - GAP - card.width - MARGIN >= 0,
    below: bottom + GAP + card.height + MARGIN <= view.height,
    above: target.top - GAP - card.height - MARGIN >= 0
  }
  const order: Exclude<CardSide, 'center'>[] = ['right', 'left', 'below', 'above']
  // Nothing fits (a tiny window): beside it on the right, overlapping, still inside the window.
  const side = order.find((s) => fits[s]) ?? 'right'
  if (side === 'right' || side === 'left') {
    const left = side === 'right' ? right + GAP : target.left - GAP - card.width
    const top = clamp(midY - card.height / 2, MARGIN, view.height - card.height - MARGIN)
    return { left: Math.round(clamp(left, MARGIN, view.width - card.width - MARGIN)), top: Math.round(top), side, arrow: Math.round(clamp(midY - top, ARROW_INSET, card.height - ARROW_INSET)) }
  }
  const top = side === 'below' ? bottom + GAP : target.top - GAP - card.height
  const left = clamp(midX - card.width / 2, MARGIN, view.width - card.width - MARGIN)
  return { left: Math.round(left), top: Math.round(top), side, arrow: Math.round(clamp(midX - left, ARROW_INSET, card.width - ARROW_INSET)) }
}
