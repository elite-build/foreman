// The loadout's one animation (a card popping into its slot) ends under Reduce Motion, and its drag states are the Card's
// own: agents.css keeps only where things sit, not how they look (rule 6 of tests/designSystem.test.ts holds the rest).
import { readFileSync } from 'node:fs'
import postcss, { type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

const css = postcss.parse(readFileSync('src/renderer/src/components/settings/agents.css', 'utf8'))

function rulesFor(selector: string): Rule[] {
  const found: Rule[] = []
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) found.push(rule)
  })
  return found
}

describe('the loadout card', () => {
  it('pops into its slot with an animation that Reduce Motion turns off', () => {
    const [equip] = rulesFor('.ml-card.equip').filter((r) => r.parent?.type === 'root')
    expect(equip.toString()).toMatch(/animation:\s*ml-equip/)
    // Keyed on the resolved setting (html[data-reduce-motion], theme.ts), not on the OS media query.
    const reduced = rulesFor("html[data-reduce-motion='on'] .ml-card.equip")
    expect(reduced).toHaveLength(1)
    expect(reduced[0].toString()).toMatch(/animation:\s*none/)
  })

  it('leaves the drag states to the Card: the lifted, ghost, target and removing looks are not redrawn here', () => {
    const states = ['.ml-card[data-lifted]', '.ml-model[data-lifted]', '.ml-card.ml-ghost', '.ml-model.ml-ghost', '.ml-remove', '.ml-empty']
    for (const selector of states) {
      for (const rule of rulesFor(selector)) {
        rule.walkDecls((d) => expect(d.prop, `${selector} sets ${d.prop}`).not.toMatch(/^(background|border|box-shadow|color|transform)/))
      }
    }
  })
})

describe('the Card ghost', () => {
  it('is not tilted or scaled under Reduce Motion', () => {
    const card = postcss.parse(readFileSync('src/renderer/src/ui/css/card.css', 'utf8'))
    let found = ''
    card.walkRules((rule) => {
      if (rule.selectors.includes("html[data-reduce-motion='on'] .ui-card[data-ghost]")) found += rule.toString()
    })
    expect(found).toMatch(/transform:\s*none/)
  })
})
