// The tests a change can affect, for the loop while working: the whole suite takes minutes (most of it real Git
// processes, which are slow to start on Windows), and CI runs it on every ready PR.
//
//   npm run test:changed [-- <base ref>] [-- --own] [-- <vitest options>]    (default base origin/main, else main)
//
// --own is the check before a pull request: only the test files the branch adds or changes, plus `npm run check:ui`
// when the renderer or the i18n catalogues change. CI runs everything else.
//
// The change is what Vitest's own --changed sees: the branch since <base ref>, plus staged, unstaged and untracked files.
// Vitest runs every test that imports a changed file, and everything when a file in vitest.config.ts's forceRerunTriggers
// or a setup file changes. Some tests read files rather than import them, out of the import graph's sight, so this adds:
//   - the design-system, contrast, i18n and ui/ checks (`npm run check:ui`) when the renderer or the i18n catalogues
//     change, as the pre-commit hook does;
//   - for a changed file in a folder that isn't a module (a doc, CSS, JSON, a fixture), every test that names it.
//     Top-level files (README.md, AGENTS.md, CHANGELOG.md) are left out: no test reads one, and their names are common
//     fixture names (makeRepo writes a README.md), so naming them ran 37 slow tests for a README edit. package.json,
//     the lockfile and tsconfig are forceRerunTriggers, so a change to one still runs everything.
// The language catalogues (src/shared/i18n/en.ts and the rest) are left out of the import graph: 417 test files import
// them, so a feature PR that adds a string ran nearly the whole suite. The check:ui tests above check the catalogues,
// and a test that expects the old wording fails in CI.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const MODULE = /\.(c|m)?[jt]sx?$/
const TEST = /\.test\.tsx?$/
const CHECK_UI = /^(src\/renderer\/|src\/shared\/i18n\/)/
const CATALOGUE = /^src\/shared\/i18n\/[a-z]{2}(-[A-Z]{2})?\.ts$/

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
const own = args.includes('--own')
if (own) args.splice(args.indexOf('--own'), 1)
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

if (own) {
  const tests = [...new Set([...changed.filter((file) => TEST.test(file) && existsSync(file)), ...extra])]
  if (!tests.length) {
    console.log(`test:changed --own: no test file changed since ${base}, and nothing for check:ui; CI runs the whole suite.`)
    process.exit(0)
  }
  console.log(`test:changed --own: ${tests.length} test file(s) the branch changed or check:ui needs; CI runs the whole suite.`)
  const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...tests, ...args], { stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

const unseen = changed.filter((file) => !MODULE.test(file) && file.includes('/'))
if (unseen.length) {
  for (const test of testsIn('tests')) {
    const source = readFileSync(test, 'utf8')
    if (unseen.some((file) => source.includes(path.posix.basename(file)))) extra.add(test)
  }
}

const related = [...changed.filter((file) => existsSync(file) && !CATALOGUE.test(file)), ...extra]
if (!related.length) {
  console.log(`test:changed: nothing has changed since ${base}.`)
  process.exit(0)
}
console.log(`test:changed: ${changed.length} file(s) changed since ${base}${extra.size ? `, plus ${extra.size} test(s) that read files rather than import them` : ''}.`)
const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'related', '--run', '--passWithNoTests', ...related, ...args], { stdio: 'inherit' })
process.exit(run.status ?? 1)
