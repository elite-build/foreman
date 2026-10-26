// #19 (G3): the sandboxed HTML/PDF preview protocol and its path guard, EXIF orientation for
// JPEG sizes, and an image read at a commit for the diff's before side.
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readImageAtCommit } from '../src/main/fileBrowse'
import { git } from '../src/main/git'
import { PreviewServer } from '../src/main/previewProtocol'
import { imageInfo, jpegOrientation } from '../src/shared/imageInfo'
import {
  framePreview,
  frameMayNavigate,
  MAX_PREVIEW_FILE_BYTES,
  parsePreviewRequest,
  previewCsp,
  previewHeaders,
  previewMime,
  previewUrl
} from '../src/shared/preview'
import { commit, makeRepo, tempDir } from './helpers'

const HOST = '0123456789abcdef0123456789abcdef'

describe('preview policy', () => {
  it('previews HTML and PDF files only', () => {
    expect(framePreview('site/index.html')).toBe('html')
    expect(framePreview('A.HTM')).toBe('html')
    expect(framePreview('docs/spec.pdf')).toBe('pdf')
    expect(framePreview('notes.md')).toBeNull()
    expect(framePreview('html')).toBeNull()
  })

  it('allows nothing by default: no scripts, connections, frames, objects, workers or forms', () => {
    const csp = previewCsp(HOST)
    const directives = new Map(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]))
    expect(directives.get('default-src')).toBe("'none'")
    // Nothing widens scripts or the network: they fall back to 'none'.
    for (const name of ['script-src', 'script-src-elem', 'script-src-attr', 'connect-src', 'prefetch-src', 'navigate-to']) expect(directives.has(name)).toBe(false)
    for (const name of ['frame-src', 'child-src', 'worker-src', 'object-src', 'form-action', 'base-uri']) expect(directives.get(name)).toBe("'none'")
    expect(directives.has('sandbox')).toBe(true)
    expect(directives.get('sandbox')).toBe('')
  })

  it('loads pictures, styles, fonts and media only from the workspace’s own preview host', () => {
    const csp = previewCsp(HOST)
    for (const name of ['img-src', 'style-src', 'font-src', 'media-src']) {
      const sources = csp.split('; ').find((d) => d.startsWith(`${name} `))!.split(' ').slice(1)
      expect(sources[0]).toBe(`foreman-preview://${HOST}`)
      // No scheme-wide or web sources, so another workspace's previews and the internet are out.
      for (const s of sources) expect(['https:', 'http:', '*', 'foreman-preview:', "'self'"]).not.toContain(s)
    }
  })

  it('serves anything runnable as plain text and never lets the browser sniff a type', () => {
    expect(previewMime('app.js')).toBe('text/plain; charset=utf-8')
    expect(previewMime('mod.mjs')).toBe('text/plain; charset=utf-8')
    expect(previewMime('x.wasm')).toBe('application/octet-stream')
    expect(previewMime('page.html')).toBe('text/html; charset=utf-8')
    expect(previewMime('doc.PDF')).toBe('application/pdf')
    expect(previewMime('mystery')).toBe('application/octet-stream')
    const headers = previewHeaders('index.html', HOST)
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Content-Security-Policy']).toBe(previewCsp(HOST))
    expect(headers['Referrer-Policy']).toBe('no-referrer')
    expect(headers['Cache-Control']).toBe('no-store')
  })

  it('builds URLs with each segment encoded', () => {
    expect(previewUrl(HOST, 'site/my page#1.html')).toBe(`foreman-preview://${HOST}/site/my%20page%231.html`)
    expect(previewUrl(HOST, 'docs\\a.pdf')).toBe(`foreman-preview://${HOST}/docs/a.pdf`)
  })

  it('parses its own requests and refuses ways out', () => {
    expect(parsePreviewRequest(`foreman-preview://${HOST}/site/my%20page.html`)).toEqual({ host: HOST, relative: 'site/my page.html' })
    expect(parsePreviewRequest(`https://${HOST}/a.html`)).toBeNull()
    expect(parsePreviewRequest('foreman-preview://not-a-host/a.html')).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/`)).toBeNull()
    // The URL parser resolves %2e%2e like .., at the root: it stays inside.
    expect(parsePreviewRequest(`foreman-preview://${HOST}/%2e%2e/secret`)).toEqual({ host: HOST, relative: 'secret' })
    // Encoded slashes and backslashes survive the URL parser; they're refused here.
    expect(parsePreviewRequest(`foreman-preview://${HOST}/a%2f..%2f..%2fsecret`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/..%5C..%5Csecret`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/C:%5CWindows%5Cwin.ini`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/a%00.html`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/.git/config`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/sub/.GIT/config`)).toBeNull()
    expect(parsePreviewRequest(`foreman-preview://${HOST}/%E0%A4%A`)).toBeNull()
    // Plain ../ is cleaned up by the URL parser itself and stays under the root.
    expect(parsePreviewRequest(`foreman-preview://${HOST}/a/../../b.html`)).toEqual({ host: HOST, relative: 'b.html' })
  })

  it('lets frames move only between previews and the PDF viewer', () => {
    expect(frameMayNavigate(`foreman-preview://${HOST}/b.html`)).toBe(true)
    expect(frameMayNavigate('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')).toBe(true)
    expect(frameMayNavigate('about:blank')).toBe(true)
    expect(frameMayNavigate('https://example.com/')).toBe(false)
    expect(frameMayNavigate('file:///C:/Windows/win.ini')).toBe(false)
    expect(frameMayNavigate('chrome-extension://otherextension/index.html')).toBe(false)
    expect(frameMayNavigate('javascript:alert(1)')).toBe(false)
    expect(frameMayNavigate('data:text/html,<script>1</script>')).toBe(false)
  })
})

