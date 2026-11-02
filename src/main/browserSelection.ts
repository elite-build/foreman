import type { BrowserBounds, BrowserSelection } from '../shared/browser'

/** Computed styles worth telling an agent about. Defaults (none, normal, auto, 0px, transparent…) are left out. */
export const BROWSER_STYLE_PROPERTIES = ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border', 'border-radius', 'box-shadow', 'gap', 'flex-direction', 'justify-content', 'align-items', 'opacity', 'z-index'] as const
const HTML_MAX = 3000

/** Runs in an isolated Chromium world: page scripts never receive a Foreman bridge. Result is untrusted draft text. */
export const CANCEL_BROWSER_SELECTION = 'globalThis.__foremanSelection?.()'
export const SELECT_BROWSER_ELEMENT = `(() => {
  globalThis.__foremanSelection?.()
  return new Promise(resolve => {
    let marked = null
    let outline = ''
    let offset = ''
    const root = document.documentElement
    const cursor = root.style.cursor
    const restore = () => {
      if (marked) { marked.style.outline = outline; marked.style.outlineOffset = offset; marked = null }
    }
    const done = value => {
      restore()
      root.style.cursor = cursor
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('click', click, true)
      window.removeEventListener('keydown', key, true)
      delete globalThis.__foremanSelection
      if (!value) return resolve(null)
      // Let the page repaint without the highlight before the host captures the element.
      let sent = false
      const send = () => { if (!sent) { sent = true; resolve(value) } }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(send))
      setTimeout(send, 150)
    }
    const highlight = element => {
      restore()
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return
      marked = element
      outline = marked.style.outline
      offset = marked.style.outlineOffset
      marked.style.outline = '2px solid Highlight'
      marked.style.outlineOffset = '2px'
    }
    const move = event => highlight(event.target)
    const pick = el => {
      restore()
      if (!el) return done(null)
      const parts = []
      for (let node = el; node && parts.length < 6; node = node.parentElement) {
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break }
        const tag = node.localName
        const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.localName === tag) : []
        parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''))
      }
      const text = (el instanceof HTMLElement ? el.innerText : el.textContent) || ''
      const html = el.outerHTML || ''
      const computed = getComputedStyle(el)
      const display = computed.getPropertyValue('display')
      const styles = ${JSON.stringify(BROWSER_STYLE_PROPERTIES)}
        .map(name => [name, computed.getPropertyValue(name).trim()])
        .filter(([name, value]) => value && !['none', 'normal', 'auto', '0', '0px', 'rgba(0, 0, 0, 0)', 'static', '1'].includes(value) && (!['flex-direction', 'justify-content', 'align-items', 'gap'].includes(name) || /flex|grid/.test(display)))
      const box = el.getBoundingClientRect()
      // Marks the element for the host's framework lookup in the page's own world, where component data lives.
      const mark = Math.random().toString(36).slice(2)
      el.setAttribute('data-foreman-selected', mark)
      done({
        selector: parts.join(' > ').slice(0, 1000),
        text: text.trim().slice(0, 2000),
        html: html.length > ${HTML_MAX} ? html.slice(0, ${HTML_MAX}) + '\\n…' : html,
        styles,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { width: innerWidth, height: innerHeight },
        mark
      })
    }
    const click = event => {
      event.preventDefault()
      event.stopImmediatePropagation()
      pick(event.target instanceof Element ? event.target : null)
    }
    const key = event => {
      if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') return done(null)
      if (event.key === 'Enter') { if (marked) pick(marked); return }
      const nodes = [...document.querySelectorAll('body *')].filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
      })
      if (!nodes.length) return
      const index = nodes.indexOf(marked)
      const next = nodes[index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length]
      highlight(next)
      next.scrollIntoView?.({ block: 'nearest' })
    }
    globalThis.__foremanSelection = () => done(null)
    root.style.cursor = 'crosshair'
    window.addEventListener('pointermove', move, true)
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', key, true)
  })
})()`

/** Isolated world again: drops the mark whether or not the framework lookup ran. */
export const UNMARK_BROWSER_SELECTION = `document.querySelectorAll('[data-foreman-selected]').forEach(el => el.removeAttribute('data-foreman-selected'))`

/**
 * Runs in the page's main world, the only one that sees React's fiber and Vue's component on the element. Read-only.
 * The page can tamper with anything it returns, so the host treats the result as untrusted and bounds it.
 * React ≤18 records `_debugSource`; React 19 only a `_debugStack`, whose first frame outside the framework is the file
 * the element was written in. That frame's line is in the dev server's transformed code, not the file, so it is dropped.
 * Production builds have neither, and minified component names are dropped.
 */
