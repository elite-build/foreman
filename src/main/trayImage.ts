// G2 (#3): the tray icon's pixels. Pure (raw BGRA buffers in, out), so it is tested without Electron:
//  - Windows draws the attention count into the icon itself: a red badge in the bottom-right corner
//    with the number in a 3×5 pixel font ("9+" past nine, so it stays legible at 16 px).
//  - macOS wants a template image for the menu bar: black plus alpha, which the system tints for
//    light and dark bars. It is cut from the app icon: the bright hat stays, the dark tile and the
//    prompt inside the hat drop out.
// Electron's nativeImage bitmaps are BGRA (premultiplied) on Windows and macOS.

const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

// The badge's red (#d93025) and the digits' white, as B, G, R.
const BADGE = [0x25, 0x30, 0xd9]
const INK = [0xff, 0xff, 0xff]

/** What the badge says: nothing for 0, the digit up to 9, then "9+". */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return count > 9 ? '9+' : String(Math.floor(count))
}

/** Where the badge goes on a square icon of `size` px: a pill in the bottom-right corner, sized to its text. */
export function badgeBox(size: number, text: string): { x: number; y: number; w: number; h: number; scale: number } {
  const scale = Math.max(1, Math.floor(size / 16))
  const pad = 2 * scale
  const textW = text.length * 3 * scale + (text.length - 1) * scale
  const h = 5 * scale + 2 * pad
  const w = Math.max(h, textW + 2 * pad)
  return { x: size - w, y: size - h, w, h, scale }
}

/** Blend one colour over a premultiplied BGRA pixel with coverage `a` (0–1). */
function blend(out: Buffer, i: number, bgr: number[], a: number): void {
  if (a <= 0) return
  for (let c = 0; c < 3; c++) out[i + c] = Math.round(bgr[c] * a + out[i + c] * (1 - a))
  out[i + 3] = Math.round(255 * a + out[i + 3] * (1 - a))
}

/** How much of pixel (px, py) a rounded rectangle covers, from 4×4 samples, so the pill's ends are smooth. */
function pillCoverage(px: number, py: number, box: { x: number; y: number; w: number; h: number }): number {
  const r = box.h / 2
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = px + (sx + 0.5) / 4
      const y = py + (sy + 0.5) / 4
      if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue
      const cx = Math.min(Math.max(x, box.x + r), box.x + box.w - r)
      const cy = box.y + r
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) hits++
    }
  }
  return hits / 16
}

/**
 * The icon with the count drawn in. `bitmap` is `size`×`size` BGRA and is not changed. A count of 0 gives
 * the icon back as it was.
 */
export function drawBadge(bitmap: Buffer, size: number, count: number): Buffer {
  const out = Buffer.from(bitmap)
  const text = badgeText(count)
  if (!text || bitmap.length < size * size * 4) return out
  const box = badgeBox(size, text)
  for (let y = Math.max(0, Math.floor(box.y)); y < size; y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < size; x++) blend(out, (y * size + x) * 4, BADGE, pillCoverage(x, y, box))
  }
  const textW = text.length * 3 * box.scale + (text.length - 1) * box.scale
  let left = box.x + Math.floor((box.w - textW) / 2)
  const top = box.y + Math.floor((box.h - 5 * box.scale) / 2)
  for (const ch of text) {
    const rows = FONT[ch]
    for (let ry = 0; ry < 5; ry++) {
      for (let rx = 0; rx < 3; rx++) {
        if (rows[ry][rx] !== '1') continue
        for (let dy = 0; dy < box.scale; dy++) {
          for (let dx = 0; dx < box.scale; dx++) {
            const x = left + rx * box.scale + dx
            const y = top + ry * box.scale + dy
            if (x >= 0 && y >= 0 && x < size && y < size) blend(out, (y * size + x) * 4, INK, 1)
          }
        }
      }
    }
    left += 4 * box.scale
  }
  return out
}

/**
 * A macOS template image cut from the app icon: every pixel black, its alpha the icon's alpha where the icon is
 * bright (the hat), fading out over a band so the edge stays smooth, and none where it is dark.
 */
export function templateBitmap(bitmap: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i + 3 < Math.min(bitmap.length, out.length); i += 4) {
    const a = bitmap[i + 3]
    if (!a) continue
    // Un-premultiply, then perceived brightness 0–1.
    const [b, g, r] = [bitmap[i], bitmap[i + 1], bitmap[i + 2]].map((v) => Math.min(255, (v * 255) / a) / 255)
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const keep = Math.min(1, Math.max(0, (lum - 0.3) / 0.25))
    out[i + 3] = Math.round(a * keep)
  }
  return out
}
