// Parameters and results of the persona methods (`foreman persona …`, docs/loops-and-graphs.md, "Personas: who a step
// is"). Each result has a `text` the command prints unless --json is given. Type-only imports.
import type { PersonaSource } from '../personas'

export interface PersonaRow {
  // 'built-in:<name>', 'repo:<repoId>:<file>', 'claude-agents:<repoId>:<file>', or a personal persona's id.
  id: string
  name: string
  source: PersonaSource
  repo?: string
  repoId?: string
  file?: string
  // A repository file's git blob SHA; a personal persona's last save.
  rev?: string
  description?: string
  readOnly: boolean
  loadout?: number
  agent?: string
  model?: string
  shows: string[]
  endsWith: string[]
  // The MCP servers it keeps; absent: every one the repository and integrations give.
  mcp?: string[]
  // Another persona of the same name a step uses instead (yours over the repository's over the built-in one).
  shadowedBy?: string
  problems: string[]
  warnings: string[]
}

export interface PersonaListParams {
  repo?: string
  cwd: string
}

export interface PersonaListResult {
  personas: PersonaRow[]
  repo?: string
  text: string
}

export interface PersonaShowParams {
  // A persona's name, id or file name.
  persona: string
  repo?: string
  cwd: string
}

export interface PersonaShowResult {
  persona: PersonaRow
  markdown: string
  // The flows that name it.
  usedBy: string[]
  text: string
}

export interface PersonaAddParams {
  markdown: string
}

export interface PersonaAddResult {
  saved: boolean
  persona?: PersonaRow
  problems?: string[]
  text: string
}

export interface PersonaRemoveParams {
  persona: string
}

export interface PersonaRemoveResult {
  removed: PersonaRow
  text: string
}
