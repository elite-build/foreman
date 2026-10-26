import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCss, ruleBody } from './cssRule'

// The accent is ~10 delta-E from --red, so a state drawn in it (selected, checked, current, focused) read as an error.
// States use the neutral --selected-* tokens and focus uses --focus-ring (blue); the accent stays for brand and emphasis.
// These pin the stylesheets so a state can't slip back onto it.

const sheets = readdirSync('src/renderer/src/ui/css')
  .filter((f) => f.endsWith('.css'))
  .map((f) => f.replace(/\.css$/, ''))

describe('ui/ states are neutral, focus is blue', () => {
  it('no ui/ stylesheet draws a focus ring or a selected, checked or current state in the accent', () => {
    const offenders: string[] = []
    for (const name of sheets) {
      const css = readCss(name)
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selector = m[1].trim()
        if (!/--accent\b|accent-color:\s*var\(--accent\)/.test(m[2])) continue
        if (/focus|selected|checked|current|pressed|expanded|\[data-target|\[data-drop/.test(selector)) offenders.push(`${name}.css: ${selector}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every focus ring is --focus-ring', () => {
    for (const name of sheets) expect(readCss(name), `${name}.css`).not.toMatch(/outline:\s*\d+px solid var\(--(accent|red|blue)\)/)
  })

  it('the switch, tab underline, menu and listbox marks, and the radio card check use the selected mark', () => {
    expect(ruleBody(readCss('switch'), ".ui-switch[aria-checked='true'] .ui-switch__track")).toMatch(/background:\s*var\(--selected-mark\)/)
    expect(ruleBody(readCss('switch'), ".ui-switch[aria-checked='true'] .ui-switch__knob")).toMatch(/background:\s*var\(--on-selected-mark\)/)
    expect(ruleBody(readCss('tabs'), ".ui-tabs--underline .ui-tab__button[aria-selected='true']")).toMatch(/border-bottom-color:\s*var\(--selected-mark\)/)
    expect(ruleBody(readCss('menu'), '.ui-menu__check')).toMatch(/color:\s*var\(--selected-mark\)/)
    expect(ruleBody(readCss('listbox'), '.ui-option__check')).toMatch(/color:\s*var\(--selected-mark\)/)
    const cards = readCss('radio-cards')
    expect(ruleBody(cards, '.ui-radio-card[data-selected]')).toMatch(/border-color:\s*var\(--selected-border\)[\s\S]*background:\s*var\(--selected-bg\)/)
    expect(ruleBody(cards, '.ui-radio-card[data-selected] .ui-radio-card__check')).toMatch(/background:\s*var\(--selected-mark\)[\s\S]*color:\s*var\(--on-selected-mark\)/)
  })

  it('a selected or pending ActionRow uses the selected fill and edge', () => {
    const css = readCss('action-row')
    expect(ruleBody(css, '.ui-action-row[data-selected]')).toMatch(/background:\s*var\(--selected-bg\)/)
    expect(ruleBody(css, '.ui-action-row[data-pending]')).toMatch(/var\(--selected-border\)/)
  })
})
