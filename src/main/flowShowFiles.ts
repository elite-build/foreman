// A file a flow's gate shows (docs/loops-and-graphs.md, "Steps": gate): a path relative to the workspace, where a `*`
// or `?` in a part of it means the newest file that matches. Read in the workspace's own folder, never outside it, and
// cut to a size limit.
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_GATE_FILE_BYTES, showPathProblem } from '../shared/flows'
import type { FlowShownFile } from './flows'

// A pattern's matches are looked at up to this many, so a wide glob can't walk a whole repository.
const MAX_MATCHES = 500

/** One part of a path pattern as a regex: `*` any run of characters but a slash, `?` one. */
function partPattern(part: string): RegExp {
  const out = [...part].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${out}$`)
}

/** The file `pattern` names under `root` (the newest match for a glob), its content cut to `maxBytes`, or why there is none. */
export async function readShownFile(root: string, pattern: string, maxBytes = MAX_GATE_FILE_BYTES): Promise<FlowShownFile> {
  const wanted = pattern.trim().replace(/^\.\//, '')
  if (showPathProblem(wanted)) return { missing: `“${pattern}” isn’t a path inside the workspace` }
  let candidates = ['']
  const parts = wanted.split('/')
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1
    const next: string[] = []
    for (const dir of candidates) {
      if (!/[*?]/.test(part)) {
        next.push(dir ? `${dir}/${part}` : part)
        continue
      }
      const re = partPattern(part)
      const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) if (re.test(entry.name) && (last ? entry.isFile() : entry.isDirectory())) next.push(dir ? `${dir}/${entry.name}` : entry.name)
    }
    candidates = next.slice(0, MAX_MATCHES)
  }
  const home = await realpath(root).catch(() => path.resolve(root))
  let best: { rel: string; full: string; mtime: number } | undefined
  for (const rel of candidates) {
    const full = await realpath(path.join(root, rel)).catch(() => '')
    // A link that leads out of the workspace isn't followed.
    if (!full || (full !== home && !full.startsWith(home + path.sep))) continue
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) continue
    if (!best || info.mtimeMs > best.mtime) best = { rel, full, mtime: info.mtimeMs }
  }
  if (!best) return { missing: `No file matches ${wanted} in the workspace` }
  const bytes = await readFile(best.full)
  const cut = bytes.length > maxBytes
  const text = (cut ? bytes.subarray(0, maxBytes) : bytes).toString('utf8').replace(/�+$/, '')
  return { path: best.rel, text, cut }
}
