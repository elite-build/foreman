// "Repo commands" in the template picker (R-2): what .claude/commands and
// .claude/skills offer, for Claude chats only. Picking one only inserts its
// name; nothing is sent.
import type { AgentCapabilities } from './agentCapabilities'
import type { SlashCommandInfo } from './types'

/** Custom commands and skills found on disk, for an agent whose record says it has them (`features.repoCommands`); built-ins are left out. */
export function repoCommands(record: Pick<AgentCapabilities, 'features'> | undefined, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  if (!record?.features.repoCommands) return []
  return commands.filter((c) => c.kind)
}

/** Commands whose name or description holds every word of the query (a leading slash is ignored). */
export function filterCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const words = query.toLowerCase().replace(/^\//, '').split(/\s+/).filter(Boolean)
  return commands.filter((c) => words.every((w) => `${c.name}\n${c.description}`.toLowerCase().includes(w)))
}

/** "/name " for the composer: a trailing space so arguments can follow. */
export const commandText = (c: Pick<SlashCommandInfo, 'name'>): string => `/${c.name} `
