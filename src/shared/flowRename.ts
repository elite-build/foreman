// Renaming inside a flow document (docs/loops-and-graphs.md): the flow's own name and description, and a step, whose
// name every edge, loop, context source, same_tab, workspace `from` and pick `over` that names it follows. The TOML is
// rewritten as text, so its comments and layout stay as written; a rename the text can't follow exactly (checked by
// reading the document again) is refused rather than half done. Pure.
import { FLOW_DONE, parseFlow, STEP_NAME, type Flow, type FlowEdge, type FlowStep } from './flows'

/** One place a step rename changes: its own table, or another part of the flow that names it. */
export interface StepRenamePlace {
  // 1-based.
  line: number
  kind: 'step' | 'start' | 'exits' | 'edge' | 'loop-over' | 'loop-then' | 'context' | 'show' | 'same-tab' | 'workspace-from' | 'pick-over'
  // The step or loop the place belongs to (by its new name), when it isn't the renamed step itself.
  owner?: string
}

export type StepRenameProblem = 'empty' | 'chars' | 'done' | 'taken' | 'unchanged' | 'unreadable'
export type StepRename = { toml: string; places: StepRenamePlace[] } | { problem: StepRenameProblem }

/** Why `to` can't be the new name of step `from` in `flow`, if it can't. */
export function stepNameProblem(flow: Flow, from: string, to: string): StepRenameProblem | undefined {
  if (!to) return 'empty'
  if (to === from) return 'unchanged'
  if (to === FLOW_DONE) return 'done'
  if (!STEP_NAME.test(to)) return 'chars'
  if (flow.steps.some((s) => s.name === to)) return 'taken'
  return undefined
}

/** `toml` with step `from` called `to` everywhere the flow names it, and the places that changed. */
export function renameStep(toml: string, from: string, to: string): StepRename {
  const before = parseFlow(toml, 'personal')
  if (!('flow' in before) || !before.flow.steps.some((s) => s.name === from)) return { problem: 'unreadable' }
  const problem = stepNameProblem(before.flow, from, to)
  if (problem) return { problem }
  const picks = new Set(before.flow.steps.filter((s) => s.kind === 'pick').map((s) => s.name))
  const { text, places } = rewrite(toml, from, to, picks)
  const after = parseFlow(text, 'personal')
  if (!('flow' in after) || JSON.stringify(after.flow) !== JSON.stringify(renamedFlow(before.flow, from, to))) return { problem: 'unreadable' }
  return { toml: text, places }
}

/** The flow as it reads once step `from` is called `to`: what the rewritten text must read as. */
export function renamedFlow(flow: Flow, from: string, to: string): Flow {
  const swap = (s: string) => (s === from ? to : s)
  // "fix.answer" names step fix; a gate's file path (it has a slash) names none.
  const swapRef = (r: string) => (r.startsWith(`${from}.`) && !r.includes('/') ? `${to}${r.slice(from.length)}` : r)
  const steps = flow.steps.map((step) => {
    const out = { ...step, name: swap(step.name) } as FlowStep & Record<string, unknown>
    if (Array.isArray(out.context)) out.context = (out.context as string[]).map(swapRef)
    if (out.kind === 'gate' && out.show) out.show = out.show.map(swapRef)
    if (out.kind === 'turn' && out.same_tab) out.same_tab = swap(out.same_tab)
    if (out.kind === 'workspace' && out.from) out.from = swap(out.from)
    if (out.kind === 'pick') out.over = out.over.map(swap)
    return out as FlowStep
  })
  // A pick step's facts are the steps it picks among, so its edges' keys are step names too.
  const picks = new Set(flow.steps.filter((s) => s.kind === 'pick').map((s) => s.name))
  const edges = Object.fromEntries(
    Object.entries(flow.edges).map(([key, edge]): [string, FlowEdge] => [swap(key), typeof edge === 'string' ? swap(edge) : Object.fromEntries(Object.entries(edge).map(([fact, next]) => [picks.has(key) ? swap(fact) : fact, swap(next)]))])
  )
  const loops = flow.loops.map((loop) => ({ ...loop, over: loop.over.map(swap), ...(loop.then !== undefined ? { then: swap(loop.then) } : {}) }))
  return { ...flow, start: swap(flow.start), steps, edges, loops }
}

