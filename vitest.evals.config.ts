import { defineConfig } from 'vitest/config'

// `npm run evals` only (scripts/evals.mjs). The evals call real models and cost money, so they are not under tests/,
// vitest.config.ts doesn't include them, and nothing runs them in `npm test` or `npm run test:changed`.
export default defineConfig({
  test: {
    include: ['evals/**/*.eval.ts'],
    testTimeout: 2 * 60 * 60 * 1000,
    hookTimeout: 60_000,
    // One file, one test: nothing to run in parallel, and the model calls make their own.
    fileParallelism: false
  }
})
