// Personas (docs/loops-and-graphs.md, "Personas: who a step is"): the role a flow's agent step plays, named once and
// reused. A persona is a markdown file with frontmatter (the shape of Claude Code's `.claude/agents/*.md`): settings that
// narrow what the step may do and add to what it is shown, with instructions beneath. This module is the model, the
// reader and the rules for applying one to a step, pure so the renderer (the editor), main (files, runs) and tests share
// them. A persona is human-owned: nothing a run does writes to one.
import { PERSONA_FILE_AGENT } from './agentCatalog'
import { AGENTS, MODELS, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'

const enT = createT('en')

export const PERSONA_DIR = '.foreman/personas'
export const CLAUDE_AGENTS_DIR = '.claude/agents'
export const MAX_PERSONA_BYTES = 32 * 1024
export const MAX_REPO_PERSONAS = 50
export const MAX_PERSONAL_PERSONAS = 100
const MAX_NAME = 64

/** What a persona can be shown, beyond a step's own context: never another step's section, which it can't know. */
export const PERSONA_SHOWS = ['task', 'diff', 'tree', 'note', 'ledger', 'checks.results'] as const
export type PersonaShow = (typeof PERSONA_SHOWS)[number]

/** The facts a persona is expected to end with: a step that ends without one reads as undecided, not clean. */
export const PERSONA_ENDS = ['review', 'done', 'findings', 'plan'] as const
export type PersonaEnd = (typeof PERSONA_ENDS)[number]

/** Shipped with Foreman, a repository file, kept in state.json, or a repository's Claude Code subagent file. */
export type PersonaSource = 'built-in' | 'repo' | 'personal' | 'claude-agents'

export interface Persona {
  name: string
  description?: string
  source: PersonaSource
  // Relative to the repository, with forward slashes, for 'repo' and 'claude-agents'.
  file?: string
  // A repository file's git blob SHA; a personal persona's last save.
  rev?: string
  // A default loadout slot (1-based), or an agent and model; a step's own choice overrides either.
  loadout?: number
  agent?: AgentKind
  model?: string
  // The step's tab is read-only while it runs; a step can't turn this off.
  read_only?: boolean
  shows?: PersonaShow[]
  ends_with?: PersonaEnd[]
  // The only MCP servers the step keeps of what the repository and integrations give; never adds one.
  mcp?: string[]
  // Scoped writes: path globs relative to the workspace root (docs/features/**). Set, and not read-only, the step's
  // turn may edit files only inside them; Foreman refuses the rest (Claude: no shell either; Codex: a read-only sandbox, so no command writes). An agent whose record doesn't offer scoped writes refuses the step.
  writes?: string[]
  // A Claude Code subagent's `tools`, kept as written: Foreman doesn't apply it.
  tools?: string
  instructions: string
}

/** A persona as Automations lists it, from any source: the persona when it reads, its problems when it doesn't. */
export interface PersonaListing {
  // 'built-in:<name>', 'repo:<repoId>:<file>', 'claude-agents:<repoId>:<file>', or the personal persona's id.
  id: string
  source: PersonaSource
  name: string
  repoId?: string
  file?: string
  rev?: string
  // The document as written: what a run's fingerprint hashes and the editor's Source shows.
  markdown: string
  persona?: Persona
  problems: string[]
  warnings: string[]
}

/** What `listPersonas` answers: the personas, and the MCP servers repositories propose (what a persona may keep). */
export interface PersonaList {
  personas: PersonaListing[]
  mcpServers: string[]
}

/** A personal persona as state.json keeps it: the document, which is the source of truth, and when it changed. */
export interface PersonalPersona {
  id: string
  markdown: string
  createdAt: string
  updatedAt: string
}

/**
 * What a flow step's turn carries of its persona: the persona's name and instructions for the system prompt, and what
 * the persona (or the step itself, with no persona) narrows: read-only, and the MCP servers kept.
 */
export interface TurnPersona {
  name?: string
  instructions?: string
  readOnly?: boolean
  mcp?: string[]
  // The only paths the turn may write (globs relative to the workspace root): file tools elsewhere and every shell are refused.
  writes?: string[]
}

/** The persona's part of a flow step's system prompt (a scope line may follow). Shared so evals/ runs the text a turn is given. */
export function personaTurnText(name: string, instructions: string): string {
  return `This turn is a step of a Foreman flow, run as the persona “${name}”. Its instructions:\n${instructions.trim()}`
}

export type PersonaParse = { persona: Persona; warnings: string[] } | { problems: string[]; warnings: string[] }

// ---- frontmatter ----

export type FrontValue = string | number | boolean | string[]

/**
 * The frontmatter between the first two `---` lines and the body after it, or null when the text has none. A small
 * YAML subset, read strictly: `key: value` with text (bare or quoted), whole numbers, true/false, inline lists
 * `[a, b]`, block lists (`- a` lines) and block text (`|` or `>` with indented lines); `#` starts a comment.
 */
export function parseFrontmatter(text: string): { meta: Record<string, FrontValue>; body: string; bad: number[]; twice: string[] } | null {
  const source = text.replace(/^﻿/, '')
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return null
  const lines = (match[1] ?? '').split(/\r?\n/)
  const meta: Record<string, FrontValue> = {}
  const bad: number[] = []
  const twice: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const kv = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?\s*$/.exec(line)
    if (!kv) {
      bad.push(i + 2)
      continue
    }
    const key = kv[1]
    const raw = stripComment(kv[2] ?? '').trim()
    if (Object.hasOwn(meta, key)) twice.push(key)
    if (raw === '') {
      // A block list under the key, or nothing.
      const items: string[] = []
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) items.push(scalarText(stripComment(lines[++i].replace(/^\s+-\s*/, '')).trim()))
      meta[key] = items.length ? items : ''
      continue
    }
    if (/^[|>][-+]?$/.test(raw)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      meta[key] = (raw.startsWith('|') ? block.join('\n') : block.join(' ')).trim()
      continue
    }
    if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) {
        bad.push(i + 2)
        continue
      }
      const inner = raw.slice(1, -1).trim()
      meta[key] = inner ? splitList(inner).map((x) => scalarText(x.trim())) : []
      continue
    }
    meta[key] = scalar(raw)
  }
  return { meta, body: source.slice(match[0].length), bad, twice }
}