describe('PreviewServer', () => {
  async function setup() {
    const root = await tempDir('foreman-preview-')
    const outside = await tempDir('foreman-outside-')
    await mkdir(path.join(root, 'site'))
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, 'site', 'index.html'), '<h1>hi</h1>')
    await writeFile(path.join(root, 'site', 'app.js'), 'alert(1)')
    await writeFile(path.join(root, '.git', 'config'), '[core]')
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    const live = new Map([['w1', root]])
    const server = new PreviewServer((id) => live.get(id))
    return { root, outside, live, server }
  }
  const hostOf = (url: string) => new URL(url).hostname

  it('serves a worktree file with the policy, from a random host per workspace', async () => {
    const { server } = await setup()
    const url = await server.urlFor('w1', 'site/index.html')
    expect(url).toMatch(/^foreman-preview:\/\/[0-9a-f]{32}\/site\/index\.html$/)
    expect(await server.urlFor('w1', 'site/app.js')).toContain(hostOf(url))
    const res = await server.handle(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
    expect(res.headers.get('content-security-policy')).toBe(previewCsp(hostOf(url)))
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const js = await server.handle(url.replace('index.html', 'app.js'))
    expect(js.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const head = await server.handle(url, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('refuses everything outside the worktree, .git, other methods and unknown hosts, with the policy still on', async () => {
    const { server, outside } = await setup()
    const url = await server.urlFor('w1', 'site/index.html')
    const base = `foreman-preview://${hostOf(url)}`
    const statuses = await Promise.all(
      [`${base}/%2e%2e/%2e%2e/secret.txt`, `${base}/.git/config`, `${base}/site`, `${base}/missing.html`, `foreman-preview://${HOST}/site/index.html`, `${base}/${encodeURIComponent(outside)}`].map(
        async (u) => (await server.handle(u)).status
      )
    )
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404])
    const refused = await server.handle(`${base}/.git/config`)
    expect(refused.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect((await server.handle(url, 'POST')).status).toBe(405)
    await expect(server.urlFor('w1', '../secret.txt')).rejects.toThrow()
    await expect(server.urlFor('w1', '.git/config')).rejects.toThrow()
  })

  it('never follows a link out of the worktree', async () => {
    const { server, root, outside } = await setup()
    // A junction on Windows needs no privileges; elsewhere a plain directory link.
    await symlink(outside, path.join(root, 'site', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const url = await server.urlFor('w1', 'site/index.html')
    expect((await server.handle(url.replace('index.html', 'escape/secret.txt'))).status).toBe(404)
    await expect(server.urlFor('w1', 'site/escape/secret.txt')).rejects.toThrow(/outside/)
  })

  it('stops answering for an archived or forgotten workspace, and caps the size', async () => {
    const { server, live, root } = await setup()
    const url = await server.urlFor('w1', 'site/index.html')
    await writeFile(path.join(root, 'big.pdf'), '')
    await truncate(path.join(root, 'big.pdf'), MAX_PREVIEW_FILE_BYTES + 1)
    expect((await server.handle(url.replace('site/index.html', 'big.pdf'))).status).toBe(413)
    live.delete('w1')
    expect((await server.handle(url)).status).toBe(404)
    await expect(server.urlFor('w1', 'site/index.html')).rejects.toThrow()
    live.set('w1', root)
    server.forget('w1')
    expect((await server.handle(url)).status).toBe(404)
    // A new host after forgetting; the old one stays dead.
    expect(hostOf(await server.urlFor('w1', 'site/index.html'))).not.toBe(hostOf(url))
  })
})

// A JPEG with an EXIF APP1 segment (orientation tag in IFD0), then a baseline frame header.
const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
function exifJpeg(w: number, h: number, orientation: number, order: 'II' | 'MM' = 'II'): Uint8Array {
  const u16 = order === 'II' ? le16 : be16
  const u32 = (n: number) => (order === 'II' ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])
  const tiff = [...[...order].map((c) => c.charCodeAt(0)), ...u16(42), ...u32(8), ...u16(2), ...u16(0x010f), ...u16(2), ...u32(4), ...u32(0), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)]
  const app1 = [...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0], tiff)
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...be16(app1.length + 2), ...app1, 0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, ...Array(9).fill(0)])
}

