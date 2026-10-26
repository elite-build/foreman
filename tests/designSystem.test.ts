// The design-system guard. Every control in src/renderer/src comes from
// ui/; feature code owns only layout. Rules 1–9 are counted per file and held to a ratchet: a count may go down, never
// up, and a file with no baseline entry may have no findings. Phase 5 took rules 1–8 to zero; rule 9 (a new look outside
// ui/) starts at today's counts in the baseline and only falls from there.
// After lowering counts, write them down (the rewrite refuses any count that went up):
//   UPDATE_DS_BASELINE=1 npx vitest run tests/designSystem.test.ts
// To list every finding with its line: DS_REPORT=<file.json> npx vitest run tests/designSystem.test.ts
// TypeScript 7 has no compiler API, so TSX is parsed with @babel/parser and CSS with postcss.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse } from '@babel/parser'
import postcss, { type AtRule, type Declaration, type Node as CssNode, type Rule as CssRule } from 'postcss'
import { describe, expect, it } from 'vitest'

const RENDERER = 'src/renderer/src'
const UI = `${RENDERER}/ui`
const DOCS = 'docs/design-system.md'
const BASELINE = 'tests/designSystem.baseline.json'
const FIXTURES = 'tests/fixtures/designSystem'

const RULES: Record<number, string> = {
  1: 'hand-built control element (<button>, <input>, <select>, <textarea>, <a> without href, <summary>)',
  2: 'non-control made interactive (handler + tabIndex, role="button", widget role)',
  3: 'contentEditable',
  4: 'raw colour',
  5: 'raw font size or radius',
  6: 'feature CSS sets appearance on ui/ markup (a ui- class, or a class feature TSX passes to a ui/ component)',
  7: 'text dimmed with opacity',
  8: 'ui/ export without a section in docs/design-system.md',
  9: 'new look outside ui/ (background, border, radius, shadow or outline on a feature class or in an inline style)'
}

/** What the failure says when rule 9 went up. */
const NEW_LOOK =
  'New look outside the design system. Reuse a component from src/renderer/src/ui/, or add one there first (component, tests, doc section in docs/design-system.md) and use it. See AGENTS.md.'

interface Finding {
  rule: number
  file: string
  line: number
  what: string
  // TS: the enclosing function or variable; CSS: the rule's selector.
  scope?: string
}

/** Every selector of a CSS finding's rule matches `pattern` (a rule with a selector list is excused only when all of it is). */
const scopeIs = (f: Finding, pattern: RegExp): boolean => (f.scope ?? '').split(',').every((s) => pattern.test(s.trim()))

/**
 * Content, not controls (PLAN.md): allowed by name, each with its reason. Keep this short; anything new goes into
 * ui/ instead. `where` narrows an entry to the findings it is about, so new code in the same file still counts.
 */
const EXCEPTIONS: { rule: number; file: string; reason: string; where?: (f: Finding) => boolean }[] = [
  {
    rule: 3,
    file: `${RENDERER}/components/RichMarkdown.tsx`,
    reason: 'the rich Markdown editor: its contentEditable is the document being written, not a control'
  },
  {
    rule: 1,
    file: `${RENDERER}/components/ApprovalPanel.tsx`,
    reason: "<details> shows the tool call's input as read-only JSON",
    where: (f) => f.what === '<summary> in <details>'
  },
  {
    rule: 1,
    file: `${RENDERER}/components/AutoReview.tsx`,
    reason: '<details> shows the review prompt as read-only text',
    where: (f) => f.what === '<summary> in <details class="ar-prompt">'
  },
  {
    rule: 1,
    file: `${RENDERER}/components/Reviews.tsx`,
    reason: "<details> shows the pull request's description as read-only Markdown",
    where: (f) => f.what === '<summary> in <details class="pr-description">'
  },
  {
    rule: 2,
    file: `${RENDERER}/components/Tour.tsx`,
    reason: "the welcome tour's card sits beside the control it spotlights, at a measured position, over the tour's own dim layer; ui/ Dialog centres itself and adds a second backdrop",
    where: (f) => f.what === '<div role="dialog">'
  },
  {
    rule: 9,
    file: `${RENDERER}/components/tour.css`,
    reason: "the welcome tour's spotlight, dim layer and card (same reason as the Tour.tsx entry above)",
    where: (f) => scopeIs(f, /^\.tour-(spot|dim|card)\b/)
  },
  {
    rule: 9,
    file: `${RENDERER}/components/files.css`,
    reason: 'the rich Markdown editor\'s document surface: the field, its editable blocks, the edited marker and the source-block view',
    where: (f) => scopeIs(f, /(^|\s)\.(rich-field|md-block|md-edited|md-source)\b/)
  },
  {
    rule: 4,
    file: `${RENDERER}/theme.ts`,
    reason: "xterm's ANSI palette (black and white kept readable on either background), and the canvas probe's reset colour",
    where: (f) => f.scope === 'terminalTheme' || f.scope === 'rgbOf'
  },
  {
    rule: 4,
    file: `${RENDERER}/components/mermaidSource.ts`,
    reason: "Mermaid's fallback palette, for tokens it can't parse (var(), color-mix()); phase 1 may move it to tokens",
    where: (f) => f.scope === 'FALLBACK'
  }
]

