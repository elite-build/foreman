// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import postcss, { type AtRule, type Rule } from 'postcss'
import { afterEach, describe, expect, it } from 'vitest'
import { HardHat, hardHatColours, isHardHatColour } from '../../src/renderer/src/ui/HardHat'
import type { HardHatColour } from '../../src/renderer/src/ui/HardHat'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

const svgOf = (container: HTMLElement) => container.querySelector('svg')!

describe('HardHat', () => {
  it('offers the twelve colours, each once', () => {
    expect(hardHatColours).toEqual(['orange', 'pink', 'teal', 'blue', 'green', 'purple', 'yellow', 'red', 'cyan', 'lime', 'brown', 'slate'])
    expect(new Set(hardHatColours).size).toBe(12)
  })

  it.each(hardHatColours)('draws the %s hat: the outlined figure, its face and the hat with >_, 24px by default', (colour) => {
    const { container } = render(<HardHat colour={colour} />)
    const svg = svgOf(container)
    expect(svg.getAttribute('class')).toBe('ui-hard-hat')
    expect(svg.getAttribute('data-colour')).toBe(colour)
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64')
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.querySelectorAll('.ui-hard-hat__outline > *')).toHaveLength(3)
    for (const part of ['face', 'hat', 'brim']) expect(svg.querySelectorAll(`.ui-hard-hat__${part}`), part).toHaveLength(1)
    // Two eyes and the prompt's underscore; the smile and the prompt's >.
    expect(svg.querySelectorAll('.ui-hard-hat__ink')).toHaveLength(3)
    expect(svg.querySelectorAll('.ui-hard-hat__line')).toHaveLength(2)
  })

  it('draws the same figure for every colour: only the hat changes, and only through data-colour', () => {
    const figures = hardHatColours.map((colour) => {
      const svg = svgOf(render(<HardHat colour={colour} />).container)
      return svg.innerHTML
    })
    expect(new Set(figures).size).toBe(1)
  })

  it('without a label it is decoration: hidden from assistive tech, beside the name it pictures', () => {
    const { container } = render(<HardHat colour="orange" />)
    const svg = svgOf(container)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
    expect(svg.getAttribute('aria-label')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('with a label it is an image named by it', () => {
    const { container } = render(<HardHat colour="teal" label="Max" />)
    const img = screen.getByRole('img', { name: 'Max' })
    expect(img).toBe(svgOf(container))
    expect(img.getAttribute('aria-hidden')).toBeNull()
  })

  it('decorative hides it even with a label, and an empty label names nothing', () => {
    const { container: a } = render(<HardHat colour="teal" label="Max" decorative />)
    expect(svgOf(a).getAttribute('aria-hidden')).toBe('true')
    expect(svgOf(a).getAttribute('role')).toBeNull()
    const { container: b } = render(<HardHat colour="teal" label="" />)
    expect(svgOf(b).getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it.each([16, 20, 24, 32, 40, 48, 64])('is %ipx square at that size', (size) => {
    const svg = svgOf(render(<HardHat colour="blue" size={size} />).container)
    expect(svg.getAttribute('width')).toBe(String(size))
    expect(svg.getAttribute('height')).toBe(String(size))
  })

  it('is never a tab stop or a control', () => {
    const { container } = render(<HardHat colour="red" label="Ada" />)
    const svg = svgOf(container)
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('tabindex')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps a layout className and passes native props through', () => {
    const svg = svgOf(render(<HardHat colour="lime" className="mine" data-testid="hat" />).container)
    expect(svg.getAttribute('class')).toBe('ui-hard-hat mine')
    expect(screen.getByTestId('hat')).toBe(svg)
  })

  it('draws the slate hat for a colour it does not know (one a newer version stored), rather than failing', () => {
    const svg = svgOf(render(<HardHat colour={'magenta' as HardHatColour} label="Eve" />).container)
    expect(svg.getAttribute('data-colour')).toBe('slate')
    expect(screen.getByRole('img', { name: 'Eve' })).toBe(svg)
  })

  it('isHardHatColour accepts the twelve and nothing else', () => {
    for (const colour of hardHatColours) expect(isHardHatColour(colour), colour).toBe(true)
    for (const value of ['magenta', '', 'Orange', 'accent', null, undefined, 3, {}]) expect(isHardHatColour(value), String(value)).toBe(false)
  })
})

describe('HardHat colours (ui/css/hard-hat.css, ui/tokens.css)', () => {
  const css = readCss('hard-hat')
  const tokens = readFileSync('src/renderer/src/ui/tokens.css', 'utf8')

  // The tokens by theme: dark is the base :root, light overrides it under prefers-color-scheme: light.
  const base = new Map<string, string>()
  const light = new Map<string, string>()
  postcss.parse(tokens).walkDecls(/^--/, (decl) => {
    const rule = decl.parent as Rule
    const media = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : undefined
    if (rule.selector?.trim() !== ':root') return
    if (!media) base.set(decl.prop, decl.value.trim())
    else if (/prefers-color-scheme:\s*light/.test(media.params)) light.set(decl.prop, decl.value.trim())
  })
  const theme = (name: 'dark' | 'light') => (token: string) => (name === 'light' && light.has(token) ? light.get(token)! : base.get(token)!)

  it.each(hardHatColours)('%s maps to its hat and brim tokens', (colour) => {
    const body = ruleBody(css, `.ui-hard-hat[data-colour='${colour}']`)
    expect(body, `a rule for ${colour}`).toBeDefined()
    expect(body).toMatch(new RegExp(`--ui-hard-hat-hat:\\s*var\\(--hat-${colour}\\)`))
    expect(body).toMatch(new RegExp(`--ui-hard-hat-brim:\\s*var\\(--hat-${colour}-shade\\)`))
  })

  it('every hat token is a colour of its own, the same in both themes, and never the accent', () => {
    const names = ['--hat-ink', '--hat-face', ...hardHatColours.flatMap((c) => [`--hat-${c}`, `--hat-${c}-shade`])]
    for (const name of names) {
      expect(base.get(name), name).toMatch(/^#[0-9a-f]{6}$/i)
      expect(light.has(name), `${name} is not overridden in light`).toBe(false)
    }
    expect(css).not.toMatch(/--accent\b/)
  })

  it('the outline stays the text colour in forced colours', () => {
    const forced = /@media \(forced-colors: active\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''
    expect(ruleBody(forced, '.ui-hard-hat')).toMatch(/forced-color-adjust:\s*none/)
    expect(ruleBody(forced, '.ui-hard-hat__outline')).toMatch(/fill:\s*CanvasText[\s\S]*stroke:\s*CanvasText/)
  })

  // WCAG 1.4.11: the figure is a graphic, so its edge needs 3:1 against what it sits on. With no disc behind it, the ink
  // outline carries it on a light surface and the face on a dark one; the >_ on the dome needs 3:1 against every hat.
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const SURFACES = ['--bg', '--bg-sidebar', '--bg-panel', '--bg-raised', '--bg-hover', '--bg-selected', '--bg-input']

  it.each(['dark', 'light'] as const)('the figure stands out on every surface (%s)', (name) => {
    const get = theme(name)
    const failures = SURFACES.map((s) => [s, Math.max(ratio(get('--hat-ink'), get(s)), ratio(get('--hat-face'), get(s)))] as const)
      .filter(([, r]) => r < 3)
      .map(([s, r]) => `${s}: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  it('the >_ reads on every hat, and the eyes on the face', () => {
    const ink = base.get('--hat-ink')!
    const failures = hardHatColours.map((c) => [c, ratio(ink, base.get(`--hat-${c}`)!)] as const).filter(([, r]) => r < 3).map(([c, r]) => `${c}: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
    expect(ratio(ink, base.get('--hat-face')!)).toBeGreaterThan(4.5)
  })
})