export function frameworkLookup(mark: string): string {
  return `(() => { try {
  const el = document.querySelector('[data-foreman-selected="' + ${JSON.stringify(mark)} + '"]')
  if (!el) return null
  const named = name => typeof name === 'string' && /^[A-Z][\\w$.]{2,}$/.test(name) ? name : ''
  const nameOf = (type, depth) => {
    if (!type || depth > 3) return ''
    if (typeof type === 'function') return named(type.displayName || type.name)
    if (typeof type === 'object') return named(type.displayName) || nameOf(type.render || type.type, depth + 1)
    return ''
  }
  const frame = stack => {
    for (const line of String(stack).split('\\n').slice(1)) {
      const m = /((?:https?|webpack-internal|file):\\/\\/[^\\s]+?):\\d+:\\d+\\)?\\s*$/.exec(line)
      if (!m || /node_modules|\\/\\.vite\\/|\\/@vite\\/|\\/@react-refresh|\\/_next\\/static\\/|react-dom|jsx-(dev-)?runtime/.test(m[1])) continue
      let file = m[1]
      try { file = /^https?:/.test(file) ? new URL(file).pathname : file.replace(/^[a-z-]+:\\/\\/\\/?(\\([^)]*\\)\\/)?(\\.\\/)?/, '') } catch {}
      return decodeURIComponent(file.replace(/[?#].*$/, '')).replace(/^\\//, '')
    }
    return ''
  }
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  if (fiberKey) {
    const host = el[fiberKey]
    const components = []
    // Nearest first; the host reverses them.
    for (let f = host && host.return; f && components.length < 5; f = f.return) {
      const name = typeof f.type === 'string' ? '' : nameOf(f.type, 0)
      if (name && components[components.length - 1] !== name) components.push(name)
    }
    const s = host && host._debugSource
    const source = s && s.fileName ? s.fileName + (s.lineNumber ? ':' + s.lineNumber : '') : host && host._debugStack ? frame(host._debugStack.stack) : ''
    return { framework: 'React', components, source }
  }
  const vue = el.__vueParentComponent
  if (vue) {
    const components = []
    for (let c = vue; c && components.length < 5; c = c.parent) {
      const name = named(c.type && (c.type.__name || c.type.name))
      if (name) components.push(name)
    }
    return { framework: 'Vue', components, source: (vue.type && vue.type.__file) || '' }
  }
  return null
} catch { return null } })()`
}

type Raw = Record<string, unknown>
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN)

/** The picker's and lookup's untrusted output, bounded and reduced to the fields Foreman uses. */
export function cleanSelection(url: string, picked: unknown, framework: unknown): Omit<BrowserSelection, 'image'> | null {
  if (!picked || typeof picked !== 'object') return null
  const p = picked as Raw
  const allowed = new Set<string>(BROWSER_STYLE_PROPERTIES)
  const styles = (Array.isArray(p.styles) ? p.styles : [])
    .filter((pair): pair is [string, string] => Array.isArray(pair) && allowed.has(pair[0]) && typeof pair[1] === 'string' && Boolean(pair[1]))
    .map(([name, value]) => [name, value.slice(0, 200)] as [string, string])
  const rect = (p.rect ?? {}) as Raw
  const width = Math.round(num(rect.width))
  const height = Math.round(num(rect.height))
  const selection: Omit<BrowserSelection, 'image'> = { url, selector: str(p.selector, 1000), text: str(p.text, 2000), html: str(p.html, 3010), styles }
  if (width > 0 && height > 0) selection.size = { width, height }
  const f = (framework && typeof framework === 'object' ? framework : {}) as Raw
  if (f.framework === 'React' || f.framework === 'Vue') {
    const components = (Array.isArray(f.components) ? f.components : []).filter((c): c is string => typeof c === 'string' && /^[A-Z][\w$.]{2,99}$/.test(c)).slice(0, 5).reverse()
    const source = str(f.source, 500).replace(/[\r\n]/g, '')
    if (components.length) selection.components = components
    if (source) selection.source = source
  }
  return selection
}

/** The element's box in the view's own pixels, padded a little and kept inside the viewport. Null when nothing shows. */
export function elementCrop(picked: unknown, zoom: number): BrowserBounds | null {
  const p = (picked ?? {}) as Raw
  const r = (p.rect ?? {}) as Raw
  const v = (p.viewport ?? {}) as Raw
  const [x, y, width, height, vw, vh] = [r.x, r.y, r.width, r.height, v.width, v.height].map(num)
  if (![x, y, width, height, vw, vh, zoom].every(Number.isFinite) || zoom <= 0 || width <= 0 || height <= 0) return null
  const pad = 8
  const left = Math.max(0, x - pad)
  const top = Math.max(0, y - pad)
  const right = Math.min(vw, x + width + pad)
  const bottom = Math.min(vh, y + height + pad)
  if (right - left < 2 || bottom - top < 2) return null
  return { x: Math.floor(left * zoom), y: Math.floor(top * zoom), width: Math.ceil((right - left) * zoom), height: Math.ceil((bottom - top) * zoom) }
}