/** Opacity below 1 on text, allowed where the selector says why (rule 7). */
const DIMMED: { selector: RegExp; reason: string }[] = [
  { selector: /:disabled|\[disabled\]|\.disabled\b|\[aria-disabled/, reason: 'a disabled control (WCAG 1.4.3 exempts inactive components)' },
  { selector: /drag|ghost|\.lifted\b|\.drop-no\b/, reason: 'shown only while dragging: the lifted item or ghost, and lanes that refuse the drop' }
]

// ---- values ----

const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
    'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
    'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ' +
    'fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen ' +
    'lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' ')
)
const HEX = /(?<![\w&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi
const COLOUR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi
const WORD = /(?<![\w-])[a-z]+(?![\w-])/gi

/** Strings, url(…) and custom property names out of a CSS value, so only its own words are left. */
function bareValue(value: string): string {
  return value
    .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
    .replace(/url\([^)]*\)/gi, ' ')
    .replace(/--[\w-]+/g, ' ')
}

/** Raw colours in text: hex and colour functions always; named colours only where the text is a CSS value. */
function colours(text: string, named: boolean): string[] {
  const value = bareValue(text)
  const found = [...value.matchAll(HEX), ...value.matchAll(COLOUR_FN)].map((m) => m[0])
  if (named) for (const m of value.matchAll(WORD)) if (NAMED_COLOURS.has(m[0].toLowerCase())) found.push(m[0])
  return found
}

const DIMENSION = /(?<![\w.#-])(\d*\.?\d+)(px|r?em|%|pt|pc|vw|vh|vmin|vmax|ch|ex|cm|mm|in|q|lh|rlh|cap|ic|cqw|cqh|cqi|cqb)(?![\w-])/gi
const SIZE_KEYWORD = /(?<![\w-])(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?![\w-])/i

/** A font size or radius that isn't a token: a non-zero length, or a size keyword. `var(--token)` and 0 are fine. */
function rawSize(value: string, prop: string): boolean {
  const v = bareValue(value.replace(/var\(\s*--[\w-]+\s*\)/g, ' '))
  if ([...v.matchAll(DIMENSION)].some((m) => Number(m[1]) !== 0)) return true
  return /^font(-size)?$/i.test(prop) && SIZE_KEYWORD.test(v)
}

/** opacity strictly between 0 and 1 (0 hides, it doesn't dim). */
function dims(value: string): boolean {
  const m = /^\s*(\d*\.?\d+)(%?)\s*$/.exec(value)
  if (!m) return false
  const n = Number(m[1]) / (m[2] ? 100 : 1)
  return n > 0 && n < 1
}

// Rule 9: the properties that give an element a look of its own. Table layout (border-collapse, border-spacing) is not one.
const LOOK_PROP = /^(background(-[\w-]+)?|border(-[\w-]+)?|box-shadow|outline(-[\w-]+)?)$/i
const NOT_LOOK_PROP = /^border-(collapse|spacing)$/i
const LOOK_STYLE_KEY = /^(background|border|outline)([A-Z]\w*)?$|^boxShadow$/
const NOT_LOOK_STYLE_KEY = /^border(Collapse|Spacing)$/
/** A plain divider: one edge, 1px solid, the border token. The one border feature code may still draw. */
const DIVIDER_PROP = /^border-(top|bottom|left|right)$/i
const DIVIDER_STYLE_KEY = /^border(Top|Bottom|Left|Right)$/
const DIVIDER_VALUE = '1px solid var(--border)'
const isDividerValue = (value: string) => value.trim().replace(/\s+/g, ' ') === DIVIDER_VALUE
/** Classes that libraries generate (highlight.js, xterm.js); their theme is not ours to move into ui/. */
const GENERATED_CLASS = /^(hljs|xterm)(-|$)/

const SIZE_PROP = /^(font|font-size|border-radius|border-(top|bottom|start|end)-(left|right|start|end)-radius)$/i
const APPEARANCE_PROP = /^(background(-[\w-]+)?|color|border(-[\w-]+)?|font(-[\w-]+)?|box-shadow|outline(-[\w-]+)?|text-decoration(-[\w-]+)?)$/i

// ---- TSX / TS ----

const CONTROLS = new Set(['button', 'input', 'select', 'textarea'])
const WIDGET_ROLES = new Set([
  'button', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'dialog', 'alertdialog', 'radio', 'radiogroup',
  'tab', 'tablist', 'tabpanel', 'switch', 'listbox', 'option', 'combobox', 'meter', 'checkbox', 'tree', 'treeitem', 'treegrid',
  'separator', 'tooltip'
])
const HANDLERS = new Set(['onClick', 'onKeyDown', 'onMouseDown'])
const STYLE_SIZE_KEYS = /^(fontSize|font|borderRadius|border(Top|Bottom|Start|End)(Left|Right|Start|End)Radius)$/
const STYLE_COLOUR_KEYS = /^(color|background(Color)?|border(Top|Right|Bottom|Left)?(Color)?|outline(Color)?|fill|stroke|boxShadow|textShadow|caretColor|accentColor|textDecorationColor)$/
const SVG_COLOUR_ATTRS = new Set(['fill', 'stroke', 'color', 'stopColor', 'floodColor', 'lightingColor'])

type Node = any

function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []): void {
  if (!node || typeof node.type !== 'string') return
  visit(node, ancestors)
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walk(c, visit, ancestors)
    else if (child && typeof child === 'object') walk(child, visit, ancestors)
  }
  ancestors.pop()
}

const attrName = (attr: Node): string | null => (attr.type === 'JSXAttribute' ? (attr.name.type === 'JSXNamespacedName' ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name) : null)
const attrOf = (el: Node, name: string): Node | undefined => el.attributes.find((a: Node) => attrName(a) === name)

/** The string values an attribute can have when they are written out ('x', {'x'}, {c ? 'x' : 'y'}, {c && 'x'}). */
function literalValues(value: Node): string[] {
  if (!value) return []
  if (value.type === 'StringLiteral') return [value.value]
  if (value.type === 'JSXExpressionContainer') return literalValues(value.expression)
  if (value.type === 'ConditionalExpression') return [...literalValues(value.consequent), ...literalValues(value.alternate)]
  if (value.type === 'LogicalExpression') return literalValues(value.right)
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) return [value.quasis[0].value.cooked]
  return []
}

