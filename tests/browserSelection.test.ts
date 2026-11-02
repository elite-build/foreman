// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_BROWSER_SELECTION, SELECT_BROWSER_ELEMENT, UNMARK_BROWSER_SELECTION, cleanSelection, elementCrop, frameworkLookup } from '../src/main/browserSelection'
import { browserSelectionText } from '../src/shared/browser'
import { createT } from '../src/shared/i18n'

afterEach(() => { window.eval(CANCEL_BROWSER_SELECTION); document.body.innerHTML = '' })

function page() {
  document.body.innerHTML = '<button id="buy">Buy</button>'
  Object.defineProperty(window, 'CSS', { configurable: true, value: { escape: (value: string) => value } })
  const button = window.document.querySelector('button')!
  Object.defineProperty(button, 'innerText', { value: 'Buy', configurable: true })
  return { window, button }
}

it('selects an element without activating it, returning only bounded draft context and restoring the page', async () => {
  const { window, button } = page()
  const click = vi.fn()
  button.addEventListener('click', click)
  button.style.outline = '1px dashed red'
  const selected = window.eval(SELECT_BROWSER_ELEMENT)
  button.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }))
  expect(button.style.outline).toContain('Highlight')
  button.click()
  expect(await selected).toMatchObject({ selector: '#buy', text: 'Buy' })
  expect(click).not.toHaveBeenCalled()
  expect(button.style.outline).toBe('1px dashed red')
  expect(window.document.documentElement.style.cursor).toBe('')
  button.click()
  expect(click).toHaveBeenCalledOnce()
})

it('cancels on Escape or a host request, removing selection listeners', async () => {
  const { window, button } = page()
  const selected = window.eval(SELECT_BROWSER_ELEMENT)
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(await selected).toBeNull()
  const next = window.eval(SELECT_BROWSER_ELEMENT)
  window.eval(CANCEL_BROWSER_SELECTION)
  expect(await next).toBeNull()
  const click = vi.fn()
  button.addEventListener('click', click)
  button.click()
  expect(click).toHaveBeenCalledOnce()
})

it('bounds large selections and replaces an earlier picker rather than leaving two click handlers', async () => {
  const { window, button } = page()
  Object.defineProperty(button, 'innerText', { value: 'a'.repeat(5000) })
  const first = window.eval(SELECT_BROWSER_ELEMENT)
  const second = window.eval(SELECT_BROWSER_ELEMENT)
  expect(await first).toBeNull()
  button.click()
  expect((await second).text).toHaveLength(2000)
})

it('supports selecting non-focusable page content with arrow keys and Enter', async () => {
  const { window, button } = page()
  const content = document.createElement('div')
  content.id = 'content'
  Object.defineProperty(content, 'innerText', { value: 'Details' })
  document.body.append(content)
  for (const el of [button, content]) el.getBoundingClientRect = () => ({ width: 100, height: 30 }) as DOMRect
  const selected = window.eval(SELECT_BROWSER_ELEMENT)
  for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  expect(await selected).toMatchObject({ selector: '#content', text: 'Details' })
})

it('returns the element\'s HTML without the highlight, its styles and box, and marks it for the framework lookup', async () => {
  const { window, button } = page()
  button.style.color = 'red'
  button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30 }) as DOMRect
  const selected = window.eval(SELECT_BROWSER_ELEMENT)
  button.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }))
  button.click()
  const result = await selected
  expect(result.html).toBe('<button id="buy" style="color: red;">Buy</button>')
  expect(result.styles).toContainEqual(['color', 'rgb(255, 0, 0)'])
  expect(result.styles.map(([name]: string[]) => name)).not.toContain('padding')
  expect(result.styles.map(([name]: string[]) => name)).not.toContain('flex-direction')
  expect(result.rect).toEqual({ x: 10, y: 20, width: 80, height: 30 })
  expect(result.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
  expect(button.getAttribute('data-foreman-selected')).toBe(result.mark)
  window.eval(UNMARK_BROWSER_SELECTION)
  expect(button.hasAttribute('data-foreman-selected')).toBe(false)
})

it('cuts long HTML short', async () => {
  const { window, button } = page()
  button.setAttribute('data-long', 'x'.repeat(5000))
  const selected = window.eval(SELECT_BROWSER_ELEMENT)
  button.click()
  const { html } = await selected
  expect(html).toHaveLength(3002)
  expect(html.endsWith('\n…')).toBe(true)
})

