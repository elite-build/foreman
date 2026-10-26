// Mermaid diagrams in Markdown (#18), the pure half: which fences are Mermaid,
// whether a fence has closed yet (render only then, never per token), the size
// and time limits, the error text shown above the source, and how Foreman's
// theme tokens become Mermaid theme variables. MermaidBlock.tsx and
// mermaidRender.ts do the DOM work; nothing here touches the document.
import type { Element, Root, RootContent } from 'hast'

/** Longer sources aren't rendered; the block shows the code and says why. */
export const MERMAID_MAX_CHARS = 20_000
/** Mermaid's own cap on edges in one graph (its default); more fails with a message. */
export const MERMAID_MAX_EDGES = 500
/**
 * Renders slower than this are abandoned and the source is shown. Mermaid can't be
 * interrupted mid-layout, so this bounds the wait, not the work already started.
 */
export const MERMAID_RENDER_TIMEOUT_MS = 5_000
/** Error text from Mermaid is trimmed to this many lines and characters. */
export const MERMAID_ERROR_MAX_LINES = 6
export const MERMAID_ERROR_MAX_CHARS = 600

// ---- fences ----

/** A code element's className (string or hast's string[]) marks it as ```mermaid. */
export function isMermaidClass(className: unknown): boolean {
  const classes = Array.isArray(className) ? className.join(' ') : String(className ?? '')
  return /(^|[\s,])language-mermaid([\s,]|$)/.test(classes)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Whether the fenced block at markdown[start, end) has its closing fence. An open
 * fence (the reply is still streaming it) runs to the end of the document, so its
 * last line is code, not a fence of the same character at least as long as the opener.
 * Lines inside a blockquote keep their `>` markers, which are skipped.
 */
export function isFenceClosed(markdown: string, start: number, end: number): boolean {
  const lines = markdown.slice(start, end).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const opener = FENCE.exec(lines[0] ?? '')?.[1]
  if (!opener || lines.length < 2) return false
  const last = lines[lines.length - 1].replace(/^(\s*>)+/, '')
  const closer = /^\s*(`{3,}|~{3,})\s*$/.exec(last)?.[1]
  return !!closer && closer[0] === opener[0] && closer.length >= opener.length
}

function walk(nodes: (Root | RootContent)[], visit: (element: Element) => void): void {
  for (const node of nodes) {
    if (node.type === 'element') visit(node)
    if ('children' in node) walk(node.children, visit)
  }
}

/**
 * A rehype plugin: marks each ```mermaid <pre> with data-mermaid="open" or "closed",
 * from its position in the Markdown source (react-markdown puts the text in file.value).
 * Without a position (shouldn't happen) the block counts as closed.
 */
export function rehypeMermaidFences() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : ''
    walk([tree], (element) => {
      if (element.tagName !== 'pre') return
      const code = element.children[0]
      if (code?.type !== 'element' || code.tagName !== 'code' || !isMermaidClass(code.properties.className)) return
      const start = element.position?.start.offset
      const end = element.position?.end.offset
      const closed = start === undefined || end === undefined || isFenceClosed(source, start, end)
      element.properties.dataMermaid = closed ? 'closed' : 'open'
    })
  }
}

// ---- limits and errors ----

export type SourceCheck = { ok: true } | { ok: false; reason: 'empty' } | { ok: false; reason: 'tooBig'; chars: number }

/** Whether a complete block may be rendered at all. */
export function checkMermaidSource(source: string, maxChars = MERMAID_MAX_CHARS): SourceCheck {
  if (!source.trim()) return { ok: false, reason: 'empty' }
  if (source.length > maxChars) return { ok: false, reason: 'tooBig', chars: source.length }
  return { ok: true }
}

/** Mermaid's error message, trimmed for the line under "Couldn't render this diagram". */
export function mermaidErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String((error as { message?: unknown })?.message ?? error ?? '')
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  let text = lines.slice(0, MERMAID_ERROR_MAX_LINES).join('\n')
  if (lines.length > MERMAID_ERROR_MAX_LINES) text += '\n…'
  if (text.length > MERMAID_ERROR_MAX_CHARS) text = `${text.slice(0, MERMAID_ERROR_MAX_CHARS - 1)}…`
  return text
}

// ---- theme ----

/** The CSS tokens a diagram is drawn with (see ui/tokens.css). */
export const MERMAID_THEME_TOKENS = [
  '--code-bg',
  '--bg-panel',
  '--bg-raised',
  '--bg-hover',
  '--border',
  '--border-strong',
  '--text',
  '--text-soft',
  '--text-muted',
  '--text-faint',
  '--red',
  '--del-bg',
  '--font'
] as const

export type MermaidThemeToken = (typeof MERMAID_THEME_TOKENS)[number]
export type ThemeTokens = Partial<Record<MermaidThemeToken, string>>

// Foreman's default dark and light values, for any token that's missing or isn't a
// plain colour Mermaid can read (it can't parse var() or color-mix()).
const FALLBACK: Record<'dark' | 'light', Record<Exclude<MermaidThemeToken, '--font'>, string>> = {
  dark: {
    '--code-bg': '#161311',
    '--bg-panel': '#131110',
    '--bg-raised': '#1d1917',
    '--bg-hover': '#241f1c',
    '--border': '#272220',
    '--border-strong': '#37302c',
    '--text': '#ede8e4',
    '--text-soft': '#cfc7c2',
    '--text-muted': '#948a85',
    '--text-faint': '#948a85',
    '--red': '#ee7a72',
    '--del-bg': 'rgba(238, 122, 114, 0.09)'
  },
  light: {
    '--code-bg': '#ffffff',
    '--bg-panel': '#fbfaf9',
    '--bg-raised': '#f2efec',
    '--bg-hover': '#eeeae6',
    '--border': '#ebe6e2',
    '--border-strong': '#dcd5cf',
    '--text': '#1d1916',
    '--text-soft': '#39322e',
    '--text-muted': '#6d6460',
    '--text-faint': '#6d6460',
    '--red': '#ac332b',
    '--del-bg': 'rgba(172, 51, 43, 0.08)'
  }
}
const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/a-z]+\))$/i

