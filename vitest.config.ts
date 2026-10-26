import { defineConfig } from 'vitest/config'

export default defineConfig({
  // .test.tsx files render design-system components; they opt into jsdom with `// @vitest-environment jsdom`.
  test: { include: ['tests/**/*.test.{ts,tsx}'], setupFiles: ['tests/setup.ts'], testTimeout: 30000 }
})
