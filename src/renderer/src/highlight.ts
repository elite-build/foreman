// Syntax colouring for the code editor: lowlight (highlight.js grammars) turned into per-line tokens whose kinds the
// editor colours with the --code-* tokens. The class-to-kind mapping mirrors the .hljs-* rules in styles/chat.css.
import { common, createLowlight } from 'lowlight'
import type { CodeEditorToken, CodeEditorTokenKind } from './ui'

const lowlight = createLowlight(common)

const MAX_LINES = 5000
const MAX_CHARS = 200_000

// Extensions whose grammar is registered under another name. Any other extension is tried as a name itself.
const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['yml', 'yaml'],
  ['toml', 'ini'],
  ['sh', 'bash'],
  ['zsh', 'bash'],
  ['ps1', 'powershell'],
  ['h', 'c'],
  ['hpp', 'cpp'],
  ['cc', 'cpp'],
  ['rs', 'rust'],
  ['kt', 'kotlin'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['cs', 'csharp'],
  ['jsonc', 'json'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['svg', 'xml'],
])

function languageFor(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  const language = LANGUAGE_BY_EXTENSION.get(extension) ?? extension
  return lowlight.registered(language) ? language : null
}

// The subset of a hast node this module reads (lowlight's Root and Element/Text fit it).
interface HastNode {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

interface Segment {
  text: string
  kind?: CodeEditorTokenKind
}

function classesOf(node: HastNode): string[] {
  const raw = node.properties?.className
  if (Array.isArray(raw)) return raw.map(String)
  return typeof raw === 'string' ? raw.split(/\s+/) : []
}

/** The token kind for one highlight.js element, from its `hljs-<scope>` class and its modifier classes. */
function kindOf(classes: string[]): CodeEditorTokenKind | undefined {
  const scope = classes.find((name) => name.startsWith('hljs-'))
  if (!scope) return undefined
  const has = (name: string) => classes.includes(name)
  switch (scope.slice('hljs-'.length)) {
    case 'keyword':
    case 'doctag':
    case 'selector-pseudo':
    case 'bullet':
      return 'keyword'
    case 'built_in':
      return 'builtin'
    case 'variable':
      return has('language_') ? 'builtin' : has('constant_') ? 'literal' : 'variable'
    case 'literal':
    case 'symbol':
      return 'literal'
    case 'number':
      return 'number'
    case 'string':
    case 'code':
      return 'string'
    case 'regexp':
    case 'subst':
      return 'regexp'
    case 'char':
      return has('escape_') ? 'regexp' : undefined
    case 'comment':
    case 'quote':
      return 'comment'
    case 'title':
      return has('class_') ? 'type' : 'title'
    case 'function':
    case 'section':
    case 'link':
    case 'selector-id':
    case 'selector-class':
      return 'title'
    case 'type':
    case 'class':
      return 'type'
    case 'template-variable':
    case 'params':
      return 'variable'
    case 'attr':
    case 'attribute':
    case 'property':
    case 'selector-attr':
      return 'property'
    case 'name':
    case 'selector-tag':
      return 'tag'
    case 'meta':
      return 'meta'
    default:
      return undefined
  }
}

/** The text runs of a highlighted tree, each with the kind of its innermost element that has one. */
function collect(node: HastNode, inherited: CodeEditorTokenKind | undefined, out: Segment[]): void {
  if (node.type === 'text') {
    if (node.value) out.push({ text: node.value, kind: inherited })
    return
  }
  const kind = kindOf(classesOf(node)) ?? inherited
  for (const child of node.children ?? []) collect(child, kind, out)
}

/** Lines of the joined text, split as the editor splits them (/\r\n|\r|\n/), each as runs of one kind. */
function toLines(segments: Segment[]): CodeEditorToken[][] {
  let full = ''
  const kinds: (CodeEditorTokenKind | undefined)[] = []
  for (const segment of segments) {
    full += segment.text
    for (let i = 0; i < segment.text.length; i++) kinds.push(segment.kind)
  }
  const lines: CodeEditorToken[][] = []
  const pushLine = (from: number, to: number) => {
    const tokens: CodeEditorToken[] = []
    let i = from
    while (i < to) {
      const kind = kinds[i]
      let j = i + 1
      while (j < to && kinds[j] === kind) j++
      const text = full.slice(i, j)
      tokens.push(kind ? { text, kind } : { text })
      i = j
    }
    lines.push(tokens)
  }
  let lineStart = 0
  for (const match of full.matchAll(/\r\n|\r|\n/g)) {
    const at = match.index ?? 0
    pushLine(lineStart, at)
    lineStart = at + match[0].length
  }
  pushLine(lineStart, full.length)
  return lines
}

/**
 * The text's lines as coloured tokens, or null when the file's language is unknown, the file is too large
 * (over 5000 lines or 200000 characters) or the grammar fails. Every line's tokens join back to that line.
 */
export function highlightLines(text: string, path: string): CodeEditorToken[][] | null {
  if (text.length > MAX_CHARS) return null
  const language = languageFor(path)
  if (!language) return null
  if (text.split(/\r\n|\r|\n/).length > MAX_LINES) return null
  let tree: HastNode
  try {
    tree = lowlight.highlight(language, text) as HastNode
  } catch {
    return null
  }
  const segments: Segment[] = []
  collect(tree, undefined, segments)
  return toLines(segments)
}
