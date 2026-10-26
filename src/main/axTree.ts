// Pure helpers for the screenshot harness's accessibility-tree capture (src/main/screenshots.ts). Kept free of Electron so
// tests can feed them recorded DevTools output. See layer 4.

/** One node of the DevTools `Accessibility.getFullAXTree` result (only the fields we read). */
export interface CdpAxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  parentId?: string
}

/** The reduced form written to `<screen>.ax.json`: small and stable, so a diff between two runs stays readable. */
export interface AxNode {
  role: string
  name: string
  level?: number
  focusable?: true
  children: AxNode[]
}

// Roles that carry no structure for a reader. Text runs are dropped too: their content already shows up in the name of
// the element that owns it, and keeping them would make every wording change a pile of added/removed lines.
const SKIPPED_ROLES = new Set(['generic', 'none', 'presentation', 'Ignored', 'StaticText', 'InlineTextBox', 'LineBreak'])

const property = (node: CdpAxNode, name: string): unknown => node.properties?.find((p) => p.name === name)?.value?.value

/** Flat protocol nodes to a tree of the nodes that matter. Skipped nodes disappear and their children move up a level. */
export function reduceAxTree(nodes: readonly CdpAxNode[]): AxNode[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const seen = new Set<string>()
  const visit = (node: CdpAxNode): AxNode[] => {
    if (seen.has(node.nodeId)) return []
    seen.add(node.nodeId)
    const children = (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id)
      return child ? visit(child) : []
    })
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    if (node.ignored || !role || SKIPPED_ROLES.has(role)) return children
    const reduced: AxNode = { role, name: typeof node.name?.value === 'string' ? node.name.value.trim() : '', children }
    const level = property(node, 'level')
    if (typeof level === 'number') reduced.level = level
    if (property(node, 'focusable') === true) reduced.focusable = true
    return [reduced]
  }
  // Roots are the nodes nothing lists as a child (normally just the web area).
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId))
  return roots.flatMap(visit)
}

/** Every node in document order. */
export function flattenAx(tree: readonly AxNode[]): AxNode[] {
  return tree.flatMap((node) => [node, ...flattenAx(node.children)])
}

export interface AxReport {
  /** Focusable elements a screen reader would announce with no name. */
  unnamedFocusable: { role: string }[]
  /** A heading that jumps more than one level below the previous heading in document order. */
  headingSkips: { from: number; to: number; name: string }[]
  mainCount: number
}

const ROOT_ROLES = new Set(['RootWebArea', 'WebArea'])
// A table row or cell has no name of its own: a reader speaks its cells, so a focused diff row is fine without one.
const CONTENT_ROLES = new Set(['row', 'cell', 'gridcell', 'rowheader', 'columnheader'])

export function checkAxTree(tree: readonly AxNode[]): AxReport {
  const nodes = flattenAx(tree)
  const unnamedFocusable = nodes.filter((n) => n.focusable && !n.name && !ROOT_ROLES.has(n.role) && !CONTENT_ROLES.has(n.role)).map((n) => ({ role: n.role }))
  const headingSkips: AxReport['headingSkips'] = []
  let previous: number | null = null
  for (const node of nodes) {
    if (node.role !== 'heading' || node.level === undefined) continue
    // The first heading on a screen can start at any level (a panel may open at h2); only later jumps are skips.
    if (previous !== null && node.level > previous + 1) headingSkips.push({ from: previous, to: node.level, name: node.name })
    previous = node.level
  }
  return { unnamedFocusable, headingSkips, mainCount: nodes.filter((n) => n.role === 'main').length }
}

/** The report as human-readable warnings; empty when the screen is clean. */
export function axWarnings(report: AxReport): string[] {
  const warnings: string[] = []
  if (report.unnamedFocusable.length) {
    const roles = new Map<string, number>()
    for (const { role } of report.unnamedFocusable) roles.set(role, (roles.get(role) ?? 0) + 1)
    warnings.push(`${report.unnamedFocusable.length} focusable without a name (${[...roles].map(([role, n]) => `${role} x${n}`).join(', ')})`)
  }
  for (const skip of report.headingSkips) warnings.push(`heading level skips from h${skip.from} to h${skip.to}${skip.name ? `: "${skip.name}"` : ''}`)
  if (report.mainCount !== 1) warnings.push(`${report.mainCount} main landmarks (expected 1)`)
  return warnings
}

export interface AxDiff {
  added: string[]
  removed: string[]
}

const key = (n: AxNode) => (n.name ? `${n.role} "${n.name}"` : n.role)

/** Nodes present in `b` but not `a` (added) and the reverse (removed), as `role "name"`; counted as a multiset, so a second identical button is an addition. */
export function diffAxTrees(a: readonly AxNode[], b: readonly AxNode[]): AxDiff {
  const count = (tree: readonly AxNode[]) => {
    const counts = new Map<string, number>()
    for (const node of flattenAx(tree)) counts.set(key(node), (counts.get(key(node)) ?? 0) + 1)
    return counts
  }
  const ca = count(a)
  const cb = count(b)
  const surplus = (from: Map<string, number>, other: Map<string, number>) =>
    [...from].flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (other.get(k) ?? 0)) }, () => k)).sort()
  return { added: surplus(cb, ca), removed: surplus(ca, cb) }
}
