// The local engine: sherpa-onnx in a helper process (see protocol.ts for the wire format and sttHelper.ts for the
// other end). One helper per dictation, so the model is not held in memory between dictations and a crash only
// costs that dictation: the helper dying reports through `onError` and Foreman carries on.
import { spawn, type ChildProcess } from 'node:child_process'
import { encodeControl, encodeFrame, KIND_AUDIO, parseReply, type HelperModelFiles } from './protocol'
import type { SttProvider, SttSession, SttStartOptions } from './provider'

/** How to run the helper: Foreman's own binary in Node mode on the built script (like the CLI shim). */
export interface HelperLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface LocalProviderOptions {
  /** Null when the built helper script is not there. */
  launch(): HelperLaunch | null
  models: { files(): HelperModelFiles | null }
  /** How long `stop` waits for the final transcript before giving up and returning what it has. */
  stopTimeoutMs?: number
}

/** The model writes upper-case words with no punctuation; this makes them readable. */
export function tidyTranscript(raw: string): string {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\bi(?=$|\s|')/g, 'I')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

export class LocalProvider implements SttProvider {
  readonly name = 'local' as const

  constructor(private options: LocalProviderOptions) {}

  async start(options: SttStartOptions): Promise<SttSession> {
    if (!/^en(-|$)/i.test(options.language)) throw new Error('The model on this computer understands English only. Set the dictation language to en, or use OpenAI.')
    const launch = this.options.launch()
    if (!launch) throw new Error('The speech helper is missing. Build Foreman again.')
    const model = this.options.models.files()
    if (!model) throw new Error('The speech model is not downloaded yet. Download it in Settings, Accessibility.')
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (error) => reject(new Error(`The speech helper could not start: ${error.message}`)))
    })
    const session = new LocalSession(child, options, this.options.stopTimeoutMs ?? 10_000)
    child.stdin?.write(encodeControl({ type: 'start', language: options.language, model }))
    return session
  }
}

class LocalSession implements SttSession {
  private text = ''
  private buffer = ''
  private stderr = ''
  private reported = ''
  private closed = false
  private finished = false
  private dead = false
  private waiting: Array<(text: string) => void> = []
  private stopping: Promise<string> | null = null

  constructor(
    private child: ChildProcess,
    private options: SttStartOptions,
    private stopTimeoutMs: number
  ) {
    child.stdin?.on('error', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => this.read(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-1000)
    })
    child.on('error', (error) => this.end(error.message))
    child.on('close', (code) => this.end(`exit code ${code ?? 'unknown'}`))
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let at: number
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const reply = parseReply(this.buffer.slice(0, at))
      this.buffer = this.buffer.slice(at + 1)
      if (!reply || this.closed) continue
      if (reply.type === 'partial') {
        this.text = tidyTranscript(reply.text)
        this.options.onPartial(this.text)
      } else if (reply.type === 'final') {
        this.text = tidyTranscript(reply.text)
        this.finished = true
        this.release()
      } else if (reply.type === 'error') {
        this.reported = reply.message
      }
    }
  }

  private release(): void {
    for (const resolve of this.waiting.splice(0)) resolve(this.text)
  }

  /** The helper is gone: a crash unless the dictation was over or dropped. */
  private end(detail: string): void {
    if (this.dead) return
    this.dead = true
    const expected = this.closed || this.finished
    this.release()
    if (expected) return
    this.closed = true
    const tail = this.stderr.trim().split('\n').pop()?.slice(0, 200)
    this.options.onError(this.reported || `Speech recognition stopped unexpectedly (${detail})${tail ? `: ${tail}` : ''}`)
  }

  audio(frame: Uint8Array): void {
    if (this.closed || this.dead || this.stopping) return
    this.child.stdin?.write(encodeFrame(KIND_AUDIO, frame))
  }

  stop(): Promise<string> {
    if (this.stopping) return this.stopping
    this.stopping = new Promise<string>((resolve) => {
      if (this.dead || this.closed) return resolve(this.text)
      const timer = setTimeout(() => {
        this.closed = true
        this.child.kill()
        resolve(this.text)
      }, this.stopTimeoutMs)
      this.waiting.push((text) => {
        clearTimeout(timer)
        resolve(text)
      })
      this.child.stdin?.write(encodeControl({ type: 'stop' }))
    })
    return this.stopping
  }

  cancel(): void {
    if (this.closed && this.dead) return
    this.closed = true
    this.release()
    this.child.kill()
  }
}
