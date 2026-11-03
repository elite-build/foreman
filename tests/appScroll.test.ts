// The window itself never scrolls. Layout can't be measured in jsdom, so the two rules that keep it so are pinned here.
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

function declarations(file: string, selector: string): Record<string, string> {
  const found: Record<string, string> = {}
  postcss.parse(readFileSync(`src/renderer/src/styles/${file}`, 'utf8')).walkRules((rule) => {
    if (rule.parent?.type === 'root' && rule.selectors.includes(selector)) rule.walkDecls((d) => void (found[d.prop] = d.value))
  })
  return found
}

describe('the app layout', () => {
  it('clips the app, so overflow inside it cannot make the window scrollable', () => {
    // hidden would still let scrollIntoView and focus scroll it, sliding the sidebar and headers under the title bar.
    expect(declarations('layout.css', '.app').overflow).toBe('clip')
  })

  it('positions the chat log, so its turns’ hidden headings stay inside it rather than hanging below the window', () => {
    expect(declarations('base.css', '.sr-only').position).toBe('absolute')
    const log = declarations('chat.css', '.chat-scroll')
    expect(log['overflow-y']).toBe('auto')
    expect(log.position).toBe('relative')
  })
})
