// The demo's scenarios and parts as the scripts need them (scripts/dev.mjs, scripts/pr-screens.mjs): read from the list
// the app uses, src/shared/scenarios.json. The app resolves a scenario itself (src/shared/scenarios.ts); here are only
// the names, to tell an argument from a typo, and a line about each for `npm run dev demo list`.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const list = (root) => JSON.parse(readFileSync(path.join(root, 'src', 'shared', 'scenarios.json'), 'utf8'))

/**
 * Every scenario's name in the checkout at `root` (this one unless another is given: a pull request's merge base).
 * None for a checkout from before there were scenarios.
 */
export function scenarioNames(root = here) {
  try {
    return Object.keys(list(root).scenarios)
  } catch {
    return []
  }
}

/** `npm run dev demo list`. */
export function scenariosText(root = here) {
  const { scenarios, parts } = list(root)
  const line = ([name, about]) => `  ${name.padEnd(14)} ${about}`
  const scenario = ([name, s]) => `${line([name, s.about])}\n  ${''.padEnd(14)} Parts: ${s.parts.join(', ') || 'none, the fixture alone'}.`
  return `Scenarios (npm run dev demo <scenario>)\n${Object.entries(scenarios).map(scenario).join('\n')}\n\nParts (--with <part,…>, --without <part,…>)\n${Object.entries(parts).map(line).join('\n')}`
}
