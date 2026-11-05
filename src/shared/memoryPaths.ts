// Which changed paths are an agent's memory (docs/loops-and-graphs.md, "Memory graph"): the files an agent reads at the
// start of every turn and can rewrite, so a turn whose delta touches one wrote to what the next turn (and the next run)
// starts from. Pure: the flow service marks a step's memory writes with it, and the memory lens draws them.

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * Whether `path` (relative to the workspace, as a turn's delta names it) is an agent memory file: CLAUDE.md (or
 * CLAUDE.local.md) anywhere, anything under the repository's `.claude/`, AGENTS.md anywhere, and any file the agent's
 * context breakdown named as a memory file (those may be absolute; one that ends with this path is the same file).
 */
export function isMemoryPath(path: string, memoryFiles: readonly string[] = []): boolean {
  const p = slashes(path.trim())
  if (!p) return false
  const name = base(p)
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'AGENTS.md') return true
  if (p.startsWith('.claude/')) return true
  return memoryFiles.some((file) => {
    const f = slashes(file)
    return f === p || f.endsWith(`/${p}`)
  })
}

/** A memory file's path as a label: its last two parts ("docs/CLAUDE.md", ".claude/settings.json"). */
export function memoryLabel(path: string): string {
  const parts = slashes(path).split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}
