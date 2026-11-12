// `npm run evals -- [case...] [--model <id>] [--runs <n>] [--update-baseline] [--list]`: runs evals/ under its own Vitest
// config (vitest.evals.config.ts), which npm test never reads. The arguments go to the eval entry in an environment variable,
// because Vitest would reject options it doesn't know; the report comes back through a file so Vitest's output can't bury it.
// Real models, real cost: see evals/README.md.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'foreman-evals-'))
const out = path.join(dir, 'report.json')

const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.evals.config.ts', '--reporter=dot', '--silent=false'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, FOREMAN_EVALS_ARGS: JSON.stringify(process.argv.slice(2)), FOREMAN_EVALS_OUT: out }
})

let outcome
try {
  outcome = JSON.parse(readFileSync(out, 'utf8'))
} catch {
  outcome = undefined
}
rmSync(dir, { recursive: true, force: true })

if (!outcome) {
  console.error('The evals did not produce a report (Vitest failed before or while running them).')
  process.exit(result.status || 1)
}
console.log(outcome.text)
process.exit(outcome.failed ? 1 : 0)
