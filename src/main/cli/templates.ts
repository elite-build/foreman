// `foreman templates list|show|add|edit|remove`: Automations → Templates from the command line. Your own templates are
// settings (`promptTemplates`) written through `updateSettings`, as the window does; a repository's own templates
// (.foreman/templates) are files in the repository and stay read-only here, refused with the file's path.
import { newTemplateId, templatePlaceholders, templateSlug } from '../../shared/promptTemplates'
import { findLayeredTemplate, qualifiedName } from '../../shared/repoTemplates'
import type { TemplateChangeResult, TemplateFollowUpParams, TemplateModelParams, TemplateRow, TemplatesListResult, TemplatesRemoveResult, TemplatesShowResult } from '../../shared/cli/templates'
import type { AppSnapshot, PromptTemplate, Repo, TemplateFollowUp, TemplateStartModel } from '../../shared/types'
import type { CliHost } from './host'
import { columns, flagParam, invalid, paramsObject, textParam, type MethodDef } from './kit'
import { resolveLoadout } from './agents'
import { ambiguous, firstLine, notFound, plural, refused } from './refs'
import { resolveRepo } from './resolve'

interface Layers {
  snapshot: AppSnapshot
  personal: PromptTemplate[]
  repo?: Repo
  fromRepo: PromptTemplate[]
}

/** Your templates, and those of the repository the command ran in (when it ran in one). */
async function layers(host: CliHost, cwd: string | undefined): Promise<Layers> {
  const snapshot = host.snapshot()
  const personal = snapshot.settings.promptTemplates
  const repo = cwd ? await resolveRepo(snapshot, cwd).catch(() => undefined) : undefined
  return { snapshot, personal, repo, fromRepo: repo ? snapshot.repoTemplates[repo.id] ?? [] : [] }
}

function rowOf(t: PromptTemplate, personal: PromptTemplate[], repos: Repo[]): TemplateRow {
  const isRepo = t.source === 'repo'
  const qualified = isRepo ? qualifiedName(t, personal) : t.name
  const model = t.followUp?.model
  return {
    slug: isRepo && qualified.startsWith('repo:') ? qualified : templateSlug(t.name),
    id: t.id,
    name: t.name,
    placeholders: templatePlaceholders(t.body),
    source: isRepo ? 'repo' : 'personal',
    ...(isRepo ? { repo: repos.find((r) => r.id === t.repoId)?.name ?? t.repoId, ...(t.file ? { file: t.file } : {}) } : {}),
    ...(t.startModel ? { startModel: { agent: t.startModel.agent, model: t.startModel.model, ...(t.startModel.effort ? { effort: t.startModel.effort } : {}) } } : {}),
    ...(t.followUp ? { followUp: { title: t.followUp.title, ...(model ? { model: { agent: model.agent, model: model.model, ...(model.effort ? { effort: model.effort } : {}), fast: model.fast } } : {}) } } : {})
  }
}

const modelText = (m: { agent: string; model: string; effort?: string }): string => `${m.agent} ${m.model}${m.effort ? ` (${m.effort})` : ''}`

/** The one template a command names, from your templates and the repository's. */
function pick(l: Layers, query: string): PromptTemplate {
  const found = findLayeredTemplate(l.personal, l.fromRepo, query)
  if ('error' in found) throw found.error.includes('matches several') ? ambiguous(found.error) : notFound(found.error, '`foreman templates` lists them.')
  return found.template
}

function refuseRepoTemplate(t: PromptTemplate, verb: string, repos: Repo[]): never {
  const repo = repos.find((r) => r.id === t.repoId)
  throw refused(`“${t.name}” is a repository template (${t.file ?? '.foreman/templates'}${repo ? ` in ${repo.name}` : ''}), so it is read-only here. Change it by editing that file${verb === 'remove' ? ' or deleting it' : ''} in the repository.`)
}

/** Schedules (not finished) that run this template: editing or removing it pauses them until re-approved. */
function scheduleNotes(snapshot: AppSnapshot, t: PromptTemplate, change: string): string[] {
  const n = snapshot.schedules.filter((s) => s.templateId === t.id && s.state !== 'finished').length
  return n ? [`${plural(n, 'schedule')} run${n === 1 ? 's' : ''} this template and will pause when ${change}; review and approve ${n === 1 ? 'it' : 'them'} again (\`foreman schedules approve <id>\`).`] : []
}

function startModelOf(host: CliHost, p: TemplateModelParams, notes: string[]): TemplateStartModel {
  const { loadout, note } = resolveLoadout(host, p)
  if (note) notes.push(note)
  return { agent: loadout.agent, model: loadout.model, ...(loadout.effort ? { effort: loadout.effort } : {}) }
}

