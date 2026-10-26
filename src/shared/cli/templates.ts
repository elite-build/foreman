// Parameters and results of the template methods. The older `templates` method (slug, name,
// placeholders) stays as it is; these return richer rows. Each result has a `text` the command prints unless --json is given.
import type { EffortLevel } from '../agents'

export interface TemplateRow {
  // What `foreman run <template>` takes: the name's slug, or `repo:<slug>` for a repository template a personal one shadows.
  slug: string
  id: string
  name: string
  placeholders: string[]
  source: 'personal' | 'repo'
  // Repository templates: the repository, and the file in it (read-only here).
  repo?: string
  file?: string
  startModel?: { agent: string; model: string; effort?: EffortLevel }
  followUp?: { title: string; model?: { agent: string; model: string; effort?: EffortLevel; fast: boolean } }
}

export interface TemplatesListParams {
  // Where the command ran: picks the repository whose own templates join yours.
  cwd?: string
}

export interface TemplatesListResult {
  templates: TemplateRow[]
  text: string
}

export interface TemplatesShowParams {
  // Slug, name, id or `repo:<slug>`.
  template: string
  cwd?: string
}

export interface TemplatesShowResult {
  template: TemplateRow
  body: string
  // The follow-up's prompt, when it has one.
  followUpPrompt?: string
  text: string
}

export interface TemplateModelParams {
  agent: string
  model: string
  effort?: EffortLevel
  fast?: boolean
}

export interface TemplateFollowUpParams {
  title?: string
  prompt?: string
  // The model the follow-up opens with; null: the chat's own model.
  model?: TemplateModelParams | null
}

export interface TemplatesAddParams {
  name: string
  body: string
  startModel?: TemplateModelParams
  followUp?: TemplateFollowUpParams
}

export interface TemplatesEditParams {
  template: string
  cwd?: string
  name?: string
  body?: string
  startModel?: TemplateModelParams
  clearStartModel?: boolean
  followUp?: TemplateFollowUpParams
  clearFollowUp?: boolean
}

export interface TemplatesRemoveParams {
  template: string
  cwd?: string
}

export interface TemplateChangeResult {
  template: TemplateRow
  // What the change affects besides the template (schedules that will pause for re-approval, a model that wasn't checked).
  notes: string[]
  text: string
}

export interface TemplatesRemoveResult {
  removed: TemplateRow
  notes: string[]
  text: string
}
