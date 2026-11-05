// Which changed paths are an agent's memory (docs/loops-and-graphs.md, "Memory graph"): the memory lens draws a write edge
// from a step whose changes touch one.
import { describe, expect, it } from 'vitest'
import { isMemoryPath, memoryLabel } from '../src/shared/memoryPaths'

describe('isMemoryPath', () => {
  it('is CLAUDE.md and AGENTS.md anywhere, and anything under the repository’s .claude/', () => {
    for (const path of ['CLAUDE.md', 'packages/api/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'src/AGENTS.md', '.claude/settings.json', '.claude/agents/reviewer.md', './CLAUDE.md', 'docs\\CLAUDE.md'])
      expect(isMemoryPath(path), path).toBe(true)
  })

  it('is not an ordinary file, a look-alike name, or a .claude folder that isn’t the repository’s', () => {
    for (const path of ['src/a.ts', 'README.md', 'claude.md', 'NOT-CLAUDE.md', 'CLAUDE.md.bak', 'docs/.claude/notes.md', 'my.claude/x', '', '   '])
      expect(isMemoryPath(path), path).toBe(false)
  })

  it('is a file the agent’s context breakdown named as memory, absolute or relative, either slash', () => {
    const named = ['/Users/me/work/repo/docs/team-notes.md', 'C:\\work\\repo\\notes\\memory.md']
    expect(isMemoryPath('docs/team-notes.md', named)).toBe(true)
    expect(isMemoryPath('notes/memory.md', named)).toBe(true)
    expect(isMemoryPath('docs/team-notes.md')).toBe(false)
    // Only the whole path: a file whose name merely ends the same way is another file.
    expect(isMemoryPath('s/team-notes.md', named)).toBe(false)
    expect(isMemoryPath('other.md', named)).toBe(false)
  })
})

describe('memoryLabel', () => {
  it('keeps the last two parts of a path', () => {
    expect(memoryLabel('/Users/me/.claude/CLAUDE.md')).toBe('.claude/CLAUDE.md')
    expect(memoryLabel('C:\\work\\repo\\CLAUDE.md')).toBe('repo/CLAUDE.md')
    expect(memoryLabel('CLAUDE.md')).toBe('CLAUDE.md')
  })
})
