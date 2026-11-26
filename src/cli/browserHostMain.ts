// The native-messaging host for Foreman for Chrome (out/main/browserHost.js). Chrome starts it when the extension
// connects, with the caller's origin (and on Windows a window handle) as arguments. It joins the app's CLI socket
// and forwards framed messages both ways, one JSON line per message on the socket. Its stdout is Chrome's channel:
// nothing but framed messages may be written there. Diagnostics go to stderr.
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { BROWSER_EXTENSION_ID, BROWSER_HOST_METHOD } from '../shared/browserLink'
import { MAX_TO_EXTENSION, NativeReader, encodeNative } from './nativeMessaging'

function fail(message: string): void {
  process.stderr.write(`${message}\n`, () => process.exit(1))
}

function main(): void {
  if (process.argv[2] !== `chrome-extension://${BROWSER_EXTENSION_ID}/`) return fail('Foreman browser host: not started by the Foreman extension.')
  const socketPath = process.env.FOREMAN_BROWSER_SOCKET
  const tokenFile = process.env.FOREMAN_BROWSER_TOKEN_FILE
  if (!socketPath || !tokenFile) return fail('Foreman browser host: FOREMAN_BROWSER_SOCKET and FOREMAN_BROWSER_TOKEN_FILE are required.')

  let token: string
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return fail('Foreman browser host: the CLI token file cannot be read.')
  }
  if (!token) return fail('Foreman browser host: the CLI token file is empty.')

  const socket = createConnection(socketPath)
  let finished = false
  // Leave once: the socket and stdin are closed and the process exits when stdout has drained.
  const finish = (code: number) => {
    if (finished) return
    finished = true
    socket.destroy()
    process.stdin.destroy()
    process.exitCode = code
  }

  // Written at once, not on 'connect': the socket queues anything written before connecting, in order, so a message
  // from the extension can never reach the app ahead of this opening line.
  socket.write(`${JSON.stringify({ method: BROWSER_HOST_METHOD, params: { token } })}\n`)

  let fromApp = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    fromApp += chunk
    let end: number
    while ((end = fromApp.indexOf('\n')) >= 0) {
      const line = fromApp.slice(0, end)
      fromApp = fromApp.slice(end + 1)
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        process.stderr.write('Foreman browser host: dropped a message from the app that is not JSON.\n')
        continue
      }
      const frame = encodeNative(message)
      if (frame.length - 4 > MAX_TO_EXTENSION) {
        process.stderr.write(`Foreman browser host: dropped a ${frame.length - 4} byte message, over Chrome's ${MAX_TO_EXTENSION} byte limit.\n`)
        continue
      }
      process.stdout.write(frame)
    }
  })
  // The app is gone or refused us: leave, and Chrome disconnects the port.
  socket.on('error', () => finish(0))
  socket.on('close', () => finish(0))

  const reader = new NativeReader()
  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[]
    try {
      messages = reader.push(chunk)
    } catch (err) {
      process.stderr.write(`Foreman browser host: ${err instanceof Error ? err.message : String(err)}\n`)
      finish(1)
      return
    }
    for (const message of messages) socket.write(`${JSON.stringify(message)}\n`)
  })
  // Chrome closed the port: flush what is queued for the app, then leave.
  process.stdin.on('end', () => socket.end(() => finish(0)))
}

main()
