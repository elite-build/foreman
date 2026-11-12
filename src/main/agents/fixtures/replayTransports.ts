// ReplayTransport, one per transport (docs/agents.md, 9.3): each stands in for the agent at the seam its adapter
// starts it through (transport.ts) and plays a fixture back through the engine in replay.ts.
//   claude   a fake CLI process on the Agent SDK's stdio (the SDK itself runs, above it)
//   codex    a fake `codex app-server` process under CodexAppServer
//   acp      an in-process stream pair under the ACP client connection
//   cursor   a fake worker process with Cursor's IPC `send` / 'message'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { CodexAppServer } from '../codex/appServer'
import type { AcpConnector } from '../acp'
import { setTransportOverride, type CodexOpener, type CursorForker, type ProcessStarter, type TransportOverrides } from '../transport'
import type { TurnRequest } from '../types'
import { EOF, kill, type Fixture } from './format'
import { ReplayEngine, claudeProtocol, ipcProtocol, jsonRpcProtocol, type Protocol, type ReplayOptions, type Sink } from './replay'

export type FixturePicker = Fixture | ((req: TurnRequest) => Fixture)

export interface ReplayHandle {
  /** Every replay this handle started, one per process or connection. */
  engines: ReplayEngine[]
  /** What didn't match, across all of them. Tests assert it is empty. */
  warnings(): string[]
  /** Puts back what the seam had. */
  uninstall(): void
}

const pick = (picker: FixturePicker, req: TurnRequest): Fixture => (typeof picker === 'function' ? picker(req) : picker)

function engineFor(handle: { engines: ReplayEngine[] }, fixture: Fixture, protocol: Protocol, sink: Sink, req: TurnRequest, options: ReplayOptions): ReplayEngine {
  const engine = new ReplayEngine(fixture, protocol, sink, { ...options, paths: { repo: req.cwd, home: os.homedir(), tmp: os.tmpdir(), ...options.paths } })
  handle.engines.push(engine)
  return engine
}

/** A child process that is a replay: JSON lines in on `stdin`, JSON lines out on `stdout`. */
class FakeProcess extends EventEmitter {
  readonly pid = undefined
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  private buffer = ''
  private engine!: ReplayEngine

  constructor(make: (sink: Sink) => ReplayEngine, signal?: AbortSignal) {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.feed(Buffer.from(chunk).toString('utf8'))
        done()
      },
      final: (done) => {
        this.engine.send(EOF)
        done()
      }
    })
    this.stdin.on('error', () => undefined)
    this.engine = make({
      recv: (data) => void this.stdout.write(JSON.stringify(data) + '\n'),
      stderr: (text) => void this.stderr.write(text),
      exit: ({ code, signal: sig }) => this.exited(code, sig as NodeJS.Signals | null)
    })
    signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true })
    this.engine.start()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.engine.send(kill(signal))
    return true
  }

  private feed(text: string): void {
    this.buffer += text
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      try {
        this.engine.send(JSON.parse(line))
      } catch {
        // Not a protocol line.
      }
    }
  }

  private exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
    setImmediate(() => this.emit('close', code, signal))
  }
}

function claudeStarter(handle: ReplayHandle, picker: FixturePicker, req: TurnRequest, options: ReplayOptions): ProcessStarter {
  return ((_command: string, _args: readonly string[], spawnOptions: { signal?: AbortSignal }) =>
    new FakeProcess((sink) => engineFor(handle, pick(picker, req), claudeProtocol, sink, req, options), spawnOptions?.signal) as unknown as ChildProcess) as unknown as ProcessStarter
}

function codexOpener(handle: ReplayHandle, picker: FixturePicker, req: TurnRequest, options: ReplayOptions): CodexOpener {
  const open: CodexOpener = () => CodexAppServer.attach(new FakeProcess((sink) => engineFor(handle, pick(picker, req), jsonRpcProtocol, sink, req, options)) as unknown as ChildProcess)
  open.standsIn = true
  return open
}

function acpConnector(handle: ReplayHandle, picker: FixturePicker, req: TurnRequest, options: ReplayOptions): AcpConnector {
  return () => {
    const toAgent = new TransformStream<any, any>()
    const toClient = new TransformStream<any, any>()
    const writer = toClient.writable.getWriter()
    const engine = engineFor(
      handle,
      pick(picker, req),
      jsonRpcProtocol,
      {
        recv: (data) => void writer.write(data).catch(() => undefined),
        stderr: () => undefined,
        exit: () => void writer.close().catch(() => undefined)
      },
      req,
      options
    )
    const reader = toAgent.readable.getReader()
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return engine.send(EOF)
        engine.send(value)
      }
    })().catch(() => undefined)
    engine.start()
    return { stream: { readable: toClient.readable, writable: toAgent.writable }, failure: () => ({ stderr: '' }), close: async () => engine.kill() }
  }
}

/** What Cursor's `fork` gives back: an IPC channel, not stdio. */
class FakeWorker extends EventEmitter {
  readonly pid = undefined
  connected = true
  killed = false
  readonly stderr = new PassThrough()
  private engine: ReplayEngine

  constructor(make: (sink: Sink) => ReplayEngine) {
    super()
    this.engine = make({
      recv: (data) => void this.emit('message', data),
      stderr: (text) => void this.stderr.write(text),
      exit: ({ code, signal }) => {
        this.connected = false
        this.stderr.end()
        queueMicrotask(() => this.emit('exit', code, signal))
      }
    })
    this.engine.start()
  }

  send(message: unknown): boolean {
    this.engine.send(message)
    return true
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.engine.kill()
  }

  kill(): boolean {
    this.killed = true
    this.engine.kill()
    return true
  }
}

function cursorForker(handle: ReplayHandle, picker: FixturePicker, req: TurnRequest, options: ReplayOptions): CursorForker {
  const start = (() => new FakeWorker((sink) => engineFor(handle, pick(picker, req), ipcProtocol, sink, req, options)) as unknown as ChildProcess) as unknown as CursorForker
  start.standsIn = true
  return start
}

/**
 * Puts the replay in the seam for `agent` (a Claude Code, Codex, Cursor or ACP agent's id; any other id is an ACP agent),
 * choosing a fixture per turn. Everything the agent's adapter starts from now on is played from it, or, with a `gate`
 * that says no for a turn, started for real.
 */
export function replayTransport(agent: string, picker: FixturePicker, options: ReplayOptions = {}, gate?: () => boolean): ReplayHandle {
  const handle: ReplayHandle = {
    engines: [],
    warnings: () => handle.engines.flatMap((e) => e.warnings),
    uninstall: () => undo()
  }
  let undo: () => void
  switch (agent) {
    case 'claude':
      undo = setTransportOverride('claude', (req) => (gate && !gate() ? undefined : claudeStarter(handle, picker, req, options)))
      break
    case 'codex':
      undo = setTransportOverride('codex', (req) => (gate && !gate() ? undefined : codexOpener(handle, picker, req, options)))
      break
    case 'cursor':
      undo = setTransportOverride('cursor', (req) => (gate && !gate() ? undefined : cursorForker(handle, picker, req, options)))
      break
    default: {
      // `acp` stands for every ACP agent without a recording of its own (the shared fixtures folder).
      const connect: TransportOverrides['acp'] = (kind, req) => ((kind === agent || agent === 'acp') && (!gate || gate()) ? acpConnector(handle, picker, req, options) : undefined)
      undo = setTransportOverride('acp', connect)
    }
  }
  return handle
}