/** -1 only (programmatic focus), as written. */
function onlyMinusOne(value: Node): boolean {
  const expr = value?.type === 'JSXExpressionContainer' ? value.expression : value
  if (!expr) return false
  if (expr.type === 'StringLiteral') return expr.value === '-1'
  if (expr.type === 'UnaryExpression') return expr.operator === '-' && expr.argument.type === 'NumericLiteral' && expr.argument.value === 1
  return false
}

function elementName(el: Node): string | null {
  return el.name.type === 'JSXIdentifier' ? el.name.name : null
}

/** The name of the function or variable around a node, for exceptions that name one. */
function scopeOf(ancestors: Node[]): string | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]
    if (a.type === 'FunctionDeclaration' && a.id) return a.id.name
    if (a.type === 'VariableDeclarator' && a.id.type === 'Identifier') return a.id.name
  }
  return undefined
}

/** The JSX element whose `style={{…}}` object this property sits in, if it does. */
function inStyleObject(ancestors: Node[]): boolean {
  const object = ancestors[ancestors.length - 1]
  const container = ancestors[ancestors.length - 2]
  const attr = ancestors[ancestors.length - 3]
  return object?.type === 'ObjectExpression' && container?.type === 'JSXExpressionContainer' && attr?.type === 'JSXAttribute' && attrName(attr) === 'style'
}

const staticKey = (prop: Node): string | null => (prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : null)

