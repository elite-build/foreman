// O15: Rich Markdown editing that never reformats what you didn't touch.
//
// The source splits into top-level blocks with exact ranges (micromark's
// positions). Each block that Rich mode can edit faithfully gets a small
// formatted tree (RichNode) that the editor renders into a contenteditable;
// an edit serializes only that block and replaces only its range, so every
// other byte (the blank lines between blocks, list markers, emphasis style,
// front matter, raw HTML, reference definitions, line endings) stays as written.
// Pure functions: the DOM side lives in RichMarkdown.tsx.
import type { List, Nodes, PhrasingContent, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export type BlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'html'
  | 'table'
  | 'definition'
  | 'thematicBreak'
  | 'other'

export interface RichText {
  type: 'text'
  value: string
}
export interface RichEl {
  type: 'el'
  tag: string
  attrs: Record<string, string>
  children: RichNode[]
}
export type RichNode = RichText | RichEl

export interface MdBlock {
  kind: BlockKind
  /** Offsets into the source: `source.slice(start, end) === text`. */
  start: number
  end: number
  text: string
  /** The formatted, editable form; null when the block is kept as written (raw HTML, tables, reference links…). */
  rich: RichNode[] | null
  /** Stable across re-parses while the block's text is unchanged. */
  key: string
}

/** The file's own habits, used for formatting the user adds (a new bold, a new list). */
export interface MdStyle {
  strong: '**' | '__'
  em: '*' | '_'
  bullet: '-' | '*' | '+'
}

export interface MdDoc {
  source: string
  blocks: MdBlock[]
  style: MdStyle
  /** The file's line ending, so edited blocks match the rest of the file. */
  eol: '\n' | '\r\n'
}

export const DEFAULT_STYLE: MdStyle = { strong: '**', em: '*', bullet: '-' }

const BOM = String.fromCharCode(0xfeff)
// Chromium types trailing and doubled spaces as no-break spaces, and may leave zero-width spaces.
const NBSP = /\xa0/g
const ZWSP = new RegExp(String.fromCharCode(0x200b), 'g')

// YAML (---, closed by --- or ...) or TOML (+++) front matter at the very top.
const FRONT_MATTER = /^(?:---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)|\+\+\+[ \t]*\r?\n(?:[\s\S]*?\r?\n)?\+\+\+)[ \t]*(?=\r?\n|$)/

const el = (tag: string, attrs: Record<string, string> = {}, children: RichNode[] = []): RichEl => ({ type: 'el', tag, attrs, children })
const txt = (value: string): RichText => ({ type: 'text', value })
const lf = (s: string): string => s.replace(/\r\n?/g, '\n')

function parse(source: string) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

const KINDS: Partial<Record<RootContent['type'], BlockKind>> = {
  heading: 'heading',
  paragraph: 'paragraph',
  list: 'list',
  blockquote: 'blockquote',
  code: 'code',
  html: 'html',
  table: 'table',
  definition: 'definition',
  footnoteDefinition: 'definition',
  thematicBreak: 'thematicBreak'
}

/** Splits the source into top-level blocks; what lies between them (blank lines) belongs to no block and is never rewritten. */
export function parseDoc(source: string): MdDoc {
  const blocks: Omit<MdBlock, 'key'>[] = []
  const style: Partial<MdStyle> = {}
  // micromark skips a byte-order mark without counting it, so it sits outside every block.
  let base = source.startsWith(BOM) ? 1 : 0
  const front = FRONT_MATTER.exec(source.slice(base))
  if (front) {
    blocks.push({ kind: 'frontmatter', start: base, end: base + front[0].length, text: front[0], rich: null })
    base += front[0].length
  }
  const rest = source.slice(base)
  for (const node of parse(rest).children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined || end <= start) continue
    noteStyle(node, rest, style)
    const kind = KINDS[node.type] ?? 'other'
    blocks.push({ kind, start: base + start, end: base + end, text: rest.slice(start, end), rich: toRich(node, rest) })
  }
  const seen = new Map<string, number>()
  const keyed = blocks.map((b) => {
    const id = `${b.kind}:${b.rich ? 'r' : 'k'}:${b.text}`
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return { ...b, key: `${id}#${n}` }
  })
  const eol = /\r?\n/.exec(source)?.[0] === '\r\n' ? '\r\n' : '\n'
  return { source, blocks: keyed, style: { ...DEFAULT_STYLE, ...style }, eol }
}

