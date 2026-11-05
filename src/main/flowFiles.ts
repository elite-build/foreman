// Flow documents (docs/loops-and-graphs.md): a repository's .foreman/flows/*.toml, the built-in starters and the
// personal flows kept in state.json, listed together for Automations. Read-only for the repository: Foreman never
// writes these files, and only regular files inside the repo are read, as for repository templates.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FLOW_STARTERS } from '../shared/flowStarters'
import { FLOW_DIR, flowSummary, MAX_FLOW_BYTES, MAX_REPO_FLOWS, parseFlow, type FlowListing, type FlowParse, type FlowSource, type PersonalFlow } from '../shared/flows'
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

interface RawFile {
  file: string
  rev: string
  toml: string
  tooLarge: boolean
}

// The files as last read, per repo; parsing them again is cheap, and follows the language asked for.
const cache = new Map<string, { key: string; raw: RawFile[] }>()
const checked = new Map<string, { rootPath: string; at: number }>()

/** Look at every repo's flows folder again on the next read, whatever `maxAgeMs` says. */
export function revalidateRepoFlows(): void {
  checked.clear()
}

/** The repo's flow files, sorted by file name, read again only when a file's size or time changed. Bad files are listed with their problems, never thrown. */
export function readRepoFlows(repoId: string, rootPath: string, t: TFunction = enT, options: RepoFileReadOptions = {}): FlowFile[] {
  const now = Date.now()
  const last = checked.get(repoId)
  const hit = cache.get(repoId)
  const fresh = hit && last?.rootPath === rootPath && options.maxAgeMs && now - last.at >= 0 && now - last.at < options.maxAgeMs
  if (!fresh) {
    checked.set(repoId, { rootPath, at: now })
    const key = listingKey(rootPath)
    if (hit?.key !== key) cache.set(repoId, { key, raw: readRaw(rootPath) })
  }
  return cache.get(repoId)!.raw.map((raw) => ({
    id: `repo:${repoId}:${raw.file}`,
    repoId,
    file: raw.file,
    rev: raw.rev,
    toml: raw.toml,
    parsed: raw.tooLarge ? { problems: [t('flows.problem.tooLarge', { kb: Math.round(MAX_FLOW_BYTES / 1024) })], warnings: [] } : parseFlow(raw.toml, 'repo', t)
  }))
}

/** The flows folder's file names with their size and time: what decides whether to read the files again. */
function listingKey(rootPath: string): string {
  const dir = path.join(rootPath, FLOW_DIR)
  const stamps: string[] = []
  for (const name of flowNames(dir)) {
    try {
      const st = lstatSync(path.join(dir, name))
      if (st.isFile()) stamps.push(`${name}:${st.mtimeMs}:${st.size}`)
    } catch {
      // Vanished between the listing and the stat.
    }
  }
  return `${rootPath}\0${stamps.join('|')}`
}

function flowNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /\.toml$/i.test(n))
      .sort()
      .slice(0, MAX_REPO_FLOWS)
  } catch {
    return []
  }
}

function readRaw(rootPath: string): RawFile[] {
  const dir = path.join(rootPath, FLOW_DIR)
  const out: RawFile[] = []
  for (const name of flowNames(dir)) {
    const file = `${FLOW_DIR}/${name}`
    try {
      const full = path.join(dir, name)
      const st = lstatSync(full)
      // Regular files only: a symlink could point outside the repository.
      if (!st.isFile()) continue
      if (st.size > MAX_FLOW_BYTES) {
        out.push({ file, rev: '', toml: '', tooLarge: true })
        continue
      }
      const content = readFileSync(full)
      out.push({ file, rev: blobSha(content), toml: content.toString('utf8').replace(/^﻿/, ''), tooLarge: false })
    } catch {
      // Unreadable: skipped, like a file that vanished.
    }
  }
  return out
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

/** Built-in starters, then each repository's files (only `repoId`'s when given), then personal flows. */
export function listFlows(repos: { id: string; rootPath: string }[], personal: PersonalFlow[], t: TFunction = enT, repoId?: string): FlowListing[] {
  const builtIn = FLOW_STARTERS.map((s) => flowListing({ id: `built-in:${s.id}`, source: 'built-in', starter: s.id, toml: s.toml, fallbackName: s.id }, parseFlow(s.toml, 'built-in', t)))
  const fromRepos = repos
    .filter((r) => !repoId || r.id === repoId)
    .flatMap((r) => readRepoFlows(r.id, r.rootPath, t).map((f) => flowListing({ id: f.id, source: 'repo', repoId: r.id, file: f.file, rev: f.rev, toml: f.toml, fallbackName: fileStem(f.file) }, f.parsed)))
  return [...builtIn, ...fromRepos, ...personal.map((p) => personalFlowListing(p, t))]
}
