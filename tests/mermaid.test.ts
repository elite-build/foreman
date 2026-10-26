import type { Element, Root } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  checkMermaidSource,
  isFenceClosed,
  isMermaidClass,
  isPlainColor,
  MERMAID_ERROR_MAX_CHARS,
  MERMAID_ERROR_MAX_LINES,
  MERMAID_MAX_CHARS,
  MERMAID_RENDER_TIMEOUT_MS,
  MERMAID_THEME_TOKENS,
  mermaidConfig,
  mermaidErrorDetail,
  mermaidThemeVariables,
  rehypeMermaidFences,
  themeKey,
  type ThemeTokens
} from '../src/renderer/src/components/mermaidSource'
import { createT } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'

/** isFenceClosed for the first fence in `md`, running to the end of the text (as a parser reports it). */
function closedAt(md: string, fenceStart = md.search(/(`{3,}|~{3,})/)): boolean {
  const lines = md.slice(fenceStart).split('\n')
  const opener = /^(`{3,}|~{3,})/.exec(lines[0])![1]
  // A closed block ends at its closing fence; an open one at the end of the document.
  let end = md.length
  let offset = fenceStart + lines[0].length + 1
  for (const line of lines.slice(1)) {
    const fence = /^\s*(?:>\s*)*(`{3,}|~{3,})\s*$/.exec(line)?.[1]
    if (fence && fence[0] === opener[0] && fence.length >= opener.length) {
      end = offset + line.length
      break
    }
    offset += line.length + 1
  }
  return isFenceClosed(md, fenceStart, end)
}

describe('mermaid: fence detection', () => {
  it('recognises language-mermaid in a class string or hast class list', () => {
    expect(isMermaidClass('language-mermaid')).toBe(true)
    expect(isMermaidClass(['hljs', 'language-mermaid'])).toBe(true)
    expect(isMermaidClass('hljs language-mermaid')).toBe(true)
    expect(isMermaidClass('hljs,language-mermaid')).toBe(true)
  })

  it('ignores other languages and look-alikes', () => {
    expect(isMermaidClass('language-ts')).toBe(false)
    expect(isMermaidClass('language-mermaidx')).toBe(false)
    expect(isMermaidClass('xlanguage-mermaid')).toBe(false)
    expect(isMermaidClass(undefined)).toBe(false)
    expect(isMermaidClass([])).toBe(false)
  })
})

describe('mermaid: open vs closed fence', () => {
  it('a block with its closing fence is closed', () => {
    expect(closedAt('Here:\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nDone.')).toBe(true)
    expect(closedAt('```mermaid\ngraph TD\n```')).toBe(true)
  })

  it('a block still streaming (no closing fence) is open', () => {
    expect(closedAt('Here:\n\n```mermaid\ngraph TD\n  A --> B')).toBe(false)
    expect(closedAt('```mermaid\ngraph TD\n  A --> B\n')).toBe(false)
    // Only the opener so far.
    expect(closedAt('```mermaid')).toBe(false)
    expect(closedAt('```mermaid\n')).toBe(false)
  })

  it('a half-typed closing fence is still open', () => {
    expect(closedAt('```mermaid\ngraph TD\n``')).toBe(false)
  })

  it('the closer must match the opener’s character and be at least as long', () => {
    const whole = (md: string) => isFenceClosed(md, 0, md.length)
    expect(whole('````mermaid\ngraph TD\n```')).toBe(false)
    expect(whole('````mermaid\ngraph TD\n`````')).toBe(true)
    expect(whole('~~~mermaid\ngraph TD\n```')).toBe(false)
    expect(closedAt('~~~mermaid\ngraph TD\n~~~\n')).toBe(true)
  })

  it('handles CRLF, trailing spaces and blockquote markers', () => {
    expect(closedAt('```mermaid\r\ngraph TD\r\n```\r\n')).toBe(true)
    expect(closedAt('```mermaid\ngraph TD\n```   ')).toBe(true)
    expect(closedAt('> ```mermaid\n> graph TD\n> ```', 2)).toBe(true)
    expect(closedAt('> ```mermaid\n> graph TD', 2)).toBe(false)
  })

  it('code that merely contains backticks isn’t a closer', () => {
    expect(closedAt('```mermaid\ngraph TD\n  A["```x"]')).toBe(false)
  })
})

