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
//   node scripts/check-new-components.mjs [<base ref>]    (default origin/main; CI passes the PR's base SHA)
// PR_LABELS (a JSON array of label names) is set by the workflow; without it the label is not checked.

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
  if (!baseIndex) return []
  const before = exportsOf(baseIndex)
  const added = [...exportsOf(headIndex)].filter(([name]) => !before.has(name))
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
  const feature = changed.filter((p) => p.startsWith('src/renderer/src/') && !p.startsWith(UI))
  if (feature.length) {
    const list = feature.slice(0, 10).join(', ') + (feature.length > 10 ? `, and ${feature.length - 10} more` : '')
    problems.push(`ui/index.ts gains ${names}, and feature code changes too (${list}). Add the component in its own pull request first, then use it.`)
  }
  return problems
}

function main() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const base = git('merge-base', process.argv[2] ?? 'origin/main', 'HEAD').trim()
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