describe('EXIF orientation', () => {
  it('swaps width and height for a picture shown turned a quarter (5–8)', () => {
    expect(imageInfo(exifJpeg(4032, 3024, 6), 'jpeg')).toEqual({ format: 'jpeg', width: 3024, height: 4032, orientation: 6 })
    expect(imageInfo(exifJpeg(4032, 3024, 8, 'MM'), 'jpeg')).toEqual({ format: 'jpeg', width: 3024, height: 4032, orientation: 8 })
    expect(imageInfo(exifJpeg(400, 300, 5), 'jpeg')).toMatchObject({ width: 300, height: 400 })
  })

  it('keeps the stored size for upright or mirrored-only orientations', () => {
    expect(imageInfo(exifJpeg(400, 300, 1), 'jpeg')).toEqual({ format: 'jpeg', width: 400, height: 300 })
    expect(imageInfo(exifJpeg(400, 300, 3), 'jpeg')).toEqual({ format: 'jpeg', width: 400, height: 300, orientation: 3 })
    expect(jpegOrientation(exifJpeg(400, 300, 2))).toBe(2)
  })

  it('ignores a missing, cut-off or nonsense orientation', () => {
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(30), ...be16(40), 3, ...Array(9).fill(0)])
    expect(jpegOrientation(plain)).toBeUndefined()
    expect(imageInfo(plain, 'jpeg')).toEqual({ format: 'jpeg', width: 40, height: 30 })
    const full = exifJpeg(400, 300, 6)
    expect(jpegOrientation(full.subarray(0, 20))).toBeUndefined()
    expect(jpegOrientation(exifJpeg(400, 300, 9))).toBeUndefined()
  })
})

describe('an image at a commit', () => {
  const png = (w: number, h: number) => {
    const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0])
  }

  it('reads the before side from git, bytes intact', async () => {
    const repo = await makeRepo({ 'README.md': 'x\n' })
    await mkdir(path.join(repo, 'img'))
    await writeFile(path.join(repo, 'img', 'logo.png'), png(16, 16))
    await git(repo, ['add', '-A'])
    await commit(repo, 'logo')
    const before = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(path.join(repo, 'img', 'logo.png'), png(32, 8))
    const old = await readImageAtCommit(repo, 'img/logo.png', before)
    expect(old).toMatchObject({ format: 'png', width: 16, height: 16, tooLarge: false })
    expect(old.dataUrl).toBe(`data:image/png;base64,${png(16, 16).toString('base64')}`)
  })

  it('takes only a commit id and a plain path', async () => {
    const repo = await makeRepo({ 'a.png': 'not really' })
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    await expect(readImageAtCommit(repo, 'a.png', 'HEAD')).rejects.toThrow(/commit id/)
    await expect(readImageAtCommit(repo, 'a.png', '--output=x')).rejects.toThrow(/commit id/)
    await expect(readImageAtCommit(repo, '../a.png', head)).rejects.toThrow()
    await expect(readImageAtCommit(repo, 'missing.png', head)).rejects.toThrow(/isn’t in that commit/)
    await expect(readImageAtCommit(repo, 'notes.txt', head)).rejects.toThrow(/can’t preview/)
  })
})