// The first bold, italic and bullet the file uses decide how new ones are written.
function noteStyle(node: Nodes, src: string, style: Partial<MdStyle>): void {
  const at = node.position?.start.offset
  if (at !== undefined) {
    if (node.type === 'strong' && !style.strong) style.strong = src[at] === '_' ? '__' : '**'
    if (node.type === 'emphasis' && !style.em) style.em = src[at] === '_' ? '_' : '*'
    if (node.type === 'list' && !node.ordered && !style.bullet && '-*+'.includes(src[at])) style.bullet = src[at] as MdStyle['bullet']
  }
  if ('children' in node) for (const child of node.children) noteStyle(child, src, style)
}

const slice = (node: Nodes, src: string): string => src.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)

/** The editable form of a block, or null when it can't be edited faithfully and is kept as written. */
function toRich(node: RootContent, src: string): RichNode[] | null {
  switch (node.type) {
    case 'heading': {
      const inline = phrasing(node.children, src)
      if (!inline) return null
      const text = slice(node, src)
      const attrs: Record<string, string> = {}
      // A setext heading ("Title" over "=====") stays one if it's edited.
      if (!text.startsWith('#')) attrs['data-setext'] = lf(text).split('\n').pop()!.trim()
      return [el(`h${node.depth}`, attrs, inline)]
    }
    case 'paragraph': {
      const inline = phrasing(node.children, src)
      return inline && [el('p', {}, inline)]
    }
    case 'blockquote': {
      const paras: RichNode[] = []
      for (const child of node.children) {
        const inline = child.type === 'paragraph' ? phrasing(child.children, src) : null
        if (!inline) return null
        paras.push(el('p', {}, inline))
      }
      return [el('blockquote', {}, paras)]
    }
    case 'list': {
      const list = listRich(node, src)
      return list && [list]
    }
    case 'code': {
      // Fenced only; an indented code block is kept as written.
      const fence = /^(`{3,}|~{3,})(.*)/.exec(slice(node, src))
      if (!fence) return null
      return [el('pre', { 'data-fence': fence[1], 'data-info': fence[2].trim() }, [el('code', {}, [txt(lf(node.value))])])]
    }
    default:
      return null
  }
}

function listRich(list: List, src: string): RichEl | null {
  const head = slice(list, src)
  const attrs: Record<string, string> = {}
  if (list.ordered) {
    const first = /^(\d+)([.)])/.exec(head)
    attrs['data-start'] = String(list.start ?? 1)
    attrs['data-delim'] = first?.[2] ?? '.'
    // "1. 1. 1." stays that way.
    const second = list.children[1] && /^(\d+)/.exec(slice(list.children[1], src))
    if (first && second && Number(first[1]) === Number(second[1])) attrs['data-same'] = '1'
  } else {
    attrs['data-marker'] = head[0]
  }
  if (list.spread) attrs['data-spread'] = '1'
  const items: RichNode[] = []
  for (const item of list.children) {
    const children: RichNode[] = []
    if (typeof item.checked === 'boolean') children.push(checkbox(item.checked))
    for (const [n, child] of item.children.entries()) {
      if (child.type === 'paragraph' && n === 0) {
        const inline = phrasing(child.children, src)
        if (!inline) return null
        children.push(...inline)
      } else if (child.type === 'list') {
        const nested = listRich(child, src)
        if (!nested) return null
        children.push(nested)
      } else {
        // A second paragraph, a code block in an item…: the whole list is kept as written.
        return null
      }
    }
    items.push(el('li', {}, children))
  }
  return el(list.ordered ? 'ol' : 'ul', attrs, items)
}

export function checkbox(checked: boolean): RichEl {
  return el('span', { class: 'md-check', contenteditable: 'false', 'data-checked': String(checked) })
}

function phrasing(nodes: PhrasingContent[], src: string): RichNode[] | null {
  const out: RichNode[] = []
  for (const node of nodes) {
    const kids = 'children' in node ? phrasing(node.children as PhrasingContent[], src) : []
    if (!kids) return null
    const at = node.position?.start.offset ?? 0
    switch (node.type) {
      case 'text': {
        const value = lf(node.value)
        const raw = lf(slice(node, src))
        // G4: text whose source differs from what it shows (escapes like \*, entities like &amp;) keeps its source,
        // so an edit elsewhere in the block doesn't turn a literal * into formatting.
        out.push(raw !== value ? el('span', { 'data-md-raw': raw, 'data-md-text': value }, [txt(value)]) : txt(value))
        break
      }
      case 'strong':
        out.push(el('strong', { 'data-mark': src[at] === '_' ? '__' : '**' }, kids))
        break
      case 'emphasis':
        out.push(el('em', { 'data-mark': src[at] === '_' ? '_' : '*' }, kids))
        break
      case 'delete':
        out.push(el('del', {}, kids))
        break
      case 'inlineCode':
        out.push(el('code', {}, [txt(node.value)]))
        break
      case 'break':
        out.push(el('br', { 'data-hard': src[at] === '\\' ? '\\' : 'spaces' }))
        break
      case 'link': {
        const raw = slice(node, src)
        const attrs: Record<string, string> = { href: node.url }
        if (node.title) attrs.title = node.title
        // <https://…> and bare URLs stay that way while their text is unchanged.
        if (!raw.startsWith('[')) Object.assign(attrs, { 'data-src': raw, 'data-text': plainText(kids) })
        out.push(el('a', attrs, kids))
        break
      }
      default:
        // Inline HTML, images, reference links, footnotes: kept as written.
        return null
    }
  }
  return out
}

// ---- Rich → HTML (the editor's initial content) ----

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const VOID = new Set(['br', 'hr'])

export function richToHtml(nodes: RichNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return escapeHtml(node.value)
      const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('')
      return VOID.has(node.tag) ? `<${node.tag}${attrs}>` : `<${node.tag}${attrs}>${richToHtml(node.children)}</${node.tag}>`
    })
    .join('')
}

// ---- Rich → Markdown (only for blocks the user edited) ----

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr'])
const isBlock = (n: RichNode): n is RichEl => n.type === 'el' && BLOCK_TAGS.has(n.tag)

/** Plain text, with <br> and paragraph breaks as newlines (code blocks, kept blocks, link text). */
export function plainText(nodes: RichNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if (node.tag === 'br') out += '\n'
    else if ((node.tag === 'div' || node.tag === 'p') && out && !out.endsWith('\n')) out += '\n' + plainText(node.children)
    else out += plainText(node.children)
  }
  return out
}

/**
 * Markdown for an edited block's content (the children of its editable
 * element), with "\n" line endings. Paragraphs the user split with Enter come
 * out as separate blocks, a blank line apart.
 */
export function serializeBlocks(nodes: RichNode[], style: MdStyle = DEFAULT_STYLE): string {
  const parts: string[] = []
  let run: RichNode[] = []
  const flush = () => {
    if (run.length) parts.push(paragraph(run, style))
    run = []
  }
  for (const node of nodes) {
    if (!isBlock(node)) {
      run.push(node)
      continue
    }
    flush()
    const tag = node.tag
    if (tag === 'p' || tag === 'div') parts.push(node.children.some(isBlock) ? serializeBlocks(node.children, style) : paragraph(node.children, style))
    else if (/^h[1-6]$/.test(tag)) parts.push(heading(node, style))
    else if (tag === 'ul' || tag === 'ol') parts.push(listMd(node, style, ''))
    else if (tag === 'blockquote') parts.push(quote(node, style))
    else if (tag === 'pre') parts.push(codeBlock(node))
    else if (tag === 'hr') parts.push('---')
  }
  flush()
  return parts.filter((p) => p.trim() !== '').join('\n\n')
}

// Chromium leaves a <br> at the end of a line as a placeholder; it isn't a line break.
function dropTrailingBreaks(nodes: RichNode[]): RichNode[] {
  const out = [...nodes]
  while (out.length) {
    const last = out[out.length - 1]
    if (last.type === 'el' && last.tag === 'br') out.pop()
    else if (last.type === 'text' && last.value.trim() === '' && !last.value.includes('\n')) out.pop()
    else break
  }
  return out
}

function paragraph(nodes: RichNode[], style: MdStyle): string {
  return inline(dropTrailingBreaks(nodes), style, {}).replace(/^\s+|\s+$/g, '')
}

function heading(node: RichEl, style: MdStyle): string {
  const level = Number(node.tag[1])
  const text = paragraph(node.children, style)
  if (!text) return ''
  const setext = node.attrs['data-setext']
  if (setext && ((level === 1 && setext[0] === '=') || (level === 2 && setext[0] === '-'))) return `${text}\n${setext}`
  return `${'#'.repeat(level)} ${text.replace(/\s*\n\s*/g, ' ')}`
}

function quote(node: RichEl, style: MdStyle): string {
  return serializeBlocks(node.children, style)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function codeBlock(node: RichEl): string {
  let value = plainText(node.children).replace(NBSP, ' ')
  if (value.endsWith('\n')) value = value.slice(0, -1)
  let fence = node.attrs['data-fence'] || '```'
  // A line in the code that would close the fence makes the fence longer.
  for (const m of value.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)) if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = fence[0].repeat(m[1].length + 1)
  return `${fence}${node.attrs['data-info'] ?? ''}\n${value}\n${fence}`
}

interface ListItem {
  check: string | null
  inline: RichNode[]
  nested: RichEl[]
}

function listMd(node: RichEl, style: MdStyle, indent: string): string {
  const items: ListItem[] = []
  for (const child of node.children) {
    if (child.type === 'el' && child.tag === 'li') {
      const item: ListItem = { check: null, inline: [], nested: [] }
      for (const part of child.children) {
        if (part.type === 'el' && part.attrs.class === 'md-check') item.check = part.attrs['data-checked'] ?? 'false'
        else if (part.type === 'el' && (part.tag === 'ul' || part.tag === 'ol')) item.nested.push(part)
        else item.inline.push(part)
      }
      items.push(item)
    } else if (child.type === 'el' && (child.tag === 'ul' || child.tag === 'ol')) {
      // Chromium's indent puts the new list beside the item, not in it.
      if (items.length) items[items.length - 1].nested.push(child)
      else items.push({ check: null, inline: [], nested: [child] })
    } else if (child.type === 'text' ? child.value.trim() : true) {
      items.push({ check: null, inline: [child], nested: [] })
    }
  }
  const ordered = node.tag === 'ol'
  const start = Number(node.attrs['data-start'] ?? 1)
  const lines: string[] = []
  let n = 0
  for (const item of items) {
    const text = itemLines(item.inline, style)
    if (!text && !item.nested.length && item.check === null) continue
    const marker = ordered ? `${node.attrs['data-same'] ? start : start + n}${node.attrs['data-delim'] ?? '.'}` : (node.attrs['data-marker'] ?? style.bullet)
    const pad = ' '.repeat(marker.length + 1)
    const task = item.check === null ? '' : item.check === 'true' ? '[x] ' : '[ ] '
    const [first, ...rest] = text.split('\n')
    const out = [`${indent}${marker} ${task}${first}`.trimEnd(), ...rest.map((line) => `${indent}${pad}${line}`)]
    for (const nested of item.nested) {
      const md = listMd(nested, style, indent + pad)
      if (md) out.push(md)
    }
    lines.push(out.join('\n'))
    n++
  }
  return lines.join(node.attrs['data-spread'] ? '\n\n' : '\n')
}

// An item's text, one line per <div>/<p> Chromium made inside it.
function itemLines(nodes: RichNode[], style: MdStyle): string {
  const lines: string[] = []
  let run: RichNode[] = []
  const flush = () => {
    const line = paragraph(run, style)
    if (line) lines.push(line)
    run = []
  }
  for (const node of nodes) {
    if (isBlock(node)) {
      flush()
      run = node.children
      flush()
    } else run.push(node)
  }
  flush()
  return lines.join('\n')
}

interface InlineCtx {
  strong?: boolean
  em?: boolean
  del?: boolean
  link?: boolean
}

// Moves whitespace outside the markers: "** bold**" isn't bold in Markdown.
function wrap(inner: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!
  return m[2] ? `${m[1]}${open}${m[2]}${close}${m[3]}` : inner
}

function codeSpan(code: string): string {
  const s = code.replace(/\n/g, ' ')
  if (!s) return ''
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  const pad = s.startsWith('`') || s.endsWith('`') || (s.startsWith(' ') && s.endsWith(' ') && s.trim()) ? ' ' : ''
  return `${ticks}${pad}${s}${pad}${ticks}`
}

function linkMd(node: RichEl, inner: string): string {
  const href = node.attrs.href ?? ''
  const shown = plainText(node.children)
  if (node.attrs['data-src'] && shown === node.attrs['data-text']) return node.attrs['data-src']
  const dest = /[\s()<>]/.test(href) ? `<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : href
  const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ''
  return `[${inner.trim() ? inner : href}](${dest}${title})`
}

const WORD = /[\p{L}\p{N}]/u

/**
 * Inline Markdown for formatted text. Text is written as typed, so Markdown
 * typed in Rich mode (`**bold**`, `## `) becomes formatting once re-read.
 */
function inline(nodes: RichNode[], style: MdStyle, ctx: InlineCtx): string {
  let out = ''
  for (const [i, node] of nodes.entries()) {
    if (node.type === 'text') {
      out += typedText(node.value.replace(NBSP, ' ').replace(ZWSP, ''))
      continue
    }
    // G4: a run that had escapes or entities in the source: its source again, with only the typed part new.
    if (node.tag === 'span' && node.attrs['data-md-raw'] !== undefined && node.children.every((c) => c.type === 'text')) {
      out += rawEdit(node.attrs['data-md-raw'], node.attrs['data-md-text'] ?? '', plainText(node.children).replace(NBSP, ' ').replace(ZWSP, ''))
      continue
    }
    const tag = node.tag
    const inner = (next: InlineCtx) => inline(node.children, style, { ...ctx, ...next })
    if (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i') {
      const strong = tag === 'strong' || tag === 'b'
      if (strong ? ctx.strong : ctx.em) {
        out += inner({})
        continue
      }
      let mark: string = node.attrs['data-mark'] ?? (strong ? style.strong : style.em)
      // Underscores don't work inside a word ("snake_case"); stars do.
      const after = nodes[i + 1] ? plainText([nodes[i + 1]]) : ''
      if (mark[0] === '_' && (WORD.test(out.slice(-1)) || WORD.test(after.slice(0, 1)))) mark = mark.replace(/_/g, '*')
      out += wrap(inner(strong ? { strong: true } : { em: true }), mark)
    } else if (tag === 'del' || tag === 's' || tag === 'strike') {
      out += ctx.del ? inner({}) : wrap(inner({ del: true }), '~~')
    } else if (tag === 'code') {
      out += codeSpan(plainText(node.children))
    } else if (tag === 'a' && !ctx.link) {
      out += linkMd(node, inner({ link: true }))
    } else if (tag === 'br') {
      out += node.attrs['data-hard'] === 'spaces' ? '  \n' : '\\\n'
    } else if (node.attrs.class === 'md-check') {
      // Only list items have a checkbox; listMd reads it.
    } else if (BLOCK_TAGS.has(tag)) {
      const text = paragraph(node.children, style)
      if (text) out += (out && !out.endsWith('\n') ? '\n' : '') + text
    } else {
      // <span>, <u>, <font>…: their text, without the styling.
      out += inner({})
    }
  }
  return out
}

// ---- G4: keeping escapes (the source of a run, and what typing adds) ----

const ASCII_PUNCT = /[!-/:-@[-`{-~]/
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013' }

function decodeEntity(ref: string): string | null {
  const body = ref.slice(1, -1)
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null
  }
  return ENTITIES[body] ?? null
}

/**
 * Where each character of a text run's shown `value` starts in its `raw` source (one past the end last), or null
 * when they can't be lined up. Backslash escapes and character references are one shown character (or a few);
 * the indentation of a paragraph's continuation lines isn't shown at all.
 */
export function rawOffsets(raw: string, value: string): number[] | null {
  const map: number[] = []
  let i = 0
  let j = 0
  while (j < value.length) {
    if (raw[i] === '\r') {
      i++
      continue
    }
    map[j] = i
    const ref = raw[i] === '&' ? /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(raw.slice(i)) : null
    const decoded = ref && decodeEntity(ref[0])
    if (raw[i] === '\\' && i + 1 < raw.length && ASCII_PUNCT.test(raw[i + 1]) && raw[i + 1] === value[j]) {
      i += 2
      j++
    } else if (ref && decoded && value.startsWith(decoded, j)) {
      for (let k = 1; k < decoded.length; k++) map[j + k] = i
      j += decoded.length
      i += ref[0].length
    } else if (raw[i] === value[j]) {
      const newline = raw[i] === '\n'
      i++
      j++
      if (newline) while ((raw[i] === ' ' || raw[i] === '\t') && value[j] !== raw[i]) i++
    } else return null
  }
  if (raw.slice(i).trim()) return null
  map[value.length] = raw.length
  return map
}

/**
 * Text the user typed, written as typed so Markdown typed in Rich mode (**bold**, ## ) still becomes formatting,
 * except where that would turn into something else: a backslash before punctuation stays a backslash, and a
 * < that would start an HTML tag stays a <.
 */
export function typedText(text: string): string {
  return text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\').replace(/<(?=[A-Za-z/!?])/g, '\\<')
}

/** Text that must read back exactly as shown: every character Markdown could take as syntax is escaped. */
export function escapeLiteral(text: string): string {
  return text.replace(/[\\`*_[\]<>~|]/g, '\\$&').replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/gm, (_m, sp: string, mark: string) => `${sp}${mark.replace(/^(\d+)?(.)$/, (_x, d: string | undefined, c: string) => `${d ?? ''}\\${c}`)}`)
}

/**
 * A run that had escapes or entities in the source, after an edit: the source of what's unchanged at both ends, and
 * the typed middle written as typedText does. A run that can't be lined up with its source is escaped whole.
 */
export function rawEdit(raw: string, before: string, now: string): string {
  if (now === before) return raw
  const map = rawOffsets(raw, before)
  if (!map) return escapeLiteral(now)
  let p = 0
  while (p < before.length && p < now.length && before[p] === now[p]) p++
  let s = 0
  while (s < before.length - p && s < now.length - p && before[before.length - 1 - s] === now[now.length - 1 - s]) s++
  return raw.slice(0, map[p]) + typedText(now.slice(p, now.length - s)) + raw.slice(map[before.length - s])
}

// ---- Writing an edit back ----

/** The block's new source: its original bytes when the edit came back to where it started. */
export function editedText(original: string, baseline: string, markdown: string, eol: string): string {
  return markdown === baseline ? original : markdown.replace(/\r?\n/g, eol)
}

/** The serialization of an untouched block, the yardstick editedText compares against. */
export function baselineOf(block: MdBlock, style: MdStyle): string {
  return block.rich ? serializeBlocks(block.rich, style) : lf(block.text)
}

/** Text to append for a paragraph typed below the last block, a blank line after what's there. */
export function appendedText(source: string, markdown: string, eol: string): string {
  const md = markdown.replace(/^\s+|\s+$/g, '')
  if (!md) return ''
  const sep = source.trim() === '' ? '' : /\n[ \t]*\r?\n[ \t]*$/.test(source) ? '' : /\n[ \t]*$/.test(source) ? eol : eol + eol
  return `${sep}${md}${eol}`.replace(/\r?\n/g, eol)
}

// ---- Toolbar: turning blocks into headings, lists and paragraphs ----

export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'ul'

/** The first block-level tag in an editable block's content ('p' for bare text). */
export function firstBlockTag(nodes: RichNode[]): string | null {
  for (const node of nodes) {
    if (isBlock(node)) return node.tag === 'div' ? 'p' : node.tag
    const other = node as RichNode
    if (other.type === 'el' || other.value.trim()) return 'p'
  }
  return null
}

function itemInline(li: RichNode): RichNode[] {
  return li.type === 'el' ? li.children.filter((c) => !(c.type === 'el' && (c.attrs.class === 'md-check' || c.tag === 'ul' || c.tag === 'ol'))) : [li]
}

/**
 * Turns an editable block's paragraphs, headings and list items into `type`
 * (a bulleted list gathers them into one list). Quotes and code stay as they are.
 */
export function setBlockType(nodes: RichNode[], type: BlockType): RichNode[] {
  // Each line of text the block holds, with the elements that hold no text (quotes, code) kept in place.
  const units: (RichNode[] | RichEl)[] = []
  let run: RichNode[] = []
  const flush = () => {
    if (run.length) units.push(run)
    run = []
  }
  for (const node of nodes) {
    if (!isBlock(node)) {
      run.push(node)
      continue
    }
    flush()
    if (node.tag === 'ul' || node.tag === 'ol') {
      const flat = (list: RichEl): void => {
        for (const li of list.children) {
          units.push(itemInline(li))
          if (li.type === 'el') for (const c of li.children) if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) flat(c)
        }
      }
      flat(node)
    } else if (node.tag === 'blockquote' || node.tag === 'pre' || node.tag === 'hr') units.push(node)
    else units.push(node.children)
  }
  flush()
  const out: RichNode[] = []
  let list: RichEl | null = null
  for (const unit of units) {
    if (!Array.isArray(unit)) {
      list = null
      out.push(unit)
    } else if (type === 'ul') {
      if (!list) out.push((list = el('ul')))
      list.children.push(el('li', {}, unit))
    } else out.push(el(type, {}, unit))
  }
  return out
}

// ---- What changed ----

/** The changed span between the saved file and the draft, in draft offsets. */
export function changedSpan(saved: string, draft: string): { start: number; end: number } | null {
  if (saved === draft) return null
  let p = 0
  const max = Math.min(saved.length, draft.length)
  while (p < max && saved[p] === draft[p]) p++
  let s = 0
  while (s < max - p && saved[saved.length - 1 - s] === draft[draft.length - 1 - s]) s++
  return { start: p, end: draft.length - s }
}

/** Indexes of the blocks an edit touched, for the margin mark. */
export function editedBlocks(saved: string, doc: MdDoc): Set<number> {
  const span = changedSpan(saved, doc.source)
  const out = new Set<number>()
  if (!span) return out
  doc.blocks.forEach((b, i) => {
    const hit = span.start === span.end ? b.start <= span.start && span.start <= b.end : b.start < span.end && b.end > span.start
    if (hit) out.add(i)
  })
  return out
}

/** Lines that differ, after the unchanged lines at the top and bottom: "3 lines changed". */
export function changedLineCount(saved: string, draft: string): number {
  if (saved === draft) return 0
  const a = saved.split('\n')
  const b = draft.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return Math.max(a.length - p - s, b.length - p - s)
}
