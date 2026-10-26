// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { CANCEL_BROWSER_SELECTION, SELECT_BROWSER_ELEMENT } from '../src/main/browserSelection'

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
  expect(await selected).toEqual({ selector: '#buy', text: 'Buy' })
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
  expect(await selected).toEqual({ selector: '#content', text: 'Details' })
})