function stripComment(value: string): string {
  let quote = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i)
  }
  return value
}

function splitList(inner: string): string[] {
  const out: string[] = []
  let quote = ''
  let current = ''
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = ''
      current += c
    } else if (c === '"' || c === "'") {
      quote = c
      current += c
    } else if (c === ',') {
      out.push(current)
      current = ''
    } else current += c
  }
  out.push(current)
  return out.filter((x) => x.trim())
}

const unquote = (v: string) => (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v)
const scalarText = (v: string) => unquote(v)

function scalar(raw: string): FrontValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return unquote(raw)
}

// ---- reading ----

const NAME = /^[A-Za-z0-9][\w-]*$/
const FIELDS = ['name', 'description', 'loadout', 'agent', 'model', 'read_only', 'shows', 'ends_with', 'mcp', 'writes']
// A Claude Code subagent file is read for its name, description, model and tools; anything else in it is left alone.

/** Claude Code's model aliases (sonnet, opus, haiku, fable) as the model Foreman runs; `inherit` or nothing: the step's. */
export function claudeAgentModel(model: string | undefined): string | undefined {
  const alias = model?.trim().toLowerCase()
  if (!alias || alias === 'inherit') return undefined
  return MODELS.find((m) => m.agent === PERSONA_FILE_AGENT && (m.id === alias || m.id.includes(`-${alias}-`)))?.id ?? model!.trim()
}

/**
 * Read a persona document. Errors (no frontmatter, a wrong value, no name) mean no persona; warnings ride along. A
 * `.claude/agents` file is read as Claude Code reads it: its name, description, model and tools, for Claude steps only.
 */
