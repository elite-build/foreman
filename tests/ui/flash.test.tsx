// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingFlashParts } from '../../src/renderer/src/components/settings/flashParts'
import { flash, flashTargets } from '../../src/renderer/src/ui/flash'
import { readCss, ruleBody } from './cssRule'

const ATTR = 'data-ui-flash'

/** jsdom has no layout: give an element the height it would have. */
function tall(el: HTMLElement, height: number): HTMLElement {
  el.getBoundingClientRect = () => ({ height, width: 600, top: 0, left: 0, right: 600, bottom: height, x: 0, y: 0, toJSON: () => ({}) })
  return el
}

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup
  return document.body.firstElementChild as HTMLElement
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('flash', () => {
  it('flashes a short target itself and takes the attribute off after the duration', () => {
    const row = tall(html('<div id="r">row</div>'), 60)
    flash(row)
    expect(row.getAttribute(ATTR)).toBe('on')
    vi.advanceTimersByTime(1399)
    expect(row.hasAttribute(ATTR)).toBe(true)
    vi.advanceTimersByTime(2)
    expect(row.hasAttribute(ATTR)).toBe(false)
  })

  it('keeps a duration of its own, and 1.0 s under Reduce Motion (a static wash needs less)', () => {
    const a = tall(html('<div>a</div>'), 40)
    flash(a, { duration: 1800 })
    vi.advanceTimersByTime(1700)
    expect(a.hasAttribute(ATTR)).toBe(true)
    vi.advanceTimersByTime(200)
    expect(a.hasAttribute(ATTR)).toBe(false)

    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    const b = tall(html('<div>b</div>'), 40)
    flash(b)
    vi.advanceTimersByTime(1001)
    expect(b.hasAttribute(ATTR)).toBe(false)
  })

  it('on a tall target lights its parts and not the target', () => {
    const block = tall(html('<section><h2>Title</h2><p>Description</p><div>rows</div></section>'), 400)
    const [h2, p] = [block.querySelector('h2')!, block.querySelector('p')!]
    flash(block, { parts: () => [h2, p, null] })
    expect(h2.hasAttribute(ATTR)).toBe(true)
    expect(p.hasAttribute(ATTR)).toBe(true)
    expect(block.hasAttribute(ATTR)).toBe(false)
  })

  it('uses a target of 120px or less whole, and falls back to the target when no part is found', () => {
    const edge = tall(html('<div><h2>t</h2></div>'), 120)
    expect(flashTargets(edge, { parts: (t) => [t.querySelector('h2')] })).toEqual([edge])
    const high = tall(html('<div><h2>t</h2></div>'), 121)
    expect(flashTargets(high, { parts: (t) => [t.querySelector('h2')] })).toEqual([high.querySelector('h2')])
    expect(flashTargets(high, { parts: () => [null, undefined] })).toEqual([high])
    expect(flashTargets(high)).toEqual([high])
    expect(flashTargets(high, { parts: (t) => [t.querySelector('h2')], tall: 500 })).toEqual([high])
  })

  it('restarts when the target is already flashing, so the first timer does not cut the second short', () => {
    const el = tall(html('<div>x</div>'), 50)
    flash(el)
    vi.advanceTimersByTime(1000)
    flash(el)
    vi.advanceTimersByTime(1000)
    expect(el.hasAttribute(ATTR)).toBe(true)
    vi.advanceTimersByTime(500)
    expect(el.hasAttribute(ATTR)).toBe(false)
  })

  it('returns a function that ends it early and clears the radius it set', () => {
    const el = tall(html('<div style="border-radius: 10px">x</div>'), 50)
    const stop = flash(el)
    expect(el.style.getPropertyValue('--ui-flash-radius')).not.toBe('')
    stop()
    expect(el.hasAttribute(ATTR)).toBe(false)
    expect(el.style.getPropertyValue('--ui-flash-radius')).toBe('')
  })

  it('leaves a held flash (the screenshot tool) alone', () => {
    const el = tall(html('<div>x</div>'), 50)
    const stop = flash(el)
    el.setAttribute(ATTR, 'hold')
    vi.advanceTimersByTime(5000)
    stop()
    expect(el.getAttribute(ATTR)).toBe('hold')
  })
})

describe('flash.css', () => {
  const css = readCss('flash')

  it('draws a neutral wash outside the target, rounded, behind its content, with no outline', () => {
    const wash = ruleBody(css, '[data-ui-flash]::after') ?? ''
    expect(wash).toMatch(/background:\s*var\(--selected-tint\)/)
    expect(wash).toMatch(/inset:\s*calc\(var\(--ui-flash-gap\) \* -1\)/)
    expect(wash).toMatch(/z-index:\s*-1/)
    expect(wash).toMatch(/border-radius:\s*max\(/)
    expect(wash).not.toMatch(/outline|--accent/)
    expect(css.replace(/@media \(forced-colors: active\)[\s\S]*$/, '')).not.toMatch(/outline|--accent/)
  })

  it('is short, and under Reduce Motion is a static wash instead of an animation', () => {
    expect(ruleBody(css, '[data-ui-flash]::after')).toMatch(/animation:\s*ui-flash 1\.4s/)
    expect(ruleBody(css, "html[data-reduce-motion='on'] [data-ui-flash]::after")).toMatch(/animation:\s*none;\s*opacity:\s*1/)
    expect(ruleBody(css, "[data-ui-flash='hold']::after")).toMatch(/animation:\s*none/)
  })

  it('marks the place with an outline under forced colours, which drop backgrounds', () => {
    expect(css).toMatch(/forced-colors: active\)[\s\S]*Highlight/)
  })
})

describe('settingFlashParts', () => {
  it('a row: its own text block', () => {
    const row = html('<div class="set-row"><div class="set-row-text">T</div><div class="set-control"><div class="set-row-text">other</div></div></div>')
    expect(settingFlashParts(row)).toEqual([row.querySelector(':scope > .set-row-text')])
  })

  it('a block inside a section: the section title and description', () => {
    const section = html('<section class="set-section"><h2>Title</h2><p class="set-section-desc">Desc</p><div id="x"><div class="set-row-text">first row</div></div></section>')
    expect(settingFlashParts(section.querySelector('#x') as HTMLElement)).toEqual([section.querySelector('h2'), section.querySelector('.set-section-desc')])
    expect(settingFlashParts(section)).toEqual([section.querySelector('h2'), section.querySelector('.set-section-desc')])
  })

  it('a section whose title sits in a header row (the model list) still finds it', () => {
    const section = html('<section class="set-section" id="setting-models-claude"><div class="mv-head"><h2>Models</h2><span>12 shown</span></div><p class="set-section-desc">Choose</p><div class="set-card"></div></section>')
    expect(settingFlashParts(section)).toEqual([section.querySelector('h2'), section.querySelector('.set-section-desc')])
  })

  it('a section without a description gives no description, and a bare block gives its first row text', () => {
    const section = html('<section class="set-section"><h2>Title</h2><div id="x"></div></section>')
    expect(settingFlashParts(section.querySelector('#x') as HTMLElement)).toEqual([section.querySelector('h2'), null])
    const bare = html('<div><div class="set-row-text">T</div></div>')
    expect(settingFlashParts(bare)).toEqual([bare.querySelector('.set-row-text')])
  })
})
