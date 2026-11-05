// The pull-request half of "the design system comes first" (AGENTS.md): a new component goes into src/renderer/src/ui/
// first, as its own change, and only then into a feature. tests/designSystem.test.ts stops hand-built controls in feature
// code; this stops a new component from arriving unannounced or together with the feature that wants it.
//
// A pull request that adds an export to ui/index.ts must:
//   - carry the `new-component` label, so adding to the design system is a decision someone made on purpose;
//   - ship the component's test (tests/ui/<File>.test.tsx) and, for a component, a sample in a ui/gallery/ page
//     (its doc section is rule 8 of the guard);
//   - leave feature code (src/renderer/src outside ui/) alone: use the component in a later pull request.
//
//   node scripts/check-new-components.mjs [<base ref>]    (default origin/main)
// PR_LABELS (a JSON array of label names) supplies the pull request's labels; without it the label is not checked.
//
//   node scripts/check-new-components.mjs --staged [<base ref>]
// The pre-commit hook's run: the ordering rule alone (the last point above), on the branch since <base ref> plus what is
// staged, so a component and the feature that uses it can't share a branch even when they're in separate commits.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const LABEL = 'new-component'
const UI = 'src/renderer/src/ui/'

/** Every value export of ui/index.ts (types left out), as name -> the module it comes from. */
export function exportsOf(indexSource) {
  const out = new Map()
  for (const m of indexSource.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()
      if (name && !/^type\s/.test(raw.trim())) out.set(name, m[2])
    }
  }
  return out
}

/**
 * What is wrong with a change, as messages (empty: nothing). `changed`: every path the change touches. `labels`: the
 * pull request's labels, or null when they aren't known (run locally). `has` and `gallery` look at the head. A base with no
 * ui/index.ts is the change that brings the design system in, the one change allowed to add components and use them.
 */
export function newComponentProblems({ baseIndex, headIndex, changed, labels, has, gallery }) {
  const added = addedExports(baseIndex, headIndex)
  if (!added.length) return []

  const problems = []
  const names = added.map(([name]) => name).join(', ')
  if (labels && !labels.includes(LABEL)) {
    problems.push(`ui/index.ts gains ${names}: a new design-system export needs the "${LABEL}" label on the pull request. Reuse a component from ui/ (or add a variant to one) unless nothing existing can do the job.`)
  }
  for (const module of new Set(added.map(([, module]) => module))) {
    const test = `tests/ui/${module}.test.tsx`
    if (!has(test)) problems.push(`${module}: no ${test}. A ui/ component ships with its keyboard and ARIA tests.`)
  }
  for (const [name] of added) {
    if (/^[A-Z]/.test(name) && !new RegExp(`<${name}\\b`).test(gallery)) problems.push(`${name}: not in any ui/gallery/ page. Add a sample so it shows in the gallery screenshots.`)
  }
  return [...problems, ...orderProblems({ baseIndex, headIndex, changed })]
}

/** The value exports `headIndex` has and `baseIndex` doesn't, as [name, module]. None when the base has no ui/index.ts. */
export function addedExports(baseIndex, headIndex) {
  if (!baseIndex) return []
  const before = exportsOf(baseIndex)
  return [...exportsOf(headIndex)].filter(([name]) => !before.has(name))
}

/**
 * The ordering rule alone: a component is in the design system once it is on the base, so a change that adds one leaves
 * feature code alone. The pre-commit hook checks this on every commit; the label, test and gallery wait for the pull request,
 * so a component can be committed while it's being built.
 */
export function orderProblems({ baseIndex, headIndex, changed }) {
  const added = addedExports(baseIndex, headIndex)
  const feature = changed.filter((p) => p.startsWith('src/renderer/src/') && !p.startsWith(UI))
  if (!added.length || !feature.length) return []
  const names = added.map(([name]) => name).join(', ')
  const list = feature.slice(0, 10).join(', ') + (feature.length > 10 ? `, and ${feature.length - 10} more` : '')
  return [`ui/index.ts gains ${names}, and feature code changes too (${list}). A component is used only once it is in the design system: add it in its own pull request first, then use it in a later one. An agent stops here and asks the developer to add the component first.`]
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const args = process.argv.slice(2)
  if (args[0] === '--staged') return staged(git, args[1])
  const base = git('merge-base', args[0] ?? 'origin/main', 'HEAD').trim()
  let baseIndex = ''
  try {
    baseIndex = git('show', `${base}:${UI}index.ts`)
  } catch {
    // No ui/ at the base: everything in it is new.
  }
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
  const labels = process.env.PR_LABELS ? JSON.parse(process.env.PR_LABELS) : null
  const galleryDir = `${UI}gallery`
  const gallery = readdirSync(galleryDir).map((f) => readFileSync(`${galleryDir}/${f}`, 'utf8')).join('\n')
  const problems = newComponentProblems({ baseIndex, headIndex: readFileSync(`${UI}index.ts`, 'utf8'), changed, labels, has: existsSync, gallery })

  if (!problems.length) {
    console.log(baseIndex ? 'check-new-components: no new design-system export, or every new one is complete.' : 'check-new-components: the base has no ui/: this change brings the design system in.')
    if (!labels) console.log(`(The "${LABEL}" label is only checked on a pull request.)`)
    return
  }
  console.error('check-new-components: a new component must go into the design system first (AGENTS.md, "UI: the design system comes first").\n')
  for (const p of problems) console.error(`  - ${p}`)
  process.exitCode = 1
}

/** The pre-commit run: the staged ui/index.ts against the base, and every path changed since the base, staged ones included. */
function staged(git, ref) {
  const tryGit = (...args) => {
    try {
      return git(...args)
    } catch {
      return ''
    }
  }
  const candidates = ref ? [ref] : ['origin/main', 'main']
  const found = candidates.find((r) => tryGit('rev-parse', '--verify', '--quiet', `${r}^{commit}`))
  if (!found) {
    console.log(`check-new-components: no ${candidates.join(' or ')} to compare with; the ordering rule is not checked.`)
    return
  }
  const base = git('merge-base', found, 'HEAD').trim()
  const problems = orderProblems({
    baseIndex: tryGit('show', `${base}:${UI}index.ts`),
    headIndex: tryGit('show', `:${UI}index.ts`),
    changed: git('diff', '--cached', '--name-only', base).split('\n').filter(Boolean)
  })
  if (!problems.length) return
  console.error(`check-new-components: a new component must be in the design system (on ${found}) before feature code uses it (AGENTS.md, "UI: the design system comes first").\n`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
