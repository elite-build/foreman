import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ruleBody } from './cssRule'

// The accent (--accent, a coral) is ~10 delta-E from --red, so anything drawn in it reads as an error. Yatin's rule:
// coral is for BRAND only (the logo and brand icons, the Automations bolt, the Assistant sparkle, agent icons, the DEFAULT
// tag and slot label, the tour spotlight). Selection, focus, state, search matches, links, paths, panels and charts
// are neutral or blue. This lists every remaining use of the accent in src/renderer/src and fails when a new one appears
// outside the allowlist, so coral can't creep back. A new brand use goes on the list, with its reason.

const ROOT = 'src/renderer/src'

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name).replace(/\\/g, '/')]))
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

// What counts as "a use": the token (--accent, --accent-bg, in var() or declared), either theme's literal, a Tag in the accent tone, or
// the coral the code keywords used to be (#e98a6e dark, #b8452a light), so syntax colours stay off the error hue.
const USE = /--accent\b|#f08b74|#a0402b|#e98a6e|#b8452a|tone=(?:"accent"|\{[^}]*'accent'[^}]*\})/gi

type Brand = { uses: number; why: string }
const tag = (why: string): Brand => ({ uses: 1, why: `accent Tag: ${why}` })

// File -> how many uses, and why each is brand.
const BRAND: Record<string, Brand> = {
  'ui/tokens.css': { uses: 8, why: 'the definitions: --accent (and its literal) and --accent-bg in the dark and light themes (--accent-border is gone: nothing needs a coral edge)' },
  'ui/css/tag.css': { uses: 3, why: '.ui-tag--accent (selector, tint and text): the accent Tag, a brand-coloured label' },
  'ui/gallery/2a.tsx': { uses: 1, why: 'the Tag gallery shows the accent tone' },
  'components/assistant/assistant.css': { uses: 2, why: 'the Assistant sparkle (title and gate icon)' },
  'components/automations/automations.css': { uses: 2, why: 'the Automations bolt (sidebar entry and view title)' },
  'components/settings/agents.css': { uses: 3, why: 'the Claude agent icon (1) and the DEFAULT slot label on a model card (2)' },
  'styles/agent-picker.css': { uses: 1, why: 'the agent icon in the composer picker' },
  'components/tour.css': { uses: 1, why: 'the tour spotlight ring' },
  'components/settings/integrations/ConnectionsTab.tsx': tag('DEFAULT'),
  'components/settings/integrations/SandboxServiceCard.tsx': tag('DEFAULT'),
  'components/settings/integrations/VercelCard.tsx': tag('DEFAULT'),
  'components/settings/OpenInSettings.tsx': tag('DEFAULT'),
  'components/settings/RepoGitTab.tsx': tag('DEFAULT on the default branch'),
  'components/settings/RepoScriptsTab.tsx': tag('DEFAULT')
}

describe('coral is for brand only', () => {
  const found: Record<string, number> = {}
  for (const file of walk(ROOT).filter((f) => /\.(css|ts|tsx)$/.test(f))) {
    const n = (strip(readFileSync(file, 'utf8')).match(USE) ?? []).length
    if (n) found[file.slice(ROOT.length + 1)] = n
  }

  it('every use of the accent is on the brand allowlist, and no more than listed', () => {
    const unlisted = Object.entries(found).filter(([f]) => !BRAND[f]).map(([f, n]) => `${f}: ${n} use(s) of the accent`)
    const over = Object.entries(found).filter(([f, n]) => BRAND[f] && n > BRAND[f].uses).map(([f, n]) => `${f}: ${n} uses, ${BRAND[f].uses} allowed (${BRAND[f].why})`)
    expect([...unlisted, ...over], 'coral reads as an error: use a neutral token (--selected-*, --border-control, --text-*) or --blue; see "Tokens" in docs/design-system.md').toEqual([])
  })

  it('the allowlist has no stale entries', () => {
    const stale = Object.entries(BRAND).filter(([f, b]) => (found[f] ?? 0) !== b.uses).map(([f, b]) => `${f}: lists ${b.uses}, found ${found[f] ?? 0}`)
    expect(stale).toEqual([])
  })

  it('every entry says why it is brand', () => {
    for (const [file, b] of Object.entries(BRAND)) expect(b.why.length, file).toBeGreaterThan(8)
  })
})

