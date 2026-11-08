// The tests a change can affect, for the loop while working: the whole suite takes minutes (most of it real Git
// processes, which are slow to start on Windows). `npm test` stays the check before a pull request.
//
//   npm run test:changed [-- <base ref>] [-- <vitest options>]    (default base origin/main, else main)
//
// The change is what Vitest's own --changed sees: the branch since <base ref>, plus staged, unstaged and untracked files.
// Vitest runs every test that imports a changed file, and everything when a file in vitest.config.ts's forceRerunTriggers
// or a setup file changes. Some tests read files rather than import them, out of the import graph's sight, so this adds:
//   - the design-system, contrast, i18n and ui/ checks (`npm run check:ui`) when the renderer or the i18n catalogues
//     change, as the pre-commit hook does;
//   - for a changed file that isn't a module (a doc, CSS, JSON, a fixture), every test that names it.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const MODULE = /\.(c|m)?[jt]sx?$/
const TEST = /\.test\.tsx?$/
const CHECK_UI = /^(src\/renderer\/|src\/shared\/i18n\/)/

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean)

function defaultBase() {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '-q', ref], { stdio: 'ignore' })
      return ref
    } catch {}
  }
  throw new Error('No origin/main or main to compare with: name a base, npm run test:changed -- <ref>.')
}

/** Every test file under `dir`, repository-relative with forward slashes. */
function testsIn(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((file) => path.posix.join(dir, file.split(path.sep).join('/')))
    .filter((file) => TEST.test(file))
}

/** The test files `npm run check:ui` runs, read from package.json so the two lists can't drift. */
function checkUiTests() {
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['check:ui']
  return script.split(/\s+/).filter((arg) => arg.startsWith('tests/')).flatMap((arg) => (statSync(arg).isDirectory() ? testsIn(arg) : [arg]))
}

const args = process.argv.slice(2)
const base = args[0] && !args[0].startsWith('-') ? args.shift() : defaultBase()
const changed = [
  ...new Set([
    ...git('diff', '--name-only', '-z', `${base}...HEAD`),
    ...git('diff', '--cached', '--name-only', '-z'),
    ...git('ls-files', '-z', '--other', '--modified', '--exclude-standard')
  ])
]

const extra = new Set()
if (changed.some((file) => CHECK_UI.test(file))) for (const test of checkUiTests()) extra.add(test)
const unseen = changed.filter((file) => !MODULE.test(file))
if (unseen.length) {
  for (const test of testsIn('tests')) {
    const source = readFileSync(test, 'utf8')
    if (unseen.some((file) => source.includes(path.posix.basename(file)))) extra.add(test)
  }
}

const related = [...changed.filter((file) => existsSync(file)), ...extra]
if (!related.length) {
  console.log(`test:changed: nothing has changed since ${base}.`)
  process.exit(0)
}
console.log(`test:changed: ${changed.length} file(s) changed since ${base}${extra.size ? `, plus ${extra.size} test(s) that read files rather than import them` : ''}.`)
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'related', '--run', '--passWithNoTests', ...related, ...args], { stdio: 'inherit' })
process.exit(run.status ?? 1)
