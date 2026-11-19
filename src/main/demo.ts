// Dev-only demo: `npm run dev demo` (scripts/dev.mjs sets FOREMAN_DEMO=1; an installed build ignores it). The app runs on
// a data folder of its own, seeded once with the screenshot fixture (screenshots.ts: two repositories, three workspaces,
// their chats, a flow run and its checks, and an organization with AI employees and their work, screensOrganization.ts),
// made fuller for the demo (demoOrganization.ts: Acme with four code repositories and a team of eight, and Lumen, a
// small open-source organization, demoLumen.ts) and kept between launches, so what you click stays. Nothing reaches the
// network: agents answer from a script, which also drives the flow runs each launch starts (main/demoRun.ts) and the
// employees' runs in the channels the demo's director keeps moving (main/demoEmployees.ts); GitHub, integrations,
// cloud sandboxes and paired devices stay off (main/index.ts).
// `npm run dev demo reset` (FOREMAN_DEMO_RESET=1) throws the folder away and seeds it again.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEMO = process.env.FOREMAN_DEMO === '1'
export const DEMO_RESET = process.env.FOREMAN_DEMO_RESET === '1'

// Says the folder is the demo's, so a reset never deletes anything else: "seeding" until the fixture is in, then
// "ready <version>".
const MARKER = '.foreman-demo'

// The demo data's version. A demo kept from an earlier one opens as it was, with a line in the log saying a reset shows
// the current one: never wiped unasked, as people add their own repositories and workspaces to it.
// 2: two organizations, eight repositories, channels and flows that move, and work held at a usage limit.
export const DEMO_VERSION = 2
const READY = `ready ${DEMO_VERSION}`

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
 * Before the app is ready (Electron then holds files in the data folder): keep a seeded demo ('outdated' when an earlier
 * version of the demo data seeded it), or empty the folder and claim it for seeding: on a reset, after a seeding that
 * never finished, or the first time. A folder that has files but isn't a demo's is refused, never deleted.
 *
 * The marker is written first and everything else is deleted around it, so a delete that stops part way (a file another
 * program holds) leaves the folder still the demo's, "seeding": the next launch empties it again rather than refusing it.
 */
export function claimDemoFolder(root: string, reset: boolean): 'kept' | 'outdated' | 'seed' {
  const state = marker(root)
  if (state === null && existsSync(root) && readdirSync(root).length) {
    throw new Error(`${root} is not a Foreman demo folder. Empty it, or set FOREMAN_DEMO_DIR to another folder.`)
  }
  if (state?.startsWith('ready') && !reset) return state === READY ? 'kept' : 'outdated'
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, MARKER), 'seeding\n')
  for (const name of readdirSync(root)) {
    if (name === MARKER) continue
    try {
      rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (err) {
      throw new Error(`Could not empty ${root} (${err instanceof Error ? err.message : String(err)}). Close whatever has a file open in it, then start the demo again.`)
    }
  }
  return 'seed'
}

/** Once the app is ready: seed a claimed folder, then mark it ready so the next launch keeps it. */
export async function seedDemo(root: string, seed: (root: string, dataDir: string) => Promise<unknown>): Promise<void> {
  await seed(root, demoDataDir(root))
  writeFileSync(path.join(root, MARKER), `${READY}\n`)
}
