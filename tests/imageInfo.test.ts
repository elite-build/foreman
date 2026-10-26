import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkspaceImage } from '../src/main/fileBrowse'
import { formatImageBytes, imageInfo, imageMetaLabel, MAX_IMAGE_PREVIEW_BYTES, previewFormat, sniffFormat } from '../src/shared/imageInfo'
import { makeRepo } from './helpers'

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number) => [(n >> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >> 8) & 255]
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]

const png = (w: number, h: number) => bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0])
// SOI, an APP0 segment to skip, a DHT (C4, not a frame), then SOF2 (progressive).
const jpeg = (w: number, h: number) =>
  bytes([0xff, 0xd8], [0xff, 0xe0], be16(16), 'JFIF', Array(10).fill(0), [0xff, 0xc4], be16(4), [0, 0], [0xff, 0xff, 0xc2], be16(17), [8], be16(h), be16(w), [3], Array(9).fill(0))
const gif = (w: number, h: number) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0])
const riff = (chunk: string, payload: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], payload)
const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)])
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14)
  return riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0])
}
const webpExtended = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])
const icoEntry = (w: number, h: number) => [w & 255, h & 255, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const ico = (...sizes: [number, number][]) => bytes([0, 0, 1, 0], le16(sizes.length), sizes.flatMap(([w, h]) => icoEntry(w, h)))
const svg = (tag: string) => new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- a comment -->\n${tag}<rect/></svg>`)

describe('imageInfo', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(imageInfo(png(512, 512), 'png')).toEqual({ format: 'png', width: 512, height: 512 })
    expect(imageInfo(png(70000, 3), 'png')).toEqual({ format: 'png', width: 70000, height: 3 })
  })

  it('reads JPEG dimensions from the first frame header, skipping other segments', () => {
    expect(imageInfo(jpeg(640, 480), 'jpeg')).toEqual({ format: 'jpeg', width: 640, height: 480 })
  })

  it('reads GIF dimensions from the logical screen', () => {
    expect(imageInfo(gif(300, 20), 'gif')).toEqual({ format: 'gif', width: 300, height: 20 })
  })

  it('reads WebP dimensions from lossy, lossless and extended files', () => {
    expect(imageInfo(webpLossy(400, 301), 'webp')).toEqual({ format: 'webp', width: 400, height: 301 })
    expect(imageInfo(webpLossless(1024, 768), 'webp')).toEqual({ format: 'webp', width: 1024, height: 768 })
    expect(imageInfo(webpExtended(5000, 4000), 'webp')).toEqual({ format: 'webp', width: 5000, height: 4000 })
  })

  it('names an icon by its largest size, 0 meaning 256', () => {
    expect(imageInfo(ico([16, 16], [0, 0], [48, 48]), 'ico')).toEqual({ format: 'ico', width: 256, height: 256 })
  })

  it('reads an SVG’s width and height, else its viewBox', () => {
    expect(imageInfo(svg('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024px">'), 'svg')).toEqual({ format: 'svg', width: 1024, height: 1024 })
    expect(imageInfo(svg('<svg viewBox="0 0 24 12" width="100%">'), 'svg')).toEqual({ format: 'svg', width: 24, height: 12 })
    expect(imageInfo(svg('<svg>'), 'svg')).toEqual({ format: 'svg' })
  })

  it('goes by the bytes when the extension is wrong', () => {
    expect(imageInfo(png(2, 3), 'jpeg')).toEqual({ format: 'png', width: 2, height: 3 })
    expect(sniffFormat(gif(1, 1))).toBe('gif')
    expect(sniffFormat(bytes('hello'))).toBeNull()
  })

  it('gives no size for a damaged or cut-off header rather than a guess', () => {
    expect(imageInfo(png(10, 10).subarray(0, 18), 'png')).toEqual({ format: 'png' })
    expect(imageInfo(jpeg(10, 10).subarray(0, 30), 'jpeg')).toEqual({ format: 'jpeg' })
    expect(imageInfo(bytes('not an image'), 'png')).toEqual({ format: 'png' })
    expect(imageInfo(new Uint8Array(0), 'webp')).toEqual({ format: 'webp' })
  })
})

describe('previewFormat', () => {
  it('previews the listed image types and nothing else', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.ico', 'g.svg'].map(previewFormat)).toEqual(['png', 'jpeg', 'jpeg', 'gif', 'webp', 'ico', 'svg'])
    expect(['a.pdf', 'b.html', 'c.bmp', 'png', 'x.png.txt'].map(previewFormat)).toEqual([null, null, null, null, null])
  })
})

describe('labels', () => {
  it('reads like the mock', () => {
    expect(imageMetaLabel({ format: 'png', width: 512, height: 512, bytes: 37274 })).toBe('PNG · 512 × 512 · 36.4 KB')
    expect(imageMetaLabel({ format: 'svg', width: 1024, height: 1024, bytes: 717 })).toBe('SVG · 1024 × 1024 · 0.7 KB')
    expect(imageMetaLabel({ format: 'svg', bytes: 717 })).toBe('SVG · 0.7 KB')
    expect(formatImageBytes(3 * 1024 * 1024 + 200 * 1024)).toBe('3.2 MB')
  })
})

describe('readWorkspaceImage', () => {
  it('sends the image as a data URL with its size', async () => {
    const repo = await makeRepo()
    const data = png(4, 2)
    await writeFile(path.join(repo, 'icon.png'), data)
    const preview = await readWorkspaceImage(repo, 'icon.png')
    expect(preview).toMatchObject({ format: 'png', width: 4, height: 2, bytes: data.length, tooLarge: false })
    expect(preview.dataUrl).toBe(`data:image/png;base64,${Buffer.from(data).toString('base64')}`)
  })

  it('sends an SVG as an image, never as markup to insert', async () => {
    const repo = await makeRepo()
    await writeFile(path.join(repo, 'x.svg'), '<svg width="8" height="8"><script>alert(1)</script></svg>')
    const preview = await readWorkspaceImage(repo, 'x.svg')
    expect(preview.dataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('sends only the size of an image over the cap', async () => {
    const repo = await makeRepo()
    await writeFile(path.join(repo, 'big.png'), Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1))
    expect(await readWorkspaceImage(repo, 'big.png')).toEqual({ format: 'png', bytes: MAX_IMAGE_PREVIEW_BYTES + 1, tooLarge: true })
  })

  it('refuses files outside the worktree and files it doesn’t preview', async () => {
    const repo = await makeRepo()
    await expect(readWorkspaceImage(repo, '../x.png')).rejects.toThrow(/outside the workspace/)
    await expect(readWorkspaceImage(repo, 'README.md')).rejects.toThrow(/can’t preview/)
  })
})
