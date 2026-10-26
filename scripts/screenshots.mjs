// Screenshots of the real app for the design-system work.
//   npm run screens -- [--out <dir>] [--only <screen,…>] [--large-text] [--walk [--walk-only <name,…>]] [--build | --no-build]
// Builds when the build is older than src/ (or with --build), then starts the built app with FOREMAN_SCREENSHOTS=1 on a
// throwaway data folder (src/main/screenshots.ts). It writes <screen>-<theme>[-<vision>][-z200].png and index.json into
// --out (default: <temp>/foreman-screens/<timestamp>), quits, and the data folder is removed. Each PNG gets a
// <name>.ax.json beside it (the reduced accessibility tree), and the summary lists accessibility warnings per screen:
// focusable elements without a name, heading levels that skip, a main-landmark count other than one. Warnings only.
// --large-text adds the large-text fixtures (accessibility plan, D3), off by default so the usual run takes no longer:
// zoom200-<screen>-<theme>.png (the window at 200% zoom) and content24-<screen>-<theme>.png (Content text size 24, set
// through the setting) for home, workspace-chat, file-diff and settings-accessibility, in light and dark. `--only` also
// takes them without the flag: `--only zoom200`, `--only content24`, or one such as `--only zoom200-home`.
// --walk then plays the keyboard walks (src/main/walks.ts, accessibility plan TESTING.md layer 4): real key presses on the
// fixture, with the focused element and the live-region text recorded after each. A transcript walk-<name>.json goes into
// --out, and each is compared with tests/fixtures/walks/<name>.json; a difference prints and the run exits 1. `--only walk`
// takes no screenshots, so only the walks run; `--walk-only approval-keys,chat-turns` plays some of them.
//   npm run screens -- --compare <dirA> <dirB> [--diff <dir>]
// Compares two runs pixel by pixel instead (scripts/screens-compare.mjs, inside Electron for its PNG decoder): differing
// pixels per file, and a diff image for each file that differs in --diff (default <dirB>/diff). Where both runs have a
// .ax.json, it also lists the accessibility nodes (role and name) added and removed.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const electron = createRequire(import.meta.url)('electron')

if (args.includes('--compare')) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const rest = args.filter((a) => a !== '--compare')
  const run = spawnSync(electron, [path.join(root, 'scripts', 'screens-compare.mjs'), ...rest], { cwd: root, env, stdio: 'inherit' })
  process.exit(run.status ?? 1)
}
const option = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const out = path.resolve(option('--out') ?? path.join(os.tmpdir(), 'foreman-screens', stamp))

function newest(dir) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs)
  }
  return latest
}

function needsBuild() {
  if (args.includes('--build')) return true
  if (args.includes('--no-build')) return false
  const built = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map((p) => path.join(root, p))
  if (!built.every(existsSync)) return true
  return newest(path.join(root, 'src')) > Math.min(...built.map((p) => statSync(p).mtimeMs))
}

if (needsBuild()) {
  console.log('Building (electron-vite build)…')
  const build = spawnSync('npx electron-vite build', { cwd: root, stdio: 'inherit', shell: true })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

mkdirSync(out, { recursive: true })
// A fixed folder, so paths in the shots (the terminal's prompt) are the same every run; a fresh one if another run holds it.
function dataFolder() {
  const fixed = path.join(os.tmpdir(), 'foreman-screens-data')
  try {
    rmSync(fixed, { recursive: true, force: true })
    mkdirSync(fixed)
    return fixed
  } catch {
    console.log(`${fixed} is in use; the terminal shot will show another path.`)
    return mkdtempSync(path.join(os.tmpdir(), 'foreman-screens-data-'))
  }
}
const data = dataFolder()
const env = {
  ...process.env,
  FOREMAN_SCREENSHOTS: '1',
  FOREMAN_SCREENSHOTS_DIR: data,
  FOREMAN_SCREENSHOTS_OUT: out,
  FOREMAN_SCREENSHOTS_ONLY: option('--only') ?? '',
  FOREMAN_SCREENSHOTS_LARGE_TEXT: args.includes('--large-text') ? '1' : '',
  FOREMAN_SCREENSHOTS_WALK: args.includes('--walk') ? '1' : '',
  FOREMAN_SCREENSHOTS_WALK_ONLY: option('--walk-only') ?? '',
  FOREMAN_SCREENSHOTS_WALK_EXPECTED: path.join(root, 'tests', 'fixtures', 'walks')
}
// Never the dev server, never Node mode, never another data folder.
for (const name of ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'FOREMAN_DATA_DIR', 'SWITCHYARD_DATA_DIR']) delete env[name]

console.log(`Capturing into ${out}`)
const app = spawn(electron, [root], { cwd: root, env, stdio: 'inherit' })
const timer = setTimeout(() => {
  console.error('Timed out after 15 minutes.')
  app.kill()
}, 15 * 60_000)

app.on('exit', (code) => {
  clearTimeout(timer)
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch (err) {
    console.error(`Could not remove ${data}: ${err instanceof Error ? err.message : err}`)
  }
  const indexFile = path.join(out, 'index.json')
  if (!existsSync(indexFile)) {
    console.error(`No index.json: the app exited with ${code} before finishing.`)
    process.exit(1)
  }
  const index = JSON.parse(readFileSync(indexFile, 'utf8'))
  console.log(`${index.shots.length} screenshots in ${out}`)
  const warned = Object.entries(index.axWarnings ?? {})
  if (warned.length) {
    console.log(`Accessibility warnings (${warned.length} of ${index.shots.length} screenshots):`)
    for (const [file, warnings] of warned) for (const w of warnings) console.log(`  ${file}: ${w}`)
  }
  for (const w of index.walks ?? []) {
    console.log(`  walk ${w.name}: ${w.ok ? 'ok' : 'FAILED'}`)
    for (const line of w.diffs) console.log(`    ${line}`)
  }
  for (const s of index.skipped) console.log(`  skipped ${s.screen} (${s.theme}${s.vision ? `, ${s.vision}` : ''}${s.variant ? `, ${s.variant}` : s.zoom === 2 ? ', 200%' : ''}): ${s.reason}`)
  process.exit(code ?? 0)
})
