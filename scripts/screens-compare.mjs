// Electron entry for `npm run screens -- --compare <dirA> <dirB> [--diff <dir>]` (scripts/screenshots.mjs starts it).
// Decodes each PNG both folders have with nativeImage, counts the pixels that differ in any channel, and writes a diff
// image for each file that differs (A dimmed to grey, differing pixels in magenta) plus compare.json into --diff
// (default <dirB>/diff). Exits 1 when anything differs. No window, no dependencies.
// Where both folders have <name>.ax.json (the reduced accessibility tree from the capture) it also prints the nodes
// (role and name) added and removed per screen. That is informational: it does not change the exit code.
// The keyboard walk's transcripts (walk-<name>.json, `npm run screens -- --walk`) sit in the same folder and are ignored here: only PNGs and
// their .ax.json are compared. A walk is checked against tests/fixtures/walks by the run itself.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('screens-compare.mjs')) + 1)
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const [dirA, dirB] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--diff').map((d) => path.resolve(d))
const diffDir = path.resolve(option('--diff') ?? path.join(dirB ?? '.', 'diff'))

function compare(file) {
  const a = nativeImage.createFromPath(path.join(dirA, file))
  const b = nativeImage.createFromPath(path.join(dirB, file))
  if (a.isEmpty() || b.isEmpty()) return { file, error: `could not decode ${a.isEmpty() ? 'A' : 'B'}` }
  const sa = a.getSize()
  const sb = b.getSize()
  if (sa.width !== sb.width || sa.height !== sb.height) return { file, error: `size ${sa.width}×${sa.height} vs ${sb.width}×${sb.height}` }
  const pa = a.toBitmap()
  const pb = b.toBitmap()
  const out = Buffer.alloc(pa.length)
  let differ = 0
  let maxDelta = 0
  // Bounding box of the differing pixels.
  const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 }
  for (let i = 0; i < pa.length; i += 4) {
    const delta = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3]))
    if (delta) {
      differ++
      maxDelta = Math.max(maxDelta, delta)
      const x = (i / 4) % sa.width
      const y = Math.floor(i / 4 / sa.width)
      box.x0 = Math.min(box.x0, x)
      box.y0 = Math.min(box.y0, y)
      box.x1 = Math.max(box.x1, x)
      box.y1 = Math.max(box.y1, y)
      // Magenta in BGRA and RGBA alike.
      out[i] = 255
      out[i + 1] = 0
      out[i + 2] = 255
    } else {
      const grey = Math.round(((pa[i] + pa[i + 1] + pa[i + 2]) / 3) * 0.35 + 255 * 0.5)
      out[i] = out[i + 1] = out[i + 2] = grey
    }
    out[i + 3] = 255
  }
  if (differ) {
    mkdirSync(diffDir, { recursive: true })
    writeFileSync(path.join(diffDir, file), nativeImage.createFromBitmap(out, sa).toPNG())
  }
  return { file, differ, maxDelta, box: differ ? `${box.x0},${box.y0}–${box.x1},${box.y1}` : undefined, total: sa.width * sa.height }
}

// Same logic as diffAxTrees in src/main/axTree.ts (this file runs as plain JS and cannot import TypeScript).
function flatten(tree) {
  return tree.flatMap((node) => [node, ...flatten(node.children ?? [])])
}
function diffAx(file) {
  const ax = file.replace(/\.png$/, '.ax.json')
  const pa = path.join(dirA, ax)
  const pb = path.join(dirB, ax)
  if (!existsSync(pa) || !existsSync(pb)) return undefined
  try {
    const count = (p) => {
      const counts = new Map()
      for (const n of flatten(JSON.parse(readFileSync(p, 'utf8')))) {
        const k = n.name ? `${n.role} "${n.name}"` : n.role
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      return counts
    }
    const ca = count(pa)
    const cb = count(pb)
    const surplus = (from, other) => [...from].flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (other.get(k) ?? 0)) }, () => k)).sort()
    return { added: surplus(cb, ca), removed: surplus(ca, cb) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

app.whenReady().then(() => {
  if (!dirA || !dirB || !existsSync(dirA) || !existsSync(dirB)) {
    console.error('Usage: npm run screens -- --compare <dirA> <dirB> [--diff <dir>]')
    return app.exit(2)
  }
  // Only screenshots: walk-<name>.json (the keyboard walk) and index.json are not compared.
  const pngs = (dir) => new Set(readdirSync(dir).filter((f) => f.endsWith('.png')))
  const inA = pngs(dirA)
  const inB = pngs(dirB)
  const results = []
  for (const file of [...new Set([...inA, ...inB])].sort()) {
    if (!inA.has(file) || !inB.has(file)) results.push({ file, error: `only in ${inA.has(file) ? 'A' : 'B'}` })
    else results.push({ ...compare(file), ax: diffAx(file) })
  }
  const width = Math.max(...results.map((r) => r.file.length))
  for (const r of results) console.log(`${r.file.padEnd(width)}  ${r.error ?? (r.differ ? `${r.differ} px differ (max channel delta ${r.maxDelta}, in ${r.box})` : 'same')}`)
  const axChanged = results.filter((r) => r.ax && (r.ax.error || r.ax.added?.length || r.ax.removed?.length))
  if (axChanged.length) {
    console.log('\nAccessibility tree changes:')
    for (const r of axChanged) {
      console.log(`  ${r.file}${r.ax.error ? `: could not compare (${r.ax.error})` : `: +${r.ax.added.length} -${r.ax.removed.length}`}`)
      for (const k of r.ax.added ?? []) console.log(`    + ${k}`)
      for (const k of r.ax.removed ?? []) console.log(`    - ${k}`)
    }
  }
  const changed = results.filter((r) => r.error || r.differ)
  console.log(`\n${results.length - changed.length} of ${results.length} identical${changed.some((r) => r.differ) ? `; diff images in ${diffDir}` : ''}`)
  mkdirSync(diffDir, { recursive: true })
  writeFileSync(path.join(diffDir, 'compare.json'), JSON.stringify({ a: dirA, b: dirB, results }, null, 2))
  app.exit(changed.length ? 1 : 0)
})
