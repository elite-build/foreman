// What Claude Code's "always allow" adds, in words the approval card can name (docs/agents.md 8): its permission
// suggestions are the rules Foreman passes back when the person chooses it, so the card names exactly those.
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { commandRule } from '../../../shared/commandParts'

/** The scope as the card shows it: one line, cut at 80 characters (as ACP's). */
const shown = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text)

const toolLabel = (toolName: string) => toolName.replace(/^mcp__[^_]+__/, '')

/**
 * From the suggestions always-allow would add: `alwaysScope`, what the button names (`npm test`, `github.com`, a folder),
 * and `alwaysRules`, the Bash rules as Claude Code writes them (`npm test:*`), for the card to say which parts of a command
 * they cover. A mode change alone names nothing.
 */
export function alwaysAllowScope(updates: readonly PermissionUpdate[] | undefined): { alwaysScope?: string; alwaysRules?: string[] } {
  const names: string[] = []
  const rules: string[] = []
  for (const update of updates ?? []) {
    if ((update.type === 'addRules' || update.type === 'replaceRules') && update.behavior === 'allow') {
      for (const rule of update.rules) {
        const content = rule.ruleContent?.trim()
        if (rule.toolName === 'Bash' && content) {
          rules.push(content)
          names.push(commandRule(content).command)
        } else if (content) names.push(content.replace(/^domain:/, ''))
        else names.push(toolLabel(rule.toolName))
      }
    } else if (update.type === 'addDirectories') names.push(...update.directories)
  }
  const unique = [...new Set(names.filter(Boolean))]
  return {
    ...(unique.length ? { alwaysScope: shown(unique.join(', ')) } : {}),
    ...(rules.length ? { alwaysRules: rules } : {})
  }
}