export function isPlainColor(value: string | undefined): value is string {
  return !!value && COLOR.test(value.trim())
}

/**
 * Mermaid "base" theme variables from Foreman's tokens, so boxes, lines and labels
 * match the app in light and dark and sit on the code background.
 */
export function mermaidThemeVariables(tokens: ThemeTokens, dark: boolean): Record<string, string | boolean> {
  const fallback = FALLBACK[dark ? 'dark' : 'light']
  const c = (name: Exclude<MermaidThemeToken, '--font'>) => {
    const value = tokens[name]?.trim()
    return isPlainColor(value) ? value : fallback[name]
  }
  const font = tokens['--font']?.trim() || FALLBACK_FONT
  return {
    darkMode: dark,
    fontFamily: font,
    fontSize: '12px',
    // Flat boxes, like the rest of Foreman (Mermaid's grey shadow glows on dark).
    dropShadow: 'none',
    background: c('--code-bg'),
    // Nodes, actors and states.
    primaryColor: c('--bg-raised'),
    primaryBorderColor: c('--border-strong'),
    primaryTextColor: c('--text'),
    mainBkg: c('--bg-raised'),
    nodeBorder: c('--border-strong'),
    nodeTextColor: c('--text'),
    secondaryColor: c('--bg-hover'),
    secondaryBorderColor: c('--border-strong'),
    secondaryTextColor: c('--text-soft'),
    tertiaryColor: c('--bg-panel'),
    tertiaryBorderColor: c('--border'),
    tertiaryTextColor: c('--text-soft'),
    textColor: c('--text'),
    titleColor: c('--text'),
    // Edges and their labels.
    lineColor: c('--text-muted'),
    edgeLabelBackground: c('--code-bg'),
    // Subgraphs.
    clusterBkg: c('--bg-panel'),
    clusterBorder: c('--border-strong'),
    // Sequence diagrams.
    actorBkg: c('--bg-raised'),
    actorBorder: c('--border-strong'),
    actorTextColor: c('--text'),
    actorLineColor: c('--border-strong'),
    signalColor: c('--text-muted'),
    signalTextColor: c('--text-soft'),
    activationBkgColor: c('--bg-hover'),
    activationBorderColor: c('--border-strong'),
    sequenceNumberColor: c('--code-bg'),
    // alt/loop/opt frames: neutral (the accent reads as an error).
    labelBoxBkgColor: c('--bg-hover'),
    labelBoxBorderColor: c('--border-strong'),
    labelTextColor: c('--text-soft'),
    loopTextColor: c('--text-muted'),
    // Notes.
    noteBkgColor: c('--bg-hover'),
    noteBorderColor: c('--border-strong'),
    noteTextColor: c('--text-soft'),
    // Error glyphs Mermaid draws inside a diagram.
    errorBkgColor: c('--del-bg'),
    errorTextColor: c('--red')
  }
}

/** The whole Mermaid config: strict security, no HTML labels, Foreman's limits and colours. */
export function mermaidConfig(tokens: ThemeTokens, dark: boolean) {
  const themeVariables = mermaidThemeVariables(tokens, dark)
  return {
    startOnLoad: false,
    // Labels are encoded text; no click handlers, scripts or links run.
    securityLevel: 'strict' as const,
    // SVG text labels, not HTML in <foreignObject>.
    htmlLabels: false,
    // Errors come back to us; Mermaid mustn't draw its own error graphic into the page.
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_CHARS,
    maxEdges: MERMAID_MAX_EDGES,
    theme: 'base' as const,
    // Plain boxes and lines, as in the mock (Mermaid 12 defaults some diagrams to "neo").
    look: 'classic' as const,
    darkMode: dark,
    fontFamily: themeVariables.fontFamily as string,
    themeVariables
  }
}

/** Equal for equal colours: a rendered SVG is reused only while this stays the same. */
export function themeKey(tokens: ThemeTokens, dark: boolean): string {
  return `${dark ? 'dark' : 'light'}|${MERMAID_THEME_TOKENS.map((name) => tokens[name]?.trim() ?? '').join('|')}`
}

// ---- G4 #18: the remembered view, and Copy as SVG ----

export type MermaidView = 'diagram' | 'code'

/** localStorage key for the Diagram / Code choice every new block starts with. */
export const MERMAID_VIEW_KEY = 'foreman:mermaidView'

/** The remembered view from its stored JSON; anything unreadable is the default, Diagram. */
export function parseMermaidView(raw: string | null): MermaidView {
  try {
    return raw !== null && JSON.parse(raw) === 'code' ? 'code' : 'diagram'
  } catch {
    return 'diagram'
  }
}

/**
 * A rendered (and already sanitised) diagram as a standalone .svg file's text: the SVG
 * namespace declared, so it opens in other apps, and an XML declaration first.
 */
export function standaloneSvg(markup: string): string {
  let svg = markup.trim()
  if (!/^<svg[\s>]/i.test(svg)) return svg
  if (!/^<svg[^>]*\sxmlns=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`
}
