// `npm run dev`: electron-vite's development app, with any other arguments passed on to it.
//   npm run dev demo [reset]
// `demo` starts it on the demo data instead (FOREMAN_DEMO=1, src/main/demo.ts): the screenshot fixture in a folder kept
// between launches, with nothing reaching the network. `reset` throws that folder away and seeds it again.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

// A new worktree has no node_modules (Foreman makes each workspace without its ignored files): install them first.
if (!existsSync('node_modules/.bin/electron-vite')) {
  console.log('foreman: no node_modules here, running npm ci first')
  const install = spawnSync('npm', ['ci'], { stdio: 'inherit', shell: true })
  if (install.status !== 0) process.exit(install.status ?? 1)
}
// Electron 45 has no install script: requiring it downloads its binary when it's missing. electron-vite only reads
// node_modules/electron/path.txt and fails with "Electron uninstall", so fetch the binary here before it starts.
createRequire(import.meta.url)('electron')

const args = process.argv.slice(2)
const env = { ...process.env }
if (args[0] === 'demo') {
  args.shift()
  env.FOREMAN_DEMO = '1'
  if (args[0] === 'reset') {
    args.shift()
    env.FOREMAN_DEMO_RESET = '1'
  }
}
// npm puts node_modules/.bin on PATH; the shell finds electron-vite.cmd on Windows.
const child = spawn('electron-vite', ['dev', ...args], { env, stdio: 'inherit', shell: true })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