describe('what replaced the coral', () => {
  const read = (path: string) => strip(readFileSync(`${ROOT}/${path}`, 'utf8'))

  it('a link (<a href>) is blue and underlined, visited or not', () => {
    const body = ruleBody(read('styles/base.css').replace(/\r/g, ''), 'a[href],\na[href]:visited')
    expect(body, 'base.css has an a[href] link rule').toBeDefined()
    expect(body).toMatch(/color:\s*var\(--blue\)/)
    expect(body).toMatch(/text-decoration:\s*underline/)
    expect(body).not.toMatch(/--accent/)
  })

  it('an underline LinkButton is blue with an underline that is always drawn', () => {
    const css = read('ui/css/link-button.css')
    expect(ruleBody(css, '.ui-link-btn--underline:not(.ui-link-btn--danger)')).toMatch(/color:\s*var\(--blue\)/)
    expect(ruleBody(css, '.ui-link-btn--underline')).toMatch(/text-decoration:\s*underline/)
  })

  it('a path chip looks like inline code: neutral text on the raised surface', () => {
    const css = read('styles/chat.css')
    const chip = ruleBody(css, '.file-chip')
    expect(chip).toMatch(/color:\s*var\(--text\)/)
    expect(chip).toMatch(/background:\s*var\(--bg-raised\)/)
    expect(ruleBody(css, '.markdown :not(pre) > code')).toMatch(/background:\s*var\(--bg-raised\)/)
  })

  it('Plan mode is a pressed neutral chip, plan and approval panels have neutral edges', () => {
    const composer = readFileSync(`${ROOT}/components/composer/Composer.tsx`, 'utf8')
    expect(composer).not.toMatch(/tone=\{session\.planMode/)
    expect(composer).toMatch(/pressed=\{Boolean\(session\.planMode\)\}/)
    const extras = read('styles/composer-extras.css')
    for (const selector of ['.composer-box.plan', '.plan-bar', '.plan-card']) expect(ruleBody(extras, selector), selector).toMatch(/border(-color)?:[^;]*var\(--selected-border\)/)
    expect(ruleBody(read('styles/approval-panels.css'), '.approval-panel')).toMatch(/var\(--selected-border\)/)
  })

  it('a merged pull request is blue, not coral', () => {
    expect(ruleBody(read('components/attention.css'), '.pr-glyph.merged')).toMatch(/var\(--blue\)/)
    expect(ruleBody(read('styles/git-panel.css'), '.merged')).toMatch(/var\(--blue\)/)
    expect(ruleBody(read('styles/git-panel.css'), '.panel-status.purple')).toMatch(/var\(--blue\)/)
  })

  it('search matches are a neutral tint or weight', () => {
    expect(read('styles/workspace/search-chats.css')).toMatch(/\.chat-hit-text mark \{[^}]*var\(--selected-tint\)/)
    expect(ruleBody(read('ui/css/listbox.css'), '.ui-option__label mark')).toMatch(/color:\s*var\(--text\)[\s\S]*font-weight:\s*600/)
  })

  it('a Mermaid diagram does not use the accent', () => {
    expect(read('components/mermaidSource.ts')).not.toMatch(/--accent|f08b74|a0402b/)
  })

  it('a planned automation block has a neutral stripe', () => {
    expect(ruleBody(read('ui/css/card.css'), ".ui-card[data-stripe='neutral']")).toMatch(/var\(--border-control\)/)
  })
})
