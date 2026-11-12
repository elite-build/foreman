// A small JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio).
// The Codex driver, the model list and ChatGPT sign-in all talk to the CLI through this.
import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree } from '../../platform'
import type { InitializeResponse } from './wire'

export interface AppServerLaunch {
  file: string
  cwd: string
  env: Record<string, string>
}

/** The methods callers use, so tests can swap in a fake server with no process. */
export interface CodexAppServerLike {
  readonly exited: boolean
  // What the server says about itself (`userAgent` carries its version); a stand-in with nothing to say answers nothing.
  // `platformOs` says which system the server runs on ("windows": its sandbox needs setting up, docs/agents.md 8).
  initialize(): Promise<Partial<Pick<InitializeResponse, 'userAgent' | 'platformOs'>> | void>
  request<T = unknown>(method: string, params: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  // The params are the wire's: wire.ts's `notification` and `serverRequest` read them as the generated type for the method.
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: (method: string, params: unknown, id: number | string) => Promise<unknown>): void
  onExit(handler: (code: number | null, stderrTail: string) => void): void
  close(): void
}

export type AppServerFactory = (launch: AppServerLaunch) => CodexAppServerLike

/** A reply to a server request that carries its own JSON-RPC code (the default for a throw is -32603). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message)
  }
}

const STDERR_TAIL = 4096
const CLIENT_VERSION = '1.0.0'

interface Reply {
  resolve(value: unknown): void
  reject(error: Error): void
  method: string
}

interface Message {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/** The `codex app-server` process. The recorder starts it the same way and tees its stdio before `attach` takes it. */
export function spawnAppServer(launch: AppServerLaunch): ChildProcess {
  // A process group on POSIX so close() reaches helpers the CLI started; Windows kills the tree by pid.
  return spawn(launch.file, ['app-server'], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
}

export class CodexAppServer implements CodexAppServerLike {
  private nextId = 0
  private replies = new Map<number | string, Reply>()
  private notifications: ((method: string, params: unknown) => void)[] = []
  private requestHandler?: (method: string, params: unknown, id: number | string) => Promise<unknown>
  private exitHandlers: ((code: number | null, stderrTail: string) => void)[] = []
  private buffer = ''
  private stderr = ''
  private exitCode: number | null = null
  private closed = false
  private _exited = false

  /** Starts `codex app-server` and wires up its pipes. Call `initialize()` before anything else. */
  static start(launch: AppServerLaunch): CodexAppServer {
    return new CodexAppServer(spawnAppServer(launch))
  }

  /** Wraps a child that already speaks the protocol on its stdio (tests use a script). */
  static attach(child: ChildProcess): CodexAppServer {
    return new CodexAppServer(child)
  }

  private constructor(private child: ChildProcess) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.read(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL)
    })
    // A write to a dead process is reported through exit, not as an unhandled stream error.
    child.stdin?.on('error', () => undefined)
    child.on('error', (err) => {
      this.stderr = `${this.stderr}${this.stderr ? '\n' : ''}${err.message}`.slice(-STDERR_TAIL)
      this.finish(null)
    })
    child.on('close', (code) => this.finish(code))
  }

  get exited(): boolean {
    return this._exited
  }

  async initialize(): Promise<InitializeResponse> {
    const hello = await this.request<InitializeResponse>('initialize', {
      clientInfo: { name: 'foreman', title: 'Foreman', version: CLIENT_VERSION },
      // Experimental API: plan mode (`collaborationMode`) and `item/tool/requestUserInput`.
      capabilities: { experimentalApi: true }
    })
    this.notify('initialized')
    return hello
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this._exited || this.closed) return Promise.reject(new Error(this._exited ? this.exitMessage() : 'Codex app-server closed'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId
      this.replies.set(id, { resolve: resolve as (value: unknown) => void, reject, method })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notifications.push(handler)
  }

  onRequest(handler: (method: string, params: unknown, id: number | string) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  onExit(handler: (code: number | null, stderrTail: string) => void): void {
    if (this._exited) queueMicrotask(() => handler(this.exitCode, this.stderr))
    else this.exitHandlers.push(handler)
  }

  /** Kills the process and its children. Pending requests fail; exit handlers run once the process is gone. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failPending(new Error('Codex app-server closed'))
    if (this._exited) return
    try {
      this.child.stdin?.end()
    } catch {
      // Already closed.
    }
    if (this.child.pid !== undefined) void killProcessTree(this.child.pid)
    else this.child.kill()
  }

  private exitMessage(): string {
    const tail = this.stderr.trim()
    const how = this.exitCode === null ? 'unexpectedly' : `with code ${this.exitCode}`
    return tail ? `Codex app-server exited ${how}: ${tail}` : `Codex app-server exited ${how}`
  }

  private finish(code: number | null): void {
    if (this._exited) return
    this._exited = true
    this.exitCode = code
    this.failPending(new Error(this.exitMessage()))
    const handlers = this.exitHandlers.splice(0)
    for (const handler of handlers) handler(code, this.stderr)
  }

  private failPending(error: Error): void {
    const pending = [...this.replies.values()]
    this.replies.clear()
    for (const reply of pending) reply.reject(error)
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return
    stdin.write(JSON.stringify(message) + '\n')
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message: Message
      try {
        message = JSON.parse(line) as Message
      } catch {
        // Not a protocol line; ignore.
        continue
      }
      if (typeof message !== 'object' || message === null) continue
      this.dispatch(message)
    }
  }

  private dispatch(message: Message): void {
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && typeof message.method === 'string') {
      void this.serve(message.id!, message.method, message.params)
      return
    }
    if (hasId) {
      const reply = this.replies.get(message.id!)
      if (!reply) return
      this.replies.delete(message.id!)
      if (message.error) reply.reject(new Error(message.error.message ?? `${reply.method} failed`))
      else reply.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      for (const handler of this.notifications) {
        try {
          handler(message.method, message.params)
        } catch {
          // A faulty handler must not stop the stream.
        }
      }
    }
  }

  /** A request from the server: answered by the handler, or with a JSON-RPC error. */
  private async serve(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) return this.write({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    try {
      const result = await this.requestHandler(method, params, id)
      this.write({ id, result: result ?? null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.write({ id, error: { code: err instanceof RpcError ? err.code : -32603, message } })
    }
  }
}
