// Cloud workspaces: the app's way into the agent host inside a sandbox (sandboxHost.ts). The app
// runs this as a sandbox command and uses its stdin and stdout as the HostClient transport: bytes
// go both ways unchanged, as soon as they arrive. Exit code 2 means no host is listening (the app
// then starts one). Node builtins only, so it runs as a single uploaded file.
//   node sandboxAttach.js [--socket /tmp/foreman-host.sock]
import net from 'node:net'

const NO_HOST = 2

function socketPath(argv: string[]): string {
  const at = argv.indexOf('--socket')
  if (at >= 0 && argv[at + 1]) return argv[at + 1]
  return argv.find((a) => a.startsWith('--socket='))?.slice('--socket='.length) || process.env.FOREMAN_HOST_SOCKET || '/tmp/foreman-host.sock'
}

let connected = false
const socket = net.connect(socketPath(process.argv.slice(2)))

// Everything written so far reaches the app before the exit.
const finish = (code: number) => process.stdout.end(() => process.exit(code))

socket.once('connect', () => {
  connected = true
  // stdin's end half-closes the socket, which the host reads as the app letting go.
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.on('error', (err: NodeJS.ErrnoException) => {
  // A missing socket, or a stale one from a host that died: nobody is listening.
  if (!connected) process.exit(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NO_HOST : 1)
})
socket.on('close', () => finish(0))
process.stdin.on('error', () => socket.end())
// The app stopped reading.
process.stdout.on('error', () => process.exit(0))
