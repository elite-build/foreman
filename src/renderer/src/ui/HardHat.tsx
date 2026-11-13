import type { SVGProps } from 'react'

// The hat colours, in the order a picker offers them. Each is a hat and brim pair of tokens (--hat-<colour>,
// --hat-<colour>-shade in tokens.css). They mark who someone is, never a state.
export const hardHatColours = ['orange', 'pink', 'teal', 'blue', 'green', 'purple', 'yellow', 'red', 'cyan', 'lime', 'brown', 'slate'] as const
export type HardHatColour = (typeof hardHatColours)[number]

// A colour read back from storage may be one this build doesn't know (a newer version wrote it).
export function isHardHatColour(value: unknown): value is HardHatColour {
  return typeof value === 'string' && (hardHatColours as readonly string[]).includes(value)
}

// Drawn when the colour isn't one of hardHatColours: the quietest hat.
const FALLBACK: HardHatColour = 'slate'

// The figure on a 64×64 grid: an outline round the whole figure (drawn first, wider, under everything), the face, its
// eyes and smile, the hat's dome and brim, and the logo's >_ on the dome.
const DOME = 'M11 35 C11 18 20 7 32 7 C44 7 53 18 53 35 Z'

export type HardHatProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'role' | 'aria-hidden' | 'aria-label' | 'focusable' | 'width' | 'height' | 'viewBox'> & {
  // The hat's colour. An unknown value draws the slate hat.
  colour: HardHatColour
  // Width and height in px (16, 20, 24, 32, 40, 48 or 64 suit the grid). Default 24.
  size?: number
  // The employee's name, when the avatar stands alone: it becomes role="img" with this name. Omit it when the name is
  // shown beside the avatar, which then is hidden from assistive tech.
  label?: string
  // Hidden from assistive tech even with a label.
  decorative?: boolean
}

// An AI employee's avatar: a little person in Foreman's hard hat, the hat in the employee's colour. Not interactive.
export function HardHat({ colour, size = 24, label, decorative, className, ...rest }: HardHatProps) {
  const hat = isHardHatColour(colour) ? colour : FALLBACK
  const named = Boolean(label) && !decorative
  return (
    <svg
      {...rest}
      className={className ? `ui-hard-hat ${className}` : 'ui-hard-hat'}
      data-colour={hat}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      focusable="false"
      {...(named ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <g className="ui-hard-hat__outline" strokeWidth="5" strokeLinejoin="round">
        <ellipse cx="32" cy="44" rx="16" ry="14" />
        <path d={DOME} />
        <rect x="5" y="31" width="54" height="8" rx="4" />
      </g>
      <ellipse className="ui-hard-hat__face" cx="32" cy="44" rx="16" ry="14" />
      <circle className="ui-hard-hat__ink" cx="25.5" cy="45" r="3" />
      <circle className="ui-hard-hat__ink" cx="38.5" cy="45" r="3" />
      <path className="ui-hard-hat__line" d="M27.5 51 Q32 55 36.5 51" fill="none" strokeWidth="3" strokeLinecap="round" />
      <path className="ui-hard-hat__hat" d={DOME} />
      <rect className="ui-hard-hat__brim" x="5" y="31" width="54" height="8" rx="4" />
      <path className="ui-hard-hat__line" d="M21.5 15.5 L28 21 L21.5 26.5" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="ui-hard-hat__ink" x="30.5" y="23.5" width="11" height="4.5" rx="2.25" />
    </svg>
  )
}
