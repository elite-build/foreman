import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // .test.tsx files render design-system components; they opt into jsdom with `// @vitest-environment jsdom`.
  // A change to a forceRerunTriggers file runs every test under --changed, `vitest related` and npm run test:changed.
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/package-lock.json', '**/tsconfig*.json']
  }
})
