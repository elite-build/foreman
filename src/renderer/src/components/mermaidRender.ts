// Turns Mermaid source into a sanitised SVG element (#18). The mermaid package is
// imported the first time a diagram is shown, never at startup. Renders run one at a
// time (Mermaid's config is global), each bounded by MERMAID_RENDER_TIMEOUT_MS, and the
// result is cached per source and theme so remounting a chat doesn't redraw it.
import { MERMAID_RENDER_TIMEOUT_MS, MERMAID_THEME_TOKENS, mermaidConfig, themeKey, type ThemeTokens } from './mermaidSource'

type Mermaid = (typeof import('mermaid'))['default']

export type RenderResult = { ok: true; svg: string } | { ok: false; kind: 'error' | 'timeout' | 'load'; error?: unknown }

let loading: Promise<Mermaid> | null = null
function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  // A failed chunk load can be retried by the next diagram.
  loading.catch(() => (loading = null))
  return loading
}

/** The theme tokens' current values on <html>. */
export function readThemeTokens(): { tokens: ThemeTokens; dark: boolean } {
  const style = getComputedStyle(document.documentElement)
  const tokens: ThemeTokens = {}
  for (const name of MERMAID_THEME_TOKENS) tokens[name] = style.getPropertyValue(name).trim()
  return { tokens, dark: window.matchMedia('(prefers-color-scheme: dark)').matches }
}

const CACHE_SIZE = 40
const cache = new Map<string, RenderResult>()
let queue: Promise<unknown> = Promise.resolve()
let counter = 0

function remember(key: string, result: RenderResult): RenderResult {
  // Timeouts and load failures aren't cached: the next try may be quicker.
  if (result.ok || result.kind === 'error') {
    cache.delete(key)
    cache.set(key, result)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }
  return result
}

export function cachedRender(source: string, theme: string): RenderResult | undefined {
  return cache.get(`${theme}\n${source}`)
}

async function renderNow(source: string, tokens: ThemeTokens, dark: boolean): Promise<RenderResult> {
  let mermaid: Mermaid
  try {
    mermaid = await loadMermaid()
  } catch (error) {
    return { ok: false, kind: 'load', error }
  }
  const id = `foreman-mermaid-${++counter}`
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RenderResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, kind: 'timeout' }), MERMAID_RENDER_TIMEOUT_MS)
  })
  const render = (async (): Promise<RenderResult> => {
    mermaid.initialize(mermaidConfig(tokens, dark))
    const { svg } = await mermaid.render(id, source)
    return { ok: true, svg }
  })().catch((error: unknown): RenderResult => ({ ok: false, kind: 'error', error }))
  try {
    return await Promise.race([render, timeout])
  } finally {
    clearTimeout(timer)
    // Mermaid measures in a scratch element; make sure an abandoned render leaves none behind.
    document.getElementById(`d${id}`)?.remove()
  }
}

/** Render (or reuse) one diagram in the current theme. */
export function renderMermaid(source: string, tokens: ThemeTokens, dark: boolean): Promise<RenderResult> {
  const key = `${themeKey(tokens, dark)}\n${source}`
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const next = queue.then(() => cache.get(key) ?? renderNow(source, tokens, dark).then((result) => remember(key, result)))
  queue = next.catch(() => undefined)
  return next
}

/**
 * Mermaid's SVG as an inert element with anything active removed: scripts, event
 * attributes, and links (unwrapped, so "click … href" can't navigate). Mermaid's strict
 * mode already encodes labels; this is a second line of defence before it enters the page.
 */
export function svgElement(svg: string): SVGSVGElement | null {
  // <template> content is inert: nothing runs or loads while it's cleaned.
  const template = document.createElement('template')
  template.innerHTML = svg
  const root = template.content.querySelector('svg')
  if (!root) return null
  for (const el of root.querySelectorAll('script, iframe, object, embed')) el.remove()
  // A link becomes a plain group: same children and transform, nowhere to go.
  for (const link of root.querySelectorAll('a')) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    for (const attr of link.attributes) if (!/^(xlink:)?href$|^target$/i.test(attr.name)) group.setAttribute(attr.name, attr.value)
    group.append(...link.childNodes)
    link.replaceWith(group)
  }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const href = name === 'href' || name === 'xlink:href' || name === 'src'
      if (name.startsWith('on') || (href && !attr.value.trim().startsWith('#'))) el.removeAttribute(attr.name)
    }
  }
  return root
}
