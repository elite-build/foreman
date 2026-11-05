// Flow documents (docs/loops-and-graphs.md): a repository's .foreman/flows/*.toml, the built-in starters and the
// personal flows kept in state.json, listed together for Automations. Read-only for the repository: Foreman never
// writes these files, and only regular files inside the repo are read, as for repository templates.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FLOW_STARTERS } from '../shared/flowStarters'
import { FLOW_DIR, flowPersonaProblems, flowSummary, MAX_FLOW_BYTES, MAX_REPO_FLOWS, parseFlow, type FlowListing, type FlowParse, type FlowPersonaRef, type FlowSource, type PersonalFlow } from '../shared/flows'
import { findPersona, type Persona, type PersonaListing } from '../shared/personas'
import { createT, type TFunction } from '../shared/i18n'
import { blobSha, type RepoFileReadOptions } from './repoTemplates'

const enT = createT('en')

export interface FlowFile {
  id: string
  repoId: string
  // Relative to the repository, with forward slashes: ".foreman/flows/fix-until-green.toml".
  file: string
  // The git blob SHA; empty when the file was too large to read.
  rev: string
  toml: string
  parsed: FlowParse
}

/** A file of a repository folder as last read: its text, or that it was too large to read. */
export interface RepoDoc {
  file: string
  rev: string
  text: string
  tooLarge: boolean
}

/**
 * A cached reader of one folder's files in each repository (sorted by name, at most `limit`, only regular files), read
 * again only when a file's name, size or time changed. Flows and personas each have one.
 */
export function repoFolderReader(dir: string, pattern: RegExp, limit: number, maxBytes: number) {
  // The files as last read, per repo; parsing them again is cheap, and follows the language asked for.
  const cache = new Map<string, { key: string; raw: RepoDoc[] }>()
  const checked = new Map<string, { rootPath: string; at: number }>()

  const names = (full: string): string[] => {
    try {
      return readdirSync(full)
        .filter((n) => pattern.test(n))
        .sort()
        .slice(0, limit)
    } catch {
      return []
    }
  }

  /** The folder's file names with their size and time: what decides whether to read the files again. */
  const listingKey = (rootPath: string): string => {
    const full = path.join(rootPath, dir)
    const stamps: string[] = []
    for (const name of names(full)) {
      try {
        const st = lstatSync(path.join(full, name))
        if (st.isFile()) stamps.push(`${name}:${st.mtimeMs}:${st.size}`)
      } catch {
        // Vanished between the listing and the stat.
      }
    }
    return `${rootPath}\0${stamps.join('|')}`
  }

  const readRaw = (rootPath: string): RepoDoc[] => {
    const full = path.join(rootPath, dir)
    const out: RepoDoc[] = []
    for (const name of names(full)) {
      const file = `${dir}/${name}`
      try {
        const at = path.join(full, name)
        const st = lstatSync(at)
        // Regular files only: a symlink could point outside the repository.
        if (!st.isFile()) continue
        if (st.size > maxBytes) {
          out.push({ file, rev: '', text: '', tooLarge: true })
          continue
        }
        const content = readFileSync(at)
        out.push({ file, rev: blobSha(content), text: content.toString('utf8').replace(/^﻿/, ''), tooLarge: false })
      } catch {
        // Unreadable: skipped, like a file that vanished.
      }
    }
    return out
  }

  return {
    read(repoId: string, rootPath: string, options: RepoFileReadOptions = {}): RepoDoc[] {
      const now = Date.now()
      const last = checked.get(repoId)
      const hit = cache.get(repoId)
      const fresh = hit && last?.rootPath === rootPath && options.maxAgeMs && now - last.at >= 0 && now - last.at < options.maxAgeMs
      if (!fresh) {
        checked.set(repoId, { rootPath, at: now })
        const key = listingKey(rootPath)
        if (hit?.key !== key) cache.set(repoId, { key, raw: readRaw(rootPath) })
      }
      return cache.get(repoId)!.raw
    },
    /** Look at every repo's folder again on the next read, whatever `maxAgeMs` says. */
    revalidate(): void {
      checked.clear()
    }
  }
}

const flowFolder = repoFolderReader(FLOW_DIR, /\.toml$/i, MAX_REPO_FLOWS, MAX_FLOW_BYTES)

