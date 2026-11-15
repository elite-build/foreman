// Layout jsdom can't measure, pinned as the rules that make it: how a wrapped diff line breaks and hangs, and the Views
// table in Settings keeping its column names over their switches.
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

function declarations(file: string, selector: string): Record<string, string> {
  const found: Record<string, string> = {}
  postcss.parse(readFileSync(`src/renderer/src/${file}`, 'utf8')).walkRules((rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls((d) => void (found[d.prop] = d.value))
  })
  return found
}

describe('a wrapped diff line', () => {
  const code = declarations('styles/file-diff.css', '.hunk .code')

  it('breaks at spaces, and splits a word only when it alone is wider than the line', () => {
    // break-all split identifiers anywhere ("creden/tials") even where a space was close by.
    expect(code['word-break']).toBeUndefined()
    expect(code['overflow-wrap']).toBe('anywhere')
    expect(code['white-space']).toBe('pre-wrap')
  })

  it('hangs its continuation 2 columns deeper than its own indent (--lead, set on each cell), past the sign', () => {
    expect(code['--hang']).toContain('var(--lead, 0)')
    expect(code['--hang']).toContain('+ 2)')
    expect(code['padding-left']).toContain('var(--hang)')
    expect(code['text-indent']).toBe('calc(-1 * var(--hang))')
  })
})

describe('Settings → Views', () => {
  it('lays every row on one set of columns, so the header’s names sit over the switches', () => {
    // Each row was its own grid with an auto last column: empty in the header, two buttons wide below it.
    expect(declarations('components/settings/settings.css', '.set-views').display).toBe('grid')
    expect(declarations('components/settings/settings.css', '.set-views.three')['grid-template-columns']).toMatch(/repeat\(3, 96px\)/)
    const row = declarations('components/settings/settings.css', '.set-views-row')
    expect(row['grid-template-columns']).toBe('subgrid')
    expect(row['grid-column']).toBe('1 / -1')
  })
})
