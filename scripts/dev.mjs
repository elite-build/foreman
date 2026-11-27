// `npm run dev`: electron-vite's development app, with any other arguments passed on to it.
//   npm run dev demo [<scenario>] [reset] [--with <part,…>] [--without <part,…>]
//   npm run dev demo list
// `demo` starts it on the demo data instead (FOREMAN_DEMO=1, src/main/demo.ts): the screenshot fixture in a folder kept
// between launches, with nothing reaching the network. `reset` throws that folder away and seeds it again.
// A scenario (src/shared/scenarios.ts: `channels`, `hire-employee`, …; `full` when none is named) says what the demo starts
// with and which screen it opens on, in a folder of its own; `--with` and `--without` add and leave out parts of it
// (`npm run dev demo -- --without lumen,flows`: npm needs the `--` before a flag). `list` prints the scenarios and parts.
// `npm run pr:screens -- capture --scenario <name>` takes a pull request's screenshots of the same data.
// Without `demo` it runs on this worktree's own data folder (scripts/devData.mjs), not the installed app's, and says
// where: FOREMAN_DATA_DIR chooses another, and `npm run dev -- --real-data` uses the installed app's.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { devDataDir } from './devData.mjs'
import { scenarioNames, scenariosText } from './scenarios.mjs'

// A new worktree has no node_modules (Foreman makes each workspace without its ignored files): install them first.
if (!existsSync('node_modules/.bin/electron-vite')) {
  console.log('foreman: no node_modules here, running npm ci first')
  const install = spawnSync('npm', ['ci'], { stdio: 'inherit', shell: true })
  if (install.status !== 0) process.exit(install.status ?? 1)
}
// Electron 45 has no install script: requiring it downloads its binary when it's missing. electron-vite only reads
// node_modules/electron/path.txt and fails with "Electron uninstall", so fetch the binary here before it starts.
createRequire(import.meta.url)('electron')

let args = process.argv.slice(2)
const env = { ...process.env }
if (args[0] === 'demo') {
  args.shift()
  env.FOREMAN_DEMO = '1'
  if (args[0] === 'list') {
    console.log(scenariosText())
    process.exit(0)
  }
  // The scenario and `reset`, in either order, then the parts to add and leave out; the rest is electron-vite's.
  const names = scenarioNames()
  while (args.length) {
    if (args[0] === 'reset') env.FOREMAN_DEMO_RESET = '1'
    else if (names.includes(args[0])) env.FOREMAN_SCENARIO = args[0]
    else if ((args[0] === '--with' || args[0] === '--without') && args[1]) env[args[0] === '--with' ? 'FOREMAN_SCENARIO_WITH' : 'FOREMAN_SCENARIO_WITHOUT'] = args.splice(1, 1)[0]
    else if (!args[0].startsWith('-')) {
      console.error(`foreman: no demo scenario called "${args[0]}". \`npm run dev demo list\` prints them.`)
      process.exit(1)
    } else break
    args.shift()
  }
} else {
  const data = devDataDir({ args })
  args = data.args
  if (data.dir) env.FOREMAN_DATA_DIR = data.dir
  if (data.source === 'worktree') console.log(`foreman: this worktree's development data is in ${data.dir} (FOREMAN_DATA_DIR chooses another; \`npm run dev -- --real-data\` uses the installed app's)`)
  else if (data.source === 'env') console.log(`foreman: development data in ${data.shown} (FOREMAN_DATA_DIR)`)
  else console.log("foreman: --real-data: using the installed app's data folder")
}
// npm puts node_modules/.bin on PATH; the shell finds electron-vite.cmd on Windows.
const child = spawn('electron-vite', ['dev', ...args], { env, stdio: 'inherit', shell: true })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
