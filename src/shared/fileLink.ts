// A link in an agent's reply that names a file on this computer, not a web page. Agents write them several ways:
// Antigravity `file:///C:/…` and `</C:/…>`, Claude and Codex a path relative to the worktree (`src/a.ts`, `src/a.ts#L42`,
// `src/a.ts:42`). Pure, so the reply's Markdown can tell such a link from a web one; main checks the path again on open.
import { isAbsolutePath } from './fileOpen'
import { joinWorkspace } from './openIn'

/** A URL scheme (`https:`, `mailto:`), not a drive letter (`C:\`, `C:/`). */
const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i

/** Whether a link's target is written as a path, so Markdown must keep it (it drops `file:` and `C:` as unsafe schemes). */
export function looksLikeFileLink(href: string): boolean {
  return /^file:/i.test(href) || DRIVE.test(href)
}

/**
 * The full path a link names, or null for a web address, another scheme or an anchor in the page. A relative path is
 * the worktree's (`root`); without a root it opens nothing. A line (`#L42`, `:42`) is dropped: the file opens.
 */
export function fileLinkPath(href: string, root?: string): string | null {
  let target = href.trim()
  if (!target || target.startsWith('#')) return null
  if (/^file:/i.test(target)) target = target.replace(/^file:(\/\/(localhost)?)?/i, '')
  else if (SCHEME.test(target) && !DRIVE.test(target)) return null
  target = target.replace(/[?#].*$/, '')
  try {
    target = decodeURIComponent(target)
  } catch {
    // A stray % in a name: the path as written.
  }
  // `/C:/…` is a Windows drive path written as a URL's path.
  if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1)
  target = target.replace(/:\d+(?::\d+)?$/, '').trim()
  if (!target) return null
  if (isAbsolutePath(target)) return target
  return root ? joinWorkspace(root, target.replace(/^\.[\\/]/, '')) : null
}