function modelParams(raw: unknown, name: string): TemplateModelParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${name} must be an object with an agent and a model.`)
  const m = raw as Record<string, unknown>
  const effort = m.effort
  if (effort !== undefined && typeof effort !== 'string') throw invalid(`${name}: effort must be text.`)
  if (m.fast !== undefined && typeof m.fast !== 'boolean') throw invalid(`${name}: fast must be true or false.`)
  return { agent: textParam(m, 'agent'), model: textParam(m, 'model'), ...(effort ? { effort: effort as TemplateModelParams['effort'] } : {}), ...(typeof m.fast === 'boolean' ? { fast: m.fast } : {}) }
}

function followUpOf(host: CliHost, raw: unknown, base: TemplateFollowUp | undefined, notes: string[]): TemplateFollowUp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('followUp must be an object with a title and a prompt.')
  const f = raw as Record<string, unknown> & TemplateFollowUpParams
  const title = (textParam(f, 'title', { optional: true }) ?? base?.title ?? '').trim()
  const prompt = (textParam(f, 'prompt', { optional: true }) ?? base?.prompt ?? '').trim()
  if (!title || !prompt) throw invalid('A follow-up needs a title and a prompt.', '--follow-up "title" --follow-up-prompt "…"')
  let model = base?.model
  if (f.model === null) model = undefined
  else if (f.model !== undefined) {
    const { loadout, note } = resolveLoadout(host, modelParams(f.model, 'followUp.model'))
    if (note) notes.push(note)
    model = loadout
  }
  return { title, prompt, ...(model ? { model } : {}) }
}

/** Another of your templates that already has this name (or a name with the same slug). */
function clashWith(personal: PromptTemplate[], name: string, exceptId?: string): PromptTemplate | undefined {
  const slug = templateSlug(name)
  return personal.find((t) => t.id !== exceptId && (t.name.trim().toLowerCase() === name.trim().toLowerCase() || templateSlug(t.name) === slug))
}

function nameOf(p: Record<string, unknown>, optional: true): string | undefined
function nameOf(p: Record<string, unknown>): string
function nameOf(p: Record<string, unknown>, optional?: true): string | undefined {
  const name = optional ? textParam(p, 'name', { optional: true }) : textParam(p, 'name')
  if (name === undefined) return undefined
  const trimmed = name.replace(/\s+/g, ' ').trim()
  if (!trimmed) throw invalid('A template needs a name.')
  if (!templateSlug(trimmed)) throw invalid('A template’s name needs letters or digits: `foreman run` takes it as a slug.')
  return trimmed
}

const list: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<TemplatesListResult> {
    const p = paramsObject(params)
    const l = await layers(host, textParam(p, 'cwd', { optional: true }))
    const rows = [...l.personal, ...l.fromRepo].map((t) => rowOf(t, l.personal, l.snapshot.repos))
    if (!rows.length) return { templates: rows, text: 'No templates. Add one with `foreman templates add <name> --stdin`.' }
    const head = ['TEMPLATE', 'NAME', 'PLACEHOLDERS', 'SOURCE', 'START MODEL', 'FOLLOW-UP']
    const lines = columns([head, ...rows.map((r) => [r.slug, r.name, r.placeholders.join(', '), r.source === 'repo' ? `repo ${r.repo}` : 'yours', r.startModel ? modelText(r.startModel) : '', r.followUp?.title ?? ''])])
    return { templates: rows, text: lines.join('\n') }
  }
}

const show: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<TemplatesShowResult> {
    const p = paramsObject(params)
    const l = await layers(host, textParam(p, 'cwd', { optional: true }))
    const t = pick(l, textParam(p, 'template'))
    const row = rowOf(t, l.personal, l.snapshot.repos)
    const head = [`${row.name} (${row.slug})${row.source === 'repo' ? ` · ${row.repo}${row.file ? `, ${row.file}` : ''}, read-only` : ''}`]
    if (row.placeholders.length) head.push(`Placeholders: ${row.placeholders.map((x) => `{{${x}}}`).join(', ')}`)
    if (row.startModel) head.push(`Start model: ${modelText(row.startModel)}`)
    if (t.followUp) head.push(`Follow-up: “${t.followUp.title}”${t.followUp.model ? ` with ${modelText(t.followUp.model)}` : ''}: ${firstLine(t.followUp.prompt, 100)}`)
    return { template: row, body: t.body, ...(t.followUp ? { followUpPrompt: t.followUp.prompt } : {}), text: `${head.join('\n')}\n\n${t.body}` }
  }
}

const add: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<TemplateChangeResult> {
    const p = paramsObject(params)
    const name = nameOf(p)
    const body = textParam(p, 'body')
    if (!body.trim()) throw invalid('A template needs a prompt.', 'Give it with --file <path> or --stdin.')
    const snapshot = host.snapshot()
    const personal = snapshot.settings.promptTemplates
    const clash = clashWith(personal, name)
    if (clash) throw invalid(`You already have a template named “${clash.name}” (${templateSlug(clash.name)}).`, `Change it with \`foreman templates edit ${templateSlug(clash.name)}\`, or pick another name.`)
    const notes: string[] = []
    const template: PromptTemplate = {
      id: newTemplateId(),
      name,
      body,
      ...(p.startModel !== undefined ? { startModel: startModelOf(host, modelParams(p.startModel, 'startModel'), notes) } : {}),
      ...(p.followUp !== undefined ? { followUp: followUpOf(host, p.followUp, undefined, notes) } : {})
    }
    await host.api.updateSettings({ promptTemplates: [...personal, template] })
    const row = rowOf(template, personal, snapshot.repos)
    if (row.placeholders.length) notes.push(`It has ${plural(row.placeholders.length, 'placeholder')} (${row.placeholders.map((x) => `{{${x}}}`).join(', ')}): \`foreman run ${row.slug} <values…>\` fills them; a schedule can’t.`)
    return { template: row, notes, text: [`Added template “${name}” (${row.slug}).`, ...notes].join('\n') }
  }
}

