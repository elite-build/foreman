// Which screenshots a screens run takes and what each file is called (screenshots.ts). Pure, so tests can run it.

export interface Shot {
  screen: string
  theme: 'light' | 'dark'
  vision?: string
  zoom?: number
  /** A large-text variant (`npm run screens -- --large-text`): the window at 200% zoom, or content text size 24. */
  variant?: LargeTextVariant
}

export const LARGE_TEXT_VARIANTS = ['zoom200', 'content24'] as const
export type LargeTextVariant = (typeof LARGE_TEXT_VARIANTS)[number]

/** The content size the `content24` variant sets (the setting's maximum). */
export const LARGE_CONTENT_SIZE = 24

/** Home, the chat, Changes (the diff) and Settings > Accessibility: the screens where large text breaks layout first. */
export const LARGE_TEXT_SCREENS: readonly string[] = ['home', 'workspace-chat', 'file-diff', 'settings-accessibility']

export function largeTextShots(): Shot[] {
  const shots: Shot[] = []
  for (const variant of LARGE_TEXT_VARIANTS) {
    for (const theme of ['light', 'dark'] as const) {
      for (const screen of LARGE_TEXT_SCREENS) shots.push({ screen, theme, variant, ...(variant === 'zoom200' ? { zoom: 2 } : {}) })
    }
  }
  return shots
}

export function fileName(shot: Shot, page = 0): string {
  const base = shot.variant ? `${shot.variant}-${shot.screen}-${shot.theme}` : `${shot.screen}-${shot.theme}${shot.vision ? `-${shot.vision}` : ''}${shot.zoom === 2 ? '-z200' : ''}`
  return `${base}${page ? `-p${page + 1}` : ''}.png`
}

/**
 * The shots to take. `base` is the usual run. The large-text variants join it with `largeText` (`--large-text`) or when
 * `only` names one (`zoom200`, `content24`, or `zoom200-home`). `only` otherwise lists screens, and keeps a variant's
 * shot when it names the screen too.
 */
export function planShots(base: readonly Shot[], options: { only?: readonly string[]; largeText?: boolean } = {}): Shot[] {
  const only = options.only ?? []
  const names = (variant: string) => [variant, ...LARGE_TEXT_SCREENS.map((screen) => `${variant}-${screen}`)]
  const asksForVariant = only.some((entry) => LARGE_TEXT_VARIANTS.some((variant) => names(variant).includes(entry)))
  const all = options.largeText || asksForVariant ? [...base, ...largeTextShots()] : [...base]
  if (!only.length) return all
  return all.filter((shot) => only.some((entry) => entry === shot.screen || (shot.variant !== undefined && (entry === shot.variant || entry === `${shot.variant}-${shot.screen}`))))
}
