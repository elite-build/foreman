// Sandboxed previews of HTML pages and PDFs in the file viewer (#19). A page is
// served from the worktree through Foreman's own foreman-preview:// protocol,
// one unguessable host per workspace, with a Content-Security-Policy that
// allows nothing but that host's own files: no scripts, no network, no frames,
// no forms. The window's frame adds sandbox="" (an opaque origin, no scripts);
// a PDF can't be in a sandboxed frame (Chromium refuses to show it there), so
// it relies on the protocol's own origin, the CSP, and the navigation rule
// below. Pure, so the rules are tested without Electron.

export const PREVIEW_SCHEME = 'foreman-preview'

/** Files the viewer can show in a sandboxed frame. */
export type FramePreview = 'html' | 'pdf'

export function framePreview(path: string): FramePreview | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'pdf') return 'pdf'
  return null
}

// Largest file the protocol serves (a PDF or an image a page uses).
export const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024

/** A host for a workspace's previews: 32 hex characters, so it is a valid URL host and can't be guessed. */
export const PREVIEW_HOST = /^[0-9a-f]{32}$/

/**
 * Types a preview may load. Anything that could run (scripts, wasm) is served as plain text,
 * so it can't run even if the CSP were somehow missing; anything unknown is octet-stream.
 */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8',
  mjs: 'text/plain; charset=utf-8',
  cjs: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  wasm: 'application/octet-stream'
}

export function previewMime(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && MIME[ext]) || 'application/octet-stream'
}

/** The origin a workspace's previews come from. */
export function previewOrigin(host: string): string {
  return `${PREVIEW_SCHEME}://${host}`
}

/**
 * The policy on every response: `default-src 'none'`, so scripts, connections, frames, objects and
 * workers are all refused; pictures, styles, fonts and media only from this workspace's own host
 * (and inline data); no form posts, no <base>, and `sandbox` so the page is an opaque origin with
 * no scripts even outside the window's sandboxed frame.
 */
export function previewCsp(host: string): string {
  const self = previewOrigin(host)
  return [
    "default-src 'none'",
    `img-src ${self} data:`,
    `style-src ${self} 'unsafe-inline'`,
    `font-src ${self} data:`,
    `media-src ${self}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox'
  ].join('; ')
}

/** Headers for a served file: its type, the policy, and no sniffing, caching, referrers or DNS prefetch. */
export function previewHeaders(path: string, host: string): Record<string, string> {
  return {
    'Content-Type': previewMime(path),
    'Content-Security-Policy': previewCsp(host),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-DNS-Prefetch-Control': 'off'
  }
}

/** The preview URL for a worktree-relative path: each segment encoded, so names with spaces or # work. */
export function previewUrl(host: string, relative: string): string {
  const path = relative
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
    .map(encodeURIComponent)
    .join('/')
  return `${previewOrigin(host)}/${path}`
}

/**
 * A request's host and worktree-relative path, or null when it isn't one of ours or reaches
 * for something it mustn't: another scheme, a malformed host, a NUL, a ".." left after the URL
 * parser's own clean-up, a backslash or drive letter (a way out on Windows), or .git.
 */
export function parsePreviewRequest(url: string): { host: string; relative: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:` || !PREVIEW_HOST.test(parsed.hostname)) return null
  let segments: string[]
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (!segments.length) return null
  for (const s of segments) {
    if (s === '..' || s === '.' || s.includes('\0') || /[\\/:]/.test(s) || s.toLowerCase() === '.git') return null
  }
  return { host: parsed.hostname, relative: segments.join('/') }
}

// Chromium's built-in PDF viewer: the page that draws a PDF lives under this extension.
export const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'

/**
 * Where a frame inside the window may navigate: only to a preview, the PDF viewer's own pages, or a
 * blank page. A link in a preview that points at the web is stopped here (the CSP can't stop navigation).
 */
export function frameMayNavigate(url: string): boolean {
  return url.startsWith(`${PREVIEW_SCHEME}://`) || url.startsWith(PDF_VIEWER_ORIGIN) || url === 'about:blank'
}