/** `toml` with its top-level `name` or `description` set to `value` (an empty description removes the line). */
export function setFlowText(toml: string, key: 'name' | 'description', value: string): string {
  const lines = toml.split('\n')
  const top = topLevelKey(lines, key)
  const written = `${key} = ${tomlString(value)}`
  if (top) {
    const line = lines[top.from]
    const single = top.from === top.to ? new RegExp(`^(\\s*${key}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(.*)$`).exec(line) : null
    if (key === 'description' && !value) lines.splice(top.from, top.to - top.from + 1)
    else if (single) lines[top.from] = `${single[1]}${tomlString(value)}${single[3]}`
    else lines.splice(top.from, top.to - top.from + 1, written)
    return lines.join('\n')
  }
  if (key === 'description' && !value) return toml
  const name = key === 'description' ? topLevelKey(lines, 'name') : undefined
  lines.splice(name ? name.to + 1 : 0, 0, written)
  return lines.join('\n')
}

// A TOML basic string: JSON's escapes are TOML's, for the one-line text a name or description is.
const tomlString = (value: string) => JSON.stringify(value.replace(/[\u0000-\u001f\u007f]+/g, ' '))

/** The lines (0-based, both included) of a key = value before the first table, a multi-line string's lines included. */
function topLevelKey(lines: string[], key: string): { from: number; to: number } | undefined {
  const scan = new Scanner()
  for (let i = 0; i < lines.length; i++) {
    if (scan.open) {
      scan.value(lines[i], () => undefined)
      continue
    }
    if (HEADER.test(lines[i])) return undefined
    const kv = KEY.exec(lines[i])
    scan.value(kv ? lines[i].slice(kv[0].length) : '', () => undefined)
    if (kv && unquote(kv[2]) === key) {
      let to = i
      while (scan.open && to + 1 < lines.length) scan.value(lines[++to], () => undefined)
      return { from: i, to }
    }
  }
  return undefined
}