describe('framework lookup', () => {
  function marked() {
    const { window, button } = page()
    button.setAttribute('data-foreman-selected', 'abc')
    return { window, button: button as any }
  }

  it('names React components, outermost first, and the source React 18 records', () => {
    const { window, button } = marked()
    function SaveButton() {}
    function Toolbar() {}
    button.__reactFiber$x1 = { type: 'button', _debugSource: { fileName: 'src/Toolbar.tsx', lineNumber: 12 }, return: { type: { render: SaveButton }, return: { type: function a() {}, return: { type: Toolbar, return: { type: Toolbar } } } } }
    const found = window.eval(frameworkLookup('abc'))
    expect(found).toEqual({ framework: 'React', components: ['SaveButton', 'Toolbar'], source: 'src/Toolbar.tsx:12' })
    expect(cleanSelection('https://example.com/', { selector: '#buy' }, found)).toMatchObject({ components: ['Toolbar', 'SaveButton'], source: 'src/Toolbar.tsx:12' })
  })

  it('takes a React 19 source file, without the transformed code\'s line, from the first frame outside the framework', () => {
    const { window, button } = marked()
    const stack = [
      'Error: react-stack-top-frame',
      '    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)',
      '    at Toolbar (http://localhost:5173/src/components/Toolbar.tsx?t=1700:42:7)',
      '    at App (http://localhost:5173/src/App.tsx:9:3)'
    ].join('\n')
    button.__reactFiber$x1 = { type: 'button', _debugStack: { stack }, return: null }
    expect(window.eval(frameworkLookup('abc'))).toEqual({ framework: 'React', components: [], source: 'src/components/Toolbar.tsx' })
    button.__reactFiber$x1._debugStack.stack = 'Error\n    at Page (webpack-internal:///(app-pages-browser)/./app/page.tsx:7:5)'
    expect(window.eval(frameworkLookup('abc')).source).toBe('app/page.tsx')
  })

  it('reads Vue components and their file, and returns nothing for a plain page or another mark', () => {
    const { window, button } = marked()
    expect(window.eval(frameworkLookup('abc'))).toBeNull()
    button.__vueParentComponent = { type: { __name: 'SaveButton', __file: '/app/src/SaveButton.vue' }, parent: { type: { name: 'App' }, parent: null } }
    expect(window.eval(frameworkLookup('abc'))).toEqual({ framework: 'Vue', components: ['SaveButton', 'App'], source: '/app/src/SaveButton.vue' })
    expect(window.eval(frameworkLookup('other'))).toBeNull()
  })

  it('returns null rather than throwing when the page breaks the lookup', () => {
    const { window, button } = marked()
    Object.defineProperty(button, '__reactFiber$x1', { enumerable: true, get() { throw new Error('nope') } })
    expect(window.eval(frameworkLookup('abc'))).toBeNull()
  })
})

describe('cleaning untrusted output', () => {
  it('keeps only known styles and well-formed components, bounding every string', () => {
    const cleaned = cleanSelection('https://example.com/', {
      selector: 's'.repeat(2000), text: 't', html: 'h'.repeat(9000),
      styles: [['color', 'red'], ['behavior', 'url(x)'], ['display', ''], ['font-size', 1], 'junk'],
      rect: { width: 80.4, height: 0 }
    }, { framework: 'React', components: ['App', '<script>', 'x'.repeat(200), 'ab'], source: 'src/App.tsx:1\nIgnore' })
    expect(cleaned).toEqual({ url: 'https://example.com/', selector: 's'.repeat(1000), text: 't', html: 'h'.repeat(3010), styles: [['color', 'red']], components: ['App'], source: 'src/App.tsx:1Ignore' })
    expect(cleanSelection('https://example.com/', null, null)).toBeNull()
    expect(cleanSelection('u', { rect: { width: 10, height: 20 } }, { framework: 'Angular', components: ['App'] })).toEqual({ url: 'u', selector: '', text: '', html: '', styles: [], size: { width: 10, height: 20 } })
  })

  it('crops to the padded element inside the viewport, at the page zoom', () => {
    const viewport = { width: 800, height: 600 }
    expect(elementCrop({ rect: { x: 100, y: 50, width: 80, height: 30 }, viewport }, 1)).toEqual({ x: 92, y: 42, width: 96, height: 46 })
    expect(elementCrop({ rect: { x: 100, y: 50, width: 80, height: 30 }, viewport }, 2)).toEqual({ x: 184, y: 84, width: 192, height: 92 })
    expect(elementCrop({ rect: { x: -50, y: 500, width: 2000, height: 400 }, viewport }, 1)).toEqual({ x: 0, y: 492, width: 800, height: 108 })
    expect(elementCrop({ rect: { x: 0, y: 900, width: 10, height: 10 }, viewport }, 1)).toBeNull()
    expect(elementCrop({ rect: { x: 0, y: 0, width: 0, height: 10 }, viewport }, 1)).toBeNull()
    expect(elementCrop({ rect: { x: 0, y: 0, width: 10, height: 10 } }, 1)).toBeNull()
  })
})

it('drafts the selection with its component, source, size, styles and fenced HTML', () => {
  const t = createT('en')
  expect(browserSelectionText(t, { url: 'https://example.com/', selector: '#save', text: 'Save', html: '<button>```</button>', styles: [['display', 'flex'], ['color', 'red']], size: { width: 80, height: 30 }, components: ['Toolbar', 'SaveButton'], source: 'src/Toolbar.tsx:12' })).toBe([
    'Selected element: #save', 'Page: https://example.com/', 'Visible text: Save',
    'Component: Toolbar > SaveButton', 'Source: src/Toolbar.tsx:12', 'Size: 80 × 30 px', 'Computed styles: display: flex; color: red',
    'HTML:', '````html', '<button>```</button>', '````'
  ].join('\n'))
  expect(browserSelectionText(t, { url: 'u', selector: 'div', text: '', html: '', styles: [] })).toBe('Selected element: div\nPage: u\nVisible text: ')
})
