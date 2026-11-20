// The recording side of the seam (docs/agents.md, 9.2): a tee that copies everything crossing a transport into frames,
// and hands the adapter exactly what the real transport would have. Nothing here changes what is said.
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { AcpConnector } from '../acp'
import type { CodexOpener, CursorForker, ProcessStarter } from '../transport'
import { spawnAppServer, CodexAppServer } from '../codex/appServer'
import type { OpencodeLauncher } from '../opencode/server'
import { EOF, kill, type Frame, type FrameDir } from './format'

export class FrameRecorder {
  readonly frames: Frame[] = []
  /** The process being recorded, for a scripted user that kills it. */
  child?: ChildProcess
  private start = Date.now()

  add(dir: FrameDir, data: unknown): void {
    this.frames.push({ t: Date.now() - this.start, dir, data })
  }
  send = (data: unknown) => this.add('send', data)
  recv = (data: unknown) => this.add('recv', data)
  stderr = (text: string) => this.add('stderr', text)
  exit = (code: number | null, signal: string | null) => this.add('exit', { code, signal })

  /** The time of the last frame, for a scripted user that waits for a pause. */
  get last(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0
  }
}

/** Splits a byte stream into JSON lines, calling `line` with each parsed one (text that isn't JSON is passed on as it is). */
function lines(line: (data: unknown) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!text) continue
      try {
        line(JSON.parse(text))
      } catch {
        line(text)
      }
    }
  }
}

/** Wraps a real child process so its stdin, stdout and stderr are copied into `rec`. Returns the same child. */
export function teeChild(child: ChildProcess, rec: FrameRecorder): ChildProcess {
  rec.child = child
  const stdin = child.stdin
  if (stdin) {
    const parse = lines(rec.send)
    const write = stdin.write.bind(stdin) as (...args: unknown[]) => boolean
    const end = stdin.end.bind(stdin) as (...args: unknown[]) => typeof stdin
    stdin.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
      parse(chunk)
      return write(chunk, ...rest)
    }) as typeof stdin.write
    let ended = false
    stdin.end = ((...args: unknown[]) => {
      const [chunk] = args
      if (typeof chunk === 'string' || chunk instanceof Buffer) parse(chunk)
      // Closing twice is one closing (a replay's input ends once).
      if (!ended) rec.send(EOF)
      ended = true
      return end(...args)
    }) as typeof stdin.end
  }
  // The adapter reads a stream of its own, so a listener added here never starts or steals the flow.
  const tap = (name: 'stdout' | 'stderr', on: (chunk: Buffer | string) => void) => {
    const source = child[name]
    if (!source) return
    const out = new PassThrough()
    source.on('data', (chunk: Buffer) => {
      on(chunk)
      out.write(chunk)
    })
    source.on('end', () => out.end())
    source.on('error', (err) => out.destroy(err))
    Object.defineProperty(child, name, { value: out, configurable: true })
  }
  tap('stdout', lines(rec.recv))
  const decoder = new StringDecoder('utf8')
  tap('stderr', (chunk) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (text) rec.stderr(text)
  })
  const killed = child.kill.bind(child)
  child.kill = ((signal?: NodeJS.Signals | number) => {
    rec.send(kill(String(signal ?? 'SIGTERM')))
    return killed(signal)
  }) as typeof child.kill
  // 'close' is after the output has been read to its end, so the exit is the last frame.
  child.once('close', (code, signal) => rec.exit(code, signal))
  return child
}

/** A Claude Code launch that tees the CLI's stdio: what `spawn` is for the SDK, recorded. */
export function teeClaudeStarter(start: ProcessStarter, rec: FrameRecorder): ProcessStarter {
  return ((command: string, args: readonly string[], options: object) => teeChild(start(command, args, options as never), rec)) as ProcessStarter
}

/** A Codex opener that tees the app-server's stdio under the same JSON-RPC client the adapter normally uses. */
export function teeCodexOpener(rec: FrameRecorder): CodexOpener {
  return (launch) => CodexAppServer.attach(teeChild(spawnAppServer(launch), rec))
}

