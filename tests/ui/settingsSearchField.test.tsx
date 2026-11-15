// @vitest-environment jsdom
// Settings' search box keeps its text clear of the search icon laid over its start, with the app's stylesheets in the
// app's order: ui/ui.css comes after every feature sheet (main.tsx), so a lone `.set-nav-search-input` lost its padding
// to the input's own, and the icon sat on top of "Search every setting…".
import '../domShims'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TextInput } from '../../src/renderer/src/ui'

// ui/ui.css with its @imports inlined, as the app loads it.
const uiStylesheet = () =>
  readFileSync('src/renderer/src/ui/ui.css', 'utf8').replace(/@import '\.\/(css\/[\w-]+\.css)';/g, (_, file: string) => readFileSync(`src/renderer/src/ui/${file}`, 'utf8'))

// The search box's own rules from settings.css (jsdom's CSS parser gives up on other parts of that file).
const searchRules = () => (readFileSync('src/renderer/src/components/settings/settings.css', 'utf8').match(/^\.set-nav-search[^{]*\{[^}]*\}/gm) ?? []).join('\n')

afterEach(cleanup)

describe('the settings search box', () => {
  it('leaves room for its icon with the app’s stylesheets in the app’s order', () => {
    const sheets = [searchRules(), uiStylesheet()]
    const styles = sheets.map((css) => {
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)
      return style
    })
    try {
      render(
        <div className="set-nav-search">
          <TextInput className="set-nav-search-input" aria-label="Search settings" />
        </div>
      )
      expect(getComputedStyle(screen.getByRole('textbox', { name: 'Search settings' })).paddingLeft).toBe('30px')
    } finally {
      styles.forEach((style) => style.remove())
    }
  })
})
