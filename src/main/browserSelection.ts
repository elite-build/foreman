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
      resolve(value)
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
      if (!el) return done(null)
      const parts = []
      for (let node = el; node && parts.length < 6; node = node.parentElement) {
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break }
        const tag = node.localName
        const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.localName === tag) : []
        parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''))
      }
      const text = (el instanceof HTMLElement ? el.innerText : el.textContent) || ''
      done({ selector: parts.join(' > ').slice(0, 1000), text: text.trim().slice(0, 2000) })
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