const HEADER = /^\s*\[(?!\[)([^\]]+)\]\s*(#.*)?$/
const KEY = /^(\s*)([A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')(\s*=\s*)/
const unquote = (key: string) => (/^["']/.test(key) ? key.slice(1, -1) : key)

/** A header's dotted parts, quotes kept: `steps."fix"` → ['steps', '"fix"']. */
function headerParts(inner: string): string[] {
  return [...inner.matchAll(/\s*("[^"]*"|'[^']*'|[^.\s"']+)\s*(?:\.|$)/g)].map((m) => m[1])
}

/**
 * Reads values a line at a time: strings (one-line ones handed to `onString` with whether a `=` follows, so an inline
 * table's keys are told from its values), comments, and what carries over to the next line (an array still open, a
 * multi-line string).
 */
class Scanner {
  private depth = 0
  private multi: '"""' | "'''" | null = null
  get open(): boolean {
    return this.depth > 0 || this.multi !== null
  }
  /** Scans `text`, returning it with each one-line string replaced by what `onString` gives (or kept). */
  value(text: string, onString: (content: string, isKey: boolean) => string | undefined): string {
    let out = ''
    let i = 0
    if (this.multi) {
      const end = closing(text, 0, this.multi)
      if (end < 0) return text
      out = text.slice(0, end + 3)
      i = end + 3
      this.multi = null
    }
    while (i < text.length) {
      const c = text[i]
      if (c === '#') return out + text.slice(i)
      if (c === '[') this.depth++
      else if (c === ']') this.depth = Math.max(0, this.depth - 1)
      if (c === '"' || c === "'") {
        const triple = text.startsWith(c.repeat(3), i) ? (c.repeat(3) as '"""' | "'''") : null
        if (triple) {
          const end = closing(text, i + 3, triple)
          if (end < 0) {
            this.multi = triple
            return out + text.slice(i)
          }
          out += text.slice(i, end + 3)
          i = end + 3
          continue
        }
        let j = i + 1
        while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1
        const content = text.slice(i + 1, j)
        const isKey = /^\s*=/.test(text.slice(j + 1))
        const next = onString(content, isKey)
        out += next === undefined ? text.slice(i, j + 1) : `${c}${next}${c}`
        i = j + 1
        continue
      }
      out += c
      i++
    }
    return out
  }
}

/** Where a multi-line string that is open at `from` closes, or -1. */
function closing(text: string, from: number, delim: '"""' | "'''"): number {
  for (let i = from; i <= text.length - 3; i++) {
    if (delim === '"""' && text[i] === '\\') {
      i++
      continue
    }
    if (text.startsWith(delim, i)) {
      // Up to two more quotes may end the string's content before its closing three.
      let end = i
      while (text[end + 3] === delim[0] && end < i + 2) end++
      return end
    }
  }
  return -1
}

/**
 * The text rewrite itself: table headers, keys and string values that name the step, in the places a flow reads them.
 * `picks` are the pick steps (by their old names), whose edges are keyed by step names.
 */
function rewrite(toml: string, from: string, to: string, picks: Set<string>): { text: string; places: StepRenamePlace[] } {
  const lines = toml.split('\n')
  const places: StepRenamePlace[] = []
  const scan = new Scanner()
  const exact = (s: string) => (s === from ? to : undefined)
  const prefix = (s: string) => (s.startsWith(`${from}.`) && !s.includes('/') ? `${to}${s.slice(from.length)}` : undefined)
  // An inline table's key that is the step (an edge leaving a pick step): `{ fix = "g" }`, `{ "fix" = "g" }`.
  const inlineKey = new RegExp(`([{,]\\s*)(["']?)${escape(from)}\\2(\\s*=)`, 'g')
  // Which table the line is in: '' before the first, else its dotted parts (unquoted); `edgesOf` is an [edges.<step>]
  // table's step by its old name.
  let table: string[] = []
  let edgesOf = ''
  // How the value being read (on this line or carried over) names steps.
  let mode: { match: (s: string) => string | undefined; kind: StepRenamePlace['kind']; owner?: string } | null = null

  const read = (text: string, n: number): string =>
    scan.value(text, (content, isKey) => {
      if (isKey || !mode) return undefined
      const next = mode.match(content)
      if (next !== undefined) places.push({ line: n, kind: mode.kind, ...(mode.owner ? { owner: mode.owner } : {}) })
      return next
    })

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1
    const line = lines[i]
    if (scan.open) {
      lines[i] = read(line, n)
      if (!scan.open) mode = null
      continue
    }
    const header = HEADER.exec(line)
    if (header) {
      const parts = headerParts(header[1])
      table = parts.map(unquote)
      edgesOf = table[0] === 'edges' && table.length === 2 ? table[1] : ''
      if ((table[0] === 'steps' || table[0] === 'edges') && table[1] === from && parts.length >= 2) {
        const quote = /^["']/.test(parts[1]) ? parts[1][0] : ''
        lines[i] = line.replace(/\[([^\]]+)\]/, (_, inner: string) => `[${inner.replace(new RegExp(`(\\.\\s*)${escape(parts[1])}`), `$1${quote}${to}${quote}`)}]`)
        places.push({ line: n, kind: table[0] === 'steps' ? 'step' : 'exits' })
        table[1] = to
      }
      mode = null
      continue
    }
    const kv = KEY.exec(line)
    if (!kv) {
      lines[i] = read(line, n)
      continue
    }
    const key = unquote(kv[2])
    let head = kv[0]
    let rest = line.slice(kv[0].length)
    const renamedKey = () => `${kv[1]}${/^["']/.test(kv[2]) ? `${kv[2][0]}${to}${kv[2][0]}` : to}${kv[3]}`
    mode = null
    const [section, owner] = table
    if (table.length === 0 && key === 'start') mode = { match: exact, kind: 'start' }
    else if (section === 'start' && table.length === 1 && key === 'step') mode = { match: exact, kind: 'start' }
    else if (section === 'edges' && table.length === 1) {
      if (key === from) {
        head = renamedKey()
        places.push({ line: n, kind: 'exits' })
      }
      if (picks.has(key) && inlineKey.test(rest)) {
        rest = rest.replace(inlineKey, `$1$2${to}$2$3`)
        places.push({ line: n, kind: 'edge', owner: key })
      }
      inlineKey.lastIndex = 0
      mode = { match: exact, kind: 'edge', owner: key === from ? to : key }
    } else if (section === 'edges' && table.length === 2) {
      if (picks.has(edgesOf) && key === from) {
        head = renamedKey()
        places.push({ line: n, kind: 'edge', owner })
      }
      mode = { match: exact, kind: 'edge', owner }
    }
    else if (section === 'steps' && table.length === 2) {
      if (key === 'context') mode = { match: prefix, kind: 'context', owner }
      else if (key === 'show') mode = { match: prefix, kind: 'show', owner }
      else if (key === 'same_tab') mode = { match: exact, kind: 'same-tab', owner }
      else if (key === 'from') mode = { match: exact, kind: 'workspace-from', owner }
      else if (key === 'over') mode = { match: exact, kind: 'pick-over', owner }
    } else if (section === 'loops' && table.length === 2) {
      if (key === 'over') mode = { match: exact, kind: 'loop-over', owner }
      else if (key === 'then') mode = { match: exact, kind: 'loop-then', owner }
    }
    lines[i] = head + read(rest, n)
    if (!scan.open) mode = null
  }
  return { text: lines.join('\n'), places }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
