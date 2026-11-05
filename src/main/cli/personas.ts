// `foreman persona …`: personas (docs/loops-and-graphs.md, "Personas: who a step is") from the command line, behind
// Settings → Experimental → Flows like the window's Personas section. Repository and built-in personas are read-only;
// add and remove work on personal ones, through the same calls the persona editor makes.
import type { PersonaAddResult, PersonaListResult, PersonaRemoveResult, PersonaRow, PersonaShowResult } from '../../shared/cli/personas'
import type { PersonaListing, PersonaSource } from '../../shared/personas'
import type { Repo } from '../../shared/types'
import { flowsOn, optionalRepo } from './flows'
import { columns, paramsObject, textParam, type MethodDef } from './kit'
import { findByRef, refused } from './refs'

// Which persona of a name a step runs as: yours, the repository's, its .claude/agents file, the built-in one.
const ORDER: PersonaSource[] = ['personal', 'repo', 'claude-agents', 'built-in']

const fileStem = (file: string | undefined) => (file ?? '').replace(/^.*\//, '').replace(/\.md$/i, '')

const spec = {
  id: (p: PersonaListing) => p.id,
  names: (p: PersonaListing) => [p.name, ...(p.file ? [fileStem(p.file), p.file] : [])],
  describe: (p: PersonaListing) => `${p.name} (${p.file ?? p.source}, id ${p.id})`
}

/** The persona a name means as a step would find it; an id or file name picks one exactly. */
function findPersonaRow(list: PersonaListing[], query: string): PersonaListing {
  const q = query.trim().toLowerCase()
  const byId = list.find((p) => p.id === query.trim())
  if (byId) return byId
  const named = list.filter((p) => p.name.toLowerCase() === q).sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source))
  // One per repository at most is the one a step uses; across repositories the id says which.
  if (named.length && new Set(named.filter((p) => p.repoId).map((p) => p.repoId)).size <= 1) return named[0]
  return findByRef(list, query, 'persona', spec)
}

const sourceText = (r: PersonaRow) => (r.source === 'repo' ? `repo ${r.repo ?? ''}`.trim() : r.source === 'claude-agents' ? `claude ${r.repo ?? ''}`.trim() : r.source)
const revText = (r: PersonaRow) => (r.source === 'repo' || r.source === 'claude-agents' ? (r.rev ?? '').slice(0, 7) : r.source === 'personal' && r.rev ? r.rev.slice(0, 10) : '')

/** The persona a step uses instead, in words: yours, or its id. */
const shadowText = (id: string) => (id.startsWith('persona-') ? 'your personal persona' : id)

/** "read-only · plan": what it may do and what it ends with. */
function factsText(r: PersonaRow): string {
  return [r.readOnly ? 'read-only' : 'edits', ...(r.endsWith.length ? [`ends with ${r.endsWith.join(', ')}`] : []), ...(r.source === 'claude-agents' ? ['Claude steps only'] : [])].join(' · ')
}

export function personaRow(p: PersonaListing, repos: Repo[], all: PersonaListing[] = []): PersonaRow {
  const persona = p.persona
  const rank = ORDER.indexOf(p.source)
  const over = persona ? all.find((o) => o !== p && o.persona && o.name.toLowerCase() === p.name.toLowerCase() && (!o.repoId || !p.repoId || o.repoId === p.repoId) && ORDER.indexOf(o.source) < rank) : undefined
  return {
    id: p.id,
    name: p.name,
    source: p.source,
    ...(p.repoId ? { repo: repos.find((r) => r.id === p.repoId)?.name ?? p.repoId, repoId: p.repoId } : {}),
    ...(p.file ? { file: p.file } : {}),
    ...(p.rev ? { rev: p.rev } : {}),
    ...(persona?.description ? { description: persona.description } : {}),
    readOnly: Boolean(persona?.read_only),
    ...(persona?.loadout !== undefined ? { loadout: persona.loadout } : {}),
    ...(persona?.agent ? { agent: persona.agent } : {}),
    ...(persona?.model ? { model: persona.model } : {}),
    shows: persona?.shows ?? [],
    endsWith: persona?.ends_with ?? [],
    ...(persona?.mcp ? { mcp: persona.mcp } : {}),
    ...(over ? { shadowedBy: over.id } : {}),
    problems: p.problems,
    warnings: p.warnings
  }
}

