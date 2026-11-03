// What fills Claude's context window, from the SDK's getContextUsage() answer to what a chat keeps for its popover.
import { describe, expect, it } from 'vitest'
import { CONTEXT_ROWS, claudeContextUsage } from '../src/shared/contextUsage'

describe('claudeContextUsage', () => {
  it('keeps nothing without a window size, and the totals alone without categories', () => {
    expect(claudeContextUsage({ totalTokens: 10, maxTokens: 0 })).toBeUndefined()
    expect(claudeContextUsage({ totalTokens: 10, maxTokens: 100 })).toEqual({ used: 10, limit: 100 })
  })

  it('keeps the categories in order, MCP tools by server, and the biggest memory files and skills first', () => {
    const usage = claudeContextUsage({
      totalTokens: 156_000,
      maxTokens: 1_000_000,
      categories: [
        { name: 'Messages', tokens: 84_200, kind: 'used' },
        { name: 'Free space', tokens: 810_000, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        // An older SDK: no kind, only isDeferred.
        { name: 'MCP tools (deferred)', tokens: 350_400, isDeferred: true },
        { name: 'System prompt', tokens: 12_100 }
      ],
      mcpTools: [
        { serverName: 'linear', name: 'save_issue', tokens: 2100 },
        { serverName: 'rea', name: 'open_binary', tokens: 900, isLoaded: false },
        { serverName: 'linear', name: 'get_issue', tokens: 900, isLoaded: false },
        { serverName: 'rea', name: 'xrefs', tokens: 800, isLoaded: false }
      ],
      memoryFiles: [
        { path: '/repo/CLAUDE.md', tokens: 16 },
        { path: '/repo/AGENTS.md', tokens: 10_200 },
        { path: '/repo/EMPTY.md', tokens: 0 }
      ],
      skills: { skillFrontmatter: [{ name: 'tdd', tokens: 700 }, { name: 'create-pr', tokens: 1200 }] }
    })
    expect(usage?.used).toBe(156_000)
    expect(usage?.limit).toBe(1_000_000)
    expect(usage?.breakdown?.categories.map((c) => [c.name, c.kind])).toEqual([
      ['Messages', 'used'],
      ['Free space', 'free'],
      ['Autocompact buffer', 'buffer'],
      ['MCP tools (deferred)', 'deferred'],
      ['System prompt', 'used']
    ])
    // A server is deferred only when none of its tools is loaded.
    expect(usage?.breakdown?.mcpServers).toEqual([
      { name: 'linear', tools: 2, tokens: 3000, deferred: false },
      { name: 'rea', tools: 2, tokens: 1700, deferred: true }
    ])
    expect(usage?.breakdown?.memoryFiles.map((f) => f.path)).toEqual(['/repo/AGENTS.md', '/repo/CLAUDE.md'])
    expect(usage?.breakdown?.skills.map((s) => s.name)).toEqual(['create-pr', 'tdd'])
  })

  it('keeps at most CONTEXT_ROWS of each list', () => {
    const skillFrontmatter = Array.from({ length: CONTEXT_ROWS + 5 }, (_, i) => ({ name: `skill-${i}`, tokens: i + 1 }))
    const usage = claudeContextUsage({ totalTokens: 1, maxTokens: 10, categories: [{ name: 'Skills', tokens: 1, kind: 'used' }], skills: { skillFrontmatter } })
    expect(usage?.breakdown?.skills).toHaveLength(CONTEXT_ROWS)
    expect(usage?.breakdown?.skills[0].name).toBe(`skill-${CONTEXT_ROWS + 4}`)
  })
})
