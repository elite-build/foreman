// Regenerates docs/cli.md (`npm run docs:cli`).
//
// The page is rendered by src/cli/docs.ts from the command table and the help renderers. That is TypeScript, and
// the project has no TypeScript runner for plain Node scripts, so this script runs the one vitest test that knows
// how to write the file: tests/cliDocs.test.ts, "writes docs/cli.md", enabled by FOREMAN_WRITE_DOCS=1. Without the
// variable that test is skipped and "is up to date" fails when the committed file is stale.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx vitest run tests/cliDocs.test.ts -t "writes"', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FOREMAN_WRITE_DOCS: '1' }
})
if (result.status === 0) console.log('docs/cli.md written')
process.exit(result.status ?? 1)
