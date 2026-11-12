import { defineConfig } from 'vitest/config'

// `npm run record:agent` only (docs/agents.md, 9.2): runs the real drivers against real agents, which costs real usage,
// so it is a config of its own and `npm test` never includes it.
export default defineConfig({
  test: {
    include: ['scripts/record/*.record.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    // Printed as it happens: a recording is watched.
    disableConsoleIntercept: true,
    fileParallelism: false
  }
})
