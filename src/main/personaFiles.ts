// Persona documents (docs/loops-and-graphs.md, "Personas: who a step is"): the built-in starters, a repository's
// .foreman/personas/*.md, its Claude Code subagents in .claude/agents/*.md (offered for Claude steps as they are), and
// the personal personas kept in state.json beside personal flows. Read-only for the repository: Foreman never writes
// these files, and only regular files inside the repo are read, as for flows and repository templates.
import { createT, type TFunction } from '../shared/i18n'
import { CLAUDE_AGENTS_DIR, MAX_PERSONA_BYTES, MAX_REPO_PERSONAS, parsePersona, PERSONA_DIR, type PersonaListing, type PersonaParse, type PersonaSource, type PersonalPersona } from '../shared/personas'
import { PERSONA_STARTERS } from '../shared/personaStarters'
import { repoFolderReader, type RepoDoc } from './flowFiles'
import type { RepoFileReadOptions } from './repoTemplates'

const enT = createT('en')

const personaFolder = repoFolderReader(PERSONA_DIR, /\.md$/i, MAX_REPO_PERSONAS, MAX_PERSONA_BYTES)
const claudeFolder = repoFolderReader(CLAUDE_AGENTS_DIR, /\.md$/i, MAX_REPO_PERSONAS, MAX_PERSONA_BYTES)

/** Look at every repo's persona folders again on the next read, whatever `maxAgeMs` says. */
export function revalidateRepoPersonas(): void {
  personaFolder.revalidate()
  claudeFolder.revalidate()
}

/** "qa-engineer.md" → "qa-engineer": the name a file is listed under while it doesn't read. */
const fileStem = (file: string): string => file.replace(/^.*\//, '').replace(/\.md$/i, '')

/** One document as Automations lists it: the persona when it reads, its problems when it doesn't. */
export function personaListing(base: { id: string; source: PersonaSource; markdown: string; fallbackName: string; repoId?: string; file?: string; rev?: string }, parsed: PersonaParse): PersonaListing {
  const { fallbackName, ...rest } = base
  const listing: PersonaListing = { ...rest, name: 'persona' in parsed ? parsed.persona.name : fallbackName, problems: 'problems' in parsed ? parsed.problems : [], warnings: parsed.warnings }
  if ('persona' in parsed) listing.persona = parsed.persona
  return listing
}

function fromFile(repoId: string, source: 'repo' | 'claude-agents', raw: RepoDoc, t: TFunction): PersonaListing {
  const parsed: PersonaParse = raw.tooLarge
    ? { problems: [t('flows.problem.tooLarge', { kb: Math.round(MAX_PERSONA_BYTES / 1024) })], warnings: [] }
    : parsePersona(raw.text, source, t, { file: raw.file, rev: raw.rev })
  return personaListing({ id: `${source}:${repoId}:${raw.file}`, source, markdown: raw.text, fallbackName: fileStem(raw.file), repoId, file: raw.file, rev: raw.rev }, parsed)
}

/** A repository's persona files: its .foreman/personas, then its .claude/agents, each sorted by file name. */
export function readRepoPersonas(repoId: string, rootPath: string, t: TFunction = enT, options: RepoFileReadOptions = {}): PersonaListing[] {
  return [
    ...personaFolder.read(repoId, rootPath, options).map((raw) => fromFile(repoId, 'repo', raw, t)),
    ...claudeFolder.read(repoId, rootPath, options).map((raw) => fromFile(repoId, 'claude-agents', raw, t))
  ]
}

export function personalPersonaListing(p: PersonalPersona, t: TFunction = enT): PersonaListing {
  return personaListing({ id: p.id, source: 'personal', markdown: p.markdown, fallbackName: p.id, rev: p.updatedAt }, parsePersona(p.markdown, 'personal', t, { rev: p.updatedAt }))
}

/** Built-in starters, then each repository's files (only `repoId`'s when given), then personal personas. */
export function listPersonas(repos: { id: string; rootPath: string }[], personal: PersonalPersona[], t: TFunction = enT, repoId?: string): PersonaListing[] {
  const builtIn = PERSONA_STARTERS.map((s) => personaListing({ id: `built-in:${s.name}`, source: 'built-in', markdown: s.markdown, fallbackName: s.name }, parsePersona(s.markdown, 'built-in', t)))
  const fromRepos = repos.filter((r) => !repoId || r.id === repoId).flatMap((r) => readRepoPersonas(r.id, r.rootPath, t))
  return [...builtIn, ...fromRepos, ...personal.map((p) => personalPersonaListing(p, t))]
}
