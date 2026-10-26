import { z } from 'zod'

export const FOREMAN_CLI_TOOL = {
  name: 'run_foreman',
  description: 'CLI escape hatch. Prefer dedicated Foreman tools whenever they cover the task. Pass words after foreman, never a shell command. Workspace agents may use help and read-only settings list/get/keys/search/path queries; sensitive values, settings writes and other commands are unavailable here. This fallback does not imply dedicated MCP coverage.',
  readOnly: true,
  schema: z.object({ args: z.array(z.string().max(1000)).min(1).max(40) }).strict()
} as const

// Reviewed runner/request pairs. A CLI command changing its request must be
// reviewed before it gains access through the workspace MCP escape hatch.
export const MCP_CLI_READ_COMMANDS: Readonly<Record<string, string>> = {
  'settings list': 'settings-list',
  'settings get': 'settings-get',
  'settings keys': 'settings-keys',
  'settings search': 'settings-search',
  'settings path': 'settings-path'
}

export const CLI_DEDICATED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  new: ['start_task'],
  send: ['send_task'],
  wait: ['wait_for_turn'],
  cancel: ['cancel_turn'],
  checks: ['run_checks', 'get_check_results']
}
