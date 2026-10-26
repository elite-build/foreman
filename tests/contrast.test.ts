// Contrast of the design tokens. Reads src/renderer/src/ui/tokens.css, applies
// the light theme and colour-vision overrides the way the cascade does, resolves var() and evaluates color-mix(in srgb)
// and alpha over each surface with the small helpers below, and holds every pair to WCAG 2.2 AA: text 4.5:1, control
// borders 3:1. A value it can't evaluate fails the test instead of passing unchecked.
import { readFileSync } from 'node:fs'
import postcss, { type AtRule, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const TOKENS = 'src/renderer/src/ui/tokens.css'

type Theme = 'dark' | 'light'
type Vision = 'default' | 'protanopia-deuteranopia' | 'tritanopia'
const THEMES: Theme[] = ['dark', 'light']
const VISIONS: Vision[] = ['default', 'protanopia-deuteranopia', 'tritanopia']

const SURFACES = ['--bg', '--bg-sidebar', '--bg-panel', '--bg-raised', '--bg-hover', '--bg-selected']
// Where a card, a control or a mark can sit: the surfaces plus an input's own fill.
const EDGE_SURFACES = [...SURFACES, '--bg-input']
const TEXT = ['--text', '--text-soft', '--text-muted', '--text-faint', '--accent', '--green', '--red', '--amber', '--blue']
// A tag's text on its own tint.
const TAGS: [text: string, tint: string][] = [
  ['--accent', '--accent-bg'],
  ['--green', '--add-bg'],
  ['--red', '--del-bg'],
  ['--amber', '--amber-bg'],
  ['--blue', '--blue-bg']
]
// Button text on its fill and hover fill.
const FILLS: [text: string, fill: string][] = [
  ['--on-primary', '--primary'],
  ['--on-primary', '--primary-hover'],
  ['--on-danger', '--danger'],
  ['--on-danger', '--danger-hover']
]
// Tokens that aren't colours.
const NOT_COLOUR = /^--(font|mono|code-ligatures|titlebar|text-(xs|sm|md|lg|xl|content(-code|-heading)?|display-[\w-]+)|radius-[\w-]+|target-min)$/

// ---- colours ----

/** sRGB channels 0–255 and alpha 0–1. */
interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseHex(hex: string): Rgba {
  const h = hex.slice(1)
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 }
}

/** Split a function's arguments on top-level commas. */
function args(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++
    else if (inner[i] === ')') depth--
    else if (inner[i] === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(inner.slice(start).trim())
  return out
}

/** A colour and an optional percentage, as color-mix() takes them: `#abc 12%`. */
function mixPart(part: string): { colour: Rgba; weight?: number } {
  const m = /^(.*?)(?:\s+(\d*\.?\d+)%)?$/s.exec(part.trim())!
  return { colour: parseColour(m[1]), weight: m[2] === undefined ? undefined : Number(m[2]) / 100 }
}

/** color-mix(in srgb, …) as CSS Color 5 defines it: weights normalised, channels premultiplied by alpha. */
function colorMix(inner: string): Rgba {
  const [space, first, second, ...rest] = args(inner)
  if (space !== 'in srgb' || !first || !second || rest.length) throw new Error(`can't evaluate color-mix(${inner})`)
  const a = mixPart(first)
  const b = mixPart(second)
  let p1 = a.weight ?? (b.weight === undefined ? 0.5 : 1 - b.weight)
  let p2 = b.weight ?? 1 - p1
  const sum = p1 + p2
  if (sum <= 0) throw new Error(`can't evaluate color-mix(${inner})`)
  const scale = Math.min(sum, 1)
  p1 /= sum
  p2 /= sum
  const alpha = a.colour.a * p1 + b.colour.a * p2
  const channel = (k: 'r' | 'g' | 'b') => (alpha === 0 ? 0 : (a.colour[k] * a.colour.a * p1 + b.colour[k] * b.colour.a * p2) / alpha)
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha * scale }
}

