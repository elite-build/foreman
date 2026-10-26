// foreman-preview:// (#19): serves a worktree's files to the file viewer's
// sandboxed HTML and PDF previews. Each workspace gets a random host for the
// app's lifetime; a request is answered only from that workspace's worktree,
// never through a link that leaves it, never from .git, and always with the
// preview CSP (see shared/preview.ts). Registered in index.ts.
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_PREVIEW_FILE_BYTES, parsePreviewRequest, previewCsp, previewHeaders, previewUrl } from '../shared/preview'
import { insideWorkspace } from './files'

export class PreviewServer {
  private hosts = new Map<string, string>()
  private workspaces = new Map<string, string>()

  /** `worktree` gives a live workspace's folder, or undefined (archived, history only, gone). */
  constructor(private worktree: (workspaceId: string) => string | undefined) {}

  private hostFor(workspaceId: string): string {
    let host = this.hosts.get(workspaceId)
    if (!host) {
      host = randomBytes(16).toString('hex')
      this.hosts.set(workspaceId, host)
      this.workspaces.set(host, workspaceId)
    }
    return host
  }

  /** The URL the viewer's frame loads for a file in the workspace. Refuses a path outside the worktree. */
  async urlFor(workspaceId: string, relative: string): Promise<string> {
    const root = this.worktree(workspaceId)
    if (!root) throw new Error('This workspace has no folder to preview from')
    await this.resolve(root, relative.replace(/\\/g, '/'))
    return previewUrl(this.hostFor(workspaceId), relative)
  }

  /** Archived or removed: its host stops answering. */
  forget(workspaceId: string): void {
    const host = this.hosts.get(workspaceId)
    if (!host) return
    this.hosts.delete(workspaceId)
    this.workspaces.delete(host)
  }

  /** The file's full path, if it is a file inside the worktree once every link is followed. */
  private async resolve(root: string, relative: string): Promise<{ full: string; size: number }> {
    if (relative.split('/').some((s) => s.toLowerCase() === '.git')) throw new Error('Not served')
    const full = insideWorkspace(root, relative)
    const [realRoot, real] = await Promise.all([realpath(root), realpath(full)])
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('That file is outside the workspace')
    const info = await stat(real)
    if (!info.isFile()) throw new Error(`${relative} is not a file`)
    return { full: real, size: info.size }
  }

  /** Answer one request. Anything refused is a bare 404 that still carries the policy. */
  async handle(url: string, method = 'GET'): Promise<Response> {
    const target = parsePreviewRequest(url)
    const workspaceId = target && this.workspaces.get(target.host)
    const root = workspaceId ? this.worktree(workspaceId) : undefined
    const refuse = (status: number) =>
      new Response(null, { status, headers: { 'Content-Security-Policy': previewCsp(target?.host ?? '00000000000000000000000000000000'), 'Cache-Control': 'no-store' } })
    if (method !== 'GET' && method !== 'HEAD') return refuse(405)
    if (!target || !root) return refuse(404)
    try {
      const file = await this.resolve(root, target.relative)
      if (file.size > MAX_PREVIEW_FILE_BYTES) return refuse(413)
      const body = method === 'HEAD' ? null : await readFile(file.full)
      return new Response(body, { status: 200, headers: previewHeaders(target.relative, target.host) })
    } catch {
      return refuse(404)
    }
  }
}