/** Look at every repo's flows folder again on the next read, whatever `maxAgeMs` says. */
export function revalidateRepoFlows(): void {
  flowFolder.revalidate()
}

/** The repo's flow files, sorted by file name, read again only when a file's size or time changed. Bad files are listed with their problems, never thrown. */
export function readRepoFlows(repoId: string, rootPath: string, t: TFunction = enT, options: RepoFileReadOptions = {}): FlowFile[] {
  return flowFolder.read(repoId, rootPath, options).map((raw) => ({
    id: `repo:${repoId}:${raw.file}`,
    repoId,
    file: raw.file,
    rev: raw.rev,
    toml: raw.text,
    parsed: raw.tooLarge ? { problems: [t('flows.problem.tooLarge', { kb: Math.round(MAX_FLOW_BYTES / 1024) })], warnings: [] } : parseFlow(raw.text, 'repo', t)
  }))
}

/** One document as Automations lists it, with its summary when it parses and its problems when it doesn't. */
export function flowListing(base: { id: string; source: FlowSource; toml: string; fallbackName: string; starter?: string; repoId?: string; file?: string; rev?: string }, parsed: FlowParse): FlowListing {
  const { fallbackName, ...rest } = base
  const listing: FlowListing = { ...rest, name: 'flow' in parsed ? parsed.flow.name : fallbackName, problems: 'problems' in parsed ? parsed.problems : [], warnings: parsed.warnings }
  if ('flow' in parsed) listing.summary = flowSummary(parsed.flow)
  return listing
}

/** "fix-until-green.toml" → "fix-until-green": the name a file is listed under while it doesn't parse. */
const fileStem = (file: string): string => file.replace(/^.*\//, '').replace(/\.toml$/i, '')

export function personalFlowListing(flow: PersonalFlow, t: TFunction = enT): FlowListing {
  return flowListing({ id: flow.id, source: 'personal', toml: flow.toml, fallbackName: flow.id, rev: flow.updatedAt }, parseFlow(flow.toml, 'personal', t))
}

/**
 * Built-in starters, then each repository's files (only `repoId`'s when given), then personal flows. With `personas`,
 * each flow's are resolved where it runs (a repository flow in its repository; any other in `repoId`'s, else in any),
 * and one that isn't there, or a step that loosens one, is a problem on the flow.
 */
export function listFlows(repos: { id: string; rootPath: string }[], personal: PersonalFlow[], t: TFunction = enT, repoId?: string, personas?: readonly PersonaListing[]): FlowListing[] {
  const builtIn = FLOW_STARTERS.map((s) => flowListing({ id: `built-in:${s.id}`, source: 'built-in', starter: s.id, toml: s.toml, fallbackName: s.id }, parseFlow(s.toml, 'built-in', t)))
  const fromRepos = repos
    .filter((r) => !repoId || r.id === repoId)
    .flatMap((r) => readRepoFlows(r.id, r.rootPath, t).map((f) => flowListing({ id: f.id, source: 'repo', repoId: r.id, file: f.file, rev: f.rev, toml: f.toml, fallbackName: fileStem(f.file) }, f.parsed)))
  const all = [...builtIn, ...fromRepos, ...personal.map((p) => personalFlowListing(p, t))]
  return personas ? all.map((listing) => withPersonas(listing, personas, t, listing.repoId ?? repoId)) : all
}

/** A listing with the personas its flow names resolved, and the persona problems added to its own. */
export function withPersonas(listing: FlowListing, personas: readonly PersonaListing[], t: TFunction = enT, repoId?: string): FlowListing {
  if (!listing.summary) return listing
  const parsed = parseFlow(listing.toml, listing.source, t)
  if (!('flow' in parsed)) return listing
  const lookup = (name: string) => findPersona(personas, name, repoId)
  const refs: FlowPersonaRef[] = []
  for (const name of listing.summary.personas) {
    const found = lookup(name)
    if (found) refs.push(personaRef(found))
  }
  const problems = flowPersonaProblems(parsed.flow, lookup, t)
  return { ...listing, personas: refs, problems: [...listing.problems, ...problems] }
}

/** How a flow's approval names a persona: its name, where it comes from and its revision. */
export function personaRef(p: Persona): FlowPersonaRef {
  return { name: p.name, source: p.source, ...(p.file ? { file: p.file } : {}), ...(p.rev ? { rev: p.rev } : {}), ...(p.read_only ? { readOnly: true } : {}) }
}