export function parsePersona(markdown: string, source: PersonaSource, t: TFunction = enT, where: { file?: string; rev?: string } = {}): PersonaParse {
  const problems: string[] = []
  const warnings: string[] = []
  if (new TextEncoder().encode(markdown).length > MAX_PERSONA_BYTES) return { problems: [t('flows.problem.tooLarge', { kb: Math.round(MAX_PERSONA_BYTES / 1024) })], warnings }
  const front = parseFrontmatter(markdown)
  if (!front) return { problems: [t('personas.problem.noFrontmatter')], warnings }
  const claude = source === 'claude-agents'
  // A Claude Code file Foreman can't fully read still offers what it can; Foreman's own files are read strictly.
  for (const line of front.bad) (claude ? warnings : problems).push(t('personas.problem.line', { line }))
  for (const field of front.twice) (claude ? warnings : problems).push(t('personas.problem.twice', { field }))
  const { meta } = front
  if (!claude) for (const key of Object.keys(meta)) if (!FIELDS.includes(key)) warnings.push(t('personas.problem.unknownField', { field: key }))

  const text = (field: string): string | undefined => {
    const v = meta[field]
    if (v === undefined || v === '') return undefined
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && field !== 'name') return String(v)
    problems.push(t('personas.problem.text', { field }))
    return undefined
  }
  const name = text('name') ?? (claude && where.file ? where.file.replace(/^.*\//, '').replace(/\.md$/i, '') : undefined)
  if (!name || !NAME.test(name) || name.length > MAX_NAME) problems.push(t('personas.problem.name'))
  const persona: Persona = { name: name ?? '', source, instructions: front.body.trim() }
  const description = text('description')
  if (description) persona.description = description
  if (where.file) persona.file = where.file
  if (where.rev) persona.rev = where.rev

  if (claude) {
    persona.agent = PERSONA_FILE_AGENT
    const model = claudeAgentModel(text('model'))
    if (model) persona.model = model
    const tools = meta.tools
    if (tools !== undefined && tools !== '') persona.tools = Array.isArray(tools) ? tools.join(', ') : String(tools)
    return problems.length ? { problems, warnings } : { persona, warnings }
  }

  const list = <T extends string>(field: string, choices?: readonly T[]): T[] | undefined => {
    const v = meta[field]
    if (v === undefined || v === '') return undefined
    if (!Array.isArray(v)) {
      problems.push(t('personas.problem.list', { field }))
      return undefined
    }
    const out: T[] = []
    for (const item of v.map((x) => x.trim()).filter(Boolean)) {
      if (choices && !(choices as readonly string[]).includes(item)) {
        if (field === 'shows' && item.includes('.')) problems.push(t('personas.problem.stepSection', { value: item }))
        else problems.push(t('personas.problem.choice', { field, value: item, choices: choices.join(', ') }))
        continue
      }
      if (!out.includes(item as T)) out.push(item as T)
    }
    return out
  }
  if (meta.loadout !== undefined && meta.loadout !== '') {
    if (typeof meta.loadout === 'number' && Number.isInteger(meta.loadout) && meta.loadout >= 1) persona.loadout = meta.loadout
    else problems.push(t('personas.problem.whole', { field: 'loadout' }))
  }
  const agent = text('agent')
  if (agent) {
    if (Object.hasOwn(AGENTS, agent)) persona.agent = agent as AgentKind
    else problems.push(t('personas.problem.agent', { agent }))
  }
  const model = text('model')
  if (model) persona.model = model
  if (meta.read_only !== undefined && meta.read_only !== '') {
    if (typeof meta.read_only === 'boolean') persona.read_only = meta.read_only
    else problems.push(t('personas.problem.bool', { field: 'read_only' }))
  }
  const shows = list('shows', PERSONA_SHOWS)
  if (shows) persona.shows = shows
  const ends = list('ends_with', PERSONA_ENDS)
  if (ends) persona.ends_with = ends
  const mcp = list<string>('mcp')
  if (mcp) persona.mcp = mcp
  const writes = list<string>('writes')
  if (writes) {
    for (const glob of writes) if (!isWriteGlob(glob)) problems.push(t('personas.problem.writes', { value: glob }))
    if (writes.length) persona.writes = writes
    if (writes.length && persona.read_only) warnings.push(t('personas.problem.writesReadOnly'))
  }
  return problems.length ? { problems, warnings } : { persona, warnings }
}

/** A `writes` glob: a path inside the workspace, relative to its root, with forward slashes and no `..`. */
export function isWriteGlob(glob: string): boolean {
  const g = glob.trim()
  if (!g || g.startsWith('/') || g.includes('\\') || /^[A-Za-z]:/.test(g)) return false
  return g.split('/').every((part) => part !== '..' && part !== '')
}

/** Whether `glob` is inside one of `allowed`: the same glob, or under a folder one of them opens with `/**`. */
export function writeGlobWithin(glob: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => a === glob || (a.endsWith('/**') && glob.startsWith(a.slice(0, -2))) || a === '**')
}

/** A persona's own problems in words (the parser's rules), for a persona built in code rather than read. */
export function validatePersona(persona: Persona, t: TFunction = enT): string[] {
  const read = parsePersona(personaMarkdown(persona), persona.source === 'claude-agents' ? 'personal' : persona.source, t)
  return 'problems' in read ? read.problems : []
}

const yamlText = (v: string) => (/^[\w./@-][\w ./@-]*$/.test(v) && !/^(true|false|\d+)$/.test(v) && !v.endsWith(' ') ? v : JSON.stringify(v))
const yamlList = (items: string[]) => `[${items.map(yamlText).join(', ')}]`

/** The document for a persona: its settings as frontmatter, the instructions beneath. What the editor saves. */
export function personaMarkdown(p: Omit<Persona, 'source'> & { source?: PersonaSource }): string {
  const lines = ['---', `name: ${yamlText(p.name)}`]
  if (p.description) lines.push(`description: ${yamlText(p.description.replace(/\s+/g, ' ').trim())}`)
  if (p.loadout !== undefined) lines.push(`loadout: ${p.loadout}`)
  if (p.agent) lines.push(`agent: ${p.agent}`)
  if (p.model) lines.push(`model: ${yamlText(p.model)}`)
  if (p.read_only !== undefined) lines.push(`read_only: ${p.read_only}`)
  if (p.shows?.length) lines.push(`shows: ${yamlList(p.shows)}`)
  if (p.ends_with?.length) lines.push(`ends_with: ${yamlList(p.ends_with)}`)
  if (p.mcp) lines.push(`mcp: ${yamlList(p.mcp)}`)
  if (p.writes?.length) lines.push(`writes: ${yamlList(p.writes)}`)
  lines.push('---')
  return `${lines.join('\n')}\n${p.instructions.trim()}\n`
}