/** A colour with every var() already resolved: hex, rgb()/rgba(), transparent, white, black, or color-mix(in srgb). */
function parseColour(value: string): Rgba {
  const v = value.trim()
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return parseHex(v)
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  const fn = /^([a-z-]+)\((.*)\)$/is.exec(v)
  if (fn?.[1] === 'color-mix') return colorMix(fn[2])
  if (fn && (fn[1] === 'rgb' || fn[1] === 'rgba')) {
    const parts = args(fn[2])
    if ((parts.length === 3 || parts.length === 4) && parts.every((p) => /^\d*\.?\d+$/.test(p))) {
      const [r, g, b, a = '1'] = parts.map(String)
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) }
    }
  }
  throw new Error(`can't evaluate the colour "${v}"`)
}

/** A colour over an opaque one. */
function over(top: Rgba, under: Rgba): Rgba {
  if (under.a !== 1) throw new Error('composite onto an opaque colour only')
  const mix = (k: 'r' | 'g' | 'b') => top[k] * top.a + under[k] * (1 - top.a)
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 }
}

function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG contrast ratio of two opaque colours. */
function contrast(a: Rgba, b: Rgba): number {
  if (a.a !== 1 || b.a !== 1) throw new Error('contrast of opaque colours only')
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ---- tokens ----

interface Layers {
  base: Map<string, string>
  theme: Record<Theme, Map<string, string>>
  vision: Record<Theme, Record<Exclude<Vision, 'default'>, Map<string, string>>>
}

/** The custom properties of tokens.css by where they apply. A custom property anywhere else fails. */
function readLayers(source: string): Layers {
  const layers: Layers = {
    base: new Map(),
    theme: { dark: new Map(), light: new Map() },
    vision: { dark: { 'protanopia-deuteranopia': new Map(), tritanopia: new Map() }, light: { 'protanopia-deuteranopia': new Map(), tritanopia: new Map() } }
  }
  postcss.parse(source, { from: TOKENS }).walkDecls(/^--/, (decl) => {
    const rule = decl.parent as Rule
    const media = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : undefined
    const scheme = media && /^\(prefers-color-scheme:\s*(dark|light)\)$/.exec(media.params.trim())?.[1]
    const vision = /^\[data-color-vision='(protanopia-deuteranopia|tritanopia)'\]$/.exec(rule.selector.trim())?.[1] as Exclude<Vision, 'default'> | undefined
    let target: Map<string, string> | undefined
    if (rule.type === 'rule' && rule.selector.trim() === ':root') target = media ? (scheme ? layers.theme[scheme as Theme] : undefined) : layers.base
    else if (vision && scheme) target = layers.vision[scheme as Theme][vision]
    if (!target) throw new Error(`${decl.prop} is set where this test can't place it (${media ? `@media ${media.params} ` : ''}${rule.selector})`)
    target.set(decl.prop, decl.value)
  })
  return layers
}

/** Every token as the cascade gives it to <html> in one theme and colour-vision mode, var() resolved. */
function tokensFor(layers: Layers, theme: Theme, vision: Vision): (name: string) => string {
  // Later layers win: they come later in the file with the same specificity, and a dark :root layer stands for the default.
  const declared = new Map([...layers.base, ...layers.theme[theme], ...(vision === 'default' ? [] : layers.vision[theme][vision])])
  const resolve = (name: string, seen: string[] = []): string => {
    if (seen.includes(name)) throw new Error(`var() cycle: ${[...seen, name].join(' → ')}`)
    const value = declared.get(name)
    if (value === undefined) throw new Error(`${name} is not defined`)
    return substitute(value, [...seen, name])
  }
  const substitute = (value: string, seen: string[]): string =>
    value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => (declared.has(name) ? resolve(name, seen) : fallback !== undefined ? substitute(fallback, seen) : resolve(name, seen)))
  return (name) => resolve(name)
}

const layers = readLayers(readFileSync(TOKENS, 'utf8'))
const MODES = THEMES.flatMap((theme) => VISIONS.map((vision) => ({ theme, vision, label: `${theme}, ${vision}` })))

