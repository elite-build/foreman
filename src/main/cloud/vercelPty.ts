// A Vercel Sandbox PTY over WebSocket, as the `sandbox` CLI's interactive shell speaks it (research.md
// "PTY protocol"): a health check, the token in the query, one JSON `start` frame, keystrokes as binary
// frames, `resize` as JSON; output arrives as binary frames and the exit code as `{type:'exit'}`.
// Uses the WHATWG WebSocket that Node 22+ and Electron's main process have.
import type { PtyListener, PtyStart, PtyTransport } from './provider'

/** The part of a WebSocket this uses, so tests can stand in for one. */
export interface PtySocket {
  readonly readyState: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown }) => void): void
}

export interface VercelPtyOptions {
  socket?: (url: string) => PtySocket
  fetch?: typeof fetch
  // The CLI's async-retry: 5 retries from 100 ms.
  healthRetries?: number
  healthDelayMs?: number
}

const OPEN = 1

/** The socket's URL: the token goes in the query, as the CLI sends it. */
export function ptySocketUrl(url: string, token: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/** The first frame: what to run. The controller wants env as K=V strings. */
export function startFrame(start: PtyStart): string {
  const env = { TERM: 'xterm-256color', ...start.env }
  return JSON.stringify({ type: 'start', command: start.command, args: start.args, env: Object.entries(env).map(([k, v]) => `${k}=${v}`), cwd: start.cwd, cols: start.cols, rows: start.rows })
}

/** The controller answers /health before it takes connections; a just-woken sandbox may need a moment. */
async function healthy(url: string, opts: VercelPtyOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch
  const retries = opts.healthRetries ?? 5
  let delay = opts.healthDelayMs ?? 100
  const health = `https://${new URL(url).hostname}/health`
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(health)
      if (res.ok) return
      if (attempt >= retries) throw new Error(`The sandbox’s terminal server isn’t healthy (${res.status} ${res.statusText})`)
    } catch (err) {
      if (attempt >= retries) throw err
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 2000)
  }
}

export async function connectVercelPty(endpoint: { url: string; token: string }, start: PtyStart, listener: PtyListener, opts: VercelPtyOptions = {}): Promise<PtyTransport> {
  await healthy(endpoint.url, opts)
  const make = opts.socket ?? ((url: string) => new WebSocket(url) as unknown as PtySocket)
  const socket = make(ptySocketUrl(endpoint.url, endpoint.token))
  socket.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('Couldn’t connect to the sandbox’s terminal')))
    socket.addEventListener('close', () => reject(new Error('The sandbox closed the terminal connection')))
  })
  const encoder = new TextEncoder()
  // Streaming, so a character split across two frames still decodes.
  const decoder = new TextDecoder()
  let exitCode: number | null = null
  let closedByUs = false
  let ended = false
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null
      if (bytes) listener.data(decoder.decode(bytes, { stream: true }))
      return
    }
    // Text frames are control messages; one that isn't JSON is output, as the CLI treats it.
    let message: { type?: unknown; code?: unknown } | null = null
    try {
      message = JSON.parse(data) as { type?: unknown; code?: unknown }
    } catch {
      listener.data(data)
      return
    }
    if (message?.type === 'exit') exitCode = typeof message.code === 'number' ? message.code : 0
  })
  socket.addEventListener('close', () => {
    if (ended) return
    ended = true
    const tail = decoder.decode()
    if (tail) listener.data(tail)
    if (!closedByUs) listener.exit(exitCode)
  })
  socket.send(startFrame(start))
  return {
    write: (data) => {
      if (socket.readyState === OPEN) socket.send(encoder.encode(data))
    },
    resize: (cols, rows) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    },
    close: () => {
      closedByUs = true
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
  }
}
