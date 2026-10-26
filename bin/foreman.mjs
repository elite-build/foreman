#!/usr/bin/env node
// The `foreman` command. `npm link` puts it on your PATH; it runs the CLI built into out/.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cli = new URL('../out/main/cli.js', import.meta.url)
if (!existsSync(fileURLToPath(cli))) {
  console.error('foreman: the CLI isn’t built yet. Run `npm run build` (or `npm run dev`) in the Foreman repository.')
  process.exit(1)
}
await import(cli.href)
