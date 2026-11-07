// A flow document as lines (docs/loops-and-graphs.md): where each step's and loop's table sits, which step a line is in,
// the line a problem names, and the document split into coloured runs for a code view. The flow studio links its graph
// and its TOML through these: a step selected on the graph highlights its block, the caret in a block selects its step.
// Pure, and forgiving: a document that doesn't parse still has lines.

export interface FlowTomlRange {
  // 1-based, both included.
  from: number
  to: number
}

export interface FlowTomlBlocks {
  steps: Record<string, FlowTomlRange>
  loops: Record<string, FlowTomlRange>
}

const HEADER = /^\s*\[([^\]]+)\]\s*(#.*)?$/
const NAME = /^(steps|loops)\.("?)([A-Za-z0-9][\w-]*)\2$/

/** Each [steps.<name>] and [loops.<name>] table's lines, from its header to its last line that isn't blank. */
export function flowTomlBlocks(toml: string): FlowTomlBlocks {
  const lines = toml.split(/\r?\n/)
  const blocks: FlowTomlBlocks = { steps: {}, loops: {} }
  let open: { kind: 'steps' | 'loops'; name: string; from: number } | null = null
  let last = 0
  const close = () => {
    if (open) blocks[open.kind][open.name] = { from: open.from, to: Math.max(open.from, last) }
    open = null
  }
  lines.forEach((line, i) => {
    const n = i + 1
    const header = HEADER.exec(line)
    if (header) {
      close()
      const name = NAME.exec(header[1].trim())
      if (name) open = { kind: name[1] as 'steps' | 'loops', name: name[3], from: n }
      last = n
      return
    }
    if (line.trim()) last = n
  })
  close()
  return blocks
}

/** The step whose table holds `line`, if any. */
export function stepAtLine(toml: string, line: number): string | undefined {
  const { steps } = flowTomlBlocks(toml)
  return Object.entries(steps).find(([, r]) => line >= r.from && line <= r.to)?.[0]
}

/** The line (and column) a problem's text names ("… at line 4, column 9"), or the line of the step it names. */
export function problemLine(problem: string, toml: string): { line: number; column?: number } | undefined {
  const at = /line (\d+)(?:,? column (\d+))?/i.exec(problem)
  if (at) return { line: Number(at[1]), ...(at[2] ? { column: Number(at[2]) } : {}) }
  const { steps, loops } = flowTomlBlocks(toml)
  const quoted = [...problem.matchAll(/[“"']([A-Za-z0-9][\w-]*)[”"']/g)].map((m) => m[1])
  for (const name of quoted) {
    if (steps[name]) return { line: steps[name].from }
    if (loops[name]) return { line: loops[name].from }
  }
  return undefined
}

export type FlowTomlTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'title' | 'property'
export interface FlowTomlToken {
  text: string
  kind?: FlowTomlTokenKind
}

const TOKEN = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(#.*$)|(\b(?:true|false)\b)|(-?\b\d[\d_]*(?:\.\d+)?\b)/g

/** One line as coloured runs that join back to it exactly: a table header, a key, strings, numbers, booleans, a comment. */
export function tokenizeFlowToml(line: string): FlowTomlToken[] {
  if (HEADER.test(line)) {
    const comment = line.indexOf('#', line.indexOf(']'))
    return comment > 0 ? [{ text: line.slice(0, comment), kind: 'title' }, { text: line.slice(comment), kind: 'comment' }] : [{ text: line, kind: 'title' }]
  }
  const out: FlowTomlToken[] = []
  let rest = line
  const key = /^(\s*)([A-Za-z0-9_.-]+|"[^"]*")(\s*=)/.exec(line)
  if (key) {
    if (key[1]) out.push({ text: key[1] })
    out.push({ text: key[2], kind: 'property' })
    out.push({ text: key[3] })
    rest = line.slice(key[0].length)
  }
  let at = 0
  for (const m of rest.matchAll(TOKEN)) {
    if (m.index! > at) out.push({ text: rest.slice(at, m.index) })
    out.push({ text: m[0], kind: m[1] ? 'string' : m[2] ? 'comment' : m[3] ? 'keyword' : 'number' })
    at = m.index! + m[0].length
  }
  if (at < rest.length) out.push({ text: rest.slice(at) })
  return out.length ? out : [{ text: line }]
}
