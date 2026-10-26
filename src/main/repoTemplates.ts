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

/** The repo's templates, sorted by file name, re-read only when a file changed. */
export function readRepoTemplates(repoId: string, rootPath: string): PromptTemplate[] {
  const dir = path.join(rootPath, REPO_TEMPLATE_DIR)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort()
  } catch {
    cache.delete(repoId)
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
  const hit = cache.get(repoId)
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