// ---- which persona a name means ----

const ORDER: PersonaSource[] = ['personal', 'repo', 'claude-agents', 'built-in']

/**
 * The persona a step's name means for a repository: your own first, then the repository's `.foreman/personas`, then its
 * `.claude/agents`, then the built-in ones, as a template's name finds yours before the repository's. Only personas
 * that read; `repoId` undefined looks in every repository's files.
 */
export function findPersona(listings: readonly PersonaListing[], name: string, repoId?: string): Persona | undefined {
  const wanted = name.trim().toLowerCase()
  const hits = listings.filter((l) => l.persona && l.persona.name.toLowerCase() === wanted && (!l.repoId || !repoId || l.repoId === repoId))
  hits.sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source))
  return hits[0]?.persona
}

// ---- applying one to a step ----

/** The parts of a flow's agent step a persona speaks to. */
export interface PersonaStep {
  name: string
  persona?: string
  loadout?: number
  agent?: string
  model?: string
  context?: string[]
  read_only?: boolean
  mcp?: string[]
  writes?: string[]
}

/** A step with its persona applied: what runs. */
export interface AppliedPersona {
  // The step's own loadout or agent and model when it names one, else the persona's.
  loadout?: number
  agent?: string
  model?: string
  // On when the persona or the step says so; a step can't turn a read-only persona's off.
  readOnly: boolean
  // The persona's `shows`, then the step's context, each once.
  context: string[]
  // The servers the step may keep (undefined: every one the repository and integrations give).
  mcp?: string[]
  // The only paths its turn may write, when the persona or the step scopes them and it isn't read-only.
  writes?: string[]
  // The facts the persona is expected to end with.
  endsWith: PersonaEnd[]
  // Where the step tried to loosen what the persona allows: refused.
  problems: string[]
}

/**
 * A persona applied to a step. Narrowing only: the step may override the loadout, add to what it is shown, turn
 * read-only on and keep fewer MCP servers, but never turn a read-only persona's off or name a server the persona
 * doesn't keep. With no persona, the step as written.
 */
export function applyPersona(step: PersonaStep, persona: Persona | undefined, t: TFunction = enT): AppliedPersona {
  const problems: string[] = []
  const ownLoadout = step.loadout !== undefined || Boolean(step.agent) || Boolean(step.model)
  const out: AppliedPersona = {
    readOnly: Boolean(step.read_only),
    context: [...new Set([...(persona?.shows ?? []), ...(step.context ?? [])])],
    endsWith: persona?.ends_with ?? [],
    problems
  }
  if (ownLoadout) Object.assign(out, step.loadout !== undefined ? { loadout: step.loadout } : {}, step.agent ? { agent: step.agent } : {}, step.model ? { model: step.model } : {})
  else if (persona?.loadout !== undefined) out.loadout = persona.loadout
  else if (persona?.agent || persona?.model) Object.assign(out, persona.agent ? { agent: persona.agent } : {}, persona.model ? { model: persona.model } : {})
  if (persona?.read_only) {
    out.readOnly = true
    if (step.read_only === false) problems.push(t('flows.problem.personaReadOnly', { step: step.name, persona: persona.name }))
  }
  if (persona?.mcp) {
    const allowed = persona.mcp
    const extra = (step.mcp ?? []).filter((s) => !allowed.includes(s))
    if (extra.length) problems.push(t('flows.problem.personaMcp', { step: step.name, persona: persona.name, servers: extra.join(', ') }))
    out.mcp = step.mcp ? step.mcp.filter((s) => allowed.includes(s)) : [...allowed]
  } else if (step.mcp) out.mcp = [...step.mcp]
  // Scoped writes: a step may narrow the persona's area, never widen it (and a persona with none, the step may scope).
  if (persona?.writes?.length) {
    const allowed = persona.writes
    const extra = (step.writes ?? []).filter((g) => !writeGlobWithin(g, allowed))
    if (extra.length) problems.push(t('flows.problem.personaWrites', { step: step.name, persona: persona.name, globs: extra.join(', '), allowed: allowed.join(', ') }))
    const kept = (step.writes ?? []).filter((g) => writeGlobWithin(g, allowed))
    out.writes = step.writes?.length ? kept : [...allowed]
  } else if (step.writes?.length) out.writes = [...step.writes]
  if (out.readOnly) delete out.writes
  return out
}
