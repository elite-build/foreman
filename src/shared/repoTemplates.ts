// Templates that live in the repo (R-1): .foreman/templates/*.md with a small
// frontmatter block. Parsing and name rules are pure so they can be tested
// without a repository. A repo template is only text (plus an optional
// start model and follow-up offer, as for personal templates): it never
// carries permissions, and nothing in it runs by itself.
import { AGENTS, type EffortLevel } from './agents'
import { templateSlug } from './promptTemplates'
import type { PromptTemplate, TemplateFollowUp, TemplateStartModel } from './types'

export const REPO_TEMPLATE_DIR = '.foreman/templates'
export const MAX_REPO_TEMPLATES = 50
export const MAX_REPO_TEMPLATE_BYTES = 64 * 1024

const EFFORTS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

type Fields = { [key: string]: string | Fields }

const unquote = (v: string): string => {
  const t = v.trim()
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t
}

/** `key: value` lines, with one level of nested keys under `key:` (two or more spaces of indent). */
export function parseFrontmatter(source: string): { fields: Fields; body: string } {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) return { fields: {}, body: text.trim() }
  const fields: Fields = {}
  let parent: Fields | null = null
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^(\s*)([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, key, value] = kv
    if (indent.length && parent) parent[key] = unquote(value)
    else if (value.trim() === '') {
      const child: Fields = {}
      fields[key] = child
      parent = child
    } else {
      fields[key] = unquote(value)
      parent = null
    }
  }
  return { fields, body: text.slice(m[0].length).trim() }
}

const asText = (v: string | Fields | undefined): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function startModelFrom(v: string | Fields | undefined): TemplateStartModel | undefined {
  let agent: string | undefined
  let model: string | undefined
  let effort: string | undefined
  if (typeof v === 'string') [agent, model, effort] = v.trim().split(/[/\s]+/)
  else if (v) {
    agent = asText(v.agent)
    model = asText(v.model)
    effort = asText(v.effort)
  }
  if (!agent || !model || !(agent in AGENTS)) return undefined
  const level = EFFORTS.find((e) => e === effort)
  return { agent: agent as TemplateStartModel['agent'], model, ...(level ? { effort: level } : {}) }
}

function followUpFrom(v: string | Fields | undefined): TemplateFollowUp | undefined {
  if (!v || typeof v === 'string') return undefined
  const title = asText(v.title)
  const prompt = asText(v.prompt)
  if (!title || !prompt) return undefined
  const model = startModelFrom(v.model)
  return { title, prompt, ...(model ? { model: { agent: model.agent, model: model.model, effort: model.effort, fast: false } } : {}) }
}

/** "release-checklist.md" → "Release checklist". */
const nameFromFile = (file: string): string => {
  const base = file.replace(/^.*\//, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return base ? base[0].toUpperCase() + base.slice(1) : file
}

/** One template file. A file without a body is skipped; unknown frontmatter keys are ignored. */
export function parseRepoTemplate(repoId: string, file: string, content: string, rev: string): PromptTemplate | null {
  const { fields, body } = parseFrontmatter(content)
  if (!body) return null
  const name = asText(fields.name) ?? nameFromFile(file)
  const slug = templateSlug(file.replace(/^.*\//, '').replace(/\.md$/i, '')) || templateSlug(name)
  const startModel = startModelFrom(fields.startModel)
  const followUp = followUpFrom(fields.followUp)
  return { id: `repo:${repoId}:${slug}`, name, body, source: 'repo', repoId, rev, file, ...(startModel ? { startModel } : {}), ...(followUp ? { followUp } : {}) }
}

/** The id a send uses to find this repo template again. */
export function parseRepoTemplateId(id: string): { repoId: string; slug: string } | null {
  const m = /^repo:([^:]+):(.+)$/.exec(id)
  return m ? { repoId: m[1], slug: m[2] } : null
}

/** The name a repo template is listed under: qualified (`repo:release-checklist`) when a personal template has the same name. */
export function qualifiedName(template: PromptTemplate, personal: PromptTemplate[]): string {
  if (template.source !== 'repo') return template.name
  const clash = personal.some((p) => templateSlug(p.name) === templateSlug(template.name))
  return clash ? `repo:${templateSlug(template.name)}` : template.name
}

export interface TemplateEntry {
  template: PromptTemplate
  layer: 'personal' | 'repo'
  // What to show: repo templates that clash with a personal one are qualified.
  label: string
  // A repo template shadowed by a personal one of the same name.
  clash: boolean
}

/** Personal templates first, then the repo's. Personal wins a bare name; the repo one stays reachable as `repo:name`. */
export function layeredTemplates(personal: PromptTemplate[], repo: PromptTemplate[]): TemplateEntry[] {
  return [
    ...personal.map((template): TemplateEntry => ({ template, layer: 'personal', label: template.name, clash: false })),
    ...repo.map((template): TemplateEntry => {
      const label = qualifiedName(template, personal)
      return { template, layer: 'repo', label, clash: label !== template.name }
    })
  ]
}

const exact = (list: PromptTemplate[], q: string) =>
  list.find((t) => t.id.toLowerCase() === q) ?? list.find((t) => t.name.trim().toLowerCase() === q) ?? list.find((t) => templateSlug(t.name) === templateSlug(q))

/**
 * The template a command-line name means across both layers. `repo:name` picks the
 * repo's. A bare name finds your own first, then the repo's; a partial name that
 * matches several (in either layer) is an error naming each way to say it.
 */
export function findLayeredTemplate(personal: PromptTemplate[], repo: PromptTemplate[], query: string): { template: PromptTemplate } | { error: string } {
  const q = query.trim().toLowerCase()
  if (!q) return { error: 'Name a template' }
  if (q.startsWith('repo:')) {
    const hit = exact(repo, q.slice(5).trim())
    if (hit) return { template: hit }
    const words = q.slice(5).split(/[\s-]+/).filter(Boolean)
    const fuzzy = repo.filter((t) => words.length > 0 && words.every((w) => t.name.toLowerCase().includes(w)))
    if (fuzzy.length === 1) return { template: fuzzy[0] }
    if (fuzzy.length > 1) return { error: `“${query}” matches several repo templates: ${fuzzy.map((t) => `repo:${templateSlug(t.name)}`).join(', ')}` }
    return { error: `No repo template named “${query.slice(5).trim()}” in ${REPO_TEMPLATE_DIR}` }
  }
  const hit = exact(personal, q) ?? exact(repo, q)
  if (hit) return { template: hit }
  const words = q.split(/[\s-]+/).filter(Boolean)
  const matches = [...personal, ...repo].filter((t) => words.every((w) => t.name.toLowerCase().includes(w)))
  if (matches.length === 1) return { template: matches[0] }
  if (matches.length > 1) return { error: `“${query}” matches several templates: ${matches.map((t) => (t.source === 'repo' ? `repo:${templateSlug(t.name)}` : templateSlug(t.name))).join(', ')}` }
  return { error: `No template named “${query}”` }
}

/** A template by id from either layer; `repoTemplates` is keyed by repository id. */
export function templateById(personal: PromptTemplate[], repoTemplates: Record<string, PromptTemplate[]>, id: string | undefined): PromptTemplate | undefined {
  if (!id) return undefined
  const own = personal.find((t) => t.id === id)
  if (own) return own
  const ref = parseRepoTemplateId(id)
  return ref ? repoTemplates[ref.repoId]?.find((t) => t.id === id) : undefined
}
