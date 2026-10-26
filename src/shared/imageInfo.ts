// Image previews in the file viewer (#19): which files open as a picture, and
// their type and size in pixels read from the file's own header, so the
// viewer can say "PNG · 512 × 512 · 36.4 KB" without decoding anything. Pure,
// so main (which reads the file) and the renderer (which labels it) share it.
import { createT, type TFunction } from './i18n'

const enT = createT('en')

// Larger images aren't sent to the window; the viewer offers the editor instead.
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'ico' | 'svg'

/** What the main process sends for a preview: the bytes as a data URL, or only the size when over the cap. */
export interface ImagePreview {
  format: ImageFormat
  // Undefined when the header doesn't say (a damaged file, or an SVG without a size). As shown: a JPEG's EXIF turn applied.
  width?: number
  height?: number
  // A JPEG's EXIF orientation when it isn't the plain 1.
  orientation?: number
  bytes: number
  tooLarge: boolean
  // data:<mime>;base64,… (absent when tooLarge). Shown through <img>, so an SVG's scripts never run.
  dataUrl?: string
}

export const IMAGE_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

const FORMAT_NAME: Record<ImageFormat, string> = { png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', ico: 'ICO', svg: 'SVG' }

/** "PNG", "JPEG", "WebP"…: the format as people name it. */
export function imageFormatName(format: ImageFormat): string {
  return FORMAT_NAME[format]
}

const EXTENSIONS: Record<string, ImageFormat> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', ico: 'ico', svg: 'svg' }

/** The preview a path gets from its extension, or null for files shown as text. */
export function previewFormat(path: string): ImageFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return (ext && EXTENSIONS[ext]) || null
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

/** The format the bytes really are, whatever the extension says; null when none of ours. */
export function sniffFormat(b: Uint8Array): Exclude<ImageFormat, 'svg'> | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && u16le(b, 4) > 0) return 'ico'
  return null
}

type Size = { width: number; height: number } | null

function pngSize(b: Uint8Array): Size {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function gifSize(b: Uint8Array): Size {
  return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null
}

// Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but don't.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(b: Uint8Array): Size {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    // Fill bytes before a marker.
    if (marker === 0xff) {
      i++
      continue
    }
    // Markers with no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(b, i + 2)
    if (SOF.has(marker)) return i + 8 < b.length ? { width: u16be(b, i + 7), height: u16be(b, i + 5) } : null
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

/**
 * The EXIF orientation (1–8) in a JPEG's APP1 segment, or undefined when it has none. 5–8 mean the
 * picture is shown turned a quarter, so its width and height swap (the browser applies it to <img>).
 */
export function jpegOrientation(b: Uint8Array): number | undefined {
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = u16be(b, i + 2)
    if (length < 2) return undefined
    if (marker === 0xe1 && i + 10 < b.length && ascii(b, i + 4, 4) === 'Exif' && b[i + 8] === 0 && b[i + 9] === 0) return exifOrientation(b, i + 10, Math.min(b.length, i + 2 + length))
    i += 2 + length
  }
  return undefined
}

/** Tag 0x0112 in IFD0 of the TIFF structure starting at `tiff` (and ending before `end`). */
function exifOrientation(b: Uint8Array, tiff: number, end: number): number | undefined {
  if (tiff + 8 > end) return undefined
  const order = ascii(b, tiff, 2)
  if (order !== 'II' && order !== 'MM') return undefined
  const little = order === 'II'
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at))
  const u32 = (at: number) => (little ? u16le(b, at) + u16le(b, at + 2) * 0x10000 : u32be(b, at))
  if (u16(tiff + 2) !== 42) return undefined
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return undefined
  const count = u16(ifd)
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12
    if (entry + 12 > end) return undefined
    if (u16(entry) !== 0x0112) continue
    // SHORT (type 3), one value, kept in the first two bytes of the value field.
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? value : undefined
  }
  return undefined
}

function webpSize(b: Uint8Array): Size {
  if (b.length < 30) return null
  const chunk = ascii(b, 12, 4)
  // Lossy: a 14-bit size after the frame's start code.
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  // Lossless: two 14-bit fields, stored minus one, after the 0x2f signature.
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    return {
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))
    }
  }
  // Extended (alpha, animation): 24-bit canvas size, stored minus one.
  if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
  return null
}

/** An icon file holds several sizes; the largest is the one worth naming. 0 in a byte means 256. */
function icoSize(b: Uint8Array): Size {
  const count = u16le(b, 4)
  let best: Size = null
  for (let n = 0; n < count && 6 + 16 * n + 1 < b.length; n++) {
    const at = 6 + 16 * n
    const width = b[at] || 256
    const height = b[at + 1] || 256
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

function svgLength(value: string | undefined): number | null {
  const m = value && /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value)
  return m ? Number(m[1]) : null
}

/** width and height on the <svg> tag when they're plain numbers (or px); otherwise the viewBox's size. */
function svgSize(b: Uint8Array): Size {
  const text = new TextDecoder().decode(b.subarray(0, 64 * 1024))
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!tag) return null
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const width = svgLength(attr('width'))
  const height = svgLength(attr('height'))
  if (width && height) return { width: Math.round(width), height: Math.round(height) }
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2] > 0 && box[3] > 0) return { width: Math.round(box[2]), height: Math.round(box[3]) }
  return null
}

/**
 * The image's real format (sniffed from its bytes, else what the extension
 * says) and its size in pixels from the header. No size when the header is
 * damaged or doesn't say. A JPEG whose EXIF orientation turns it a quarter (5–8) reports its size as
 * shown, width and height swapped, since the browser draws it turned.
 */
export function imageInfo(bytes: Uint8Array, fromExtension: ImageFormat): { format: ImageFormat; width?: number; height?: number; orientation?: number } {
  const format = fromExtension === 'svg' ? 'svg' : sniffFormat(bytes) ?? fromExtension
  const read = { png: pngSize, jpeg: jpegSize, gif: gifSize, webp: webpSize, ico: icoSize, svg: svgSize }[format]
  let size: Size = null
  try {
    size = read(bytes)
  } catch {
    size = null
  }
  let orientation: number | undefined
  if (format === 'jpeg') {
    try {
      orientation = jpegOrientation(bytes)
    } catch {
      orientation = undefined
    }
  }
  const turned = orientation !== undefined && orientation >= 5
  const extra = orientation && orientation !== 1 ? { orientation } : {}
  if (!size || size.width <= 0 || size.height <= 0) return { format, ...extra }
  return turned ? { format, width: size.height, height: size.width, ...extra } : { format, width: size.width, height: size.height, ...extra }
}

/** "0.7 KB", "36.4 KB", "2.1 MB". */
export function formatImageBytes(bytes: number, t: TFunction = enT): string {
  if (bytes < 1024 * 1024) return t('files.image.kb', { size: (bytes / 1024).toFixed(1) })
  return t('files.image.mb', { size: (bytes / 1024 / 1024).toFixed(1) })
}

/** The viewer's header line: "PNG · 512 × 512 · 36.4 KB", leaving out a size the file doesn't state. */
export function imageMetaLabel(preview: Pick<ImagePreview, 'format' | 'width' | 'height' | 'bytes'>, t: TFunction = enT): string {
  const parts = [FORMAT_NAME[preview.format]]
  if (preview.width && preview.height) parts.push(t('files.image.dimensions', { width: preview.width, height: preview.height }))
  parts.push(formatImageBytes(preview.bytes, t))
  return parts.join(' · ')
}
