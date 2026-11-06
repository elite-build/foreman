// Scoped writes (docs/loops-and-graphs.md, "Personas: who a step is"): a flow persona's `writes` is enforced by Foreman,
// not the prompt. A file tool inside the globs is allowed, one elsewhere refused naming the area, a shell refused; each
// refusal is words the agent reads and carries on from, never an approval that stops the run.
import { describe, expect, it } from 'vitest'
import { workspaceRelative, writeScopeDecision } from '../src/shared/permissions'

const ROOT = '/work/repo'
const WRITES = ['docs/features/**']

describe('scoped writes', () => {
  it('allows the file tools inside the globs, relative or absolute', () => {
    expect(writeScopeDecision('Write', { file_path: 'docs/features/search/requirements.md' }, WRITES, ROOT)).toEqual({ allow: true })
    expect(writeScopeDecision('Edit', { file_path: '/work/repo/docs/features/search/design.md' }, WRITES, ROOT)).toEqual({ allow: true })
    expect(writeScopeDecision('MultiEdit', { file_path: './docs/features/a/b/c.md' }, WRITES, ROOT)).toEqual({ allow: true })
    expect(writeScopeDecision('NotebookEdit', { notebook_path: 'docs/features/x/notes.ipynb' }, WRITES, ROOT)).toEqual({ allow: true })
  })

  it('refuses them anywhere else, naming the allowed area, without stopping the turn', () => {
    for (const file_path of ['src/main/index.ts', '/work/repo/docs/guide.md', '/etc/passwd', '../other/docs/features/a.md', 'docs/features/../../src/x.ts']) {
      const decided = writeScopeDecision('Edit', { file_path }, WRITES, ROOT)
      expect(decided).toMatchObject({ allow: false })
      const message = decided && !decided.allow ? decided.message : ''
      expect(message).toContain('may only write inside docs/features/**')
      // Words for the agent to carry on from: nothing in them stops the run.
      expect(message).toContain('Carry on')
    }
    expect(writeScopeDecision('Write', {}, WRITES, ROOT)).toMatchObject({ allow: false })
  })

  it('refuses every shell, since a command can write anywhere', () => {
    for (const tool of ['Bash', 'PowerShell']) {
      const decided = writeScopeDecision(tool, { command: 'echo hi > docs/features/a.md' }, WRITES, ROOT)
      expect(decided).toMatchObject({ allow: false, message: expect.stringContaining('so it has no shell') })
    }
  })

  it('leaves every other tool to the turn’s approval policy', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'mcp__foreman__report']) expect(writeScopeDecision(tool, { file_path: 'src/a.ts' }, WRITES, ROOT)).toBeNull()
  })

  it('reads Windows paths without case, and a glob with no slash at any depth', () => {
    expect(writeScopeDecision('Write', { file_path: 'C:\\Work\\Repo\\docs\\features\\a.md' }, WRITES, 'c:\\work\\repo')).toEqual({ allow: true })
    expect(writeScopeDecision('Write', { file_path: 'notes/today.md' }, ['*.md'], ROOT)).toEqual({ allow: true })
    expect(workspaceRelative('/work/repo', ROOT)).toBeNull()
    expect(workspaceRelative('/work/repository/a.md', ROOT)).toBeNull()
    expect(workspaceRelative('a/./b/../c.md', ROOT)).toBe('a/c.md')
  })
})