describe('mermaid: rehype plugin marks blocks open or closed', () => {
  const pre = (className: string[], start: number, end: number): Element => ({
    type: 'element',
    tagName: 'pre',
    properties: {},
    position: { start: { line: 1, column: 1, offset: start }, end: { line: 1, column: 1, offset: end } },
    children: [{ type: 'element', tagName: 'code', properties: { className }, children: [{ type: 'text', value: 'graph TD' }] }]
  })

  it('sets data-mermaid from the source text, and leaves other code alone', () => {
    const md = '```mermaid\ngraph TD\n```\n\n```ts\nx\n```\n\n```mermaid\ngraph TD'
    const tsAt = md.indexOf('```ts')
    const openAt = md.lastIndexOf('```mermaid')
    const closed = pre(['language-mermaid'], 0, md.indexOf('\n\n'))
    const ts = pre(['language-ts'], tsAt, md.indexOf('\n\n', tsAt))
    const open = pre(['language-mermaid'], openAt, md.length)
    const tree: Root = { type: 'root', children: [closed, { type: 'element', tagName: 'div', properties: {}, children: [ts, open] }] }
    rehypeMermaidFences()(tree, { value: md })
    expect(closed.properties.dataMermaid).toBe('closed')
    expect(open.properties.dataMermaid).toBe('open')
    expect(ts.properties.dataMermaid).toBeUndefined()
  })

  it('a block without a position counts as closed', () => {
    const block = pre(['language-mermaid'], 0, 0)
    delete block.position
    rehypeMermaidFences()({ type: 'root', children: [block] }, { value: '' })
    expect(block.properties.dataMermaid).toBe('closed')
  })
})