function colourOf(get: (name: string) => string, name: string): Rgba {
  try {
    return parseColour(get(name))
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : err}`)
  }
}

describe('contrast helpers', () => {
  it('measures WCAG contrast', () => {
    expect(contrast(parseColour('#000'), parseColour('#fff'))).toBeCloseTo(21, 5)
    expect(contrast(parseColour('#777777'), parseColour('#ffffff'))).toBeCloseTo(4.48, 2)
  })

  it('mixes in srgb as CSS does', () => {
    const near = (c: Rgba, want: Rgba) => (['r', 'g', 'b', 'a'] as const).forEach((k) => expect(c[k], k).toBeCloseTo(want[k], 6))
    const tint = parseColour('color-mix(in srgb, #ff0000 12%, transparent)')
    near(tint, { r: 255, g: 0, b: 0, a: 0.12 })
    near(over(tint, parseColour('#ffffff')), { r: 255, g: 224.4, b: 224.4, a: 1 })
    near(parseColour('color-mix(in srgb, #000000, #ffffff)'), { r: 127.5, g: 127.5, b: 127.5, a: 1 })
    near(parseColour('color-mix(in srgb, #000000 20%, #ffffff 20%)'), { r: 127.5, g: 127.5, b: 127.5, a: 0.4 })
    near(parseColour('rgba(0, 0, 0, 0.6)'), { r: 0, g: 0, b: 0, a: 0.6 })
  })

  it("rejects what it can't evaluate", () => {
    expect(() => parseColour('oklch(70% 0.1 30)')).toThrow()
    expect(() => parseColour('color-mix(in oklch, red, blue)')).toThrow()
    expect(() => parseColour('rgb(0 0 0 / 50%)')).toThrow()
    expect(() => parseColour('var(--accent)')).toThrow()
  })
})

describe('design tokens (ui/tokens.css)', () => {
  it.each(MODES)('every colour token evaluates ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const names = new Set([...layers.base.keys(), ...layers.theme[theme].keys()])
    for (const name of names) if (!NOT_COLOUR.test(name)) colourOf(get, name)
    for (const name of SURFACES) expect(colourOf(get, name).a, `${name} is opaque`).toBe(1)
  })

  it.each(MODES)('text is 4.5:1 and control borders 3:1 on every surface ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    for (const surface of SURFACES) {
      const bg = colourOf(get, surface)
      for (const text of TEXT) {
        const ratio = contrast(over(colourOf(get, text), bg), bg)
        if (ratio < 4.5) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`)
      }
      const border = contrast(over(colourOf(get, '--border-control'), bg), bg)
      if (border < 3) failures.push(`--border-control on ${surface}: ${border.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  it.each(MODES)('tag text is 4.5:1 on its tint over every surface ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    for (const surface of SURFACES) {
      const bg = colourOf(get, surface)
      for (const [text, tint] of TAGS) {
        const under = over(colourOf(get, tint), bg)
        const ratio = contrast(over(colourOf(get, text), under), under)
        if (ratio < 4.5) failures.push(`${text} on ${tint} over ${surface}: ${ratio.toFixed(2)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it.each(MODES)('button text is 4.5:1 on its fill ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    for (const [text, fill] of FILLS) {
      const bg = colourOf(get, fill)
      expect(bg.a, `${fill} is opaque`).toBe(1)
      const ratio = contrast(over(colourOf(get, text), bg), bg)
      if (ratio < 4.5) failures.push(`${text} on ${fill}: ${ratio.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  it.each(MODES)('every syntax colour is 4.5:1 on --code-bg ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const bg = colourOf(get, '--code-bg')
    const names = [...new Set([...layers.base.keys(), ...layers.theme[theme].keys()])].filter((n) => n.startsWith('--code-') && n !== '--code-bg' && !NOT_COLOUR.test(n))
    expect(names.length).toBeGreaterThan(10)
    const failures = names.map((n) => [n, contrast(over(colourOf(get, n), bg), bg)] as const).filter(([, r]) => r < 4.5).map(([n, r]) => `${n}: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  // ui/css/meter.css: the fill carries the value, so it needs 3:1 against the track it sits in.
  it.each(MODES)('a meter fill is 3:1 on its track ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const track = colourOf(get, '--bg-raised')
    const failures = ['--green', '--amber', '--red']
      .map((fill) => [fill, contrast(over(colourOf(get, fill), track), track)] as const)
      .filter(([, r]) => r < 3)
      .map(([fill, r]) => `${fill} on --bg-raised: ${r.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  // ui/css/callout.css: body text is --text-soft and the title --text, on the tone's tint over any surface.
  it.each(MODES)('callout text is 4.5:1 on every tone over every surface ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    for (const surface of SURFACES) {
      const bg = colourOf(get, surface)
      for (const tint of ['--bg-raised', '--blue-bg', '--add-bg', '--amber-bg', '--del-bg']) {
        const under = over(colourOf(get, tint), bg)
        for (const text of ['--text-soft', '--text']) {
          const ratio = contrast(over(colourOf(get, text), under), under)
          if (ratio < 4.5) failures.push(`${text} on ${tint} over ${surface}: ${ratio.toFixed(2)}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  // The focus ring is blue, and every state that used to wear the accent (selected, chosen, current, checked) is neutral:
  // the accent is ~10 delta-E from --red, so it made "you're here" read as an error. Each mark below is a non-text
  // indicator (WCAG 1.4.11), so it needs 3:1 against everything it sits on.
  it.each(MODES)('the focus ring is blue and 3:1 on every surface ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    expect(get('--focus-ring'), '--focus-ring is --blue').toBe(get('--blue'))
    const failures: string[] = []
    for (const surface of EDGE_SURFACES) {
      const bg = colourOf(get, surface)
      const ratio = contrast(over(colourOf(get, '--focus-ring'), bg), bg)
      if (ratio < 3) failures.push(`--focus-ring on ${surface}: ${ratio.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  it.each(MODES)('a selected edge and mark are 3:1 on every surface, a check is 3:1 on its fill ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    for (const surface of [...EDGE_SURFACES, '--selected-bg']) {
      const bg = colourOf(get, surface)
      for (const mark of ['--selected-border', '--selected-mark']) {
        const ratio = contrast(over(colourOf(get, mark), bg), bg)
        if (ratio < 3) failures.push(`${mark} on ${surface}: ${ratio.toFixed(2)}`)
      }
    }
    const fill = colourOf(get, '--selected-mark')
    const glyph = contrast(over(colourOf(get, '--on-selected-mark'), fill), fill)
    if (glyph < 3) failures.push(`--on-selected-mark on --selected-mark: ${glyph.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  it.each(MODES)('text is 4.5:1 on a selected fill and on the see-through tint ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    const failures: string[] = []
    // The fill is opaque; the tint lies over whatever the thing sits on.
    const fill = colourOf(get, '--selected-bg')
    expect(fill.a, '--selected-bg is opaque').toBe(1)
    for (const text of ['--text', '--text-soft', '--text-muted']) {
      const ratio = contrast(over(colourOf(get, text), fill), fill)
      if (ratio < 4.5) failures.push(`${text} on --selected-bg: ${ratio.toFixed(2)}`)
    }
    for (const surface of SURFACES) {
      const bg = colourOf(get, surface)
      const under = over(colourOf(get, '--selected-tint'), bg)
      // Muted text only just passes on the hover and selected surfaces (4.5:1 bare), so no wash can sit over those
      // with it; the wash is for the page, the panels and the sidebar.
      for (const text of surface === '--bg-hover' || surface === '--bg-selected' || surface === '--bg-raised' ? ['--text', '--text-soft'] : ['--text', '--text-soft', '--text-muted']) {
        const ratio = contrast(over(colourOf(get, text), under), under)
        if (ratio < 4.5) failures.push(`${text} on --selected-tint over ${surface}: ${ratio.toFixed(2)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it.each(MODES)('no state token is the accent ($label)', ({ theme, vision }) => {
    const get = tokensFor(layers, theme, vision)
    for (const name of ['--focus-ring', '--selected-bg', '--selected-border', '--selected-mark', '--selected-tint']) {
      expect(get(name), `${name} is not the accent`).not.toContain(get('--accent'))
    }
  })

  it('places every custom property: base, light theme, or a colour-vision override', () => {
    expect(() => readLayers(':root { --x: #fff } .other { --y: #000 }')).toThrow(/can't place/)
    expect(() => readLayers('@media (min-width: 1px) { :root { --x: #fff } }')).toThrow(/can't place/)
    expect(layers.base.size).toBeGreaterThan(40)
  })

  it('--text-faint is --text-muted', () => {
    for (const { theme, vision } of MODES) {
      const get = tokensFor(layers, theme, vision)
      expect(get('--text-faint')).toBe(get('--text-muted'))
    }
  })
})