/** Rules 1, 2, 3 and the inline-style halves of 4, 5 and 7 in one TS or TSX file. `uiFile`: only rule 4 applies. */
function scanScript(file: string, source: string, uiFile = false): Finding[] {
  const ast = parse(source, { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['typescript'] })
  const out: Finding[] = []
  const add = (rule: number, node: Node, what: string, ancestors: Node[]) => out.push({ rule, file, line: node.loc?.start.line ?? 0, what, scope: scopeOf(ancestors) })

  walk(ast.program, (node, ancestors) => {
    // Rule 4: hex and colour functions in any string; named colours in style values and SVG colour attributes.
    if (node.type === 'StringLiteral' || node.type === 'TemplateElement') {
      const parent = ancestors[ancestors.length - 1]
      if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration') return
      const text = node.type === 'StringLiteral' ? node.value : (node.value.cooked ?? node.value.raw)
      const key = parent?.type === 'ObjectProperty' && parent.value === node ? staticKey(parent) : null
      const named =
        (key !== null && STYLE_COLOUR_KEYS.test(key) && inStyleObject(ancestors.slice(0, -1))) ||
        (parent?.type === 'JSXAttribute' && SVG_COLOUR_ATTRS.has(attrName(parent) ?? ''))
      for (const c of colours(text, named)) add(4, node, c, ancestors)
      return
    }
    if (uiFile) return

    // Rules 5 and 7 inline: literal values in a JSX style object. Computed values (a prop, a setting) aren't judged.
    if (node.type === 'ObjectProperty' && inStyleObject(ancestors)) {
      const key = staticKey(node)
      const values: Node[] = node.value.type === 'ConditionalExpression' ? [node.value.consequent, node.value.alternate] : [node.value]
      let flagged = false
      for (const v of values) {
        const literal = v.type === 'NumericLiteral' ? `${v.value}px` : v.type === 'StringLiteral' ? v.value : null
        if (literal === null) continue
        if (key && STYLE_SIZE_KEYS.test(key) && rawSize(literal, key === 'fontSize' ? 'font-size' : key === 'font' ? 'font' : 'border-radius')) {
          add(5, v, `${key}: ${literal}`, ancestors)
          flagged = true
        }
        if (key === 'opacity' && dims(String(v.value))) add(7, v, `opacity: ${v.value}`, ancestors)
      }
      // Rule 9: a look of its own in an inline style, whatever the value (a prop is as much a look as a literal). A raw
      // colour (rule 4) or raw radius (rule 5) is already a finding, and a plain divider is allowed.
      if (key && LOOK_STYLE_KEY.test(key) && !NOT_LOOK_STYLE_KEY.test(key)) {
        const strings: string[] = []
        walk(node.value, (n) => {
          if (n.type === 'StringLiteral') strings.push(n.value)
          else if (n.type === 'TemplateElement') strings.push(n.value.cooked ?? n.value.raw)
        })
        const rawColour = strings.some((text) => colours(text, STYLE_COLOUR_KEYS.test(key)).length > 0)
        const divider = DIVIDER_STYLE_KEY.test(key) && values.every((v) => v.type === 'StringLiteral' && isDividerValue(v.value))
        if (!flagged && !rawColour && !divider) add(9, node, `style ${key}`, ancestors)
      }
      return
    }

    if (node.type !== 'JSXOpeningElement') return
    const name = elementName(node)
    // Components (and member expressions) are judged where they are defined.
    if (!name || !/^[a-z]/.test(name)) return
    const has = (attr: string) => Boolean(attrOf(node, attr))
    const spread = node.attributes.some((a: Node) => a.type === 'JSXSpreadAttribute')

    // Rule 1.
    if (CONTROLS.has(name)) add(1, node, `<${name}>`, ancestors)
    else if (name === 'a' && !has('href') && !spread) add(1, node, '<a> without href', ancestors)
    else if (name === 'summary') {
      // The <details> this summary opens (its opening element), to name it in exceptions.
      const details = [...ancestors].reverse().find((a) => a.type === 'JSXElement' && elementName(a.openingElement) === 'details')
      const cls = details ? literalValues(attrOf(details.openingElement, 'className')?.value)[0] : undefined
      add(1, node, `<summary> in <details${cls ? ` class="${cls}"` : ''}>`, ancestors)
    }

    // Rule 2: one finding per element.
    const roles = literalValues(attrOf(node, 'role')?.value)
    const widget = roles.find((r) => WIDGET_ROLES.has(r))
    const tabIndex = attrOf(node, 'tabIndex')
    const handler = node.attributes.some((a: Node) => HANDLERS.has(attrName(a) ?? ''))
    const native = CONTROLS.has(name) || name === 'summary' || (name === 'a' && has('href'))
    // A separator is a widget only when it can be focused (a splitter); a divider line in content isn't.
    const splitter = widget !== 'separator' || has('tabIndex') || has('aria-valuenow')
    if (widget && splitter) add(2, node, `<${name} role="${widget}">`, ancestors)
    else if (handler && tabIndex && !native && !onlyMinusOne(tabIndex.value)) add(2, node, `<${name}> with a handler and tabIndex`, ancestors)

    // Rule 3.
    const editable = attrOf(node, 'contentEditable') ?? attrOf(node, 'contenteditable')
    if (editable) {
      const v = editable.value
      const off = v?.type === 'JSXExpressionContainer' && v.expression.type === 'BooleanLiteral' && !v.expression.value
      if (!off && !(v?.type === 'StringLiteral' && v.value === 'false')) add(3, node, `<${name} contentEditable>`, ancestors)
    }
  })
  return out
}

// ---- CSS ----

