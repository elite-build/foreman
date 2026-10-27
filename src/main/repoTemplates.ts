// Reads a repository's .foreman/templates (R-1). Read-only: Foreman never
// writes these files, and only regular files inside the repo are read.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_REPO_TEMPLATES, MAX_REPO_TEMPLATE_BYTES, parseRepoTemplate, REPO_TEMPLATE_DIR } from '../shared/repoTemplates'
import type { PromptTemplate } from '../shared/types'

/** The git blob SHA of some content: the revision `git hash-object` would give the file. */
export function blobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

const cache = new Map<string, { key: string; templates: PromptTemplate[] }>()
// When each repo's folder was last listed, for readers that accept an answer a few seconds old (the snapshot).
const checked = new Map<string, { rootPath: string; at: number }>()

export interface RepoFileReadOptions {
  // Reuse the last answer when the folder was looked at less than this long ago, without touching the disk.
  maxAgeMs?: number
}

/** Look at every repo's templates folder again on the next read, whatever `maxAgeMs` says. */
export function revalidateRepoTemplates(): void {
  checked.clear()
}

/** The repo's templates, sorted by file name, re-read only when a file changed. */
export function readRepoTemplates(repoId: string, rootPath: string, options: RepoFileReadOptions = {}): PromptTemplate[] {
  const now = Date.now()
  const last = checked.get(repoId)
  const hit = cache.get(repoId)
  if (hit && last?.rootPath === rootPath && options.maxAgeMs && now - last.at >= 0 && now - last.at < options.maxAgeMs) return hit.templates
  checked.set(repoId, { rootPath, at: now })
  const dir = path.join(rootPath, REPO_TEMPLATE_DIR)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort()
  } catch {
    // Kept as an empty answer, so a repo without the folder isn't listed again on every read.
    cache.set(repoId, { key: `${rootPath}\0`, templates: [] })
    return []
  }
  const files: { name: string; stamp: string }[] = []
  for (const name of names.slice(0, MAX_REPO_TEMPLATES)) {
    try {
      const st = lstatSync(path.join(dir, name))
      if (st.isFile() && st.size <= MAX_REPO_TEMPLATE_BYTES) files.push({ name, stamp: `${name}:${st.mtimeMs}:${st.size}` })
    } catch {
      // Vanished between the listing and the stat.
    }
  }
  const key = `${rootPath}\0${files.map((f) => f.stamp).join('|')}`
  if (hit?.key === key) return hit.templates
  const templates: PromptTemplate[] = []
  const seen = new Set<string>()
  for (const { name } of files) {
    try {
      const content = readFileSync(path.join(dir, name))
      const template = parseRepoTemplate(repoId, `${REPO_TEMPLATE_DIR}/${name}`, content.toString('utf8'), blobSha(content))
      if (template && !seen.has(template.id)) {
        seen.add(template.id)
        templates.push(template)
      }
    } catch {
      // Unreadable: skipped, like any other malformed file.
    }
  }
  cache.set(repoId, { key, templates })
  return templates
}
