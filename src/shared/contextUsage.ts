// What fills an agent's context window, kept on the chat for the composer's context popover. Claude's SDK says
// (query.getContextUsage()); the other agents report a total only, which needs nothing from here.
import type { ContextBreakdown, ContextCategoryKind, ContextUsage } from './types'

/** Rows kept per list: enough to see what's big, small enough that every chat can carry it. */
export const CONTEXT_ROWS = 30

/** The parts of the Claude Agent SDK's `getContextUsage()` answer that Foreman reads. */
export interface ClaudeContextReport {
  categories?: { name: string; tokens: number; kind?: ContextCategoryKind; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  memoryFiles?: { path: string; tokens: number }[]
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  skills?: { skillFrontmatter?: { name: string; tokens: number }[] }
}

const biggestFirst = <T extends { tokens: number }>(rows: T[]): T[] => rows.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, CONTEXT_ROWS)

/** Claude's report as the chat's context usage, with its breakdown when it has one; nothing when it gives no window size. */
export function claudeContextUsage(report: ClaudeContextReport): ContextUsage | undefined {
  if (!(report.maxTokens > 0)) return undefined
  if (!report.categories?.length) return { used: report.totalTokens, limit: report.maxTokens }
  const servers = new Map<string, { name: string; tools: number; tokens: number; deferred: boolean }>()
  for (const tool of report.mcpTools ?? []) {
    const server = servers.get(tool.serverName) ?? { name: tool.serverName, tools: 0, tokens: 0, deferred: true }
    server.tools++
    server.tokens += tool.tokens
    if (tool.isLoaded !== false) server.deferred = false
    servers.set(tool.serverName, server)
  }
  const breakdown: ContextBreakdown = {
    // An older SDK has no `kind`; its deferred rows say so with isDeferred.
    categories: report.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind ?? (c.isDeferred ? 'deferred' : 'used') })),
    mcpServers: biggestFirst([...servers.values()]),
    memoryFiles: biggestFirst((report.memoryFiles ?? []).map((f) => ({ path: f.path, tokens: f.tokens }))),
    skills: biggestFirst((report.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, tokens: s.tokens })))
  }
  return { used: report.totalTokens, limit: report.maxTokens, breakdown }
}