/** An ACP connector that tees the messages each way (a real process, or an in-process fake). */
export function teeAcpConnector(connect: AcpConnector, rec: FrameRecorder): AcpConnector {
  return (launch) => {
    const transport = connect(launch)
    const toAgent = new TransformStream<any, any>({
      transform(message, controller) {
        rec.send(message)
        controller.enqueue(message)
      },
      flush: () => rec.send(EOF)
    })
    const fromAgent = new TransformStream<any, any>({
      transform(message, controller) {
        rec.recv(message)
        controller.enqueue(message)
      },
      flush: () => rec.exit(0, null)
    })
    void toAgent.readable.pipeTo(transport.stream.writable).catch(() => undefined)
    void transport.stream.readable.pipeTo(fromAgent.writable).catch(() => undefined)
    return { ...transport, stream: { readable: fromAgent.readable, writable: toAgent.writable } }
  }
}

/**
 * An OpenCode launcher that tees its server's HTTP traffic (replay.ts `httpProtocol`): each request a `send`
 * (`{http: "POST /session/ses_…/prompt_async", id, body}`, without the query and headers, which carry the folder and the
 * password), each answer a `recv` (`{re: id, status, body}`), and each server-sent event a `recv` of its own (`{event}`),
 * after the `{re, status, stream: true}` that opened the stream. Its error output and exit are recorded too; closing it is a kill.
 */
export function teeOpencodeLauncher(launch: OpencodeLauncher, rec: FrameRecorder): OpencodeLauncher {
  return async (options) => {
    const server = await launch(options)
    if (server.process) {
      rec.child = server.process
      const decoder = new StringDecoder('utf8')
      server.process.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
        if (text) rec.stderr(text)
      })
      // Its exit, not its pipes closing: the turn's own close comes after a crash, and must not land before it.
      server.process.once('exit', (code, signal) => rec.exit(code, signal))
    }
    const running = () => !server.process || (server.process.exitCode === null && server.process.signalCode === null)
    let next = 0
    const parse = (text: string): unknown => {
      if (!text) return undefined
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    const recorded: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const id = next++
      const body = parse(await request.clone().text())
      rec.send({ http: `${request.method} ${new URL(request.url).pathname}`, id, ...(body !== undefined ? { body } : {}) })
      const response = await server.fetch(request)
      if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const text = await response.text()
        const answer = parse(text)
        rec.recv({ re: id, status: response.status, ...(answer !== undefined ? { body: withoutKeys(answer) } : {}) })
        return new Response(response.status === 204 ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      rec.recv({ re: id, status: response.status, stream: true })
      const decoder = new TextDecoder()
      let buffer = ''
      const reader = response.body.getReader()
      // The stream's end is a frame of its own (`{re, end: true}`): a server that dies breaks it before its process is seen to exit.
      const events = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await reader.read()
            if (done) {
              rec.recv({ re: id, end: true })
              return controller.close()
            }
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
            const blocks = buffer.split('\n\n')
            buffer = blocks.pop() ?? ''
            for (const block of blocks) {
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s*/, '')).join('\n')
              if (data) rec.recv({ event: parse(data) })
            }
            controller.enqueue(value)
          } catch (err) {
            rec.recv({ re: id, end: true, broke: true })
            controller.error(err)
          }
        },
        cancel: (reason) => reader.cancel(reason)
      })
      return new Response(events, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    return {
      ...server,
      fetch: recorded,
      close: async () => {
        // Closing a server that already went away (a crash) kills nothing.
        if (running()) rec.send(kill('SIGTERM'))
        await server.close()
      }
    }
  }
}

/** A provider's `key` (OpenCode answers `/config/providers` with the keys it read): never in a recording. */
function withoutKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => !(k === 'key' && typeof v === 'string')).map(([k, v]) => [k, withoutKeys(v)]))
}

/** A Cursor worker starter that tees the IPC messages each way (the real forked worker, or the in-process fake). */
export function teeCursorFork(fork: CursorForker, rec: FrameRecorder): CursorForker {
  const start = ((...args: Parameters<CursorForker>) => {
    const child = fork(...args)
    const send = child.send.bind(child) as (message: unknown, ...rest: unknown[]) => boolean
    child.send = ((message: unknown, ...rest: unknown[]) => {
      rec.send(message)
      return send(message, ...rest)
    }) as typeof child.send
    child.on('message', (message) => rec.recv(message))
    child.once('exit', (code, signal) => rec.exit(code, signal))
    rec.child = child
    return child
  }) as unknown as CursorForker
  start.standsIn = fork.standsIn
  return start
}