/** The nearest ancestor of a declaration that passes `test`. */
function enclosing(node: Declaration, test: (n: CssNode) => boolean): CssNode | undefined {
  for (let p = node.parent as CssNode | undefined; p; p = p.parent as CssNode | undefined) if (test(p)) return p
  return undefined
}
const isRule = (n: CssNode) => n.type === 'rule'
const isKeyframes = (n: CssNode) => n.type === 'atrule' && /keyframes$/i.test((n as AtRule).name)

/** Strip :not(…), [attr=…] and the like so only the compound's own classes are left. */
function withoutGroups(selector: string): string {
  let out = ''
  let depth = 0
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += ch
  }
  return out
}

/** The classes of the element a selector styles: its last compound. */
function subjectClasses(selector: string): string[] {
  const compounds = withoutGroups(selector).trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  const last = compounds[compounds.length - 1] ?? ''
  return [...last.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])
}

/**
 * Rules 4, 5, 6 and 7 in one stylesheet. `uiClasses`: ui/'s own classes once ui/ exists (rule 6), else null. `passed`: the
 * classes feature TSX hands to ui/ components, which are ui/ markup too.
 */
function scanCss(file: string, source: string, uiClasses: Set<string> | null, uiFile = false, passed: Set<string> = new Set()): Finding[] {
  const out: Finding[] = []
  const root = postcss.parse(source, { from: file })
  root.walkDecls((decl) => {
    const rule = enclosing(decl, isRule) as CssRule | undefined
    const selector = rule?.selector ?? ''
    // Rules 4–6 already name a declaration they flag; rule 9 leaves it to them.
    let flagged = false
    const add = (n: number, what: string) => {
      if (n >= 4 && n <= 6) flagged = true
      out.push({ rule: n, file, line: decl.source?.start?.line ?? 0, what, scope: selector })
    }
    for (const c of colours(decl.value, true)) add(4, `${decl.prop}: ${c}`)
    if (uiFile) return
    if (SIZE_PROP.test(decl.prop) && rawSize(decl.value, decl.prop)) add(5, `${decl.prop}: ${decl.value}`)
    if (decl.prop === 'opacity' && dims(decl.value) && !enclosing(decl, isKeyframes)) {
      const reasons = (rule?.selectors ?? [selector]).map((s) => DIMMED.find((d) => d.selector.test(s)))
      if (!reasons.length || reasons.some((r) => !r)) add(7, `opacity: ${decl.value}`)
    }
    if (uiClasses && rule && APPEARANCE_PROP.test(decl.prop)) {
      const subjects = rule.selectors.flatMap(subjectClasses)
      const target = subjects.find((c) => uiClasses.has(c))
      const handed = subjects.find((c) => passed.has(c))
      if (target) add(6, `${decl.prop} on .${target}`)
      else if (handed) add(6, `${decl.prop} on .${handed} (passed to a ui/ component)`)
    }
    // Rule 9: a look of its own on a feature class. Plain dividers and generated classes (.hljs-*, .xterm*) are allowed.
    if (rule && !flagged && LOOK_PROP.test(decl.prop) && !NOT_LOOK_PROP.test(decl.prop)) {
      const divider = DIVIDER_PROP.test(decl.prop) && isDividerValue(decl.value)
      const generated = rule.selectors.every((s) => [...withoutGroups(s).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].some((m) => GENERATED_CLASS.test(m[1])))
      if (!divider && !generated) add(9, `${decl.prop}: ${decl.value}`)
    }
  })
  return out
}

/** Every class ui/'s stylesheets define, for rule 6. */
function uiClassNames(uiDir: string): Set<string> {
  const classes = new Set<string>()
  // Not tokens.css: its global forced-colors block names app-wide state classes (.selected, .active), not ui/ markup.
  for (const file of files(uiDir).filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'))) {
    postcss.parse(readFileSync(file, 'utf8'), { from: file }).walkRules((rule) => {
      for (const m of withoutGroups(rule.selector).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1])
    })
  }
  return classes
}

/**
 * The class names feature TSX hands to ui/ components (`className`, `triggerClassName`, `panelClassName`, … on a JSX
 * element named like a ui/ export, and `className` inside `primaryProps={{…}}`). The component renders them on its own
 * element, so a feature rule that gives them a colour, border or font restyles ui/ markup just like a `ui-` class (rule 6).
 * Whole words only: a template literal contributes the words that don't touch a `${…}`.
 */