const edit: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<TemplateChangeResult> {
    const p = paramsObject(params)
    const l = await layers(host, textParam(p, 'cwd', { optional: true }))
    const t = pick(l, textParam(p, 'template'))
    if (t.source === 'repo') refuseRepoTemplate(t, 'edit', l.snapshot.repos)
    const name = nameOf(p, true)
    const body = textParam(p, 'body', { optional: true })
    if (body !== undefined && !body.trim()) throw invalid('A template needs a prompt; to remove it use `foreman templates remove`.')
    const clearStart = flagParam(p, 'clearStartModel')
    const clearFollow = flagParam(p, 'clearFollowUp')
    if (clearStart && p.startModel !== undefined) throw invalid('Give a start model or clear it, not both.')
    if (clearFollow && p.followUp !== undefined) throw invalid('Give a follow-up or clear it, not both.')
    if (name === undefined && body === undefined && p.startModel === undefined && p.followUp === undefined && !clearStart && !clearFollow) throw invalid('Nothing to change: give a new name, prompt, start model or follow-up.')
    if (name !== undefined) {
      const clash = clashWith(l.personal, name, t.id)
      if (clash) throw invalid(`You already have a template named “${clash.name}” (${templateSlug(clash.name)}).`)
    }
    const notes: string[] = []
    const next: PromptTemplate = { ...t }
    if (name !== undefined) next.name = name
    if (body !== undefined) next.body = body
    if (clearStart) delete next.startModel
    else if (p.startModel !== undefined) next.startModel = startModelOf(host, modelParams(p.startModel, 'startModel'), notes)
    if (clearFollow) delete next.followUp
    else if (p.followUp !== undefined) next.followUp = followUpOf(host, p.followUp, t.followUp, notes)
    const changedText = body !== undefined && body !== t.body
    if (changedText) notes.push(...scheduleNotes(l.snapshot, t, 'the template’s text changes'))
    await host.api.updateSettings({ promptTemplates: l.personal.map((x) => (x.id === t.id ? next : x)) })
    const row = rowOf(next, l.personal.map((x) => (x.id === t.id ? next : x)), l.snapshot.repos)
    return { template: row, notes, text: [`Updated template “${next.name}” (${row.slug}).`, ...notes].join('\n') }
  }
}

const remove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<TemplatesRemoveResult> {
    const p = paramsObject(params)
    const l = await layers(host, textParam(p, 'cwd', { optional: true }))
    const t = pick(l, textParam(p, 'template'))
    if (t.source === 'repo') refuseRepoTemplate(t, 'remove', l.snapshot.repos)
    const rest = l.personal.filter((x) => x.id !== t.id)
    const notes = scheduleNotes(l.snapshot, t, 'it is removed')
    await host.api.updateSettings({ promptTemplates: rest })
    return { removed: rowOf(t, l.personal, l.snapshot.repos), notes, text: [`Removed template “${t.name}”.`, ...notes].join('\n') }
  }
}

export const TEMPLATES_METHODS: Record<string, MethodDef> = {
  'templates-list': list,
  'templates-show': show,
  'templates-add': add,
  'templates-edit': edit,
  'templates-remove': remove
}