describe('mermaid: limits', () => {
  it('renders ordinary sources', () => {
    expect(checkMermaidSource('graph TD\n  A --> B')).toEqual({ ok: true })
    expect(checkMermaidSource('x'.repeat(MERMAID_MAX_CHARS))).toEqual({ ok: true })
  })

  it('refuses empty and oversized sources, saying how big', () => {
    expect(checkMermaidSource('  \n ')).toEqual({ ok: false, reason: 'empty' })
    expect(checkMermaidSource('x'.repeat(MERMAID_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'tooBig', chars: MERMAID_MAX_CHARS + 1 })
    expect(checkMermaidSource('graph TD', 4)).toEqual({ ok: false, reason: 'tooBig', chars: 8 })
  })

  it('limits are sensible constants', () => {
    expect(MERMAID_MAX_CHARS).toBeGreaterThanOrEqual(5_000)
    expect(MERMAID_MAX_CHARS).toBeLessThanOrEqual(50_000)
    expect(MERMAID_RENDER_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
    expect(MERMAID_RENDER_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('trims Mermaid’s error text to a few lines', () => {
    const parse = new Error('Parse error on line 6:\n...archived -->> history\n-----------------------^\nExpecting \'-->\', got \'INVALID\'')
    expect(mermaidErrorDetail(parse)).toBe(parse.message)
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const detail = mermaidErrorDetail(long)
    expect(detail.split('\n')).toHaveLength(MERMAID_ERROR_MAX_LINES + 1)
    expect(detail.endsWith('…')).toBe(true)
    expect(mermaidErrorDetail('x'.repeat(5000)).length).toBe(MERMAID_ERROR_MAX_CHARS)
    expect(mermaidErrorDetail({ message: 'No diagram type detected' })).toBe('No diagram type detected')
    expect(mermaidErrorDetail('a\r\n\r\n  \nb')).toBe('a\nb')
  })
})

describe('mermaid: theme mapping', () => {
  const dark: ThemeTokens = {
    '--code-bg': '#161311',
    '--bg-panel': '#131110',
    '--bg-raised': '#1d1917',
    '--bg-hover': '#241f1c',
    '--border': '#272220',
    '--border-strong': '#37302c',
    '--text': '#ede8e4',
    '--text-soft': '#cfc7c2',
    '--text-muted': '#948a85',
    '--text-faint': '#6b625e',
    '--red': '#ee7a72',
    '--del-bg': 'rgba(238, 122, 114, 0.09)',
    '--font': "'Geist Variable', system-ui, sans-serif"
  }

  it('draws nodes, lines, labels and frames with Foreman’s tokens', () => {
    const vars = mermaidThemeVariables(dark, true)
    expect(vars.darkMode).toBe(true)
    expect(vars.background).toBe('#161311')
    expect(vars.primaryColor).toBe('#1d1917')
    expect(vars.actorBkg).toBe('#1d1917')
    expect(vars.primaryBorderColor).toBe('#37302c')
    expect(vars.primaryTextColor).toBe('#ede8e4')
    expect(vars.lineColor).toBe('#948a85')
    expect(vars.signalTextColor).toBe('#cfc7c2')
    // Frames are neutral: the coral accent reads as an error.
    expect(vars.labelBoxBkgColor).toBe('#241f1c')
    expect(vars.labelBoxBorderColor).toBe('#37302c')
    expect(vars.labelTextColor).toBe('#cfc7c2')
    expect(vars.fontFamily).toBe("'Geist Variable', system-ui, sans-serif")
  })

  it('follows light mode and the code background', () => {
    const vars = mermaidThemeVariables({ ...dark, '--code-bg': '#eff1f5', '--text': '#1d1916' }, false)
    expect(vars.darkMode).toBe(false)
    expect(vars.background).toBe('#eff1f5')
    expect(vars.textColor).toBe('#1d1916')
  })

  it('falls back to Foreman’s defaults for missing or unparseable tokens', () => {
    const light = mermaidThemeVariables({ '--code-bg': 'var(--bg-input)', '--text-soft': 'color-mix(in srgb, red 5%, blue)' }, false)
    expect(light.background).toBe('#ffffff')
    expect(light.labelTextColor).toBe('#39322e')
    expect(light.primaryTextColor).toBe('#1d1916')
    const none = mermaidThemeVariables({}, true)
    expect(none.background).toBe('#161311')
    expect(String(none.fontFamily)).toContain('sans-serif')
    // Every colour handed to Mermaid is one it can parse.
    for (const [name, value] of Object.entries(none)) if (/Color|Bkg|Border|background/.test(name)) expect(isPlainColor(String(value)), name).toBe(true)
  })

  it('recognises plain colours only', () => {
    expect(isPlainColor('#abc')).toBe(true)
    expect(isPlainColor('#aabbccdd')).toBe(true)
    expect(isPlainColor('rgb(1, 2, 3)')).toBe(true)
    expect(isPlainColor('rgba(1 2 3 / 50%)')).toBe(true)
    expect(isPlainColor('var(--x)')).toBe(false)
    expect(isPlainColor('red; background: url(x)')).toBe(false)
    expect(isPlainColor('')).toBe(false)
  })

  it('the theme key changes with light/dark and with any token', () => {
    expect(themeKey(dark, true)).toBe(themeKey({ ...dark }, true))
    expect(themeKey(dark, true)).not.toBe(themeKey(dark, false))
    expect(themeKey(dark, true)).not.toBe(themeKey({ ...dark, '--text': '#fff' }, true))
    expect(themeKey(dark, true).split('|')).toHaveLength(MERMAID_THEME_TOKENS.length + 1)
  })

  it('config is strict, text-only, bounded and themed', () => {
    const config = mermaidConfig(dark, true)
    expect(config.securityLevel).toBe('strict')
    expect(config.htmlLabels).toBe(false)
    expect(config.startOnLoad).toBe(false)
    expect(config.suppressErrorRendering).toBe(true)
    expect(config.maxTextSize).toBe(MERMAID_MAX_CHARS)
    expect(config.theme).toBe('base')
    expect(config.themeVariables.primaryColor).toBe('#1d1917')
  })
})

describe('mermaid: strings', () => {
  const keys = Object.keys(en).filter((key) => key.startsWith('mermaid.'))

  it('every Mermaid string has a Spanish translation', () => {
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(es[key as keyof typeof es], key).toBeTruthy()
  })

  it('fills the limit messages', () => {
    expect(createT('en')('mermaid.tooBig', { chars: '25,000', max: '20,000' })).toBe('The source is 25,000 characters; diagrams render up to 20,000.')
    expect(createT('es')('mermaid.timeout', { seconds: 5 })).toBe('Dibujarlo tardó más de 5 segundos.')
  })
})
