// Dev-only demo: `npm run dev demo` (scripts/dev.mjs sets FOREMAN_DEMO=1; an installed build ignores it). The app runs on
// a data folder of its own, seeded once with the screenshot fixture (screenshots.ts: two repositories, three workspaces,
// their chats, a flow run and its checks) and kept between launches, so what you click stays. Nothing reaches the
// network: agents answer from a script, which also drives the flow run each launch starts (main/demoRun.ts); GitHub,
// integrations, cloud sandboxes and paired devices stay off (main/index.ts).
// `npm run dev demo reset` (FOREMAN_DEMO_RESET=1) throws the folder away and seeds it again.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEMO = process.env.FOREMAN_DEMO === '1'
export const DEMO_RESET = process.env.FOREMAN_DEMO_RESET === '1'

// Says the folder is the demo's, so a reset never deletes anything else: "seeding" until the fixture is in, then "ready".
const MARKER = '.foreman-demo'

/** FOREMAN_DEMO_DIR, or "Foreman Demo" next to the app's own data folder. */
export function demoFolder(appData: string): string {
  return path.resolve(process.env.FOREMAN_DEMO_DIR || path.join(appData, 'Foreman Demo'))
}

/** The app's data folder inside the demo's; the fixture's repositories and worktrees sit beside it. */
export function demoDataDir(root: string): string {
  return path.join(root, 'data')
}

function marker(root: string): string | null {
  const file = path.join(root, MARKER)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
}

/**
 * Before the app is ready (Electron then holds files in the data folder): keep a seeded demo, or empty the folder and
 * claim it for seeding: on a reset, after a seeding that never finished, or the first time. A folder that has files but
 * isn't a demo's is refused, never deleted.
 */
export function claimDemoFolder(root: string, reset: boolean): 'kept' | 'seed' {
  const state = marker(root)
  if (state === null && existsSync(root) && readdirSync(root).length) {
    throw new Error(`${root} is not a Foreman demo folder. Empty it, or set FOREMAN_DEMO_DIR to another folder.`)
  }
  if (state === 'ready' && !reset) return 'kept'
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, MARKER), 'seeding\n')
  return 'seed'
}

/** Once the app is ready: seed a claimed folder, then mark it ready so the next launch keeps it. */
export async function seedDemo(root: string, seed: (root: string, dataDir: string) => Promise<unknown>): Promise<void> {
  await seed(root, demoDataDir(root))
  writeFileSync(path.join(root, MARKER), 'ready\n')
}
