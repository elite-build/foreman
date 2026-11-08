// `npm run dev`: electron-vite's development app, with any other arguments passed on to it.
//   npm run dev demo [reset]
// `demo` starts it on the demo data instead (FOREMAN_DEMO=1, src/main/demo.ts): the screenshot fixture in a folder kept
// between launches, with nothing reaching the network. `reset` throws that folder away and seeds it again.
import { spawn } from 'node:child_process'

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