function passedClassNames(source: string, file: string, uiNames: Set<string>): Set<string> {
  const classes = new Set<string>()
  if (!file.endsWith('.tsx')) return classes
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  // A component this file defines itself is judged where it is defined, whatever it is called.
  const local = new Set<string>()
  walk(ast.program, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) local.add(node.id.name)
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') local.add(node.id.name)
  })
  const words = (text: string) => text.split(/\s+/).filter(Boolean)
  const collect = (value: Node): void => {
    if (!value) return
    if (value.type === 'StringLiteral') for (const w of words(value.value)) classes.add(w)
    else if (value.type === 'JSXExpressionContainer') collect(value.expression)
    else if (value.type === 'ConditionalExpression') {
      collect(value.consequent)
      collect(value.alternate)
    }
    else if (value.type === 'LogicalExpression') collect(value.right)
    else if (value.type === 'TemplateLiteral') {
      value.quasis.forEach((q: Node, i: number) => {
        const text: string = q.value.cooked ?? ''
        const parts = text.split(/(\s+)/)
        parts.forEach((part, j) => {
          if (!part.trim()) return
          const touchesStart = j === 0 && i > 0
          const touchesEnd = j === parts.length - 1 && i < value.quasis.length - 1
          if (!touchesStart && !touchesEnd) classes.add(part)
        })
      })
    }
  }
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement') return
    const name = elementName(node)
    if (!name || !uiNames.has(name) || local.has(name)) return
    for (const attr of node.attributes) {
      const key = attrName(attr)
      if (key === 'className' || key?.endsWith('ClassName')) collect(attr.value)
      else if (key === 'primaryProps' && attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type === 'ObjectExpression') {
        for (const p of attr.value.expression.properties) if (p.type === 'ObjectProperty' && staticKey(p) === 'className') collect(p.value)
      }
    }
  })
  return classes
}

/** The classes feature TSX under `dir` passes to ui/ components named in `uiNames`; `skip` leaves out ui/'s own files. */
function passedClassesIn(dir: string, uiNames: Set<string>, skip: (file: string) => boolean = () => false): Set<string> {
  const classes = new Set<string>()
  for (const full of files(dir).filter((f) => f.endsWith('.tsx'))) {
    if (skip(posix(full))) continue
    for (const c of passedClassNames(readFileSync(full, 'utf8'), full, uiNames)) classes.add(c)
  }
  return classes
}

// ---- rule 8 ----

/** Components ui/index.ts exports (capitalised names), following `export * from`. */
function uiExports(indexFile: string): string[] {
  const names: string[] = []
  const ast = parse(readFileSync(indexFile, 'utf8'), { sourceType: 'module', plugins: ['typescript'] })
  for (const node of ast.program.body as Node[]) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue
      for (const s of node.specifiers ?? []) if (s.exportKind !== 'type') names.push(s.exported.name ?? s.exported.value)
      const d = node.declaration
      if (d?.id?.name) names.push(d.id.name)
      for (const v of d?.declarations ?? []) if (v.id.type === 'Identifier') names.push(v.id.name)
    } else if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
      const base = join(indexFile, '..', node.source.value)
      const target = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find(existsSync)
      if (target) names.push(...uiExports(target))
    }
  }
  return [...new Set(names)].filter((n) => /^[A-Z]/.test(n))
}