const list: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<PersonaListResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const repo = await optionalRepo(host, p)
    const { personas } = await host.api.listPersonas(repo?.id)
    const repos = host.state().repos
    const rows = personas.map((x) => personaRow(x, repos, personas))
    const table = columns([['NAME', 'SOURCE', 'FILE', 'REV', 'WHAT IT IS'], ...rows.map((r) => [r.name, sourceText(r), r.file ?? '', revText(r), r.problems.length ? '' : factsText(r)])])
    const lines = [table[0]]
    rows.forEach((r, i) => {
      lines.push(table[i + 1])
      for (const problem of r.problems) lines.push(`  problem: ${problem}`)
      if (r.shadowedBy) lines.push(`  not used: ${shadowText(r.shadowedBy)} of the same name comes first`)
    })
    return { personas: rows, ...(repo ? { repo: repo.name } : {}), text: lines.join('\n') }
  }
}

const show: MethodDef = {
  tier: 'read',
  async handle(host, params): Promise<PersonaShowResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const repo = await optionalRepo(host, p)
    const { personas } = await host.api.listPersonas(repo?.id)
    const found = findPersonaRow(personas, textParam(p, 'persona'))
    const row = personaRow(found, host.state().repos, personas)
    const usedBy = (await host.api.listFlows(repo?.id)).filter((f) => f.summary?.personas.some((n) => n.toLowerCase() === row.name.toLowerCase())).map((f) => f.name)
    const where = row.source === 'built-in' ? 'built-in' : row.source === 'personal' ? 'personal' : `${row.repo}: ${row.file}${row.rev ? ` at ${row.rev.slice(0, 7)}` : ''}`
    const lines = [`${row.name} (${where})`, `id ${row.id}`]
    if (row.description) lines.push(row.description)
    if (!row.problems.length) {
      lines.push(`What it is: ${factsText(row)}`)
      lines.push(`Shows: ${row.shows.length ? row.shows.join(', ') : '(only what each step’s context names)'}`)
      lines.push(`Loadout: ${row.loadout !== undefined ? `loadout ${row.loadout}` : row.model ? `${row.agent ?? 'claude'} ${row.model}` : 'the step’s own, else loadout 1'}`)
      lines.push(`MCP servers: ${row.mcp ? (row.mcp.length ? `only ${row.mcp.join(', ')}` : 'none') : 'every one the repository and integrations give'}`)
      if (found.persona?.tools) lines.push(`Tools (not applied): ${found.persona.tools}`)
    }
    lines.push(`Used by: ${usedBy.length ? usedBy.join(', ') : '(no flow names it)'}`)
    if (row.shadowedBy) lines.push(`Not used: ${shadowText(row.shadowedBy)} of the same name comes first.`)
    for (const problem of row.problems) lines.push(`Problem: ${problem}`)
    for (const warning of row.warnings) lines.push(`Warning: ${warning}`)
    return { persona: row, markdown: found.markdown, usedBy, text: `${lines.join('\n')}\n\n${found.markdown.trimEnd()}` }
  }
}

// Saving or deleting a personal persona changes what a flow's turns are told, so it is admin, as flow add is.
const add: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<PersonaAddResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const saved = await host.api.savePersonalPersona({ markdown: textParam(p, 'markdown') })
    if ('problems' in saved) return { saved: false, problems: saved.problems, text: [`Not saved: the persona has ${saved.problems.length === 1 ? 'a problem' : 'problems'}.`, ...saved.problems.map((x) => `  ${x}`)].join('\n') }
    const row = personaRow(saved.persona, host.state().repos)
    return { saved: true, persona: row, text: [`Saved the personal persona “${row.name}” (id ${row.id}).`, ...row.warnings.map((w) => `  warning: ${w}`)].join('\n') }
  }
}

const remove: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<PersonaRemoveResult> {
    flowsOn(host)
    const p = paramsObject(params)
    const { personas } = await host.api.listPersonas()
    const found = findPersonaRow(personas, textParam(p, 'persona'))
    if (found.source !== 'personal') throw refused(`Only personal personas can be removed here; “${found.name}” is ${found.source === 'built-in' ? 'built into Foreman' : `the repository file ${found.file}`}.`)
    await host.api.deletePersonalPersona(found.id)
    return { removed: personaRow(found, host.state().repos), text: `Removed the personal persona “${found.name}”. Flows that name it use the repository’s or the built-in one of that name, if there is one.` }
  }
}

export const PERSONA_METHODS: Record<string, MethodDef> = {
  'persona-list': list,
  'persona-show': show,
  'persona-add': add,
  'persona-remove': remove
}