/** Rule 8: an export is documented when a heading in the doc names it. */
function undocumented(exports: string[], doc: string): string[] {
  const headings = [...doc.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].replace(/`/g, ''))
  return exports.filter((name) => !headings.some((h) => new RegExp(`(^|[^\\w])${name}([^\\w]|$)`).test(h)))
}

// ---- the whole renderer ----

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files(full, out)
    else if (/\.(tsx?|css)$/.test(name)) out.push(full)
  }
  return out
}

const posix = (p: string) => p.split(sep).join('/')

function applyExceptions(findings: Finding[]): { counted: Finding[]; excused: Finding[] } {
  const counted: Finding[] = []
  const excused: Finding[] = []
  for (const f of findings) {
    const named = EXCEPTIONS.some((e) => e.rule === f.rule && e.file === f.file && (!e.where || e.where(f)))
    ;(named ? excused : counted).push(f)
  }
  return { counted, excused }
}

function scanRenderer(): Finding[] {
  const ui = existsSync(join(UI, 'index.ts'))
  const uiClasses = ui ? uiClassNames(UI) : null
  const passed = ui ? passedClassesIn(RENDERER, new Set(uiExports(join(UI, 'index.ts'))), (f) => f.startsWith(`${UI}/`)) : new Set<string>()
  const findings: Finding[] = []
  for (const full of files(RENDERER)) {
    const file = posix(relative('.', full))
    const inUi = file.startsWith(`${UI}/`)
    if (file === `${UI}/tokens.css`) continue
    const source = readFileSync(full, 'utf8')
    findings.push(...(file.endsWith('.css') ? scanCss(file, source, uiClasses, inUi, passed) : scanScript(file, source, inUi)))
  }
  if (ui) {
    const doc = existsSync(DOCS) ? readFileSync(DOCS, 'utf8') : ''
    for (const name of undocumented(uiExports(join(UI, 'index.ts')), doc)) findings.push({ rule: 8, file: `${UI}/index.ts`, line: 0, what: name })
  }
  return findings
}

type Counts = Record<string, Record<string, number>>

function countByFile(findings: Finding[]): Counts {
  const counts: Counts = {}
  for (const f of findings) {
    counts[f.file] ??= {}
    counts[f.file][f.rule] = (counts[f.file][f.rule] ?? 0) + 1
  }
  return Object.fromEntries(Object.keys(counts).sort().map((file) => [file, counts[file]]))
}

/** Every (file, rule) count above its baseline, a file with no baseline entry included. */
function overBaseline(now: Counts, baseline: Counts): string[] {
  const over: string[] = []
  for (const [file, rules] of Object.entries(now)) {
    for (const [rule, n] of Object.entries(rules)) {
      const was = baseline[file]?.[rule] ?? 0
      if (n > was) over.push(`${file}: rule ${rule} (${RULES[Number(rule)]}) ${was} → ${n}`)
    }
  }
  return over
}

/** What a failing run tells the author: rule 9 gets its own instruction, the rest the ratchet's. */
function failure(over: string[]): string {
  const lines = ['fix these, or use ui/ (lower counts: UPDATE_DS_BASELINE=1 npx vitest run tests/designSystem.test.ts)']
  if (over.some((o) => o.includes(': rule 9 '))) lines.unshift(NEW_LOOK)
  return lines.join('\n')
}

// ---- tests ----

/** A fixture states what it should produce on its first line: `// expect 1=4 2=0` (or in a CSS comment). */
function expected(source: string): Record<string, number> {
  const line = /expect((?:\s+\d=\d+)+)/.exec(source.split('\n')[0])?.[1] ?? ''
  return Object.fromEntries([...line.matchAll(/(\d)=(\d+)/g)].map((m) => [m[1], Number(m[2])]))
}

function tally(findings: Finding[], rules: string[]): Record<string, number> {
  return Object.fromEntries(rules.map((r) => [r, findings.filter((f) => String(f.rule) === r).length]))
}

describe('design-system guard: the rules', () => {
  const fixtures = readdirSync(FIXTURES).filter((n) => /\.(tsx?|css)$/.test(n))
  const ui = join(FIXTURES, 'ui')
  const uiClasses = uiClassNames(ui)
  // Rule 6, second half: the classes the fixture feature code hands to the stand-in ui/ components in passed/ui.
  const passedDir = join(FIXTURES, 'passed')
  const passedNames = new Set(uiExports(join(passedDir, 'ui', 'index.ts')))
  const passed = passedClassesIn(passedDir, passedNames, (f) => f.includes('/ui/'))

  it.each(fixtures)('%s', (name) => {
    const file = join(FIXTURES, name)
    const source = readFileSync(file, 'utf8')
    const want = expected(source)
    expect(Object.keys(want).length).toBeGreaterThan(0)
    const findings = name.endsWith('.css') ? scanCss(name, source, uiClasses, false, name.startsWith('rule6-passed') ? passed : new Set()) : scanScript(name, source)
    expect(tally(findings, Object.keys(want))).toEqual(want)
  })

  it('rule 6 knows ui/ classes from its stylesheets', () => {
    expect([...uiClasses].sort()).toEqual(['btn', 'primary', 'tag'])
    expect(subjectClasses('.sidebar .btn:hover')).toEqual(['btn'])
    expect(subjectClasses('.btn .label')).toEqual(['label'])
    expect(subjectClasses('.row:not(.btn) > span.tag')).toEqual(['tag'])
  })

  it('rule 6 collects the classes feature TSX passes to ui/ components, whole words only', () => {
    expect([...passedNames].sort()).toEqual(['ActionRow', 'Menu', 'Pressable'])
    // className (literal, conditional, template), triggerClassName and panelClassName, and className in primaryProps.
    expect([...passed].sort()).toEqual(['card-pick', 'fixed-word', 'menu-panel', 'menu-trigger', 'pick-a', 'pick-b', 'row', 'row-main'])
    // A plain element's class, the word glued to ${…} and a locally defined component's class are not ui/ markup.
    for (const c of ['plain-div', 'tpl-', 'tpl-true', 'shadowed']) expect(passed.has(c), c).toBe(false)
    const found = scanCss('x.css', '.card-pick { color: var(--text); }', uiClasses, false, passed)
    expect(found.map((f) => [f.rule, f.what])).toEqual([[6, 'color on .card-pick (passed to a ui/ component)']])
  })

  it('rule 8 needs a doc heading for every component ui/index.ts exports', () => {
    const exports = uiExports(join(ui, 'index.ts'))
    expect(exports.sort()).toEqual(['Button', 'Tag'])
    expect(undocumented(exports, readFileSync(join(FIXTURES, 'design-system.md'), 'utf8'))).toEqual(['Tag'])
  })

  it('named exceptions cover only what they name', () => {
    const file = `${RENDERER}/components/AutoReview.tsx`
    const inDetails: Finding = { rule: 1, file, line: 1, what: '<summary> in <details class="ar-prompt">' }
    const other: Finding = { rule: 1, file, line: 2, what: '<button>' }
    expect(applyExceptions([inDetails, other])).toEqual({ counted: [other], excused: [inDetails] })
    for (const e of EXCEPTIONS) expect(existsSync(e.file), e.file).toBe(true)
  })

  it('rule 9 never judges ui/ itself', () => {
    expect(scanCss('ui/x.css', '.panel { background: var(--bg); border: 1px solid var(--border-strong); }', null, true)).toEqual([])
    expect(scanScript('ui/X.tsx', 'export const X = () => <div style={{ background: "var(--bg)" }} />', true)).toEqual([])
  })

  it('rule 9 says what to do instead', () => {
    const over = overBaseline({ 'a.css': { 9: 3 }, 'b.css': { 9: 1 } }, { 'a.css': { 9: 2 } })
    expect(over).toHaveLength(2)
    expect(failure(over)).toContain(
      'New look outside the design system. Reuse a component from src/renderer/src/ui/, or add one there first (component, tests, doc section in docs/design-system.md) and use it. See AGENTS.md.'
    )
    expect(failure(overBaseline({ 'a.tsx': { 1: 1 } }, {}))).not.toContain('New look')
  })

  it('rule 9 lets the named content exceptions through and nothing else in their files', () => {
    const tour = `${RENDERER}/components/tour.css`
    const card: Finding = { rule: 9, file: tour, line: 1, what: 'background: var(--bg-raised)', scope: '.tour-card' }
    const other: Finding = { rule: 9, file: tour, line: 2, what: 'background: var(--bg-raised)', scope: '.tour-new-thing' }
    const mixed: Finding = { rule: 9, file: tour, line: 3, what: 'border: 1px solid var(--border)', scope: '.tour-card, .tour-button' }
    expect(applyExceptions([card, other, mixed])).toEqual({ counted: [other, mixed], excused: [card] })
    const editor = `${RENDERER}/components/files.css`
    const block: Finding = { rule: 9, file: editor, line: 1, what: 'outline: none', scope: '.md-rich .md-block' }
    const toolbar: Finding = { rule: 9, file: editor, line: 2, what: 'background: var(--bg)', scope: '.md-toolbar' }
    expect(applyExceptions([block, toolbar])).toEqual({ counted: [toolbar], excused: [block] })
  })

  it('the ratchet lets counts fall and stops them rising', () => {
    const baseline = { 'a.tsx': { 1: 2 } }
    expect(overBaseline({ 'a.tsx': { 1: 1 } }, baseline)).toEqual([])
    expect(overBaseline({ 'a.tsx': { 1: 3 } }, baseline)).toHaveLength(1)
    expect(overBaseline({ 'a.tsx': { 2: 1 } }, baseline)).toHaveLength(1)
    expect(overBaseline({ 'b.tsx': { 1: 1 } }, baseline)).toHaveLength(1)
  })
})

describe('design-system guard: src/renderer/src', () => {
  it('no (file, rule) count is above the baseline', () => {
    const { counted, excused } = applyExceptions(scanRenderer())
    const now = countByFile(counted)
    const baseline: Counts = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
    const over = overBaseline(now, baseline)
    if (process.env.DS_REPORT) writeFileSync(process.env.DS_REPORT, `${JSON.stringify({ counted, excused }, null, 2)}\n`)
    const total = (c: Counts, rule: number) => Object.values(c).reduce((n, r) => n + (r[rule] ?? 0), 0)
    console.log(
      `Design-system guard (rule: now / baseline): ${Object.keys(RULES)
        .map((r) => `${r}: ${total(now, Number(r))}/${total(baseline, Number(r))}`)
        .join(', ')}; ${excused.length} allowed by name.`
    )
    if (process.env.UPDATE_DS_BASELINE === '1') {
      // Written down only when nothing went up (or when there is none yet); a rise is fixed in the code, never here.
      if (existsSync(BASELINE)) expect(over, 'counts went up; the baseline is not rewritten upward').toEqual([])
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    expect(over, failure(over)).toEqual([])
  })
})
